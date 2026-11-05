// ============================================================================
// 問題パック管理 UIコントローラー
// Phase 4: サムネイル設定モーダル & mockup準拠カード動的生成 & DB連携
// ============================================================================

import { encodeToVideo, decodeFromVideo, extractMetadataAndText } from './qr-video-core.js';
import * as DB from '../main/db.js';
import { parseText } from '../main/parser.js';
import { escapeHtml } from '../main/utils.js';

// DOM要素
const exportPackBtn = document.getElementById('export-pack-btn');
const addPackBtn = document.getElementById('add-pack-btn');
const packFileInput = document.getElementById('pack-file-input');
const inputText = document.getElementById('input-text');
const modeTextRadio = document.getElementById('mode-text');
const packGrid = document.querySelector('.pack-grid');

// サムネイル設定モーダル関連
const thumbnailModal = document.getElementById('pack-thumbnail-modal');
const thumbnailTitleInput = document.getElementById('thumbnail-title-input');
const thumbnailCategoryInput = document.getElementById('thumbnail-category-input');
const confirmExportPackBtn = document.getElementById('confirm-export-pack-btn');

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
let currentExportProblems = [];

// ============================================================================
// プログレスモーダル制御
// ============================================================================
function showProgressModal(title) {
    isProcessCanceled = false;
    progressTitle.textContent = title;
    progressBar.style.width = '0%';
    progressStatus.textContent = '準備中...';
    progressCancelBtn.style.display = 'inline-flex';
    progressModal.classList.add('active');
}

function hideProgressModal() {
    progressModal.classList.remove('active');
}

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
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 1000);
}

// ============================================================================
// サムネイル設定モーダル & リアルタイムプレビュー制御
// ============================================================================
function getSelectedThemeColor() {
    const checked = document.querySelector('input[name="thumbnail_theme"]:checked');
    return checked ? checked.value : 'blue';
}

function updateThumbnailPreview() {
    if (!previewCard) return;

    const title = thumbnailTitleInput.value.trim() || '問題パック';
    const category = thumbnailCategoryInput.value.trim() || '問題パック / 一般';
    const theme = getSelectedThemeColor();
    const count = currentExportProblems.length;
    const now = new Date();
    const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;

    // クラス切り替え (mockup HTML design-2 準拠)
    previewCard.className = `q-card preview-card theme-${theme}`;
    previewBadge.textContent = category;
    previewTitle.innerHTML = escapeHtml(title).replace(/\n/g, '<br>');
    previewCount.textContent = count;
    previewDate.textContent = dateStr;
}

function openThumbnailModal() {
    const text = inputText.value.trim();
    if (!text) {
        alert('出力する問題データが入力されていません。\nテキストエリアに問題を入力してください。');
        return;
    }

    currentExportProblems = parseText(text);
    if (currentExportProblems.length === 0) {
        alert('有効な問題形式が見つかりません。形式を確認してください。');
        return;
    }

    // デフォルト入力値のセット
    if (!thumbnailTitleInput.value) {
        thumbnailTitleInput.value = `特訓問題パック (${currentExportProblems.length}問)`;
    }
    if (!thumbnailCategoryInput.value) {
        thumbnailCategoryInput.value = '問題パック / 復習';
    }

    updateThumbnailPreview();
    thumbnailModal.classList.add('active');
}

function closeThumbnailModal() {
    thumbnailModal.classList.remove('active');
}

