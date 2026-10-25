const { normalizeTitle, queryVariants, rowMetadata, movieMatch, yearsMatch } = require('../lib/titles');
const { getMetadata } = require('../lib/metadata');
const { matchesEpisode, matchesSeasonPack, matchIdentifiedSeries } = require('../lib/episodes');
const { releaseMetadata } = require('../lib/releases');
const { canRequestSource } = require('../lib/requests');
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
        if (normalizedSub !== normalizedTitle && !normalizedSub.startsWith(normalizedTitle + ' ')) return { match: false, score: 0 };
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        
        const hasSeasonEpisode = matchesEpisode(subName, season, episode);
        const isSeasonPack = matchesSeasonPack(subName, season);

        if (!hasSeasonEpisode && !isSeasonPack) {
            if (process.env.DEBUG_SEARCH) console.log(`[Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        // Season packs get slightly lower score than exact episode matches
        if (isSeasonPack) {
            if (process.env.DEBUG_SEARCH) console.log(`[Filter] "${subName}" is a season pack for S${s}`);
        }
        
        // Check that title words are in subtitle (less strict for series)
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            if (process.env.DEBUG_SEARCH) console.log(`[Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
            return { match: false, score: 0 };
        }
        
        // Season packs get lower score (5) than exact episode matches (10)
        return { match: true, score: matchScore + (isSeasonPack ? 5 : 10), isSeasonPack };
    }
    
    return movieMatch(subName, movieTitle, movieYear);
}

/**
 * Search for subtitles on Subsunacs.net
 * Based on kgkolev/service.subtitles.subsunacs Kodi addon
 */
