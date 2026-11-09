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
    if (progressTitle) progressTitle.textContent = title;
    if (progressBar) progressBar.style.width = '0%';
    if (progressStatus) progressStatus.textContent = '準備中...';
    if (progressCancelBtn) { progressCancelBtn.style.display = 'inline-flex'; progressCancelBtn.disabled = false; }
    progressModal?.classList.add('active');
}
function hideProgressModal() {
    progressModal?.classList.remove('active');
    if (progressCancelBtn) { progressCancelBtn.style.display = 'inline-flex'; progressCancelBtn.disabled = false; }
}
function updateProgressUI(ratio, message) {
    if (progressBar) progressBar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    if (message && progressStatus) progressStatus.textContent = message;
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
    if (previewCount) previewCount.textContent = count;
    if (previewDate) previewDate.textContent = dateStr;
}

// 「他」が選ばれたら自由記述欄を表示
thumbnailSubjectSelect?.addEventListener('change', () => {
    if (thumbnailSubjectCustom) thumbnailSubjectCustom.style.display = thumbnailSubjectSelect.value === '他' ? 'block' : 'none';
    updateThumbnailPreview();
});

function openPackModal(mode, initialText = '', initialMeta = null) {
    if (!thumbnailModal || !thumbnailTitleInput || !thumbnailSubjectSelect || !thumbnailThemeSelect || !confirmPackModalBtn) {
        console.error('[Q-One:DOM] 問題パック設定モーダルの必須要素が不足しています。');
        alert('問題パック設定画面を開けません。HTMLとJavaScriptのバージョンを確認してください。');
        return;
    }
    currentModalMode = mode;

    if (mode === 'export' || mode === 'save_my_pack') {
        const text = inputText?.value.trim() || '';
        if (!text) {
            alert('問題データが入力されていません。\nテキストエリアに問題を入力してください。');
            return;
        }
        try {
            currentTargetProblems = parseText(text, 'manual_input', { strict: true });
        } catch (error) {
            alert(`問題データの形式が正しくありません。\n${error.message || error}`);
            return;
        }
        if (currentTargetProblems.length === 0) {
            alert('有効な問題形式が見つかりません。形式を確認してください。');
            return;
        }

        if (mode === 'export') {
            if (modalTitleText) modalTitleText.textContent = '問題パックを出力';
            if (modalSubtitleText) modalSubtitleText.textContent = '動画の先頭フレームに埋め込むサムネイルを設定します。';
            confirmPackModalBtn.textContent = 'この設定でパックを出力';
        } else {
            if (modalTitleText) modalTitleText.textContent = 'マイ問題パックとして保存';
            if (modalSubtitleText) modalSubtitleText.textContent = 'カードの外観を設定し、問題パック一覧に追加・保存します。';
            confirmPackModalBtn.textContent = 'パック一覧に保存';
        }
    } else if (mode === 'import_txt') {
        pendingImportRawText = initialText;
        try {
            currentTargetProblems = parseText(initialText, 'manual_input', { strict: true });
        } catch (error) {
            alert(`テキストファイルの問題形式が正しくありません。\n${error.message || error}`);
            return;
        }
        if (currentTargetProblems.length === 0) {
            alert('有効な問題が見つかりません。ファイル形式と問題記法を確認してください。');
            return;
        }
        if (modalTitleText) modalTitleText.textContent = 'テキストの読み込みと保存設定';
        if (modalSubtitleText) modalSubtitleText.textContent = 'このテキストファイルを問題パックとしてアプリ内に保存します。';
        confirmPackModalBtn.textContent = 'パックとして保存 (一覧に追加)';
    } else {
        console.error('[Q-One:Pack] 不明なモーダルモード:', mode);
        return;
    }

    if (initialMeta) {
        thumbnailTitleInput.value = initialMeta.title || '';
        const cat = initialMeta.category || '数学';
        if ([...thumbnailSubjectSelect.options].some(o => o.value === cat)) {
            thumbnailSubjectSelect.value = cat;
            if (thumbnailSubjectCustom) thumbnailSubjectCustom.style.display = 'none';
        } else {
            thumbnailSubjectSelect.value = '他';
            if (thumbnailSubjectCustom) {
                thumbnailSubjectCustom.value = cat;
                thumbnailSubjectCustom.style.display = 'block';
            }
        }
        thumbnailThemeSelect.value = initialMeta.themeColor || 'blue';
    } else if (!thumbnailTitleInput.value) {
        thumbnailTitleInput.value = `特訓問題パック (${currentTargetProblems.length}問)`;
    }

    confirmPackModalBtn.disabled = false;
    updateThumbnailPreview();
    thumbnailModal.classList.add('active');
}
function closePackModal() { thumbnailModal?.classList.remove('active'); }

