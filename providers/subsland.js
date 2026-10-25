const { normalizeTitle, queryVariants, rowMetadata, movieMatch, yearsMatch } = require('../lib/titles');
const { getMetadata } = require('../lib/metadata');
const { attachRequestLimits, canRequestSource } = require('../lib/requests');
const { matchesEpisode, matchesSeasonPack, matchIdentifiedSeries } = require('../lib/episodes');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { existsSync } = require('node:fs');
const { binary, version: curlVersion } = require('../lib/curl-binary');
const { createCurlAdapter } = require('../lib/subsland-http');
const { fuzzyMatch } = require('./fuzzy');
const { getImdbMetadata } = require('./subsunacs');

const BASE_URL = 'https://subsland.com';
const SEARCH_URL = `${BASE_URL}/index.php`;
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const TMDB_API_KEY = 'b019b78bbd3a80f0f3112369c3b8c243';
const TMDB_URL = 'https://api.themoviedb.org/3';

// Keep the same public session and headers for search, details and downloads.
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': `${BASE_URL}/`
};
const nativeHttp = existsSync(binary) && process.env.SUBSLAND_HTTP_CLIENT !== 'axios';
console.log(`[SubsLand] HTTP client: ${nativeHttp ? 'curl-impersonate ' + curlVersion : 'axios'}`);
const client = attachRequestLimits(wrapper(axios.create({ jar: new CookieJar(), headers: BROWSER_HEADERS,
    ...(nativeHttp ? { adapter: createCurlAdapter() } : {}) })));

function canonicalUrl(value) {
    const url = new URL(value, `${BASE_URL}/`);
    if (!['subsland.com', 'www.subsland.com'].includes(url.hostname) ||
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
        throw new Error('Invalid SubsLand URL');
    }
    // www currently has a broken origin certificate (Cloudflare 525).
    url.hostname = 'subsland.com';
    url.protocol = 'https:';
    return url.href;
}

/**
 * Fetch directly; the site's HTML uses Windows-1251, not UTF-8.
 */
async function fetchPage(url) {
    const resp = await client.get(canonicalUrl(url), {
        responseType: 'arraybuffer',
        headers: BROWSER_HEADERS,
        timeout: 20000
    });
    return iconv.decode(Buffer.from(resp.data), 'win1251');
}

/**
 * Download the original subtitle archive directly from SubsLand.
 */
async function fetchBinary(url, referer = `${BASE_URL}/`) {
    const resp = await client.get(canonicalUrl(url), {
        headers: { Referer: canonicalUrl(referer) },
        responseType: 'arraybuffer',
        timeout: 30000
    });
    return Buffer.from(resp.data);
}

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
            if (process.env.DEBUG_SEARCH) console.log(`[SubsLand Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        if (isSeasonPack) {
            if (process.env.DEBUG_SEARCH) console.log(`[SubsLand Filter] "${subName}" is a season pack for S${s}`);
        }
        
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            if (process.env.DEBUG_SEARCH) console.log(`[SubsLand Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
            return { match: false, score: 0 };
        }
        
        return { match: true, score: matchScore + (isSeasonPack ? 5 : 10), isSeasonPack };
    }
    
    return movieMatch(subName, movieTitle, movieYear);
}

/**
 * Search for Bulgarian subtitles on SubsLand.com
 * category=1 is Bulgarian language
 * Download URLs are directly available in search results (very efficient)
 */
