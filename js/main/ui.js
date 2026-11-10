import { state } from './state.js';
import {
    screens, mainScreen, feedbackContainer, feedbackText, actionBtn, checkButtonContainer,
    progressBar, progressTextEl, importanceDisplay, mistakeCounter, addToReviewBtn,
    modeIndicator, selfGradingContainer, postAnswerButtons, incorrectListMain,
    interimReviewPanelBtn, interimReviewBtn, reviewRatingContainer
} from './dom.js';
import { escapeHtml } from './utils.js';
import { triggerMeterAnimation, triggerPerfectAnimation } from './animations.js';

let screenTransitionSequence = 0;

const modalFocusState = new WeakMap();
let modalKeyboardHandlerInstalled = false;

function getModalFocusableElements(modal) {
    return [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
}

function focusModal(modal) {
    const focusables = getModalFocusableElements(modal);
    (focusables[0] || modal.querySelector('.modal-content') || modal).focus({ preventScroll: true });
}

function installModalKeyboardHandling() {
    if (modalKeyboardHandlerInstalled) return;
    modalKeyboardHandlerInstalled = true;
    document.addEventListener('keydown', event => {
        const activeModal = [...document.querySelectorAll('.modal.active')].at(-1);
        if (!activeModal) return;
        if (event.key === 'Escape' && !activeModal.dataset.preventEscape) {
            event.preventDefault();
            activeModal.classList.remove('active');
            return;
        }
        if (event.key !== 'Tab') return;
        const focusables = getModalFocusableElements(activeModal);
        if (!focusables.length) {
            event.preventDefault();
            (activeModal.querySelector('.modal-content') || activeModal).focus();
            return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && (document.activeElement === first || !activeModal.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !activeModal.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    });
}

export function setupModal(modal) {
    if (!modal || modal.dataset.qoneModalReady === 'true') return false;
    modal.dataset.qoneModalReady = 'true';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'true');
    if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
    const content = modal.querySelector('.modal-content');
    if (content && !content.hasAttribute('tabindex')) content.tabIndex = -1;
    const title = modal.querySelector('h1, h2, h3');
    if (title) {
        if (!title.id) title.id = `qone-modal-title-${Math.random().toString(36).slice(2, 9)}`;
        modal.setAttribute('aria-labelledby', title.id);
    }
    const close = () => modal.classList.remove('active');
    modal.querySelector('.modal-overlay')?.addEventListener('click', close);
    modal.querySelector('.modal-close-btn')?.addEventListener('click', close);

    const observer = new MutationObserver(() => {
        const isOpen = modal.classList.contains('active');
        if (isOpen) {
            if (!modalFocusState.get(modal)?.open) {
                modalFocusState.set(modal, { open: true, returnFocus: document.activeElement });
                modal.setAttribute('aria-hidden', 'false');
                document.body.classList.add('modal-open');
                requestAnimationFrame(() => focusModal(modal));
            }
        } else {
            const previous = modalFocusState.get(modal);
            if (previous?.open) {
                modal.setAttribute('aria-hidden', 'true');
                modalFocusState.set(modal, { open: false, returnFocus: previous.returnFocus });
                if (!document.querySelector('.modal.active')) document.body.classList.remove('modal-open');
                if (previous.returnFocus instanceof HTMLElement && previous.returnFocus.isConnected) {
                    requestAnimationFrame(() => previous.returnFocus.focus({ preventScroll: true }));
                }
            }
        }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    installModalKeyboardHandling();
    return true;
}

export function switchScreen(screenName, showIntermediateResultsFn) {
    const target = screens[screenName];
    if (!target) {
        const error = new Error(`画面 #${screenName}-screen が見つかりません。`);
        console.error('[Q-One:UI] 画面遷移を中止しました:', error);
        const main = document.getElementById('main-screen');
        if (main) {
            let notice = main.querySelector('[data-qone-screen-error]');
            if (!notice) {
                notice = document.createElement('p');
                notice.dataset.qoneScreenError = 'true';
                notice.setAttribute('role', 'alert');
                main.prepend(notice);
            }
            notice.textContent = error.message;
        }
        return false;
    }

    const sequence = ++screenTransitionSequence;
    const previous = screens[state.currentScreen];
    previous?.classList.remove('visible');
    window.setTimeout(() => {
        if (sequence !== screenTransitionSequence) return;
        previous?.classList.remove('active');
        state.currentScreen = screenName;
        target.classList.add('active');
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        if (screenName === 'intermediate') {
            try { showIntermediateResultsFn?.(); }
            catch (error) { console.error('[Q-One:UI] 中間結果の描画に失敗:', error); }
        } else if (screenName === 'end') {
            triggerPerfectAnimation();
        }
        window.setTimeout(() => {
            if (sequence === screenTransitionSequence) target.classList.add('visible');
        }, 50);
    }, previous ? 300 : 0);
    return true;
}

export function updateProgress() {
    const total = state.wordList?.length || 0;
    const current = Math.min(state.currentIndex || 0, total);
    const percentage = total > 0 ? (current / total) * 100 : 0;
    if (progressBar) progressBar.style.width = `${percentage}%`;
    const progressContainer = document.getElementById('progress-bar-container');
    if (progressContainer) {
        progressContainer.setAttribute('role', 'progressbar');
        progressContainer.setAttribute('aria-label', '学習の進捗');
        progressContainer.setAttribute('aria-valuemin', '0');
        progressContainer.setAttribute('aria-valuemax', '100');
        progressContainer.setAttribute('aria-valuenow', String(Math.round(percentage)));
    }
    if (progressTextEl) progressTextEl.textContent = `問題 ${Math.min(current + 1, total)} / ${total}`;
    if (mistakeCounter) {
        if (state.mistakeCount > 0) {
            mistakeCounter.textContent = `✗ ${state.mistakeCount}`;
            mistakeCounter.classList.add('visible');
        } else {
            mistakeCounter.classList.remove('visible');
        }
    }
    if (importanceDisplay && current < total) {
        const importance = Math.min(3, Math.max(0, Number(state.wordList[current]?.importance) || 0));
        importanceDisplay.textContent = '★'.repeat(importance) + '☆'.repeat(3 - importance);
    }
}

function getCorrectAnswerText(problem) {
    switch (problem?.type) {
        case 'check': return problem.smallText || '';
        case 'enter':
        case 'select': return problem.correctAnswer || '';
        case 'fill': return Array.isArray(problem.answers) ? problem.answers.join(', ') : '';
        default: return '';
    }
}

function renderIncorrectList(container) {
    if (!container) return;
    container.replaceChildren();
    const items = [...(state.reviewList || [])].sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    items.forEach(problem => {
        const li = document.createElement('li');
        const importance = Math.min(3, Math.max(0, Number(problem.importance) || 0));
        const importanceStars = '★'.repeat(importance) + '☆'.repeat(3 - importance);
        const content = document.createElement('div');
        content.className = 'incorrect-item-content';
        const stars = document.createElement('span');
        stars.className = 'incorrect-item-importance';
        stars.textContent = importanceStars;
        const question = document.createElement('span');
        question.className = 'incorrect-item-text';
        question.textContent = problem.largeText || '';
        content.append(stars, question);
        const answer = document.createElement('span');
        answer.className = 'incorrect-item-answer';
        answer.textContent = getCorrectAnswerText(problem);
        li.append(content, answer);
        container.appendChild(li);
    });
}

export function updateIncorrectListPanel() {
    renderIncorrectList(incorrectListMain);
    const hasIncorrect = (state.reviewList || []).length > 0;
    if (interimReviewPanelBtn) interimReviewPanelBtn.disabled = !hasIncorrect;
    if (interimReviewBtn) interimReviewBtn.disabled = !hasIncorrect;
}

export function showIntermediateResults() {
    const intermediate = screens.intermediate;
    if (!intermediate) {
        console.error('[Q-One:UI] 中間結果画面が存在しません。');
        return;
    }

    let percentage;
    let detailsText;
    if (state.isCheckOnlyMode) {
        const total = (state.checkOKCount || 0) + (state.checkReviewCount || 0);
        percentage = total > 0 ? (state.checkOKCount / total * 100) : 100;
        detailsText = `理解度 ${state.checkOKCount || 0} / ${total} 問`;
    } else {
        const total = Number(state.currentPassTotalForRate) || 0;
        percentage = total > 0 ? ((Number(state.correctCount) || 0) / total * 100) : 100;
        detailsText = `${Number(state.correctCount) || 0} / ${total} 問 正解`;
    }

    const visualEl = intermediate.querySelector('.results-visual');
    const percentageEl = document.getElementById('results-percentage');
    const detailsEl = document.getElementById('results-details');
    if (detailsEl) detailsEl.textContent = detailsText;

    const rootStyles = getComputedStyle(document.documentElement);
    const startColorHex = rootStyles.getPropertyValue('--danger-color').trim();
    let endColorHex;
    if (percentage >= 80) endColorHex = rootStyles.getPropertyValue('--success-color').trim();
    else if (percentage >= 50) endColorHex = rootStyles.getPropertyValue('--warning-color').trim();
    else endColorHex = startColorHex;
    if (visualEl && percentageEl) {
        triggerMeterAnimation(percentage, visualEl, percentageEl, startColorHex, endColorHex);
    } else if (percentageEl) {
        percentageEl.textContent = `${Math.round(percentage)}%`;
    }

    const hasIncorrect = (state.reviewList || []).length > 0;
    const retryBtn = document.getElementById('retry-incorrect-btn');
    const copyBtn = document.getElementById('copy-incorrect-btn');
    if (retryBtn) retryBtn.disabled = !hasIncorrect;
    if (copyBtn) copyBtn.disabled = !hasIncorrect;
    renderIncorrectList(document.getElementById('incorrect-list'));
}

export function resetQuestionUI(views = {}) {
    feedbackContainer?.classList.remove('visible', 'correct', 'incorrect', 'neutral');
    const answerSaveStatus = document.getElementById('answer-save-status');
    if (answerSaveStatus) answerSaveStatus.textContent = '';
    actionBtn?.classList.remove('visible');
    checkButtonContainer?.classList.remove('active');
    selfGradingContainer?.classList.remove('active');
    postAnswerButtons?.classList.remove('active');
    reviewRatingContainer?.classList.remove('active');
    if (addToReviewBtn) addToReviewBtn.style.display = 'none';
    Object.values(views || {}).forEach(view => {
        if (view) view.style.display = 'none';
    });
}
