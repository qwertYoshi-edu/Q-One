// ============================================================================
// 問題パック管理 UIコントローラー
// ============================================================================

import { encodeToVideo, decodeFromVideo, extractMetadataAndText } from './qr-video-core.js';
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
            triggerDownload(videoBlob, filename);
            setTimeout(() => {
                hideProgressModal();
                alert(`問題パックを保存しました。\nファイル名: ${filename}`);
            }, 500);
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
            title: meta?.title || file.name.replace(/\.[^/.]+$/, ''),
            category: meta?.category || '問題パック',
            themeColor: meta?.themeColor || 'blue',
            rawText: pureText,
            problems: problemsWithPackId,
            count: problemsWithPackId.length,
            createdAt: meta?.createdAt || Date.now()
        };

        if (isProcessCanceled) throw Object.assign(new Error('ユーザーによってキャンセルされました。'), { name: 'AbortError' });
        // 保存処理に入った後は中断できないため、コミット中はキャンセル操作を無効化する。
        if (progressStatus) progressStatus.textContent = '問題パックを保存中...';
        if (progressCancelBtn) {
            progressCancelBtn.disabled = true;
            progressCancelBtn.style.display = 'none';
        }
        await DB.put('packs', packRecord);
        const newCardEl = createPackCardElement(packRecord);
        newCardEl.setAttribute('data-dynamic', 'true');
        packGrid.appendChild(newCardEl);
        if (inputText) inputText.value = pureText;

        updateProgressUI(1.0, '復元＆登録完了！');
        setTimeout(() => {
            hideProgressModal();
            newCardEl.click();
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
        addPackBtn.addEventListener('click', () => packFileInput.click());
        packFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleImportPack(file);
        });
    }

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
