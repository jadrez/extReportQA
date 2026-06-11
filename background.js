// Background Service Worker v7.4
// - Captura vía getDisplayMedia (API oficial Web) en offscreen document
// - Background solo crea offscreen y reenvía mensajes (rol mínimo)
// - YA NO usa chrome.desktopCapture (incompatible con offscreen, ver doc Chrome)

let popupWindowId = null;
let creatingOffscreen = null; // promesa anti-race
let captureInProgress = false; // lock para evitar capturas simultáneas
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

function bgLog(message) {
    try {
        const entry = { ts: new Date().toISOString(), message: '[bg] ' + message };
        chrome.storage.local.get(['debugLogs'], (res) => {
            const logs = (res && res.debugLogs) ? res.debugLogs : [];
            logs.push(entry);
            if (logs.length > 500) logs.splice(0, logs.length - 500);
            chrome.storage.local.set({ debugLogs: logs });
        });
    } catch (e) { /* noop */ }
}

// ====== OFFSCREEN MANAGEMENT ======
async function hasOffscreenDocument() {
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [OFFSCREEN_URL]
        });
        return contexts.length > 0;
    }
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
        return await chrome.offscreen.hasDocument();
    }
    return false;
}

async function ensureOffscreenDocument() {
    const exists = await hasOffscreenDocument();
    bgLog('hasOffscreenDocument=' + exists);

    if (exists) {
        bgLog('offscreen ya existe, no se recrea');
        return;
    }

    // Limpiar marcador alive antes de crear
    try { await chrome.storage.local.remove(['offscreenAlive']); } catch(_){}

    if (creatingOffscreen) {
        bgLog('esperando creación en curso');
        await creatingOffscreen;
        return;
    }

    creatingOffscreen = (async () => {
        let createError = null;
        try {
            bgLog('intentando createDocument con USER_MEDIA+DISPLAY_MEDIA...');
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
                justification: 'Capturar screenshot de pantalla para evidencia QA'
            });
            bgLog('createDocument exitoso (USER_MEDIA+DISPLAY_MEDIA)');
            return;
        } catch (err) {
            createError = err;
            bgLog('createDocument primer intento error: ' + err.message);
        }

        try {
            bgLog('intentando fallback con solo DISPLAY_MEDIA...');
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['DISPLAY_MEDIA'],
                justification: 'Capturar screenshot de pantalla'
            });
            bgLog('createDocument exitoso (DISPLAY_MEDIA)');
            return;
        } catch (err) {
            bgLog('createDocument fallback DISPLAY_MEDIA error: ' + err.message);
        }

        try {
            bgLog('intentando fallback con solo USER_MEDIA...');
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['USER_MEDIA'],
                justification: 'Capturar pantalla'
            });
            bgLog('createDocument exitoso (USER_MEDIA)');
            return;
        } catch (err) {
            bgLog('createDocument USER_MEDIA también falló: ' + err.message);
            throw createError || err;
        }
    })();

    try {
        await creatingOffscreen;
        bgLog('offscreen document creado, esperando que cargue HTML/JS...');
    } finally {
        creatingOffscreen = null;
    }

    // Esperar a que el HTML escriba offscreenAlive (hasta 5 segundos)
    const start = Date.now();
    while ((Date.now() - start) < 5000) {
        const alive = await new Promise((resolve) => {
            chrome.storage.local.get(['offscreenAlive'], (data) => {
                resolve(data && data.offscreenAlive ? data.offscreenAlive : null);
            });
        });
        if (alive) {
            bgLog('offscreen confirmó alive stage=' + (alive.stage || '?') + ' tras ' + (Date.now()-start) + 'ms');
            return;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    bgLog('TIMEOUT 5s esperando alive del offscreen');
}

async function closeOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        try {
            await chrome.offscreen.closeDocument();
            bgLog('offscreen document cerrado');
        } catch (e) {
            bgLog('closeDocument error: ' + e.message);
        }
    }
}

// ====== MESSAGE ROUTER ======
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Ignorar mensajes destinados al offscreen
    if (request.target === 'offscreen') return false;

    if (request.action === 'openPopupWindow') {
        openOrUpdatePopupWindow(request.data);
        sendResponse({ status: 'opened' });
        return false;
    }

    if (request.action === 'closePopupWindow') {
        closePopupWindow();
        sendResponse({ status: 'closed' });
        return false;
    }

    if (request.action === 'updatePopupWindow') {
        chrome.storage.local.set({ popupData: request.data }, () => {
            sendResponse({ status: 'updated' });
        });
        return true;
    }

    if (request.action === 'resizePopupWindow') {
        if (popupWindowId) {
            const upd = {};
            if (request.state)  upd.state  = request.state;
            if (request.height) upd.height = request.height;
            if (request.width)  upd.width  = request.width;
            if (request.left !== undefined) upd.left = request.left;
            if (request.top  !== undefined) upd.top  = request.top;
            chrome.windows.update(popupWindowId, upd);
        }
        sendResponse({ status: 'ok' });
        return false;
    }

    if (request.action === 'capture_screen') {
        // Flujo simplificado v7.4: el offscreen hace getDisplayMedia directamente.
        // El background solo asegura que el offscreen exista y reenvía el mensaje.
        handleCapture(request.context || {})
            .then((result) => sendResponse(result))
            .catch((err) => {
                bgLog('handleCapture error: ' + err.message);
                sendResponse({ ok: false, error: err.message });
            });
        return true; // async
    }
});

