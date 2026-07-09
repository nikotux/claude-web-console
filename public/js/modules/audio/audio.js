// modules/audio/audio.js — Extracción de audio: pegás una transcripción (ya
// pasada a texto) y la IA interpreta quién dijo qué y por qué, la clasifica,
// arma un plan y PROPONE tareas que van al módulo `tasks` con tu aprobación.
//
// YA NO es una sección de sidebar propia: vive DENTRO de "Pendientes" (pedido
// del usuario). Se expone como openAudioPanel(ctx) y lo abre tasks.js (botón
// admin, porque consume tokens). Al crear tareas dispara el evento `tasks-changed`
// del bus para que el tablero de Pendientes se refresque solo.
//
// La corrida es DESACOPLADA y consume tokens: POST /api/audio/analyze arranca un
// runner detached y el modal ENCUESTA GET /api/audio/:id (resiliente a cambios
// de pestaña / reinicios del server — patrón triage/health/desk-live).
import { pacman } from '../../ui/pacman.js';

const SEG = {
  accion: { emoji: '🎯', label: 'Acción' },
  plan: { emoji: '🗺️', label: 'Plan' },
  decision: { emoji: '✅', label: 'Decisión' },
  problema: { emoji: '⚠️', label: 'Problema' },
  pregunta: { emoji: '❓', label: 'Pregunta' },
  info: { emoji: 'ℹ️', label: 'Info' },
};
const segOf = (t) => SEG[t] || SEG.info;
const PRIO_EMOJI = { alta: '🔴', media: '🟡', baja: '🟢' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtAgo(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

// Pinta un resultado ya interpretado dentro de `container`. bus (opcional) se
// usa para avisar `tasks-changed` al crear tareas desde las propuestas; dialog
// (opcional) para el confirm de "Pasar a plan".
// Es ASÍNCRONA: antes de pintar consulta qué tareas de este informe ya están
// creadas (source=audio + sourceRef=jobId) para marcarlas ✓ y bloquear su botón.
async function renderResult(container, job, id, bus, dialog) {
  const res = job.result;
  if (!res) { container.innerHTML = ''; return; }
  // Tareas de ESTE informe ya presentes en Pendientes (match por título).
  let createdTitles = new Set();
  if (id) {
    try {
      const d = await (await fetch('/api/tasks')).json();
      createdTitles = new Set((d.tasks || []).filter((t) => t.sourceRef === id).map((t) => t.title));
    } catch { /* noop */ }
  }
  const speakers = (res.speakers || []).map((s) =>
    `<li><strong>${esc(s.name || '?')}</strong>${s.role ? ` — ${esc(s.role)}` : ''}</li>`).join('');
  const segments = (res.segments || []).map((s) => {
    const so = segOf(s.type);
    return `<li class="au-seg au-seg--${s.type}">
      <span class="au-seg-type" title="${so.label}">${so.emoji}</span>
      <span class="au-seg-body"><span class="au-seg-who">${esc(s.who || '?')}:</span> ${esc(s.text)}
      ${s.why ? `<span class="au-seg-why">↳ ${esc(s.why)}</span>` : ''}</span></li>`;
  }).join('');
  const plan = (res.plan || []).map((p) =>
    `<li><strong>${esc(p.step)}</strong>${p.why ? `<span class="au-why"> — ${esc(p.why)}</span>` : ''}</li>`).join('');
  const proposed = res.proposedTasks || [];
  const allCreated = proposed.length > 0 && proposed.every((t) => createdTitles.has(t.title));
  const tasks = proposed.map((t, i) => {
    const already = createdTitles.has(t.title);
    return `
    <div class="au-task${already ? ' au-task--done' : ''}" data-i="${i}">
      <div class="au-task-top">
        <span class="au-task-prio">${PRIO_EMOJI[t.priority] || '🟡'}</span>
        <span class="au-task-title">${esc(t.title)}</span>
        ${already
          ? '<span class="au-task-already" title="Ya está en Pendientes">✓ Ya creada</span>'
          : `<button class="btn-ghost btn--sm au-task-add" data-i="${i}">＋ Crear tarea</button>`}
      </div>
      ${t.description ? `<div class="au-task-desc">${esc(t.description)}</div>` : ''}
      ${(t.tags || []).length ? `<div class="task-tags">${t.tags.map((x) => `<span class="task-tag">${esc(x)}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('');

  // Botón "raw": el CRUDO del procesamiento — la transcripción original que se
  // pegó + el JSON interpretado por la IA. Nace COLAPSADO (regla de UI). El
  // transcript viene del GET /api/audio/:id (presente en el flujo de análisis y
  // al abrir un informe); si faltara, se muestra solo el JSON.
  const rawJson = JSON.stringify(res, null, 2);
  const rawBlock = `
    <details class="au-raw"><summary>🧾 Raw · crudo del procesamiento</summary>
      ${job.transcript ? `<div class="au-raw-blk">
        <div class="au-raw-h">Transcripción original · ${job.transcript.length} chars</div>
        <pre class="au-raw-pre">${esc(job.transcript)}</pre></div>` : ''}
      <div class="au-raw-blk">
        <div class="au-raw-h">Resultado interpretado · JSON</div>
        <pre class="au-raw-pre">${esc(rawJson)}</pre></div>
    </details>`;

  // Título del informe (lo genera la IA): editable inline con ✏️.
  const titleBar = id ? `<div class="au-titlebar">
      <span class="au-title-txt">${esc(job.title || 'Sin título')}</span>
      <button class="btn-ghost btn--sm btn--icon au-title-edit" title="Editar título">✏️</button>
    </div>` : '';
  container.innerHTML = `
    ${titleBar}
    ${res.summary ? `<div class="au-summary">${esc(res.summary)}</div>` : ''}
    ${proposed.length ? `
      <div class="au-block au-tasks-block">
        <div class="au-block-head"><span>➕ Tareas propuestas (${proposed.length})</span>
          <div class="au-block-acts">
            <button class="btn-ghost btn--sm" data-ref="toplan" title="Crear un plan con estas tareas">🗺️ Pasar a plan</button>
            <button class="btn btn--sm" data-ref="addall"${allCreated ? ' disabled' : ''}>${allCreated ? '✓ Creadas' : 'Crear todas'}</button>
          </div></div>
        <div class="au-tasks">${tasks}</div>
      </div>` : '<div class="au-none">La IA no propuso tareas de este audio.</div>'}
    <details class="au-block" open><summary>🗣️ Segmentos (${res.segments?.length || 0})</summary>
      <ul class="au-segs">${segments || '<li class="bf-sub">—</li>'}</ul></details>
    ${res.plan?.length ? `<details class="au-block"><summary>🗺️ Plan (${res.plan.length})</summary><ol class="au-plan">${plan}</ol></details>` : ''}
    ${speakers ? `<details class="au-block"><summary>👥 Hablantes (${res.speakers.length})</summary><ul class="au-speakers">${speakers}</ul></details>` : ''}
    ${rawBlock}`;

  const createTasks = async (items) => {
    if (!items.length) return;
    await fetch('/api/tasks/from-audio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: id, tasks: items }),
    });
    bus?.dispatchEvent?.(new Event('tasks-changed'));
  };
  container.querySelectorAll('.au-task-add').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const t = res.proposedTasks[Number(btn.dataset.i)];
      btn.disabled = true; btn.textContent = '✓ Creada';
      await createTasks([t]);
    });
  });
  const addAll = container.querySelector('[data-ref="addall"]');
  if (addAll) addAll.addEventListener('click', async () => {
    addAll.disabled = true; addAll.textContent = '✓ Creadas';
    await createTasks(res.proposedTasks || []);
    container.querySelectorAll('.au-task-add').forEach((b) => { b.disabled = true; b.textContent = '✓ Creada'; });
  });

  // "Pasar a plan": crea un PLAN (título del audio) + todas las tareas propuestas
  // asignadas a ese plan. Reusa el CRUD existente (POST /plans + /from-audio con
  // planId por ítem → createTask valida el planId contra los planes reales).
  const toPlan = container.querySelector('[data-ref="toplan"]');
  if (toPlan) toPlan.addEventListener('click', async () => {
    const items = res.proposedTasks || [];
    if (!items.length) return;
    if (dialog?.confirmDialog) {
      const ok = await dialog.confirmDialog({
        title: 'Pasar a plan',
        message: `Se crea el plan “${job.title || 'Audio'}” y ${items.length} tarea(s) asignada(s). ¿Continuar?`,
        confirmLabel: 'Crear plan',
      });
      if (!ok) return;
    }
    toPlan.disabled = true; toPlan.textContent = '⏳ creando…';
    try {
      const pr = await fetch('/api/tasks/plans', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: job.title || 'Plan de audio', description: res.summary || '', status: 'active' }),
      });
      const plan = (await pr.json()).plan;
      await fetch('/api/tasks/from-audio', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id, tasks: items.map((t) => ({ ...t, planId: plan?.id || null })) }),
      });
      bus?.dispatchEvent?.(new Event('tasks-changed'));
      toPlan.textContent = '✓ Plan creado';
      container.querySelectorAll('.au-task-add').forEach((b) => { b.disabled = true; b.textContent = '✓ Creada'; });
      if (addAll) { addAll.disabled = true; addAll.textContent = '✓ Creadas'; }
    } catch { toPlan.disabled = false; toPlan.textContent = '🗺️ Pasar a plan'; }
  });

  // Edición INLINE del título (clic en ✏️ → input → Enter/blur guarda, Esc cancela).
  const editBtn = container.querySelector('.au-title-edit');
  if (editBtn && id) editBtn.addEventListener('click', () => {
    const span = container.querySelector('.au-title-txt');
    if (!span) return;
    const cur = job.title || '';
    const input = document.createElement('input');
    input.className = 'au-title-input'; input.value = cur; input.maxLength = 200;
    span.replaceWith(input); input.focus(); input.select();
    let settled = false;
    const finish = async (commit) => {
      if (settled) return; settled = true;
      let val = job.title || cur;
      if (commit) {
        const v = input.value.trim();
        if (v && v !== cur) {
          try {
            const r = await fetch(`/api/audio/${id}/title`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: v }) });
            if (r.ok) { job.title = v; val = v; }
          } catch { /* noop */ }
        }
      }
      const ns = document.createElement('span'); ns.className = 'au-title-txt'; ns.textContent = val || 'Sin título';
      input.replaceWith(ns);
      // Reflejar en el header del informe (pestaña Informes) si está montado.
      const sumT = container.closest('.au-report')?.querySelector('.au-report-title');
      if (sumT) sumT.textContent = val || 'Sin título';
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  });
}

// Abre el panel de extracción de audio (modal). ctx = { icon, dialog, bus }.
// Self-contained: carga su propio historial de análisis al abrir.
export function openAudioPanel(ctx) {
  const { icon, dialog, bus } = ctx;
  let jobs = [];

  const m = dialog.openModal({ title: 'Extracción de audio', width: '780px' });
  m.card.classList.add('au-card');
  m.body.innerHTML = `
    <div class="au-panel">
      <div class="au-intro">Pegá la transcripción del audio (ya pasada a texto). La IA interpreta
        <strong>quién dijo qué y por qué</strong>, le pone un <strong>título</strong>, arma un plan y
        propone tareas para Pendientes. El título se puede editar después.</div>
      <textarea class="au-input" data-ref="ta" rows="8" placeholder="Pegá acá la transcripción…"></textarea>
      <div class="au-actions">
        <span class="au-hint" data-ref="hint"></span>
        <button class="btn" data-ref="run">${icon('sparkle', { size: 14 })}<span>Analizar</span></button>
      </div>
      <div class="au-status" data-ref="status" hidden></div>
      <div class="au-result" data-ref="result"></div>
      <details class="au-history" data-ref="histbox" hidden><summary>🕑 Análisis anteriores</summary>
        <div class="au-hist-list" data-ref="hist"></div></details>
    </div>`;
  const q = (r) => m.body.querySelector(`[data-ref="${r}"]`);
  const ta = q('ta');
  const statusEl = q('status'); const resultEl = q('result'); const runBtn = q('run');

  function renderHistory() {
    const box = q('histbox'); const hist = q('hist');
    if (!jobs.length) { box.hidden = true; return; }
    box.hidden = false;
    box.querySelector('summary').textContent = `🕑 Análisis anteriores (${jobs.length})`;
    hist.innerHTML = jobs.map((j) => `
      <button class="au-hist-item" data-id="${j.id}">
        <span class="au-hist-title">${esc(j.title)}</span>
        <span class="au-hist-meta">${j.status === 'done' ? `${j.proposedCount} tarea(s)` : j.status === 'running' ? '⏳' : '✕'} · ${fmtAgo(j.createdAt)}</span>
      </button>`).join('');
    hist.querySelectorAll('.au-hist-item').forEach((b) =>
      b.addEventListener('click', () => openExisting(b.dataset.id)));
  }

  async function loadJobs() {
    try { jobs = (await (await fetch('/api/audio')).json()).jobs || []; } catch { /* noop */ }
    renderHistory();
  }

  let polling = false;
  async function pollJob(id) {
    for (let i = 0; i < 150 && polling; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      let job;
      try { job = await (await fetch(`/api/audio/${id}`)).json(); } catch { continue; }
      if (!job || job.status === 'running') continue;
      return job;
    }
    return null;
  }

  async function analyze() {
    const transcript = ta.value.trim();
    if (transcript.length < 10) { statusEl.hidden = false; statusEl.className = 'au-status au-status--err'; statusEl.textContent = 'Pegá la transcripción primero.'; return; }
    const ok = await dialog.confirmDialog({
      title: 'Analizar audio',
      message: 'Se interpreta la transcripción con Claude (sonnet). CONSUME TOKENS reales y puede tardar hasta ~2 min. Es de solo lectura.',
      confirmLabel: 'Analizar',
    });
    if (!ok) return;
    runBtn.disabled = true;
    resultEl.innerHTML = '';
    statusEl.hidden = false;
    statusEl.className = 'au-status';
    statusEl.innerHTML = `${pacman({ state: 'delegating' })} <span>interpretando el audio…</span>`;
    polling = true;
    try {
      const res = await fetch('/api/audio/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const started = await res.json();
      if (!res.ok) throw new Error(started.error || 'No se pudo iniciar el análisis.');
      const job = started.status === 'done' ? started : await pollJob(started.id);
      if (!job) throw new Error('El análisis se interrumpió. Reintentá.');
      if (job.status === 'error') throw new Error(job.error || 'El análisis falló.');
      statusEl.hidden = true;
      renderResult(resultEl, job, started.id || job.id, bus, dialog);
      await loadJobs();
    } catch (e) {
      statusEl.className = 'au-status au-status--err';
      statusEl.textContent = e.message || 'Error al analizar.';
    } finally {
      runBtn.disabled = false;
      polling = false;
    }
  }

  async function openExisting(id) {
    statusEl.hidden = false; statusEl.className = 'au-status'; statusEl.innerHTML = 'cargando…';
    resultEl.innerHTML = '';
    try {
      const job = await (await fetch(`/api/audio/${id}`)).json();
      ta.value = job.transcript || '';
      statusEl.hidden = true;
      if (job.status === 'done') renderResult(resultEl, job, id, bus, dialog);
      else if (job.status === 'error') { statusEl.hidden = false; statusEl.className = 'au-status au-status--err'; statusEl.textContent = job.error || 'Ese análisis falló.'; }
    } catch { statusEl.className = 'au-status au-status--err'; statusEl.textContent = 'No se pudo cargar.'; }
  }

  runBtn.addEventListener('click', analyze);
  const orig = m.close;
  m.close = () => { polling = false; orig(); };
  setTimeout(() => ta.focus(), 30);
  loadJobs();
}

// Monta la PESTAÑA "Informes" dentro del tablero de Pendientes: cada audio
// procesado como un informe COLAPSABLE (regla de UI: header compacto + detalle
// tipo árbol a demanda). El "producto del procesamiento" (resumen/segmentos/
// plan/tareas/hablantes) se renderiza al expandir con GET /api/audio/:id, e
// incluye el botón "raw" (transcripción + JSON). ctx = { icon, dialog, bus }.
// Devuelve { reload } para refrescar la lista tras analizar un audio nuevo.
export function mountReports(container, ctx) {
  const { icon, bus, dialog } = ctx;
  container.innerHTML = `
    <div class="au-reports">
      <div class="au-reports-head">
        <span class="au-reports-title">Informes de audio</span>
        <button class="btn btn--sm" data-ref="new" title="Analizar una transcripción de audio (consume tokens)">${icon('mic', { size: 13 })}<span>Analizar audio</span></button>
      </div>
      <div class="au-reports-list" data-ref="list">cargando…</div>
    </div>`;
  const listEl = container.querySelector('[data-ref="list"]');

  function reportRow(j) {
    const meta = j.status === 'done'
      ? `${j.proposedCount} tarea(s) · ${j.chars || 0} chars`
      : j.status === 'running' ? '⏳ en curso' : '✕ error';
    return `<details class="au-report" data-id="${esc(j.id)}">
      <summary class="au-report-sum">
        <span class="au-report-ico">🎙️</span>
        <span class="au-report-title">${esc(j.title)}</span>
        <span class="au-report-meta">${meta} · ${fmtAgo(j.createdAt)}</span>
      </summary>
      <div class="au-report-body">cargando…</div>
    </details>`;
  }

  async function load() {
    let jobs = [];
    try { jobs = (await (await fetch('/api/audio')).json()).jobs || []; } catch { /* noop */ }
    if (!jobs.length) {
      listEl.innerHTML = '<div class="au-none">Todavía no analizaste ningún audio. Usá “Analizar audio” para crear el primer informe.</div>';
      return;
    }
    listEl.innerHTML = jobs.map(reportRow).join('');
    listEl.querySelectorAll('.au-report').forEach((det) => {
      det.addEventListener('toggle', async () => {
        if (!det.open || det.dataset.loaded) return;
        det.dataset.loaded = '1';
        const body = det.querySelector('.au-report-body');
        body.innerHTML = '<div class="au-status">cargando…</div>';
        try {
          const job = await (await fetch(`/api/audio/${det.dataset.id}`)).json();
          if (job.status === 'done') renderResult(body, job, det.dataset.id, bus, dialog);
          else if (job.status === 'error') { body.innerHTML = `<div class="au-status au-status--err">${esc(job.error || 'Ese análisis falló.')}</div>`; }
          else body.innerHTML = '<div class="au-status">El análisis sigue en curso. Volvé a abrir en un rato.</div>';
        } catch { body.innerHTML = '<div class="au-status au-status--err">No se pudo cargar el informe.</div>'; }
      });
    });
  }

  container.querySelector('[data-ref="new"]').addEventListener('click', () => {
    // Al cerrar el panel de análisis, refrescamos la lista (puede haber un
    // informe nuevo). openAudioPanel abre su propio modal encima.
    openAudioPanel({ ...ctx, bus: wrapBusReload(bus, load) });
  });

  load();
  return { reload: load };
}

// Envuelve el bus para refrescar la lista de informes cuando el panel de
// análisis crea tareas (señal de que hubo un análisis nuevo).
function wrapBusReload(bus, reload) {
  if (!bus) return bus;
  return {
    dispatchEvent: (ev) => { try { reload(); } catch { /* noop */ } return bus.dispatchEvent(ev); },
    addEventListener: bus.addEventListener?.bind(bus),
    removeEventListener: bus.removeEventListener?.bind(bus),
  };
}
