// db.js - IndexedDB wrapper para evidencias QA
// Solución al problema de límite de chrome.storage.local (10MB)
// IndexedDB con unlimitedStorage permite cientos de MB sin problema.

const QA_DB_NAME = 'qa_evidence_db';
const QA_DB_VERSION = 1;
const QA_STORE = 'evidence';

function qaOpenDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(QA_DB_NAME, QA_DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(QA_STORE)) {
                const store = db.createObjectStore(QA_STORE, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                store.createIndex('sessionId', 'sessionId', { unique: false });
                store.createIndex('step', 'step', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function qaAddEvidence(evidence) {
    const db = await qaOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QA_STORE, 'readwrite');
        const store = tx.objectStore(QA_STORE);
        const req = store.add(evidence);
        req.onsuccess = () => {
            db.close();
            resolve(req.result); // id
        };
        req.onerror = () => {
            db.close();
            reject(req.error);
        };
    });
}

async function qaGetAllEvidence(sessionId) {
    const db = await qaOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QA_STORE, 'readonly');
        const store = tx.objectStore(QA_STORE);
        const results = [];
        const req = store.openCursor();
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                const v = cursor.value;
                if (!sessionId || v.sessionId === sessionId) {
                    results.push(v);
                }
                cursor.continue();
            } else {
                db.close();
                // ordenar por step y luego por captureIndex (para múltiples evidencias por paso)
                results.sort((a, b) => {
                    const stepDiff = (a.step || 0) - (b.step || 0);
                    if (stepDiff !== 0) return stepDiff;
                    return (a.captureIndex || 1) - (b.captureIndex || 1);
                });
                resolve(results);
            }
        };
        req.onerror = () => {
            db.close();
            reject(req.error);
        };
    });
}

async function qaClearSession(sessionId) {
    const db = await qaOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QA_STORE, 'readwrite');
        const store = tx.objectStore(QA_STORE);
        const req = store.openCursor();
        let count = 0;
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                if (!sessionId || cursor.value.sessionId === sessionId) {
                    cursor.delete();
                    count++;
                }
                cursor.continue();
            } else {
                db.close();
                resolve(count);
            }
        };
        req.onerror = () => {
            db.close();
            reject(req.error);
        };
    });
}

async function qaClearAll() {
    const db = await qaOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QA_STORE, 'readwrite');
        const store = tx.objectStore(QA_STORE);
        const req = store.clear();
        req.onsuccess = () => { db.close(); resolve(); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function qaCountEvidence(sessionId) {
    const all = await qaGetAllEvidence(sessionId);
    return all.length;
}

async function qaDeleteEvidenceById(id) {
    const db = await qaOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QA_STORE, 'readwrite');
        const store = tx.objectStore(QA_STORE);
        const req = store.delete(id);
        req.onsuccess = () => { db.close(); resolve(); };
        req.onerror  = () => { db.close(); reject(req.error); };
    });
}

async function qaGetEvidenceForStep(sessionId, step) {
    const all = await qaGetAllEvidence(sessionId);
    return all.filter(ev => ev.step === step);
}

async function qaGetEvidenceById(id) {
    const db = await qaOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QA_STORE, 'readonly');
        const store = tx.objectStore(QA_STORE);
        const req = store.get(id);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror  = () => { db.close(); reject(req.error); };
    });
}

async function qaUpdateEvidence(id, patch) {
    const db = await qaOpenDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QA_STORE, 'readwrite');
        const store = tx.objectStore(QA_STORE);
        const req = store.get(id);
        req.onsuccess = () => {
            const record = req.result;
            if (!record) { db.close(); reject(new Error('Evidence not found: ' + id)); return; }
            Object.assign(record, patch);
            const upd = store.put(record);
            upd.onsuccess = () => { db.close(); resolve(); };
            upd.onerror  = () => { db.close(); reject(upd.error); };
        };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function qaGetStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const est = await navigator.storage.estimate();
            return {
                usage: est.usage || 0,
                quota: est.quota || 0,
                percent: est.quota ? ((est.usage / est.quota) * 100).toFixed(2) : '0'
            };
        } catch (e) {
            return null;
        }
    }
    return null;
}
