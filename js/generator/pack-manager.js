// ============================================================================
// 問題パック管理 UIコントローラー
// ============================================================================

import { encodeToVideo, decodeFromVideo, decodeFromCamera, extractMetadataAndText } from './qr-video-core.js';
import * as DB from '../main/db.js';
import { parseText } from '../main/parser.js';
import { escapeHtml } from '../main/utils.js';
import { state } from '../main/state.js';

// DOM要素
const exportPackBtn = document.getElementById('export-pack-btn');
const saveMyProblemBtn = document.getElementById('save-my-problem-btn');
const addPackBtn = document.getElementById('add-pack-btn');
const packFileInput = document.getElementById('pack-file-input');
const packImportChoiceModal = document.getElementById('pack-import-choice-modal');
const packImportFileBtn = document.getElementById('pack-import-file-btn');
const packImportCameraBtn = document.getElementById('pack-import-camera-btn');
const cameraScanModal = document.getElementById('camera-scan-modal');
const cameraScanVideo = document.getElementById('camera-scan-video');
const cameraScanOverlay = document.getElementById('camera-scan-overlay');
const cameraScanProgress = document.getElementById('camera-scan-progress');
const cameraScanStatus = document.getElementById('camera-scan-status');
const cameraPacketMap = document.getElementById('camera-packet-map');
const cameraMissingSummary = document.getElementById('camera-missing-summary');
const cameraScanCancelBtn = document.getElementById('camera-scan-cancel-btn');
const cameraScanCloseBtn = document.getElementById('camera-scan-close-btn');
const cameraPreviewFrame = document.getElementById('camera-preview-frame');
const cameraScanGuide = document.querySelector('#camera-preview-frame .camera-scan-guide');
const inputText = document.getElementById('input-text');
const packGrid = document.querySelector('.pack-grid');

// 設定モーダル関連（エクスポート・インポート兼用）
const thumbnailModal = document.getElementById('pack-thumbnail-modal');
const modalTitleText = document.getElementById('pack-modal-title-text');
const modalSubtitleText = document.getElementById('pack-modal-subtitle-text');

const thumbnailTitleInput = document.getElementById('thumbnail-title-input');
const thumbnailSubjectSelect = document.getElementById('thumbnail-subject-select');
const thumbnailSubjectCustom = document.getElementById('thumbnail-subject-custom');
const thumbnailThemeSelect = document.getElementById('thumbnail-theme-select');
const confirmPackModalBtn = document.getElementById('confirm-pack-modal-btn');

// リアルタイムプレビュー要素
const previewCard = document.getElementById('thumbnail-preview-card');
const previewBadge = document.getElementById('preview-badge');
const previewTitle = document.getElementById('preview-title');
const previewCount = document.getElementById('preview-count');
const previewDate = document.getElementById('preview-date');

// プログレスモーダル要素
const progressModal = document.getElementById('progress-modal');
const progressTitle = document.getElementById('progress-modal-title');
const progressBar = document.getElementById('progress-modal-bar');
const progressStatus = document.getElementById('progress-modal-status');
const progressCancelBtn = document.getElementById('progress-modal-cancel');

let isProcessCanceled = false;
let currentTargetProblems = [];
let currentModalMode = 'export'; // 'export' | 'import_txt' | 'save_my_pack'
let pendingImportRawText = '';
let isCameraScanCanceled = false;

// カメラ読み取り視覚フィードバック用状態
let renderedPacketTotal = 0;
let hitHighlightTimerId = null;
let overlayClearTimerId = null;

// ============================================================================
// プログレスUI制御
// ============================================================================
function showProgressModal(title) {
    isProcessCanceled = false;
    if (progressTitle) progressTitle.textContent = title;
    if (progressBar) progressBar.style.width = '0%';
    if (progressStatus) progressStatus.textContent = '準備中...';
    if (progressCancelBtn) {
        progressCancelBtn.style.display = 'inline-flex';
        progressCancelBtn.disabled = false;
    }
    progressModal?.classList.add('active');
}
function hideProgressModal() {
    progressModal?.classList.remove('active');
    if (progressCancelBtn) {
        progressCancelBtn.style.display = 'inline-flex';
        progressCancelBtn.disabled = false;
    }
}
function updateProgressUI(ratio, message) {
    if (progressBar) progressBar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    if (message && progressStatus) progressStatus.textContent = message;
}

