export const DB_NAME = 'QOneDB';
export const DB_VERSION = 4; // Version 4 の既存利用者との互換性を維持

export const STORE_SCHEMAS = Object.freeze([
    { name: 'packs', keyPath: 'id' },
    { name: 'test_sessions', keyPath: 'id' },
    { name: 'answer_logs', keyPath: 'id' },
    { name: 'problem_stats', keyPath: 'problemId' },
    { name: 'fsrs_states', keyPath: 'id' },
    { name: 'user_settings', keyPath: 'key' }
]);

let dbInstance = null;
let dbInitPromise = null;

export function initDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('このブラウザではIndexedDBを利用できません。'));
            return;
        }

        console.log(`[Q-One:DB] データベース初期化要求 (Version: ${DB_VERSION})`);
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            STORE_SCHEMAS.forEach(({ name, keyPath }) => {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, { keyPath });
                    console.log(`[Q-One:DB] ストア作成: ${name}`);
                }
            });
        };

        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            dbInstance.onversionchange = () => {
                dbInstance.close();
                dbInstance = null;
                dbInitPromise = null;
            };
            console.log(`[Q-One:DB] データベース初期化完了 (Version: ${dbInstance.version})`);
            resolve(dbInstance);
        };

        request.onerror = (event) => {
            const error = event.target.error || new Error('IndexedDBの初期化に失敗しました。');
            console.error('[Q-One:Error] IndexedDBの初期化エラー:', error);
            reject(error);
        };

        request.onblocked = () => {
            console.warn('[Q-One:DB] 他のタブがデータベース更新を妨げています。');
        };
    }).catch(error => {
        dbInitPromise = null;
        throw error;
    });

    return dbInitPromise;
}

function getStore(storeName, mode = 'readonly') {
    if (!dbInstance) throw new Error('データベースが初期化されていません。');
    if (!dbInstance.objectStoreNames.contains(storeName)) {
        throw new Error(`オブジェクトストアが見つかりません: ${storeName}`);
    }
    return dbInstance.transaction(storeName, mode).objectStore(storeName);
}

function transactionPromise(transaction, label = 'IndexedDB transaction') {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error(`${label} に失敗しました。`));
        transaction.onabort = () => reject(transaction.error || new Error(`${label} が中断されました。`));
    });
}

export async function get(storeName, key) {
    await initDB();
    return new Promise((resolve, reject) => {
        let request;
        try { request = getStore(storeName).get(key); }
        catch (error) { reject(error); return; }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function getAll(storeName) {
    await initDB();
    return new Promise((resolve, reject) => {
        let request;
        try { request = getStore(storeName).getAll(); }
        catch (error) { reject(error); return; }
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

export async function put(storeName, item) {
    await initDB();
    return new Promise((resolve, reject) => {
        let request;
        try { request = getStore(storeName, 'readwrite').put(item); }
        catch (error) { reject(error); return; }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function add(storeName, item) {
    await initDB();
    return new Promise((resolve, reject) => {
        let request;
        try { request = getStore(storeName, 'readwrite').add(item); }
        catch (error) { reject(error); return; }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function remove(storeName, key) {
    await initDB();
    return new Promise((resolve, reject) => {
        let request;
        try { request = getStore(storeName, 'readwrite').delete(key); }
        catch (error) { reject(error); return; }
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function clear(storeName) {
    await initDB();
    return new Promise((resolve, reject) => {
        let request;
        try { request = getStore(storeName, 'readwrite').clear(); }
        catch (error) { reject(error); return; }
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function getAllStores() {
    await initDB();
    const storeNames = Array.from(dbInstance.objectStoreNames);
    const tx = dbInstance.transaction(storeNames, 'readonly');
    const result = {};
    const requests = storeNames.map(name => new Promise((resolve, reject) => {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { result[name] = request.result || []; resolve(); };
        request.onerror = () => reject(request.error);
    }));
    await Promise.all(requests);
    return result;
}

/**
 * 解答ログ・簡易間隔反復状態・問題統計・セッション進捗を単一トランザクションで確定する。
 * answer_logs は add() を使い、同一IDの二重記録を制約違反として検出する。
 */
export async function commitAnswer({ log, reviewState = null, problemStat = null, session = null, userSetting = null }) {
    await initDB();
    const storeNames = ['answer_logs', 'fsrs_states', 'problem_stats', 'test_sessions'];
    if (userSetting) storeNames.push('user_settings');
    const tx = dbInstance.transaction(storeNames, 'readwrite');
    const completion = transactionPromise(tx, '解答保存');

    try {
        tx.objectStore('answer_logs').add(log);
        if (reviewState) tx.objectStore('fsrs_states').put(reviewState);
        if (problemStat) tx.objectStore('problem_stats').put(problemStat);
        if (userSetting) tx.objectStore('user_settings').put(userSetting);
        if (session) {
            const sessionStore = tx.objectStore('test_sessions');
            const sessionRequest = sessionStore.get(session.id);
            sessionRequest.onsuccess = () => {
                sessionStore.put({ ...(sessionRequest.result || {}), ...session });
            };
        }
    } catch (error) {
        try { tx.abort(); } catch (_) { /* すでに終了 */ }
        throw error;
    }
    await completion;
    return true;
}

/**
 * バックアップを全ストア一括で置換する。トランザクション失敗時は全操作がロールバックされる。
 */
export async function replaceAllStores(dataByStore) {
    await initDB();
    const storeNames = Array.from(dbInstance.objectStoreNames);
    const tx = dbInstance.transaction(storeNames, 'readwrite');
    const completion = transactionPromise(tx, 'データインポート');

    try {
        for (const name of storeNames) {
            const store = tx.objectStore(name);
            store.clear();
            const records = dataByStore[name] || [];
            for (const record of records) store.put(record);
        }
    } catch (error) {
        try { tx.abort(); } catch (_) { /* すでに終了 */ }
        throw error;
    }
    await completion;
}

/** 全オブジェクトストアを単一トランザクションで消去する。 */
export async function clearAllStores() {
    await initDB();
    const storeNames = Array.from(dbInstance.objectStoreNames);
    const tx = dbInstance.transaction(storeNames, 'readwrite');
    const completion = transactionPromise(tx, '全データリセット');
    try {
        for (const name of storeNames) tx.objectStore(name).clear();
    } catch (error) {
        try { tx.abort(); } catch (_) { /* すでに終了 */ }
        throw error;
    }
    await completion;
}

// 開発者用ヘルスチェックツール（コンソールから window.__debugQOne() で実行）
if (typeof window !== 'undefined') {
    window.__debugQOne = async function() {
        console.log('=== Q-One DB Diagnostics ===');
        try {
            await initDB();
            console.log(`DB接続成功: ${dbInstance.name}, Version: ${dbInstance.version}`);
            const stores = Array.from(dbInstance.objectStoreNames);
            console.log(`オブジェクトストア (${stores.length}):`, stores);
            for (const store of stores) {
                const all = await getAll(store);
                console.log(`- ${store}: ${all.length} records`);
            }
        } catch (error) {
            console.error('診断中にエラーが発生しました:', error);
        }
        console.log('============================');
    };
}
