
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const iconv = require('iconv-lite');
const subsunacs = require('./providers/subsunacs');
const subsSab = require('./providers/subssab');
const subsland = require('./providers/subsland');
const easternSpirit = require('./providers/easternspirit');

// Define port and base URL
const PORT = process.env.PORT || 8080;
const BASE_URL = 'https://bulgarian-subs-addon.onrender.com';

// Cache configuration
const CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours in milliseconds
const cache = {};

// Proxy cache — caches already-extracted subtitle content to avoid re-downloading
const PROXY_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const proxyCache = {};
// Request coalescing — prevents parallel downloads for the same subtitle
const pendingDownloads = {};
// Rate limiting — per-IP to block spammers before anything else
const ipRateLimit = {};
const IP_RATE_LIMIT_WINDOW = 60 * 1000; // 60 seconds
const IP_RATE_LIMIT_MAX = 10; // max 10 proxy requests per IP per window
// Track cache hit counts per key (for log throttling)
const cacheHitCount = {};

function getProviderName(sub) {
    const source = sub.id.split('_')[0];
    if (source === 'subsunacs') return 'Subsunacs.net';
    if (source === 'subssab') return 'Subs.sab.bz';
    if (source === 'subsland') return 'SubsLand.com';
    if (source === 'easternspirit') return 'EasternSpirit.org';
    return source;
}

function getProxyUrl(sub, season, episode) {
    let proxyUrl = `${BASE_URL}/proxy?url=${encodeURIComponent(sub.url)}&source=${sub.id.split('_')[0]}`;
    if (season && episode) {
        proxyUrl += `&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`;
    }
    return proxyUrl;
}

