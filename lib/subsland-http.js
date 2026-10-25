const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const axios = require('axios');
const { binary } = require('./curl-binary');

function allowedUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'subsland.com' || url.port || url.username || url.password) {
        throw new Error('SubsLand HTTP client refused an external URL');
    }
    return url.href;
}

function parseHeaders(raw) {
    const blocks = raw.split(/\r?\n\r?\n/).filter(block => /^HTTP\//.test(block));
    const lines = (blocks.at(-1) || '').split(/\r?\n/);
    const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(lines.shift());
    if (!status) throw new Error('Invalid upstream HTTP response');
    const headers = {};
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 1) continue;
        const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
        if (key === 'set-cookie') (headers[key] ||= []).push(value);
        else headers[key] = value;
    }
    return { status: Number(status[1]), statusText: status[2] || '', headers };
}

function createCurlAdapter({ executable = binary, spawnProcess = spawn, maxConcurrent = 2 } = {}) {
    let active = 0;
    const queue = [];
    function release() {
        active--;
        const next = queue.shift();
        if (next) { next.cleanup(); active++; next.resolve(release); }
    }
    function acquire(config) {
        if (config.signal?.aborted) return Promise.reject(new axios.CanceledError('canceled', config));
        if (active < maxConcurrent) { active++; return Promise.resolve(release); }
        if (queue.length >= 16) return Promise.reject(new axios.AxiosError('SubsLand HTTP client is busy', 'EBUSY', config));
        return new Promise((resolve, reject) => {
            const abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); entry.cleanup(); reject(new axios.CanceledError('canceled', config)); };
            const entry = { resolve, cleanup: () => config.signal?.removeEventListener('abort', abort) };
            queue.push(entry);
            config.signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async function request(url, config) {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subsland-http-'));
        const headerFile = path.join(directory, 'headers');
        const timeout = Math.min(30000, Math.max(1, Number(config.timeout) || 20000));
        const limit = Math.min(20 * 1024 * 1024, config.maxContentLength > 0 ? config.maxContentLength : 2 * 1024 * 1024);
        try {
            if (config.signal?.aborted) throw new axios.CanceledError('canceled', config);
            const args = ['--disable', '--impersonate', 'chrome131', '--compressed', '--silent', '--show-error', '--globoff',
                '--proto', '=https', '--max-time', String(timeout / 1000), '--connect-timeout', String(Math.min(timeout, 10000) / 1000),
                '--max-filesize', String(limit), '--dump-header', headerFile];
            const headers = axios.AxiosHeaders.from(config.headers);
            for (const name of ['Accept', 'Accept-Language', 'Referer', 'User-Agent']) {
                const value = headers.get(name);
                if (value && !/[\r\n]/.test(value)) args.push('--header', `${name}: ${value}`);
            }
            const cookies = await config.jar?.getCookieString(url);
            if (cookies) args.push('--header', `Cookie: ${cookies}`);
            args.push('--url', allowedUrl(url));
            const data = await new Promise((resolve, reject) => {
                const child = spawnProcess(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: config.signal, timeout: timeout + 500 });
                let size = 0, failure;
                const chunks = [];
                child.stdout.on('data', chunk => {
                    size += chunk.length;
                    if (size > limit) { failure = new axios.AxiosError('SubsLand response exceeds size limit', 'ERR_BAD_RESPONSE', config); child.kill(); }
                    else chunks.push(chunk);
                });
                child.stderr.resume(); // Do not expose request headers or native diagnostics in public errors.
                child.on('error', error => { failure = error; });
                child.on('close', code => {
                    if (config.signal?.aborted) return reject(new axios.CanceledError('canceled', config));
                    if (failure) return reject(new axios.AxiosError(failure.message, failure.code || 'EUPSTREAM', config));
                    if (code !== 0) return reject(new axios.AxiosError(`SubsLand HTTP client failed (${code})`, code === 28 ? 'ECONNABORTED' : 'EUPSTREAM', config));
                    resolve(Buffer.concat(chunks, size));
                });
            });
            if ((await fs.stat(headerFile)).size > 65536) throw new Error('SubsLand response headers exceed size limit');
            const response = { ...parseHeaders(await fs.readFile(headerFile, 'utf8')), data, config };
            for (const cookie of response.headers['set-cookie'] || []) await config.jar?.setCookie(cookie, url, { ignoreError: true });
            return response;
        } finally {
            await fs.unlink(headerFile).catch(() => {});
            await fs.rmdir(directory).catch(() => {});
        }
    }
    return async config => {
        if (config.method && config.method.toLowerCase() !== 'get') throw new axios.AxiosError('SubsLand only supports GET', 'ERR_BAD_REQUEST', config);
        let url = allowedUrl(config.url);
        const outerSignal = config.signal;
        const timeoutSignal = AbortSignal.timeout(Math.min(30000, Math.max(1, Number(config.timeout) || 20000)));
        config = { ...config, signal: outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal };
        let done;
        try {
            done = await acquire(config);
            for (let redirects = 0; redirects <= 3; redirects++) {
                const response = await request(url, config);
                if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
                    url = allowedUrl(new URL(response.headers.location, url).href);
                    continue;
                }
                if (config.validateStatus && !config.validateStatus(response.status)) {
                    throw new axios.AxiosError(`Request failed with status code ${response.status}`, 'ERR_BAD_RESPONSE', config, null, response);
                }
                return response;
            }
            throw new axios.AxiosError('Too many SubsLand redirects', 'ERR_FR_TOO_MANY_REDIRECTS', config);
        } catch (error) {
            if (!outerSignal?.aborted && timeoutSignal.aborted) throw new axios.AxiosError('SubsLand HTTP request timed out', 'ECONNABORTED', config);
            throw error;
        } finally { done?.(); }
    };
}
module.exports = { createCurlAdapter, parseHeaders, allowedUrl };
