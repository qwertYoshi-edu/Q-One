import * as DB from './db.js';
import { startNewPass } from './quiz.js';
import { escapeHtml, classifyReviewStates, isMasteredReviewState } from './utils.js';
import { summarizeProblemPerformance, calculateAccuracyPercent } from './analysis-metrics.js';

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
const statReviewDueCount = document.getElementById('stat-review-due-count');
const statOverdueCount = document.getElementById('stat-overdue-count');
const statLearningDays = document.getElementById('stat-learning-days-analysis');
const statWeaknessCount = document.getElementById('stat-weakness-count');
const statRetentionBreakdown = document.getElementById('stat-retention-breakdown');
const calendarGrid = document.getElementById('calendar-heatmap-grid');
const weeklyStatsList = document.getElementById('weekly-stats-list');

let currentWeaknessProblems = [];
const BUILT_IN_DEMO_PACKS = [
    { id: 'qone_demo_math_v1', title: '高校数学Ⅰ・A 頻出公式・定理集', category: '数学' },
    { id: 'qone_demo_japanese_v1', title: '現代文・重要語句 必須キーワード', category: '現代文' }
];

function normalizeLog(log, packProblem = null, inferredPackId = null) {
    const packId = log.packId || inferredPackId || packProblem?.packId || 'manual_input';
    const questionId = log.questionId || packProblem?.questionId || log.problemId || 'unknown';
    return {
        ...log,
        packId,
        questionId,
        problemKey: log.problemKey || `${packId}:${questionId}`,
        problemType: log.problemType || packProblem?.type || null,
        timestamp: Number(log.timestamp) || 0,
        isCorrect: log.isCorrect === true || log.isCorrect === 1 || log.isCorrect === 'true'
    };
}

/**
 * 旧版では通常ログ(problemId=hash)と簡易間隔反復ログ(questionId=q_n_hash)が別々に保存されていた。
 * problemIdの先頭6桁・sessionId・timeMs・正誤が一致する組だけ通常ログ側を除外する。
 * それ以外の履歴は削除せず、利用可能なpack情報から識別子を補完する。
 */
function normalizeAndDedupeLogs(rawLogs, packs = []) {
    const packProblemIndex = new Map();
    for (const pack of packs || []) {
        for (const problem of pack.problems || []) {
            if (!problem.problemId) continue;
            const key = String(problem.problemId);
            if (!packProblemIndex.has(key)) packProblemIndex.set(key, []);
            packProblemIndex.get(key).push({ packId: pack.id, problem });
        }
    }

    const canonicalRatedLogs = (rawLogs || []).filter(log =>
        log?.sessionId && log?.questionId && log?.problemKey &&
        log.rating !== null && log.rating !== undefined && log.timeMs !== undefined
    );

    const retained = [];
    for (const raw of rawLogs || []) {
        if (!raw || typeof raw !== 'object') continue;
        const lacksCanonicalIdentity = !raw.questionId && !raw.problemKey;
        const hash = String(raw.problemId || '');
        if (lacksCanonicalIdentity && raw.sessionId && hash && raw.timeMs !== undefined) {
            const hashPrefix = hash.slice(0, 6);
            const duplicate = canonicalRatedLogs.some(candidate =>
                candidate !== raw &&
                candidate.sessionId === raw.sessionId &&
                candidate.timeMs === raw.timeMs &&
                Boolean(candidate.isCorrect) === Boolean(raw.isCorrect) &&
                String(candidate.questionId).endsWith(`_${hashPrefix}`)
            );
            if (duplicate) continue;
        }

        const packMatches = packProblemIndex.get(hash) || [];
        const packMatch = packMatches.length === 1 ? packMatches[0] : null;
        retained.push(normalizeLog(raw, packMatch?.problem || null, packMatch?.packId || null));
    }

    return retained.sort((a, b) => a.timestamp - b.timestamp);
}


function getPackCategory(packMap, packId) {
    return packMap.get(packId)?.category || (packId === 'manual_input' ? 'テキスト入力' : '一般');
}

function isFinalCheckLog(log, sessionsById) {
    return log.attemptType === 'final_check' || log.mode === 'final_check' ||
        sessionsById.get(log.sessionId)?.mode === 'final_check';
}

function isCheckProblemLog(log) {
    return log.problemType === 'check' || log.attemptType === 'check_understanding';
}

function isAnalysisLearningLog(log, sessionsById) {
    return !isFinalCheckLog(log, sessionsById) && !isCheckProblemLog(log);
}

