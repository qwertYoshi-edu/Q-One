import * as db from './db.js';
import {
    profileModal, profileNameInput,
    statTotalQuestions, statCorrectRate, statLearningDays
} from './dom.js';

export async function openProfileModal() {
    if (!profileModal) return;
    profileModal.classList.add('active');
    await loadUserProfile();
    await loadStatistics();
}

async function loadUserProfile() {
    if (!profileNameInput) return;
    const userSetting = await db.get('user_settings', 'username');
    if (userSetting?.value) profileNameInput.value = userSetting.value;
}

export async function saveUsername(newName) {
    await db.put('user_settings', { key: 'username', value: String(newName || '').trim() || 'ゲスト' });
}

async function loadStatistics() {
    const [sessions, logs] = await Promise.all([
        db.getAll('test_sessions'),
        db.getAll('answer_logs')
    ]);

    const totals = {
        answered: 0,
        correct: 0,
        days: new Set(),
        normal: { answered: 0, correct: 0 },
        final_check: { answered: 0, correct: 0 },
        review: { answered: 0, correct: 0 },
        retry: { answered: 0, correct: 0 },
        weakness_training: { answered: 0, correct: 0 }
    };

    for (const session of sessions || []) {
        const answeredValue = session.learningAnsweredCount ?? session.answeredCount ?? session.totalQuestions;
        const correctValue = session.learningCorrectCount ?? session.correctCount ?? 0;
        const answered = Math.max(0, Number(answeredValue) || 0);
        const correct = Math.min(answered, Math.max(0, Number(correctValue) || 0));
        totals.answered += answered;
        totals.correct += correct;

        const mode = session.mode || 'normal';
        let category = mode;
        if (mode === 'history_retry' || mode === 'retry_all') category = 'retry';
        if (!totals[category]) category = 'normal';
        totals[category].answered += answered;
        totals[category].correct += correct;

        if (session.startedAt) {
            const date = new Date(session.startedAt);
            if (!Number.isNaN(date.getTime())) {
                totals.days.add(`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`);
            }
        }
    }

    const sessionsById = new Map((sessions || []).map(session => [session.id, session]));
    const checkBySessionProblem = new Map();
    for (const log of logs || []) {
        if (log.attemptType === 'final_check' || log.mode === 'final_check' ||
            sessionsById.get(log.sessionId)?.mode === 'final_check') continue;
        if (log.problemType !== 'check' && log.attemptType !== 'check_understanding') continue;
        const key = `${log.sessionId || 'unknown'}|${log.problemKey || log.questionId || log.problemId || log.id}`;
        const previous = checkBySessionProblem.get(key);
        if (!previous || (Number(log.timestamp) || 0) >= (Number(previous.timestamp) || 0)) {
            checkBySessionProblem.set(key, log);
        }
    }
    const checkLogs = [...checkBySessionProblem.values()];
    const checkCorrect = checkLogs.filter(log => log.isCorrect === true || log.isCorrect === 1).length;

    const correctRate = totals.answered > 0 ? Math.round(totals.correct / totals.answered * 100) : 0;
    if (statTotalQuestions) statTotalQuestions.textContent = String(totals.answered);
    if (statCorrectRate) statCorrectRate.textContent = `${correctRate}%`;
    if (statLearningDays) statLearningDays.textContent = String(totals.days.size);

    const breakdown = document.getElementById('stat-mode-breakdown');
    if (breakdown) {
        const format = (label, data) => `${label} ${data.answered}問・${data.correct}問正解`;
        breakdown.textContent = [
            format('通常学習', totals.normal),
            format('直前チェック', totals.final_check),
            format('誤答復習', totals.review),
            format('再挑戦', totals.retry),
            format('苦手特訓', totals.weakness_training),
            `確認型問題の理解度 ${checkCorrect}/${checkLogs.length}問`
        ].join(' / ');
    }
}
