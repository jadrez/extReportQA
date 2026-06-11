// Popup Window v7.4 - Captura directa con getDisplayMedia
// Cuando el background pide capturar:
//   1) Background mueve esta ventana fuera de pantalla
//   2) Esta ventana recibe captureRequest_* vía storage
//   3) Llama getDisplayMedia -> JPEG -> IndexedDB
//   4) Escribe captureResult_* en storage
//   5) Background restaura la ventana

const DEFAULT_QUALITY = 0.75;
const processedRequests = new Set();

let currentData = null;
let testState = null;
let stepCaptureCount = 0; // capturas realizadas en el paso actual
let isCapturing = false;  // bloqueo durante captura en curso

const $ = (id) => document.getElementById(id);

function showStatus(msg, type) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status show ' + (type || '');
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => { el.className = 'status'; }, 3500);
}

function wLog(msg) {
    console.log('[QA window]', msg);
    try {
        chrome.storage.local.get(['debugLogs'], (res) => {
            const logs = (res && res.debugLogs) ? res.debugLogs : [];
            logs.push({ ts: new Date().toISOString(), message: '[window] ' + msg });
            if (logs.length > 500) logs.splice(0, logs.length - 500);
            chrome.storage.local.set({ debugLogs: logs });
        });
    } catch (e) { /* noop */ }
}

// ===== RELOJ EN TIEMPO REAL =====
function updateClock() {
    const now = new Date();
    const dateEl = $('infoDate');
    const clockEl = $('infoClock');
    if (dateEl) dateEl.textContent = now.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (clockEl) clockEl.textContent = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function updateInfoBar() {
    if (!testState) return;
    const version  = testState.version  || '';
    const navegador = testState.navegador || '';

    const vWrap = $('infoVersionWrap');
    const vSep  = $('sepVersion');
    const vEl   = $('infoVersion');
    if (version && vWrap && vSep && vEl) {
        vEl.textContent = version;
        vWrap.style.display = 'flex';
        vSep.style.display  = 'inline';
    }

    const nWrap = $('infoNavegadorWrap');
    const nSep  = $('sepNavegador');
    const nEl   = $('infoNavegador');
    if (navegador && nWrap && nSep && nEl) {
        nEl.textContent = navegador;
        nWrap.style.display = 'flex';
        nSep.style.display  = 'inline';
    }
}

// Iniciar reloj — actualiza cada segundo
updateClock();
setInterval(updateClock, 1000);

function updateUI() {
    if (!currentData) {
        $('stepNumber').textContent = '—';
        $('stepText').textContent = 'Sin datos';
        return;
    }
    $('stepNumber').textContent = `Paso ${currentData.step} de ${currentData.total}`;
    $('stepText').textContent = currentData.stepText || '';

    const captureBtn = $('captureBtn');
    captureBtn.disabled = isCapturing;
    captureBtn.classList.toggle('is-capturing', isCapturing);
    captureBtn.classList.toggle('has-captures', stepCaptureCount > 0 && !isCapturing);

    if (isCapturing) {
        captureBtn.textContent = '⏳ Capturando…';
    } else if (stepCaptureCount === 0) {
        captureBtn.textContent = '📸 Capturar';
    } else {
        captureBtn.textContent = `📸 Agregar evidencia (${stepCaptureCount})`;
    }

    const countBar = $('captureCountBar');
    if (stepCaptureCount > 0) {
        const plural = stepCaptureCount === 1 ? 'evidencia capturada' : 'evidencias capturadas';
        countBar.textContent = `✓ ${stepCaptureCount} ${plural} en este paso`;
        countBar.style.display = 'block';
    } else {
        countBar.style.display = 'none';
    }

    const nextBtn = $('nextBtn');
    nextBtn.disabled = currentData.step >= currentData.total;

    const prevBtn = $('prevBtn');
    if (prevBtn) prevBtn.disabled = currentData.step <= 1;

    // Mostrar botón eliminar evidencia solo si hay capturas en este paso
    const delEvBtn = $('wDeleteEvidenceBtn');
    if (delEvBtn) delEvBtn.style.display = stepCaptureCount > 0 ? 'block' : 'none';

    // Cargar nota del paso actual
    const noteEl = $('wStepNoteInput');
    if (noteEl && testState) {
        const idx = currentData.step - 1;
        noteEl.value = (testState.stepNotes && testState.stepNotes[idx]) || '';
    }
}

// ===== INIT =====
wLog('popup-window v7.4 cargando');
chrome.storage.local.get(['popupData', 'testState'], async (result) => {
    if (result.popupData) currentData = result.popupData;
    if (result.testState) testState = result.testState;
    updateInfoBar();
    // Sincronizar estado de captura del paso actual al iniciar
    if (currentData && testState) {
        await syncWindowCaptureState(currentData.step - 1);
    }
    updateUI();
    wLog('popup-window listo, escuchando captureRequest_*');
});

// Escuchar cambios en storage: popupData/testState para UI y captureRequest_* para captura
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.popupData) {
        const prevStep = currentData ? currentData.step : null;
        currentData = changes.popupData.newValue;
        if (currentData && testState && currentData.step !== prevStep) {
            // El paso cambió desde afuera (popup principal): sincronizar evidencias
            syncWindowCaptureState(currentData.step - 1).then(() => updateUI());
        } else {
            updateUI();
        }
    }
    if (changes.testState) {
        const prev = testState;
        testState = changes.testState.newValue;
        updateInfoBar();
        // Si capturedThisStep cambió y stepCaptureCount está desincronizado, re-sincronizar
        if (currentData && testState && testState.sessionId) {
            const prevCaptured = prev ? prev.capturedThisStep : false;
            const nowCaptured  = testState.capturedThisStep;
            if (nowCaptured !== prevCaptured || (nowCaptured && stepCaptureCount === 0)) {
                syncWindowCaptureState(currentData.step - 1).then(() => updateUI());
            }
        }
    }

    // Detectar peticiones de captura
    for (const key of Object.keys(changes)) {
        if (!key.startsWith('captureRequest_')) continue;
        const newValue = changes[key].newValue;
        if (!newValue) continue;

        const requestId = key.replace('captureRequest_', '');
        if (processedRequests.has(requestId)) continue;
        processedRequests.add(requestId);

        wLog('captureRequest detectado reqId=' + requestId);
        chrome.storage.local.remove([key]);
        handleCaptureRequest(newValue.context || {}, requestId);
    }
});

