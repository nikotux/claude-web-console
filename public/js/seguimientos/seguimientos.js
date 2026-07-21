// public/js/seguimientos/seguimientos.js — dashboard "Seguimientos" como PM
// personal (PLAN-553, 2026-07-21). Layout 2×2 sobre la base ticket-céntrica:
//   TOP  📝 Resumen del día (texto)
//   R1   🔵 Tabla de tickets Niko   · 📅 Agenda por horizonte
//   R2   🟡 Métricas                · 💬 Standup (reunión diaria)
// Todo 0 tokens salvo los botones que abren sesión (Actualizaciones/Standup/
// Trabajar/Vista IA). Móvil: los cuadrantes se apilan y son colapsables.
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

// ---- Derivados con fallback (robusto a snapshots viejos/nuevos) ----
function due(f) { return f.dueDate || (f.detail && f.detail.dueDate) || null; }
function projOf(f) { return f.project || (f.detail && f.detail.relatedTo) || 'Otros'; }
function isBlocked(f) { return (f.blockedBy && f.blockedBy.length) || f.ownerType === 'vendor' || f.ownerType === 'aprobacion' || f.statusType === 'On Hold'; }

const DAY = 86400000;
function dkey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function daysUntil(dl) { if (!dl) return null; const d = new Date(dl); if (isNaN(d.getTime())) return null; d.setHours(0, 0, 0, 0); return Math.round((d.getTime() - startOfToday()) / DAY); }
function horizonOf(dl) { const n = daysUntil(dl); if (n == null) return 'nodate'; if (n < 0) return 'overdue'; if (n === 0) return 'today'; if (n <= 7) return 'week'; if (n <= 31) return 'month'; return 'later'; }
function fmtShort(s) { try { return new Date(s).toLocaleDateString('es', { day: '2-digit', month: 'short' }); } catch { return String(s); } }
function fmtDate(s) { if (!s) return null; try { return new Date(s).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }); } catch { return String(s); } }

const COLS = [
  { k: 'key', label: '#', type: 'num', get: (f) => Number(f.key) || 0, cell: (f) => `#${esc(f.key)}` },
  { k: 'domain', label: 'Área', type: 'enum', opts: ['casa', 'oficina', 'otros'], get: (f) => f.domain || '', cell: (f) => `${dom(f.domain)} ${esc(f.domain || '')}` },
  { k: 'project', label: 'Proyecto', type: 'text', get: (f) => projOf(f), cell: (f) => esc(projOf(f)) },
  { k: 'ownerBall', label: 'Dueño de la pelota', type: 'text', get: (f) => f.ownerBall || '', cell: (f) => esc(f.ownerBall || '—') },
  { k: 'ownerType', label: 'Tipo', type: 'enum', opts: Object.keys(TYPE).filter(Boolean), get: (f) => f.ownerType || '', cell: (f) => `<span style="color:${typeMeta(f.ownerType).color}">${typeMeta(f.ownerType).label}</span>` },
  { k: 'involucrados', label: 'Involucrados', type: 'text', get: (f) => (f.involucrados || []).join(', '), cell: (f) => esc((f.involucrados || []).join(', ') || '—') },
  { k: 'title', label: 'Título', type: 'text', get: (f) => f.title || '', cell: (f) => esc(f.title || '') },
  { k: 'nextAction', label: 'Próxima acción', type: 'text', get: (f) => f.nextAction || '', cell: (f) => esc(f.nextAction || '') },
  { k: 'deadline', label: 'Deadline', type: 'date', get: (f) => due(f) || '', cell: (f) => { const dl = due(f); if (!dl) return '<span class="sg-dim">—</span>'; const n = daysUntil(dl); return `<span class="${n < 0 ? 'sg-r-bad' : n === 0 ? 'sg-r-warn' : ''}">${esc(fmtShort(dl))}</span>`; } },
  { k: 'daysIdle', label: 'Días', type: 'num', get: (f) => f.daysIdle || 0, cell: (f) => `${f.daysIdle ?? 0}` },
  { k: 'status', label: 'Estado', type: 'text', get: (f) => f.status || '', cell: (f) => esc(f.status || '') },
];

const state = { data: null, sort: { k: 'deadline', dir: 1 }, filters: {}, selected: new Set(), aiKeys: null, groupByProject: false, onlyMine: false, delta: null, lastSeenAt: null, seenMarked: false, collapsed: {}, metricRange: 'month', calMonth: null, history: [], _charts: {}, calEvents: {}, calMeta: { connected: false, error: null, loading: false } };

