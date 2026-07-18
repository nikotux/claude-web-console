// public/js/seguimientos/seguimientos.js — dashboard "Seguimientos" (F5).
// Vista tipo EXCEL: columnas ordenables (click header), filtros por columna,
// selección múltiple y detalle en ventana emergente. "Trabajar seleccionados"
// arma UNA sesión con el contexto de todos los frentes elegidos.
const app = document.getElementById('app');

const TYPE = {
  vendor: { label: '🔴 Proveedor', color: 'var(--cwc-danger)' },
  aprobacion: { label: '🟠 Aprobación', color: 'var(--cwc-warn)' },
  'decision-mark-chris': { label: '🟡 Decisión M/C', color: 'var(--cwc-warn)' },
  mio: { label: '✅ Mío', color: 'var(--cwc-ok)' },
  '': { label: '⚪ —', color: 'var(--cwc-text-dim)' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function dom(d) { return d === 'oficina' ? '🏢' : d === 'casa' ? '🏠' : '📌'; }
function typeMeta(t) { return TYPE[t] || TYPE['']; }

const COLS = [
  { k: 'key', label: '#', type: 'num', get: (f) => Number(f.key) || 0, cell: (f) => `#${esc(f.key)}` },
  { k: 'domain', label: 'Área', type: 'enum', opts: ['casa', 'oficina', 'otros'], get: (f) => f.domain || '', cell: (f) => `${dom(f.domain)} ${esc(f.domain || '')}` },
  { k: 'ownerBall', label: 'Dueño de la pelota', type: 'text', get: (f) => f.ownerBall || '', cell: (f) => esc(f.ownerBall || '—') },
  { k: 'ownerType', label: 'Tipo', type: 'enum', opts: Object.keys(TYPE).filter(Boolean), get: (f) => f.ownerType || '', cell: (f) => `<span style="color:${typeMeta(f.ownerType).color}">${typeMeta(f.ownerType).label}</span>` },
  { k: 'involucrados', label: 'Involucrados', type: 'text', get: (f) => (f.involucrados || []).join(', '), cell: (f) => esc((f.involucrados || []).join(', ') || '—') },
  { k: 'title', label: 'Título', type: 'text', get: (f) => f.title || '', cell: (f) => esc(f.title || '') },
  { k: 'nextAction', label: 'Próxima acción', type: 'text', get: (f) => f.nextAction || '', cell: (f) => esc(f.nextAction || '') },
  { k: 'daysIdle', label: 'Días', type: 'num', get: (f) => f.daysIdle || 0, cell: (f) => `${f.daysIdle ?? 0}` },
  { k: 'status', label: 'Estado', type: 'text', get: (f) => f.status || '', cell: (f) => esc(f.status || '') },
];

const state = { data: null, sort: { k: 'ownerBall', dir: 1 }, filters: {}, selected: new Set(), aiKeys: null };

function rows() {
  let r = (state.data?.frentes || []).slice();
  if (state.aiKeys) r = r.filter((f) => state.aiKeys.has(String(f.key)));
  for (const c of COLS) {
    const fv = state.filters[c.k];
    if (!fv) continue;
    if (c.type === 'enum') r = r.filter((f) => c.get(f) === fv);
    else r = r.filter((f) => String(c.get(f)).toLowerCase().includes(fv.toLowerCase()));
  }
  const s = COLS.find((c) => c.k === state.sort.k);
  if (s) r.sort((a, b) => {
    const va = s.get(a); const vb = s.get(b);
    const cmp = s.type === 'num' ? (va - vb) : String(va).localeCompare(String(vb), 'es');
    return cmp * state.sort.dir;
  });
  return r;
}

function headHtml() {
  const th = COLS.map((c) => {
    const arrow = state.sort.k === c.k ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th data-sort="${c.k}">${esc(c.label)}${arrow}</th>`;
  }).join('');
  const filters = COLS.map((c) => {
    if (c.type === 'enum') {
      const opts = ['<option value="">·</option>'].concat(c.opts.map((o) => `<option value="${esc(o)}" ${state.filters[c.k] === o ? 'selected' : ''}>${esc(o)}</option>`)).join('');
      return `<th><select data-filter="${c.k}">${opts}</select></th>`;
    }
    return `<th><input data-filter="${c.k}" value="${esc(state.filters[c.k] || '')}" placeholder="filtrar"></th>`;
  }).join('');
  return `<tr><th class="sg-cbh"><input type="checkbox" data-selall></th>${th}</tr>
          <tr class="sg-frow"><th></th>${filters}</tr>`;
}

function rowHtml(f) {
  const sel = state.selected.has(String(f.key));
  const cells = COLS.map((c) => `<td>${c.cell(f)}</td>`).join('');
  return `<tr data-key="${esc(f.key)}" class="${sel ? 'sg-selrow' : ''}">
    <td class="sg-cb"><input type="checkbox" data-rowsel="${esc(f.key)}" ${sel ? 'checked' : ''}></td>${cells}</tr>`;
}

function renderRows() {
  const tb = document.getElementById('sg-tbody'); if (!tb) return;
  const rs = rows();
  tb.innerHTML = rs.length
    ? rs.map(rowHtml).join('')
    : `<tr><td colspan="${COLS.length + 1}" class="sg-empty">Sin frentes. Tocá 🔄 Refrescar Desk.</td></tr>`;
  updateBulk();
}

function updateBulk() {
  const b = document.getElementById('sg-bulk'); if (!b) return;
  const n = state.selected.size;
  b.textContent = `🧰 Trabajar ${n} seleccionado${n === 1 ? '' : 's'}`;
  b.disabled = n === 0;
}

function fullRender() {
  const d = state.data || { counts: {} }; const c = d.counts || {};
  const busy = d.refreshing || d.classifying;
  app.innerHTML = `
    <header class="sg-head">
      <div class="sg-titlebar">
        <h1>🎯 Seguimientos</h1>
        <span class="sg-counts">${c.total || 0} frentes · 🏠 ${c.casa || 0} · 🏢 ${c.oficina || 0}${c.classified != null ? ` · clasif. ${c.classified}` : ''}</span>
        <div class="sg-actions">
          <button data-act="aiview">🤖 Vista con IA</button>
          <button data-act="scan">🔄 Actualizaciones</button>
          <button id="sg-bulk" data-act="bulk" disabled>🧰 Trabajar 0 seleccionados</button>
          ${state.aiKeys ? `<button class="sg-mini" data-act="clearai" title="Limpiar Vista IA">✖ IA (${state.aiKeys.size})</button>` : ''}
          <button class="sg-mini" data-act="refresh" title="Refrescar datos de Desk" ${busy ? 'disabled' : ''}>${d.refreshing ? '…' : '↻'}</button>
          <button class="sg-mini" data-act="classify" title="Re-clasificar con IA" ${busy ? 'disabled' : ''}>${d.classifying ? '…' : '🧠'}</button>
        </div>
      </div>
    </header>
    <div class="sg-tablewrap">
      <table class="sg-table"><thead>${headHtml()}</thead><tbody id="sg-tbody"></tbody></table>
    </div>`;
  renderRows();
}

function fmtDate(s) {
  if (!s) return null;
  try { return new Date(s).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }); } catch { return String(s); }
}

// Filas clave→valor de una sección (omite vacíos).
function kvRows(pairs) {
  const html = pairs
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<div class="sg-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join('');
  return html || '<div class="sg-dim">—</div>';
}

// Detalle rico tipo Tickets & Features (bv2): Propiedades / Personas / Tiempos /
// Descripción (→ "Contenido del correo" si es correo) + Resolver en sesión.
function openDetail(key) {
  const f = (state.data?.frentes || []).find((x) => String(x.key) === String(key));
  if (!f) return;
  const d = f.detail || {};
  const isEmail = f.source === 'correo';
  const descLabel = isEmail ? 'Contenido del correo' : 'Descripción';
  const pelota = f.ownerBall ? `${f.ownerBall} · ${typeMeta(f.ownerType).label}` : null;
  const ov = document.createElement('div');
  ov.className = 'sg-modal';
  ov.innerHTML = `<div class="sg-modal-card sg-modal-wide">
    <div class="sg-modal-h"><b>${dom(f.domain)} #${esc(f.key)} · ${esc(f.title)}</b><button class="sg-x" title="cerrar">✕</button></div>
    <div class="sg-modal-body">
      <div class="sg-sect">⚙️ Propiedades</div>
      <div class="sg-grid2">${kvRows([
        ['Carril', d.category || f.domain], ['Prioridad', d.priority], ['Estado', f.status],
        ['País', d.country], ['Producto', d.product], ['Cliente', d.client],
        ['Relacionado a', d.relatedTo], ['Canal', d.channel], ['Idioma', d.language],
        ['Pelota', pelota], ['Involucrados', (f.involucrados || []).join(', ')], ['Próxima acción', f.nextAction],
      ])}</div>
      <div class="sg-sect">👥 Personas</div>
      <div class="sg-grid2">${kvRows([['Propietario', d.assignee], ['Reporter', d.reporter]])}</div>
      <div class="sg-sect">🕒 Tiempos</div>
      <div class="sg-grid2">${kvRows([
        ['Creado', fmtDate(d.createdTime)], ['Última actualización', fmtDate(d.modifiedTime || f.lastSignalAt)],
        ['Vence', fmtDate(d.dueDate)], ['On hold desde', fmtDate(d.onholdTime)],
        ['Comentarios', d.commentCount], ['Adjuntos', d.attachmentCount],
      ])}</div>
      <div class="sg-sect">📝 ${descLabel}</div>
      <div class="sg-desc">${esc(d.description || '—')}</div>
      <div class="sg-sect">💬 Comentarios & adjuntos del hilo</div>
      <div class="sg-dim">Pendiente del MCP de Tolkien (PLAN-551) — por ahora se ven en Zoho Desk.</div>
      ${f.webUrl ? `<div style="margin-top:.5rem"><a href="${esc(f.webUrl)}" target="_blank" rel="noopener">abrir ticket en Zoho ↗</a></div>` : ''}
      ${f.sessionRef ? `<div class="sg-dim">Sesión vinculada: ${esc(f.sessionRef)}</div>` : ''}
    </div>
    <div class="sg-modal-foot"><button data-resolve="${esc(f.key)}">💬 Resolver en sesión</button></div>
  </div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.classList.contains('sg-x')) { ov.remove(); return; }
    const rb = e.target.closest('[data-resolve]');
    if (rb) { resolveBulk([rb.dataset.resolve]); ov.remove(); }
  });
  document.body.appendChild(ov);
}

async function resolveBulk(keys) {
  if (!keys || !keys.length) return;
  try {
    const r = await fetch('/api/seguimientos/resolve-bulk', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ keys }),
    });
    const d = await r.json();
    if (d.chatId) window.open('/', '_blank');
  } catch { /* noop */ }
}