function groupLogsByProblem(logs) {
    const grouped = new Map();
    for (const log of logs) {
        if (!grouped.has(log.problemKey)) grouped.set(log.problemKey, []);
        grouped.get(log.problemKey).push(log);
    }
    grouped.forEach(items => items.sort((a, b) => a.timestamp - b.timestamp));
    return grouped;
}

function resolveProblemFromHistory(latestLog, sessionsById, packsById, statsByKey) {
    const session = sessionsById.get(latestLog.sessionId);
    const snapshot = Array.isArray(session?.problemSnapshot) ? session.problemSnapshot : [];
    const fromSnapshot = snapshot.find(problem => {
        const packId = problem.packId || session?.packId || 'manual_input';
        const questionId = problem.questionId || problem.problemId || 'unknown';
        return `${packId}:${questionId}` === latestLog.problemKey;
    });
    if (fromSnapshot) return fromSnapshot;

    const pack = packsById.get(latestLog.packId);
    const fromPack = pack?.problems?.find(problem => {
        const questionId = problem.questionId || problem.problemId || 'unknown';
        return questionId === latestLog.questionId || problem.problemId === latestLog.problemId;
    });
    if (fromPack) return fromPack;

    const stat = statsByKey.get(latestLog.problemKey);
    if (stat?.problemData) return stat.problemData;
    return null;
}

