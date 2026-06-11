// offscreen.js v7.4
// PRIMERA ACCIÓN: marcar alive en storage para diagnóstico
// (debe ejecutarse antes de cualquier otra cosa)

try {
    chrome.storage.local.set({
        offscreenAlive: { ts: Date.now(), stage: 'offscreen_js_top' }
    });
    chrome.storage.local.get(['debugLogs'], (res) => {
        const logs = (res && res.debugLogs) ? res.debugLogs : [];
        logs.push({ ts: new Date().toISOString(), message: '[offscreen] *** PRIMERA LÍNEA ejecutada ***' });
        if (logs.length > 500) logs.splice(0, logs.length - 500);
        chrome.storage.local.set({ debugLogs: logs });
    });
    console.log('[QA offscreen] PRIMERA LÍNEA ejecutada');
} catch (e) {
    console.error('[QA offscreen] PRIMERA LÍNEA falló', e);
}

const DEFAULT_QUALITY = 0.75;
const processedRequests = new Set();

function offLog(msg) {
    console.log('[QA offscreen]', msg);
    try {
        chrome.storage.local.get(['debugLogs'], (res) => {
            const logs = (res && res.debugLogs) ? res.debugLogs : [];
            logs.push({ ts: new Date().toISOString(), message: '[offscreen] ' + msg });
            if (logs.length > 500) logs.splice(0, logs.length - 500);
            chrome.storage.local.set({ debugLogs: logs });
        });
    } catch (e) { console.error('offLog fail', e); }
}

offLog('=== offscreen.js v7.4 cargando ===');

// Marcar alive con stage más avanzado
chrome.storage.local.set({
    offscreenAlive: { ts: Date.now(), stage: 'offscreen_js_ready' }
}, () => {
    if (chrome.runtime.lastError) {
        offLog('NO pude marcar alive (offscreen_js_ready): ' + chrome.runtime.lastError.message);
    } else {
        offLog('marcado offscreenAlive=offscreen_js_ready');
    }
});

// Escuchar peticiones de captura vía storage (no sendMessage)
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    // Buscar cualquier captureRequest_* nuevo
    for (const key of Object.keys(changes)) {
        if (!key.startsWith('captureRequest_')) continue;
        const newValue = changes[key].newValue;
        if (!newValue) continue;  // fue removido, ignorar

        const requestId = key.replace('captureRequest_', '');
        if (processedRequests.has(requestId)) {
            offLog('requestId ya procesado, ignorando: ' + requestId);
            continue;
        }
        processedRequests.add(requestId);

        offLog('captura solicitada vía storage reqId=' + requestId);

        // Limpiar la request key inmediatamente para no procesarla 2 veces
        chrome.storage.local.remove([key]);

        // Disparar captura asíncrona
        captureAndSaveAsync(newValue.context || {}, requestId);
    }
});

