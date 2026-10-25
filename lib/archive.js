const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const { isUtf8 } = require('node:buffer');
const { episodeReferences, matchesEpisode } = require('./episodes');
const { openSevenZip } = require('./sevenzip');
const { releaseMetadata } = require('./releases');
const MAX_FILE = 2 * 1024 * 1024;
const MAX_ARCHIVE = 20 * 1024 * 1024;
const EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa', 'sub', 'txt'];
const nameOf = f => f.path || f.name || f.entryName || '';
const extension = name => name.split('.').pop().toLowerCase();

function decodeSubtitleBuffer(buffer) {
    const encoding = buffer[0] === 0xFF && buffer[1] === 0xFE ? 'utf16le' :
        buffer[0] === 0xFE && buffer[1] === 0xFF ? 'utf16be' : isUtf8(buffer) ? 'utf8' : 'win1251';
    return iconv.decode(buffer, encoding);
}
function eligibleFile(file) {
    const name = nameOf(file);
    return !file.isDirectory && !file.flags?.directory && !/(?:^|[\\/])(?:__MACOSX|\.)/.test(name) && EXTENSIONS.includes(extension(name));
}
function findSubtitleForEpisode(files, season, episode, filename = '') {
    let candidates = files.filter(eligibleFile).sort((a, b) => EXTENSIONS.indexOf(extension(nameOf(a))) - EXTENSIONS.indexOf(extension(nameOf(b))));
    if (!candidates.length) return null;
    if (season == null || episode == null) {
        const disc = String(filename).match(/(?:^|[^a-z0-9])cd[ ._-]*(\d+)(?!\d)/i);
        if (disc) return candidates.find(f => new RegExp(`(?:^|[^a-z0-9])cd[ ._-]*0*${Number(disc[1])}(?!\\d)`, 'i').test(nameOf(f))) || null;
        const full = candidates.filter(f => !/(?:^|[^a-z0-9])cd[ ._-]*\d+(?!\d)/i.test(nameOf(f)));
        if (full.length) return full[0];
        // Separate CDs need the corresponding stream part; never silently serve CD2 of a full movie.
        return null;
    }
    const exact = candidates.find(f => matchesEpisode(nameOf(f), season, episode));
    if (exact) return exact;
    candidates = candidates.filter(f => {
        const name = nameOf(f);
        if (episodeReferences(name).length) return false;
        return [...name.matchAll(/\bs(?:eason)?[ ._-]*(\d+)/gi)].every(m => Number(m[1]) === Number(season));
    });
    const e = Number(episode);
    const loose = new RegExp(`(?:^|[ ._-])(?:e(?:p(?:isode)?)?[ ._-]*)?0*${e}(?=[ ._-]|$)`, 'i');
    const found = candidates.find(f => {
        const name = nameOf(f).split(/[\\/]/).pop();
        if (loose.test(name)) return true;
        return [...name.matchAll(/(?:^|[ ._-])(\d{3,4})(?=[ ._-]|$)/g)].some(m => Number(m[1].slice(0, -2)) === Number(season) && Number(m[1].slice(-2)) === e);
    });
    if (found) return found;
    if (candidates.length === 1 && files.filter(eligibleFile).length === 1 &&
        !/(?:\be(?:p(?:isode)?)?[ ._-]*\d+|(?:^|[ ._-])\d{1,3}(?=[ ._-]|$))/i.test(nameOf(candidates[0]))) return candidates[0];
    return null;
}

