const axios = require('axios');
const { matchIdentifiedSeries } = require('../lib/episodes');
const API = 'https://api.subsource.net';
const SITE = 'https://subsource.net';
const options = { timeout: 8000, headers: { Referer: SITE + '/', Origin: SITE } };
const detailPath = /^\/subtitle\/[a-z0-9-]+\/bulgarian\/\d+$/;

// Public website requests, verified without an account or API key. No login/challenge bypass.
async function search(imdbId, type, season, episode) {
    try {
        const response = await axios.post(`${API}/v1/movie/search`, { query: imdbId, includeSeasons: true, limit: 5 }, options);
        const expectedType = type === 'series' ? 'tvseries' : 'movie';
        const candidates = (response.data.results || []).filter(item => item.type === expectedType).slice(0, 3);
        for (const candidate of candidates) {
            const id = type === 'series' ? candidate.seasons?.find(item => Number(item.season) === Number(season))?.id : candidate.id;
            if (!Number.isSafeInteger(id)) continue;
            // Search season links use a legacy "season=" form; movie metadata has the canonical path.
            const { data: movie } = await axios.get(`${API}/v1/movie/${id}`, options);
            if (movie.type !== expectedType || (type === 'series' && Number(movie.season) !== Number(season))) continue;
            if (!/^\/subtitles\/[a-z0-9-]+(?:\/season-\d+)?$/.test(movie.link || '')) continue;
            const { data } = await axios.get(`${API}/v1${movie.link}?language=bulgarian&sort_by_date=true`, options);
            const identity = data.movie?.source_data?.link?.match(/imdb\.com\/title\/(tt\d+)(?:\/|$)/)?.[1];
            if (identity !== imdbId || data.media_type !== expectedType) continue;
            const results = new Map();
            for (const subtitle of data.subtitles || []) {
                if (subtitle.language !== 'bulgarian' || /machine|automated|^ai$/i.test(subtitle.production_type || '')) continue;
                const path = '/subtitle/' + subtitle.link;
                if (!detailPath.test(path) || !Number.isSafeInteger(subtitle.id)) continue;
                const name = subtitle.release_info;
                if (typeof name !== 'string') continue;
                if (type === 'series' && !matchIdentifiedSeries(name, season, episode).match) continue;
                results.set(subtitle.id, { id: `subsource_${subtitle.id}`, name, lang: 'bul', url: SITE + path });
            }
            if (results.size) return [...results.values()];
        }
    } catch (error) { console.error('[SubSource] Search error:', error.message); }
    return [];
}

async function download(url) {
    const target = new URL(url);
    if (target.origin !== SITE || !detailPath.test(target.pathname) || target.search || target.hash) throw new Error('Invalid SubSource subtitle URL');
    const { data } = await axios.get(API + '/v1' + target.pathname, options);
    const token = data.subtitle?.download_token;
    if (data.subtitle?.language !== 'bulgarian' || typeof token !== 'string' || !/^[a-zA-Z0-9_-]{20,256}$/.test(token)) throw new Error('SubSource download is unavailable');
    const response = await axios.get(`${API}/v1/subtitle/download/${encodeURIComponent(token)}`, { ...options, timeout: 20000, responseType: 'arraybuffer' });
    return Buffer.from(response.data);
}
module.exports = { search, download };