// ACTUALIZACIONES → abre la sesión-Limbo de escaneo (seleccionados o todos).
async function scanUpdates() {
  const keys = state.selected.size ? [...state.selected] : null;
  try {
    const r = await fetch('/api/seguimientos/scan-updates', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ keys }),
    });
    const d = await r.json();
    if (d.chatId) window.open('/', '_blank');
  } catch { /* noop */ }
}

// Mini-modal de texto (evita prompt() nativo). Resuelve con el texto o null.
function askText(title, placeholder) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'sg-modal';
    ov.innerHTML = `<div class="sg-modal-card" style="width:min(460px,94vw)">
      <div class="sg-modal-h"><b>${esc(title)}</b><button class="sg-x">✕</button></div>
      <div class="sg-modal-body"><input id="sg-ask" placeholder="${esc(placeholder || '')}"></div>
      <div class="sg-modal-foot"><button data-ok>Aplicar</button></div>
    </div>`;
    const inp = ov.querySelector('#sg-ask');
    const done = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.classList.contains('sg-x')) return done(null);
      if (e.target.closest('[data-ok]')) return done(inp.value.trim() || null);
    });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); });
    document.body.appendChild(ov);
    setTimeout(() => inp.focus(), 30);
  });
}

// VISTA CON IA → filtro por lenguaje natural: la IA marca y filtra lo que pediste.
async function aiView() {
  const q = await askText('🤖 Vista con IA — describí qué querés ver', 'ej: todo lo que involucra a Julián y está trabado');
  if (!q) return;
  const btns = document.querySelectorAll('[data-act="aiview"]');
  btns.forEach((b) => { b.textContent = '🤖 pensando…'; b.disabled = true; });
  try {
    const r = await fetch('/api/seguimientos/ai-filter', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query: q }),
    });
    const d = await r.json();
    if (Array.isArray(d.keys)) {
      state.aiKeys = new Set(d.keys.map(String));
      state.selected = new Set(d.keys.map(String)); // primera selección
      fullRender();
    } else { btns.forEach((b) => { b.textContent = '🤖 Vista con IA'; b.disabled = false; }); }
  } catch { btns.forEach((b) => { b.textContent = '🤖 Vista con IA'; b.disabled = false; }); }
}

