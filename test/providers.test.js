const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const iconv = require('iconv-lite');
const subsSab = require('../providers/subssab');
const subsland = require('../providers/subsland');

test('Subs.sab.bz follows newly discovered pages and retains season packs without downloading them', async t => {
    const visited = [];
    const fixture = async url => {
        if (url.includes('cinemeta')) return { data: { meta: { name: 'Test Show', year: '2008' } } };
        if (url.includes('themoviedb')) return { data: { tv_results: [{ name: 'Test Show', first_air_date: '2008' }] } };
        assert.ok(!url.includes('act=download'), 'search must not download archives');
        const offset = Number(new URL(url).searchParams.get('st'));
        visited.push(offset);
        const unrelated = '<table><tr><td><a href="index.php?act=download&attach_id=999" onmouseout="hideddrivetip()">Test Show - Season 2</a></td></tr></table>';
        const html = offset === 0 ? unrelated + '<a href="?act=search&st=25">2</a>' : offset === 25 ? unrelated + '<a href="?act=search&st=50">3</a>' : '<table><tr><td><a href="index.php?act=download&attach_id=123" onmouseout="hideddrivetip()">Test Show - Season 1</a></td></tr></table>';
        return { data: iconv.encode(html, 'win1251') };
    };
    t.mock.method(axios, 'get', fixture);
    t.mock.method(subsSab.client, 'get', fixture);
    const results = await subsSab.search('tt1234567', 'series', '1', '1');
    assert.deepEqual(visited, [0, 25, 50]);
    assert.equal(results[0].id, 'subssab_123');
    assert.equal(results[0].name, 'Test Show - Season 1');
});

test('Subs.sab.bz stops empty pagination and falls back from IMDb to the title', async t => {
    const requests = [];
    t.mock.method(axios, 'get', async () => ({ data: { meta: { name: 'Squid Game', year: '2021' } } }));
    t.mock.method(subsSab.client, 'get', async url => {
        requests.push(url);
        const html = new URL(url).searchParams.has('imdb')
            ? '<a href="?act=search&imdb=tt10919420&st=25">Next</a>'
            : '<table><tr><td class="c2field"><a href="?act=download&attach_id=5">Squid Game - Season 1</a></td></tr></table>';
        return { data: iconv.encode(html, 'win1251') };
    });
    const results = await subsSab.search('tt10919420', 'series', '1', '1');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(url => !new URL(url).searchParams.has('st')));
    assert.equal(results[0].id, 'subssab_5');
});

test('SubsLand searches and downloads directly, with Windows-1251 HTML', async t => {
    const visited = [];
    t.mock.method(axios, 'get', async url => {
        visited.push(url);
        if (url.includes('imdb.com')) throw new Error('No IMDb in fixture');
        if (url.includes('cinemeta')) return { data: { meta: { name: 'Test Show', year: '2008' } } };
        assert.equal(new URL(url).hostname, 'subsland.com');
        if (url.includes('/downloadsubtitles/')) return { data: Buffer.from('PK fixture') };
        return { data: iconv.encode('<p>Търсенето на субтитри приключи</p><table><tr><td><a href="https://subsland.com/subtitles/test-123.html">Test.Show.S01E01</a><a href="https://subsland.com/downloadsubtitles/test.zip">Свали</a></td></tr></table>', 'win1251') };
    });
    const results = await subsland.search('tt1234567', 'series', '1', '1');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Test.Show.S01E01');
    assert.equal((await subsland.download(results[0].url)).toString(), 'PK fixture');
    assert.ok(visited.every(url => !url.includes('jina.ai') && !url.includes('codetabs')));
});

test('SubsLand follows HTML-escaped pagination to older seasons and rejects comment-page links', async t => {
    const pages = [];
    t.mock.method(axios, 'get', async url => {
        if (url.includes('cinemeta')) return { data: { meta: { name: 'Silo', year: '2023' } } };
        const page = Number(new URL(url).searchParams.get('page'));
        pages.push(page);
        const html = page === 0
            ? '<a href="index.php?s=Silo&amp;w=name&amp;category=1&amp;page=1">Next</a><a href="/subtitlescomments/x.html?page=99">Comments</a>'
            : '<table><tr><td><a href="https://subsland.com/subtitles/Silo-123.html">Silo - S01</a><a href="https://subsland.com/downloadsubtitles/silo.zip">Свали</a></td></tr></table>';
        return { data: iconv.encode(html, 'win1251') };
    });
    const results = await subsland.search('tt14688458', 'series', 1, 8);
    assert.deepEqual(pages, [0, 1]);
    assert.equal(results[0].id, 'subsland_123');
});

test('IMDb identity accepts translated series names but still requires the requested season', async t => {
    t.mock.method(axios, 'get', async () => ({ data: { meta: { name: 'English Name', year: '2021' } } }));
    t.mock.method(subsSab.client, 'get', async () => ({ data: iconv.encode('<table>' + [1, 2].map(season =>
        `<tr><td class="c2field"><a href="?act=download&attach_id=${season}">Име - Season ${season}</a><a href="https://imdb.com/title/tt9998887/">IMDb</a></td></tr>`).join('') + '</table>', 'win1251') }));
    const results = await subsSab.search('tt9998887', 'series', 1, 1);
    assert.deepEqual(results.map(row => row.id), ['subssab_1']);
});

test('Grimm must not return The Sisters Grimm', async t => {
    t.mock.method(axios, 'get', async url => {
        if (url.includes('imdb.com')) throw new Error('No IMDb in fixture');
        if (url.includes('cinemeta')) return { data: { meta: { name: 'Grimm', year: '2011' } } };
        return { data: iconv.encode('<table><tr><td><a href="https://subsland.com/subtitles/test-123.html">The Sisters Grimm - S01 (2025)</a><a href="https://subsland.com/downloadsubtitles/test.zip">Свали</a></td></tr></table>', 'win1251') };
    });
    assert.deepEqual(await subsland.search('tt1830617', 'series', '1', '10'), []);
});

test('Subsunacs searches accented colon titles using a short fallback and verifies IMDb identity', async t => {
    const visited = [];
    t.mock.method(axios, 'get', async url => {
        assert.ok(url.includes('cinemeta'));
        return { data: { meta: { name: 'Léon: The Professional', year: '1994' } } };
    });
    t.mock.method(axios, 'post', async (url, body) => {
        const query = new URLSearchParams(body).get('m');
        visited.push(query);
        const html = query === 'Leon' ? '<table><tr><td><a class="tooltip" href="/subtitles/Leon-123/" title="&lt;img src=&quot;/ii/big/000110413.jpg&quot;&gt;">Leon</a><span class="smGray">(1994)</span></td></tr></table>' : '';
        return { data: iconv.encode(html, 'win1251') };
    });
    const results = await require('../providers/subsunacs').search('tt0110413', 'movie');
    assert.deepEqual(visited, ['Leon The Professional', 'Leon']);
    assert.equal(results[0].id, 'subsunacs_123');
});

test('Subs.sab.bz client keeps session cookies for subsequent downloads', async t => {
    const http = require('node:http');
    const server = http.createServer((req, res) => {
        if (req.url === '/search') { res.setHeader('Set-Cookie', 'session_id=test-session; Path=/; HttpOnly'); res.end('search'); }
        else { res.writeHead(req.headers.cookie?.includes('session_id=test-session') ? 200 : 403); res.end('archive'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    await subsSab.client.get(`${base}/search`);
    assert.equal((await subsSab.client.get(`${base}/download`)).data, 'archive');
});
