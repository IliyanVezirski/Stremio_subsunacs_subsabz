#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { extractor } = require('node-unrar-js');
const iconv = require('iconv-lite');

const season = parseInt(process.argv[2] || '1', 10);
const episode = parseInt(process.argv[3] || '1', 10);
const titleArg = process.argv[4] || '';
const yearArg = process.argv[5] || '';
const want = new RegExp(`S0*${season}[^A-Za-z0-9]*E0*${episode}`, 'i');
const files = ['tmp_subs.sab_1770270608152.html','tmp_subs.sab_1770270608778.html','tmp_subs.sab_1770270608900.html'];
const outDir = path.join(process.cwd(), 'tmp', 'downloads');
fs.mkdirSync(outDir, { recursive: true });

async function tryExtractZip(file) {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return false;
  try {
    const directory = await unzipper.Open.file(p);
    for (const entry of directory.files) {
      if (want.test(entry.path)) {
        const outName = `extracted_${path.basename(entry.path)}`;
        const outPath = path.join(outDir, outName);
        await new Promise((res, rej) => {
          entry.stream().pipe(fs.createWriteStream(outPath)).on('finish', res).on('error', rej);
        });
        console.log('Extracted', entry.path, '->', outPath);
        return true;
      }
    }
  } catch (e) {
    // parse failed
  }
  return false;
}

function normalize(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[\u0400-\u04FF]/g, '') // remove Cyrillic for tokens comparison
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenOverlapScore(name, title) {
  if (!title) return 1.0; // no constraint
  const na = normalize(name).split(/\s+/).filter(Boolean);
  const ta = normalize(title).split(/\s+/).filter(Boolean);
  if (ta.length === 0) return 1.0;
  let common = 0;
  for (const t of ta) if (na.includes(t)) common++;
  return common / ta.length;
}

function matchesTitleYear(name) {
  if (yearArg) {
    if (!new RegExp(yearArg).test(name)) return false;
  }
  if (titleArg) {
    const score = tokenOverlapScore(name, titleArg);
    return score >= 0.5; // require at least half title tokens
  }
  return true;
}

(async () => {
  for (const f of files) {
    console.log('Checking', f);
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    // try to locate embedded ZIP/RAR signature inside the saved file
    const zipSig = Buffer.from([0x50,0x4b,0x03,0x04]);
    const rarSig = Buffer.from([0x52,0x61,0x72,0x21]); // 'Rar!'
    const zipOff = buf.indexOf(zipSig);
    const rarOff = buf.indexOf(rarSig);
    if (zipOff >= 0) {
      try {
        const sliceBuf = buf.slice(zipOff);
        // try open from buffer
        const directory = await unzipper.Open.buffer(sliceBuf);
        for (const entry of directory.files) {
          const entryName = entry.path || '';
          if (want.test(entryName) && matchesTitleYear(entryName)) {
            const outName = `extracted_${path.basename(entryName)}`;
            const outPath = path.join(outDir, outName);
            await new Promise((res, rej) => {
              entry.stream().pipe(fs.createWriteStream(outPath)).on('finish', res).on('error', rej);
            });
            console.log('Extracted', entry.path, '->', outPath);
            return process.exit(0);
          }
        }
      } catch (e) {
        console.log('ZIP parse from embedded offset failed, fallback scanning:', e.message);
      }
    }
    if (rarOff >= 0) {
      try {
        const sliceBuf = buf.slice(rarOff);
        // write tmp rar for inspection
        const tmpRar = path.join(outDir, `embedded_${path.basename(p)}.rar`);
        fs.writeFileSync(tmpRar, sliceBuf);
        try {
          const inst = extractor({ file: sliceBuf });
          const list = inst.getFileList();
          if (Array.isArray(list)) {
            for (const item of list) {
              const name = item.name || '';
              if (want.test(name) && matchesTitleYear(name)) {
                // try extracting file
                try {
                  const extracted = inst.extractFiles([name]);
                  if (extracted && extracted.length) {
                    const outPath = path.join(outDir, `extracted_${path.basename(name)}`);
                    fs.writeFileSync(outPath, Buffer.from(extracted[0].fileData));
                    console.log('Extracted', name, '->', outPath);
                    return process.exit(0);
                  }
                } catch (e2) {
                  console.log('RAR extraction failed for', name, e2.message);
                }
              }
            }
          }
        } catch (e) {
          console.log('RAR list/extract failed:', e.message);
        }
      } catch (e) {
        console.log('RAR fallback failed:', e.message);
      }
    }
    // fallback: search binary for filename-like patterns around SxxExx
    const txt = buf.toString('binary');
    const re = new RegExp(`([^\\r\\n]{0,200}S0*${season}[^\\r\\n]*E0*${episode}[^\\r\\n]{0,200}\\.(srt|sub|ass|vtt|txt))`,`i`);
    const m = re.exec(txt);
    if (m) {
      const rawMatch = m[1];
      // try to extract the actual filename (printable) from the matched chunk
      const nameRe = /([A-Za-z0-9_\-\.\(\) \[\]]+\.(srt|sub|ass|vtt|txt))/i;
      const fm = nameRe.exec(rawMatch);
      const filename = fm ? fm[1] : rawMatch.replace(/[^\x20-\x7E]+/g, '_').slice(-120);
      console.log('Found filename inside binary (best-effort):', filename);
      if (matchesTitleYear(filename)) {
        const safe = filename.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_');
        const outPath = path.join(outDir, `saved_${safe}`);
        fs.writeFileSync(outPath, buf);
        console.log('Wrote raw archive to', outPath, '(please inspect manually)');
        return process.exit(0);
      } else {
        console.log('Filename found but failed title/year check:', filename);
      }
    }
  }
  console.log('No matching episode file found in saved archives.');
})();