function rows() {
  let r = (state.data?.frentes || []).slice();
  if (state.onlyMine) r = r.filter((f) => f.mine);
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
    let cmp;
    if (s.type === 'num') cmp = va - vb;
    else if (s.type === 'date') cmp = (Date.parse(va) || Infinity) - (Date.parse(vb) || Infinity);
    else cmp = String(va).localeCompare(String(vb), 'es');
    return cmp * state.sort.dir;
  });
  return r;
}

// ---------- Deltas para el standup (comparación con la última visita) ----------
const LS_KEY = 'sg:lastSeen';
function computeDelta() {
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { /* noop */ }
  const F = state.data?.frentes || [];
  const curKeys = new Set(F.map((f) => String(f.key)));
  let nuevos = 0; let terminados = 0;
  if (prev && Array.isArray(prev.keys)) {
    const prevKeys = new Set(prev.keys.map(String));
    for (const k of curKeys) if (!prevKeys.has(k)) nuevos++;
    for (const k of prevKeys) if (!curKeys.has(k)) terminados++;
    state.lastSeenAt = prev.at || null;
  } else { state.lastSeenAt = null; }
  const porVencer = F.filter((f) => ['overdue', 'today', 'week'].includes(horizonOf(due(f)))).length;
  const trabados = F.filter(isBlocked).length;
  state.delta = { nuevos, terminados, porVencer, trabados };
}
function markSeen() {
  if (state.seenMarked) return;
  const F = state.data?.frentes || [];
  try { localStorage.setItem(LS_KEY, JSON.stringify({ keys: F.map((f) => String(f.key)), at: new Date().toISOString() })); } catch { /* noop */ }
  state.seenMarked = true;
}

// ---------------- Secciones ----------------
function renderResumen() {
  const F = state.data?.frentes || [];
  if (!F.length) return '<span class="sg-dim">Sin frentes. Tocá ↻ para traer datos de Desk.</span>';
  const overdue = F.filter((f) => horizonOf(due(f)) === 'overdue').length;
  const today = F.filter((f) => horizonOf(due(f)) === 'today').length;
  const week = F.filter((f) => horizonOf(due(f)) === 'week').length;
  const noDate = F.filter((f) => !due(f)).length;
  const blocked = F.filter(isBlocked).length;
  const stale = F.filter((f) => (f.daysIdle || 0) > 10).length;
  const d = state.delta || {};
  const p = [];
  p.push(`Tenés <b>${F.length}</b> frentes abiertos`);
  if (overdue) p.push(`<b class="sg-r-bad">${overdue} vencidos</b>`);
  if (today) p.push(`<b class="sg-r-warn">${today} vencen hoy</b>`);
  if (week) p.push(`${week} esta semana`);
  if (blocked) p.push(`<b>${blocked} trabados</b>`);
  if (stale) p.push(`${stale} sin señal +10d`);
  if (d.nuevos) p.push(`<b class="sg-r-new">${d.nuevos} nuevos</b> desde tu última visita`);
  if (d.terminados) p.push(`${d.terminados} salieron del tablero`);
  let txt = p.join(' · ') + '.';
  if (noDate === F.length) txt += ` <span class="sg-r-hint">⚠️ Ningún ticket tiene deadline en Zoho todavía — ${state.calMeta.connected ? 'el calendario muestra tus reuniones, pero no vencimientos.' : 'cargalos para llenar el calendario.'}</span>`;
  else if (noDate) txt += ` <span class="sg-r-hint">${noDate} sin deadline.</span>`;
  return `<div class="sg-resumen-txt">${txt}</div>`;
}

// ---------- Calendario híbrido (mini-mes en el cuadrante + modal ampliado) ----------
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WD = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
let lastCalRangeKey = null;

function calMonthDate() { if (!state.calMonth) { const n = new Date(); state.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); } return state.calMonth; }
function localKey(dl) { return dkey(new Date(dl)); }
function itemsByDay() {
  const m = {};
  for (const f of (state.data?.frentes || [])) { const dl = due(f); if (!dl) continue; const k = localKey(dl); (m[k] = m[k] || []).push(f); }
  return m;
}
function todayKey() { return dkey(new Date()); }
function clip(s, n) { const t = String(s || 'Reunión'); return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t; }
function hm(s) { return String(s || '').slice(11, 16) || '--:--'; }
function eventLine(m, withEnd = false) {
  const time = m.allDay ? 'Todo el día' : (withEnd ? `${hm(m.startISO)}–${hm(m.endISO)}` : hm(m.startISO));
  return `${time} ${m.subject || 'Reunión'}`;
}
function calendarRangeForMonth() {
  const base = calMonthDate();
  const from = new Date(base.getFullYear(), base.getMonth(), 1);
  from.setDate(from.getDate() - 7);
  const to = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  to.setDate(to.getDate() + 7);
  return { from: dkey(from), to: dkey(to) };
}

