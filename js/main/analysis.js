import * as DB from './db.js';
import { startNewPass } from './quiz.js';
import { classifyReviewStates } from './utils.js';
import {
    summarizeProblemPerformance,
    summarizeRecentLearning,
    sortWeaknessProblems
} from './analysis-metrics.js';

const trainBtn = document.getElementById('start-weakness-training-btn');
const problemListContainer = document.getElementById('analysis-problem-list');
const statWeaknessCount = document.getElementById('stat-weakness-count');
const statRecentAccuracy = document.getElementById('stat-recent-accuracy');
const statRecentAccuracyDetail = document.getElementById('stat-recent-accuracy-detail');
const statRecentLearningDays = document.getElementById('stat-recent-learning-days');
let currentWeaknessProblems = [];
let isWeaknessListExpanded = false;
let renderSequence = 0;

const BUILT_IN_DEMO_PACK_IDS = ['qone_demo_math_v1', 'qone_demo_japanese_v1'];

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

function isFinalCheckLog(log, sessionsById) {
    return log.attemptType === 'final_check' || log.mode === 'final_check' ||
        sessionsById.get(log.sessionId)?.mode === 'final_check';
}

function isCheckProblemLog(log) {
    return log.problemType === 'check' || log.attemptType === 'check_understanding';
}

function isHomeLearningLog(log, sessionsById) {
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
    return stat?.problemData || null;
}

function setMetricText(element, value) {
    if (element) element.textContent = value;
}

export async function renderAnalysisDashboard() {
    const sequence = ++renderSequence;
    isWeaknessListExpanded = false;
    try {
        await DB.initDB();
        const [packs, rawLogs, reviewStates, sessions, stats] = await Promise.all([
            DB.getAll('packs'),
            DB.getAll('answer_logs'),
            DB.getAll('fsrs_states'),
            DB.getAll('test_sessions'),
            DB.getAll('problem_stats')
        ]);
        if (sequence !== renderSequence) return;

        const safePacks = Array.isArray(packs) ? packs : [];
        const safeSessions = Array.isArray(sessions) ? sessions : [];
        const safeStats = Array.isArray(stats) ? stats : [];
        const safeReviewStates = Array.isArray(reviewStates) ? reviewStates : [];
        const packsById = new Map(safePacks.map(pack => [pack.id, pack]));
        const sessionsById = new Map(safeSessions.map(session => [session.id, session]));
        const statsByKey = new Map();
        for (const stat of safeStats) {
            if (stat?.problemId) statsByKey.set(stat.problemId, stat);
            const data = stat?.problemData;
            if (data?.packId && (data.questionId || data.problemId)) {
                statsByKey.set(`${data.packId}:${data.questionId || data.problemId}`, stat);
            }
        }

        const targetPackIds = new Set([
            ...safePacks.map(pack => pack.id),
            ...BUILT_IN_DEMO_PACK_IDS,
            'manual_input'
        ]);
        const normalizedLogs = normalizeAndDedupeLogs(rawLogs, safePacks);
        const learningLogs = normalizedLogs.filter(log => targetPackIds.has(log.packId) && isHomeLearningLog(log, sessionsById));
        const logsByProblem = groupLogsByProblem(learningLogs);
        const targetReviewStates = safeReviewStates.filter(item =>
            item && targetPackIds.has(item.packId) && item.due !== null && item.due !== undefined && Number.isFinite(Number(item.due))
        );
        const now = Date.now();
        const reviewStateMap = new Map(targetReviewStates.map(item => [item.id, item]));

        currentWeaknessProblems = [];
        logsByProblem.forEach((problemLogs, problemKey) => {
            const performance = summarizeProblemPerformance(problemLogs);
            if (!performance.isWeak) return;

            const latestLog = problemLogs[problemLogs.length - 1];
            const problem = resolveProblemFromHistory(latestLog, sessionsById, packsById, statsByKey);
            if (!problem || !problem.type || problem.largeText === undefined) return;

            const schedule = reviewStateMap.get(problemKey);
            const recentIncorrectLogs = performance.recentLogs.filter(log =>
                !log.isCorrect || Number(log.rating) === 1
            );
            const ratingHistory = Array.isArray(schedule?.ratingHistory) ? schedule.ratingHistory.slice(-3) : [];
            const recentAgainCount = ratingHistory.filter(item => Number(item?.rating) === 1).length;
            const isScheduledDue = Number.isFinite(Number(schedule?.due)) && Number(schedule.due) <= now;

            let weaknessReason = 'もう一度確認';
            if (recentIncorrectLogs.length > 0) weaknessReason = '最近まちがえた';
            else if (performance.isLowAccuracy) weaknessReason = '正解率が低め';
            else if (isScheduledDue || recentAgainCount > 0) weaknessReason = 'もう一度確認';

            currentWeaknessProblems.push({
                ...problem,
                packId: latestLog.packId,
                questionId: latestLog.questionId,
                problemKey,
                weaknessReason,
                accuracy: performance.accuracy,
                recentIncorrectCount: recentIncorrectLogs.length,
                isScheduledDue,
                recentAgainCount,
                lastIncorrectAt: recentIncorrectLogs.reduce((latest, log) => Math.max(latest, log.timestamp), 0),
                latestAttemptAt: latestLog.timestamp,
                attemptCount: problemLogs.length,
                correctCount: performance.correctCount
            });
        });

        currentWeaknessProblems = sortWeaknessProblems(currentWeaknessProblems);
        const recentSummary = summarizeRecentLearning(learningLogs, new Date(now));

        setMetricText(statWeaknessCount, `${currentWeaknessProblems.length}問`);
        setMetricText(statRecentAccuracy, recentSummary.accuracyPercent === null ? '—' : `${recentSummary.accuracyPercent}%`);
        setMetricText(statRecentAccuracyDetail, recentSummary.totalAttempts > 0
            ? `直近7日間・通常学習${recentSummary.totalAttempts}回`
            : 'まだ学習記録がありません');
        setMetricText(statRecentLearningDays, `${recentSummary.learningDays}日`);

        renderWeaknessList(currentWeaknessProblems, learningLogs.length > 0);
    } catch (error) {
        if (sequence !== renderSequence) return;
        console.error('[Q-One:Error] ホームの学習データ読み込みに失敗:', error);
        setMetricText(statWeaknessCount, '—');
        setMetricText(statRecentAccuracy, '—');
        setMetricText(statRecentAccuracyDetail, '学習データを読み込めませんでした');
        setMetricText(statRecentLearningDays, '—');
        if (problemListContainer) {
            problemListContainer.replaceChildren();
            const message = document.createElement('p');
            message.className = 'analysis-empty-state';
            message.textContent = '学習データを読み込めませんでした。ページを再読み込みしてください。';
            problemListContainer.appendChild(message);
        }
        if (trainBtn) trainBtn.hidden = true;
    }
}