// ===== BOTONES =====
$('captureBtn').addEventListener('click', startCapture);
$('nextBtn').addEventListener('click', nextStep);
$('prevBtn').addEventListener('click', previousStep);

function startCapture() {
    if (!currentData) return;
    if (isCapturing) return;
    if (!testState) {
        showStatus('Estado no disponible', 'error');
        return;
    }

    isCapturing = true;
    updateUI();
    wLog('startCapture clic #' + (stepCaptureCount + 1) + ', pidiendo al bg que mueva la ventana');
    showStatus('Preparando captura…', '');

    const context = {
        sessionId: testState.sessionId,
        step: currentData.step,
        stepText: currentData.stepText,
        jpegQuality: testState.jpegQuality || DEFAULT_QUALITY,
        url: testState.url,
        previousCount: testState.evidenceCount || 0,
        captureIndex: stepCaptureCount + 1,
        version: testState.version || '',
        navegador: testState.navegador || ''
    };

    chrome.runtime.sendMessage({ action: 'capture_screen', context }, (response) => {
        isCapturing = false;

        if (chrome.runtime.lastError) {
            wLog('sendMessage error: ' + chrome.runtime.lastError.message);
            showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
            updateUI();
            return;
        }
        if (!response || !response.ok) {
            const err = (response && response.error) || 'Captura cancelada';
            wLog('captura fallida: ' + err);
            showStatus(err, 'error');
            updateUI();
            return;
        }

        // Captura exitosa: incrementar contador del paso
        stepCaptureCount++;
        chrome.storage.local.get(['testState'], (res) => {
            if (res.testState) testState = res.testState;
            if (currentData) currentData.isCaptured = true;
            chrome.storage.local.set({ popupData: currentData });
            updateUI();
            showStatus(`✓ Evidencia ${stepCaptureCount} guardada (${response.sizeKB} KB)`, 'success');
            chrome.runtime.sendMessage({ action: 'evidenceCapturedFromWindow' }, () => {});
            // Mostrar botón de anotación con el id de la evidencia recién guardada
            if (response.id) showAnnotateTrigger(response.id);
        });
    });
}