export async function renderAnalysisDashboard() {
    try {
        await DB.initDB();
        const [packs, rawLogs, reviewStates, sessions, stats] = await Promise.all([
            DB.getAll('packs'),
            DB.getAll('answer_logs'),
            DB.getAll('fsrs_states'), // 旧DB名を後方互換のため維持。値は独自スケジューラの状態。
            DB.getAll('test_sessions'),
            DB.getAll('problem_stats')
        ]);

        updateFilterSelects(packs || []);
        const selectedSubject = subjectSelect?.value || 'all';
        const selectedPackId = packSelect?.value || 'all';
        const packsById = new Map((packs || []).map(pack => [pack.id, pack]));
        const sessionsById = new Map((sessions || []).map(session => [session.id, session]));
        const statsByKey = new Map();
        for (const stat of stats || []) {
            statsByKey.set(stat.problemId, stat);
            const data = stat.problemData;
            if (data?.packId && (data.questionId || data.problemId)) {
                statsByKey.set(`${data.packId}:${data.questionId || data.problemId}`, stat);
            }
        }

        const targetPackIds = new Set([...(packs || []).map(pack => pack.id), ...BUILT_IN_DEMO_PACKS.map(pack => pack.id)]);
        targetPackIds.add('manual_input');
        if (selectedSubject !== 'all') {
            for (const pack of [...(packs || []), ...BUILT_IN_DEMO_PACKS]) {
                if ((pack.category || '一般') !== selectedSubject) targetPackIds.delete(pack.id);
            }
            if (selectedSubject !== 'テキスト入力') targetPackIds.delete('manual_input');
        }
        if (selectedPackId !== 'all') {
            targetPackIds.clear();
            targetPackIds.add(selectedPackId);
        }

        const dedupedLogs = normalizeAndDedupeLogs(rawLogs, packs);
        const filteredLogs = dedupedLogs.filter(log => targetPackIds.has(log.packId));
        const logsByProblem = groupLogsByProblem(filteredLogs);
        const targetReviewStates = (reviewStates || []).filter(item => targetPackIds.has(item.packId) && item.due !== null && item.due !== undefined && Number.isFinite(Number(item.due)));
        const reviewBuckets = classifyReviewStates(targetReviewStates, new Date(), 3);
        const reviewStateMap = new Map(targetReviewStates.map(item => [item.id, item]));

        let firstCorrect = 0;
        let firstTotal = 0;
        let reviewCorrect = 0;
        let reviewTotal = 0;
        currentWeaknessProblems = [];
        const activeLearningDates = new Set();

        logsByProblem.forEach((problemLogs, problemKey) => {
            const learningLogs = problemLogs.filter(log => isAnalysisLearningLog(log, sessionsById));
            if (learningLogs.length === 0) return;

            const performance = summarizeProblemPerformance(learningLogs);
            const firstLog = performance.firstLog;
            firstTotal += performance.firstTotal;
            firstCorrect += performance.firstCorrect;
            reviewTotal += performance.reviewTotal;
            reviewCorrect += performance.reviewCorrect;
            for (const log of learningLogs) {
                if (Number.isFinite(log.timestamp) && log.timestamp > 0) activeLearningDates.add(localDateKey(new Date(log.timestamp)));
            }

            // 弱点は解答ログに基づいて判定し、期限・間隔は復習対象側に分離する。
            if (performance.isWeak) {
                const latestLog = learningLogs[learningLogs.length - 1];
                const problem = resolveProblemFromHistory(latestLog, sessionsById, packsById, statsByKey);
                if (problem?.type && problem.largeText !== undefined) {
                    const reasons = [];
                    if (performance.hasRecentMistake) reasons.push('直近3回以内に誤答');
                    if (performance.isLowAccuracy) reasons.push(`正答率${Math.round(performance.accuracy * 100)}% (${performance.correctCount}/${learningLogs.length})`);
                    const schedule = reviewStateMap.get(problemKey);
                    if (schedule) {
                        reasons.push(`現在の復習間隔 ${formatReviewInterval(schedule.intervalDays)}`);
                        const ratingNames = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
                        const recentRatings = (schedule.ratingHistory || []).slice(-3).map(item => ratingNames[Number(item.rating)] || '不明');
                        if (recentRatings.length) reasons.push(`直近評価 ${recentRatings.join(' → ')}`);
                    }
                    currentWeaknessProblems.push({
                        ...problem,
                        packId: latestLog.packId,
                        questionId: latestLog.questionId,
                        problemKey,
                        weaknessReason: reasons.join(' / '),
                        accuracy: Math.round(performance.accuracy * 100),
                        correctCount: performance.correctCount,
                        attemptCount: learningLogs.length,
                        recentHistory: performance.recentLogs.map(log => ({ isCorrect: log.isCorrect, rating: log.rating, timestamp: log.timestamp }))
                    });
                }
            }
        });

        const masteredCount = targetReviewStates.filter(isMasteredReviewState).length;
        const learningCount = targetReviewStates.filter(item => Number(item.state) === 1 && !isMasteredReviewState(item)).length;
        const reviewCount = targetReviewStates.filter(item => Number(item.state) === 2 && !isMasteredReviewState(item)).length;
        // 「新規」は reps=0 のスケジュール状態ではなく、既知の問題のうち未スケジュールの数。
        const knownProblemKeys = new Set();
        for (const pack of packs || []) {
            if (!targetPackIds.has(pack.id)) continue;
            (pack.problems || []).forEach((problem, index) => {
                if (problem?.type === 'check') return;
                const questionId = problem.questionId || problem.problemId || `q_${index + 1}`;
                knownProblemKeys.add(`${pack.id}:${questionId}`);
            });
        }
        for (const log of filteredLogs) {
            if (!isCheckProblemLog(log)) knownProblemKeys.add(log.problemKey);
        }
        for (const stat of stats || []) {
            if (targetPackIds.has(stat.packId) && stat.questionId && stat.problemData?.type !== 'check') knownProblemKeys.add(`${stat.packId}:${stat.questionId}`);
            else if (typeof stat.problemId === 'string' && targetPackIds.has(stat.packId) && stat.problemId.includes(':')) knownProblemKeys.add(stat.problemId);
        }
        const scheduledKeys = new Set(targetReviewStates.map(item => item.id));
        const newScheduleCount = [...knownProblemKeys].filter(key => !scheduledKeys.has(key)).length;

        if (statMasteredCount) statMasteredCount.textContent = String(masteredCount);
        if (statMatureCount) statMatureCount.textContent = String(targetReviewStates.length);
        if (statFirstAccuracy) statFirstAccuracy.textContent = firstTotal > 0 ? `${calculateAccuracyPercent(firstCorrect, firstTotal)}%` : 'データ不足';
        if (statFirstTotal) statFirstTotal.textContent = firstTotal > 0 ? `${firstTotal}問中 ${firstCorrect}問` : '初回解答ログなし';
        if (statReviewAccuracy) statReviewAccuracy.textContent = reviewTotal > 0 ? `${calculateAccuracyPercent(reviewCorrect, reviewTotal)}%` : 'データ不足';
        if (statReviewTotal) statReviewTotal.textContent = reviewTotal > 0 ? `${reviewTotal}回中 ${reviewCorrect}回` : '復習解答ログなし';
        if (statReviewDueCount) statReviewDueCount.textContent = String(reviewBuckets.overdue.length + reviewBuckets.dueToday.length);
        if (statOverdueCount) statOverdueCount.textContent = String(reviewBuckets.overdue.length);
        if (statLearningDays) statLearningDays.textContent = String(activeLearningDates.size);
        if (statWeaknessCount) statWeaknessCount.textContent = String(currentWeaknessProblems.length);
        if (statRetentionBreakdown) {
            statRetentionBreakdown.textContent = `定着度：新規 ${newScheduleCount}問 ／ 学習中 ${learningCount}問 ／ 復習中 ${reviewCount}問 ／ 定着済み ${masteredCount}問`;
        }

        const learningActivityLogs = filteredLogs.filter(log => isAnalysisLearningLog(log, sessionsById));
        renderCalendarHeatmap(learningActivityLogs);
        renderWeeklyStats(learningActivityLogs);
        renderWeaknessList(currentWeaknessProblems);
    } catch (error) {
        console.error('[Q-One:Error] ダッシュボード集計エラー:', error);
        if (problemListContainer) {
            problemListContainer.innerHTML = `<div class="analysis-empty-state"><p>分析データを読み込めませんでした。</p><p>${escapeHtml(error.message || String(error))}</p></div>`;
        }
        if (trainBtn) trainBtn.disabled = true;
    }
}

