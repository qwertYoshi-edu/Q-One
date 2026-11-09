import { state } from './state.js';
import {
    screens, mainScreen, views, feedbackContainer, feedbackText, actionBtn, checkButtonContainer,
    addToReviewBtn, modeIndicator, postAnswerButtons, nextProblemBtn, retryCurrentProblemBtn,
    selfGradingContainer, selfGradingInfo, selfGradeCorrectBtn, selfGradeIncorrectBtn,
    fillRateSlider, selfGradeCheckbox, modeTextRadio, rangeStartInput, rangeEndInput, fsrsRatingContainer, fsrsRatingBtns
} from './dom.js';

// 名前衝突を防ぐため「DB」という大文字の変数名でインポート
import * as DB from './db.js';

import { parseText } from './parser.js';
import { escapeHtml, normalizeAnswer, FSRS_RATINGS, calculateNextFSRSState, createInitialFSRSState } from './utils.js';
import { resetQuestionUI, switchScreen, updateProgress, updateIncorrectListPanel, showIntermediateResults } from './ui.js';

function screenSwitcher(screenName) {
    return switchScreen(screenName, showIntermediateResults);
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
        if (!state.selectedPackData || !state.selectedPackData.problems || state.selectedPackData.problems.length === 0) {
            alert('出題する問題パックを一覧から選択してください。');
            return;
        }
        state.currentPackId = state.selectedPackData.id;
        allProblems = state.selectedPackData.problems.map((p, idx) => ({
            ...p,
            packId: state.selectedPackData.id,
            questionId: p.questionId || `q_${idx + 1}`
        }));
    } else {
        state.currentPackId = 'manual_input';
        state.selectedPackData = null;
        const inputTextEl = document.getElementById('input-text');
        if (!inputTextEl) {
            console.error('[Q-One:DOM] #input-text が見つかりません。');
            alert('問題入力欄が見つかりません。HTMLとJavaScriptのバージョンを確認してください。');
            return;
        }
        allProblems = parseText(inputTextEl.value, 'manual_input');
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

    const selectedImportance = document.querySelector('input[name="importance"]:checked')?.value || '1-3';
    const [minImp, maxImp] = selectedImportance.split('-').map(Number);
    let filteredProblems = slicedProblems.filter(p => p.importance >= minImp && p.importance <= maxImp);
    
    if (document.getElementById('shuffle-checkbox')?.checked) filteredProblems.sort(() => Math.random() - 0.5);
    
    if (filteredProblems.length === 0) {
        alert('選択した範囲・重要度の問題が存在しないか、形式に誤りがあります。');
        return;
    }
    
    state.originalWordList = JSON.parse(JSON.stringify(filteredProblems));
    state.fillBlankRate = Number.parseInt(fillRateSlider?.value || '100', 10) || 100;
    
    // 新規セッションIDの生成 (UUIDが無ければランダム文字列)
    startNewPass(filteredProblems, false, { mode: isCheckMode ? 'final_check' : 'normal' });
}