function renderCalendarSurfaces() {
  const agenda = document.querySelector('[data-quad="agenda"] .sg-quad-b');
  const resumen = document.querySelector('[data-quad="resumen"] .sg-quad-b');
  if (!agenda && !resumen) { fullRender(); return; }
  if (agenda) agenda.innerHTML = renderCalendar();
  if (resumen) resumen.innerHTML = renderResumen();
}

async function loadCalendar(force) {
  const range = calendarRangeForMonth();
  const rangeKey = `${range.from}|${range.to}`;
  if (!force && lastCalRangeKey === rangeKey) return;
  lastCalRangeKey = rangeKey;
  state.calMeta = { ...state.calMeta, loading: true, error: null };
  try {
    const qs = new URLSearchParams({ from: range.from, to: range.to });
    if (force) qs.set('fresh', '1');
    const r = await fetch(`/api/seguimientos/calendar?${qs}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.calEvents = data.byDay || {};
    state.calMeta = { connected: !!data.connected, error: data.error || null, loading: false };
  } catch (e) {
    state.calMeta = { ...state.calMeta, error: e.message, loading: false };
  }
  renderCalendarSurfaces();
}

// Grilla de un mes. opts.big = celdas con chips de items; opts.selected = día resaltado.
function miniMonthHtml(base, byDay, opts = {}) {
  const y = base.getFullYear(); const mo = base.getMonth();
  const startWd = (new Date(y, mo, 1).getDay() + 6) % 7; // lunes = 0
  const daysIn = new Date(y, mo + 1, 0).getDate();
  const tk = todayKey();
  let cells = '';
  for (let i = 0; i < startWd; i++) cells += '<div class="sg-cal-cell sg-cal-empty"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const k = dkey(new Date(y, mo, d));
    const items = byDay[k] || [];
    const events = (state.calEvents && state.calEvents[k]) || [];
    const chips = opts.big
      ? items.map((f) => `<span class="sg-cal-chip">#${esc(f.key)}</span>`).concat(events.map((m) => `<span class="sg-cal-chip sg-cal-chip--ev">📆 ${esc(clip(m.subject, 14))}</span>`)).slice(0, 3).join('') + (items.length + events.length > 3 ? `<span class="sg-cal-more">+${items.length + events.length - 3}</span>` : '')
      : `<span class="sg-cal-dots">${items.length ? '<span class="sg-cal-dot"></span>' : ''}${events.length ? '<span class="sg-cal-evdot"></span>' : ''}</span>`;
    cells += `<div class="sg-cal-cell${k === tk ? ' sg-cal-today' : ''}${opts.selected === k ? ' sg-cal-sel' : ''}${items.length || events.length ? ' sg-cal-has' : ''}" data-cal-day="${k}"><span class="sg-cal-num">${d}</span>${chips}</div>`;
  }
  return `<div class="sg-cal-grid${opts.big ? ' sg-cal-grid--big' : ''}">${WD.map((w) => `<div class="sg-cal-wd">${w}</div>`).join('')}${cells}</div>`;
}

// Tira de ESTA semana (fila 2 del calendario). Cada día abre el popup del día.
function weekStripHtml(byDay) {
  const sd = new Date(); sd.setHours(0, 0, 0, 0);
  const wStart = new Date(sd); wStart.setDate(sd.getDate() - ((sd.getDay() + 6) % 7));
  const tk = todayKey();
  let cols = '';
  for (let i = 0; i < 7; i++) {
    const dd = new Date(wStart); dd.setDate(wStart.getDate() + i);
    const k = dkey(dd);
    const n = (byDay[k] || []).length;
    const evn = ((state.calEvents && state.calEvents[k]) || []).length;
    cols += `<div class="sg-wkcol${k === tk ? ' sg-wkcol-today' : ''}" data-cal-day="${k}"><span class="sg-wkcol-wd">${WD[i]}</span><span class="sg-wkcol-d">${dd.getDate()}</span>${n ? `<span class="sg-wkcol-n">${n}</span>` : ''}${evn ? `<span class="sg-wkcol-ev">${evn}</span>` : ''}</div>`;
  }
  return `<div class="sg-wkstrip">${cols}</div>`;
}

function renderCalendar() {
  const base = calMonthDate();
  const byDay = itemsByDay();
  const F = state.data?.frentes || [];
  const noDate = F.filter((f) => !due(f)).length;
  const head = `<div class="sg-cal-head">
    <button class="sg-cal-nav" data-cal-nav="-1" title="mes anterior">‹</button>
    <span class="sg-cal-title">${MONTHS[base.getMonth()]} ${base.getFullYear()}</span>
    <button class="sg-cal-nav" data-cal-nav="1" title="mes siguiente">›</button>
    <button class="sg-cal-exp" data-act="calexpand" title="Ampliar a pantalla completa">⤢</button>
  </div>`;
  const hint = (noDate === F.length && F.length)
    ? `<div class="sg-r-hint" style="margin-top:.3rem">Sin deadlines en Zoho todavía${state.calMeta.connected ? ' — las reuniones aparecen con el punto frío.' : ' — cargalos y aparecen acá.'}</div>`
    : (noDate ? `<div class="sg-dim" style="margin-top:.3rem">${noDate} sin deadline.</div>` : '');
  const calHint = !state.calMeta.connected
    ? '<div class="sg-dim" style="margin-top:.3rem">🔌 Conectá tu calendario de Microsoft en ⚙ Sistema → Conexiones para ver tus reuniones acá.</div>'
    : (state.calMeta.error ? `<div class="sg-r-hint" style="margin-top:.3rem">⚠️ No se pudieron traer las reuniones: ${esc(state.calMeta.error)}</div>` : '');
  return head
    + `<div class="sg-cal-monthrow">${miniMonthHtml(base, byDay)}</div>`
    + '<div class="sg-cal-wklabel">Esta semana · tocá un día para ver el detalle</div>'
    + weekStripHtml(byDay)
    + hint
    + calHint;
}

// Popup del día estilo Outlook: banda "todo el día" (tickets) + timeline por
// horas. Las reuniones se leen por strings locales de Graph para no correrlas
// al huso del server cuando se muestran en el timeline.
const DV_H0 = 6; const DV_H1 = 21;
function openDayView(dateK) {
  const items = itemsByDay()[dateK] || [];
  const meetings = (state.calEvents && state.calEvents[dateK]) || [];
  const allDayMeetings = meetings.filter((m) => m.allDay);
  const timedMeetings = meetings.filter((m) => !m.allDay && Number.isFinite(Number(m.hour)));
  const hoursInDay = timedMeetings.map((m) => Number(m.hour));
  const h0 = Math.min(DV_H0, ...(hoursInDay.length ? hoursInDay : [DV_H0]));
  const h1 = Math.max(DV_H1, ...(hoursInDay.length ? hoursInDay : [DV_H1]));
  const ov = document.createElement('div');
  ov.className = 'sg-modal';
  const allDayRows = items.map((f) => `<div class="sg-dv-item" data-key="${esc(f.key)}"><span class="sg-ag-dot sg-ag-${horizonOf(due(f))}"></span><span class="sg-dv-t">🎫 #${esc(f.key)} ${esc(f.title)}</span></div>`)
    .concat(allDayMeetings.map((m) => `<div class="sg-dv-item sg-dv-item--ev">📆 <span class="sg-dv-t">${esc(m.subject || 'Reunión')}</span></div>`));
  const allday = allDayRows.length ? allDayRows.join('') : '<div class="sg-dim">Sin tickets ni reuniones de todo el día.</div>';
  const note = !state.calMeta.connected
    ? '<div class="sg-dim sg-dv-note">🔌 Conectá tu calendario de Microsoft en ⚙ Sistema → Conexiones para ver tus reuniones acá.</div>'
    : (!meetings.length ? '<div class="sg-dim sg-dv-note">Sin reuniones este día.</div>' : '');
  let hours = '';
  for (let h = h0; h <= h1; h++) {
    const evs = meetings.filter((m) => m.hour === h)
      .map((m) => {
        const txt = `📆 ${eventLine(m, true)}${m.location ? ` · ${m.location}` : ''}`;
        return m.webLink
          ? `<a class="sg-dv-ev" data-meeting-link href="${esc(m.webLink)}" target="_blank" rel="noopener">${esc(txt)}</a>`
          : `<div class="sg-dv-ev" data-meeting="${esc(m.id)}">${esc(txt)}</div>`;
      }).join('');
    hours += `<div class="sg-dv-hrow"><span class="sg-dv-h">${String(h).padStart(2, '0')}:00</span><div class="sg-dv-slot">${evs}</div></div>`;
  }
  ov.innerHTML = `<div class="sg-modal-card sg-dv-card">
    <div class="sg-modal-h"><b>📅 ${esc(dateK)}</b><button class="sg-x">✕</button></div>
    <div class="sg-dv-body">
      <div class="sg-dv-allday"><div class="sg-dv-lbl">Todo el día</div>${allday}</div>
      <div class="sg-dv-hours">${hours}</div>
      ${note}
    </div></div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.classList.contains('sg-x')) { ov.remove(); return; }
    if (e.target.closest('[data-meeting-link]')) return;
    const it = e.target.closest('[data-key]');
    if (it) { ov.remove(); openDetail(it.dataset.key); }
  });
  document.body.appendChild(ov);
}

// Popup del día (ventana emergente con lo asignado a esa fecha).
function openDayPopup(dateK) {
  const items = itemsByDay()[dateK] || [];
  const ov = document.createElement('div');
  ov.className = 'sg-modal';
  const list = items.length
    ? items.map((f) => `<div class="sg-ag-row" data-key="${esc(f.key)}"><span class="sg-ag-dot sg-ag-${horizonOf(due(f))}"></span><span class="sg-ag-t">#${esc(f.key)} ${esc(f.title)}</span></div>`).join('')
    : '<div class="sg-dim">Nada asignado a este día.</div>';
  ov.innerHTML = `<div class="sg-modal-card" style="width:min(460px,94vw)">
    <div class="sg-modal-h"><b>📅 ${esc(dateK)}</b><button class="sg-x">✕</button></div>
    <div class="sg-modal-body">${list}</div></div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.classList.contains('sg-x')) { ov.remove(); return; }
    const row = e.target.closest('[data-key]');
    if (row) { ov.remove(); openDetail(row.dataset.key); }
  });
  document.body.appendChild(ov);
}

// Calendario AMPLIADO (mes grande + semana en detalle, estilo Outlook/Google).
function openCalendarModal() {
  const base = new Date(calMonthDate());
  let selected = todayKey();
  const ov = document.createElement('div');
  ov.className = 'sg-modal';
  ov.innerHTML = `<div class="sg-modal-card sg-calm-card">
    <div class="sg-modal-h"><b>📅 Calendario</b><button class="sg-x">✕</button></div>
    <div class="sg-calm-body"><div class="sg-calm-month"></div><div class="sg-calm-week"></div></div></div>`;
  const draw = () => {
    const byDay = itemsByDay();
    const sd = new Date(selected + 'T00:00:00');
    const wStart = new Date(sd); wStart.setDate(sd.getDate() - ((sd.getDay() + 6) % 7));
    let weekHtml = '';
    for (let i = 0; i < 7; i++) {
      const dd = new Date(wStart); dd.setDate(wStart.getDate() + i);
      const k = dkey(dd);
      const items = byDay[k] || [];
      const meetings = (state.calEvents && state.calEvents[k]) || [];
      const ticketHtml = items.map((f) => `<div class="sg-wk-item" data-key="${esc(f.key)}">#${esc(f.key)} ${esc(f.title)}</div>`).join('');
      const meetingHtml = meetings.map((m) => `<div class="sg-wk-item sg-wk-item--ev">📆 ${esc(eventLine(m))}</div>`).join('');
      weekHtml += `<div class="sg-wk-day${k === selected ? ' sg-wk-sel' : ''}"><div class="sg-wk-h">${WD[i]} ${dd.getDate()}</div>${ticketHtml}${meetingHtml}${items.length || meetings.length ? '' : '<div class="sg-dim sg-wk-empty">—</div>'}</div>`;
    }
    ov.querySelector('.sg-calm-month').innerHTML = `<div class="sg-cal-head"><button class="sg-cal-nav" data-cm-nav="-1">‹</button><span class="sg-cal-title">${MONTHS[base.getMonth()]} ${base.getFullYear()}</span><button class="sg-cal-nav" data-cm-nav="1">›</button></div>${miniMonthHtml(base, byDay, { big: true, selected })}`;
    ov.querySelector('.sg-calm-week').innerHTML = `<div class="sg-wk-title">Semana de ${esc(selected)}</div>${weekHtml}`;
  };
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.classList.contains('sg-x')) { ov.remove(); return; }
    const nav = e.target.closest('[data-cm-nav]'); if (nav) { base.setMonth(base.getMonth() + Number(nav.dataset.cmNav)); draw(); return; }
    const day = e.target.closest('[data-cal-day]'); if (day) { selected = day.dataset.calDay; draw(); return; }
    const item = e.target.closest('[data-key]'); if (item) { ov.remove(); openDetail(item.dataset.key); }
  });
  document.body.appendChild(ov);
  draw();
}

