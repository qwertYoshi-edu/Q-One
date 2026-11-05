// main.js
import { state } from './state.js';
import {
    screens, mainScreen, intermediateScreen, toggleIncorrectListBtn, listOverlay, toggleIncorrectListBtnMain,
    listOverlayMain, helpBtn, helpModal, copyIncorrectBtn, copyModal, copyTextarea,
    startBtn, finalCheckBtn, retryIncorrectBtn, retryAllBtn, retryFinalCheckBtn,
    restartCompletelyBtn, endRetryAllBtn, endRestartBtn, fillRateSlider, fillRateValue,
    homeBtn, interimReviewBtn, interimReviewPanelBtn, packCards, inputModeRadios, inputPanels,
    settingsBtn, settingsModal, darkModeToggle, fontSizeSlider, fontSizeValue,
    exportDataBtn, importDataBtn, importDataInput, resetDataBtn, profileBtn, profileModal, profileNameInput,
    mobileSettingsFab, settingsStack, closeSettingsBtn
} from './dom.js';

import { openProfileModal, saveUsername } from './profile.js';
import {
    startGame, startNewPass, retryIncorrect, retryAll, restartGame,
    startInterimReview, endInterimReview
} from './quiz.js';
import { setupModal, switchScreen, showIntermediateResults } from './ui.js';
import { reconstructProblemString } from './parser.js';
import { initPackManager } from '../generator/pack-manager.js';
import { initAnalysisModule, renderAnalysisDashboard } from './analysis.js';
import * as DB from './db.js';

// 中間結果画面の誤答リスト開閉
if (toggleIncorrectListBtn) {
    toggleIncorrectListBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        intermediateScreen.classList.toggle('list-open');
        toggleIncorrectListBtn.innerHTML = intermediateScreen.classList.contains('list-open') ? '&lt;' : '&gt;';
    });
}
if (listOverlay) listOverlay.addEventListener('click', () => intermediateScreen.classList.remove('list-open'));

// 出題画面の誤答リスト開閉
if (toggleIncorrectListBtnMain) {
    toggleIncorrectListBtnMain.addEventListener('click', (e) => {
        e.stopPropagation();
        mainScreen.classList.toggle('list-open');
        toggleIncorrectListBtnMain.innerHTML = mainScreen.classList.contains('list-open') ? '&lt;' : '&gt;';
    });
}
if (listOverlayMain) listOverlayMain.addEventListener('click', () => mainScreen.classList.remove('list-open'));

// ヘルプモーダル
helpBtn.addEventListener('click', () => helpModal.classList.add('active'));
setupModal(helpModal);

// 誤答コピーモーダル
copyIncorrectBtn.addEventListener('click', () => {
    const incorrectProblemsText = state.reviewList.map(reconstructProblemString).join('#\n');
    copyTextarea.value = incorrectProblemsText;
    copyModal.classList.add('active');
});
setupModal(copyModal);
copyTextarea.addEventListener('click', function() { this.select(); });

// ゲーム制御ボタン
startBtn.addEventListener('click', () => startGame(false));
finalCheckBtn.addEventListener('click', () => startGame(true));
retryIncorrectBtn.addEventListener('click', retryIncorrect);
retryAllBtn.addEventListener('click', retryAll);
retryFinalCheckBtn.addEventListener('click', () => {
    state.isFinalCheckMode = true;
    startNewPass(state.originalWordList, false);
});
restartCompletelyBtn.addEventListener('click', restartGame);
endRetryAllBtn.addEventListener('click', retryAll);
endRestartBtn.addEventListener('click', restartGame);
fillRateSlider.addEventListener('input', (e) => { fillRateValue.textContent = e.target.value; });

// ヘッダー操作
homeBtn.addEventListener('click', () => {
    if (confirm('最初の画面に戻りますか？\n（入力した問題や設定は保持されます）')) {
        if (state.isInterimReview) endInterimReview(false);
        switchScreen('setup', showIntermediateResults);
    }
});

interimReviewBtn.addEventListener('click', () => {
    if (state.isInterimReview) {
        if (confirm('復習を中断して元の問題に戻りますか？')) endInterimReview(true);
    } else {
        startInterimReview();
    }
});
interimReviewPanelBtn.addEventListener('click', startInterimReview);

// ===== 問題パックカードの選択インタラクション =====
packCards.forEach((card) => {
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', 'false');
    const selectCard = () => {
        packCards.forEach((other) => {
            const selected = other === card;
            other.classList.toggle('is-selected', selected);
            other.setAttribute('aria-pressed', String(selected));
        });
    };
    card.addEventListener('click', selectCard);
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectCard();
        }
    });
});

// 入力モードタブ切替時のアニメーション制御
inputModeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
        if (inputPanels) {
            inputPanels.querySelectorAll('.panel').forEach((panel) => { panel.style.animation = 'none'; });
            requestAnimationFrame(() => {
                const active = inputPanels.querySelector('.panel[style*="display: block"]');
                if (active) active.style.animation = '';
            });
        }
    });
});

// ============================================================================
// プロフィールモーダル管理
// ============================================================================
if (profileBtn) {
    profileBtn.addEventListener('click', () => openProfileModal());
}
setupModal(profileModal);

