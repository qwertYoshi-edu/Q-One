// ============================================================================
// 問題パック管理 UIコントローラー
// ============================================================================

import { encodeToVideo, decodeFromVideo, extractMetadataAndText, packageWithMetadata } from './qr-video-core.js';
import * as DB from '../main/db.js';
import { parseText } from '../main/parser.js';
import { escapeHtml } from '../main/utils.js';
import { state } from '../main/state.js';

// DOM要素
const exportPackBtn = document.getElementById('export-pack-btn');
const saveMyProblemBtn = document.getElementById('save-my-problem-btn');
const addPackBtn = document.getElementById('add-pack-btn');
const packFileInput = document.getElementById('pack-file-input');
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

// ============================================================================
// プログレスUI制御
// ============================================================================
function showProgressModal(title) {
    isProcessCanceled = false;
    progressTitle.textContent = title;
    progressBar.style.width = '0%';
    progressStatus.textContent = '準備中...';
    progressCancelBtn.style.display = 'inline-flex';
    progressModal.classList.add('active');
}
function hideProgressModal() { progressModal.classList.remove('active'); }
function updateProgressUI(ratio, message) {
    progressBar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    if (message) progressStatus.textContent = message;
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

// ============================================================================
// モーダル・プレビュー制御
// ============================================================================
function getSelectedThemeColor() { return thumbnailThemeSelect.value || 'blue'; }

function getSelectedSubject() {
    return thumbnailSubjectSelect.value === '他' 
        ? thumbnailSubjectCustom.value.trim() || 'その他'
        : thumbnailSubjectSelect.value;
}

function updateThumbnailPreview() {
    if (!previewCard) return;
    const title = thumbnailTitleInput.value.trim() || '問題パック';
    const category = getSelectedSubject();
    const theme = getSelectedThemeColor();
    const count = currentTargetProblems.length;
    const now = new Date();
    const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;

    previewCard.className = `q-card preview-card theme-${theme}`;
    previewBadge.textContent = category;
    previewTitle.innerHTML = escapeHtml(title).replace(/\n/g, '<br>');
    previewCount.textContent = count;
    previewDate.textContent = dateStr;
}

// 「他」が選ばれたら自由記述欄を表示
thumbnailSubjectSelect.addEventListener('change', () => {
    thumbnailSubjectCustom.style.display = thumbnailSubjectSelect.value === '他' ? 'block' : 'none';
    updateThumbnailPreview();
});

function openPackModal(mode, initialText = '', initialMeta = null) {
    currentModalMode = mode;
    
    if (mode === 'export' || mode === 'save_my_pack') {
        const text = inputText.value.trim();
        if (!text) {
            alert('問題データが入力されていません。\nテキストエリアに問題を入力してください。');
            return;
        }
        currentTargetProblems = parseText(text);
        if (currentTargetProblems.length === 0) {
            alert('有効な問題形式が見つかりません。形式を確認してください。');
            return;
        }

        if (mode === 'export') {
            modalTitleText.textContent = '問題パックを出力';
            modalSubtitleText.textContent = '動画の先頭フレームに埋め込むサムネイルを設定します。';
            confirmPackModalBtn.textContent = 'この設定でパックを出力';
        } else {
            modalTitleText.textContent = 'マイ問題パックとして保存';
            modalSubtitleText.textContent = 'カードの外観を設定し、問題パック一覧に追加・保存します。';
            confirmPackModalBtn.textContent = 'パック一覧に保存';
        }
        
    } else if (mode === 'import_txt') {
        pendingImportRawText = initialText;
        currentTargetProblems = parseText(initialText);
        
        modalTitleText.textContent = 'テキストの読み込みと保存設定';
        modalSubtitleText.textContent = 'このテキストファイルを問題パックとしてアプリ内に保存します。';
        confirmPackModalBtn.textContent = 'パックとして保存 (一覧に追加)';
    }

    // 初期値のセット
    if (initialMeta) {
        thumbnailTitleInput.value = initialMeta.title || '';
        const cat = initialMeta.category || '数学';
        // セレクトボックス内に存在するかチェック
        if ([...thumbnailSubjectSelect.options].some(o => o.value === cat)) {
            thumbnailSubjectSelect.value = cat;
            thumbnailSubjectCustom.style.display = 'none';
        } else {
            thumbnailSubjectSelect.value = '他';
            thumbnailSubjectCustom.value = cat;
            thumbnailSubjectCustom.style.display = 'block';
        }
        thumbnailThemeSelect.value = initialMeta.themeColor || 'blue';
    } else {
        if (!thumbnailTitleInput.value) thumbnailTitleInput.value = `特訓問題パック (${currentTargetProblems.length}問)`;
    }

    updateThumbnailPreview();
    thumbnailModal.classList.add('active');
}
function closePackModal() { thumbnailModal.classList.remove('active'); }

// ============================================================================
// 実行アクション (エクスポート or TXTインポート完了)
// ============================================================================
async function executeModalAction() {
    const title = thumbnailTitleInput.value.trim() || '問題パック';
    const category = getSelectedSubject();
    const themeColor = getSelectedThemeColor();
    const count = currentTargetProblems.length;
    const meta = { title, category, themeColor, count, createdAt: Date.now() };

    closePackModal();

    if (currentModalMode === 'export') {
        const text = inputText.value.trim();
        showProgressModal('問題パックを作成中...');
        try {
            const videoBlob = await encodeToVideo(text, (ratio, message) => updateProgressUI(ratio, message), meta);
            updateProgressUI(1.0, '動画ファイルの生成が完了しました！');
            const filename = `${title.replace(/[\s\W]/g, '_')}_${Date.now()}.mp4`;
            triggerDownload(videoBlob, filename);
            setTimeout(() => {
                hideProgressModal();
                alert(`問題パックを保存しました。\nファイル名: ${filename}`);
            }, 500);
        } catch (err) {
            console.error('[Q-One:Error] パック出力エラー:', err);
            hideProgressModal();
            alert(`問題パックの出力に失敗しました:\n${err.message || err}`);
        }
    } else if (currentModalMode === 'import_txt' || currentModalMode === 'save_my_pack') {
        // TXTインポートおよび「マイ問題に保存」の場合、DBに直接保存
        try {
            const packId = `pack_${Date.now()}`;
            const targetText = currentModalMode === 'save_my_pack' ? inputText.value.trim() : pendingImportRawText;
            
            // packIdを各問題に付与
            const problemsWithPackId = currentTargetProblems.map((p, idx) => ({
                ...p,
                packId: packId,
                questionId: p.questionId || `q_${idx + 1}`
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
            packGrid.appendChild(newCardEl);

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

    article.addEventListener('click', () => {
        document.querySelectorAll('.pack-grid .q-card').forEach(c => {
            c.classList.remove('is-selected');
            c.setAttribute('aria-pressed', 'false');
        });
        article.classList.add('is-selected');
        article.setAttribute('aria-pressed', 'true');
        
        // 状態を更新
        state.selectedPackData = pack;
        state.currentPackId = pack.id;

        const statusEl = document.getElementById('pack-file-status');
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = `選択中: ${pack.title} (${pack.count}問)`;
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

async function handleImportPack(file) {
    if (!file) return;

    if (file.name.toLowerCase().endsWith('.txt')) {
        // TXTファイルの場合
        try {
            const rawFileText = await file.text();
            const { meta, text: pureText } = extractMetadataAndText(rawFileText);
            
            // 初期のタイトル推測
            if (!meta) {
                openPackModal('import_txt', pureText, { title: file.name.replace(/\.[^/.]+$/, "") });
            } else {
                openPackModal('import_txt', pureText, meta);
            }
        } catch (err) {
            alert('テキストファイルの読み込みに失敗しました。');
        }
        packFileInput.value = '';
        return;
    }

    // MP4(動画QR)ファイルの場合
    showProgressModal('問題パックを解析中...');
    try {
        const rawRestoredText = await decodeFromVideo(
            file,
            (ratio, message) => updateProgressUI(ratio, message),
            () => isProcessCanceled
        );
        updateProgressUI(0.95, 'データを登録中...');
        
        const { meta, text: pureText } = extractMetadataAndText(rawRestoredText);
        const parsedProblems = parseText(pureText);

        const packRecord = {
            id: `pack_${Date.now()}`,
            title: meta?.title || file.name.replace(/\.[^/.]+$/, ""),
            category: meta?.category || '問題パック',
            themeColor: meta?.themeColor || 'blue',
            rawText: pureText,
            problems: parsedProblems,
            count: parsedProblems.length,
            createdAt: meta?.createdAt || Date.now()
        };

        await DB.put('packs', packRecord);
        const newCardEl = createPackCardElement(packRecord);
        newCardEl.setAttribute('data-dynamic', 'true');
        packGrid.appendChild(newCardEl);
        inputText.value = pureText;

        updateProgressUI(1.0, '復元＆登録完了！');
        setTimeout(() => {
            hideProgressModal();
            newCardEl.click();
            alert(`「${packRecord.title}」(${packRecord.count}問) を読み込みました！`);
        }, 500);
    } catch (err) {
        console.error('[Q-One:Error] 動画パック読み込みエラー:', err);
        hideProgressModal();
        if (!isProcessCanceled) alert(`読み込みに失敗しました:\n${err.message || err}`);
    } finally {
        packFileInput.value = '';
    }
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
        addPackBtn.addEventListener('click', () => packFileInput.click());
        packFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleImportPack(file);
        });
    }

    if (progressCancelBtn) {
        progressCancelBtn.addEventListener('click', () => {
            isProcessCanceled = true;
            progressStatus.textContent = 'キャンセル中...';
            progressCancelBtn.style.display = 'none';
        });
    }

    loadSavedPacksFromDB();
}
