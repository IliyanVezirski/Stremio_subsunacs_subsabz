const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const BASE_URL = 'https://www.opensubtitles.org';
const SEARCH_URL = `${BASE_URL}/en/search`;
const DOWNLOAD_URL = 'https://dl.opensubtitles.org/en/download/sub';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

let currentUserAgent = '';
let sessionCookies = '';

function getRandomUserAgent() {
    currentUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    return currentUserAgent;
}

function getHeaders(referer = '') {
    const headers = {
        'User-Agent': currentUserAgent || getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,bg;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
    };
    if (sessionCookies) {
        headers['Cookie'] = sessionCookies;
    }
    if (referer) {
        headers['Referer'] = referer;
    }
    return headers;
}

function extractCookies(response) {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
        const cookies = setCookie.map(c => c.split(';')[0]).join('; ');
        if (cookies) {
            sessionCookies = cookies;
            console.log('[OpenSubtitles] Got cookies:', cookies.substring(0, 100));
        }
    }
}

async function initSession() {
    try {
        console.log('[OpenSubtitles] Initializing session...');
        const response = await axios.get(BASE_URL, {
            responseType: 'arraybuffer',
            headers: getHeaders(),
            timeout: 15000,
            validateStatus: () => true
        });
        extractCookies(response);
        console.log('[OpenSubtitles] Session initialized, status:', response.status);
        return response.status === 200 || response.status === 301 || response.status === 302;
    } catch (error) {
        console.log('[OpenSubtitles] Session init error:', error.message);
        return false;
    }
}

async function search(imdbId, type, season, episode) {
    try {
        if (!imdbId || !imdbId.startsWith('tt')) {
            console.log('[OpenSubtitles] Invalid IMDB ID:', imdbId);
            return [];
        }

        await initSession();

        const numericImdbId = imdbId.replace('tt', '');
        const isSeries = type === 'series' && season && episode;
        
        let searchUrl = `${SEARCH_URL}/sublanguageid-bul/imdbid-${numericImdbId}`;
        
        if (isSeries) {
            searchUrl += `/season-${season}/episode-${episode}`;
        }
        
        console.log(`[OpenSubtitles] Searching: ${searchUrl}`);

        const response = await axios.get(searchUrl, {
            responseType: 'arraybuffer',
            headers: getHeaders(BASE_URL),
            timeout: 20000,
            validateStatus: (status) => status < 500
        });

        extractCookies(response);

        if (response.status !== 200) {
            console.log('[OpenSubtitles] Search failed with status:', response.status);
            return [];
        }

        let html;
        const buffer = Buffer.from(response.data);
        
        try {
            html = iconv.decode(buffer, 'utf-8');
        } catch (e) {
            html = buffer.toString('utf-8');
        }

        const $ = cheerio.load(html);
        const subtitles = [];

        $('table#search_results tr').each((index, row) => {
            const $row = $(row);
            
            const $downloadLink = $row.find('a[href*="/en/subtitleserve/sub/"]');
            if ($downloadLink.length === 0) return;
            
            const downloadHref = $downloadLink.attr('href');
            if (!downloadHref) return;
            
            const $nameLink = $row.find('a[href*="/en/subtitles/"]').first();
            let name = $nameLink.text().trim().replace(/\s+/g, ' ');
            
            if (!name) {
                const $firstTd = $row.find('td').first();
                name = $firstTd.text().trim().replace(/\s+/g, ' ').substring(0, 100);
            }
            
            const subIdMatch = downloadHref.match(/\/sub\/(\d+)/);
            const subId = subIdMatch ? subIdMatch[1] : null;
            if (!subId) return;
            
            const $fpsCell = $row.find('td').eq(-3);
            const fps = $fpsCell.text().trim();
            
            const $cdCell = $row.find('td').eq(3);
            const cds = $cdCell.text().trim();
            
            const downloadUrl = `${DOWNLOAD_URL}/${subId}`;
            
            subtitles.push({
                id: `opensubtitles_${subId}`,
                lang: 'bul',
                url: downloadUrl,
                name: name || `OpenSubtitles ${subId}`,
                fps: fps,
                cds: cds,
                score: 10
            });
            
            console.log(`[OpenSubtitles] Found: id=${subId} name="${name}" fps=${fps}`);
        });

        if (subtitles.length === 0) {
            $('a[href*="/subtitleserve/sub/"]').each((index, element) => {
                const $link = $(element);
                const href = $link.attr('href');
                if (!href) return;
                
                const $row = $link.closest('tr');
                let name = $row.find('a[href*="/subtitles/"]').first().text().trim();
                if (!name) {
                    name = $link.attr('title') || 'Unknown';
                }
                
                const subIdMatch = href.match(/\/sub\/(\d+)/);
                const subId = subIdMatch ? subIdMatch[1] : null;
                if (!subId) return;
                
                const downloadUrl = `${DOWNLOAD_URL}/${subId}`;
                
                subtitles.push({
                    id: `opensubtitles_${subId}`,
                    lang: 'bul',
                    url: downloadUrl,
                    name: name,
                    score: 8
                });
                
                console.log(`[OpenSubtitles] Found (fallback): id=${subId} name="${name}"`);
            });
        }

        console.log(`[OpenSubtitles] Total found: ${subtitles.length} subtitles`);
        return subtitles;

    } catch (error) {
        console.error('[OpenSubtitles] Search error:', error.message);
        return [];
    }
}

async function download(downloadUrl) {
    try {
        console.log(`[OpenSubtitles] Downloading: ${downloadUrl}`);
        
        if (!sessionCookies) {
            await initSession();
        }
        
        const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: { ...getHeaders(BASE_URL), 'Referer': BASE_URL },
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status < 400
        });

        extractCookies(response);

        const buffer = Buffer.from(response.data);
        console.log(`[OpenSubtitles] Downloaded ${buffer.length} bytes`);
        
        return buffer;

    } catch (error) {
        console.error('[OpenSubtitles] Download error:', error.message);
        throw error;
    }
}

module.exports = { search, download };
