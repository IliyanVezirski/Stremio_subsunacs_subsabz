const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { crc32 } = require('adm-zip/util');
const { extractSubtitle, normalizeSubtitle } = require('../lib/archive');
const { matchesEpisode, matchesSeasonPack } = require('../lib/episodes');
const content = '1\n00:00:01,000 --> 00:00:03,000\nТестов субтитър.\n';
function zip(entries) {
    const file = new AdmZip();
    for (const [name, data] of Object.entries(entries)) file.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return file.toBuffer();
}
function rar(name, text) {
    const data = Buffer.from(text), filename = Buffer.from(name);
    const main = Buffer.alloc(13); main[2] = 0x73; main.writeUInt16LE(13, 5); main.writeUInt16LE(crc32(main.subarray(2)) & 0xFFFF);
    const file = Buffer.alloc(32 + filename.length); file[2] = 0x74; file.writeUInt16LE(0x8000, 3); file.writeUInt16LE(file.length, 5);
    file.writeUInt32LE(data.length, 7); file.writeUInt32LE(data.length, 11); file[15] = 2; file.writeUInt32LE(crc32(data) >>> 0, 16);
    file[24] = 20; file[25] = 0x30; file.writeUInt16LE(filename.length, 26); file.writeUInt32LE(32, 28); filename.copy(file, 32);
    file.writeUInt16LE(crc32(file.subarray(2)) & 0xFFFF);
    const end = Buffer.from([0, 0, 0x7b, 0, 0, 7, 0]); end.writeUInt16LE(crc32(end.subarray(2)) & 0xFFFF);
    return Buffer.concat([Buffer.from('526172211a0700', 'hex'), main, file, data, end]);
}
test('season packs, nested archives and alternate numbering pick the requested episode', async () => {
    const data = zip({ 'Show.S02.zip': zip({ '01.srt': content.replace('Тестов', 'Грешен') }), 'Show.S01.zip': zip({ 'Show.101.srt': content, 'Show.110.srt': content.replace('Тестов', 'Грешен') }) });
    const result = await extractSubtitle(data, { season: '1', episode: '1' });
    assert.equal(result.content, content);
    assert.equal(result.fileName, 'Show.S01.zip/Show.101.srt');
    assert.equal(result.episodeMatched, true);
});
test('RAR extraction works concurrently without sharing the wrong archive', async () => {
    const first = rar('Show.S01E01.srt', content);
    const second = rar('Show.S01E02.srt', content.replace('Тестов', 'Втори'));
    const results = await Promise.all([extractSubtitle(first, { season: 1, episode: 1 }), extractSubtitle(second, { season: 1, episode: 2 })]);
    assert.equal(results[0].content, content);
    assert.equal(results[1].content, content.replace('Тестов', 'Втори'));
});
test('MicroDVD is converted with declared or supplied FPS; unknown FPS is not guessed', () => {
    const text = Buffer.from('{1}{1}25\n{25}{75}Здравей|свят\n');
    assert.match(normalizeSubtitle(text), /00:00:01,000 --> 00:00:03,000/);
    assert.match(normalizeSubtitle(Buffer.from('{25}{75}Здравей\n'), 25), /00:00:01,000/);
    assert.throws(() => normalizeSubtitle(Buffer.from('{25}{75}Здравей\n')), /FPS/);
});

test('MicroDVD reads explicit FPS from the archive UTF-16 information file', async () => {
    const info = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Кадри/сек : 25 FPS', 'utf16le')]);
    const data = zip({ 'NCIS.S01E01.sub': '{25}{75}Тестов субтитър\n', 'subsunacs.net_49972.txt': info });
    const result = await extractSubtitle(data, { season: 1, episode: 1 });
    assert.match(result.content, /00:00:01,000 --> 00:00:03,000/);
    assert.equal(result.episodeMatched, true);
});

test('MicroDVD rejects conflicting FPS metadata and metadata from another folder', async () => {
    for (const entries of [
        { 'Show.S01E01.sub': '{25}{75}Тест\n', 'README.txt': 'FPS: 25\nFPS: 23.976' },
        { 'Season1/Show.S01E01.sub': '{25}{75}Тест\n', 'Season2/README.txt': 'FPS: 25' }
    ]) await assert.rejects(extractSubtitle(zip(entries), { season: 1, episode: 1 }), { code: 'SUBTITLE_FPS_REQUIRED' });
});
test('ASS, VTT and text subtitles are recognized by their contents', async () => {
    assert.match(normalizeSubtitle(Buffer.from('[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Здравей\\Nсвят')), /Здравей\nсвят/);
    assert.match(normalizeSubtitle(Buffer.from('WEBVTT\n\n00:01.000 --> 00:03.000\nЗдравей\n')), /00:00:01,000/);
    assert.equal((await extractSubtitle(zip({ 'README.txt': 'No captions', 'movie.txt': content }))).content, content);
});
test('multipart CD release requires matching stream part', async () => {
    const data = zip({ 'Movie.CD2.srt': content.replace('Тестов', 'Втори'), 'Movie.CD1.srt': content });
    assert.equal(await extractSubtitle(data), null);
    assert.equal((await extractSubtitle(data, { filename: 'Movie.CD1.avi' })).content, content);
    const underscores = zip({ 'Movie_CD2.srt': content.replace('Тестов', 'Втори'), 'Movie_CD1.srt': content });
    assert.equal(await extractSubtitle(underscores), null);
    assert.equal((await extractSubtitle(underscores, { filename: 'Movie_CD1.avi' })).content, content);
});
test('episode ranges and multiple-season packs are matched without prefix errors', () => {
    assert.equal(matchesEpisode('Show.S01E01-E03', 1, 2), true);
    assert.equal(matchesEpisode('Show.1x01-02', 1, 2), true);
    assert.equal(matchesEpisode('Show.S01E01E02', 1, 2), true);
    assert.equal(matchesEpisode('Show.S01E10', 1, 1), false);
    assert.equal(matchesSeasonPack('Show Season 1-4', 3), true);
});
test('oversized ZIP entries are refused before decompression', async () => {
    const data = zip({ 'large.srt': 'x'.repeat(2 * 1024 * 1024 + 1) });
    await assert.rejects(extractSubtitle(data), /size limit/);
});
