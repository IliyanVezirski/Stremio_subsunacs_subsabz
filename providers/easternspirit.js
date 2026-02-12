const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { fuzzyMatch } = require('./fuzzy');

const BASE_URL = 'https://www.easternspirit.org/forum/index.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Session state
let client = null;
let jar = null;
let sessionCsrf = null;
let loggedIn = false;

/**
 * Initialize HTTP client with cookie jar
 */
function initClient() {
    jar = new CookieJar();
    client = wrapper(axios.create({
        jar,
        headers: { 'User-Agent': UA },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true
    }));
}

/**
 * Login to Eastern Spirit forum
 */
async function login() {
    const username = process.env.ES_USERNAME || 'zamunda_is_great';
    const password = process.env.ES_PASSWORD || '102088077';

    try {
        if (!client) initClient();

        // Get login page for CSRF token
        const loginPageResp = await client.get(`${BASE_URL}?/login/`);
        const csrfMatch = loginPageResp.data.match(/name=["']csrfKey["']\s*value=["']([^"']+)/);
        if (!csrfMatch) {
            console.log('[EasternSpirit] Could not find CSRF token on login page');
            return false;
        }

        // POST login
        const params = new URLSearchParams();
        params.append('login__standard_submitted', '1');
        params.append('csrfKey', csrfMatch[1]);
        params.append('auth', username);
        params.append('password', password);
        params.append('remember_me', '1');
        params.append('_processLogin', 'usernamepassword');

        const loginResp = await client.post(`${BASE_URL}?/login/`, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': `${BASE_URL}?/login/`
            }
        });

        // Check if login succeeded
        const isLoggedIn = loginResp.data.includes('Sign Out') || loginResp.data.includes('Изход') || loginResp.data.includes('Unread Content');
        if (!isLoggedIn) {
            console.log('[EasternSpirit] Login failed - check credentials');
            return false;
        }

        // Extract csrfKey from the response for later use
        const newCsrf = loginResp.data.match(/csrfKey=([a-f0-9]+)/);
        sessionCsrf = newCsrf ? newCsrf[1] : csrfMatch[1];
        loggedIn = true;
        console.log('[EasternSpirit] Login successful');
        return true;
    } catch (err) {
        console.error('[EasternSpirit] Login error:', err.message);
        return false;
    }
}

/**
 * Ensure we have an active session. Re-login if needed.
 */
async function ensureSession() {
    if (loggedIn && client) {
        // Quick check: fetch a page and see if still logged in
        try {
            const resp = await client.get(BASE_URL);
            if (resp.data.includes('Sign Out') || resp.data.includes('Изход')) {
                // Update csrf
                const csrf = resp.data.match(/csrfKey=([a-f0-9]+)/);
                if (csrf) sessionCsrf = csrf[1];
                return true;
            }
        } catch (e) { /* fall through to re-login */ }
    }

    // Need to login
    initClient();
    loggedIn = false;
    return await login();
}

/**
 * Refresh csrfKey from any page response
 */
function refreshCsrf(html) {
    const csrf = html.match(/csrfKey=([a-f0-9]+)/);
    if (csrf) sessionCsrf = csrf[1];
}

/**
 * Normalize title for comparison
 */
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\u0400-\u04FF\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Check if a search result matches the target title
 */
function isGoodMatch(resultTitle, targetTitle, targetYear) {
    const normResult = normalizeTitle(resultTitle);
    const normTarget = normalizeTitle(targetTitle);

    // Extract year from result title like "Squid Game 2 2024" -> 2024
    const resultYearMatch = resultTitle.match(/(\d{4})\s*$/);
    const resultYear = resultYearMatch ? resultYearMatch[1] : null;
    // Title without year
    const resultNoYear = normResult.replace(/\s*\d{4}\s*$/, '').trim();
    const targetNoYear = normTarget.replace(/\s*\d{4}\s*$/, '').trim();

    // Direct match
    if (resultNoYear === targetNoYear) {
        return { match: true, score: 20 };
    }

    // Result starts with target (e.g. "squid game 2" starts with "squid game")
    if (resultNoYear.startsWith(targetNoYear + ' ') || targetNoYear.startsWith(resultNoYear + ' ')) {
        return { match: true, score: 18 };
    }

    // Word overlap - all target words must appear in result
    const targetWords = targetNoYear.split(/\s+/).filter(w => w.length >= 2);
    const resultWords = resultNoYear.split(/\s+/);
    let overlap = 0;
    for (const tw of targetWords) {
        if (resultWords.some(rw => rw === tw)) overlap++;
    }

    // If ALL target words are in result, it's a match (result may have extra words like season number)
    if (overlap === targetWords.length && targetWords.length >= 1) {
        return { match: true, score: overlap + 5 };
    }

    const minMatches = Math.max(1, Math.ceil(targetWords.length * 0.6));
    if (overlap >= minMatches) {
        if (targetYear && resultYear && targetYear !== resultYear) {
            return { match: false, score: 0 };
        }
        return { match: true, score: overlap };
    }

    // Fuzzy match
    try {
        const fm = fuzzyMatch(resultTitle, targetTitle);
        if (fm.match) {
            return { match: true, score: Math.round(fm.score * 10) };
        }
    } catch (e) { /* ignore */ }

    return { match: false, score: 0 };
}

/**
 * Get metadata for an IMDB ID using Cinemeta
 */
async function getMetadata(imdbId, type) {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        const resp = await axios.get(url, { timeout: 10000 });
        if (resp.data && resp.data.meta) {
            const meta = resp.data.meta;
            const year = (meta.releaseInfo || meta.year || '').toString().substring(0, 4);
            return { name: meta.name, year };
        }
    } catch (e) { /* fall through */ }

    // Fallback: TMDB
    try {
        const tmdbKey = 'b019b78bbd3a80f0f3112369c3b8c243';
        const resp = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbKey}&external_source=imdb_id`, { timeout: 10000 });
        const results = type === 'series' ? resp.data.tv_results : resp.data.movie_results;
        if (results && results.length > 0) {
            const item = results[0];
            return { name: item.title || item.name, year: (item.release_date || item.first_air_date || '').substring(0, 4) };
        }
    } catch (e) { /* ignore */ }

    return null;
}

/**
 * Search for subtitles on Eastern Spirit
 */
async function search(imdbId, type, season, episode) {
    try {
        if (!await ensureSession()) {
            console.log('[EasternSpirit] Not logged in, skipping');
            return [];
        }

        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[EasternSpirit] Could not get metadata for:', imdbId);
            return [];
        }

        const isSeries = type === 'series' && season && episode;
        console.log(`[EasternSpirit] Searching for: "${meta.name}" (${isSeries ? `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : 'movie'}, year=${meta.year || '?'})`);

        // POST search
        const searchParams = new URLSearchParams();
        searchParams.append('csrfKey', sessionCsrf);
        searchParams.append('q', meta.name);
        searchParams.append('type', 'downloads_file');

        const searchResp = await client.post(`${BASE_URL}?/search/`, searchParams.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        refreshCsrf(searchResp.data);

        // Parse search results - extract unique file IDs and titles
        const seen = new Map();
        const regex = /\/files\/file\/(\d+)-([^/"'&\s]+)[^"']*["'][^>]*>([^<]{2,})/g;
        let m;
        while ((m = regex.exec(searchResp.data)) !== null) {
            const id = m[1];
            const slug = m[2];
            const text = m[3].trim();
            if (text.match(/^\d|comment|reaction/i)) continue;
            if (!seen.has(id)) {
                const titleFromSlug = slug.replace(/-/g, ' ');
                seen.set(id, { id, slug, title: text || titleFromSlug });
            }
        }

        const results = [...seen.values()];
        console.log(`[EasternSpirit] Found ${results.length} search results`);

        // Match results against target title
        const subtitles = [];
        for (const result of results) {
            const matchResult = isGoodMatch(result.title, meta.name, meta.year);
            if (!matchResult.match) {
                console.log(`[EasternSpirit Filter] "${result.title}" doesn't match "${meta.name}"`);
                continue;
            }

            console.log(`[EasternSpirit] Match: id=${result.id} "${result.title}" score=${matchResult.score}`);

            if (isSeries) {
                // For series: get download page to find episode revisions
                const episodeSubs = await getSeriesRevisions(result.id, result.slug, season, episode);
                subtitles.push(...episodeSubs);
            } else {
                // For movies: get the file detail page download link
                const movieSub = await getMovieDownload(result.id, result.slug);
                if (movieSub) subtitles.push(movieSub);
            }

            // Stop after first good match
            if (subtitles.length > 0) break;
        }

        console.log(`[EasternSpirit] Found ${subtitles.length} subtitles`);
        return subtitles;
    } catch (error) {
        console.error('[EasternSpirit] Search error:', error.message);
        return [];
    }
}

/**
 * Get movie download info from file detail page
 */
async function getMovieDownload(fileId, slug) {
    try {
        const fileUrl = `${BASE_URL}?/files/file/${fileId}-${slug}/&do=download`;
        const resp = await client.get(fileUrl);
        refreshCsrf(resp.data);

        // Find revision download links
        const revisions = extractRevisions(resp.data, fileId, slug);
        if (revisions.length === 0) {
            // Single file - try direct download
            const directUrl = `${BASE_URL}?/files/file/${fileId}-${slug}/&do=download&csrfKey=${sessionCsrf}`;
            return {
                id: `easternspirit_${fileId}`,
                lang: 'bul',
                url: directUrl,
                score: 10
            };
        }

        // Use the latest revision (last one)
        const latestRev = revisions[revisions.length - 1];
        return {
            id: `easternspirit_${fileId}_r${latestRev.id}`,
            lang: 'bul',
            url: `${BASE_URL}?/files/file/${fileId}-${slug}/&do=download&r=${latestRev.id}&csrfKey=${sessionCsrf}`,
            score: 10
        };
    } catch (err) {
        console.error('[EasternSpirit] Movie download error:', err.message);
        return null;
    }
}

/**
 * Get series episode revisions and find the matching episode
 */
async function getSeriesRevisions(fileId, slug, season, episode) {
    try {
        const fileUrl = `${BASE_URL}?/files/file/${fileId}-${slug}/&do=download`;
        const resp = await client.get(fileUrl);
        refreshCsrf(resp.data);

        const revisions = extractRevisions(resp.data, fileId, slug);
        if (revisions.length === 0) {
            console.log('[EasternSpirit] No revisions found for series');
            return [];
        }

        console.log(`[EasternSpirit] Found ${revisions.length} revisions`);

        const epNum = parseInt(episode);
        const subtitles = [];

        // Strategy 1: try to match revision index to episode number
        // Revisions are typically uploaded in chronological order (ep1 first)
        if (epNum > 0 && epNum <= revisions.length) {
            const rev = revisions[epNum - 1];
            subtitles.push({
                id: `easternspirit_${fileId}_r${rev.id}`,
                lang: 'bul',
                url: `${BASE_URL}?/files/file/${fileId}-${slug}/&do=download&r=${rev.id}&csrfKey=${sessionCsrf}`,
                score: 10
            });
            console.log(`[EasternSpirit] Episode ${epNum} -> revision ${rev.id} (by index)`);
        }

        // Also return the latest revision as fallback (might contain all episodes)
        if (revisions.length === 1) {
            const rev = revisions[0];
            if (subtitles.length === 0) {
                subtitles.push({
                    id: `easternspirit_${fileId}_r${rev.id}`,
                    lang: 'bul',
                    url: `${BASE_URL}?/files/file/${fileId}-${slug}/&do=download&r=${rev.id}&csrfKey=${sessionCsrf}`,
                    score: 5
                });
            }
        }

        return subtitles;
    } catch (err) {
        console.error('[EasternSpirit] Series revisions error:', err.message);
        return [];
    }
}

/**
 * Extract revision IDs from the download page
 */
function extractRevisions(html, fileId, slug) {
    const revisions = [];
    const seen = new Set();
    const regex = /do=download&(?:amp;)?r=(\d+)/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
        if (!seen.has(m[1])) {
            seen.add(m[1]);
            revisions.push({ id: m[1] });
        }
    }
    // Sort by ID ascending (earliest revision first = episode 1)
    revisions.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    return revisions;
}

/**
 * Download a subtitle file from Eastern Spirit
 */
async function download(url) {
    try {
        if (!await ensureSession()) {
            throw new Error('Not logged in');
        }

        // Refresh csrfKey in the URL if needed
        let dlUrl = url;
        if (sessionCsrf) {
            dlUrl = url.replace(/csrfKey=[a-f0-9]+/, `csrfKey=${sessionCsrf}`);
        }

        console.log('[EasternSpirit] Downloading from:', dlUrl.substring(0, 100));
        const resp = await client.get(dlUrl, { responseType: 'arraybuffer' });

        const buffer = Buffer.from(resp.data);
        if (buffer.length === 0) {
            throw new Error('Empty response');
        }

        // Check if we got HTML instead of a file (session expired)
        const text = buffer.toString('utf8', 0, 50);
        if (text.includes('<!DOCTYPE') || text.includes('<html')) {
            console.log('[EasternSpirit] Got HTML instead of file, re-login needed');
            loggedIn = false;
            if (!await ensureSession()) {
                throw new Error('Re-login failed');
            }
            // Retry with fresh csrfKey
            dlUrl = url.replace(/csrfKey=[a-f0-9]+/, `csrfKey=${sessionCsrf}`);
            const retry = await client.get(dlUrl, { responseType: 'arraybuffer' });
            const retryBuf = Buffer.from(retry.data);
            const retryText = retryBuf.toString('utf8', 0, 50);
            if (retryText.includes('<!DOCTYPE') || retryText.includes('<html')) {
                throw new Error('Download still returns HTML after re-login');
            }
            console.log(`[EasternSpirit] Downloaded ${retryBuf.length} bytes (after re-login)`);
            return retryBuf;
        }

        console.log(`[EasternSpirit] Downloaded ${buffer.length} bytes`);
        return buffer;
    } catch (err) {
        console.error('[EasternSpirit] Download error:', err.message);
        throw err;
    }
}

module.exports = { search, download };
