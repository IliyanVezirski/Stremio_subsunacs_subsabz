const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
process.env.BASE_URL = 'http://127.0.0.1:8080';
process.env.SEARCH_TIMEOUT_MS = '100';
const { app, findSubtitleForEpisode, decodeSubtitleBuffer, extractSubtitleFromZip } = require('../index');
const subsunacs = require('../providers/subsunacs');
const subsource = require('../providers/subsource');
beforeEach(t => t.mock.method(subsource, 'search', async () => []));
const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\nЗдравей, свят!\r\n';
const files = (...names) => names.map(name => ({ name }));

test('episode 1 is not episode 10', () => {
    assert.equal(findSubtitleForEpisode(files('Show.S01E10.srt', 'Show.S01E01.srt'), '1', '1').name, 'Show.S01E01.srt');
});
test('missing episode never falls back to another episode', () => {
    assert.equal(findSubtitleForEpisode(files('Show.S01E02.srt', 'Show.S01E03.srt'), '1', '1'), null);
});
test('single wrong episode is rejected', () => {
    assert.equal(findSubtitleForEpisode(files('Show.S02E01.srt'), '1', '1'), null);
});
test('wrong season is not matched by the loose episode pattern', () => {
    assert.equal(findSubtitleForEpisode(files('Show.S02E01.srt', 'Show.S02E02.srt'), '1', '1'), null);
});
test('episode-only names and unnamed single releases still work', () => {
    assert.equal(findSubtitleForEpisode(files('Show.02.srt', 'Show.01.srt'), '1', '1').name, 'Show.01.srt');
    assert.equal(findSubtitleForEpisode(files('release.srt'), '1', '1').name, 'release.srt');
});
test('Windows-1251 and UTF-8 Bulgarian decode correctly', () => {
    for (const encoding of ['win1251', 'utf8']) assert.equal(decodeSubtitleBuffer(iconv.encode(srt, encoding)), srt);
});
test('valid UTF-8 without Cyrillic is preserved', () => {
    assert.equal(decodeSubtitleBuffer(Buffer.from('Café — déjà vu')), 'Café — déjà vu');
});
test('UTF-16 subtitles with BOM decode correctly', () => {
    assert.equal(decodeSubtitleBuffer(iconv.encode(srt, 'utf16le', { addBOM: true })), srt);
});
test('ZIP extracts the requested episode with Cyrillic intact', () => {
    const zip = new AdmZip();
    zip.addFile('Show.S01E01.srt', iconv.encode(srt, 'win1251'));
    zip.addFile('Show.S01E10.srt', Buffer.from('wrong episode'));
    assert.equal(extractSubtitleFromZip(zip.toBuffer(), '1', '1'), srt);
    assert.equal(extractSubtitleFromZip(zip.toBuffer(), '1', '9'), null);
});

let server, base;
before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