const manifest = {
    id: 'com.stremio.bulgarian.subs',
    version: '1.1.6',
    name: 'Bulgarian Subtitles',
    description: 'Най-големите каталози за български субтитри на едно място.',
    
    // Слагаме го тук, защото Stremio го показва като кликаем линк под описанието
    contactEmail: 'https://bit.ly/support_addon',

    // Оставяме и това за всеки случай
    helpUrl: 'https://bit.ly/support_addon',

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

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    console.log(`[Request] Type: ${type}, ID: ${id}`);

    const [imdbId, season, episode] = id.split(':');

    if (cache[id] && (Date.now() - cache[id].timestamp < CACHE_TTL)) {
        console.log(`[Cache] HIT for ${id}`);
        const subtitles = cache[id].subtitles.map((sub, i) => ({ id: getProviderName(sub) + '_' + i, lang: 'bul', url: getProxyUrl(sub, season, episode) }));
        return { subtitles };
    }
    console.log(`[Cache] MISS for ${id}`);
    
    if (!imdbId || !imdbId.startsWith('tt')) {
        return { subtitles: [] };
    }

    try {
        const [subsunacsSubs, subsSabSubs, subslandSubs] = await Promise.all([
            subsunacs.search(imdbId, type, season, episode).catch(err => {
                console.error('[Subsunacs Error]', err.message);
                return [];
            }),
            subsSab.search(imdbId, type, season, episode).catch(err => {
                console.error('[Subs.sab.bz Error]', err.message);
                return [];
            }),
            subsland.search(imdbId, type, season, episode).catch(err => {
                console.error('[SubsLand Error]', err.message);
                return [];
            })
        ]);

        let rawSubtitles = [...subsunacsSubs, ...subsSabSubs, ...subslandSubs];

        // EasternSpirit as fallback - only search if no subtitles found from other providers
        if (rawSubtitles.length === 0) {
            console.log('[EasternSpirit] No subs from other providers, trying EasternSpirit...');
            const easternSpiritSubs = await easternSpirit.search(imdbId, type, season, episode).catch(err => {
                console.error('[EasternSpirit Error]', err.message);
                return [];
            });
            rawSubtitles = [...easternSpiritSubs];
        }
        
        console.log(`[Result] Found ${rawSubtitles.length} subtitles for ${id}`);

        // Store raw subtitles in cache
        cache[id] = {
            subtitles: rawSubtitles,
            timestamp: Date.now()
        };
        console.log(`[Cache] STORED for ${id}`);

        const proxiedSubtitles = rawSubtitles.map((sub, i) => ({ id: getProviderName(sub) + '_' + i, lang: 'bul', url: getProxyUrl(sub, season, episode) }));

        return { subtitles: proxiedSubtitles };
    } catch (error) {
        console.error('[Handler Error]', error);
        return { subtitles: [] };
    }
});

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.get('/proxy', async (req, res) => {
    const { url, source, season, episode } = req.query;
    
    if (!url) {
        return res.status(400).send('Missing URL parameter');
    }

    // Per-IP rate limiting — applied BEFORE cache to block spammers completely
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (!ipRateLimit[clientIp]) {
        ipRateLimit[clientIp] = [];
    }
    ipRateLimit[clientIp] = ipRateLimit[clientIp].filter(t => now - t < IP_RATE_LIMIT_WINDOW);
    if (ipRateLimit[clientIp].length >= IP_RATE_LIMIT_MAX) {
        // Log only once per burst to avoid log spam
        if (ipRateLimit[clientIp].length === IP_RATE_LIMIT_MAX) {
            console.log(`[Proxy] RATE LIMITED IP ${clientIp}: ${url}`);
        }
        return res.status(429).send('Too many requests. Try again later.');
    }
    ipRateLimit[clientIp].push(now);

    // Build a unique cache key for this subtitle request
    const cacheKey = `${source}|${url}|${season || ''}|${episode || ''}`;

    // Serve from proxy cache if available
    if (proxyCache[cacheKey] && (Date.now() - proxyCache[cacheKey].timestamp < PROXY_CACHE_TTL)) {
        // Throttled logging — log only every 50th cache hit to reduce noise
        cacheHitCount[cacheKey] = (cacheHitCount[cacheKey] || 0) + 1;
        if (cacheHitCount[cacheKey] === 1 || cacheHitCount[cacheKey] % 50 === 0) {
            console.log(`[Proxy] CACHE HIT #${cacheHitCount[cacheKey]} for ${url}`);
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="subtitle.srt"');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(proxyCache[cacheKey].content);
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
                return res.send(content);
            }
            return res.status(404).send('Could not download subtitle');
        } catch (error) {
            console.error('[Proxy] Coalesced request error:', error.message);
            return res.status(500).send(`Error downloading subtitle: ${error.message}`);
        }
    }

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
            } else {
                const response = await axios.get(url, {
                    responseType: 'arraybuffer',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.6',
                        'Referer': url
                    },
                    timeout: 30000
                });
                buffer = Buffer.from(response.data);
            }
            
            if (!buffer || buffer.length === 0) {
                console.log('[Proxy] Empty response');
                return null;
            }
            
            console.log(`[Proxy] Downloaded ${buffer.length} bytes`);
            
            const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;
            const isRar = buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72;
            
            const textStart = buffer.toString('utf8', 0, 100).toLowerCase();
            if (textStart.includes('<!doctype') || textStart.includes('<html>') || textStart.includes('error')) {
                console.log('[Proxy] Received HTML error page instead of archive');
                console.log('[Proxy] Content:', buffer.toString('utf8', 0, 300));
                return null;
            }
            
            let content = null;
            if (isZip) {
                console.log('[Proxy] Detected ZIP file, extracting with adm-zip...');
                content = extractSubtitleFromZip(buffer, season, episode);
            } else if (isRar) {
                console.log('[Proxy] Detected RAR file, extracting...');
                content = await extractSubtitleFromRar(buffer, season, episode);
            } else {
                const text = buffer.toString('utf8').substring(0, 200);
                if (text.includes('-->') || /^\d+\s*\n\d{2}:\d{2}/.test(text)) {
                    console.log('[Proxy] Detected SRT file directly');
                    content = buffer.toString('utf8');
                    if (content.includes('\ufffd') || /[\x80-\x9F]/.test(content)) {
                        content = iconv.decode(buffer, 'win1251');
                    }
                } else {
                    console.log('[Proxy] Unknown format, first 100 chars:', text.substring(0, 100));
                    return null;
                }
            }

            // Store in proxy cache
            if (content) {
                proxyCache[cacheKey] = { content, timestamp: Date.now() };
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
            return res.send(content);
        }
        return res.status(404).send('Could not download subtitle');
    } catch (error) {
        console.error('[Proxy] Error:', error.message);
        return res.status(500).send(`Error downloading subtitle: ${error.message}`);
    } finally {
        delete pendingDownloads[cacheKey];
    }
});