function createPackId() {
    return `pack_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

function isValidPackProblem(problem) {
    if (!problem || typeof problem !== 'object' || typeof problem.largeText !== 'string') return false;
    switch (problem.type) {
        case 'check':
            return typeof problem.smallText === 'string';
        case 'enter':
            return typeof problem.correctAnswer === 'string' && problem.correctAnswer.length > 0;
        case 'select':
            return Array.isArray(problem.options) && problem.options.length >= 2 &&
                problem.options.every(option => typeof option === 'string' && option.length > 0) &&
                typeof problem.correctAnswer === 'string' && problem.correctAnswer.length > 0 &&
                problem.options.includes(problem.correctAnswer);
        case 'fill':
            return Array.isArray(problem.answers) && problem.answers.length > 0 &&
                Array.isArray(problem.questionParts) && problem.questionParts.length === problem.answers.length + 1 &&
                problem.answers.every(answer => typeof answer === 'string' && answer.length > 0) &&
                problem.questionParts.every(part => typeof part === 'string');
        default:
            return false;
    }
}

function parsePackText(rawText) {
    const chunks = String(rawText || '').trim().split('#').map(part => part.trim()).filter(Boolean);
    if (chunks.length === 0) throw new Error('問題データが空です。');
    const problems = parseText(rawText);
    if (problems.length === 0) throw new Error('有効な問題がありません。入力形式を確認してください。');
    if (problems.length !== chunks.length) throw new Error('形式不正の問題が含まれています。修正してから再度読み込んでください。');
    const invalidIndex = problems.findIndex(problem => !isValidPackProblem(problem));
    if (invalidIndex >= 0) throw new Error(`問題 ${invalidIndex + 1} の内部データが不完全です。問題形式を確認してください。`);
    return problems;
}
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

/**
 * MP4を端末標準の共有シートへ渡す。
 * iOSでは「ビデオを保存」など、Androidでは端末にある共有先が表示される。
 * Web Share API非対応・共有失敗時は従来のダウンロードへフォールバックする。
 */
async function shareOrDownloadVideo(blob, filename) {
    if (typeof File !== 'undefined' && typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function') {
        try {
            const file = new File([blob], filename, {
                type: 'video/mp4',
                lastModified: Date.now()
            });
            if (navigator.canShare({ files: [file] })) {
                try {
                    // 生成完了直後に呼び出し、ネイティブ共有UIへMP4を渡す。
                    await navigator.share({ files: [file], title: 'Q-One問題パック' });
                    return 'shared';
                } catch (error) {
                    // ユーザーが共有シートを閉じた場合、意図しないダウンロードは行わない。
                    if (error?.name === 'AbortError') return 'cancelled';
                    console.warn('[Q-One] ネイティブ共有を利用できないため、通常のダウンロードに切り替えます:', error);
                }
            }
        } catch (error) {
            console.warn('[Q-One] ファイル共有の事前判定に失敗しました:', error);
        }
    }

    triggerDownload(blob, filename);
    return 'downloaded';
}

// ============================================================================
// カメラプレビュー正方形レイアウト＆QR認識視覚フィードバック制御
// ============================================================================
function fitCameraPreview() {
    if (!cameraPreviewFrame) return;

    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width || document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = viewport?.height || document.documentElement.clientHeight || window.innerHeight;
    const modalContent = cameraPreviewFrame.closest('.camera-scan-modal-content');

    const contentStyle = modalContent ? getComputedStyle(modalContent) : null;
    const paddingLeft = parseFloat(contentStyle?.paddingLeft || '0') || 0;
    const paddingRight = parseFloat(contentStyle?.paddingRight || '0') || 0;
    const paddingTop = parseFloat(contentStyle?.paddingTop || '0') || 0;
    const paddingBottom = parseFloat(contentStyle?.paddingBottom || '0') || 0;

    // モーダル内でプレビュー以外の要素が占める高さを計測する。
    // 閉じるボタンはabsolute配置なので通常フローの高さに含めない。
    let reservedHeight = 0;
    if (modalContent) {
        for (const child of modalContent.children) {
            if (child === cameraPreviewFrame || child === cameraScanModal?.querySelector('.modal-close-btn')) {
                continue;
            }

            const style = getComputedStyle(child);
            if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') {
                continue;
            }

            const rect = child.getBoundingClientRect();
            reservedHeight += rect.height +
                (parseFloat(style.marginTop) || 0) +
                (parseFloat(style.marginBottom) || 0);
        }
    }

    const modalWidth = modalContent?.clientWidth
        ? modalContent.clientWidth - paddingLeft - paddingRight
        : viewportWidth * 0.92;

    const maxWidth = Math.max(88, Math.min(
        viewportWidth * 0.88,
        modalWidth,
        420
    ));

    const safeTop = parseFloat(getComputedStyle(cameraScanModal || document.body).paddingTop) || 0;
    const safeBottom = parseFloat(getComputedStyle(cameraScanModal || document.body).paddingBottom) || 0;
    const heightAvailableByLayout = viewportHeight -
        safeTop - safeBottom -
        paddingTop - paddingBottom -
        reservedHeight - 16;

    const maxHeight = Math.max(88, Math.min(
        viewportHeight * (viewportHeight <= 600 ? 0.40 : 0.50),
        heightAvailableByLayout,
        420
    ));

    // 短辺基準の解析領域に合わせ、プレビュー枠も常に1:1の正方形に統一する。
    const side = Math.max(88, Math.floor(Math.min(maxWidth, maxHeight)));
    if (!Number.isFinite(side) || side <= 0) return;

    cameraPreviewFrame.style.width = `${side}px`;
    cameraPreviewFrame.style.height = `${side}px`;

    if (cameraScanOverlay) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = Math.round(side * dpr);
        const targetH = Math.round(side * dpr);
        if (cameraScanOverlay.width !== targetW || cameraScanOverlay.height !== targetH) {
            cameraScanOverlay.width = targetW;
            cameraScanOverlay.height = targetH;
        }
    }
}

function clearScanOverlay() {
    if (overlayClearTimerId !== null) {
        clearTimeout(overlayClearTimerId);
        overlayClearTimerId = null;
    }
    cameraPreviewFrame?.classList.remove('is-detecting');
    if (!cameraScanOverlay) return;
    const ctx = cameraScanOverlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, cameraScanOverlay.width, cameraScanOverlay.height);
}

function drawScanOverlay(location, isNew = false, seqLabel = null) {
    if (!cameraScanOverlay || !location) {
        clearScanOverlay();
        return;
    }

    const width = cameraScanOverlay.width;
    const height = cameraScanOverlay.height;
    if (!width || !height) return;

    const ctx = cameraScanOverlay.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const pts = [
        location.topLeftCorner,
        location.topRightCorner,
        location.bottomRightCorner,
        location.bottomLeftCorner
    ].map(p => ({ x: p.x * width, y: p.y * height }));

    const strokeColor = isNew ? '#34D399' : '#38BDF8';
    const fillColor = isNew ? 'rgba(52, 211, 153, 0.22)' : 'rgba(56, 189, 248, 0.14)';

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.closePath();

    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.lineWidth = Math.max(3, Math.round(width * 0.01));
    ctx.strokeStyle = strokeColor;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 4隅のドットマーカー描画
    const dotRadius = Math.max(4, Math.round(width * 0.013));
    ctx.fillStyle = strokeColor;
    for (const pt of pts) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // 認識中のフレーム番号バッジをQR中央に表示
    if (seqLabel) {
        const centerX = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
        const centerY = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
        const fontSize = Math.max(13, Math.round(width * 0.045));
        ctx.font = `800 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        const textWidth = ctx.measureText(seqLabel).width;
        const padX = fontSize * 0.65;
        const boxW = textWidth + padX * 2;
        const boxH = fontSize * 1.65;
        const boxX = centerX - boxW / 2;
        const boxY = centerY - boxH / 2;
        const radius = boxH / 2;

        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, radius);
        ctx.fillStyle = 'rgba(17, 24, 39, 0.82)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = strokeColor;
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(seqLabel, centerX, centerY);
    }

    ctx.restore();

    cameraPreviewFrame?.classList.add('is-detecting');

    if (overlayClearTimerId !== null) clearTimeout(overlayClearTimerId);
    overlayClearTimerId = setTimeout(() => {
        clearScanOverlay();
    }, 550);
}

