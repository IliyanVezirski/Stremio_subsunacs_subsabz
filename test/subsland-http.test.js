const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { createCurlAdapter, parseHeaders } = require('../lib/subsland-http');
const fixture = path.join(__dirname, 'fixtures', 'fake-curl.cjs');
const fakeSpawn = (_, args, options) => spawn(process.execPath, [fixture, ...args], options);
const client = options => axios.create({ adapter: createCurlAdapter({ spawnProcess: fakeSpawn, ...options }), jar: new CookieJar(), responseType: 'arraybuffer' });

test('native SubsLand client retains cookies, disables curlrc and URL globbing', async () => {
    const http = client();
    await http.get('https://subsland.com/cookie');
    const result = JSON.parse((await http.get('https://subsland.com/check')).data);
    assert.equal(result.cookie, 'Cookie: session=fixture');
    assert.equal(result.disabledConfig, true);
    assert.equal(result.globoff, true);
});

test('native SubsLand client only follows same-host HTTPS redirects', async () => {
    let spawned = 0;
    const http = client({ spawnProcess: (...args) => { spawned++; return fakeSpawn(...args); } });
    assert.equal(JSON.parse((await http.get('https://subsland.com/redirect')).data).path, '/final');
    assert.equal(spawned, 2);
    await assert.rejects(http.get('https://subsland.com/external'), /external URL/);
    assert.equal(spawned, 3);
    await assert.rejects(http.get('https://example.com/'), /external URL/);
    assert.equal(spawned, 3);
});

test('native SubsLand client preserves upstream status and Retry-After for the source gate', async () => {
    await assert.rejects(client().get('https://subsland.com/refused'), error => {
        assert.equal(error.response.status, 403);
        assert.equal(error.response.headers['retry-after'], '120');
        assert.equal(error.response.headers['cf-mitigated'], 'challenge');
        return true;
    });
});

test('native SubsLand client bounds decompressed output and cancels a running native process', async () => {
    const http = client();
    await assert.rejects(http.get('https://subsland.com/large', { maxContentLength: 1024 }), /size limit/);
    const controller = new AbortController();
    const started = Date.now();
    const pending = http.get('https://subsland.com/slow', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, error => axios.isCancel(error));
    assert.ok(Date.now() - started < 2000);
});

test('a canceled queued request never launches a native process', async () => {
    let spawned = 0;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const http = client({ maxConcurrent: 1, spawnProcess: (...args) => { spawned++; markStarted(); return fakeSpawn(...args); } });
    const first = new AbortController(), second = new AbortController();
    const a = http.get('https://subsland.com/slow', { signal: first.signal }).catch(error => error);
    const b = http.get('https://subsland.com/slow', { signal: second.signal }).catch(error => error);
    await started;
    second.abort();
    assert.ok(axios.isCancel(await b));
    first.abort();
    assert.ok(axios.isCancel(await a));
    assert.equal(spawned, 1);
    assert.equal((await http.get('https://subsland.com/final')).status, 200);
});

test('native header parser handles CONNECT and multiple Set-Cookie headers', () => {
    const response = parseHeaders('HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\n');
    assert.equal(response.status, 200);
    assert.deepEqual(response.headers['set-cookie'], ['a=1', 'b=2']);
});

test('native timeout includes queue time and releases process capacity', async () => {
    const http = client({ maxConcurrent: 1 });
    const a = http.get('https://subsland.com/slow', { timeout: 150 }).catch(error => error);
    const b = http.get('https://subsland.com/slow', { timeout: 50 }).catch(error => error);
    assert.equal((await b).code, 'ECONNABORTED');
    assert.equal((await a).code, 'ECONNABORTED');
    assert.equal((await http.get('https://subsland.com/final')).status, 200);
});
