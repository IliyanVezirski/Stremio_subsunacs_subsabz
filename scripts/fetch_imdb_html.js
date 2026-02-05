const fs = require('fs');
const axios = require('axios');

const imdbId = process.argv[2] || 'tt14850054';
const url = `https://www.imdb.com/title/${imdbId}/`;

(async () => {
    try {
        console.log('Fetching', url);
        const resp = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 15000
        });

        // If IMDb returns non-200 or empty body, try the jina.ai cached proxy
        if ((resp.status !== 200) || !resp.data || (typeof resp.data === 'string' && resp.data.trim().length === 0)) {
            console.log('IMDb returned empty or non-200, trying releaseinfo page');
            try {
                const releaseUrl = `https://www.imdb.com/title/${imdbId}/releaseinfo`;
                const ril = await axios.get(releaseUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
                console.log('Releaseinfo status:', ril.status);
                if (ril && ril.data) resp.data = ril.data;
            } catch (e) {
                console.log('Releaseinfo fetch failed, trying jina.ai proxy');
                const proxyUrl = `https://r.jina.ai/http://www.imdb.com/title/${imdbId}/`;
                const proxyResp = await axios.get(proxyUrl, { timeout: 15000 });
                console.log('Proxy status:', proxyResp.status);
                if (proxyResp && proxyResp.data) resp.data = proxyResp.data;
            }
        }
        console.log('Status:', resp.status);
        console.log('Content-Length header:', resp.headers['content-length'] || 'none');
        const file = `./tmp_imdb_${imdbId}.html`;
        const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        fs.writeFileSync(file, body, 'utf8');
        console.log('Saved to', file, ' (bytes:', Buffer.byteLength(body, 'utf8'), ')');
    } catch (e) {
        console.error('Error fetching IMDb:', e && e.message ? e.message : e);
    }
})();