function triggerScanHitEffect() {
    if (!cameraPreviewFrame) return;
    cameraPreviewFrame.classList.remove('is-hit');
    // リフローを強制して連続ヒット時もアニメーションを再発火させる
    void cameraPreviewFrame.offsetWidth;
    cameraPreviewFrame.classList.add('is-hit');

    if (typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(28); } catch (_) { /* ignore */ }
    }

    if (hitHighlightTimerId !== null) clearTimeout(hitHighlightTimerId);
    hitHighlightTimerId = setTimeout(() => {
        cameraPreviewFrame?.classList.remove('is-hit');
    }, 360);
}

function resetPacketMapUI() {
    renderedPacketTotal = 0;
    if (hitHighlightTimerId !== null) {
        clearTimeout(hitHighlightTimerId);
        hitHighlightTimerId = null;
    }
    clearScanOverlay();
    cameraPreviewFrame?.classList.remove('is-hit', 'is-detecting');

    if (cameraPacketMap) {
        cameraPacketMap.innerHTML = '';
        cameraPacketMap.hidden = true;
    }
    if (cameraMissingSummary) {
        cameraMissingSummary.textContent = '';
        cameraMissingSummary.hidden = true;
    }
}

function updatePacketMapUI(details) {
    if (!details || !cameraPacketMap) return;
    const total = Number.isInteger(details.total) && details.total > 0 ? details.total : 0;
    if (total === 0) return;

    const wasHidden = cameraPacketMap.hidden;
    let layoutChanged = false;

    if (renderedPacketTotal !== total) {
        renderedPacketTotal = total;
        cameraPacketMap.innerHTML = '';
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < total; i++) {
            const tile = document.createElement('div');
            tile.className = 'packet-tile';
            tile.dataset.seq = String(i);
            tile.textContent = String(i + 1);
            tile.setAttribute('aria-label', `フレーム ${i + 1}: 未受信`);
            fragment.appendChild(tile);
        }
        cameraPacketMap.appendChild(fragment);
        cameraPacketMap.hidden = false;
        layoutChanged = true;
    } else if (wasHidden) {
        cameraPacketMap.hidden = false;
        layoutChanged = true;
    }

    const receivedSet = new Set(Array.isArray(details.receivedIndices) ? details.receivedIndices : []);
    const tiles = cameraPacketMap.querySelectorAll('.packet-tile');
    const missingNumbers = [];

    tiles.forEach((tile, index) => {
        const isReceived = receivedSet.has(index);
        if (isReceived) {
            if (!tile.classList.contains('is-received')) {
                tile.classList.add('is-received');
                tile.setAttribute('aria-label', `フレーム ${index + 1}: 受信済み`);
            }
        } else {
            missingNumbers.push(index + 1);
        }

        if (details.addedSeq === index) {
            tile.classList.remove('is-just-received');
            void tile.offsetWidth;
            tile.classList.add('is-just-received');
        }
    });

    if (cameraMissingSummary) {
        const wasSummaryHidden = cameraMissingSummary.hidden;
        if (missingNumbers.length === 0) {
            cameraMissingSummary.textContent = 'すべての番号を受信しました！';
            cameraMissingSummary.hidden = false;
        } else {
            const maxVisible = 12;
            const listed = missingNumbers.slice(0, maxVisible).map(n => `#${n}`).join(', ');
            const suffix = missingNumbers.length > maxVisible ? ` ほか${missingNumbers.length - maxVisible}枚` : '';
            cameraMissingSummary.textContent = `未受信（残り${missingNumbers.length}枚）: ${listed}${suffix}`;
            cameraMissingSummary.hidden = false;
        }
        if (wasSummaryHidden !== cameraMissingSummary.hidden) {
            layoutChanged = true;
        }
    }

    if (layoutChanged) {
        requestAnimationFrame(fitCameraPreview);
    }
}

