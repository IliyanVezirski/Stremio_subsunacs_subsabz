(async () => {
    const path = require('path');
    const projectRoot = path.resolve(__dirname, '..');
    const subsunacs = require(path.join(projectRoot, 'providers', 'subsunacs'));
    const subsSab = require(path.join(projectRoot, 'providers', 'subssab'));

    const imdbId = process.argv[2] || 'tt19861162'; // pass IMDb id as first arg, default for backward compat
    const seasonArg = process.argv[3] ? parseInt(process.argv[3], 10) : null;
    const episodeArg = process.argv[4] ? parseInt(process.argv[4], 10) : null;

    console.log('Debug search for', imdbId, seasonArg ? `S${seasonArg}` : '', episodeArg ? `E${episodeArg}` : '');

    // Detect media type (movie or series) using subsunacs helper
    let type = 'movie';
    try {
        if (typeof subsunacs.detectMediaType === 'function') {
            const detected = await subsunacs.detectMediaType(imdbId);
            if (detected) type = detected;
            console.log('[Debug] Detected type:', type);
        }
    } catch (e) {
        console.error('[Debug] detectMediaType error:', e && e.message ? e.message : e);
    }

    // Quick check: fetch IMDb-derived metadata if available
    try {
        if (typeof subsunacs.getImdbMetadata === 'function') {
            const imdbMeta = await subsunacs.getImdbMetadata(imdbId);
            console.log('[Debug] IMDb metadata:', imdbMeta);
        }
    } catch (e) {
        console.error('[Debug] getImdbMetadata error:', e && e.message ? e.message : e);
    }

    let s1 = [];
    let s2 = [];
    try {
        console.log('\n--- subsunacs.search ---');
        s1 = await subsunacs.search(imdbId, type);
        console.log('subsunacs returned count =', Array.isArray(s1) ? s1.length : 'non-array', '\n', s1);
    } catch (e) {
        console.error('subsunacs.search threw:', e && e.stack ? e.stack : e);
    }

    try {
        console.log('\n--- subssab.search ---');
        s2 = await subsSab.search(imdbId, type);
        console.log('subssab returned count =', Array.isArray(s2) ? s2.length : 'non-array', '\n', s2);
    } catch (e) {
        console.error('subssab.search threw:', e && e.stack ? e.stack : e);
    }

    // Try calling download on first result from subsunacs (if present) to see proxy download behavior
    try {
        if (Array.isArray(s1) && s1.length > 0) {
            console.log('\n--- subsunacs.download (first result) ---');
            const buf = await subsunacs.download(s1[0].url);
            console.log('Downloaded bytes:', buf ? buf.length : 'null');
        } else {
            console.log('\nNo subsunacs results to attempt download');
        }
    } catch (e) {
        console.error('subsunacs.download threw:', e && e.stack ? e.stack : e);
    }

    // And same for subssab
    try {
        if (Array.isArray(s2) && s2.length > 0) {
            console.log('\n--- subssab.download (first result) ---');
            const buf2 = await subsSab.download(s2[0].url);
            console.log('Downloaded bytes:', buf2 ? buf2.length : 'null');
        } else {
            console.log('\nNo subssab results to attempt download');
        }
    } catch (e) {
        console.error('subssab.download threw:', e && e.stack ? e.stack : e);
    }

    console.log('\nDebug finished');
    process.exit(0);
})();