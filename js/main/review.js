import * as DB from './db.js';
import { classifyReviewStates } from './utils.js';

const CHECKPOINT_KEY = 'scheduledReviewCheckpoint';

function identityOf(problem, fallbackPackId = 'manual_input', fallbackQuestionId = 'unknown') {
    const packId = problem?.packId || fallbackPackId;
    const questionId = problem?.questionId || problem?.problemId || fallbackQuestionId;
    return `${packId}:${questionId}`;
}

function buildProblemIndex(packs, stats) {
    const index = new Map();
    for (const pack of packs || []) {
        for (let i = 0; i < (pack.problems || []).length; i++) {
            const problem = pack.problems[i];
            const normalized = {
                ...problem,
                packId: pack.id,
                questionId: problem.questionId || problem.problemId || `q_${i + 1}`
            };
            index.set(identityOf(normalized), normalized);
        }
    }
    for (const stat of stats || []) {
        const problem = stat?.problemData;
        if (!problem || typeof problem !== 'object') continue;
        const key = identityOf(problem, stat.packId || 'manual_input', stat.questionId || stat.problemId || 'unknown');
        if (!index.has(key)) index.set(key, problem);
    }
    return index;
}

export async function getReviewOverview(now = new Date()) {
    await DB.initDB();
    const [packs, rawStates, stats] = await Promise.all([
        DB.getAll('packs'),
        DB.getAll('fsrs_states'),
        DB.getAll('problem_stats')
    ]);
    const problemIndex = buildProblemIndex(packs, stats);
    const states = (rawStates || []).filter(item => item && item.id && item.due !== null && item.due !== undefined && Number.isFinite(Number(item.due)));
    const buckets = classifyReviewStates(states, now, 3);
    const toQueueItem = item => {
        const problem = problemIndex.get(item.id);
        return problem && typeof problem.largeText === 'string'
            ? { ...problem, packId: item.packId || problem.packId, questionId: item.questionId || problem.questionId, reviewDue: Number(item.due), reviewState: item }
            : null;
    };
    const overdue = buckets.overdue.map(toQueueItem).filter(Boolean);
    const dueToday = buckets.dueToday.map(toQueueItem).filter(Boolean);
    const upcoming = buckets.upcoming.map(toQueueItem).filter(Boolean);
    const queuedKeys = new Set(states.map(item => item.id));
    const newCount = [...problemIndex.entries()].filter(([key, problem]) => problem?.type !== 'check' && !queuedKeys.has(key)).length;
    return {
        queue: overdue, // 復習予定時刻を迎えた問題のみを出題する。時刻前の予定分は先取りしない。
        todayTargetCount: buckets.overdue.length + buckets.dueToday.length,
        overdueCount: buckets.overdue.length,
        dueTodayCount: buckets.dueToday.length,
        upcomingCount: buckets.upcoming.length,
        newCount,
        unavailableCount: buckets.overdue.length - overdue.length + buckets.dueToday.length - dueToday.length,
        nextDueAt: states.reduce((next, item) => {
            const due = Number(item.due);
            return due > now.getTime() && (next === null || due < next) ? due : next;
        }, null),
        dayStart: buckets.dayStart,
        dayEnd: buckets.dayEnd
    };
}

export async function getScheduledReviewCheckpoint() {
    const stored = await DB.get('user_settings', CHECKPOINT_KEY);
    const value = stored?.value;
    if (!value || value.version !== 1 || !Array.isArray(value.questions) ||
        !Number.isInteger(value.index) || value.index < 0 || value.index >= value.questions.length) {
        if (stored) await DB.remove('user_settings', CHECKPOINT_KEY);
        return null;
    }
    return value;
}

export async function clearScheduledReviewCheckpoint() {
    await DB.remove('user_settings', CHECKPOINT_KEY);
}

export function getCheckpointSetting(questions, nextIndex, now = Date.now()) {
    if (!Array.isArray(questions) || !Number.isInteger(nextIndex)) return null;
    if (nextIndex >= questions.length) return { key: CHECKPOINT_KEY, value: null };
    return {
        key: CHECKPOINT_KEY,
        value: {
            version: 1,
            questions,
            index: Math.max(0, nextIndex),
            updatedAt: now
        }
    };
}

export function getReviewCheckpointKey() {
    return CHECKPOINT_KEY;
}

export async function saveScheduledReviewCheckpoint(questions, index = 0, now = Date.now()) {
    const setting = getCheckpointSetting(questions, index, now);
    if (!setting) throw new Error('復習再開情報を作成できませんでした。');
    await DB.put('user_settings', setting);
    return true;
}
