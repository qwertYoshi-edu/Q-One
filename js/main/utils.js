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
// FSRS (Free Spaced Repetition Scheduler) 軽量コアロジック
// Rating: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
// ============================================================================
export const FSRS_RATINGS = {
    AGAIN: 1,
    HARD: 2,
    GOOD: 3,
    EASY: 4
};

/**
 * 初期のFSRS状態オブジェクトを生成
 */
export function createInitialFSRSState(problemKey, packId, questionId, revision = 1) {
    return {
        id: problemKey,         // packId + ":" + questionId
        packId: packId || 'manual_input',
        questionId: questionId,
        revision: revision,
        stability: 0,           // 記憶の定着度（日数に比例）
        difficulty: 5.0,        // 難易度 (1.0〜10.0)
        reps: 0,                // 総学習回数
        lapses: 0,              // Againになった回数
        state: 0,               // 0: New, 1: Learning, 2: Review
        lastReview: null,       // 最終復習日時 (timestamp)
        due: Date.now(),        // 次回復習日時 (timestamp)
        intervalDays: 0         // 次回までの間隔（日）
    };
}

/**
 * 評価をもとに次のFSRS状態を計算
 * @param {Object} prevState 以前のFSRSState
 * @param {number} rating 1 (Again), 2 (Hard), 3 (Good), 4 (Easy)
 * @param {number} now 実行時刻 (Date.now())
 */
export function calculateNextFSRSState(prevState, rating, now = Date.now()) {
    const state = prevState ? { ...prevState } : createInitialFSRSState();
    const elapsedDays = state.lastReview ? Math.max(0, (now - state.lastReview) / (1000 * 60 * 60 * 24)) : 0;
    
    let { stability, difficulty, reps, lapses } = state;

    // 難易度の更新
    const difficultyDelta = (rating === FSRS_RATINGS.AGAIN) ? 1.0 : (rating === FSRS_RATINGS.HARD ? 0.5 : (rating === FSRS_RATINGS.EASY ? -0.8 : -0.2));
    difficulty = Math.min(10.0, Math.max(1.0, difficulty + difficultyDelta));

    let nextIntervalDays = 1;

    if (state.reps === 0) {
        // 初回学習時
        switch (rating) {
            case FSRS_RATINGS.AGAIN: stability = 0.5; nextIntervalDays = 0.1; break; // 2〜3時間後
            case FSRS_RATINGS.HARD:  stability = 1.0; nextIntervalDays = 1; break;
            case FSRS_RATINGS.GOOD:  stability = 3.0; nextIntervalDays = 3; break;
            case FSRS_RATINGS.EASY:  stability = 7.0; nextIntervalDays = 7; break;
        }
        state.state = (rating === FSRS_RATINGS.AGAIN) ? 1 : 2;
    } else {
        // 復習時
        if (rating === FSRS_RATINGS.AGAIN) {
            lapses += 1;
            stability = Math.max(0.5, stability * 0.4); // 忘却による安定性低下
            nextIntervalDays = 0.1;
            state.state = 1; // 再学習
        } else {
            // 正解時：間隔を拡大
            const hardFactor = (rating === FSRS_RATINGS.HARD) ? 0.8 : (rating === FSRS_RATINGS.EASY ? 1.4 : 1.0);
            const retrievability = Math.exp(-elapsedDays / Math.max(0.1, stability));
            stability = stability * (1 + Math.exp(1 - difficulty / 10) * (1 - retrievability) * hardFactor);
            nextIntervalDays = Math.max(1, Math.round(stability));
            state.state = 2; // 復習
        }
    }

    reps += 1;

    return {
        ...state,
        stability: parseFloat(stability.toFixed(2)),
        difficulty: parseFloat(difficulty.toFixed(2)),
        reps,
        lapses,
        lastReview: now,
        intervalDays: nextIntervalDays,
        due: now + (nextIntervalDays * 24 * 60 * 60 * 1000)
    };
}
