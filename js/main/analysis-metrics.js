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

