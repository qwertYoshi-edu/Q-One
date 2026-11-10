/** 問題単位の正答・弱点判定を集計する純粋関数。 */
export function summarizeProblemPerformance(logs) {
    const ordered = [...(Array.isArray(logs) ? logs : [])].sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    if (ordered.length === 0) {
        return { firstLog: null, firstTotal: 0, firstCorrect: 0, reviewTotal: 0, reviewCorrect: 0, accuracy: null, recentLogs: [], hasRecentMistake: false, isLowAccuracy: false, isWeak: false };
    }
    const firstLog = ordered[0];
    const subsequentLogs = ordered.slice(1);
    const correctCount = ordered.filter(log => log.isCorrect === true || log.isCorrect === 1 || log.isCorrect === 'true').length;
    const accuracy = correctCount / ordered.length;
    const recentLogs = ordered.slice(-3);
    const hasRecentMistake = recentLogs.some(log => Number(log.rating) === 1 || !(log.isCorrect === true || log.isCorrect === 1 || log.isCorrect === 'true'));
    const isLowAccuracy = ordered.length >= 2 && accuracy < 0.8;
    return {
        firstLog,
        firstTotal: 1,
        firstCorrect: firstLog.isCorrect === true || firstLog.isCorrect === 1 || firstLog.isCorrect === 'true' ? 1 : 0,
        reviewTotal: subsequentLogs.length,
        reviewCorrect: subsequentLogs.filter(log => log.isCorrect === true || log.isCorrect === 1 || log.isCorrect === 'true').length,
        accuracy,
        recentLogs,
        hasRecentMistake,
        isLowAccuracy,
        isWeak: hasRecentMistake || isLowAccuracy,
        correctCount
    };
}

export function calculateAccuracyPercent(correctCount, totalCount) {
    const correct = Number(correctCount);
    const total = Number(totalCount);
    if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return null;
    return Math.round(Math.max(0, correct) / total * 100);
}


/** 今週（月曜始まり）の学習問題数と学習日数をログから集計する。 */
export function summarizeWeeklyLearning(logs, now = new Date()) {
    const reference = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (!Number.isFinite(reference.getTime())) return { problemCount: 0, learningDays: 0 };

    const weekStart = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const problemKeys = new Set();
    const learningDays = new Set();

    for (const log of Array.isArray(logs) ? logs : []) {
        const timestamp = Number(log?.timestamp);
        if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > reference.getTime()) continue;
        const date = new Date(timestamp);
        if (date < weekStart) continue;
        if (typeof log.problemKey === 'string' && log.problemKey.length > 0) problemKeys.add(log.problemKey);
        learningDays.add(`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`);
    }

    return { problemCount: problemKeys.size, learningDays: learningDays.size };
}
