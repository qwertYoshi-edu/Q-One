import { state } from './state.js';
import {
    screens, mainScreen, views, feedbackContainer, feedbackText, actionBtn, checkButtonContainer,
    addToReviewBtn, modeIndicator, postAnswerButtons, nextProblemBtn, retryCurrentProblemBtn,
    selfGradingContainer, selfGradingInfo, selfGradeCorrectBtn, selfGradeIncorrectBtn,
    fillRateSlider, selfGradeCheckbox, modeTextRadio, rangeStartInput, rangeEndInput, reviewRatingContainer, reviewRatingBtns
} from './dom.js';

// 名前衝突を防ぐため「DB」という大文字の変数名でインポート
import * as DB from './db.js';

import { parseText } from './parser.js';
import { getCheckpointSetting, clearScheduledReviewCheckpoint } from './review.js';
import { escapeHtml, normalizeAnswer, REVIEW_RATINGS, calculateNextReviewState, createInitialReviewState, resolveReviewStateForRevision } from './utils.js';
import { resetQuestionUI, switchScreen, updateProgress, updateIncorrectListPanel, showIntermediateResults } from './ui.js';

function screenSwitcher(screenName) {
    return switchScreen(screenName, showIntermediateResults);
}

function createId(prefix = 'qone') {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `${prefix}_${uuid || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

function getProblemIdentity(problem) {
    const packId = problem.packId || state.currentPackId || 'manual_input';
    const questionId = problem.questionId || problem.problemId || 'unknown';
    return { packId, questionId, problemKey: `${packId}:${questionId}` };
}

function sameProblem(a, b) {
    return getProblemIdentity(a).problemKey === getProblemIdentity(b).problemKey;
}

function validateProblemShape(problem) {
    if (!problem || typeof problem !== 'object' || Array.isArray(problem) || typeof problem.largeText !== 'string') return false;
    switch (problem.type) {
        case 'check':
            return typeof problem.smallText === 'string';
        case 'enter':
            return typeof problem.correctAnswer === 'string' && problem.correctAnswer.length > 0;
        case 'select':
            return Array.isArray(problem.options) && problem.options.length >= 2 &&
                problem.options.every(option => typeof option === 'string' && option.length > 0) &&
                typeof problem.correctAnswer === 'string' && problem.correctAnswer.length > 0 && problem.options.includes(problem.correctAnswer);
        case 'fill':
            return Array.isArray(problem.answers) && problem.answers.length > 0 &&
                Array.isArray(problem.questionParts) && problem.questionParts.length === problem.answers.length + 1 &&
                problem.answers.every(answer => typeof answer === 'string' && answer.length > 0) &&
                problem.questionParts.every(part => typeof part === 'string');
        default:
            return false;
    }
}

export function startGame(isCheckMode = false) {
    state.isFinalCheckMode = isCheckMode;
    state.isInterimReview = false;
    state.savedState = null;
    state.isSelfGradingMode = Boolean(selfGradeCheckbox?.checked) && !state.isFinalCheckMode;

    const modePackRadio = document.getElementById('mode-pack');
    let allProblems = [];

    // パックタブ選択時：DBのパック問題から出題、テキストタブ時：テキストエリアから出題
    if (modePackRadio && modePackRadio.checked) {
        if (!state.selectedPackData || !Array.isArray(state.selectedPackData.problems) || state.selectedPackData.problems.length === 0) {
            alert('出題する問題パックを一覧から選択してください。');
            return;
        }
        state.currentPackId = state.selectedPackData.id;
        if (state.selectedPackData.problems.some(problem => !problem || typeof problem !== 'object' || Array.isArray(problem))) {
            alert('選択した問題パックに不正な問題データが含まれています。');
            return;
        }
        allProblems = state.selectedPackData.problems.map((p, idx) => ({
            ...p,
            packId: state.selectedPackData.id,
            questionId: p.questionId || p.problemId || `q_${idx + 1}`,
            importance: Number.isFinite(Number(p.importance)) ? Number(p.importance) : 1
        }));
    } else {
        state.currentPackId = 'manual_input';
        state.selectedPackData = null;
        const textInput = document.getElementById('input-text');
        if (!textInput) {
            alert('問題入力欄が見つかりません。ページを再読み込みしてください。');
            return;
        }
        allProblems = parseText(textInput.value, 'manual_input');
    }
    
    const invalidProblemIndex = allProblems.findIndex(problem => !validateProblemShape(problem));
    if (invalidProblemIndex >= 0) {
        alert(`問題 ${invalidProblemIndex + 1} の形式が正しくありません。問題パックまたは入力テキストを確認してください。`);
        return;
    }

    // --- 範囲指定ロジック ---
    const startVal = rangeStartInput ? rangeStartInput.value : '';
    const endVal = rangeEndInput ? rangeEndInput.value : '';
    const startIdx = parseInt(startVal, 10);
    const endIdx = parseInt(endVal, 10);
    
    let slicedProblems = allProblems;
    if (!isNaN(startIdx) || !isNaN(endIdx)) {
        const s = isNaN(startIdx) ? 0 : Math.max(0, startIdx - 1);
        const e = isNaN(endIdx) ? allProblems.length : Math.min(allProblems.length, endIdx);
        if (s < e) {
            slicedProblems = allProblems.slice(s, e);
        } else {
            alert('出題範囲の指定が不正です。'); return;
        }
    }

    const importanceRadio = document.querySelector('input[name="importance"]:checked');
    if (!importanceRadio) {
        alert('重要度の選択肢が見つかりません。ページを再読み込みしてください。');
        return;
    }
    const selectedImportance = importanceRadio.value;
    const [minImp, maxImp] = selectedImportance.split('-').map(Number);
    let filteredProblems = slicedProblems.filter(p => p.importance >= minImp && p.importance <= maxImp);
    
    if (document.getElementById('shuffle-checkbox')?.checked) filteredProblems.sort(() => Math.random() - 0.5);
    
    if (filteredProblems.length === 0) {
        alert('選択した範囲・重要度の問題が存在しないか、形式に誤りがあります。');
        return;
    }
    
    state.originalWordList = JSON.parse(JSON.stringify(filteredProblems));
    state.fillBlankRate = Number.parseInt(fillRateSlider?.value || '100', 10) || 100;
    
    state.currentSessionMode = isCheckMode ? 'final_check' : 'normal';
    startNewPass(filteredProblems, false, { mode: state.currentSessionMode });
}

export function startNewPass(problems, isReview = false, options = {}) {
    if (!Array.isArray(problems) || problems.some(problem => !problem || typeof problem !== 'object' || Array.isArray(problem))) {
        alert('出題データが配列ではないか、不正な要素が含まれています。問題パック・履歴データを確認してください。');
        return;
    }
    const normalizedProblems = problems.map((problem, index) => ({
        ...problem,
        packId: problem.packId || state.currentPackId || 'manual_input',
        questionId: problem.questionId || problem.problemId || `q_${index + 1}`,
        revision: Number.isInteger(problem.revision) && problem.revision > 0 ? problem.revision : 1,
        importance: Number.isFinite(Number(problem.importance)) ? Math.min(3, Math.max(1, Number(problem.importance))) : 1
    }));
    if (normalizedProblems.length === 0 || normalizedProblems.some(problem => !validateProblemShape(problem))) {
        alert('出題データが空、または問題形式が不正です。問題パック・履歴データを確認してください。');
        return;
    }
    const identityKeys = normalizedProblems.map(problem => getProblemIdentity(problem).problemKey);
    if (new Set(identityKeys).size !== identityKeys.length) {
        alert('同じ問題識別子が重複しています。問題パックの questionId を一意にしてから再度お試しください。');
        console.error('[Q-One:DataIntegrity] 同一セッション内に重複する問題識別子があります。', identityKeys);
        return;
    }

    state.isInterimReview = false;
    state.savedState = null;
    state.isRetryingCurrent = false;
    state.wordList = normalizedProblems;
    state.reviewList = [];
    state.currentIndex = Number.isInteger(options.resumeIndex)
        ? Math.max(0, Math.min(normalizedProblems.length - 1, options.resumeIndex))
        : 0;
    state.correctCount = 0;
    state.checkOKCount = 0;
    state.checkReviewCount = 0;
    state.mistakeCount = 0;
    state.answerLocked = false;
    state.pendingAnswer = null;
    state.isReviewPhase = Boolean(isReview);
    state.currentSessionMode = options.mode || (state.isFinalCheckMode ? 'final_check' : (isReview ? 'review' : 'normal'));
    state.isFinalCheckMode = state.currentSessionMode === 'final_check';
    state.currentPassTotalForRate = state.isFinalCheckMode
        ? state.wordList.length
        : state.wordList.filter(problem => problem.type !== 'check').length;
    state.isCheckOnlyMode = state.wordList.length > 0 && state.wordList.every(problem => problem.type === 'check');

    if (!options.reuseSession || !state.currentSessionId) {
        state.currentSessionId = createId('session');
        state.currentSessionStartedAt = Date.now();
        state.sessionAnswerResults = new Map();
        state.sessionAnswerCount = 0;
    }

    const sessionPackIds = [...new Set(state.wordList.map(problem => problem.packId || 'manual_input'))];
    const session = {
        id: state.currentSessionId,
        packId: sessionPackIds.length === 1 ? sessionPackIds[0] : 'multiple',
        packIds: sessionPackIds,
        packTitle: options.packTitle || state.selectedPackData?.title || (sessionPackIds[0] === 'manual_input' ? 'テキスト入力' : ''),
        mode: state.currentSessionMode,
        range: options.range || `${rangeStartInput ? rangeStartInput.value || '1' : '1'} ~ ${rangeEndInput ? rangeEndInput.value || '最後' : '最後'}`,
        totalQuestions: state.wordList.length,
        answeredCount: 0,
        answerCount: 0,
        correctCount: 0,
        accuracy: null,
        learningAnsweredCount: 0,
        learningCorrectCount: 0,
        learningAccuracy: null,
        checkAnsweredCount: 0,
        checkCorrectCount: 0,
        checkAccuracy: null,
        totalTimeMs: 0,
        startedAt: state.currentSessionStartedAt || Date.now(),
        completedAt: null,
        problemSnapshot: JSON.parse(JSON.stringify(state.wordList)),
        snapshotVersion: 1,
        isSelfGradingMode: Boolean(state.isSelfGradingMode)
    };

    let modeTitle = state.isFinalCheckMode ? '直前チェック' : (state.isReviewPhase ? '復習モード' : '通常モード');
    if (state.currentSessionMode === 'scheduled_review') modeTitle = '今日の復習';
    else if (state.currentSessionMode === 'weakness_training') modeTitle = '苦手克服特訓';
    else if (state.currentSessionMode === 'retry_all' || state.currentSessionMode === 'history_retry') modeTitle = '再挑戦';
    if (state.isSelfGradingMode && !state.isFinalCheckMode) modeTitle += ' (自己採点)';
    if (modeIndicator) modeIndicator.textContent = modeTitle;

    updateIncorrectListPanel();
    screenSwitcher('main');
    state.sessionReady = DB.put('test_sessions', session).catch(error => {
        console.error('[Q-One:Error] セッション保存エラー:', error);
        alert(`学習セッションを保存できませんでした: ${error.message || error}`);
        throw error;
    });
    // まだ回答がないまま画面遷移しても未処理拒否にしない。保存処理側では同じPromiseをawaitする。
    state.sessionReady.catch(() => {});

    showNextProblem();
}

export function retryIncorrect() {
    state.isFinalCheckMode = false;
    if (state.reviewList.length > 0) startNewPass(state.reviewList, true, { mode: 'review' });
}

export function retryAll() {
    state.isFinalCheckMode = false;
    startNewPass(state.originalWordList, false, { mode: 'retry_all' });
}

export function restartGame() {
    state.isInterimReview = false;
    state.savedState = null;
    screenSwitcher('setup');
}

/** 現在の学習セッションを維持したまま、誤答だけを一時的に再出題する。 */
export function startInterimReview() {
    if (!state.reviewList?.length || state.isInterimReview) {
        if (!state.reviewList?.length) alert('復習する問題がありません。');
        return;
    }
    if (!confirm('間違えた問題を一旦復習しますか？')) return;

    mainScreen?.classList.remove('list-open');
    state.savedState = {
        wordList: [...state.wordList],
        currentIndex: state.currentIndex,
        reviewList: [...state.reviewList]
    };
    state.isInterimReview = true;
    state.wordList = [...state.reviewList].sort(() => Math.random() - 0.5);
    state.reviewList = [];
    state.currentIndex = 0;
    if (modeIndicator) modeIndicator.textContent = '一旦復習モード';
    updateIncorrectListPanel();
    showNextProblem();
}

/** 一時復習後に元の問題位置へ戻し、セッションIDと集計を継続する。 */
export function endInterimReview(resume = true) {
    if (!state.isInterimReview || !state.savedState) return;

    state.wordList = state.savedState.wordList;
    state.currentIndex = state.savedState.currentIndex;
    state.reviewList = state.savedState.reviewList;
    state.isInterimReview = false;
    state.savedState = null;

    let modeTitle = state.isFinalCheckMode ? '直前チェック' : (state.isReviewPhase ? '復習モード' : '通常モード');
    if (state.currentSessionMode === 'weakness_training') modeTitle = '苦手克服特訓';
    if (state.isSelfGradingMode && !state.isFinalCheckMode) modeTitle += ' (自己採点)';
    if (modeIndicator) modeIndicator.textContent = modeTitle;
    updateIncorrectListPanel();
    if (resume) showNextProblem();
}

function setAnswerActionsDisabled(disabled) {
    reviewRatingBtns.forEach(button => { button.disabled = Boolean(disabled); });
    if (nextProblemBtn) nextProblemBtn.disabled = Boolean(disabled);
    if (retryCurrentProblemBtn) retryCurrentProblemBtn.disabled = Boolean(disabled);
}

function lockPendingAction(pending) {
    if (!pending || pending.actionTaken) return false;
    pending.actionTaken = true;
    setAnswerActionsDisabled(true);
    return true;
}

function unlockPendingAction(pending) {
    if (state.pendingAnswer !== pending) return;
    pending.actionTaken = false;
    setAnswerActionsDisabled(false);
}

export function showNextProblem() {
    setAnswerActionsDisabled(false);
    state.isRetryingCurrent = false;
    state.answerLocked = false;
    state.pendingAnswer = null;
    if (state.currentIndex >= state.wordList.length) {
        if (state.currentSessionMode === 'scheduled_review') {
            clearScheduledReviewCheckpoint().catch(error => console.error('[Q-One:Review] 復習再開情報の消去に失敗:', error));
        }
        // 学習セッションを完了状態にする。最終回答の保存が終わってから反映する。
        if (!state.isInterimReview && state.currentSessionId) {
            finalizeCurrentSession().catch(error => console.error('[Q-One:Error] セッション完了処理エラー:', error));
        }

        if (state.isInterimReview) endInterimReview(true);
        else if (state.reviewList.length === 0) screenSwitcher('end');
        else screenSwitcher('intermediate');
        return;
    }

    updateProgress();
    resetQuestionUI(views);

    const problem = state.wordList[state.currentIndex];
    if (!validateProblemShape(problem)) {
        const error = new Error(`問題 ${state.currentIndex + 1} のデータ形式が不正です。`);
        console.error('[Q-One:Quiz] 出題データ検証失敗:', error, problem);
        alert(`${error.message} 学習を中断し、最初の画面に戻ります。`);
        screenSwitcher('setup');
        return;
    }
    let reviewMark = state.isReviewPhase ? '<span class="review-indicator">復習</span>' : '';
    if (state.isInterimReview) reviewMark = '<span class="review-indicator" style="background-color: var(--warning-color); color: white;">一旦復習</span>';
    const view = views[state.isFinalCheckMode ? 'check' : problem.type];
    const largeTextContent = view?.querySelector('.large-text');
    if (!view || !largeTextContent) {
        const error = new Error(`出題ビューまたは .large-text が見つかりません: ${state.isFinalCheckMode ? 'check' : problem.type}`);
        console.error('[Q-One:Quiz] 出題UI要素が不足しています:', error);
        alert('出題画面の構成が不完全です。ページを再読み込みしてください。');
        screenSwitcher('setup');
        return;
    }
    largeTextContent.replaceChildren();
    const textSpan = document.createElement('span');
    textSpan.textContent = problem.largeText;
    largeTextContent.appendChild(textSpan);
    if (reviewMark) largeTextContent.insertAdjacentHTML('beforeend', reviewMark);
    
    view.classList.add('is-entering');
    view.style.display = 'block';
    requestAnimationFrame(() => { view.classList.remove('is-entering'); });

    if (state.isFinalCheckMode) {
        let answerHtml = '';
        switch (problem.type) {
            case 'select': case 'enter': answerHtml = escapeHtml(problem.correctAnswer); break;
            case 'fill': answerHtml = problem.questionParts.map((part, index) => escapeHtml(part) + (index < problem.answers.length ? `<span class="final-check-answer">${escapeHtml(problem.answers[index])}</span>` : '')).join(''); break;
            default: answerHtml = escapeHtml(problem.smallText || '');
        }
        const smallTextContent = view.querySelector('.small-text');
        if (!smallTextContent) {
            console.error('[Q-One:Quiz] 直前チェック用の .small-text がありません。');
            alert('直前チェック画面の構成が不完全です。ページを再読み込みしてください。');
            screenSwitcher('setup');
            return;
        }
        smallTextContent.innerHTML = answerHtml;
        setupCheck();
    } else {
        if (view.querySelector('.small-text')) view.querySelector('.small-text').textContent = problem.smallText || '';
        if (problem.type === 'check') setupCheck();
        else if (problem.type === 'select') setupSelect(problem);
        else if (problem.type === 'enter') setupEnter(problem);
        else if (problem.type === 'fill') setupFill(problem);
    }
    
    // 時間計測開始とデバッグログ
    state.currentQuestionStartTime = Date.now();
    console.log(`[Q-One:Quiz] 出題開始: 問題ID [${problem.problemId || '未定義'}] / 計測スタート`);
}

function setupCheck() {
    checkButtonContainer.classList.add('active');
    document.getElementById('ok-btn').onclick = () => handleAnswerFeedback(true);
    document.getElementById('review-btn').onclick = () => handleAnswerFeedback(false);
}

function setupSelect(problem) {
    const container = document.getElementById('select-options-container');
    container.innerHTML = '';
    [...problem.options].sort(() => Math.random() - 0.5).forEach(optionText => {
        const btn = document.createElement('button');
        btn.textContent = optionText;
        btn.className = 'select-option-btn';
        btn.dataset.optionText = optionText;
        btn.setAttribute('aria-label', `${optionText}を選択`);
        btn.onclick = () => {
            if (state.answerLocked) return;
            const isCorrect = (optionText === problem.correctAnswer);
            container.querySelectorAll('button').forEach(candidate => {
                candidate.disabled = true;
                const isAnswer = candidate.dataset.optionText === problem.correctAnswer;
                const isChosen = candidate.dataset.optionText === optionText;
                if (isAnswer) candidate.classList.add('correct');
                if (isChosen && !isCorrect) candidate.classList.add('incorrect');
                const stateLabel = isAnswer ? '正解' : (isChosen ? '選択したが不正解' : '');
                candidate.setAttribute('aria-label', `${candidate.dataset.optionText}${stateLabel ? `、${stateLabel}` : ''}`);
            });
            handleAnswerFeedback(isCorrect, problem.correctAnswer);
        };
        container.appendChild(btn);
    });
}

function setupEnter(problem) {
    const input = document.getElementById('enter-input');
    input.value = '';
    input.disabled = false;
    input.setAttribute('aria-label', '解答を入力');

    const handleSubmit = () => {
        input.disabled = true;
        actionBtn.classList.remove('visible');
        const isCorrect = normalizeAnswer(input.value) === normalizeAnswer(problem.correctAnswer);

        if (state.isSelfGradingMode) {
            if (isCorrect) {
                handleAnswerFeedback(true, problem.correctAnswer);
            } else {
                startSelfGradingSingle(
                    `あなたの入力: 「${escapeHtml(input.value)}」<br>正解: 「${escapeHtml(problem.correctAnswer)}」`,
                    problem.correctAnswer
                );
            }
        } else {
            handleAnswerFeedback(isCorrect, problem.correctAnswer);
        }
    };

    actionBtn.textContent = '回答';
    actionBtn.onclick = handleSubmit;
    actionBtn.classList.add('visible');
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.isComposing) handleSubmit();
    };
    requestAnimationFrame(() => input.focus());
}

function setupFill(problem) {
    const contentDiv = document.getElementById('fill-content');
    contentDiv.innerHTML = '';
    const totalBlanks = problem.answers.length;
    const blanksToShow = Math.round(totalBlanks * (state.fillBlankRate / 100));
    const blankIndices = new Set([...Array(totalBlanks).keys()].sort(() => 0.5 - Math.random()).slice(0, blanksToShow));

    const updateInputWidth = (input) => {
        const len = input.value.length || 4;
        input.style.width = Math.max(70, (len + 3) * 16) + 'px';
    };

    problem.questionParts.forEach((part, index) => {
        contentDiv.appendChild(document.createTextNode(part));
        if (index < totalBlanks) {
            if (blankIndices.has(index)) {
                const input = document.createElement('input');
                input.className = 'fill-input';
                input.dataset.answerIndex = index;
                input.setAttribute('aria-label', `空欄 ${index + 1} の解答`);
                input.addEventListener('input', () => updateInputWidth(input));
                contentDiv.appendChild(input);
                updateInputWidth(input);
            } else {
                const prefilled = document.createElement('span');
                prefilled.className = 'fill-prefilled';
                prefilled.textContent = problem.answers[index];
                contentDiv.appendChild(prefilled);
            }
        }
    });

    const handleSubmit = () => {
        const inputs = [...contentDiv.querySelectorAll('.fill-input')];
        inputs.forEach(i => i.disabled = true);
        actionBtn.classList.remove('visible');

        if (state.isSelfGradingMode && inputs.length > 0) {
            const blanksData = inputs.map(input => {
                const answerIndex = parseInt(input.dataset.answerIndex, 10);
                const correctVal = problem.answers[answerIndex];
                const userVal = input.value;
                const isMatch = normalizeAnswer(userVal) === normalizeAnswer(correctVal);
                return { element: input, userValue: userVal, correctValue: correctVal, isMatch, answerIndex };
            });

            const allMatch = blanksData.every(b => b.isMatch);
            if (allMatch) {
                blanksData.forEach(b => b.element.classList.add('correct'));
                handleAnswerFeedback(true, problem.answers.join(', '));
            } else {
                startSelfGradingFill(problem, blanksData);
            }
        } else {
            let allCorrect = true;
            inputs.forEach(input => {
                const answerIndex = parseInt(input.dataset.answerIndex, 10);
                const isInputCorrect = normalizeAnswer(input.value) === normalizeAnswer(problem.answers[answerIndex]);
                input.classList.add(isInputCorrect ? 'correct' : 'incorrect');
                if (!isInputCorrect) allCorrect = false;
            });
            handleAnswerFeedback(allCorrect, problem.answers.join(', '));
        }
    };

    actionBtn.textContent = '回答';
    actionBtn.onclick = handleSubmit;
    actionBtn.classList.add('visible');
}

function startSelfGradingSingle(infoHtml, correctAnswerText) {
    feedbackContainer.classList.remove('visible');
    selfGradingInfo.innerHTML = infoHtml;
    selfGradingContainer.classList.add('active');
    selfGradeCorrectBtn.onclick = () => {
        selfGradingContainer.classList.remove('active');
        handleAnswerFeedback(true, correctAnswerText);
    };
    selfGradeIncorrectBtn.onclick = () => {
        selfGradingContainer.classList.remove('active');
        handleAnswerFeedback(false, correctAnswerText);
    };
}

function startSelfGradingFill(problem, blanksData) {
    feedbackContainer.classList.remove('visible');
    const results = [];
    blanksData.forEach((b, idx) => {
        if (b.isMatch) {
            b.element.classList.add('correct');
            results[idx] = true;
        }
    });

    state.selfGradingFillState = {
        currentIndex: 0,
        blanks: blanksData,
        results,
        problem
    };

    selfGradingContainer.classList.add('active');
    advanceFillGrading();
}

function advanceFillGrading() {
    const gradingState = state.selfGradingFillState;
    gradingState.blanks.forEach(b => b.element.classList.remove('grading-focus'));
    while (gradingState.currentIndex < gradingState.blanks.length && gradingState.results[gradingState.currentIndex] !== undefined) {
        gradingState.currentIndex++;
    }

    if (gradingState.currentIndex >= gradingState.blanks.length) {
        selfGradingContainer.classList.remove('active');
        const allCorrect = gradingState.results.every(r => r === true);
        handleAnswerFeedback(allCorrect, gradingState.problem.answers.join(', '));
        return;
    }

    const current = gradingState.blanks[gradingState.currentIndex];
    current.element.classList.add('grading-focus');
    current.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    selfGradingInfo.innerHTML = `空欄 ${current.answerIndex + 1} の採点<br>あなたの入力: 「${escapeHtml(current.userValue)}」<br>正解: 「${escapeHtml(current.correctValue)}」`;

    selfGradeCorrectBtn.onclick = () => {
        current.element.classList.add('correct');
        gradingState.results[gradingState.currentIndex] = true;
        gradingState.currentIndex++;
        advanceFillGrading();
    };

    selfGradeIncorrectBtn.onclick = () => {
        current.element.classList.add('incorrect');
        gradingState.results[gradingState.currentIndex] = false;
        gradingState.currentIndex++;
        advanceFillGrading();
    };
}

export function retryCurrentProblem() {
    setAnswerActionsDisabled(false);
    state.isRetryingCurrent = true;
    state.answerLocked = false;
    state.pendingAnswer = null;
    feedbackContainer.classList.remove('visible', 'correct', 'incorrect', 'neutral');
    postAnswerButtons.classList.remove('active');
    selfGradingContainer.classList.remove('active');
    addToReviewBtn.style.display = 'none';
    const problem = state.wordList[state.currentIndex];
    if (problem.type === 'select') setupSelect(problem);
    else if (problem.type === 'enter') setupEnter(problem);
    else if (problem.type === 'fill') setupFill(problem);
}

function handleAnswerFeedback(isCorrect, correctAnswerText) {
    if (state.answerLocked) return;
    state.answerLocked = true;

    const timeMs = Math.max(0, Date.now() - (state.currentQuestionStartTime || Date.now()));
    const problem = state.wordList[state.currentIndex];
    if (!problem) {
        state.answerLocked = false;
        console.error('[Q-One:Error] 回答対象の問題が見つかりません。', state.currentIndex);
        return;
    }

    console.log(`[Q-One:Quiz] 回答検知: 解答時間 [${timeMs}]ms / 正誤: [${isCorrect}]`);

    if (state.isRetryingCurrent) {
        // 再挑戦は別ログとして残しつつ、画面上の最新結果をセッション集計へ反映する。
        const previousResult = state.sessionAnswerResults?.get(getProblemIdentity(problem).problemKey);
        if (previousResult && previousResult.isCorrect !== Boolean(isCorrect)) {
            if (problem.type === 'check' && !state.isFinalCheckMode) {
                if (isCorrect) {
                    state.checkOKCount++;
                    state.checkReviewCount = Math.max(0, state.checkReviewCount - 1);
                } else {
                    state.checkReviewCount++;
                    state.checkOKCount = Math.max(0, state.checkOKCount - 1);
                }
            } else if (problem.type !== 'check' || state.isFinalCheckMode) {
                if (isCorrect) {
                    state.correctCount++;
                    state.mistakeCount = Math.max(0, state.mistakeCount - 1);
                    if (state.isInterimReview && state.savedState) {
                        state.savedState.reviewList = state.savedState.reviewList.filter(item => !sameProblem(item, problem));
                    } else {
                        state.reviewList = state.reviewList.filter(item => !sameProblem(item, problem));
                    }
                } else {
                    state.correctCount = Math.max(0, state.correctCount - 1);
                    state.mistakeCount++;
                    const targetList = state.isInterimReview && state.savedState
                        ? state.savedState.reviewList
                        : state.reviewList;
                    if (!targetList.some(item => sameProblem(item, problem))) targetList.push(problem);
                }
            }
            updateIncorrectListPanel();
        }
    } else {
        if (state.isInterimReview) {
            if (problem.type === 'check') {
                if (isCorrect) state.checkOKCount++;
                else state.checkReviewCount++;
            } else if (isCorrect) {
                state.correctCount++;
            }
            if (isCorrect) {
                state.mistakeCount = Math.max(0, state.mistakeCount - 1);
                state.savedState.reviewList = state.savedState.reviewList.filter(item => !sameProblem(item, problem));
            } else {
                if (!state.savedState.reviewList.some(item => sameProblem(item, problem))) {
                    state.savedState.reviewList.push(problem);
                }
            }
        } else {
            if (state.isFinalCheckMode) {
                if (isCorrect) state.checkOKCount++;
                else state.checkReviewCount++;
                if (isCorrect) state.correctCount++;
            } else if (problem.type === 'check') {
                if (isCorrect) state.checkOKCount++;
                else state.checkReviewCount++;
            } else if (isCorrect) {
                state.correctCount++;
            }

            if (!isCorrect) {
                if (!state.reviewList.some(item => sameProblem(item, problem))) state.reviewList.push(problem);
                if (problem.type !== 'check' && !state.isFinalCheckMode) state.mistakeCount++;
            }
            updateIncorrectListPanel();
        }
    }

    state.pendingAnswer = {
        problem,
        isCorrect: Boolean(isCorrect),
        correctAnswerText,
        timeMs,
        sessionId: state.currentSessionId,
        sessionMode: state.currentSessionMode,
        isFinalCheckMode: state.isFinalCheckMode,
        isInterimReview: state.isInterimReview,
        isRetryingCurrent: state.isRetryingCurrent,
        questionIndex: state.currentIndex,
        sessionQuestions: state.currentSessionMode === 'scheduled_review' ? JSON.parse(JSON.stringify(state.wordList)) : null,
        sessionReady: state.sessionReady,
        priorSessionResults: new Map(state.sessionAnswerResults || []),
        priorSessionAnswerCount: Number(state.sessionAnswerCount) || 0,
        recorded: false,
        promise: null,
        actionTaken: false
    };

    const requiresRating = isCorrect && problem.type !== 'check' && !state.isFinalCheckMode;
    if (problem.type !== 'check' && !state.isFinalCheckMode) {
        feedbackText.textContent = isCorrect ? '正解！' : `不正解　正しい解答: ${correctAnswerText}`;
        feedbackContainer.className = `visible ${isCorrect ? 'correct' : 'incorrect'}`;
        actionBtn.classList.remove('visible');

        if (requiresRating && reviewRatingContainer && reviewRatingBtns.length > 0) {
            postAnswerButtons.classList.remove('active');
            reviewRatingContainer.classList.add('active');
            reviewRatingBtns.forEach(btn => {
                btn.onclick = async () => {
                    const pending = state.pendingAnswer;
                    const rating = Number.parseInt(btn.dataset.rating, 10);
                    if (![1, 2, 3, 4].includes(rating) || !lockPendingAction(pending)) return;
                    reviewRatingContainer.classList.remove('active');
                    try {
                        await finalizePendingAnswer(rating);
                        if (state.pendingAnswer === pending) moveToNextProblem();
                    } catch (error) {
                        console.error('[Q-One:Error] 解答保存に失敗:', error);
                        unlockPendingAction(pending);
                        alert(`解答履歴を保存できませんでした。再度お試しください。\n${error.message || error}`);
                        reviewRatingContainer.classList.add('active');
                    }
                };
            });
        } else if (!isCorrect) {
            if (reviewRatingContainer) reviewRatingContainer.classList.remove('active');
            finalizePendingAnswer(REVIEW_RATINGS.AGAIN).catch(error => {
                console.error('[Q-One:Error] 解答保存に失敗:', error);
                feedbackText.textContent = `履歴保存エラー: ${error.message || error}`;
            });
            postAnswerButtons.classList.add('active');
            nextProblemBtn.onclick = async () => {
                const pending = state.pendingAnswer;
                if (!lockPendingAction(pending)) return;
                try {
                    await finalizePendingAnswer(REVIEW_RATINGS.AGAIN);
                    if (state.pendingAnswer === pending) moveToNextProblem();
                } catch (error) {
                    unlockPendingAction(pending);
                    console.error('[Q-One:Error] 次の問題へ進めません:', error);
                    alert(`履歴を保存できていないため、次の問題へ進めません。\n${error.message || error}`);
                }
            };
            retryCurrentProblemBtn.onclick = async () => {
                const pending = state.pendingAnswer;
                if (!lockPendingAction(pending)) return;
                try {
                    await finalizePendingAnswer(REVIEW_RATINGS.AGAIN);
                    if (state.pendingAnswer === pending) retryCurrentProblem();
                } catch (error) {
                    unlockPendingAction(pending);
                    console.error('[Q-One:Error] 問題の再挑戦を開始できません:', error);
                    alert(`履歴を保存できていないため、再挑戦できません。\n${error.message || error}`);
                }
            };
        } else if (requiresRating) {
            // 簡易間隔反復 UI が欠落している環境でも、正答を未記録のままにしない。
            finalizePendingAnswer(REVIEW_RATINGS.GOOD).then(moveToNextProblem).catch(error => {
                console.error('[Q-One:Error] 解答保存に失敗:', error);
                alert(`解答履歴を保存できませんでした: ${error.message || error}`);
            });
        } else if (!requiresRating) {
            finalizePendingAnswer(null).then(moveToNextProblem).catch(error => {
                console.error('[Q-One:Error] 解答保存に失敗:', error);
                alert(`解答履歴を保存できませんでした: ${error.message || error}`);
            });
        }
    } else {
        finalizePendingAnswer(null).then(moveToNextProblem).catch(error => {
            console.error('[Q-One:Error] 解答保存に失敗:', error);
            alert(`解答履歴を保存できませんでした: ${error.message || error}`);
        });
    }
    updateProgress();
}

function moveToNextProblem() {
    state.currentIndex++;
    showNextProblem();
}

async function finalizePendingAnswer(rating) {
    const pending = state.pendingAnswer;
    if (!pending) throw new Error('保存対象の回答がありません。');
    if (pending.recorded) return;
    if (pending.promise) return pending.promise;

    const saveStatus = document.getElementById('answer-save-status');
    if (saveStatus) saveStatus.textContent = '保存中…';
    const savePromise = persistAnswer(pending, rating);
    pending.promise = savePromise;
    try {
        await savePromise;
        pending.recorded = true;
        if (saveStatus) saveStatus.textContent = '保存済み';
    } catch (error) {
        if (saveStatus) saveStatus.textContent = '保存に失敗しました。再試行してください。';
        // 一時的なIndexedDBエラー後に再試行できるよう、失敗Promiseを保持しない。
        if (pending.promise === savePromise) pending.promise = null;
        throw error;
    }
}

function getAttemptType(pending) {
    if (pending.isRetryingCurrent) return 'retry_current';
    if (pending.sessionMode === 'scheduled_review') return 'scheduled_review';
    if (pending.isInterimReview) return 'interim_review';
    if (pending.isFinalCheckMode || pending.sessionMode === 'final_check') return 'final_check';
    if (pending.sessionMode === 'weakness_training') return 'weakness_training';
    if (pending.sessionMode === 'review') return 'review';
    if (pending.sessionMode === 'retry_all' || pending.sessionMode === 'history_retry') return 'retry';
    return 'initial';
}

function summarizeSessionResults(results, isFinalCheckMode) {
    const values = [...results.values()];
    const learning = isFinalCheckMode ? values : values.filter(result => result.problemType !== 'check');
    const checks = isFinalCheckMode ? [] : values.filter(result => result.problemType === 'check');
    const correctCount = values.filter(result => result.isCorrect).length;
    const learningCorrectCount = learning.filter(result => result.isCorrect).length;
    const checkCorrectCount = checks.filter(result => result.isCorrect).length;
    return {
        answeredCount: values.length,
        correctCount,
        accuracy: values.length ? Math.round(correctCount / values.length * 100) : null,
        learningAnsweredCount: learning.length,
        learningCorrectCount,
        learningAccuracy: learning.length ? Math.round(learningCorrectCount / learning.length * 100) : null,
        checkAnsweredCount: checks.length,
        checkCorrectCount,
        checkAccuracy: checks.length ? Math.round(checkCorrectCount / checks.length * 100) : null
    };
}

async function persistAnswer(pending, rating) {
    await pending.sessionReady;
    const { problem, isCorrect, timeMs } = pending;
    const now = Date.now();
    const { packId, questionId, problemKey } = getProblemIdentity(problem);
    const attemptType = getAttemptType(pending);
    const answerCategory = problem.type === 'check' && !pending.isFinalCheckMode ? 'check_understanding' : 'graded';
    const shouldUseReviewScheduler = rating !== null && rating !== undefined && problem.type !== 'check' && !pending.isFinalCheckMode;
    const shouldUpdateStats = attemptType === 'initial' && problem.type !== 'check' && !pending.isFinalCheckMode;

    let nextReviewState = null;
    if (shouldUseReviewScheduler) {
        // Version 4 で保存済みの packId:questionId 形式をそのまま引き継ぐ。
        const previous = await DB.get('fsrs_states', problemKey);
        const revision = Number.isInteger(problem.revision) && problem.revision > 0 ? problem.revision : 1;
        // 問題本文が改訂された場合、旧内容への評価履歴を新内容へ引き継がない。
        const current = resolveReviewStateForRevision(previous, problemKey, packId, questionId, revision, now);
        nextReviewState = calculateNextReviewState(current, rating, now);
        nextReviewState.packId = packId;
        nextReviewState.questionId = questionId;
        nextReviewState.revision = revision;
    }

    let nextStats = null;
    if (shouldUpdateStats) {
        const stats = await DB.get('problem_stats', problemKey);
        nextStats = stats || {
            problemId: problemKey,
            sourceProblemId: problem.problemId || questionId,
            packId,
            questionId,
            problemText: problem.largeText || '',
            problemData: null,
            packIds: [],
            totalAnswers: 0,
            correctAnswers: 0,
            continuousCorrects: 0,
            averageTimeMs: 0,
            lastAnsweredAt: 0,
            lastMistakeAt: null
        };
        nextStats.packId = packId;
        nextStats.questionId = questionId;
        nextStats.sourceProblemId = problem.problemId || questionId;
        nextStats.problemText = problem.largeText || '';
        nextStats.problemData = JSON.parse(JSON.stringify(problem));
        nextStats.packIds = [...new Set([...(nextStats.packIds || []), packId])];
        const previousCount = Number(nextStats.totalAnswers) || 0;
        nextStats.averageTimeMs = previousCount > 0
            ? Math.round(((Number(nextStats.averageTimeMs) || 0) * previousCount + timeMs) / (previousCount + 1))
            : timeMs;
        nextStats.totalAnswers = previousCount + 1;
        nextStats.lastAnsweredAt = now;
        if (isCorrect) {
            nextStats.correctAnswers = (Number(nextStats.correctAnswers) || 0) + 1;
            nextStats.continuousCorrects = (Number(nextStats.continuousCorrects) || 0) + 1;
        } else {
            nextStats.continuousCorrects = 0;
            nextStats.lastMistakeAt = now;
        }
    }

    const log = {
        id: createId('answer'),
        sessionId: pending.sessionId || null,
        packId,
        questionId,
        problemKey,
        problemId: problem.problemId || questionId,
        revision: problem.revision || 1,
        isCorrect: Boolean(isCorrect),
        rating: shouldUseReviewScheduler ? rating : null,
        timeMs,
        userAnswer: null,
        mode: pending.sessionMode,
        attemptType,
        answerCategory,
        problemType: problem.type || 'unknown',
        isInterimReview: pending.isInterimReview,
        isRetryingCurrent: pending.isRetryingCurrent,
        timestamp: now
    };

    const nextResults = new Map(pending.priorSessionResults || []);
    nextResults.set(problemKey, {
        isCorrect: Boolean(isCorrect),
        problemType: problem.type || 'unknown',
        timestamp: now
    });
    const summary = summarizeSessionResults(nextResults, pending.sessionMode === 'final_check');
    const session = pending.sessionId ? {
        id: pending.sessionId,
        ...summary,
        answerCount: pending.priorSessionAnswerCount + 1,
        updatedAt: now
    } : null;

    const userSetting = pending.sessionMode === 'scheduled_review'
        ? getCheckpointSetting(pending.sessionQuestions, pending.questionIndex + 1, now)
        : null;
    await DB.commitAnswer({ log, reviewState: nextReviewState, problemStat: nextStats, session, userSetting });
    // 保存完了が別セッション開始後に返ってきても、新しいセッションの状態を上書きしない。
    if (state.currentSessionId === pending.sessionId) {
        state.sessionAnswerResults = nextResults;
        state.sessionAnswerCount = pending.priorSessionAnswerCount + 1;
    }
    console.log(`[Q-One:DB] 解答を一括保存: ${problemKey} / ${attemptType} / rating=${log.rating}`);
}

async function finalizeCurrentSession() {
    const sessionId = state.currentSessionId;
    const sessionReady = state.sessionReady;
    const resultSnapshot = new Map(state.sessionAnswerResults || []);
    const answerCount = Number(state.sessionAnswerCount) || 0;
    const sessionMode = state.currentSessionMode;
    await sessionReady;
    const session = await DB.get('test_sessions', sessionId);
    if (!session || session.completedAt) return;
    session.completedAt = Date.now();
    session.totalTimeMs = Math.max(0, session.completedAt - (session.startedAt || session.completedAt));
    Object.assign(session, summarizeSessionResults(resultSnapshot, sessionMode === 'final_check'));
    session.answerCount = answerCount;
    await DB.put('test_sessions', session);
}

