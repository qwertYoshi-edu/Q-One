import { state } from './state.js';
import {
    screens, mainScreen, feedbackContainer, feedbackText, actionBtn, checkButtonContainer,
    progressBar, progressTextEl, importanceDisplay, mistakeCounter, addToReviewBtn,
    modeIndicator, selfGradingContainer, postAnswerButtons, incorrectListMain,
    interimReviewPanelBtn, interimReviewBtn
} from './dom.js';
import { escapeHtml } from './utils.js';
import { triggerMeterAnimation, triggerPerfectAnimation } from './animations.js';

export function setupModal(modal) {
    const overlay = modal.querySelector('.modal-overlay');
    const closeBtn = modal.querySelector('.modal-close-btn');
    overlay.addEventListener('click', () => modal.classList.remove('active'));
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
}

export function switchScreen(screenName, showIntermediateResultsFn) {
    screens[state.currentScreen].classList.remove('visible');
    setTimeout(() => {
        screens[state.currentScreen].classList.remove('active');
        state.currentScreen = screenName;
        screens[state.currentScreen].classList.add('active');
        if (screenName === 'intermediate') showIntermediateResultsFn();
        else if (screenName === 'end') triggerPerfectAnimation();
        setTimeout(() => screens[state.currentScreen].classList.add('visible'), 50);
    }, 300);
}

export function updateProgress() {
    const total = state.wordList.length;
    const percentage = total > 0 ? (state.currentIndex / total) * 100 : 0;
    progressBar.style.width = `${percentage}%`;
    progressTextEl.textContent = `問題 ${state.currentIndex + 1} / ${total}`;
    if (state.mistakeCount > 0) {
        mistakeCounter.textContent = `✗ ${state.mistakeCount}`;
        mistakeCounter.classList.add('visible');
    } else {
        mistakeCounter.classList.remove('visible');
    }
    if (state.currentIndex < total) {
        const problem = state.wordList[state.currentIndex];
        importanceDisplay.textContent = '★'.repeat(problem.importance) + '☆'.repeat(3 - problem.importance);
    }
}

export function updateIncorrectListPanel() {
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
    interimReviewPanelBtn.disabled = !hasIncorrect;
    interimReviewBtn.disabled = !hasIncorrect;
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
    }

    const visualEl = screens.intermediate.querySelector('.results-visual');
    const percentageEl = document.getElementById('results-percentage');
    document.getElementById('results-details').textContent = detailsText;

    const rootStyles = getComputedStyle(document.documentElement);
    const startColorHex = rootStyles.getPropertyValue('--danger-color').trim();
    let endColorHex;
    if (percentage >= 80) endColorHex = rootStyles.getPropertyValue('--success-color').trim();
    else if (percentage >= 50) endColorHex = rootStyles.getPropertyValue('--warning-color').trim();
    else endColorHex = startColorHex;
    triggerMeterAnimation(percentage, visualEl, percentageEl, startColorHex, endColorHex);

    const hasIncorrect = state.reviewList.length > 0;
    document.getElementById('retry-incorrect-btn').disabled = !hasIncorrect;
    document.getElementById('copy-incorrect-btn').disabled = !hasIncorrect;

    const listEl = document.getElementById('incorrect-list');
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
    feedbackContainer.classList.remove('visible', 'correct', 'incorrect', 'neutral');
    actionBtn.classList.remove('visible');
    checkButtonContainer.classList.remove('active');
    selfGradingContainer.classList.remove('active');
    postAnswerButtons.classList.remove('active');
    addToReviewBtn.style.display = 'none';
    Object.values(views).forEach(v => v.style.display = 'none');
}