function openPackImportChoice() {
    packImportChoiceModal?.classList.add('active');
}

function closePackImportChoice() {
    packImportChoiceModal?.classList.remove('active');
}

// ============================================================================
// モーダル・プレビュー制御
// ============================================================================
function getSelectedThemeColor() { return thumbnailThemeSelect?.value || 'blue'; }

function getSelectedSubject() {
    if (!thumbnailSubjectSelect) return '一般';
    return thumbnailSubjectSelect.value === '他'
        ? thumbnailSubjectCustom?.value.trim() || 'その他'
        : thumbnailSubjectSelect.value;
}

function updateThumbnailPreview() {
    if (!previewCard) return;
    const title = thumbnailTitleInput?.value.trim() || '問題パック';
    const category = getSelectedSubject();
    const theme = getSelectedThemeColor();
    const count = currentTargetProblems.length;
    const now = new Date();
    const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;

    previewCard.className = `q-card preview-card theme-${theme}`;
    if (previewBadge) previewBadge.textContent = category;
    if (previewTitle) previewTitle.innerHTML = escapeHtml(title).replace(/\n/g, '<br>');
    if (previewCount) previewCount.textContent = String(count);
    if (previewDate) previewDate.textContent = dateStr;
}

// 「他」が選ばれたら自由記述欄を表示
if (thumbnailSubjectSelect) {
    thumbnailSubjectSelect.addEventListener('change', () => {
        if (thumbnailSubjectCustom) thumbnailSubjectCustom.style.display = thumbnailSubjectSelect.value === '他' ? 'block' : 'none';
        updateThumbnailPreview();
    });
}

function openPackModal(mode, initialText = '', initialMeta = null) {
    currentModalMode = mode;
    
    if (mode === 'export' || mode === 'save_my_pack') {
        const text = inputText?.value.trim() || '';
        if (!text) {
            alert('問題データが入力されていません。\nテキストエリアに問題を入力してください。');
            return false;
        }
        try {
            currentTargetProblems = parsePackText(text);
        } catch (error) {
            alert(error.message);
            return false;
        }

        if (mode === 'export') {
            if (modalTitleText) modalTitleText.textContent = '問題パックを出力';
            if (modalSubtitleText) modalSubtitleText.textContent = '動画の先頭フレームに埋め込むサムネイルを設定します。';
            if (confirmPackModalBtn) confirmPackModalBtn.textContent = 'この設定でパックを出力';
        } else {
            if (modalTitleText) modalTitleText.textContent = 'マイ問題パックとして保存';
            if (modalSubtitleText) modalSubtitleText.textContent = 'カードの外観を設定し、問題パック一覧に追加・保存します。';
            if (confirmPackModalBtn) confirmPackModalBtn.textContent = 'パック一覧に保存';
        }
        
    } else if (mode === 'import_txt') {
        pendingImportRawText = initialText;
        try {
            currentTargetProblems = parsePackText(initialText);
        } catch (error) {
            alert(`TXTを問題パックとして登録できません。\n${error.message}`);
            return false;
        }

        if (modalTitleText) modalTitleText.textContent = 'テキストの読み込みと保存設定';
        if (modalSubtitleText) modalSubtitleText.textContent = 'このテキストファイルを問題パックとしてアプリ内に保存します。';
        if (confirmPackModalBtn) confirmPackModalBtn.textContent = 'パックとして保存 (一覧に追加)';
    }

    // 初期値のセット
    if (initialMeta) {
        if (thumbnailTitleInput) thumbnailTitleInput.value = initialMeta.title || '';
        const cat = initialMeta.category || '数学';
        // セレクトボックス内に存在するかチェック
        if (thumbnailSubjectSelect && [...thumbnailSubjectSelect.options].some(o => o.value === cat)) {
            thumbnailSubjectSelect.value = cat;
            if (thumbnailSubjectCustom) thumbnailSubjectCustom.style.display = 'none';
        } else {
            if (thumbnailSubjectSelect) thumbnailSubjectSelect.value = '他';
            if (thumbnailSubjectCustom) {
                thumbnailSubjectCustom.value = cat;
                thumbnailSubjectCustom.style.display = 'block';
            }
        }
        if (thumbnailThemeSelect) thumbnailThemeSelect.value = initialMeta.themeColor || 'blue';
    } else {
        if (thumbnailTitleInput && !thumbnailTitleInput.value) thumbnailTitleInput.value = `特訓問題パック (${currentTargetProblems.length}問)`;
    }

    updateThumbnailPreview();
    thumbnailModal?.classList.add('active');
    return true;
}
function closePackModal() { thumbnailModal?.classList.remove('active'); }