// ===== CAPTURA REAL (corre con la ventana fuera de pantalla) =====
async function handleCaptureRequest(context, requestId) {
    wLog('--- handleCaptureRequest START reqId=' + requestId);

    let stream = null;
    let video = null;

    const finishWith = (result) => {
        wLog('finishWith ok=' + result.ok + ' (reqId=' + requestId + ')');
        chrome.storage.local.set({
            ['captureResult_' + requestId]: result
        });
    };

    const cleanup = () => {
        try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch(_){}
        try { if (video) video.pause(); } catch(_){}
        try { if (video && video.parentNode) video.parentNode.removeChild(video); } catch(_){}
    };

    try {
        // PASO 1: getDisplayMedia
        wLog('PASO 1: getDisplayMedia...');
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 30 } },
                audio: false
            });
            wLog('PASO 1 OK, tracks=' + stream.getTracks().length);
        } catch (err) {
            wLog('PASO 1 FALLÓ: ' + err.name + ': ' + err.message);
            finishWith({ ok: false, error: 'getDisplayMedia: ' + err.message });
            return;
        }

        // PASO 2: video element
        video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.style.position = 'fixed';
        video.style.left = '-9999px';
        document.body.appendChild(video);

        try { await video.play(); } catch(_){}

        // PASO 3: esperar dimensiones
        let waited = 0;
        while ((video.videoWidth === 0 || video.videoHeight === 0) && waited < 3000) {
            await new Promise(r => setTimeout(r, 100));
            waited += 100;
        }
        wLog('PASO 3: ' + video.videoWidth + 'x' + video.videoHeight + ' (' + waited + 'ms)');

        if (video.videoWidth === 0 || video.videoHeight === 0) {
            cleanup();
            finishWith({ ok: false, error: 'Video sin dimensiones' });
            return;
        }

        // PASO 4: drawImage
        await new Promise(r => requestAnimationFrame(() => r(null)));
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        wLog('PASO 4 OK: frame dibujado');

        // PASO 4b: overlay de metadatos en esquina superior izquierda
        try {
            const now = new Date();
            const dateStr = now.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeStr = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

            const overlayLines = [`${dateStr}   ${timeStr}`];
            const tags = [context.version, context.navegador].filter(Boolean);
            if (tags.length > 0) overlayLines.push(tags.join('   ·   '));

            const fontSize = Math.max(22, Math.round(canvas.height * 0.028));
            const padding  = Math.round(fontSize * 0.75);
            const lineH    = Math.round(fontSize * 1.6);
            const boxX = 20;
            const boxY = 20;

            ctx.font = `700 ${fontSize}px 'Segoe UI', -apple-system, Arial, sans-serif`;
            ctx.textBaseline = 'top';

            let maxW = 0;
            for (const line of overlayLines) {
                const w = ctx.measureText(line).width;
                if (w > maxW) maxW = w;
            }

            const boxW = maxW + padding * 2;
            const boxH = overlayLines.length * lineH + padding;
            const r    = Math.round(fontSize * 0.35);

            // Fondo oscuro con esquinas redondeadas
            ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
            ctx.beginPath();
            ctx.moveTo(boxX + r, boxY);
            ctx.lineTo(boxX + boxW - r, boxY);
            ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
            ctx.lineTo(boxX + boxW, boxY + boxH - r);
            ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
            ctx.lineTo(boxX + r, boxY + boxH);
            ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
            ctx.lineTo(boxX, boxY + r);
            ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
            ctx.closePath();
            ctx.fill();

            // Línea de acento azul a la izquierda
            ctx.fillStyle = '#3b82f6';
            ctx.fillRect(boxX, boxY + r, 4, boxH - r * 2);

            // Texto blanco
            ctx.fillStyle = '#ffffff';
            overlayLines.forEach((line, i) => {
                ctx.fillText(line, boxX + padding, boxY + Math.round(padding * 0.5) + i * lineH);
            });

            wLog('PASO 4b OK: overlay grabado (' + overlayLines.join(' | ') + ')');
        } catch (oe) {
            wLog('PASO 4b overlay error (no crítico): ' + oe.message);
        }

        // PASO 5: JPEG
        const quality = context.jpegQuality || DEFAULT_QUALITY;
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const sizeKB = Math.round(dataUrl.length / 1024);
        wLog('PASO 5 OK: JPEG ' + sizeKB + ' KB');

        // PASO 6: cleanup
        cleanup();

        // PASO 7: IndexedDB
        if (typeof qaAddEvidence !== 'function') {
            wLog('PASO 7 FALLÓ: qaAddEvidence no disponible');
            finishWith({ ok: false, error: 'db.js no cargó' });
            return;
        }

        const evidence = {
            sessionId: context.sessionId,
            step: context.step,
            stepText: context.stepText,
            captureIndex: context.captureIndex || 1,
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
            wLog('PASO 7 OK: id=' + id);
        } catch (e) {
            wLog('PASO 7 FALLÓ: ' + e.message);
            finishWith({ ok: false, error: 'IndexedDB: ' + e.message });
            return;
        }

        // Actualizar testState (incrementar contador)
        chrome.storage.local.get(['testState'], (res) => {
            const ts = res.testState;
            if (ts) {
                ts.evidenceCount = (ts.evidenceCount || 0) + 1;
                ts.capturedThisStep = true;
                chrome.storage.local.set({ testState: ts });
            }
        });

        wLog('=== CAPTURA EXITOSA reqId=' + requestId + ' ===');
        finishWith({
            ok: true,
            id,
            sizeKB,
            evidenceCount: (context.previousCount || 0) + 1
        });

    } catch (err) {
        wLog('EXCEPCIÓN: ' + (err.message || err));
        cleanup();
        finishWith({ ok: false, error: err.message || String(err) });
    }
}

