// analysis.js
import * as DB from './db.js';
import { startNewPass } from './quiz.js';
import { escapeHtml } from './utils.js';

// DOM要素
const subjectSelect = document.getElementById('analysis-subject-select');
const packSelect = document.getElementById('analysis-pack-select');
const trainBtn = document.getElementById('start-weakness-training-btn');
const trainBtnText = document.getElementById('weakness-train-btn-text');
const problemListContainer = document.getElementById('analysis-problem-list');

const statMasteredCount = document.getElementById('stat-mastered-count');
const statMatureCount = document.getElementById('stat-mature-count');
const statFirstAccuracy = document.getElementById('stat-first-accuracy');
const statFirstTotal = document.getElementById('stat-first-total');
const statReviewAccuracy = document.getElementById('stat-review-accuracy');
const statReviewTotal = document.getElementById('stat-review-total');

const calendarGrid = document.getElementById('calendar-heatmap-grid');
const weeklyStatsList = document.getElementById('weekly-stats-list');

let currentWeaknessProblems = [];

/**
 * ダッシュボードの集計とレンダリング
 */
export async function renderAnalysisDashboard() {
    try {
        console.log('[Q-One:Analysis] 仕様書準拠の動的集計を開始');
        await DB.initDB();

        const [packs, logs, fsrsStates] = await Promise.all([
            DB.getAll('packs'),
            DB.getAll('answer_logs'),
            DB.getAll('fsrs_states')
        ]);

        updateFilterSelects(packs);

        if (!logs || logs.length === 0) {
            renderEmptyState();
            return;
        }

        const selectedSubject = subjectSelect ? subjectSelect.value : 'all';
        const selectedPackId = packSelect ? packSelect.value : 'all';

        // 1. 対象パックの絞り込み
        let targetPackIds = new Set((packs || []).map(p => p.id));
        targetPackIds.add('manual_input');

        if (selectedSubject !== 'all') {
            const subjectPacks = (packs || []).filter(p => (p.category || '一般') === selectedSubject);
            targetPackIds = new Set(subjectPacks.map(p => p.id));
        }
        if (selectedPackId !== 'all') {
            targetPackIds = new Set([selectedPackId]);
        }

        // 2. ログのフィルタリング
        const filteredLogs = logs.filter(log => targetPackIds.has(log.packId || 'manual_input'));

        // 3. 問題ごとのログを時系列にグループ化
        const logsByProblem = new Map();
        filteredLogs.forEach(log => {
            const key = log.problemKey || log.problemId;
            if (!logsByProblem.has(key)) logsByProblem.set(key, []);
            logsByProblem.get(key).push(log);
        });

        // 4. 初回正答率・復習正答率・苦手克服数の算出
        let firstCorrect = 0, firstTotal = 0;
        let reviewCorrect = 0, reviewTotal = 0;
        let masteredCount = 0;
        currentWeaknessProblems = [];

        logsByProblem.forEach((pLogs, problemKey) => {
            pLogs.sort((a, b) => a.timestamp - b.timestamp);

            // 初回回答
            const firstLog = pLogs[0];
            firstTotal++;
            if (firstLog.isCorrect) firstCorrect++;

            // 復習回答
            for (let i = 1; i < pLogs.length; i++) {
                reviewTotal++;
                if (pLogs[i].isCorrect) reviewCorrect++;
            }

            // 仕様書: 苦手克服の厳密判定
            // 「過去にAgainとなった問題を1日以上(24時間)後の復習でGoodまたはEasyと評価した場合」
            let hadAgain = false;
            let againTime = 0;
            let isOvercome = false;

            for (const l of pLogs) {
                if (l.rating === 1 || !l.isCorrect) {
                    hadAgain = true;
                    againTime = l.timestamp;
                } else if (hadAgain && (l.rating === 3 || l.rating === 4)) {
                    if (l.timestamp - againTime >= 24 * 60 * 60 * 1000) {
                        isOvercome = true;
                        break;
                    }
                }
            }
            if (isOvercome) masteredCount++;

            // FSRS状態のマップを作成（定着度の判定用）
        const fsrsMap = new Map((fsrsStates || []).map(f => [f.id, f]));

        logsByProblem.forEach((pLogs, problemKey) => {
            pLogs.sort((a, b) => a.timestamp - b.timestamp);

            // 初回回答
            const firstLog = pLogs[0];
            firstTotal++;
            if (firstLog.isCorrect) firstCorrect++;

            // 復習回答
            for (let i = 1; i < pLogs.length; i++) {
                reviewTotal++;
                if (pLogs[i].isCorrect) reviewCorrect++;
            }

            // 苦手克服判定
            let hadAgain = false;
            let againTime = 0;
            let isOvercome = false;

            for (const l of pLogs) {
                if (l.rating === 1 || !l.isCorrect) {
                    hadAgain = true;
                    againTime = l.timestamp;
                } else if (hadAgain && (l.rating === 3 || l.rating === 4)) {
                    if (l.timestamp - againTime >= 24 * 60 * 60 * 1000) {
                        isOvercome = true;
                        break;
                    }
                }
            }
            if (isOvercome) masteredCount++;

            // ===== 緩和された要復習・苦手問題の判定ロジック =====
            // 条件1: 直近3回の回答の中に1度でも Again(または不正解) がある
            const recentLogs = pLogs.slice(-3);
            const hasRecentMistake = recentLogs.some(l => l.rating === 1 || !l.isCorrect);

            // 条件2: 通算正答率が 80% 未満
            const problemCorrectCount = pLogs.filter(l => l.isCorrect).length;
            const accuracy = pLogs.length > 0 ? (problemCorrectCount / pLogs.length) : 0;
            const isLowAccuracy = accuracy < 0.8;

            // 条件3: 過去に間違えたことがあり、かつ復習間隔が3日未満（まだ十分に定着していない）
            const fsrs = fsrsMap.get(problemKey);
            const isImmature = hadAgain && (!fsrs || (fsrs.intervalDays || 0) < 3);

            // 上記のいずれかに該当すれば「苦手・要復習」と判定
            if (hasRecentMistake || isLowAccuracy || isImmature) {
                const latestLog = pLogs[pLogs.length - 1];
                const foundPack = (packs || []).find(p => p.id === (latestLog.packId || 'manual_input'));
                let prob = foundPack?.problems?.find(pr => (pr.questionId || pr.problemId) === (latestLog.questionId || latestLog.problemId));

                // パック内に見つからない（テキスト入力履歴など）場合でもログから復元
                if (!prob) {
                    prob = {
                        largeText: `問題 (${problemKey})`,
                        correctAnswer: '履歴から集計中',
                        packId: latestLog.packId || 'manual_input',
                        questionId: latestLog.questionId
                    };
                }

                // 苦手理由のタグ付け
                let reason = '要復習';
                if (hasRecentMistake) reason = '直近ミス';
                else if (isLowAccuracy) reason = `正答率${Math.round(accuracy * 100)}%`;
                else if (isImmature) reason = '未定着';

                currentWeaknessProblems.push({
                    ...prob,
                    weaknessReason: reason,
                    accuracy: Math.round(accuracy * 100)
                });
            }
        });

        // 5. 定着問題（復習間隔7日以上）の算出
        const targetFsrs = (fsrsStates || []).filter(fs => targetPackIds.has(fs.packId));
        const matureCount = targetFsrs.filter(fs => (fs.intervalDays || 0) >= 7).length;

        // UI反映
        if (statMasteredCount) statMasteredCount.textContent = masteredCount;
        if (statMatureCount) statMatureCount.textContent = matureCount;

        if (statFirstAccuracy) {
            statFirstAccuracy.textContent = firstTotal > 0 ? `${Math.round((firstCorrect / firstTotal) * 100)}%` : '--%';
        }
        if (statFirstTotal) statFirstTotal.textContent = `${firstTotal}問中 ${firstCorrect}問`;

        if (statReviewAccuracy) {
            statReviewAccuracy.textContent = reviewTotal > 0 ? `${Math.round((reviewCorrect / reviewTotal) * 100)}%` : '--%';
        }
        if (statReviewTotal) statReviewTotal.textContent = `${reviewTotal}回中 ${reviewCorrect}回`;

        // 6. 学習カレンダー（直近28日分）の描画
        renderCalendarHeatmap(filteredLogs);

        // 7. 週次推移の描画
        renderWeeklyStats(logsByProblem);

        // 8. 苦手リストの描画
        renderWeaknessList(currentWeaknessProblems);

    } catch (err) {
        console.error('[Q-One:Error] ダッシュボード集計エラー:', err);
    }
}

/**
 * 直近28日間の回答カレンダー描画
 */
function renderCalendarHeatmap(logs) {
    if (!calendarGrid) return;
    calendarGrid.innerHTML = '';

    const dayCounts = new Map();
    logs.forEach(log => {
        const dateKey = new Date(log.timestamp).toISOString().slice(0, 10);
        dayCounts.set(dateKey, (dayCounts.get(dateKey) || 0) + 1);
    });

    const now = new Date();
    for (let i = 27; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const count = dayCounts.get(key) || 0;

        let levelClass = '';
        if (count >= 20) levelClass = 'level-3';
        else if (count >= 10) levelClass = 'level-2';
        else if (count >= 1) levelClass = 'level-1';

        const cell = document.createElement('div');
        cell.className = `calendar-day-cell ${levelClass}`;
        cell.title = `${key}: ${count}問解答`;
        cell.textContent = d.getDate();
        calendarGrid.appendChild(cell);
    }
}

/**
 * 初回正答率の週次推移描画 (直近4週)
 */
function renderWeeklyStats(logsByProblem) {
    if (!weeklyStatsList) return;
    weeklyStatsList.innerHTML = '';

    const now = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const weeks = [
        { label: '今週', start: now - oneWeekMs, end: now, firstTotal: 0, firstCorrect: 0 },
        { label: '先週', start: now - oneWeekMs * 2, end: now - oneWeekMs, firstTotal: 0, firstCorrect: 0 },
        { label: '2週前', start: now - oneWeekMs * 3, end: now - oneWeekMs * 2, firstTotal: 0, firstCorrect: 0 },
        { label: '3週前', start: now - oneWeekMs * 4, end: now - oneWeekMs * 3, firstTotal: 0, firstCorrect: 0 }
    ];

    logsByProblem.forEach(pLogs => {
        pLogs.sort((a, b) => a.timestamp - b.timestamp);
        const first = pLogs[0];
        const w = weeks.find(wk => first.timestamp >= wk.start && first.timestamp < wk.end);
        if (w) {
            w.firstTotal++;
            if (first.isCorrect) w.firstCorrect++;
        }
    });

    weeks.forEach(w => {
        const rate = w.firstTotal > 0 ? `${Math.round((w.firstCorrect / w.firstTotal) * 100)}%` : '判定保留';
        const row = document.createElement('div');
        row.className = 'weekly-stat-row';
        row.innerHTML = `
            <span>${w.label} (${w.firstTotal}問)</span>
            <span class="weekly-stat-rate">${rate}</span>
        `;
        weeklyStatsList.appendChild(row);
    });
}

function renderWeaknessList(problems) {
    if (!problemListContainer) return;
    problemListContainer.innerHTML = '';

    if (problems.length === 0) {
        problemListContainer.innerHTML = '<div class="analysis-empty-state"><p>🎉 現在、克服が必要な苦手問題はありません！</p></div>';
        if (trainBtn) trainBtn.disabled = true;
        if (trainBtnText) trainBtnText.textContent = '苦手克服特訓 (0問)';
        return;
    }

    problems.forEach(prob => {
        const el = document.createElement('div');
        el.className = 'analysis-problem-card';
        el.innerHTML = `
            <div class="analysis-card-main">
                <div class="analysis-card-header">
                    <span class="analysis-badge danger">${escapeHtml(prob.weaknessReason || '要復習')}</span>
                    ${prob.accuracy !== undefined ? `<span style="font-size:0.8rem;color:var(--secondary-color);">正答率: ${prob.accuracy}%</span>` : ''}
                </div>
                <div class="analysis-card-q">${escapeHtml(prob.largeText || '問題文')}</div>
                <div class="analysis-card-ans">正解: ${escapeHtml(prob.correctAnswer || prob.smallText || prob.answers?.join(', ') || '―')}</div>
            </div>
        `;
        problemListContainer.appendChild(el);
    });

    if (trainBtn) trainBtn.disabled = false;
    if (trainBtnText) trainBtnText.textContent = `苦手克服特訓 (${problems.length}問)`;
}

function renderEmptyState() {
    if (statMasteredCount) statMasteredCount.textContent = '0';
    if (statMatureCount) statMatureCount.textContent = '0';
    if (statFirstAccuracy) statFirstAccuracy.textContent = '--%';
    if (statReviewAccuracy) statReviewAccuracy.textContent = '--%';
    if (problemListContainer) {
        problemListContainer.innerHTML = '<div class="analysis-empty-state"><p>学習データがまだありません。問題を解くと分析が反映されます。</p></div>';
    }
}

function updateFilterSelects(packs) {
    if (!subjectSelect || !packSelect) return;
    
    // 教科一覧の抽出
    const subjects = new Set(['数学', '現代文', '古典', '漢文', '英語', '物理', '化学', '生物', '日本史', '世界史', '地理', '公共']);
    (packs || []).forEach(p => { if (p.category) subjects.add(p.category); });

    const currentSub = subjectSelect.value;
    subjectSelect.innerHTML = '<option value="all">全教科横断</option>';
    subjects.forEach(sub => {
        const opt = document.createElement('option');
        opt.value = sub;
        opt.textContent = sub;
        subjectSelect.appendChild(opt);
    });
    if ([...subjectSelect.options].some(o => o.value === currentSub)) subjectSelect.value = currentSub;

    // パック一覧
    const currentPack = packSelect.value;
    packSelect.innerHTML = '<option value="all">全パック</option><option value="manual_input">テキスト入力履歴</option>';
    (packs || []).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.title || p.id;
        packSelect.appendChild(opt);
    });
    if ([...packSelect.options].some(o => o.value === currentPack)) packSelect.value = currentPack;
}

export function initAnalysisModule() {
    if (subjectSelect) subjectSelect.addEventListener('change', renderAnalysisDashboard);
    if (packSelect) packSelect.addEventListener('change', renderAnalysisDashboard);
    if (trainBtn) {
        trainBtn.addEventListener('click', () => {
            if (currentWeaknessProblems.length > 0) {
                if (confirm(`抽出された苦手問題（${currentWeaknessProblems.length}問）で特訓を開始しますか？`)) {
                    startNewPass(currentWeaknessProblems, true);
                }
            }
        });
    }

    const analysisRadio = document.getElementById('mode-analysis');
    if (analysisRadio) {
        analysisRadio.addEventListener('change', () => {
            if (analysisRadio.checked) renderAnalysisDashboard();
        });
    }
}
