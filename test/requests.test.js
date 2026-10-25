const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { attachRequestLimits } = require('../lib/requests');

test('upstream 429 activates cooldown instead of retrying the server', async () => {
    let calls = 0;
    const client = attachRequestLimits(axios.create({ adapter: async config => {
        calls++;
        throw new axios.AxiosError('Rate limited', 'ERR_BAD_REQUEST', config, {}, { status: 429, headers: { 'retry-after': '120' } });
    } }));
    await assert.rejects(client.get('https://subsland.com/index.php'), /Rate limited/);
    await assert.rejects(client.get('https://subsland.com/index.php'), /cooling down/);
    assert.equal(calls, 1);
});

test('subtitle redirects cannot fetch arbitrary hosts', async () => {
    const client = attachRequestLimits(axios.create({ adapter: async config => {
        assert.throws(() => config.beforeRedirect({ hostname: '127.0.0.1', protocol: 'http:' }), /outside/);
        assert.doesNotThrow(() => config.beforeRedirect({ hostname: 'subsunacs.net', protocol: 'https:' }));
        return { data: 'ok', status: 200, headers: {}, config };
    } }));
    assert.equal((await client.get('https://subsunacs.net/get.php?id=123')).data, 'ok');
});
