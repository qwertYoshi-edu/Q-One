import { state } from './state.js';
import {
    screens, mainScreen, intermediateScreen, toggleIncorrectListBtn, listOverlay, toggleIncorrectListBtnMain,
    listOverlayMain, helpBtn, helpModal, copyIncorrectBtn, copyModal, copyTextarea,
    startBtn, finalCheckBtn, retryIncorrectBtn, retryAllBtn, retryFinalCheckBtn,
    restartCompletelyBtn, endRetryAllBtn, endRestartBtn, fillRateSlider, fillRateValue,
    homeBtn, interimReviewBtn, interimReviewPanelBtn, packCards, inputModeRadios, inputPanels,
    settingsBtn, settingsModal, darkModeToggle, fontSizeSlider, fontSizeValue,
    exportDataBtn, importDataBtn, importDataInput, resetDataBtn, profileBtn, profileModal, profileNameInput,
    mobileSettingsFab, settingsStack, closeSettingsBtn
} from './dom.js';

import { openProfileModal, saveUsername } from './profile.js';
import {
    startGame, startNewPass, retryIncorrect, retryAll, restartGame,
    startInterimReview, endInterimReview
} from './quiz.js';
import { setupModal, switchScreen, showIntermediateResults } from './ui.js';
import { reconstructProblemString } from './parser.js';
import { initPackManager } from '../generator/pack-manager.js';
import { initAnalysisModule, renderAnalysisDashboard } from './analysis.js';
import { initHistoryModule } from './history.js';
import * as DB from './db.js';

// 中間結果画面の誤答リスト開閉
if (toggleIncorrectListBtn) {
    toggleIncorrectListBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!intermediateScreen) return;
        intermediateScreen.classList.toggle('list-open');
        toggleIncorrectListBtn.innerHTML = intermediateScreen.classList.contains('list-open') ? '&lt;' : '&gt;';
    });
}
if (listOverlay) listOverlay.addEventListener('click', () => intermediateScreen?.classList.remove('list-open'));

// 出題画面の誤答リスト開閉
if (toggleIncorrectListBtnMain) {
    toggleIncorrectListBtnMain.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!mainScreen) return;
        mainScreen.classList.toggle('list-open');
        toggleIncorrectListBtnMain.innerHTML = mainScreen.classList.contains('list-open') ? '&lt;' : '&gt;';
    });
}
if (listOverlayMain) listOverlayMain.addEventListener('click', () => mainScreen?.classList.remove('list-open'));

// ヘルプモーダル
helpBtn?.addEventListener('click', () => helpModal?.classList.add('active'));
setupModal(helpModal);

// 誤答コピーモーダル
copyIncorrectBtn?.addEventListener('click', () => {
    const incorrectProblemsText = state.reviewList.map(reconstructProblemString).join('#\n');
    if (!copyTextarea || !copyModal) {
        console.error('[Q-One:DOM] 誤答コピー用モーダルの要素が不足しています。');
        alert('誤答コピー画面を開けません。');
        return;
    }
    copyTextarea.value = incorrectProblemsText;
    copyModal.classList.add('active');
});
setupModal(copyModal);
copyTextarea?.addEventListener('click', function() { this.select(); });

// ゲーム制御ボタン
startBtn?.addEventListener('click', () => startGame(false));
finalCheckBtn?.addEventListener('click', () => startGame(true));
retryIncorrectBtn?.addEventListener('click', retryIncorrect);
retryAllBtn?.addEventListener('click', retryAll);
retryFinalCheckBtn?.addEventListener('click', () => {
    state.isFinalCheckMode = true;
    startNewPass(state.originalWordList, false, { mode: 'final_check', sourceSessionId: state.currentSessionId });
});
restartCompletelyBtn?.addEventListener('click', restartGame);
endRetryAllBtn?.addEventListener('click', retryAll);
endRestartBtn?.addEventListener('click', restartGame);
fillRateSlider?.addEventListener('input', (e) => { if (fillRateValue) fillRateValue.textContent = e.target.value; });

// ヘッダー操作
homeBtn?.addEventListener('click', () => {
    if (confirm('最初の画面に戻りますか？\n（入力した問題や設定は保持されます）')) {
        if (state.isInterimReview) endInterimReview(false);
        switchScreen('setup', showIntermediateResults);
    }
});