const MRANGES = [['day', 'Día'], ['week', 'Semana'], ['month', 'Mes'], ['year', 'Año']];
function renderMetrics() {
  const F = state.data?.frentes || [];
  const done = state.data?.done || [];
  const byProj = {}; for (const f of F) { const p = projOf(f); byProj[p] = (byProj[p] || 0) + 1; }
  const blocked = F.filter(isBlocked).length;
  const tiles = [['Abiertos', F.length], ['Trabados', blocked], ['Cerrados 30d', done.length], ['Proyectos', Object.keys(byProj).length]]
    .map(([l, v]) => `<div class="sg-tile"><b>${v}</b><span>${esc(l)}</span></div>`).join('');
  const seg = MRANGES.map(([k, l]) => `<button class="sg-seg ${state.metricRange === k ? 'sg-seg--on' : ''}" data-mrange="${k}">${l}</button>`).join('');
  const rangeLbl = (MRANGES.find((m) => m[0] === state.metricRange) || MRANGES[2])[1];
  return `
    <div class="sg-mrange">${seg}</div>
    <div class="sg-tiles">${tiles}</div>
    <div class="sg-mcharts">
      <div class="sg-mchart"><div class="sg-mx-sect">📂 Por proyecto</div><div class="sg-chartbox"><canvas id="sg-chart-proj"></canvas></div></div>
      <div class="sg-mchart"><div class="sg-mx-sect">📈 Abiertos vs cerrados <span class="sg-dim">· ${esc(rangeLbl)}</span></div><div class="sg-chartbox"><canvas id="sg-chart-trend"></canvas></div></div>
    </div>`;
}

