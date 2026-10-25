const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const binary = require('7zip-bin-full').path7z;
let queue = Promise.resolve();

function run(args, maxBuffer) {
    const task = queue.then(() => new Promise((resolve, reject) => {
        const child = execFile(binary, args, { windowsHide: true, encoding: 'buffer', timeout: 5000, maxBuffer },
            (error, stdout) => error ? reject(new Error('7z extraction failed or exceeded its resource limit')) : resolve(stdout));
        child.stdin.end();
    }));
    queue = task.catch(() => {});
    return task;
}

async function openSevenZip(buffer) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bgsubs-'));
    const archive = path.join(directory, buffer.subarray(0, 3).toString() === 'Rar' ? 'input.rar' : 'input.7z');
    const close = () => fs.rm(directory, { recursive: true, force: true });
    try {
        await fs.writeFile(archive, buffer);
        const listing = (await run(['l', '-slt', '-ba', '-sccUTF-8', '-p-', '--', archive], 512 * 1024)).toString('utf8');
        const entries = listing.trim().split(/\r?\n\r?\n/).map(block => {
            const fields = Object.fromEntries(block.split(/\r?\n/).map(line => {
                const separator = line.indexOf(' = ');
                return [line.slice(0, separator), line.slice(separator + 3)];
            }));
            if (fields.Encrypted === '+') throw new Error('Encrypted archives are unsupported');
            for (const dict of (fields.Method || '').matchAll(/:(\d+)([kmg])?/gi)) {
                const bytes = dict[2] ? Number(dict[1]) * 1024 ** ({ k:1, m:2, g:3 }[dict[2].toLowerCase()]) : 2 ** Number(dict[1]);
                if (bytes > 64 * 1024 * 1024) throw new Error('7z dictionary exceeds memory budget');
            }
            const size = Number(fields.Size);
            if (!Number.isSafeInteger(size) || size < 0 || !fields.Path) throw new Error('Invalid 7z entry');
            return { name: fields.Path, size, isDirectory: fields.Folder === '+' || /^D/.test(fields.Attributes || '') };
        });
        if (entries.length > 2000 || entries.reduce((sum, entry) => sum + entry.size, 0) > 32 * 1024 * 1024) throw new Error('7z archive exceeds expansion budget');
        return {
            entries, close,
            // Read exactly one filename to stdout, never extract archive paths onto disk.
            read: entry => run(['x', '-so', '-spd', '-mmt=1', '-p-', '--', archive, entry.name], 8 * 1024 * 1024)
        };
    } catch (error) { await close(); throw error; }
}
module.exports = { openSevenZip };