interimReviewBtn?.addEventListener('click', () => {
    if (state.isInterimReview) {
        if (confirm('復習を中断して元の問題に戻りますか？')) endInterimReview(true);
    } else {
        startInterimReview();
    }
});
interimReviewPanelBtn?.addEventListener('click', startInterimReview);

// 問題パックカードの選択は pack-manager.js が実データと一体で管理する。

// 入力モードタブ切替時のアニメーション制御
inputModeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
        if (inputPanels) {
            inputPanels.querySelectorAll('.panel').forEach((panel) => { panel.style.animation = 'none'; });
            requestAnimationFrame(() => {
                const active = inputPanels.querySelector('.panel[style*="display: block"]');
                if (active) active.style.animation = '';
            });
        }
    });
});

// ============================================================================
// プロフィールモーダル管理
// ============================================================================
if (profileBtn) {
    profileBtn.addEventListener('click', () => openProfileModal());
}
setupModal(profileModal);

if (profileNameInput) {
    profileNameInput?.addEventListener('change', (e) => {
        saveUsername(e.target.value).catch(error => {
            console.error('[Q-One:Error] ユーザー名の保存に失敗しました:', error);
            alert('ユーザー名を保存できませんでした。');
        });
    });
    profileNameInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            profileNameInput.blur();
        }
    });
}

// ============================================================================
// モバイル版：設定スライドイン（オーバーレイ）の制御
// ============================================================================
if (mobileSettingsFab) {
    mobileSettingsFab?.addEventListener('click', () => {
        settingsStack?.classList.add('is-open');
    });
}
if (closeSettingsBtn) {
    closeSettingsBtn?.addEventListener('click', () => {
        settingsStack?.classList.remove('is-open');
    });
}
document.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.history-retry-actions .retry-action')) {
        if (window.innerWidth <= 899) {
            settingsStack?.classList.add('is-open');
        }
    }
});
startBtn?.addEventListener('click', () => {
    settingsStack?.classList.remove('is-open');
});
finalCheckBtn?.addEventListener('click', () => {
    settingsStack?.classList.remove('is-open');
});

// ============================================================================
// 設定モーダル & データベース管理・データ入出力処理
// ============================================================================
async function loadSettings() {
    try {
        await DB.initDB();
        const themeSetting = await DB.get('user_settings', 'theme');
        const fontSizeSetting = await DB.get('user_settings', 'fontSize');

        const isDark = themeSetting ? themeSetting.value === 'dark' : false;
        if (darkModeToggle) darkModeToggle.checked = isDark;
        applyTheme(isDark);

        const fontSize = fontSizeSetting ? fontSizeSetting.value : 100;
        if (fontSizeSlider) fontSizeSlider.value = fontSize;
        if (fontSizeValue) fontSizeValue.textContent = fontSize;
        applyFontSize(fontSize);
    } catch (e) {
        console.error('[Q-One:Error] 設定の読み込みに失敗しました', e);
    }
}

function applyTheme(isDark) {
    if (isDark) {
        document.documentElement.dataset.theme = 'dark';
    } else {
        delete document.documentElement.dataset.theme;
    }
}

function applyFontSize(percent) {
    document.documentElement.style.fontSize = `${16 * (percent / 100)}px`;
}

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => settingsModal?.classList.add('active'));
}
setupModal(settingsModal);

darkModeToggle?.addEventListener('change', async (e) => {
    const isDark = e.target.checked;
    applyTheme(isDark);
    try {
        await DB.put('user_settings', { key: 'theme', value: isDark ? 'dark' : 'light' });
    } catch (error) {
        console.error('[Q-One:Error] テーマ設定の保存に失敗しました:', error);
        alert('テーマ設定を保存できませんでした。');
    }
});

fontSizeSlider?.addEventListener('input', (e) => {
    const val = e.target.value;
    if (fontSizeValue) fontSizeValue.textContent = val;
    applyFontSize(val);
});

fontSizeSlider?.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10);
    try {
        await DB.put('user_settings', { key: 'fontSize', value: val });
    } catch (error) {
        console.error('[Q-One:Error] 文字サイズ設定の保存に失敗しました:', error);
        alert('文字サイズ設定を保存できませんでした。');
    }
});

// JSONバックアップ形式 v1。旧形式（各ストア配列がルート直下にある形式）も読み込む。
const BACKUP_FORMAT = 'qone-backup';
const BACKUP_VERSION = 1;

