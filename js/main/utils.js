export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

export function normalizeSinglePart(str) {
    if (typeof str !== 'string') return '';
    let s = str.trim().replace(/\.\.\./g, '…');
    s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[。、.,!！?？\-ー_]/g, '');
    s = s.replace(/\s+/g, '');
    return s.toLowerCase();
}

export function normalizeAnswer(str) {
    if (typeof str !== 'string') return '';
    const s = str.trim();
    if (s.includes('、') || s.includes(',')) {
        return s.split(/[、,]/).map(part => normalizeSinglePart(part)).filter(Boolean).sort().join('');
    }
    return normalizeSinglePart(s);
}

// ============================================================================
// Q-One Simple Interval Scheduler (独自の簡易間隔反復アルゴリズム)
// FSRSの実装ではない。学習効果の実証を意味するものではない。
// Rating: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
// ============================================================================
export const REVIEW_RATINGS = Object.freeze({
    AGAIN: 1,
    HARD: 2,
    GOOD: 3,
    EASY: 4
});

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** 新規問題の復習状態を作成する。 */
export function createInitialReviewState(problemKey, packId, questionId, revision = 1, now = Date.now()) {
    return {
        id: problemKey,
        packId: packId || 'manual_input',
        questionId: questionId || 'unknown',
        revision: Number.isInteger(revision) && revision > 0 ? revision : 1,
        difficulty: 5,             // 1 (易しい) ～ 10 (難しい)
        reps: 0,
        lapses: 0,
        state: 0,                  // 0: New, 1: Learning, 2: Review
        lastReview: null,
        due: now,
        intervalDays: 0,
        lastRating: null,
        ratingHistory: [],
        algorithm: 'qone-simple-v1',
        createdAt: now,
        updatedAt: now
    };
}

/** 問題改訂時は旧内容の復習履歴を引き継がず、新しい状態を作る。 */
export function resolveReviewStateForRevision(previousState, problemKey, packId, questionId, revision = 1, now = Date.now()) {
    const safeRevision = Number.isInteger(revision) && revision > 0 ? revision : 1;
    if (!previousState || Number(previousState.revision || 1) !== safeRevision) {
        return createInitialReviewState(problemKey, packId, questionId, safeRevision, now);
    }
    return previousState;
}

/**
 * 4段階評価に応じた次回復習状態を計算する。
 *
 * 初回: Again=10分、Hard=1日、Good=3日、Easy=7日。
 * 2回目以降: 基準倍率 (0.25 / 1.2 / 2.0 / 2.8) × 難易度係数。
 * 難易度係数は 1.1 - (difficulty - 1) × 0.02 (0.92～1.10)。
 * Again は最大でも1日、最低10分。その他は最低1日、最大3650日。
 * このルールは説明可能性を優先した独自設計であり、FSRSではなく、
 * 記憶保持率や学習成績を保証・予測するモデルではない。
 */
