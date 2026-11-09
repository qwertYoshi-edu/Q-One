import * as DB from './db.js';
import { state } from './state.js';
import { startNewPass } from './quiz.js';
import { escapeHtml } from './utils.js';
import { buildLegacySessionMetrics } from './metrics.js';

const historyListContainer = document.getElementById('history-entry-list');

const MODE_LABELS = {
    normal: '通常学習',
    final_check: '直前チェック',
    review: '復習',
    weakness_training: '苦手克服特訓'
};

export async function renderHistoryList() {
    if (!historyListContainer) return;

    try {
        await DB.initDB();
        const [sessions, packs, logs] = await Promise.all([
            DB.getAll('test_sessions'),
            DB.getAll('packs'),
            DB.getAll('answer_logs')
        ]);
        const legacyMetrics = buildLegacySessionMetrics(logs, sessions);

        if (!sessions.length) {
            historyListContainer.innerHTML = `
                <div style="padding: 3rem 1rem; text-align: center; color: var(--secondary-color);">
                    <p>まだ学習履歴がありません。<br>問題を解くとここに履歴が記録されます。</p>
                </div>`;
            return;
        }

        sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        const packMap = new Map((packs || []).map(pack => [pack.id, pack]));
        historyListContainer.innerHTML = '';

        sessions.forEach(session => {
            const date = new Date(session.startedAt || Date.now());
            const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            const sessionPackIds = Array.isArray(session.packIds) && session.packIds.length
                ? session.packIds
                : (session.packId && !['manual_input', 'multiple'].includes(session.packId) ? [session.packId] : []);
            const isPack = sessionPackIds.length > 0 || (session.packId && !['manual_input', 'multiple'].includes(session.packId));
            const packData = session.packId && session.packId !== 'multiple' ? packMap.get(session.packId) : null;
            const title = session.packTitle || packData?.title || (sessionPackIds.length > 1 ? '複数パック' : (isPack ? '削除されたパック' : 'テキスト入力'));
            const legacy = legacyMetrics.get(session.id);
            const answered = Number.isFinite(session.answeredCount)
                ? session.answeredCount
                : (legacy?.answered ?? (session.completedAt ? (session.totalQuestions || 0) : 0));
            const correct = Number.isFinite(session.answeredCount)
                ? Math.min(answered, Math.max(0, Number(session.correctCount) || 0))
                : Math.min(answered, Math.max(0, legacy?.correct ?? (Number(session.correctCount) || 0)));
            const checkAnswered = Number(session.checkAnsweredCount) || legacy?.checkAnswered || 0;
            const checkCorrect = Number(session.checkAnsweredCount) > 0
                ? (Number(session.checkOKCount) || 0)
                : (legacy?.checkCorrect || 0);
            const retryAnswered = Number(session.retryAnsweredCount) || legacy?.retryAnswered || 0;
            const interimAnswered = Number(session.interimReviewAnsweredCount) || legacy?.interimReviewAnswered || 0;
            const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;
            const mode = session.mode || 'normal';

            const article = document.createElement('article');
            article.className = 'history-entry';
            article.innerHTML = `
                <div class="history-entry-main">
                    <div class="history-header">
                        <span class="history-badge history-date">${dateStr}</span>
                        <span class="history-badge ${isPack ? 'history-pack' : ''}">${escapeHtml(isPack ? (packData?.category || session.packCategory || (sessionPackIds.length > 1 ? '複数パック' : 'パック')) : 'テキスト')}</span>
                        <span class="history-badge">${escapeHtml(MODE_LABELS[mode] || '学習')}</span>
                    </div>
                    <div class="history-title-row">
                        <h3>${escapeHtml(title)}</h3>
                        <span class="history-range-badge">範囲: ${escapeHtml(session.range || '全問')}</span>
                    </div>
                    <div class="history-stats">
                        <span class="history-stat-item">${answered}問回答 / ${session.totalQuestions || 0}問</span>
                        <span class="history-stat-item">${correct}問正解</span>
                        <span class="history-stat-item highlight">正答率 ${answered > 0 ? `${accuracy}%` : '未回答'}</span>
                        ${checkAnswered > 0 ? `<span class="history-stat-item">確認型理解度 ${Math.round(checkCorrect / checkAnswered * 100)}% (${checkCorrect}/${checkAnswered})</span>` : ''}
                        ${retryAnswered + interimAnswered > 0 ? `<span class="history-stat-item">再回答 ${retryAnswered + interimAnswered}回</span>` : ''}
                    </div>
                </div>
                <div class="history-retry-actions" aria-label="リトライ操作">
                    <button class="retry-action btn-retry-history" type="button">
                        <span aria-hidden="true">↻</span> もう一度解く
                    </button>
                </div>`;

            article.querySelector('.btn-retry-history')?.addEventListener('click', () => {
                retryFromHistory(session, packData).catch(error => {
                    console.error('[Q-One:Error] 履歴からの再挑戦に失敗:', error);
                    alert(`履歴から問題を復元できませんでした。\n${error.message || error}`);
                });
            });
            historyListContainer.appendChild(article);
        });
    } catch (error) {
        console.error('[Q-One:Error] 履歴読み込み失敗:', error);
        historyListContainer.textContent = '学習履歴を読み込めませんでした。コンソールで原因を確認してください。';
    }
}

async function retryFromHistory(session, packData) {
    let problemsToRun = Array.isArray(session.problemSnapshot)
        ? session.problemSnapshot
        : (Array.isArray(session.problemsSnapshot) ? session.problemsSnapshot : null);

    if (problemsToRun?.length) {
        problemsToRun = JSON.parse(JSON.stringify(problemsToRun));
    } else if (session.packId && !['manual_input', 'multiple'].includes(session.packId) && packData?.problems?.length) {
        const confirmed = confirm('この履歴には当時の問題スナップショットがありません。現在保存されている問題パックの内容で再挑戦します。過去の内容と異なる可能性があります。続行しますか？');
        if (!confirmed) return;
        problemsToRun = JSON.parse(JSON.stringify(packData.problems));
    } else {
        alert('この古い履歴には問題データのスナップショットがありません。元の問題パックも見つからないため、当時の問題を正確に再現できません。');
        return;
    }

    if (!problemsToRun.length) {
        alert('この履歴に再挑戦できる問題が保存されていません。');
        return;
    }

    const mode = ['normal', 'final_check', 'review', 'weakness_training'].includes(session.mode)
        ? session.mode
        : (session.mode === 'final_check' ? 'final_check' : 'normal');
    state.isFinalCheckMode = mode === 'final_check';
    state.currentPackId = session.packId || problemsToRun[0].packId || 'manual_input';
    state.selectedPackData = packData || null;
    state.originalWordList = JSON.parse(JSON.stringify(problemsToRun));

    startNewPass(problemsToRun, mode === 'review' || mode === 'weakness_training', {
        mode,
        sourceSessionId: session.id,
        packId: state.currentPackId,
        packTitle: session.packTitle || packData?.title || '',
        packCategory: session.packCategory || packData?.category || '',
        range: session.range || '履歴スナップショット'
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
