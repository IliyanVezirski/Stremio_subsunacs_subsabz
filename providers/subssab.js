const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const BASE_URL = 'http://subs.sab.bz';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';

/**
 * Normalize title for comparison - remove special chars, lowercase
 */
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\u0400-\u04FF\s]/gi, ' ') // Keep letters, numbers, cyrillic
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Check if subtitle matches the movie/series by title and year/season/episode
 */
function isGoodMatch(subName, movieTitle, movieYear, season = null, episode = null) {
    const normalizedSub = normalizeTitle(subName);
    const normalizedTitle = normalizeTitle(movieTitle);
    const titleWords = normalizedTitle.split(/\s+/).filter(w => w.length > 2);
    const subWords = normalizedSub.split(/\s+/);
    
    // For TV series - check season/episode match
    if (season !== null && episode !== null) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        const sNum = parseInt(season);
        const eNum = parseInt(episode);
        
        // Common season/episode patterns
        const sePatterns = [
            new RegExp(`s0*${sNum}e0*${eNum}`, 'i'),          // S03E01, S3E1
            new RegExp(`${sNum}x0*${eNum}`, 'i'),              // 3x01, 03x01  
            new RegExp(`season\\s*0*${sNum}.*episode\\s*0*${eNum}`, 'i'), // Season 3 Episode 1
            new RegExp(`\\b0*${sNum}x0*${eNum}\\b`, 'i'),      // 03x01 with word boundaries
        ];
        
        // Season pack patterns (full season without specific episode)
        const seasonPackPatterns = [
            new RegExp(`s0*${sNum}\\b(?!e)`, 'i'),             // S03 but not S03E
            new RegExp(`\\bseason\\s*0*${sNum}\\b`, 'i'),     // Season 3
            new RegExp(`\\bs0*${sNum}[\\s\\.-]*(complete|full|all)`, 'i'), // S03 Complete
            new RegExp(`(complete|full).*s0*${sNum}\\b`, 'i'), // Complete S03
        ];
        
        const hasSeasonEpisode = sePatterns.some(pattern => pattern.test(subName));
        const isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(subName)) && 
                             !hasSeasonEpisode; // Only if NOT a specific episode
        
        if (!hasSeasonEpisode && !isSeasonPack) {
            console.log(`[Subs.sab.bz Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        // Season packs get slightly lower score than exact episode matches
        if (isSeasonPack) {
            console.log(`[Subs.sab.bz Filter] "${subName}" is a season pack for S${s}`);
        }
        
        // Check that title words are in subtitle (less strict for series)
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            console.log(`[Subs.sab.bz Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
            return { match: false, score: 0 };
        }
        
        // Season packs get lower score (5) than exact episode matches (10)
        return { match: true, score: matchScore + (isSeasonPack ? 5 : 10), isSeasonPack };
    }
    
    // For movies - check year match
    if (movieYear) {
        const yearMatch = subName.match(/(19|20)\d{2}/);
        if (yearMatch && yearMatch[0] !== movieYear) {
            return { match: false, score: 0 };
        }
    }
    
    // For short titles (1-2 words), be VERY strict
    if (titleWords.length <= 2) {
        // Title must be at the beginning
        const startsWithTitle = titleWords.every((word, i) => subWords[i] === word);
        if (!startsWithTitle) {
            return { match: false, score: 0 };
        }
        
        // Check what comes AFTER the title
        const nextWordIndex = titleWords.length;
        if (subWords[nextWordIndex]) {
            const nextWord = subWords[nextWordIndex];
            // Next word should be: year, or release term (720p, bluray, etc), or "aka"
            const isYear = /^(19|20)\d{2}$/.test(nextWord);
            const isReleaseTerm = /^(720p|1080p|2160p|4k|bluray|bdrip|brrip|hdrip|webrip|web|dvdrip|hdtv|proper|repack|extended|unrated|directors|x264|x265|h264|h265|aac|dts|ac3|remux|uhd)$/i.test(nextWord);
            const isAka = nextWord === 'aka' || nextWord === 'a';
            
            if (!isYear && !isReleaseTerm && !isAka) {
                // Next word is probably part of a different movie title
                return { match: false, score: 0 };
            }
        }
    }
    
    // Calculate match score
    const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
    const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.5));
    
    return {
        match: matchScore >= minMatches,
        score: matchScore
    };
}

