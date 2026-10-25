const axios = require('axios');
const { BoundedCache } = require('./cache');
const cache = new BoundedCache(500, 2 * 1024 * 1024);
const pending = new Map();
async function getMetadata(imdbId, type) {
    const key = `${type}:${imdbId}`;
    const found = cache.get(key);
    if (found) return found;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
        let meta;
        try {
            const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
            const data = response.data?.meta;
            if (data?.name) meta = { name: data.name, year: String(data.year || data.releaseInfo || '').slice(0, 4) };
        } catch (error) { if (axios.isCancel(error)) return null; }
        if (!meta) {
            try {
                const apiKey = process.env.TMDB_API_KEY || 'b019b78bbd3a80f0f3112369c3b8c243';
                const response = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                    params: { api_key: apiKey, external_source: 'imdb_id' }, timeout: 5000
                });
                const item = (type === 'series' ? response.data.tv_results : response.data.movie_results)?.[0];
                if (item) meta = { name: item.title || item.name, year: (item.release_date || item.first_air_date || '').slice(0, 4) };
            } catch { return null; }
        }
        if (meta) cache.set(key, meta, 6 * 60 * 60 * 1000);
        return meta || null;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
}
module.exports = { getMetadata };