function createSessionId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneData(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeProblemIdentity(problem, index, fallbackPackId) {
    const packId = String(problem.packId || fallbackPackId || 'manual_input');
    const questionId = String(problem.questionId || problem.problemId || `q_${index + 1}`);
    const revision = Number.isInteger(Number(problem.revision)) && Number(problem.revision) > 0
        ? Number(problem.revision)
        : 1;
    return {
        ...problem,
        packId,
        questionId,
        revision,
        problemId: problem.problemId || questionId,
        problemKey: `${packId}:${questionId}:r${revision}`
    };
}

export function startNewPass(problems, isReview, options = {}) {
    if (!Array.isArray(problems) || problems.length === 0) {
        alert('出題できる問題がありません。');
        return;
    }

    const fallbackPackId = options.packId || state.currentPackId || 'manual_input';
    state.wordList = problems.map((problem, index) => normalizeProblemIdentity(problem, index, fallbackPackId));
    state.originalWordList = cloneData(state.wordList);
    const sessionMode = options.mode || (state.isFinalCheckMode ? 'final_check' : (isReview ? 'review' : 'normal'));
    state.sessionMode = sessionMode;
    state.isFinalCheckMode = sessionMode === 'final_check';
    state.reviewList = [];
    state.currentIndex = 0;
    state.correctCount = 0;
    state.checkOKCount = 0;
    state.checkReviewCount = 0;
    state.mistakeCount = 0;
    state.answerHandledForCurrent = false;
    state.sessionAttemptCounts = Object.create(null);

    state.currentPassTotalForRate = state.wordList.filter(p => p.type !== 'check' && !state.isFinalCheckMode).length;
    // 直前チェックでは全問題を確認型UIで扱い、理解度として集計する。
    state.isCheckOnlyMode = state.isFinalCheckMode || state.wordList.every(p => p.type === 'check');
    state.isReviewPhase = Boolean(isReview);

    const uniquePackIds = [...new Set(state.wordList.map(p => p.packId))];
    state.currentPackId = uniquePackIds.length === 1 ? uniquePackIds[0] : 'multiple';
    state.currentSessionId = createSessionId();
    state.sessionStartedAt = Date.now();

    let modeTitle;
    if (sessionMode === 'final_check') modeTitle = '直前チェック';
    else if (sessionMode === 'weakness_training') modeTitle = '苦手克服特訓';
    else if (sessionMode === 'review') modeTitle = '復習モード';
    else modeTitle = '通常モード';
    if (state.isSelfGradingMode && sessionMode !== 'final_check') modeTitle += ' (自己採点)';
    if (modeIndicator) modeIndicator.textContent = modeTitle;

    updateIncorrectListPanel();
    screenSwitcher('main');

    const startedAt = state.sessionStartedAt;
    const sessionRecord = {
        id: state.currentSessionId,
        packId: uniquePackIds.length === 1 ? uniquePackIds[0] : (uniquePackIds.length ? 'multiple' : fallbackPackId),
        packIds: uniquePackIds,
        packTitle: options.packTitle || (state.selectedPackData?.title || ''),
        packCategory: options.packCategory || (state.selectedPackData?.category || ''),
        mode: sessionMode,
        sourceSessionId: options.sourceSessionId || null,
        range: options.range ?? `${rangeStartInput?.value || '1'} ~ ${rangeEndInput?.value || '最後'}`,
        totalQuestions: state.wordList.length,
        answeredCount: 0,
        attemptCount: 0,
        correctCount: 0,
        accuracy: 0,
        checkAnsweredCount: 0,
        checkOKCount: 0,
        checkReviewCount: 0,
        interimReviewAnsweredCount: 0,
        interimReviewCorrectCount: 0,
        retryAnsweredCount: 0,
        retryCorrectCount: 0,
        totalTimeMs: 0,
        startedAt,
        completedAt: null,
        snapshotVersion: 1,
        problemSnapshot: cloneData(state.wordList)
    };
    state.currentSessionSaveError = null;
    state.currentSessionSavePromise = DB.put('test_sessions', sessionRecord).then(() => true).catch(err => {
        state.currentSessionSaveError = err;
        console.error('[Q-One:Error] セッション保存エラー:', err);
        alert('学習セッションを保存できませんでした。ブラウザのストレージ設定を確認してください。');
        return false;
    });

    showNextProblem();
}

export function retryIncorrect() {
    state.isFinalCheckMode = false;
    if (state.reviewList.length > 0) startNewPass(state.reviewList, true, { mode: 'review', sourceSessionId: state.currentSessionId });
}

export function retryAll() {
    const previousMode = state.sessionMode || 'normal';
    state.isFinalCheckMode = previousMode === 'final_check';
    startNewPass(state.originalWordList, previousMode === 'review' || previousMode === 'weakness_training', { mode: previousMode, sourceSessionId: state.currentSessionId });
}

export function restartGame() {
    state.isInterimReview = false;
    state.savedState = null;
    screenSwitcher('setup');
}

export function showNextProblem() {
    state.isRetryingCurrent = false;
    state.answerHandledForCurrent = false;
    if (nextProblemBtn) {
        nextProblemBtn.disabled = false;
        nextProblemBtn.textContent = '次へ';
    }
    if (retryCurrentProblemBtn) retryCurrentProblemBtn.disabled = false;
    if (state.currentIndex >= state.wordList.length) {
        // テスト終了時にセッションレコードを更新
        if (!state.isInterimReview && state.currentSessionId) {
            DB.get('test_sessions', state.currentSessionId).then(session => {
                if (session) {
                    session.completedAt = Date.now();
                    session.totalTimeMs = Date.now() - session.startedAt;
                    DB.put('test_sessions', session);
                }
            }).catch(e => console.error('[Q-One:Error] セッション更新エラー:', e));
        }

        if (state.isInterimReview) endInterimReview(true);
        else if (state.reviewList.length === 0) screenSwitcher('end');
        else screenSwitcher('intermediate');
        return;
    }

    updateProgress();
    fsrsRatingBtns.forEach(btn => { btn.dataset.used = 'false'; btn.disabled = false; });
    resetQuestionUI(views);

    const problem = state.wordList[state.currentIndex];
    let reviewMark = state.isReviewPhase ? '<span class="review-indicator">復習</span>' : '';
    if (state.isInterimReview) reviewMark = '<span class="review-indicator" style="background-color: var(--warning-color); color: white;">一旦復習</span>';
    const view = views[state.isFinalCheckMode ? 'check' : problem.type];
    if (!view) {
        console.error(`[Q-One:DOM] 問題形式 '${problem.type}' の表示領域がありません。`);
        alert(`問題表示領域が不足しています (${problem.type})。ページを再読み込みしてください。`);
        return;
    }

    const largeTextContent = view.querySelector('.large-text');
    if (!largeTextContent) throw new Error(`問題表示領域 '${problem.type}' に .large-text がありません。`);
    largeTextContent.innerHTML = '';
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
        view.querySelector('.small-text').innerHTML = answerHtml;
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
    const okButton = document.getElementById('ok-btn');
    const reviewButton = document.getElementById('review-btn');
    if (!checkButtonContainer || !okButton || !reviewButton) {
        console.error('[Q-One:DOM] 確認型問題の回答UIが不足しています。');
        alert('確認型問題の回答UIが見つかりません。ページを再読み込みしてください。');
        return;
    }
    checkButtonContainer.classList.add('active');
    okButton.disabled = false;
    reviewButton.disabled = false;
    okButton.onclick = () => handleAnswerFeedback(true);
    reviewButton.onclick = () => handleAnswerFeedback(false);
}

function setupSelect(problem) {
    const container = document.getElementById('select-options-container');
    if (!container || !Array.isArray(problem.options) || problem.options.length === 0) {
        console.error('[Q-One:DOM/Data] 選択問題の選択肢UIまたはデータが不足しています。', problem);
        alert('選択問題の選択肢を表示できません。問題データを確認してください。');
        return;
    }
    container.innerHTML = '';
    [...problem.options].sort(() => Math.random() - 0.5).forEach(optionText => {
        const btn = document.createElement('button');
        btn.textContent = optionText;
        btn.className = 'select-option-btn';
        btn.onclick = (e) => {
            container.querySelectorAll('button').forEach(b => b.disabled = true);
            const isCorrect = (optionText === problem.correctAnswer);
            container.querySelectorAll('button').forEach(b => {
                if (b.textContent === problem.correctAnswer) b.classList.add('correct');
            });
            if (!isCorrect) e.target.classList.add('incorrect');
            handleAnswerFeedback(isCorrect, problem.correctAnswer);
        };
        container.appendChild(btn);
    });
}

function setupEnter(problem) {
    const input = document.getElementById('enter-input');
    if (!input || !actionBtn) {
        console.error('[Q-One:DOM] 記述問題の入力UIが不足しています。');
        alert('記述問題の入力欄が見つかりません。');
        return;
    }
    input.value = '';
    input.disabled = false;

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
    if (!contentDiv || !actionBtn || !Array.isArray(problem.answers) || !Array.isArray(problem.questionParts) || problem.questionParts.length !== problem.answers.length + 1) {
        console.error('[Q-One:DOM/Data] 穴埋め問題の表示UIまたはデータが不正です。', problem);
        alert('穴埋め問題を表示できません。問題データを確認してください。');
        return;
    }
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
    state.isRetryingCurrent = true;
    state.answerHandledForCurrent = false;
    state.currentQuestionStartTime = Date.now();
    feedbackContainer?.classList.remove('visible', 'correct', 'incorrect', 'neutral');
    postAnswerButtons?.classList.remove('active');
    selfGradingContainer?.classList.remove('active');
    if (addToReviewBtn) addToReviewBtn.style.display = 'none';
    const problem = state.wordList[state.currentIndex];
    if (problem.type === 'select') setupSelect(problem);
    else if (problem.type === 'enter') setupEnter(problem);
    else if (problem.type === 'fill') setupFill(problem);
}

function buildProblemKey(problem) {
    const packId = String(problem.packId || state.currentPackId || 'manual_input');
    const questionId = String(problem.questionId || problem.problemId || 'unknown');
    const revision = Number(problem.revision) || 1;
    return `${packId}:${questionId}:r${revision}`;
}

async function persistAnswer(problem, isCorrect, timeMs, rating, attemptType, timestamp = Date.now()) {
    const packId = String(problem.packId || state.currentPackId || 'manual_input');
    const questionId = String(problem.questionId || problem.problemId || 'unknown');
    const revision = Number(problem.revision) || 1;
    const problemKey = buildProblemKey(problem);
    const isCheckQuestion = problem.type === 'check' || state.isFinalCheckMode;
    const mode = state.isInterimReview ? 'interim_review' : state.sessionMode;
    const attemptNumber = (state.sessionAttemptCounts[problemKey] || 0) + 1;
    state.sessionAttemptCounts[problemKey] = attemptNumber;

    const logId = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `answer_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
    const log = {
        id: logId,
        sessionId: state.currentSessionId || 'session_unknown',
        packId,
        questionId,
        problemId: problem.problemId || questionId,
        problemKey,
        revision,
        problemType: problem.type,
        isCheckQuestion,
        mode,
        sessionMode: state.sessionMode,
        attemptType,
        attemptNumber,
        isFirstAttempt: attemptType === 'first',
        isInterimReview: mode === 'interim_review',
        isCorrect: Boolean(isCorrect),
        rating: Number.isInteger(rating) ? rating : null,
        timeMs: Math.max(0, Number(timeMs) || 0),
        userAnswer: null,
        timestamp
    };

    const shouldUpdateStats = state.sessionMode === 'normal' && attemptType === 'first' && !isCheckQuestion;
    await DB.recordAnswerTransaction({
        log,
        fsrsStateId: Number.isInteger(rating) ? problemKey : null,
        legacyFsrsStateId: Number.isInteger(rating) ? `${packId}:${questionId}` : null,
        buildFSRSState: Number.isInteger(rating)
            ? previous => {
                const compatiblePrevious = previous && (Number(previous.revision) || 1) === revision
                    ? previous
                    : createInitialFSRSState(problemKey, packId, questionId, revision);
                const next = calculateNextFSRSState(compatiblePrevious, rating, timestamp);
                return { ...next, id: problemKey, packId, questionId, revision };
            }
            : null,
        statsKey: shouldUpdateStats ? problemKey : null,
        buildProblemStats: shouldUpdateStats ? previous => {
            const stats = previous || {
                problemId: problemKey,
                problemKey,
                packId,
                questionId,
                revision,
                problemText: problem.largeText || '',
                problemData: cloneData(problem),
                packIds: [],
                totalAnswers: 0,
                correctAnswers: 0,
                continuousCorrects: 0,
                averageTimeMs: 0,
                lastAnsweredAt: 0,
                lastMistakeAt: null
            };
            const previousTotal = Number(stats.totalAnswers) || 0;
            const safeTime = Math.max(0, Number(timeMs) || 0);
            stats.problemKey = problemKey;
            stats.packId = packId;
            stats.questionId = questionId;
            stats.revision = revision;
            stats.problemText = problem.largeText || stats.problemText || '';
            stats.problemData = cloneData(problem);
            stats.packIds = [...new Set([...(Array.isArray(stats.packIds) ? stats.packIds : []), packId])];
            stats.averageTimeMs = previousTotal > 0
                ? Math.round(((Number(stats.averageTimeMs) || 0) * previousTotal + safeTime) / (previousTotal + 1))
                : safeTime;
            stats.totalAnswers = previousTotal + 1;
            stats.lastAnsweredAt = timestamp;
            if (isCorrect) {
                stats.correctAnswers = (Number(stats.correctAnswers) || 0) + 1;
                stats.continuousCorrects = (Number(stats.continuousCorrects) || 0) + 1;
            } else {
                stats.continuousCorrects = 0;
                stats.lastMistakeAt = timestamp;
            }
            return stats;
        } : null
    });
    console.log(`[Q-One:DB] 解答を一元記録: ${problemKey} / ${attemptType} / ${isCorrect ? '正解' : '不正解'}`);
}

function handleAnswerFeedback(isCorrect, correctAnswerText) {
    if (state.answerHandledForCurrent) return;
    state.answerHandledForCurrent = true;

    const timeMs = Math.max(0, Date.now() - (state.currentQuestionStartTime || Date.now()));
    const problem = state.wordList[state.currentIndex];
    if (!problem) {
        state.answerHandledForCurrent = false;
        console.error('[Q-One:Quiz] 回答対象の問題が見つかりません。');
        return;
    }
    const attemptType = state.isInterimReview
        ? 'interim_review'
        : (state.isRetryingCurrent ? 'retry_current' : 'first');

    console.log(`[Q-One:Quiz] 回答検知: 解答時間 [${timeMs}]ms / 正誤: [${isCorrect}]`);

    const saveAnswer = async (rating, advance = true) => {
        try {
            const sessionSaved = await state.currentSessionSavePromise;
            if (!sessionSaved) throw state.currentSessionSaveError || new Error('学習セッションを保存できていません。');
            await persistAnswer(problem, isCorrect, timeMs, rating, attemptType);
            if (advance) moveToNextProblem();
            return true;
        } catch (error) {
            console.error('[Q-One:Error] 解答記録の保存に失敗しました:', error);
            alert(`解答記録を保存できませんでした。画面を進める前に、同じ回答の記録を再試行してください。\n${error.message || error}`);
            return false;
        }
    };

    if (attemptType !== 'retry_current') {
        if (state.isInterimReview) {
            if (isCorrect) {
                state.correctCount++;
                state.mistakeCount = Math.max(0, state.mistakeCount - 1);
                if (state.savedState) {
                    state.savedState.reviewList = state.savedState.reviewList.filter(p => buildProblemKey(p) !== buildProblemKey(problem));
                }
            } else if (!state.reviewList.some(p => buildProblemKey(p) === buildProblemKey(problem))) {
                state.reviewList.push(problem);
            }
        } else {
            if (problem.type === 'check' || state.isFinalCheckMode) {
                if (isCorrect) state.checkOKCount++;
                else state.checkReviewCount++;
            } else if (isCorrect) {
                state.correctCount++;
            }
            if (!isCorrect) {
                if (!state.reviewList.some(p => buildProblemKey(p) === buildProblemKey(problem))) state.reviewList.push(problem);
                if (problem.type !== 'check' && !state.isFinalCheckMode) state.mistakeCount++;
            }
            updateIncorrectListPanel();
        }
    }

    const requiresFSRSRating = problem.type !== 'check' && !state.isFinalCheckMode;
    if (requiresFSRSRating) {
        if (!feedbackText || !feedbackContainer) {
            console.error('[Q-One:DOM] 解答フィードバックUIが不足しています。');
            alert('解答結果の表示に必要なUIが見つかりません。');
            state.answerHandledForCurrent = false;
            return;
        }
        feedbackText.textContent = isCorrect ? '正解！' : `不正解　正しい解答: ${correctAnswerText || ''}`;
        feedbackContainer.className = `visible ${isCorrect ? 'correct' : 'incorrect'}`;
        actionBtn?.classList.remove('visible');

        if (isCorrect) {
            postAnswerButtons?.classList.remove('active');
            if (fsrsRatingContainer && fsrsRatingBtns.length > 0) {
                fsrsRatingContainer.classList.add('active');
                fsrsRatingBtns.forEach(btn => {
                    btn.disabled = false;
                    btn.onclick = async () => {
                        if (btn.dataset.used === 'true') return;
                        fsrsRatingBtns.forEach(item => { item.disabled = true; });
                        fsrsRatingContainer.classList.remove('active');
                        const saved = await saveAnswer(parseInt(btn.dataset.rating, 10), true);
                        if (saved) btn.dataset.used = 'true';
                        fsrsRatingBtns.forEach(item => { item.disabled = false; });
                        if (!saved) {
                            fsrsRatingContainer.classList.add('active');
                            state.answerHandledForCurrent = true;
                        }
                    };
                });
            } else {
                // FSRS UIが欠落している環境でも、回答ログだけは失わない。
                saveAnswer(FSRS_RATINGS.GOOD, true);
            }
        } else {
            fsrsRatingContainer?.classList.remove('active');
            postAnswerButtons?.classList.add('active');

            // 誤答ログの保存が完了するまでは次の問題へ進めない。
            // 保存失敗時は「次へ」ボタンから同一回答の保存だけを再試行する。
            let answerPersisted = false;
            let saveInFlight = false;
            const nextLabel = nextProblemBtn?.textContent || '次へ';
            const retrySaveOrAdvance = async () => {
                if (saveInFlight) return;
                if (!answerPersisted) {
                    saveInFlight = true;
                    if (nextProblemBtn) nextProblemBtn.disabled = true;
                    if (retryCurrentProblemBtn) retryCurrentProblemBtn.disabled = true;
                    const saved = await saveAnswer(FSRS_RATINGS.AGAIN, false);
                    saveInFlight = false;
                    answerPersisted = saved;
                    if (!saved) {
                        if (nextProblemBtn) {
                            nextProblemBtn.disabled = false;
                            nextProblemBtn.textContent = '記録を再試行';
                        }
                        return;
                    }
                    if (nextProblemBtn) {
                        nextProblemBtn.disabled = false;
                        nextProblemBtn.textContent = nextLabel;
                    }
                    if (retryCurrentProblemBtn) retryCurrentProblemBtn.disabled = false;
                    return;
                }
                moveToNextProblem();
            };
            if (nextProblemBtn) {
                nextProblemBtn.disabled = true;
                nextProblemBtn.onclick = retrySaveOrAdvance;
            }
            if (retryCurrentProblemBtn) {
                retryCurrentProblemBtn.disabled = true;
                retryCurrentProblemBtn.onclick = async () => {
                    if (!answerPersisted) {
                        await retrySaveOrAdvance();
                        if (!answerPersisted) return;
                    }
                    retryCurrentProblem();
                };
            }
            retrySaveOrAdvance();
        }
    } else {
        // 確認型・直前チェックも同じ一元記録経路を通す。
        // 失敗時は選択済みのボタンだけを再試行ボタンとして残し、状態カウンタを二重加算しない。
        const selectedCheckButton = document.getElementById(isCorrect ? 'ok-btn' : 'review-btn');
        const otherCheckButton = document.getElementById(isCorrect ? 'review-btn' : 'ok-btn');
        if (selectedCheckButton) selectedCheckButton.disabled = true;
        if (otherCheckButton) otherCheckButton.disabled = true;
        const persistCheckAnswer = async () => {
            const saved = await saveAnswer(null, true);
            if (!saved && selectedCheckButton) selectedCheckButton.disabled = false;
        };
        if (selectedCheckButton) selectedCheckButton.onclick = persistCheckAnswer;
        persistCheckAnswer();
    }

    updateProgress();
}

function moveToNextProblem() {
    state.currentIndex++;
    showNextProblem();
}

export function startInterimReview() {
    if (state.reviewList.length === 0) {
        alert('復習する問題がありません。');
        return;
    }
    if (!confirm('間違えた問題を復習しますか？')) return;
    mainScreen?.classList.remove('list-open');
    state.isInterimReview = true;
    state.savedState = {
        wordList: [...state.wordList],
        currentIndex: state.currentIndex,
        reviewList: [...state.reviewList]
    };
    state.wordList = [...state.reviewList].sort(() => Math.random() - 0.5);
    state.reviewList = [];
    state.currentIndex = 0;
    if (modeIndicator) modeIndicator.textContent = '一旦復習モード';
    showNextProblem();
}

export function endInterimReview(resume) {
    if (!state.isInterimReview) return;
    state.wordList = state.savedState.wordList;
    state.currentIndex = state.savedState.currentIndex;
    state.reviewList = state.savedState.reviewList;
    state.isInterimReview = false;
    state.savedState = null;
    let modeTitle = state.isFinalCheckMode ? '直前チェック' : (state.isReviewPhase ? '復習モード' : '通常モード');
    if (state.isSelfGradingMode && !state.isFinalCheckMode) modeTitle += ' (自己採点)';
    if (modeIndicator) modeIndicator.textContent = modeTitle;
    updateIncorrectListPanel();
    if (resume) showNextProblem();
}

