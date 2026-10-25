const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const cases = require('./validation-cases.json');
if (cases.movies.length !== 50 || cases.series.length !== 50) throw new Error('Expected exactly 50 movies and 50 series');
const selected = new Set(process.argv.slice(2));
const inputs = [...cases.movies.map(([id, title]) => ({ type: 'movie', id, title })), ...cases.series.map(([id, title]) => ({ type: 'series', id, title }))]
    .filter(item => !selected.size || selected.has(item.id));
const codeFiles = ['index.js', 'package.json', 'package-lock.json', 'scripts/validate_100.js', 'scripts/validation-cases.json', ...['lib', 'providers'].flatMap(dir => fs.readdirSync(dir).filter(file => file.endsWith('.js')).sort().map(file => `${dir}/${file}`))];
const hash = createHash('sha256');
for (const file of codeFiles) hash.update(file).update(fs.readFileSync(file));
const report = { startedAt: new Date().toISOString(), sourceSha256: hash.digest('hex'), expected: inputs.length, results: [], summary: null };
fs.mkdirSync('reports', { recursive: true });
fs.mkdirSync('tmp', { recursive: true });
const output = selected.size ? 'reports/validation-recheck.json' : 'reports/validation-100.json';
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
const port = process.env.TEST_PORT || '18081';
const base = `http://127.0.0.1:${port}`;
const log = fs.createWriteStream(selected.size ? 'tmp/validation-recheck.log' : 'tmp/validation-100.log');
const child = fork(path.join(__dirname, '..', 'index.js'), [], { env: { ...process.env, PORT: port, BASE_URL: base }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
child.stdout.pipe(log); child.stderr.pipe(log);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url, timeout = 40000) {
    for (let retry = 0; retry < 3; retry++) {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
        if (response.status !== 429) return response;
        const wait = Number(response.headers.get('retry-after')) || 60;
        await response.text();
        await sleep(Math.min(900, Math.max(1, wait)) * 1000 + 250);
    }
    throw new Error('Rate limit persisted after respecting Retry-After');
}
function verify(content) {
    const cues = [...content.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/g)];
    const validTimes = cues.every(m => {
        const time = offset => Number(m[offset]) * 3600000 + Number(m[offset + 1]) * 60000 + Number(m[offset + 2]) * 1000 + Number(m[offset + 3]);
        return time(5) >= time(1);
    });
    const cyrillic = (content.match(/[А-Яа-я]/g) || []).length;
    return { cues: cues.length, cyrillic, valid: cues.length >= 5 && cyrillic >= 20 && validTimes && !content.includes('\uFFFD') && !/<html\b/i.test(content) };
}
function candidates(subtitles) {
    const groups = new Map();
    for (const sub of subtitles) {
        const source = new URL(sub.url).searchParams.get('source');
        if (!groups.has(source)) groups.set(source, []);
        groups.get(source).push(sub);
    }
    const result = [];
    for (let i = 0; i < 12; i++) for (const group of groups.values()) if (group[i]) result.push(group[i]);
    return result.slice(0, 12);
}
(async () => {
    for (let n = 0; ; n++) {
        try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
        if (n === 100 || child.exitCode !== null) throw new Error('Validation server failed to start');
        await sleep(100);
    }
    const manifest = await (await fetch(`${base}/manifest.json`)).json();
    report.manifestVersion = manifest.version;
    save();
    for (const input of inputs) {
        const started = Date.now();
        const row = { ...input, success: false, attempts: [] };
        try {
            const response = await request(`${base}/subtitles/${input.type}/${input.id}.json`, 25000);
            row.searchStatus = response.status;
            row.searchMs = Date.now() - started;
            const json = await response.json();
            if (!response.ok || !Array.isArray(json.subtitles)) throw new Error('Invalid search response');
            row.found = json.subtitles.length;
            if (!row.found) row.error = 'No matching subtitles found';
            for (const sub of candidates(json.subtitles)) {
                const attempt = { source: new URL(sub.url).searchParams.get('source'), name: sub.name };
                row.attempts.push(attempt);
                try {
                    if (new URL(sub.url).origin !== base) throw new Error('Result points outside local addon');
                    const file = await request(sub.url);
                    const text = await file.text();
                    attempt.status = file.status;
                    attempt.file = decodeURIComponent(file.headers.get('x-subtitle-file') || '');
                    attempt.episodeMatched = file.headers.get('x-subtitle-episode-match');
                    const checks = verify(text);
                    Object.assign(attempt, checks);
                    attempt.valid = file.ok && checks.valid && (input.type === 'movie' || attempt.episodeMatched === 'yes');
                    if (attempt.valid) { row.success = true; break; }
                    attempt.error = file.ok ? 'Subtitle/episode validation failed' : text.slice(0, 200);
                } catch (error) { attempt.error = error.message; }
                await sleep(6500);
            }
        } catch (error) { row.error = error.message; }
        row.totalMs = Date.now() - started;
        report.results.push(row);
        const passed = report.results.filter(item => item.success).length;
        report.summary = { completed: report.results.length, passed, failed: report.results.length - passed, successPercent: 100 * passed / inputs.length };
        save();
        console.log(JSON.stringify({ completed: report.results.length, total: inputs.length, title: input.title, type: input.type, success: row.success, found: row.found, passed, error: row.error }));
        await sleep(Math.max(0, 6500 - (Date.now() - started)));
    }
    report.debug = await (await fetch(`${base}/debug`)).json();
    report.finishedAt = new Date().toISOString();
    report.publishEligible = inputs.length === 100 && report.results.length === 100 && report.results.every(row => row.success);
    save();
    console.log('FINAL', JSON.stringify(report.summary));
    if (!report.results.every(row => row.success)) process.exitCode = 1;
})().catch(error => { report.fatalError = error.message; save(); console.error(error); process.exitCode = 1; }).finally(() => { child.kill(); log.end(); });