async function captureAndSaveAsync(context, requestId) {
    offLog('--- captura START step=' + context.step + ' reqId=' + requestId);

    let stream = null;
    let video = null;

    const finishWith = (result) => {
        offLog('finishWith ok=' + result.ok + ' (reqId=' + requestId + ')');
        try {
            chrome.storage.local.set({
                ['captureResult_' + requestId]: result,
                lastCaptureResult: { requestId, ...result }
            }, () => {
                if (chrome.runtime.lastError) {
                    offLog('storage.set result error: ' + chrome.runtime.lastError.message);
                } else {
                    offLog('resultado guardado en storage');
                }
            });
        } catch (e) { offLog('finishWith fail: ' + e.message); }
    };

    const cleanup = () => {
        try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch(_){}
        try { if (video) video.pause(); } catch(_){}
        try { if (video && video.parentNode) video.parentNode.removeChild(video); } catch(_){}
        offLog('cleanup ejecutado');
    };

    try {
        // === PASO 1: getDisplayMedia ===
        offLog('PASO 1: llamando getDisplayMedia...');
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 30 } },
                audio: false
            });
            offLog('PASO 1 OK: stream obtenido, tracks=' + stream.getTracks().length);
        } catch (err) {
            offLog('PASO 1 FALLÓ: ' + err.name + ': ' + err.message);
            finishWith({ ok: false, error: 'getDisplayMedia: ' + err.message });
            return;
        }

        // === PASO 2: video element + play ===
        offLog('PASO 2: creando <video>...');
        video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        document.body.appendChild(video);

        try {
            await video.play();
            offLog('PASO 2 OK: video.play() resuelto');
        } catch (err) {
            offLog('PASO 2 warning video.play: ' + err.message);
        }

        // === PASO 3: esperar dimensiones ===
        offLog('PASO 3: esperando dimensiones del video...');
        let waited = 0;
        while ((video.videoWidth === 0 || video.videoHeight === 0) && waited < 3000) {
            await new Promise(r => setTimeout(r, 100));
            waited += 100;
        }
        offLog(`PASO 3 resultado: ${video.videoWidth}x${video.videoHeight} (waited ${waited}ms)`);

        if (video.videoWidth === 0 || video.videoHeight === 0) {
            cleanup();
            finishWith({ ok: false, error: 'Video sin dimensiones después de 3s' });
            return;
        }

        // === PASO 4: pintar frame ===
        offLog('PASO 4: requestAnimationFrame + drawImage...');
        await new Promise(r => requestAnimationFrame(() => r(null)));

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            offLog('PASO 4 OK: frame dibujado');
        } catch (err) {
            offLog('PASO 4 FALLÓ drawImage: ' + err.message);
            cleanup();
            finishWith({ ok: false, error: 'drawImage: ' + err.message });
            return;
        }

        // === PASO 5: toDataURL ===
        offLog('PASO 5: convirtiendo a JPEG...');
        const quality = context.jpegQuality || DEFAULT_QUALITY;
        let dataUrl;
        try {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
        } catch (err) {
            offLog('PASO 5 FALLÓ toDataURL: ' + err.message);
            cleanup();
            finishWith({ ok: false, error: 'toDataURL: ' + err.message });
            return;
        }
        const sizeKB = Math.round(dataUrl.length / 1024);
        offLog('PASO 5 OK: JPEG ' + sizeKB + ' KB (q=' + quality + ')');

        // === PASO 6: cleanup INMEDIATO ===
        offLog('PASO 6: cleanup del stream...');
        cleanup();

        // === PASO 7: guardar en IndexedDB ===
        offLog('PASO 7: guardando en IndexedDB...');

        // Esperar hasta 2s a que db.js termine de cargar y qaAddEvidence esté disponible
        let dbWait = 0;
        while (typeof qaAddEvidence !== 'function' && dbWait < 2000) {
            await new Promise(r => setTimeout(r, 50));
            dbWait += 50;
        }
        if (typeof qaAddEvidence !== 'function') {
            offLog('PASO 7 FALLÓ: qaAddEvidence no disponible (db.js no cargó)');
            finishWith({ ok: false, error: 'db.js no se cargó' });
            return;
        }
        if (dbWait > 0) offLog('PASO 7: esperé ' + dbWait + 'ms a que cargue db.js');

        const evidence = {
            sessionId: context.sessionId,
            step: context.step,
            stepText: context.stepText,
            screenshot: dataUrl,
            url: context.url || '',
            timestamp: new Date().toLocaleTimeString('es-CO'),
            fullDate: new Date().toLocaleString('es-CO'),
            capturedAt: new Date().toISOString(),
            sizeKB: sizeKB
        };

        let id;
        try {
            id = await qaAddEvidence(evidence);
            offLog('PASO 7 OK: id=' + id);
        } catch (e) {
            offLog('PASO 7 FALLÓ qaAddEvidence: ' + e.message);
            finishWith({ ok: false, error: 'IndexedDB: ' + e.message });
            return;
        }

        offLog('=== CAPTURA EXITOSA reqId=' + requestId + ' ===');
        finishWith({
            ok: true,
            id,
            sizeKB,
            evidenceCount: (context.previousCount || 0) + 1
        });

    } catch (err) {
        offLog('EXCEPCIÓN no manejada: ' + (err.message || err));
        cleanup();
        finishWith({ ok: false, error: err.message || String(err) });
    }
}

offLog('=== offscreen.js v7.4 listo ===');