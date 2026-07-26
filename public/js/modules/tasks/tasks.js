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
import { mountLearning } from '../learning/learning.js';
import { pacman } from '../../ui/pacman.js';
import { renderMarkdown } from '../../ui/markdown.js';
import { readCache, writeCache } from '../../ui/cache-store.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
const STATUS = [
  { key: 'pendiente', get label() { return t('tasks.status.pendiente', 'Pendiente'); }, emoji: '⚪' },
  { key: 'en-progreso', get label() { return t('tasks.status.en-progreso', 'En progreso'); }, emoji: '🔵' },
  { key: 'hecha', get label() { return t('tasks.status.hecha', 'Hecha'); }, emoji: '✅' },
];
const PRIO = [
  { key: 'alta', get label() { return t('tasks.prio.alta', 'Alta'); }, emoji: '🔴' },
  { key: 'media', get label() { return t('tasks.prio.media', 'Media'); }, emoji: '🟡' },
  { key: 'baja', get label() { return t('tasks.prio.baja', 'Baja'); }, emoji: '🟢' },
];
const TYPE = [
  { key: 'task', get label() { return t('tasks.type.task', 'Tarea'); }, emoji: '🔹' },
  { key: 'idea', get label() { return t('tasks.type.idea', 'Idea'); }, emoji: '💡' },
  { key: 'nota', get label() { return t('tasks.type.nota', 'Nota'); }, emoji: '📝' },
  { key: 'feature', get label() { return t('tasks.type.feature', 'Feature'); }, emoji: '✨' },
];
const PLAN_STATUS = [
  { key: 'active', get label() { return t('tasks.planStatus.active', 'Activo'); }, emoji: '🟢' },
  { key: 'proposed', get label() { return t('tasks.planStatus.proposed', 'Propuesto'); }, emoji: '💭' },
  { key: 'done', get label() { return t('tasks.planStatus.done', 'Completado'); }, emoji: '✅' },
  { key: 'cancelled', get label() { return t('tasks.planStatus.cancelled', 'Cancelado'); }, emoji: '🚫' },
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
  let ago = t('tasks.time.justNow', 'recién');
  if (s >= 86400) ago = t('tasks.time.daysAgo', 'hace {n} d', { n: Math.floor(s / 86400) });
  else if (s >= 3600) ago = t('tasks.time.hoursAgo', 'hace {n} h', { n: Math.floor(s / 3600) });
  else if (s >= 60) ago = t('tasks.time.minsAgo', 'hace {n} min', { n: Math.floor(s / 60) });
  return `${day} · ${ago}`;
}
// Fecha objetivo/vencimiento (guardada como YYYY-MM-DD) → "13 may 2026".
function fmtDay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, mo, dd] = iso.split('-').map(Number);
  return new Date(y, mo - 1, dd).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
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
        <span class="sec-dot" data-ref="dot" title="${t('tasks.sidebar.dotTitle', 'Tareas pendientes')}"></span>
        <span class="sec-title">${t('tasks.sidebar.title', 'Banco de conocimiento')}</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="add" title="${t('tasks.sidebar.addTitle', 'Nueva tarea')}">${icon('plus', { size: 14 })}</button>
        ${helpBtn('tasks')}
      </header>
      <div class="tk-card">
        <div class="task-mini" data-ref="mini">${t('tasks.common.loading', 'cargando…')}</div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm btn--block" data-ref="board">${icon('checklist', { size: 13 })}<span>${t('tasks.sidebar.openBoard', 'Abrir tablero')}</span></button>
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
        refs.dot.title = counts.total ? t('tasks.sidebar.dotCounts', '{pend} pendiente(s) · {prog} en progreso · {done} hecha(s)', { pend, prog, done }) : t('tasks.sidebar.noTasks', 'Sin tareas');
      }
      refs.mini.innerHTML = counts.total
        ? `<span class="task-chip">⚪ ${pend}</span><span class="task-chip">🔵 ${prog}</span><span class="task-chip">✅ ${done}</span>`
        : `<span class="bf-sub">${t('tasks.sidebar.emptyHint', 'Sin tareas · creá la primera con ＋')}</span>`;
    }

    async function loadCounts() {
      // Cache-then-network: pinta los últimos contadores conocidos al instante.
      const cached = readCache('tasks-counts');
      if (cached) { counts = cached.data; renderMini(); }
      try {
        const d = await (await fetch('/api/tasks/counts')).json();
        counts = d.counts || counts;
        writeCache('tasks-counts', counts);
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
        const tk = existing || { title: '', description: '', type: 'task', priority: 'media', status: 'pendiente', tags: [], planId: null, owner: '', estimate: '', dueDate: '' };
        const m = dialog.openModal({ title: isEdit ? t('tasks.form.editTitle', 'Editar {id}', { id: tk.id }) : t('tasks.form.newTitle', 'Nueva tarea'), width: '520px', onClose: () => finish(null) });
        const planOpts = `<option value="">${t('tasks.form.noPlan', '— sin plan —')}</option>${plans.map((p) => `<option value="${p.id}"${p.id === tk.planId ? ' selected' : ''}>${esc(p.title)}</option>`).join('')}`;
        m.body.innerHTML = `
          <div class="task-form">
            <label class="task-fld"><span>${t('tasks.form.title', 'Título')}</span>
              <input type="text" data-f="title" maxlength="200" placeholder="${t('tasks.form.phTitle', 'Qué hay que hacer')}" value="${esc(tk.title)}" /></label>
            <label class="task-fld"><span>${t('tasks.form.detail', 'Detalle (Markdown)')}</span>
              <textarea data-f="description" rows="4" maxlength="4000" placeholder="${t('tasks.form.phDetail', 'Contexto, por qué, notas… (soporta Markdown)')}">${esc(tk.description)}</textarea></label>
            <div class="task-form-row">
              <label class="task-fld"><span>${t('tasks.form.type', 'Tipo')}</span>
                <select data-f="type">${TYPE.map((x) => `<option value="${x.key}"${x.key === (tk.type || 'task') ? ' selected' : ''}>${x.emoji} ${x.label}</option>`).join('')}</select></label>
              <label class="task-fld"><span>${t('tasks.form.priority', 'Prioridad')}</span>
                <select data-f="priority">${PRIO.map((p) => `<option value="${p.key}"${p.key === tk.priority ? ' selected' : ''}>${p.emoji} ${p.label}</option>`).join('')}</select></label>
              <label class="task-fld"><span>${t('tasks.form.status', 'Estado')}</span>
                <select data-f="status">${STATUS.map((s) => `<option value="${s.key}"${s.key === tk.status ? ' selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}</select></label>
            </div>
            <div class="task-form-row">
              <label class="task-fld"><span>${t('tasks.form.owner', 'Owner')}</span>
                <input type="text" data-f="owner" maxlength="120" placeholder="${t('tasks.form.phOwner', 'Quién es responsable')}" value="${esc(tk.owner || '')}" /></label>
              <label class="task-fld"><span>${t('tasks.form.estimate', 'Estimación')}</span>
                <input type="text" data-f="estimate" maxlength="40" placeholder="${t('tasks.form.phEstimate', 'ej: 1d, 4h')}" value="${esc(tk.estimate || '')}" /></label>
              <label class="task-fld"><span>${t('tasks.form.targetDate', 'Fecha objetivo')}</span>
                <input type="date" data-f="dueDate" value="${esc(tk.dueDate || '')}" /></label>
            </div>
            <label class="task-fld"><span>${t('tasks.form.plan', 'Plan')}</span>
              <select data-f="planId">${planOpts}</select></label>
            <label class="task-fld"><span>${t('tasks.form.tags', 'Tags (coma)')}</span>
              <input type="text" data-f="tags" placeholder="${t('tasks.form.phTags', 'cliente, urgente')}" value="${esc((tk.tags || []).join(', '))}" /></label>
          </div>
          <div class="dlg-actions">
            <button class="btn-ghost" data-a="cancel">${t('tasks.common.cancel', 'Cancelar')}</button>
            <button class="btn" data-a="save">${isEdit ? t('tasks.common.save', 'Guardar') : t('tasks.common.create', 'Crear')}</button>
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
            owner: get('owner').trim(),
            estimate: get('estimate').trim(),
            dueDate: get('dueDate'),
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
        const p = existing || { title: '', description: '', status: 'active', owner: '', phase: '', targetDate: '' };
        const m = dialog.openModal({ title: isEdit ? t('tasks.planForm.editTitle', 'Editar {id}', { id: p.id }) : t('tasks.planForm.newTitle', 'Nuevo plan'), width: '520px', onClose: () => finish(null) });
        m.body.innerHTML = `
          <div class="task-form">
            <label class="task-fld"><span>${t('tasks.form.title', 'Título')}</span>
              <input type="text" data-f="title" maxlength="200" placeholder="${t('tasks.planForm.phTitle', 'Nombre del plan')}" value="${esc(p.title)}" /></label>
            <label class="task-fld"><span>${t('tasks.form.detail', 'Detalle (Markdown)')}</span>
              <textarea data-f="description" rows="3" maxlength="4000" placeholder="${t('tasks.planForm.phDetail', 'Objetivo del plan… (soporta Markdown)')}">${esc(p.description)}</textarea></label>
            <div class="task-form-row">
              <label class="task-fld"><span>${t('tasks.form.status', 'Estado')}</span>
                <select data-f="status">${PLAN_STATUS.map((s) => `<option value="${s.key}"${s.key === p.status ? ' selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}</select></label>
              <label class="task-fld"><span>${t('tasks.planForm.phase', 'Fase')}</span>
                <input type="text" data-f="phase" maxlength="20" placeholder="${t('tasks.planForm.phPhase', 'ej: 1, 4')}" value="${esc(p.phase || '')}" /></label>
            </div>
            <div class="task-form-row">
              <label class="task-fld"><span>${t('tasks.form.owner', 'Owner')}</span>
                <input type="text" data-f="owner" maxlength="120" placeholder="${t('tasks.planForm.phOwner', 'Responsable')}" value="${esc(p.owner || '')}" /></label>
              <label class="task-fld"><span>${t('tasks.form.targetDate', 'Fecha objetivo')}</span>
                <input type="date" data-f="targetDate" value="${esc(p.targetDate || '')}" /></label>
            </div>
          </div>
          <div class="dlg-actions">
            <button class="btn-ghost" data-a="cancel">${t('tasks.common.cancel', 'Cancelar')}</button>
            <button class="btn" data-a="save">${isEdit ? t('tasks.common.save', 'Guardar') : t('tasks.common.create', 'Crear')}</button>
          </div>`;
        const get = (f) => m.body.querySelector(`[data-f="${f}"]`).value;
        m.body.querySelector('[data-a="cancel"]').addEventListener('click', () => m.close());
        m.body.querySelector('[data-a="save"]').addEventListener('click', () => {
          const payload = { title: get('title').trim(), description: get('description'), status: get('status'), owner: get('owner').trim(), phase: get('phase').trim(), targetDate: get('targetDate') };
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
      let learningApi = null;       // { reload } de la pestaña Aprendizaje
      // Ventana grande, casi como el Explorador (92vw · alto 90vh): el sizing
      // real vive en .task-board-card (style.css); pasamos 92vw como el explorador.
      const m = dialog.openModal({ title: t('tasks.board.title', 'Banco de conocimiento'), width: '92vw', onClose: () => { boardApi = null; } });
      m.card.classList.add('task-board-card');
      m.card.querySelector('.dlg-head')?.insertAdjacentHTML('beforeend', helpBtn('tasks'));
      m.body.innerHTML = `
        <div class="task-board">
          <div class="tk-tabs" data-ref="tabs"></div>
          <div class="tk-pane" data-ref="pane"></div>
        </div>`;
      const tabsEl = m.body.querySelector('[data-ref="tabs"]');
      const paneEl = m.body.querySelector('[data-ref="pane"]');
      const TABS = [
        { key: 'panel', label: `📊 ${t('tasks.tabs.panel', 'Panel')}` },
        { key: 'tareas', label: `📋 ${t('tasks.tabs.tasks', 'Tareas')}` },
        { key: 'planes', label: `🗺️ ${t('tasks.tabs.plans', 'Planes')}` },
        { key: 'aprendizaje', label: `🎓 ${t('tasks.tabs.learning', 'Aprendizaje')}` },
        { key: 'informes', label: `🎙️ ${t('tasks.tabs.reports', 'Informes')}` },
      ];
      const audioCtx = { icon, dialog, bus: ctx.bus };
      const learningCtx = { icon, dialog, bus: ctx.bus, whoami: ctx.whoami, openChat: ctx.openChat };

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
      function taskCardV2(tk) {
        const st = statusOf(tk.status);
        const pr = prioOf(tk.priority);
        const ty = typeOf(tk.type);
        const plan = tk.planId ? plans.find((p) => p.id === tk.planId) : null;
        const src = tk.source === 'audio' ? '🎙️ ' : '';
        return `<div class="task-cardv2 task-cardv2--${tk.status}" data-open="${tk.id}" role="button" tabindex="0" title="${t('tasks.card.openTitle', 'Abrir {id}', { id: tk.id })}">
          <div class="task-cardv2-top">
            <span class="task-type" title="${ty.label}">${ty.emoji}</span>
            <span class="task-cardv2-id">${tk.id}</span>
            <span class="task-prio task-prio--${tk.priority}" title="${t('tasks.card.prioTitle', 'Prioridad {label}', { label: pr.label })}">${pr.emoji}</span>
            <span class="task-cardv2-status" title="${st.label}">${st.emoji}</span>
          </div>
          <div class="task-cardv2-title">${src}${esc(tk.title)}</div>
          ${plan ? `<div class="task-cardv2-foot"><span class="task-plan">🗺️ ${esc(plan.title)}</span></div>` : ''}
        </div>`;
      }

      // ===== Detalle enriquecido (estilo Pad) — compartido tarea/plan =====
      // Helpers de relaciones (blocks/blockedBy cruzan tareas↔planes).
      const itemRaw = (id) => tasks.find((x) => x.id === id) || plans.find((x) => x.id === id);
      const allItems = () => [...tasks.map((t) => ({ id: t.id, title: t.title, kind: 'task' })), ...plans.map((p) => ({ id: p.id, title: p.title, kind: 'plan' }))];
      const relLabel = (id) => { const r = itemRaw(id); return r ? r.title : id; };
      const relIco = (id) => (id.startsWith('PLAN-') ? '🗺️' : '🔹');
      const blockedByIds = (id) => [...tasks, ...plans].filter((x) => (x.blocks || []).includes(id)).map((x) => x.id);
      const relChip = (id, removable) => `<span class="tk-rel" data-open-item="${id}" title="${esc(relLabel(id))}">${relIco(id)} <span class="tk-rel-id">${esc(id)}</span> <span class="tk-rel-t">${esc(relLabel(id))}</span>${removable ? `<button class="tk-rel-x" data-rel-remove="${id}" title="${t('tasks.rel.removeTitle', 'Quitar')}">✕</button>` : ''}</span>`;
      const ACT_ICO = { created: '➕', completed: '✅', status: '🔄', updated: '✏️', deleted: '🗑️' };
      const evText = (ev) => {
        if (ev.kind === 'created') return t('tasks.ev.created', 'Creado');
        if (ev.kind === 'completed') return t('tasks.ev.completed', 'Completado');
        if (ev.kind === 'status') return t('tasks.ev.status', 'Estado → {detail}', { detail: ev.detail || '' });
        if (ev.kind === 'updated') return t('tasks.ev.updated', 'Actualizado');
        if (ev.kind === 'deleted') return t('tasks.ev.deleted', 'Eliminado');
        return ev.kind || '';
      };

      // Picker de relación "bloquea": modal con búsqueda sobre todos los ítems.
      function pickRelationship(excludeIds) {
        return new Promise((resolve) => {
          let done = false; const fin = (v) => { if (done) return; done = true; resolve(v); };
          const items = allItems().filter((x) => !excludeIds.includes(x.id));
          const pm = dialog.openModal({ title: t('tasks.rel.pickTitle', 'Vincular · bloquea a…'), width: '440px', onClose: () => fin(null) });
          pm.body.innerHTML = `
            <input class="tk-rel-search" data-ref="s" placeholder="${t('tasks.rel.searchPh', 'Buscar por id o título…')}" />
            <div class="tk-rel-picklist" data-ref="l"></div>`;
          const s = pm.body.querySelector('[data-ref="s"]');
          const l = pm.body.querySelector('[data-ref="l"]');
          const draw = (q = '') => {
            const ql = q.toLowerCase();
            const rows = items.filter((x) => !ql || x.id.toLowerCase().includes(ql) || x.title.toLowerCase().includes(ql)).slice(0, 60);
            l.innerHTML = rows.length ? rows.map((x) => `<button class="tk-rel-pick" data-id="${x.id}">${x.kind === 'plan' ? '🗺️' : '🔹'} <b>${esc(x.id)}</b> ${esc(x.title)}</button>`).join('') : `<div class="dash-empty">${t('tasks.rel.noMatch', 'Nada coincide.')}</div>`;
          };
          draw();
          s.addEventListener('input', () => draw(s.value));
          l.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) { fin(b.dataset.id); pm.close(); } });
          setTimeout(() => s.focus(), 30);
        });
      }

      // Detalle de UNA tarea o plan en ventana nueva (modal) — breadcrumb,
      // propiedades, descripción Markdown, relaciones y timeline+comentarios.
      function openDetail(kind, itemArg) {
        const isPlan = kind === 'plan';
        let item = itemArg;
        let dirty = false; // aplicamos algo ⇒ recargar el tablero al cerrar
        // Los blocks/blockedBy ya NO vienen en la lista (BUG-620): se piden lazy
        // solo para el ítem abierto (1 request en vez del fan-out de ~121).
        let itemLinks = { blocks: [], blockedBy: [] };
        async function loadLinks() {
          try {
            const url = isPlan ? `/api/tasks/plans/${item.id}/links` : `/api/tasks/${item.id}/links`;
            itemLinks = await (await fetch(url)).json();
          } catch { itemLinks = { blocks: [], blockedBy: [] }; }
        }
        const headIco = isPlan ? planStatusOf(item.status).emoji : typeOf(item.type).emoji;
        const dm = dialog.openModal({ title: `${headIco} ${item.id}`, width: '660px', onClose: () => { if (dirty) boardApi?.reload(); } });
        dm.card.classList.add('tk-detail-card');

        const patchItem = (body) => fetch(isPlan ? `/api/tasks/plans/${item.id}` : `/api/tasks/${item.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        // Aplica una mutación, recarga el tablero y re-renderiza el detalle con el
        // ítem fresco (o cierra si se borró).
        const mutate = async (fn) => {
          await fn(); dirty = true; await boardApi.reload();
          const fresh = (isPlan ? plans : tasks).find((x) => x.id === item.id);
          if (!fresh) { dm.close(); return; }
          item = fresh; renderBody(); loadLinks().then(renderBody);
        };

        function propRow(label, val) { return `<div class="tk-prop"><span class="tk-prop-k">${label}</span><span class="tk-prop-v">${val}</span></div>`; }
        function propsHtml() {
          if (isPlan) {
            const st = planStatusOf(item.status);
            return [
              propRow(t('tasks.form.status', 'Estado'), `${st.emoji} ${st.label}`),
              propRow(t('tasks.prop.phase', 'Fase'), item.phase ? esc(item.phase) : '—'),
              propRow(t('tasks.form.targetDate', 'Fecha objetivo'), item.targetDate ? fmtDay(item.targetDate) : '—'),
              propRow(t('tasks.form.owner', 'Owner'), item.owner ? esc(item.owner) : '—'),
              propRow(t('tasks.prop.progress', 'Progreso'), `${item.doneCount || 0}/${item.taskCount || 0} · ${item.pct || 0}%`),
            ].join('');
          }
          const st = statusOf(item.status); const pr = prioOf(item.priority); const ty = typeOf(item.type);
          return [
            propRow(t('tasks.form.status', 'Estado'), `${st.emoji} ${st.label}`),
            propRow(t('tasks.form.priority', 'Prioridad'), `${pr.emoji} ${pr.label}`),
            propRow(t('tasks.form.type', 'Tipo'), `${ty.emoji} ${ty.label}`),
            propRow(t('tasks.form.owner', 'Owner'), item.owner ? esc(item.owner) : '—'),
            propRow(t('tasks.form.estimate', 'Estimación'), item.estimate ? esc(item.estimate) : '—'),
            propRow(t('tasks.form.targetDate', 'Fecha objetivo'), item.dueDate ? fmtDay(item.dueDate) : '—'),
          ].join('');
        }
        function relHtml() {
          const blocks = itemLinks.blocks || [];
          const bby = itemLinks.blockedBy || [];
          const childOf = !isPlan && item.planId ? item.planId : null;
          const children = isPlan ? tasks.filter((t) => t.planId === item.id) : [];
          const doneCh = children.filter((t) => t.status === 'hecha').length;
          const rows = [];
          if (!isPlan) rows.push(`<div class="tk-rel-row"><span class="tk-rel-lbl">${t('tasks.rel.partOf', 'Parte del plan')}</span><div class="tk-rel-chips">${childOf ? relChip(childOf, false) : `<span class="dash-empty">${t('tasks.rel.noPlanShort', 'Sin plan')}</span>`}</div></div>`);
          if (isPlan) rows.push(`<div class="tk-rel-row"><span class="tk-rel-lbl">${t('tasks.rel.children', 'Hijos {done}/{total}', { done: doneCh, total: children.length })}</span><div class="tk-rel-chips">${children.length ? children.map((tk) => relChip(tk.id, false)).join('') : `<span class="dash-empty">${t('tasks.rel.noChildren', 'Sin tareas asignadas')}</span>`}</div></div>`);
          rows.push(`<div class="tk-rel-row"><span class="tk-rel-lbl">${t('tasks.rel.blocks', 'Bloquea a')}</span><div class="tk-rel-chips">${blocks.length ? blocks.map((id) => relChip(id, true)).join('') : ''}<button class="btn-ghost btn--sm tk-rel-add" data-rel-add title="${t('tasks.rel.addTitle', 'Vincular')}">＋</button></div></div>`);
          rows.push(`<div class="tk-rel-row"><span class="tk-rel-lbl">${t('tasks.rel.blockedBy', 'Bloqueado por')}</span><div class="tk-rel-chips">${bby.length ? bby.map((id) => relChip(id, false)).join('') : '<span class="dash-empty">—</span>'}</div></div>`);
          return rows.join('');
        }
        function crumbHtml() {
          const plan = !isPlan && item.planId ? plans.find((p) => p.id === item.planId) : null;
          return `<div class="tk-crumb">
            <span class="tk-crumb-lnk" data-goto-tab="panel">🏠 ${t('tasks.crumb.bank', 'Banco')}</span><span class="tk-crumb-sep">/</span>
            <span class="tk-crumb-lnk" data-goto-tab="planes">📋 ${t('tasks.tabs.plans', 'Planes')}</span>
            ${plan ? `<span class="tk-crumb-sep">/</span><span class="tk-crumb-lnk" data-open-item="${plan.id}">${esc(plan.id)}</span>` : ''}
            <span class="tk-crumb-sep">/</span><span class="tk-crumb-cur">${item.id}</span></div>`;
        }
        function actsHtml() {
          if (isPlan) {
            return `<button class="btn-ghost btn--sm" data-da="edit">${icon('edit', { size: 13 })}<span>${t('tasks.common.edit', 'Editar')}</span></button>
              <button class="btn-ghost btn--sm" data-da="del">${icon('trash', { size: 13 })}<span>${t('tasks.common.delete', 'Eliminar')}</span></button>`;
          }
          const advanceBtn = item.status === 'pendiente'
            ? `<button class="btn btn--sm" data-da="advance">${t('tasks.detail.advanceToProgress', '▶ En progreso')}</button>`
            : item.status === 'en-progreso'
              ? `<button class="btn btn--sm" data-da="advance">${t('tasks.detail.markDone', '✅ Marcar hecha')}</button>`
              : `<button class="btn-ghost btn--sm" data-da="reopen">${t('tasks.detail.reopen', '↩ Reabrir')}</button>`;
          return `${advanceBtn}
            <button class="btn-ghost btn--sm" data-da="edit">${icon('edit', { size: 13 })}<span>${t('tasks.common.edit', 'Editar')}</span></button>
            <button class="btn-ghost btn--sm" data-da="del">${icon('trash', { size: 13 })}<span>${t('tasks.common.delete', 'Eliminar')}</span></button>`;
        }

        function renderBody() {
          const blocks = itemLinks.blocks || [];
          const hasRel = blocks.length || (itemLinks.blockedBy || []).length || (!isPlan && item.planId) || (isPlan && tasks.some((t) => t.planId === item.id));
          const tags = !isPlan && (item.tags || []).length ? `<div class="task-tags">${item.tags.map((x) => `<span class="task-tag">${esc(x)}</span>`).join('')}</div>` : '';
          dm.body.innerHTML = `
            <div class="tk-detail">
              ${crumbHtml()}
              <div class="tk-detail-title">${esc(item.title)}</div>
              <div class="tk-detail-sub">${icon('clock', { size: 11 })} ${t('tasks.detail.created', 'Creada {date}', { date: fmtDate(item.createdAt) })}${item.updatedAt && item.updatedAt !== item.createdAt ? ` · ✏️ ${fmtDate(item.updatedAt)}` : ''}${item.source === 'audio' ? ` · 🎙️ ${t('tasks.detail.fromAudio', 'desde audio')}` : ''}</div>
              <div class="tk-detail-acts">${actsHtml()}</div>
              <details class="tk-sec" open><summary class="tk-sec-h">${t('tasks.sec.properties', '⚙️ Propiedades')}</summary><div class="tk-sec-b"><div class="tk-props">${propsHtml()}</div>${tags}</div></details>
              <details class="tk-sec" open><summary class="tk-sec-h">${t('tasks.sec.description', '📝 Descripción')}</summary><div class="tk-sec-b">${item.description ? `<div class="tk-md">${renderMarkdown(item.description)}</div>` : `<div class="dash-empty">${t('tasks.detail.noDescription', 'Sin descripción.')}</div>`}</div></details>
              <details class="tk-sec"${hasRel ? ' open' : ''}><summary class="tk-sec-h">${t('tasks.sec.relations', '🔗 Relaciones')}</summary><div class="tk-sec-b tk-rels">${relHtml()}</div></details>
              <details class="tk-sec"><summary class="tk-sec-h">${t('tasks.sec.timeline', '🕑 Timeline y comentarios')}</summary><div class="tk-sec-b" data-ref="timeline">${t('tasks.common.loading', 'cargando…')}</div></details>
            </div>`;
          loadTimeline();
        }

        async function loadTimeline() {
          const box = dm.body.querySelector('[data-ref="timeline"]');
          if (!box) return;
          let events = [];
          try {
            const url = isPlan ? `/api/tasks/plans/${item.id}/timeline` : `/api/tasks/${item.id}/timeline`;
            events = (await (await fetch(url)).json()).events || [];
          } catch { /* noop */ }
          const rows = events.map((ev) => {
            if (ev.type === 'comment') {
              return `<div class="tk-tl tk-tl--c"><span class="tk-tl-ico">💬</span><div class="tk-tl-body"><div class="tk-tl-txt">${esc(ev.text)}</div><div class="tk-tl-meta">${fmtDate(ev.ts)} <button class="tk-tl-del" data-comment-del="${ev.cid}" title="${t('tasks.timeline.delComment', 'Borrar comentario')}">✕</button></div></div></div>`;
            }
            return `<div class="tk-tl"><span class="tk-tl-ico">${ACT_ICO[ev.kind] || '•'}</span><div class="tk-tl-body"><div class="tk-tl-txt">${esc(evText(ev))}</div><div class="tk-tl-meta">${fmtDate(ev.ts)}</div></div></div>`;
          }).join('');
          box.innerHTML = `
            <div class="tk-tl-composer">
              <textarea class="tk-tl-input" data-ref="cinput" rows="2" placeholder="${t('tasks.timeline.commentPh', 'Escribí un comentario… (Ctrl+Enter para enviar)')}"></textarea>
              <button class="btn btn--sm" data-comment-send>${t('tasks.timeline.comment', 'Comentar')}</button>
            </div>
            <div class="tk-tl-list">${rows || `<div class="dash-empty">${t('tasks.timeline.noActivity', 'Sin actividad todavía.')}</div>`}</div>`;
          const ta = box.querySelector('[data-ref="cinput"]');
          ta?.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); box.querySelector('[data-comment-send]')?.click(); } });
        }

        dm.body.addEventListener('click', async (e) => {
          // Quitar relación (antes que open-item: el ✕ vive dentro del chip).
          const rr = e.target.closest('[data-rel-remove]');
          if (rr) { const id = rr.dataset.relRemove; await mutate(() => patchItem({ blocks: (itemLinks.blocks || []).filter((x) => x !== id) })); return; }
          const ra = e.target.closest('[data-rel-add]');
          if (ra) { const chosen = await pickRelationship([item.id, ...(itemLinks.blocks || [])]); if (chosen) await mutate(() => patchItem({ blocks: [...(itemLinks.blocks || []), chosen] })); return; }
          // Comentarios.
          const cs = e.target.closest('[data-comment-send]');
          if (cs) {
            const ta = dm.body.querySelector('[data-ref="cinput"]');
            const text = (ta?.value || '').trim();
            if (!text) return;
            cs.disabled = true;
            try {
              const url = isPlan ? `/api/tasks/plans/${item.id}/comment` : `/api/tasks/${item.id}/comment`;
              await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
              dirty = true; await loadTimeline();
            } finally { cs.disabled = false; }
            return;
          }
          const cd = e.target.closest('[data-comment-del]');
          if (cd) {
            const url = isPlan ? `/api/tasks/plans/${item.id}/comment/${cd.dataset.commentDel}/delete` : `/api/tasks/${item.id}/comment/${cd.dataset.commentDel}/delete`;
            await fetch(url, { method: 'POST' }); dirty = true; await loadTimeline(); return;
          }
          // Navegación.
          const oi = e.target.closest('[data-open-item]');
          if (oi) { const raw = itemRaw(oi.dataset.openItem); if (raw) { dm.close(); openDetail(oi.dataset.openItem.startsWith('PLAN-') ? 'plan' : 'task', raw); } return; }
          const gt = e.target.closest('[data-goto-tab]');
          if (gt) { dm.close(); showTab(gt.dataset.gotoTab); return; }
          // Acciones.
          const b = e.target.closest('[data-da]');
          if (!b) return;
          const a = b.dataset.da;
          if (a === 'advance') { await mutate(() => patchItem({ status: item.status === 'pendiente' ? 'en-progreso' : 'hecha' })); return; }
          if (a === 'reopen') { await mutate(() => patchItem({ status: 'pendiente' })); return; }
          if (a === 'edit') { const p = isPlan ? await planForm(item) : await taskForm(item, plans); if (p) await mutate(() => patchItem(p)); return; }
          if (a === 'del') {
            const ok = await dialog.confirmDialog({
              title: isPlan ? t('tasks.confirm.delPlanTitle', 'Eliminar plan') : t('tasks.confirm.delTaskTitle', 'Eliminar tarea'),
              message: isPlan ? t('tasks.confirm.delPlanMsg', '¿Eliminar el plan “{title}”? Las tareas quedan SIN plan.', { title: item.title }) : t('tasks.confirm.delTaskMsg', '¿Eliminar “{title}”? No se puede deshacer.', { title: item.title }),
              confirmLabel: t('tasks.common.delete', 'Eliminar'),
              danger: true,
            });
            if (ok) { await fetch(isPlan ? `/api/tasks/plans/${item.id}/delete` : `/api/tasks/${item.id}/delete`, { method: 'POST' }); dirty = true; await boardApi.reload(); dm.close(); }
            return;
          }
        });

        renderBody(); loadLinks().then(renderBody);
      }
      const openTaskDetail = (t) => openDetail('task', t);
      const openPlanDetail = (p) => openDetail('plan', p);

      function tareasHtml() {
        const FILT = [
          { key: 'activas', label: t('tasks.filter.active', 'Activas') },
          { key: 'todas', label: t('tasks.filter.all', 'Todas') },
          { key: 'hecha', label: t('tasks.filter.done', '✅ Hechas') },
        ];
        return `
          <div class="task-board-head">
            <div class="task-filters">${FILT.map((f) => `<button class="task-filter${f.key === filter ? ' is-on' : ''}" data-filt="${f.key}">${f.label}</button>`).join('')}</div>
            <div class="task-board-actions">
              ${isAdmin ? `<button class="btn-ghost btn--sm" data-a="analyze" title="${t('tasks.actions.analyzeTitle', 'Análisis general con IA: duplicados, unificables y completar info (consume tokens)')}">${icon('sparkle', { size: 13 })}<span>${t('tasks.actions.analyze', 'Análisis general')}</span></button>` : ''}
              ${isAdmin ? `<button class="btn-ghost btn--sm" data-a="audio" title="${t('tasks.actions.audioTitle', 'Analizar una transcripción de audio (consume tokens)')}">${icon('mic', { size: 13 })}<span>${t('tasks.actions.audio', 'Audio')}</span></button>` : ''}
              <button class="btn btn--sm" data-a="new">${icon('plus', { size: 13 })}<span>${t('tasks.actions.new', 'Nueva')}</span></button>
            </div>
          </div>
          <div class="task-grid" data-ref="list">${t('tasks.common.loading', 'cargando…')}</div>`;
      }

      function renderList() {
        const listEl = paneEl.querySelector('[data-ref="list"]');
        if (!listEl) return;
        const shown = tasks.filter((t) => filter === 'todas' ? true : filter === 'hecha' ? t.status === 'hecha' : t.status !== 'hecha');
        listEl.innerHTML = shown.length
          ? shown.map(taskCardV2).join('')
          : `<div class="task-empty">${t('tasks.list.empty', 'Nada por acá. Creá una tarea con “Nueva”.')}</div>`;
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
          : `<div class="dash-empty">${t('tasks.plan.noTasks', 'Sin tareas asignadas. Asigná tareas a este plan desde el campo “Plan” de cada tarea.')}</div>`;
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
              <button class="btn-ghost btn--sm" data-pact="open" data-id="${p.id}">${icon('checklist', { size: 13 })}<span>${t('tasks.common.open', 'Abrir')}</span></button>
              <button class="btn-ghost btn--sm" data-pact="edit" data-id="${p.id}">${icon('edit', { size: 13 })}<span>${t('tasks.common.edit', 'Editar')}</span></button>
              <button class="btn-ghost btn--sm" data-pact="del" data-id="${p.id}">${icon('trash', { size: 13 })}<span>${t('tasks.common.delete', 'Eliminar')}</span></button>
            </div>
          </div>
        </details>`;
      }
      function planesHtml() {
        return `
          <div class="task-board-head">
            <span class="tk-pane-title">${t('tasks.plan.paneTitle', 'Planes que agrupan tareas con progreso')}</span>
            <div class="task-board-actions">
              ${isAdmin ? `<button class="btn-ghost btn--sm" data-a="analyze-plans" title="${t('tasks.plan.analyzeTitle', 'Análisis general de planes con IA: duplicados, unificables y completar info (consume tokens)')}">${icon('sparkle', { size: 13 })}<span>${t('tasks.actions.analyze', 'Análisis general')}</span></button>` : ''}
              <button class="btn btn--sm" data-a="newplan">${icon('plus', { size: 13 })}<span>${t('tasks.plan.new', 'Nuevo plan')}</span></button>
            </div>
          </div>
          <div class="plan-list">${plans.length ? plans.map(planCard).join('') : `<div class="task-empty">${t('tasks.plan.empty', 'Todavía no hay planes. Creá uno con “Nuevo plan” y asigná tareas desde su campo “Plan”.')}</div>`}</div>`;
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
        // Pac-Man real (motor compartido) en vez de un emoji estático: mismo
        // dato `c.delegating` que usa la tarjeta de Sesiones (sessions.js).
        const state = `${pacman({ state: c.delegating ? 'delegating' : 'working', size: 'sm' })} ${c.delegating ? t('tasks.panel.delegating', 'delegando') : t('tasks.panel.working', 'trabajando')}`;
        const tk = c.ticketNumber ? ` · ${esc(String(c.ticketNumber))}` : '';
        return `<div class="dash-item dash-item--chat">
          <span class="dash-item-ico">💻</span>
          <span class="dash-item-title">${esc(c.title || t('tasks.panel.session', 'Sesión'))}</span>
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
          ...stalled.map((tk) => `<div class="dash-item dash-item--warn"><span class="dash-item-ico">⚠️</span><span class="dash-item-title">${esc(tk.title)}</span><span class="dash-item-meta">${t('tasks.panel.stalledMeta', 'en progreso, sin cambios {date}', { date: fmtDate(tk.updatedAt || tk.createdAt) })}</span></div>`),
          ...highPend.map((tk) => `<div class="dash-item dash-item--warn"><span class="dash-item-ico">🔴</span><span class="dash-item-title">${esc(tk.title)}</span><span class="dash-item-meta">${t('tasks.panel.highPrioMeta', 'alta prioridad, sin arrancar')}</span></div>`),
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
              <div class="dash-coll-h">📋 ${t('tasks.panel.collTasks', 'Tareas')} <span>${tasks.length}</span></div>
              <div class="dash-coll-b">
                <span class="dash-pill">${t('tasks.panel.pillPend', '⚪ {n} pend.', { n: pend.length })}</span>
                <span class="dash-pill">${t('tasks.panel.pillActive', '🔵 {n} en curso', { n: active.length })}</span>
                <span class="dash-pill">${t('tasks.panel.pillDone', '✅ {n} hechas', { n: done.length })}</span>
              </div>
            </div>
            <div class="dash-coll-card">
              <div class="dash-coll-h">🗺️ ${t('tasks.panel.collPlans', 'Planes')} <span>${plans.length}</span></div>
              <div class="dash-coll-b"><span class="dash-pill">${t('tasks.panel.pillActivePlans', '{n} activos', { n: activePlans.length })}</span></div>
            </div>
            <div class="dash-coll-card">
              <div class="dash-coll-h">🎙️ ${t('tasks.panel.collReports', 'Informes')} <span>${audio.length}</span></div>
              <div class="dash-coll-b"><span class="dash-pill">${t('tasks.panel.pillProposed', '{n} tarea(s) propuestas', { n: proposed })}</span></div>
            </div>
            <div class="dash-coll-card">
              <div class="dash-coll-h">💻 ${t('tasks.panel.collSessions', 'Sesiones')} <span>${chats.length}</span></div>
              <div class="dash-coll-b"><span class="dash-pill">${t('tasks.panel.pillWorking', '{n} trabajando ahora', { n: workChats.length })}</span></div>
            </div>
          </div>
          ${typePills ? `<div class="dash-tags">${typePills}</div>` : ''}
          ${topTags.length ? `<div class="dash-tags">${topTags.map(([g, n]) => `<span class="task-tag">${esc(g)} · ${n}</span>`).join('')}</div>` : ''}`;

        // 🕑 Actividad reciente: LOG REAL persistido (tareas/planes) + audios
        const ICO = { created: '➕', completed: '✅', status: '🔄', updated: '✏️', deleted: '🗑️' };
        const actText = (ev) => {
          const isPlanEv = ev.entity === 'plan';
          const title = ev.title || '';
          if (ev.kind === 'created') {
            if (isPlanEv) return t('tasks.act.createdPlan', 'Creaste el plan “{title}”', { title });
            return t('tasks.act.createdTask', 'Creaste {ref}“{title}”', { ref: ev.refId ? `${ev.refId} ` : '', title });
          }
          if (ev.kind === 'completed') return t('tasks.act.completed', 'Completaste “{title}”', { title });
          if (ev.kind === 'status') return t('tasks.act.status', '{ref} → {detail} · “{title}”', { ref: ev.refId || '', detail: ev.detail || '', title });
          if (ev.kind === 'updated') return isPlanEv ? t('tasks.act.updatedPlan', 'Actualizaste el plan “{title}”', { title }) : t('tasks.act.updatedTask', 'Actualizaste “{title}”', { title });
          if (ev.kind === 'deleted') return isPlanEv ? t('tasks.act.deletedPlan', 'Eliminaste el plan “{title}”', { title }) : t('tasks.act.deletedTask', 'Eliminaste “{title}”', { title });
          return title;
        };
        const acts = activity.map((ev) => ({ ts: ev.ts, ico: ICO[ev.kind] || '•', txt: actText(ev) }));
        for (const j of audio) acts.push({ ts: j.createdAt, ico: '🎙️', txt: `${t('tasks.act.analyzedAudio', 'Analizaste el audio “{title}”', { title: j.title })}${j.proposedCount ? t('tasks.act.tasksSuffix', ' ({n} tarea/s)', { n: j.proposedCount }) : ''}` });
        acts.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const recent = acts.slice(0, 14).map((a) => `<div class="dash-act"><span class="dash-act-ico">${a.ico}</span><span class="dash-act-txt">${esc(a.txt)}</span><span class="dash-act-ts">${fmtDate(a.ts)}</span></div>`).join('');

        // Orden (pedido del usuario 2026-07-06): CLASIFICACIÓN primero (resumen
        // de todo, nace abierta), después el resto del dashboard.
        // Botón "Reorganizar todo con IA" (admin): análisis HOLÍSTICO de tareas +
        // planes + informes (dup/unificar/completar + agrupar en planes + crear
        // tareas de informes que faltan). Consume tokens ⇒ runner desacoplado.
        const reorgHead = isAdmin
          ? `<div class="task-board-head">
              <span class="tk-pane-title">${t('tasks.panel.overviewTitle', 'Vista general del tablero')}</span>
              <div class="task-board-actions">
                <button class="btn btn--sm" data-a="reorg" title="${t('tasks.panel.reorgTitle', 'Reorganiza TODO con IA: unifica duplicados, agrupa tareas en planes, completa info y crea las tareas de informes que faltan (consume tokens)')}">${icon('sparkle', { size: 13 })}<span>${t('tasks.panel.reorg', 'Reorganizar todo con IA')}</span></button>
              </div></div>`
          : '';
        return `<div class="dash">
          ${reorgHead}
          ${dashSec(t('tasks.panel.secClassif', '🗂️ Clasificación'), tasks.length + audio.length + plans.length, classif, { open: true })}
          ${dashSec(t('tasks.panel.secInProgress', '🔥 En curso'), active.length + workChats.length, enCurso || dashEmpty(t('tasks.panel.emptyInProgress', 'Nada en curso ahora.')), { open: true })}
          ${dashSec(t('tasks.panel.secAttention', '⚠️ Necesita atención'), stalled.length + highPend.length, attn || dashEmpty(t('tasks.panel.emptyAttention', 'Todo en orden, sin alertas.')), { open: (stalled.length + highPend.length) > 0 })}
          ${dashSec(t('tasks.panel.secUpNext', '⏭️ Seguí por acá'), Math.min(3, active.length + pend.length), upnext || dashEmpty(t('tasks.panel.emptyUpNext', 'No hay tareas activas.')), { open: true })}
          ${dashSec(t('tasks.panel.secActivePlans', '📊 Planes activos'), activePlans.length, plansBars || dashEmpty(t('tasks.panel.emptyActivePlans', 'Sin planes activos. Creá uno en la pestaña Planes.')), { open: activePlans.length > 0 })}
          ${dashSec(t('tasks.panel.secRecent', '🕑 Actividad reciente'), Math.min(14, acts.length), recent || dashEmpty(t('tasks.panel.emptyRecent', 'Sin actividad todavía.')))}
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
        learningApi = null;
        if (tab === 'informes') { reportsApi = mountReports(paneEl, audioCtx); return; }
        if (tab === 'aprendizaje') { learningApi = mountLearning(paneEl, learningCtx); return; }
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
        else if (tab === 'aprendizaje') learningApi?.reload?.();
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
        if (e.target.closest('[data-a="reorg"]')) { openAnalysis('global'); return; }
        if (e.target.closest('[data-a="analyze"]')) { openAnalysis('tasks'); return; }
        if (e.target.closest('[data-a="analyze-plans"]')) { openAnalysis('plans'); return; }
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
          if (pact.dataset.pact === 'open') { openPlanDetail(p); return; }
          if (pact.dataset.pact === 'edit') { const upd = await planForm(p); if (upd) { await fetch(`/api/tasks/plans/${pid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(upd) }); await boardApi.reload(); } return; }
          if (pact.dataset.pact === 'del') {
            const ok = await dialog.confirmDialog({
              title: t('tasks.confirm.delPlanTitle', 'Eliminar plan'),
              message: t('tasks.confirm.delPlanMsg2', '¿Eliminar el plan “{title}”? Las tareas quedan SIN plan (no se borran).', { title: p.title }),
              confirmLabel: t('tasks.common.delete', 'Eliminar'),
              danger: true,
            });
            if (ok) { await fetch(`/api/tasks/plans/${pid}/delete`, { method: 'POST' }); await boardApi.reload(); }
            return;
          }
        }
        // ----- Tareas -----
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const id = act.dataset.id;
        const tt = tasks.find((x) => x.id === id);
        if (!tt) return;
        if (act.dataset.act === 'advance') return patch(id, { status: tt.status === 'pendiente' ? 'en-progreso' : 'hecha' });
        if (act.dataset.act === 'reopen') return patch(id, { status: 'pendiente' });
        if (act.dataset.act === 'edit') { const p = await taskForm(tt, plans); if (p) return patch(id, p); return; }
        if (act.dataset.act === 'del') {
          const ok = await dialog.confirmDialog({
            title: t('tasks.confirm.delTaskTitle', 'Eliminar tarea'),
            message: t('tasks.confirm.delTaskMsg', '¿Eliminar “{title}”? No se puede deshacer.', { title: tt.title }),
            confirmLabel: t('tasks.common.delete', 'Eliminar'),
            danger: true,
          });
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

      // ===== Análisis general IA (duplicados / unificables / completar) =====
      // scope='tasks' | 'plans'. Runner desacoplado (POST /analyze) + poll del GET.
      // Las propuestas se aprueban de a una; aplicar reusa el CRUD existente.
      function openAnalysis(scope) {
        const isPlans = scope === 'plans';
        const isGlobal = scope === 'global';
        const label = isGlobal ? t('tasks.analysis.scopeAll', 'todo (tareas, planes e informes)') : isPlans ? t('tasks.analysis.scopePlans', 'planes') : t('tasks.analysis.scopeTasks', 'tareas');
        const busyTxt = isGlobal ? t('tasks.analysis.busyReorg', 'reorganizando todo') : t('tasks.analysis.busyAnalyze', 'analizando las {label}', { label });
        // En 'global' un id puede ser tarea o plan → buscar en ambos.
        const titleOf = (id) => {
          const it = (isPlans ? plans : tasks).find((x) => x.id === id)
            || (isGlobal ? plans.find((x) => x.id === id) : null);
          return it ? it.title : id;
        };
        let polling = false;
        let dirty = false;       // aplicamos algo ⇒ recargar el tablero al cerrar
        let lastResult = null;
        const am = dialog.openModal({
          title: isGlobal ? t('tasks.analysis.titleReorg', '🧹 Reorganizar todo con IA') : t('tasks.analysis.title', '🧠 Análisis general · {label}', { label }), width: '640px',
          onClose: () => { polling = false; if (dirty) boardApi?.reload(); },
        });
        am.body.innerHTML = `
          <div class="tk-analysis">
            <div class="tk-an-head">
              <span class="tk-an-sub">${isGlobal
                ? t('tasks.analysis.subReorg', 'Analiza tareas, planes e informes juntos: unifica duplicados, agrupa tareas en planes, completa info y crea las tareas de informes que faltan.')
                : t('tasks.analysis.subAnalyze', 'Detecta duplicados, unificables y completa info faltante con los informes.')}</span>
              <button class="btn btn--sm" data-ref="run">${icon('sparkle', { size: 13 })}<span>${t('tasks.analysis.run', 'Analizar')}</span></button>
            </div>
            <div class="tk-an-status" data-ref="status" hidden></div>
            <div class="tk-an-result" data-ref="result"></div>
          </div>`;
        const runBtn = am.body.querySelector('[data-ref="run"]');
        const statusEl = am.body.querySelector('[data-ref="status"]');
        const resultEl = am.body.querySelector('[data-ref="result"]');

        function propCard(kind, idx, headHtml, bodyHtml) {
          return `<div class="tk-an-card" data-kind="${kind}" data-idx="${idx}">
            <div class="tk-an-card-h">${headHtml}</div>
            ${bodyHtml}
            <div class="tk-an-card-acts">
              <button class="btn-ghost btn--sm" data-dismiss>${t('tasks.analysis.dismiss', 'Descartar')}</button>
              <button class="btn btn--sm" data-ap>${t('tasks.analysis.approve', 'Aprobar')}</button>
            </div>
            <div class="tk-an-card-state" hidden></div>
          </div>`;
        }
        function section(title, items, cards, open) {
          return `<details class="tk-an-sec"${open ? ' open' : ''}>
            <summary class="tk-an-sec-h">${title} <span class="tk-an-n">${items.length}</span></summary>
            <div class="tk-an-sec-b">${items.length ? cards : `<div class="dash-empty">${t('tasks.analysis.sectionEmpty', 'Nada por acá.')}</div>`}</div></details>`;
        }
        function renderAnalysis(result) {
          lastResult = result;
          const dup = result.duplicados || [];
          const unif = result.unificables || [];
          const comp = result.completar || [];
          const grp = result.agrupar || [];
          const crea = result.crearTareas || [];
          const temas = result.crearTemas || [];
          const total = dup.length + unif.length + comp.length + (isGlobal ? grp.length + crea.length + temas.length : 0);
          const dupCards = dup.map((d, i) => propCard('dup', i,
            `🔁 ${t('tasks.analysis.keep', 'Conservar')} <b>${esc(titleOf(d.keep))}</b>`,
            `<div class="tk-an-line">${t('tasks.analysis.removeLbl', 'Eliminar:')} ${d.remove.map((id) => esc(titleOf(id))).join(', ')}</div>${d.why ? `<div class="tk-an-why">${esc(d.why)}</div>` : ''}`)).join('');
          const unifCards = unif.map((u, i) => propCard('unif', i,
            `🔗 ${t('tasks.analysis.unifHead', 'Unir {n} en uno', { n: u.ids.length })}`,
            `<div class="tk-an-line">${u.ids.map((id) => esc(titleOf(id))).join(' + ')} → <b>${esc(u.title || t('tasks.analysis.sameTitle', '(mismo título)'))}</b></div>${u.description ? `<div class="tk-an-desc">${esc(u.description)}</div>` : ''}${u.why ? `<div class="tk-an-why">${esc(u.why)}</div>` : ''}`)).join('');
          const compCards = comp.map((c, i) => propCard('comp', i,
            `📝 ${t('tasks.analysis.completeVerb', 'Completar')} <b>${esc(titleOf(c.id))}</b>`,
            `${c.description ? `<div class="tk-an-desc">${esc(c.description)}</div>` : ''}${(c.tags || []).length ? `<div class="task-tags">${c.tags.map((x) => `<span class="task-tag">${esc(x)}</span>`).join('')}</div>` : ''}${c.why ? `<div class="tk-an-why">${esc(c.why)}</div>` : ''}`)).join('');
          // 🗂️ Agrupar en plan (solo global): plan existente (planId) o nuevo (planTitle).
          const grpCards = grp.map((g, i) => propCard('group', i,
            g.planId ? `🗂️ ${t('tasks.analysis.addToPlan', 'Sumar al plan')} <b>${esc(titleOf(g.planId))}</b>` : `🗂️ ${t('tasks.plan.new', 'Nuevo plan')} <b>${esc(g.planTitle)}</b>`,
            `<div class="tk-an-line">${g.taskIds.map((id) => esc(titleOf(id))).join(', ')}</div>${!g.planId && g.planDescription ? `<div class="tk-an-desc">${esc(g.planDescription)}</div>` : ''}${g.why ? `<div class="tk-an-why">${esc(g.why)}</div>` : ''}`)).join('');
          // 🎙️ Crear desde informe (solo global): tareas propuestas aún no cargadas.
          const creaCards = crea.map((c, i) => propCard('create', i,
            `🎙️ ${t('tasks.analysis.createTasks', 'Crear {n} tarea(s)', { n: c.tasks.length })}${c.fromReport ? ` ${t('tasks.analysis.from', 'de')} <b>${esc(c.fromReport)}</b>` : ''}`,
            `<div class="tk-an-line">${c.tasks.map((t) => esc(t.title)).join(' · ')}</div>${c.why ? `<div class="tk-an-why">${esc(c.why)}</div>` : ''}`)).join('');
          // 🎓 Temas de aprendizaje sugeridos (solo global): puente Pendientes → Banco.
          const SCOPE_EMO = { console: '🖥️', tolkien: '🌳' };
          const temasCards = temas.map((s, i) => propCard('createtema', i,
            `🎓 ${t('tasks.analysis.learn', 'Aprender:')} <b>${esc(s.title)}</b>`,
            `<div class="tk-an-line">${s.area ? `${esc(s.area)} · ` : ''}${SCOPE_EMO[s.scope] || '🖥️'} ${esc(s.scope)}</div>${s.why ? `<div class="tk-an-why">${esc(s.why)}</div>` : ''}`)).join('');
          resultEl.innerHTML = `
            ${result.resumen ? `<div class="tk-an-summary">${esc(result.resumen)}</div>` : ''}
            ${total ? '' : `<div class="dash-empty">${t('tasks.analysis.allClean', '✅ Todo prolijo: nada para unificar, agrupar ni completar.')}</div>`}
            ${section(t('tasks.analysis.secDup', '🔁 Duplicados'), dup, dupCards, dup.length > 0)}
            ${section(t('tasks.analysis.secUnif', '🔗 Unificables'), unif, unifCards, unif.length > 0)}
            ${section(t('tasks.analysis.secComp', '📝 Completar info'), comp, compCards, comp.length > 0)}
            ${isGlobal ? section(t('tasks.analysis.secGroup', '🗂️ Agrupar en planes'), grp, grpCards, grp.length > 0) : ''}
            ${isGlobal ? section(t('tasks.analysis.secCreate', '🎙️ Crear desde informes'), crea, creaCards, crea.length > 0) : ''}
            ${isGlobal ? section(t('tasks.analysis.secTemas', '🎓 Temas de aprendizaje sugeridos'), temas, temasCards, temas.length > 0) : ''}`;
        }

        const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        const delUrl = (id) => (isPlans ? `/api/tasks/plans/${id}/delete` : `/api/tasks/${id}/delete`);
        const updUrl = (id) => (isPlans ? `/api/tasks/plans/${id}` : `/api/tasks/${id}`);
        async function applyProposal(kind, p) {
          if (kind === 'dup') {
            for (const id of p.remove) await post(delUrl(id));
          } else if (kind === 'unif') {
            const [first, ...rest] = p.ids;
            await post(updUrl(first), { title: p.title || undefined, description: p.description || undefined });
            for (const id of rest) await post(delUrl(id));
          } else if (kind === 'comp') {
            const body = { description: p.description };
            if (!isPlans && (p.tags || []).length) body.tags = p.tags;
            await post(updUrl(p.id), body);
          } else if (kind === 'group') {
            // Plan destino: existente (planId) o recién creado (planTitle).
            let planId = p.planId;
            if (!planId) {
              const j = await (await post('/api/tasks/plans', { title: p.planTitle, description: p.planDescription || undefined })).json();
              planId = j?.plan?.id;
            }
            if (!planId) throw new Error('sin plan destino');
            for (const id of p.taskIds) await post(`/api/tasks/${id}`, { planId });
          } else if (kind === 'create') {
            for (const t of p.tasks) await post('/api/tasks', t);
          } else if (kind === 'createtema') {
            // Puente al Banco de conocimiento: crea el tema de aprendizaje sugerido.
            await post('/api/learning', { title: p.title, area: p.area, scope: p.scope });
          }
          dirty = true;
        }

        resultEl.addEventListener('click', async (e) => {
          const card = e.target.closest('.tk-an-card');
          if (!card) return;
          const ap = e.target.closest('[data-ap]');
          const dis = e.target.closest('[data-dismiss]');
          if (!ap && !dis) return;
          const kind = card.dataset.kind;
          const LISTS = { dup: 'duplicados', unif: 'unificables', comp: 'completar', group: 'agrupar', create: 'crearTareas', createtema: 'crearTemas' };
          const list = lastResult[LISTS[kind]];
          const p = list?.[Number(card.dataset.idx)];
          if (!p) return;
          const acts = card.querySelector('.tk-an-card-acts');
          const stateEl = card.querySelector('.tk-an-card-state');
          if (dis) { card.classList.add('tk-an-card--dismissed'); acts?.remove(); stateEl.hidden = false; stateEl.textContent = t('tasks.analysis.stateDismissed', 'Descartada'); return; }
          acts.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          stateEl.hidden = false; stateEl.textContent = t('tasks.analysis.applying', 'Aplicando…');
          try {
            await applyProposal(kind, p);
            card.classList.add('tk-an-card--done'); acts.remove(); stateEl.textContent = t('tasks.analysis.applied', '✓ Aplicada');
          } catch {
            acts.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            stateEl.textContent = t('tasks.analysis.applyError', '✕ Error al aplicar');
          }
        });

        async function poll() {
          for (let i = 0; i < 130 && polling; i += 1) {
            await new Promise((r) => setTimeout(r, 2000));
            let j;
            try { j = await (await fetch(`/api/tasks/analysis?scope=${scope}`)).json(); } catch { continue; }
            if (!j || j.status === 'running') continue;
            return j;
          }
          return null;
        }
        async function analyze() {
          const ok = await dialog.confirmDialog({
            title: isGlobal ? t('tasks.analysis.confirmTitleReorg', 'Reorganizar todo con IA') : t('tasks.analysis.confirmTitle', 'Análisis general'),
            message: `${isGlobal ? t('tasks.analysis.confirmMsgReorgPre', 'Se analizan tareas, planes e informes juntos') : t('tasks.analysis.confirmMsgAnalyzePre', 'Se analizan todas las {label}', { label })}${t('tasks.analysis.confirmMsgTail', ' con Claude (sonnet). CONSUME TOKENS reales y puede tardar. Es de solo lectura; nada se aplica sin tu aprobación.')}`,
            confirmLabel: isGlobal ? t('tasks.analysis.confirmReorg', 'Reorganizar') : t('tasks.analysis.run', 'Analizar'),
          });
          if (!ok) return;
          runBtn.disabled = true;
          resultEl.innerHTML = '';
          statusEl.hidden = false; statusEl.className = 'tk-an-status';
          statusEl.innerHTML = `${pacman({ state: 'delegating' })} <span>${busyTxt}…</span>`;
          polling = true;
          try {
            const r = await post('/api/tasks/analyze', { scope });
            const started = await r.json();
            if (!r.ok) throw new Error(started.error || t('tasks.analysis.errStart', 'No se pudo iniciar el análisis.'));
            const j = started.status === 'done' ? started : await poll();
            if (!j) throw new Error(t('tasks.analysis.errInterrupted', 'El análisis se interrumpió. Reintentá.'));
            if (j.status === 'error') throw new Error(j.error || t('tasks.analysis.errFailed', 'El análisis falló.'));
            statusEl.hidden = true;
            renderAnalysis(j.result);
            runBtn.querySelector('span').textContent = t('tasks.analysis.reanalyze', 'Volver a analizar');
          } catch (err) {
            statusEl.className = 'tk-an-status tk-an-status--err'; statusEl.textContent = err.message || t('tasks.analysis.errGeneric', 'Error al analizar.');
          } finally {
            runBtn.disabled = false; polling = false;
          }
        }
        runBtn.addEventListener('click', analyze);
        const origClose = am.close;
        am.close = () => { polling = false; origClose(); };

        // Al abrir: si hay un resultado previo persistido, mostrarlo; si corre, encuestar.
        (async () => {
          try {
            const j = await (await fetch(`/api/tasks/analysis?scope=${scope}`)).json();
            if (j.status === 'done' && j.result) { renderAnalysis(j.result); runBtn.querySelector('span').textContent = t('tasks.analysis.reanalyze', 'Volver a analizar'); }
            else if (j.status === 'running') {
              polling = true; statusEl.hidden = false; statusEl.className = 'tk-an-status';
              statusEl.innerHTML = `${pacman({ state: 'delegating' })} <span>${busyTxt}…</span>`;
              const done = await poll();
              if (done && done.status === 'done' && done.result) { statusEl.hidden = true; renderAnalysis(done.result); runBtn.querySelector('span').textContent = t('tasks.analysis.reanalyze', 'Volver a analizar'); }
              else { statusEl.hidden = true; }
            }
          } catch { /* noop */ }
        })();
      }

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