function formatReviewInterval(daysValue) {
    const days = Number(daysValue) || 0;
    if (days < 1) return `${Math.max(1, Math.round(days * 24 * 60))}分`;
    if (days < 2) return `${Math.round(days * 24)}時間`;
    return `${Number(days.toFixed(1))}日`;
}

function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderCalendarHeatmap(logs) {
    if (!calendarGrid) return;
    calendarGrid.innerHTML = '';
    const dayCounts = new Map();
    for (const log of logs) {
        if (!Number.isFinite(log.timestamp) || log.timestamp <= 0) continue;
        const key = localDateKey(new Date(log.timestamp));
        dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
    }

    const now = new Date();
    for (let offset = 27; offset >= 0; offset--) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
        const key = localDateKey(date);
        const count = dayCounts.get(key) || 0;
        const levelClass = count >= 20 ? 'level-3' : count >= 10 ? 'level-2' : count >= 1 ? 'level-1' : '';
        const cell = document.createElement('div');
        cell.className = `calendar-day-cell ${levelClass}`;
        cell.title = `${key}: ${count}回解答`;
        cell.textContent = date.getDate();
        calendarGrid.appendChild(cell);
    }
}

function renderWeeklyStats(logs) {
    if (!weeklyStatsList) return;
    weeklyStatsList.innerHTML = '';
    const now = new Date();
    const currentMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const mondayOffset = (currentMonday.getDay() + 6) % 7;
    currentMonday.setDate(currentMonday.getDate() - mondayOffset);
    const weeks = Array.from({ length: 4 }, (_, index) => {
        const start = new Date(currentMonday);
        start.setDate(start.getDate() - (3 - index) * 7);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        return { start, end, label: index === 3 ? '今週' : `${3 - index}週前`, total: 0, firstTotal: 0, firstCorrect: 0 };
    });
    const firstSeen = new Set();
    const sorted = [...logs].sort((a, b) => a.timestamp - b.timestamp);
    for (const log of sorted) {
        const isFirstEverLog = !firstSeen.has(log.problemKey);
        firstSeen.add(log.problemKey);
        const date = new Date(log.timestamp);
        const week = weeks.find(item => date >= item.start && date < item.end);
        if (!week) continue;
        week.total++;
        if (isFirstEverLog) {
            week.firstTotal++;
            if (log.isCorrect) week.firstCorrect++;
        }
    }
    for (const week of weeks) {
        const rate = week.firstTotal > 0 ? `${calculateAccuracyPercent(week.firstCorrect, week.firstTotal)}%` : 'データ不足';
        const row = document.createElement('div');
        row.className = 'weekly-stat-row';
        const label = document.createElement('span');
        label.textContent = `${week.label} · ${week.total}回学習`;
        const value = document.createElement('span');
        value.className = 'weekly-stat-rate';
        value.textContent = `初回 ${rate}`;
        row.append(label, value);
        weeklyStatsList.appendChild(row);
    }
}

