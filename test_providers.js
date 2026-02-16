const subsSab = require('./providers/subssab');
const subsland = require('./providers/subsland');

console.log('Testing subsSab...');
subsSab.search('tt1375666', 'movie').then(r => {
    console.log('subsSab Result:', r.length);
}).catch(e => console.error('subsSab Error:', e.message));

console.log('Testing subsland...');
subsland.search('tt1375666', 'movie').then(r => {
    console.log('subsland Result:', r.length);
}).catch(e => console.error('subsland Error:', e.message));
