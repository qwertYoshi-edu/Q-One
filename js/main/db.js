export const DB_NAME = 'QOneDB';
// Version 4 is the schema used by existing installations. No destructive
// migration is required for the fixes in this release.
export const DB_VERSION = 4;

export const STORE_KEY_PATHS = Object.freeze({
    packs: 'id',
    test_sessions: 'id',
    answer_logs: 'id',
    problem_stats: 'problemId',
    fsrs_states: 'id',
    user_settings: 'key'
});

let dbInstance = null;
let openingPromise = null;

export function initDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (openingPromise) return openingPromise;

    openingPromise = new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('このブラウザではIndexedDBを利用できません。'));
            openingPromise = null;
            return;
        }

        console.log(`[Q-One:DB] データベース初期化要求 (Version: ${DB_VERSION})`);
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            console.log(`[Q-One:DB] スキーマ確認 (Version: ${event.oldVersion} -> ${event.newVersion})`);

            Object.entries(STORE_KEY_PATHS).forEach(([name, keyPath]) => {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, { keyPath });
                    console.log(`[Q-One:DB] オブジェクトストア作成: ${name}`);
                }
            });
        };

        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            dbInstance.onversionchange = () => {
                dbInstance?.close();
                dbInstance = null;
                openingPromise = null;
            };
            dbInstance.onclose = () => {
                dbInstance = null;
                openingPromise = null;
            };
            console.log(`[Q-One:DB] データベース初期化完了 (Version: ${dbInstance.version})`);
            openingPromise = null;
            resolve(dbInstance);
        };

        request.onerror = () => {
            const error = request.error || new Error('IndexedDBの初期化に失敗しました。');
            console.error('[Q-One:Error] IndexedDBの初期化エラー:', error);
            openingPromise = null;
            reject(error);
        };

        request.onblocked = () => {
            console.warn('[Q-One:DB] データベース接続が別タブによってブロックされています。');
        };
    });

    return openingPromise;
}

function getDatabaseStoreNames(db) {
    return Array.from(db.objectStoreNames);
}


function runStoreRequest(storeName, mode, requestFactory, resultMapper = request => request.result) {
    if (!dbInstance) return Promise.reject(new Error('データベースが初期化されていません。'));
    if (!dbInstance.objectStoreNames.contains(storeName)) {
        return Promise.reject(new Error(`オブジェクトストアが見つかりません: ${storeName}`));
    }
    return new Promise((resolve, reject) => {
        let transaction;
        let request;
        let result;
        try {
            transaction = dbInstance.transaction(storeName, mode);
            request = requestFactory(transaction.objectStore(storeName));
        } catch (error) {
            reject(error);
            return;
        }
        request.onsuccess = () => { result = resultMapper(request); };
        request.onerror = () => {
            // IndexedDBは通常このエラーでトランザクションを中断する。
            reject(request.error || new Error(`${storeName} の処理に失敗しました。`));
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || request.error || new Error(`${storeName} の処理に失敗しました。`));
        transaction.onabort = () => reject(transaction.error || request.error || new Error(`${storeName} の処理が中断されました。`));
    });
}

export async function get(storeName, key) {
    await initDB();
    return runStoreRequest(storeName, 'readonly', store => store.get(key));
}

export async function getAll(storeName) {
    await initDB();
    return runStoreRequest(storeName, 'readonly', store => store.getAll(), request => request.result || []);
}

export async function put(storeName, item) {
    await initDB();
    return runStoreRequest(storeName, 'readwrite', store => store.put(item));
}

export async function add(storeName, item) {
    await initDB();
    return runStoreRequest(storeName, 'readwrite', store => store.add(item));
}

export async function remove(storeName, key) {
    await initDB();
    await runStoreRequest(storeName, 'readwrite', store => store.delete(key), () => undefined);
}

export async function clear(storeName) {
    await initDB();
    await runStoreRequest(storeName, 'readwrite', store => store.clear(), () => undefined);
}

/**
 * A complete answer write. The answer log, FSRS state, problem statistics and
 * owning session are committed in one IndexedDB transaction.
 * Builder callbacks must be synchronous and must not perform I/O.
 */
