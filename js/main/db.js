export const DB_NAME = 'QOneDB';
export const DB_VERSION = 4; // FSRS導入に伴いバージョンを4へ引き上げ

let dbInstance = null;

export function initDB() {
    return new Promise((resolve, reject) => {
        if (dbInstance) return resolve(dbInstance);

        console.log(`[Q-One:DB] データベース初期化要求 (Version: ${DB_VERSION})`);
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            console.log(`[Q-One:DB] onupgradeneeded 発火 (oldVersion: ${e.oldVersion} -> newVersion: ${e.newVersion})`);
            const db = e.target.result;
            
            // 必要なオブジェクトストアの一覧とそれぞれの主キー
            const schemas = [
                { name: 'packs', keyPath: 'id' },
                { name: 'test_sessions', keyPath: 'id' },
                { name: 'answer_logs', keyPath: 'id' },
                { name: 'problem_stats', keyPath: 'problemId' },
                { name: 'fsrs_states', keyPath: 'id' }, // 新規追加: packId + questionId を主キーとする復習状態
                { name: 'user_settings', keyPath: 'key' }
            ];

            schemas.forEach(schema => {
                if (!db.objectStoreNames.contains(schema.name)) {
                    db.createObjectStore(schema.name, { keyPath: schema.keyPath });
                    console.log(`[Q-One:DB] ストア作成: ${schema.name}`);
                }
            });
        };

        request.onsuccess = (e) => {
            dbInstance = e.target.result;
            console.log(`[Q-One:DB] データベース初期化完了 (Version: ${dbInstance.version})`);
            resolve(dbInstance);
        };

        request.onerror = (e) => {
            console.error('[Q-One:Error] IndexedDBの初期化エラー:', e.target.error);
            reject(e.target.error);
        };
    });
}

function getStore(storeName, mode = 'readonly') {
    if (!dbInstance) throw new Error("データベースが初期化されていません。");
    if (!dbInstance.objectStoreNames.contains(storeName)) {
        throw new Error(`オブジェクトストアが見つかりません: ${storeName}`);
    }
    return dbInstance.transaction(storeName, mode).objectStore(storeName);
}

export async function get(storeName, key) {
    await initDB();
    return new Promise((resolve, reject) => {
        const request = getStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function getAll(storeName) {
    await initDB();
    return new Promise((resolve, reject) => {
        const request = getStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function put(storeName, item) {
    await initDB();
    return new Promise((resolve, reject) => {
        const request = getStore(storeName, 'readwrite').put(item);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function add(storeName, item) {
    await initDB();
    return new Promise((resolve, reject) => {
        const request = getStore(storeName, 'readwrite').add(item);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function remove(storeName, key) {
    await initDB();
    return new Promise((resolve, reject) => {
        const request = getStore(storeName, 'readwrite').delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function clear(storeName) {
    await initDB();
    return new Promise((resolve, reject) => {
        const request = getStore(storeName, 'readwrite').clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 開発者用ヘルスチェックツール（コンソールから window.__debugQOne() で実行）
window.__debugQOne = async function() {
    console.log("=== Q-One DB Diagnostics ===");
    try {
        await initDB();
        console.log(`✅ DB接続成功: ${dbInstance.name}, Version: ${dbInstance.version}`);
        const stores = Array.from(dbInstance.objectStoreNames);
        console.log(`📦 オブジェクトストア (${stores.length}):`, stores);
        
        for (const store of stores) {
            const all = await getAll(store);
            console.log(`   - ${store}: ${all.length} records`);
        }
    } catch (err) {
        console.error("❌ 診断中にエラーが発生しました:", err);
    }
    console.log("============================");
};
