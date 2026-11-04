export const state = {
    originalWordList: [],
    wordList: [],
    reviewList: [],
    currentIndex: 0,
    correctCount: 0,
    checkOKCount: 0,
    checkReviewCount: 0,
    currentPassTotalForRate: 0,
    isReviewPhase: false,
    currentScreen: 'setup',
    mistakeCount: 0,
    fillBlankRate: 100,
    isCheckOnlyMode: false,
    isFinalCheckMode: false,
    isRetryingCurrent: false,
    isInterimReview: false,
    savedState: null,
    isSelfGradingMode: false,
    selfGradingFillState: {
        currentIndex: 0,
        blanks: [],
        results: [],
        problem: null
    }
};
