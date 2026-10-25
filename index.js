
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const { AbuseGuard, normalizeIp } = require('./lib/abuse');
const abuse = new AbuseGuard();
const { BoundedCache } = require('./lib/cache');
const { withDeadline, getSourceDiagnostics } = require('./lib/requests');
const subsunacs = require('./providers/subsunacs');
const subsSab = require('./providers/subssab');
const subsland = require('./providers/subsland');
const easternSpirit = require('./providers/easternspirit');
const subsource = require('./providers/subsource');
const { extractSubtitle, findSubtitleForEpisode, decodeSubtitleBuffer, extractSubtitleFromZip, extractSubtitleFromRar } = require('./lib/archive');

// Define port and base URL
const PORT = process.env.PORT || 8080;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // Search results: five minutes
const cache = new BoundedCache(1000, 8 * 1024 * 1024);
const pendingSearches = new Map();

// Proxy cache — caches already-extracted subtitle content to avoid re-downloading
const PROXY_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const proxyCache = new BoundedCache(200, 32 * 1024 * 1024);
// Request coalescing — prevents parallel downloads for the same subtitle
const pendingDownloads = Object.create(null);
// Rate limiting — per-IP to block spammers before anything else
const failedDownloads = new BoundedCache(500, 128 * 1024);

// Release expired data even when no more requests arrive for those keys.
const cleanupTimer = setInterval(() => {
    cache.prune(); proxyCache.prune(); failedDownloads.prune(); abuse.clients.prune();
}, 60000);
cleanupTimer.unref();

// Hard blacklist for attacking IPs
const BLACKLISTED_IPS = new Set([
    '185.107.56.71',
    '172.71.99.13',
    '10.19.235.3'
]);

function getProviderName(sub) {
    const source = sub.id.split('_')[0];
    if (source === 'subsunacs') return 'Subsunacs.net';
    if (source === 'subssab') return 'Subs.sab.bz';
    if (source === 'subsland') return 'SubsLand.com';
    if (source === 'easternspirit') return 'EasternSpirit.org';
    if (source === 'subsource') return 'SubSource.net';
    return source;
}

function getProxyUrl(sub, season, episode, filename) {
    let proxyUrl = `${BASE_URL}/proxy?url=${encodeURIComponent(sub.url)}&source=${sub.id.split('_')[0]}`;
    if (season && episode) {
        proxyUrl += `&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`;
    }
    if (Number(sub.fps) >= 10 && Number(sub.fps) <= 120) proxyUrl += '&fps=' + Number(sub.fps);
    if (typeof filename === 'string' && filename.length <= 300) proxyUrl += '&filename=' + encodeURIComponent(filename);
    return proxyUrl;
}

const manifest = {
    id: 'com.stremio.bulgarian.subs',
    version: '1.2.0',
    name: 'Bulgarian Subtitles',
    description: 'Български субтитри от Subsunacs.net, Subs.sab.bz, SubsLand.com, SubSource.net и EasternSpirit.org.',
    
    // Слагаме го тук, защото Stremio го показва като кликаем линк под описанието
    contactEmail: 'Ilian.vezirski@gmail.com',

    // Оставяме и това за всеки случай
    helpUrl: 'https://revolut.me/iliyantyb2',

    logo: 'https://cdn-icons-png.flaticon.com/512/16135/16135593.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: false, // Променете на true, за да се появи бутон "Configure"
        configurationRequired: false
    },
    stremioAddonsConfig: {
      "issuer": "https://stremio-addons.net",
      "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..i0matrKUZQpKi4hcK1BrXg.XTGwBN_5sUYxMwM-F6NMDbMMILdL_7-1eyYbH-YapR0y2HuLNp7R1rf6Pl5um7gShHzihR-kWG5tD96mzZgwsO0UUhvHYT0zRl-vERdTlTWkaXEojgAmNB75L0Vjj8nM.DoCZpYVobL1ZOQEZ-Zjxlg"
    }
};

const builder = new addonBuilder(manifest);

const SEARCH_TIMEOUT_MS = Math.max(100, Math.min(60000, Number(process.env.SEARCH_TIMEOUT_MS) || 8000));