// ---- Gráficos (Chart.js, tema desde tokens --cwc-*) ----
function chartTokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n, d) => (cs.getPropertyValue(n) || d).trim();
  return {
    text: g('--cwc-text-dim', '#888'), grid: g('--cwc-border', '#333'),
    palette: [g('--cwc-accent', '#c60'), g('--cwc-ok', '#3a3'), g('--cwc-warn', '#da1'), g('--cwc-danger', '#c33'), g('--cwc-accent-cool', '#48c'), g('--cwc-text', '#ccc')],
  };
}
function destroyCharts() { for (const k of Object.keys(state._charts)) { try { state._charts[k].destroy(); } catch { /* noop */ } delete state._charts[k]; } }
function historyForRange() {
  const days = state.history || [];
  const N = state.metricRange === 'day' ? 1 : state.metricRange === 'week' ? 7 : state.metricRange === 'month' ? 30 : 365;
  const sel = days.slice(-N);
  if (state.metricRange === 'year') {
    const byMonth = {}; for (const d of sel) byMonth[d.date.slice(0, 7)] = d;
    return Object.keys(byMonth).sort().map((m) => byMonth[m]);
  }
  return sel;
}
function drawMetricCharts() {
  if (!window.Chart) return;
  if (state.collapsed.metrics) return;
  const projC = document.getElementById('sg-chart-proj');
  const trendC = document.getElementById('sg-chart-trend');
  if (!projC && !trendC) return;
  destroyCharts();
  const T = chartTokens();
  const F = state.data?.frentes || [];
  if (projC) {
    const byProj = {}; for (const f of F) { const p = projOf(f); byProj[p] = (byProj[p] || 0) + 1; }
    const labels = Object.keys(byProj); const data = labels.map((l) => byProj[l]);
    state._charts.proj = new window.Chart(projC, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => T.palette[i % T.palette.length]), borderWidth: 0 }] },
      options: { plugins: { legend: { position: 'bottom', labels: { color: T.text, font: { size: 10 }, boxWidth: 10, padding: 6 } } }, cutout: '55%', maintainAspectRatio: false },
    });
  }
  if (trendC) {
    const h = historyForRange();
    const labels = h.map((d) => (state.metricRange === 'year' ? d.date.slice(0, 7) : d.date.slice(5)));
    state._charts.trend = new window.Chart(trendC, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Abiertos', data: h.map((d) => d.open || 0), borderColor: T.palette[0], backgroundColor: 'transparent', tension: 0.3, pointRadius: 2 },
        { label: 'Cerrados', data: h.map((d) => d.done || 0), borderColor: T.palette[1], backgroundColor: 'transparent', tension: 0.3, pointRadius: 2 },
      ] },
      options: { plugins: { legend: { labels: { color: T.text, font: { size: 10 }, boxWidth: 10 } } }, scales: { x: { ticks: { color: T.text, font: { size: 9 }, maxRotation: 0 }, grid: { color: T.grid } }, y: { beginAtZero: true, ticks: { color: T.text, font: { size: 9 }, precision: 0 }, grid: { color: T.grid } } }, maintainAspectRatio: false },
    });
  }
}

