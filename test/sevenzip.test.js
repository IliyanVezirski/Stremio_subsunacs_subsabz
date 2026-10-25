const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const binary = require('7zip-bin-full').path7z;
const { extractSubtitle } = require('../lib/archive');

test('7z season pack extracts exact episode to memory and rejects a missing episode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgsubs-test-'));
    try {
        const content = '1\n00:00:01,000 --> 00:00:03,000\nЗдравей, свят!\n';
        await fs.writeFile(path.join(dir, 'Show.S01E01.srt'), content);
        await fs.writeFile(path.join(dir, 'Show.S01E10.srt'), content.replace('Здравей', 'Грешно'));
        await exec(binary, ['a', '-t7z', '-mx=1', 'fixture.7z', 'Show.S01E01.srt', 'Show.S01E10.srt'], { cwd: dir, windowsHide: true });
        const buffer = await fs.readFile(path.join(dir, 'fixture.7z'));
        const result = await extractSubtitle(buffer, { season: 1, episode: 1 });
        assert.equal(result.content, content);
        assert.equal(result.episodeMatched, true);
        assert.equal(await extractSubtitle(buffer, { season: 1, episode: 9 }), null);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
