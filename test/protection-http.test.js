const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.TRUST_PROXY_HOPS = '0';
const { app } = require('../index');
let server, base;
before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));
test('spoofed forwarding headers cannot reset limits on a direct connection', async () => {
    const statuses = [];
    for (let n = 0; n < 127; n++) {
        const response = await fetch(`${base}/manifest.json`, { headers: { 'X-Forwarded-For': `198.51.100.${n}` } });
        await response.text();
        statuses.push(response.status);
    }
    assert.ok(statuses.includes(429));
    assert.equal(statuses.at(-1), 403);
    assert.equal((await fetch(`${base}/health`)).status, 200);
});
test('trusted-proxy mode uses the nearest untrusted address; hard bans are preserved', async () => {
    app.set('trust proxy', 1);
    const banned = await fetch(`${base}/manifest.json`, { headers: { 'X-Forwarded-For': '203.0.113.1, 185.107.56.71' } });
    assert.equal(banned.status, 403);
    const forgedLeft = await fetch(`${base}/manifest.json`, { headers: { 'X-Forwarded-For': '185.107.56.71, 203.0.113.1' } });
    assert.equal(forgedLeft.status, 200);
});

test('one client exhausting its fresh-download budget does not block another client', async t => {
    app.set('trust proxy', 1);
    const provider = require('../providers/subsunacs');
    t.mock.method(provider, 'download', async () => Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nЗдравей!\n'));
    for (let n = 0; n < 11; n++) {
        const response = await fetch(`${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=' + n)}`, { headers: { 'X-Forwarded-For': '198.51.100.10' } });
        assert.equal(response.status, n < 10 ? 200 : 429);
        await response.text();
    }
    const response = await fetch(`${base}/proxy?source=subsunacs&url=${encodeURIComponent('https://subsunacs.net/get.php?id=100')}`, { headers: { 'X-Forwarded-For': '198.51.100.11' } });
    assert.equal(response.status, 200);
});
