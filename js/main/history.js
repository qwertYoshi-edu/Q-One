import * as DB from './db.js';
import { state } from './state.js';
import { startNewPass } from './quiz.js';
import { parseText } from './parser.js';
import { escapeHtml } from './utils.js';

const historyListContainer = document.getElementById('history-entry-list');

/**
 * 履歴一覧の取得と描画
 */
export async function renderHistoryList() {
    if (!historyListContainer) return;
    
    try {
        await DB.initDB();
        const [sessions, packs] = await Promise.all([
            DB.getAll('test_sessions'),
            DB.getAll('packs')
        ]);

        if (!sessions || sessions.length === 0) {
            historyListContainer.innerHTML = `
                <div style="padding: 3rem 1rem; text-align: center; color: var(--secondary-color);">
                    <p>まだ学習履歴がありません。<br>問題を解くとここに履歴が記録されます。</p>
                </div>
            `;
            return;
        }

        // 開始日時の新しい順にソート
        sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

        // パック辞書を作成
        const packMap = new Map((packs || []).map(p => [p.id, p]));

        historyListContainer.innerHTML = '';

        sessions.forEach(session => {
            const date = new Date(session.startedAt || Date.now());
            const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            
            const isPack = session.packId && session.packId !== 'manual_input';
            const packData = isPack ? packMap.get(session.packId) : null;
            const title = packData ? packData.title : (isPack ? '削除されたパック' : 'テキスト入力');
            const totalQ = session.totalQuestions || 0;
            const correctQ = session.correctCount || 0;
            const accuracy = totalQ > 0 ? Math.round((correctQ / totalQ) * 100) : 0;

            const article = document.createElement('article');
            article.className = 'history-entry';
            article.innerHTML = `
                <div class="history-entry-main">
                    <div class="history-header">
                        <span class="history-badge history-date">${dateStr}</span>
                        <span class="history-badge ${isPack ? 'history-pack' : ''}">${isPack ? (packData?.category || 'パック') : 'テキスト'}</span>
                        ${session.mode === 'final_check' ? '<span class="history-badge" style="background:#FEF3C7;color:#92400E;">直前チェック</span>' : ''}
                    </div>
                    <div class="history-title-row">
                        <h3>${escapeHtml(title)}</h3>
                        <span class="history-range-badge">範囲: ${escapeHtml(session.range || '全問')}</span>
                    </div>
                    <div class="history-stats">
                        <span class="history-stat-item">${totalQ}問中 ${correctQ}問正解</span>
                        <span class="history-stat-item highlight">正答率 ${accuracy}%</span>
                    </div>
                </div>
                <div class="history-retry-actions" aria-label="リトライ操作">
                    <button class="retry-action btn-retry-history" type="button">
                        <span aria-hidden="true">↻</span> もう一度解く
                    </button>
                </div>
            `;

            // 「もう一度解く」クリックイベント
            const retryBtn = article.querySelector('.btn-retry-history');
            retryBtn.addEventListener('click', () => {
                retryFromHistory(session, packData);
            });

            historyListContainer.appendChild(article);
        });

    } catch (err) {
        console.error('[Q-One:Error] 履歴読み込み失敗:', err);
    }
}

/**
 * 履歴から再挑戦する処理
 */
async function retryFromHistory(session, packData) {
    let problemsToRun = [];

    if (session.packId && session.packId !== 'manual_input') {
        if (!packData || !packData.problems || packData.problems.length === 0) {
            alert('この問題パックは削除されたか、問題データが存在しません。');
            return;
        }
        problemsToRun = packData.problems;
        state.currentPackId = packData.id;
        state.selectedPackData = packData;
    } else {
        const inputText = document.getElementById('input-text')?.value;
        if (!inputText) {
            alert('テキストエリアに問題が入力されていません。');
            return;
        }
        problemsToRun = parseText(inputText, 'manual_input');
        state.currentPackId = 'manual_input';
    }

    // 範囲のパース（例: "1 ~ 50"）
    if (session.range && session.range.includes('~')) {
        const [startStr, endStr] = session.range.split('~').map(s => s.trim());
        const s = parseInt(startStr, 10);
        const e = parseInt(endStr, 10);
        const startIdx = isNaN(s) ? 0 : Math.max(0, s - 1);
        const endIdx = isNaN(e) ? problemsToRun.length : Math.min(problemsToRun.length, e);
        if (startIdx < endIdx) {
            problemsToRun = problemsToRun.slice(startIdx, endIdx);
        }
    }

    if (problemsToRun.length === 0) {
        alert('出題可能な問題がありません。');
        return;
    }

    state.isFinalCheckMode = session.mode === 'final_check';
    state.currentSessionId = (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36);

    // 出題開始
    startNewPass(problemsToRun, false);
}

/**
 * 履歴モジュールの初期化
 */
export function initHistoryModule() {
    const historyRadio = document.getElementById('mode-history');
    if (historyRadio) {
        historyRadio.addEventListener('change', () => {
            if (historyRadio.checked) renderHistoryList();
        });
    }
}