// ============================================================================
// 実行アクション (エクスポート or TXTインポート完了)
// ============================================================================
async function executeModalAction() {
    if (confirmPackModalBtn?.disabled) return;
    if (confirmPackModalBtn) confirmPackModalBtn.disabled = true;
    const title = thumbnailTitleInput?.value.trim() || '問題パック';
    const category = getSelectedSubject();
    const themeColor = getSelectedThemeColor();
    const count = currentTargetProblems.length;
    const meta = { title, category, themeColor, count, createdAt: Date.now() };

    closePackModal();
    try {
        if (currentModalMode === 'export') {
            const text = inputText?.value.trim() || '';
            if (!text) throw new Error('出力する問題データが見つかりません。');
            showProgressModal('問題パックを作成中...');
            try {
                const videoBlob = await encodeToVideo(text, (ratio, message) => updateProgressUI(ratio, message), {
                    ...meta,
                    isCanceled: () => isProcessCanceled
                });
                updateProgressUI(1.0, '動画ファイルの生成が完了しました！');
                const filename = `${title.replace(/[\s\W]/g, '_')}_${Date.now()}.mp4`;
                triggerDownload(videoBlob, filename);
                setTimeout(() => {
                    hideProgressModal();
                    alert(`問題パックを保存しました。\nファイル名: ${filename}`);
                }, 500);
            } catch (err) {
                if (err?.name === 'AbortError' || isProcessCanceled) {
                    console.info('[Q-One:Generator] 動画生成をキャンセルしました。');
                    hideProgressModal();
                    alert('動画生成をキャンセルしました。ファイルは出力されていません。');
                } else {
                    console.error('[Q-One:Error] パック出力エラー:', err);
                    hideProgressModal();
                    alert(`問題パックの出力に失敗しました:\n${err.message || err}`);
                }
            }
        } else if (currentModalMode === 'import_txt' || currentModalMode === 'save_my_pack') {
            const packId = createPackId();
            const targetText = currentModalMode === 'save_my_pack' ? (inputText?.value.trim() || '') : pendingImportRawText;
            const problemsWithPackId = currentTargetProblems.map((problem, index) => ({
                ...problem,
                packId,
                questionId: problem.questionId || `q_${index + 1}`,
                revision: Number(problem.revision) || 1
            }));
            const packRecord = {
                id: packId,
                title: meta.title,
                category: meta.category,
                themeColor: meta.themeColor,
                rawText: targetText,
                problems: problemsWithPackId,
                count: problemsWithPackId.length,
                createdAt: meta.createdAt
            };
            await DB.put('packs', packRecord);
            const newCardEl = createPackCardElement(packRecord);
            newCardEl.setAttribute('data-dynamic', 'true');
            packGrid?.appendChild(newCardEl);
            newCardEl.click();
            alert(`問題パック「${title}」(${count}問) をマイ問題として保存しました！`);
        }
    } catch (err) {
        console.error('[Q-One:Error] 問題パック処理エラー:', err);
        alert(`問題パックの処理に失敗しました:\n${err.message || err}`);
    } finally {
        if (confirmPackModalBtn) confirmPackModalBtn.disabled = false;
    }
}

// ============================================================================
// ファイルインポート分岐（MP4 / TXT）
// ============================================================================
function createPackId() {
    return globalThis.crypto?.randomUUID
        ? `pack_${globalThis.crypto.randomUUID()}`
        : `pack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDemoPacks() {
    const definitions = [
        {
            id: 'math-sample', title: '高校数学Ⅰ・A 頻出公式・定理集', category: '数学', themeColor: 'blue',
            text: [
                '[enter]二次方程式 ax²+bx+c=0 の判別式は？@b²-4ac_2',
                '[select]sin²θ+cos²θ の値は？@三角関数の基本関係を確認。<0>{1}',
                '[check]等差数列の公差は、隣り合う項の差である。@正しい_1'
            ].join('#')
        },
        {
            id: 'japanese-sample', title: '古典・重要語句 学習デモ', category: '古典', themeColor: 'red',
            text: [
                '[enter]古文「いとをかし」の意味は？@とても趣がある_2',
                '[select]「あはれ」の意味として適切なものは？@意味を選択。<大きな声>{しみじみとした趣}',
                '[check]係り結びでは、係助詞に応じて文末が特定の活用形になる。@正しい_2'
            ].join('#')
        }
    ];
    return definitions.map(definition => {
        const problems = parseText(definition.text, definition.id, { strict: true }).map(problem => ({
            ...problem,
            packId: definition.id,
            questionId: problem.questionId,
            revision: 1
        }));
        return { ...definition, rawText: definition.text, problems, count: problems.length, createdAt: 0, isDemo: true };
    });
}

function selectPackCard(card, pack) {
    if (!pack || !Array.isArray(pack.problems) || pack.problems.length === 0) {
        alert('この問題パックには有効な問題がありません。');
        return;
    }
    packGrid?.querySelectorAll('.q-card').forEach(other => {
        other.classList.toggle('is-selected', other === card);
        other.setAttribute('aria-pressed', String(other === card));
    });
    state.selectedPackData = pack;
    state.currentPackId = pack.id;
    const status = document.getElementById('pack-file-status');
    if (status) {
        status.style.display = 'block';
        status.textContent = `選択中: ${pack.title} (${pack.problems.length}問)`;
    }
}

function bindPackCard(card, pack) {
    if (!card || card.dataset.selectionBound === 'true') return;
    card.dataset.selectionBound = 'true';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', 'false');
    card.addEventListener('click', () => selectPackCard(card, pack));
    card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectPackCard(card, pack);
        }
    });
}

export function createPackCardElement(pack) {
    const article = document.createElement('article');
    article.className = `q-card theme-${pack.themeColor || 'blue'}`;
    article.tabIndex = 0;
    article.setAttribute('role', 'button');
    article.setAttribute('aria-pressed', 'false');
    article.dataset.packId = pack.id;
    
    const problemCount = Array.isArray(pack.problems) ? pack.problems.length : 0;
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
            <div class="metric-content"><span class="metric-number">${problemCount}</span><span class="metric-unit">問</span></div>
        </div>
        <footer class="footer">
            <span class="status">LOADED PACK</span>
            <time>${dateStr}</time>
        </footer>
    `;

    bindPackCard(article, pack);
    return article;
}

