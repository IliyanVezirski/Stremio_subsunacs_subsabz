#!/usr/bin/env node
// Usage: node scripts/inspect_saved_archives.js ARCHIVE [...ARCHIVE]
const fs = require('node:fs');
const AdmZip = require('adm-zip');
const { openSevenZip } = require('../lib/sevenzip');
(async () => {
    const files = process.argv.slice(2);
    if (!files.length) throw new Error('Usage: node scripts/inspect_saved_archives.js ARCHIVE [...ARCHIVE]');
    for (const file of files) {
        if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Archive exceeds size limit');
        const data = fs.readFileSync(file);
        if (data.subarray(0, 2).toString() === 'PK') {
            console.log(JSON.stringify({ file, entries: new AdmZip(data).getEntries().map(entry => ({ name: entry.entryName, size: entry.header.size })) }));
        } else {
            const archive = await openSevenZip(data);
            try { console.log(JSON.stringify({ file, entries: archive.entries })); }
            finally { await archive.close(); }
        }
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
