// Run locally and from Render Shell to compare the same public source requests.
const fs = require('node:fs');
const subsland = require('../providers/subsland');
const { extractSubtitle } = require('../lib/archive');
const { getSourceState, withDeadline } = require('../lib/requests');
const { refusalDetails } = require('../lib/source-gate');

async function main() {
    const report = { checkedAt: new Date().toISOString(), environment: process.env.RENDER ? 'render' : 'local', cases: [], success: false };
    try {
        const root = await subsland.client.get('https://subsland.com/', { timeout: 15000, responseType: 'arraybuffer' });
        report.homepageStatus = root.status;
        for (const item of [
            { id: 'tt0133093', title: 'The Matrix', type: 'movie' },
            { id: 'tt0108778', title: 'Friends', type: 'series', season: 1, episode: 1 }
        ]) {
            if (!getSourceState('subsland.com').available) break;
            const row = { ...item, found: 0, attempts: [], success: false };
            report.cases.push(row);
            const results = await withDeadline(() => subsland.search(item.id, item.type, item.season, item.episode), 15000);
            row.found = results.length;
            for (const result of results.slice(0, 3)) {
                if (!getSourceState('subsland.com').available) break;
                try {
                    const buffer = await withDeadline(() => subsland.download(result.url), 30000);
                    const subtitle = await extractSubtitle(buffer, { season: item.season, episode: item.episode, fps: result.fps });
                    const cues = (subtitle?.content.match(/\d{2}:\d{2}:\d{2},\d{3}\s*-->/g) || []).length;
                    const cyrillic = (subtitle?.content.match(/[А-Яа-я]/g) || []).length;
                    const success = cues >= 5 && cyrillic >= 20 && !subtitle.content.includes('\uFFFD');
                    row.attempts.push({ id: result.id, archiveBytes: buffer.length, cues, cyrillic, success });
                    if (success) { row.success = true; break; }
                } catch (error) {
                    row.attempts.push({ id: result.id, error: error.message, ...(error.response ? { refusal: refusalDetails(error.response) } : {}) });
                }
            }
        }
        report.success = report.cases.length === 2 && report.cases.every(row => row.success);
    } catch (error) {
        report.error = error.message;
        if (error.response) { report.status = error.response.status; report.refusal = refusalDetails(error.response); }
    } finally {
        report.source = getSourceState('subsland.com');
        fs.mkdirSync('reports', { recursive: true });
        fs.writeFileSync('reports/subsland-check.json', JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        if (!report.success) process.exitCode = 1;
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