builder.defineSubtitlesHandler(async ({ type, id, extra = {} }) => {
    if (!['movie', 'series'].includes(type) || typeof id !== 'string' ||
        !(type === 'series' ? /^tt\d+:\d{1,3}:\d{1,4}$/ : /^tt\d+$/).test(id)) return { subtitles: [] };
    const [imdbId, season, episode] = id.split(':');
    const key = type + ':' + id;
    const format = raw => ({ subtitles: raw.map((sub, i) => ({
        id: getProviderName(sub) + '_' + i, lang: 'bul',
        url: getProxyUrl(sub, season, episode, extra.filename), name: sub.name
    })) });
    const cached = cache.get(key);
    if (cached) return format(cached);
    if (pendingSearches.has(key)) return format(await pendingSearches.get(key));
    if (pendingSearches.size >= 12) return { subtitles: [], cacheMaxAge: 0 };

    const task = (async () => {
        const search = async (name, provider, budget = SEARCH_TIMEOUT_MS) => {
            try { return await withDeadline(() => provider.search(imdbId, type, season, episode), budget); }
            catch (error) { console.error('[' + name + '] ' + error.message); return []; }
        };
        const results = await Promise.all([
            search('Subs.sab.bz', subsSab), search('SubsLand', subsland), search('Subsunacs', subsunacs)
        ]);
        let raw = results.flat();
        // One catalog may contain only split-CD or unsupported releases. Offer an independent fallback.
        if (results.filter(items => items.length).length < 2) raw.push(...await search('SubSource', subsource));
        if (!raw.length) raw = await search('EasternSpirit', easternSpirit, Math.min(SEARCH_TIMEOUT_MS, 4000));
        // Short retry windows let temporarily failing providers recover instead of hiding results for 48 hours.
        cache.set(key, raw, raw.length ? CACHE_TTL : 30 * 1000);
        console.log('[Result] Found ' + raw.length + ' subtitles for ' + id);
        return raw;
    })();
    pendingSearches.set(key, task);
    try { return format(await task); }
    finally { pendingSearches.delete(key); }
});

const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');
const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.RENDER ? 1 : 0));
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be 0..5');
app.set('trust proxy', proxyHops);

function enforce(req, res, kind, limit) {
    const result = abuse.consume(req.clientIp, kind, limit);
    if (result.allowed) return true;
    res.setHeader('Retry-After', String(result.retryAfter));
    res.status(result.status).send(result.status === 403 ? 'Temporarily blocked for excessive requests.' : 'Too many requests. Try again later.');
    return false;
}

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.path === '/health') return next();
    req.clientIp = normalizeIp(req.ip);
    if (BLACKLISTED_IPS.has(req.clientIp)) return res.status(403).send('Blocked.');
    if (!enforce(req, res, 'requests', 120)) return;
    if (req.originalUrl.length > 4096) return res.status(414).send('Request URL too long');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(405).send('Method not allowed');
    next();
});

function sendSubtitle(res, result) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="subtitle.srt"');
    res.setHeader('Cache-Control', 'public, max-age=7200');
    res.setHeader('X-Subtitle-File', encodeURIComponent(result.fileName));
    res.setHeader('X-Subtitle-Episode-Match', result.episodeMatched ? 'yes' : 'unknown');
    return res.send(result.content);
}

function downloadFailure(error) {
    return error.code === 'SUBTITLE_FPS_REQUIRED'
        ? { status: 422, message: 'This MicroDVD subtitle needs FPS metadata. Select a time-based subtitle release.' }
        : { status: 502, message: 'Subtitle source unavailable. Try again later.' };
}

