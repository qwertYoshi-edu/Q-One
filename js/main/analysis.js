import * as DB from './db.js';
import { startNewPass } from './quiz.js';
import { escapeHtml } from './utils.js';
import { removeKnownLegacyDuplicates } from './metrics.js';

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

function getPackId(log) {
    return String(log.packId || 'manual_input');
}

function getQuestionId(log) {
    return String(log.questionId || log.problemId || 'unknown');
}

function getProblemKey(log) {
    if (log.problemKey) return String(log.problemKey);
    const revision = Number(log.revision) || 1;
    return `${getPackId(log)}:${getQuestionId(log)}:r${revision}`;
}

function getLogMode(log) {
    return log.mode || log.sessionMode || 'normal';
}

function isPrimaryLog(log) {
    return getLogMode(log) === 'normal' && (log.attemptType === undefined || log.attemptType === 'first');
}

function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildProblemSnapshotMap(sessions) {
    const map = new Map();
    (sessions || []).forEach(session => {
        if (!Array.isArray(session.problemSnapshot)) return;
        session.problemSnapshot.forEach(problem => {
            const packId = String(problem.packId || session.packId || 'manual_input');
            const questionId = String(problem.questionId || problem.problemId || 'unknown');
            const revision = Number(problem.revision) || 1;
            map.set(`${packId}:${questionId}:r${revision}`, problem);
        });
    });
    return map;
}

