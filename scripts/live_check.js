// Opt-in network smoke test. Downloads at most one result per provider and title.
const fs = require('node:fs');
const { extractSubtitleFromZip, extractSubtitleFromRar, decodeSubtitleBuffer } = require('../index');
const providers = ['subsunacs', 'subssab', 'subsland', 'easternspirit'];
const cases = [
    ['movie', 'tt0133093', null, null], // The Matrix
    ['series', 'tt0903747', '1', '1'], // Breaking Bad
];

(async () => {
    const report = [];
    for (const [type, id, season, episode] of cases) {
        await Promise.all(providers.map(async name => {
            const provider = require(`../providers/${name}`);
            const started = Date.now();
            const row = { provider: name, type, id, season, episode };
            try {
                const results = await provider.search(id, type, season, episode);
                row.searchMs = Date.now() - started;
                row.count = results.length;
                row.results = results;
                if (results.length) {
                    const buffer = await provider.download(results[0].url);
                    row.bytes = buffer?.length || 0;
                    let content;
                    if (buffer?.subarray(0, 2).toString() === 'PK') {
                        row.format = 'zip';
                        content = extractSubtitleFromZip(buffer, season, episode);
                    } else if (buffer?.subarray(0, 3).toString() === 'Rar') {
                        row.format = 'rar';
                        content = await extractSubtitleFromRar(buffer, season, episode);
                    } else if (buffer) {
                        row.format = 'text';
                        content = decodeSubtitleBuffer(buffer);
                    }
                    row.validSubtitle = Boolean(content && (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(content) || /^Dialogue:/m.test(content)));
                    row.hasCyrillic = /[А-Яа-я]/.test(content || '');
                    row.sample = content?.slice(0, 160);
                }
            } catch (error) { row.error = error.message; }
            row.totalMs = Date.now() - started;
            report.push(row);
            console.log('[CHECK]', JSON.stringify({ ...row, results: undefined, sample: undefined }));
        }));
    }
    fs.mkdirSync('tmp', { recursive: true });
    fs.writeFileSync('tmp/live-check.json', JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