export async function recordAnswerTransaction({
    log,
    fsrsStateId = null,
    legacyFsrsStateId = null,
    buildFSRSState = null,
    statsKey = null,
    buildProblemStats = null
}) {
    const db = await initDB();
    const stores = ['answer_logs', 'test_sessions'];
    if (buildFSRSState && fsrsStateId) stores.push('fsrs_states');
    if (buildProblemStats && statsKey) stores.push('problem_stats');

    return new Promise((resolve, reject) => {
        let transaction;
        try {
            transaction = db.transaction(stores, 'readwrite');
        } catch (error) {
            reject(error);
            return;
        }

        let failure = null;
        const abortWith = (error) => {
            failure = error || new Error('解答記録トランザクションに失敗しました。');
            try { transaction.abort(); } catch (_) { /* transaction may already be inactive */ }
        };

        transaction.oncomplete = () => resolve({ id: log.id });
        transaction.onerror = () => reject(failure || transaction.error || new Error('解答記録に失敗しました。'));
        transaction.onabort = () => reject(failure || transaction.error || new Error('解答記録が中断されました。'));

        try {
            transaction.objectStore('answer_logs').add(log);

            const sessionStore = transaction.objectStore('test_sessions');
            const sessionRequest = sessionStore.get(log.sessionId);
            sessionRequest.onsuccess = () => {
                try {
                    const session = sessionRequest.result;
                    if (!session) throw new Error(`解答の保存先セッションが見つかりません: ${log.sessionId}`);

                    session.attemptCount = (Number(session.attemptCount) || 0) + 1;
                    if (log.attemptType === 'first') {
                        session.answeredCount = (session.answeredCount || 0) + 1;
                        if (log.isCorrect) session.correctCount = (session.correctCount || 0) + 1;
                        if (log.isCheckQuestion || log.mode === 'final_check') {
                            session.checkAnsweredCount = (session.checkAnsweredCount || 0) + 1;
                            if (log.isCorrect) session.checkOKCount = (session.checkOKCount || 0) + 1;
                            else session.checkReviewCount = (session.checkReviewCount || 0) + 1;
                        }
                    } else if (log.attemptType === 'interim_review') {
                        session.interimReviewAnsweredCount = (session.interimReviewAnsweredCount || 0) + 1;
                        if (log.isCorrect) session.interimReviewCorrectCount = (session.interimReviewCorrectCount || 0) + 1;
                    } else {
                        session.retryAnsweredCount = (session.retryAnsweredCount || 0) + 1;
                        if (log.isCorrect) session.retryCorrectCount = (session.retryCorrectCount || 0) + 1;
                    }

                    session.accuracy = session.answeredCount > 0
                        ? session.correctCount / session.answeredCount
                        : 0;
                    session.lastAnsweredAt = log.timestamp;
                    sessionStore.put(session);
                } catch (error) {
                    abortWith(error);
                }
            };
            sessionRequest.onerror = () => abortWith(sessionRequest.error);

            if (buildFSRSState && fsrsStateId) {
                const fsrsStore = transaction.objectStore('fsrs_states');
                const saveNextFSRSState = previousState => {
                    try {
                        const nextState = buildFSRSState(previousState || null);
                        if (!nextState || nextState.id !== fsrsStateId) {
                            throw new Error('FSRS状態の識別子が一致しません。');
                        }
                        fsrsStore.put(nextState);
                    } catch (error) {
                        abortWith(error);
                    }
                };
                const fsrsRequest = fsrsStore.get(fsrsStateId);
                fsrsRequest.onsuccess = () => {
                    if (fsrsRequest.result || !legacyFsrsStateId || legacyFsrsStateId === fsrsStateId) {
                        saveNextFSRSState(fsrsRequest.result || null);
                        return;
                    }
                    const legacyRequest = fsrsStore.get(legacyFsrsStateId);
                    legacyRequest.onsuccess = () => saveNextFSRSState(legacyRequest.result || null);
                    legacyRequest.onerror = () => abortWith(legacyRequest.error);
                };
                fsrsRequest.onerror = () => abortWith(fsrsRequest.error);
            }

            if (buildProblemStats && statsKey) {
                const statsStore = transaction.objectStore('problem_stats');
                const statsRequest = statsStore.get(statsKey);
                statsRequest.onsuccess = () => {
                    try {
                        const nextStats = buildProblemStats(statsRequest.result || null);
                        if (!nextStats || nextStats.problemId !== statsKey) {
                            throw new Error('問題成績の識別子が一致しません。');
                        }
                        statsStore.put(nextStats);
                    } catch (error) {
                        abortWith(error);
                    }
                };
                statsRequest.onerror = () => abortWith(statsRequest.error);
            }
        } catch (error) {
            abortWith(error);
        }
    });
}

