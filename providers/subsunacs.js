const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { fuzzyMatch } = require('./fuzzy');

const BASE_URL = 'https://subsunacs.net';
const SEARCH_URL = `${BASE_URL}/search.php`;
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const TMDB_API_KEY = 'b019b78bbd3a80f0f3112369c3b8c243';
const TMDB_URL = 'https://api.themoviedb.org/3';

/**
 * Normalize title for comparison - remove special chars, lowercase
 */
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\u0400-\u04FF\s]/gi, ' ') // Keep letters, numbers, cyrillic
        .replace(/\s+/g, ' ')
        .trim();
}

// Sanitize a string for search queries: remove punctuation like :,-. and collapse spaces
function sanitizeSearchString(s) {
    if (!s) return s;
    return String(s)
        .replace(/[\:\-–—,\.\/\\\(\)\[\]"'`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Check if subtitle matches the movie/series by title and year/season/episode
 */
function isGoodMatch(subName, movieTitle, movieYear, season = null, episode = null) {
    const normalizedSub = normalizeTitle(subName);
    const normalizedTitle = normalizeTitle(movieTitle);
    const titleWords = normalizedTitle.split(/\s+/);
    const subWords = normalizedSub.split(/\s+/);
    
    // For TV series - check season/episode match
    if (season !== null && episode !== null) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        const sNum = parseInt(season);
        const eNum = parseInt(episode);
        
        // Common season/episode patterns
        const sePatterns = [
            new RegExp(`s0*${sNum}e0*${eNum}`, 'i'),          // S03E01, S3E1
            new RegExp(`${sNum}x0*${eNum}`, 'i'),              // 3x01, 03x01  
            new RegExp(`season\\s*0*${sNum}.*episode\\s*0*${eNum}`, 'i'), // Season 3 Episode 1
            new RegExp(`\\b0*${sNum}x0*${eNum}\\b`, 'i'),      // 03x01 with word boundaries
        ];
        
        // Season pack patterns (full season without specific episode)
        const seasonPackPatterns = [
            new RegExp(`s0*${sNum}\\b(?!e)`, 'i'),             // S03 but not S03E
            new RegExp(`\\bseason\\s*0*${sNum}\\b`, 'i'),     // Season 3
            new RegExp(`\\bs0*${sNum}[\\s\\.-]*(complete|full|all)`, 'i'), // S03 Complete
            new RegExp(`(complete|full).*s0*${sNum}\\b`, 'i'), // Complete S03
        ];
        
        const hasSeasonEpisode = sePatterns.some(pattern => pattern.test(subName));
        const isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(subName)) && 
                             !hasSeasonEpisode; // Only if NOT a specific episode
        
        if (!hasSeasonEpisode && !isSeasonPack) {
            console.log(`[Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        // Season packs get slightly lower score than exact episode matches
        if (isSeasonPack) {
            console.log(`[Filter] "${subName}" is a season pack for S${s}`);
        }
        
        // Check that title words are in subtitle (less strict for series)
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            console.log(`[Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
            return { match: false, score: 0 };
        }
        
        // Season packs get lower score (5) than exact episode matches (10)
        return { match: true, score: matchScore + (isSeasonPack ? 5 : 10), isSeasonPack };
    }
    
    // For movies - check year match
    if (movieYear) {
        const yearMatch = subName.match(/(19|20)\d{2}/);
        if (yearMatch && yearMatch[0] !== movieYear) {
            return { match: false, score: 0 };
        }
    }
    
    // For short titles (1-2 words), be VERY strict but handle numbered sequels
    if (titleWords.length <= 2) {
        // Title must be at the beginning
        const startsWithTitle = titleWords.every((word, i) => subWords[i] === word);
        if (!startsWithTitle) {
            return { match: false, score: 0 };
        }
        
        // Check what comes AFTER the title
        const nextWordIndex = titleWords.length;
        if (subWords[nextWordIndex]) {
            const nextWord = subWords[nextWordIndex];
            // Next word should be: year, release term, "aka", or number (for sequels like "Zootopia 2")
            const isYear = /^(19|20)\d{2}$/.test(nextWord);
            const isReleaseTerm = /^(720p|1080p|2160p|4k|bluray|bdrip|brrip|hdrip|webrip|web|dvdrip|hdtv|proper|repack|extended|unrated|directors|x264|x265|h264|h265|aac|dts|ac3|remux|uhd)$/i.test(nextWord);
            const isAka = nextWord === 'aka' || nextWord === 'a';
            const isNumber = /^\d+$/.test(nextWord); // Allow numbers (sequel numbers, part numbers)
            const isEpisodePattern = /^\d{1,2}x\d{1,2}$/i.test(nextWord) || /^s\d{1,2}e\d{1,2}$/i.test(nextWord) || /^\d{1,2}x\d{1,2}$/i.test(nextWord);
            const isSeasonToken = /^season$/i.test(nextWord) || /^s\d{1,2}$/i.test(nextWord);

            if (!isYear && !isReleaseTerm && !isAka && !isNumber && !isEpisodePattern && !isSeasonToken) {
                // Next word is probably part of a different movie title
                console.log(`[Filter] "${nextWord}" after "${normalizedTitle}" looks like different movie`);
                return { match: false, score: 0 };
            }
        }
    }
    
    // Calculate match score
    const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
    const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.5));

    if (matchScore >= minMatches) {
        return { match: true, score: matchScore };
    }

    // Fallback: fuzzy matching (Levenshtein + token overlap)
    try {
        const fm = fuzzyMatch(subName, movieTitle);
        if (fm.match) {
            console.log(`[Fuzzy] Accepted by fuzzy: lev=${fm.lev.toFixed(2)} overlap=${fm.overlap.toFixed(2)} score=${fm.score.toFixed(2)}`);
            // Scale fuzzy score to similar scale (0..10)
            return { match: true, score: Math.round(fm.score * 10) };
        }
    } catch (e) {
        console.error('[Fuzzy] Error:', e.message);
    }

    return { match: false, score: matchScore };
}

/**
 * Search for subtitles on Subsunacs.net
 * Based on kgkolev/service.subtitles.subsunacs Kodi addon
 */
async function search(imdbId, type, season, episode) {
    try {
        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[Subsunacs] Could not get metadata for:', imdbId);
            return [];
        }

        const year = meta.year ? String(meta.year).substring(0, 4) : '';
        const isSeries = type === 'series' && season && episode;
        
        // Log search target (do not include year in the search string)
        console.log(`[Subsunacs] Searching for: ${meta.name}${isSeries ? ` S${season}E${episode}` : ''} (year=${year || 'unknown'})`);
        
        // Build search query like Kodi addon
        let searchQuery = sanitizeSearchString(meta.name);
        if (isSeries) {
            const s = String(season).padStart(2, '0');
            const e = String(episode).padStart(2, '0');
            searchQuery = `${sanitizeSearchString(meta.name)} ${s}x${e}`;
        }

        // We'll request the first page via POST and then detect pagination and iterate further pages
        const searchParams = new URLSearchParams({
            m: searchQuery,
            l: '0',
            c: '',
            // Do not include year in the search query — we'll filter by the page-provided year later
            y: '0',
            a: '',
            d: '',
            u: '',
            g: '',
            t: 'Submit'
        });

        const subtitles = [];
        const deferred = [];
        const maxPagesLimit = 50;

        // Fetch first page (POST)
        let firstResponse;
        try {
            firstResponse = await axios.post(SEARCH_URL, searchParams.toString(), {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.6 (KHTML, like Gecko) Chrome/20.0.1092.0 Safari/536.6',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'bg,en;q=0.9'
                },
                timeout: 15000
            });
        } catch (err) {
            console.error('[Subsunacs] Initial search request failed:', err.message);
            return [];
        }

        // Helper to parse a page's HTML and collect subtitles
        const parsePage = (html) => {
            const $ = cheerio.load(html);
            $('a.tooltip').each((index, element) => {
                const $link = $(element);
                const name = $link.text().trim();
                let href = $link.attr('href');

                if (!href || !name) return;

                // Extract year shown on page (e.g. <span class="smGray"> (2003) </span>) if present
                let subtitleYear = null;
                try {
                    const yearText = ($link.find('span.smGray').text() || $link.siblings('span.smGray').text() || $link.closest('td').find('span.smGray').text() || '').trim();
                    const m = yearText.match(/(19|20)\d{2}/);
                    if (m) subtitleYear = m[0];
                } catch (e) {}

                // If page provides a year and it doesn't match movie year, skip this subtitle
                if (!isSeries && subtitleYear && year && String(subtitleYear) !== String(year)) {
                    return;
                }

                const matchResult = isSeries
                    ? isGoodMatch(name, meta.name, null, season, episode)
                    : isGoodMatch(name, meta.name, year);
                if (!matchResult.match) return;

                const matchScore = matchResult.score;

                if (!href.startsWith('http')) {
                    href = `${BASE_URL}/${href}`;
                }

                // Extract subtitle ID from URL
                const idMatch = href.match(/-(\d+)\/?$/) || href.match(/id=(\d+)/);
                const subId = idMatch ? idMatch[1] : (href + Math.random()).toString();

                // If this is a season pack and user requested a specific episode, defer inspecting the details page
                if (isSeries && matchResult.isSeasonPack && season && episode) {
                    deferred.push(
                        fetchEpisodeSubtitlesFromSeasonPack(href, season, episode).then((episodeSubs) => {
                            if (episodeSubs && episodeSubs.length) {
                                for (const es of episodeSubs) {
                                    subtitles.push({ id: `subsunacs_${es.id || subId}`, lang: 'bul', url: es.url, score: matchScore + 5 });
                                    console.log(`[Subsunacs] Episode found inside season pack: id=${es.id || subId} name="${es.name}" href=${es.url}`);
                                }
                                return true;
                            }
                            return false;
                        }).catch((e) => {
                            console.error('[Subsunacs] Error fetching season pack details:', e && e.message ? e.message : e);
                            return false;
                        })
                    );
                    // continue, do not add season pack now; episode-specific results will be added by deferred handler
                    return;
                }

                subtitles.push({
                    id: `subsunacs_${subId}`,
                    lang: 'bul',
                    url: href,
                    score: matchScore
                });
                console.log(`[Subsunacs] Match found: id=${subId} name="${name}" year=${subtitleYear || '?'} score=${matchScore} href=${href}`);
            });

            // detect numeric pagination
            const pageNums = [];
            $('a').each((i, el) => {
                const t = $(el).text().trim();
                if (/^\d+$/.test(t)) pageNums.push(parseInt(t, 10));
            });
            return pageNums.length ? Math.max(...pageNums) : 1;
        };

            // Fetch details page of a season pack and search for episode-specific subtitle links
            function fetchEpisodeSubtitlesFromSeasonPack(detailUrl, season, episode) {
                // synchronous wrapper returning array via Promise (we'll call without await inside cheerio loop using a cached promise)
                // but for simplicity in this scraping flow we'll perform a synchronous-looking fetch via axios (return Promise)
                return (async () => {
                    try {
                        const resp = await axios.get(detailUrl, {
                            responseType: 'arraybuffer',
                            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': BASE_URL },
                            timeout: 15000
                        });
                        const html = iconv.decode(Buffer.from(resp.data), 'win1251');
                        const $d = cheerio.load(html);

                        const candidates = [];
                        const s = String(season).padStart(2, '0');
                        const e = String(episode).padStart(2, '0');
                        const patterns = [
                            new RegExp(`s0*${parseInt(season)}e0*${parseInt(episode)}`, 'i'),
                            new RegExp(`${parseInt(season)}x0*${parseInt(episode)}`, 'i'),
                            new RegExp(`\b${s}x${e}\b`, 'i'),
                            new RegExp(`\b${parseInt(episode)}\b`)
                        ];

                        $d('a').each((i, el) => {
                            const text = $d(el).text().trim();
                            const href2 = $d(el).attr('href');
                            if (!href2) return;
                            for (const pat of patterns) {
                                if (pat.test(text) || pat.test(href2)) {
                                    let full = href2;
                                    if (!full.startsWith('http')) full = `${BASE_URL}/${full.replace(/^\//, '')}`;
                                    // attempt to extract id
                                    const idm = full.match(/-(\d+)\/?$/) || full.match(/id=(\d+)/);
                                    const idv = idm ? idm[1] : null;
                                    candidates.push({ id: idv, url: full, name: text || '' });
                                    break;
                                }
                            }
                        });

                        return candidates;
                    } catch (e) {
                        return [];
                    }
                })();
            }

        // Parse first page
        const firstHtml = iconv.decode(Buffer.from(firstResponse.data), 'win1251');
        let maxFoundPage = parsePage(firstHtml);

        // If multiple pages, iterate pages via GET adding 'page' param
        for (let page = 2; page <= Math.min(maxFoundPage, maxPagesLimit); page++) {
            // Build URL with query params similar to the POST
            let pageUrl;
            try {
                const urlObj = new URL(SEARCH_URL);
                urlObj.searchParams.set('m', searchQuery);
                urlObj.searchParams.set('l', '0');
                // Do not include year in GET page requests; keep y=0 to avoid filtering by search engine
                urlObj.searchParams.set('y', '0');
                urlObj.searchParams.set('t', 'Submit');
                urlObj.searchParams.set('page', String(page));
                pageUrl = urlObj.toString();
            } catch (e) {
                pageUrl = `${SEARCH_URL}?m=${encodeURIComponent(searchQuery)}&l=0&y=0&t=Submit&page=${page}`;
            }

            console.log(`[Subsunacs] Fetching page ${page}: ${pageUrl}`);

            try {
                const resp = await axios.get(pageUrl, {
                    responseType: 'arraybuffer',
                    headers: {
                        'User-Agent': 'Mozilla/5.0',
                        'Accept-Language': 'bg,en;q=0.9',
                        'Referer': BASE_URL
                    },
                    timeout: 15000
                });
                const html = iconv.decode(Buffer.from(resp.data), 'win1251');
                // update maxFoundPage in case later pages reveal more
                const maybeMax = parsePage(html);
                if (maybeMax > maxFoundPage) maxFoundPage = maybeMax;
            } catch (err) {
                console.error('[Subsunacs] Page fetch error:', err.message);
                break;
            }
        }

        // Wait for any deferred detail-page fetches (season-pack inspections)
        try {
            await Promise.all(deferred);
        } catch (e) {}

        // Deduplicate by id keeping highest score
        const dedup = {};
        for (const s of subtitles) {
            if (!dedup[s.id] || s.score > dedup[s.id].score) dedup[s.id] = s;
        }
        const results = Object.values(dedup);
        results.sort((a, b) => b.score - a.score);

        console.log(`[Subsunacs] Found ${results.length} subtitles across pages`);
        return results;
        
    } catch (error) {
        console.error('[Subsunacs] Search error:', error.message);
        return [];
    }
}

