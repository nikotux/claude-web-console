// modules/learning/learning.js — pestaña "🎓 Aprendizaje" del Banco de
// conocimiento (tablero del módulo `tasks`). Registro de los TEMAS que el dueño
// va aprendiendo/reforzando (instrucciones de Chris, cómo funciona el backend,
// GetPad, GitHub, cómo proponer un fix). Aprendizaje ASISTIDO:
//   · "🎓 Explicame esto" (por tema): corrida IA read-only que NAVEGA el código
//     real y AUTO-GUARDA una explicación como material de estudio editable.
//   · RUTAS de aprendizaje (LR<n>): agrupan temas con progreso % (temas dominados).
//   · "🧠 Analizar aprendizaje": IA que organiza los temas (duplicados, unificar,
//     completar, agrupar en rutas, qué aprender primero, temas nuevos). Las
//     propuestas NUNCA se auto-aplican: Aprobar/Descartar por ítem.
//
// UI colapsable + árbol (regla del proyecto). Se monta desde tasks.js con el
// patrón mountReports: export mountLearning(container, ctx) → { reload }.
// ctx = { icon, dialog, bus, whoami }.
import { renderMarkdown } from '../../ui/markdown.js';
import { pacman } from '../../ui/pacman.js';

// renderMarkdown() devuelve un NODO DOM (ya sanitizado en su interior); para
// interpolarlo en un template de innerHTML necesitamos su HTML como string
// (si no, se stringifica a "[object HTMLDivElement]"). Es seguro: el nodo ya
// pasó por sanitize() dentro de renderMarkdown.
const mdHtml = (s) => renderMarkdown(s).innerHTML;

