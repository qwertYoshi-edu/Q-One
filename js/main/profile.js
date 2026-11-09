import * as db from './db.js';
import { buildLegacySessionMetrics } from './metrics.js';
import {
    profileModal, profileNameInput,
    statTotalQuestions, statCorrectRate, statLearningDays
} from './dom.js';

export async function openProfileModal() {
    if (!profileModal) return;
    profileModal.classList.add('active');
    try {
        await loadUserProfile();
        await loadStatistics();
    } catch (error) {
        console.error('[Q-One:Error] プロフィールの読み込みに失敗しました:', error);
        alert('プロフィール情報を読み込めませんでした。ストレージの状態を確認してください。');
    }
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
    const legacyMetrics = buildLegacySessionMetrics(logs, sessions);
    let totalAnswered = 0;
    let totalCorrect = 0;
    let checkAnswered = 0;
    let checkCorrect = 0;
    const uniqueDays = new Set();
    const modeStats = new Map([
        ['normal', { label: '通常学習', answered: 0, correct: 0 }],
        ['final_check', { label: '直前チェック', answered: 0, correct: 0 }],
        ['review', { label: '復習', answered: 0, correct: 0 }],
        ['weakness_training', { label: '苦手克服特訓', answered: 0, correct: 0 }]
    ]);
    let interimReviewAnswered = 0;

    sessions.forEach(session => {
        const legacy = legacyMetrics.get(session.id);
        const answered = Number.isFinite(session.answeredCount)
            ? Math.max(0, session.answeredCount)
            : Math.max(0, legacy?.answered ?? (session.completedAt ? Number(session.totalQuestions) || 0 : 0));
        const correct = Number.isFinite(session.answeredCount)
            ? Math.min(answered, Math.max(0, Number(session.correctCount) || 0))
            : Math.min(answered, Math.max(0, legacy?.correct ?? (Number(session.correctCount) || 0)));
        totalAnswered += answered;
        totalCorrect += correct;

        const mode = modeStats.has(session.mode) ? session.mode : 'normal';
        const bucket = modeStats.get(mode);
        bucket.answered += answered;
        bucket.correct += correct;

        const sessionCheckAnswered = Math.max(0, Number(session.checkAnsweredCount) || legacy?.checkAnswered || 0);
        checkAnswered += sessionCheckAnswered;
        checkCorrect += Math.min(sessionCheckAnswered, Number(session.checkAnsweredCount) > 0
            ? Math.max(0, Number(session.checkOKCount) || 0)
            : Math.max(0, legacy?.checkCorrect || 0));
        interimReviewAnswered += Math.max(0, Number(session.interimReviewAnsweredCount) || legacy?.interimReviewAnswered || 0);

        if (session.startedAt) {
            const date = new Date(session.startedAt);
            const dateString = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            uniqueDays.add(dateString);
        }
    });

    const correctRate = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
    if (statTotalQuestions) statTotalQuestions.textContent = totalAnswered;
    if (statCorrectRate) statCorrectRate.textContent = totalAnswered > 0 ? `${correctRate}%` : '--%';
    if (statLearningDays) statLearningDays.textContent = uniqueDays.size;

    const modeBreakdown = document.getElementById('stat-mode-breakdown');
    if (modeBreakdown) {
        const rows = [...modeStats.values()].map(item => {
            const rate = item.answered ? `${Math.round(item.correct / item.answered * 100)}%` : '--%';
            return `${item.label}: ${item.answered}問 / 正答率 ${rate}`;
        });
        const checkRate = checkAnswered ? `${Math.round(checkCorrect / checkAnswered * 100)}%` : '--%';
        rows.push(`確認型の理解度: ${checkAnswered}問 / ${checkRate}`);
        rows.push(`一旦復習: ${interimReviewAnswered}回`);
        modeBreakdown.textContent = rows.join('　｜　');
    }
}