// ============================================================================
// 実行アクション (エクスポート or TXTインポート完了)
// ============================================================================
async function executeModalAction() {
    const title = thumbnailTitleInput?.value.trim() || '問題パック';
    const category = getSelectedSubject();
    const themeColor = getSelectedThemeColor();
    const count = currentTargetProblems.length;
    const meta = { title, category, themeColor, count, createdAt: Date.now() };

    closePackModal();

    if (currentModalMode === 'export') {
        const text = inputText?.value.trim() || '';
        if (!text) { alert('問題データが入力されていません。'); return; }
        showProgressModal('問題パックを作成中...');
        try {
            const videoBlob = await encodeToVideo(
                text,
                (ratio, message) => updateProgressUI(ratio, message),
                meta,
                { isCanceled: () => isProcessCanceled }
            );
            if (isProcessCanceled) throw Object.assign(new Error('ユーザーによってキャンセルされました。'), { name: 'AbortError' });
            updateProgressUI(1.0, '動画ファイルの生成が完了しました！');
            const filename = `${title.replace(/[\s\W]/g, '_')}_${Date.now()}.mp4`;
            // アプリ独自の自動再生モーダルは開かず、OS標準の共有シートを呼び出す。
            hideProgressModal();
            const saveResult = await shareOrDownloadVideo(videoBlob, filename);
            if (saveResult === 'downloaded') {
                alert('この端末では標準の共有シートを利用できないため、動画をダウンロードしました。');
            } else if (saveResult === 'cancelled') {
                console.info('[Q-One] 動画の共有・保存をキャンセルしました。');
            }
        } catch (err) {
            if (err?.name === 'AbortError' || isProcessCanceled) {
                if (progressStatus) progressStatus.textContent = 'キャンセルしました。';
                hideProgressModal();
            } else {
                console.error('[Q-One:Error] パック出力エラー:', err);
                hideProgressModal();
                alert(`問題パックの出力に失敗しました:\n${err.message || err}`);
            }
        }
    } else if (currentModalMode === 'import_txt' || currentModalMode === 'save_my_pack') {
        // TXTインポートおよび「マイ問題に保存」の場合、DBに直接保存
        try {
            const packId = createPackId();
            const targetText = currentModalMode === 'save_my_pack' ? (inputText?.value.trim() || '') : pendingImportRawText;
            if (!targetText) throw new Error('問題データが空です。');
            
            // packIdを各問題に付与
            const problemsWithPackId = currentTargetProblems.map((p, idx) => ({
                ...p,
                packId,
                questionId: p.questionId || `q_${idx + 1}`,
                revision: Number.isInteger(p.revision) ? p.revision : 1
            }));

            const packRecord = {
                id: packId,
                title: meta.title,
                category: meta.category,
                themeColor: meta.themeColor,
                rawText: targetText,
                problems: problemsWithPackId,
                count: meta.count,
                createdAt: meta.createdAt
            };

            await DB.put('packs', packRecord);
            const newCardEl = createPackCardElement(packRecord);
            newCardEl.setAttribute('data-dynamic', 'true');
            if (packGrid) packGrid.appendChild(newCardEl);

            // 自動選択
            newCardEl.click();
            alert(`問題パック「${title}」(${count}問) をマイ問題として保存しました！`);
        } catch (err) {
            console.error('[Q-One:Error] パック保存エラー:', err);
            alert(`問題パックの保存に失敗しました:\n${err.message || err}`);
        }
    }
}