app.get('/proxy', async (req, res) => {
    const { url, source, season, episode, fps, filename } = req.query;
    
    if (!url) {
        return res.status(400).send('Missing URL parameter');
    }
    const hosts = {
        subsunacs: ['subsunacs.net', 'www.subsunacs.net'],
        subssab: ['subs.sab.bz'], subsland: ['subsland.com', 'www.subsland.com'],
        easternspirit: ['www.easternspirit.org', 'easternspirit.org'],
        subsource: ['subsource.net']
    };
    try {
        if (typeof url !== 'string' || typeof source !== 'string' || !Object.hasOwn(hosts, source)) throw new Error('Invalid source');
        if (fps !== undefined && (typeof fps !== 'string' || !/^\d{2,3}(?:\.\d{1,3})?$/.test(fps) || Number(fps) < 10 || Number(fps) > 120)) throw new Error('Invalid FPS');
        if (filename !== undefined && (typeof filename !== 'string' || filename.length > 300)) throw new Error('Invalid filename');
        const target = new URL(url);
        if (!['http:', 'https:'].includes(target.protocol) || !hosts[source].includes(target.hostname) || target.username || target.password || target.port) throw new Error('Invalid URL');
        if ((season !== undefined || episode !== undefined) &&
            (typeof season !== 'string' || typeof episode !== 'string' || !/^\d{1,3}$/.test(season) || !/^\d{1,4}$/.test(episode))) throw new Error('Invalid episode');
    } catch {
        return res.status(400).send('Invalid subtitle request');
    }

    // Build a unique cache key for this subtitle request
    const cacheKey = `${source}|${url}|${season || ''}|${episode || ''}|${fps || ''}|${filename || ''}`;

    // Serve from proxy cache if available
    const cachedSubtitle = proxyCache.get(cacheKey);
    if (cachedSubtitle) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="subtitle.srt"');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return sendSubtitle(res, cachedSubtitle);
    }

    console.log(`[Proxy] Source: ${source}, URL: ${url}${season ? `, S${season}E${episode}` : ''}`);

    // Request coalescing — if a download is already in-flight for this key, wait for it
    if (pendingDownloads[cacheKey]) {
        console.log(`[Proxy] Waiting for in-flight download: ${url}`);
        try {
            const content = await pendingDownloads[cacheKey];
            if (content) {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', 'attachment; filename="subtitle.srt"');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return sendSubtitle(res, content);
            }
            return res.status(404).send('Could not download subtitle');
        } catch (error) {
            console.error('[Proxy] Coalesced request error:', error.message);
            const failure = downloadFailure(error);
            return res.status(failure.status).send(failure.message);
        }
    }

    if (Object.keys(pendingDownloads).length >= 4) {
        res.setHeader('Retry-After', '5');
        return res.status(503).send('Downloads busy. Try again shortly.');
    }

    const previousFailure = failedDownloads.get(cacheKey);
    if (previousFailure) return res.status(previousFailure.status).send(previousFailure.message);
    if (!enforce(req, res, 'downloads', 10)) return;

    // Start a new download and register it for coalescing
    const downloadPromise = (async () => {
        try {
            let buffer;
            
            if (source === 'subsunacs') {
                buffer = await subsunacs.download(url);
            } else if (source === 'subssab') {
                buffer = await subsSab.download(url);
            } else if (source === 'subsland') {
                buffer = await subsland.download(url);
            } else if (source === 'easternspirit') {
                buffer = await easternSpirit.download(url);
            } else if (source === 'subsource') {
                buffer = await subsource.download(url);
            }
            
            if (!buffer || buffer.length === 0) {
                console.log('[Proxy] Empty response');
                return null;
            }
            
            console.log(`[Proxy] Downloaded ${buffer.length} bytes`);
            
            const content = await extractSubtitle(buffer, { season, episode, fps, filename });
            if (content) console.log('[Archive] Selected ' + content.fileName);

            // Store in proxy cache
            if (content) {
                proxyCache.set(cacheKey, content, PROXY_CACHE_TTL);
                console.log(`[Proxy] Cached subtitle for: ${url}`);
            }
            return content;
        } catch (error) {
            console.error('[Proxy] Download/extract error:', error.message);
            throw error;
        }
    })();

    pendingDownloads[cacheKey] = downloadPromise;

    try {
        const content = await downloadPromise;
        if (content) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="subtitle.srt"');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return sendSubtitle(res, content);
        }
        failedDownloads.set(cacheKey, { status: 404, message: 'Could not download subtitle' }, 30000);
        return res.status(404).send('Could not download subtitle');
    } catch (error) {
        console.error('[Proxy] Error:', error.message);
        const failure = downloadFailure(error);
        failedDownloads.set(cacheKey, failure, 30000);
        return res.status(failure.status).send(failure.message);
    } finally {
        delete pendingDownloads[cacheKey];
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/debug', async (req, res) => {
    const results = {
        port: PORT,
        sources: getSourceDiagnostics(),
        protection: { trackedClients: abuse.clients.size, denied: abuse.denied, temporaryBans: abuse.bans, proxyHops },
        uptimeSeconds: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        pendingSearches: pendingSearches.size,
        baseUrl: BASE_URL,
        cache: {
            size: cache.size,
            ttl: CACHE_TTL
        },
        proxyCache: {
            size: proxyCache.size,
            bytes: proxyCache.bytes,
            ttl: PROXY_CACHE_TTL
        },
        pendingDownloads: Object.keys(pendingDownloads).length,
        env: {
            PORT: process.env.PORT
        }
    };
    res.json(results);
});

app.use((req, res, next) => {
    const match = req.path.match(/^\/subtitles\/(movie|series)\/([^/]+)(?:\/[^/]+)?\.json$/);
    if (match) {
        let id;
        try { id = decodeURIComponent(match[2]); } catch { return res.status(400).send('Invalid subtitle ID'); }
        const key = match[1] + ':' + id;
        if (!cache.get(key) && !pendingSearches.has(key) && !enforce(req, res, 'searches', 20)) return;
    }
    next();
});
app.use(getRouter(builder.getInterface()));

// Listen on 0.0.0.0 to accept connections from outside the container
if (require.main === module) app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Runtime] Node ${process.version}; heap limit ${Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 1024 / 1024)} MiB`);
    setInterval(() => {
        const memory = process.memoryUsage();
        console.log(`[Runtime] rss=${Math.round(memory.rss / 1024 / 1024)} MiB heap=${Math.round(memory.heapUsed / 1024 / 1024)} MiB searchCache=${cache.size} subtitleCache=${proxyCache.size} activeSearches=${pendingSearches.size} activeDownloads=${Object.keys(pendingDownloads).length}`);
    }, 60000).unref();
    console.log(`
🎬 Bulgarian Subtitles Addon is running!`);
    console.log(`
🎧 Listening on 0.0.0.0:${PORT}`);
    console.log(`
📦 Install in Stremio: ${BASE_URL}/manifest.json`);
});

module.exports = { app, findSubtitleForEpisode, decodeSubtitleBuffer, extractSubtitleFromZip, extractSubtitleFromRar };
