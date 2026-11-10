import * as DB from './db.js';
import { startNewPass } from './quiz.js';
import { escapeHtml, classifyReviewStates, isMasteredReviewState } from './utils.js';
import { summarizeProblemPerformance, calculateAccuracyPercent, summarizeWeeklyLearning } from './analysis-metrics.js';

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
const weaknessSummary = document.getElementById('home-weakness-summary');
const toggleWeaknessListBtn = document.getElementById('toggle-weakness-list-btn');
const weekProblemCount = document.getElementById('home-week-problem-count');
const weekDayCount = document.getElementById('home-week-day-count');
const weekDescription = document.getElementById('home-week-description');

let currentWeaknessProblems = [];
let showAllWeaknesses = false;
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

            // 確認したい問題は解答ログに基づいて判定し、復習時刻・間隔はスケジュール側で管理する。
            if (performance.isWeak) {
                const latestLog = learningLogs[learningLogs.length - 1];
                const problem = resolveProblemFromHistory(latestLog, sessionsById, packsById, statsByKey);
                if (problem?.type && problem.largeText !== undefined) {
                    const schedule = reviewStateMap.get(problemKey);
                    const latestAttemptAt = Number(learningLogs[learningLogs.length - 1]?.timestamp) || 0;
                    const accuracy = Math.round(performance.accuracy * 100);
                    const weaknessReason = performance.hasRecentMistake
                        ? '最近間違えた問題'
                        : performance.isLowAccuracy
                            ? '正解できた回数が少ない'
                            : 'もう一度確認';
                    const reviewDue = Number(schedule?.due);
                    const ageDays = latestAttemptAt > 0 ? Math.max(0, (Date.now() - latestAttemptAt) / 86400000) : 30;
                    const priorityScore =
                        (Number.isFinite(reviewDue) && reviewDue <= Date.now() ? 4 : 0) +
                        (performance.hasRecentMistake ? 3 : 0) +
                        (performance.isLowAccuracy ? 2 : 0) +
                        Math.max(0, 1 - ageDays / 30);
                    currentWeaknessProblems.push({
                        ...problem,
                        packId: latestLog.packId,
                        questionId: latestLog.questionId,
                        problemKey,
                        weaknessReason,
                        accuracy,
                        correctCount: performance.correctCount,
                        attemptCount: learningLogs.length,
                        hasRecentMistake: performance.hasRecentMistake,
                        isLowAccuracy: performance.isLowAccuracy,
                        latestAttemptAt,
                        reviewDue: Number.isFinite(reviewDue) ? reviewDue : null,
                        priorityScore,
                        recentHistory: performance.recentLogs.map(log => ({ isCorrect: log.isCorrect, rating: log.rating, timestamp: log.timestamp }))
                    });
                }
            }
        });

        currentWeaknessProblems.sort((a, b) =>
            (b.priorityScore - a.priorityScore) ||
            (a.accuracy - b.accuracy) ||
            (b.latestAttemptAt - a.latestAttemptAt)
        );

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
        renderHomeWeekSummary(learningActivityLogs);
        renderWeaknessList(currentWeaknessProblems);
    } catch (error) {
        console.error('[Q-One:Error] ダッシュボード集計エラー:', error);
        if (problemListContainer) {
            problemListContainer.innerHTML = `<div class="analysis-empty-state"><p>学習データを読み込めませんでした。</p></div>`;
        }
        if (weaknessSummary) weaknessSummary.textContent = '学習記録を読み込めませんでした。';
        if (weekDescription) weekDescription.textContent = '学習記録を読み込めませんでした。';
        if (toggleWeaknessListBtn) toggleWeaknessListBtn.hidden = true;
        if (trainBtn) trainBtn.disabled = true;
    }
}

function formatReviewInterval(daysValue) {
    const days = Number(daysValue) || 0;
    if (days < 1) return `${Math.max(1, Math.round(days * 24 * 60))}分`;
    if (days < 2) return `${Math.round(days * 24)}時間`;
    return `${Number(days.toFixed(1))}日`;
}