export async function renderAnalysisDashboard() {
    try {
        await DB.initDB();
        const [packs, rawLogs, fsrsStates, sessions, problemStats] = await Promise.all([
            DB.getAll('packs'),
            DB.getAll('answer_logs'),
            DB.getAll('fsrs_states'),
            DB.getAll('test_sessions'),
            DB.getAll('problem_stats')
        ]);
        updateFilterSelects(packs);

        const selectedSubject = subjectSelect?.value || 'all';
        const selectedPackId = packSelect?.value || 'all';
        const demoPackCategories = { 'math-sample': '数学', 'japanese-sample': '古典' };
        let targetPackIds = new Set((packs || []).map(pack => pack.id));
        targetPackIds.add('manual_input');
        Object.entries(demoPackCategories).forEach(([id, category]) => {
            if (selectedSubject === 'all' || selectedSubject === category) targetPackIds.add(id);
        });
        if (selectedSubject !== 'all') {
            targetPackIds = new Set((packs || [])
                .filter(pack => (pack.category || '一般') === selectedSubject)
                .map(pack => pack.id));
            Object.entries(demoPackCategories).forEach(([id, category]) => {
                if (category === selectedSubject) targetPackIds.add(id);
            });
        }
        if (selectedPackId !== 'all') targetPackIds = new Set([selectedPackId]);

        const filteredLogs = removeKnownLegacyDuplicates((rawLogs || [])
            .filter(log => targetPackIds.has(getPackId(log)))
            .filter(log => Number.isFinite(Number(log.timestamp))));

        if (filteredLogs.length === 0) {
            renderEmptyState();
            if (calendarGrid) calendarGrid.innerHTML = '';
            if (weeklyStatsList) weeklyStatsList.innerHTML = '';
            return;
        }

        const logsByProblem = new Map();
        filteredLogs.forEach(log => {
            const key = getProblemKey(log);
            if (!logsByProblem.has(key)) logsByProblem.set(key, []);
            logsByProblem.get(key).push(log);
        });
        logsByProblem.forEach(problemLogs => problemLogs.sort((a, b) => a.timestamp - b.timestamp));

        const fsrsMap = new Map((fsrsStates || []).map(item => [item.id, item]));
        const statsMap = new Map((problemStats || []).map(item => [item.problemId, item]));
        const packMap = new Map((packs || []).map(pack => [pack.id, pack]));
        const snapshotMap = buildProblemSnapshotMap(sessions);

        let firstCorrect = 0;
        let firstTotal = 0;
        let reviewCorrect = 0;
        let reviewTotal = 0;
        let masteredCount = 0;
        currentWeaknessProblems = [];

        logsByProblem.forEach((problemLogs, problemKey) => {
            const normalLogs = problemLogs.filter(isPrimaryLog);
            if (normalLogs.length) {
                const firstLog = normalLogs[0];
                firstTotal++;
                if (firstLog.isCorrect === true) firstCorrect++;
            }

            const reviewLogs = problemLogs.filter(log => {
                const mode = getLogMode(log);
                return mode === 'review' || mode === 'weakness_training' || mode === 'interim_review' ||
                    log.attemptType === 'interim_review' || log.attemptType === 'retry_current';
            });
            reviewTotal += reviewLogs.length;
            reviewCorrect += reviewLogs.filter(log => log.isCorrect === true).length;

            const eligibleLogs = problemLogs.filter(log => getLogMode(log) !== 'final_check' && !log.isCheckQuestion);
            if (!eligibleLogs.length) return;

            let hadAgain = false;
            let againTime = 0;
            let isOvercome = false;
            for (const log of eligibleLogs) {
                if (log.rating === 1 || log.isCorrect === false) {
                    hadAgain = true;
                    againTime = log.timestamp;
                } else if (hadAgain && (log.rating === 3 || log.rating === 4) &&
                    log.timestamp - againTime >= 24 * 60 * 60 * 1000) {
                    isOvercome = true;
                    break;
                }
            }
            if (isOvercome) masteredCount++;

            const recentLogs = eligibleLogs.slice(-3);
            const hasRecentMistake = recentLogs.some(log => log.rating === 1 || log.isCorrect === false);
            const correctCount = eligibleLogs.filter(log => log.isCorrect === true).length;
            const accuracy = eligibleLogs.length ? correctCount / eligibleLogs.length : 0;
            const isLowAccuracy = accuracy < 0.8;

            const lastLog = eligibleLogs[eligibleLogs.length - 1];
            const fsrs = fsrsMap.get(problemKey) || fsrsMap.get(`${getPackId(lastLog)}:${getQuestionId(lastLog)}`);
            const isImmature = hadAgain && (!fsrs || (Number(fsrs.intervalDays) || 0) < 3);

            if (hasRecentMistake || isLowAccuracy || isImmature) {
                const packId = getPackId(lastLog);
                const questionId = getQuestionId(lastLog);
                const revision = Number(lastLog.revision) || 1;
                const pack = packMap.get(packId);
                let problem = pack?.problems?.find(item =>
                    String(item.questionId || item.problemId) === questionId && (Number(item.revision) || 1) === revision
                );
                problem ||= snapshotMap.get(problemKey);
                problem ||= statsMap.get(problemKey)?.problemData;

                if (!problem) {
                    problem = {
                        type: lastLog.problemType || 'enter',
                        largeText: `問題データを復元できません (${questionId})`,
                        correctAnswer: '問題パックまたは履歴スナップショットがありません',
                        packId,
                        questionId,
                        revision,
                        problemKey
                    };
                }

                let reason = '要復習';
                if (hasRecentMistake) reason = '直近ミス';
                else if (isLowAccuracy) reason = `正答率${Math.round(accuracy * 100)}%`;
                else if (isImmature) reason = '未定着';

                currentWeaknessProblems.push({
                    ...problem,
                    packId,
                    questionId,
                    revision,
                    problemKey,
                    weaknessReason: reason,
                    accuracy: Math.round(accuracy * 100)
                });
            }
        });

        const targetFsrs = (fsrsStates || []).filter(item => targetPackIds.has(item.packId));
        const matureCount = targetFsrs.filter(item => (Number(item.intervalDays) || 0) >= 7).length;

        if (statMasteredCount) statMasteredCount.textContent = masteredCount;
        if (statMatureCount) statMatureCount.textContent = matureCount;
        if (statFirstAccuracy) statFirstAccuracy.textContent = firstTotal ? `${Math.round(firstCorrect / firstTotal * 100)}%` : '--%';
        if (statFirstTotal) statFirstTotal.textContent = `${firstTotal}問中 ${firstCorrect}問`;
        if (statReviewAccuracy) statReviewAccuracy.textContent = reviewTotal ? `${Math.round(reviewCorrect / reviewTotal * 100)}%` : '--%';
        if (statReviewTotal) statReviewTotal.textContent = `${reviewTotal}回中 ${reviewCorrect}回`;

        renderCalendarHeatmap(filteredLogs);
        renderWeeklyStats(logsByProblem);
        renderWeaknessList(currentWeaknessProblems);
    } catch (error) {
        console.error('[Q-One:Error] ダッシュボード集計エラー:', error);
        if (problemListContainer) {
            problemListContainer.textContent = '分析データを読み込めませんでした。コンソールで原因を確認してください。';
        }
    }
}

function renderCalendarHeatmap(logs) {
    if (!calendarGrid) return;
    calendarGrid.innerHTML = '';
    const dayCounts = new Map();
    logs.forEach(log => {
        const key = localDateKey(new Date(log.timestamp));
        dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
    });

    const now = new Date();
    for (let offset = 27; offset >= 0; offset--) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
        const key = localDateKey(day);
        const count = dayCounts.get(key) || 0;
        const level = count >= 20 ? 'level-3' : (count >= 10 ? 'level-2' : (count >= 1 ? 'level-1' : ''));
        const cell = document.createElement('div');
        cell.className = `calendar-day-cell ${level}`;
        cell.title = `${key}: ${count}回回答`;
        cell.textContent = day.getDate();
        calendarGrid.appendChild(cell);
    }
}

