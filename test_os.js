const os = require('./providers/opensubtitles');
os.search('tt1375666', 'movie').then(r => {
    console.log('Result:', r.length, 'subtitles');
    if (r.length > 0) console.log('First:', r[0]);
}).catch(e => console.error('Error:', e.message));