function renderHomeWeekSummary(logs) {
    if (!weekProblemCount || !weekDayCount) return;
    const summary = summarizeWeeklyLearning(logs, new Date());
    weekProblemCount.textContent = String(summary.problemCount);
    weekDayCount.textContent = String(summary.learningDays);
    if (weekDescription) {
        weekDescription.textContent = summary.problemCount === 0
            ? '今週の学習記録はまだありません。'
            : `今週は ${summary.learningDays} 日学習し、${summary.problemCount} 問に取り組みました。`;
    }
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
    problemListContainer.replaceChildren();
    showAllWeaknesses = false;

    if (problems.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'analysis-empty-state';
        const message = document.createElement('p');
        message.textContent = '今のところ、優先して確認する問題はありません。';
        empty.appendChild(message);
        problemListContainer.appendChild(empty);
        if (weaknessSummary) weaknessSummary.textContent = '最近の解答記録から、確認したい問題は見つかりませんでした。';
        if (toggleWeaknessListBtn) toggleWeaknessListBtn.hidden = true;
        if (trainBtn) trainBtn.disabled = true;
        if (trainBtnText) trainBtnText.textContent = '確認したい問題を解く (0問)';
        return;
    }

    problems.forEach((problem, index) => {
        const element = document.createElement('article');
        element.className = 'analysis-problem-card';
        element.hidden = index >= 3;

        const main = document.createElement('div');
        main.className = 'analysis-card-main';
        const header = document.createElement('div');
        header.className = 'analysis-card-header';
        const badge = document.createElement('span');
        badge.className = 'analysis-badge danger';
        badge.textContent = '確認したい';
        const reason = document.createElement('span');
        reason.className = 'analysis-card-evidence';
        reason.textContent = problem.weaknessReason || 'もう一度確認';
        header.append(badge, reason);

        const question = document.createElement('div');
        question.className = 'analysis-card-q';
        question.textContent = problem.largeText || '問題文を表示できません。';
        const meta = document.createElement('div');
        meta.className = 'analysis-card-meta';
        meta.textContent = `正答率 ${Number.isFinite(Number(problem.accuracy)) ? `${problem.accuracy}%` : 'データ不足'}`;
        main.append(header, question, meta);
        element.appendChild(main);
        problemListContainer.appendChild(element);
    });

    if (weaknessSummary) weaknessSummary.textContent = `${problems.length} 問あります。優先度の高い問題から表示しています。`;
    if (toggleWeaknessListBtn) {
        toggleWeaknessListBtn.hidden = problems.length <= 3;
        toggleWeaknessListBtn.textContent = `すべての問題を見る（${problems.length}問）`;
        toggleWeaknessListBtn.setAttribute('aria-expanded', 'false');
    }
    if (trainBtn) trainBtn.disabled = false;
    if (trainBtnText) trainBtnText.textContent = `確認したい問題を解く (${problems.length}問)`;
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
    if (weekProblemCount) weekProblemCount.textContent = '0';
    if (weekDayCount) weekDayCount.textContent = '0';
    if (weekDescription) weekDescription.textContent = '今週の学習記録はまだありません。';
    if (weaknessSummary) weaknessSummary.textContent = '問題を解くと、もう一度確認したい問題がここに表示されます。';
    if (toggleWeaknessListBtn) toggleWeaknessListBtn.hidden = true;
    if (problemListContainer) {
        problemListContainer.innerHTML = '<div class="analysis-empty-state"><p>学習データがまだありません。問題を解くと、ここに表示されます。</p></div>';
    }
    if (trainBtn) trainBtn.disabled = true;
    if (trainBtnText) trainBtnText.textContent = '確認したい問題を解く (0問)';
}

function updateFilterSelects(packs) {
    if (!subjectSelect || !packSelect) return;
    const subjects = new Set(['数学', '現代文', '古典', '漢文', '英語', '物理', '化学', '生物', '日本史', '世界史', '地理', '公共']);
    packs.forEach(pack => { if (pack.category) subjects.add(pack.category); });

    const selectedSubject = subjectSelect.value;
    subjectSelect.replaceChildren(new Option('すべて', 'all'));
    [...subjects].sort().forEach(subject => subjectSelect.add(new Option(subject, subject)));
    if ([...subjectSelect.options].some(option => option.value === selectedSubject)) subjectSelect.value = selectedSubject;

    const selectedPack = packSelect.value;
    packSelect.replaceChildren(new Option('すべて', 'all'), new Option('テキスト入力', 'manual_input'));
    packs.forEach(pack => packSelect.add(new Option(pack.title || pack.id, pack.id)));
    for (const demo of BUILT_IN_DEMO_PACKS) {
        if (!packs.some(pack => pack.id === demo.id)) packSelect.add(new Option(`${demo.title} (デモ)`, demo.id));
    }
    if ([...packSelect.options].some(option => option.value === selectedPack)) packSelect.value = selectedPack;
}

export function initAnalysisModule() {
    if (subjectSelect) subjectSelect.addEventListener('change', renderAnalysisDashboard);
    if (packSelect) packSelect.addEventListener('change', renderAnalysisDashboard);
    if (toggleWeaknessListBtn) {
        toggleWeaknessListBtn.addEventListener('click', () => {
            const shouldExpand = !showAllWeaknesses;
            showAllWeaknesses = shouldExpand;
            const cards = problemListContainer?.querySelectorAll('.analysis-problem-card') || [];
            cards.forEach((card, index) => { card.hidden = !shouldExpand && index >= 3; });
            toggleWeaknessListBtn.setAttribute('aria-expanded', String(shouldExpand));
            toggleWeaknessListBtn.textContent = shouldExpand
                ? '一部だけ表示'
                : `すべての問題を見る（${currentWeaknessProblems.length}問）`;
        });
    }
    if (trainBtn) {
        trainBtn.addEventListener('click', () => {
            if (currentWeaknessProblems.length === 0) return;
            startNewPass(currentWeaknessProblems, false, { mode: 'weakness_training' });
        });
    }
    if (document.getElementById('mode-analysis')?.checked) renderAnalysisDashboard();
}