function findSubtitleForEpisode(files, season, episode) {
    const subtitleExtensions = ['.srt', '.ssa', '.ass', '.vtt'];
    
    const subFiles = files.filter(f => {
        const name = (f.path || f.name || f.entryName || '').toLowerCase();
        return subtitleExtensions.some(ext => name.endsWith(ext));
    });
    
    if (subFiles.length === 0) return null;
    if (subFiles.length === 1) return subFiles[0];
    
    if (season && episode) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        const sNum = parseInt(season);
        const eNum = parseInt(episode);
        
        const patterns = [
            new RegExp(`s0*${sNum}e0*${eNum}`, 'i'),
            new RegExp(`\\b0*${sNum}x0*${eNum}\\b`, 'i'),
            new RegExp(`[\\.\\_\\-\\\s]0*${eNum}[\\.\\_\\-\\\s]`, 'i'),
            new RegExp(`e0*${eNum}[^0-9]`, 'i'),
        ];
        
        for (const pattern of patterns) {
            const match = subFiles.find(f => {
                const name = (f.path || f.name || f.entryName || '');
                return pattern.test(name);
            });
            if (match) {
                console.log(`[Proxy] Found episode match: ${match.path || match.name || match.entryName}`);
                return match;
            }
        }
        
        console.log(`[Proxy] No specific episode file found for S${s}E${e}, files:`, subFiles.map(f => f.path || f.name || f.entryName));
    }
    
    return subFiles[0];
}

// Extract subtitle content from ZIP — returns string or null (no res dependency)
function extractSubtitleFromZip(buffer, season = null, episode = null) {
    try {
        const zip = new AdmZip(buffer);
        const zipEntries = zip.getEntries();
        const subFile = findSubtitleForEpisode(zipEntries, season, episode);
        
        if (!subFile) {
            console.log('[Proxy] No subtitle file found in ZIP');
            return null;
        }

        console.log(`[Proxy] Extracting from ZIP: ${subFile.entryName}`);
        const subBuffer = zip.readFile(subFile);
        return decodeSubtitleBuffer(subBuffer);
        
    } catch (error) {
        console.error('[Proxy] ZIP extract error:', error.message);
        throw error;
    }
}

// Extract subtitle content from RAR — returns string or null (no res dependency)
async function extractSubtitleFromRar(buffer, season = null, episode = null) {
    try {
        const extractor = await createExtractorFromData({ data: buffer });
        const list = extractor.getFileList();
        const fileHeaders = [...list.fileHeaders];
        const filesWithPath = fileHeaders.map(f => ({ ...f, path: f.name }));
        const subFileHeader = findSubtitleForEpisode(filesWithPath, season, episode);
        
        if (!subFileHeader) {
            console.log('[Proxy] No subtitle file found in RAR');
            return null;
        }

        console.log(`[Proxy] Extracting from RAR: ${subFileHeader.name}`);
        
        const extracted = extractor.extract({ files: [subFileHeader.name] });
        const files = [...extracted.files];
        
        if (files.length === 0 || !files[0].extraction) {
            console.log('[Proxy] Failed to extract file from RAR');
            return null;
        }
        
        const subBuffer = Buffer.from(files[0].extraction);
        return decodeSubtitleBuffer(subBuffer);
        
    } catch (error) {
        console.error('[Proxy] RAR extract error:', error.message);
        throw error;
    }
}

// Decode a subtitle buffer to UTF-8 string, falling back to win1251
function decodeSubtitleBuffer(subBuffer) {
    let content;
    try {
        content = subBuffer.toString('utf8');
        if (content.includes('\ufffd') || /[\x80-\x9F]/.test(content)) {
            content = iconv.decode(subBuffer, 'win1251');
        }
    } catch (e) {
        content = iconv.decode(subBuffer, 'win1251');
    }
    return content;
}

app.get('/debug', async (req, res) => {
    const results = {
        port: PORT,
        baseUrl: BASE_URL,
        cache: {
            size: Object.keys(cache).length,
            ttl: CACHE_TTL
        },
        proxyCache: {
            size: Object.keys(proxyCache).length,
            ttl: PROXY_CACHE_TTL
        },
        pendingDownloads: Object.keys(pendingDownloads).length,
        env: {
            PORT: process.env.PORT
        }
    };
    res.json(results);
});

app.use(getRouter(builder.getInterface()));

// Listen on 0.0.0.0 to accept connections from outside the container
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🎬 Bulgarian Subtitles Addon is running!`);
    console.log(`
🎧 Listening on 0.0.0.0:${PORT}`);
    console.log(`
📦 Install in Stremio: ${BASE_URL}/manifest.json`);
});