/**
 * Download subtitle from details page
 * Returns the archive buffer
 */
async function download(pageUrl) {
    try {
        console.log(`[Subsunacs] Getting download from: ${pageUrl}`);
        
        // First visit the details page to find the download link
        const detailsResponse = await axios.get(pageUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.6 (KHTML, like Gecko) Chrome/20.0.1092.0 Safari/536.6',
                'Referer': BASE_URL
            },
            timeout: 15000
        });
        
        const html = iconv.decode(Buffer.from(detailsResponse.data), 'win1251');
        const $ = cheerio.load(html);
        
        // Find download link - look for links with "get.php" or download icon
        let downloadUrl = null;
        
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('get.php')) {
                downloadUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
                return false;
            }
        });
        
        // Also try to find by class or image
        if (!downloadUrl) {
            $('a[href*="get"], a.download, a[title*="Свали"], a[title*="Download"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href) {
                    downloadUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
                    return false;
                }
            });
        }
        
        // Try extracting ID from URL path (format: /subtitles/name-ID/)
        if (!downloadUrl) {
            const pathMatch = pageUrl.match(/-(\d+)\/?$/);
            if (pathMatch) {
                downloadUrl = `${BASE_URL}/get.php?id=${pathMatch[1]}`;
            }
        }
        
        if (!downloadUrl) {
            console.log('[Subsunacs] No download URL found on page');
            return null;
        }
        
        console.log(`[Subsunacs] Downloading: ${downloadUrl}`);
        
        // Download with Referer header (important!)
        const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.6 (KHTML, like Gecko) Chrome/20.0.1092.0 Safari/536.6',
                'Referer': pageUrl
            },
            timeout: 30000
        });
        
        return Buffer.from(response.data);
        
    } catch (error) {
        console.error('[Subsunacs] Download error:', error.message);
        return null;
    }
}