function timestamp(ms) {
    ms = Math.max(0, Math.round(ms));
    const hours = Math.floor(ms / 3600000), minutes = Math.floor(ms / 60000) % 60, seconds = Math.floor(ms / 1000) % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function normalizeSubtitle(buffer, fps) {
    if (buffer.length > MAX_FILE) throw new Error('Subtitle exceeds 2 MiB limit');
    const text = decodeSubtitleBuffer(buffer);
    if (text.includes('\0') || /<html\b|<!doctype\s+html/i.test(text)) return null;
    if (/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(text)) return text;
    if (/\d{2}:\d{2}(?::\d{2})?\.\d{3}\s*-->/.test(text)) {
        let n = 0;
        const cues = [...text.matchAll(/((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*?)(?=\r?\n\r?\n|$)/g)];
        return cues.map(m => `${++n}\n${(m[1].length === 9 ? '00:' : '') + m[1].replace('.', ',')} --> ${(m[2].length === 9 ? '00:' : '') + m[2].replace('.', ',')}\n${m[3].trim()}\n`).join('\n') || null;
    }
    if (/^Dialogue:/m.test(text)) {
        let n = 0;
        const fields = (text.match(/^Format:\s*(.*Start.*End.*Text.*)$/mi)?.[1] || 'Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text').split(',').map(s => s.trim().toLowerCase());
        return text.split(/\r?\n/).filter(line => line.startsWith('Dialogue:')).map(line => {
            const values = line.slice(9).split(',');
            const time = field => { const parts = values[fields.indexOf(field)]?.trim().split(':').map(Number); return parts?.length === 3 ? timestamp((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000) : null; };
            const start = time('start'), end = time('end');
            if (!start || !end) return '';
            const dialogue = values.slice(fields.indexOf('text')).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
            return `${++n}\n${start} --> ${end}\n${dialogue}\n`;
        }).filter(Boolean).join('\n') || null;
    }
    if (/^\{\d+\}\{\d+\}/m.test(text)) {
        const declared = text.match(/^\{[01]\}\{[01]\}(\d+(?:\.\d+)?)\s*$/m);
        const rate = Number(declared?.[1] || fps);
        if (!(rate >= 10 && rate <= 120)) {
            const error = new Error('MicroDVD .sub requires FPS metadata; select another release');
            error.code = 'SUBTITLE_FPS_REQUIRED';
            throw error;
        }
        let n = 0;
        return [...text.matchAll(/^\{(\d+)\}\{(\d+)\}(.*)$/gm)].filter(m => Number(m[2]) > Number(m[1])).map(m =>
            `${++n}\n${timestamp(Number(m[1]) * 1000 / rate)} --> ${timestamp(Number(m[2]) * 1000 / rate)}\n${m[3].replace(/\{[^}]*\}/g, '').replace(/\|/g, '\n').trim()}\n`).join('\n') || null;
    }
    return null;
}

function archiveType(buffer) {
    if (buffer.subarray(0, 6).toString('hex') === '377abcaf271c') return '7z';
    if (buffer.subarray(0, 2).toString() === 'PK') return 'zip';
    if (buffer.subarray(0, 3).toString() === 'Rar') return 'rar';
    return null;
}
async function extractSubtitle(buffer, options = {}, state = { depth: 0, bytes: 0, attempts: 0 }) {
    if (!buffer?.length) return null;
    if (buffer.length > MAX_ARCHIVE || state.bytes + buffer.length > 32 * 1024 * 1024) throw new Error('Archive exceeds memory budget');
    state.bytes += buffer.length;
    const type = archiveType(buffer);
    if (!type) {
        const content = normalizeSubtitle(buffer, options.fps);
        return content ? { content, fileName: options.fileName || 'subtitle.srt', episodeMatched: false } : null;
    }
    if (state.depth > 2) throw new Error('Nested archive depth exceeded');
    const visited = new Set();
    const zip = type === 'zip' ? new AdmZip(buffer) : null;
    // Native RAR/7z extraction is isolated from Node: decoder failure cannot abort the addon process.
    const seven = type !== 'zip' ? await openSevenZip(buffer) : null;
    const metadataRates = new Map();
    const metadataFps = async fileName => {
        const directory = name => name.replace(/\\/g, '/').split('/').slice(0, -1).join('/').toLowerCase();
        const folder = directory(fileName);
        if (metadataRates.has(folder)) return metadataRates.get(folder);
        const entries = (zip ? zip.getEntries() : seven.entries).filter(entry => {
            const name = nameOf(entry);
            return directory(name) === folder && /^(?:subsunacs\.net_\d+|subs\.unacs\.bg_\d+|readme|info)\.(?:txt|nfo)$/i.test(name.split(/[\\/]/).pop());
        });
        // Reject ambiguous/large metadata sets rather than infer a frame rate.
        if (entries.length > 4) return undefined;
        const texts = [];
        for (const entry of entries) {
            const size = zip ? entry.header.size : entry.size;
            if (size > 64 * 1024 || state.bytes + size > 32 * 1024 * 1024) continue;
            const data = zip ? zip.readFile(entry) : await seven.read(entry);
            state.bytes += data.length;
            texts.push(decodeSubtitleBuffer(data));
        }
        const fps = releaseMetadata(texts.join('\n')).fps;
        metadataRates.set(folder, fps);
        return fps;
    };
    let lastError;
    try {
    while (state.attempts < 12) {
        let nested = false;
        const select = entries => {
            if (entries.length > 2000) throw new Error('Archive has too many entries');
            const remaining = entries.filter(entry => !visited.has(nameOf(entry)));
            const direct = findSubtitleForEpisode(remaining, options.season, options.episode, options.filename);
            if (direct) return direct;
            nested = true;
            return remaining.filter(entry => /\.(zip|rar|7z)$/i.test(nameOf(entry)) && !entry.isDirectory && !entry.flags?.directory &&
                (options.season == null || [...nameOf(entry).matchAll(/\bs(?:eason)?[ ._-]*(\d+)/gi)].every(m => Number(m[1]) === Number(options.season))))
                .find(entry => !episodeReferences(nameOf(entry)).length || matchesEpisode(nameOf(entry), options.season, options.episode));
        };
        let item;
        if (zip) {
            const selected = select(zip.getEntries());
            if (!selected) break;
            if (selected.header.size > (nested ? 8 * 1024 * 1024 : MAX_FILE)) throw new Error('Archive entry exceeds size limit');
            item = { name: selected.entryName, buffer: zip.readFile(selected) };
        } else if (seven) {
            const selected = select(seven.entries);
            if (!selected) break;
            if (selected.size > (nested ? 8 * 1024 * 1024 : MAX_FILE)) throw new Error('Archive entry exceeds size limit');
            item = { name: selected.name, buffer: await seven.read(selected) };
        }
        if (!item) break;
        visited.add(item.name);
        state.attempts++;
        try {
            if (nested) {
                const child = { ...state, depth: state.depth + 1 };
                const result = await extractSubtitle(item.buffer, options, child);
                state.bytes = child.bytes; state.attempts = child.attempts;
                if (result) return { ...result, fileName: `${item.name}/${result.fileName}`, episodeMatched: result.episodeMatched || matchesEpisode(item.name, options.season, options.episode) };
            } else {
                let content;
                try { content = normalizeSubtitle(item.buffer, options.fps); }
                catch (error) {
                    if (error.code !== 'SUBTITLE_FPS_REQUIRED') throw error;
                    content = normalizeSubtitle(item.buffer, await metadataFps(item.name));
                }
                if (content) return { content, fileName: item.name, episodeMatched: matchesEpisode(item.name, options.season, options.episode) || Boolean(options.season != null && options.episode != null && /(?:^|[ ._/-])(?:e(?:p(?:isode)?)?[ ._-]*)?\d{1,4}(?=[ ._/-]|$)/i.test(item.name) && findSubtitleForEpisode([{ name: item.name }], options.season, options.episode)) };
            }
        } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    console.warn('[Archive] No usable match (unsupported format, separate CD parts, or missing episode)');
    return null;
    } finally { if (seven) await seven.close(); }
}

// Compatibility for scripts/tests that only need the decoded text.
function extractSubtitleFromZip(buffer, season = null, episode = null) {
    const zip = new AdmZip(buffer);
    const file = findSubtitleForEpisode(zip.getEntries(), season, episode);
    if (!file) return null;
    if (file.header.size > MAX_FILE) throw new Error('Subtitle exceeds size limit');
    return normalizeSubtitle(zip.readFile(file));
}
async function extractSubtitleFromRar(buffer, season = null, episode = null) {
    return (await extractSubtitle(buffer, { season, episode }))?.content || null;
}
module.exports = { extractSubtitle, extractSubtitleFromZip, extractSubtitleFromRar, findSubtitleForEpisode, decodeSubtitleBuffer, normalizeSubtitle };