export async function loadSavedPacksFromDB() {
    if (!packGrid) return;
    const demoPackMap = new Map(createDemoPacks().map(pack => [pack.id, pack]));
    packGrid.querySelectorAll('.q-card[data-pack-id]').forEach(card => {
        const demoPack = demoPackMap.get(card.dataset.packId);
        if (demoPack) bindPackCard(card, demoPack);
    });
    try {
        await DB.initDB();
        const savedPacks = await DB.getAll('packs');
        packGrid.querySelectorAll('.q-card[data-dynamic="true"]').forEach(card => card.remove());

        const savedIds = new Set((savedPacks || []).map(pack => pack?.id).filter(Boolean));
        packGrid.querySelectorAll('.q-card[data-pack-id]').forEach(card => {
            if (savedIds.has(card.dataset.packId)) card.remove();
        });
        (savedPacks || []).forEach(pack => {
            if (!pack?.id || !Array.isArray(pack.problems) || pack.problems.length === 0) {
                console.warn('[Q-One:Pack] 不正な保存済みパックを表示から除外しました:', pack?.id);
                return;
            }
            const cardEl = createPackCardElement(pack);
            cardEl.setAttribute('data-dynamic', 'true');
            packGrid.appendChild(cardEl);
        });
    } catch (err) {
        console.error('[Q-One:Error] パック描画失敗:', err);
        const status = document.getElementById('pack-file-status');
        if (status) {
            status.style.display = 'block';
            status.textContent = '保存済みパックを読み込めませんでした。デモパックは引き続き利用できます。';
        }
    }
}

async function handleImportPack(file) {
    if (!file) return;

    const extension = file.name.toLowerCase().split('.').pop();
    if (extension === 'txt') {
        try {
            const rawFileText = await file.text();
            const { meta, text: pureText } = extractMetadataAndText(rawFileText);
            const parsed = parseText(pureText, 'manual_input', { strict: true });
            if (parsed.length === 0) throw new Error('有効な問題が0件です。');
            openPackModal('import_txt', pureText, meta || { title: file.name.replace(/\.[^/.]+$/, '') });
        } catch (err) {
            console.error('[Q-One:Pack] TXT読み込み拒否:', err);
            alert(`テキストファイルを問題パックとして読み込めません。\n${err.message || err}`);
        } finally {
            packFileInput.value = '';
        }
        return;
    }

    if (!['mp4', 'mov'].includes(extension)) {
        alert('対応形式は MP4・MOV・TXT です。');
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
        updateProgressUI(0.95, 'データを登録中...');
        
        const { meta, text: pureText } = extractMetadataAndText(rawRestoredText);
        const parsedProblems = parseText(pureText, 'manual_input', { strict: true });
        if (parsedProblems.length === 0) throw new Error('動画内に有効な問題がありません。');

        const packId = createPackId();
        const problemsWithPackId = parsedProblems.map((problem, index) => ({
            ...problem, packId, questionId: problem.questionId || `q_${index + 1}`, revision: Number(problem.revision) || 1
        }));
        const packRecord = {
            id: packId,
            title: meta?.title || file.name.replace(/\.[^/.]+$/, ""),
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
        packGrid?.appendChild(newCardEl);
        inputText.value = pureText;

        updateProgressUI(1.0, '復元＆登録完了！');
        if (progressCancelBtn) progressCancelBtn.style.display = 'none';
        setTimeout(() => {
            hideProgressModal();
            newCardEl.click();
            alert(`「${packRecord.title}」(${packRecord.count}問) を読み込みました！`);
        }, 500);
    } catch (err) {
        console.error('[Q-One:Error] 動画パック読み込みエラー:', err);
        hideProgressModal();
        if (isProcessCanceled || err?.name === 'AbortError') {
            alert('動画の読み込みをキャンセルしました。');
        } else {
            alert(`読み込みに失敗しました:\n${err.message || err}`);
        }
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
            if (isProcessCanceled || progressCancelBtn.disabled) return;
            isProcessCanceled = true;
            if (progressStatus) progressStatus.textContent = 'キャンセル中...';
            progressCancelBtn.disabled = true;
        });
    }

    loadSavedPacksFromDB();
}
