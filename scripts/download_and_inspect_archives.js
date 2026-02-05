#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const unzipper = require('unzipper');
const { extractor } = require('node-unrar-js');

const WORKDIR = process.cwd();
const SAVED = fs.readdirSync(WORKDIR).filter(f => f.startsWith('tmp_subs.sab_') && f.endsWith('.html'));
if (SAVED.length === 0) {
  console.error('No tmp_subs.sab_*.html files found in', WORKDIR);
  process.exit(1);
}

function collectAttachLinksFromHtml(file) {
  const buf = fs.readFileSync(file);
  let text = '';
  try { text = iconv.decode(buf, 'utf8'); if (!text || text.trim().length === 0) throw new Error('empty'); }
  catch (e) { try { text = iconv.decode(buf, 'win1251'); } catch (e2) { text = buf.toString('binary'); } }
  const $ = cheerio.load(text);
  const links = [];
  $('a').each((i, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!href) return;
    if (/attach_id=\d+/i.test(href) || /act=download/i.test(href) || /attach_id/i.test(href) || /download/i.test(href)) {
      links.push(href);
    }
  });
  // also search raw text for attach_id
  const raw = text;
  const re = /attach_id=(\d+)/gi;
  let m;
  while ((m = re.exec(raw))) {
    links.push(`http://subs.sab.bz/index.php?act=download&attach_id=${m[1]}`);
  }
  return Array.from(new Set(links));
}

function normalizeUrl(href) {
  if (href.startsWith('//')) return 'http:' + href;
  if (/^https?:\/\//i.test(href)) return href;
  // try relative to subs.sab.bz
  if (href.startsWith('/')) return 'http://subs.sab.bz' + href;
  return href;
}

async function downloadUrl(url, outDir) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', maxContentLength: 200 * 1024 * 1024 });
  const buf = Buffer.from(resp.data);
  // pick a filename
  const urlObj = new URL(url, 'http://subs.sab.bz');
  const params = urlObj.searchParams;
  let name = urlObj.pathname.split('/').pop() || 'attachment';
  if (params.has('attach_id')) name = `attach_${params.get('attach_id')}` + path.extname(name);
  if (!path.extname(name)) {
    // sniff
    if (buf.slice(0,4).toString('hex') === '504b0304') name = name + '.zip';
    if (buf.slice(0,7).toString('ascii').startsWith('Rar!')) name = name + '.rar';
  }
  const outPath = path.join(outDir, name);
  fs.writeFileSync(outPath, buf);
  return outPath;
}

async function inspectArchive(filePath) {
  const sig = fs.readFileSync(filePath, { length: 8 });
  const header = sig.slice(0,4).toString('hex');
  console.log('Inspecting', path.basename(filePath));
  if (header === '504b0304') {
    console.log(' - Detected ZIP');
    const entries = [];
    await new Promise((res, rej) => {
      fs.createReadStream(filePath)
        .pipe(unzipper.Parse())
        .on('entry', e => { entries.push(e.path); e.autodrain(); })
        .on('close', () => res())
        .on('error', rej);
    });
    console.log(' - ZIP entries:');
    entries.slice(0,100).forEach(e => console.log('   ', e));
  } else if (fs.readFileSync(filePath, {encoding:'binary', length:7}).startsWith('Rar!')) {
    console.log(' - Detected RAR');
    const buf = fs.readFileSync(filePath);
    const extractorInstance = extractor({ file: buf });
    try {
      const list = extractorInstance.getFileList();
      if (Array.isArray(list)) {
        console.log(' - RAR entries:');
        list.forEach(i => console.log('   ', i.name));
      } else {
        console.log(' - RAR list result:', list);
      }
    } catch (e) {
      console.error(' - RAR inspect error', e.message);
    }
  } else {
    console.log(' - Unknown archive type; saved file size', fs.statSync(filePath).size);
  }
}

async function main() {
  const outDir = path.join(WORKDIR, 'tmp', 'downloads');
  fs.mkdirSync(outDir, { recursive: true });
  const allLinks = [];
  for (const f of SAVED) {
    const file = path.join(WORKDIR, f);
    const links = collectAttachLinksFromHtml(file);
    console.log(`Found ${links.length} candidate links in ${f}`);
    links.forEach(l => allLinks.push(normalizeUrl(l)));
  }
  const unique = Array.from(new Set(allLinks));
  if (unique.length === 0) { console.log('No attach/download links discovered.'); return; }
  console.log('Unique download links:', unique.length);
  for (const u of unique) {
    console.log('Downloading:', u);
    try {
      const saved = await downloadUrl(u, outDir);
      console.log('Saved to', saved);
      await inspectArchive(saved);
    } catch (e) {
      console.error('Failed to download/inspect', u, e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
