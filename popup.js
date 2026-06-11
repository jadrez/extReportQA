// QA Test Evidence Tracker v7.4
// - Screenshots como JPEG comprimido (no PNG base64 monstruoso)
// - Evidencias en IndexedDB (no chrome.storage.local)
// - chrome.storage.local guarda solo metadatos pequeños (testState sin screenshots)

const DEFAULT_QUALITY = 0.75;

let testState = {
    sessionId: null,
    url: '',
    proyecto: '',
    funcionalidad: '',
    idEscenario: '',
    nombreEscenario: '',
    idCaso: '',
    nombreCaso: '',
    precondiciones: '',
    datosPrueba: '',
    resultadoEsperado: '',
    httpEsperado: '',
    version: '',
    navegador: '',
    resultadoEjecucion: '',
    categorizacion: '',
    stepNotes: {},
    steps: [],
    currentStepIndex: 0,
    evidenceCount: 0,
    isActive: false,
    startTime: null,
    capturedThisStep: false,
    jpegQuality: DEFAULT_QUALITY
};

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const loadStepsBtn      = $('loadSteps');
const captureBtn        = $('captureBtn');
const prevBtn           = $('prevBtn');
const nextBtn           = $('nextBtn');
const stopBtn           = $('stopBtn');
const resetBtn          = $('resetBtn');
const exportBtn         = $('exportBtn');
const saveResultadoBtn  = $('saveResultadoBtn');
const urlInput          = $('url');
const stepsInput        = $('steps');
const qualityInput      = $('quality');

// ===== TAB SWITCHING =====
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        $(`${tab}-tab`).classList.add('active');
        if (tab === 'gallery') updateGallery();
    });
});

// ===== IMPORTAR DESDE PLANILLA =====

// Parser TSV — maneja campos multilínea con comillas (formato Excel)
function parseTSVRow(raw) {
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const fields = [];
    let cur = '';
    let inQuote = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inQuote) {
            if (ch === '"') {
                if (i + 1 < text.length && text[i + 1] === '"') {
                    cur += '"'; i += 2; // comilla escapada ""
                } else {
                    inQuote = false; i++;
                }
            } else {
                cur += ch; i++;
            }
        } else {
            if (ch === '"')      { inQuote = true; i++; }
            else if (ch === '\t') { fields.push(cur.trim()); cur = ''; i++; }
            else if (ch === '\n') { break; } // fin de la primera fila
            else                  { cur += ch; i++; }
        }
    }
    fields.push(cur.trim());
    return fields;
}

function parseStepsFromText(text) {
    return text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => l.replace(/^[\*\-•·\d]+[\.\)\:\s]+/, '').trim())
        .filter(l => l.length > 0);
}

function matchVersion(val) {
    const v = val.toLowerCase();
    if (v.includes('mobile') || v.includes('móvil')) return 'Mobile';
    if (v.includes('desktop') || v.includes('escritorio')) return 'Desktop';
    return '';
}

function matchNavegador(val) {
    const v = val.toLowerCase();
    if (v.includes('chrome'))                      return 'Chrome';
    if (v.includes('firefox') || v.includes('mozilla')) return 'Mozilla Firefox';
    if (v.includes('edge'))                        return 'Microsoft Edge';
    if (v.includes('safari'))                      return 'Safari';
    return '';
}

const IMPORT_COLS_FRONT = [
    { idx: 0, label: 'ID Escenario' },
    { idx: 1, label: 'Nombre Escenario' },
    { idx: 2, label: 'ID Caso' },
    { idx: 3, label: 'Categorización' },
    { idx: 4, label: 'Versión' },
    { idx: 5, label: 'Navegador' },
    { idx: 6, label: 'Precondiciones' },
    { idx: 7, label: 'Caso de Prueba' },
    { idx: 8, label: 'Paso a Paso' },
    { idx: 9, label: 'Resultado Esperado' }
];

const IMPORT_COLS_BACK = [
    { idx: 0, label: 'ID Escenario' },
    { idx: 1, label: 'Nombre Escenario' },
    { idx: 2, label: 'ID Caso' },
    { idx: 3, label: 'Categorización' },
    { idx: 4, label: 'Precondiciones' },
    { idx: 5, label: 'Caso de Prueba' },
    { idx: 6, label: 'Paso a Paso' },
    { idx: 7, label: 'HTTP Esperado' },
    { idx: 8, label: 'Resultado Esperado' }
];

function getImportFlow() {
    const active = document.querySelector('.flow-opt.active');
    return active ? active.dataset.flow : 'front';
}

function getImportCols() {
    return getImportFlow() === 'back' ? IMPORT_COLS_BACK : IMPORT_COLS_FRONT;
}

function renderImportColList() {
    const cols = getImportCols();
    const list = $('importColList');
    if (!list) return;
    list.innerHTML = cols.map(c =>
        `<span class="col-tag">${c.idx + 1}. ${c.label}</span>`
    ).join('');
}

