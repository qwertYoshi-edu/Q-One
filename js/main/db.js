export const DB_NAME = 'QOneDB';
export const DB_VERSION = 1;

let dbInstance = null;

export function initDB() {
    return new Promise((resolve, reject) => {
        if (dbInstance) return resolve(dbInstance);

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('packs')) {
                db.createObjectStore('packs', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('test_sessions')) {
                db.createObjectStore('test_sessions', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('answer_logs')) {
                db.createObjectStore('answer_logs', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('user_settings')) {
                db.createObjectStore('user_settings', { keyPath: 'key' });
            }
        };

        request.onsuccess = (e) => {
            dbInstance = e.target.result;
            resolve(dbInstance);
        };

        request.onerror = (e) => {
            console.error('IndexedDBの初期化エラー:', e.target.error);
            reject(e.target.error);
        };
    });
}

function getStore(storeName, mode = 'readonly') {
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

// ※ delete は予約語のため remove とする
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