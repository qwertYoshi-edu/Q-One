// ============================================================================
// 動画QR転送 コアロジックモジュール
// UI（DOM）に依存せず、テキストと動画(MP4)の相互変換のみを担う
// Phase 4: mockup HTML (design-2) 完全準拠のCanvas描画 & メタデータ連携
// ============================================================================

const PROTOCOL_MAGIC = new Uint8Array([0x56, 0x51, 0x52, 0x31]); // VQR1
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 72;
const MAX_DATA_FRAMES = 99;
const ALIGNMENT = 16;

// Q-One用 固定設定
const SETTINGS = {
    version: 40,
    ec: 'H',
    modulePx: 4,
    extraMargin: 6,
    // 生成動画の再生テンポとカメラ読み取りの両立を図る。
    fps: 3,
    bitrateMbps: 4,
    reserve: 1,
    align16: true,
    compress: true,
    limit100: false
};

// mockup HTML準拠のテーマカラーパレット定義（全11色）
export const THEME_PALETTES = {
    red: { accent: '#EF4444', soft: '#FEF2F2', tint: '#FEE2E2' },
    blue: { accent: '#3B82F6', soft: '#EFF6FF', tint: '#DBEAFE' },
    yellow: { accent: '#F59E0B', soft: '#FFFBEB', tint: '#FEF3C7' },
    green: { accent: '#10B981', soft: '#ECFDF5', tint: '#D1FAE5' },
    purple: { accent: '#8B5CF6', soft: '#F5F3FF', tint: '#EDE9FE' },
    orange: { accent: '#F97316', soft: '#FFF7ED', tint: '#FFEDD5' },
    cyan: { accent: '#06B6D4', soft: '#ECFEFF', tint: '#CFFAFE' },
    'light-gray': { accent: '#6B7280', soft: '#F9FAFB', tint: '#E5E7EB' },
    'dark-gray': { accent: '#374151', soft: '#F3F4F6', tint: '#D1D5DB' },
    navy: { accent: '#1E3A8A', soft: '#EFF6FF', tint: '#BFDBFE' },
    'deep-red': { accent: '#991B1B', soft: '#FEF2F2', tint: '#FECACA' }
};

// mockup HTMLのSVGアイコンパス定義
const APP_GLYPH_PATH = "M29.745 4.03c6.61-.463 12.345 4.522 12.807 11.133l1.2 17.148a.75.75 0 0 1-1.24.618L24.964 17.677a.75.75 0 0 1 .44-1.314l4.35-.305a2 2 0 0 1 1.452.486l6.846 5.951-.488-6.983a7 7 0 0 0-7.472-6.494l-15.96 1.116a1 1 0 0 0-.928 1.067l.418 5.985.034.36a7 7 0 0 0 7.437 6.135l7.154-.5a2 2 0 0 1 1.452.485l3.345 2.908a.75.75 0 0 1-.44 1.314l-11.162.78c-6.508.456-12.166-4.367-12.782-10.824l-.026-.309-.628-8.978a3 3 0 0 1 2.784-3.202z";