// ===== NOTAS POR PASO DESDE VENTANA FLOTANTE =====
$('wSaveNoteBtn').addEventListener('click', () => {
    if (!testState || !currentData) return;
    if (!testState.stepNotes) testState.stepNotes = {};
    const idx = currentData.step - 1;
    testState.stepNotes[idx] = $('wStepNoteInput').value.trim();
    chrome.storage.local.set({ testState }, () => {
        chrome.runtime.sendMessage({ action: 'stepsUpdatedFromWindow' }, () => {});
        showStatus('Nota guardada', 'success');
    });
});

$('wStepNoteInput').addEventListener('keydown', (e) => {
    e.stopPropagation(); // evitar que Space dispare captura
});

// ===== GESTIÓN DE PASOS DESDE VENTANA FLOTANTE =====
let wStepEditorMode = null; // 'edit' | 'add'

$('wEditStepBtn').addEventListener('click', () => {
    if (!testState || !currentData) return;
    wStepEditorMode = 'edit';
    $('wStepEditorInput').value = currentData.stepText || '';
    $('wStepEditorInput').placeholder = 'Editar paso actual…';
    $('wStepEditorPanel').style.display = 'block';
    $('wStepEditorInput').focus();
    $('wStepEditorInput').select();
});

$('wAddStepBtn').addEventListener('click', () => {
    if (!testState || !currentData) return;
    wStepEditorMode = 'add';
    $('wStepEditorInput').value = '';
    $('wStepEditorInput').placeholder = 'Texto del nuevo paso…';
    $('wStepEditorPanel').style.display = 'block';
    $('wStepEditorInput').focus();
});

$('wDeleteStepBtn').addEventListener('click', async () => {
    if (!testState || !currentData) return;
    if (testState.steps.length <= 1) {
        showStatus('No se puede eliminar el único paso', 'error');
        return;
    }
    const txt = currentData.stepText || '';
    if (!confirm(`¿Eliminar: "${txt.length > 50 ? txt.slice(0,50)+'…' : txt}"?\nSe eliminarán también las evidencias de este paso.`)) return;

    // Limpiar trigger de anotación del paso que se va a eliminar
    hideAnnotateTrigger();
    if (annotateState.open) closeAnnotatePanel();

    // Eliminar evidencias del paso antes de quitarlo del array
    const stepNum = currentData.step;
    const stepEvidence = await qaGetEvidenceForStep(testState.sessionId, stepNum);
    for (const ev of stepEvidence) await qaDeleteEvidenceById(ev.id);
    testState.evidenceCount = Math.max(0, (testState.evidenceCount || 0) - stepEvidence.length);

    testState.steps.splice(testState.currentStepIndex, 1);
    if (testState.currentStepIndex >= testState.steps.length) {
        testState.currentStepIndex = testState.steps.length - 1;
    }

    // Sincronizar estado de captura del nuevo paso actual
    await syncWindowCaptureState(testState.currentStepIndex);

    currentData = {
        sessionId: testState.sessionId,
        step: testState.currentStepIndex + 1,
        stepText: testState.steps[testState.currentStepIndex],
        total: testState.steps.length,
        isCaptured: testState.capturedThisStep,
        isActive: testState.isActive
    };
    chrome.storage.local.set({ testState, popupData: currentData }, () => {
        updateUI();
        chrome.runtime.sendMessage({ action: 'stepsUpdatedFromWindow' }, () => {});
        chrome.runtime.sendMessage({ action: 'evidenceCapturedFromWindow' }, () => {});
        showStatus(`Paso eliminado${stepEvidence.length > 0 ? ` (${stepEvidence.length} evidencia(s) borrada(s))` : ''}`, 'success');
    });
});

