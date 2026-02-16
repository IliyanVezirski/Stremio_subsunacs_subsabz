const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { fuzzyMatch } = require('./fuzzy');
const { getImdbMetadata } = require('./subsunacs');

const BASE_URL = 'http://subs.sab.bz';
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
            new RegExp(`s0*${sNum}e0*${eNum}(?!\\d)`, 'i'),   // S03E01, S3E1 (not S3E10)
            new RegExp(`${sNum}x0*${eNum}(?!\\d)`, 'i'),       // 3x01, 03x01 (not 3x10)
            new RegExp(`season\\s*0*${sNum}.*episode\\s*0*${eNum}(?!\\d)`, 'i'), // Season 3 Episode 1
            new RegExp(`\\b0*${sNum}x0*${eNum}\\b`, 'i'),      // 03x01 with word boundaries
        ];
        
        // Season pack patterns (full season without specific episode)
        const seasonPackPatterns = [
            new RegExp(`s0*${sNum}\\b(?!e)`, 'i'),             // S03 but not S03E
            new RegExp(`\\bseason\\s*0*${sNum}\\b`, 'i'),     // Season 3
            new RegExp(`\\bs0*${sNum}[\\s\\.-]*(complete|full|all)`, 'i'), // S03 Complete
            new RegExp(`(complete|full).*s0*${sNum}\\b`, 'i'), // Complete S03
            new RegExp(`\\b0*${sNum}\\b[\\s\\-]*(complete|full|all|season)`, 'i'), // 04 - Complete Season
            new RegExp(`(complete|full|season)[\\s\\-]*0*${sNum}\\b`, 'i'), // Complete Season 04
        ];
        
        const hasSeasonEpisode = sePatterns.some(pattern => pattern.test(subName));
        const isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(subName)) && 
                             !hasSeasonEpisode; // Only if NOT a specific episode
        
        if (!hasSeasonEpisode && !isSeasonPack) {
            console.log(`[Subs.sab.bz Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        // Season packs get slightly lower score than exact episode matches
        if (isSeasonPack) {
            console.log(`[Subs.sab.bz Filter] "${subName}" is a season pack for S${s}`);
        }
        
        // Check that title words are in subtitle (less strict for series)
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            console.log(`[Subs.sab.bz Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
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
    
    // For short titles (1-2 words), be VERY strict
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
            // Next word should be: year, or release term (720p, bluray, etc), or "aka", or episode/season marker
            const isYear = /^(19|20)\d{2}$/.test(nextWord);
            const isReleaseTerm = /^(720p|1080p|2160p|4k|bluray|bdrip|brrip|hdrip|webrip|web|dvdrip|hdtv|proper|repack|extended|unrated|directors|x264|x265|h264|h265|aac|dts|ac3|remux|uhd)$/i.test(nextWord);
            const isAka = nextWord === 'aka' || nextWord === 'a';
            const isNumber = /^\d+$/.test(nextWord);
            const isEpisodePattern = /^\d{1,2}x\d{1,2}$/i.test(nextWord) || /^s\d{1,2}e\d{1,2}$/i.test(nextWord);
            const isSeasonToken = /^season$/i.test(nextWord) || /^s\d{1,2}$/i.test(nextWord);

            if (!isYear && !isReleaseTerm && !isAka && !isNumber && !isEpisodePattern && !isSeasonToken) {
                // Next word is probably part of a different movie title
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
            return { match: true, score: Math.round(fm.score * 10) };
        }
    } catch (e) {
        console.error('[Fuzzy] Error:', e.message);
    }

    return { match: false, score: matchScore };
}

/**
 * Search for subtitles on Subs.sab.bz
 * Note: This site has some issues with downloads, may not always work
 */
async function search(imdbId, type, season, episode) {
    try {
        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[Subs.sab.bz] Could not get metadata for:', imdbId);
            return [];
        }

        const year = meta.year ? String(meta.year).substring(0, 4) : '';
        const isSeries = type === 'series' && season && episode;
        
        // Log search target (do not include year in the search string)
        console.log(`[Subs.sab.bz] Searching for: ${meta.name}${isSeries ? ` S${season}E${episode}` : ''} (year=${year || 'unknown'})`);
        
        let searchQuery = sanitizeSearchString(meta.name);
        
        const searchUrl = `${BASE_URL}/index.php?act=search&movie=${encodeURIComponent(searchQuery)}&select-language=2`;
        
        const response = await axios.get(searchUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'bg,en;q=0.9',
                'Referer': BASE_URL
            },
            timeout: 15000
        });

        const html = iconv.decode(Buffer.from(response.data), 'win1251');
        const $ = cheerio.load(html);

        const subtitles = [];
        const deferred = [];

        // Helper to parse a cheerio document and collect subtitle entries
        const parseDoc = ($doc) => {
            $doc('a[href*="act=download"][onmouseout="hideddrivetip()"]').each((index, element) => {
                const $link = $doc(element);
                const name = $link.text().trim();
                let href = $link.attr('href');

                if (!href || !name || name.length < 2) return;

                // Extract year/date from the row (e.g. <td>13 Mar 2015</td>)
                let subtitleYear = null;
                try {
                    const $row = $link.closest('tr');
                    if ($row.length) {
                        $row.find('td').each((i, td) => {
                            const txt = $doc(td).text().trim();
                            const m = txt.match(/(19|20)\d{2}/);
                            if (m && !subtitleYear) subtitleYear = m[0];
                        });
                    }
                } catch (e) {}

                // If page provides a year and it doesn't match movie year, skip this subtitle
                if (!isSeries && subtitleYear && year && String(subtitleYear) !== String(year)) {
                    return;
                }

                // Check if subtitle matches our movie/series
                const matchResult = isSeries
                    ? isGoodMatch(name, meta.name, null, season, episode)
                    : isGoodMatch(name, meta.name, year);
                if (!matchResult.match) return;

                const matchScore = matchResult.score;

                // Extract attach_id from download URL
                const attachMatch = href.match(/attach_id=(\d+)/);
                if (!attachMatch) return;
                const attachId = attachMatch[1];

                // Make full URL
                if (!href.startsWith('http')) {
                    href = `${BASE_URL}/${href}`;
                }

                // If this is a season pack and an episode is requested, defer inspection of detail page
                // Fall back to including the season pack itself if no episode-specific links found
                if (isSeries && matchResult.isSeasonPack && season && episode) {
                    const packHref = href;
                    const packAttachId = attachId;
                    const packScore = matchScore;
                    deferred.push(
                        fetchEpisodeSubsFromSabDetail(packHref, season, episode).then((episodeSubs) => {
                            if (episodeSubs && episodeSubs.length) {
                                for (const es of episodeSubs) {
                                    subtitles.push({ id: `subssab_${es.id || packAttachId}`, lang: 'bul', url: es.url, score: packScore + 5 });
                                    console.log(`[Subs.sab.bz] Episode found inside season pack: id=${es.id || packAttachId} name="${es.name}" href=${es.url}`);
                                }
                            } else {
                                // No episode-specific links found — include the season pack itself;
                                // the proxy will download the archive and extract the correct episode file
                                subtitles.push({ id: `subssab_${packAttachId}`, lang: 'bul', url: packHref, score: packScore });
                                console.log(`[Subs.sab.bz] Season pack included (archive extraction): id=${packAttachId} name="${name}" href=${packHref}`);
                            }
                        }).catch((e) => {
                            console.error('[Subs.sab.bz] Error fetching season pack details:', e && e.message ? e.message : e);
                            // On error, still include the season pack as fallback
                            subtitles.push({ id: `subssab_${packAttachId}`, lang: 'bul', url: packHref, score: packScore });
                            console.log(`[Subs.sab.bz] Season pack included after error: id=${packAttachId} href=${packHref}`);
                        })
                    );
                    return;
                }

                console.log(`[Subs.sab.bz] Match found: id=${attachId} name="${name}" year=${subtitleYear || '?'} score=${matchScore} href=${href}`);

                subtitles.push({
                    id: `subssab_${attachId}`,
                    lang: 'bul',
                    url: href,
                    score: matchScore
                });
            });
        };

        // Parse first page
        parseDoc($);

        // wait for any deferred seasonal detail inspections
        try { await Promise.all(deferred); } catch (e) {}

        // Helper: fetch a Subs.sab.bz detail page and try to find episode-specific download links
        async function fetchEpisodeSubsFromSabDetail(detailUrl, season, episode) {
            try {
                const r = await axios.get(detailUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': searchUrl }, timeout: 15000 });
                const h = iconv.decode(Buffer.from(r.data), 'win1251');
                const $$ = cheerio.load(h);
                const s = String(season).padStart(2, '0');
                const e = String(episode).padStart(2, '0');
                const patterns = [new RegExp(`s0*${parseInt(season)}e0*${parseInt(episode)}`, 'i'), new RegExp(`${parseInt(season)}x0*${parseInt(episode)}`, 'i'), new RegExp(`\b${s}x${e}\b`, 'i')];
                const found = [];
                $$('a').each((i, el) => {
                    const txt = $$(el).text().trim();
                    let href = $$(el).attr('href');
                    if (!href) return;
                    if (patterns.some(p => p.test(txt) || p.test(href))) {
                        if (!href.startsWith('http')) href = `${BASE_URL}/${href.replace(/^\//, '')}`;
                        const idm = href.match(/attach_id=(\d+)/) || href.match(/id=(\d+)/) || href.match(/-(\d+)\/?$/);
                        const idv = idm ? idm[1] : null;
                        found.push({ id: idv, url: href, name: txt });
                    }
                });
                return found;
            } catch (e) {
                return [];
            }
        }

        // Find numeric pagination links and collect their hrefs
        const pageHrefs = new Set();
        // Look into common pagination containers
        const containers = ['#pages', '.pages', '.pagination', 'center', '.pagenav'];
        containers.forEach((sel) => {
            try {
                $(sel).find('a').each((i2, a) => {
                    const txt = $(a).text().trim();
                    let href = $(a).attr('href');
                    if (!href) return;
                    href = href.trim();
                    // Ignore anchors and javascript pseudo-links
                    if (href === '#' || href === '' || href.startsWith('#') || href.toLowerCase().startsWith('javascript')) return;
                    if (/^\d+$/.test(txt) && href) {
                        let full = href;
                        if (!full.startsWith('http')) full = `${BASE_URL}/${full.replace(/^\//, '')}`;
                        pageHrefs.add(full);
                    }
                });
            } catch (e) {}
        });

        // Fallback: scan all anchors for numeric text
        if (pageHrefs.size === 0) {
            $('a').each((i, a) => {
                const txt = $(a).text().trim();
                let href = $(a).attr('href');
                if (!href) return;
                href = href.trim();
                if (href === '#' || href === '' || href.startsWith('#') || href.toLowerCase().startsWith('javascript')) return;
                if (/^\d+$/.test(txt) && href) {
                    let full = href;
                    if (!full.startsWith('http')) full = `${BASE_URL}/${full.replace(/^\//, '')}`;
                    pageHrefs.add(full);
                }
            });
        }

        // Fetch and parse each page href
        for (const href of pageHrefs) {
            try {
                console.log(`[Subs.sab.bz] Fetching page href: ${href}`);
                const r = await axios.get(href, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': searchUrl }, timeout: 15000 });
                const h = iconv.decode(Buffer.from(r.data), 'win1251');
                const $$ = cheerio.load(h);
                parseDoc($$);
            } catch (e) {
                console.error('[Subs.sab.bz] Page fetch error:', e.message);
            }
        }

        // Deduplicate and sort
        const dedup = {};
        for (const s of subtitles) {
            if (!dedup[s.id] || s.score > dedup[s.id].score) dedup[s.id] = s;
        }
        const results = Object.values(dedup).sort((a, b) => b.score - a.score);

        console.log(`[Subs.sab.bz] Found ${results.length} subtitles across pages`);
        return results;
        
    } catch (error) {
        console.error('[Subs.sab.bz] Search error:', error.message);
        return [];
    }
}

