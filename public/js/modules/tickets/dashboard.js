// modules/tickets/dashboard.js — modal del dashboard "One Front Door".
// Layout (rediseño Niko 2026-07-07): header con [buscar] [actualizar] + ✕ ·
// buscador de ticket por número · "Por carril" como primera hilera · PESTAÑAS
// DE PROPIETARIO (adaptan las vistas a una persona) · debajo vencidos/aging/
// resueltos/dev-lane (masonry, filtrados por propietario). Sin "Esperando a".
// Filtro por propietario: tickets por su agente de Desk + PRs por su autor de
// GitHub, con matching de nombre aproximado (agente y login son identidades
// distintas). Todo determinístico, del snapshot (sin IA, sin tokens).
import { openModal } from '../../ui/dialog.js';
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';
import { openTicketDetail } from './ticket-detail.js';
import { openPrDetail } from './pr-detail.js';

// Carriles: emoji + label SEPARADOS. En la card se muestra SOLO el emoji (chip
// sin texto); el label vive en las pestañas de filtro (que hacen de leyenda) y
// en el modal de leyenda (botón "?"). `other` ya no es "·": tiene su ícono.
const LANE_META = {
  bug: { emoji: '🐞', label: 'bug' }, feature: { emoji: '💡', label: 'feature' },
  hardware: { emoji: '🖥', label: 'hardware' }, access: { emoji: '🔑', label: 'access' },
  platform: { emoji: '⚙️', label: 'platform' }, onboarding: { emoji: '🌱', label: 'onboarding' },
  'facilities-house': { emoji: '🏠', label: 'Infraestructura Casa' },
  'facilities-office': { emoji: '🏢', label: 'Infraestructura Oficina' },
  other: { emoji: '🏷️', label: 'other' },
};
const laneEmoji = (l) => LANE_META[l]?.emoji || '🏷️';
const laneLabel = (l) => LANE_META[l]?.label || l || 'other';
// Compat con laneRows/laneTab: "emoji label" para las pestañas y barras.
const LANE_LABEL = Object.fromEntries(Object.entries(LANE_META).map(([k, v]) => [k, `${v.emoji} ${v.label}`]));
const BALL_LABEL = { yours: '🟡 tuya', chris: '🔵 Chris' };

