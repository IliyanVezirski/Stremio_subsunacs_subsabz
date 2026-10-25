const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AbuseGuard, normalizeIp } = require('../lib/abuse');
test('continued limit violations produce a temporary ban and expire', () => {
    let now = 0;
    const guard = new AbuseGuard({ now: () => now, banMs: 10000 });
    for (let n = 0; n < 10; n++) assert.equal(guard.consume('192.0.2.1', 'downloads', 10).allowed, true);
    for (let n = 0; n < 4; n++) assert.equal(guard.consume('192.0.2.1', 'downloads', 10).status, 429);
    assert.equal(guard.consume('192.0.2.1', 'downloads', 10).status, 403);
    assert.equal(guard.consume('192.0.2.1', 'requests', 120).status, 403);
    now = 11000;
    assert.equal(guard.consume('192.0.2.1', 'downloads', 10).allowed, true);
});
test('IPv6 rotation and IPv4-mapped forms do not evade limits', () => {
    assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(normalizeIp('2001:db8:1:2::1'), normalizeIp('2001:db8:1:2:abcd::9'));
    assert.equal(normalizeIp('invalid'), 'unknown');
});
test('a cached response budget is separate from expensive download budget', () => {
    const guard = new AbuseGuard();
    for (let n = 0; n < 10; n++) guard.consume('192.0.2.1', 'downloads', 10);
    assert.equal(guard.consume('192.0.2.1', 'requests', 120).allowed, true);
    assert.equal(guard.consume('192.0.2.1', 'searches', 20).allowed, true);
    assert.equal(guard.consume('192.0.2.2', 'downloads', 10).allowed, true);
});
