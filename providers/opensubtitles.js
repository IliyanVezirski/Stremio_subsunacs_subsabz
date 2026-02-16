const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const BASE_URL = 'https://www.opensubtitles.org';
const SEARCH_URL = `${BASE_URL}/en/search`;
const DOWNLOAD_URL = 'https://dl.opensubtitles.org/en/download/sub';

const CODETABS_PREFIX = 'https://api.codetabs.com/v1/proxy/?quest=';

async function fetchPage(url) {
    const proxyUrl = `${CODETABS_PREFIX}${encodeURIComponent(url)}`;
    const resp = await axios.get(proxyUrl, {
        responseType: 'arraybuffer',
        timeout: 20000
    });
    const buffer = Buffer.from(resp.data);
    return buffer.toString('utf-8');
}

async function fetchBinary(url) {
    const proxyUrl = `${CODETABS_PREFIX}${encodeURIComponent(url)}`;
    const resp = await axios.get(proxyUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
    });
    return Buffer.from(resp.data);
}

async function search(imdbId, type, season, episode) {
    try {
        if (!imdbId || !imdbId.startsWith('tt')) {
            console.log('[OpenSubtitles] Invalid IMDB ID:', imdbId);
            return [];
        }

        const numericImdbId = imdbId.replace('tt', '');
        const isSeries = type === 'series' && season && episode;
        
        let searchUrl = `${SEARCH_URL}/sublanguageid-bul/imdbid-${numericImdbId}`;
        
        if (isSeries) {
            searchUrl += `/season-${season}/episode-${episode}`;
        }
        
        console.log(`[OpenSubtitles] Searching: ${searchUrl}`);

        const html = await fetchPage(searchUrl);

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
        
        const buffer = await fetchBinary(downloadUrl);
        console.log(`[OpenSubtitles] Downloaded ${buffer.length} bytes`);
        
        return buffer;

    } catch (error) {
        console.error('[OpenSubtitles] Download error:', error.message);
        throw error;
    }
}

module.exports = { search, download };
