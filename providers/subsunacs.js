const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const BASE_URL = 'https://subsunacs.net';
const SEARCH_URL = `${BASE_URL}/search.php`;
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const TMDB_API_KEY = 'b019b78bbd3a80f0f3112369c3b8c243';
const TMDB_URL = 'https://api.themoviedb.org/3';

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
            console.log(`[Filter] Series subtitle "${subName}" doesn't match S${s}E${e} or season pack`);
            return { match: false, score: 0 };
        }
        
        // Season packs get slightly lower score than exact episode matches
        if (isSeasonPack) {
            console.log(`[Filter] "${subName}" is a season pack for S${s}`);
        }
        
        // Check that title words are in subtitle (less strict for series)
        const matchScore = titleWords.filter(word => normalizedSub.includes(word)).length;
        const minMatches = Math.max(1, Math.ceil(titleWords.length * 0.6));
        
        if (matchScore < minMatches) {
            console.log(`[Filter] Series subtitle "${subName}" doesn't match title "${movieTitle}"`);
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
    
    // For short titles (1-2 words), be VERY strict but handle numbered sequels
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
            // Next word should be: year, release term, "aka", or number (for sequels like "Zootopia 2")
            const isYear = /^(19|20)\d{2}$/.test(nextWord);
            const isReleaseTerm = /^(720p|1080p|2160p|4k|bluray|bdrip|brrip|hdrip|webrip|web|dvdrip|hdtv|proper|repack|extended|unrated|directors|x264|x265|h264|h265|aac|dts|ac3|remux|uhd)$/i.test(nextWord);
            const isAka = nextWord === 'aka' || nextWord === 'a';
            const isNumber = /^\d+$/.test(nextWord); // Allow numbers (sequel numbers, part numbers)
            
            if (!isYear && !isReleaseTerm && !isAka && !isNumber) {
                // Next word is probably part of a different movie title
                console.log(`[Filter] "${nextWord}" after "${normalizedTitle}" looks like different movie`);
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
 * Search for subtitles on Subsunacs.net
 * Based on kgkolev/service.subtitles.subsunacs Kodi addon
 */
async function search(imdbId, type, season, episode) {
    try {
        const meta = await getMetadata(imdbId, type);
        if (!meta || !meta.name) {
            console.log('[Subsunacs] Could not get metadata for:', imdbId);
            return [];
        }

        const year = meta.year ? String(meta.year).substring(0, 4) : '';
        const isSeries = type === 'series' && season && episode;
        
        console.log(`[Subsunacs] Searching for: ${meta.name} ${isSeries ? `S${season}E${episode}` : `(${year})`}`);
        
        // Build search query like Kodi addon
        let searchQuery = meta.name;
        if (isSeries) {
            const s = String(season).padStart(2, '0');
            const e = String(episode).padStart(2, '0');
            searchQuery = `${meta.name} ${s}x${e}`;
        }

        // POST search - don't use year for series (might interfere)
        const searchParams = new URLSearchParams({
            m: searchQuery,
            l: '0',
            c: '',
            y: isSeries ? '0' : (year || '0'),  // Don't use year for series
            a: '',
            d: '',
            u: '',
            g: '',
            t: 'Submit'
        });

        const response = await axios.post(SEARCH_URL, searchParams.toString(), {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.6 (KHTML, like Gecko) Chrome/20.0.1092.0 Safari/536.6',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'bg,en;q=0.9'
            },
            timeout: 15000
        });

        const html = iconv.decode(Buffer.from(response.data), 'win1251');
        const $ = cheerio.load(html);
        
        const subtitles = [];
        
        // Parse results and filter by title relevance
        $('a.tooltip').each((index, element) => {
            const $link = $(element);
            const name = $link.text().trim();
            let href = $link.attr('href');
            
            if (!href || !name) return;
            
            // Check if subtitle matches our movie/series
            const matchResult = isSeries 
                ? isGoodMatch(name, meta.name, null, season, episode)
                : isGoodMatch(name, meta.name, year);
            if (!matchResult.match) {
                return; // Skip this subtitle
            }
            
            const matchScore = matchResult.score;
            
            // Make full URL if relative
            if (!href.startsWith('http')) {
                href = `${BASE_URL}/${href}`;
            }
            
            // Get CD count from sibling td
            const $td = $link.closest('td');
            const cdText = $td.next('td').text().trim() || '1';
            
            // Get uploader
            let uploader = '';
            try {
                let $uploaderTd = $td;
                for (let i = 0; i < 5; i++) {
                    $uploaderTd = $uploaderTd.next('td');
                }
                uploader = $uploaderTd.text().trim();
            } catch (e) {}
            
            // Extract subtitle ID from URL
            const idMatch = href.match(/-(\d+)\/?$/) || href.match(/id=(\d+)/);
            const subId = idMatch ? idMatch[1] : index.toString();
            
            subtitles.push({
                id: `subsunacs_${subId}`,
                lang: 'bul',
                url: href,
                score: matchScore // Store score for potential sorting
            });
        });

        // Sort by match score (best matches first)
        subtitles.sort((a, b) => b.score - a.score);
        
        console.log(`[Subsunacs] Found ${subtitles.length} subtitles`);
        return subtitles;
        
    } catch (error) {
        console.error('[Subsunacs] Search error:', error.message);
        return [];
    }
}

/**
 * Download subtitle from details page
 * Returns the archive buffer
 */
async function download(pageUrl) {
    try {
        console.log(`[Subsunacs] Getting download from: ${pageUrl}`);
        
        // First visit the details page to find the download link
        const detailsResponse = await axios.get(pageUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.6 (KHTML, like Gecko) Chrome/20.0.1092.0 Safari/536.6',
                'Referer': BASE_URL
            },
            timeout: 15000
        });
        
        const html = iconv.decode(Buffer.from(detailsResponse.data), 'win1251');
        const $ = cheerio.load(html);
        
        // Find download link - look for links with "get.php" or download icon
        let downloadUrl = null;
        
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('get.php')) {
                downloadUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
                return false;
            }
        });
        
        // Also try to find by class or image
        if (!downloadUrl) {
            $('a[href*="get"], a.download, a[title*="Свали"], a[title*="Download"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href) {
                    downloadUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
                    return false;
                }
            });
        }
        
        // Try extracting ID from URL path (format: /subtitles/name-ID/)
        if (!downloadUrl) {
            const pathMatch = pageUrl.match(/-(\d+)\/?$/);
            if (pathMatch) {
                downloadUrl = `${BASE_URL}/get.php?id=${pathMatch[1]}`;
            }
        }
        
        if (!downloadUrl) {
            console.log('[Subsunacs] No download URL found on page');
            return null;
        }
        
        console.log(`[Subsunacs] Downloading: ${downloadUrl}`);
        
        // Download with Referer header (important!)
        const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/536.6 (KHTML, like Gecko) Chrome/20.0.1092.0 Safari/536.6',
                'Referer': pageUrl
            },
            timeout: 30000
        });
        
        return Buffer.from(response.data);
        
    } catch (error) {
        console.error('[Subsunacs] Download error:', error.message);
        return null;
    }
}

async function getMetadata(imdbId, type) {
    // Try Cinemeta first
    try {
        const metaType = type === 'series' ? 'series' : 'movie';
        const url = `${CINEMETA_URL}/${metaType}/${imdbId}.json`;
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        if (response.data && response.data.meta && response.data.meta.name) {
            console.log(`[Cinemeta] Found: ${response.data.meta.name}`);
            return {
                name: response.data.meta.name,
                year: response.data.meta.year || response.data.meta.releaseInfo
            };
        }
    } catch (error) {
        console.error('[Cinemeta] Error:', error.message);
    }
    
    // Fallback to TMDB
    console.log('[Metadata] Cinemeta failed, trying TMDB...');
    try {
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const url = `${TMDB_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });

        const results = type === 'series' ? response.data.tv_results : response.data.movie_results;
        
        if (results && results.length > 0) {
            const item = results[0];
            const name = item.title || item.name;
            const year = (item.release_date || item.first_air_date || '').substring(0, 4);
            console.log(`[TMDB] Found: ${name} (${year})`);
            return { name, year };
        }
    } catch (error) {
        console.error('[TMDB] Error:', error.message);
    }
    
    console.log('[Metadata] No metadata found for:', imdbId);
    return null;
}

module.exports = { search, download };