// ============================================================================
// ファイルインポート分岐（MP4 / TXT）
// ============================================================================
export function createPackCardElement(pack) {
    const article = document.createElement('article');
    article.className = `q-card theme-${pack.themeColor || 'blue'}`;
    article.tabIndex = 0;
    article.setAttribute('role', 'button');
    article.setAttribute('aria-pressed', 'false');
    article.dataset.packId = pack.id;
    
    const now = new Date(pack.createdAt || Date.now());
    const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;

    article.innerHTML = `
        <div class="top">
            <div class="category-row">
                <span class="badge">${escapeHtml(pack.category || '一般')}</span>
                <span class="app-icon"><svg viewBox="0 0 52 46" fill="none" aria-hidden="true"><path d="M29.745 4.03c6.61-.463 12.345 4.522 12.807 11.133l1.2 17.148a.75.75 0 0 1-1.24.618L24.964 17.677a.75.75 0 0 1 .44-1.314l4.35-.305a2 2 0 0 1 1.452.486l6.846 5.951-.488-6.983a7 7 0 0 0-7.472-6.494l-15.96 1.116a1 1 0 0 0-.928 1.067l.418 5.985.034.36a7 7 0 0 0 7.437 6.135l7.154-.5a2 2 0 0 1 1.452.485l3.345 2.908a.75.75 0 0 1-.44 1.314l-11.162.78c-6.508.456-12.166-4.367-12.782-10.824l-.026-.309-.628-8.978a3 3 0 0 1 2.784-3.202z" fill="currentColor"/></svg></span>
            </div>
            <div class="card-title">${escapeHtml(pack.title || '無題のパック').replace(/\n/g, '<br>')}</div>
        </div>
        <div class="metric-row">
            <span class="main-symbol"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="13" y2="11"/></svg></span>
            <div class="metric-content"><span class="metric-number">${pack.count || 0}</span><span class="metric-unit">問</span></div>
        </div>
        <footer class="footer">
            <span class="status">LOADED PACK</span>
            <time>${dateStr}</time>
        </footer>
    `;

    const selectCard = () => {
        document.querySelectorAll('.pack-grid .q-card').forEach(card => {
            card.classList.remove('is-selected');
            card.setAttribute('aria-pressed', 'false');
        });
        article.classList.add('is-selected');
        article.setAttribute('aria-pressed', 'true');
        state.selectedPackData = pack;
        state.currentPackId = pack.id;
        const statusEl = document.getElementById('pack-file-status');
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = `選択中: ${pack.title} (${pack.problems?.length || 0}問)`;
        }
    };
    article.addEventListener('click', selectCard);
    article.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectCard();
        }
    });

    return article;
}

export async function loadSavedPacksFromDB() {
    if (!packGrid) return;
    try {
        await DB.initDB();
        const savedPacks = await DB.getAll('packs');
        const dynamicCards = packGrid.querySelectorAll('.q-card[data-dynamic="true"]');
        dynamicCards.forEach(c => c.remove());

        (savedPacks || []).forEach(pack => {
            const cardEl = createPackCardElement(pack);
            cardEl.setAttribute('data-dynamic', 'true');
            packGrid.appendChild(cardEl);
        });
    } catch (err) { console.error('[Q-One:Error] パック描画失敗:', err); }
}

async function registerPackFromRestoredText(rawRestoredText, fallbackTitle = '読み込んだ問題パック') {
    const { meta, text: pureText } = extractMetadataAndText(rawRestoredText);
    const parsedProblems = parsePackText(pureText);
    const packId = createPackId();
    const problemsWithPackId = parsedProblems.map((problem, index) => ({
        ...problem,
        packId,
        questionId: problem.questionId || `q_${index + 1}`,
        revision: Number.isInteger(problem.revision) ? problem.revision : 1
    }));

    const packRecord = {
        id: packId,
        title: meta?.title || fallbackTitle,
        category: meta?.category || '問題パック',
        themeColor: meta?.themeColor || 'blue',
        rawText: pureText,
        problems: problemsWithPackId,
        count: problemsWithPackId.length,
        createdAt: meta?.createdAt || Date.now()
    };

    await DB.put('packs', packRecord);
    const newCardEl = createPackCardElement(packRecord);
    newCardEl.setAttribute('data-dynamic', 'true');
    if (packGrid) packGrid.appendChild(newCardEl);
    if (inputText) inputText.value = pureText;
    return { packRecord, newCardEl };
}

function closeCameraScanModal() {
    isCameraScanCanceled = true;
    resetPacketMapUI();
    cameraScanModal?.classList.remove('active');
}

async function startCameraImport() {
    if (!packGrid) {
        alert('問題パック一覧が見つからないため、読み込みを開始できません。');
        return;
    }
    isCameraScanCanceled = false;
    resetPacketMapUI();
    if (cameraScanProgress) cameraScanProgress.style.width = '0%';
    if (cameraScanStatus) cameraScanStatus.textContent = 'カメラを起動しています...';
    if (cameraPreviewFrame) {
        cameraPreviewFrame.style.width = '';
        cameraPreviewFrame.style.height = '';
    }
    cameraScanModal?.classList.add('active');
    requestAnimationFrame(fitCameraPreview);

    try {
        const rawRestoredText = await decodeFromCamera(
            cameraScanVideo,
            (ratio, message, details) => {
                if (cameraScanProgress) cameraScanProgress.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
                if (message && cameraScanStatus) cameraScanStatus.textContent = message;

                if (details) {
                    if (details.qrDetected && details.location) {
                        const seqLabel = Number.isInteger(details.currentSeq)
                            ? `#${details.currentSeq + 1}${details.isNew ? ' NEW' : ' OK'}`
                            : 'QR検出';
                        drawScanOverlay(details.location, Boolean(details.isNew), seqLabel);
                    } else if (details.qrDetected === false) {
                        clearScanOverlay();
                    }

                    if (details.isNew) {
                        triggerScanHitEffect();
                    }

                    if (Number.isInteger(details.total) && details.total > 0) {
                        updatePacketMapUI(details);
                    }
                }
            },
            () => isCameraScanCanceled,
            cameraScanGuide
        );
        if (isCameraScanCanceled) throw Object.assign(new Error('ユーザーによってキャンセルされました。'), { name: 'AbortError' });
        resetPacketMapUI();
        cameraScanModal?.classList.remove('active');

        showProgressModal('問題パックを保存中...');
        if (progressCancelBtn) {
            progressCancelBtn.disabled = true;
            progressCancelBtn.style.display = 'none';
        }
        const { packRecord, newCardEl } = await registerPackFromRestoredText(rawRestoredText, 'カメラから読み込んだ問題パック');
        updateProgressUI(1, '復元・登録が完了しました。');
        setTimeout(() => {
            hideProgressModal();
            newCardEl?.click();
            alert(`「${packRecord.title}」(${packRecord.count}問) を読み込みました！`);
        }, 300);
    } catch (error) {
        resetPacketMapUI();
        cameraScanModal?.classList.remove('active');
        hideProgressModal();
        if (error?.name === 'AbortError' || isCameraScanCanceled) {
            console.info('[Q-One] カメラ読み取りを停止しました。');
        } else {
            console.error('[Q-One:Error] カメラ読み取りエラー:', error);
            alert(`カメラでの読み込みに失敗しました。\n${error.message || error}`);
        }
    }
}

