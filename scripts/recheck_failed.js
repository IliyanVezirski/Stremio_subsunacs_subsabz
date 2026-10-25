// Recheck transient failures once, retaining the original run and every failed attempt.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const cases = require('./validation-cases.json');
const basePath = 'reports/validation-100.json';

(async () => {
    const first = JSON.parse(fs.readFileSync(basePath));
    const codeFiles = ['index.js', 'package.json', 'package-lock.json', 'scripts/validate_100.js', 'scripts/validation-cases.json', ...['lib', 'providers'].flatMap(dir => fs.readdirSync(dir).filter(file => file.endsWith('.js')).sort().map(file => `${dir}/${file}`))];
    const hash = createHash('sha256');
    for (const file of codeFiles) hash.update(file).update(fs.readFileSync(file));
    if (hash.digest('hex') !== first.sourceSha256) throw new Error('Source changed since the full run; run all 100 titles again');
    const expected = new Set([...cases.movies, ...cases.series].map(([id]) => id));
    if (!first.finishedAt || first.expected !== 100 || first.results.length !== 100 ||
        new Set(first.results.map(row => row.id)).size !== 100 || first.results.some(row => !expected.has(row.id))) {
        throw new Error('A completed run of the fixed 100 titles is required');
    }
    const failures = first.results.filter(row => !row.success);
    let retry = null;
    if (failures.length) {
        const cooldownUntil = Math.max(Date.now(), ...Object.values(first.debug?.sources || {}).map(source => source.cooldownUntil || 0));
        const wait = Math.min(15 * 60000, cooldownUntil - Date.now() + 1000);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(__dirname, 'validate_100.js'), ...failures.map(row => row.id)], { stdio: 'inherit', windowsHide: true });
            child.on('error', reject);
            child.on('exit', resolve);
        });
        retry = JSON.parse(fs.readFileSync('reports/validation-recheck.json'));
        if (!retry.finishedAt || retry.sourceSha256 !== first.sourceSha256 || retry.results.length !== failures.length ||
            retry.results.some(row => !failures.some(original => original.id === row.id && original.type === row.type))) {
            throw new Error('Recheck must complete against exactly the same code and failed titles');
        }
    }
    const results = first.results.map(row => retry?.results.find(checked => checked.id === row.id) || row);
    const passed = results.filter(row => row.success).length;
    const final = {
        startedAt: first.startedAt, finishedAt: new Date().toISOString(), sourceSha256: first.sourceSha256,
        baseReport: basePath, firstPassSummary: first.summary, originalFailures: failures,
        recheck: retry, results,
        summary: { completed: results.length, passed, failed: results.length - passed, successPercent: passed },
        publishEligible: results.length === 100 && passed === 100
    };
    fs.writeFileSync('reports/validation-final.json', JSON.stringify(final, null, 2));
    console.log('FINAL WITH RECHECK', JSON.stringify(final.summary), 'first-pass failures:', failures.length);
    if (!final.publishEligible) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
