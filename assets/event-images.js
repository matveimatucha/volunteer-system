/**
 * Преобразует ссылки (в т.ч. Google Диск) в URL, пригодный для <img>.
 * Для Диска используется thumbnail API — он стабильнее, чем export=download.
 */
function extractGoogleDriveFileId(url) {
    if (!url || !/google/i.test(url)) return null;

    const patterns = [
        /\/file\/d\/([a-zA-Z0-9_-]+)/,
        /\/d\/([a-zA-Z0-9_-]{10,})(?:\/|$|\?)/,
        /[?&]id=([a-zA-Z0-9_-]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1].length >= 10) return match[1];
    }
    return null;
}

function getDirectImageUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (!trimmed) return '';

    if (/googleusercontent\.com/i.test(trimmed)) {
        return trimmed;
    }

    const fileId = extractGoogleDriveFileId(trimmed);
    if (fileId) {
        return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1920`;
    }

    return trimmed;
}

function escapeHtmlAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;');
}