$('wConfirmStepEdit').addEventListener('click', () => {
    const text = $('wStepEditorInput').value.trim();
    if (!text) { showStatus('El texto no puede estar vacío', 'error'); return; }

    const mode = wStepEditorMode;
    $('wStepEditorPanel').style.display = 'none';
    wStepEditorMode = null;

    if (mode === 'edit') {
        testState.steps[testState.currentStepIndex] = text;
        currentData.stepText = text;
    } else if (mode === 'add') {
        testState.steps.splice(testState.currentStepIndex + 1, 0, text);
    }
    // Sincronizar total siempre (crítico cuando se añade al final)
    currentData.total = testState.steps.length;
    chrome.storage.local.set({ testState, popupData: currentData }, () => {
        updateUI();
        chrome.runtime.sendMessage({ action: 'stepsUpdatedFromWindow' }, () => {});
        showStatus(mode === 'edit' ? 'Paso actualizado' : 'Paso insertado después del actual', 'success');
    });
});

$('wCancelStepEdit').addEventListener('click', () => {
    $('wStepEditorPanel').style.display = 'none';
    wStepEditorMode = null;
});

$('wStepEditorInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  $('wConfirmStepEdit').click();
    if (e.key === 'Escape') $('wCancelStepEdit').click();
});

// Sincroniza stepCaptureCount y capturedThisStep consultando IndexedDB
async function syncWindowCaptureState(stepIndex) {
    if (!testState || !testState.sessionId) return 0;
    const evidences = await qaGetEvidenceForStep(testState.sessionId, stepIndex + 1);
    stepCaptureCount = evidences.length;
    testState.capturedThisStep = evidences.length > 0;
    return evidences.length;
}

async function nextStep() {
    if (!testState || !currentData) return;
    if (currentData.step >= currentData.total) return;

    hideAnnotateTrigger();
    if (annotateState.open) closeAnnotatePanel();

    testState.currentStepIndex++;
    await syncWindowCaptureState(testState.currentStepIndex);

    chrome.storage.local.set({ testState }, () => {
        currentData = {
            sessionId: testState.sessionId,
            step: testState.currentStepIndex + 1,
            stepText: testState.steps[testState.currentStepIndex],
            total: testState.steps.length,
            isCaptured: testState.capturedThisStep,
            isActive: testState.isActive
        };
        chrome.storage.local.set({ popupData: currentData }, () => {
            updateUI();
            chrome.runtime.sendMessage({ action: 'stepAdvancedFromWindow' }, () => {});
        });
    });
}

async function previousStep() {
    if (!testState || !currentData) return;
    if (currentData.step <= 1) return;

    hideAnnotateTrigger();
    if (annotateState.open) closeAnnotatePanel();

    testState.currentStepIndex--;
    await syncWindowCaptureState(testState.currentStepIndex);

    chrome.storage.local.set({ testState }, () => {
        currentData = {
            sessionId: testState.sessionId,
            step: testState.currentStepIndex + 1,
            stepText: testState.steps[testState.currentStepIndex],
            total: testState.steps.length,
            isCaptured: testState.capturedThisStep,
            isActive: testState.isActive
        };
        chrome.storage.local.set({ popupData: currentData }, () => {
            updateUI();
            chrome.runtime.sendMessage({ action: 'stepAdvancedFromWindow' }, () => {});
        });
    });
}

