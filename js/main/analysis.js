import * as DB from './db.js';
import { startNewPass } from './quiz.js';
import { escapeHtml } from './utils.js';

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
 * 旧版では通常ログ(problemId=hash)とFSRSログ(questionId=q_n_hash)が別々に保存されていた。
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
        const [packs, rawLogs, fsrsStates, sessions, stats] = await Promise.all([
            DB.getAll('packs'),
            DB.getAll('answer_logs'),
            DB.getAll('fsrs_states'),
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
        const fsrsMap = new Map((fsrsStates || []).map(item => [item.id, item]));

        let firstCorrect = 0;
        let firstTotal = 0;
        let reviewCorrect = 0;
        let reviewTotal = 0;
        let masteredCount = 0;
        currentWeaknessProblems = [];
        const firstLogs = [];

        logsByProblem.forEach((problemLogs, problemKey) => {
            const learningLogs = problemLogs.filter(log => isAnalysisLearningLog(log, sessionsById));
            if (learningLogs.length === 0) return;

            const firstLog = learningLogs[0];
            firstLogs.push(firstLog);
            firstTotal++;
            if (firstLog.isCorrect) firstCorrect++;

            const subsequentLogs = learningLogs.slice(1);
            for (const log of subsequentLogs) {
                reviewTotal++;
                if (log.isCorrect) reviewCorrect++;
            }

            let hadAgain = false;
            let againTime = 0;
            let isOvercome = false;
            for (const log of learningLogs) {
                if (log.rating === 1 || !log.isCorrect) {
                    hadAgain = true;
                    againTime = log.timestamp;
                } else if (hadAgain && (log.rating === 3 || log.rating === 4)) {
                    if (log.timestamp - againTime >= 24 * 60 * 60 * 1000) {
                        isOvercome = true;
                        break;
                    }
                }
            }
            if (isOvercome) masteredCount++;

            const recentLogs = learningLogs.slice(-3);
            const hasRecentMistake = recentLogs.some(log => log.rating === 1 || !log.isCorrect);
            const correctCount = learningLogs.filter(log => log.isCorrect).length;
            const accuracy = correctCount / learningLogs.length;
            const isLowAccuracy = accuracy < 0.8;
            const fsrs = fsrsMap.get(problemKey);
            const isImmature = hadAgain && (!fsrs || (Number(fsrs.intervalDays) || 0) < 3);

            if (hasRecentMistake || isLowAccuracy || isImmature) {
                const latestLog = learningLogs[learningLogs.length - 1];
                const problem = resolveProblemFromHistory(latestLog, sessionsById, packsById, statsByKey);
                // 型情報のない旧ログから不完全な問題を作らず、再挑戦可能なデータだけを使う。
                if (problem?.type && problem.largeText !== undefined) {
                    let reason = '要復習';
                    if (hasRecentMistake) reason = '直近ミス';
                    else if (isLowAccuracy) reason = `正答率${Math.round(accuracy * 100)}%`;
                    else if (isImmature) reason = '未定着';
                    currentWeaknessProblems.push({
                        ...problem,
                        packId: latestLog.packId,
                        questionId: latestLog.questionId,
                        problemKey,
                        weaknessReason: reason,
                        accuracy: Math.round(accuracy * 100)
                    });
                }
            }
        });

        const targetFsrs = (fsrsStates || []).filter(item => targetPackIds.has(item.packId));
        const matureCount = targetFsrs.filter(item => (Number(item.intervalDays) || 0) >= 7).length;

        if (statMasteredCount) statMasteredCount.textContent = String(masteredCount);
        if (statMatureCount) statMatureCount.textContent = String(matureCount);
        if (statFirstAccuracy) statFirstAccuracy.textContent = firstTotal > 0 ? `${Math.round(firstCorrect / firstTotal * 100)}%` : '--%';
        if (statFirstTotal) statFirstTotal.textContent = `${firstTotal}問中 ${firstCorrect}問`;
        if (statReviewAccuracy) statReviewAccuracy.textContent = reviewTotal > 0 ? `${Math.round(reviewCorrect / reviewTotal * 100)}%` : '--%';
        if (statReviewTotal) statReviewTotal.textContent = `${reviewTotal}回中 ${reviewCorrect}回`;

        renderCalendarHeatmap(filteredLogs);
        renderWeeklyStats(firstLogs);
        renderWeaknessList(currentWeaknessProblems);

        if (filteredLogs.length === 0 && targetFsrs.length === 0) renderEmptyState();
    } catch (error) {
        console.error('[Q-One:Error] ダッシュボード集計エラー:', error);
        if (problemListContainer) {
            problemListContainer.innerHTML = `<div class="analysis-empty-state"><p>分析データを読み込めませんでした。</p><p>${escapeHtml(error.message || String(error))}</p></div>`;
        }
        if (trainBtn) trainBtn.disabled = true;
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

function renderWeeklyStats(firstLogs) {
    if (!weeklyStatsList) return;
    weeklyStatsList.innerHTML = '';
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const weeks = [
        { label: '今週', start: now - weekMs, end: now },
        { label: '先週', start: now - weekMs * 2, end: now - weekMs },
        { label: '2週前', start: now - weekMs * 3, end: now - weekMs * 2 },
        { label: '3週前', start: now - weekMs * 4, end: now - weekMs * 3 }
    ].map(week => ({ ...week, total: 0, correct: 0 }));

    for (const firstLog of firstLogs) {
        const week = weeks.find(item => firstLog.timestamp >= item.start && firstLog.timestamp < item.end);
        if (!week) continue;
        week.total++;
        if (firstLog.isCorrect) week.correct++;
    }

    for (const week of weeks) {
        const rate = week.total > 0 ? `${Math.round(week.correct / week.total * 100)}%` : '判定保留';
        const row = document.createElement('div');
        row.className = 'weekly-stat-row';
        const label = document.createElement('span');
        label.textContent = `${week.label} (${week.total}問)`;
        const value = document.createElement('span');
        value.className = 'weekly-stat-rate';
        value.textContent = rate;
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
                    <span class="analysis-badge danger">${escapeHtml(problem.weaknessReason || '要復習')}</span>
                    <span style="font-size:0.8rem;color:var(--secondary-color);">正答率: ${Number(problem.accuracy) || 0}%</span>
                </div>
                <div class="analysis-card-q">${escapeHtml(problem.largeText || '問題文')}</div>
                <div class="analysis-card-ans">正解: ${escapeHtml(answer)}</div>
            </div>`;
        problemListContainer.appendChild(element);
    }
    if (trainBtn) trainBtn.disabled = false;
    if (trainBtnText) trainBtnText.textContent = `苦手克服特訓 (${problems.length}問)`;
}

function renderEmptyState() {
    if (statMasteredCount) statMasteredCount.textContent = '0';
    if (statMatureCount) statMatureCount.textContent = '0';
    if (statFirstAccuracy) statFirstAccuracy.textContent = '--%';
    if (statFirstTotal) statFirstTotal.textContent = '0問中 0問';
    if (statReviewAccuracy) statReviewAccuracy.textContent = '--%';
    if (statReviewTotal) statReviewTotal.textContent = '0回中 0回';
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
            if (confirm(`抽出された苦手問題（${currentWeaknessProblems.length}問）で特訓を開始しますか？`)) {
                startNewPass(currentWeaknessProblems, false, { mode: 'weakness_training' });
            }
        });
    }
    const analysisRadio = document.getElementById('mode-analysis');
    if (analysisRadio) analysisRadio.addEventListener('change', () => {
        if (analysisRadio.checked) renderAnalysisDashboard();
    });
}