function renderImportPreview(raw) {
    const preview = $('importPreview');
    const table   = $('importPreviewTable');
    if (!raw.trim()) { preview.style.display = 'none'; return; }

    const f = parseTSVRow(raw);
    if (f.length < 2) { preview.style.display = 'none'; return; }

    table.innerHTML = getImportCols().map(({ idx, label }) => {
        const val = (f[idx] || '').trim();
        if (!val) {
            return `<tr>
                <td class="col-name"><span class="col-num">${idx + 1}.</span>${label}</td>
                <td class="col-val is-empty">— vacío —</td>
            </tr>`;
        }
        const lines = val.split('\n');
        const MAX_LINES = 3;
        const shown = lines.slice(0, MAX_LINES).join('\n');
        const more  = lines.length > MAX_LINES
            ? `<span class="val-lines">+${lines.length - MAX_LINES} líneas más</span>`
            : '';
        const esc = shown
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<tr>
            <td class="col-name"><span class="col-num">${idx + 1}.</span>${label}</td>
            <td class="col-val is-multiline">${esc}${more}</td>
        </tr>`;
    }).join('');

    preview.style.display = 'block';
}

$('importToggle').addEventListener('click', () => {
    const panel = $('importPanel');
    const btn   = $('importToggle');
    const open  = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    btn.textContent = '📋 Importar desde planilla de Excel ' + (open ? '▸' : '▾');
    if (!open) renderImportColList(); // renderizar col-list al abrir
    if (open)  $('importPreview').style.display = 'none';
});

// Toggle Front / Back
document.querySelectorAll('.flow-opt').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.flow-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Mostrar/ocultar campo HTTP Esperado según flujo
        const isBack = btn.dataset.flow === 'back';
        $('httpEsperadoGroup').style.display = isBack ? 'block' : 'none';
        renderImportColList();
        // Re-renderizar preview si ya hay texto pegado
        const raw = $('importInput').value;
        if (raw.trim()) renderImportPreview(raw);
    });
});

$('importInput').addEventListener('input', () => {
    renderImportPreview($('importInput').value);
});

$('importBtn').addEventListener('click', () => {
    const raw = $('importInput').value;
    if (!raw.trim()) {
        showImportMsg('Pega primero la fila copiada de Excel', 'error');
        return;
    }

    const f = parseTSVRow(raw);
    const get = (i) => (f[i] || '').trim();

    if (f.length < 2) {
        showImportMsg('No se detectaron columnas. Asegúrate de copiar una fila completa de la planilla.', 'error');
        return;
    }

    const flow = getImportFlow();

    if (flow === 'back') {
        // Mapeo Back:
        // 0:ID Esc  1:Escenario  2:ID Caso  3:Categorización
        // 4:Precondiciones  5:Caso de Prueba  6:Paso a Paso
        // 7:HTTP Esperado  8:Resultado Esperado
        if (get(0)) $('idEscenario').value       = get(0);
        if (get(1)) $('nombreEscenario').value   = get(1);
        if (get(2)) $('idCaso').value            = get(2);
        if (get(3)) $('categorizacion').value    = get(3);
        if (get(4)) $('precondiciones').value    = get(4);
        if (get(5)) $('nombreCaso').value        = get(5);
        if (get(7)) {
            $('httpEsperado').value = get(7);
            $('httpEsperadoGroup').style.display = 'block';
        }
        if (get(8)) $('resultadoEsperado').value = get(8);
        if (get(6)) {
            const pasos = parseStepsFromText(get(6));
            if (pasos.length > 0) $('steps').value = pasos.map(s => '* ' + s).join('\n');
        }
    } else {
        // Mapeo Front (original):
        // 0:ID Esc  1:Escenario  2:ID Caso  3:Categorización  4:Versión  5:Navegador
        // 6:Precondiciones  7:Caso de Prueba  8:Paso a Paso  9:Resultado Esperado
        if (get(0)) $('idEscenario').value       = get(0);
        if (get(1)) $('nombreEscenario').value   = get(1);
        if (get(2)) $('idCaso').value            = get(2);
        if (get(3)) $('categorizacion').value    = get(3);
        if (get(6)) $('precondiciones').value    = get(6);
        if (get(7)) $('nombreCaso').value        = get(7);
        if (get(9)) $('resultadoEsperado').value = get(9);
        if (get(4)) {
            const vm = matchVersion(get(4));
            $('version').value = vm || get(4);
        }
        if (get(5)) {
            const nm = matchNavegador(get(5));
            $('navegador').value = nm || get(5);
        }
        if (get(8)) {
            const pasos = parseStepsFromText(get(8));
            if (pasos.length > 0) $('steps').value = pasos.map(s => '* ' + s).join('\n');
        }
    }

    // Cerrar panel y confirmar
    $('importPanel').style.display  = 'none';
    $('importToggle').textContent   = '📋 Importar desde planilla de Excel ▸';
    $('importInput').value          = '';
    $('importPreview').style.display = 'none';

    const filled = f.filter(c => c.length > 0).length;
    showImportMsg(`✓ ${filled} columnas importadas. Completa la URL y luego inicia la prueba.`, 'success');
});

function showImportMsg(text, type) {
    const el = $('importMessage');
    el.textContent = text;
    el.className = 'message ' + type;
    setTimeout(() => { el.className = 'message'; }, 5000);
}

// ===== LOAD STEPS / START SESSION =====
loadStepsBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const stepsText = stepsInput.value.trim();
    const quality = parseFloat(qualityInput.value) || DEFAULT_QUALITY;

    if (!url) return showMessage('Ingresa una URL', 'error');
    if (!$('proyecto').value.trim()) return showMessage('El campo Proyecto / Requerimiento es obligatorio', 'error');
    if (!$('funcionalidad').value.trim()) return showMessage('El campo Funcionalidad es obligatorio', 'error');
    if (!stepsText) return showMessage('Ingresa pasos', 'error');

    const steps = stepsText.split('\n')
        .map(s => s.trim())
        .filter(s => s.startsWith('*'))
        .map(s => s.substring(1).trim());

    if (steps.length === 0) return showMessage('Los pasos deben empezar con *', 'error');
    if (quality < 0.1 || quality > 1) return showMessage('Calidad debe estar entre 0.1 y 1.0', 'error');

    // Limpiar sesión anterior de IndexedDB
    try { await qaClearAll(); } catch (e) { appendDebugLog('qaClearAll falló: ' + e.message); }

    testState = {
        sessionId: 'sess_' + Date.now(),
        url,
        proyecto: $('proyecto').value.trim(),
        funcionalidad: $('funcionalidad').value.trim(),
        idEscenario: $('idEscenario').value.trim(),
        nombreEscenario: $('nombreEscenario').value.trim(),
        idCaso: $('idCaso').value.trim(),
        nombreCaso: $('nombreCaso').value.trim(),
        precondiciones: $('precondiciones').value.trim(),
        datosPrueba: $('datosPrueba').value.trim(),
        resultadoEsperado: $('resultadoEsperado').value.trim(),
        httpEsperado: $('httpEsperado').value.trim(),
        version: $('version').value,
        navegador: $('navegador').value,
        categorizacion: $('categorizacion').value.trim(),
        resultadoEjecucion: '',
        stepNotes: {},
        steps,
        currentStepIndex: 0,
        evidenceCount: 0,
        isActive: true,
        startTime: new Date().toISOString(),
        capturedThisStep: false,
        jpegQuality: quality
    };

    await saveState();
    clearDraft(); // borrador ya no necesario, la prueba está guardada en testState
    showMessage(`✓ ${steps.length} pasos cargados (sesión: ${testState.sessionId})`, 'success');

    setTimeout(() => {
        document.querySelector('[data-tab="test"]').click();
        updateUI();
        openPopupWindow();
    }, 400);
});

// ===== CAPTURE =====
captureBtn.addEventListener('click', () => {
    if (testState.capturedThisStep) {
        showMessage('Ya capturaste este paso. Haz clic en Siguiente.', 'warning');
        return;
    }
    captureScreenshot();
});

// Verifica si el paso ya tiene evidencias y sincroniza capturedThisStep
async function syncCaptureStateForStep(stepIndex) {
    const step = stepIndex + 1;
    const evidences = await qaGetEvidenceForStep(testState.sessionId, step);
    testState.capturedThisStep = evidences.length > 0;
    return evidences.length;
}

// ===== PREVIOUS =====
prevBtn.addEventListener('click', async () => {
    if (testState.currentStepIndex > 0) {
        testState.currentStepIndex--;
        await syncCaptureStateForStep(testState.currentStepIndex);
        await saveState();
        updateUI();
        updatePopupWindow();
    }
});

// ===== NEXT =====
nextBtn.addEventListener('click', async () => {
    if (testState.currentStepIndex < testState.steps.length - 1) {
        testState.currentStepIndex++;
        await syncCaptureStateForStep(testState.currentStepIndex);
        await saveState();
        updateUI();
        updatePopupWindow();
    } else {
        showMessage('Último paso alcanzado. Detén la prueba para finalizar.', 'info');
    }
});

// ===== STOP =====
stopBtn.addEventListener('click', async () => {
    if (!confirm('¿Detener la prueba?')) return;
    testState.isActive = false;
    await saveState();
    updateUI();
    closePopupWindow();
    document.querySelector('[data-tab="gallery"]').click();
});

// ===== RESET =====
resetBtn.addEventListener('click', async () => {
    if (!confirm('¿Reiniciar desde el paso 1? Se borrarán las evidencias capturadas pero se conservan la URL y los pasos.')) return;
    try { await qaClearAll(); } catch(e) { appendDebugLog('reset clearAll: ' + e.message); }
    testState.evidenceCount = 0;
    testState.currentStepIndex = 0;
    testState.capturedThisStep = false;
    testState.isActive = true;
    await saveState();
    updateUI();
    updatePopupWindow();
    showMessage('Prueba reiniciada desde el paso 1', 'success');
});

// ===== ELIMINAR EVIDENCIA DEL PASO =====
$('deleteStepEvidenceBtn').addEventListener('click', async () => {
    if (!testState.isActive) return;
    const step = testState.currentStepIndex + 1;
    if (!confirm(`¿Eliminar todas las evidencias del Paso ${step}? Podrás volver a capturar.`)) return;

    const evidences = await qaGetEvidenceForStep(testState.sessionId, step);
    for (const ev of evidences) {
        await qaDeleteEvidenceById(ev.id);
    }

    testState.evidenceCount = Math.max(0, (testState.evidenceCount || 0) - evidences.length);
    testState.capturedThisStep = false;
    await saveState();
    updateUI();
    await updateGallery();
    updatePopupWindow();
    showMessage(`✓ ${evidences.length} evidencia(s) del Paso ${step} eliminada(s). Puedes re-capturar.`, 'success');
});

// ===== NOTAS POR PASO =====
$('saveNoteBtn').addEventListener('click', async () => {
    const note = $('stepNoteInput').value.trim();
    if (!testState.stepNotes) testState.stepNotes = {};
    testState.stepNotes[testState.currentStepIndex] = note;
    await saveState();
    updatePopupWindow();
    const lbl = $('noteSavedLabel');
    lbl.style.display = 'inline';
    setTimeout(() => { lbl.style.display = 'none'; }, 2000);
});

$('stepNoteInput').addEventListener('keydown', (e) => {
    // Evitar que Space u otras teclas disparen atajos
    e.stopPropagation();
});

// ===== RESULTADO DE EJECUCIÓN =====
saveResultadoBtn.addEventListener('click', async () => {
    testState.resultadoEjecucion = $('resultadoEjecucion').value.trim();
    await saveState();
    showMessage('Resultado de ejecución guardado', 'success');
});

// ===== REUTILIZAR EVIDENCIA =====
$('reuseCheck').addEventListener('change', () => {
    $('reusePanel').style.display = $('reuseCheck').checked ? 'block' : 'none';
});

// ===== EXPORT =====
exportBtn.addEventListener('click', exportReport);

// ===== CAPTURE SCREENSHOT =====
// El flujo de captura se delega al background, que orquesta:
//   1) Asegura que el offscreen document exista
//   2) Offscreen llama a getDisplayMedia → usuario ve el selector nativo de Chrome
//      (pestañas: Pestaña / Ventana / Pantalla completa)
//   3) Usuario elige "Pantalla completa" — captura incluye barra de URL + reloj
//   4) Offscreen genera JPEG y guarda en IndexedDB
//   5) Background nos devuelve { ok, id, sizeKB, evidenceCount }
async function captureScreenshot() {
    showMessage('Selecciona la pantalla a capturar…', 'info');
    appendDebugLog('captureScreenshot start step=' + (testState.currentStepIndex + 1));

    const context = {
        sessionId: testState.sessionId,
        step: testState.currentStepIndex + 1,
        stepText: testState.steps[testState.currentStepIndex],
        jpegQuality: testState.jpegQuality || DEFAULT_QUALITY,
        url: testState.url,
        previousCount: testState.evidenceCount || 0
    };

    chrome.runtime.sendMessage({ action: 'capture_screen', context }, async (response) => {
        if (chrome.runtime.lastError) {
            appendDebugLog('capture_screen lastError: ' + chrome.runtime.lastError.message);
            showMessage('Error de comunicación: ' + chrome.runtime.lastError.message, 'error');
            return;
        }

        if (!response || !response.ok) {
            const errMsg = (response && response.error) || 'Captura cancelada';
            appendDebugLog('captura fallida: ' + errMsg);
            showMessage(errMsg, 'error');
            return;
        }

        // La evidencia ya quedó guardada en IndexedDB por el offscreen
        testState.evidenceCount = response.evidenceCount || (testState.evidenceCount + 1);
        testState.capturedThisStep = true;
        await saveState();
        updateUI();
        updateGallery();
        updatePopupWindow();
        showMessage(`✓ Evidencia ${testState.evidenceCount} guardada (${response.sizeKB} KB)`, 'success');
    });
}

// ===== UI =====
function updateUI() {
    if (!testState.isActive || testState.steps.length === 0) {
        $('testInactive').style.display = 'block';
        $('testActive').style.display = 'none';
        return;
    }
    $('testInactive').style.display = 'none';
    $('testActive').style.display = 'block';

    const current = testState.currentStepIndex + 1;
    const total = testState.steps.length;

    $('stepNumber').textContent = `Paso ${current} de ${total}`;
    $('stepText').textContent = testState.steps[testState.currentStepIndex];
    $('stepCounter').textContent = `${testState.evidenceCount}/${total}`;
    const noteInput = $('stepNoteInput');
    if (noteInput) {
        noteInput.value = (testState.stepNotes && testState.stepNotes[testState.currentStepIndex]) || '';
    }
    $('progressFill').style.width = Math.min(100, (testState.evidenceCount / total) * 100) + '%';

    updateStepsList();
    updateButtonStates();
}

function updateStepsList() {
    const list = $('stepsList');
    list.innerHTML = testState.steps.map((step, idx) => {
        let cls = 'step-item';
        if (idx === testState.currentStepIndex) cls += ' active';
        if (idx < testState.currentStepIndex) cls += ' completed';
        const text = step.length > 50 ? step.substring(0, 50) + '…' : step;
        return `<div class="${cls}">${idx + 1}. ${text}</div>`;
    }).join('');
}

function updateButtonStates() {
    const isLast  = testState.currentStepIndex >= testState.steps.length - 1;
    const isFirst = testState.currentStepIndex <= 0;
    captureBtn.disabled = testState.capturedThisStep;
    captureBtn.textContent = testState.capturedThisStep ? '✓ Capturado' : '📸 Capturar';
    nextBtn.disabled = isLast;
    prevBtn.disabled = isFirst;

    // Mostrar botón eliminar evidencia solo cuando el paso actual ya tiene capturas
    const delBtn = $('deleteStepEvidenceBtn');
    if (delBtn) delBtn.style.display = testState.capturedThisStep ? 'block' : 'none';
}

// ===== GALLERY =====
async function updateGallery() {
    const container = $('galleryContainer');
    const stats = $('galleryStats');
    // Sincronizar textarea con el valor guardado
    const resultadoEl = $('resultadoEjecucion');
    if (resultadoEl && testState.resultadoEjecucion) {
        resultadoEl.value = testState.resultadoEjecucion;
    }

    try {
        const all = await qaGetAllEvidence(testState.sessionId);
        const total = testState.steps.length || 0;
        const cov = total ? Math.round((all.length / total) * 100) : 0;

        const est = await qaGetStorageEstimate();
        const storageInfo = est
            ? `💾 ${(est.usage / 1024 / 1024).toFixed(1)} MB usados de ${(est.quota / 1024 / 1024).toFixed(0)} MB (${est.percent}%)`
            : '';

        stats.innerHTML = `
            <strong>Evidencias:</strong> ${all.length} / ${total}
            &nbsp;·&nbsp; <strong>Cobertura:</strong> ${cov}%
            <br><span style="font-size:10px;color:#666;">${storageInfo}</span>
        `;

        if (all.length === 0) {
            container.innerHTML = '<div class="empty-gallery">📭 Aún no hay evidencias</div>';
            return;
        }

        container.innerHTML = all.map(ev => `
            <div class="gallery-item">
                <div class="gallery-item-header">
                    Paso ${ev.step}: ${escapeHtml(ev.stepText || '')}
                    <span style="float:right;color:#888;font-weight:normal;">${ev.sizeKB || '?'} KB</span>
                </div>
                <img src="${ev.screenshot}" alt="Evidencia paso ${ev.step}">
            </div>
        `).join('');
    } catch (err) {
        appendDebugLog('updateGallery error: ' + err.message);
        container.innerHTML = '<div class="empty-gallery">Error al cargar galería: ' + escapeHtml(err.message) + '</div>';
    }
}

// ===== EXPORT REPORT =====
async function exportReport() {
    // Guardar el resultado de ejecución si tiene texto antes de exportar
    const resultadoEl = $('resultadoEjecucion');
    if (resultadoEl && resultadoEl.value.trim()) {
        testState.resultadoEjecucion = resultadoEl.value.trim();
        await saveState();
    }

    let all;
    try {
        all = await qaGetAllEvidence(testState.sessionId);
    } catch (err) {
        showMessage('Error leyendo evidencias: ' + err.message, 'error');
        return;
    }

    if (all.length === 0) {
        showMessage('No hay evidencias para exportar', 'warning');
        return;
    }

    const totalSteps = testState.steps.length || all.length;
    const coverage = Math.round((all.length / totalSteps) * 100);

    // Si el checkbox de reutilización está activo, usar los campos override
    const reusing = $('reuseCheck') && $('reuseCheck').checked;
    const rGet = (id) => ($(`r${id}`) && $(`r${id}`).value.trim()) || '';

    const reportMeta = reusing ? {
        idEscenario:     rGet('IdEscenario')    || testState.idEscenario,
        nombreEscenario: rGet('NombreEscenario') || testState.nombreEscenario,
        idCaso:          rGet('IdCaso')          || testState.idCaso,
        nombreCaso:      rGet('NombreCaso')      || testState.nombreCaso,
        precondiciones:  rGet('Precondiciones')  || testState.precondiciones,
        datosPrueba:     rGet('DatosPrueba')     || testState.datosPrueba,
        resultadoEsperado: rGet('ResultadoEsperado') || testState.resultadoEsperado
    } : {
        idEscenario:     testState.idEscenario,
        nombreEscenario: testState.nombreEscenario,
        idCaso:          testState.idCaso,
        nombreCaso:      testState.nombreCaso,
        precondiciones:  testState.precondiciones,
        datosPrueba:     testState.datosPrueba,
        resultadoEsperado: testState.resultadoEsperado
    };

    const idEsc = (reportMeta.idEscenario || 'SIN-ESC').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const idCas = (reportMeta.idCaso      || 'SIN-CP' ).replace(/[^a-zA-Z0-9_\-]/g, '_');

    const metaRow = (label, value) => value
        ? `<tr><td class="meta-label">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`
        : '';

    const preBlock = (label, value) => value ? `
<div class="section-block">
    <div class="section-title">${escapeHtml(label)}</div>
    <div class="section-body">${escapeHtml(value)}</div>
</div>` : '';

    let html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>${idEsc}_${idCas} - Reporte QA</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1100px; margin: 0 auto; padding: 30px; background: #f5f5f5; color: #222; }
    .report-header { background: linear-gradient(135deg, #0066cc, #0052a3); color: white; padding: 24px 28px; border-radius: 8px; margin-bottom: 20px; }
    .report-header h1 { margin: 0 0 4px; font-size: 22px; }
    .report-header .subtitle { font-size: 13px; opacity: 0.85; }
    .card { background: white; border-radius: 6px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); overflow: hidden; }
    .card-header { background: #0066cc; color: white; padding: 10px 16px; font-weight: 700; font-size: 14px; }
    .card-body { padding: 16px; }
    .meta-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .meta-table td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    .meta-table tr:last-child td { border-bottom: none; }
    .meta-label { font-weight: 700; color: #444; width: 200px; white-space: nowrap; }
    .cols-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .section-block { margin-bottom: 14px; }
    .section-block:last-child { margin-bottom: 0; }
    .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #0066cc; margin-bottom: 4px; letter-spacing: 0.4px; }
    .section-body { font-size: 13px; line-height: 1.5; color: #333; white-space: pre-wrap; background: #f8f9fa; padding: 10px 12px; border-radius: 4px; border-left: 3px solid #0066cc; }
    .resultado-block { border-left-color: #28a745; }
    .resultado-title { color: #155724; }
    .resultado-body { border-left-color: #28a745; background: #f0fff4; }
    .evidence { background: white; border-radius: 6px; margin-bottom: 18px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .evidence-header { background: #0066cc; color: white; padding: 12px 16px; font-weight: 700; }
    .evidence-meta { padding: 10px 16px; background: #f8f9fa; font-size: 13px; border-bottom: 1px solid #eee; }
    .evidence-meta div { margin: 2px 0; }
    .evidence img { width: 100%; display: block; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; }
    .badge-ok { background: #d4edda; color: #155724; }
    .footer { text-align: center; color: #999; font-size: 12px; margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; }
    .note-box { margin-top: 8px; background: #f0f7ff; border: 1px solid #cce0ff; border-left: 3px solid #3b82f6; border-radius: 4px; padding: 8px 10px; }
    .note-box-label { font-size: 11px; font-weight: 700; color: #1a5276; margin-bottom: 5px; display: flex; align-items: center; justify-content: space-between; }
    .note-box textarea { width: 100%; min-height: 56px; padding: 6px 8px; border: 1px solid #d0e8ff; border-radius: 3px; font-size: 12px; font-family: inherit; resize: vertical; background: white; color: #222; box-sizing: border-box; }
    .note-copy-btn { padding: 3px 10px; background: #0066cc; color: white; border: none; border-radius: 3px; font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap; margin-left: 8px; }
    .note-copy-btn:hover { background: #0052a3; }
</style></head><body>
<div class="report-header">
    <h1>📋 Reporte QA Test Evidence</h1>
    <div class="subtitle">Generado el ${new Date().toLocaleString('es-CO')} &nbsp;·&nbsp; Sesión: ${escapeHtml(testState.sessionId || '—')}${reusing ? ' &nbsp;·&nbsp; <strong>♻️ Evidencia reutilizada</strong>' : ''}</div>
</div>

<div class="card">
    <div class="card-header">📌 Identificación del caso</div>
    <div class="card-body">
        <table class="meta-table">
            ${metaRow('Proyecto / Requerimiento', testState.proyecto)}
            ${metaRow('Funcionalidad', testState.funcionalidad)}
            ${metaRow('ID Escenario', reportMeta.idEscenario)}
            ${metaRow('Nombre del Escenario', reportMeta.nombreEscenario)}
            ${metaRow('ID Caso', reportMeta.idCaso)}
            ${metaRow('Nombre del Caso', reportMeta.nombreCaso)}
            ${metaRow('Categorización', testState.categorizacion)}
            ${metaRow('Versión', testState.version)}
            ${metaRow('Navegador', testState.navegador)}
            ${metaRow('URL', testState.url)}
            ${metaRow('Inicio', testState.startTime ? new Date(testState.startTime).toLocaleString('es-CO') : '')}
        </table>
    </div>
</div>

<div class="card">
    <div class="card-header">📊 Resumen de ejecución</div>
    <div class="card-body">
        <table class="meta-table">
            <tr><td class="meta-label">Pasos totales</td><td>${totalSteps}</td></tr>
            <tr><td class="meta-label">Evidencias capturadas</td><td>${all.length}</td></tr>
            <tr><td class="meta-label">Cobertura</td><td>${coverage}%</td></tr>
        </table>
    </div>
</div>
`;

    const hasDetail = reportMeta.precondiciones || reportMeta.datosPrueba || testState.httpEsperado || reportMeta.resultadoEsperado;
    if (hasDetail) {
        html += `
<div class="card">
    <div class="card-header">📋 Detalle de la prueba</div>
    <div class="card-body">
        ${preBlock('Precondiciones', reportMeta.precondiciones)}
        ${preBlock('Datos de prueba', reportMeta.datosPrueba)}
        ${preBlock('HTTP Esperado', testState.httpEsperado)}
        ${preBlock('Resultado esperado', reportMeta.resultadoEsperado)}
    </div>
</div>`;
    }

    html += `\n<div class="card">\n    <div class="card-header">📸 Evidencias</div>\n    <div class="card-body" style="padding:0;">`;

    // Contar cuántas capturas hay por paso para etiquetar múltiples
    const countByStep = {};
    for (const ev of all) {
        countByStep[ev.step] = (countByStep[ev.step] || 0) + 1;
    }
    const indexByStep = {};
    for (const ev of all) {
        indexByStep[ev.step] = (indexByStep[ev.step] || 0) + 1;
        const total = countByStep[ev.step];
        const idx = indexByStep[ev.step];
        const stepLabel = total > 1
            ? `Paso ${ev.step}: ${escapeHtml(ev.stepText || '')} &nbsp;<span style="font-weight:400;font-size:12px;opacity:0.85;">— Evidencia ${idx} de ${total}</span>`
            : `Paso ${ev.step}: ${escapeHtml(ev.stepText || '')}`;
        const stepNote = testState.stepNotes && testState.stepNotes[ev.step - 1];
        const noteId   = `note_${ev.step}_${idx}`;
        const noteHtml = stepNote ? `
<div class="note-box">
    <div class="note-box-label">
        <span>📝 Nota del paso</span>
        <button class="note-copy-btn" onclick="(function(btn){var ta=document.getElementById('${noteId}');navigator.clipboard.writeText(ta.value).then(function(){btn.textContent='✓ Copiado';setTimeout(function(){btn.textContent='📋 Copiar'},2000)}).catch(function(){ta.select();document.execCommand('copy');btn.textContent='✓ Copiado';setTimeout(function(){btn.textContent='📋 Copiar'},2000)})})(this)">📋 Copiar</button>
    </div>
    <textarea id="${noteId}" readonly>${escapeHtml(stepNote)}</textarea>
</div>` : '';
        html += `
<div class="evidence" style="border-radius:0;box-shadow:none;border-bottom:1px solid #eee;">
    <div class="evidence-header">${stepLabel}</div>
    <div class="evidence-meta">
        <div><strong>🌐 URL:</strong> ${escapeHtml(ev.url || '')}</div>
        <div><strong>📅 Fecha:</strong> ${escapeHtml(ev.fullDate || '')}</div>
        <div><strong>📦 Tamaño:</strong> ${ev.sizeKB || '?'} KB</div>
        ${noteHtml}
    </div>
    <img src="${ev.screenshot}" alt="Evidencia paso ${ev.step}">
</div>`;
    }

    html += `\n    </div>\n</div>`;

    if (testState.resultadoEjecucion) {
        html += `
<div class="card">
    <div class="card-header" style="background:#28a745;">✅ Resultado de la ejecución</div>
    <div class="card-body">
        <div class="section-block resultado-block">
            <div class="section-body resultado-body">${escapeHtml(testState.resultadoEjecucion)}</div>
        </div>
    </div>
</div>`;
    }

    html += `<div class="footer">Generado por QA Test Evidence Tracker v7.4</div></body></html>`;

    const blob    = new Blob([html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);

    chrome.downloads.download({
        url:      blobUrl,
        filename: `${idEsc}_${idCas}.html`,
        saveAs:   true
    }, (downloadId) => {
        URL.revokeObjectURL(blobUrl);
        if (chrome.runtime.lastError) {
            showMessage('Error al guardar: ' + chrome.runtime.lastError.message, 'error');
        } else {
            showMessage('✓ Reporte guardado', 'success');
        }
    });
}

// ===== STATE PERSISTENCE =====
function saveState() {
    return new Promise((resolve) => {
        chrome.storage.local.set({ testState }, () => {
            if (chrome.runtime.lastError) {
                appendDebugLog('saveState error: ' + chrome.runtime.lastError.message);
            }
            resolve();
        });
    });
}

function showMessage(text, type) {
    const msg = $('configMessage');
    if (!msg) return;
    msg.textContent = text;
    msg.className = `message ${type}`;
    clearTimeout(showMessage._t);
    showMessage._t = setTimeout(() => { msg.className = 'message'; }, 4000);
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ===== DEBUG LOGS =====
function appendDebugLog(message) {
    try {
        const entry = { ts: new Date().toISOString(), message };
        chrome.storage.local.get(['debugLogs'], (res) => {
            const logs = (res && res.debugLogs) ? res.debugLogs : [];
            logs.push(entry);
            if (logs.length > 200) logs.splice(0, logs.length - 200);
            chrome.storage.local.set({ debugLogs: logs });
        });
    } catch (e) { console.error('appendDebugLog failed', e); }
}

function showDebugLogsModal() {
    const modal = $('debugModal');
    const text = $('debugText');
    if (!modal || !text) return;
    chrome.storage.local.get(['debugLogs'], (res) => {
        const logs = (res && res.debugLogs) ? res.debugLogs : [];
        text.value = logs.slice(-200).map(l => `[${l.ts}] ${l.message}`).join('\n') || 'No hay logs';
        modal.style.display = 'flex';
    });
}

function hideDebugLogsModal() {
    const modal = $('debugModal');
    if (modal) modal.style.display = 'none';
}

document.addEventListener('click', (e) => {
    if (e.target.id === 'showDebugBtn') showDebugLogsModal();
    if (e.target.id === 'closeDebugBtn') hideDebugLogsModal();
    if (e.target.id === 'copyDebugBtn') {
        const t = $('debugText');
        if (t) { t.select(); document.execCommand('copy'); }
    }
    if (e.target.id === 'clearDebugBtn') {
        chrome.storage.local.set({ debugLogs: [] }, () => {
            const t = $('debugText');
            if (t) t.value = 'Logs limpiados.';
        });
    }
    if (e.target.id === 'storageInfoBtn') showStorageInfo();
});

async function showStorageInfo() {
    const est = await qaGetStorageEstimate();
    const count = await qaCountEvidence();
    if (est) {
        alert(`💾 Almacenamiento\n\nEvidencias en IndexedDB: ${count}\nUsado: ${(est.usage/1024/1024).toFixed(2)} MB\nCuota total: ${(est.quota/1024/1024).toFixed(0)} MB\nUso: ${est.percent}%`);
    } else {
        alert(`Evidencias en IndexedDB: ${count}\n(estimación de cuota no disponible)`);
    }
}

// ===== POPUP WINDOW HELPERS =====
function buildPopupData() {
    return {
        sessionId: testState.sessionId,
        step: testState.currentStepIndex + 1,
        stepText: testState.steps[testState.currentStepIndex] || '',
        total: testState.steps.length,
        isCaptured: !!testState.capturedThisStep,
        isActive: !!testState.isActive
    };
}

function openPopupWindow() {
    chrome.runtime.sendMessage({ action: 'openPopupWindow', data: buildPopupData() }, () => {});
}
function updatePopupWindow() {
    chrome.runtime.sendMessage({ action: 'updatePopupWindow', data: buildPopupData() }, () => {});
}
function closePopupWindow() {
    chrome.runtime.sendMessage({ action: 'closePopupWindow' }, () => {});
}

// ===== SYNC FROM POPUP WINDOW =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'evidenceCapturedFromWindow') {
        chrome.storage.local.get(['testState'], async (res) => {
            if (res.testState) testState = res.testState;
            updateUI();
            await updateGallery();
        });
        sendResponse({ status: 'ok' });
    } else if (request.action === 'stepAdvancedFromWindow') {
        chrome.storage.local.get(['testState'], (res) => {
            if (res.testState) testState = res.testState;
            updateUI();
        });
        sendResponse({ status: 'ok' });
    } else if (request.action === 'stepsUpdatedFromWindow') {
        chrome.storage.local.get(['testState'], (res) => {
            if (res.testState) testState = res.testState;
            updateUI();
        });
        sendResponse({ status: 'ok' });
    }
    return true;
});

// ===== GESTIÓN DE PASOS =====
let stepEditorMode = null; // 'edit' | 'add'

$('editStepBtn').addEventListener('click', () => {
    if (!testState.isActive) return;
    stepEditorMode = 'edit';
    $('stepEditorInput').value = testState.steps[testState.currentStepIndex] || '';
    $('stepEditorInput').placeholder = 'Editar paso actual…';
    $('stepEditorPanel').style.display = 'block';
    $('stepEditorInput').focus();
    $('stepEditorInput').select();
});

$('addStepBtn').addEventListener('click', () => {
    if (!testState.isActive) return;
    stepEditorMode = 'add';
    $('stepEditorInput').value = '';
    $('stepEditorInput').placeholder = 'Texto del nuevo paso…';
    $('stepEditorPanel').style.display = 'block';
    $('stepEditorInput').focus();
});

$('deleteStepBtn').addEventListener('click', async () => {
    if (!testState.isActive) return;
    if (testState.steps.length <= 1) {
        showMessage('No se puede eliminar el único paso restante', 'error');
        return;
    }
    const txt = testState.steps[testState.currentStepIndex] || '';
    if (!confirm(`¿Eliminar el paso: "${txt.length > 60 ? txt.slice(0,60)+'…' : txt}"?\nSe eliminarán también las evidencias capturadas para este paso.`)) return;

    // Eliminar evidencias del paso antes de quitarlo del array
    const stepNum = testState.currentStepIndex + 1;
    const stepEvidence = await qaGetEvidenceForStep(testState.sessionId, stepNum);
    for (const ev of stepEvidence) await qaDeleteEvidenceById(ev.id);
    testState.evidenceCount = Math.max(0, (testState.evidenceCount || 0) - stepEvidence.length);

    testState.steps.splice(testState.currentStepIndex, 1);
    if (testState.currentStepIndex >= testState.steps.length) {
        testState.currentStepIndex = testState.steps.length - 1;
    }
    // Sincronizar capturedThisStep con el nuevo paso actual
    await syncCaptureStateForStep(testState.currentStepIndex);
    await saveState();
    updateUI();
    await updateGallery();
    updatePopupWindow();
    showMessage(`Paso eliminado${stepEvidence.length > 0 ? ` (${stepEvidence.length} evidencia(s) borrada(s))` : ''}`, 'success');
});

$('confirmStepEdit').addEventListener('click', async () => {
    const text = $('stepEditorInput').value.trim();
    if (!text) { showMessage('El texto no puede estar vacío', 'error'); return; }

    const mode = stepEditorMode;
    $('stepEditorPanel').style.display = 'none';
    stepEditorMode = null;

    if (mode === 'edit') {
        testState.steps[testState.currentStepIndex] = text;
    } else if (mode === 'add') {
        testState.steps.splice(testState.currentStepIndex + 1, 0, text);
    }
    await saveState();
    updateUI();
    updatePopupWindow();
    showMessage(mode === 'edit' ? 'Paso actualizado' : 'Paso insertado después del actual', 'success');
});

$('cancelStepEdit').addEventListener('click', () => {
    $('stepEditorPanel').style.display = 'none';
    stepEditorMode = null;
});

$('stepEditorInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  $('confirmStepEdit').click();
    if (e.key === 'Escape') $('cancelStepEdit').click();
});

