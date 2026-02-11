const axios = require('axios');
const cheerio = require('cheerio');
const { fuzzyMatch } = require('./fuzzy');
const { getImdbMetadata } = require('./subsunacs');

const BASE_URL = 'https://subsland.com';
const SEARCH_URL = `${BASE_URL}/index.php`;
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const TMDB_API_KEY = 'b019b78bbd3a80f0f3112369c3b8c243';
const TMDB_URL = 'https://api.themoviedb.org/3';

// Browser-like headers to avoid Cloudflare 403 blocks
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"'
};

const JINA_PREFIX = 'https://r.jina.ai/';

/**
 * Fetch an HTML page from SubsLand, bypassing Cloudflare.
 * Strategy: try direct request first, fall back to Jina AI proxy on 403.
 */
async function fetchPage(url) {
    // Try direct request first
    try {
        const resp = await axios.get(url, {
            headers: BROWSER_HEADERS,
            timeout: 15000,
            maxRedirects: 5
        });
        if (resp.status === 200) return resp.data;
    } catch (err) {
        if (!err.response || err.response.status !== 403) {
            throw err;
        }
        console.log('[SubsLand] Direct request got 403, using Jina AI proxy...');
    }

    // Fallback: Jina AI proxy
    const jinaUrl = `${JINA_PREFIX}${url}`;
    const resp = await axios.get(jinaUrl, {
        headers: {
            'Accept': 'text/html',
            'X-Return-Format': 'html'
        },
        timeout: 20000
    });
    return resp.data;
}

/**
 * Download a binary file from SubsLand (not behind Cloudflare).
 */
