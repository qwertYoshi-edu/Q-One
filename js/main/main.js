import { state } from './state.js';
import {
    screens, mainScreen, intermediateScreen, toggleIncorrectListBtn, listOverlay, toggleIncorrectListBtnMain,
    listOverlayMain, helpBtn, helpModal, copyIncorrectBtn, copyModal, copyTextarea,
    startBtn, finalCheckBtn, retryIncorrectBtn, retryAllBtn, retryFinalCheckBtn,
    restartCompletelyBtn, endRetryAllBtn, endRestartBtn, fillRateSlider, fillRateValue,
    homeBtn, interimReviewBtn, interimReviewPanelBtn, packCards, inputModeRadios, inputPanels,settingsBtn, settingsModal, darkModeToggle, fontSizeSlider, fontSizeValue,
    exportDataBtn, importDataBtn, importDataInput, resetDataBtn, profileBtn, profileModal, profileNameInput, mobileSettingsFab, settingsStack, closeSettingsBtn
} from './dom.js';
import { openProfileModal, saveUsername } from './profile.js';
import {
    startGame, startNewPass, retryIncorrect, retryAll, restartGame,
    startInterimReview, endInterimReview
} from './quiz.js';
import { setupModal, switchScreen, showIntermediateResults } from './ui.js';
import { reconstructProblemString } from './parser.js';
import { initPackManager } from '../generator/pack-manager.js';

import * as db from './db.js';

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
setupModal(profileModal); // 既存の setupModal で×ボタン等を制御

// ユーザー名の変更（フォーカスが外れた時）
if (profileNameInput) {
    profileNameInput.addEventListener('change', (e) => {
        saveUsername(e.target.value);
    });
    // Enterキーを押した際にフォーカスを外して保存を確定させる
    profileNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            profileNameInput.blur();
        }
    });
}

// ============================================================================
// モバイル版：設定スライドイン（オーバーレイ）の制御
// ============================================================================

// FABを押して開く
if (mobileSettingsFab) {
    mobileSettingsFab.addEventListener('click', () => {
        settingsStack.classList.add('is-open');
    });
}

// 閉じるボタンを押して閉じる
if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
        settingsStack.classList.remove('is-open');
    });
}

// 履歴タブの「もう一度解く」ボタンを押した際も設定を開く
// ※将来的に動的生成される場合、イベント委譲（Event Delegation）の利用も検討
document.addEventListener('click', (e) => {
    if (e.target.closest('.history-retry-actions .retry-action')) {
        if (window.innerWidth <= 899) {
            settingsStack.classList.add('is-open');
        }
    }
});

// テストが開始されたら、裏でこっそり設定シートを閉じておく（ホームに戻った時に閉じているようにする）
startBtn.addEventListener('click', () => {
    settingsStack.classList.remove('is-open');
    // startGame(false) は既存のイベントリスナーで実行される
});
finalCheckBtn.addEventListener('click', () => {
    settingsStack.classList.remove('is-open');
    // startGame(true) は既存のイベントリスナーで実行される
});

// ============================================================================
// 設定モーダル & データベース管理・データ入出力処理
// ============================================================================

// 初期化（DBから設定を読み込んで適用）
async function loadSettings() {
    try {
        await db.initDB();
        const themeSetting = await db.get('user_settings', 'theme');
        const fontSizeSetting = await db.get('user_settings', 'fontSize');

        const isDark = themeSetting ? themeSetting.value === 'dark' : false;
        darkModeToggle.checked = isDark;
        applyTheme(isDark);

        const fontSize = fontSizeSetting ? fontSizeSetting.value : 100;
        fontSizeSlider.value = fontSize;
        fontSizeValue.textContent = fontSize;
        applyFontSize(fontSize);
    } catch (e) {
        console.error('設定の読み込みに失敗しました', e);
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

// 設定モーダル制御
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => settingsModal.classList.add('active'));
}
setupModal(settingsModal);

darkModeToggle.addEventListener('change', async (e) => {
    const isDark = e.target.checked;
    applyTheme(isDark);
    await db.put('user_settings', { key: 'theme', value: isDark ? 'dark' : 'light' });
});

fontSizeSlider.addEventListener('input', (e) => {
    const val = e.target.value;
    fontSizeValue.textContent = val;
    applyFontSize(val);
});

fontSizeSlider.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10);
    await db.put('user_settings', { key: 'fontSize', value: val });
});

// JSONエクスポート
exportDataBtn.addEventListener('click', async () => {
    try {
        const data = {
            packs: await db.getAll('packs'),
            test_sessions: await db.getAll('test_sessions'),
            answer_logs: await db.getAll('answer_logs'),
            user_settings: await db.getAll('user_settings')
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
        console.error(err);
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
        
        // 簡易バリデーション
        if (typeof data !== 'object' || (!data.user_settings && !data.packs)) {
            throw new Error('サポートされていないデータフォーマットです。');
        }

        if (confirm('現在のデータはすべて上書きされます。よろしいですか？')) {
            await db.clear('packs');
            await db.clear('test_sessions');
            await db.clear('answer_logs');
            await db.clear('user_settings');

            for (const pack of data.packs || []) await db.put('packs', pack);
            for (const session of data.test_sessions || []) await db.put('test_sessions', session);
            for (const log of data.answer_logs || []) await db.put('answer_logs', log);
            for (const setting of data.user_settings || []) await db.put('user_settings', setting);

            alert('インポートが完了しました。設定を反映するためページを再読み込みします。');
            location.reload();
        }
    } catch (err) {
        console.error(err);
        alert('インポートに失敗しました: ' + err.message);
    } finally {
        importDataInput.value = ''; // ファイル選択リセット
    }
});

// 全データリセット
resetDataBtn.addEventListener('click', async () => {
    if (confirm('【警告】すべてのデータと設定が削除されます。本当に実行しますか？')) {
        try {
            await db.clear('packs');
            await db.clear('test_sessions');
            await db.clear('answer_logs');
            await db.clear('user_settings');
            alert('全データをリセットしました。ページを再読み込みします。');
            location.reload();
        } catch (err) {
            console.error(err);
            alert('リセット処理中にエラーが発生しました。');
        }
    }
});

// アプリ起動時に設定を適用
loadSettings();

// 問題パック生成・読み込み機能の初期化
initPackManager();

// 初期画面の表示
screens.setup.classList.add('visible');