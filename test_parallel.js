const openSubtitles = require('./providers/opensubtitles');
const subsSab = require('./providers/subssab');
const subsland = require('./providers/subsland');

async function test() {
    console.log('Starting parallel search...');
    
    const [openSubtitlesSubs, subsSabSubs, subslandSubs] = await Promise.all([
        openSubtitles.search('tt1375666', 'movie').catch(err => {
            console.error('[OpenSubtitles Error]', err.message);
            return [];
        }),
        subsSab.search('tt1375666', 'movie').catch(err => {
            console.error('[Subs.sab.bz Error]', err.message);
            return [];
        }),
        subsland.search('tt1375666', 'movie').catch(err => {
            console.error('[SubsLand Error]', err.message);
            return [];
        })
    ]);

    const rawSubtitles = [...openSubtitlesSubs, ...subsSabSubs, ...subslandSubs];
    console.log('Total:', rawSubtitles.length, 'subtitles');
    console.log('OpenSubtitles:', openSubtitlesSubs.length);
    console.log('SubsSab:', subsSabSubs.length);
    console.log('SubsLand:', subslandSubs.length);
}

test().catch(e => console.error('Test error:', e));
