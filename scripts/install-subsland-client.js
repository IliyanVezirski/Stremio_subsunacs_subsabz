const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const axios = require('axios');
const { version, platform, directory, binary } = require('../lib/curl-binary');

async function main() {
    if (!platform) { console.warn('[SubsLand] Native HTTP client unavailable on this platform; using axios'); return; }
    const filename = `curl-impersonate-v${version}.${platform.target}.tar.gz`;
    const url = `https://github.com/lexiforest/curl-impersonate/releases/download/v${version}/${filename}`;
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 20 * 1024 * 1024 });
    if (createHash('sha256').update(response.data).digest('hex') !== platform.sha256) throw new Error('SubsLand HTTP client archive checksum mismatch');
    await fs.mkdir(directory, { recursive: true });
    const archive = path.join(directory, 'download.tar.gz');
    try {
        await fs.writeFile(archive, response.data);
        // Extract exactly the verified executable; no paths supplied by a website or user.
        execFileSync('tar', ['-xzf', archive, '-C', directory, platform.member], { timeout: 10000, windowsHide: true });
        if (process.platform !== 'win32') await fs.chmod(binary, 0o755);
        const output = execFileSync(binary, ['--disable', '--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
        if (!output.includes('curl')) throw new Error('SubsLand HTTP client did not start');
        console.log(`[SubsLand] Installed verified curl-impersonate ${version} (${platform.target})`);
    } finally { await fs.unlink(archive).catch(() => {}); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
