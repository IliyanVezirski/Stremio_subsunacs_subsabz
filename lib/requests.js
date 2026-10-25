const { AsyncLocalStorage } = require('node:async_hooks');
const axios = require('axios');
const { SourceGate } = require('./source-gate');
const context = new AsyncLocalStorage();
const sourceGate = new SourceGate();
const subtitleHosts = new Set(['subsunacs.net', 'www.subsunacs.net', 'subs.sab.bz', 'subsland.com', 'www.subsland.com', 'www.easternspirit.org', 'easternspirit.org', 'subsource.net', 'api.subsource.net']);
const sourceHost = value => new URL(value.includes('://') ? value : 'https://' + value).hostname.replace(/^www\./, '');

function attachRequestLimits(client, gate = sourceGate) {
    client.interceptors.request.use(async config => {
        const signal = context.getStore() || config.signal;
        if (signal) config.signal = signal;
        const url = new URL(config.url, config.baseURL);
        if (subtitleHosts.has(url.hostname)) {
            config.beforeRedirect = options => {
                if (!subtitleHosts.has(options.hostname) || !['http:', 'https:'].includes(options.protocol) || options.auth) {
                    throw new Error('Subtitle redirect points outside the allowed sources');
                }
            };
            await gate.enter(sourceHost(url.href), config, signal);
        }
        config.maxContentLength = /get\.php|act=download|downloadsubtitles|do=download|\/v1\/subtitle\/download\//.test(url.href) ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
        return config;
    });
    client.interceptors.response.use(response => { gate.success(response.config); return response; }, error => {
        gate.failure(error);
        return Promise.reject(error);
    });
    return client;
}
attachRequestLimits(axios);

async function withDeadline(action, milliseconds) {
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            context.run(controller.signal, () => Promise.resolve().then(action)),
            new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`Provider deadline exceeded (${milliseconds} ms)`));
                    controller.abort();
                }, milliseconds);
            })
        ]);
    } finally { clearTimeout(timer); }
}
const getSourceState = host => sourceGate.state(sourceHost(host));
const canRequestSource = host => !context.getStore()?.aborted && getSourceState(host).available;
module.exports = { withDeadline, attachRequestLimits, canRequestSource, getSourceState, getSourceDiagnostics: () => sourceGate.diagnostics() };