async function post(path) {
  try { await fetch(path, { method: 'POST', headers: { accept: 'application/json' } }); } catch { /* noop */ }
  setTimeout(load, 400);
}

async function load() {
  try {
    const r = await fetch('/api/seguimientos', { headers: { accept: 'application/json' } });
    state.data = await r.json();
    fullRender();
    if (state.data.refreshing || state.data.classifying) setTimeout(load, 2000);
  } catch (e) {
    app.innerHTML = `<p class="sg-empty">Error al cargar: ${esc(e.message)}</p>`;
  }
}

app.addEventListener('click', (e) => {
  const sortTh = e.target.closest('[data-sort]');
  if (sortTh) { const k = sortTh.dataset.sort; state.sort = { k, dir: state.sort.k === k ? -state.sort.dir : 1 }; fullRender(); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'bulk') resolveBulk([...state.selected]);
    else if (a === 'scan') scanUpdates();
    else if (a === 'aiview') aiView();
    else if (a === 'clearai') { state.aiKeys = null; fullRender(); }
    else post(`/api/seguimientos/${a}`);
    return;
  }
  if (e.target.matches('input, select')) return; // clicks en checkbox/filtros no abren detalle
  const tr = e.target.closest('tr[data-key]');
  if (tr) openDetail(tr.dataset.key);
});

app.addEventListener('change', (e) => {
  if (e.target.matches('[data-rowsel]')) {
    const k = e.target.dataset.rowsel;
    if (e.target.checked) state.selected.add(k); else state.selected.delete(k);
    e.target.closest('tr').classList.toggle('sg-selrow', e.target.checked);
    updateBulk();
    return;
  }
  if (e.target.matches('[data-selall]')) {
    const on = e.target.checked;
    for (const f of rows()) { const k = String(f.key); if (on) state.selected.add(k); else state.selected.delete(k); }
    renderRows();
    return;
  }
  if (e.target.matches('select[data-filter]')) { state.filters[e.target.dataset.filter] = e.target.value; renderRows(); }
});

app.addEventListener('input', (e) => {
  if (e.target.matches('input[data-filter]')) { state.filters[e.target.dataset.filter] = e.target.value; renderRows(); }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.sg-modal').forEach((m) => m.remove()); });

load();
