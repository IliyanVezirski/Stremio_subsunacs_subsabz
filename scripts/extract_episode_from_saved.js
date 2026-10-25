#!/usr/bin/env node
// Usage: node scripts/extract_episode_from_saved.js ARCHIVE SEASON EPISODE [FPS]
const fs = require('node:fs');
const path = require('node:path');
const { extractSubtitle } = require('../lib/archive');
(async () => {
    const [file, season, episode, fps] = process.argv.slice(2);
    if (!file || !/^\d+$/.test(season || '') || !/^\d+$/.test(episode || '')) throw new Error('Usage: node scripts/extract_episode_from_saved.js ARCHIVE SEASON EPISODE [FPS]');
    if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Archive exceeds size limit');
    const result = await extractSubtitle(fs.readFileSync(file), { season: Number(season), episode: Number(episode), fps: fps && Number(fps) });
    if (!result) throw new Error('No usable matching subtitle');
    const directory = path.resolve('tmp', 'downloads');
    fs.mkdirSync(directory, { recursive: true });
    const output = path.join(directory, `extracted-S${season}-E${episode}.srt`);
    fs.writeFileSync(output, result.content, 'utf8');
    console.log(JSON.stringify({ file: result.fileName, output, episodeMatched: result.episodeMatched }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