async function searchQuery(imdbId, type, season, episode, query) {
    try {
        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[SubsLand] Could not get metadata for:', imdbId);
            return [];
        }

        const year = meta.year ? String(meta.year).substring(0, 4) : '';
        const isSeries = type === 'series' && season && episode;

        let searchQuery = query || sanitizeSearchString(meta.name);

        console.log(`[SubsLand] Searching for: "${searchQuery}" (target: ${meta.name}${isSeries ? ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : ''}, year=${year || 'unknown'})`);

        const subtitles = [];
        const maxPagesLimit = 4;

        // Parse each result row separately; the legacy page contains malformed table markup.
        const parsePage = (html) => {
            // Only parse after the search results marker to skip featured/carousel section
            const marker = 'Търсенето на субтитри приключи';
            const markerIdx = html.indexOf(marker);
            const resultHtml = markerIdx > -1 ? html.substring(markerIdx) : html;

            // If SubsLand says "not found", skip these results (they're just keyword matches)
            if (resultHtml.includes('Не са открити')) {
                console.log('[SubsLand] No exact matches found, skipping keyword-only results');
                return 0;
            }

            // Extract each <tr> block with regex
            const trRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
            const trBlocks = resultHtml.match(trRegex) || [];

            for (const trBlock of trBlocks) {
                // Must have BOTH a /subtitles/ link AND a /downloadsubtitles/ link (filters out non-results)
                const subMatch = trBlock.match(/href=["']?(https?:\/\/subsland\.com\/subtitles\/[^"'\s>]+)/i);
                const dlMatch = trBlock.match(/href=["']?(https?:\/\/subsland\.com\/downloadsubtitles\/[^"'\s>]+)/i);
                if (!subMatch || !dlMatch) continue;

                const subHref = subMatch[1];
                const idMatch = subHref.match(/-(\d+)\.html/);
                if (!idMatch) continue;
                const subId = idMatch[1];

                let downloadUrl = dlMatch[1];
                if (!downloadUrl.startsWith('http')) {
                    downloadUrl = `${BASE_URL}/${downloadUrl.replace(/^\//, '')}`;
                }

                // Extract title: parse just this <tr> block with cheerio for reliable text extraction
                const $tr = cheerio.load(`<table>${trBlock}</table>`);
                const $titleLink = $tr('a[href*="/subtitles/"]').first();
                const info = rowMetadata($tr, $titleLink.closest('tr'));
                if (info.imdbIds.length && !info.imdbIds.includes(imdbId)) continue;
                let name = $titleLink.text().trim();

                // Fallback: extract from onmouseover tooltip (has release name)
                if (!name || name.length < 2) {
                    const tipMatch = trBlock.match(/Tip\(['"]<font[^>]*><b>([^<]+)<\/b>/i);
                    if (tipMatch) name = tipMatch[1].trim();
                }
                if (!name || name.length < 2) continue;

                // Extract year from the title text (e.g., "Gladiator II (2024)")
                let subtitleYear = null;
                const yearFromName = name.match(/\((\d{4})\)/);
                if (yearFromName) subtitleYear = yearFromName[1];

                // If page provides a year and it doesn't match movie year, skip
                if (!isSeries && subtitleYear && year && !yearsMatch(subtitleYear, year)) {
                    continue;
                }

                // Check if subtitle matches our movie/series
                const matchResult = info.imdbIds.includes(imdbId) ? (isSeries ? matchIdentifiedSeries(name, season, episode) : { match: true, score: 20 }) : isSeries
                    ? isGoodMatch(name, meta.name, null, season, episode)
                    : isGoodMatch(name, meta.name, year);
                if (!matchResult.match) continue;

                const matchScore = matchResult.score;

                console.log(`[SubsLand] Match found: id=${subId} name="${name}" year=${subtitleYear || '?'} score=${matchScore} download=${downloadUrl}`);

                subtitles.push({
                    id: `subsland_${subId}`,
                    name,
                    fps: info.fps,
                    discs: info.discs,
                    lang: 'bul',
                    url: downloadUrl,
                    score: matchScore
                });
            }

            // Read decoded attributes: the live site uses &amp;page= in HTML.
            let maxPage = 0;
            const $ = cheerio.load(resultHtml);
            $('a[href]').each((_, element) => {
                let url;
                try { url = new URL($(element).attr('href'), SEARCH_URL); } catch { return; }
                const page = Number(url.searchParams.get('page'));
                if (url.origin === BASE_URL && url.pathname === '/index.php' &&
                    url.searchParams.get('s') === searchQuery && Number.isInteger(page) && page > maxPage) maxPage = page;
            });
            return maxPage;
        };

        // Fetch first page
        const searchUrl = `${SEARCH_URL}?s=${encodeURIComponent(searchQuery)}&w=name&category=1`;
        let firstHtml;
        try {
            firstHtml = await fetchPage(searchUrl);
        } catch (err) {
            console.error('[SubsLand] Search request failed:', err.message);
            return [];
        }
        let maxFoundPage = parsePage(firstHtml);

        // If multiple pages, fetch them
        for (let page = 1; page <= Math.min(maxFoundPage, maxPagesLimit) && !(isSeries && subtitles.length); page++) {
            const pageUrl = `${SEARCH_URL}?s=${encodeURIComponent(searchQuery)}&w=name&category=1&page=${page}`;
            console.log(`[SubsLand] Fetching page ${page + 1}: ${pageUrl}`);
            try {
                const pageHtml = await fetchPage(pageUrl);
                const maybeMax = parsePage(pageHtml);
                if (maybeMax > maxFoundPage) maxFoundPage = maybeMax;
            } catch (err) {
                console.error('[SubsLand] Page fetch error:', err.message);
                break;
            }
        }

        // Deduplicate by id keeping highest score
        const dedup = {};
        for (const s of subtitles) {
            if (!dedup[s.id] || s.score > dedup[s.id].score) dedup[s.id] = s;
        }
        const results = Object.values(dedup);
        results.sort((a, b) => b.score - a.score || (!isSeries ? (a.discs || 1) - (b.discs || 1) : 0));

        console.log(`[SubsLand] Found ${results.length} subtitles`);
        return results;

    } catch (error) {
        console.error('[SubsLand] Search error:', error.message);
        return [];
    }
}

async function search(imdbId, type, season, episode) {
    if (!canRequestSource(BASE_URL)) return [];
    const meta = await getMetadata(imdbId, type);
    if (!meta) return [];
    for (const query of queryVariants(meta.name)) {
        if (!canRequestSource(BASE_URL)) break;
        const result = await searchQuery(imdbId, type, season, episode, query);
        if (result.length) return result;
    }
    return [];
}

/**
 * Download subtitle from SubsLand.com
 * Download URLs are either direct .zip/.rar links from /downloadsubtitles/
 * or detail page URLs from which we extract the download link
 */
async function download(downloadUrl) {
    try {
        console.log(`[SubsLand] Downloading from: ${downloadUrl}`);

        // If the URL is a direct download link (/downloadsubtitles/), fetch it directly
        if (downloadUrl.includes('/downloadsubtitles/')) {
            const buffer = await fetchBinary(downloadUrl);
            console.log(`[SubsLand] Downloaded ${buffer.length} bytes`);
            return buffer;
        }

        // Otherwise it's a detail page URL - scrape the download link from it
        console.log(`[SubsLand] Fetching detail page for download link: ${downloadUrl}`);
        const detailHtml = await fetchPage(downloadUrl);

        const $ = cheerio.load(detailHtml);
        let dlUrl = null;

        // Look for download link in /downloadsubtitles/ path
        $('a[href*="/downloadsubtitles/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                dlUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
                return false;
            }
        });

        if (!dlUrl) {
            console.log('[SubsLand] No download URL found on detail page');
            return null;
        }

        console.log(`[SubsLand] Downloading: ${dlUrl}`);
        const buffer = await fetchBinary(dlUrl, downloadUrl);
        console.log(`[SubsLand] Downloaded ${buffer.length} bytes`);
        return buffer;

    } catch (error) {
        console.error('[SubsLand] Download error:', error.message);
        throw error;
    }
}



module.exports = { search, download, client };