async function getImdbMetadata(imdbId) {
    try {
        const url = `https://www.imdb.com/title/${imdbId}/`;
        let resp = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/'
            },
            timeout: 10000
        });

        if (resp.status !== 200 || !resp.data || (typeof resp.data === 'string' && resp.data.trim().length === 0)) {
            try {
                const rilUrl = `https://www.imdb.com/title/${imdbId}/releaseinfo`;
                const ril = await axios.get(rilUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                if (ril && ril.status === 200 && ril.data && ril.data.trim().length > 0) resp = ril;
            } catch (e) {
                try {
                    const proxyUrl = `https://r.jina.ai/http://www.imdb.com/title/${imdbId}/`;
                    const proxyResp = await axios.get(proxyUrl, { timeout: 10000 });
                    if (proxyResp && proxyResp.status === 200 && proxyResp.data) resp = proxyResp;
                } catch (e2) {}
            }
        }

        if (!resp || !resp.data || (typeof resp.data === 'string' && resp.data.trim().length === 0)) {
            console.log('[IMDb] No usable HTML returned (blocked or empty response)');
            return null;
        }

        const $ = cheerio.load(resp.data);

        // Title selectors
        let name = null;
        const titleSelectors = [
            'span.hero__primary-text[data-testid="hero__primary-text"]',
            'h1[data-testid="hero-title-block__title"]',
            'h1',
            'div.title_wrapper > h1',
            'meta[property="og:title"]'
        ];
        for (const sel of titleSelectors) {
            try {
                if (sel.startsWith('meta')) {
                    const v = $(sel).attr('content');
                    if (v && v.trim()) { name = v.trim(); break; }
                    continue;
                }
                const t = $(sel).first().text();
                if (t && t.trim()) { name = t.trim(); break; }
            } catch (e) {}
        }

        // Year extraction
        let year = null;
        const releaseAnchor = $('a[href*="/releaseinfo/"]').first();
        if (releaseAnchor && releaseAnchor.text()) {
            const m = releaseAnchor.text().trim().match(/(19|20)\d{2}/);
            if (m) year = m[0];
        }
        if (!year) {
            const y1 = $('#titleYear a').first().text();
            if (y1 && y1.match(/(19|20)\d{2}/)) year = y1.match(/(19|20)\d{2}/)[0];
        }
        if (!year) {
            const metaYearText = $('ul[data-testid="hero-title-block__metadata"]').first().text();
            if (metaYearText) {
                const m2 = metaYearText.match(/(19|20)\d{2}/);
                if (m2) year = m2[0];
            }
        }
        if (!year && name) {
            const m3 = name.match(/\b(19|20)\d{2}\b/);
            if (m3) year = m3[0];
        }

        return { name: name || null, year: year || null };
    } catch (err) {
        console.error('[IMDb] Fetch error:', err.message);
        return null;
    }
}

