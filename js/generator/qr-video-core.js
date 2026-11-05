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
    fps: 10,
    bitrateMbps: 4,
    reserve: 1,
    align16: true,
    compress: true,
    limit100: false
};

// mockup HTML準拠のテーマカラーパレット定義
export const THEME_PALETTES = {
    blue: { accent: '#3B82F6', soft: '#EFF6FF', tint: '#DBEAFE' },
    red: { accent: '#EF4444', soft: '#FEF2F2', tint: '#FEE2E2' },
    green: { accent: '#10B981', soft: '#ECFDF5', tint: '#D1FAE5' },
    yellow: { accent: '#F59E0B', soft: '#FFFBEB', tint: '#FEF3C7' },
    purple: { accent: '#8B5CF6', soft: '#F5F3FF', tint: '#EDE9FE' }
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
export async function encodeToVideo(text, onProgress, options = {}) {
    if (!text.trim()) throw new Error('テキストが空です。');
    if (!window.qrcode || !window.Mp4Muxer || !('VideoEncoder' in window)) {
        throw new Error('必要なライブラリまたはブラウザAPIが不足しています。');
    }

    // メタデータの自動パッケージ化
    const meta = {
        title: options.title || '問題パック',
        category: options.category || '問題パック',
        themeColor: options.themeColor || 'blue',
        count: options.count || 0,
        createdAt: Date.now()
    };
    const packagedText = packageWithMetadata(text, meta);
    const textBytes = new TextEncoder().encode(packagedText);

    const cap = getQRCapacity(SETTINGS.version, SETTINGS.ec);
    const payloadSize = Math.max(0, cap - HEADER_SIZE - SETTINGS.reserve);
    if (payloadSize <= 0) throw new Error('容量計算エラー。データを格納できません。');

    let encoded = textBytes, compressed = false;
    if (SETTINGS.compress) {
        const c = await compressBytes(textBytes);
        encoded = c.bytes; compressed = c.compressed;
    }
    const finalPayload = compressed ? encoded : textBytes;
    const flags = compressed ? 1 : 0;
    const totalChunks = Math.ceil(finalPayload.length / payloadSize);

    if (totalChunks > MAX_DATA_FRAMES && SETTINGS.limit100) {
        throw new Error(`データが大きすぎます。圧縮後も${totalChunks}フレーム必要です（最大${MAX_DATA_FRAMES}）。`);
    }

    const hash = await sha256(finalPayload);
    const transferId = randomTransferId();
    const packets = [];
    for (let i = 0; i < totalChunks; i++) {
        const part = finalPayload.slice(i * payloadSize, Math.min(finalPayload.length, (i + 1) * payloadSize));
        packets.push(writePacket({ transferId, seq: i, total: totalChunks, originalSize: textBytes.length, encodedSize: finalPayload.length, flags, hash, payload: part }));
    }

    const qrCanvas = document.createElement('canvas');
    let qrInfo = drawQRToCanvas(packets[0], qrCanvas);
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
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { encoderError = e; console.error(e); }
    });

    videoEncoder.configure({
        codec: 'avc1.42001f', width: actualSide, height: actualSide,
        bitrate: Math.round(SETTINGS.bitrateMbps * 1_000_000),
        framerate: SETTINGS.fps, avc: { format: 'avc' }
    });

    const totalFrames = 1 + totalChunks;
    const frameDurationMicros = Math.round(1_000_000 / SETTINGS.fps);

    for (let fi = 0; fi < totalFrames; fi++) {
        if (encoderError) throw encoderError;

        if (fi === 0) {
            // 第1フレームに mockup HTML design-2 完全準拠のカスタムサムネイルを描画
            drawCustomThumbnail(outputCanvas, actualSide, meta);
        } else {
            drawQRToCanvas(packets[fi - 1], qrCanvas);
            const ctx = outputCanvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(qrCanvas, 0, 0, actualSide, actualSide);
        }

        const timestampMicros = fi * frameDurationMicros;
        const frame = new VideoFrame(outputCanvas, { timestamp: timestampMicros, duration: frameDurationMicros });
        const keyFrame = (fi === 0 || fi % SETTINGS.fps === 0);
        videoEncoder.encode(frame, { keyFrame });
        frame.close();

        if (fi % 5 === 0 || fi === totalFrames - 1) {
            onProgress((fi + 1) / totalFrames, `エンコード中... ${fi + 1} / ${totalFrames}`);
            await sleep(0);
        }
    }

    await videoEncoder.flush();
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
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

export async function decodeFromVideo(file, onProgress, isStopped) {
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

    const chunks = new Map();
    let transferId = null, total = null, originalSize = null, encodedSize = null, flags = null, expectedHash = null;
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
                const packet = parsePacket(Uint8Array.from(e.data.binaryData));
                if (packet) {
                    if (!transferId) {
                        transferId = packet.transferId.slice(); total = packet.total; originalSize = packet.originalSize;
                        encodedSize = packet.encodedSize; flags = packet.flags; expectedHash = packet.hash.slice();
                    }
                    if (equalBytes(transferId, packet.transferId) && packet.total === total && equalBytes(packet.hash, expectedHash)) {
                        if (!chunks.has(packet.seq)) chunks.set(packet.seq, packet.payload.slice());
                    }
                }
            }
            if (total !== null) {
                if (chunks.size === total && !isAllChunksCollected) isAllChunksCollected = true;
            }
        };
    });

    try {
        onProgress(0, '動画ファイルの読み込み中...');
        const arrayBuffer = await file.arrayBuffer();
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
                const ratio = total ? (chunks.size / total * 0.9) : ((i + 1) / sampleQueue.length * 0.4);
                onProgress(ratio, total ? `QR解析中... ${chunks.size} / ${total}` : '映像を展開中...');
                await sleep(0);
            }
        }

        if (!isStopped() && !isAllChunksCollected) await decoder.flush();
        while (inFlight > 0) { if (isAllChunksCollected) break; await sleep(20); }
        if (isStopped()) throw new Error('ユーザーによってキャンセルされました。');

        if (total !== null && chunks.size === total) {
            onProgress(0.95, 'テキストデータを復元中...');
            const joined = new Uint8Array(encodedSize);
            let p = 0;
            for (let i = 0; i < total; i++) {
                const c = chunks.get(i);
                if (!c) throw new Error('データの一部が欠損しています。');
                joined.set(c, p); p += c.length;
            }
            const h = await sha256(joined);
            if (!equalBytes(h, expectedHash)) throw new Error('データが破損しています。');

            let plain = joined;
            if (flags & 1) plain = await decompressBytes(joined);
            if (originalSize !== null && plain.length !== originalSize) throw new Error('復元サイズが一致しません。');
            
            return new TextDecoder('utf-8', { fatal: true }).decode(plain);
        } else {
            throw new Error(`必要なデータが不足しています。読み取れたQR: ${chunks.size}/${total||'不明'}`);
        }
    } finally {
        workers.forEach(w => w.terminate());
        URL.revokeObjectURL(workerUrl);
    }
}
