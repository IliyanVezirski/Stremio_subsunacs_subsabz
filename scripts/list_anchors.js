#!/usr/bin/env node
const fs = require('fs');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const files = ['tmp_subs.sab_1770270608152.html','tmp_subs.sab_1770270608778.html','tmp_subs.sab_1770270608900.html'];

for (const f of files) {
  const p = require('path').resolve(process.cwd(), f);
  if (!fs.existsSync(p)) { console.log('Missing', f); continue; }
  const b = fs.readFileSync(p);
  let t = '';
  try { t = iconv.decode(b, 'utf8'); if (!t.trim()) throw 1; } catch (e) { try { t = iconv.decode(b, 'win1251'); } catch (e2) { t = b.toString('binary'); } }
  const $ = cheerio.load(t);
  console.log('\n===', f, '===');
  console.log('File size:', fs.statSync(p).size);
  console.log('Snippet:', t.slice(0,800).replace(/\n/g,' '));
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    console.log(text || '(no text)', '->', href);
  });
}
