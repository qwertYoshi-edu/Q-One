// ============================================================================
// 問題パック管理 UIコントローラー
// ============================================================================

import { encodeToVideo, decodeFromVideo } from './qr-video-core.js';

// DOM要素
const exportPackBtn = document.getElementById('export-pack-btn');
const addPackBtn = document.getElementById('add-pack-btn');
const packFileInput = document.getElementById('pack-file-input');
const inputText = document.getElementById('input-text');
const modeTextRadio = document.getElementById('mode-text');

// プログレスモーダル要素
const progressModal = document.getElementById('progress-modal');
const progressTitle = document.getElementById('progress-modal-title');
const progressBar = document.getElementById('progress-modal-bar');
const progressStatus = document.getElementById('progress-modal-status');
const progressCancelBtn = document.getElementById('progress-modal-cancel');

let isProcessCanceled = false;

// モーダル表示・非表示
function showProgressModal(title) {
    isProcessCanceled = false;
    progressTitle.textContent = title;
    progressBar.style.width = '0%';
    progressStatus.textContent = '準備中...';
    progressCancelBtn.style.display = 'inline-flex';
    progressModal.classList.add('active');
}

function hideProgressModal() {
    progressModal.classList.remove('active');
}

function updateProgressUI(ratio, message) {
    progressBar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    if (message) progressStatus.textContent = message;
}

// ファイルダウンロード用ヘルパー
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 1000);
}

// パック出力処理
async function handleExportPack() {
    const text = inputText.value.trim();
    if (!text) {
        alert('出力する問題データが入力されていません。\nテキストエリアに問題を入力してください。');
        return;
    }

    showProgressModal('問題パックを作成中...');

    try {
        const videoBlob = await encodeToVideo(text, (ratio, message) => {
            updateProgressUI(ratio, message);
        });

        updateProgressUI(1.0, '動画ファイルの生成が完了しました！');
        const filename = `QOne-Pack-${Date.now()}.mp4`;
        triggerDownload(videoBlob, filename);
        
        setTimeout(() => {
            hideProgressModal();
            alert(`問題パックを保存しました。\nファイル名: ${filename}`);
        }, 500);

    } catch (err) {
        console.error(err);
        hideProgressModal();
        alert(`問題パックの出力に失敗しました:\n${err.message || err}`);
    }
}

// パック読み込み（復元）処理
async function handleImportPack(file) {
    if (!file) return;

    showProgressModal('問題パックを解析中...');

    try {
        const restoredText = await decodeFromVideo(
            file,
            (ratio, message) => {
                updateProgressUI(ratio, message);
            },
            () => isProcessCanceled
        );

        updateProgressUI(1.0, '復元完了！');

        setTimeout(() => {
            hideProgressModal();
            // テキスト入力欄に反映
            inputText.value = restoredText;
            // 「テキスト入力」タブに自動切替
            if (modeTextRadio) {
                modeTextRadio.checked = true;
                modeTextRadio.dispatchEvent(new Event('change'));
            }
            alert(`「${file.name}」から問題データを正常に読み込みました！\n設定を確認してスタートしてください。`);
        }, 500);

    } catch (err) {
        console.error(err);
        hideProgressModal();
        if (!isProcessCanceled) {
            alert(`問題パックの読み込みに失敗しました:\n${err.message || err}`);
        }
    } finally {
        packFileInput.value = ''; // 選択リセット
    }
}

// イベントリスナーの登録
export function initPackManager() {
    // パック出力ボタン
    if (exportPackBtn) {
        exportPackBtn.addEventListener('click', handleExportPack);
    }

    // パック読み込みタイル
    if (addPackBtn && packFileInput) {
        addPackBtn.addEventListener('click', () => packFileInput.click());
        packFileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleImportPack(file);
        });
    }

    // キャンセルボタン
    if (progressCancelBtn) {
        progressCancelBtn.addEventListener('click', () => {
            isProcessCanceled = true;
            progressStatus.textContent = 'キャンセル中...';
            progressCancelBtn.style.display = 'none';
        });
    }
}