async function handleImportPack(file) {
    if (!file) return;
    const extension = file.name.toLowerCase().split('.').pop();
    const isKnownExtension = ['txt', 'mp4', 'mov'].includes(extension);
    // 拡張子を優先し、拡張子が判定不能な場合だけMIMEタイプで補完する。
    const isText = extension === 'txt' || (!isKnownExtension && file.type === 'text/plain');
    const isVideo = ['mp4', 'mov'].includes(extension) ||
        (!isKnownExtension && ['video/mp4', 'video/quicktime'].includes(file.type));

    if (!isText && !isVideo) {
        alert('対応しているファイル形式は MP4・MOV・TXT です。');
        packFileInput.value = '';
        return;
    }

    if (isText) {
        try {
            const rawFileText = await file.text();
            const { meta, text: pureText } = extractMetadataAndText(rawFileText);
            openPackModal('import_txt', pureText, meta || { title: file.name.replace(/\.[^/.]+$/, '') });
        } catch (error) {
            console.error('[Q-One:Error] TXT読み込みエラー:', error);
            alert(`テキストファイルの読み込みに失敗しました。\n${error.message || error}`);
        } finally {
            packFileInput.value = '';
        }
        return;
    }

    if (!packGrid) {
        alert('問題パック一覧が見つからないため、読み込みを開始できません。');
        packFileInput.value = '';
        return;
    }

    showProgressModal('問題パックを解析中...');
    try {
        const rawRestoredText = await decodeFromVideo(
            file,
            (ratio, message) => updateProgressUI(ratio, message),
            () => isProcessCanceled
        );
        if (isProcessCanceled) throw Object.assign(new Error('ユーザーによってキャンセルされました。'), { name: 'AbortError' });
        updateProgressUI(0.95, 'データを検証中...');

        if (isProcessCanceled) throw Object.assign(new Error('ユーザーによってキャンセルされました。'), { name: 'AbortError' });
        // 保存処理に入った後は中断できないため、コミット中はキャンセル操作を無効化する。
        if (progressStatus) progressStatus.textContent = '問題パックを保存中...';
        if (progressCancelBtn) {
            progressCancelBtn.disabled = true;
            progressCancelBtn.style.display = 'none';
        }
        const fallbackTitle = file.name.replace(/\.[^/.]+$/, '');
        const { packRecord, newCardEl } = await registerPackFromRestoredText(rawRestoredText, fallbackTitle);

        updateProgressUI(1.0, '復元＆登録完了！');
        setTimeout(() => {
            hideProgressModal();
            newCardEl?.click();
            alert(`「${packRecord.title}」(${packRecord.count}問) を読み込みました！`);
        }, 300);
    } catch (error) {
        hideProgressModal();
        if (error?.name === 'AbortError' || isProcessCanceled) {
            console.info('[Q-One] 動画パックの読み込みをキャンセルしました。');
        } else {
            console.error('[Q-One:Error] 動画パック読み込みエラー:', error);
            alert(`読み込みに失敗しました:\n${error.message || error}`);
        }
    } finally {
        packFileInput.value = '';
    }
}