export function calculateNextReviewState(previousState, rating, now = Date.now()) {
    if (![1, 2, 3, 4].includes(Number(rating))) {
        throw new RangeError(`不正な復習評価です: ${rating}`);
    }
    if (!Number.isFinite(now)) throw new TypeError('復習日時は有限の数値で指定してください。');

    const previous = previousState
        ? { ...createInitialReviewState(previousState.id, previousState.packId, previousState.questionId, previousState.revision, now), ...previousState }
        : createInitialReviewState(null, null, null, 1, now);
    const normalizedRating = Number(rating);
    const repsBefore = Math.max(0, Number(previous.reps) || 0);
    const previousInterval = Math.max(0, Number(previous.intervalDays) || 0);
    let difficulty = Math.min(10, Math.max(1, Number(previous.difficulty) || 5));
    let intervalDays;

    const difficultyDelta = {
        [REVIEW_RATINGS.AGAIN]: 1.0,
        [REVIEW_RATINGS.HARD]: 0.35,
        [REVIEW_RATINGS.GOOD]: -0.15,
        [REVIEW_RATINGS.EASY]: -0.4
    }[normalizedRating];
    difficulty = Math.min(10, Math.max(1, difficulty + difficultyDelta));

    if (repsBefore === 0) {
        intervalDays = {
            [REVIEW_RATINGS.AGAIN]: 10 / 1440,
            [REVIEW_RATINGS.HARD]: 1,
            [REVIEW_RATINGS.GOOD]: 3,
            [REVIEW_RATINGS.EASY]: 7
        }[normalizedRating];
    } else if (normalizedRating === REVIEW_RATINGS.AGAIN) {
        intervalDays = Math.max(10 / 1440, Math.min(1, previousInterval * 0.25));
    } else {
        const multiplier = {
            [REVIEW_RATINGS.HARD]: 1.2,
            [REVIEW_RATINGS.GOOD]: 2.0,
            [REVIEW_RATINGS.EASY]: 2.8
        }[normalizedRating];
        const difficultyFactor = 1.1 - (difficulty - 1) * 0.02;
        intervalDays = Math.min(3650, Math.max(1, previousInterval * multiplier * difficultyFactor));
    }

    const history = Array.isArray(previous.ratingHistory) ? previous.ratingHistory.slice(-19) : [];
    history.push({ rating: normalizedRating, at: now });
    const lapses = Math.max(0, Number(previous.lapses) || 0) + (normalizedRating === REVIEW_RATINGS.AGAIN && repsBefore > 0 ? 1 : 0);
    const roundedInterval = Number(intervalDays.toFixed(4));

    return {
        ...Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'easeFactor' && key !== 'stability')),
        difficulty: Number(difficulty.toFixed(2)),
        reps: repsBefore + 1,
        lapses,
        state: normalizedRating === REVIEW_RATINGS.AGAIN || repsBefore < 2 ? 1 : 2,
        lastReview: now,
        intervalDays: roundedInterval,
        due: now + roundedInterval * DAY_MS,
        lastRating: normalizedRating,
        ratingHistory: history,
        algorithm: 'qone-simple-v1',
        updatedAt: now
    };
}

/** 現地時間の今日の開始・翌日開始を返す (DSTの日も暦日で計算)。 */
export function getLocalDayBounds(now = new Date()) {
    const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (Number.isNaN(date.getTime())) throw new TypeError('日付が不正です。');
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 1);
    return { start: start.getTime(), end: end.getTime() };
}

/** 保存済みスケジュールを端末の現地日付で分類する。 */
export function classifyReviewStates(reviewStates, now = new Date(), upcomingDays = 3) {
    const { start, end } = getLocalDayBounds(now);
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const upcomingEndDate = new Date(end);
    upcomingEndDate.setDate(upcomingEndDate.getDate() + Math.max(0, upcomingDays));
    const upcomingEnd = upcomingEndDate.getTime();
    const valid = (Array.isArray(reviewStates) ? reviewStates : [])
        .filter(item => item && typeof item.id === 'string' && item.due !== null && item.due !== undefined && Number.isFinite(Number(item.due)))
        .sort((a, b) => Number(a.due) - Number(b.due));
    return {
        // 現在時刻より前の予定と、今日これからの予定を分ける。今日の予定は先取り出題しない。
        overdue: valid.filter(item => Number(item.due) <= nowTime),
        dueToday: valid.filter(item => Number(item.due) > nowTime && Number(item.due) < end),
        upcoming: valid.filter(item => Number(item.due) >= end && Number(item.due) < upcomingEnd),
        all: valid,
        dayStart: start,
        dayEnd: end,
        upcomingEnd
    };
}

/** 定着判定を明示的な条件に限定する。 */
export function isMasteredReviewState(reviewState) {
    const history = Array.isArray(reviewState?.ratingHistory) ? reviewState.ratingHistory : [];
    const lastThree = history.slice(-3);
    return Number(reviewState?.reps) >= 3 &&
        Number(reviewState?.intervalDays) >= 7 &&
        lastThree.length === 3 &&
        lastThree.every(item => Number(item?.rating) >= REVIEW_RATINGS.GOOD);
}
