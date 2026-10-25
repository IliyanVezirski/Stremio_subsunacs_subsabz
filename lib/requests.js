const { AsyncLocalStorage } = require('node:async_hooks');
const axios = require('axios');
const { setTimeout: delay } = require('node:timers/promises');
const context = new AsyncLocalStorage();
const status = new Map();
const subtitleHosts = new Set(['subsunacs.net', 'www.subsunacs.net', 'subs.sab.bz', 'subsland.com', 'www.subsland.com', 'www.easternspirit.org', 'easternspirit.org', 'subsource.net', 'api.subsource.net']);
const nextRequest = new Map();

function attachRequestLimits(client) {
    client.interceptors.request.use(async config => {
        const signal = context.getStore();
        if (signal) config.signal = signal;
        const url = new URL(config.url, config.baseURL);
        if (subtitleHosts.has(url.hostname)) {
            config.beforeRedirect = options => {
                if (!subtitleHosts.has(options.hostname) || !['http:', 'https:'].includes(options.protocol) || options.auth) {
                    throw new Error('Subtitle redirect points outside the allowed sources');
                }
            };
            const entry = status.get(url.hostname) || { requests: 0, failures: 0, cooldownUntil: 0 };
            if (Date.now() < entry.cooldownUntil) throw new axios.AxiosError('Subtitle source is cooling down after refusing requests', 'EPROVIDERCOOLDOWN');
            const start = Math.max(Date.now(), nextRequest.get(url.hostname) || 0);
            nextRequest.set(url.hostname, start + 400);
            if (start > Date.now()) await delay(start - Date.now(), undefined, { signal });
            if (Date.now() < entry.cooldownUntil) throw new axios.AxiosError('Subtitle source is cooling down after refusing requests', 'EPROVIDERCOOLDOWN');
            entry.requests++;
            status.set(url.hostname, entry);
        }
        config.maxContentLength = /get\.php|act=download|downloadsubtitles|do=download|\/v1\/subtitle\/download\//.test(url.href) ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
        return config;
    });
    client.interceptors.response.use(response => response, error => {
        let host;
        try { host = new URL(error.config?.url).hostname; } catch {}
        if (subtitleHosts.has(host) && error.code !== 'EPROVIDERCOOLDOWN' && error.code !== 'ERR_CANCELED') {
            const entry = status.get(host) || { requests: 0, failures: 0, cooldownUntil: 0 };
            entry.failures++;
            entry.lastStatus = error.response?.status || error.code;
            if ([401, 403, 429, 522].includes(error.response?.status)) {
                const retry = Number(error.response.headers?.['retry-after']);
                entry.cooldownUntil = Date.now() + Math.min(15 * 60000, Math.max(60000, Number.isFinite(retry) ? retry * 1000 : 60000));
            }
            status.set(host, entry);
        }
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
module.exports = { withDeadline, attachRequestLimits, getSourceDiagnostics: () => Object.fromEntries(status) };