function renderWeaknessList(problems) {
    if (!problemListContainer) return;
    problemListContainer.innerHTML = '';
    if (problems.length === 0) {
        problemListContainer.innerHTML = '<div class="analysis-empty-state"><p>現在、克服が必要な苦手問題はありません。</p></div>';
        if (trainBtn) trainBtn.disabled = true;
        if (trainBtnText) trainBtnText.textContent = '苦手克服特訓 (0問)';
        return;
    }

    for (const problem of problems) {
        const element = document.createElement('div');
        element.className = 'analysis-problem-card';
        const answer = problem.correctAnswer || problem.smallText || problem.answers?.join(', ') || '―';
        element.innerHTML = `
            <div class="analysis-card-main">
                <div class="analysis-card-header">
                    <span class="analysis-badge danger">苦手</span>
                    <span class="analysis-card-evidence">${escapeHtml(problem.weaknessReason || '解答履歴に根拠あり')}</span>
                </div>
                <div class="analysis-card-q">${escapeHtml(problem.largeText || '問題文')}</div>
                <div class="analysis-card-ans">正解: ${escapeHtml(answer)}</div>
                <div class="analysis-card-meta">解答 ${Number(problem.attemptCount) || 0}回 · 正解 ${Number(problem.correctCount) || 0}回</div>
            </div>`;
        problemListContainer.appendChild(element);
    }
    if (trainBtn) trainBtn.disabled = false;
    if (trainBtnText) trainBtnText.textContent = `苦手克服特訓 (${problems.length}問)`;
}

function renderEmptyState() {
    if (statMasteredCount) statMasteredCount.textContent = '0';
    if (statMatureCount) statMatureCount.textContent = '0';
    if (statFirstAccuracy) statFirstAccuracy.textContent = 'データ不足';
    if (statFirstTotal) statFirstTotal.textContent = '0問中 0問';
    if (statReviewAccuracy) statReviewAccuracy.textContent = 'データ不足';
    if (statReviewTotal) statReviewTotal.textContent = '復習解答ログなし';
    if (statReviewDueCount) statReviewDueCount.textContent = '0';
    if (statOverdueCount) statOverdueCount.textContent = '0';
    if (statLearningDays) statLearningDays.textContent = '0';
    if (statWeaknessCount) statWeaknessCount.textContent = '0';
    if (statRetentionBreakdown) statRetentionBreakdown.textContent = '定着度：データ不足';
    if (weeklyStatsList) weeklyStatsList.innerHTML = '';
    if (calendarGrid) calendarGrid.innerHTML = '';
    if (problemListContainer) {
        problemListContainer.innerHTML = '<div class="analysis-empty-state"><p>学習データがまだありません。問題を解くと分析が反映されます。</p></div>';
    }
    if (trainBtn) trainBtn.disabled = true;
    if (trainBtnText) trainBtnText.textContent = '苦手克服特訓 (0問)';
}

function updateFilterSelects(packs) {
    if (!subjectSelect || !packSelect) return;
    const subjects = new Set(['数学', '現代文', '古典', '漢文', '英語', '物理', '化学', '生物', '日本史', '世界史', '地理', '公共']);
    packs.forEach(pack => { if (pack.category) subjects.add(pack.category); });

    const selectedSubject = subjectSelect.value;
    subjectSelect.replaceChildren(new Option('全教科横断', 'all'));
    [...subjects].sort().forEach(subject => subjectSelect.add(new Option(subject, subject)));
    if ([...subjectSelect.options].some(option => option.value === selectedSubject)) subjectSelect.value = selectedSubject;

    const selectedPack = packSelect.value;
    packSelect.replaceChildren(new Option('全パック', 'all'), new Option('テキスト入力履歴', 'manual_input'));
    packs.forEach(pack => packSelect.add(new Option(pack.title || pack.id, pack.id)));
    for (const demo of BUILT_IN_DEMO_PACKS) {
        if (!packs.some(pack => pack.id === demo.id)) packSelect.add(new Option(`${demo.title} (デモ)`, demo.id));
    }
    if ([...packSelect.options].some(option => option.value === selectedPack)) packSelect.value = selectedPack;
}

export function initAnalysisModule() {
    if (subjectSelect) subjectSelect.addEventListener('change', renderAnalysisDashboard);
    if (packSelect) packSelect.addEventListener('change', renderAnalysisDashboard);
    if (trainBtn) {
        trainBtn.addEventListener('click', () => {
            if (currentWeaknessProblems.length === 0) return;
            startNewPass(currentWeaknessProblems, false, { mode: 'weakness_training' });
        });
    }
    const analysisRadio = document.getElementById('mode-analysis');
    if (analysisRadio) analysisRadio.addEventListener('change', () => {
        if (analysisRadio.checked) renderAnalysisDashboard();
    });
}