/** Read all stores in one readonly transaction for a coherent backup. */
export async function exportAllData() {
    const db = await initDB();
    const storeNames = getDatabaseStoreNames(db);
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, 'readonly');
        const data = {};
        if (storeNames.length === 0) return resolve(data);

        storeNames.forEach(name => {
            const request = transaction.objectStore(name).getAll();
            request.onsuccess = () => { data[name] = request.result || []; };
            request.onerror = () => reject(request.error || new Error(`${name} の読み込みに失敗しました。`));
        });
        transaction.oncomplete = () => resolve(data);
        transaction.onerror = () => reject(transaction.error || new Error('バックアップの読み込みに失敗しました。'));
        transaction.onabort = () => reject(transaction.error || new Error('バックアップの読み込みが中断されました。'));
    });
}

/**
 * Atomically replace all known stores. Callers must validate every record
 * before invoking this function. Missing store arrays are treated as empty.
 */
export async function replaceAllData(storeData) {
    const db = await initDB();
    if (!storeData || typeof storeData !== 'object' || Array.isArray(storeData)) {
        throw new Error('インポートデータのストア構造が不正です。');
    }
    const storeNames = getDatabaseStoreNames(db);
    const normalized = {};
    for (const name of storeNames) {
        const records = storeData[name] === undefined ? [] : storeData[name];
        if (!Array.isArray(records)) throw new Error(`${name} は配列である必要があります。`);
        const keyPath = db.transaction(name, 'readonly').objectStore(name).keyPath;
        if (typeof keyPath !== 'string') throw new Error(`${name} の主キー定義を検証できません。`);
        const seen = new Set();
        records.forEach((record, index) => {
            if (!record || typeof record !== 'object' || Array.isArray(record)) {
                throw new Error(`${name}[${index}] はオブジェクトではありません。`);
            }
            const key = record[keyPath];
            if (typeof key !== 'string' || !key.trim()) throw new Error(`${name}[${index}] に主キー '${keyPath}' がありません。`);
            if (seen.has(key)) throw new Error(`${name} に重複した主キー '${key}' があります。`);
            seen.add(key);
        });
        normalized[name] = records;
    }
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('データのインポートに失敗しました。'));
        transaction.onabort = () => reject(transaction.error || new Error('データのインポートが中断されました。'));

        try {
            storeNames.forEach(name => {
                const store = transaction.objectStore(name);
                store.clear();
                normalized[name].forEach(record => store.put(record));
            });
        } catch (error) {
            try { transaction.abort(); } catch (_) { /* already inactive */ }
            reject(error);
        }
    });
}

/** Clear every object store in a single transaction. */
export async function clearAllData() {
    const db = await initDB();
    const storeNames = getDatabaseStoreNames(db);
    if (storeNames.length === 0) return;
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('全データの削除に失敗しました。'));
        transaction.onabort = () => reject(transaction.error || new Error('全データの削除が中断されました。'));
        storeNames.forEach(name => transaction.objectStore(name).clear());
    });
}

// 開発者用ヘルスチェックツール（コンソールから window.__debugQOne() で実行）
if (typeof window !== 'undefined') {
    window.__debugQOne = async function() {
        console.log('=== Q-One DB Diagnostics ===');
        try {
            const db = await initDB();
            console.log(`DB接続成功: ${db.name}, Version: ${db.version}`);
            const stores = getDatabaseStoreNames(db);
            console.log(`オブジェクトストア (${stores.length}):`, stores);
            for (const store of stores) {
                const all = await getAll(store);
                console.log(` - ${store}: ${all.length} records`);
            }
        } catch (err) {
            console.error('診断中にエラーが発生しました:', err);
        }
        console.log('============================');
    };
}