// ===== KEYBOARD =====
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && testState.isActive && !testState.capturedThisStep
        && document.activeElement.tagName !== 'TEXTAREA'
        && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        captureScreenshot();
    }
});

// ===== BORRADOR DE CONFIG (persiste campos mientras se llena el formulario) =====
const DRAFT_FIELDS = [
    'url', 'proyecto', 'funcionalidad', 'idEscenario', 'nombreEscenario',
    'idCaso', 'nombreCaso', 'categorizacion', 'version', 'navegador',
    'precondiciones', 'datosPrueba', 'httpEsperado', 'resultadoEsperado', 'steps', 'quality'
];

function saveDraftNow() {
    const draft = {};
    DRAFT_FIELDS.forEach(id => {
        const el = $(id);
        if (el) draft[id] = el.value;
    });
    chrome.storage.local.set({ draftConfig: draft });
}

DRAFT_FIELDS.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input',  saveDraftNow);
    el.addEventListener('change', saveDraftNow);
});

function restoreDraft(draft) {
    DRAFT_FIELDS.forEach(id => {
        const el = $(id);
        if (el && draft[id] !== undefined && draft[id] !== '') {
            el.value = draft[id];
        }
    });
    if (draft.httpEsperado) $('httpEsperadoGroup').style.display = 'block';
}

