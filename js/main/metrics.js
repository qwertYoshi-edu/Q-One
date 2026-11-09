/**
 * Shared answer-log compatibility helpers.
 * Old releases wrote two rows for one rated answer and did not persist
 * per-session answer counters. These helpers de-duplicate only the known
 * legacy pair in memory and derive safe display metrics without mutating DB.
 */
export function removeKnownLegacyDuplicates(logs) {
    const sorted = [...(logs || [])].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const usedRich = new Set();
    const suppressed = new Set();
    const richBySessionAndCorrectness = new Map();

    // Pair candidates are indexed by session/correctness and time so a large
    // history does not require an all-records quadratic scan.
    sorted.forEach((candidate, index) => {
        if (!candidate.problemKey || !candidate.packId || !candidate.questionId || !candidate.sessionId) return;
        const groupKey = `${candidate.sessionId}\u0000${String(candidate.isCorrect)}`;
        if (!richBySessionAndCorrectness.has(groupKey)) richBySessionAndCorrectness.set(groupKey, []);
        richBySessionAndCorrectness.get(groupKey).push(index);
    });

    const lowerBound = (indices, timestamp) => {
        let low = 0;
        let high = indices.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if ((sorted[indices[middle]].timestamp || 0) < timestamp) low = middle + 1;
            else high = middle;
        }
        return low;
    };

    sorted.forEach((legacy, index) => {
        const isLegacyShape = !legacy.problemKey || !legacy.packId || !legacy.questionId;
        if (!isLegacyShape || !legacy.sessionId || !legacy.problemId) return;

        const hashPrefix = String(legacy.problemId).split('-')[0].slice(0, 6);
        const candidateIndices = richBySessionAndCorrectness.get(`${legacy.sessionId}\u0000${String(legacy.isCorrect)}`) || [];
        if (!candidateIndices.length) return;

        const timestamp = legacy.timestamp || 0;
        const startAt = lowerBound(candidateIndices, timestamp - 5 * 60 * 1000);
        let nearestIndex = -1;
        let nearestDelta = Infinity;
        for (let position = startAt; position < candidateIndices.length; position++) {
            const candidateIndex = candidateIndices[position];
            const candidate = sorted[candidateIndex];
            const delta = Math.abs((candidate.timestamp || 0) - timestamp);
            if (delta > 5 * 60 * 1000) break;
            if (candidateIndex === index || usedRich.has(candidateIndex) || delta >= nearestDelta) continue;
            const identity = `${candidate.questionId} ${candidate.problemKey} ${candidate.problemId || ''}`;
            if (!identity.includes(hashPrefix) && candidate.problemId !== legacy.problemId) continue;
            nearestDelta = delta;
            nearestIndex = candidateIndex;
        }

        if (nearestIndex >= 0) {
            usedRich.add(nearestIndex);
            suppressed.add(index);
        }
    });

    return sorted.filter((_, index) => !suppressed.has(index));
}

/** Build legacy metrics keyed by session ID. New sessions use stored counters. */
export function buildLegacySessionMetrics(logs, sessions = []) {
    const sessionModes = new Map((sessions || []).map(session => [session.id, session.mode || 'normal']));
    const bySession = new Map();

    removeKnownLegacyDuplicates(logs).forEach(log => {
        if (!log?.sessionId) return;
        if (!bySession.has(log.sessionId)) bySession.set(log.sessionId, new Map());

        const packId = log.packId || 'manual_input';
        const questionId = log.questionId || log.problemId || 'unknown';
        const revision = Number(log.revision) || 1;
        const key = log.problemKey || (log.packId && log.questionId
            ? `${packId}:${questionId}:r${revision}`
            : `legacy:${log.problemId || questionId}`);
        const groupMap = bySession.get(log.sessionId);
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key).push(log);
    });

    const result = new Map();
    bySession.forEach((problemGroups, sessionId) => {
        const metrics = {
            answered: 0,
            correct: 0,
            retryAnswered: 0,
            interimReviewAnswered: 0,
            checkAnswered: 0,
            checkCorrect: 0
        };

        problemGroups.forEach(group => {
            group.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            const firstLog = group.find(log => log.attemptType === 'first') ||
                group.find(log => log.attemptType === undefined && log.isInterimReview !== true) ||
                group[0];
            if (!firstLog) return;

            metrics.answered++;
            if (firstLog.isCorrect === true) metrics.correct++;

            const sessionMode = sessionModes.get(sessionId) || 'normal';
            if (sessionMode === 'final_check' || firstLog.isCheckQuestion === true || firstLog.problemType === 'check') {
                metrics.checkAnswered++;
                if (firstLog.isCorrect === true) metrics.checkCorrect++;
            }

            group.forEach(log => {
                if (log === firstLog) return;
                if (log.isInterimReview === true || log.attemptType === 'interim_review') metrics.interimReviewAnswered++;
                else metrics.retryAnswered++;
            });
        });

        result.set(sessionId, metrics);
    });

    return result;
}
