const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

(async () => {
  try {
    const BASE_URL = 'http://subs.sab.bz';
    const searchQuery = 'The Return';
    const url = `${BASE_URL}/index.php?act=search&movie=${encodeURIComponent(searchQuery)}&select-language=2`;
    console.log('Requesting:', url);
    const resp = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' }});
    const html = iconv.decode(Buffer.from(resp.data), 'win1251');
    const $ = cheerio.load(html);

    // Print potential pagination links
    const pagLinks = [];
    $('a').each((i, el) => {
      const txt = $(el).text().trim();
      const href = $(el).attr('href');
      if (txt && href) {
        // collect links where text looks numeric or 'Next'/'Prev' or contains 'page'
        if (/^\d+$/.test(txt) || /next|prev|след|следна|следваща/i.test(txt) || /page|page=/i.test(href)) {
          pagLinks.push({ txt, href });
        }
      }
    });

    console.log('Found pagination-like links count:', pagLinks.length);
    pagLinks.forEach(p => console.log(p.txt, p.href));

    // Also print nearby container HTML for pagination
    const possibleContainers = [];
    // common selectors
    ['.pagination', '.pages', '#pages', '.nav', '.pagenav', 'td[align="center"]', 'center'].forEach(sel => {
      $(sel).each((i, el) => {
        possibleContainers.push({ sel, html: $(el).html().substring(0, 500) });
      });
    });

    console.log('Possible pagination containers found:', possibleContainers.length);
    possibleContainers.forEach(c => {
      console.log('---', c.sel, '---\n', c.html.replace(/\n/g, ' '));
    });

    // Save full HTML snippet near bottom for manual inspection
    const bottom = $('body').html().slice(-2000);
    console.log('--- bottom of body (last 2000 chars) ---\n', bottom);
  } catch (e) {
    console.error(e.message);
  }
})();