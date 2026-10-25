const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { SourceGate, retryDelay } = require('../lib/source-gate');
const { attachRequestLimits } = require('../lib/requests');
const refused = (config, status = 403, headers = {}) => new axios.AxiosError('refused', 'ERR_BAD_REQUEST', config, {}, { status, headers });

test('HTTP Retry-After dates and seconds are respected', () => {
    const now = Date.parse('2026-10-25T17:00:00Z');
    assert.equal(retryDelay('120', now), 120000);
    assert.equal(retryDelay('Sun, 25 Oct 2026 17:02:00 GMT', now), 120000);
    assert.equal(retryDelay('invalid', now), 0);
});

test('one probe is allowed after cooldown; repeated refusals increase waiting time', async () => {
    let now = 1000000;
    const gate = new SourceGate({ now: () => now, spacing: () => 0, log: () => {} });
    const config = {};
    await gate.enter('subsland.com', config);
    gate.failure(refused(config));
    assert.equal(gate.state('subsland.com').retryAfter, 60);
    now += 60000;
    const probe = {};
    await gate.enter('subsland.com', probe);
    await assert.rejects(gate.enter('subsland.com', {}), { code: 'EPROVIDERCOOLDOWN' });
    gate.failure(refused(probe));
    assert.equal(gate.state('subsland.com').retryAfter, 120);
    now += 120000;
    const recovered = {};
    await gate.enter('subsland.com', recovered);
    gate.success(recovered);
    assert.equal(gate.state('subsland.com').available, true);
    assert.equal(gate.state('subsland.com').consecutiveRefusals, 0);
});

test('an older in-flight success cannot undo a later refusal', async () => {
    const gate = new SourceGate({ spacing: () => 0, log: () => {} });
    const first = {}, second = {};
    await gate.enter('subs.sab.bz', first);
    await gate.enter('subs.sab.bz', second);
    gate.failure(refused(second));
    gate.success(first);
    assert.equal(gate.state('subs.sab.bz').available, false);
});

test('queued requests see a refusal from the first request and never reach the server', async () => {
    let now = 100000, wake;
    const sleeping = new Promise(resolve => { wake = resolve; });
    const gate = new SourceGate({ now: () => now, spacing: () => 1000, sleep: () => sleeping, log: () => {} });
    let failFirst, calls = 0;
    const client = attachRequestLimits(axios.create({ adapter: config => {
        calls++;
        return new Promise((resolve, reject) => { failFirst = () => reject(refused(config)); });
    } }), gate);
    const first = client.get('https://subsland.com/index.php');
    const firstRejected = assert.rejects(first, /refused/);
    while (!failFirst) await new Promise(resolve => setImmediate(resolve));
    const second = client.get('https://subsland.com/index.php?page=1');
    const secondRejected = assert.rejects(second, { code: 'EPROVIDERCOOLDOWN' });
    await new Promise(resolve => setImmediate(resolve));
    failFirst(); await firstRejected;
    now += 1000; wake(); await secondRejected;
    assert.equal(calls, 1);
});

test('canceled queued work does not reserve future slots', async () => {
    let now = 100000, wake;
    const gate = new SourceGate({ now: () => now, spacing: () => 1000, sleep: () => new Promise(resolve => { wake = resolve; }), log: () => {} });
    await gate.enter('subsunacs.net', {});
    const controller = new AbortController();
    const queued = gate.enter('subsunacs.net', {}, controller.signal);
    const rejected = assert.rejects(queued, { code: 'ERR_CANCELED' });
    while (!wake) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); now += 1000; wake(); await rejected;
    assert.equal(gate.state('subsunacs.net').nextRequest, now);
    const next = {};
    await gate.enter('subsunacs.net', next);
    assert.equal(gate.state('subsunacs.net').requests, 2);
});
