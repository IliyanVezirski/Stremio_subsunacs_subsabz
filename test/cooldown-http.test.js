const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.BASE_URL = 'http://127.0.0.1:8080';
process.env.SEARCH_TIMEOUT_MS = '100';
const { app } = require('../index');
const subsunacs = require('../providers/subsunacs');
const subsource = require('../providers/subsource');
const srt = '1\n00:00:01,000 --> 00:00:03,000\nТестов субтитър.\n';
let server, base;
before(async () => { server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); }); base = 'http://127.0.0.1:' + server.address().port; });
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(t => t.mock.method(subsource, 'search', async () => []));

test('cooldown keeps cached files playable, hides unavailable links, and returns Retry-After without stale failure caching', async t => {
    const axios = require('axios');
    const { attachRequestLimits } = require('../lib/requests');
    let now = Date.now(), downloads = 0;
    t.mock.method(Date, 'now', () => now);
    const subs = [801, 802].map(id => ({ id: `subsunacs_${id}`, name: 'Fixture', url: `https://subsunacs.net/get.php?id=${id}` }));
    t.mock.method(subsunacs, 'search', async () => subs);
    for (const name of ['subssab', 'subsland']) t.mock.method(require(`../providers/${name}`), 'search', async () => []);
    t.mock.method(subsunacs, 'download', async () => { downloads++; return Buffer.from(srt); });
    const searchUrl = `${base}/subtitles/movie/tt2888777.json`;
    const initial = await (await fetch(searchUrl)).json();
    assert.equal(initial.subtitles.length, 2);
    const urls = initial.subtitles.map(sub => base + new URL(sub.url).pathname + new URL(sub.url).search);
    assert.equal((await fetch(urls[0])).status, 200);
    const client = attachRequestLimits(axios.create({ adapter: async config => {
        throw new axios.AxiosError('fixture refusal', 'ERR_BAD_REQUEST', config, {}, { status: 403, headers: {} });
    } }));
    await assert.rejects(client.get('https://subsunacs.net/search.php'), /fixture refusal/);
    const filtered = await (await fetch(searchUrl)).json();
    assert.equal(filtered.subtitles.length, 1);
    assert.equal((await fetch(urls[0])).status, 200);
    for (let n = 0; n < 3; n++) {
        const response = await fetch(urls[1]);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('retry-after'), '60');
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(downloads, 1);
    now += 61000;
    assert.equal((await fetch(urls[1])).status, 200);
    assert.equal(downloads, 2);
});

test('a cached list containing only a paused source is replaced with available fallback results', async t => {
    const axios = require('axios');
    const { attachRequestLimits } = require('../lib/requests');
    t.mock.method(subsunacs, 'search', async () => []);
    t.mock.method(require('../providers/subsland'), 'search', async () => []);
    let searches = 0;
    t.mock.method(require('../providers/subssab'), 'search', async () => { searches++; return [{ id: 'subssab_900', name: 'Fixture', url: 'http://subs.sab.bz/index.php?act=download&attach_id=900' }]; });
    const url = `${base}/subtitles/movie/tt2999888.json`;
    assert.equal((await (await fetch(url)).json()).subtitles.length, 1);
    const client = attachRequestLimits(axios.create({ adapter: async config => {
        throw new axios.AxiosError('fixture refusal', 'ERR_BAD_REQUEST', config, {}, { status: 403, headers: {} });
    } }));
    await assert.rejects(client.get('https://subs.sab.bz/index.php'), /fixture refusal/);
    t.mock.method(subsource, 'search', async () => [{ id: 'subsource_900', name: 'Backup', url: 'https://subsource.net/subtitle/movie/bulgarian/900' }]);
    const results = await (await fetch(url)).json();
    assert.equal(results.subtitles.length, 1);
    assert.ok(results.subtitles[0].url.includes('source=subsource'));
    assert.equal(searches, 1, 'paused provider must not be called again');
});

test('the first actual upstream refusal returns 503 with its Retry-After and subsequent requests do not fetch again', async t => {
    const axios = require('axios');
    const { attachRequestLimits } = require('../lib/requests');
    let calls = 0;
    const client = attachRequestLimits(axios.create({ adapter: async config => {
        calls++;
        throw new axios.AxiosError('fixture refusal', 'ERR_BAD_REQUEST', config, {}, { status: 429, headers: { 'retry-after': '120' } });
    } }));
    t.mock.method(subsource, 'download', async () => (await client.get('https://api.subsource.net/v1/subtitle/test/bulgarian/999')).data);
    const url = `${base}/proxy?source=subsource&url=${encodeURIComponent('https://subsource.net/subtitle/test/bulgarian/999')}`;
    for (let n = 0; n < 2; n++) {
        const response = await fetch(url);
        assert.equal(response.status, 503);
        assert.equal(Number(response.headers.get('retry-after')), 120);
    }
    assert.equal(calls, 1);
});
