const axios = require('axios');
const { setTimeout: delay } = require('node:timers/promises');

function retryDelay(value, now) {
    if (value == null || value === '') return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function refusalDetails(response) {
    const headers = response?.headers || {};
    // Fixed classifications only: never put cookies, URLs or response bodies in /debug.
    const body = Buffer.isBuffer(response?.data) ? response.data.subarray(0, 16384).toString('utf8')
        : typeof response?.data === 'string' ? response.data.slice(0, 16384) : '';
    const cloudflare = /cloudflare/i.test(String(headers.server || ''));
    const challenge = headers['cf-mitigated'] === 'challenge' || /<title>\s*Just a moment|cf-chl-|challenge-platform/i.test(body);
    const kind = challenge ? 'cloudflare-challenge' : response?.status === 429 ? 'rate-limit'
        : response?.status === 525 ? 'origin-tls-failure' : cloudflare && response?.status === 403 ? 'cloudflare-forbidden'
        : response?.status === 403 ? 'forbidden' : response?.status === 401 ? 'authentication-required' : 'upstream-error';
    const ray = String(headers['cf-ray'] || '');
    return { kind, ...( /^[a-f0-9]{12,32}-[A-Z]{3}$/.test(ray) ? { ray } : {} ) };
}

function waitTurn(promise, signal, config) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(new axios.CanceledError('Request canceled', config));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

class SourceGate {
    constructor({ now = () => Date.now(), sleep = delay, spacing = host => ['subs.sab.bz', 'subsland.com'].includes(host) ? 1000 : 400, log = console.warn } = {}) {
        this.now = now; this.sleep = sleep; this.spacing = spacing; this.log = log; this.sources = new Map(); this.queues = new Map();
    }
    entry(host) {
        if (!this.sources.has(host)) this.sources.set(host, { requests: 0, failures: 0, cooldownUntil: 0, consecutiveRefusals: 0, probing: false, epoch: 0, nextRequest: 0 });
        return this.sources.get(host);
    }
    state(host) {
        const entry = this.entry(host);
        const retryAfter = Math.max(entry.probing ? 1 : 0, Math.ceil((entry.cooldownUntil - this.now()) / 1000));
        return { ...entry, available: retryAfter === 0, retryAfter };
    }
    unavailable(host, config) {
        const state = this.state(host);
        const error = new axios.AxiosError('Subtitle source is cooling down after refusing requests', 'EPROVIDERCOOLDOWN', config);
        error.retryAfter = state.retryAfter;
        error.retryAt = Math.max(state.cooldownUntil, this.now() + state.retryAfter * 1000);
        return error;
    }
    async enter(host, config, signal) {
        if (signal?.aborted) throw new axios.CanceledError('Request canceled', config);
        const entry = this.entry(host); // Register shared state before any await.
        if (!this.state(host).available) throw this.unavailable(host, config);
        const previous = this.queues.get(host) || Promise.resolve();
        let release;
        const turn = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => turn);
        this.queues.set(host, tail);
        try {
            await waitTurn(previous, signal, config);
            if (!this.state(host).available) throw this.unavailable(host, config);
            const start = Math.max(this.now(), entry.nextRequest);
            if (start > this.now()) await this.sleep(start - this.now(), undefined, { signal });
            if (signal?.aborted) throw new axios.CanceledError('Request canceled', config);
            if (!this.state(host).available) throw this.unavailable(host, config);
            const probe = entry.consecutiveRefusals > 0;
            if (probe) entry.probing = true;
            config.subtitleGate = { host, epoch: entry.epoch, probe };
            entry.nextRequest = this.now() + this.spacing(host);
            entry.requests++;
        } finally {
            // Canceled searches do not reserve future HTTP slots and delay real downloads.
            release();
            tail.then(() => { if (this.queues.get(host) === tail) this.queues.delete(host); });
        }
    }
    success(config) {
        const request = config?.subtitleGate;
        if (!request) return;
        const entry = this.entry(request.host);
        // An older in-flight success must not undo a newer refusal.
        if (request.epoch !== entry.epoch) return;
        if (request.probe) this.log(`[Source] ${request.host} recovered; requests resumed`);
        entry.probing = false; entry.consecutiveRefusals = 0; entry.cooldownUntil = 0;
    }
    failure(error) {
        const request = error.config?.subtitleGate;
        if (!request || error.code === 'EPROVIDERCOOLDOWN') return;
        const entry = this.entry(request.host);
        if (request.probe && request.epoch === entry.epoch) entry.probing = false;
        if (axios.isCancel(error) || error.code === 'ABORT_ERR') return;
        entry.failures++; entry.lastStatus = error.response?.status || error.code; entry.lastFailureAt = this.now();
        entry.lastRefusal = refusalDetails(error.response);
        if ([401, 403, 429, 503, 522].includes(error.response?.status) || request.probe) {
            // Concurrent failures belong to one refusal event, not multiple backoff steps.
            if (request.epoch === entry.epoch) { entry.consecutiveRefusals++; entry.epoch++; }
            const backoff = Math.min(15 * 60000, 60000 * 2 ** Math.min(4, entry.consecutiveRefusals - 1));
            const serverWait = retryDelay(error.response?.headers?.['retry-after'], this.now());
            const until = this.now() + Math.max(backoff, serverWait);
            const first = entry.cooldownUntil <= this.now();
            entry.cooldownUntil = Math.max(entry.cooldownUntil, until);
            entry.probing = false;
            error.retryAfter = Math.ceil((entry.cooldownUntil - this.now()) / 1000);
            error.retryAt = entry.cooldownUntil;
            if (first) this.log(`[Source] ${request.host} returned ${entry.lastStatus} (${entry.lastRefusal.kind}${entry.lastRefusal.ray ? ', ray=' + entry.lastRefusal.ray : ''}); paused for ${error.retryAfter}s until ${new Date(entry.cooldownUntil).toISOString()}`);
        }
    }
    diagnostics() { return Object.fromEntries([...this.sources.keys()].map(host => [host, this.state(host)])); }
}
module.exports = { SourceGate, retryDelay, refusalDetails };