function initializeDemoPacks() {
    const demoDefinitions = [
        {
            id: 'qone_demo_math_v1',
            title: '高校数学Ⅰ・A 頻出公式・定理集',
            category: '数学',
            themeColor: 'blue',
            rawText: [
                '[enter]三角形の内角の和は何度か。@180_1',
                '[enter]二次方程式 x^2 - 5x + 6 = 0 の解を答えよ。@2, 3_2',
                '[select]円周角の定理として正しいものを選べ。@同じ弧に対する角の関係は？<円周角は中心角の半分>{円周角は中心角と等しい}_2'
            ].join('#\n')
        },
        {
            id: 'qone_demo_japanese_v1',
            title: '現代文・重要語句 必須キーワード',
            category: '現代文',
            themeColor: 'red',
            rawText: [
                '[select]「敷居が高い」の本来の意味として適切なのはどれか。@意味を選択せよ。<不義理などがあって、その人の家へ行きにくい>{高級で入りにくい}_2',
                '[enter]「姑息」の本来の意味を簡潔に答えよ。@一時しのぎ_2',
                '[check]文章の主題と筆者の主張を区別できるか。@主題は中心的話題、主張は筆者の考え。'
            ].join('#\n')
        }
    ];

    demoDefinitions.forEach(definition => {
        const card = packGrid?.querySelector(`[data-pack-id="${definition.id}"]`);
        if (!card) return;
        const problems = parsePackText(definition.rawText).map((problem, index) => ({
            ...problem,
            packId: definition.id,
            questionId: problem.questionId || `q_${index + 1}`
        }));
        const demoPack = {
            ...definition,
            rawText: definition.rawText,
            problems,
            count: problems.length,
            createdAt: null,
            isDemo: true
        };

        // 静的モックの架空日付・進捗を、実際のデモ内容に一致する表示へ置換する。
        const title = card.querySelector('.card-title');
        if (title) title.textContent = definition.title;
        const badge = card.querySelector('.category-row .badge');
        if (badge) badge.textContent = `DEMO / ${definition.category}`;
        const count = card.querySelector('.metric-number');
        if (count) count.textContent = String(problems.length);
        const detail = card.querySelector('.detail .excerpt');
        if (detail) detail.textContent = `収録内容: ${problems.length}問のデモ問題`;
        const status = card.querySelector('.footer .status');
        if (status) status.textContent = 'DEMO PACK';
        const time = card.querySelector('.footer time');
        if (time) time.textContent = '内蔵サンプル';
        const progress = card.querySelector('.donut-wrap');
        if (progress) progress.remove();
        const progressContent = card.querySelector('.metric-content');
        if (progressContent) progressContent.innerHTML = `<div class="metric-number">${problems.length}</div><div class="metric-unit">問</div>`;
        card.setAttribute('aria-label', `${definition.title}、デモ問題${problems.length}問`);
        card.addEventListener('click', () => {
            document.querySelectorAll('.pack-grid .q-card').forEach(other => {
                other.classList.remove('is-selected');
                other.setAttribute('aria-pressed', 'false');
            });
            card.classList.add('is-selected');
            card.setAttribute('aria-pressed', 'true');
            state.selectedPackData = demoPack;
            state.currentPackId = demoPack.id;
            const statusEl = document.getElementById('pack-file-status');
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.textContent = `選択中: ${demoPack.title} (${demoPack.count}問・デモ)`;
            }
        });
        card.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                card.click();
            }
        });
    });
}

// ============================================================================
// 初期化処理
// ============================================================================
export function initPackManager() {
    if (exportPackBtn) exportPackBtn.addEventListener('click', () => openPackModal('export'));
    if (saveMyProblemBtn) saveMyProblemBtn.addEventListener('click', () => openPackModal('save_my_pack'));

    if (thumbnailModal) {
        const overlay = thumbnailModal.querySelector('.modal-overlay');
        const closeBtn = thumbnailModal.querySelector('.modal-close-btn');
        if (overlay) overlay.addEventListener('click', closePackModal);
        if (closeBtn) closeBtn.addEventListener('click', closePackModal);
    }

    if (thumbnailTitleInput) thumbnailTitleInput.addEventListener('input', updateThumbnailPreview);
    if (thumbnailSubjectCustom) thumbnailSubjectCustom.addEventListener('input', updateThumbnailPreview);
    if (thumbnailThemeSelect) thumbnailThemeSelect.addEventListener('change', updateThumbnailPreview);

    if (confirmPackModalBtn) confirmPackModalBtn.addEventListener('click', executeModalAction);

    if (addPackBtn && packFileInput) {
        addPackBtn.addEventListener('click', openPackImportChoice);
        packFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleImportPack(file);
        });
    }

    packImportChoiceModal?.querySelectorAll('[data-close-import-choice]').forEach(element => {
        element.addEventListener('click', closePackImportChoice);
    });
    packImportFileBtn?.addEventListener('click', () => {
        closePackImportChoice();
        packFileInput?.click();
    });
    packImportCameraBtn?.addEventListener('click', () => {
        closePackImportChoice();
        startCameraImport();
    });

    cameraScanCancelBtn?.addEventListener('click', closeCameraScanModal);
    cameraScanCloseBtn?.addEventListener('click', closeCameraScanModal);
    cameraScanVideo?.addEventListener('loadedmetadata', fitCameraPreview);
    cameraScanVideo?.addEventListener('resize', fitCameraPreview);
    window.addEventListener('resize', fitCameraPreview, { passive: true });
    window.addEventListener('orientationchange', () => requestAnimationFrame(fitCameraPreview), { passive: true });
    window.visualViewport?.addEventListener('resize', fitCameraPreview, { passive: true });

    if (progressCancelBtn) {
        progressCancelBtn.addEventListener('click', () => {
            isProcessCanceled = true;
            if (progressStatus) progressStatus.textContent = 'キャンセル中...';
            progressCancelBtn.disabled = true;
            progressCancelBtn.style.display = 'none';
        });
    }

    initializeDemoPacks();
    loadSavedPacksFromDB();
}