function renderStandup() {
  const d = state.delta || {};
  const rows2 = [['🆕 Nuevos', d.nuevos || 0], ['✅ Salieron del tablero', d.terminados || 0], ['📅 Por vencer', d.porVencer || 0], ['⛔ Trabados', d.trabados || 0]]
    .map(([l, v]) => `<div class="sg-su-row"><span>${l}</span><b>${v}</b></div>`).join('');
  const last = state.lastSeenAt ? `desde ${fmtShort(state.lastSeenAt)}` : 'primera visita';
  return `
    <div class="sg-su-digest"><div class="sg-su-h">Cambios ${esc(last)}</div>${rows2}</div>
    <button class="sg-su-btn" data-act="standup">💬 Abrir reunión del día</button>
    <div class="sg-dim">Abre una sesión conmigo con este panorama cargado. Charlamos qué hacer; actualizar tickets pide tu OK.</div>`;
}

// Un cuadrante colapsable con header.
function quad(id, title, bodyHtml, extraHead = '') {
  const col = state.collapsed[id] ? ' sg-quad--collapsed' : '';
  return `<section class="sg-quad${col}" data-quad="${id}">
    <div class="sg-quad-h" data-collapse="${id}"><span class="sg-quad-t">${title}</span>${extraHead}<span class="sg-quad-chev">▾</span></div>
    <div class="sg-quad-b">${bodyHtml}</div>
  </section>`;
}