$('wDeleteEvidenceBtn').addEventListener('click', async () => {
    if (!testState || !currentData) return;
    if (!confirm('¿Eliminar todas las evidencias de este paso? Podrás volver a capturar.')) return;

    const step = currentData.step;
    const evidences = await qaGetEvidenceForStep(testState.sessionId, step);
    for (const ev of evidences) {
        await qaDeleteEvidenceById(ev.id);
    }

    testState.evidenceCount = Math.max(0, (testState.evidenceCount || 0) - evidences.length);
    testState.capturedThisStep = false;
    stepCaptureCount = 0;

    chrome.storage.local.set({ testState }, () => {
        updateUI();
        chrome.runtime.sendMessage({ action: 'evidenceCapturedFromWindow' }, () => {});
        showStatus(`🗑️ ${evidences.length} evidencia(s) eliminada(s). Puedes volver a capturar.`, 'success');
    });
});

document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && currentData && !isCapturing
        && document.activeElement.tagName !== 'INPUT'
        && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        startCapture();
    }
    if (e.key === 'Escape' && annotateState.open) closeAnnotatePanel();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && annotateState.open) {
        e.preventDefault();
        annUndo();
    }
});

// ===== ANOTACIONES =====
// Todas las coordenadas se trabajan en espacio del canvas (resolución original).
// annGetPos convierte mouse/touch → canvas coords directamente via getBoundingClientRect ratio.

const annotateState = {
    open: false,
    evidenceId: null,
    origImage: null,
    tool: 'rect',
    color: '#ef4444',
    lineWidth: 2,
    shapes: [],
    drawing: false,
    startX: 0,
    startY: 0
};

let lastCaptureId = null;

function showAnnotateTrigger(evidenceId) {
    lastCaptureId = evidenceId;
    const trigger = $('annotateTrigger');
    trigger.classList.add('show');
    trigger.onclick = () => openAnnotatePanel(evidenceId);
}

function hideAnnotateTrigger() {
    $('annotateTrigger').classList.remove('show');
    lastCaptureId = null;
}

async function openAnnotatePanel(evidenceId) {
    hideAnnotateTrigger();

    let ev;
    try { ev = await qaGetEvidenceById(evidenceId); } catch(e) {
        showStatus('Error cargando imagen: ' + e.message, 'error'); return;
    }
    if (!ev || !ev.screenshot) { showStatus('Imagen no encontrada', 'error'); return; }

    annotateState.evidenceId = evidenceId;
    annotateState.shapes     = [];
    annotateState.open       = true;

    // Mostrar panel y maximizar ventana para tener el mayor espacio posible
    $('annotatePanel').classList.add('show');
    chrome.runtime.sendMessage({ action: 'resizePopupWindow', state: 'maximized' });

    const img = new Image();
    img.onload = () => {
        annotateState.origImage = img;
        const canvas = $('annotateCanvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;

        // Esperar a que la ventana termine de maximizarse antes de medir el espacio real
        setTimeout(() => {
            const wrap     = canvas.parentElement;
            const displayW = wrap.clientWidth || (window.innerWidth - 24);
            // Reservar ~150px para toolbar + botones + info bar superior + padding
            const availH   = window.innerHeight - 150;
            const aspect   = img.naturalWidth / img.naturalHeight;
            let displayH   = Math.round(displayW / aspect);
            if (displayH > availH) displayH = availH;
            canvas.style.height = displayH + 'px';
            annRedraw();
        }, 350);
    };
    img.src = ev.screenshot;
}

function closeAnnotatePanel() {
    annotateState.open = false;
    $('annotatePanel').classList.remove('show');
    // Restaurar tamaño normal del popup
    chrome.runtime.sendMessage({ action: 'resizePopupWindow', state: 'normal', width: 620, height: 600 });
}

// Convierte evento de mouse/touch a coordenadas del canvas (resolución original)
function annGetPos(e) {
    const canvas  = $('annotateCanvas');
    const rect    = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : (e.clientX ?? 0);
    const clientY = e.touches ? e.touches[0].clientY : (e.clientY ?? 0);
    return {
        x: (clientX - rect.left) / rect.width  * canvas.width,
        y: (clientY - rect.top)  / rect.height * canvas.height
    };
}

function annRedraw() {
    const canvas = $('annotateCanvas');
    const ctx    = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (annotateState.origImage) ctx.drawImage(annotateState.origImage, 0, 0);
    for (const s of annotateState.shapes) annDrawShape(ctx, s);
}

// Dibuja una forma en coordenadas de canvas (sin escalar — ya están en resolución original)
function annDrawShape(ctx, s) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth   = s.lw;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    if (s.type === 'rect') {
        ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
    } else if (s.type === 'arrow') {
        const angle   = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const headLen = Math.max(20, s.lw * 5);
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2 - headLen * Math.cos(angle - Math.PI / 7), s.y2 - headLen * Math.sin(angle - Math.PI / 7));
        ctx.lineTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - headLen * Math.cos(angle + Math.PI / 7), s.y2 - headLen * Math.sin(angle + Math.PI / 7));
        ctx.stroke();
    }
}

