function normalizeTitle(value) {
    return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:the|an|a)\s+/, '');
}
function queryVariants(title) {
    // Apostrophes are meaningful to the sites' search forms (Schindler's List).
    const ascii = String(title).normalize('NFKD').replace(/\p{M}/gu, '');
    const clean = ascii.replace(/[:–—,./\\()[\]"`-]/g, ' ').replace(/\s+/g, ' ').trim();
    const sequel = clean.replace(/\b(?:[Pp]art\s+)?(II|III|IV|VI|VII|VIII|IX|X)\b/g,
        (_, roman) => ({II:2,III:3,IV:4,VI:6,VII:7,VIII:8,IX:9,X:10})[roman]);
    const short = ascii.includes(':') ? ascii.split(':')[0].trim() : '';
    return [...new Set([clean, clean.replace(/^(?:the|an|a)\s+/i, ''), sequel, sequel.replace(/^(?:the|an|a)\s+/i, ''), short.length >= 3 ? short : ''])].filter(Boolean);
}

function canonicalTitle(value) {
    const romans = { ii:2, iii:3, iv:4, vi:6, vii:7, viii:8, ix:9, x:10 };
    return normalizeTitle(value).replace(/\b(?:part\s+)?(ii|iii|iv|vi|vii|viii|ix|x)\b/g, (_, n) => romans[n]).replace(/\bpart\s+(\d+)\b/g, '$1');
}
function yearsMatch(actual, expected) {
    // Festival premiere and theatrical release can fall in adjacent years.
    return !actual || !expected || Math.abs(Number(actual) - Number(expected)) <= 1;
}
function movieMatch(name, title, year) {
    const sub = canonicalTitle(name), target = canonicalTitle(title);
    const suffix = sub === target ? '' : sub.startsWith(target + ' ') ? sub.slice(target.length + 1) : null;
    if (suffix === null) return { match: false, score: 0 };
    const next = suffix.split(' ')[0];
    const release = /^(?:19\d{2}|20\d{2}|720p|1080p|2160p|4k|bluray|blu|bdrip|brrip|hdrip|webrip|web|dvd|dvdrip|hdtv|proper|repack|extended|unrated|directors|dc|x264|x265|h264|h265|aac|dts|ac3|remux|uhd|aka)$/;
    // A sequel number or another title word is not a release suffix.
    if (next && !release.test(next)) return { match: false, score: 0 };
    const namedYear = suffix.match(/\b(?:19|20)\d{2}\b/)?.[0];
    return { match: yearsMatch(namedYear, year), score: target.split(' ').length };
}
function rowMetadata($, row, discOffset = 1) {
    const imdbIds = row.find('a[href*="imdb.com/title/tt"]').map((_, a) => ($(a).attr('href').match(/tt\d+/) || [])[0]).get().filter(Boolean);
    const cells = row.find('td').map((_, td) => $(td).text().trim()).get();
    const fpsIndex = cells.findIndex(value => /^(?:[12]\d|[3-5]\d|60)\.\d{2,3}$/.test(value));
    const fps = fpsIndex >= 0 ? Number(cells[fpsIndex]) : undefined;
    const discsCell = cells[fpsIndex + discOffset] || '';
    const discs = fpsIndex >= 0 && /^\d{1,2}$/.test(discsCell) ? Number(discsCell) : undefined;
    return { imdbIds, fps, discs };
}
module.exports = { normalizeTitle, queryVariants, rowMetadata, movieMatch, yearsMatch };