function tableBody() {
  return `<div class="sg-tablewrap"><table class="sg-table"><thead>${headHtml()}</thead><tbody id="sg-tbody"></tbody></table></div>`;
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
  if (!rs.length) { tb.innerHTML = `<tr><td colspan="${COLS.length + 1}" class="sg-empty">Sin frentes que coincidan.</td></tr>`; updateBulk(); return; }
  if (state.groupByProject) {
    const byP = {};
    for (const f of rs) { const p = projOf(f); (byP[p] = byP[p] || []).push(f); }
    const order = Object.keys(byP).sort((a, b) => byP[b].length - byP[a].length);
    tb.innerHTML = order.map((p) => `<tr class="sg-grouprow"><td colspan="${COLS.length + 1}">📂 ${esc(p)} · ${byP[p].length}</td></tr>${byP[p].map(rowHtml).join('')}`).join('');
  } else {
    tb.innerHTML = rs.map(rowHtml).join('');
  }
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
  const tableHead = `
    <button class="sg-chip ${state.groupByProject ? 'sg-chip--on' : ''}" data-act="groupproj" title="Agrupar por proyecto">📂 Proyecto</button>
    <button class="sg-chip ${state.onlyMine ? 'sg-chip--on' : ''}" data-act="minefilter" title="Solo tickets míos (asignados / tag Niko)">👤 Míos${c.mine != null ? ` (${c.mine})` : ''}</button>`;
  app.innerHTML = `
    <header class="sg-head">
      <div class="sg-titlebar">
        <h1>🎯 Seguimientos</h1>
        <span class="sg-counts">${c.total || 0} frentes · 🏠 ${c.casa || 0} · 🏢 ${c.oficina || 0}${c.done != null ? ` · ✅ ${c.done} cerrados` : ''}${c.classified != null ? ` · clasif. ${c.classified}` : ''}</span>
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
    ${quad('resumen', '📝 Resumen del día', renderResumen())}
    <div class="sg-grid">
      <div class="sg-col sg-col-l">
        ${quad('table', '🔵 Tickets Niko', tableBody(), tableHead)}
        ${quad('metrics', '🟡 Métricas', renderMetrics())}
      </div>
      <div class="sg-col sg-col-r">
        ${quad('agenda', '📅 Calendario', renderCalendar())}
        ${quad('standup', '💬 Standup', renderStandup())}
      </div>
    </div>`;
  renderRows();
  requestAnimationFrame(drawMetricCharts);
}

// Filas clave→valor de una sección (omite vacíos).
function kvRows(pairs) {
  const html = pairs
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<div class="sg-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join('');
  return html || '<div class="sg-dim">—</div>';
}

