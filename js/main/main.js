import { state } from './state.js';
import {
    screens, mainScreen, intermediateScreen, toggleIncorrectListBtn, listOverlay, toggleIncorrectListBtnMain,
    listOverlayMain, helpBtn, helpModal, copyIncorrectBtn, copyModal, copyTextarea,
    startBtn, finalCheckBtn, retryIncorrectBtn, retryAllBtn, retryFinalCheckBtn,
    restartCompletelyBtn, endRetryAllBtn, endRestartBtn, fillRateSlider, fillRateValue,
    homeBtn, interimReviewBtn, interimReviewPanelBtn, inputModeRadios, inputPanels,
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
import { getReviewOverview, getScheduledReviewCheckpoint, saveScheduledReviewCheckpoint } from './review.js';

const BACKUP_FORMAT = 'q-one-backup';
const BACKUP_VERSION = 1;
const dailyReviewButton = document.getElementById('start-daily-review-btn');
const dailyReviewStatus = document.getElementById('review-home-status');
const dailyReviewDueCount = document.getElementById('review-home-due-count');
const reviewNotificationDot = document.getElementById('home-review-notification-dot');
const reviewNotificationDescription = document.getElementById('home-review-notification-description');
const homeTabRadio = document.getElementById('mode-analysis');
let reviewRefreshTimer = null;
let dailyReviewRefreshSequence = 0;
const dataInfoOpenButton = document.getElementById('open-data-info-btn');
const dataInfoCloseButton = document.getElementById('close-data-info-btn');
const STORE_KEY_FIELDS = Object.freeze({
    packs: 'id',
    test_sessions: 'id',
    answer_logs: 'id',
    problem_stats: 'problemId',
    fsrs_states: 'id',
    user_settings: 'key'
});

document.querySelectorAll('.modal').forEach(modal => setupModal(modal));

function listen(element, eventName, handler) {
    if (element) element.addEventListener(eventName, handler);
}

function initializeFeature(name, callback) {
    try {
        callback();
    } catch (error) {
        console.error(`[Q-One:InitError] ${name} の初期化に失敗しました:`, error);
        showInitializationError(`${name} の初期化に失敗しました。`, error);
    }
}

function showInitializationError(message, error) {
    let panel = document.getElementById('qone-initialization-error');
    if (!panel) {
        panel = document.createElement('section');
        panel.id = 'qone-initialization-error';
        panel.setAttribute('role', 'alert');
        panel.style.cssText = 'position:fixed;z-index:99999;left:12px;right:12px;top:12px;padding:16px;border:1px solid #d33;border-radius:8px;background:#fff;color:#222;box-shadow:0 4px 20px rgba(0,0,0,.18);font:14px/1.6 system-ui,sans-serif;white-space:pre-wrap;';
        document.body.appendChild(panel);
    }
    panel.textContent = `${message}\n${error?.message || String(error || '')}\n開発者はコンソールの [Q-One:InitError] を確認してください。`;
}

function validateRequiredDOM() {
    const requiredIds = [
        'setup-screen', 'main-screen', 'intermediate-screen', 'end-screen',
        'input-text', 'start-btn', 'final-check-btn',
        'check-view', 'select-view', 'enter-view', 'fill-view',
        'select-options-container', 'enter-input', 'fill-content',
        'check-button-container', 'ok-btn', 'review-btn',
        'action-btn', 'feedback-container', 'feedback-text',
        'post-answer-buttons', 'next-problem-btn', 'retry-current-problem-btn', 'add-to-review-btn',
        'self-grading-container', 'self-grading-info', 'self-grade-correct-btn', 'self-grade-incorrect-btn',
        'progress-bar', 'progress-text'
    ];
    const missing = requiredIds.filter(id => !document.getElementById(id));
    const missingChildren = ['check-view', 'select-view', 'enter-view', 'fill-view']
        .filter(id => !document.getElementById(id)?.querySelector('.large-text'))
        .map(id => `#${id} .large-text`);
    if (!document.getElementById('check-view')?.querySelector('.small-text')) missingChildren.push('#check-view .small-text');
    if (!document.getElementById('select-view')?.querySelector('.small-text')) missingChildren.push('#select-view .small-text');
    const allMissing = [...missing, ...missingChildren];
    if (allMissing.length > 0) {
        const error = new Error(`必須DOM要素が見つかりません: ${allMissing.map(id => id.startsWith('#') ? id : `#${id}`).join(', ')}`);
        console.error('[Q-One:InitError] 必須DOM検証失敗:', error);
        showInitializationError('アプリの初期化を中止しました。HTMLの必須要素が欠落しています。', error);
        return false;
    }
    return true;
}

// 中間結果画面・出題画面の誤答リスト開閉
listen(toggleIncorrectListBtn, 'click', event => {
    event.stopPropagation();
    intermediateScreen?.classList.toggle('list-open');
    if (toggleIncorrectListBtn && intermediateScreen) {
        toggleIncorrectListBtn.innerHTML = intermediateScreen.classList.contains('list-open') ? '&lt;' : '&gt;';
    }
});
listen(listOverlay, 'click', () => intermediateScreen?.classList.remove('list-open'));

listen(toggleIncorrectListBtnMain, 'click', event => {
    event.stopPropagation();
    mainScreen?.classList.toggle('list-open');
    if (toggleIncorrectListBtnMain && mainScreen) {
        toggleIncorrectListBtnMain.innerHTML = mainScreen.classList.contains('list-open') ? '&lt;' : '&gt;';
    }
});
listen(listOverlayMain, 'click', () => mainScreen?.classList.remove('list-open'));

// ヘルプ・誤答コピー
listen(helpBtn, 'click', () => helpModal?.classList.add('active'));
listen(copyIncorrectBtn, 'click', () => {
    if (!copyTextarea || !copyModal) return;
    const incorrectProblemsText = state.reviewList.map(reconstructProblemString).filter(Boolean).join('#\n');
    copyTextarea.value = incorrectProblemsText;
    copyModal.classList.add('active');
});
listen(copyTextarea, 'click', function() { this.select(); });

// 復習通知は既存の復習スケジュールを参照し、due <= 現在時刻の問題がある場合だけ表示する。
function updateReviewTabNotification(dueCount) {
    const hasDueReview = Number(dueCount) > 0;
    if (reviewNotificationDot) reviewNotificationDot.hidden = !hasDueReview;
    if (reviewNotificationDescription) {
        reviewNotificationDescription.textContent = hasDueReview ? '復習できる問題があります。' : '';
    }
}

function scheduleNextReviewRefresh(nextDueAt) {
    if (reviewRefreshTimer !== null) {
        clearTimeout(reviewRefreshTimer);
        reviewRefreshTimer = null;
    }
    const dueAt = Number(nextDueAt);
    if (!Number.isFinite(dueAt) || dueAt <= Date.now()) return;
    const delay = Math.min(Math.max(dueAt - Date.now() + 50, 1000), 2147480000);
    reviewRefreshTimer = setTimeout(() => {
        reviewRefreshTimer = null;
        refreshDailyReviewHome();
    }, delay);
}

// ホーム表示時・データ更新時に、今日の復習とタブ通知を同じスケジュールから更新する。
async function refreshDailyReviewHome() {
    if (!dailyReviewButton) return;
    const refreshSequence = ++dailyReviewRefreshSequence;
    dailyReviewButton.disabled = true;
    if (dailyReviewStatus) dailyReviewStatus.textContent = '復習予定を確認しています。';
    try {
        const [overview, checkpoint] = await Promise.all([
            getReviewOverview(),
            getScheduledReviewCheckpoint()
        ]);
        if (refreshSequence !== dailyReviewRefreshSequence) return;
        const remainingCheckpoint = checkpoint ? Math.max(0, checkpoint.questions.length - checkpoint.index) : 0;
        if (dailyReviewDueCount) {
            dailyReviewDueCount.textContent = String(checkpoint ? remainingCheckpoint : overview.todayTargetCount);
        }
        updateReviewTabNotification(overview.overdueCount);
        scheduleNextReviewRefresh(overview.nextDueAt);

        dailyReviewButton.disabled = overview.queue.length === 0 && !checkpoint;
        dailyReviewButton.textContent = checkpoint
            ? '復習を続きから再開'
            : overview.queue.length > 0
                ? '今日の復習を始める'
                : '今すぐ復習できる問題はありません';

        if (dailyReviewStatus) {
            const unavailable = overview.unavailableCount > 0
                ? '一部の問題を読み込めません。問題パックを確認してください。'
                : '';
            dailyReviewStatus.textContent = checkpoint
                ? `前回の続きが ${remainingCheckpoint} 問あります。${unavailable}`
                : overview.queue.length > 0
                    ? `今日の復習を始められます。${unavailable}`
                    : overview.todayTargetCount > 0
                        ? `今日取り組む問題は ${overview.todayTargetCount} 問あります。復習時刻になったら開始できます。${unavailable}`
                        : '今日は復習する問題はありません。';
        }
    } catch (error) {
        if (refreshSequence !== dailyReviewRefreshSequence) return;
        console.error('[Q-One:Review] 復習予定の取得に失敗:', error);
        updateReviewTabNotification(0);
        scheduleNextReviewRefresh(null);
        if (dailyReviewStatus) dailyReviewStatus.textContent = '復習予定を読み込めませんでした。ページを再読み込みしてください。';
        dailyReviewButton.disabled = true;
    }
}

async function startDailyReview() {
    if (!dailyReviewButton || dailyReviewButton.disabled) return;
    dailyReviewButton.disabled = true;
    if (dailyReviewStatus) dailyReviewStatus.textContent = '復習問題を準備しています。';
    try {
        const checkpoint = await getScheduledReviewCheckpoint();
        if (checkpoint) {
            startNewPass(checkpoint.questions, true, {
                mode: 'scheduled_review',
                resumeIndex: checkpoint.index,
                range: '前回の続き'
            });
            return;
        }
        const overview = await getReviewOverview();
        if (!overview.queue.length) {
            if (dailyReviewStatus) {
                dailyReviewStatus.textContent = overview.unavailableCount > 0
                    ? '復習予定の問題を読み込めませんでした。問題パックを確認してください。'
                    : overview.todayTargetCount > 0
                        ? `今日取り組む問題は ${overview.todayTargetCount} 問あります。復習時刻になったら開始できます。`
                        : '今日は復習する問題はありません。';
            }
            dailyReviewButton.disabled = true;
            return;
        }
        await saveScheduledReviewCheckpoint(overview.queue, 0);
        startNewPass(overview.queue, true, { mode: 'scheduled_review', range: '今日の復習' });
    } catch (error) {
        console.error('[Q-One:Review] 今日の復習開始に失敗:', error);
        if (dailyReviewStatus) dailyReviewStatus.textContent = '復習を開始できませんでした。もう一度お試しください。';
        dailyReviewButton.disabled = false;
    }
}

listen(dailyReviewButton, 'click', startDailyReview);

// 学習記録・復習予定・問題パックが更新されたら、表示中のホームも通知も再集計する。
const HOME_REFRESH_STORES = new Set(['packs', 'test_sessions', 'answer_logs', 'problem_stats', 'fsrs_states']);
document.addEventListener('qone:data-changed', event => {
    const changedStores = event.detail?.stores || [];
    if (!changedStores.some(storeName => HOME_REFRESH_STORES.has(storeName))) return;
    refreshDailyReviewHome();
    if (homeTabRadio?.checked) renderAnalysisDashboard();
});

listen(homeTabRadio, 'change', () => {
    if (!homeTabRadio.checked) return;
    refreshDailyReviewHome();
    renderAnalysisDashboard();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        refreshDailyReviewHome();
        if (homeTabRadio?.checked) renderAnalysisDashboard();
    }
});
window.addEventListener('focus', () => refreshDailyReviewHome());
window.addEventListener('pageshow', () => refreshDailyReviewHome());

// 学習操作
listen(startBtn, 'click', () => startGame(false));
listen(finalCheckBtn, 'click', () => startGame(true));
listen(retryIncorrectBtn, 'click', retryIncorrect);
listen(retryAllBtn, 'click', retryAll);
listen(retryFinalCheckBtn, 'click', () => {
    state.isFinalCheckMode = true;
    startNewPass(state.originalWordList, false, { mode: 'final_check' });
});
listen(restartCompletelyBtn, 'click', restartGame);
listen(endRetryAllBtn, 'click', retryAll);
listen(endRestartBtn, 'click', restartGame);
listen(fillRateSlider, 'input', event => {
    if (fillRateValue) fillRateValue.textContent = event.target.value;
});

listen(homeBtn, 'click', () => {
    if (confirm('最初の画面に戻りますか？\n（入力した問題や設定は保持されます）')) {
        if (state.isInterimReview) endInterimReview(false);
        switchScreen('setup', showIntermediateResults);
        refreshDailyReviewHome();
    }
});

listen(interimReviewBtn, 'click', () => {
    if (state.isInterimReview) {
        if (confirm('復習を中断して元の問題に戻りますか？')) endInterimReview(true);
    } else {
        startInterimReview();
    }
});
listen(interimReviewPanelBtn, 'click', startInterimReview);

// 入力モードタブ切替時のアニメーション制御
(inputModeRadios || []).forEach(radio => {
    listen(radio, 'change', () => {
        if (!inputPanels) return;
        inputPanels.querySelectorAll('.panel').forEach(panel => { panel.style.animation = 'none'; });
        requestAnimationFrame(() => {
            const active = inputPanels.querySelector('.panel[style*="display: block"]');
            if (active) active.style.animation = '';
        });
    });
});

// プロフィール
listen(profileBtn, 'click', () => openProfileModal().catch(error => {
    console.error('[Q-One:Error] プロフィール表示エラー:', error);
    alert(`プロフィールを読み込めませんでした: ${error.message || error}`);
}));
listen(profileNameInput, 'change', event => {
    saveUsername(event.target.value).catch(error => console.error('[Q-One:Error] ユーザー名保存エラー:', error));
});
listen(profileNameInput, 'keydown', event => {
    if (event.key === 'Enter') profileNameInput.blur();
});

// モバイル版：設定スライドイン
listen(mobileSettingsFab, 'click', () => {
    settingsStack?.classList.add('is-open');
    closeSettingsBtn?.focus({ preventScroll: true });
});
listen(closeSettingsBtn, 'click', () => {
    settingsStack?.classList.remove('is-open');
    mobileSettingsFab?.focus({ preventScroll: true });
});
document.addEventListener('click', event => {
    const target = event.target;
    if (target instanceof Element && target.closest('.history-retry-actions .retry-action') && window.innerWidth <= 899) {
        settingsStack?.classList.add('is-open');
    }
});
listen(startBtn, 'click', () => settingsStack?.classList.remove('is-open'));
listen(finalCheckBtn, 'click', () => settingsStack?.classList.remove('is-open'));

// 独立したデータ・プライバシー説明画面
listen(dataInfoOpenButton, 'click', () => {
    settingsModal?.classList.remove('active');
    switchScreen('info');
});
listen(dataInfoCloseButton, 'click', () => switchScreen('setup'));

// 設定モーダル
async function loadSettings() {
    try {
        await DB.initDB();
        const [themeSetting, fontSizeSetting] = await Promise.all([
            DB.get('user_settings', 'theme'),
            DB.get('user_settings', 'fontSize')
        ]);
        const isDark = themeSetting?.value === 'dark';
        if (darkModeToggle) darkModeToggle.checked = isDark;
        applyTheme(isDark);

        const fontSize = Math.min(150, Math.max(75, Number(fontSizeSetting?.value) || 100));
        if (fontSizeSlider) fontSizeSlider.value = String(fontSize);
        if (fontSizeValue) fontSizeValue.textContent = String(fontSize);
        applyFontSize(fontSize);
    } catch (error) {
        console.error('[Q-One:Error] 設定の読み込みに失敗しました:', error);
        showInitializationError('設定データを読み込めませんでした。', error);
    }
}

function applyTheme(isDark) {
    if (isDark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
}

function applyFontSize(percent) {
    const value = Math.min(150, Math.max(75, Number(percent) || 100));
    document.documentElement.style.fontSize = `${16 * (value / 100)}px`;
}

listen(settingsBtn, 'click', () => settingsModal?.classList.add('active'));
listen(darkModeToggle, 'change', async event => {
    const isDark = event.target.checked;
    applyTheme(isDark);
    try {
        await DB.put('user_settings', { key: 'theme', value: isDark ? 'dark' : 'light' });
    } catch (error) {
        console.error('[Q-One:Error] テーマ設定の保存に失敗:', error);
        alert(`設定を保存できませんでした: ${error.message || error}`);
    }
});
listen(fontSizeSlider, 'input', event => {
    const value = event.target.value;
    if (fontSizeValue) fontSizeValue.textContent = value;
    applyFontSize(value);
});
listen(fontSizeSlider, 'change', async event => {
    const value = Number.parseInt(event.target.value, 10);
    try {
        await DB.put('user_settings', { key: 'fontSize', value });
    } catch (error) {
        console.error('[Q-One:Error] 文字サイズ設定の保存に失敗:', error);
        alert(`設定を保存できませんでした: ${error.message || error}`);
    }
});

function validateBackupProblem(problem) {
    if (!problem || typeof problem !== 'object' || Array.isArray(problem) || typeof problem.largeText !== 'string') return false;
    switch (problem.type) {
        case 'check':
            return typeof problem.smallText === 'string';
        case 'enter':
            return typeof problem.correctAnswer === 'string' && problem.correctAnswer.length > 0;
        case 'select':
            return Array.isArray(problem.options) && problem.options.length >= 2 &&
                problem.options.every(option => typeof option === 'string' && option.length > 0) &&
                typeof problem.correctAnswer === 'string' && problem.correctAnswer.length > 0 && problem.options.includes(problem.correctAnswer);
        case 'fill':
            return Array.isArray(problem.answers) && problem.answers.length > 0 &&
                Array.isArray(problem.questionParts) && problem.questionParts.length === problem.answers.length + 1 &&
                problem.answers.every(answer => typeof answer === 'string' && answer.length > 0) &&
                problem.questionParts.every(part => typeof part === 'string');
        default:
            return false;
    }
}

function validateBackup(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('JSONの最上位はオブジェクトである必要があります。');
    }
    const isLegacy = data.format === undefined;
    if (isLegacy && data.version !== undefined) {
        throw new Error('バックアップ形式の識別子がありません。');
    }
    if (!isLegacy && data.format !== BACKUP_FORMAT) {
        throw new Error('Q-Oneのバックアップ形式ではありません。');
    }
    if (!isLegacy && (!Number.isInteger(data.version) || data.version < 1 || data.version > BACKUP_VERSION)) {
        throw new Error(`未対応のバックアップバージョンです: ${data.version}`);
    }
    if (!isLegacy && (!data.exportedAt || Number.isNaN(Date.parse(data.exportedAt)))) {
        throw new Error('エクスポート日時が正しくありません。');
    }

    const source = data.stores && typeof data.stores === 'object' && !Array.isArray(data.stores)
        ? data.stores
        : data;
    const recognizedNames = Object.keys(STORE_KEY_FIELDS);
    const requiredNames = isLegacy ? recognizedNames.filter(name => name !== 'fsrs_states') : recognizedNames;
    const missingNames = requiredNames.filter(name => !Array.isArray(source[name]));
    if (missingNames.length > 0) {
        throw new Error(`必須データストアが不足しています: ${missingNames.join(', ')}`);
    }

    const normalized = {};
    for (const storeName of recognizedNames) {
        const records = source[storeName] === undefined ? [] : source[storeName];
        if (!Array.isArray(records)) throw new Error(`${storeName} は配列である必要があります。`);
        const keyField = STORE_KEY_FIELDS[storeName];
        const keys = new Set();
        normalized[storeName] = records.map((record, index) => {
            if (!record || typeof record !== 'object' || Array.isArray(record)) {
                throw new Error(`${storeName}[${index}] がオブジェクトではありません。`);
            }
            const key = record[keyField];
            if (key === undefined || key === null || String(key).trim().length === 0) {
                throw new Error(`${storeName}[${index}] に必須キー ${keyField} がありません。`);
            }
            const normalizedKey = String(key);
            if (keys.has(normalizedKey)) throw new Error(`${storeName} に主キー重複があります: ${normalizedKey}`);
            keys.add(normalizedKey);

            if (storeName === 'packs') {
                if (!Array.isArray(record.problems)) {
                    throw new Error(`packs[${index}].problems は配列である必要があります。`);
                }
                const problemIdentities = new Set();
                for (let problemIndex = 0; problemIndex < record.problems.length; problemIndex++) {
                    const problem = record.problems[problemIndex];
                    if (!validateBackupProblem(problem)) {
                        throw new Error(`packs[${index}].problems[${problemIndex}] の形式が正しくありません。`);
                    }
                    const questionId = problem.questionId || problem.problemId || `q_${problemIndex + 1}`;
                    const identity = `${problem.packId || record.id}:${questionId}`;
                    if (problemIdentities.has(identity)) throw new Error(`packs[${index}] に問題識別子の重複があります: ${identity}`);
                    problemIdentities.add(identity);
                }
            }
            if (storeName === 'test_sessions' && record.problemSnapshot !== undefined) {
                if (!Array.isArray(record.problemSnapshot)) {
                    throw new Error(`test_sessions[${index}].problemSnapshot は配列である必要があります。`);
                }
                const problemIdentities = new Set();
                for (let problemIndex = 0; problemIndex < record.problemSnapshot.length; problemIndex++) {
                    const problem = record.problemSnapshot[problemIndex];
                    if (!validateBackupProblem(problem)) {
                        throw new Error(`test_sessions[${index}].problemSnapshot[${problemIndex}] の形式が正しくありません。`);
                    }
                    const questionId = problem.questionId || problem.problemId || `q_${problemIndex + 1}`;
                    const identity = `${problem.packId || record.packId || 'manual_input'}:${questionId}`;
                    if (problemIdentities.has(identity)) throw new Error(`test_sessions[${index}] の問題スナップショットに識別子重複があります: ${identity}`);
                    problemIdentities.add(identity);
                }
            }
            if (storeName === 'answer_logs' && typeof record.isCorrect !== 'boolean') {
                throw new Error(`answer_logs[${index}].isCorrect は真偽値である必要があります。`);
            }
            if (storeName === 'fsrs_states' && typeof record.id !== 'string') {
                throw new Error(`fsrs_states[${index}].id は文字列である必要があります。`);
            }
            if (storeName === 'user_settings' && typeof record.key !== 'string') {
                throw new Error(`user_settings[${index}].key は文字列である必要があります。`);
            }
            return record;
        });
    }

    // 旧形式のバックアップには復習スケジュール情報が含まれていないため、インポート時に現行状態を保持する。
    Object.defineProperty(normalized, 'preserveExistingReviewState', {
        value: isLegacy && !Array.isArray(source.fsrs_states),
        enumerable: false
    });
    return normalized;
}

// JSONエクスポート：DBに存在する全ストアを取得する。
listen(exportDataBtn, 'click', async () => {
    try {
        const stores = await DB.getAllStores();
        const data = {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            exportedAt: new Date().toISOString(),
            database: { name: DB.DB_NAME, version: DB.DB_VERSION },
            ...stores
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `QOne_Backup_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        console.error('[Q-One:Error] エクスポートエラー:', error);
        alert(`エクスポートに失敗しました: ${error.message || error}`);
    }
});

listen(importDataBtn, 'click', () => importDataInput?.click());
listen(importDataInput, 'change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        const parsed = JSON.parse(await file.text());
        const normalized = validateBackup(parsed);
        const storeCounts = Object.values(normalized).reduce((sum, records) => sum + records.length, 0);
        const reviewStateNotice = normalized.preserveExistingReviewState
            ? '\n※旧形式のバックアップに復習スケジュール情報がないため、現在の復習スケジュールは保持します。'
            : '';
        if (!confirm(`バックアップ内の${storeCounts}件のレコードで、現在の全データを置き換えます。よろしいですか？${reviewStateNotice}`)) return;
        if (normalized.preserveExistingReviewState) normalized.fsrs_states = await DB.getAll('fsrs_states');
        await DB.replaceAllStores(normalized);
        alert('インポートが完了しました。設定を反映するためページを再読み込みします。');
        location.reload();
    } catch (error) {
        console.error('[Q-One:Error] インポートエラー:', error);
        alert(`インポートに失敗しました。既存データは変更されていません。\n${error.message || error}`);
    } finally {
        event.target.value = '';
    }
});

// 全データリセット
listen(resetDataBtn, 'click', async () => {
    if (!confirm('【警告】すべてのデータと設定が削除されます。本当に実行しますか？')) return;
    try {
        await DB.clearAllStores();
        alert('全データをリセットしました。ページを再読み込みします。');
        location.reload();
    } catch (error) {
        console.error('[Q-One:Error] リセットエラー:', error);
        alert(`リセット処理中にエラーが発生しました: ${error.message || error}`);
    }
});

// アプリケーション起動
if (validateRequiredDOM()) {
    initializeFeature('問題パック管理', initPackManager);
    initializeFeature('ホーム', initAnalysisModule);
    initializeFeature('学習履歴', initHistoryModule);
    refreshDailyReviewHome();
    loadSettings();
    screens.setup?.classList.add('visible');
}