function validateBackupProblem(problem, label) {
    const validTypes = ['check', 'select', 'enter', 'fill'];
    if (!problem || typeof problem !== 'object' || Array.isArray(problem) ||
        !validTypes.includes(problem.type) || typeof problem.largeText !== 'string' || !problem.largeText.trim()) {
        throw new Error(`${label} の形式または問題文が不正です。`);
    }
    if (problem.type === 'select' && (
        !Array.isArray(problem.options) || problem.options.length < 2 ||
        problem.options.some(option => typeof option !== 'string' || !option.trim()) ||
        typeof problem.correctAnswer !== 'string' || !problem.options.includes(problem.correctAnswer)
    )) {
        throw new Error(`${label} の選択肢データが不正です。`);
    }
    if (problem.type === 'enter' && (typeof problem.correctAnswer !== 'string' || !problem.correctAnswer.trim())) {
        throw new Error(`${label} の正解データが不正です。`);
    }
    if (problem.type === 'check' && (typeof problem.smallText !== 'string' || !problem.smallText.trim())) {
        throw new Error(`${label} の確認文が不正です。`);
    }
    if (problem.type === 'fill' && (
        !Array.isArray(problem.answers) || problem.answers.length === 0 ||
        problem.answers.some(answer => typeof answer !== 'string' || !answer.trim()) ||
        !Array.isArray(problem.questionParts) ||
        problem.questionParts.length !== problem.answers.length + 1 ||
        problem.questionParts.some(part => typeof part !== 'string')
    )) {
        throw new Error(`${label} の穴埋めデータが不正です。`);
    }
}

function validateBackupRecord(storeName, record, index) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`${storeName}[${index}] がオブジェクトではありません。`);
    }
    const keyPath = DB.STORE_KEY_PATHS[storeName];
    const key = record[keyPath];
    if (typeof key !== 'string' || !key.trim()) {
        throw new Error(`${storeName}[${index}] に必須キー '${keyPath}' がありません。`);
    }

    if (storeName === 'packs') {
        if (!Array.isArray(record.problems) || record.problems.length === 0) {
            throw new Error(`packs[${index}].problems は1件以上の問題を含む配列である必要があります。`);
        }
        record.problems.forEach((problem, problemIndex) => validateBackupProblem(
            problem,
            `packs[${index}].problems[${problemIndex}]`
        ));
    }
    if (storeName === 'test_sessions') {
        if (!Number.isFinite(record.startedAt) || !Number.isFinite(record.totalQuestions) || record.totalQuestions < 0 ||
            typeof record.packId !== 'string' || !record.packId.trim()) {
            throw new Error(`test_sessions[${index}] に開始日時、総問題数、または問題パックIDがありません。`);
        }
        ['totalQuestions', 'answeredCount', 'attemptCount', 'correctCount', 'checkAnsweredCount', 'checkOKCount', 'checkReviewCount', 'totalTimeMs'].forEach(field => {
            if (record[field] !== undefined && (!Number.isFinite(record[field]) || record[field] < 0)) {
                throw new Error(`test_sessions[${index}].${field} が不正です。`);
            }
        });
        if (record.problemSnapshot !== undefined && !Array.isArray(record.problemSnapshot)) {
            throw new Error(`test_sessions[${index}].problemSnapshot は配列である必要があります。`);
        }
        if (Array.isArray(record.problemSnapshot)) {
            record.problemSnapshot.forEach((problem, problemIndex) => validateBackupProblem(
                problem,
                `test_sessions[${index}].problemSnapshot[${problemIndex}]`
            ));
        }
        if (record.packIds !== undefined && (!Array.isArray(record.packIds) || record.packIds.some(id => typeof id !== 'string'))) {
            throw new Error(`test_sessions[${index}].packIds が不正です。`);
        }
    }
    if (storeName === 'answer_logs') {
        if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) {
            throw new Error(`answer_logs[${index}].sessionId がありません。`);
        }
        if (typeof record.isCorrect !== 'boolean') {
            throw new Error(`answer_logs[${index}].isCorrect が真偽値ではありません。`);
        }
        if (!Number.isFinite(record.timestamp)) {
            throw new Error(`answer_logs[${index}].timestamp が不正です。`);
        }
        if (![record.problemId, record.questionId, record.problemKey].some(value => typeof value === 'string' && value.trim())) {
            throw new Error(`answer_logs[${index}] に問題識別情報がありません。`);
        }
        if (record.timeMs !== undefined && (!Number.isFinite(record.timeMs) || record.timeMs < 0)) {
            throw new Error(`answer_logs[${index}].timeMs が不正です。`);
        }
    }
    if (storeName === 'problem_stats') {
        ['totalAnswers', 'correctAnswers'].forEach(field => {
            if (!Number.isFinite(record[field]) || record[field] < 0) {
                throw new Error(`problem_stats[${index}].${field} が不正です。`);
            }
        });
    }
    if (storeName === 'fsrs_states') {
        if (typeof record.packId !== 'string' || !record.packId.trim() ||
            typeof record.questionId !== 'string' || !record.questionId.trim()) {
            throw new Error(`fsrs_states[${index}] に問題パックまたは問題IDがありません。`);
        }
        ['stability', 'difficulty', 'reps', 'lapses', 'intervalDays', 'due'].forEach(field => {
            if (!Number.isFinite(record[field])) {
                throw new Error(`fsrs_states[${index}].${field} が不正です。`);
            }
        });
    }
}

