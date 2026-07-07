// modules/tasks/tasks.js — "Pendientes": tablero PRIVADO de tareas de este
// proyecto en el sidebar. Versión simplificada de "Bugs & Features": una
// tarjeta = una tarea (título, detalle, prioridad, estado, tags, fecha).
//
// UI colapsable (regla del proyecto): la sección del sidebar muestra solo un
// header compacto con el semáforo + conteos; el detalle vive en un TABLERO
// modal (openModal) que se abre bajo demanda.
//
// Se alimenta manual Y desde el módulo `audio`, que YA NO tiene sección propia:
// vive DENTRO de Pendientes (pedido del usuario). El botón "Analizar audio"
// (admin, consume tokens) abre openAudioPanel; al crear tareas desde una
// transcripción, audio dispara `tasks-changed` y este módulo se refresca.
import { openAudioPanel, mountReports } from '../audio/audio.js';
const STATUS = [
  { key: 'pendiente', label: 'Pendiente', emoji: '⚪' },
  { key: 'en-progreso', label: 'En progreso', emoji: '🔵' },
  { key: 'hecha', label: 'Hecha', emoji: '✅' },
];
const PRIO = [
  { key: 'alta', label: 'Alta', emoji: '🔴' },
  { key: 'media', label: 'Media', emoji: '🟡' },
  { key: 'baja', label: 'Baja', emoji: '🟢' },
];
const TYPE = [
  { key: 'task', label: 'Tarea', emoji: '🔹' },
  { key: 'idea', label: 'Idea', emoji: '💡' },
  { key: 'nota', label: 'Nota', emoji: '📝' },
  { key: 'feature', label: 'Feature', emoji: '✨' },
];
const PLAN_STATUS = [
  { key: 'active', label: 'Activo', emoji: '🟢' },
  { key: 'proposed', label: 'Propuesto', emoji: '💭' },
  { key: 'done', label: 'Completado', emoji: '✅' },
  { key: 'cancelled', label: 'Cancelado', emoji: '🚫' },
];
const statusOf = (k) => STATUS.find((s) => s.key === k) || STATUS[0];
const prioOf = (k) => PRIO.find((p) => p.key === k) || PRIO[1];
const typeOf = (k) => TYPE.find((x) => x.key === k) || TYPE[0];
const planStatusOf = (k) => PLAN_STATUS.find((x) => x.key === k) || PLAN_STATUS[0];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const day = d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  const s = Math.floor((Date.now() - ms) / 1000);
  let ago = 'recién';
  if (s >= 86400) ago = `hace ${Math.floor(s / 86400)} d`;
  else if (s >= 3600) ago = `hace ${Math.floor(s / 3600)} h`;
  else if (s >= 60) ago = `hace ${Math.floor(s / 60)} min`;
  return `${day} · ${ago}`;
}