function annUndo() {
    if (annotateState.shapes.length === 0) return;
    annotateState.shapes.pop();
    annRedraw();
}

// Canvas events
const annCanvas = $('annotateCanvas');
annCanvas.addEventListener('mousedown',  annStart);
annCanvas.addEventListener('mousemove',  annMove);
annCanvas.addEventListener('mouseup',    annEnd);
annCanvas.addEventListener('mouseleave', annEnd);
annCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); annStart(e); }, { passive: false });
annCanvas.addEventListener('touchmove',  (e) => { e.preventDefault(); annMove(e);  }, { passive: false });
annCanvas.addEventListener('touchend',   (e) => { e.preventDefault(); annEnd(e);   }, { passive: false });

function annStart(e) {
    if (!annotateState.open) return;
    const pos = annGetPos(e);
    annotateState.drawing = true;
    annotateState.startX  = pos.x;
    annotateState.startY  = pos.y;
}

function annMove(e) {
    if (!annotateState.drawing || !annotateState.open) return;
    const pos = annGetPos(e);
    annRedraw();
    // Preview de la forma mientras se arrastra
    const canvas = $('annotateCanvas');
    const rect   = canvas.getBoundingClientRect();
    const scaledLw = annotateState.lineWidth * (canvas.width / rect.width);
    annDrawShape(canvas.getContext('2d'), {
        type: annotateState.tool, color: annotateState.color, lw: scaledLw,
        x1: annotateState.startX, y1: annotateState.startY, x2: pos.x, y2: pos.y
    });
}

function annEnd(e) {
    if (!annotateState.drawing || !annotateState.open) return;
    annotateState.drawing = false;

    const canvas  = $('annotateCanvas');
    const rect    = canvas.getBoundingClientRect();
    const scaledLw = annotateState.lineWidth * (canvas.width / rect.width);
    const rawE = e.changedTouches ? { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY } : e;
    const pos = annGetPos(rawE);

    annotateState.shapes.push({
        type: annotateState.tool, color: annotateState.color, lw: scaledLw,
        x1: annotateState.startX, y1: annotateState.startY, x2: pos.x, y2: pos.y
    });
    annRedraw();
}

// Toolbar: herramientas
document.querySelectorAll('.ann-tool').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.ann-tool').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        annotateState.tool = btn.dataset.tool;
    });
});

// Toolbar: colores
document.querySelectorAll('.ann-color').forEach(dot => {
    dot.addEventListener('click', () => {
        document.querySelectorAll('.ann-color').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        annotateState.color = dot.dataset.color;
    });
});

// Toolbar: grosor
document.querySelectorAll('.ann-lw').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.ann-lw').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        annotateState.lineWidth = parseInt(btn.dataset.lw, 10);
    });
});

$('annUndoBtn').addEventListener('click', annUndo);

$('annSkipBtn').addEventListener('click', () => {
    closeAnnotatePanel();
    showStatus('Anotación omitida', '');
});

$('annSaveBtn').addEventListener('click', async () => {
    if (annotateState.shapes.length === 0) {
        closeAnnotatePanel();
        return;
    }
    const canvas  = $('annotateCanvas');
    const quality = (testState && testState.jpegQuality) || DEFAULT_QUALITY;
    const newDataUrl = canvas.toDataURL('image/jpeg', quality);
    const sizeKB = Math.round(newDataUrl.length / 1024);
    try {
        await qaUpdateEvidence(annotateState.evidenceId, { screenshot: newDataUrl, sizeKB });
        closeAnnotatePanel();
        showStatus(`✓ Anotación guardada (${sizeKB} KB)`, 'success');
        chrome.runtime.sendMessage({ action: 'evidenceCapturedFromWindow' }, () => {});
    } catch(err) {
        showStatus('Error guardando: ' + err.message, 'error');
    }
});

console.log('✅ Popup Window v7.4 cargado');