// Detalle rico tipo Tickets & Features (bv2).
function openDetail(key) {
  const f = (state.data?.frentes || []).find((x) => String(x.key) === String(key));
  if (!f) return;
  const dt = f.detail || {};
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
        ['Proyecto', projOf(f)], ['Carril', dt.category || f.domain], ['Prioridad', dt.priority], ['Estado', f.status],
        ['País', dt.country], ['Producto', dt.product], ['Cliente', dt.client],
        ['Relacionado a', dt.relatedTo], ['Canal', dt.channel], ['Idioma', dt.language],
        ['Pelota', pelota], ['Involucrados', (f.involucrados || []).join(', ')], ['Próxima acción', f.nextAction],
      ])}</div>
      <div class="sg-sect">👥 Personas</div>
      <div class="sg-grid2">${kvRows([['Propietario', dt.assignee], ['Reporter', dt.reporter]])}</div>
      <div class="sg-sect">🕒 Tiempos</div>
      <div class="sg-grid2">${kvRows([
        ['Creado', fmtDate(dt.createdTime)], ['Última actualización', fmtDate(dt.modifiedTime || f.lastSignalAt)],
        ['Vence', fmtDate(due(f))], ['On hold desde', fmtDate(dt.onholdTime)],
        ['Comentarios', dt.commentCount], ['Adjuntos', dt.attachmentCount],
      ])}</div>
      <div class="sg-sect">📝 ${descLabel}</div>
      <div class="sg-desc">${esc(dt.description || '—')}</div>
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

async function postJson(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

async function resolveBulk(keys) {
  if (!keys || !keys.length) return;
  try { const d = await postJson('/api/seguimientos/resolve-bulk', { keys }); if (d.chatId) window.open('/', '_blank'); } catch { /* noop */ }
}

async function scanUpdates() {
  const keys = state.selected.size ? [...state.selected] : null;
  try { const d = await postJson('/api/seguimientos/scan-updates', { keys }); if (d.chatId) window.open('/', '_blank'); } catch { /* noop */ }
}

async function openStandup() {
  try { const d = await postJson('/api/seguimientos/standup', { digest: state.delta }); if (d.chatId) window.open('/', '_blank'); } catch { /* noop */ }
}

// Mini-modal de texto (evita prompt() nativo).
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

async function aiView() {
  const q = await askText('🤖 Vista con IA — describí qué querés ver', 'ej: todo lo que involucra a Julián y está trabado');
  if (!q) return;
  const btns = document.querySelectorAll('[data-act="aiview"]');
  btns.forEach((b) => { b.textContent = '🤖 pensando…'; b.disabled = true; });
  try {
    const d = await postJson('/api/seguimientos/ai-filter', { query: q });
    if (Array.isArray(d.keys)) {
      state.aiKeys = new Set(d.keys.map(String));
      state.selected = new Set(d.keys.map(String));
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
    const [snap, hist] = await Promise.all([
      fetch('/api/seguimientos', { headers: { accept: 'application/json' } }).then((r) => r.json()),
      fetch('/api/seguimientos/history', { headers: { accept: 'application/json' } }).then((r) => r.json()).catch(() => ({ days: [] })),
    ]);
    state.data = snap;
    state.history = Array.isArray(hist.days) ? hist.days : [];
    computeDelta();
    fullRender();
    markSeen();
    loadCalendar(false);
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
    else if (a === 'standup') openStandup();
    else if (a === 'aiview') aiView();
    else if (a === 'groupproj') { state.groupByProject = !state.groupByProject; fullRender(); }
    else if (a === 'minefilter') { state.onlyMine = !state.onlyMine; fullRender(); }
    else if (a === 'clearai') { state.aiKeys = null; fullRender(); }
    else if (a === 'calexpand') openCalendarModal();
    else post(`/api/seguimientos/${a}`);
    return;
  }
  // Filtro de tiempo de Métricas.
  const mr = e.target.closest('[data-mrange]');
  if (mr) { state.metricRange = mr.dataset.mrange; fullRender(); return; }
  // Navegación de mes del mini-calendario.
  const cn = e.target.closest('[data-cal-nav]');
  if (cn) { const b = calMonthDate(); b.setMonth(b.getMonth() + Number(cn.dataset.calNav)); state.calMonth = new Date(b); fullRender(); loadCalendar(false); return; }
  // Click en un día del calendario (mes o semana) → popup estilo Outlook.
  const cd = e.target.closest('[data-cal-day]');
  if (cd) { openDayView(cd.dataset.calDay); return; }
  // Colapsar un cuadrante (después de data-act: los chips del header ganan).
  const collapse = e.target.closest('[data-collapse]');
  if (collapse) { const id = collapse.dataset.collapse; state.collapsed[id] = !state.collapsed[id]; document.querySelector(`[data-quad="${id}"]`)?.classList.toggle('sg-quad--collapsed', state.collapsed[id]); if (id === 'metrics' && !state.collapsed[id]) requestAnimationFrame(drawMetricCharts); return; }
  if (e.target.matches('input, select')) return;
  const el = e.target.closest('[data-key]');
  if (el) openDetail(el.dataset.key);
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
