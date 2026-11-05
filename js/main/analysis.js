// analysis.js
import * as DB from './db.js';
import { parseText } from './parser.js';
import { startNewPass } from './quiz.js';
import { escapeHtml } from './utils.js';

// DOM要素の参照
const packSelect = document.getElementById('analysis-pack-select');
const sortSelect = document.getElementById('analysis-sort-select');
const trainBtn = document.getElementById('start-weakness-training-btn');
const trainBtnText = document.getElementById('weakness-train-btn-text');
const problemListContainer = document.getElementById('analysis-problem-list');

const summaryDangerCount = document.getElementById('summary-danger-count');
const summaryWarningCount = document.getElementById('summary-warning-count');
const summarySafeCount = document.getElementById('summary-safe-count');

// 現在表示・特訓対象となっている問題データ
let currentAnalysisProblems = [];

/**
 * 苦手度スコアを算出する
 * - 正答率が低いほど高スコア (最大50点)
 * - 連続正解が0ならペナルティ加点 (30点)
 * - 平均解答速度が5秒(5000ms)を超えている場合加点 (最大20点)
 */
function calculateWeaknessScore(stat) {
    if (!stat || stat.totalAnswers === 0) return 0;
    
    const accuracy = stat.correctAnswers / stat.totalAnswers;
    const errorScore = (1 - accuracy) * 50;
    const continuousMistakeScore = stat.continuousCorrects === 0 ? 30 : Math.max(0, 15 - stat.continuousCorrects * 5);
    const speedScore = Math.min(20, (stat.averageTimeMs / 5000) * 10);
    
    return errorScore + continuousMistakeScore + speedScore;
}

/**
 * 判定バッジの種別を判定
 * - danger (要復習): 連続正解が0回、または正答率50%未満
 * - warning (迷い気味): 連続正解1〜2回、または平均速度が4.5秒以上
 * - safe (定着): 連続正解3回以上かつ正答率80%以上
 */
function evaluateProblemStatus(stat) {
    const accuracy = stat.totalAnswers > 0 ? (stat.correctAnswers / stat.totalAnswers) : 1;
    
    if (stat.continuousCorrects === 0 || accuracy < 0.5) {
        return { type: 'danger', label: '🚨 要復習' };
    }
    if (stat.continuousCorrects < 3 || stat.averageTimeMs >= 4500) {
        return { type: 'warning', label: '🐢 迷い気味' };
    }
    return { type: 'safe', label: '✨ 定着' };
}

/**
 * 分析ダッシュボード全体の更新・描画
 */
export async function renderAnalysisDashboard() {
    try {
        console.log('[Q-One:Analysis] 苦手分析ダッシュボードの集計を開始');
        await DB.initDB();

        // 1. DBから問題統計・ログ・パック一覧を取得
        const [stats, logs, packs] = await Promise.all([
            DB.getAll('problem_stats'),
            DB.getAll('answer_logs'),
            DB.getAll('packs')
        ]);

        // 2. パックセレクタのオプション更新
        updatePackSelectOptions(packs);

        if (!stats || stats.length === 0) {
            renderEmptyState();
            return;
        }

        // 3. 対象パックによるフィルタリング
        const selectedPackId = packSelect ? packSelect.value : 'all';
        let filteredStats = stats;
        if (selectedPackId !== 'all') {
            filteredStats = stats.filter(s => Array.isArray(s.packIds) && s.packIds.includes(selectedPackId));
        }

        if (filteredStats.length === 0) {
            renderEmptyState();
            return;
        }

        // 4. ソート処理
        const sortType = sortSelect ? sortSelect.value : 'weakness';
        filteredStats.sort((a, b) => {
            if (sortType === 'weakness') {
                return calculateWeaknessScore(b) - calculateWeaknessScore(a);
            }
            if (sortType === 'speed') {
                return (b.averageTimeMs || 0) - (a.averageTimeMs || 0);
            }
            if (sortType === 'recent_mistake') {
                return (b.lastMistakeAt || 0) - (a.lastMistakeAt || 0);
            }
            return 0;
        });

        // 5. 各問題ごとの直近5回のログをマッピング
        const logsByProblemId = new Map();
        logs.forEach(log => {
            if (!logsByProblemId.has(log.problemId)) {
                logsByProblemId.set(log.problemId, []);
            }
            logsByProblemId.get(log.problemId).push(log);
        });

        // 6. カウント集計とDOM生成
        let dangerCount = 0;
        let warningCount = 0;
        let safeCount = 0;

        problemListContainer.innerHTML = '';
        currentAnalysisProblems = [];

        filteredStats.forEach(stat => {
            const evaluation = evaluateProblemStatus(stat);
            if (evaluation.type === 'danger') dangerCount++;
            else if (evaluation.type === 'warning') warningCount++;
            else if (evaluation.type === 'safe') safeCount++;

            // 直近5回の履歴ドット用
            const problemLogs = logsByProblemId.get(stat.problemId) || [];
            problemLogs.sort((a, b) => b.timestamp - a.timestamp);
            const recent5Logs = problemLogs.slice(0, 5).reverse(); // 古い順に5件並べる

            let dotsHtml = '';
            for (let i = 0; i < 5; i++) {
                if (i < recent5Logs.length) {
                    const isCorrect = recent5Logs[i].isCorrect;
                    dotsHtml += `<span class="dot ${isCorrect ? 'correct' : 'incorrect'}" title="${isCorrect ? '正解' : '不正解'}"></span>`;
                } else {
                    dotsHtml += `<span class="dot" title="記録なし"></span>`;
                }
            }

            // カード要素の作成
            const cardEl = document.createElement('div');
            cardEl.className = 'analysis-problem-card';
            cardEl.innerHTML = `
                <div class="analysis-card-main">
                    <div class="analysis-card-header">
                        <span class="analysis-badge ${evaluation.type}">${evaluation.label}</span>
                        <span style="font-size: 0.8rem; color: var(--secondary-color);">正答率: ${Math.round((stat.correctAnswers / stat.totalAnswers) * 100)}% (${stat.correctAnswers}/${stat.totalAnswers}問)</span>
                        <span style="font-size: 0.8rem; color: var(--secondary-color);">連続正解: ${stat.continuousCorrects}回</span>
                    </div>
                    <div class="analysis-card-q">${escapeHtml(stat.problemText || '問題文不明')}</div>
                    <div class="analysis-card-ans">正解: ${escapeHtml(stat.problemData?.correctAnswer || stat.problemData?.answers?.join(', ') || '―')}</div>
                </div>
                <div class="analysis-card-stats">
                    <div class="history-dots" title="直近5回の解答推移 (左から順)">
                        ${dotsHtml}
                    </div>
                    <span class="analysis-speed-text">平均 ${(stat.averageTimeMs / 1000).toFixed(1)}秒</span>
                </div>
            `;
            problemListContainer.appendChild(cardEl);

            // 特訓用データとして蓄積
            if (stat.problemData) {
                currentAnalysisProblems.push(stat.problemData);
            }
        });

        // サマリーバッジの反映
        if (summaryDangerCount) summaryDangerCount.textContent = dangerCount;
        if (summaryWarningCount) summaryWarningCount.textContent = warningCount;
        if (summarySafeCount) summarySafeCount.textContent = safeCount;

        // 特訓ボタンの制御（要復習・迷い気味の問題、またはリスト全体）
        if (trainBtn && trainBtnText) {
            const trainCount = currentAnalysisProblems.length;
            trainBtnText.textContent = `表示中の苦手問題で特訓 (${trainCount}問)`;
            trainBtn.disabled = trainCount === 0;
        }

    } catch (err) {
        console.error('[Q-One:Error] 苦手分析の読み込みに失敗しました:', err);
    }
}