// ============================================================================
// パック出力実行
// ============================================================================
async function executeExportPack() {
    closeThumbnailModal();
    const text = inputText.value.trim();
    const title = thumbnailTitleInput.value.trim() || '問題パック';
    const category = thumbnailCategoryInput.value.trim() || '問題パック';
    const themeColor = getSelectedThemeColor();
    const count = currentExportProblems.length;

    showProgressModal('問題パックを作成中...');

    try {
        const options = { title, category, themeColor, count };
        const videoBlob = await encodeToVideo(text, (ratio, message) => {
            updateProgressUI(ratio, message);
        }, options);

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
}

// ============================================================================
// パックインポート & カード動的生成 (mockup HTML design-2 完全移植)
// ============================================================================
export function createPackCardElement(pack) {
    const article = document.createElement('article');
    article.className = `q-card theme-${pack.themeColor || 'blue'}`;
    article.tabIndex = 0;
    article.setAttribute('role', 'button');
    article.setAttribute('aria-pressed', 'false');
    article.dataset.packId = pack.id;
    
    const now = new Date(pack.createdAt || Date.now());
    const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    article.innerHTML = `
        <div class="top">
            <div class="category-row">
                <span class="badge">${escapeHtml(pack.category || '問題パック')}</span>
                <span class="app-icon"><svg viewBox="0 0 52 46" fill="none" aria-hidden="true"><path d="M29.745 4.03c6.61-.463 12.345 4.522 12.807 11.133l1.2 17.148a.75.75 0 0 1-1.24.618L24.964 17.677a.75.75 0 0 1 .44-1.314l4.35-.305a2 2 0 0 1 1.452.486l6.846 5.951-.488-6.983a7 7 0 0 0-7.472-6.494l-15.96 1.116a1 1 0 0 0-.928 1.067l.418 5.985.034.36a7 7 0 0 0 7.437 6.135l7.154-.5a2 2 0 0 1 1.452.485l3.345 2.908a.75.75 0 0 1-.44 1.314l-11.162.78c-6.508.456-12.166-4.367-12.782-10.824l-.026-.309-.628-8.978a3 3 0 0 1 2.784-3.202z" fill="currentColor"/></svg></span>
            </div>
            <div class="card-title">${escapeHtml(pack.title || '無題のパック')}</div>
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

    // カード選択・読み込みインタラクション
    article.addEventListener('click', () => {
        document.querySelectorAll('.pack-grid .q-card').forEach(c => {
            c.classList.remove('is-selected');
            c.setAttribute('aria-pressed', 'false');
        });
        article.classList.add('is-selected');
        article.setAttribute('aria-pressed', 'true');
        
        // テキストエリアに問題データを注入
        if (inputText && pack.rawText) {
            inputText.value = pack.rawText;
        }

        // スマホ画面等でスムーズに出題設定ができるよう通知
        const statusEl = document.getElementById('pack-file-status');
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.textContent = `選択中: ${pack.title} (${pack.count}問)`;
        }
    });

    return article;
}

// DBから保存済みパックをロードして一覧に描画
export async function loadSavedPacksFromDB() {
    if (!packGrid) return;
    try {
        await DB.initDB();
        const savedPacks = await DB.getAll('packs');
        
        // 既存の動的カードをクリア（追加タイルと初期サンプルは残す）
        const dynamicCards = packGrid.querySelectorAll('.q-card[data-dynamic="true"]');
        dynamicCards.forEach(c => c.remove());

        (savedPacks || []).forEach(pack => {
            const cardEl = createPackCardElement(pack);
            cardEl.setAttribute('data-dynamic', 'true');
            packGrid.appendChild(cardEl);
        });
        console.log(`[Q-One:Pack] 保存済みパック描画完了: ${savedPacks.length}件`);
    } catch (err) {
        console.error('[Q-One:Error] パック描画失敗:', err);
    }
}

// パック読み込み処理
async function handleImportPack(file) {
    if (!file) return;

    showProgressModal('問題パックを解析中...');

    try {
        const rawRestoredText = await decodeFromVideo(
            file,
            (ratio, message) => updateProgressUI(ratio, message),
            () => isProcessCanceled
        );

        updateProgressUI(0.95, 'メタデータを解析中...');
        
        // メタデータと純粋なテキストを分離
        const { meta, text: pureText } = extractMetadataAndText(rawRestoredText);
        const parsedProblems = parseText(pureText);

        const packId = `pack_${Date.now()}`;
        const packRecord = {
            id: packId,
            title: meta?.title || file.name.replace(/\.[^/.]+$/, ""),
            category: meta?.category || '問題パック / インポート',
            themeColor: meta?.themeColor || 'blue',
            rawText: pureText,
            problems: parsedProblems,
            count: parsedProblems.length,
            createdAt: meta?.createdAt || Date.now()
        };

        // IndexedDB の packs ストアに保存
        await DB.put('packs', packRecord);

        // ホーム画面のカード一覧に即座に追加
        const newCardEl = createPackCardElement(packRecord);
        newCardEl.setAttribute('data-dynamic', 'true');
        packGrid.appendChild(newCardEl);

        // テキスト入力欄に反映
        inputText.value = pureText;

        updateProgressUI(1.0, '復元＆登録完了！');

        setTimeout(() => {
            hideProgressModal();
            // 自動的に新カードを選択状態にする
            newCardEl.click();
            alert(`「${packRecord.title}」(${packRecord.count}問) を読み込み、問題パック一覧に追加しました！`);
        }, 500);

    } catch (err) {
        console.error('[Q-One:Error] パック読み込みエラー:', err);
        hideProgressModal();
        if (!isProcessCanceled) {
            alert(`問題パックの読み込みに失敗しました:\n${err.message || err}`);
        }
    } finally {
        packFileInput.value = '';
    }
}

// ============================================================================
// 初期化
// ============================================================================
export function initPackManager() {
    // パック出力ボタン -> サムネイルモーダル起動
    if (exportPackBtn) {
        exportPackBtn.addEventListener('click', openThumbnailModal);
    }

    // モーダル閉じるボタン・オーバーレイ
    if (thumbnailModal) {
        const overlay = thumbnailModal.querySelector('.modal-overlay');
        const closeBtn = thumbnailModal.querySelector('.modal-close-btn');
        if (overlay) overlay.addEventListener('click', closeThumbnailModal);
        if (closeBtn) closeBtn.addEventListener('click', closeThumbnailModal);
    }

    // プレビューのリアルタイム更新監視
    if (thumbnailTitleInput) {
        thumbnailTitleInput.addEventListener('input', updateThumbnailPreview);
    }
    if (thumbnailCategoryInput) {
        thumbnailCategoryInput.addEventListener('input', updateThumbnailPreview);
    }
    document.querySelectorAll('input[name="thumbnail_theme"]').forEach(r => {
        r.addEventListener('change', updateThumbnailPreview);
    });

    // 確定エクスポートボタン
    if (confirmExportPackBtn) {
        confirmExportPackBtn.addEventListener('click', executeExportPack);
    }

    // パック追加タイル -> ファイルダイアログ
    if (addPackBtn && packFileInput) {
        addPackBtn.addEventListener('click', () => packFileInput.click());
        packFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleImportPack(file);
        });
    }

    // キャンセルボタン
    if (progressCancelBtn) {
        progressCancelBtn.addEventListener('click', () => {
            isProcessCanceled = true;
            progressStatus.textContent = 'キャンセル中...';
            progressCancelBtn.style.display = 'none';
        });
    }

    // 初回起動時のDBパック一覧描画
    loadSavedPacksFromDB();
}