export default {
  name: 'tasks',

  mount(el, ctx) {
    const { icon, dialog } = ctx;
    let counts = { pendiente: 0, 'en-progreso': 0, hecha: 0, total: 0 };
    let boardApi = null; // { reload } cuando el tablero está abierto
    let isAdmin = false;  // el análisis de audio requiere admin (consume tokens)

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="Tareas pendientes"></span>
        <span class="sec-title">Pendientes</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="add" title="Nueva tarea">${icon('plus', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="task-mini" data-ref="mini">cargando…</div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm btn--block" data-ref="board">${icon('checklist', { size: 13 })}<span>Abrir tablero</span></button>
        </div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    function renderMini() {
      const pend = counts.pendiente || 0;
      const prog = counts['en-progreso'] || 0;
      const done = counts.hecha || 0;
      refs.count.textContent = counts.total ? String(pend + prog) : '';
      if (refs.dot) {
        const dstate = pend > 0 ? 'warn' : (counts.total ? 'ok' : 'idle');
        refs.dot.className = `sec-dot sec-dot--${dstate}`;
        refs.dot.title = counts.total ? `${pend} pendiente(s) · ${prog} en progreso · ${done} hecha(s)` : 'Sin tareas';
      }
      refs.mini.innerHTML = counts.total
        ? `<span class="task-chip">⚪ ${pend}</span><span class="task-chip">🔵 ${prog}</span><span class="task-chip">✅ ${done}</span>`
        : '<span class="bf-sub">Sin tareas · creá la primera con ＋</span>';
    }

    async function loadCounts() {
      try {
        const d = await (await fetch('/api/tasks')).json();
        counts = d.counts || counts;
      } catch { /* noop */ }
      renderMini();
    }

    // ===== Formulario de alta/edición (openModal con inputs propios) =====
    // `plans` = lista de planes disponibles para asignar la tarea a uno.
    function taskForm(existing, plans = []) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; resolve(v); };
        const isEdit = !!existing;
        const t = existing || { title: '', description: '', type: 'task', priority: 'media', status: 'pendiente', tags: [], planId: null };
        const m = dialog.openModal({ title: isEdit ? `Editar ${t.id}` : 'Nueva tarea', width: '520px', onClose: () => finish(null) });
        const planOpts = `<option value="">— sin plan —</option>${plans.map((p) => `<option value="${p.id}"${p.id === t.planId ? ' selected' : ''}>${esc(p.title)}</option>`).join('')}`;
        m.body.innerHTML = `
          <div class="task-form">
            <label class="task-fld"><span>Título</span>
              <input type="text" data-f="title" maxlength="200" placeholder="Qué hay que hacer" value="${esc(t.title)}" /></label>
            <label class="task-fld"><span>Detalle</span>
              <textarea data-f="description" rows="4" maxlength="4000" placeholder="Contexto, por qué, notas…">${esc(t.description)}</textarea></label>
            <div class="task-form-row">
              <label class="task-fld"><span>Tipo</span>
                <select data-f="type">${TYPE.map((x) => `<option value="${x.key}"${x.key === (t.type || 'task') ? ' selected' : ''}>${x.emoji} ${x.label}</option>`).join('')}</select></label>
              <label class="task-fld"><span>Prioridad</span>
                <select data-f="priority">${PRIO.map((p) => `<option value="${p.key}"${p.key === t.priority ? ' selected' : ''}>${p.emoji} ${p.label}</option>`).join('')}</select></label>
              <label class="task-fld"><span>Estado</span>
                <select data-f="status">${STATUS.map((s) => `<option value="${s.key}"${s.key === t.status ? ' selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}</select></label>
            </div>
            <label class="task-fld"><span>Plan</span>
              <select data-f="planId">${planOpts}</select></label>
            <label class="task-fld"><span>Tags (coma)</span>
              <input type="text" data-f="tags" placeholder="cliente, urgente" value="${esc((t.tags || []).join(', '))}" /></label>
          </div>
          <div class="dlg-actions">
            <button class="btn-ghost" data-a="cancel">Cancelar</button>
            <button class="btn" data-a="save">${isEdit ? 'Guardar' : 'Crear'}</button>
          </div>`;
        const get = (f) => m.body.querySelector(`[data-f="${f}"]`).value;
        m.body.querySelector('[data-a="cancel"]').addEventListener('click', () => m.close());
        m.body.querySelector('[data-a="save"]').addEventListener('click', () => {
          const payload = {
            title: get('title').trim(),
            description: get('description'),
            type: get('type'),
            priority: get('priority'),
            status: get('status'),
            planId: get('planId') || null,
            tags: get('tags').split(',').map((x) => x.trim()).filter(Boolean),
          };
          if (!payload.title) { m.body.querySelector('[data-f="title"]').focus(); return; }
          finish(payload);
          m.close();
        });
        setTimeout(() => m.body.querySelector('[data-f="title"]')?.focus(), 30);
      });
    }

    // Formulario de alta/edición de un PLAN.
    function planForm(existing) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (settled) return; settled = true; resolve(v); };
        const isEdit = !!existing;
        const p = existing || { title: '', description: '', status: 'active' };
        const m = dialog.openModal({ title: isEdit ? `Editar ${p.id}` : 'Nuevo plan', width: '520px', onClose: () => finish(null) });
        m.body.innerHTML = `
          <div class="task-form">
            <label class="task-fld"><span>Título</span>
              <input type="text" data-f="title" maxlength="200" placeholder="Nombre del plan" value="${esc(p.title)}" /></label>
            <label class="task-fld"><span>Detalle</span>
              <textarea data-f="description" rows="3" maxlength="4000" placeholder="Objetivo del plan…">${esc(p.description)}</textarea></label>
            <label class="task-fld"><span>Estado</span>
              <select data-f="status">${PLAN_STATUS.map((s) => `<option value="${s.key}"${s.key === p.status ? ' selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}</select></label>
          </div>
          <div class="dlg-actions">
            <button class="btn-ghost" data-a="cancel">Cancelar</button>
            <button class="btn" data-a="save">${isEdit ? 'Guardar' : 'Crear'}</button>
          </div>`;
        const get = (f) => m.body.querySelector(`[data-f="${f}"]`).value;
        m.body.querySelector('[data-a="cancel"]').addEventListener('click', () => m.close());
        m.body.querySelector('[data-a="save"]').addEventListener('click', () => {
          const payload = { title: get('title').trim(), description: get('description'), status: get('status') };
          if (!payload.title) { m.body.querySelector('[data-f="title"]').focus(); return; }
          finish(payload);
          m.close();
        });
        setTimeout(() => m.body.querySelector('[data-f="title"]')?.focus(), 30);
      });
    }

    async function addTask() {
      let plans = [];
      try { plans = (await (await fetch('/api/tasks/plans')).json()).plans || []; } catch { /* noop */ }
      const payload = await taskForm(null, plans);
      if (!payload) return;
      await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      await loadCounts();
      boardApi?.reload();
    }

    // ===== Tablero (modal) con pestañas =====
    // Inspirado en cómo Pad organiza su dashboard (Active Work / Needs Attention
    // / Up Next / Collections / Recent Activity) pero alimentado 100% con datos
    // LOCALES de la consola (tareas + informes de audio + sesiones de trabajo),
    // 0 tokens, todo DERIVADO. Pad es solo el REFERENTE de diseño, NO la fuente.
    function openBoard(initialTab = 'panel') {
      let tab = initialTab;         // panel | tareas | planes | informes
      let filter = 'activas';       // filtro de la pestaña Tareas: activas | todas | hecha
      let tasks = [];
      let plans = [];               // /api/tasks → planes con progreso derivado
      let activity = [];            // /api/tasks/activity → log real de cambios
      let chats = [];               // /api/chat/list → trabajos en sesiones
      let audio = [];               // /api/audio → informes
      let reportsApi = null;        // { reload } de la pestaña Informes
      const m = dialog.openModal({ title: 'Pendientes', width: '820px', onClose: () => { boardApi = null; } });
      m.card.classList.add('task-board-card');
      m.body.innerHTML = `
        <div class="task-board">
          <div class="tk-tabs" data-ref="tabs"></div>
          <div class="tk-pane" data-ref="pane"></div>
        </div>`;
      const tabsEl = m.body.querySelector('[data-ref="tabs"]');
      const paneEl = m.body.querySelector('[data-ref="pane"]');
      const TABS = [
        { key: 'panel', label: '📊 Panel' },
        { key: 'tareas', label: '📋 Tareas' },
        { key: 'planes', label: '🗺️ Planes' },
        { key: 'informes', label: '🎙️ Informes' },
      ];
      const audioCtx = { icon, dialog, bus: ctx.bus };

      function renderTabs() {
        tabsEl.innerHTML = TABS.map((t) => {
          let n = '';
          if (t.key === 'tareas') n = (counts.pendiente || 0) + (counts['en-progreso'] || 0);
          else if (t.key === 'planes') n = plans.length;
          else if (t.key === 'informes') n = audio.length;
          const badge = (n !== '' && n) ? ` <span class="tk-tab-n">${n}</span>` : '';
          return `<button class="tk-tab${t.key === tab ? ' on' : ''}" data-tab="${t.key}">${t.label}${badge}</button>`;
        }).join('');
      }

      // ---------- pestaña Tareas: cuadritos en columnas (estilo Bugs v2) ----------
      // Cada tarjeta nace CONTRAÍDA (solo lo esencial); al hacer clic se abre el
      // DETALLE en una ventana nueva (modal) — pedido del usuario 2026-07-06.
      function taskCardV2(t) {
        const st = statusOf(t.status);
        const pr = prioOf(t.priority);
        const ty = typeOf(t.type);
        const plan = t.planId ? plans.find((p) => p.id === t.planId) : null;
        const src = t.source === 'audio' ? '🎙️ ' : '';
        return `<div class="task-cardv2 task-cardv2--${t.status}" data-open="${t.id}" role="button" tabindex="0" title="Abrir ${t.id}">
          <div class="task-cardv2-top">
            <span class="task-type" title="${ty.label}">${ty.emoji}</span>
            <span class="task-cardv2-id">${t.id}</span>
            <span class="task-prio task-prio--${t.priority}" title="Prioridad ${pr.label}">${pr.emoji}</span>
            <span class="task-cardv2-status" title="${st.label}">${st.emoji}</span>
          </div>
          <div class="task-cardv2-title">${src}${esc(t.title)}</div>
          ${plan ? `<div class="task-cardv2-foot"><span class="task-plan">🗺️ ${esc(plan.title)}</span></div>` : ''}
        </div>`;
      }

      // Detalle de UNA tarea en ventana nueva (modal) + acciones.
      function openTaskDetail(t) {
        const st = statusOf(t.status);
        const pr = prioOf(t.priority);
        const ty = typeOf(t.type);
        const plan = t.planId ? plans.find((p) => p.id === t.planId) : null;
        const dm = dialog.openModal({ title: `${ty.emoji} ${t.id}`, width: '560px' });
        dm.card.classList.add('task-detail-card');
        const advanceBtn = t.status === 'pendiente'
          ? '<button class="btn btn--sm" data-da="advance">▶ En progreso</button>'
          : t.status === 'en-progreso'
            ? '<button class="btn btn--sm" data-da="advance">✅ Marcar hecha</button>'
            : '<button class="btn-ghost btn--sm" data-da="reopen">↩ Reabrir</button>';
        dm.body.innerHTML = `
          <div class="task-detail">
            <div class="task-detail-title">${esc(t.title)}</div>
            <div class="task-detail-chips">
              <span class="task-chip2">${ty.emoji} ${ty.label}</span>
              <span class="task-chip2">${pr.emoji} ${pr.label}</span>
              <span class="task-chip2">${st.emoji} ${st.label}</span>
              ${plan ? `<span class="task-chip2 task-chip2--plan">🗺️ ${esc(plan.title)}${plan.taskCount ? ` · ${plan.pct}%` : ''}</span>` : ''}
              ${t.source === 'audio' ? '<span class="task-chip2">🎙️ desde audio</span>' : ''}
            </div>
            ${t.description ? `<div class="task-detail-desc">${esc(t.description)}</div>` : '<div class="dash-empty">Sin descripción.</div>'}
            ${(t.tags || []).length ? `<div class="task-tags">${t.tags.map((x) => `<span class="task-tag">${esc(x)}</span>`).join('')}</div>` : ''}
            <div class="task-detail-dates">
              <span>${icon('clock', { size: 11 })} Creada ${fmtDate(t.createdAt)}</span>
              ${t.updatedAt && t.updatedAt !== t.createdAt ? `<span>✏️ ${fmtDate(t.updatedAt)}</span>` : ''}
              ${t.doneAt ? `<span>✅ ${fmtDate(t.doneAt)}</span>` : ''}
            </div>
            <div class="task-detail-acts">
              ${advanceBtn}
              <button class="btn-ghost btn--sm" data-da="edit">${icon('edit', { size: 13 })}<span>Editar</span></button>
              <button class="btn-ghost btn--sm" data-da="del">${icon('trash', { size: 13 })}<span>Eliminar</span></button>
            </div>
          </div>`;
        dm.body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-da]');
          if (!b) return;
          const a = b.dataset.da;
          if (a === 'advance') { await patch(t.id, { status: t.status === 'pendiente' ? 'en-progreso' : 'hecha' }); dm.close(); return; }
          if (a === 'reopen') { await patch(t.id, { status: 'pendiente' }); dm.close(); return; }
          if (a === 'edit') { const p = await taskForm(t, plans); if (p) await patch(t.id, p); dm.close(); return; }
          if (a === 'del') {
            const ok = await dialog.confirmDialog({ title: 'Eliminar tarea', message: `¿Eliminar “${t.title}”? No se puede deshacer.`, confirmLabel: 'Eliminar', danger: true });
            if (ok) { await fetch(`/api/tasks/${t.id}/delete`, { method: 'POST' }); await boardApi.reload(); }
            dm.close();
            return;
          }
        });
      }

      function tareasHtml() {
        const FILT = [
          { key: 'activas', label: 'Activas' },
          { key: 'todas', label: 'Todas' },
          { key: 'hecha', label: '✅ Hechas' },
        ];
        return `
          <div class="task-board-head">
            <div class="task-filters">${FILT.map((f) => `<button class="task-filter${f.key === filter ? ' is-on' : ''}" data-filt="${f.key}">${f.label}</button>`).join('')}</div>
            <div class="task-board-actions">
              ${isAdmin ? `<button class="btn-ghost btn--sm" data-a="audio" title="Analizar una transcripción de audio (consume tokens)">${icon('mic', { size: 13 })}<span>Audio</span></button>` : ''}
              <button class="btn btn--sm" data-a="new">${icon('plus', { size: 13 })}<span>Nueva</span></button>
            </div>
          </div>
          <div class="task-grid" data-ref="list">cargando…</div>`;
      }

      function renderList() {
        const listEl = paneEl.querySelector('[data-ref="list"]');
        if (!listEl) return;
        const shown = tasks.filter((t) => filter === 'todas' ? true : filter === 'hecha' ? t.status === 'hecha' : t.status !== 'hecha');
        listEl.innerHTML = shown.length
          ? shown.map(taskCardV2).join('')
          : '<div class="task-empty">Nada por acá. Creá una tarea con “Nueva”.</div>';
      }

      // ---------- pestaña Planes ----------
      function progressBar(pct) {
        return `<div class="dash-bar"><span class="dash-bar-fill" style="width:${pct}%"></span></div>`;
      }
      function planCard(p) {
        const st = planStatusOf(p.status);
        const own = tasks.filter((t) => t.planId === p.id);
        const subtasks = own.length
          ? own.map((t) => `<div class="plan-task"><span>${statusOf(t.status).emoji}</span><span class="dash-item-title">${esc(t.title)}</span></div>`).join('')
          : '<div class="dash-empty">Sin tareas asignadas. Asigná tareas a este plan desde el campo “Plan” de cada tarea.</div>';
        return `<details class="plan-item" data-id="${p.id}">
          <summary class="plan-sum">
            <span class="plan-status" title="${st.label}">${st.emoji}</span>
            <span class="plan-title">${esc(p.title)}</span>
            <span class="plan-meta">${p.doneCount}/${p.taskCount} · ${p.pct}%</span>
          </summary>
          <div class="plan-body">
            ${progressBar(p.pct)}
            ${p.description ? `<div class="task-desc">${esc(p.description)}</div>` : ''}
            <div class="plan-tasks">${subtasks}</div>
            <div class="plan-actions">
              <button class="btn-ghost btn--sm" data-pact="edit" data-id="${p.id}">${icon('edit', { size: 13 })}<span>Editar</span></button>
              <button class="btn-ghost btn--sm" data-pact="del" data-id="${p.id}">${icon('trash', { size: 13 })}<span>Eliminar</span></button>
            </div>
          </div>
        </details>`;
      }
      function planesHtml() {
        return `
          <div class="task-board-head">
            <span class="tk-pane-title">Planes que agrupan tareas con progreso</span>
            <div class="task-board-actions">
              <button class="btn btn--sm" data-a="newplan">${icon('plus', { size: 13 })}<span>Nuevo plan</span></button>
            </div>
          </div>
          <div class="plan-list">${plans.length ? plans.map(planCard).join('') : '<div class="task-empty">Todavía no hay planes. Creá uno con “Nuevo plan” y asigná tareas desde su campo “Plan”.</div>'}</div>`;
      }

      // ---------- pestaña Panel (dashboard derivado) ----------
      const PRIO_RANK = { alta: 0, media: 1, baja: 2 };
      const STALE_MS = 3 * 24 * 60 * 60 * 1000;

      function dashSec(title, count, bodyHtml, { open = false } = {}) {
        return `<details class="dash-sec"${open ? ' open' : ''}>
          <summary class="dash-sec-h"><span class="dash-sec-t">${title}</span><span class="dash-sec-n">${count}</span></summary>
          <div class="dash-sec-b">${bodyHtml}</div></details>`;
      }
      const dashEmpty = (txt) => `<div class="dash-empty">${esc(txt)}</div>`;

      function taskLine(t) {
        const pr = prioOf(t.priority);
        return `<div class="dash-item" data-goto="${t.id}">
          <span class="dash-item-ico">${pr.emoji}</span>
          <span class="dash-item-title">${esc(t.title)}</span>
          <span class="dash-item-meta">${statusOf(t.status).emoji} ${fmtDate(t.updatedAt || t.createdAt)}</span>
        </div>`;
      }
      function chatLine(c) {
        const state = c.delegating ? '🟣 delegando' : '🟠 trabajando';
        const tk = c.ticketNumber ? ` · ${esc(String(c.ticketNumber))}` : '';
        return `<div class="dash-item dash-item--chat">
          <span class="dash-item-ico">💻</span>
          <span class="dash-item-title">${esc(c.title || 'Sesión')}</span>
          <span class="dash-item-meta">${state}${tk}</span>
        </div>`;
      }

      function panelHtml() {
        const active = tasks.filter((t) => t.status === 'en-progreso');
        const pend = tasks.filter((t) => t.status === 'pendiente');
        const done = tasks.filter((t) => t.status === 'hecha');
        const workChats = chats.filter((c) => c.status === 'working' || c.delegating);
        const now = Date.now();

        // 🔥 En curso
        const enCurso = [...active.map(taskLine), ...workChats.map(chatLine)].join('');

        // ⚠️ Necesita atención: en progreso estancadas + alta prioridad sin arrancar
        const stalled = active.filter((t) => (now - (t.updatedAt || t.createdAt)) > STALE_MS);
        const highPend = pend.filter((t) => t.priority === 'alta');
        const attn = [
          ...stalled.map((t) => `<div class="dash-item dash-item--warn"><span class="dash-item-ico">⚠️</span><span class="dash-item-title">${esc(t.title)}</span><span class="dash-item-meta">en progreso, sin cambios ${fmtDate(t.updatedAt || t.createdAt)}</span></div>`),
          ...highPend.map((t) => `<div class="dash-item dash-item--warn"><span class="dash-item-ico">🔴</span><span class="dash-item-title">${esc(t.title)}</span><span class="dash-item-meta">alta prioridad, sin arrancar</span></div>`),
        ].join('');

        // ⏭️ Up Next: activas por prioridad + antigüedad
        const upnext = [...active, ...pend]
          .sort((a, b) => (PRIO_RANK[a.priority] - PRIO_RANK[b.priority]) || ((a.createdAt || 0) - (b.createdAt || 0)))
          .slice(0, 3)
          .map((t, i) => `<div class="dash-next" data-goto="${t.id}"><span class="dash-next-n">${i + 1}</span><span class="dash-item-title">${esc(t.title)}</span><span class="dash-item-meta">${prioOf(t.priority).emoji} ${statusOf(t.status).label}</span></div>`).join('');

        // 📊 Planes activos (Active Plans): barra de progreso por plan
        const activePlans = plans.filter((p) => p.status === 'active' || p.status === 'proposed');
        const plansBars = activePlans.map((p) => `<div class="dash-plan" data-goto-plan="${p.id}">
          <div class="dash-plan-top"><span class="dash-item-title">${esc(p.title)}</span><span class="dash-item-meta">${p.doneCount}/${p.taskCount} · ${p.pct}%</span></div>
          ${progressBar(p.pct)}</div>`).join('');

        // 🗂️ Clasificación (Collections)
        const tagCount = {};
        for (const t of tasks) for (const g of (t.tags || [])) tagCount[g] = (tagCount[g] || 0) + 1;
        const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const typeCount = {};
        for (const t of tasks) typeCount[t.type || 'task'] = (typeCount[t.type || 'task'] || 0) + 1;
        const typePills = TYPE.filter((ty) => typeCount[ty.key]).map((ty) => `<span class="dash-pill">${ty.emoji} ${typeCount[ty.key]} ${ty.label.toLowerCase()}</span>`).join('');
        const proposed = audio.reduce((s, j) => s + (j.proposedCount || 0), 0);
        const classif = `
          <div class="dash-coll">
            <div class="dash-coll-card">
              <div class="dash-coll-h">📋 Tareas <span>${tasks.length}</span></div>
              <div class="dash-coll-b">
                <span class="dash-pill">⚪ ${pend.length} pend.</span>
                <span class="dash-pill">🔵 ${active.length} en curso</span>
                <span class="dash-pill">✅ ${done.length} hechas</span>
              </div>
            </div>
            <div class="dash-coll-card">
              <div class="dash-coll-h">🗺️ Planes <span>${plans.length}</span></div>
              <div class="dash-coll-b"><span class="dash-pill">${activePlans.length} activos</span></div>
            </div>
            <div class="dash-coll-card">
              <div class="dash-coll-h">🎙️ Informes <span>${audio.length}</span></div>
              <div class="dash-coll-b"><span class="dash-pill">${proposed} tarea(s) propuestas</span></div>
            </div>
            <div class="dash-coll-card">
              <div class="dash-coll-h">💻 Sesiones <span>${chats.length}</span></div>
              <div class="dash-coll-b"><span class="dash-pill">${workChats.length} trabajando ahora</span></div>
            </div>
          </div>
          ${typePills ? `<div class="dash-tags">${typePills}</div>` : ''}
          ${topTags.length ? `<div class="dash-tags">${topTags.map(([g, n]) => `<span class="task-tag">${esc(g)} · ${n}</span>`).join('')}</div>` : ''}`;

        // 🕑 Actividad reciente: LOG REAL persistido (tareas/planes) + audios
        const ICO = { created: '➕', completed: '✅', status: '🔄', updated: '✏️', deleted: '🗑️' };
        const actText = (ev) => {
          const who = ev.entity === 'plan' ? 'el plan ' : '';
          if (ev.kind === 'created') return `Creaste ${who}${ev.entity !== 'plan' && ev.refId ? `${ev.refId} ` : ''}“${ev.title}”`;
          if (ev.kind === 'completed') return `Completaste “${ev.title}”`;
          if (ev.kind === 'status') return `${ev.refId || ''} → ${ev.detail || ''} · “${ev.title}”`;
          if (ev.kind === 'updated') return `Actualizaste ${who}“${ev.title}”`;
          if (ev.kind === 'deleted') return `Eliminaste ${who}“${ev.title}”`;
          return ev.title || '';
        };
        const acts = activity.map((ev) => ({ ts: ev.ts, ico: ICO[ev.kind] || '•', txt: actText(ev) }));
        for (const j of audio) acts.push({ ts: j.createdAt, ico: '🎙️', txt: `Analizaste el audio “${j.title}”${j.proposedCount ? ` (${j.proposedCount} tarea/s)` : ''}` });
        acts.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const recent = acts.slice(0, 14).map((a) => `<div class="dash-act"><span class="dash-act-ico">${a.ico}</span><span class="dash-act-txt">${esc(a.txt)}</span><span class="dash-act-ts">${fmtDate(a.ts)}</span></div>`).join('');

        // Orden (pedido del usuario 2026-07-06): CLASIFICACIÓN primero (resumen
        // de todo, nace abierta), después el resto del dashboard.
        return `<div class="dash">
          ${dashSec('🗂️ Clasificación', tasks.length + audio.length + plans.length, classif, { open: true })}
          ${dashSec('🔥 En curso', active.length + workChats.length, enCurso || dashEmpty('Nada en curso ahora.'), { open: true })}
          ${dashSec('⚠️ Necesita atención', stalled.length + highPend.length, attn || dashEmpty('Todo en orden, sin alertas.'), { open: (stalled.length + highPend.length) > 0 })}
          ${dashSec('⏭️ Seguí por acá', Math.min(3, active.length + pend.length), upnext || dashEmpty('No hay tareas activas.'), { open: true })}
          ${dashSec('📊 Planes activos', activePlans.length, plansBars || dashEmpty('Sin planes activos. Creá uno en la pestaña Planes.'), { open: activePlans.length > 0 })}
          ${dashSec('🕑 Actividad reciente', Math.min(14, acts.length), recent || dashEmpty('Sin actividad todavía.'))}
        </div>`;
      }

      // ---------- orquestación de pestañas ----------
      async function loadData() {
        // /api/tasks ya trae tasks + counts + plans (con progreso) en un request.
        try { const d = await (await fetch('/api/tasks')).json(); tasks = d.tasks || []; counts = d.counts || counts; plans = d.plans || []; } catch { /* noop */ }
        try { const d = await (await fetch('/api/tasks/activity')).json(); activity = d.events || []; } catch { activity = []; }
        try { const d = await (await fetch('/api/chat/list')).json(); chats = d.chats || []; } catch { chats = []; }
        try { const d = await (await fetch('/api/audio')).json(); audio = d.jobs || []; } catch { audio = []; }
        renderMini();
      }

      function showTab(next) {
        tab = next;
        renderTabs();
        reportsApi = null;
        if (tab === 'informes') { reportsApi = mountReports(paneEl, audioCtx); return; }
        if (tab === 'panel') { paneEl.innerHTML = panelHtml(); return; }
        if (tab === 'planes') { paneEl.innerHTML = planesHtml(); return; }
        paneEl.innerHTML = tareasHtml();
        renderList();
      }

      function refreshCurrent() {
        renderTabs();
        if (tab === 'panel') paneEl.innerHTML = panelHtml();
        else if (tab === 'planes') paneEl.innerHTML = planesHtml();
        else if (tab === 'tareas') renderList();
        else if (tab === 'informes') reportsApi?.reload?.();
      }

      async function patch(id, body) {
        await fetch(`/api/tasks/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await boardApi.reload();
      }
      boardApi = { reload: async () => { await loadData(); refreshCurrent(); } };

      tabsEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (b) showTab(b.dataset.tab);
      });

      paneEl.addEventListener('click', async (e) => {
        // Abrir el detalle de una tarea (cuadrito de la pestaña Tareas) en modal.
        const openBtn = e.target.closest('[data-open]');
        if (openBtn) { const t = tasks.find((x) => x.id === openBtn.dataset.open); if (t) openTaskDetail(t); return; }
        // Ir a la pestaña Tareas / Planes desde un ítem del Panel.
        const gotoPlan = e.target.closest('[data-goto-plan]');
        if (gotoPlan && tab === 'panel') { showTab('planes'); return; }
        const goto = e.target.closest('[data-goto]');
        if (goto && tab === 'panel') { filter = 'todas'; showTab('tareas'); return; }
        const filt = e.target.closest('[data-filt]');
        if (filt) { filter = filt.dataset.filt; paneEl.querySelectorAll('.task-filter').forEach((x) => x.classList.toggle('is-on', x.dataset.filt === filter)); renderList(); return; }
        if (e.target.closest('[data-a="audio"]')) { openAudioPanel(audioCtx); return; }
        const nb = e.target.closest('[data-a="new"]');
        if (nb) { const p = await taskForm(null, plans); if (p) { await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); await boardApi.reload(); } return; }
        // ----- Planes -----
        if (e.target.closest('[data-a="newplan"]')) {
          const p = await planForm(null);
          if (p) { await fetch('/api/tasks/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); await boardApi.reload(); }
          return;
        }
        const pact = e.target.closest('[data-pact]');
        if (pact) {
          const pid = pact.dataset.id;
          const p = plans.find((x) => x.id === pid);
          if (!p) return;
          if (pact.dataset.pact === 'edit') { const upd = await planForm(p); if (upd) { await fetch(`/api/tasks/plans/${pid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(upd) }); await boardApi.reload(); } return; }
          if (pact.dataset.pact === 'del') {
            const ok = await dialog.confirmDialog({ title: 'Eliminar plan', message: `¿Eliminar el plan “${p.title}”? Las tareas quedan SIN plan (no se borran).`, confirmLabel: 'Eliminar', danger: true });
            if (ok) { await fetch(`/api/tasks/plans/${pid}/delete`, { method: 'POST' }); await boardApi.reload(); }
            return;
          }
        }
        // ----- Tareas -----
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const id = act.dataset.id;
        const t = tasks.find((x) => x.id === id);
        if (!t) return;
        if (act.dataset.act === 'advance') return patch(id, { status: t.status === 'pendiente' ? 'en-progreso' : 'hecha' });
        if (act.dataset.act === 'reopen') return patch(id, { status: 'pendiente' });
        if (act.dataset.act === 'edit') { const p = await taskForm(t, plans); if (p) return patch(id, p); return; }
        if (act.dataset.act === 'del') {
          const ok = await dialog.confirmDialog({ title: 'Eliminar tarea', message: `¿Eliminar “${t.title}”? No se puede deshacer.`, confirmLabel: 'Eliminar', danger: true });
          if (ok) { await fetch(`/api/tasks/${id}/delete`, { method: 'POST' }); await boardApi.reload(); }
          return;
        }
      });

      // Accesibilidad: abrir el cuadrito con Enter/Espacio (tiene role=button).
      paneEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const ob = e.target.closest('[data-open]');
        if (ob) { e.preventDefault(); const t = tasks.find((x) => x.id === ob.dataset.open); if (t) openTaskDetail(t); }
      });

      (async () => { await loadData(); showTab(tab); })();
    }

    refs.add.addEventListener('click', addTask);
    refs.board.addEventListener('click', () => openBoard());
    // El módulo de audio, tras crear tareas, avisa por el bus para refrescar.
    ctx.bus?.addEventListener?.('tasks-changed', () => { loadCounts(); boardApi?.reload(); });
    // El análisis de audio (botón "Audio" DENTRO del tablero) requiere admin
    // (consume tokens). El acceso "Analizar audio" del sidebar se quitó a
    // pedido del usuario; queda el del tablero + la pestaña Informes.
    ctx.whoami?.then?.((me) => { isAdmin = !!me?.admin; });

    loadCounts();
    setInterval(() => { if (!document.hidden) loadCounts(); }, 20000);
  },
};