if (profileNameInput) {
    profileNameInput.addEventListener('change', (e) => {
        saveUsername(e.target.value);
    });
    profileNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            profileNameInput.blur();
        }
    });
}

// ============================================================================
// モバイル版：設定スライドイン（オーバーレイ）の制御
// ============================================================================
if (mobileSettingsFab) {
    mobileSettingsFab.addEventListener('click', () => {
        settingsStack.classList.add('is-open');
    });
}
if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
        settingsStack.classList.remove('is-open');
    });
}
document.addEventListener('click', (e) => {
    if (e.target.closest('.history-retry-actions .retry-action')) {
        if (window.innerWidth <= 899) {
            settingsStack.classList.add('is-open');
        }
    }
});
startBtn.addEventListener('click', () => {
    settingsStack.classList.remove('is-open');
});
finalCheckBtn.addEventListener('click', () => {
    settingsStack.classList.remove('is-open');
});

// ============================================================================
// 設定モーダル & データベース管理・データ入出力処理
// ============================================================================
async function loadSettings() {
    try {
        await DB.initDB();
        const themeSetting = await DB.get('user_settings', 'theme');
        const fontSizeSetting = await DB.get('user_settings', 'fontSize');

        const isDark = themeSetting ? themeSetting.value === 'dark' : false;
        darkModeToggle.checked = isDark;
        applyTheme(isDark);

        const fontSize = fontSizeSetting ? fontSizeSetting.value : 100;
        fontSizeSlider.value = fontSize;
        fontSizeValue.textContent = fontSize;
        applyFontSize(fontSize);
    } catch (e) {
        console.error('[Q-One:Error] 設定の読み込みに失敗しました', e);
    }
}

function applyTheme(isDark) {
    if (isDark) {
        document.documentElement.dataset.theme = 'dark';
    } else {
        delete document.documentElement.dataset.theme;
    }
}

function applyFontSize(percent) {
    document.documentElement.style.fontSize = `${16 * (percent / 100)}px`;
}

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => settingsModal.classList.add('active'));
}
setupModal(settingsModal);

darkModeToggle.addEventListener('change', async (e) => {
    const isDark = e.target.checked;
    applyTheme(isDark);
    await DB.put('user_settings', { key: 'theme', value: isDark ? 'dark' : 'light' });
});

fontSizeSlider.addEventListener('input', (e) => {
    const val = e.target.value;
    fontSizeValue.textContent = val;
    applyFontSize(val);
});

fontSizeSlider.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10);
    await DB.put('user_settings', { key: 'fontSize', value: val });
});

// JSONエクスポート
exportDataBtn.addEventListener('click', async () => {
    try {
        const data = {
            packs: await DB.getAll('packs'),
            test_sessions: await DB.getAll('test_sessions'),
            answer_logs: await DB.getAll('answer_logs'),
            problem_stats: await DB.getAll('problem_stats'),
            user_settings: await DB.getAll('user_settings')
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `QOne_Backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('[Q-One:Error] エクスポートエラー:', err);
        alert('エクスポートに失敗しました。');
    }
});

// JSONインポート
importDataBtn.addEventListener('click', () => importDataInput.click());

importDataInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        if (typeof data !== 'object' || (!data.user_settings && !data.packs)) {
            throw new Error('サポートされていないデータフォーマットです。');
        }

        if (confirm('現在のデータはすべて上書きされます。よろしいですか？')) {
            await DB.clear('packs');
            await DB.clear('test_sessions');
            await DB.clear('answer_logs');
            await DB.clear('problem_stats');
            await DB.clear('user_settings');

            for (const pack of data.packs || []) await DB.put('packs', pack);
            for (const session of data.test_sessions || []) await DB.put('test_sessions', session);
            for (const log of data.answer_logs || []) await DB.put('answer_logs', log);
            for (const stat of data.problem_stats || []) await DB.put('problem_stats', stat);
            for (const setting of data.user_settings || []) await DB.put('user_settings', setting);

            alert('インポートが完了しました。設定を反映するためページを再読み込みします。');
            location.reload();
        }
    } catch (err) {
        console.error('[Q-One:Error] インポートエラー:', err);
        alert('インポートに失敗しました: ' + err.message);
    } finally {
        importDataInput.value = '';
    }
});

// 全データリセット
resetDataBtn.addEventListener('click', async () => {
    if (confirm('【警告】すべてのデータと設定が削除されます。本当に実行しますか？')) {
        try {
            await DB.clear('packs');
            await DB.clear('test_sessions');
            await DB.clear('answer_logs');
            await DB.clear('problem_stats');
            await DB.clear('user_settings');
            alert('全データをリセットしました。ページを再読み込みします。');
            location.reload();
        } catch (err) {
            console.error('[Q-One:Error] リセットエラー:', err);
            alert('リセット処理中にエラーが発生しました。');
        }
    }
});

// ============================================================================
// アプリケーション起動
// ============================================================================
loadSettings();
initPackManager();
initAnalysisModule();

// 初期画面の表示
screens.setup.classList.add('visible');
