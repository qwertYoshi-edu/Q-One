export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

export function normalizeSinglePart(str) {
    if (typeof str !== 'string') return '';
    let s = str.trim().replace(/\.\.\./g, '…');
    s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[。、.,!！?？\-ー_]/g, '');
    s = s.replace(/\s+/g, '');
    return s.toLowerCase();
}

export function normalizeAnswer(str) {
    if (typeof str !== 'string') return '';
    const s = str.trim();
    if (s.includes('、') || s.includes(',')) {
        return s.split(/[、,]/).map(part => normalizeSinglePart(part)).filter(Boolean).sort().join('');
    }
    return normalizeSinglePart(s);
}
