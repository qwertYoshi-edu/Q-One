import { state } from './state.js';
import {
    screens, mainScreen, views, feedbackContainer, feedbackText, actionBtn, checkButtonContainer,
    addToReviewBtn, modeIndicator, postAnswerButtons, nextProblemBtn, retryCurrentProblemBtn,
    selfGradingContainer, selfGradingInfo, selfGradeCorrectBtn, selfGradeIncorrectBtn,
    fillRateSlider, selfGradeCheckbox, modeTextRadio, rangeStartInput, rangeEndInput,　fsrsRatingContainer, fsrsRatingBtns
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
    if (modeTextRadio && !modeTextRadio.checked) {
        alert('現在「テキスト入力」タブのみ対応しています。');
        return;
    }
    state.isFinalCheckMode = isCheckMode;
    state.isInterimReview = false;
    state.savedState = null;
    state.isSelfGradingMode = selfGradeCheckbox.checked && !state.isFinalCheckMode;

    const inputText = document.getElementById('input-text').value;
    const allProblems = parseText(inputText);
    
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

    const selectedImportance = document.querySelector('input[name="importance"]:checked').value;
    const [minImp, maxImp] = selectedImportance.split('-').map(Number);
    let filteredProblems = slicedProblems.filter(p => p.importance >= minImp && p.importance <= maxImp);
    
    if (document.getElementById('shuffle-checkbox').checked) filteredProblems.sort(() => Math.random() - 0.5);
    
    if (filteredProblems.length === 0) {
        alert('選択した範囲・重要度の問題が存在しないか、形式に誤りがあります。');
        return;
    }
    
    state.originalWordList = JSON.parse(JSON.stringify(filteredProblems));
    state.fillBlankRate = parseInt(fillRateSlider.value, 10);
    
    // 新規セッションIDの生成 (UUIDが無ければランダム文字列)
    state.currentSessionId = (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36);
    
    startNewPass(filteredProblems, false);
}

export function startNewPass(problems, isReview) {
    state.wordList = [...problems];
    state.reviewList = [];
    state.currentIndex = 0;
    state.correctCount = 0;
    state.checkOKCount = 0;
    state.checkReviewCount = 0;
    state.mistakeCount = 0;
    state.currentPassTotalForRate = state.wordList.filter(p => p.type !== 'check' && !state.isFinalCheckMode).length;
    state.isCheckOnlyMode = state.wordList.every(p => p.type === 'check');
    state.isReviewPhase = isReview;

    let modeTitle = state.isFinalCheckMode ? '直前チェック' : (state.isReviewPhase ? '復習モード' : '通常モード');
    if (state.isSelfGradingMode && !state.isFinalCheckMode) modeTitle += ' (自己採点)';
    modeIndicator.textContent = modeTitle;

    updateIncorrectListPanel();
    screenSwitcher('main');
    
    // テストセッションをDBに記録（UIを止めないようにバックグラウンド実行）
    if (!isReview) {
        DB.put('test_sessions', {
            id: state.currentSessionId,
            packId: 'manual_input', // 仮
            mode: state.isFinalCheckMode ? 'final_check' : 'normal',
            range: `${rangeStartInput ? rangeStartInput.value || '1' : '1'} ~ ${rangeEndInput ? rangeEndInput.value || '最後' : '最後'}`,
            totalQuestions: state.wordList.length,
            correctCount: 0,
            totalTimeMs: 0,
            startedAt: Date.now(),
            completedAt: null
        }).catch(err => console.error('セッション保存エラー:', err));
    }

    showNextProblem();
}

export function retryIncorrect() {
    state.isFinalCheckMode = false;
    if (state.reviewList.length > 0) startNewPass(state.reviewList, true);
}

export function retryAll() {
    state.isFinalCheckMode = false;
    startNewPass(state.originalWordList, false);
}

export function restartGame() {
    state.isInterimReview = false;
    state.savedState = null;
    screenSwitcher('setup');
}

