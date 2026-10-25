const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const subsland = require('../providers/subsland');

test('SubsLand axios fallback preserves the server session from search through download', async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/search') { res.setHeader('Set-Cookie', 'land_session=fixture; Path=/; HttpOnly'); res.end('search'); }
        else { res.statusCode = req.headers.cookie === 'land_session=fixture' ? 200 : 403; res.end('archive'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const adapter = require('axios').getAdapter('http');
    await subsland.client.get(base + '/search', { adapter });
    assert.equal((await subsland.client.get(base + '/download', { adapter })).data, 'archive');
});

test('SubsLand canonicalizes old www links and uses the detail page as download Referer', async t => {
    const visited = [];
    t.mock.method(subsland.client, 'get', async (url, config) => {
        visited.push({ url, referer: config.headers?.Referer });
        return { data: url.includes('/subtitles/')
            ? Buffer.from('<a href="https://www.subsland.com/downloadsubtitles/test.rar">Download</a>') : Buffer.from('Rar! fixture') };
    });
    const result = await subsland.download('http://www.subsland.com/subtitles/test-123.html');
    assert.equal(result.toString(), 'Rar! fixture');
    assert.deepEqual(visited.map(x => x.url), ['https://subsland.com/subtitles/test-123.html', 'https://subsland.com/downloadsubtitles/test.rar']);
    assert.equal(visited[1].referer, 'https://subsland.com/subtitles/test-123.html');
    await assert.rejects(subsland.download('https://example.com/downloadsubtitles/evil.zip'), /Invalid SubsLand URL/);
    assert.equal(visited.length, 2);
});

test('Source diagnostics distinguish a Cloudflare challenge without exposing the response or cookies', () => {
    const { refusalDetails } = require('../lib/source-gate');
    const result = refusalDetails({ status: 403, headers: { server: 'cloudflare', 'cf-mitigated': 'challenge', 'cf-ray': 'a502e4b32c20d8ac-SOF', 'set-cookie': 'secret=private' }, data: 'private body' });
    assert.deepEqual(result, { kind: 'cloudflare-challenge', ray: 'a502e4b32c20d8ac-SOF' });
    assert.equal(refusalDetails({ status: 403, headers: { server: 'cloudflare' }, data: Buffer.from('<title>Just a moment...</title>') }).kind, 'cloudflare-challenge');
    assert.equal(refusalDetails({ status: 403, headers: { server: 'cloudflare' }, data: 'Forbidden' }).kind, 'cloudflare-forbidden');
    assert.equal(refusalDetails({ status: 525 }).kind, 'origin-tls-failure');
});