function clearDraft() {
    chrome.storage.local.remove(['draftConfig']);
}

// ===== INIT =====
chrome.storage.local.get(['testState', 'draftConfig'], async (result) => {
    // Alias para compatibilidad con el bloque original
    const draftConfig = result.draftConfig || null;
    if (result.testState) {
        testState = Object.assign(testState, result.testState);

        // Restaurar campos en el formulario de config
        urlInput.value = testState.url || '';
        if (testState.steps && testState.steps.length) {
            stepsInput.value = testState.steps.map(s => '* ' + s).join('\n');
        }
        $('proyecto').value          = testState.proyecto || '';
        $('funcionalidad').value     = testState.funcionalidad || '';
        $('idEscenario').value       = testState.idEscenario || '';
        $('nombreEscenario').value   = testState.nombreEscenario || '';
        $('idCaso').value            = testState.idCaso || '';
        $('nombreCaso').value        = testState.nombreCaso || '';
        $('precondiciones').value    = testState.precondiciones || '';
        $('datosPrueba').value       = testState.datosPrueba || '';
        $('httpEsperado').value      = testState.httpEsperado || '';
        $('resultadoEsperado').value = testState.resultadoEsperado || '';
        if (testState.httpEsperado) $('httpEsperadoGroup').style.display = 'block';
        $('version').value           = testState.version || '';
        $('navegador').value         = testState.navegador || '';
        $('categorizacion').value    = testState.categorizacion || '';
        $('resultadoEjecucion').value = testState.resultadoEjecucion || '';

        if (testState.isActive) {
            document.querySelector('[data-tab="test"]').click();
            updateUI();
            openPopupWindow();
        } else {
            // Sesión inactiva: si hay borrador más reciente, aplicarlo encima
            if (draftConfig) restoreDraft(draftConfig);
            updateUI();
        }
    } else {
        // Sin sesión: restaurar borrador o poner valores de ejemplo
        if (draftConfig) {
            restoreDraft(draftConfig);
        } else {
            urlInput.value = 'https://tiendaempresas.claro.com.co/';
            stepsInput.value = `* Ingresar a la tienda\n* Hacer clic en menú\n* Seleccionar producto\n* Agregar al carrito\n* Proceder a comprar`;
        }
    }
    // refrescar galería en background para tener stats al abrir
    await updateGallery();
});

console.log('✅ QA Test Evidence Tracker v7.4 cargado');
