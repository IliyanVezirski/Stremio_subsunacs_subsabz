const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const fs = require('fs');

const title = process.argv[2] || 'Outlander';
const season = process.argv[3] || '1';

const SUBS_SAB = 'http://subs.sab.bz';
const SUBSUNACS = 'https://subsunacs.net';

function sanitize(q) { return encodeURIComponent(q); }

async function searchSubsSab(title, season) {
    const q = `${title} Season ${season}`;
    const url = `${SUBS_SAB}/index.php?act=search&movie=${sanitize(q)}&select-language=2`;
    console.log('[Subs.sab.bz] Search URL:', url);
    try {
        const resp = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = iconv.decode(Buffer.from(resp.data), 'win1251');
        const $ = cheerio.load(html);
        const matches = [];
        $('a').each((i, el) => {
            const txt = $(el).text().trim();
            const href = $(el).attr('href');
            if (!href) return;
            if (/season\s*0*${season}|season\s*${season}/i.test(txt) || new RegExp(`Season\\s*0*${season}`, 'i').test(txt)) {
                let full = href;
                if (!full.startsWith('http')) full = `${SUBS_SAB}/${full.replace(/^\//, '')}`;
                matches.push({ site: 'subs.sab', text: txt, href: full });
            }
        });
        return matches;
    } catch (e) {
        console.error('[Subs.sab.bz] Search error:', e.message);
        return [];
    }
}

async function searchSubsunacs(title, season) {
    const q = `${title} Season ${season}`;
    const url = `${SUBSUNACS}/index.php?act=search&movie=${sanitize(q)}`;
    console.log('[Subsunacs] Search URL:', url);
    try {
        const resp = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = iconv.decode(Buffer.from(resp.data), 'win1251');
        const $ = cheerio.load(html);
        const matches = [];
        $('a').each((i, el) => {
            const txt = $(el).text().trim();
            const href = $(el).attr('href');
            if (!href) return;
            if (/season\s*0*${season}|season\s*${season}/i.test(txt) || new RegExp(`Season\\s*0*${season}`, 'i').test(txt)) {
                let full = href;
                if (!full.startsWith('http')) full = `${SUBSUNACS}/${full.replace(/^\//, '')}`;
                matches.push({ site: 'subsunacs', text: txt, href: full });
            }
        });
        return matches;
    } catch (e) {
        console.error('[Subsunacs] Search error:', e.message);
        return [];
    }
}

async function fetchAndSave(detail) {
    try {
        const resp = await axios.get(detail.href, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': detail.site === 'subs.sab' ? SUBS_SAB : SUBSUNACS }, timeout: 15000 });
        const html = (detail.site === 'subs.sab') ? iconv.decode(Buffer.from(resp.data), 'win1251') : iconv.decode(Buffer.from(resp.data), 'win1251');
        const file = `tmp_${detail.site}_${Date.now()}.html`;
        fs.writeFileSync(file, html, 'utf8');
        console.log('Saved detail HTML to', file, 'for', detail.href);
        return file;
    } catch (e) {
        console.error('Fetch detail error for', detail.href, e.message);
        return null;
    }
}

(async () => {
    console.log('Searching season packs for', title, 'season', season);
    const sab = await searchSubsSab(title, season);
    const sun = await searchSubsunacs(title, season);
    const all = sab.concat(sun);
    if (all.length === 0) {
        console.log('No explicit season-pack links found in search results. Trying broader scan for "Season" mention...');
        // fallback: scan anchors containing 'Season' regardless of number
        // perform subs.sab full search
        try {
            const resp = await axios.get(`${SUBS_SAB}/index.php?act=search&movie=${sanitize(title)}&select-language=2`, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
            const html = iconv.decode(Buffer.from(resp.data), 'win1251');
            const $ = cheerio.load(html);
            $('a').each((i, el) => {
                const txt = $(el).text().trim();
                const href = $(el).attr('href');
                if (!href) return;
                if (/Season\s*\d+/i.test(txt)) {
                    let full = href;
                    if (!full.startsWith('http')) full = `${SUBS_SAB}/${full.replace(/^\//, '')}`;
                    all.push({ site: 'subs.sab', text: txt, href: full });
                }
            });
        } catch (e) {}
    }

    if (all.length === 0) {
        console.log('No season-pack links found.');
        return;
    }

    console.log('Found', all.length, 'season-pack candidate links:');
    for (const a of all) console.log('-', a.site, a.text, a.href);

    // fetch first candidate detail and save
    const saved = [];
    for (const d of all.slice(0, 4)) {
        const f = await fetchAndSave(d);
        if (f) saved.push(f);
    }

    console.log('Done. Saved files:', saved);
})();
