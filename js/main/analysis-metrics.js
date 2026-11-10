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

/** 今日を含む直近7日間の解答正答率と学習日数を集計する。 */
export function summarizeRecentLearning(logs, now = new Date()) {
    const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (Number.isNaN(current.getTime())) throw new TypeError('集計日時が不正です。');

    const start = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 6).getTime();
    const end = current.getTime();
    const recentLogs = (Array.isArray(logs) ? logs : []).filter(log => {
        const timestamp = Number(log?.timestamp);
        return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
    });
    const correctCount = recentLogs.filter(log => log.isCorrect === true || log.isCorrect === 1 || log.isCorrect === 'true').length;
    const learningDates = new Set(recentLogs.map(log => {
        const date = new Date(Number(log.timestamp));
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }));

    return {
        totalAttempts: recentLogs.length,
        correctAttempts: correctCount,
        accuracyPercent: calculateAccuracyPercent(correctCount, recentLogs.length),
        learningDays: learningDates.size
    };
}

/** 優先度の高い苦手問題を先に並べる。スコアは表示せず、根拠の順で比較する。 */
export function sortWeaknessProblems(problems) {
    return [...(Array.isArray(problems) ? problems : [])].sort((a, b) => {
        const compareDescending = (left, right) => (Number(right) || 0) - (Number(left) || 0);
        const recentMistakes = compareDescending(a.recentIncorrectCount, b.recentIncorrectCount);
        if (recentMistakes) return recentMistakes;

        const duePriority = compareDescending(a.isScheduledDue ? 1 : 0, b.isScheduledDue ? 1 : 0);
        if (duePriority) return duePriority;

        const againPriority = compareDescending(a.recentAgainCount, b.recentAgainCount);
        if (againPriority) return againPriority;

        const accuracyPriority = (Number(a.accuracy) || 0) - (Number(b.accuracy) || 0);
        if (accuracyPriority) return accuracyPriority;

        const mistakeRecency = compareDescending(a.lastIncorrectAt, b.lastIncorrectAt);
        if (mistakeRecency) return mistakeRecency;

        const activityRecency = compareDescending(a.latestAttemptAt, b.latestAttemptAt);
        if (activityRecency) return activityRecency;

        return String(a.problemKey || '').localeCompare(String(b.problemKey || ''));
    });
}