const STATUS = [
  { key: 'por-aprender', label: 'Por aprender', emoji: '🔴' },
  { key: 'reforzando', label: 'Reforzando', emoji: '🟡' },
  { key: 'dominado', label: 'Dominado', emoji: '🟢' },
];
const PRIO = [
  { key: 'alta', label: 'Alta', emoji: '🔴' },
  { key: 'media', label: 'Media', emoji: '🟡' },
  { key: 'baja', label: 'Baja', emoji: '🟢' },
];
const SCOPE = [
  { key: 'console', label: 'Mi Consola', emoji: '🖥️' },
  { key: 'tolkien', label: 'Tolkien', emoji: '🌳' },
];
const ROUTE_STATUS = [
  { key: 'activa', label: 'Activa', emoji: '🟢' },
  { key: 'propuesta', label: 'Propuesta', emoji: '💭' },
  { key: 'completada', label: 'Completada', emoji: '✅' },
  { key: 'archivada', label: 'Archivada', emoji: '🗃️' },
];
const statusOf = (k) => STATUS.find((s) => s.key === k) || STATUS[0];
const prioOf = (k) => PRIO.find((p) => p.key === k) || PRIO[1];
const scopeOf = (k) => SCOPE.find((s) => s.key === k) || SCOPE[0];
const routeStatusOf = (k) => ROUTE_STATUS.find((s) => s.key === k) || ROUTE_STATUS[0];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Catálogo de secciones de la explicación guiada (ver explain-shared.js
// explainPrompt): cada `##` del markdown se pinta como una FILA-ACORDEÓN con
// su ícono propio (UI colapsable + árbol, regla del proyecto) en vez de un
// chorizo de texto — "En una línea" nace abierta (resumen), el resto colapsado.
const SECTION_ICONS = {
  'en una línea': '⚡',
  'cómo funciona por dentro': '🔧',
  'piezas clave': '🧩',
  'cómo se conecta': '🔗',
  'paso a paso': '🧭',
  'errores comunes': '⚠️',
  'para tu caso': '🎯',
  'para reforzar': '📌',
};
function sectionIcon(title) { return SECTION_ICONS[String(title || '').trim().toLowerCase()] || '📄'; }
function splitSections(md) {
  const text = String(md || '').trim();
  if (!text) return [];
  if (!/^##\s/.test(text)) return [{ title: '', body: text }];
  return text.split(/\n(?=##\s)/g).map((p) => {
    const m = p.match(/^##\s*(.+?)\s*\n([\s\S]*)$/);
    if (!m) return { title: p.replace(/^##\s*/, '').trim(), body: '' };
    return { title: m[1].trim(), body: m[2].trim() };
  }).filter((s) => s.title || s.body);
}

function fmtAgo(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s >= 86400) return `hace ${Math.floor(s / 86400)} d`;
  if (s >= 3600) return `hace ${Math.floor(s / 3600)} h`;
  if (s >= 60) return `hace ${Math.floor(s / 60)} min`;
  return 'recién';
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

export function mountLearning(container, ctx) {
  const { icon, dialog, whoami } = ctx;
  let isAdmin = false;
  whoami?.then?.((me) => { isAdmin = !!me?.admin; if (adminBtnEl) adminBtnEl.style.display = isAdmin ? '' : 'none'; });

  // cwd de Tolkien para "Profundizar en chat" (mismo patrón que tickets.js/
  // comms.js): default 'tolkien' hasta que /api/tolkien/status resuelva el rel real.
  let tolkienRel = 'tolkien';
  (async () => { try { const st = await (await fetch('/api/tolkien/status')).json(); if (st?.rel) tolkienRel = st.rel; } catch { /* noop */ } })();

  let topics = [];
  let routes = [];
  let filter = 'activos'; // activos | todos | dominados | route:<id>

  container.innerHTML = `
    <div class="lt-wrap">
      <div class="lt-head">
        <div class="lt-filters" data-ref="filters">
          <button class="lt-fchip on" data-filter="activos">Aprendiendo</button>
          <button class="lt-fchip" data-filter="dominados">Dominados</button>
          <button class="lt-fchip" data-filter="todos">Todos</button>
        </div>
        <button class="btn-ghost btn--sm" data-ref="analyze" title="Analizar el aprendizaje con IA: organiza, agrupa en rutas y sugiere qué aprender (consume tokens)" style="display:none">${icon('sparkle', { size: 13 })}<span>Analizar</span></button>
        <button class="btn btn--sm" data-ref="new" title="Agregar un tema para aprender">${icon('plus', { size: 13 })}<span>Nuevo tema</span></button>
      </div>
      <div class="lt-intro">🎓 Temas que vas aprendiendo/reforzando. Agrupalos en <b>rutas</b>, tocá “🎓 Explicame esto” para un repaso que <b>lee el código real</b>, y usá “Analizar” para que la IA organice todo y sugiera qué estudiar.</div>
      <details class="lt-routes-sec" data-ref="routessec">
        <summary><span data-ref="routestitle">🗺️ Rutas de aprendizaje</span></summary>
        <div class="lt-routes" data-ref="routes"></div>
        <button class="btn-ghost btn--sm" data-ref="newroute">${icon('plus', { size: 12 })}<span>Nueva ruta</span></button>
      </details>
      <div class="lt-grid" data-ref="grid">cargando…</div>
    </div>`;

  const gridEl = container.querySelector('[data-ref="grid"]');
  const filtersEl = container.querySelector('[data-ref="filters"]');
  const routesEl = container.querySelector('[data-ref="routes"]');
  const routesTitleEl = container.querySelector('[data-ref="routestitle"]');
  const adminBtnEl = container.querySelector('[data-ref="analyze"]');

  function routeById(id) { return routes.find((r) => r.id === id); }

  function visibleTopics() {
    if (filter.startsWith('route:')) { const id = filter.slice(6); return topics.filter((t) => t.routeId === id); }
    if (filter === 'todos') return topics;
    if (filter === 'dominados') return topics.filter((t) => t.status === 'dominado');
    return topics.filter((t) => t.status !== 'dominado');
  }

  function card(t) {
    const st = statusOf(t.status);
    const sc = scopeOf(t.scope);
    const rt = t.routeId ? routeById(t.routeId) : null;
    return `<div class="lt-card" data-id="${esc(t.id)}" role="button" tabindex="0">
      <div class="lt-card-top">
        <span class="lt-dot" title="${esc(st.label)}">${st.emoji}</span>
        <span class="lt-scope" title="${esc(sc.label)}">${sc.emoji}</span>
        ${t.explanation ? '<span class="lt-expbadge" title="Ya tiene explicación guiada">📖</span>' : ''}
        ${(t.contextoEntradas || []).length ? '<span class="lt-expbadge" title="Tiene contexto adicional (charlas/notas)">🎙️</span>' : ''}
      </div>
      <div class="lt-card-title">${esc(t.title)}</div>
      ${t.area ? `<div class="lt-card-area">${esc(t.area)}</div>` : ''}
      ${rt ? `<div class="lt-card-route" title="Ruta">🗺️ ${esc(rt.title)}</div>` : ''}
      ${(t.tags || []).length ? `<div class="lt-card-tags">${t.tags.slice(0, 4).map((x) => `<span class="lt-tag">${esc(x)}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  function renderRoutes() {
    routesTitleEl.textContent = `🗺️ Rutas de aprendizaje${routes.length ? ` (${routes.length})` : ''}`;
    if (!routes.length) {
      routesEl.innerHTML = '<div class="lt-muted">Sin rutas todavía. Agrupá temas relacionados en un camino de estudio (o dejá que “Analizar” lo proponga).</div>';
      return;
    }
    routesEl.innerHTML = routes.map((r) => {
      const rs = routeStatusOf(r.status);
      const active = filter === `route:${r.id}`;
      return `<div class="lt-route${active ? ' on' : ''}" data-route="${esc(r.id)}">
        <div class="lt-route-h">
          <span class="lt-route-title" role="button" tabindex="0" data-routefilter="${esc(r.id)}" title="Ver sus temas">${rs.emoji} ${esc(r.title)}</span>
          <span class="lt-route-meta">${r.doneCount}/${r.topicCount} · ${r.pct}%</span>
          <button class="btn-ghost btn--sm btn--icon" data-routeedit="${esc(r.id)}" title="Editar ruta">${icon('edit', { size: 12 })}</button>
          <button class="btn-ghost btn--sm btn--icon lt-danger" data-routedel="${esc(r.id)}" title="Eliminar ruta">${icon('trash', { size: 12 })}</button>
        </div>
        <div class="lt-route-bar"><span style="width:${r.pct}%"></span></div>
      </div>`;
    }).join('');
  }

  function renderGrid() {
    const vis = visibleTopics();
    const filterNote = filter.startsWith('route:') ? `<div class="lt-filternote">Mostrando temas de la ruta <b>${esc(routeById(filter.slice(6))?.title || '')}</b> · <span class="lt-clearfilter" role="button" tabindex="0">ver todos</span></div>` : '';
    if (!vis.length) {
      gridEl.innerHTML = `${filterNote}<div class="lt-none">${topics.length ? 'Nada en este filtro.' : 'Todavía no cargaste ningún tema. Usá “Nuevo tema” para empezar (ej: “Cómo funciona GetPad”, “Cómo proponer un fix en un PR”).'}</div>`;
    } else {
      gridEl.innerHTML = filterNote + vis.map(card).join('');
    }
    gridEl.querySelectorAll('.lt-card').forEach((c) => {
      const open = () => openDetail(c.dataset.id);
      c.addEventListener('click', open);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    const cf = gridEl.querySelector('.lt-clearfilter');
    if (cf) cf.addEventListener('click', () => { filter = 'activos'; syncFilterChips(); renderRoutes(); renderGrid(); });
  }

  function syncFilterChips() {
    filtersEl.querySelectorAll('.lt-fchip').forEach((c) => c.classList.toggle('on', c.dataset.filter === filter));
  }

  async function load() {
    try {
      const d = await api('/api/learning');
      topics = d.topics || [];
      routes = d.routes || [];
      renderRoutes();
      renderGrid();
    } catch { gridEl.innerHTML = '<div class="lt-none">No se pudieron leer los temas.</div>'; }
  }

  // ===== Formularios =====
  function routeOptions(sel) {
    return `<option value="">— sin ruta —</option>${routes.map((r) => `<option value="${r.id}"${r.id === sel ? ' selected' : ''}>${esc(r.title)}</option>`).join('')}`;
  }

  function topicForm(existing) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); };
      const isEdit = !!existing;
      const t = existing || { title: '', area: '', scope: 'console', status: 'por-aprender', priority: 'media', tags: [], routeId: null, notes: '', question: '' };
      const m = dialog.openModal({ title: isEdit ? `Editar ${t.id}` : 'Nuevo tema', width: '540px', onClose: () => finish(null) });
      m.body.innerHTML = `
        <div class="task-form">
          <label class="task-fld"><span>Tema</span>
            <input type="text" data-f="title" maxlength="200" placeholder="Ej: Cómo funciona GetPad" value="${esc(t.title)}" /></label>
          <div class="task-form-row">
            <label class="task-fld"><span>Área</span>
              <input type="text" data-f="area" maxlength="80" placeholder="Ej: Backend Tolkien, GitHub/PRs" value="${esc(t.area || '')}" /></label>
            <label class="task-fld"><span>Alcance (qué código navega la IA)</span>
              <select data-f="scope">${SCOPE.map((s) => `<option value="${s.key}"${s.key === (t.scope || 'console') ? ' selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}</select></label>
          </div>
          <div class="task-form-row">
            <label class="task-fld"><span>Estado</span>
              <select data-f="status">${STATUS.map((s) => `<option value="${s.key}"${s.key === t.status ? ' selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}</select></label>
            <label class="task-fld"><span>Prioridad</span>
              <select data-f="priority">${PRIO.map((p) => `<option value="${p.key}"${p.key === t.priority ? ' selected' : ''}>${p.emoji} ${p.label}</option>`).join('')}</select></label>
            <label class="task-fld"><span>Ruta</span>
              <select data-f="routeId">${routeOptions(t.routeId)}</select></label>
          </div>
          <label class="task-fld"><span>Pregunta puntual (opcional)</span>
            <input type="text" data-f="question" maxlength="1000" placeholder="Qué querés entender exactamente" value="${esc(t.question || '')}" /></label>
          <label class="task-fld"><span>Notas / contexto (Markdown)</span>
            <textarea data-f="notes" rows="5" maxlength="8000" placeholder="Instrucciones de Chris, detalles previos, lo que ya sabés… (soporta Markdown)">${esc(t.notes || '')}</textarea></label>
        </div>
        <div class="dlg-actions">
          <button class="btn-ghost" data-a="cancel">Cancelar</button>
          <button class="btn" data-a="save">${isEdit ? 'Guardar' : 'Crear'}</button>
        </div>`;
      const get = (f) => m.body.querySelector(`[data-f="${f}"]`).value;
      m.body.querySelector('[data-a="cancel"]').addEventListener('click', () => m.close());
      m.body.querySelector('[data-a="save"]').addEventListener('click', () => {
        const payload = {
          title: get('title').trim(), area: get('area').trim(), scope: get('scope'),
          status: get('status'), priority: get('priority'), routeId: get('routeId') || null,
          question: get('question').trim(), notes: get('notes'),
        };
        if (!payload.title) { m.body.querySelector('[data-f="title"]').focus(); return; }
        finish(payload); m.close();
      });
      setTimeout(() => m.body.querySelector('[data-f="title"]')?.focus(), 30);
    });
  }

  function routeForm(existing) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); };
      const isEdit = !!existing;
      const r = existing || { title: '', description: '', status: 'activa' };
      const m = dialog.openModal({ title: isEdit ? `Editar ${r.id}` : 'Nueva ruta', width: '480px', onClose: () => finish(null) });
      m.body.innerHTML = `
        <div class="task-form">
          <label class="task-fld"><span>Título de la ruta</span>
            <input type="text" data-f="title" maxlength="200" placeholder="Ej: Dominar el ciclo de un PR" value="${esc(r.title)}" /></label>
          <label class="task-fld"><span>Estado</span>
            <select data-f="status">${ROUTE_STATUS.map((s) => `<option value="${s.key}"${s.key === r.status ? ' selected' : ''}>${s.emoji} ${s.label}</option>`).join('')}</select></label>
          <label class="task-fld"><span>Descripción (Markdown)</span>
            <textarea data-f="description" rows="3" maxlength="4000" placeholder="Qué cubre esta ruta">${esc(r.description || '')}</textarea></label>
        </div>
        <div class="dlg-actions">
          <button class="btn-ghost" data-a="cancel">Cancelar</button>
          <button class="btn" data-a="save">${isEdit ? 'Guardar' : 'Crear'}</button>
        </div>`;
      const get = (f) => m.body.querySelector(`[data-f="${f}"]`).value;
      m.body.querySelector('[data-a="cancel"]').addEventListener('click', () => m.close());
      m.body.querySelector('[data-a="save"]').addEventListener('click', () => {
        const payload = { title: get('title').trim(), status: get('status'), description: get('description') };
        if (!payload.title) { m.body.querySelector('[data-f="title"]').focus(); return; }
        finish(payload); m.close();
      });
      setTimeout(() => m.body.querySelector('[data-f="title"]')?.focus(), 30);
    });
  }

  // ===== Detalle del tema =====
  async function openDetail(id) {
    let dirty = false, pollTimer = null, alive = true;
    const m = dialog.openModal({ title: '🎓 Tema', width: 'min(1080px, 94vw)', onClose: () => { alive = false; if (pollTimer) clearTimeout(pollTimer); if (dirty) load(); } });

    async function fresh() {
      try { return (await api(`/api/learning/${id}`)).topic; }
      catch { return topics.find((x) => x.id === id) || null; }
    }

    async function render() {
      const t = await fresh();
      if (!alive) return;
      if (!t) { m.body.innerHTML = '<div class="lt-none">El tema ya no existe.</div>'; return; }
      const st = statusOf(t.status); const pr = prioOf(t.priority); const sc = scopeOf(t.scope);
      const rt = t.routeId ? routeById(t.routeId) : null;
      const nextStatus = t.status === 'por-aprender' ? 'reforzando' : t.status === 'reforzando' ? 'dominado' : null;
      const advLabel = t.status === 'por-aprender' ? '🟡 Marcar “reforzando”' : t.status === 'reforzando' ? '🟢 Marcar “dominado”' : null;

      const sections = splitSections(t.explanation);
      // GUÍA (columna izquierda ANCHA): toda la explicación renderizada DE
      // CORRIDO en un solo documento formateado, para leerla entera.
      const guiaBody = !t.explanation
        ? '<div class="lt-exp-empty">Todavía no generaste la guía de este tema. "Regenerar" analiza TODO de una pasada — código real + tus notas + el contexto adicional — y arma la guía completa.</div>'
        : `<div class="lt-exp-md lt-guia-doc">${mdHtml(t.explanation)}</div>`;
      // SECCIONES (columna derecha ANGOSTA): las MISMAS partes, separadas en un
      // acordeón para saltar/enfocar. Son las piezas que componen la Guía.
      const seccionesBody = !t.explanation
        ? '<div class="lt-muted">Las secciones aparecen al generar la guía — son las piezas que la componen.</div>'
        : sections.length > 1
          ? sections.map((s, i) => `
              <details class="lt-exp-sec"${i === 0 ? ' open' : ''}>
                <summary>${sectionIcon(s.title)} ${esc(s.title || 'Sección')}</summary>
                <div class="lt-exp-sec-body">${mdHtml(s.body)}</div>
              </details>`).join('')
          : '<div class="lt-muted">La guía no tiene secciones separables (regeneralá para que las arme).</div>';
      const versions = t.explainVersions || [];
      const histHtml = versions.length
        ? `<details class="lt-exp-hist"><summary>🕑 Versiones anteriores (${versions.length})</summary>
            <div class="lt-exp-hist-list">${versions.map((v, i) => `
              <details class="lt-exp-hist-item"><summary>v-${versions.length - i} · ${esc(v.model || '')} · ${fmtAgo(v.at)}</summary>
              <div class="lt-exp-sec-body">${mdHtml(v.explanation)}</div></details>`).join('')}
            </div></details>`
        : '';
      const checkNote = (() => {
        const c = t.explainCheck;
        if (!t.explanation || !c) return '';
        if (!c.stale) return '<div class="lt-exp-fresh">🟢 Al día — sin cambios de notas, contexto ni código desde la última vez.</div>';
        const why = c.reason === 'code' ? 'el código citado cambió' : 'hay notas/contexto nuevos';
        return `<div class="lt-exp-stalenote">🟡 Hay cambios (${esc(why)}) — "Regenerar" va a ADAPTAR la guía, no empezar de cero.</div>`;
      })();
      const foot = t.explanation ? `<div class="lt-exp-foot">📖 Guía${t.explainModel ? ` · ${esc(t.explainModel)}` : ''}${t.explainedAt ? ` · ${fmtAgo(t.explainedAt)}` : ''}.</div>` : '';
      const explainBtn = isAdmin
        ? `<button class="btn btn--sm" data-a="explain">${icon('sparkle', { size: 13 })}<span>${t.explanation ? '🔄 Regenerar' : '🎓 Generar guía completa'}</span></button>`
        : '<span class="lt-adminnote">Pedile a un admin que genere la guía (consume tokens).</span>';
      const forceLink = (isAdmin && t.explanation)
        ? '<span class="lt-force-link" data-a="explainforce" role="button" tabindex="0">Forzar regeneración completa</span>'
        : '';

      // Origen de cada entrada de contexto: 🎙️ IA · 💬 chat · ✍️ manual.
      const cxBadge = (src) => (src === 'ia' ? '🎙️ IA' : src === 'chat' ? '💬 chat' : '✍️ manual');
      const cxBadgeCls = (src) => (src === 'ia' ? ' lt-cx-ia' : src === 'chat' ? ' lt-cx-chat' : '');
      const ctxEntries = Array.isArray(t.contextoEntradas) ? t.contextoEntradas : [];
      const ctxInner = ctxEntries.length
        ? ctxEntries.map((e) => `<div class="lt-cx-item" data-cx="${esc(e.id)}">
            <div class="lt-cx-head">
              <span class="lt-cx-badge${cxBadgeCls(e.source)}">${cxBadge(e.source)}</span>
              <span class="lt-cx-when">${fmtAgo(e.at)}</span>
              <span class="lt-cx-acts">
                <button class="btn-ghost btn--sm btn--icon" data-a="cxedit" data-cx="${esc(e.id)}" title="Editar entrada">${icon('edit', { size: 12 })}</button>
                <button class="btn-ghost btn--sm btn--icon lt-danger" data-a="cxdel" data-cx="${esc(e.id)}" title="Borrar entrada">${icon('trash', { size: 12 })}</button>
              </span>
            </div>
            <div class="lt-cx-text">${esc(e.text)}</div>
          </div>`).join('')
        : '<div class="lt-muted">Sin contexto adicional todavía. Sumá una nota manual, pegá una transcripción, o abrí “💬 Profundizar en chat” (al cerrarlo, su resumen vuelve solo acá) — todo se incorpora a la próxima guía.</div>';

      m.body.innerHTML = `
        <div class="lt-detail">
          <!-- PIEZA 1 (ancho completo): info básica del tema + contexto -->
          <div class="lt-d-head"><span class="lt-d-id">${esc(t.id)}</span><h3 class="lt-d-title">${esc(t.title)}</h3></div>
          <div class="lt-d-props">
            <span class="lt-chip">${st.emoji} ${esc(st.label)}</span>
            <span class="lt-chip">Prioridad ${pr.emoji} ${esc(pr.label)}</span>
            <span class="lt-chip">${sc.emoji} ${esc(sc.label)}</span>
            ${t.area ? `<span class="lt-chip">📂 ${esc(t.area)}</span>` : ''}
            ${rt ? `<span class="lt-chip">🗺️ ${esc(rt.title)}</span>` : ''}
          </div>
          ${(t.tags || []).length ? `<div class="lt-card-tags">${t.tags.map((x) => `<span class="lt-tag">${esc(x)}</span>`).join('')}</div>` : ''}
          ${t.question ? `<div class="lt-d-q">❓ <b>Foco:</b> ${esc(t.question)}</div>` : ''}
          <details class="lt-sec"><summary>📝 Notas / contexto</summary>
            <div class="lt-sec-body">
              <div class="lt-notes-view" data-ref="notesview">
                <div class="lt-notes-md">${t.notes ? mdHtml(t.notes) : '<div class="lt-muted">Sin notas. Tocá ✏️ para escribir lo que ya sabés, instrucciones de Chris, etc.</div>'}</div>
                <button class="btn-ghost btn--sm" data-a="notesedit">${icon('edit', { size: 12 })}<span>${t.notes ? 'Editar' : 'Escribir notas'}</span></button>
              </div>
              <div class="lt-notes-edit" data-ref="notesedit" hidden>
                <textarea class="tkm-ta" data-ref="notesta" rows="5" placeholder="Notas del tema (soporta Markdown)…">${esc(t.notes || '')}</textarea>
                <div class="tkm-add-acts">
                  <button class="btn btn--sm" data-a="notessave">${icon('edit', { size: 12 })}<span>Guardar</span></button>
                  <button class="btn-ghost btn--sm" data-a="notescancel">Cancelar</button>
                  <span class="tkm-status" data-ref="notesstatus"></span>
                </div>
              </div>
            </div></details>
          <details class="lt-sec"><summary>🎙️ Contexto adicional${ctxEntries.length ? ` (${ctxEntries.length})` : ''}</summary>
            <div class="lt-sec-body">
              <div class="tkm-ctx lt-cx-list">${ctxInner}</div>
              <div class="lt-cx-addbar">
                <button class="btn-ghost btn--sm" data-a="cxnote">${icon('plus', { size: 12 })}<span>Agregar nota</span></button>
                <details class="tkm-add">
                  <summary>${icon('play', { size: 11 })} Interpretar una charla / transcripción</summary>
                  <textarea class="tkm-ta" data-ref="ctxta" rows="5" placeholder="Pegá acá la transcripción de la charla…"></textarea>
                  <div class="tkm-add-acts">
                    <button class="btn-ghost btn--sm" data-a="ctxanalyze">${icon('sparkle', { size: 12 })}<span>Interpretar con IA</span></button>
                    <span class="tkm-status" data-ref="ctxstatus"></span>
                  </div>
                </details>
              </div>
            </div></details>

          <!-- PIEZAS 2 y 3 (2 columnas asimétricas): Guía (ancha) + Secciones (angosta) -->
          <div class="lt-detail-cols">
            <section class="lt-col-main">
              <div class="lt-col-h">📖 Guía</div>
              <div class="lt-exp-status" data-ref="expstatus"></div>
              ${checkNote}
              <div class="lt-guia" data-ref="guia">${guiaBody}</div>
              ${histHtml}
              ${foot}
              <div class="lt-exp-actions">${explainBtn}${forceLink}</div>
            </section>
            <aside class="lt-col-side">
              <div class="lt-col-h">🧩 Secciones${sections.length > 1 ? ` (${sections.length})` : ''}</div>
              <div class="lt-secciones" data-ref="secciones">${seccionesBody}</div>
            </aside>
          </div>

          <!-- Acciones (ancho completo) -->
          <div class="lt-d-actions">
            ${ctx.openChat ? `<button class="btn-ghost btn--sm" data-a="chat">${icon('sparkle', { size: 13 })}<span>💬 Profundizar en chat</span></button>` : ''}
            ${advLabel ? `<button class="btn-ghost btn--sm" data-a="advance">${advLabel}</button>` : ''}
            <button class="btn-ghost btn--sm" data-a="edit">${icon('edit', { size: 13 })}<span>Editar</span></button>
            <button class="btn-ghost btn--sm lt-danger" data-a="delete">${icon('trash', { size: 13 })}<span>Eliminar</span></button>
          </div>
        </div>`;
      wire(t, nextStatus);
    }

    function buildChatPrompt(t) {
      const lines = [`Tema de aprendizaje: "${t.title}"${t.area ? ` (${t.area})` : ''}.`, `Alcance: ${scopeOf(t.scope).label}.`];
      if (t.question) lines.push(`Foco puntual: ${t.question}`);
      if (t.notes) lines.push(`\n== Notas / contexto ==\n${t.notes}`);
      const cxEntries = Array.isArray(t.contextoEntradas) ? t.contextoEntradas : [];
      if (cxEntries.length) lines.push(`\n== Contexto adicional ==\n${cxEntries.map((e) => `[${e.source === 'ia' ? 'charla interpretada' : 'nota manual'}] ${e.text}`).join('\n\n')}`);
      if (t.explanation) lines.push(`\n== Explicación guiada ya generada ==\n${t.explanation}`);
      lines.push('\nQuiero profundizar/trabajar este tema en este chat: repasemos, resolvamos dudas, y si hace falta aplicarlo a código real (ej. un fix, un PR), hacelo. Entendé el contexto de arriba antes de proponer nada.');
      return lines.join('\n');
    }

    function wire(t, nextStatus) {
      const statusEl = m.body.querySelector('[data-ref="expstatus"]');
      const ctxStatusEl = m.body.querySelector('[data-ref="ctxstatus"]');
      const setCtxStatus = (s) => { if (ctxStatusEl) ctxStatusEl.textContent = s || ''; };
      const q = (a) => m.body.querySelector(`[data-a="${a}"]`);
      const post = async (body) => { await api(`/api/learning/${t.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); dirty = true; await load(); render(); };
      const errBox = (e) => dialog.confirmDialog?.({ title: 'Error', message: String(e.message), confirmLabel: 'Ok' });

      q('edit')?.addEventListener('click', async () => { const patch = await topicForm(t); if (patch) post(patch).catch(errBox); });
      q('advance')?.addEventListener('click', () => { if (nextStatus) post({ status: nextStatus }).catch(errBox); });
      q('delete')?.addEventListener('click', async () => {
        const ok = await dialog.confirmDialog({ title: 'Eliminar tema', message: `¿Eliminar “${t.title}”? Se pierde también su explicación guiada. No se puede deshacer.`, confirmLabel: 'Eliminar', danger: true });
        if (!ok) return;
        try { await api(`/api/learning/${t.id}/delete`, { method: 'POST' }); dirty = true; m.close(); } catch (e) { errBox(e); }
      });
      q('chat')?.addEventListener('click', async () => {
        await ctx.openChat?.({
          cwd: t.scope === 'tolkien' ? tolkienRel : 'claude-web-console',
          mode: 'plan',
          prompt: buildChatPrompt(t),
          title: `🎓 ${t.title}`.slice(0, 60),
          learningId: t.id, // write-back: al cerrar el chat, su resumen vuelve como entrada 💬 del tema
        });
      });

      // ----- Explicación (regeneración inteligente: un solo botón) -----
      const runExplain = async (force) => {
        const msg = force
          ? `Vas a REGENERAR desde CERO la explicación de "${t.title}" (ignora lo que ya tenía). Consume tokens y puede tardar 1-2 min.`
          : `La IA revisa si hay cambios (notas, contexto adicional o código citado) desde la última vez y ${t.explanation ? 'ADAPTA' : 'genera'} la explicación de "${t.title}" — solo gasta tokens si hace falta.`;
        const ok = await dialog.confirmDialog({ title: '🎓 Regenerar explicación', message: msg, confirmLabel: force ? 'Forzar regeneración' : 'Regenerar' });
        if (!ok) return;
        try {
          const r = await api(`/api/learning/${t.id}/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force }) });
          if (r.status === 'noop') { statusEl.innerHTML = `<div class="lt-exp-fresh">🟢 ${esc(r.reason || 'Sin cambios, no hizo falta regenerar.')}</div>`; return; }
          poll(t.id, statusEl, r.mode);
        } catch (e) { statusEl.innerHTML = `<div class="lt-exp-err">${esc(String(e.message))}</div>`; }
      };
      q('explain')?.addEventListener('click', () => runExplain(false));
      const forceEl = q('explainforce');
      forceEl?.addEventListener('click', () => runExplain(true));
      forceEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runExplain(true); } });

      // ----- Notas / contexto: edición INLINE (sin abrir el form completo) -----
      const notesView = m.body.querySelector('[data-ref="notesview"]');
      const notesEditBox = m.body.querySelector('[data-ref="notesedit"]');
      const notesTa = m.body.querySelector('[data-ref="notesta"]');
      const notesStatus = m.body.querySelector('[data-ref="notesstatus"]');
      q('notesedit')?.addEventListener('click', () => {
        if (notesView) notesView.hidden = true;
        if (notesEditBox) notesEditBox.hidden = false;
        notesTa?.focus();
      });
      q('notescancel')?.addEventListener('click', () => {
        if (notesEditBox) notesEditBox.hidden = true;
        if (notesView) notesView.hidden = false;
        if (notesTa) notesTa.value = t.notes || '';
      });
      q('notessave')?.addEventListener('click', async () => {
        if (notesStatus) notesStatus.textContent = 'Guardando…';
        try { await api(`/api/learning/${t.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: notesTa?.value || '' }) }); dirty = true; render(); }
        catch (e) { if (notesStatus) notesStatus.textContent = e.message || 'Error de red.'; }
      });

      // ----- Contexto adicional: LISTA de entradas -----
      const ctxBtn = q('ctxanalyze');
      // Agregar una nota MANUAL (entrada ✍️ nueva).
      q('cxnote')?.addEventListener('click', async () => {
        const ok = await dialog.textEditorDialog?.({
          title: '✍️ Agregar nota', hint: 'Nota de contexto para este tema (se suma a la lista y entra en la próxima explicación). Soporta Markdown.', saveLabel: 'Agregar',
          onSave: async (text) => {
            if (!String(text).trim()) throw new Error('La nota está vacía.');
            await api(`/api/learning/${t.id}/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
          },
        });
        if (ok) { dirty = true; render(); }
      });
      // Editar / borrar una entrada puntual (delegado, hay varias).
      m.body.querySelectorAll('[data-a="cxedit"]').forEach((b) => b.addEventListener('click', async () => {
        const cid = b.dataset.cx;
        const cur = ctxEntries.find((e) => e.id === cid)?.text || '';
        const ok = await dialog.textEditorDialog?.({
          title: '✏️ Editar entrada', hint: 'Editá el texto de esta entrada de contexto.', value: cur, saveLabel: 'Guardar',
          onSave: async (text) => {
            if (!String(text).trim()) throw new Error('La entrada está vacía.');
            await api(`/api/learning/${t.id}/context/${cid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
          },
        });
        if (ok) { dirty = true; render(); }
      }));
      m.body.querySelectorAll('[data-a="cxdel"]').forEach((b) => b.addEventListener('click', async () => {
        const cid = b.dataset.cx;
        const ok = await dialog.confirmDialog({ title: 'Borrar entrada', message: '¿Borrar esta entrada de contexto? No se puede deshacer.', confirmLabel: 'Borrar', danger: true });
        if (!ok) return;
        try { await api(`/api/learning/${t.id}/context/${cid}/delete`, { method: 'POST' }); dirty = true; render(); }
        catch (e) { errBox(e); }
      }));
      // Interpretar una transcripción con IA → AGREGA una entrada 🎙️ nueva.
      q('ctxanalyze')?.addEventListener('click', async () => {
        const ta = m.body.querySelector('[data-ref="ctxta"]');
        const text = (ta?.value || '').trim();
        if (text.length < 20) { setCtxStatus('Pegá una transcripción (mín. 20 caracteres).'); return; }
        const ok = await dialog.confirmDialog({ title: 'Interpretar con IA', message: 'Corre una interpretación con IA (consume tokens) y se AGREGA como una entrada de Contexto adicional del tema. ¿Seguir?', confirmLabel: 'Interpretar' });
        if (!ok) return;
        setCtxStatus('Interpretando…');
        if (ctxBtn) ctxBtn.disabled = true;
        let res;
        try { res = await api(`/api/learning/${t.id}/context-analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript: text }) }); }
        catch (e) { setCtxStatus(e.message || 'Error de red.'); if (ctxBtn) ctxBtn.disabled = false; return; }
        if (res.status === 'done') { dirty = true; render(); return; }
        let n = 0;
        const pollCtx = async () => {
          if (!alive) return;
          n += 1;
          let job = null;
          try { job = await api(`/api/learning/${t.id}/context-analyze/${res.id}`); } catch { /* reintentar */ }
          if (!alive) return;
          if (job?.status === 'done') { setCtxStatus('Listo ✓'); dirty = true; render(); return; }
          if (job?.status === 'error') { setCtxStatus(job.error || 'Falló la interpretación.'); if (ctxBtn) ctxBtn.disabled = false; return; }
          if (n > 150) { setCtxStatus('Tardó demasiado.'); if (ctxBtn) ctxBtn.disabled = false; return; }
          setTimeout(pollCtx, 2000);
        };
        setTimeout(pollCtx, 2000);
      });
    }

    function poll(topicId, statusEl, mode) {
      if (statusEl) {
        const label = mode === 'adapt' ? 'Adaptando la explicación con los cambios nuevos…' : 'Generando la explicación completa (navega el código real)…';
        statusEl.innerHTML = `${pacman({ state: 'delegating' })} <span>${esc(label)} Puede tardar 1-2 min.</span>`;
      }
      const tick = async () => {
        if (!alive) return;
        let j = null;
        try { j = await api(`/api/learning/${topicId}/explain`); } catch { /* reintentar */ }
        if (!alive) return;
        if (j && j.status === 'done') { dirty = true; render(); return; }
        if (j && j.status === 'error') { if (statusEl) statusEl.innerHTML = `<div class="lt-exp-err">${esc(j.error || 'La explicación falló.')}</div>`; return; }
        pollTimer = setTimeout(tick, 2500);
      };
      pollTimer = setTimeout(tick, 2000);
    }
    render();
  }

  // ===== Análisis IA del aprendizaje =====
  async function openAnalysis() {
    const ok = await dialog.confirmDialog({ title: '🧠 Analizar aprendizaje', message: 'La IA va a revisar TODOS tus temas y sugerir cómo organizarlos: duplicados, unificar, completar, agrupar en rutas, qué aprender primero y temas nuevos. Consume tokens. Las propuestas NO se aplican solas: vos aprobás cada una.', confirmLabel: 'Analizar' });
    if (!ok) return;
    const m = dialog.openModal({ title: '🧠 Análisis del aprendizaje', width: '720px', onClose: () => { alive = false; if (pollTimer) clearTimeout(pollTimer); if (dirty) load(); } });
    let pollTimer = null, alive = true, dirty = false;
    m.body.innerHTML = `<div class="lt-an-status">${pacman({ state: 'delegating' })} <span>Analizando tus temas…</span></div>`;
    try { await api('/api/learning/analyze', { method: 'POST' }); }
    catch (e) { m.body.innerHTML = `<div class="lt-exp-err">${esc(String(e.message))}</div>`; return; }

    const tick = async () => {
      if (!alive) return;
      let j = null;
      try { j = await api('/api/learning/analysis'); } catch { /* reintentar */ }
      if (!alive) return;
      if (j && j.status === 'done') { renderResult(j.result); return; }
      if (j && j.status === 'error') { m.body.innerHTML = `<div class="lt-exp-err">${esc(j.error || 'El análisis falló.')}</div>`; return; }
      pollTimer = setTimeout(tick, 2500);
    };
    pollTimer = setTimeout(tick, 2000);

    function section(title, items, bodyFn) {
      if (!items || !items.length) return '';
      return `<details class="lt-sec" open><summary>${title} (${items.length})</summary><div class="lt-sec-body lt-an-list">${items.map(bodyFn).join('')}</div></details>`;
    }

    function renderResult(r) {
      if (!alive) return;
      if (!r) { m.body.innerHTML = '<div class="lt-none">Sin resultado.</div>'; return; }
      const tById = (id) => topics.find((x) => x.id === id);
      const tName = (id) => esc(tById(id)?.title || id);
      let html = `<div class="lt-an-resumen">${esc(r.resumen || '')}</div>`;
      html += section('🔁 Duplicados', r.duplicados, (d, i) => `<div class="lt-an-item" data-kind="dup" data-i="${i}">
        <div class="lt-an-txt">Conservar <b>${tName(d.keep)}</b>, quitar ${d.remove.map(tName).map((x) => `“${x}”`).join(', ')}. <span class="lt-an-why">${esc(d.why)}</span></div>
        <div class="lt-an-acts"><button class="btn btn--sm" data-ap>Aplicar</button><button class="btn-ghost btn--sm" data-dis>Descartar</button></div></div>`);
      html += section('🔗 Unificables', r.unificables, (u, i) => `<div class="lt-an-item" data-kind="unif" data-i="${i}">
        <div class="lt-an-txt">Fusionar ${u.ids.map(tName).map((x) => `“${x}”`).join(' + ')} → <b>${esc(u.title)}</b>. <span class="lt-an-why">${esc(u.why)}</span></div>
        <div class="lt-an-acts"><button class="btn btn--sm" data-ap>Aplicar</button><button class="btn-ghost btn--sm" data-dis>Descartar</button></div></div>`);
      html += section('✍️ Completar info', r.completar, (c, i) => `<div class="lt-an-item" data-kind="comp" data-i="${i}">
        <div class="lt-an-txt"><b>${tName(c.id)}</b>: ${esc((c.notes || '').slice(0, 160))}${c.tags?.length ? ` · tags: ${c.tags.map(esc).join(', ')}` : ''} <span class="lt-an-why">${esc(c.why)}</span></div>
        <div class="lt-an-acts"><button class="btn btn--sm" data-ap>Aplicar</button><button class="btn-ghost btn--sm" data-dis>Descartar</button></div></div>`);
      html += section('🗺️ Agrupar en rutas', r.agrupar, (g, i) => `<div class="lt-an-item" data-kind="grp" data-i="${i}">
        <div class="lt-an-txt">${g.routeId ? `A la ruta <b>${esc(routeById(g.routeId)?.title || g.routeId)}</b>` : `Nueva ruta <b>${esc(g.routeTitle)}</b>`}: ${g.topicIds.map(tName).map((x) => `“${x}”`).join(', ')}. <span class="lt-an-why">${esc(g.why)}</span></div>
        <div class="lt-an-acts"><button class="btn btn--sm" data-ap>Aplicar</button><button class="btn-ghost btn--sm" data-dis>Descartar</button></div></div>`);
      if (r.aprenderPrimero?.length) {
        html += `<details class="lt-sec" open><summary>🎯 Qué aprender primero</summary><div class="lt-sec-body">${r.aprenderPrimero.map((a) => `<div class="lt-an-order">${a.orderedIds.map((id, k) => `<span class="lt-an-step">${k + 1}. ${tName(id)}</span>`).join(' → ')}<div class="lt-an-why">${esc(a.why)}</div></div>`).join('')}</div></details>`;
      }
      html += section('➕ Temas nuevos sugeridos', r.sugerirNuevos, (s, i) => `<div class="lt-an-item" data-kind="new" data-i="${i}">
        <div class="lt-an-txt"><b>${esc(s.title)}</b>${s.area ? ` · ${esc(s.area)}` : ''} · ${scopeOf(s.scope).emoji} <span class="lt-an-why">${esc(s.why)}</span></div>
        <div class="lt-an-acts"><button class="btn btn--sm" data-ap>Crear tema</button><button class="btn-ghost btn--sm" data-dis>Descartar</button></div></div>`);
      const empty = !r.duplicados.length && !r.unificables.length && !r.completar.length && !r.agrupar.length && !r.sugerirNuevos.length && !r.aprenderPrimero?.length;
      m.body.innerHTML = `<div class="lt-an">${html}${empty ? '<div class="lt-muted">La IA no encontró nada para reorganizar. Tu banco ya está prolijo. 🎉</div>' : ''}</div>`;
      wireResult(r);
    }

    function wireResult(r) {
      m.body.querySelectorAll('.lt-an-item').forEach((el) => {
        const kind = el.dataset.kind; const i = Number(el.dataset.i);
        const done = (label) => { el.querySelector('.lt-an-acts').innerHTML = `<span class="lt-an-done">✓ ${label}</span>`; };
        el.querySelector('[data-dis]')?.addEventListener('click', () => done('Descartado'));
        el.querySelector('[data-ap]')?.addEventListener('click', async () => {
          try {
            if (kind === 'dup') { const d = r.duplicados[i]; for (const id of d.remove) await api(`/api/learning/${id}/delete`, { method: 'POST' }); }
            else if (kind === 'unif') { const u = r.unificables[i]; const [first, ...rest] = u.ids; await api(`/api/learning/${first}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: u.title, notes: u.notes }) }); for (const id of rest) await api(`/api/learning/${id}/delete`, { method: 'POST' }); }
            else if (kind === 'comp') { const c = r.completar[i]; await api(`/api/learning/${c.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: c.notes, tags: c.tags }) }); }
            else if (kind === 'grp') { const g = r.agrupar[i]; let routeId = g.routeId; if (!routeId) { const nr = (await api('/api/learning/routes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: g.routeTitle, description: g.routeDescription }) })).route; routeId = nr.id; } for (const id of g.topicIds) await api(`/api/learning/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routeId }) }); }
            else if (kind === 'new') { const s = r.sugerirNuevos[i]; await api('/api/learning', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: s.title, area: s.area, scope: s.scope }) }); }
            dirty = true; done('Aplicado');
          } catch (e) { dialog.confirmDialog?.({ title: 'Error', message: String(e.message), confirmLabel: 'Ok' }); }
        });
      });
    }
  }

  // ===== Wiring del panel =====
  filtersEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter; syncFilterChips(); renderRoutes(); renderGrid();
  });
  routesEl.addEventListener('click', async (e) => {
    const rf = e.target.closest('[data-routefilter]');
    if (rf) { filter = `route:${rf.dataset.routefilter}`; syncFilterChips(); renderRoutes(); renderGrid(); return; }
    const ed = e.target.closest('[data-routeedit]');
    if (ed) { const r = routeById(ed.dataset.routeedit); const patch = await routeForm(r); if (patch) { try { await api(`/api/learning/routes/${r.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }); await load(); } catch (er) { dialog.confirmDialog?.({ title: 'Error', message: String(er.message), confirmLabel: 'Ok' }); } } return; }
    const dl = e.target.closest('[data-routedel]');
    if (dl) { const r = routeById(dl.dataset.routedel); const okd = await dialog.confirmDialog({ title: 'Eliminar ruta', message: `¿Eliminar la ruta “${r.title}”? Sus temas quedan SIN ruta (no se borran).`, confirmLabel: 'Eliminar', danger: true }); if (okd) { try { await api(`/api/learning/routes/${r.id}/delete`, { method: 'POST' }); if (filter === `route:${r.id}`) filter = 'activos'; await load(); } catch (er) { dialog.confirmDialog?.({ title: 'Error', message: String(er.message), confirmLabel: 'Ok' }); } } }
  });
  container.querySelector('[data-ref="newroute"]').addEventListener('click', async () => {
    const payload = await routeForm(null);
    if (!payload) return;
    try { await api('/api/learning/routes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); await load(); }
    catch (e) { dialog.confirmDialog?.({ title: 'Error', message: String(e.message), confirmLabel: 'Ok' }); }
  });
  container.querySelector('[data-ref="new"]').addEventListener('click', async () => {
    const payload = await topicForm(null);
    if (!payload) return;
    try { await api('/api/learning', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); await load(); }
    catch (e) { dialog.confirmDialog?.({ title: 'Error', message: String(e.message), confirmLabel: 'Ok' }); }
  });
  adminBtnEl.addEventListener('click', openAnalysis);

  load();
  return { reload: load };
}