function renderWeeklyStats(logsByProblem) {
    if (!weeklyStatsList) return;
    weeklyStatsList.innerHTML = '';
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const weeks = [
        { label: '今週', start: now - weekMs, end: now, firstTotal: 0, firstCorrect: 0 },
        { label: '先週', start: now - weekMs * 2, end: now - weekMs, firstTotal: 0, firstCorrect: 0 },
        { label: '2週前', start: now - weekMs * 3, end: now - weekMs * 2, firstTotal: 0, firstCorrect: 0 },
        { label: '3週前', start: now - weekMs * 4, end: now - weekMs * 3, firstTotal: 0, firstCorrect: 0 }
    ];

    logsByProblem.forEach(problemLogs => {
        const first = problemLogs.filter(isPrimaryLog)[0];
        if (!first) return;
        const week = weeks.find(item => first.timestamp >= item.start && first.timestamp < item.end);
        if (week) {
            week.firstTotal++;
            if (first.isCorrect === true) week.firstCorrect++;
        }
    });

    weeks.forEach(week => {
        const rate = week.firstTotal ? `${Math.round(week.firstCorrect / week.firstTotal * 100)}%` : 'データなし';
        const row = document.createElement('div');
        row.className = 'weekly-stat-row';
        const label = document.createElement('span');
        label.textContent = `${week.label} (${week.firstTotal}問)`;
        const value = document.createElement('span');
        value.className = 'weekly-stat-rate';
        value.textContent = rate;
        row.append(label, value);
        weeklyStatsList.appendChild(row);
    });
}

function renderWeaknessList(problems) {
    if (!problemListContainer) return;
    problemListContainer.innerHTML = '';
    if (!problems.length) {
        problemListContainer.innerHTML = '<div class="analysis-empty-state"><p>現在、克服が必要な苦手問題はありません。</p></div>';
        if (trainBtn) trainBtn.disabled = true;
        if (trainBtnText) trainBtnText.textContent = '苦手克服特訓 (0問)';
        return;
    }

    problems.forEach(problem => {
        const element = document.createElement('div');
        element.className = 'analysis-problem-card';
        const header = document.createElement('div');
        header.className = 'analysis-card-header';
        const reason = document.createElement('span');
        reason.className = 'analysis-badge danger';
        reason.textContent = problem.weaknessReason || '要復習';
        const accuracy = document.createElement('span');
        accuracy.style.cssText = 'font-size:0.8rem;color:var(--secondary-color);';
        accuracy.textContent = `正答率: ${problem.accuracy ?? 0}%`;
        header.append(reason, accuracy);
        const question = document.createElement('div');
        question.className = 'analysis-card-q';
        question.textContent = problem.largeText || '問題文';
        const answer = document.createElement('div');
        answer.className = 'analysis-card-ans';
        answer.textContent = `正解: ${problem.correctAnswer || problem.smallText || problem.answers?.join(', ') || '―'}`;
        element.append(header, question, answer);
        problemListContainer.appendChild(element);
    });

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
    if (problemListContainer) {
        problemListContainer.innerHTML = '<div class="analysis-empty-state"><p>学習データがまだありません。問題を解くと分析が反映されます。</p></div>';
    }
    if (trainBtn) trainBtn.disabled = true;
    if (trainBtnText) trainBtnText.textContent = '苦手克服特訓 (0問)';
}

function updateFilterSelects(packs) {
    if (!subjectSelect || !packSelect) return;
    const subjects = new Set(['数学', '現代文', '古典', '漢文', '英語', '物理', '化学', '生物', '日本史', '世界史', '地理', '公共']);
    (packs || []).forEach(pack => { if (pack.category) subjects.add(pack.category); });

    const currentSubject = subjectSelect.value;
    subjectSelect.innerHTML = '<option value="all">全教科横断</option>';
    subjects.forEach(subject => {
        const option = document.createElement('option');
        option.value = subject;
        option.textContent = subject;
        subjectSelect.appendChild(option);
    });
    if ([...subjectSelect.options].some(option => option.value === currentSubject)) subjectSelect.value = currentSubject;

    const currentPack = packSelect.value;
    packSelect.innerHTML = '<option value="all">全パック</option><option value="manual_input">テキスト入力履歴</option><option value="math-sample">高校数学Ⅰ・A デモ</option><option value="japanese-sample">古典・重要語句 デモ</option>';
    (packs || []).forEach(pack => {
        const option = document.createElement('option');
        option.value = pack.id;
        option.textContent = pack.title || pack.id;
        packSelect.appendChild(option);
    });
    if ([...packSelect.options].some(option => option.value === currentPack)) packSelect.value = currentPack;
}

export function initAnalysisModule() {
    subjectSelect?.addEventListener('change', renderAnalysisDashboard);
    packSelect?.addEventListener('change', renderAnalysisDashboard);
    trainBtn?.addEventListener('click', () => {
        if (!currentWeaknessProblems.length) return;
        if (confirm(`抽出された苦手問題（${currentWeaknessProblems.length}問）で特訓を開始しますか？`)) {
            startNewPass(currentWeaknessProblems, true, { mode: 'weakness_training' });
        }
    });
    const analysisRadio = document.getElementById('mode-analysis');
    analysisRadio?.addEventListener('change', () => {
        if (analysisRadio.checked) renderAnalysisDashboard();
    });
}
