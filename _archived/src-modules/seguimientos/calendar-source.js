// Fuente única del calendario de Seguimientos.
//
// Graph devuelve `dateTime` en la zona pedida con el header Prefer. Como este
// servidor corre en Berlín y el calendario de Niko se mira en Medellín, no
// convertimos esos strings con Date para decidir día/hora: un parseo local/UTC
// puede correr eventos cerca de medianoche al día incorrecto.
import { getAccessToken } from '../../core/connections-store.js';

const GRAPH_CALENDAR_VIEW = 'https://graph.microsoft.com/v1.0/me/calendarView';
const TTL_MS = 120000;
const MAX_EXPANDED_DAYS = 60;
const cache = new Map();

function shortError(e) {
  return String(e?.message || e || 'Error de calendario.').slice(0, 180);
}

function addDaysKey(dayKey, delta) {
  const y = Number(dayKey.slice(0, 4));
  const m = Number(dayKey.slice(5, 7));
  const d = Number(dayKey.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function compareDay(a, b) {
  return String(a).localeCompare(String(b));
}

function expandedDays(e) {
  const startDay = String(e.start?.dateTime || '').slice(0, 10);
  let endDay = String(e.end?.dateTime || '').slice(0, 10) || startDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay)) return [];

  // En eventos de día completo, Graph informa el fin como exclusivo. Si no lo
  // ajustamos, un feriado de un día aparece también al día siguiente.
  if (e.isAllDay) endDay = addDaysKey(endDay, -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDay) || compareDay(endDay, startDay) < 0) endDay = startDay;

  const days = [];
  let cur = startDay;
  for (let i = 0; i < MAX_EXPANDED_DAYS && compareDay(cur, endDay) <= 0; i++) {
    days.push(cur);
    cur = addDaysKey(cur, 1);
  }
  return days;
}

function normalizeEvent(e, dayKey) {
  const startISO = e.start?.dateTime || null;
  const endISO = e.end?.dateTime || null;
  const allDay = !!e.isAllDay;
  return {
    id: e.id || `${dayKey}:${e.subject || ''}`,
    subject: e.subject || 'Reunión',
    dayKey,
    hour: allDay ? null : Number(String(startISO || '').slice(11, 13)),
    startISO,
    endISO,
    allDay,
    location: e.location?.displayName || null,
    organizer: e.organizer?.emailAddress?.name || null,
    webLink: e.webLink || null,
    showAs: e.showAs || null,
  };
}

export async function fetchCalendar(username, { from, to, fresh = false } = {}) {
  const key = `${username}|${from}|${to}`;
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  }

  let token;
  try {
    token = await getAccessToken(username, 'microsoft');
  } catch {
    return { connected: false, byDay: {}, count: 0, reason: 'sin-conexion' };
  }

  try {
    const qs = new URLSearchParams({
      startDateTime: from,
      endDateTime: to,
      $select: 'id,subject,start,end,isAllDay,location,organizer,webLink,showAs',
      $orderby: 'start/dateTime',
      $top: '200',
    });
    const res = await fetch(`${GRAPH_CALENDAR_VIEW}?${qs}`, {
      headers: {
        authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="America/Bogota"',
      },
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* best-effort */ }
      return { connected: true, byDay: {}, count: 0, error: `Graph ${res.status}: ${body.slice(0, 120) || res.statusText}` };
    }

    const raw = await res.json();
    const byDay = {};
    let count = 0;
    for (const e of (Array.isArray(raw.value) ? raw.value : [])) {
      for (const dayKey of expandedDays(e)) {
        (byDay[dayKey] = byDay[dayKey] || []).push(normalizeEvent(e, dayKey));
        count++;
      }
    }

    const value = { connected: true, byDay, count };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { connected: true, byDay: {}, count: 0, error: shortError(e) };
  }
}