// ------------------------
// Helper Functions
// ------------------------
function concatBytes(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of arrays) { out.set(a, p); p += a.length; }
    return out;
}
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n >>> 0); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function r16(a, o) { return new DataView(a.buffer, a.byteOffset, a.byteLength).getUint16(o); }
function r32(a, o) { return new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(o); }
function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function bytesToBinaryString(bytes) {
    let out = '';
    const block = 8192;
    for (let i = 0; i < bytes.length; i += block) {
        const sub = bytes.subarray(i, Math.min(bytes.length, i + block));
        out += String.fromCharCode.apply(null, Array.from(sub));
    }
    return out;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 角丸矩形描画ヘルパー
function drawRoundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.arcTo(x + width, y, x + width, y + radius, radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
    ctx.lineTo(x + radius, y + height);
    ctx.arcTo(x, y + height, x, y + height - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
}

// ------------------------
// CRC32 / SHA256 / Deflate
// ------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
async function sha256(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(d);
}
async function compressBytes(bytes) {
    if (!('CompressionStream' in window)) return { bytes, compressed: false };
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(bytes); writer.close();
    const out = await new Response(cs.readable).arrayBuffer();
    const result = new Uint8Array(out);
    return { bytes: result, compressed: result.length < bytes.length };
}
async function decompressBytes(bytes) {
    if (!('DecompressionStream' in window)) throw new Error('ブラウザがDEFLATE展開に非対応です。');
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(bytes); writer.close();
    const out = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(out);
}
function randomTransferId() {
    const x = new Uint8Array(8); crypto.getRandomValues(x); return x;
}

// -------------------------
// メタデータ埋め込み＆抽出ヘルパー
// -------------------------
export function packageWithMetadata(text, meta) {
    const metaHeader = `<!--QONE_META:${JSON.stringify(meta)}-->\n`;
    return metaHeader + text;
}

export function extractMetadataAndText(rawText) {
    const match = rawText.match(/^<!--QONE_META:(.*?)-->\r?\n?/s);
    if (match) {
        try {
            const meta = JSON.parse(match[1]);
            const text = rawText.substring(match[0].length);
            return { meta, text };
        } catch (e) {
            console.warn('[Q-One:Core] メタデータ解析失敗:', e);
        }
    }
    return { meta: null, text: rawText };
}

// -------------------------
// Protocol Packet
// -------------------------
function writePacket({ transferId, seq, total, originalSize, encodedSize, flags, hash, payload }) {
    if (payload.length > 65535) throw new Error('payload too large');
    const h = new Uint8Array(HEADER_SIZE);
    h.set(PROTOCOL_MAGIC, 0); h[4] = PROTOCOL_VERSION; h[5] = flags & 255; h[6] = HEADER_SIZE; h[7] = 0;
    h.set(transferId, 8); h.set(u32(seq), 16); h.set(u32(total), 20);
    h.set(u32(originalSize), 24); h.set(u32(encodedSize), 28); h.set(u16(payload.length), 32);
    h.set(u16(0), 34); h.set(hash, 36); h.set(u32(crc32(payload)), 68);
    return concatBytes(h, payload);
}
function parsePacket(bytes) {
    if (bytes.length < HEADER_SIZE || !equalBytes(bytes.subarray(0, 4), PROTOCOL_MAGIC)) return null;
    if (bytes[4] !== PROTOCOL_VERSION || bytes[6] !== HEADER_SIZE) return null;
    const seq = r32(bytes, 16), total = r32(bytes, 20), originalSize = r32(bytes, 24), encodedSize = r32(bytes, 28), len = r16(bytes, 32);
    if (total < 1 || seq >= total || HEADER_SIZE + len > bytes.length) return null;
    const payload = bytes.slice(HEADER_SIZE, HEADER_SIZE + len);
    const crc = r32(bytes, 68);
    if (crc32(payload) !== crc) return null;
    return { flags: bytes[5], transferId: bytes.slice(8, 16), seq, total, originalSize, encodedSize, payload, hash: bytes.slice(36, 68), crc };
}

// 動画・カメラの両入力で共用するパケット蓄積・復元処理。
export function createPacketCollector() {
    const chunks = new Map();
    let transferId = null;
    let total = null;
    let originalSize = null;
    let encodedSize = null;
    let flags = null;
    let expectedHash = null;

    function add(binaryData) {
        const packet = parsePacket(binaryData instanceof Uint8Array ? binaryData : Uint8Array.from(binaryData || []));
        if (!packet) return { accepted: false, added: false, received: chunks.size, total, complete: false };

        if (!transferId) {
            transferId = packet.transferId.slice();
            total = packet.total;
            originalSize = packet.originalSize;
            encodedSize = packet.encodedSize;
            flags = packet.flags;
            expectedHash = packet.hash.slice();
        }

        const sameTransfer = equalBytes(transferId, packet.transferId) &&
            packet.total === total &&
            packet.originalSize === originalSize &&
            packet.encodedSize === encodedSize &&
            packet.flags === flags &&
            equalBytes(packet.hash, expectedHash);
        if (!sameTransfer) return { accepted: false, added: false, received: chunks.size, total, complete: false };

        const added = !chunks.has(packet.seq);
        if (added) chunks.set(packet.seq, packet.payload.slice());
        return { accepted: true, added, received: chunks.size, total, complete: chunks.size === total };
    }

    async function restore() {
        if (total === null || chunks.size !== total) throw new Error('必要なQRパケットがそろっていません。');
        const joined = new Uint8Array(encodedSize);
        let offset = 0;
        for (let i = 0; i < total; i++) {
            const chunk = chunks.get(i);
            if (!chunk) throw new Error('データの一部が欠損しています。');
            if (offset + chunk.length > joined.length) throw new Error('パケットサイズが不正です。');
            joined.set(chunk, offset);
            offset += chunk.length;
        }
        if (offset !== encodedSize) throw new Error('復元データのサイズが一致しません。');

        const actualHash = await sha256(joined);
        if (!equalBytes(actualHash, expectedHash)) throw new Error('データが破損しています（SHA-256不一致）。');

        let plain = joined;
        if (flags & 1) plain = await decompressBytes(joined);
        if (originalSize !== null && plain.length !== originalSize) throw new Error('復元サイズが一致しません。');
        return new TextDecoder('utf-8', { fatal: true }).decode(plain);
    }

    return {
        add,
        restore,
        get received() { return chunks.size; },
        get total() { return total; },
        get complete() { return total !== null && chunks.size === total; }
    };
}

// -------------------------
// QR Drawing & Capacity
// -------------------------
function qrcodeStringHack() {
    if (typeof qrcode === 'function' && !qrcode.stringToBytesIsHacked) {
        qrcode.stringToBytes = function (s) {
            const out = new Array(s.length);
            for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
            return out;
        };
        qrcode.stringToBytesIsHacked = true;
    }
}
function buildQR(payloadBytes, version, ec) {
    qrcodeStringHack();
    const qr = qrcode(version, ec);
    qr.addData(bytesToBinaryString(payloadBytes), 'Byte');
    qr.make();
    return qr;
}
function canEncodeBytes(length, version, ec) {
    try {
        const dummy = new Uint8Array(length);
        buildQR(dummy, version, ec);
        return true;
    } catch (e) { return false; }
}
const capacityCache = new Map();
function getQRCapacity(version, ec) {
    const key = `${version}-${ec}`;
    if (capacityCache.has(key)) return capacityCache.get(key);
    let lo = 0, hi = 3000;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (canEncodeBytes(mid, version, ec)) lo = mid; else hi = mid - 1;
    }
    capacityCache.set(key, lo);
    return lo;
}
function drawQRToCanvas(payload, targetCanvas) {
    const qr = buildQR(payload, SETTINGS.version, SETTINGS.ec);
    const modules = qr.getModuleCount();
    const quiet = 4 * SETTINGS.modulePx;
    const rawSize = modules * SETTINGS.modulePx + quiet * 2 + SETTINGS.extraMargin * 2;
    const side = SETTINGS.align16 ? Math.ceil(rawSize / ALIGNMENT) * ALIGNMENT : rawSize;
    targetCanvas.width = side; targetCanvas.height = side;
    const ctx = targetCanvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, side, side);
    const offset = Math.floor((side - (modules * SETTINGS.modulePx + quiet * 2)) / 2) + quiet;
    ctx.fillStyle = '#000';
    for (let r = 0; r < modules; r++) {
        for (let c = 0; c < modules; c++) {
            if (qr.isDark(r, c)) ctx.fillRect(offset + c * SETTINGS.modulePx, offset + r * SETTINGS.modulePx, SETTINGS.modulePx, SETTINGS.modulePx);
        }
    }
    return { side };
}

