function releaseMetadata(text) {
    const formats = text.match(/(?:Формат|Format)\s*:\s*([A-Z /,]+?)(?=Дата|Добавени|Date|Info|Инфо|$)/i)?.[1] || '';
    const rates = [...text.matchAll(/(?:\bFPS\s*[:=]?\s*(\d{2}(?:[.,]\d{1,3})?)|(\d{2}(?:[.,]\d{1,3})?)\s*FPS\b)/gi)]
        .map(match => Number((match[1] || match[2]).replace(',', '.'))).filter(rate => rate >= 10 && rate <= 120);
    const unique = [...new Set(rates)];
    const fps = unique.length === 1 ? unique[0] : undefined;
    // Prefer time-based captions and modern full-length releases over unknown-FPS SUB files.
    const timeBased = /\b(?:SRT|ASS|SSA|VTT)\b/i.test(formats);
    const hd = /\b(?:BluRay|BDRip|BRRip|WEB[ .-]?DL|WEBRip|HDTV|720p|1080p|2160p)\b/i.test(text);
    const multipart = /\b[2-9]\s*(?:CD|диск)/i.test(text);
    return { formats: formats.trim(), fps, quality: (timeBased ? 8 : fps ? 2 : 0) + (hd ? 4 : 0) - (multipart && !hd ? 6 : 0) };
}
module.exports = { releaseMetadata };