function normalizeAndValidateBackup(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('JSONのルートはオブジェクトである必要があります。');
    }
    if (data.format !== undefined && data.format !== BACKUP_FORMAT) {
        throw new Error('Q-Oneのバックアップファイルではありません。');
    }
    if (data.format === BACKUP_FORMAT && (data.version !== BACKUP_VERSION || typeof data.exportedAt !== 'string' || !Number.isFinite(Date.parse(data.exportedAt)))) {
        throw new Error('バックアップのバージョンまたはエクスポート日時が不正です。');
    }
    if (data.version !== undefined && (!Number.isInteger(data.version) || data.version > BACKUP_VERSION || data.version < 1)) {
        throw new Error(`未対応のバックアップバージョンです: ${data.version}`);
    }
    if (data.databaseVersion !== undefined && (!Number.isInteger(data.databaseVersion) || data.databaseVersion > DB.DB_VERSION || data.databaseVersion < 1)) {
        throw new Error(`未対応のデータベースバージョンです: ${data.databaseVersion}`);
    }

    const source = data.stores && typeof data.stores === 'object' && !Array.isArray(data.stores)
        ? data.stores
        : data;
    const storeNames = Object.keys(DB.STORE_KEY_PATHS);
    const unknownStores = Object.keys(source).filter(name => !storeNames.includes(name) && !['format', 'version', 'databaseVersion', 'exportedAt'].includes(name));
    if (unknownStores.length) throw new Error(`未対応のデータストアが含まれています: ${unknownStores.join(', ')}`);
    if (data.format === BACKUP_FORMAT && storeNames.some(name => !Object.prototype.hasOwnProperty.call(source, name))) {
        throw new Error('バックアップに必要なデータストアが不足しています。');
    }
    const hasKnownStore = storeNames.some(name => Object.prototype.hasOwnProperty.call(source, name));
    if (!hasKnownStore) throw new Error('対応するデータストアが見つかりません。');

    const normalized = {};
    storeNames.forEach(storeName => {
        const records = source[storeName] === undefined ? [] : source[storeName];
        if (!Array.isArray(records)) throw new Error(`${storeName} は配列である必要があります。`);
        const keys = new Set();
        records.forEach((record, index) => {
            validateBackupRecord(storeName, record, index);
            const key = record[DB.STORE_KEY_PATHS[storeName]];
            if (keys.has(key)) throw new Error(`${storeName} に重複したキー '${key}' があります。`);
            keys.add(key);
        });
        normalized[storeName] = records;
    });
    return normalized;
}