async function searchQuery(imdbId, type, season, episode, query) {
    try {
        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[Subsunacs] Could not get metadata for:', imdbId);
            return [];
        }

        const year = meta.year ? String(meta.year).substring(0, 4) : '';
        const isSeries = type === 'series' && season && episode;
        
        // Build search query
        let searchQuery = sanitizeSearchString(meta.name);
        if (isSeries) {
            const s = String(season).padStart(2, '0');
            searchQuery = `${sanitizeSearchString(meta.name)} ${s}`;
        }
        if (query) searchQuery = query;
        
        console.log(`[Subsunacs] Searching for: "${searchQuery}" (target: ${meta.name}${isSeries ? ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : ''}, year=${year || 'unknown'})`);

        // We'll request the first page via POST and then detect pagination and iterate further pages
        const searchParams = new URLSearchParams({
            m: searchQuery,
            imdbcheck: '1',
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
        const maxPagesLimit = 8;

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
                if (!isSeries && subtitleYear && year && !yearsMatch(subtitleYear, year)) {
                    return;
                }

                let matchResult = isSeries
                    ? isGoodMatch(name, meta.name, null, season, episode)
                    : isGoodMatch(name, meta.name, year);
                // The site's tooltip poster filename is the numeric IMDb ID (sometimes zero-padded).
                const posterId = ($link.attr('title') || '').match(/ii\/big(?:200)?\/(\d+)\.(?:jpg|png)/i)?.[1];
                // Same-title remakes are different series: a known conflicting IMDb ID is a rejection.
                if (Number(posterId) > 0 && Number(posterId) !== Number(imdbId.slice(2))) return;
                if (posterId && Number(posterId) === Number(imdbId.slice(2))) matchResult = isSeries ? matchIdentifiedSeries(name, season, episode) : { match: true, score: 20 };
                if (!isSeries && !matchResult.match && subtitleYear) {
                    const aliases = $link.siblings('span.smGray').map((_, el) => $(el).text().trim()).get();
                    if (aliases.some(alias => movieMatch(alias, meta.name, year).match)) matchResult = { match: true, score: 10 };
                }
                if (!matchResult.match) return;

                const matchScore = matchResult.score;

                if (!href.startsWith('http')) {
                    href = `${BASE_URL}/${href.replace(/^\//, '')}`;
                }

                // Extract subtitle ID from URL
                const idMatch = href.match(/-(\d+)\/?$/) || href.match(/id=(\d+)/);
                const subId = idMatch ? idMatch[1] : (href + Math.random()).toString();

                const release = releaseMetadata(cheerio.load($link.attr('title') || '').text());
                subtitles.push({
                    id: `subsunacs_${subId}`,
                    name,
                    lang: 'bul',
                    url: href,
                    score: matchScore,
                    quality: release.quality,
                    fps: release.fps,
                    formats: release.formats
                });
                console.log(`[Subsunacs] Match found: id=${subId} name="${name}" year=${subtitleYear || '?'} score=${matchScore} href=${href}`);
            });

            // detect pagination from <select> dropdown (options like "Стр. 1", "Стр. 2", ...)
            let maxPage = 1;
            $('select').each((i, sel) => {
                $(sel).find('option').each((j, opt) => {
                    const txt = $(opt).text().trim();
                    const val = $(opt).attr('value');
                    // Match "Стр. N" pattern used by subsunacs pagination
                    const m = txt.match(/Стр\.\s*(\d+)/);
                    if (m) {
                        const pNum = parseInt(m[1], 10);
                        if (pNum > maxPage) maxPage = pNum;
                    }
                });
            });
            return maxPage;
        };

        // Parse first page
        const firstHtml = iconv.decode(Buffer.from(firstResponse.data), 'win1251');
        let maxFoundPage = parsePage(firstHtml);

        // If multiple pages, iterate pages via GET using the p= parameter format that subsunacs uses
        for (let page = 2; page <= Math.min(maxFoundPage, maxPagesLimit) && !(isSeries && subtitles.length); page++) {
            const pageUrl = `${SEARCH_URL}?t=1&m=${encodeURIComponent(searchQuery)}&imdbcheck=1&y=0&u=&c=&l=0&a=&d=&g=&o=0&s=0&memid=0&p=${page}`;
            console.log(`[Subsunacs] Fetching page ${page}: ${pageUrl}`);
            try {
                const resp = await axios.get(pageUrl, {
                    responseType: 'arraybuffer',
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'bg,en;q=0.9', 'Referer': BASE_URL },
                    timeout: 15000
                });
                const html = iconv.decode(Buffer.from(resp.data), 'win1251');
                const maybeMax = parsePage(html);
                if (maybeMax > maxFoundPage) maxFoundPage = maybeMax;
            } catch (err) {
                console.error('[Subsunacs] Page fetch error:', err.message);
                break;
            }
        }

        // Deduplicate by id keeping highest score
        const dedup = {};
        for (const s of subtitles) {
            if (!dedup[s.id] || s.score > dedup[s.id].score) dedup[s.id] = s;
        }
        const results = Object.values(dedup);
        results.sort((a, b) => b.score - a.score || b.quality - a.quality || Number(b.id.split('_').pop()) - Number(a.id.split('_').pop()));

        console.log(`[Subsunacs] Found ${results.length} subtitles across pages`);
        return results;
        
    } catch (error) {
        console.error('[Subsunacs] Search error:', error.message);
        return [];
    }
}

async function search(imdbId, type, season, episode) {
    if (!canRequestSource(BASE_URL)) return [];
    const meta = await getMetadata(imdbId, type);
    if (!meta) return [];
    const titles = queryVariants(meta.name);
    const queries = type === 'series' ? [`${titles[0]} ${String(season).padStart(2, '0')}`, ...titles] : titles;
    for (const query of [...new Set(queries)]) {
        if (!canRequestSource(BASE_URL)) break;
        const result = await searchQuery(imdbId, type, season, episode, query);
        if (result.length) return result;
    }
    return [];
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
        const target = new URL(downloadUrl);
        if (!['subsunacs.net', 'www.subsunacs.net'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.port) {
            throw new Error('Invalid Subsunacs download target');
        }
        
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
        throw error;
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
