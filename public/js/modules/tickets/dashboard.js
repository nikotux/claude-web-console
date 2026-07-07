// modules/bugs-v2/dashboard.js — modal del dashboard "One Front Door".
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

const LANE_LABEL = {
  bug: '🐞 bug', feature: '💡 feature', hardware: '🖥 hardware', access: '🔑 access',
  platform: '⚙️ platform', onboarding: '🌱 onboarding', other: '· other',
};
const BALL_LABEL = { yours: '🟡 tuya', chris: '🔵 Chris' };

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
function block(title, inner, open) {
  return `<details class="bv2-block"${open ? ' open' : ''}>
    <summary class="bv2-block-h"><span>${title}</span>${icon('chevronDown', { size: 14 })}</summary>
    <div class="bv2-block-body">${inner}</div>
  </details>`;
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
    onClose: () => { modalClosed = true; busyListeners.delete(reflectBusy); }, // deja de escuchar al cerrar
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

  // --- Botones en el header (junto a la ✕, con espacio) ---
  const head = modal.card.querySelector('.dlg-head');
  const headActions = document.createElement('div');
  headActions.className = 'bv2-head-actions';
  headActions.innerHTML = `
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
    if (manualBusy) return;               // dedup GLOBAL: un solo refresh manual a la vez
    setManualBusy(true);                  // notifica a TODOS los modales vivos (Pac-Man)
    load(true).finally(() => setManualBusy(false));
  });
  reflectBusy(manualBusy);                // si ya venía corriendo de antes, mostralo YA
  headActions.querySelector('[data-ref="search-toggle"]').addEventListener('click', () => {
    const bar = content.querySelector('[data-ref="searchbar"]');
    if (bar) { bar.hidden = !bar.hidden; if (!bar.hidden) bar.querySelector('input')?.focus(); }
  });

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

  function ticketRow(t, metric, chipClass) {
    ticketMap.set(String(t.ticketNumber), t);
    return `<div class="bv2-row bv2-row--click" data-num="${esc(t.ticketNumber)}" role="button" tabindex="0" title="Ver detalle del ticket">
      <span class="bv2-row-id">#${esc(t.ticketNumber)}</span>
      <span class="bb-chip ${chipClass}">${esc(LANE_LABEL[t.lane] || t.lane)}</span>
      <span class="bv2-row-sub">${esc((t.subject || '').slice(0, 60))}</span>
      ${lockBadge(t)}
      ${t.stale ? '<span class="bv2-stale" title="Dato en caché: no vino en el último refresh, se conserva el último conocido">◷</span>' : ''}
      <span class="bv2-row-metric">${esc(metric)}</span>
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

  function ticketList(items, metricFn, chipClass, max = 12) {
    const f = applyFilter(items);
    if (!f.length) return '<div class="bf-sub">— nada —</div>';
    const shown = f.slice(0, max).map((t) => ticketRow(t, metricFn(t), chipClass)).join('');
    return shown + (f.length > max ? `<div class="bf-sub">+ ${f.length - max} más</div>` : '');
  }
  function devLaneList(dl) {
    if (dl?.error) return `<div class="bf-sub">gh no disponible: ${esc(dl.error)}</div>`;
    const prs = filterPRs(dl?.prs);
    if (!prs.length) return '<div class="bf-sub">— sin PRs —</div>';
    return prs.map((pr) => {
      prMap.set(String(pr.number), pr);
      return `<div class="bv2-row bv2-row--click" data-pr="${esc(pr.number)}" role="button" tabindex="0" title="Ver detalle del PR">
        <span class="bv2-row-id">#${pr.number}</span>
        <span class="bb-chip ${pr.ball === 'yours' ? 'bb-chip--warn' : 'bb-chip--info'}">${BALL_LABEL[pr.ball] || pr.ball}</span>
        <span class="bv2-row-sub">${esc(pr.title)}${pr.isDraft ? ' · draft' : ''}</span>
        ${lockBadge(pr)}
        ${pr._stale ? '<span class="bv2-stale" title="Dato en caché: no vino en el último refresh">◷</span>' : ''}
        <span class="bv2-row-metric">${ciBadge(pr.ci)}</span>
      </div>`;
    }).join('');
  }

  // Personas para las pestañas: owners de tickets (vencidos/aging/resueltos) +
  // autores de PRs, deduplicados por matching (mismo humano en Desk y GitHub).
  function collectOwners(d) {
    const persons = new Map(); // keyNorm -> label (el más largo)
    const add = (name) => {
      if (!name) return;
      for (const [k, v] of persons) if (personMatch(name, v)) { if (name.length > v.length) persons.set(k, name); return; }
      const k = norm(name); if (k) persons.set(k, name);
    };
    for (const t of [...(d.overdue || []), ...(d.aging || []), ...(d.resolvedThisWeek || [])]) add(t.ownerName);
    for (const pr of (d.devLane?.prs || [])) add(pr.authorName || pr.author);
    return [...persons.values()].sort((a, b) => a.localeCompare(b));
  }

  function render(d) {
    lastData = d;
    currentYou = d.you || null;
    ticketMap.clear(); prMap.clear();
    const lanes = Object.entries(d.openByLane).filter(([, b]) => b.total > 0).sort((a, b) => b[1].total - a[1].total);
    const maxTotal = Math.max(1, ...lanes.map(([, b]) => b.total));
    const laneRows = lanes.map(([lane, b]) => {
      const w = Math.round((b.total / maxTotal) * 100);
      const prio = [b.P1 && `P1·${b.P1}`, b.P2 && `P2·${b.P2}`, b.P3 && `P3·${b.P3}`, b.unset && `sin·${b.unset}`].filter(Boolean).join(' ');
      const on = selectedLane === lane ? ' bv2-lane--on' : '';
      return `<div class="bv2-lane bv2-lane--click${on}" data-lane="${esc(lane)}" role="button" tabindex="0" title="Filtrar por ${esc(lane)}"><span class="bv2-lane-name">${esc(LANE_LABEL[lane] || lane)}</span><span class="bv2-lane-bar"><span style="width:${w}%"></span></span><span class="bv2-lane-n">${b.total}</span><span class="bf-sub">${esc(prio)}</span></div>`;
    }).join('');

    // Pestañas de CARRIL (filtro principal) + dropdown de DUEÑO (sub-filtro).
    const laneKeys = lanes.map(([l]) => l);
    const laneTab = (label, key) => `<button class="bv2-tab${selectedLane === key ? ' bv2-tab--on' : ''}" data-lane="${esc(key ?? '')}">${esc(label)}</button>`;
    const laneTabsHtml = [laneTab('Todos', null), ...laneKeys.map((l) => laneTab(LANE_LABEL[l] || l, l))].join('');
    const owners = collectOwners(d);
    const ownerOpts = ['<option value="">Dueño: todos</option>', ...owners.map((o) => `<option value="${esc(o)}"${selectedOwner === o ? ' selected' : ''}>${esc(o)}</option>`)].join('');

    content.innerHTML = `
      <div class="bv2-head"><span class="bf-sub">${icon('clock', { size: 11 })} snapshot ${fmtAgo(d.generatedAt)} (auto 60s) · ${d.counts.total} tickets · sin IA</span></div>
      <div class="bv2-searchbar" data-ref="searchbar" hidden>
        <input type="text" placeholder="Número de ticket (ej. 527) + Enter" data-ref="search" class="btn--sm" />
      </div>

      <div class="tk-card">
        <div class="bv2-h">Por carril · ${d.counts.open} abiertos</div>
        ${laneRows || '<div class="bf-sub">— sin abiertos —</div>'}
      </div>

      <div class="bv2-filterbar">
        <div class="bv2-tabs" data-ref="tabs">${laneTabsHtml}</div>
        <button class="bv2-tab${selectedMine ? ' bv2-tab--on' : ''}" data-ref="mine" title="Solo lo que tengo tomado">🔒 Míos</button>
        <select class="bv2-owner-select btn--sm" data-ref="owner" title="Filtrar por dueño (opcional)">${ownerOpts}</select>
      </div>

      <div class="bv2-cols5">
        ${block(`🆕 Nuevos · sin triar · ${countBadge(applyFilter(d.needsTriage).length, d.counts.needsTriage)}`, ticketList(d.needsTriage, (t) => `${t.agingDays}d`, 'bb-chip--info'), true)}
        ${block(`🔴 Vencidos · ${countBadge(applyFilter(d.overdue).length, d.counts.overdue)}`, ticketList(d.overdue, (t) => `${t.agingDays}d`, 'bb-chip--danger'), true)}
        ${block(`🕐 Sin update 7+ días · ${countBadge(applyFilter(d.aging).length, d.counts.aging)}`, ticketList(d.aging, (t) => `${t.agingDays}d`, 'bb-chip--warn'), true)}
        ${block(`✅ Resueltos esta semana · ${countBadge(applyFilter(d.resolvedThisWeek).length, d.counts.resolvedThisWeek)}`, ticketList(d.resolvedThisWeek, () => '✓', 'bb-chip--ok'), true)}
        ${block(`🔀 Dev-lane · PRs · ${countBadge(filterPRs(d.devLane?.prs).length, (d.devLane?.prs || []).length)}`, devLaneList(d.devLane), true)}
      </div>`;
  }

  // Listener delegado: filas de ticket/PR, pestañas de carril y buscador.
  content.addEventListener('click', (e) => {
    const tRow = e.target.closest('.bv2-row[data-num]');
    if (tRow) { const t = ticketMap.get(tRow.dataset.num); if (t) openTicketDetail(t, deps); return; }
    const pRow = e.target.closest('.bv2-row[data-pr]');
    if (pRow) { const pr = prMap.get(pRow.dataset.pr); if (pr) openPrDetail(pr, deps); return; }
    const mineBtn = e.target.closest('[data-ref="mine"]');
    if (mineBtn) { selectedMine = !selectedMine; if (lastData) render(lastData); return; }
    const tab = e.target.closest('.bv2-tab');
    if (tab) { selectedLane = tab.dataset.lane || null; if (lastData) render(lastData); return; }
    const laneBar = e.target.closest('.bv2-lane--click');
    if (laneBar) { const l = laneBar.dataset.lane || null; selectedLane = selectedLane === l ? null : l; if (lastData) render(lastData); }
  });
  // Sub-filtro por dueño (dropdown).
  content.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-ref="owner"]');
    if (sel) { selectedOwner = sel.value || null; if (lastData) render(lastData); }
  });
  content.addEventListener('keydown', (e) => {
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
      if (res.ok && d && !d.error && !d.loading && d.counts && !modalClosed) render(d);
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
