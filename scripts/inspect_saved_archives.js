#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { extractor } = require('node-unrar-js');

const files = ['tmp_subs.sab_1770270608152.html','tmp_subs.sab_1770270608778.html','tmp_subs.sab_1770270608900.html'];

async function inspect(file) {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) { console.log('Missing', file); return; }
  const sig = fs.readFileSync(p, { length: 8 });
  const header = sig.slice(0,4).toString('hex');
  console.log('\n===', file, 'size=', fs.statSync(p).size, '===');
  if (header === '504b0304') {
    console.log('Type: ZIP');
    const entries = [];
    try {
      await new Promise((res, rej) => {
        fs.createReadStream(p)
          .pipe(unzipper.Parse())
          .on('entry', e => { entries.push(e.path); e.autodrain(); })
          .on('close', () => res())
          .on('error', rej);
      });
      entries.forEach(e => console.log(' -', e));
    } catch (e) {
      console.log(' - unzip parse failed, will fallback to raw scanning:', e.message);
      // fallback: search for common subtitle filename patterns inside binary
      try {
        const buf = fs.readFileSync(p);
        const txt = buf.toString('binary');
        const re = /([A-Za-z0-9_\.\- ]+\.(srt|sub|ass|vtt|txt))/ig;
        const found = new Set();
        let m;
        while ((m = re.exec(txt))) found.add(m[1]);
        if (found.size) {
          console.log(' - Embedded subtitle filenames:');
          for (const n of found) console.log('   ', n);
        }
      } catch (e2) { }
    }
  } else {
    // try rar
    const header7 = fs.readFileSync(p, {encoding:'binary', length:7});
    if (header7.startsWith('Rar!')) {
      console.log('Type: RAR');
      const buf = fs.readFileSync(p);
      try {
        const inst = extractor({ file: buf });
        const list = inst.getFileList();
        if (Array.isArray(list)) list.forEach(i => console.log(' -', i.name));
        else console.log(' - RAR list result:', list);
      } catch (e) {
        console.error(' - RAR inspect error', e.message);
      }
    } else {
      console.log('Unknown format; header=', header);
      // fallback: search raw for subtitle filenames
      const buf = fs.readFileSync(p);
      const txt = buf.toString('binary');
      const re = /([A-Za-z0-9_\.\- ]+\.(srt|sub|ass|vtt|txt))/ig;
      const found = new Set();
      let m;
      while ((m = re.exec(txt))) found.add(m[1]);
      if (found.size) {
        console.log(' - Embedded subtitle filenames:');
        for (const n of found) console.log('   ', n);
      }
    }
  }
}

(async () => {
  for (const f of files) await inspect(f);
})();
