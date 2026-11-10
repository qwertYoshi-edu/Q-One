import * as DB from './db.js';
import { state } from './state.js';
import { startNewPass } from './quiz.js';
import { escapeHtml } from './utils.js';

const historyListContainer = document.getElementById('history-entry-list');

function getSessionPackTitle(session, packsById) {
    const ids = session.packIds || (session.packId ? [session.packId] : []);
    const titles = [...new Set(ids)].map(id => {
        if (id === 'manual_input') return 'テキスト入力';
        if (id === 'multiple') return '複数パック';
        return packsById.get(id)?.title || (session.packTitle && ids.length === 1 ? session.packTitle : '削除されたパック');
    });
    return titles.length > 0 ? titles.join(' / ') : 'テキスト入力';
}

function getModeLabel(mode) {
    return ({
        normal: '通常学習',
        final_check: '直前チェック',
        review: '間違えた問題の復習',
        retry_all: '全問再挑戦',
        history_retry: '履歴から再挑戦',
        weakness_training: '苦手な問題の復習'
    })[mode] || '学習';
}

export async function renderHistoryList() {
    if (!historyListContainer) return;
    try {
        await DB.initDB();
        const [sessions, packs] = await Promise.all([DB.getAll('test_sessions'), DB.getAll('packs')]);
        if (!sessions || sessions.length === 0) {
            historyListContainer.innerHTML = `
                <div style="padding: 3rem 1rem; text-align: center; color: var(--secondary-color);">
                    <p>まだ学習履歴がありません。<br>問題を解くとここに履歴が記録されます。</p>
                </div>`;
            return;
        }

        sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        const packsById = new Map((packs || []).map(pack => [pack.id, pack]));
        historyListContainer.replaceChildren();

        for (const session of sessions) {
            const date = new Date(session.startedAt || Date.now());
            const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            const title = getSessionPackTitle(session, packsById);
            const totalQuestions = Number(session.totalQuestions) || 0;
            const answeredCount = Number.isFinite(Number(session.answeredCount)) ? Number(session.answeredCount) : totalQuestions;
            const correctCount = Math.min(answeredCount, Math.max(0, Number(session.correctCount) || 0));
            const accuracy = answeredCount > 0
                ? (Number.isFinite(Number(session.accuracy)) ? Math.round(Number(session.accuracy)) : Math.round(correctCount / answeredCount * 100))
                : 0;
            const checkAnsweredCount = Math.max(0, Number(session.checkAnsweredCount) || 0);
            const checkCorrectCount = Math.min(checkAnsweredCount, Math.max(0, Number(session.checkCorrectCount) || 0));
            const checkSummary = checkAnsweredCount > 0
                ? `<span class="history-stat-item">確認型の理解度 ${checkCorrectCount}/${checkAnsweredCount}問</span>`
                : '';
            const hasSnapshot = Array.isArray(session.problemSnapshot) && session.problemSnapshot.length > 0;

            const article = document.createElement('article');
            article.className = 'history-entry';
            article.innerHTML = `
                <div class="history-entry-main">
                    <div class="history-header">
                        <span class="history-badge history-date">${dateStr}</span>
                        <span class="history-badge">${escapeHtml(getModeLabel(session.mode))}</span>
                        <span class="history-badge ${session.packId !== 'manual_input' ? 'history-pack' : ''}">${escapeHtml(title)}</span>
                    </div>
                    <div class="history-title-row">
                        <h3>${escapeHtml(title)}</h3>
                        <span class="history-range-badge">範囲: ${escapeHtml(session.range || '全問')}</span>
                    </div>
                    <div class="history-stats">
                        <span class="history-stat-item">${answeredCount}/${totalQuestions}問回答・${correctCount}問正解</span>
                        <span class="history-stat-item highlight">正答率 ${answeredCount > 0 ? `${accuracy}%` : '未回答'}</span>
                        ${checkSummary}
                    </div>
                    ${!hasSnapshot ? '<p class="history-snapshot-notice">旧形式の履歴：当時の問題データは保存されていません。</p>' : ''}
                </div>
                <div class="history-retry-actions" aria-label="リトライ操作">
                    <button class="retry-action btn-retry-history" type="button">↻ もう一度解く</button>
                </div>`;

            article.querySelector('.btn-retry-history')?.addEventListener('click', () => {
                retryFromHistory(session, packsById);
            });
            historyListContainer.appendChild(article);
        }
    } catch (error) {
        console.error('[Q-One:Error] 履歴読み込み失敗:', error);
        historyListContainer.innerHTML = `<div class="analysis-empty-state"><p>履歴を読み込めませんでした。</p><p>${escapeHtml(error.message || String(error))}</p></div>`;
    }
}