/**
 * 空状態の描画
 */
function renderEmptyState() {
    problemListContainer.innerHTML = `
        <div class="analysis-empty-state">
            <svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
            <p>該当する学習データがまだありません。<br>テストを解くとここに苦手分析が表示されます。</p>
        </div>
    `;
    if (summaryDangerCount) summaryDangerCount.textContent = '0';
    if (summaryWarningCount) summaryWarningCount.textContent = '0';
    if (summarySafeCount) summarySafeCount.textContent = '0';
    if (trainBtn && trainBtnText) {
        trainBtnText.textContent = '表示中の苦手問題で特訓 (0問)';
        trainBtn.disabled = true;
    }
}

/**
 * パック選択セレクトボックスの動的更新
 */
function updatePackSelectOptions(packs) {
    if (!packSelect) return;
    const currentVal = packSelect.value;
    
    // 既存の動的オプションを一旦クリアして再構築
    packSelect.innerHTML = `
        <option value="all">全パック横断</option>
        <option value="manual_input">テキスト入力履歴</option>
    `;
    
    (packs || []).forEach(pack => {
        const opt = document.createElement('option');
        opt.value = pack.id;
        opt.textContent = pack.title || `パック (${pack.id})`;
        packSelect.appendChild(opt);
    });

    // 以前の選択状態を復元（存在すれば）
    if ([...packSelect.options].some(o => o.value === currentVal)) {
        packSelect.value = currentVal;
    }
}

/**
 * 苦手特訓テストの開始
 */
function startWeaknessTraining() {
    if (!currentAnalysisProblems || currentAnalysisProblems.length === 0) {
        alert('特訓対象の問題がありません。');
        return;
    }

    if (confirm(`表示中の苦手問題（${currentAnalysisProblems.length}問）で特訓を開始しますか？`)) {
        console.log('[Q-One:Analysis] 苦手特訓テストを起動:', currentAnalysisProblems);
        // 復習モードフラグをtrueにして出題パスを開始
        startNewPass(currentAnalysisProblems, true);
    }
}

/**
 * イベントリスナーの初期化
 */
export function initAnalysisModule() {
    if (packSelect) {
        packSelect.addEventListener('change', () => renderAnalysisDashboard());
    }
    if (sortSelect) {
        sortSelect.addEventListener('change', () => renderAnalysisDashboard());
    }
    if (trainBtn) {
        trainBtn.addEventListener('click', startWeaknessTraining);
    }

    // 「苦手分析」タブがクリックされた時に自動リロード
    const analysisRadio = document.getElementById('mode-analysis');
    if (analysisRadio) {
        analysisRadio.addEventListener('change', () => {
            if (analysisRadio.checked) {
                renderAnalysisDashboard();
            }
        });
    }
}