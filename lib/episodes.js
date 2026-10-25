// Parse complete numeric tokens: E01 must never match E010 or another season.
function episodeReferences(name) {
    const refs = [];
    const pattern = /(?:s(\d+)[ ._-]*e(\d+)|(?:^|[^\d])(\d+)x(\d+)|season[ ._-]*(\d+)[ ._-]*episode[ ._-]*(\d+))/gi;
    for (const match of String(name).matchAll(pattern)) {
        const season = Number(match[1] ?? match[3] ?? match[5]);
        const episode = Number(match[2] ?? match[4] ?? match[6]);
        refs.push({ season, episode });
        const suffix = String(name).slice(match.index + match[0].length);
        const range = suffix.match(/^\s*-\s*e?(\d+)(?!\d)/i);
        if (range && Number(range[1]) > episode && Number(range[1]) - episode <= 30) {
            for (let next = episode + 1; next <= Number(range[1]); next++) refs.push({ season, episode: next });
        } else {
            const joined = suffix.match(/^(?:e\d+)+/i)?.[0];
            if (joined) for (const extra of joined.matchAll(/e(\d+)/gi)) refs.push({ season, episode: Number(extra[1]) });
        }
    }
    return refs;
}

function matchesEpisode(name, season, episode) {
    return episodeReferences(name).some(ref => ref.season === Number(season) && ref.episode === Number(episode));
}

function matchesSeasonPack(name, season) {
    if (episodeReferences(name).length || /(?:^|[^a-z])e(?:p(?:isode)?)?[ ._-]*\d+/i.test(name)) return false;
    const s = Number(season);
    const range = String(name).match(/\b(?:season|s)[ ._-]*(\d+)\s*-\s*s?(\d+)(?!\d)/i);
    if (range && s >= Number(range[1]) && s <= Number(range[2])) return true;
    return new RegExp(`(?:\\bs(?:eason)?[ ._-]*0*${s}\\b|\\b0*${s}[ ._-]*(?:complete|full|all|season)\\b|(?:complete|full|season)[ ._-]*0*${s}\\b)`, 'i').test(name);
}

function matchIdentifiedSeries(name, season, episode) {
    const exact = matchesEpisode(name, season, episode);
    const pack = matchesSeasonPack(name, season);
    return { match: exact || pack, score: exact ? 30 : pack ? 25 : 0, isSeasonPack: pack };
}
module.exports = { episodeReferences, matchesEpisode, matchesSeasonPack, matchIdentifiedSeries };