// ====== CAPTURE ORCHESTRATION ======
async function handleCapture(context) {
    // Lock: solo una captura a la vez
    if (captureInProgress) {
        bgLog('captura en progreso, rechazando duplicada');
        return { ok: false, error: 'Ya hay una captura en curso' };
    }
    captureInProgress = true;

    try {
        return await doCapture(context);
    } finally {
        captureInProgress = false;
    }
}

async function doCapture(context) {
    bgLog('doCapture v7.4 start step=' + context.step);

    // Verificar que la popup-window realmente existe; si no, recrearla
    let windowExists = false;
    if (popupWindowId !== null) {
        windowExists = await new Promise((resolve) => {
            chrome.windows.get(popupWindowId, (win) => {
                if (chrome.runtime.lastError || !win) resolve(false);
                else resolve(true);
            });
        });
    }

    if (!windowExists) {
        bgLog('popup-window no existe, buscando existente...');
        popupWindowId = null;

        // Antes de crear, buscar si ya hay una abierta (evita duplicados por reinicio del SW)
        const foundId = await findExistingPopupWindowId();
        if (foundId !== null) {
            popupWindowId = foundId;
            bgLog('popup-window encontrada (recovery) id=' + popupWindowId);
            windowExists = true;
        } else {
            await new Promise((resolve) => {
                chrome.windows.create({
                    url: chrome.runtime.getURL('popup-window.html'),
                    type: 'popup',
                    width: 620,
                    height: 600,
                    left: 80,
                    top: 80,
                    focused: false   // NO robar foco — evita cierres en cascada
                }, (win) => {
                    if (win) {
                        popupWindowId = win.id;
                        bgLog('popup-window recreada id=' + popupWindowId);
                    }
                    resolve();
                });
            });

            // Esperar a que cargue y se registre el listener de storage
            bgLog('esperando 1.5s a que popup-window cargue...');
            await new Promise(r => setTimeout(r, 1500));

            if (popupWindowId === null) {
                return { ok: false, error: 'No se pudo crear popup-window' };
            }
        }
    }

    // 1. Guardar posición original
    let originalBounds = null;
    try {
        originalBounds = await new Promise((resolve) => {
            chrome.windows.get(popupWindowId, (win) => {
                if (chrome.runtime.lastError || !win) resolve(null);
                else resolve({ left: win.left, top: win.top, width: win.width, height: win.height });
            });
        });
        bgLog('bounds originales: ' + JSON.stringify(originalBounds));
    } catch(e) { /* fallback */ }

    if (!originalBounds || originalBounds.left < 0 || originalBounds.top < 0) {
        originalBounds = { left: 80, top: 80, width: 620, height: 600 };
        bgLog('usando bounds default: ' + JSON.stringify(originalBounds));
    }

    // 2. Marcar flag para que onRemoved ignore cierres durante la captura
    captureInProgress = true; // ya estaba true, pero re-asegurar

    // 3. Mover popup-window fuera de pantalla
    try {
        await new Promise((resolve) => {
            chrome.windows.update(popupWindowId, { left: -3000, top: -3000 }, () => resolve());
        });
        bgLog('popup-window movida fuera de pantalla');
    } catch(e) {
        bgLog('error moviendo popup-window: ' + e.message);
    }

    // 3. Enriquecer context con URL real
    if (!context.url) {
        try {
            const realUrl = await getActiveRealTabUrl();
            if (realUrl) context.url = realUrl;
        } catch (e) { /* fallback */ }
    }

    // 4. Pedir a popup-window que haga la captura (vía storage para evitar sendMessage issues)
    const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const requestKey = 'captureRequest_' + requestId;
    const resultKey  = 'captureResult_' + requestId;
    try { await chrome.storage.local.remove([requestKey, resultKey]); } catch(_){}

    bgLog('escribiendo captureRequest reqId=' + requestId);
    await new Promise((resolve) => {
        chrome.storage.local.set({ [requestKey]: { context, ts: Date.now() } }, () => resolve());
    });

    // 5. Esperar resultado (máx 120s)
    const maxWait = 120000;
    const start = Date.now();
    let result = null;
    let lastLog = 0;
    while ((Date.now() - start) < maxWait) {
        await new Promise(r => setTimeout(r, 200));
        const got = await new Promise((resolve) => {
            chrome.storage.local.get([resultKey], (data) => {
                resolve(data && data[resultKey] ? data[resultKey] : null);
            });
        });
        if (got) {
            result = got;
            try { await chrome.storage.local.remove([resultKey]); } catch(_){}
            break;
        }
        const elapsed = Date.now() - start;
        if (elapsed - lastLog > 15000) {
            lastLog = elapsed;
            bgLog('esperando captura... ' + Math.round(elapsed/1000) + 's');
        }
    }

    // 6. Restaurar/recrear popup-window en posición original
    const windowStillExists = popupWindowId !== null && await new Promise((resolve) => {
        chrome.windows.get(popupWindowId, (win) => {
            if (chrome.runtime.lastError || !win) resolve(false);
            else resolve(true);
        });
    });

    if (windowStillExists) {
        // Mover de vuelta y traer al frente
        try {
            await new Promise((resolve) => {
                chrome.windows.update(popupWindowId, {
                    left: originalBounds.left,
                    top: originalBounds.top,
                    state: 'normal',
                    focused: true
                }, () => resolve());
            });
            bgLog('popup-window restaurada a posición original');
        } catch(e) {
            bgLog('error restaurando: ' + e.message);
        }
    } else {
        // La ventana se cerró durante la captura — recrearla en la posición original
        bgLog('ventana se cerró durante captura, recreando en posición original...');
        popupWindowId = null;
        await new Promise((resolve) => {
            chrome.windows.create({
                url: chrome.runtime.getURL('popup-window.html'),
                type: 'popup',
                width: originalBounds.width || 620,
                height: originalBounds.height || 600,
                left: originalBounds.left,
                top: originalBounds.top,
                focused: true
            }, (win) => {
                if (win) {
                    popupWindowId = win.id;
                    bgLog('popup-window recreada post-captura id=' + popupWindowId);
                }
                resolve();
            });
        });
    }

    if (!result) {
        bgLog('TIMEOUT esperando resultado');
        return { ok: false, error: 'Timeout (120s) esperando captura' };
    }

    bgLog('handleCapture termina ok=' + result.ok + ' size=' + (result.sizeKB || 'N/A'));
    return result;
}