function renderWeaknessList(problems, hasLearningData) {
    if (!problemListContainer) return;
    problemListContainer.replaceChildren();

    if (problems.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'analysis-empty-state';
        const message = document.createElement('p');
        message.textContent = hasLearningData
            ? '今のところ、特に復習が必要な問題はありません。'
            : '問題を解くと、ここに確認したい問題が表示されます。';
        emptyState.appendChild(message);
        problemListContainer.appendChild(emptyState);
        if (trainBtn) trainBtn.hidden = true;
        isWeaknessListExpanded = false;
        return;
    }

    if (trainBtn) trainBtn.hidden = false;
    const visibleCount = isWeaknessListExpanded ? problems.length : Math.min(3, problems.length);
    for (const problem of problems.slice(0, visibleCount)) {
        const element = document.createElement('article');
        element.className = 'analysis-problem-card';

        const main = document.createElement('div');
        main.className = 'analysis-card-main';
        const header = document.createElement('div');
        header.className = 'analysis-card-header';
        const reason = document.createElement('span');
        reason.className = 'analysis-card-evidence';
        reason.textContent = problem.weaknessReason || 'もう一度確認';
        const question = document.createElement('p');
        question.className = 'analysis-card-q';
        question.textContent = typeof problem.largeText === 'string' && problem.largeText.length > 0
            ? problem.largeText
            : '問題文を表示できません。';

        header.appendChild(reason);
        main.append(header, question);
        element.appendChild(main);
        problemListContainer.appendChild(element);
    }

    if (problems.length > 3) {
        const moreButton = document.createElement('button');
        moreButton.type = 'button';
        moreButton.className = 'btn-secondary home-more-button';
        moreButton.textContent = isWeaknessListExpanded ? '折りたたむ' : 'もっと見る';
        moreButton.setAttribute('aria-expanded', String(isWeaknessListExpanded));
        moreButton.addEventListener('click', () => {
            isWeaknessListExpanded = !isWeaknessListExpanded;
            renderWeaknessList(currentWeaknessProblems, true);
        });
        problemListContainer.appendChild(moreButton);
    }
}

export function initAnalysisModule() {
    if (trainBtn) {
        trainBtn.addEventListener('click', () => {
            if (currentWeaknessProblems.length === 0) return;
            startNewPass(currentWeaknessProblems, false, { mode: 'weakness_training' });
        });
    }
    const homeRadio = document.getElementById('mode-analysis');
    if (homeRadio) homeRadio.addEventListener('change', () => {
        if (homeRadio.checked) renderAnalysisDashboard();
    });
    renderAnalysisDashboard();
}