/**
 * Search for subtitles on Subs.sab.bz
 * Note: This site has some issues with downloads, may not always work
 */
async function search(imdbId, type, season, episode) {
    try {
        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[Subs.sab.bz] Could not get metadata for:', imdbId);
            return [];
        }

        const year = meta.year ? String(meta.year).substring(0, 4) : '';
        const isSeries = type === 'series' && season && episode;
        
        console.log(`[Subs.sab.bz] Searching for: ${meta.name} ${isSeries ? `S${season}E${episode}` : `(${year})`}`);
        
        let searchQuery = meta.name;
        if (isSeries) {
            const s = String(season).padStart(2, '0');
            const e = String(episode).padStart(2, '0');
            searchQuery = `${meta.name} ${s}x${e}`;
        }
        
        const searchUrl = `${BASE_URL}/index.php?act=search&movie=${encodeURIComponent(searchQuery)}&select-language=2`;
        
        const response = await axios.get(searchUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'bg,en;q=0.9',
                'Referer': BASE_URL
            },
            timeout: 15000
        });

        const html = iconv.decode(Buffer.from(response.data), 'win1251');
        const $ = cheerio.load(html);
        
        const subtitles = [];
        
        // Look for subtitle links - they have onMouseover with tooltip containing movie info
        $('a[href*="act=download"][onmouseout="hideddrivetip()"]').each((index, element) => {
            const $link = $(element);
            const name = $link.text().trim();
            let href = $link.attr('href');
            
            if (!href || !name || name.length < 2) return;
            
            // Check if subtitle matches our movie/series
            const matchResult = isSeries 
                ? isGoodMatch(name, meta.name, null, season, episode)
                : isGoodMatch(name, meta.name, year);
            if (!matchResult.match) {
                return; // Skip this subtitle
            }
            
            const matchScore = matchResult.score;
            
            // Extract attach_id from download URL
            const attachMatch = href.match(/attach_id=(\d+)/);
            if (!attachMatch) return;
            
            const attachId = attachMatch[1];
            
            // Try to get uploader from row
            let uploader = '';
            const $row = $link.closest('tr');
            if ($row.length) {
                const $uploaderLink = $row.find('a[href*="showuser"]');
                if ($uploaderLink.length) {
                    uploader = $uploaderLink.text().trim();
                }
            }
            
            // Make full URL
            if (!href.startsWith('http')) {
                href = `${BASE_URL}/${href}`;
            }
            
            subtitles.push({
                id: `subssab_${attachId}`,
                lang: 'bul',
                url: href,
                score: matchScore
            });
        });

        // Sort by match score
        subtitles.sort((a, b) => b.score - a.score);

        console.log(`[Subs.sab.bz] Found ${subtitles.length} subtitles`);
        return subtitles;
        
    } catch (error) {
        console.error('[Subs.sab.bz] Search error:', error.message);
        return [];
    }
}

/**
 * Download subtitle - URL is already a direct download link
 */
async function download(downloadUrl) {
    try {
        console.log(`[Subs.sab.bz] Downloading from: ${downloadUrl}`);
        
        // The URL is already the direct download link with attach_id
        const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': BASE_URL,
                'Accept': '*/*'
            },
            timeout: 30000,
            maxRedirects: 5
        });
        
        console.log(`[Subs.sab.bz] Downloaded ${response.data.byteLength} bytes`);
        return Buffer.from(response.data);
        
    } catch (error) {
        console.error('[Subs.sab.bz] Download error:', error.message);
        return null;
    }
}

async function getMetadata(imdbId, type) {
    try {
        const metaType = type === 'series' ? 'series' : 'movie';
        const url = `${CINEMETA_URL}/${metaType}/${imdbId}.json`;
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        if (response.data && response.data.meta) {
            return {
                name: response.data.meta.name,
                year: response.data.meta.year || response.data.meta.releaseInfo
            };
        }
        return null;
    } catch (error) {
        console.error('[Cinemeta] Error:', error.message);
        return null;
    }
}

module.exports = { search, download };
