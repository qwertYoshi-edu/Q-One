import * as db from './db.js';
import { 
    profileModal, profileNameInput, 
    statTotalQuestions, statCorrectRate, statLearningDays 
} from './dom.js';

export async function openProfileModal() {
    profileModal.classList.add('active');
    await loadUserProfile();
    await loadStatistics();
}

async function loadUserProfile() {
    const userSetting = await db.get('user_settings', 'username');
    if (userSetting && userSetting.value) {
        profileNameInput.value = userSetting.value;
    }
}

export async function saveUsername(newName) {
    await db.put('user_settings', { key: 'username', value: newName.trim() || 'ゲスト' });
}

async function loadStatistics() {
    // 履歴データを全件取得
    const sessions = await db.getAll('test_sessions');
    
    let totalQuestions = 0;
    let totalCorrect = 0;
    const uniqueDays = new Set();
    
    sessions.forEach(session => {
        totalQuestions += session.totalQuestions || 0;
        totalCorrect += session.correctCount || 0;
        
        // 開始日時から「YYYY-MM-DD」の文字列を作り、Setに入れることで日数をカウント
        if (session.startedAt) {
            const date = new Date(session.startedAt);
            const dateString = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
            uniqueDays.add(dateString);
        }
    });
    
    // 全体正答率の計算
    const correctRate = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
    
    // UIへの反映
    statTotalQuestions.textContent = totalQuestions;
    statCorrectRate.textContent = `${correctRate}%`;
    statLearningDays.textContent = uniqueDays.size;
}