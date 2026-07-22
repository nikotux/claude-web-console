// core/microsoft-calendar-client.js — cliente directo a Graph Calendar con identidad de USUARIO.
//
// Las sesiones de chat no deben escribir calendario con credenciales del agente:
// este módulo resuelve el token OAuth de Microsoft por username y fija la zona
// horaria operativa de Niko en America/Bogota cuando el llamador no indique otra.
import { getAccessToken } from './connections-store.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function parseResponse(res) {
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { text, json };
}

function graphErrorMessage({ text, json }) {
  return json?.error?.message || json?.message || json?.error_description || text.slice(0, 200);
}

async function graphFetch(username, url, options = {}) {
  const ctx = await calendarCtx(username);
  const headers = { ...ctx.headers, ...(options.headers || {}) };
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH_BASE}${url}`, {
    ...options,
    headers,
  });
  const parsed = await parseResponse(res);
  if (!res.ok) {
    throw new Error('Graph ' + res.status + ': ' + (graphErrorMessage(parsed) || res.statusText));
  }
  return parsed.json;
}

export async function calendarCtx(username) {
  let token;
  try {
    token = await getAccessToken(username, 'microsoft');
  } catch {
    throw new Error(`Microsoft no está conectado para ${username}. Conectalo en ⚙ Sistema → Conexiones.`);
  }
  if (!token) {
    throw new Error(`Microsoft no está conectado para ${username}. Conectalo en ⚙ Sistema → Conexiones.`);
  }

  return {
    token,
    headers: { authorization: 'Bearer ' + token },
  };
}

export async function createEvent(username, {
  subject,
  start,
  end,
  timeZone = 'America/Bogota',
  bodyHtml = null,
  location = null,
  isAllDay = false,
  reminderMinutesBeforeStart = null,
  categories = null,
}) {
  if (!subject) throw new Error('Falta subject para crear el evento de calendario.');
  if (!start) throw new Error('Falta start para crear el evento de calendario.');
  if (!end) throw new Error('Falta end para crear el evento de calendario.');

  const payload = {
    subject,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
    isAllDay: !!isAllDay,
  };
  if (bodyHtml) payload.body = { contentType: 'HTML', content: bodyHtml };
  if (location) payload.location = { displayName: location };
  if (typeof reminderMinutesBeforeStart === 'number' && Number.isFinite(reminderMinutesBeforeStart)) {
    payload.isReminderOn = true;
    payload.reminderMinutesBeforeStart = reminderMinutesBeforeStart;
  }
  if (Array.isArray(categories)) payload.categories = categories;

  return graphFetch(username, '/me/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function listEvents(username, { from, to, timeZone = 'America/Bogota', top = 50 }) {
  if (!from) throw new Error('Falta from para listar el calendario.');
  if (!to) throw new Error('Falta to para listar el calendario.');

  const qs = new URLSearchParams({
    startDateTime: from,
    endDateTime: to,
    $top: String(top),
    $orderby: 'start/dateTime',
  });
  const data = await graphFetch(username, `/me/calendarView?${qs.toString()}`, {
    headers: { Prefer: `outlook.timezone="${timeZone}"` },
  });
  if (!Array.isArray(data?.value)) {
    throw new Error('Graph devolvió una respuesta de calendario inválida.');
  }
  return data.value;
}

export async function deleteEvent(username, eventId) {
  if (!eventId) throw new Error('Falta el ID del evento de calendario.');
  return graphFetch(username, `/me/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
}
