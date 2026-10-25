const { normalizeTitle, queryVariants, rowMetadata, movieMatch, yearsMatch } = require('../lib/titles');
const { getMetadata } = require('../lib/metadata');
const { matchesEpisode, matchesSeasonPack, matchIdentifiedSeries } = require('../lib/episodes');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { attachRequestLimits } = require('../lib/requests');
const { fuzzyMatch } = require('./fuzzy');
const { getImdbMetadata } = require('./subsunacs');

const BASE_URL = 'http://subs.sab.bz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const client = attachRequestLimits(wrapper(axios.create({ jar: new CookieJar(), headers: { 'User-Agent': USER_AGENT } })));
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
            if (process.env.DEBUG_SEARCH) console.log(`[Subs.sab.bz Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        // Season packs get slightly lower score than exact episode matches
        if (isSeasonPack) {
            if (process.env.DEBUG_SEARCH) console.log(`[Subs.sab.bz Filter] "${subName}" is a season pack for S${s}`);
        }
        
        // Check that title words are in subtitle (less strict for series)
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            if (process.env.DEBUG_SEARCH) console.log(`[Subs.sab.bz Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
            return { match: false, score: 0 };
        }
        
        // Season packs get lower score (5) than exact episode matches (10)
        return { match: true, score: matchScore + (isSeasonPack ? 5 : 10), isSeasonPack };
    }
    
    return movieMatch(subName, movieTitle, movieYear);
}

/**
 * Search for subtitles on Subs.sab.bz
 * Note: This site has some issues with downloads, may not always work
 */
async function searchQuery(imdbId, type, season, episode, query, byImdb = false) {
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
        
        let searchQuery = query || sanitizeSearchString(meta.name);
        
        const searchUrl = `${BASE_URL}/index.php?act=search&${byImdb ? 'imdb=' + encodeURIComponent(imdbId) : 'movie=' + encodeURIComponent(searchQuery)}&select-language=2`;
        
        const response = await client.get(searchUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'bg,en;q=0.9',
                'Referer': BASE_URL
            },
            timeout: 15000
        });

        const html = iconv.decode(Buffer.from(response.data), 'win1251');
        const $ = cheerio.load(html);

        const subtitles = [];

        // Helper to parse a cheerio document and collect subtitle entries
        const parseDoc = ($doc) => {
            const links = $doc('a[href*="act=download"][onmouseout="hideddrivetip()"], td.c2field a[href*="act=download"]');
            links.each((index, element) => {
                const $link = $doc(element);
                const name = $link.text().trim();
                let href = $link.attr('href');

                if (!href || !name || name.length < 2) return;
                const info = rowMetadata($doc, $link.closest('tr'), -1);
                if (info.imdbIds.length && !info.imdbIds.includes(imdbId)) return;

                // Extract year/date from the row (e.g. <td>13 Mar 2015</td>)
                let subtitleYear = null;
                try {
                    const $row = $link.closest('tr');
                    if ($row.length) {
                        $row.find('td').each((i, td) => {
                            const txt = $doc(td).text().trim();
                            // Ignore upload dates; only use a standalone release-year cell.
                            const m = txt.match(/^\(?((?:19|20)\d{2})\)?$/);
                            if (m && !subtitleYear) subtitleYear = m[1];
                        });
                    }
                } catch (e) {}

                // If page provides a year and it doesn't match movie year, skip this subtitle
                if (!isSeries && subtitleYear && year && !yearsMatch(subtitleYear, year)) {
                    return;
                }

                // Check if subtitle matches our movie/series
                const matchResult = info.imdbIds.includes(imdbId) ? (isSeries ? matchIdentifiedSeries(name, season, episode) : { match: true, score: 20 }) : isSeries
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

                console.log(`[Subs.sab.bz] Match found: id=${attachId} name="${name}" year=${subtitleYear || '?'} score=${matchScore} href=${href}`);

                subtitles.push({
                    id: `subssab_${attachId}`,
                    name,
                    fps: info.fps,
                    discs: info.discs,
                    lang: 'bul',
                    url: href,
                    score: matchScore
                });
            });
            return links.length;
        };

        // Parse first page
        const firstPageCount = parseDoc($);

        // Discover links on every page; later pages can reveal older seasons.
        const pages = new Map();
        const seen = new Set([0]);
        const collectPages = doc => {
            doc('a[href]').each((_, el) => {
                let url;
                try { url = new URL(doc(el).attr('href'), BASE_URL); } catch { return; }
                const offset = Number(url.searchParams.get('st'));
                if (url.origin === BASE_URL && url.searchParams.get('act') === 'search' &&
                    Number.isInteger(offset) && offset > 0 && !seen.has(offset)) pages.set(offset, url.href);
            });
        };
        // The site renders a "next" link even for an empty result set.
        if (firstPageCount) collectPages($);
        // A matching episode/season pack is sufficient; avoid crawling unrelated seasons.
        while (pages.size && seen.size < 15 && !(isSeries && subtitles.length) && !(subtitles.length >= 10)) {
            const [offset, href] = pages.entries().next().value;
            pages.delete(offset);
            seen.add(offset);
            try {
                const response = await client.get(href, { responseType: 'arraybuffer', headers: { 'User-Agent': USER_AGENT, Referer: searchUrl }, timeout: 15000 });
                const doc = cheerio.load(iconv.decode(Buffer.from(response.data), 'win1251'));
                const pageCount = parseDoc(doc);
                if (!pageCount) break;
                collectPages(doc);
            } catch (error) {
                console.error('[Subs.sab.bz] Page fetch error:', error.message);
                break;
            }
        }

        // Deduplicate and sort
        const dedup = {};
        for (const s of subtitles) {
            if (!dedup[s.id] || s.score > dedup[s.id].score) dedup[s.id] = s;
        }
        const results = Object.values(dedup).sort((a, b) => b.score - a.score || (!isSeries ? (a.discs || 1) - (b.discs || 1) : 0) || Number(b.id.split('_').pop()) - Number(a.id.split('_').pop()));

        console.log(`[Subs.sab.bz] Found ${results.length} subtitles across pages`);
        return results;
        
    } catch (error) {
        console.error('[Subs.sab.bz] Search error:', error.message);
        return [];
    }
}

async function search(imdbId, type, season, episode) {
    let results = await searchQuery(imdbId, type, season, episode, null, true);
    if (results.length) return results;
    const meta = await getMetadata(imdbId, type);
    if (!meta) return [];
    for (const query of queryVariants(meta.name)) {
        results = await searchQuery(imdbId, type, season, episode, query);
        if (results.length) return results;
    }
    return [];
}

/**
 * Download subtitle - URL is already a direct download link
 */
async function download(downloadUrl) {
    try {
        console.log(`[Subs.sab.bz] Downloading from: ${downloadUrl}`);
        
        // The URL is already the direct download link with attach_id
        const response = await client.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': USER_AGENT,
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
        throw error;
    }
}



module.exports = { search, download, client };