async function getActiveRealTabUrl() {
    return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
            const real = tabs.find(t =>
                t.url &&
                !t.url.includes('popup-window.html') &&
                !t.url.includes('offscreen.html') &&
                !t.url.startsWith('chrome://') &&
                !t.url.startsWith('chrome-extension://')
            );
            resolve(real ? real.url : null);
        });
    });
}

// ====== POPUP WINDOW ======

// Busca una ventana popup-window.html ya abierta (útil cuando el service worker reinicia y pierde popupWindowId)
async function findExistingPopupWindowId() {
    const popupUrl = chrome.runtime.getURL('popup-window.html');
    return new Promise((resolve) => {
        chrome.windows.getAll({ populate: true }, (windows) => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            for (const win of windows) {
                if (win.tabs && win.tabs.some(tab => tab.url && tab.url.startsWith(popupUrl.split('?')[0]))) {
                    resolve(win.id);
                    return;
                }
            }
            resolve(null);
        });
    });
}

async function openOrUpdatePopupWindow(data) {
    chrome.storage.local.set({ popupData: data });

    // Verificar si la ventana conocida sigue abierta
    if (popupWindowId !== null) {
        const exists = await new Promise((resolve) => {
            chrome.windows.get(popupWindowId, (win) => {
                resolve(!chrome.runtime.lastError && !!win);
            });
        });
        if (exists) return; // Ya existe, el cambio de storage la actualizará
        popupWindowId = null;
    }

    // El service worker puede haber reiniciado y perdido popupWindowId: buscar por URL
    const existingId = await findExistingPopupWindowId();
    if (existingId !== null) {
        popupWindowId = existingId;
        bgLog('popup-window recuperada (service worker reinició) id=' + popupWindowId);
        // Re-escribir popupData en storage para que popup-window.js re-sincronice su estado
        chrome.storage.local.get(['popupData'], (res) => {
            if (res.popupData) {
                chrome.storage.local.set({ popupData: res.popupData });
            }
        });
        return;
    }

    createPopupWindow();
}

function createPopupWindow() {
    chrome.windows.create({
        url: chrome.runtime.getURL('popup-window.html'),
        type: 'popup',
        width: 340,
        height: 360,
        left: 80,
        top: 80,
        focused: false
    }, (win) => {
        if (chrome.runtime.lastError) {
            bgLog('windows.create error: ' + chrome.runtime.lastError.message);
            return;
        }
        popupWindowId = win.id;
        bgLog('popup-window creada id=' + popupWindowId);
    });
}

function closePopupWindow() {
    if (popupWindowId !== null) {
        chrome.windows.remove(popupWindowId, () => {
            popupWindowId = null;
        });
    }
}

chrome.windows.onRemoved.addListener((removedId) => {
    if (removedId === popupWindowId) {
        if (captureInProgress) {
            bgLog('popup-window se cerró durante captura — se recreará al finalizar');
            // No reseteamos popupWindowId todavía; doCapture detectará y manejará
            popupWindowId = null;
        } else {
            bgLog('popup-window cerrada por usuario');
            popupWindowId = null;
        }
    }
});

console.log('✅ Background v7.4 cargado (getDisplayMedia en offscreen)');