// Prioridad como chip de PROPIEDAD (lleva su valor: emoji de color + P1/2/3).
const PRIO_META = {
  P1: { emoji: '🔴', label: 'P1', chip: 'bb-chip--danger', desc: 'Prioridad alta' },
  P2: { emoji: '🟠', label: 'P2', chip: 'bb-chip--warn', desc: 'Prioridad media' },
  P3: { emoji: '🟡', label: 'P3', chip: 'bb-chip--muted', desc: 'Prioridad baja' },
};
// Iniciales del dueño para el chip 👤 (ej. "Giovanna Rincon" → "GR").
function initials(name) {
  if (!name) return null;
  const p = String(name).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return null;
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

// Estado del ticket normalizado por `lifecycle` (el backend ya lo deriva limpio
// en derive.js) — así es AGNÓSTICO del idioma: Zoho manda status bilingües y
// duplicados ("Open"≈"Abierto", "En espera"≈"On Hold", "Resuelto"≈"Closed") por
// tener dos departamentos. Cada estado tiene emoji + label corto + color de chip;
// el status CRUDO de Zoho se conserva en el tooltip para no perder fidelidad.
const STATUS_META = {
  new:         { label: 'Nuevo',          emoji: '🆕', chip: 'bb-chip--info' },
  triaged:     { label: 'Asignado',       emoji: '📌', chip: 'bb-chip--cool' },
  in_progress: { label: 'En progreso',    emoji: '🔧', chip: 'bb-chip--warn' },
  waiting:     { label: 'Espera cliente', emoji: '⏸️', chip: 'bb-chip--muted' },
  closed:      { label: 'Resuelto',       emoji: '✅', chip: 'bb-chip--ok' },
};
function statusMeta(t) {
  const m = STATUS_META[t.lifecycle];
  if (m) return m;
  // Fallback: lifecycle desconocido → mostrar el status crudo de Zoho tal cual.
  return { label: (t.status || '—'), emoji: '', chip: 'bb-chip--info' };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// Matching de personas (agente Desk <-> autor GitHub): normaliza y compara por
// tokens de nombre. Aproximado a propósito (los nombres difieren entre sistemas).
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function nameTokens(s) { return norm(s).split(/\s+/).filter((x) => x.length > 2); }
function personMatch(a, b) {
  if (!a || !b) return false;
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  const ta = nameTokens(a), tb = nameTokens(b);
  if (ta.some((x) => tb.includes(x))) return true;
  const ja = na.replace(/\s+/g, ''), jb = nb.replace(/\s+/g, '');
  return ja.includes(jb) || jb.includes(ja);
}
function ciBadge(ci) {
  if (ci === 'passing') return `<span class="bb-chip bb-chip--ok" title="CI verde">${icon('check', { size: 11 })}</span>`;
  if (ci === 'failing') return `<span class="bb-chip bb-chip--danger" title="CI roja">${icon('close', { size: 11 })}</span>`;
  if (ci === 'pending') return `<span class="bb-chip bb-chip--warn" title="CI corriendo">${icon('clock', { size: 11 })}</span>`;
  return '';
}
// `expandKey` (opcional) agrega la 2ª manija del bloque: un botón ⤢ en el header
// que abre la columna como TABLA ANCHA tipo Excel (además de la manija de colapsar
// del propio <details>). El listener delegado del modal lo captura por data-expand.
// El chevron lleva su propia clase para que SOLO él rote al abrir (si no, el ⤢
// también giraría por la regla `.bv2-block[open] > summary svg`).
function block(title, inner, open, expandKey) {
  const exp = expandKey
    ? `<button type="button" class="bv2-expand" data-expand="${esc(expandKey)}" title="Ver todos en tabla ancha (tipo Excel)">${icon('maximize', { size: 13 })}</button>`
    : '';
  return `<details class="bv2-block"${open ? ' open' : ''}>
    <summary class="bv2-block-h"><span>${title}</span><span class="bv2-block-tools">${exp}${icon('chevronDown', { size: 14, className: 'bv2-chev' })}</span></summary>
    <div class="bv2-block-body">${inner}</div>
  </details>`;
}

// Columnas de la vista TABLA (tipo Excel). Cada una: cómo se pinta la celda
// (`cell`) y cómo se ordena (`val` → clave comparable; `num` = orden numérico).
// Usa los mismos helpers/metadata que las cards para ser coherente.
const TABLE_COLS = [
  { key: 'ticketNumber', label: '#', num: true, val: (t) => Number(t.ticketNumber) || 0, cell: (t) => `#${esc(t.ticketNumber)}` },
  { key: 'subject', label: 'Asunto', cls: 'tkt-c-subj', val: (t) => String(t.subject || '').toLowerCase(), cell: (t) => esc(t.subject || '(sin asunto)') },
  { key: 'lane', label: 'Carril', val: (t) => laneLabel(t.lane), cell: (t) => `${laneEmoji(t.lane)} ${esc(laneLabel(t.lane))}` },
  { key: 'lifecycle', label: 'Estado', val: (t) => statusMeta(t).label, cell: (t) => { const sm = statusMeta(t); return `${sm.emoji || ''} ${esc(sm.label)}`.trim(); } },
  { key: 'priority', label: 'Prioridad', val: (t) => t.priority || 'zzz', cell: (t) => { const p = PRIO_META[t.priority]; return p ? `${p.emoji} ${p.label}` : '—'; } },
  { key: 'ownerName', label: 'Dueño', val: (t) => String(t.ownerName || 'zzz').toLowerCase(), cell: (t) => esc(t.ownerName || '—') },
  { key: 'agingDays', label: 'Días', num: true, val: (t) => t.agingDays ?? 0, cell: (t) => String(t.agingDays ?? 0) },
  { key: 'sla', label: 'SLA', num: true, val: (t) => (t.overdue ? 2 : (t.agingDays >= 7 ? 1 : 0)), cell: (t) => (t.overdue ? '🔴 SLA roto' : (t.agingDays >= 7 ? '🟠 sin update' : '🟢 al día')) },
];

// Columnas de la vista "Todos" = TABLE_COLS + una columna "Cola" al frente que
// dice de qué bucket (Nuevos/Vencidos/En progreso) viene cada ticket (el campo
// `_bucket` lo etiqueta openColumnTable al concatenar las 3 columnas).
const TABLE_COLS_ALL = [
  { key: 'bucket', label: 'Cola', val: (t) => t._bucket || '', cell: (t) => esc(t._bucket || '—') },
  ...TABLE_COLS,
];

// Abre una columna del dashboard como TABLA ANCHA ordenable (modal propio, se
// apila sobre el del dashboard). Datos ya en memoria (0 fetch, 0 tokens). El
// buscador filtra por # o asunto; las filas abren el detalle del ticket existente.
// `opts.cols` permite otro juego de columnas (p.ej. la vista "Todos" con "Cola").
function openTicketTable(titleText, items, deps, opts = {}) {
  const cols = opts.cols || TABLE_COLS;
  const rows = (items || []).slice();
  const localMap = new Map();
  for (const t of rows) localMap.set(String(t.ticketNumber), t);
  let sortKey = null, sortDir = -1, q = '';
  const m = openModal({ title: `${titleText} · tabla`, width: 'min(1200px, 96vw)' });
  const wrap = document.createElement('div');
  wrap.className = 'tkt-tblwrap';
  wrap.innerHTML = `
    <div class="tkt-tblbar">
      <input type="text" class="btn--sm tkt-tblsearch" placeholder="Filtrar por # o asunto…" data-ref="q" />
      <span class="bf-sub" data-ref="count"></span>
    </div>
    <div class="tkt-tblscroll" data-ref="scroll"></div>`;
  m.body.appendChild(wrap);
  const scrollEl = wrap.querySelector('[data-ref="scroll"]');
  const countEl = wrap.querySelector('[data-ref="count"]');
  const inp = wrap.querySelector('[data-ref="q"]');

  function sorted() {
    let list = rows;
    if (q) { const qq = q.toLowerCase(); list = list.filter((t) => String(t.ticketNumber).includes(qq) || String(t.subject || '').toLowerCase().includes(qq)); }
    if (sortKey) {
      const col = cols.find((c) => c.key === sortKey);
      if (col) list = list.slice().sort((a, b) => { const va = col.val(a), vb = col.val(b); const r = col.num ? (va - vb) : String(va).localeCompare(String(vb)); return r * sortDir; });
    }
    return list;
  }
  function renderTable() {
    const list = sorted();
    countEl.textContent = `${list.length} de ${rows.length}`;
    const head = cols.map((c) => {
      const on = sortKey === c.key;
      const arrow = on ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
      return `<th class="${c.cls || ''}${c.num ? ' tkt-c-num' : ''}" data-sort="${c.key}" title="Ordenar por ${esc(c.label)}">${esc(c.label)}${arrow}</th>`;
    }).join('');
    const body = list.length
      ? list.map((t) => `<tr data-num="${esc(t.ticketNumber)}" role="button" tabindex="0" title="Ver detalle del ticket">${cols.map((c) => `<td class="${c.cls || ''}${c.num ? ' tkt-c-num' : ''}">${c.cell(t)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="bf-sub" style="padding:.8rem">— nada —</td></tr>`;
    scrollEl.innerHTML = `<table class="tkt-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }
  scrollEl.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = cols.find((c) => c.key === k)?.num ? -1 : 1; }
      renderTable();
      return;
    }
    const tr = e.target.closest('tr[data-num]');
    if (tr) { const t = localMap.get(tr.dataset.num); if (t) openTicketDetail(t, deps); }
  });
  inp.addEventListener('input', () => { q = inp.value; renderTable(); });
  renderTable();
  return m;
}

// Estado del refresh manual COMPARTIDO entre aperturas del modal (persistente):
// si cerrás y reabrís mientras corre, el Pac-Man sigue visible porque el estado
// NO vive en el DOM del modal (que se destruye al cerrar) sino acá, a nivel de
// módulo. El refresh en sí corre server-side (refreshNow) y termina aunque
// cierres la ventana — esto solo mantiene honesto el indicador visual.
let manualBusy = false;
const busyListeners = new Set(); // fn(busy) que cada modal vivo registra para pintar su botón
function setManualBusy(v) {
  manualBusy = v;
  for (const fn of [...busyListeners]) { try { fn(v); } catch { /* noop */ } }
}

export function openBugsV2Dashboard(deps = {}) {
  let modalClosed = false;
  const modal = openModal({
    title: 'Tickets & Features · One Front Door',
    width: 'min(1180px, 94vw)',
    onClose: () => {
      modalClosed = true; busyListeners.delete(reflectBusy); // deja de escuchar al cerrar
      if (resolvedRetryTimer) { clearTimeout(resolvedRetryTimer); resolvedRetryTimer = null; }
      if (resolvedAutoTimer) { clearInterval(resolvedAutoTimer); resolvedAutoTimer = null; }
    },
  });
  const content = document.createElement('div');
  content.className = 'bv2-dash';
  modal.body.appendChild(content);
  const ticketMap = new Map();
  const prMap = new Map();
  let selectedLane = null;  // filtro PRINCIPAL por carril (null = Todos)
  let selectedOwner = null; // sub-filtro OPCIONAL por dueño (null = Todos)
  let selectedMine = false; // filtro "Míos": solo lo que tengo tomado
  let lastData = null;
  let currentYou = null;    // usuario logueado (para pintar "Tuyo" vs "en uso por X")
  const isMine = (x) => !!(x?.workingBy && currentYou && x.workingBy.by === currentYou);
  // Vista ACTIVA vs RESUELTOS (rediseño 2026-07-09). El toggle vive en la 2ª fila
  // de filtros; los filtros de carril/dueño/míos se aplican a AMBAS vistas. La
  // data de Resueltos viene de un caché PERSISTENTE server-side (2026-07-10,
  // ver sources.js) — acá sólo se guarda por sesión del modal para no re-pedirla
  // al cambiar de pestaña de vista.
  let viewMode = 'active';      // 'active' | 'resolved'
  let resolvedData = null;      // { tickets, prs, byLane, counts, capped, ... }
  let resolvedError = null;
  let resolvedLoading = false;  // spinner de 1ª carga
  let resolvedGenerating = false; // store aún sin 1ª pasada (arranque en frío)
  let resolvedInFlight = false; // evita fetches solapados de /resolved
  let resolvedRetryTimer = null;  // reintento mientras el store se genera / termina un refresco
  let resolvedAutoTimer = null;   // auto-refresh periódico mientras se mira Resueltos

  // --- Botones en el header (junto a la ✕, con espacio) ---
  const head = modal.card.querySelector('.dlg-head');
  const headActions = document.createElement('div');
  headActions.className = 'bv2-head-actions';
  headActions.innerHTML = `
    <button class="btn-ghost btn--sm btn--icon" data-ref="legend" title="Leyenda de íconos">${icon('help', { size: 15 })}</button>
    <button class="btn-ghost btn--sm btn--icon" data-ref="search-toggle" title="Buscar ticket por número">${icon('search', { size: 15 })}</button>
    <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Actualizar (fuerza refresh)">${icon('refresh', { size: 15 })}</button>`;
  head.insertBefore(headActions, head.querySelector('.dlg-x'));
  const refreshBtn = headActions.querySelector('[data-ref="refresh"]');
  const refreshIcon = refreshBtn.innerHTML;
  let sawBusy = false; // este modal vio el refresh arrancar → al terminar, trae lo nuevo
  // Pinta/despinta el botón de ESTE modal según el estado global de refresh.
  // Al pasar de ocupado→libre, si este modal vio el refresh, recarga sin parpadeo
  // (así una ventana reabierta a mitad de refresco muestra los datos frescos sola).
  function reflectBusy(busy) {
    refreshBtn.disabled = busy;
    refreshBtn.innerHTML = busy ? pacman({ state: 'working', size: 'pac-sm' }) : refreshIcon;
    if (busy) { sawBusy = true; }
    else if (sawBusy && !modalClosed) { sawBusy = false; silentReload(); }
  }
  busyListeners.add(reflectBusy);
  refreshBtn.addEventListener('click', () => {
    // Único botón de actualizar: fuerza el refresco de la vista visible. En
    // Resueltos dispara el refresco de FONDO (no bloquea) y conserva lo visible.
    if (viewMode === 'resolved') { loadResolved(true, !!resolvedData); return; }
    if (manualBusy) return;               // dedup GLOBAL: un solo refresh manual a la vez
    setManualBusy(true);                  // notifica a TODOS los modales vivos (Pac-Man)
    load(true).finally(() => setManualBusy(false));
  });
  reflectBusy(manualBusy);                // si ya venía corriendo de antes, mostralo YA
  headActions.querySelector('[data-ref="search-toggle"]').addEventListener('click', () => {
    const bar = content.querySelector('[data-ref="searchbar"]');
    if (bar) { bar.hidden = !bar.hidden; if (!bar.hidden) bar.querySelector('input')?.focus(); }
  });
  headActions.querySelector('[data-ref="legend"]').addEventListener('click', openLegend);

  // Leyenda de íconos: carriles + estados + propiedades, agrupada tipo árbol.
  function openLegend() {
    const row = (chipHtml, desc) => `<div class="bv2-leg-row">${chipHtml}<span class="bv2-leg-desc">${esc(desc)}</span></div>`;
    const laneRows = Object.values(LANE_META)
      .map((v) => row(`<span class="bb-chip bv2-ic">${v.emoji}</span>`, v.label)).join('');
    const statusRows = Object.values(STATUS_META)
      .map((v) => row(`<span class="bb-chip ${v.chip} bv2-ic">${v.emoji}</span>`, v.label)).join('');
    const propRows = [
      ...Object.values(PRIO_META).map((v) => row(`<span class="bb-chip ${v.chip} bv2-prop">${v.emoji} ${v.label}</span>`, v.desc)),
      row('<span class="bb-chip bb-chip--info bv2-prop">👤 GR</span>', 'Dueño asignado (iniciales del agente)'),
    ].join('');
    const m = openModal({ title: 'Leyenda de íconos', width: 420 });
    m.body.innerHTML = `
      <div class="bv2-legend">
        <div class="bv2-leg-group"><div class="bv2-leg-h">🏷️ Carril</div>${laneRows}</div>
        <div class="bv2-leg-group"><div class="bv2-leg-h">🚦 Estado</div>${statusRows}</div>
        <div class="bv2-leg-group"><div class="bv2-leg-h">🔖 Propiedades</div>${propRows}</div>
      </div>`;
  }

  // Badge de "en uso": 🔒 verde si es tuyo, ámbar si lo trabaja otro.
  function lockBadge(t) {
    const w = t.workingBy;
    if (!w) return '';
    const mine = currentYou && w.by === currentYou;
    const cls = mine ? 'bb-chip--ok' : 'bb-chip--warn';
    const txt = mine ? 'Tuyo' : `🔒 ${w.label || w.by}`;
    return `<span class="bb-chip ${cls} bv2-lock" title="En uso por ${esc(w.label || w.by)}">${esc(txt)}</span>`;
  }
  function fmtAgo(ms) {
    if (!ms) return 'recién';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return 'recién';
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    return `hace ${Math.floor(s / 3600)} h`;
  }

  // Card de DOS filas: (1) título completo del ticket; (2) #nº + chips de
  // clasificación SOLO-ícono (carril · estado) + chips de PROPIEDAD con su valor
  // (prioridad · dueño · antigüedad). La leyenda de todos los íconos vive en el
  // botón "?" del header. Prioridad/dueño se omiten si el ticket no los tiene.
  function ticketRow(t) {
    ticketMap.set(String(t.ticketNumber), t);
    const sm = statusMeta(t);
    const prio = PRIO_META[t.priority];
    const own = initials(t.ownerName);
    const chips = [
      `<span class="bb-chip bv2-ic" title="Carril: ${esc(laneLabel(t.lane))}">${laneEmoji(t.lane)}</span>`,
      `<span class="bb-chip ${sm.chip} bv2-ic" title="Estado: ${esc(sm.label)}${t.status ? ` (Zoho: ${esc(t.status)})` : ''}">${sm.emoji || esc(sm.label)}</span>`,
      prio ? `<span class="bb-chip ${prio.chip} bv2-prop" title="${esc(prio.desc)}">${prio.emoji} ${prio.label}</span>` : '',
      own ? `<span class="bb-chip bb-chip--info bv2-prop" title="Dueño: ${esc(t.ownerName)}">👤 ${esc(own)}</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="bv2-card bv2-row--click" data-num="${esc(t.ticketNumber)}" role="button" tabindex="0" title="Ver detalle del ticket">
      <div class="bv2-card-title">${esc(t.subject || '(sin asunto)')}</div>
      <div class="bv2-card-meta">
        <span class="bv2-row-id">#${esc(t.ticketNumber)}</span>
        ${chips}
        ${lockBadge(t)}
        ${t.stale ? '<span class="bv2-stale" title="Dato en caché: no vino en el último refresh, se conserva el último conocido">◷</span>' : ''}
      </div>
    </div>`;
  }
  // Filtros compartidos por listas Y contadores → los números del header se
  // recalculan con el carril/dueño activo (pedido Niko 2026-07-07: al filtrar
  // "bug", "Vencidos" debe decir 3, no el 17 global).
  const applyFilter = (items) => (items || []).filter((t) => (!selectedLane || t.lane === selectedLane) && (!selectedOwner || personMatch(t.ownerName, selectedOwner)) && (!selectedMine || isMine(t)));
  const filterPRs = (prs) => (prs || []).filter((pr) => (!selectedOwner || personMatch(pr.authorName || pr.author, selectedOwner)) && (!selectedMine || isMine(pr)));
  const filtering = () => Boolean(selectedLane || selectedOwner || selectedMine);
  // Muestra "filtrado / total" cuando hay filtro y difiere; si no, solo el total.
  const countBadge = (filtered, total) => (filtering() && filtered !== total ? `${filtered} <span class="bf-sub">/ ${total}</span>` : String(total));

  function ticketList(items, max = 12, expandKey) {
    const f = applyFilter(items);
    if (!f.length) return '<div class="bf-sub">— nada —</div>';
    const shown = f.slice(0, max).map((t) => ticketRow(t)).join('');
    if (f.length <= max) return shown;
    // "+N más" clickeable → abre la tabla ancha (la misma que el botón ⤢ del header).
    const attr = expandKey ? ` data-expand="${esc(expandKey)}" role="button" tabindex="0"` : '';
    return shown + `<div class="bf-sub${expandKey ? ' bv2-more' : ''}"${attr}>+ ${f.length - max} más${expandKey ? ' · ver tabla ⤢' : ''}</div>`;
  }
  // Resuelve una data-expand key → tabla ancha con el array YA filtrado (respeta
  // el carril/dueño/míos activos, igual que las columnas). Datos en memoria.
  function openColumnTable(key) {
    // "Todos": une las 3 columnas de abiertos (o los resueltos si estás en esa
    // vista), respetando el filtro activo. Cada ticket se etiqueta con su cola.
    if (key === 'all') {
      if (viewMode === 'resolved') { openTicketTable('✅ Todos los resueltos', applyFilter(resolvedData?.tickets) || [], deps); return; }
      const tag = (arr, label) => (applyFilter(arr) || []).map((t) => ({ ...t, _bucket: label }));
      const all = [
        ...tag(lastData?.nuevos, '🆕 Nuevos'),
        ...tag(lastData?.vencidos, '🔴 Vencidos'),
        ...tag(lastData?.enProgreso, '🔧 En progreso'),
      ];
      openTicketTable('📋 Todos los abiertos', all, deps, { cols: TABLE_COLS_ALL });
      return;
    }
    const CFG = {
      nuevos: { title: '🆕 Nuevos', get: () => applyFilter(lastData?.nuevos) },
      vencidos: { title: '🔴 Vencidos', get: () => applyFilter(lastData?.vencidos) },
      enProgreso: { title: '🔧 En progreso', get: () => applyFilter(lastData?.enProgreso) },
      resolved: { title: '✅ Tickets resueltos', get: () => applyFilter(resolvedData?.tickets) },
    };
    const cfg = CFG[key];
    if (cfg) openTicketTable(cfg.title, cfg.get() || [], deps);
  }
  // PRs del dev-lane: misma card de 2 filas (título arriba; #nº + estado abajo).
  // `opts.merged` → vista Resueltos: chip verde "✅ merged" en vez de pelota/CI
  // (un PR mergeado NO tiene CI corriendo — ese era el bug del #263).
  function devLaneList(prs, error, opts = {}) {
    if (error) return `<div class="bf-sub">gh no disponible: ${esc(error)}</div>`;
    const list = filterPRs(prs);
    if (!list.length) return `<div class="bf-sub">— ${opts.merged ? 'sin PRs mergeados' : 'sin PRs abiertos'} —</div>`;
    return list.map((pr) => {
      prMap.set(String(pr.number), pr);
      const statusChip = opts.merged
        ? `<span class="bb-chip bb-chip--ok bv2-prop" title="Mergeado${pr.mergedAt ? ` · ${fmtDate(pr.mergedAt)}` : ''}">✅ merged</span>`
        : `<span class="bb-chip ${pr.ball === 'yours' ? 'bb-chip--warn' : 'bb-chip--info'} bv2-prop" title="Pelota: ${esc(BALL_LABEL[pr.ball] || pr.ball)}">${BALL_LABEL[pr.ball] || pr.ball}</span>
           <span class="bv2-prop" title="Estado de checks (CI)">${ciBadge(pr.ci)}</span>`;
      return `<div class="bv2-card bv2-row--click" data-pr="${esc(pr.number)}" role="button" tabindex="0" title="Ver detalle del PR">
        <div class="bv2-card-title">${esc(pr.title)}${pr.isDraft ? ' · draft' : ''}</div>
        <div class="bv2-card-meta">
          <span class="bv2-row-id">#${pr.number}</span>
          ${statusChip}
          ${lockBadge(pr)}
          ${pr._stale ? '<span class="bv2-stale" title="Dato en caché: no vino en el último refresh">◷</span>' : ''}
        </div>
      </div>`;
    }).join('');
  }
  function fmtDate(iso) {
    const ms = Date.parse(iso || '');
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toISOString().slice(0, 10);
  }

  // Personas para el dropdown: owners de tickets + autores de PRs, deduplicados
  // por matching (mismo humano en Desk y GitHub). Incluye la vista Resueltos si
  // ya se cargó, para que el filtro por dueño cubra ambas vistas.
  function collectOwners(d) {
    const persons = new Map(); // keyNorm -> label (el más largo)
    const add = (name) => {
      if (!name) return;
      for (const [k, v] of persons) if (personMatch(name, v)) { if (name.length > v.length) persons.set(k, name); return; }
      const k = norm(name); if (k) persons.set(k, name);
    };
    for (const t of [...(d.nuevos || []), ...(d.vencidos || []), ...(d.enProgreso || [])]) add(t.ownerName);
    for (const pr of (d.devLane?.prs || [])) add(pr.authorName || pr.author);
    if (resolvedData) {
      for (const t of (resolvedData.tickets || [])) add(t.ownerName);
      for (const pr of (resolvedData.prs || [])) add(pr.authorName || pr.author);
    }
    return [...persons.values()].sort((a, b) => a.localeCompare(b));
  }

  // "Por carril" (resumen de abiertos) — sólo se pinta en la vista Activos.
  function laneOverviewHtml(d) {
    const lanes = Object.entries(d.openByLane || {}).filter(([, b]) => b.total > 0).sort((a, b) => b[1].total - a[1].total);
    const maxTotal = Math.max(1, ...lanes.map(([, b]) => b.total));
    const laneRows = lanes.map(([lane, b]) => {
      const w = Math.round((b.total / maxTotal) * 100);
      const prio = [b.P1 && `P1·${b.P1}`, b.P2 && `P2·${b.P2}`, b.P3 && `P3·${b.P3}`, b.unset && `sin·${b.unset}`].filter(Boolean).join(' ');
      const on = selectedLane === lane ? ' bv2-lane--on' : '';
      return `<div class="bv2-lane bv2-lane--click${on}" data-lane="${esc(lane)}" role="button" tabindex="0" title="Filtrar por ${esc(lane)}"><span class="bv2-lane-name">${esc(LANE_LABEL[lane] || lane)}</span><span class="bv2-lane-bar"><span style="width:${w}%"></span></span><span class="bv2-lane-n">${b.total}</span><span class="bf-sub">${esc(prio)}</span></div>`;
    }).join('');
    return `<div class="tk-card"><div class="bv2-h">Por carril · ${d.counts.open} abiertos</div>${laneRows || '<div class="bf-sub">— sin abiertos —</div>'}</div>`;
  }

  function searchBarHtml() {
    return `<div class="bv2-searchbar" data-ref="searchbar" hidden>
      <input type="text" placeholder="Número de ticket (ej. 527) + Enter" data-ref="search" class="btn--sm" />
    </div>`;
  }

  // Barra de filtros: FILA 1 = carriles · FILA 2 = Míos + Dueño + toggle de vista
  // (Activos | Resueltos). Los carriles cubren las lanes presentes en cualquiera
  // de las dos vistas (para poder filtrar los resueltos por carril también).
  function filterBarHtml(d) {
    const activeLanes = Object.entries(d.openByLane || {}).filter(([, b]) => b.total > 0).map(([l]) => l);
    const resolvedLanes = resolvedData ? Object.entries(resolvedData.byLane || {}).filter(([, n]) => n > 0).map(([l]) => l) : [];
    // Carriles SIEMPRE visibles aunque estén en 0 (pedido de Nico 2026-07-10): la
    // iniciativa de Infraestructura (Casa Mark / Nueva Oficina, pedida por Chris) se
    // muestra como pestaña fija — señal de "esto se trackea" — mientras el resto de
    // las lanes sigue apareciendo sólo con ≥1 ticket. Se ordena por el catálogo
    // LANE_META (así Infraestructura queda antes de 'other', no tras él).
    const PINNED_LANES = ['facilities-house', 'facilities-office'];
    const laneOrder = Object.keys(LANE_META);
    const orderOf = (l) => { const i = laneOrder.indexOf(l); return i === -1 ? 999 : i; };
    const laneKeys = [...new Set([...activeLanes, ...resolvedLanes, ...PINNED_LANES])].sort((a, b) => orderOf(a) - orderOf(b));
    const laneTab = (label, key) => `<button class="bv2-tab${selectedLane === key ? ' bv2-tab--on' : ''}" data-lane="${esc(key ?? '')}">${esc(label)}</button>`;
    const laneTabsHtml = [laneTab('Todos', null), ...laneKeys.map((l) => laneTab(LANE_LABEL[l] || l, l))].join('');
    const owners = collectOwners(d);
    const ownerOpts = ['<option value="">Dueño: todos</option>', ...owners.map((o) => `<option value="${esc(o)}"${selectedOwner === o ? ' selected' : ''}>${esc(o)}</option>`)].join('');
    // Conteo del botón "Todos en tabla": total del filtro activo (une las 3
    // columnas en Activos, o los resueltos en esa vista). Respeta carril/dueño/míos.
    const allCount = viewMode === 'resolved'
      ? applyFilter(resolvedData?.tickets).length
      : applyFilter(d.nuevos).length + applyFilter(d.vencidos).length + applyFilter(d.enProgreso).length;
    const allLabel = filtering() ? 'Todos (filtro)' : 'Todos';
    return `
      <div class="bv2-filterbar">
        <div class="bv2-tabs" data-ref="tabs">${laneTabsHtml}</div>
      </div>
      <div class="bv2-filterbar bv2-filterbar--row2">
        <button class="bv2-tab${selectedMine ? ' bv2-tab--on' : ''}" data-ref="mine" title="Solo lo que tengo tomado">🔒 Míos</button>
        <select class="bv2-owner-select btn--sm" data-ref="owner" title="Filtrar por dueño (opcional)">${ownerOpts}</select>
        <button class="bv2-allbtn" data-expand="all" title="Abrir TODOS en la tabla ancha (respeta el filtro activo)">${icon('maximize', { size: 12 })}<span>${allLabel} · ${allCount}</span></button>
        <div class="bv2-viewtoggle" data-ref="viewtoggle">
          <button class="bv2-vtab${viewMode === 'active' ? ' bv2-vtab--on' : ''}" data-view="active">🟢 Activos</button>
          <button class="bv2-vtab${viewMode === 'resolved' ? ' bv2-vtab--on' : ''}" data-view="resolved">✅ Resueltos</button>
        </div>
      </div>`;
  }

  // Dispatcher: re-render de la vista ACTUAL. Con `d` refresca lastData/currentYou.
  function render(d) {
    if (d) { lastData = d; currentYou = d.you || null; }
    ticketMap.clear(); prMap.clear();
    if (!lastData) return;
    if (viewMode === 'resolved') renderResolved();
    else renderActive();
  }

  // VISTA ACTIVOS: 3 columnas unificadas (Nuevos · Vencidos · En progreso) + PRs
  // abiertos. Cada ticket abierto cae en UNA sola columna (ver views.buildDashboard).
  function renderActive() {
    const d = lastData;
    content.innerHTML = `
      <div class="bv2-head"><span class="bf-sub">${icon('clock', { size: 11 })} snapshot ${fmtAgo(d.generatedAt)} (auto 60s) · ${d.counts.total} tickets · sin IA</span></div>
      ${searchBarHtml()}
      ${laneOverviewHtml(d)}
      ${filterBarHtml(d)}
      <div class="bv2-cols4">
        ${block(`🆕 Nuevos · ${countBadge(applyFilter(d.nuevos).length, d.counts.nuevos)}`, ticketList(d.nuevos, 12, 'nuevos'), true, 'nuevos')}
        ${block(`🔴 Vencidos · ${countBadge(applyFilter(d.vencidos).length, d.counts.vencidos)}`, ticketList(d.vencidos, 12, 'vencidos'), true, 'vencidos')}
        ${block(`🔧 En progreso · ${countBadge(applyFilter(d.enProgreso).length, d.counts.enProgreso)}`, ticketList(d.enProgreso, 12, 'enProgreso'), true, 'enProgreso')}
        ${block(`🔀 Dev-lane · PRs abiertos · ${countBadge(filterPRs(d.devLane?.prs).length, (d.devLane?.prs || []).length)}`, devLaneList(d.devLane?.prs, d.devLane?.error), true)}
      </div>`;
  }

  // VISTA RESUELTOS: PERSISTENTE + INCREMENTAL (pedido Niko 2026-07-10). Tickets
  // cerrados + PRs mergeados se acumulan en disco del lado server — una vez
  // guardado, un ítem no se vuelve a pedir a Zoho/GitHub, así que la 1ª carga
  // tarda (enriquece todo lo que aún no está en el store) y las siguientes son
  // casi instantáneas (sólo revisa si hay novedades). Mismos filtros de
  // carril/dueño/míos que Activos.
  function renderResolved() {
    const d = lastData;
    let body;
    if ((resolvedLoading || resolvedGenerating) && !resolvedData) {
      const msg = resolvedGenerating
        ? 'generando la base de resueltos por primera vez… (se completa sola en el fondo, no hace falta que esperes acá)'
        : 'leyendo resueltos…';
      body = `<div class="bf-sub" style="padding:1rem;display:flex;align-items:center;gap:.5rem">${pacman({ state: 'working', size: 'pac-sm' })} ${msg}</div>`;
    } else if (resolvedError && !resolvedData) {
      body = `<div class="bf-err" style="padding:1rem">${esc(resolvedError)}</div>`;
    } else if (resolvedData) {
      const capNote = resolvedData.capped
        ? `<div class="bf-sub" style="padding:.3rem .6rem 0">⚠️ Zoho limita ~100/depto sin paginar por consulta — el caché se va completando solo con cada revisión</div>` : '';
      const refNote = resolvedData.refreshing
        ? `<div class="bf-sub" style="padding:.3rem .6rem 0;display:flex;align-items:center;gap:.4rem">${pacman({ state: 'working', size: 'pac-sm' })} actualizando en el fondo…</div>` : '';
      const errNote = resolvedData.ticketsError
        ? `<div class="bf-sub" style="padding:.3rem .6rem 0">⚠️ ${esc(resolvedData.ticketsError)}</div>` : '';
      body = `${capNote}${refNote}${errNote}
        <div class="bv2-cols4">
          ${block(`✅ Tickets resueltos · ${countBadge(applyFilter(resolvedData.tickets).length, (resolvedData.tickets || []).length)}`, ticketList(resolvedData.tickets, 60, 'resolved'), true, 'resolved')}
          ${block(`🔀 PRs mergeados · ${countBadge(filterPRs(resolvedData.prs).length, (resolvedData.prs || []).length)}`, devLaneList(resolvedData.prs, resolvedData.prError, { merged: true }), true)}
        </div>`;
    } else {
      body = '<div class="bf-sub" style="padding:1rem">— sin datos —</div>';
    }
    const ago = resolvedData ? ` · actualizado ${fmtAgo(resolvedData.generatedAt)}` : '';
    const cnt = resolvedData ? ` · ${resolvedData.counts?.tickets ?? 0} tickets + ${resolvedData.counts?.prs ?? 0} PRs` : '';
    content.innerHTML = `
      <div class="bv2-head"><span class="bf-sub">${icon('clock', { size: 11 })} ✅ Resueltos · base persistente (auto)${ago}${cnt}</span></div>
      ${searchBarHtml()}
      ${filterBarHtml(d)}
      ${body}`;
  }

  // Lee la vista Resueltos del caché PERSISTENTE del server (el refresher de
  // fondo lo mantiene al día, ver sources.js). Es INSTANTÁNEO — ya no enriquece
  // en el request. `force` dispara un refresco de fondo YA (no bloquea). `silent`
  // = no mostrar el spinner (refresco en background, conserva lo visible).
  async function loadResolved(force, silent) {
    if (resolvedInFlight) return;
    resolvedInFlight = true;
    if (!silent && !resolvedData) { resolvedLoading = true; resolvedError = null; if (viewMode === 'resolved') renderResolved(); }
    try {
      const res = await fetch(`/api/tickets/resolved${force ? '?force=1' : ''}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        if (!resolvedData) resolvedError = data.error || 'Error';
      } else if (data.loading) {
        // Store todavía sin su 1ª pasada (arranque en frío) → "generando…" + reintento.
        resolvedGenerating = true; resolvedError = null;
        scheduleResolvedRetry(3000);
      } else {
        resolvedData = data; resolvedError = null; resolvedGenerating = false;
        // Si hay un refresco de fondo en curso, re-leemos en unos segundos para
        // tomar lo nuevo cuando termine (sin que tengas que tocar nada).
        if (data.refreshing) scheduleResolvedRetry(4000);
      }
    } catch (e) {
      if (!resolvedData) resolvedError = String(e?.message || e);
    } finally {
      resolvedInFlight = false;
      resolvedLoading = false;
      if (!modalClosed && viewMode === 'resolved') renderResolved();
    }
  }
  function scheduleResolvedRetry(ms) {
    if (resolvedRetryTimer || modalClosed) return;
    resolvedRetryTimer = setTimeout(() => {
      resolvedRetryTimer = null;
      if (!modalClosed && viewMode === 'resolved') loadResolved(false, true);
    }, ms);
  }
  // Auto-refresh periódico mientras se está mirando Resueltos (barato: el endpoint
  // sólo lee el store). Uniforme con el auto-refresh de Activos.
  function ensureResolvedAutoRefresh() {
    if (resolvedAutoTimer) return;
    resolvedAutoTimer = setInterval(() => {
      if (modalClosed) { clearInterval(resolvedAutoTimer); resolvedAutoTimer = null; return; }
      if (viewMode === 'resolved' && !resolvedInFlight) loadResolved(false, true);
    }, 20000);
  }

  // Listener delegado: filas de ticket/PR, pestañas de carril y buscador.
  content.addEventListener('click', (e) => {
    // Expandir columna → tabla ancha. preventDefault: el botón vive dentro del
    // <summary>, sin esto el click además colapsaría/expandiría el bloque.
    const expBtn = e.target.closest('[data-expand]');
    if (expBtn) { e.preventDefault(); openColumnTable(expBtn.dataset.expand); return; }
    const tRow = e.target.closest('.bv2-card[data-num]');
    if (tRow) { const t = ticketMap.get(tRow.dataset.num); if (t) openTicketDetail(t, deps); return; }
    const pRow = e.target.closest('.bv2-card[data-pr]');
    if (pRow) { const pr = prMap.get(pRow.dataset.pr); if (pr) openPrDetail(pr, deps); return; }
    const vtab = e.target.closest('.bv2-vtab');
    if (vtab) {
      const v = vtab.dataset.view;
      if (v && v !== viewMode) {
        viewMode = v;
        render(); // pinta la vista al toque (instantáneo con lo que haya)
        if (v === 'resolved') {
          // Lee del store (rápido). Si ya tenemos data, refresco SILENCIOSO para
          // no parpadear; si no, carga con spinner. Y arranca el auto-refresh.
          loadResolved(false, !!resolvedData);
          ensureResolvedAutoRefresh();
        }
      }
      return;
    }
    const mineBtn = e.target.closest('[data-ref="mine"]');
    if (mineBtn) { selectedMine = !selectedMine; render(); return; }
    const tab = e.target.closest('.bv2-tab');
    if (tab) { selectedLane = tab.dataset.lane || null; render(); return; }
    const laneBar = e.target.closest('.bv2-lane--click');
    if (laneBar) { const l = laneBar.dataset.lane || null; selectedLane = selectedLane === l ? null : l; render(); }
  });
  // Sub-filtro por dueño (dropdown).
  content.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-ref="owner"]');
    if (sel) { selectedOwner = sel.value || null; render(); }
  });
  content.addEventListener('keydown', (e) => {
    // Enter/Espacio sobre el "+N más" (div con role=button) → abre la tabla.
    if (e.key === 'Enter' || e.key === ' ') {
      const exp = e.target.closest('[data-expand]');
      if (exp) { e.preventDefault(); openColumnTable(exp.dataset.expand); return; }
    }
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('[data-ref="search"]');
    if (!inp) return;
    const num = String(inp.value || '').replace(/[^\d]/g, '');
    if (num) openTicketDetail({ ticketNumber: num }, deps);
  });

  // Recarga silenciosa (sin el estado "leyendo…"): re-renderiza solo si llegan
  // datos válidos, conservando lo visible si falla. La usa reflectBusy al terminar
  // un refresh disparado desde OTRA apertura del modal.
  async function silentReload() {
    try {
      const res = await fetch('/api/tickets/dashboard');
      const d = await res.json();
      if (res.ok && d && !d.error && !d.loading && d.counts && !modalClosed) {
        if (viewMode === 'active') render(d);            // refresca la vista visible
        else { lastData = d; currentYou = d.you || null; } // en Resueltos: guardo datos, no piso la vista
      }
    } catch { /* conserva lo visible */ }
  }

  async function load(force) {
    content.innerHTML = `<div class="bf-sub" style="padding:1rem">${icon('clock', { size: 12 })} leyendo…</div>`;
    try {
      const res = await fetch(`/api/tickets/dashboard${force ? '?force=1' : ''}`);
      const d = await res.json();
      if (!res.ok || d.error) { content.innerHTML = `<div class="bf-err" style="padding:1rem">${esc(d.error || 'Error')}</div>`; return; }
      if (d.loading) { content.innerHTML = `<div class="bf-sub" style="padding:1rem">${icon('clock', { size: 12 })} generando el primer snapshot (~7 s)…</div>`; setTimeout(() => load(false), 3000); return; }
      render(d);
    } catch (e) {
      content.innerHTML = `<div class="bf-err" style="padding:1rem">Error: ${esc(e?.message || e)}</div>`;
    }
  }

  load(false);
  return modal;
}