// JSONエクスポート
exportDataBtn?.addEventListener('click', async () => {
    try {
        const stores = await DB.exportAllData();
        const data = {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            databaseVersion: DB.DB_VERSION,
            exportedAt: new Date().toISOString(),
            stores
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `QOne_Backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        console.error('[Q-One:Error] エクスポートエラー:', error);
        alert(`エクスポートに失敗しました。\n${error.message || error}`);
    }
});

// JSONインポート
importDataBtn?.addEventListener('click', () => importDataInput?.click());

importDataInput?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        const parsed = JSON.parse(await file.text());
        // 既存DBを変更する前に、全ストアと全レコードを検証する。
        const normalized = normalizeAndValidateBackup(parsed);
        const sourceStores = parsed.stores && typeof parsed.stores === 'object' ? parsed.stores : parsed;
        if (parsed.format === undefined && !Object.prototype.hasOwnProperty.call(sourceStores, 'fsrs_states')) {
            normalized.fsrs_states = await DB.getAll('fsrs_states');
        }
        const summary = Object.entries(normalized).map(([name, records]) => `${name}: ${records.length}件`).join('\n');
        if (!confirm(`バックアップを復元します。現在の全データは置き換えられます。\n\n${summary}\n\n続行しますか？`)) return;

        await DB.replaceAllData(normalized);
        alert('インポートが完了しました。設定を反映するためページを再読み込みします。');
        location.reload();
    } catch (error) {
        console.error('[Q-One:Error] インポートエラー:', error);
        alert(`インポートに失敗しました。既存データは変更されていません。\n${error.message || error}`);
    } finally {
        importDataInput.value = '';
    }
});

// 全データリセット
resetDataBtn?.addEventListener('click', async () => {
    if (!confirm('【警告】問題パック・学習履歴・解答ログ・復習スケジュール・設定のすべてが削除されます。本当に実行しますか？')) return;
    try {
        await DB.clearAllData();
        alert('全データをリセットしました。ページを再読み込みします。');
        location.reload();
    } catch (error) {
        console.error('[Q-One:Error] リセットエラー:', error);
        alert(`リセット処理中にエラーが発生しました。\n${error.message || error}`);
    }
});

// ============================================================================
// アプリケーション起動
// ============================================================================
const requiredStartupElements = [
    ['setup-screen', screens.setup],
    ['main-screen', screens.main],
    ['intermediate-screen', screens.intermediate],
    ['end-screen', screens.end],
    ['input-text', document.getElementById('input-text')],
    ['mode-pack', document.getElementById('mode-pack')],
    ['start-btn', startBtn],
    ['final-check-btn', finalCheckBtn],
    ['check-view', document.getElementById('check-view')],
    ['select-view', document.getElementById('select-view')],
    ['enter-view', document.getElementById('enter-view')],
    ['fill-view', document.getElementById('fill-view')],
    ['feedback-container', document.getElementById('feedback-container')],
    ['feedback-text', document.getElementById('feedback-text')],
    ['action-btn', document.getElementById('action-btn')],
    ['check-button-container', document.getElementById('check-button-container')],
    ['ok-btn', document.getElementById('ok-btn')],
    ['review-btn', document.getElementById('review-btn')],
    ['select-options-container', document.getElementById('select-options-container')],
    ['enter-input', document.getElementById('enter-input')],
    ['fill-content', document.getElementById('fill-content')],
    ['post-answer-buttons', document.getElementById('post-answer-buttons')],
    ['check-view .large-text', screens.main?.querySelector('#check-view .large-text')],
    ['check-view .small-text', screens.main?.querySelector('#check-view .small-text')],
    ['select-view .large-text', screens.main?.querySelector('#select-view .large-text')],
    ['enter-view .large-text', screens.main?.querySelector('#enter-view .large-text')],
    ['fill-view .large-text', screens.main?.querySelector('#fill-view .large-text')],
    ['self-grading-container', document.getElementById('self-grading-container')],
    ['self-grading-info', document.getElementById('self-grading-info')],
    ['self-grade-correct-btn', document.getElementById('self-grade-correct-btn')],
    ['self-grade-incorrect-btn', document.getElementById('self-grade-incorrect-btn')]
];
const missingStartupElements = requiredStartupElements.filter(([, element]) => !element).map(([id]) => id);
if (missingStartupElements.length) {
    const errorPanel = document.createElement('section');
    errorPanel.setAttribute('role', 'alert');
    errorPanel.style.cssText = 'margin:1rem;padding:1rem;border:2px solid #dc2626;border-radius:8px;color:#b91c1c;background:#fff;';
    errorPanel.textContent = `Q-Oneの初期化に必要なHTML要素が見つかりません: ${missingStartupElements.join(', ')}。HTMLとJavaScriptのバージョンを確認してください。`;
    document.body.prepend(errorPanel);
    console.error('[Q-One:DOM] 必須要素が不足しています:', missingStartupElements);
    if (startBtn) startBtn.disabled = true;
    if (finalCheckBtn) finalCheckBtn.disabled = true;
} else {
    loadSettings();
    initPackManager();
    initAnalysisModule();
    initHistoryModule();
    screens.setup.classList.add('visible');
}
