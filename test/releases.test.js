const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseMetadata } = require('../lib/releases');
test('time-based HDTV subtitles outrank unknown-FPS SUB and multipart DVD releases', () => {
    const hd = releaseMetadata('Формат: SRT Дата: 2006 Инфо: Пригодени за HDTV 23,976 FPS.');
    const sub = releaseMetadata('Формат: SUB Дата: 2010 Инфо: DVDRipped');
    const discs = releaseMetadata('Формат: SRT Дата: 2007 Инфо: DVDRip на 2 диска');
    assert.equal(hd.fps, 23.976);
    assert.ok(hd.quality > sub.quality);
    assert.ok(hd.quality > discs.quality);
});
test('FPS is accepted only when explicitly labeled and unambiguous', () => {
    assert.equal(releaseMetadata('Размер 25 MB, 1080p, 2001').fps, undefined);
    assert.equal(releaseMetadata('FPS: 25.000').fps, 25);
    assert.equal(releaseMetadata('Original 25 FPS, another version 23.976 FPS').fps, undefined);
});
