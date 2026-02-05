function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;

    let prev = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;

    for (let i = 1; i <= al; i++) {
        let cur = [i];
        for (let j = 1; j <= bl; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(
                prev[j] + 1,      // deletion
                cur[j - 1] + 1,    // insertion
                prev[j - 1] + cost // substitution
            );
        }
        prev = cur;
    }
    return prev[bl];
}

function normalizedSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function fuzzyMatch(subName, movieTitle) {
    const a = (subName || '').toLowerCase().replace(/[^a-z0-9\u0400-\u04FF\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    const b = (movieTitle || '').toLowerCase().replace(/[^a-z0-9\u0400-\u04FF\s]/gi, ' ').replace(/\s+/g, ' ').trim();

    if (!b) return { match: false, score: 0, lev: 0, overlap: 0 };

    // Fast contain checks
    if (a.includes(b) || b.includes(a)) return { match: true, score: 1, lev: 1, overlap: 1, reason: 'contains' };

    const lev = normalizedSimilarity(a, b);
    const bTokens = b.split(' ').filter(Boolean);
    const overlap = bTokens.length ? bTokens.filter(w => a.includes(w)).length / bTokens.length : 0;

    const score = lev * 0.6 + overlap * 0.4; // weighted

    return { match: score >= 0.78, score, lev, overlap };
}

module.exports = { levenshtein, normalizedSimilarity, fuzzyMatch };