async function getMetadata(imdbId, type) {
    // Prefer IMDb scraping first
    try {
        const imdbMeta = await getImdbMetadata(imdbId);
        if (imdbMeta && imdbMeta.name) {
            console.log(`[CINEMETA-FALLBACK] Using IMDb metadata: ${imdbMeta.name} (${imdbMeta.year || 'unknown'})`);
            return imdbMeta;
        }
    } catch (e) {
        console.error('[Metadata] IMDb fetch error:', e.message);
    }

    // Try Cinemeta next
    try {
        const metaType = type === 'series' ? 'series' : 'movie';
        const url = `${CINEMETA_URL}/${metaType}/${imdbId}.json`;
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        if (response.data && response.data.meta && response.data.meta.name) {
            console.log(`[Cinemeta] Found: ${response.data.meta.name}`);
            return {
                name: response.data.meta.name,
                year: response.data.meta.year || response.data.meta.releaseInfo
            };
        }
    } catch (error) {
        console.error('[Cinemeta] Error:', error.message);
    }
    
    // Fallback to TMDB
    try {
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const url = `${TMDB_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        const results = type === 'series' ? response.data.tv_results : response.data.movie_results;
        
        if (results && results.length > 0) {
            const item = results[0];
            const name = item.title || item.name;
            const year = (item.release_date || item.first_air_date || '').substring(0, 4);
            console.log(`[TMDB] Found: ${name} (${year})`);
            return { name, year };
        }
    } catch (error) {
        console.error('[TMDB] Error:', error.message);
    }
    
    console.log('[Metadata] No metadata found for:', imdbId);
    return null;
}

/**
 * Detect whether an IMDb id refers to a movie or a series.
 * Strategy: try Cinemeta series/movie endpoints, then TMDB find as fallback.
 */
async function detectMediaType(imdbId) {
    try {
        // Try Cinemeta series endpoint
        const seriesUrl = `${CINEMETA_URL}/series/${imdbId}.json`;
        const sresp = await axios.get(seriesUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        if (sresp && sresp.data && sresp.data.meta) return 'series';
    } catch (e) {}

    try {
        // Try Cinemeta movie endpoint
        const movieUrl = `${CINEMETA_URL}/movie/${imdbId}.json`;
        const mresp = await axios.get(movieUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        if (mresp && mresp.data && mresp.data.meta) return 'movie';
    } catch (e) {}

    // Fallback to TMDB find endpoint
    try {
        const url = `${TMDB_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const resp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        if (resp && resp.data) {
            const tv = resp.data.tv_results || [];
            const mv = resp.data.movie_results || [];
            if (tv.length > 0 && mv.length === 0) return 'series';
            if (mv.length > 0 && tv.length === 0) return 'movie';
            if (tv.length > 0 && mv.length > 0) return tv.length >= mv.length ? 'series' : 'movie';
        }
    } catch (e) {}

    return null;
}

module.exports = { search, download, getImdbMetadata, detectMediaType };