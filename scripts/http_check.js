// Real Stremio HTTP flow against an isolated local server (no production changes).
const fs = require('node:fs');
const { fork } = require('node:child_process');
const path = require('node:path');
const port = process.env.TEST_PORT || '18080';
const base = `http://127.0.0.1:${port}`;
const child = fork(path.join(__dirname, '..', 'index.js'), [], {
    env: { ...process.env, PORT: port, BASE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
});
child.stdout.on('data', data => process.stdout.write(data));
child.stderr.on('data', data => process.stderr.write(data));

(async () => {
    const report = [];
    for (let n = 0; ; n++) {
        try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
        if (n === 100 || child.exitCode !== null) throw new Error('Server did not start');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const cases = [
        ['movie', 'tt0133093', 'The Matrix'],
        ['series', 'tt0903747:1:1', 'Breaking Bad S01E01'],
        ['series', 'tt1830617:1:10', 'Grimm S01E10'],
        ['series', 'tt1567432:3:19', 'Teen Wolf S03E19'],
        ['series', 'tt1442437:9:9', 'Modern Family S09E09']
    ];
    for (const [type, id, title] of cases) {
        const started = Date.now();
        const response = await fetch(`${base}/subtitles/${type}/${id}.json`, { signal: AbortSignal.timeout(20000) });
        const { subtitles } = await response.json();
        const row = { title, status: response.status, searchMs: Date.now() - started, count: subtitles?.length, downloads: [] };
        if (!response.ok || !Array.isArray(subtitles)) throw new Error('Invalid subtitle response');
        const seen = new Set();
        for (const sub of subtitles) {
            const url = new URL(sub.url);
            if (url.origin !== base) throw new Error('Proxy points outside local server');
            const source = url.searchParams.get('source');
            if (seen.has(source)) continue;
            if (seen.size && !['tt0133093', 'tt0903747:1:1'].includes(id)) break;
            seen.add(source);
            const file = await fetch(sub.url, { signal: AbortSignal.timeout(40000) });
            const content = await file.text();
            row.downloads.push({ source, name: sub.name, status: file.status, chars: content.length,
                validSubtitle: file.ok && /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(content),
                cyrillic: /[А-Яа-я]/.test(content) });
        }
        report.push(row);
        console.log('[HTTP CHECK]', JSON.stringify(row));
    }
    const debug = await (await fetch(`${base}/debug`)).json();
    console.log('[HTTP DEBUG]', JSON.stringify(debug));
    fs.mkdirSync('tmp', { recursive: true });
    fs.writeFileSync('tmp/http-check.json', JSON.stringify({ report, debug }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => child.kill());