async function retryFromHistory(session, packsById) {
    let problemsToRun = [];
    const hasSnapshot = Array.isArray(session.problemSnapshot) && session.problemSnapshot.length > 0;

    if (hasSnapshot) {
        problemsToRun = JSON.parse(JSON.stringify(session.problemSnapshot));
    } else {
        const packId = session.packId;
        const packData = packsById.get(packId);
        if (packId && packId !== 'manual_input' && packData?.problems?.length) {
            const proceed = confirm(
                'この履歴は旧形式のため、当時の問題データが保存されていません。\\n現在の問題パックの内容を使って再挑戦しますか？'
            );
            if (!proceed) return;
            problemsToRun = JSON.parse(JSON.stringify(packData.problems));
            state.selectedPackData = packData;
            state.currentPackId = packData.id;
            // スナップショットがない旧履歴に限り、保存されていた範囲を現行パックへ適用する。
            if (session.range && session.range.includes('~')) {
                const [startText, endText] = session.range.split('~').map(value => value.trim());
                const start = Number.parseInt(startText, 10);
                const end = Number.parseInt(endText, 10);
                const from = Number.isNaN(start) ? 0 : Math.max(0, start - 1);
                const to = Number.isNaN(end) ? problemsToRun.length : Math.min(problemsToRun.length, end);
                if (from < to) problemsToRun = problemsToRun.slice(from, to);
            }
        } else {
            alert('この旧履歴には問題データのスナップショットがなく、元の問題パックも利用できません。\\nテキストエリアの現在の内容とは同一とは限らないため、安全のため再挑戦を中止しました。');
            return;
        }
    }

    if (problemsToRun.length === 0) {
        alert('再挑戦できる問題データがありません。');
        return;
    }

    const normalizedPackIds = [...new Set(problemsToRun.map(problem => problem.packId || session.packId || 'manual_input'))];
    problemsToRun = problemsToRun.map((problem, index) => ({
        ...problem,
        packId: problem.packId || normalizedPackIds[0] || 'manual_input',
        questionId: problem.questionId || problem.problemId || `q_${index + 1}`,
        revision: Number.isInteger(problem.revision) ? problem.revision : 1
    }));

    state.originalWordList = JSON.parse(JSON.stringify(problemsToRun));
    state.currentPackId = normalizedPackIds.length === 1 ? normalizedPackIds[0] : 'multiple';
    if (normalizedPackIds.length !== 1 || normalizedPackIds[0] === 'manual_input') state.selectedPackData = null;
    state.isFinalCheckMode = session.mode === 'final_check';
    state.isSelfGradingMode = Boolean(session.isSelfGradingMode) && !state.isFinalCheckMode;

    startNewPass(problemsToRun, false, {
        mode: state.isFinalCheckMode ? 'final_check' : 'history_retry',
        range: session.range || '全問',
        packTitle: session.packTitle || ''
    });
}

export function initHistoryModule() {
    const historyRadio = document.getElementById('mode-history');
    if (historyRadio) {
        historyRadio.addEventListener('change', () => {
            if (historyRadio.checked) renderHistoryList();
        });
    }
}