async function fetchBinary(url, referer) {
    const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            ...BROWSER_HEADERS,
            'Referer': referer || BASE_URL
        },
        timeout: 30000
    });
    return Buffer.from(resp.data);
}

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
            new RegExp(`\\b0*${sNum}\\b[\\s\\-]*(complete|full|all|season)`, 'i'),
            new RegExp(`(complete|full|season)[\\s\\-]*0*${sNum}\\b`, 'i'),
        ];
        
        const hasSeasonEpisode = sePatterns.some(pattern => pattern.test(subName));
        const isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(subName)) && 
                             !hasSeasonEpisode;
        
        if (!hasSeasonEpisode && !isSeasonPack) {
            console.log(`[SubsLand Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        if (isSeasonPack) {
            console.log(`[SubsLand Filter] "${subName}" is a season pack for S${s}`);
        }
        
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            console.log(`[SubsLand Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
            return { match: false, score: 0 };
        }
        
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
        const startsWithTitle = titleWords.every((word, i) => subWords[i] === word);
        if (!startsWithTitle) {
            return { match: false, score: 0 };
        }

        const nextWordIndex = titleWords.length;
        if (subWords[nextWordIndex]) {
            const nextWord = subWords[nextWordIndex];
            const isYear = /^(19|20)\d{2}$/.test(nextWord);
            const isReleaseTerm = /^(720p|1080p|2160p|4k|bluray|bdrip|brrip|hdrip|webrip|web|dvdrip|hdtv|proper|repack|extended|unrated|directors|x264|x265|h264|h265|aac|dts|ac3|remux|uhd)$/i.test(nextWord);
            const isAka = nextWord === 'aka' || nextWord === 'a';
            const isNumber = /^\d+$/.test(nextWord);
            const isEpisodePattern = /^\d{1,2}x\d{1,2}$/i.test(nextWord) || /^s\d{1,2}e\d{1,2}$/i.test(nextWord);
            const isSeasonToken = /^season$/i.test(nextWord) || /^s\d{1,2}$/i.test(nextWord);

            if (!isYear && !isReleaseTerm && !isAka && !isNumber && !isEpisodePattern && !isSeasonToken) {
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

    // Fallback: fuzzy matching
    try {
        const fm = fuzzyMatch(subName, movieTitle);
        if (fm.match) {
            console.log(`[SubsLand Fuzzy] Accepted: lev=${fm.lev.toFixed(2)} overlap=${fm.overlap.toFixed(2)} score=${fm.score.toFixed(2)}`);
            return { match: true, score: Math.round(fm.score * 10) };
        }
    } catch (e) {
        console.error('[SubsLand Fuzzy] Error:', e.message);
    }

    return { match: false, score: matchScore };
}

/**
 * Search for Bulgarian subtitles on SubsLand.com
 * category=1 is Bulgarian language
 * Download URLs are directly available in search results (very efficient)
 */
async function search(imdbId, type, season, episode) {
    try {
        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[SubsLand] Could not get metadata for:', imdbId);
            return [];
        }

        const year = meta.year ? String(meta.year).substring(0, 4) : '';
        const isSeries = type === 'series' && season && episode;

        let searchQuery = sanitizeSearchString(meta.name);
        if (isSeries) {
            const s = String(season).padStart(2, '0');
            const e = String(episode).padStart(2, '0');
            searchQuery = `${sanitizeSearchString(meta.name)} S${s}E${e}`;
        }

        console.log(`[SubsLand] Searching for: "${searchQuery}" (target: ${meta.name}${isSeries ? ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : ''}, year=${year || 'unknown'})`);

        const subtitles = [];
        const maxPagesLimit = 5;

        // Parse a page and collect subtitles
        const parsePage = (html) => {
            const $ = cheerio.load(html);

            // Each search result row is a <tr> with subtitle link, download link, and IMDB link
            $('tr').each((index, row) => {
                const $row = $(row);

                // Find the subtitle title link (links to /subtitles/NAME-ID.html)
                const $titleLink = $row.find('a[href*="/subtitles/"]').first();
                if (!$titleLink.length) return;

                const titleHref = $titleLink.attr('href') || '';
                if (!titleHref.includes('/subtitles/')) return;

                const name = $titleLink.text().trim();
                if (!name || name.length < 2) return;

                // Extract subtitle ID from the URL (format: NAME-ID.html)
                const idMatch = titleHref.match(/-(\d+)\.html/);
                if (!idMatch) return;
                const subId = idMatch[1];

                // Find the direct download link (links to /downloadsubtitles/)
                const $downloadLink = $row.find('a[href*="/downloadsubtitles/"]');
                let downloadUrl = null;
                if ($downloadLink.length) {
                    downloadUrl = $downloadLink.attr('href') || null;
                    if (downloadUrl && !downloadUrl.startsWith('http')) {
                        downloadUrl = `${BASE_URL}/${downloadUrl.replace(/^\//, '')}`;
                    }
                }

                // If no direct download link found, we'll construct one from the detail page later
                if (!downloadUrl) {
                    downloadUrl = titleHref;
                    if (!downloadUrl.startsWith('http')) {
                        downloadUrl = `${BASE_URL}/${downloadUrl.replace(/^\//, '')}`;
                    }
                }

                // Extract year from the title text (e.g., "Gladiator II (2024)")
                let subtitleYear = null;
                const yearFromName = name.match(/\((\d{4})\)/);
                if (yearFromName) subtitleYear = yearFromName[1];

                // If page provides a year and it doesn't match movie year, skip
                if (!isSeries && subtitleYear && year && String(subtitleYear) !== String(year)) {
                    return;
                }

                // Check if subtitle matches our movie/series
                const matchResult = isSeries
                    ? isGoodMatch(name, meta.name, null, season, episode)
                    : isGoodMatch(name, meta.name, year);
                if (!matchResult.match) return;

                const matchScore = matchResult.score;

                console.log(`[SubsLand] Match found: id=${subId} name="${name}" year=${subtitleYear || '?'} score=${matchScore} download=${downloadUrl}`);

                subtitles.push({
                    id: `subsland_${subId}`,
                    lang: 'bul',
                    url: downloadUrl,
                    score: matchScore
                });
            });

            // Detect pagination: look for page links like "21 - 40" or page numbers
            let maxPage = 0;
            $('a[href*="&page="]').each((i, el) => {
                const href = $(el).attr('href') || '';
                const pageMatch = href.match(/[&?]page=(\d+)/);
                if (pageMatch) {
                    const pNum = parseInt(pageMatch[1], 10);
                    if (pNum > maxPage) maxPage = pNum;
                }
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
        for (let page = 1; page <= Math.min(maxFoundPage, maxPagesLimit); page++) {
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

        // If it's a series and we found no results, try broader search with just the title and season
        if (isSeries && subtitles.length === 0) {
            const s = String(season).padStart(2, '0');
            const broaderQuery = `${sanitizeSearchString(meta.name)} S${s}`;
            console.log(`[SubsLand] No episode results, trying broader search: "${broaderQuery}"`);
            const broaderUrl = `${SEARCH_URL}?s=${encodeURIComponent(broaderQuery)}&w=name&category=1`;
            try {
                const broaderHtml = await fetchPage(broaderUrl);
                parsePage(broaderHtml);
            } catch (err) {
                console.error('[SubsLand] Broader search failed:', err.message);
            }
        }

        // Deduplicate by id keeping highest score
        const dedup = {};
        for (const s of subtitles) {
            if (!dedup[s.id] || s.score > dedup[s.id].score) dedup[s.id] = s;
        }
        const results = Object.values(dedup);
        results.sort((a, b) => b.score - a.score);

        console.log(`[SubsLand] Found ${results.length} subtitles`);
        return results;

    } catch (error) {
        console.error('[SubsLand] Search error:', error.message);
        return [];
    }
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
        return null;
    }
}

async function getMetadata(imdbId, type) {
    // Prefer IMDb scraping first
    try {
        const imdbMeta = await getImdbMetadata(imdbId);
        if (imdbMeta && imdbMeta.name) {
            console.log(`[SubsLand] IMDb metadata: ${imdbMeta.name} (${imdbMeta.year || 'unknown'})`);
            return imdbMeta;
        }
    } catch (e) {
        console.error('[SubsLand] IMDb fetch error:', e.message);
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
            return {
                name: response.data.meta.name,
                year: response.data.meta.year || response.data.meta.releaseInfo
            };
        }
    } catch (error) {
        console.error('[SubsLand Cinemeta] Error:', error.message);
    }
    
    // Fallback to TMDB
    console.log('[SubsLand] Cinemeta failed, trying TMDB...');
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
            const yearStr = (item.release_date || item.first_air_date || '').substring(0, 4);
            return { name, year: yearStr };
        }
    } catch (error) {
        console.error('[SubsLand TMDB] Error:', error.message);
    }

    return null;
}

module.exports = { search, download };
