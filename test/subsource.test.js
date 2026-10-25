const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const source = require('../providers/subsource');

function fixtures(t, imdb = 'tt10919420') {
    const calls = [];
    t.mock.method(axios, 'post', async (url, body) => {
        calls.push(url);
        assert.equal(body.query, 'tt10919420');
        return { data: { results: [{ type: 'tvseries', seasons: [{ season: 1, id: 10 }] }] } };
    });
    t.mock.method(axios, 'get', async url => {
        calls.push(url);
        if (url.endsWith('/movie/10')) return { data: { type: 'tvseries', season: 1, link: '/subtitles/squid-game/season-1' } };
        return { data: { media_type: 'tvseries', movie: { source_data: { link: `https://www.imdb.com/title/${imdb}/` } }, subtitles: [
            { id: 1, language: 'bulgarian', release_info: 'Squid.Game.S01', link: 'squid-game-season-1/bulgarian/1' },
            { id: 2, language: 'english', release_info: 'Squid.Game.S01', link: 'squid-game-season-1/english/2' },
            { id: 3, language: 'bulgarian', release_info: 'Squid.Game.S01E02', link: 'squid-game-season-1/bulgarian/3' },
            { id: 4, language: 'bulgarian', release_info: 'Squid.Game.S01', link: 'squid-game-season-1/bulgarian/4', production_type: 'machine' }
        ] } };
    });
    return calls;
}

test('SubSource validates IMDb, language and episode, preserving a matching season pack', async t => {
    const calls = fixtures(t);
    const results = await source.search('tt10919420', 'series', 1, 1);
    assert.deepEqual(results.map(s => s.id), ['subsource_1']);
    assert.equal(calls.length, 3);
    assert.ok(calls[2].includes('/season-1?language=bulgarian'));
});

test('SubSource rejects a different IMDb title even when text matches', async t => {
    fixtures(t, 'tt0000001');
    assert.deepEqual(await source.search('tt10919420', 'series', 1, 1), []);
});

test('SubSource obtains a fresh public download token and rejects arbitrary URLs', async t => {
    const calls = [];
    t.mock.method(axios, 'get', async url => {
        calls.push(url);
        return url.includes('/download/') ? { data: Buffer.from('PK fixture') } : { data: { subtitle: { language: 'bulgarian', download_token: 'a'.repeat(64) } } };
    });
    assert.equal((await source.download('https://subsource.net/subtitle/squid-game-season-1/bulgarian/1')).toString(), 'PK fixture');
    assert.equal(calls.length, 2);
    for (const url of ['https://subsource.net.evil.example/subtitle/a/bulgarian/1', 'https://subsource.net/subtitle/a/english/1', 'https://subsource.net/subtitle/a/bulgarian/1?url=http://localhost']) {
        await assert.rejects(source.download(url), /Invalid/);
    }
    assert.equal(calls.length, 2);
});
