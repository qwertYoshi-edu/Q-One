import { state } from './state.js';
import {
    screens, mainScreen, feedbackContainer, feedbackText, actionBtn, checkButtonContainer,
    progressBar, progressTextEl, importanceDisplay, mistakeCounter, addToReviewBtn,
    modeIndicator, selfGradingContainer, postAnswerButtons, incorrectListMain,
    interimReviewPanelBtn, interimReviewBtn, fsrsRatingContainer
} from './dom.js';
import { escapeHtml } from './utils.js';
import { triggerMeterAnimation, triggerPerfectAnimation } from './animations.js';

export function setupModal(modal) {
    if (!modal) return;
    const overlay = modal.querySelector('.modal-overlay');
    const closeBtn = modal.querySelector('.modal-close-btn');
    overlay?.addEventListener('click', () => modal.classList.remove('active'));
    closeBtn?.addEventListener('click', () => modal.classList.remove('active'));
}

export function switchScreen(screenName, showIntermediateResultsFn) {
    const current = screens[state.currentScreen];
    const target = screens[screenName];
    if (!target) {
        console.error(`[Q-One:DOM] 画面 '${screenName}' が見つかりません。`);
        alert(`画面 '${screenName}' を表示できません。HTML構造を確認してください。`);
        return;
    }
    if (!current) {
        console.error(`[Q-One:DOM] 現在の画面 '${state.currentScreen}' が見つかりません。`);
        state.currentScreen = screenName;
        target.classList.add('active', 'visible');
        return;
    }
    current.classList.remove('visible');
    setTimeout(() => {
        current.classList.remove('active');
        state.currentScreen = screenName;
        target.classList.add('active');
        if (screenName === 'intermediate' && typeof showIntermediateResultsFn === 'function') showIntermediateResultsFn();
        else if (screenName === 'end') triggerPerfectAnimation();
        setTimeout(() => target.classList.add('visible'), 50);
    }, 300);
}

export function updateProgress() {
    const total = state.wordList.length;
    const percentage = total > 0 ? (state.currentIndex / total) * 100 : 0;
    if (progressBar) progressBar.style.width = `${percentage}%`;
    if (progressTextEl) progressTextEl.textContent = `問題 ${Math.min(state.currentIndex + 1, total)} / ${total}`;
    if (state.mistakeCount > 0) {
        if (mistakeCounter) {
            mistakeCounter.textContent = `✗ ${state.mistakeCount}`;
            mistakeCounter.classList.add('visible');
        }
    } else {
        mistakeCounter?.classList.remove('visible');
    }
    if (state.currentIndex < total) {
        const problem = state.wordList[state.currentIndex];
        if (importanceDisplay) importanceDisplay.textContent = '★'.repeat(problem.importance) + '☆'.repeat(3 - problem.importance);
    }
}

export function updateIncorrectListPanel() {
    if (!incorrectListMain) return;
    incorrectListMain.innerHTML = '';
    state.reviewList.sort((a, b) => b.importance - a.importance).forEach(problem => {
        const li = document.createElement('li');
        let correctAnswerText = '';
        switch (problem.type) {
            case 'check': correctAnswerText = problem.smallText; break;
            case 'enter':
            case 'select': correctAnswerText = problem.correctAnswer; break;
            case 'fill': correctAnswerText = problem.answers.join(', '); break;
        }
        const importanceStars = '★'.repeat(problem.importance) + '☆'.repeat(3 - problem.importance);
        li.innerHTML = `<div class="incorrect-item-content"><span class="incorrect-item-importance">${importanceStars}</span><span class="incorrect-item-text">${escapeHtml(problem.largeText)}</span></div><span class="incorrect-item-answer">${escapeHtml(correctAnswerText)}</span>`;
        incorrectListMain.appendChild(li);
    });
    const hasIncorrect = state.reviewList.length > 0;
    if (interimReviewPanelBtn) interimReviewPanelBtn.disabled = !hasIncorrect;
    if (interimReviewBtn) interimReviewBtn.disabled = !hasIncorrect;
}

export function showIntermediateResults() {
    let percentage, detailsText;
    if (state.isCheckOnlyMode) {
        const total = state.checkOKCount + state.checkReviewCount;
        percentage = total > 0 ? (state.checkOKCount / total * 100) : 100;
        detailsText = '理解度';
    } else {
        percentage = state.currentPassTotalForRate > 0 ? (state.correctCount / state.currentPassTotalForRate * 100) : 100;
        detailsText = `${state.correctCount} / ${state.currentPassTotalForRate} 問 正解`;
        const checkTotal = state.checkOKCount + state.checkReviewCount;
        if (checkTotal > 0) detailsText += ` ／ 確認型理解度 ${state.checkOKCount} / ${checkTotal}`;
    }

    const visualEl = screens.intermediate?.querySelector('.results-visual');
    const percentageEl = document.getElementById('results-percentage');
    const detailsEl = document.getElementById('results-details');
    if (detailsEl) detailsEl.textContent = detailsText;

    const rootStyles = getComputedStyle(document.documentElement);
    const startColorHex = rootStyles.getPropertyValue('--danger-color').trim();
    let endColorHex;
    if (percentage >= 80) endColorHex = rootStyles.getPropertyValue('--success-color').trim();
    else if (percentage >= 50) endColorHex = rootStyles.getPropertyValue('--warning-color').trim();
    else endColorHex = startColorHex;
    if (visualEl && percentageEl) triggerMeterAnimation(percentage, visualEl, percentageEl, startColorHex, endColorHex);

    const hasIncorrect = state.reviewList.length > 0;
    const retryButton = document.getElementById('retry-incorrect-btn');
    const copyButton = document.getElementById('copy-incorrect-btn');
    if (retryButton) retryButton.disabled = !hasIncorrect;
    if (copyButton) copyButton.disabled = !hasIncorrect;

    const listEl = document.getElementById('incorrect-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    state.reviewList.sort((a, b) => b.importance - a.importance).forEach(problem => {
        const li = document.createElement('li');
        let correctAnswerText = '';
        switch (problem.type) {
            case 'check': correctAnswerText = problem.smallText; break;
            case 'enter':
            case 'select': correctAnswerText = problem.correctAnswer; break;
            case 'fill': correctAnswerText = problem.answers.join(', '); break;
        }
        const importanceStars = '★'.repeat(problem.importance) + '☆'.repeat(3 - problem.importance);
        li.innerHTML = `<div class="incorrect-item-content"><span class="incorrect-item-importance">${importanceStars}</span><span class="incorrect-item-text">${escapeHtml(problem.largeText)}</span></div><span class="incorrect-item-answer">${escapeHtml(correctAnswerText)}</span>`;
        listEl.appendChild(li);
    });
}

export function resetQuestionUI(views) {
    feedbackContainer?.classList.remove('visible', 'correct', 'incorrect', 'neutral');
    actionBtn?.classList.remove('visible');
    checkButtonContainer?.classList.remove('active');
    selfGradingContainer?.classList.remove('active');
    postAnswerButtons?.classList.remove('active');
    if (fsrsRatingContainer) fsrsRatingContainer.classList.remove('active');
    if (addToReviewBtn) addToReviewBtn.style.display = 'none';
    Object.values(views || {}).forEach(v => { if (v) v.style.display = 'none'; });
}
