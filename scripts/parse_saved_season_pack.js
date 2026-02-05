#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

const args = process.argv.slice(2);
const season = parseInt(args[0] || '1', 10);
const episode = parseInt(args[1] || '1', 10);

function buildPatterns(s, e) {
  const sP = String(s).padStart(2, '0');
  const eP = String(e).padStart(2, '0');
  return [
    new RegExp(`S\\s*0*${s}\\s*E\\s*0*${e}`, 'i'),
    new RegExp(`\\b${s}x${e}\\b`, 'i'),
    new RegExp(`\\b${sP}x${eP}\\b`, 'i'),
    new RegExp(`\\b${sP}[\\s._-]*${eP}\\b`, 'i'),
    new RegExp(`Season[\\s:-]*${s}[\\D]`, 'i')
  ];
}

const patterns = buildPatterns(season, episode);

function looksLikeEpisode(str) {
  if (!str) return false;
  return patterns.some(r => r.test(str));
}

// discover files: CLI args or files matching tmp_subs.sab_*.html
let files = [];
if (args.length > 2) {
  files = args.slice(2);
} else {
  files = fs.readdirSync(process.cwd()).filter(f => f.startsWith('tmp_subs.sab_') && f.endsWith('.html'));
}

if (files.length === 0) {
  console.log('No tmp_subs.sab_*.html files found in', process.cwd());
  process.exit(0);
}

for (const f of files) {
  const filePath = path.resolve(process.cwd(), f);
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${f}`);
    continue;
  }
  const buf = fs.readFileSync(filePath);
  let text = '';
  try {
    text = iconv.decode(buf, 'utf8');
    if (!text || text.trim().length === 0) throw new Error('empty-utf8');
  } catch (e) {
    try { text = iconv.decode(buf, 'win1251'); } catch (e2) { text = buf.toString('binary'); }
  }

  const $ = cheerio.load(text);
  const anchors = [];
  $('a').each((i, a) => {
    const href = $(a).attr('href') || '';
    const txt = $(a).text().trim();
    const title = $(a).attr('title') || '';
    if (looksLikeEpisode(href) || looksLikeEpisode(txt) || looksLikeEpisode(title)) {
      anchors.push({ href, text: txt || title || href });
    }
  });

  // scan raw text for patterns
  const rawMatches = new Set();
  for (const r of patterns) {
    let m;
    const copy = new RegExp(r.source, r.flags);
    while ((m = copy.exec(text))) {
      rawMatches.add(m[0]);
      copy.lastIndex = (copy.lastIndex || 0) + 1;
    }
  }

  console.log(`\nFile: ${f}`);
  if (anchors.length) {
    console.log('Matched anchors:');
    anchors.forEach(a => console.log(` - ${a.text} -> ${a.href}`));
  } else {
    console.log('No matching anchors found.');
  }

  if (rawMatches.size) {
    console.log('Raw pattern matches in file text:');
    for (const m of rawMatches) console.log(` - ${m}`);
  } else {
    console.log('No raw pattern matches found.');
  }
}

process.exit(0);
