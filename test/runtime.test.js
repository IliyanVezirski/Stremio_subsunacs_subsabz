const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const { BoundedCache } = require('../lib/cache');
const { withDeadline } = require('../lib/requests');
const { matchesEpisode, matchesSeasonPack } = require('../lib/episodes');

test('cache evicts expired, least-recently-used and oversized data', t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const cache = new BoundedCache(2, 20);
    cache.set('a', 'one', 10);
    cache.set('b', 'two', 20);
    assert.equal(cache.get('a'), 'one');
    cache.set('c', 'three', 20);
    assert.equal(cache.get('b'), undefined);
    now = 11;
    cache.prune();
    assert.equal(cache.get('a'), undefined);
    cache.set('huge', 'x'.repeat(30), 20);
    assert.equal(cache.get('huge'), undefined);
    assert.equal(cache.size, 1);
    assert.ok(cache.bytes <= 20);
    now = 30;
    cache.prune();
    assert.equal(cache.bytes, 0);
});

test('deadline cancels the underlying HTTP request', async () => {
    let closed;
    const disconnected = new Promise(resolve => { closed = resolve; });
    const server = http.createServer((req, res) => res.on('close', closed));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(withDeadline(() => axios.get(`http://127.0.0.1:${server.address().port}`), 100), /deadline/);
        await Promise.race([disconnected, new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('HTTP request was not cancelled')), 1000);
            timer.unref();
        })]);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('series matching respects complete numbers and explicit episodes', () => {
    assert.equal(matchesEpisode('Show 11x01', 1, 1), false);
    assert.equal(matchesEpisode('Show S01E10', 1, 1), false);
    assert.equal(matchesEpisode('Show 01x01', 1, 1), true);
    assert.equal(matchesSeasonPack('Show Season 1 Episode 10', 1), false);
    assert.equal(matchesSeasonPack('Show - 01 - Complete Season', 1), true);
});
