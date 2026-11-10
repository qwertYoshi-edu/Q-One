import * as DB from './db.js';
const CHECKPOINT_KEY = 'scheduledReviewCheckpoint';

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
