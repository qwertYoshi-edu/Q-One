export const screens = {
    setup: document.getElementById('setup-screen'),
    main: document.getElementById('main-screen'),
    intermediate: document.getElementById('intermediate-screen'),
    end: document.getElementById('end-screen'),
    info: document.getElementById('info-screen')
};

export const mainScreen = document.getElementById('main-screen');

export const views = {
    check: document.getElementById('check-view'),
    select: document.getElementById('select-view'),
    enter: document.getElementById('enter-view'),
    fill: document.getElementById('fill-view')
};

export const feedbackContainer = document.getElementById('feedback-container');
export const feedbackText = document.getElementById('feedback-text');
export const actionBtn = document.getElementById('action-btn');
export const checkButtonContainer = document.getElementById('check-button-container');
export const progressBar = document.getElementById('progress-bar');
export const progressTextEl = document.getElementById('progress-text');
export const importanceDisplay = document.getElementById('importance-display');
export const mistakeCounter = document.getElementById('mistake-counter');
export const addToReviewBtn = document.getElementById('add-to-review-btn');
export const modeIndicator = document.getElementById('mode-indicator');

export const helpBtn = document.getElementById('help-btn');
export const helpModal = document.getElementById('help-modal');
export const copyIncorrectBtn = document.getElementById('copy-incorrect-btn');
export const copyModal = document.getElementById('copy-modal');
export const copyTextarea = document.getElementById('copy-textarea');
export const fillRateSlider = document.getElementById('fill-rate-slider');
export const fillRateValue = document.getElementById('fill-rate-value');
export const confettiCanvas = document.getElementById('confetti-canvas');

export const postAnswerButtons = document.getElementById('post-answer-buttons');
export const nextProblemBtn = document.getElementById('next-problem-btn');
export const retryCurrentProblemBtn = document.getElementById('retry-current-problem-btn');

export const reviewRatingContainer = document.getElementById('review-rating-container');
export const reviewRatingBtns = document.querySelectorAll('#review-rating-container .btn-review-rating');

export const selfGradingContainer = document.getElementById('self-grading-container');
export const selfGradingInfo = document.getElementById('self-grading-info');
export const selfGradeCorrectBtn = document.getElementById('self-grade-correct-btn');
export const selfGradeIncorrectBtn = document.getElementById('self-grade-incorrect-btn');
export const selfGradeCheckbox = document.getElementById('self-grade-checkbox');

export const homeBtn = document.getElementById('home-btn');
export const interimReviewBtn = document.getElementById('interim-review-btn');
export const interimReviewPanelBtn = document.getElementById('interim-review-panel-btn');
export const toggleIncorrectListBtnMain = document.getElementById('toggle-incorrect-list-btn-main');
export const listOverlayMain = document.querySelector('.list-overlay-main');
export const incorrectListMain = document.getElementById('incorrect-list-main');

export const intermediateScreen = document.getElementById('intermediate-screen');
export const toggleIncorrectListBtn = document.getElementById('toggle-incorrect-list-btn');
export const listOverlay = document.querySelector('.list-overlay');

export const startBtn = document.getElementById('start-btn');
export const finalCheckBtn = document.getElementById('final-check-btn');
export const retryIncorrectBtn = document.getElementById('retry-incorrect-btn');
export const retryAllBtn = document.getElementById('retry-all-btn');
export const retryFinalCheckBtn = document.getElementById('retry-final-check-btn');
export const restartCompletelyBtn = document.getElementById('restart-completely-btn');
export const endRetryAllBtn = document.getElementById('end-retry-all-btn');
export const endRestartBtn = document.getElementById('end-restart-btn');
export const okBtn = document.getElementById('ok-btn');
export const reviewBtn = document.getElementById('review-btn');
export const enterInput = document.getElementById('enter-input');
export const selectOptionsContainer = document.getElementById('select-options-container');
export const fillContent = document.getElementById('fill-content');

// ===== 新デザイン（モックアップUI）用要素 =====
export const modeTextRadio = document.getElementById('mode-text');
export const addPackBtn = document.getElementById('add-pack-btn');
export const packFileInput = document.getElementById('pack-file-input');
export const packFileStatus = document.getElementById('pack-file-status');
export const packCards = document.querySelectorAll('.pack-grid .q-card');
export const inputModeRadios = document.querySelectorAll('input[name="input_mode"]');
export const inputPanels = document.querySelector('.input-panels');

// ===== 設定モーダル・データ管理用要素 =====
export const settingsBtn = document.getElementById('settings-btn');
export const settingsModal = document.getElementById('settings-modal');
export const darkModeToggle = document.getElementById('dark-mode-toggle');
export const fontSizeSlider = document.getElementById('font-size-slider');
export const fontSizeValue = document.getElementById('font-size-value');
export const exportDataBtn = document.getElementById('export-data-btn');
export const importDataBtn = document.getElementById('import-data-btn');
export const importDataInput = document.getElementById('import-data-input');
export const resetDataBtn = document.getElementById('reset-data-btn');

// ===== プロフィール用要素 =====
export const profileBtn = document.querySelector('.app-actions .icon-btn[title="プロフィール"]');
export const profileModal = document.getElementById('profile-modal');
export const profileNameInput = document.getElementById('profile-username');
export const statTotalQuestions = document.getElementById('stat-total-questions');
export const statCorrectRate = document.getElementById('stat-correct-rate');
export const statLearningDays = document.getElementById('stat-learning-days');

// ===== モバイル用設定画面フロー要素 =====
export const mobileSettingsFab = document.getElementById('mobile-settings-fab');
export const settingsStack = document.querySelector('.settings-stack');
export const closeSettingsBtn = document.getElementById('close-settings-btn');

export const rangeStartInput = document.getElementById('range-start');
export const rangeEndInput = document.getElementById('range-end');