// ----------------------------------------------------------------------------
// Phase 4: mockup HTML (design-2 クリーン・アウトライン) Canvas完全再現描画
// ----------------------------------------------------------------------------
export function drawCustomThumbnail(canvas, side, options = {}) {
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    
    // スケール計算 (mockup HTMLの基準幅 220px に対する比率)
    const scale = side / 220;

    const themeKey = options.themeColor || 'blue';
    const palette = THEME_PALETTES[themeKey] || THEME_PALETTES.blue;
    const title = options.title || '問題パック';
    const category = options.category || '問題パック / 一般';
    const count = options.count !== undefined ? String(options.count) : '0';
    const dateStr = options.date || new Date().toISOString().slice(0, 10).replace(/-/g, '.');

    ctx.save();

    // 1. 全体背景（白）
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, side, side);

    // 2. 上部4pxのアクセントライン
    ctx.fillStyle = palette.accent;
    ctx.fillRect(0, 0, side, 4 * scale);

    // 3. 外枠線
    ctx.strokeStyle = '#DDE4E8';
    ctx.lineWidth = 1.5 * scale;
    ctx.strokeRect(0.75 * scale, 0.75 * scale, side - 1.5 * scale, side - 1.5 * scale);

    // 4. カテゴリバッジ
    ctx.font = `850 ${9.5 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif`;
    const badgeText = category;
    const badgeMetrics = ctx.measureText(badgeText);
    const badgePaddingX = 5 * scale;
    const badgePaddingY = 3 * scale;
    const badgeW = badgeMetrics.width + badgePaddingX * 2;
    const badgeH = 12 * scale + badgePaddingY * 2;
    const badgeX = 8 * scale;
    const badgeY = 9 * scale;

    // バッジ背景 (soft) & 枠線 (tint)
    ctx.fillStyle = palette.soft;
    ctx.strokeStyle = palette.tint;
    ctx.lineWidth = 1 * scale;
    drawRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4 * scale);
    ctx.fill();
    ctx.stroke();

    // バッジテキスト
    ctx.fillStyle = palette.accent;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(badgeText, badgeX + badgePaddingX, badgeY + badgeH / 2);

    // 5. 右上 appGlyph アイコン (SVGパス完全描画)
    ctx.save();
    const glyphSize = 15 * scale;
    const glyphX = side - 8 * scale - glyphSize;
    const glyphY = 10 * scale;
    ctx.translate(glyphX, glyphY);
    ctx.scale(glyphSize / 52, (glyphSize * (46 / 52)) / 46);
    ctx.fillStyle = palette.accent;
    const glyphPath = new Path2D(APP_GLYPH_PATH);
    ctx.fill(glyphPath);
    ctx.restore();

    // 6. カードタイトル (最大2行の折返し描画)
    ctx.fillStyle = '#1F2937';
    ctx.font = `850 ${14 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const titleX = 8 * scale;
    const titleY = 32 * scale;
    const maxTitleWidth = side - 16 * scale;
    const lineHeight = 16 * scale;

    // タイトルの折返し処理
    const lines = [];
    const words = title.split('<br>');
    if (words.length > 1) {
        lines.push(words[0], words.slice(1).join(' '));
    } else {
        let currentLine = '';
        for (let i = 0; i < title.length; i++) {
            const testLine = currentLine + title[i];
            if (ctx.measureText(testLine).width > maxTitleWidth && i > 0) {
                lines.push(currentLine);
                currentLine = title[i];
                if (lines.length === 2) break;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine && lines.length < 2) lines.push(currentLine);
    }
    lines.slice(0, 2).forEach((l, idx) => {
        ctx.fillText(l, titleX, titleY + idx * lineHeight);
    });

    // 7. メトリック行 (中央メインシンボル＋数値)
    const centerY = side * 0.54;

    // メインシンボル背景 (30x30 角丸正方形)
    const symbolSize = 30 * scale;
    const symbolX = side * 0.22 - symbolSize / 2;
    const symbolY = centerY - symbolSize / 2;
    ctx.fillStyle = palette.soft;
    drawRoundRect(ctx, symbolX, symbolY, symbolSize, symbolSize, 8 * scale);
    ctx.fill();

    // メインシンボル: icons.book のSVGパスを描画
    ctx.save();
    ctx.translate(symbolX + 4 * scale, symbolY + 4 * scale);
    const bookScale = (22 * scale) / 24;
    ctx.scale(bookScale, bookScale);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 2;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';

    const p1 = new Path2D("M4 19.5A2.5 2.5 0 0 1 6.5 17H20");
    const p2 = new Path2D("M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z");
    ctx.stroke(p1);
    ctx.stroke(p2);
    ctx.beginPath();
    ctx.moveTo(9, 7); ctx.lineTo(15, 7);
    ctx.moveTo(9, 11); ctx.lineTo(13, 11);
    ctx.stroke();
    ctx.restore();

    // 問題数カウント数値
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = palette.accent;
    ctx.font = `900 ${36 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const numX = side * 0.44;
    const numY = centerY + 12 * scale;
    ctx.fillText(count, numX, numY);

    const numWidth = ctx.measureText(count).width;
    // 単位「問」
    ctx.fillStyle = '#1F2937';
    ctx.font = `850 ${13 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", sans-serif`;
    ctx.fillText('問', numX + numWidth + 4 * scale, numY);

    // 8. フッター (境界線・ステータス・日時)
    const footerY = side - 18 * scale;
    ctx.strokeStyle = '#EEF0F2';
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.moveTo(8 * scale, footerY);
    ctx.lineTo(side - 8 * scale, footerY);
    ctx.stroke();

    ctx.font = `850 ${8 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'bottom';
    
    // ステータス
    ctx.fillStyle = palette.accent;
    ctx.textAlign = 'left';
    ctx.fillText('UNOPENED PACK', 8 * scale, side - 6 * scale);

    // 日時
    ctx.fillStyle = '#6B7280';
    ctx.textAlign = 'right';
    ctx.fillText(dateStr, side - 8 * scale, side - 6 * scale);

    ctx.restore();
}

// -------------------------
// Encode (Generate Video)
// -------------------------
export async function encodeToVideo(text, onProgress, options = {}, control = {}) {
    const isCanceled = typeof control === 'function'
        ? control
        : (typeof control.isCanceled === 'function' ? control.isCanceled : () => false);
    const throwIfCanceled = () => {
        if (isCanceled()) {
            const error = new Error('ユーザーによってキャンセルされました。');
            error.name = 'AbortError';
            throw error;
        }
    };
    const reportProgress = (ratio, message) => {
        if (typeof onProgress === 'function') onProgress(ratio, message);
    };

    throwIfCanceled();
    if (typeof text !== 'string' || !text.trim()) throw new Error('テキストが空です。');
    if (!window.qrcode || !window.Mp4Muxer || !('VideoEncoder' in window)) {
        throw new Error('必要なライブラリまたはブラウザAPIが不足しています。');
    }

    const meta = {
        title: options.title || '問題パック',
        category: options.category || '問題パック',
        themeColor: options.themeColor || 'blue',
        count: options.count || 0,
        createdAt: options.createdAt || Date.now()
    };
    const packagedText = packageWithMetadata(text, meta);
    const textBytes = new TextEncoder().encode(packagedText);

    const cap = getQRCapacity(SETTINGS.version, SETTINGS.ec);
    const payloadSize = Math.max(0, cap - HEADER_SIZE - SETTINGS.reserve);
    if (payloadSize <= 0) throw new Error('容量計算エラー。データを格納できません。');

    let encoded = textBytes;
    let compressed = false;
    if (SETTINGS.compress) {
        const compressedResult = await compressBytes(textBytes);
        encoded = compressedResult.bytes;
        compressed = compressedResult.compressed;
        throwIfCanceled();
    }

    const finalPayload = compressed ? encoded : textBytes;
    const flags = compressed ? 1 : 0;
    const totalChunks = Math.ceil(finalPayload.length / payloadSize);
    if (totalChunks > MAX_DATA_FRAMES && SETTINGS.limit100) {
        throw new Error(`データが大きすぎます。圧縮後も${totalChunks}フレーム必要です（最大${MAX_DATA_FRAMES}）。`);
    }

    throwIfCanceled();
    const hash = await sha256(finalPayload);
    throwIfCanceled();
    const transferId = randomTransferId();
    const packets = [];
    for (let i = 0; i < totalChunks; i++) {
        throwIfCanceled();
        const part = finalPayload.slice(i * payloadSize, Math.min(finalPayload.length, (i + 1) * payloadSize));
        packets.push(writePacket({ transferId, seq: i, total: totalChunks, originalSize: textBytes.length, encodedSize: finalPayload.length, flags, hash, payload: part }));
        if (i % 8 === 0) await sleep(0);
    }

    throwIfCanceled();
    const qrCanvas = document.createElement('canvas');
    const qrInfo = drawQRToCanvas(packets[0], qrCanvas);
    const actualSide = qrInfo.side;
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = outputCanvas.height = actualSide;

    const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: actualSide, height: actualSide },
        fastStart: 'in-memory'
    });

    let encoderError = null;
    const videoEncoder = new VideoEncoder({
        output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
        error: error => { encoderError = error; console.error('[Q-One:Encoder]', error); }
    });

    try {
        videoEncoder.configure({
            codec: 'avc1.42001f',
            width: actualSide,
            height: actualSide,
            bitrate: Math.round(SETTINGS.bitrateMbps * 1_000_000),
            framerate: SETTINGS.fps,
            avc: { format: 'avc' }
        });

        const totalFrames = 1 + totalChunks;
        const frameDurationMicros = Math.round(1_000_000 / SETTINGS.fps);
        const outputContext = outputCanvas.getContext('2d');
        if (!outputContext) throw new Error('動画フレーム用Canvasを初期化できません。');

        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            throwIfCanceled();
            if (encoderError) throw encoderError;

            if (frameIndex === 0) {
                drawCustomThumbnail(outputCanvas, actualSide, meta);
            } else {
                drawQRToCanvas(packets[frameIndex - 1], qrCanvas);
                outputContext.imageSmoothingEnabled = false;
                outputContext.drawImage(qrCanvas, 0, 0, actualSide, actualSide);
            }

            const timestampMicros = frameIndex * frameDurationMicros;
            const frame = new VideoFrame(outputCanvas, { timestamp: timestampMicros, duration: frameDurationMicros });
            try {
                videoEncoder.encode(frame, { keyFrame: frameIndex === 0 || frameIndex % SETTINGS.fps === 0 });
            } finally {
                frame.close();
            }

            if (frameIndex % 5 === 0 || frameIndex === totalFrames - 1) {
                reportProgress((frameIndex + 1) / totalFrames, `エンコード中... ${frameIndex + 1} / ${totalFrames}`);
                await sleep(0);
            }
        }

        throwIfCanceled();
        if (encoderError) throw encoderError;
        await videoEncoder.flush();
        throwIfCanceled();
        if (encoderError) throw encoderError;

        // finalize() は正常終了時にのみ呼ぶ。キャンセル時に不完全なMP4は返さない。
        muxer.finalize();
        if (!muxer.target.buffer) throw new Error('MP4の確定に失敗しました。');
        return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    } catch (error) {
        if (isCanceled() && error?.name !== 'AbortError') {
            const canceled = new Error('ユーザーによってキャンセルされました。');
            canceled.name = 'AbortError';
            throw canceled;
        }
        throw error;
    } finally {
        try {
            if (videoEncoder.state !== 'closed') videoEncoder.close();
        } catch (closeError) {
            console.warn('[Q-One:Encoder] VideoEncoderの解放時にエラー:', closeError);
        }
    }
}

// -------------------------
// Decode (MP4 Demux -> WebCodecs -> Worker jsQR)
// -------------------------
function getExtradata(mp4boxfile, trackId) {
    const trak = mp4boxfile.getTrackById(trackId);
    if (!trak || !trak.mdia || !trak.mdia.minf || !trak.mdia.minf.stbl || !trak.mdia.minf.stbl.stsd) return null;
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC ?? entry.hvcC ?? entry.vpcC;
        if (box != null) {
            if (box.type === 'avcC') {
                let size = 7;
                if (box.SPS) for (let s of box.SPS) size += 2 + s.length;
                if (box.PPS) for (let p of box.PPS) size += 2 + p.length;
                const buf = new Uint8Array(size); let i = 0;
                buf[i++] = box.configurationVersion; buf[i++] = box.AVCProfileIndication;
                buf[i++] = box.profile_compatibility; buf[i++] = box.AVCLevelIndication;
                buf[i++] = 0xFC | (box.lengthSizeMinusOne !== undefined ? box.lengthSizeMinusOne : 3);
                buf[i++] = 0xE0 | (box.nb_SPS_nalus || (box.SPS ? box.SPS.length : 0));
                if (box.SPS) for (let s of box.SPS) { buf[i++] = (s.length >> 8) & 0xFF; buf[i++] = s.length & 0xFF; buf.set(s.nalu, i); i += s.length; }
                buf[i++] = box.nb_PPS_nalus || (box.PPS ? box.PPS.length : 0);
                if (box.PPS) for (let p of box.PPS) { buf[i++] = (p.length >> 8) & 0xFF; buf[i++] = p.length & 0xFF; buf.set(p.nalu, i); i += p.length; }
                return buf;
            }
        }
    }
    return null;
}

function computeFrameSignature(data, width, height) {
    let hash = 0;
    const stepX = Math.max(1, Math.floor(width / 32)), stepY = Math.max(1, Math.floor(height / 32));
    for (let y = 0; y < height; y += stepY) {
        const rowOffset = y * width * 4;
        for (let x = 0; x < width; x += stepX) {
            const idx = rowOffset + x * 4;
            const val = (data[idx] << 16) | (data[idx + 1] << 8) | data[idx + 2];
            hash = ((hash << 5) - hash + val) | 0;
        }
    }
    return hash;
}

export async function decodeFromVideo(file, onProgress, isStopped = () => false) {
    const throwIfStopped = () => {
        if (isStopped()) {
            const error = new Error('ユーザーによってキャンセルされました。');
            error.name = 'AbortError';
            throw error;
        }
    };
    throwIfStopped();
    if (!window.MP4Box || !('VideoDecoder' in window)) throw new Error('ブラウザが動画解析に非対応です。');
    
    const workerCode = `
        self.importScripts('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
        self.onmessage = function(e) {
            const { id, data, width, height } = e.data;
            try {
                const code = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
                if (code && code.binaryData && code.binaryData.length > 0) {
                    const bin = new Uint8Array(code.binaryData);
                    self.postMessage({ id, success: true, binaryData: bin }, [bin.buffer]);
                } else {
                    self.postMessage({ id, success: false });
                }
            } catch (err) { self.postMessage({ id, success: false, error: err.message }); }
        };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const concurrency = Math.max(2, Math.min(6, navigator.hardwareConcurrency || 4));
    const workers = Array.from({ length: concurrency }, () => new Worker(workerUrl));

    const packetCollector = createPacketCollector();
    let isAllChunksCollected = false;

    let inFlight = 0, inFlightResolvers = [];
    const onWorkerFinished = () => {
        inFlight--;
        if (inFlightResolvers.length > 0) inFlightResolvers.shift()();
    };
    const waitCapacity = () => (inFlight < concurrency * 2) ? Promise.resolve() : new Promise(r => inFlightResolvers.push(r));

    workers.forEach(w => {
        w.onmessage = (e) => {
            onWorkerFinished();
            if (e.data.success && e.data.binaryData) {
                packetCollector.add(Uint8Array.from(e.data.binaryData));
            }
            if (packetCollector.complete && !isAllChunksCollected) isAllChunksCollected = true;
        };
    });

    let activeDecoder = null;
    try {
        if (typeof onProgress === 'function') onProgress(0, '動画ファイルの読み込み中...');
        const arrayBuffer = await file.arrayBuffer();
        throwIfStopped();
        arrayBuffer.fileStart = 0;

        const mp4boxfile = MP4Box.createFile();
        const sampleQueue = [];
        let fileInfo = null;

        const mp4Ready = new Promise((resolve, reject) => {
            mp4boxfile.onReady = info => { fileInfo = info; resolve(info); };
            mp4boxfile.onError = e => reject(new Error('MP4解析エラー: ' + e));
        });

        mp4boxfile.onSamples = (id, ref, samples) => sampleQueue.push(...samples);
        mp4boxfile.appendBuffer(arrayBuffer); mp4boxfile.flush();
        await mp4Ready;

        const videoTrack = fileInfo.videoTracks[0];
        if (!videoTrack) throw new Error('映像が見つかりません。');
        mp4boxfile.setExtractionOptions(videoTrack.id, 'video', { nbSamples: videoTrack.nb_samples });
        mp4boxfile.start();

        const description = getExtradata(mp4boxfile, videoTrack.id);
        if (!description) throw new Error('メタデータ抽出失敗。');

        let frameCanvas = null, frameCtx = null, lastSignature = null, roundRobinIdx = 0, decoderError = null;

        const decoder = new VideoDecoder({
            output: (videoFrame) => {
                try {
                    if (isStopped() || isAllChunksCollected) { videoFrame.close(); return; }
                    if (!frameCanvas) {
                        frameCanvas = document.createElement('canvas');
                        frameCanvas.width = videoFrame.displayWidth; frameCanvas.height = videoFrame.displayHeight;
                        frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
                    }
                    frameCtx.drawImage(videoFrame, 0, 0); videoFrame.close();
                    
                    const imgData = frameCtx.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
                    const sig = computeFrameSignature(imgData.data, frameCanvas.width, frameCanvas.height);
                    if (sig === lastSignature) return;
                    lastSignature = sig;

                    inFlight++;
                    const targetWorker = workers[roundRobinIdx % concurrency];
                    roundRobinIdx++;
                    const buffer = imgData.data.buffer;
                    targetWorker.postMessage({ id: 0, data: imgData.data, width: frameCanvas.width, height: frameCanvas.height }, [buffer]);
                } catch (err) { console.error(err); }
            },
            error: (e) => { decoderError = e; }
        });
        activeDecoder = decoder;

        decoder.configure({
            codec: videoTrack.codec.startsWith('avc1') ? videoTrack.codec : 'avc1.42001f',
            codedWidth: videoTrack.video.width || videoTrack.track_width,
            codedHeight: videoTrack.video.height || videoTrack.track_height,
            description
        });

        for (let i = 0; i < sampleQueue.length; i++) {
            if (isStopped() || isAllChunksCollected) break;
            if (decoderError) throw decoderError;
            await waitCapacity();
            const s = sampleQueue[i];
            decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: s.cts, duration: s.duration, data: s.data }));
            
            if (i % 10 === 0) {
                const ratio = packetCollector.total ? (packetCollector.received / packetCollector.total * 0.9) : ((i + 1) / sampleQueue.length * 0.4);
                if (typeof onProgress === 'function') onProgress(ratio, packetCollector.total ? `QR解析中... ${packetCollector.received} / ${packetCollector.total}` : '映像を展開中...');
                await sleep(0);
            }
        }

        if (!isStopped() && !isAllChunksCollected) await decoder.flush();
        while (inFlight > 0) {
            if (isStopped() || isAllChunksCollected) break;
            await sleep(20);
        }
        if (isStopped()) {
            const canceled = new Error('ユーザーによってキャンセルされました。');
            canceled.name = 'AbortError';
            throw canceled;
        }

        if (packetCollector.complete) {
            if (typeof onProgress === 'function') onProgress(0.95, 'テキストデータを復元中...');
            return await packetCollector.restore();
        }
        throw new Error(`必要なデータが不足しています。読み取れたQR: ${packetCollector.received}/${packetCollector.total ?? '不明'}`);

    } finally {
        if (activeDecoder) {
            try { if (activeDecoder.state !== 'closed') activeDecoder.close(); }
            catch (error) { console.warn('[Q-One:Decoder] VideoDecoderの解放時にエラー:', error); }
        }
        workers.forEach(worker => worker.terminate());
        URL.revokeObjectURL(workerUrl);
    }
}