export function showNextProblem() {
    state.isRetryingCurrent = false;
    if (state.currentIndex >= state.wordList.length) {
        if (state.isInterimReview) endInterimReview(true);
        else if (state.reviewList.length === 0) screenSwitcher('end');
        else screenSwitcher('intermediate');
        return;
    }

    updateProgress();
    resetQuestionUI(views);

    const problem = state.wordList[state.currentIndex];
    let reviewMark = state.isReviewPhase ? '<span class="review-indicator">復習</span>' : '';
    if (state.isInterimReview) reviewMark = '<span class="review-indicator" style="background-color: var(--warning-color); color: white;">一旦復習</span>';
    const view = views[state.isFinalCheckMode ? 'check' : problem.type];
    
    const largeTextContent = view.querySelector('.large-text');
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
    const timeMs = Date.now() - state.currentQuestionStartTime;
    const problem = state.wordList[state.currentIndex];
    const isPrimaryTest = !state.isInterimReview && !state.isFinalCheckMode && !state.isRetryingCurrent;
    
    console.log(`[Q-One:Quiz] 回答検知: 解答時間 [${timeMs}]ms / 正誤: [${isCorrect}]`);

    // DBへの記録をバックグラウンドで実行
    saveAnswerToDB(problem, isCorrect, timeMs, isPrimaryTest).catch(err => {
        console.error('[Q-One:Error] saveAnswerToDB 実行中にエラー発生:', err);
    });

    if (!state.isRetryingCurrent) {
        if (state.isInterimReview) {
            if (isCorrect) {
                state.correctCount++;
                state.mistakeCount--;
                state.savedState.reviewList = state.savedState.reviewList.filter(p => p.originalString !== problem.originalString);
            } else {
                if (!state.reviewList.some(p => p.originalString === problem.originalString)) state.reviewList.push(problem);
            }
        } else {
            if (problem.type === 'check' || state.isFinalCheckMode) isCorrect ? state.checkOKCount++ : state.checkReviewCount++;
            else if (isCorrect) state.correctCount++;
            if (!isCorrect) {
                if (!state.reviewList.some(p => p.originalString === problem.originalString)) state.reviewList.push(problem);
                if (problem.type !== 'check' && !state.isFinalCheckMode) state.mistakeCount++;
            }
            updateIncorrectListPanel();
        }
    }

    if (problem.type !== 'check' && !state.isFinalCheckMode) {
        feedbackText.textContent = isCorrect ? '正解！' : `不正解　正しい解答: ${correctAnswerText}`;
        feedbackContainer.className = `visible ${isCorrect ? 'correct' : 'incorrect'}`;
        actionBtn.classList.remove('visible');

        if (isCorrect) {
            // 正解時: 4段階自己評価ボタンを表示
            postAnswerButtons.classList.remove('active');
            if (fsrsRatingContainer) {
                fsrsRatingContainer.classList.add('active');
                fsrsRatingBtns.forEach(btn => {
                    btn.onclick = async () => {
                        const rating = parseInt(btn.dataset.rating, 10);
                        fsrsRatingContainer.classList.remove('active');
                        await recordFSRSAnswer(problem, rating, timeMs, true);
                        moveToNextProblem();
                    };
                });
            }
        } else {
            // 不正解時: 自動的に Again (rating: 1) として記録し、解説表示とともに「次へ」ボタンを表示
            if (fsrsRatingContainer) fsrsRatingContainer.classList.remove('active');
            recordFSRSAnswer(problem, FSRS_RATINGS.AGAIN, timeMs, false);

            // 仕様書「同じ問題を誤答直後に連続出題しない」: キューの少し後方（3問後または末尾）に再挿入
            if (!state.isRetryingCurrent && !state.isInterimReview) {
                const insertIndex = Math.min(state.wordList.length, state.currentIndex + 3);
                state.wordList.splice(insertIndex, 0, problem);
            }

            postAnswerButtons.classList.add('active');
            nextProblemBtn.onclick = moveToNextProblem;
            retryCurrentProblemBtn.onclick = retryCurrentProblem;
        }
    } else {
        moveToNextProblem();
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
    mainScreen.classList.remove('list-open');
    state.isInterimReview = true;
    state.savedState = {
        wordList: [...state.wordList],
        currentIndex: state.currentIndex,
        reviewList: [...state.reviewList]
    };
    state.wordList = [...state.reviewList].sort(() => Math.random() - 0.5);
    state.reviewList = [];
    state.currentIndex = 0;
    modeIndicator.textContent = '一旦復習モード';
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
    modeIndicator.textContent = modeTitle;
    updateIncorrectListPanel();
    if (resume) showNextProblem();
}

async function saveAnswerToDB(problem, isCorrect, timeMs, isPrimaryTest) {
    try {
        const timestamp = Date.now();
        
        if (!problem.problemId) {
            console.warn('[Q-One:Warning] problemId が存在しません。ログ保存に失敗する可能性があります。');
        }

        // 1. 解答ログの保存
        await DB.add('answer_logs', {
            id: `${state.currentSessionId}-${timestamp}-${Math.random().toString(36).slice(2, 6)}`,
            sessionId: state.currentSessionId,
            problemId: problem.problemId || 'unknown',
            isCorrect: isCorrect,
            timeMs: timeMs,
            userAnswer: null, 
            isInterimReview: state.isInterimReview,
            timestamp: timestamp
        });
        console.log(`[Q-One:DB] ログ保存完了 (answer_logs)`);

        // 2. 問題の成績(Stats)の更新 (初回挑戦かつ本番テストの時のみ)
        if (isPrimaryTest && problem.type !== 'check') {
            // 対象が存在しない場合のNotFoundErrorを防ぐため catch して null にフォールバック
            let stats = await DB.get('problem_stats', problem.problemId).catch(() => null);
            if (!stats) {
                stats = {
                    problemId: problem.problemId,
                    problemText: problem.largeText,
                    problemData: { ...problem },
                    packIds: ['manual_input'],
                    totalAnswers: 0,
                    correctAnswers: 0,
                    continuousCorrects: 0,
                    averageTimeMs: 0,
                    lastAnsweredAt: 0,
                    lastMistakeAt: null
                };
            } else {
                stats.problemData = { ...problem };
            }

            // 移動平均の計算
            if (stats.totalAnswers > 0) {
                stats.averageTimeMs = Math.round((stats.averageTimeMs * stats.totalAnswers + timeMs) / (stats.totalAnswers + 1));
            } else {
                stats.averageTimeMs = timeMs;
            }

            stats.totalAnswers++;
            stats.lastAnsweredAt = timestamp;

            if (isCorrect) {
                stats.correctAnswers++;
                stats.continuousCorrects++;
            } else {
                stats.continuousCorrects = 0;
                stats.lastMistakeAt = timestamp;
            }

            await DB.put('problem_stats', stats);
            console.log(`[Q-One:DB] 成績表更新完了 (problem_stats)`);
        }
    } catch (err) {
        console.error('[Q-One:Error] DB保存処理中に深刻な例外が発生しました:', err);
    }
}

/**
 * FSRS評価と履歴をIndexedDBへ保存するヘルパー
 */
async function recordFSRSAnswer(problem, rating, timeMs, isCorrect) {
    try {
        const now = Date.now();
        const problemKey = `${problem.packId || 'manual_input'}:${problem.questionId || problem.problemId}`;

        // 1. 既存のFSRS状態を取得または新規作成
        let fsrsState = await DB.get('fsrs_states', problemKey).catch(() => null);
        if (!fsrsState) {
            fsrsState = createInitialFSRSState(problemKey, problem.packId, problem.questionId, problem.revision || 1);
        }

        // 2. 次のFSRS状態を計算して保存
        const updatedFSRS = calculateNextFSRSState(fsrsState, rating, now);
        await DB.put('fsrs_states', updatedFSRS);

        // 3. 回答ログを保存
        await DB.add('answer_logs', {
            id: `${state.currentSessionId}-${now}-${Math.random().toString(36).slice(2, 6)}`,
            sessionId: state.currentSessionId,
            packId: problem.packId || 'manual_input',
            questionId: problem.questionId || problem.problemId,
            problemKey: problemKey,
            revision: problem.revision || 1,
            rating: rating,
            isCorrect: isCorrect,
            timeMs: timeMs,
            timestamp: now
        });
        console.log(`[Q-One:FSRS] 保存完了: Rating [${rating}] / 次回復習 [${updatedFSRS.intervalDays}日後]`);
    } catch (e) {
        console.error('[Q-One:Error] FSRS状態の保存に失敗:', e);
    }
}