/**
 * Download subtitle - URL is already a direct download link
 */
async function download(downloadUrl) {
    try {
        console.log(`[Subs.sab.bz] Downloading from: ${downloadUrl}`);
        
        // The URL is already the direct download link with attach_id
        const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': BASE_URL,
                'Accept': '*/*'
            },
            timeout: 30000,
            maxRedirects: 5
        });
        
        console.log(`[Subs.sab.bz] Downloaded ${response.data.byteLength} bytes`);
        return Buffer.from(response.data);
        
    } catch (error) {
        console.error('[Subs.sab.bz] Download error:', error.message);
        return null;
    }
}

async function getMetadata(imdbId, type) {
    // For TV series, try TMDB first (can get show name from episode ID)
    if (type === 'series') {
        try {
            const url = `${TMDB_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 10000
            });

            // Direct series match
            if (response.data.tv_results && response.data.tv_results.length > 0) {
                const item = response.data.tv_results[0];
                const name = item.name;
                const year = (item.first_air_date || '').substring(0, 4);
                console.log(`[TMDB] Series found: ${name} (${year})`);
                return { name, year };
            }
            
            // Episode ID - need to get show name
            if (response.data.tv_episode_results && response.data.tv_episode_results.length > 0) {
                const episode = response.data.tv_episode_results[0];
                const showId = episode.show_id;
                console.log(`[TMDB] Episode found, show_id: ${showId}`);
                
                const showUrl = `${TMDB_URL}/tv/${showId}?api_key=${TMDB_API_KEY}`;
                const showResp = await axios.get(showUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 10000
                });
                
                if (showResp.data && showResp.data.name) {
                    const name = showResp.data.name;
                    const year = (showResp.data.first_air_date || '').substring(0, 4);
                    console.log(`[TMDB] Show from episode: ${name} (${year})`);
                    return { name, year };
                }
            }
        } catch (error) {
            console.error('[TMDB] Error:', error.message);
        }
    }

    // Try IMDb scraping
    try {
        const imdbMeta = await getImdbMetadata(imdbId);
        if (imdbMeta && imdbMeta.name) {
            console.log(`[Subs.sab.bz] IMDb metadata: ${imdbMeta.name} (${imdbMeta.year || 'unknown'})`);
            return imdbMeta;
        }
    } catch (e) {
        console.error('[Subs.sab.bz] IMDb fetch error:', e.message);
    }

    // Try Cinemeta
    try {
        const metaType = type === 'series' ? 'series' : 'movie';
        const url = `${CINEMETA_URL}/${metaType}/${imdbId}.json`;
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        if (response.data && response.data.meta && response.data.meta.name) {
            return {
                name: response.data.meta.name,
                year: response.data.meta.year || response.data.meta.releaseInfo
            };
        }
    } catch (error) {
        console.error('[Cinemeta] Error:', error.message);
    }
    
    // Fallback to TMDB for movies
    if (type !== 'series') {
        console.log('[Subs.sab.bz] Trying TMDB for movie...');
        try {
            const url = `${TMDB_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 10000
            });

            if (response.data.movie_results && response.data.movie_results.length > 0) {
                const item = response.data.movie_results[0];
                const name = item.title || item.name;
                const year = (item.release_date || '').substring(0, 4);
                return { name, year };
            }
        } catch (error) {
            console.error('[TMDB] Error:', error.message);
        }
    }

    return null;
}

module.exports = { search, download };