// -------------------------
// Decode (Live Camera -> Worker jsQR)
// -------------------------
export async function decodeFromCamera(videoElement, onProgress, isStopped = () => false, guideElement = null) {
    const throwIfStopped = () => {
        if (isStopped()) {
            const error = new Error('ユーザーによってキャンセルされました。');
            error.name = 'AbortError';
            throw error;
        }
    };
    if (!videoElement) throw new Error('カメラ映像の表示先が見つかりません。');
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('このブラウザーではカメラを利用できません。HTTPS接続とカメラ対応ブラウザーを確認してください。');
    }
    throwIfStopped();

    let stream = null;
    let worker = null;
    let workerUrl = null;
    let frameCanvas = null;
    let frameContext = null;
    let scanLoopTimeoutId = null;
    let cancelWatchId = null;
    let workerReadyTimeoutId = null;
    let workerResponseTimeoutId = null;

    try {
        if (typeof onProgress === 'function') onProgress(0, 'カメラを起動しています...');

        try {
            const portraitDisplay = window.matchMedia?.('(orientation: portrait)').matches ??
                window.innerHeight >= window.innerWidth;
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: portraitDisplay ? 720 : 1280 },
                    height: { ideal: portraitDisplay ? 1280 : 720 },
                    frameRate: { ideal: 15, max: 20 }
                }
            });
        } catch (error) {
            if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
                throw new Error('カメラの使用が許可されていません。ブラウザーのサイト設定からカメラを許可してください。');
            }
            if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
                throw new Error('利用できるカメラが見つかりません。');
            }
            if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
                throw new Error('カメラを開始できません。他のアプリで使用中でないか確認してください。');
            }
            throw error;
        }
        throwIfStopped();

        videoElement.muted = true;
        videoElement.playsInline = true;
        videoElement.autoplay = true;
        videoElement.srcObject = stream;
        await videoElement.play();

        // メタデータだけでなく、実際に描画可能なフレームが届くまで待つ。
        const videoReadyDeadline = performance.now() + 12000;
        while ((!videoElement.videoWidth || !videoElement.videoHeight || videoElement.readyState < 2) && !isStopped()) {
            if (performance.now() > videoReadyDeadline) {
                throw new Error('カメラ映像を取得できませんでした。カメラを再起動して、もう一度お試しください。');
            }
            await sleep(80);
        }
        throwIfStopped();

        const sourceWidth = videoElement.videoWidth;
        const sourceHeight = videoElement.videoHeight;

        // ガイドの実際の表示位置を、object-fit: contain で描画された
        // カメラ映像のピクセル座標へ変換する。画面比率とカメラ比率が
        // 異なる端末でも、表示ガイドと解析ROIがずれないようにする。
        // loadedmetadata後にCSSレイアウトが反映される時間を確保する。
        await sleep(50);
        const videoRect = videoElement.getBoundingClientRect();
        const guideRect = guideElement?.getBoundingClientRect?.();
        const containScale = Math.min(
            videoRect.width / sourceWidth,
            videoRect.height / sourceHeight
        );
        if (!Number.isFinite(containScale) || containScale <= 0) {
            throw new Error('カメラ映像の表示領域を取得できません。');
        }

        const contentWidth = sourceWidth * containScale;
        const contentHeight = sourceHeight * containScale;
        const contentLeft = videoRect.left + (videoRect.width - contentWidth) / 2;
        const contentTop = videoRect.top + (videoRect.height - contentHeight) / 2;

        let guideLeft;
        let guideTop;
        let guideWidth;
        let guideHeight;
        if (guideRect && guideRect.width > 0 && guideRect.height > 0) {
            guideLeft = (guideRect.left - contentLeft) / containScale;
            guideTop = (guideRect.top - contentTop) / containScale;
            guideWidth = guideRect.width / containScale;
            guideHeight = guideRect.height / containScale;
        } else {
            // ガイド要素を取得できない場合のみ、従来互換の中央領域を使う。
            guideWidth = Math.min(sourceWidth, sourceHeight) * 0.68;
            guideHeight = guideWidth;
            guideLeft = (sourceWidth - guideWidth) / 2;
            guideTop = (sourceHeight - guideHeight) / 2;
        }

        // ガイドの各辺から2.5%ずつ余白を追加（全体で約5%広い範囲）。
        // 枠ぎりぎりに映ったQRの位置検出パターンが切れるのを防ぐ。
        const marginX = guideWidth * 0.025;
        const marginY = guideHeight * 0.025;
        const sourceX = Math.max(0, Math.floor(guideLeft - marginX));
        const sourceY = Math.max(0, Math.floor(guideTop - marginY));
        const sourceRight = Math.min(sourceWidth, Math.ceil(guideLeft + guideWidth + marginX));
        const sourceBottom = Math.min(sourceHeight, Math.ceil(guideTop + guideHeight + marginY));
        const scanRegionWidth = Math.max(1, sourceRight - sourceX);
        const scanRegionHeight = Math.max(1, sourceBottom - sourceY);

        // 高密度QRの読み取りに必要な画素数を維持する。
        // 1600pxを超えるカメラ映像だけ、処理負荷を抑えるため縮小する。
        const maxScanDimension = 1600;
        const scanScale = Math.min(1, maxScanDimension / Math.max(scanRegionWidth, scanRegionHeight));
        const width = Math.max(1, Math.round(scanRegionWidth * scanScale));
        const height = Math.max(1, Math.round(scanRegionHeight * scanScale));
        frameCanvas = document.createElement('canvas');
        frameCanvas.width = width;
        frameCanvas.height = height;
        frameContext = frameCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
        if (!frameContext) throw new Error('カメラ映像を解析するCanvasを初期化できません。');

        // Worker側でライブラリを読み込んだことを通知させる。
        // CDN読み込み失敗時に「読み取り中」のまま永久に止まらないようにする。
        const workerCode = `
            try {
                self.importScripts('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
                if (typeof jsQR !== 'function') throw new Error('jsQRを初期化できません。');
                self.postMessage({ type: 'ready' });
            } catch (err) {
                self.postMessage({ type: 'init-error', error: err && err.message ? err.message : String(err) });
            }

            self.onmessage = function(e) {
                const message = e.data || {};
                if (message.type !== 'scan') return;
                const { id, data, width, height, fallbackInvert } = message;
                try {
                    const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
                    // 通常のQ-One QRは黒地ではなく白地に黒。通常解析はdontInvertで軽量化し、
                    // 反転QRにも対応できるよう、ときどきattemptBothで再確認する。
                    const options = { inversionAttempts: fallbackInvert ? 'attemptBoth' : 'dontInvert' };
                    const code = jsQR(pixels, width, height, options);
                    if (code && code.binaryData && code.binaryData.length > 0) {
                        const bin = new Uint8Array(code.binaryData);
                        self.postMessage({ type: 'scan-result', id, qrFound: true, version: code.version, binaryData: bin }, [bin.buffer]);
                    } else {
                        self.postMessage({ type: 'scan-result', id, qrFound: false });
                    }
                } catch (err) {
                    self.postMessage({ type: 'scan-result', id, error: err && err.message ? err.message : String(err) });
                }
            };
        `;
        const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
        workerUrl = URL.createObjectURL(workerBlob);
        worker = new Worker(workerUrl);

        const collector = createPacketCollector();
        let workerBusy = false;
        let settled = false;
        let scanCount = 0;
        let lastScanAt = -Infinity;
        let lastStatusAt = 0;
        let requestId = 0;
        let pendingRequestId = 0;
        let isWorkerReady = false;
        let readyResolve;
        let readyReject;
        let resultPromiseResolve;
        let resultPromiseReject;

        const workerReadyPromise = new Promise((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });
        const resultPromise = new Promise((resolve, reject) => {
            resultPromiseResolve = resolve;
            resultPromiseReject = reject;
        });

        const fail = (error) => {
            if (settled) return;
            settled = true;
            if (workerResponseTimeoutId !== null) clearTimeout(workerResponseTimeoutId);
            resultPromiseReject(error);
        };

        worker.onmessage = async (event) => {
            const data = event.data || {};
            if (data.type === 'ready') {
                isWorkerReady = true;
                if (workerReadyTimeoutId !== null) clearTimeout(workerReadyTimeoutId);
                readyResolve();
                return;
            }
            if (data.type === 'init-error') {
                const error = new Error(`QR解析ライブラリを読み込めませんでした: ${data.error || '不明なエラー'}`);
                readyReject(error);
                if (isWorkerReady) fail(error);
                return;
            }
            if (data.type !== 'scan-result') return;
            if (data.id !== pendingRequestId) return;

            workerBusy = false;
            if (workerResponseTimeoutId !== null) {
                clearTimeout(workerResponseTimeoutId);
                workerResponseTimeoutId = null;
            }
            if (settled || isStopped()) return;

            if (data.error) {
                console.warn('[Q-One:Camera] QR解析エラー:', data.error);
            } else if (data.qrFound && data.binaryData) {
                const result = collector.add(data.binaryData);
                if (result.added && typeof onProgress === 'function') {
                    const ratio = result.total ? Math.min(0.9, result.received / result.total * 0.9) : 0;
                    onProgress(ratio, `QR読み取り中... ${result.received} / ${result.total}`);
                } else if (!result.accepted && typeof onProgress === 'function') {
                    onProgress(0, 'QRコードを検出しました。Q-Oneの転送データを確認しています...');
                }

                if (result.complete && !settled) {
                    settled = true;
                    try {
                        if (typeof onProgress === 'function') onProgress(0.95, '全パケットを受信しました。データを検証中...');
                        const restored = await collector.restore();
                        if (typeof onProgress === 'function') onProgress(1, 'データの復元が完了しました。');
                        resultPromiseResolve(restored);
                    } catch (error) {
                        resultPromiseReject(error);
                    }
                }
            } else if (data.qrFound && typeof onProgress === 'function') {
                onProgress(0, 'QRコードを検出しました。読み取りを続けています...');
            }
        };

        worker.onerror = (event) => {
            const error = new Error(`QR解析Workerでエラーが発生しました: ${event.message || '不明なエラー'}`);
            if (isWorkerReady) fail(error);
            else readyReject(error);
        };
        worker.onmessageerror = () => {
            const error = new Error('QR解析Workerとのデータ通信に失敗しました。ページを再読み込みしてお試しください。');
            if (isWorkerReady) fail(error);
            else readyReject(error);
        };

        workerReadyTimeoutId = setTimeout(() => {
            const error = new Error('QR解析ライブラリの起動がタイムアウトしました。通信状態を確認して、もう一度お試しください。');
            readyReject(error);
        }, 12000);

        // Worker初期化中も停止操作を監視する。
        cancelWatchId = setInterval(() => {
            if (isStopped()) {
                const error = new Error('ユーザーによってキャンセルされました。');
                error.name = 'AbortError';
                if (isWorkerReady) fail(error);
                else readyReject(error);
            }
        }, 120);

        if (typeof onProgress === 'function') onProgress(0, 'QR解析を準備しています...');
        await workerReadyPromise;
        if (workerReadyTimeoutId !== null) {
            clearTimeout(workerReadyTimeoutId);
            workerReadyTimeoutId = null;
        }
        throwIfStopped();
        if (typeof onProgress === 'function') onProgress(0, '画面内のQRコードを探しています...');

        // requestVideoFrameCallback / requestAnimationFrameのフレーム通知に依存せず、
        // タイマーで最新の映像を定期確認する。MediaStreamのフレーム通知に端末差があっても
        // スキャンが停止しない。解析中は次のフレームを投入しない。
        const scanFrame = () => {
            if (settled || isStopped()) return;
            const now = performance.now();
            if (!workerBusy && videoElement.readyState >= 2 && now - lastScanAt >= 140) {
                lastScanAt = now;
                scanCount += 1;
                try {
                    frameContext.drawImage(
                        videoElement,
                        sourceX, sourceY, scanRegionWidth, scanRegionHeight,
                        0, 0, width, height
                    );
                    const imageData = frameContext.getImageData(0, 0, width, height);
                    const id = ++requestId;
                    pendingRequestId = id;
                    workerBusy = true;
                    worker.postMessage({
                        type: 'scan',
                        id,
                        data: imageData.data,
                        width,
                        height,
                        // 反転画像の可能性も低頻度で確認する。
                        fallbackInvert: scanCount % 8 === 0
                    }, [imageData.data.buffer]);

                    workerResponseTimeoutId = setTimeout(() => {
                        if (workerBusy && pendingRequestId === id) {
                            workerBusy = false;
                            fail(new Error('QR解析が応答しません。カメラ映像を閉じて、もう一度読み取りを開始してください。'));
                        }
                    }, 12000);
                } catch (error) {
                    workerBusy = false;
                    console.warn('[Q-One:Camera] フレーム取得をスキップしました:', error);
                }
            }

            if (!settled && !isStopped() && typeof onProgress === 'function' &&
                scanCount > 0 && now - lastStatusAt >= 1100) {
                lastStatusAt = now;
                // 定期ステータス更新でも進捗率を0に戻さない。
                const currentRatio = collector.total
                    ? Math.min(0.9, collector.received / collector.total * 0.9)
                    : 0;
                const status = collector.total
                    ? `QR読み取り中... ${collector.received} / ${collector.total}`
                    : `QRコードを探しています...（解析 ${scanCount} 回）`;
                onProgress(currentRatio, status);
            }
            if (!settled && !isStopped()) scanLoopTimeoutId = setTimeout(scanFrame, 50);
        };

        scanLoopTimeoutId = setTimeout(scanFrame, 0);
        return await resultPromise;
    } finally {
        if (cancelWatchId !== null) clearInterval(cancelWatchId);
        if (scanLoopTimeoutId !== null) clearTimeout(scanLoopTimeoutId);
        if (workerReadyTimeoutId !== null) clearTimeout(workerReadyTimeoutId);
        if (workerResponseTimeoutId !== null) clearTimeout(workerResponseTimeoutId);
        if (worker) worker.terminate();
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (videoElement) {
            videoElement.pause();
            videoElement.srcObject = null;
        }
    }
}