test('manifest is compatible with the subtitle resource', async () => {
    const response = await fetch(`${base}/manifest.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const manifest = await response.json();
    assert.deepEqual(manifest.types, ['movie', 'series']);
    assert.doesNotMatch(manifest.description, /opensubtitles/i);
    assert.equal((await fetch(`${base}/proxy?source=opensubtitles&url=https://www.opensubtitles.org/`)).status, 400);
});
test('proxy accepts subtitle dialogue containing the word error', async t => {
    const content = srt.replace('Здравей, свят!', 'There is an error.');
    t.mock.method(subsunacs, 'download', async () => Buffer.from(content));
    const response = await fetch(`${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=1')}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
});
test('parallel proxy requests share one download and then use cache', async t => {
    let calls = 0;
    t.mock.method(subsunacs, 'download', async () => {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 30));
        return iconv.encode(srt, 'win1251');
    });
    const url = `${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=2')}`;
    const responses = await Promise.all([fetch(url), fetch(url)]);
    for (const response of responses) assert.equal(await response.text(), srt);
    assert.equal(await (await fetch(url)).text(), srt);
    assert.equal(calls, 1);
});
test('search returns local proxy URLs and keeps provider names', async t => {
    for (const name of ['subsunacs', 'subssab', 'subsland']) {
        t.mock.method(require(`../providers/${name}`), 'search', async () => name === 'subsunacs' ? [{ id: 'subsunacs_123', name: 'Release', url: 'https://subsunacs.net/get.php?id=123' }] : []);
    }
    const result = await (await fetch(`${base}/subtitles/movie/tt1234567.json`)).json();
    assert.equal(result.subtitles.length, 1);
    assert.equal(new URL(result.subtitles[0].url).origin, process.env.BASE_URL);
    assert.equal(result.subtitles[0].lang, 'bul');
});

test('slow provider cannot block search; concurrent searches run only once', async t => {
    const counts = {};
    for (const name of ['subsunacs', 'subssab', 'subsland']) {
        counts[name] = 0;
        t.mock.method(require(`../providers/${name}`), 'search', async () => {
            counts[name]++;
            if (name === 'subsland') return new Promise(() => {});
            return name === 'subsunacs' ? [{ id: 'subsunacs_124', name: 'Release', url: 'https://subsunacs.net/get.php?id=124' }] : [];
        });
    }
    const started = Date.now();
    const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/subtitles/series/tt1234568:1:10.json`)));
    for (const response of responses) assert.equal((await response.json()).subtitles.length, 1);
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(Object.values(counts), [1, 1, 1]);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
});
test('HTML is rejected, invalid query cannot fetch arbitrary URLs, and server stays healthy', async t => {
    t.mock.method(subsunacs, 'download', async () => Buffer.from('<html lang="en"><body>Error</body></html>'));
    const html = await fetch(`${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=4')}`);
    assert.equal(html.status, 404);
    for (const query of ['source=unknown&url=http://127.0.0.1', 'source=subsunacs&url[]=https://subsunacs.net', 'source=subsunacs&url=https://example.com']) {
        assert.equal((await fetch(`${base}/proxy?${query}`)).status, 400);
    }
    assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('repeated failures are cached and do not repeatedly download the same archive', async t => {
    let count = 0;
    t.mock.method(subsunacs, 'download', async () => { count++; return Buffer.from('<html>Unavailable</html>'); });
    const url = `${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=999')}`;
    for (let i = 0; i < 12; i++) assert.equal((await fetch(url)).status, 404);
    assert.equal(count, 1);
});

test('unique concurrent searches are bounded and health remains responsive', async t => {
    let release, started = 0;
    const gate = new Promise(resolve => { release = resolve; });
    for (const name of ['subsunacs', 'subssab', 'subsland']) {
        t.mock.method(require(`../providers/${name}`), 'search', async () => {
            started++;
            await gate;
            return [{ id: 'subsunacs_321', name: 'Fixture', url: 'https://subsunacs.net/get.php?id=321' }];
        });
    }
    const requests = Array.from({ length: 12 }, (_, n) => fetch(`${base}/subtitles/movie/tt9000${n}.json`));
    try {
        const deadline = Date.now() + 1000;
        while (started < 36 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
        assert.equal(started, 36);
        const busy = await (await fetch(`${base}/subtitles/movie/tt99999999.json`)).json();
        assert.deepEqual(busy.subtitles, []);
        assert.equal(busy.cacheMaxAge, 0);
        assert.equal((await fetch(`${base}/health`)).status, 200);
        assert.equal(started, 36);
    } finally { release(); await Promise.all(requests); }
});

test('different downloads are bounded while duplicate requests share work', async t => {
    let release, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(subsunacs, 'download', async () => { calls++; await gate; return Buffer.from(srt); });
    const url = n => `${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=' + (500 + n))}`;
    const pending = Array.from({ length: 4 }, (_, n) => fetch(url(n)));
    try {
        const deadline = Date.now() + 1000;
        while (calls < 4 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls, 4);
        assert.equal((await fetch(url(5))).status, 503);
        pending.push(fetch(url(0)));
        assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally { release(); }
    for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
    assert.equal(calls, 4);
});

test('missing MicroDVD FPS returns 422 and upstream failures return 502 while health stays available', async t => {
    t.mock.method(subsunacs, 'download', async url => {
        if (url.includes('701')) throw new Error('Upstream returned 403');
        return Buffer.from('{25}{75}Тестов субтитър\n');
    });
    const response = await fetch(`${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=700')}`);
    assert.equal(response.status, 422);
    assert.match(await response.text(), /FPS/);
    const failed = await fetch(`${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=701')}`);
    assert.equal(failed.status, 502);
    assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a single primary catalog also gets independent backup releases', async t => {
    t.mock.method(subsunacs, 'search', async () => [{ id: 'subsunacs_1', name: 'Movie CD release', url: 'https://subsunacs.net/get.php?id=1' }]);
    for (const name of ['subssab', 'subsland']) t.mock.method(require(`../providers/${name}`), 'search', async () => []);
    t.mock.method(subsource, 'search', async () => [{ id: 'subsource_2', name: 'Movie full release', url: 'https://subsource.net/subtitle/movie/bulgarian/2' }]);
    const body = await (await fetch(`${base}/subtitles/movie/tt1987654.json`)).json();
    assert.equal(body.subtitles.length, 2);
    assert.ok(body.subtitles.some(item => item.url.includes('source=subsource')));
});
