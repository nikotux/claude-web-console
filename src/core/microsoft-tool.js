// Puente de Microsoft 365 para el chat con identidad inmutable por sesión.
//
// La invariante multi-tenant depende de que `username` se capture una sola vez
// al crear el servidor: ninguna tool lo acepta desde el modelo ni permite actuar
// "en nombre de" otra cuenta. Si el modelo pudiera elegirlo, podría cruzar la
// frontera entre dueños de chats y consultar el buzón o los archivos de otro.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { fetchMailBodies, fetchMailSample } from './microsoft-mail-client.js';
import { calendarCtx, createEvent, listEvents } from './microsoft-calendar-client.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TIME_ZONE = 'America/Bogota';
const NETWORK_TIMEOUT_MS = 15_000;
const MAX_MAIL_BODY_CHARS = 20_000;
const MAX_TEXT_FILE_BYTES = 60_000;

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  return textResult({
    error: err?.userMessage || 'No se pudo completar la operación con Microsoft 365. Intentá nuevamente.',
  });
}

function toolError(message, status = null) {
  const err = new Error(message);
  err.userMessage = message;
  err.status = status;
  return err;
}

function clampLimit(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(Math.trunc(number), max));
}

async function microsoftHeaders(username, extra = {}) {
  try {
    const ctx = await calendarCtx(username);
    return { ...ctx.headers, ...extra };
  } catch (err) {
    // No colapsar las dos causas en un mismo mensaje: "no hay conexión guardada" se
    // arregla conectando, pero "el refresh falló" con la conexión sana manda al usuario
    // a un panel que ya está bien. Distinguirlas es lo que hace accionable el error.
    const detail = String(err?.message || '').trim();
    if (/no está conectado|sin conexión/i.test(detail)) {
      throw toolError('Microsoft no está conectado para vos: conectalo en ⚙ Sistema → Conexiones.');
    }
    throw toolError(`No se pudo renovar el acceso a Microsoft 365: ${detail.slice(0, 200)}. Si vuelve a pasar, reconectá Microsoft en ⚙ Sistema → Conexiones.`);
  }
}

function graphMessage(parsed) {
  return parsed?.error?.message || parsed?.message || '';
}

function graphFailure(status, area, parsed = null) {
  if (status === 401) {
    return toolError('La conexión de Microsoft venció o fue revocada. Reconectala en ⚙ Sistema → Conexiones.', status);
  }
  if (status === 403) {
    return toolError(`Falta un permiso de Microsoft 365 para ${area}. Reconectalo en ⚙ Sistema → Conexiones y aceptá los permisos solicitados.`, status);
  }
  if (status === 404) return toolError(`No se encontró el elemento solicitado en ${area}.`, status);
  if (status === 429) return toolError('Microsoft Graph limitó temporalmente las consultas. Esperá un momento e intentá de nuevo.', status);
  if (status >= 500) return toolError('Microsoft Graph no está disponible temporalmente. Intentá de nuevo más tarde.', status);
  const detail = String(graphMessage(parsed)).slice(0, 240);
  return toolError(`Microsoft Graph rechazó la operación de ${area}${detail ? `: ${detail}` : ` (HTTP ${status})`}.`, status);
}

async function graphFetch(username, path, { area, method = 'GET', headers = {}, body, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const requestHeaders = await microsoftHeaders(username, headers);
    return await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: requestHeaders,
      body,
      redirect,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.userMessage) throw err;
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw toolError(`La consulta de ${area} agotó el tiempo de espera.`);
    }
    throw toolError(`No se pudo conectar con Microsoft Graph para ${area}.`);
  } finally {
    clearTimeout(timer);
  }
}

async function graphJson(username, path, options = {}) {
  const res = await graphFetch(username, path, options);
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) throw graphFailure(res.status, options.area, parsed);
  return parsed;
}

function recipient(value) {
  const email = value?.emailAddress || value || {};
  return {
    nombre: String(email.name || '').trim() || null,
    correo: String(email.address || '').trim() || null,
  };
}

function localDateTime(value) {
  if (!value) return null;
  // Calendar puede devolver siete decimales; Date sólo garantiza milisegundos.
  const raw = String(value).replace(/(\.\d{3})\d+/, '$1');
  const zoned = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? raw : `${raw.replace(/Z$/i, '')}-05:00`;
  const date = new Date(zoned);
  if (!Number.isFinite(date.getTime())) return raw;
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function htmlToText(value) {
  return decodeEntities(String(value || '')
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function boundedText(value, max = MAX_MAIL_BODY_CHARS) {
  const text = String(value || '');
  if (text.length <= max) return { texto: text, truncado: false };
  return {
    texto: `${text.slice(0, max)}\n\n[Contenido truncado por longitud]`,
    truncado: true,
  };
}

function messageSummary(message) {
  return {
    id: message?.id || null,
    asunto: message?.subject || '(sin asunto)',
    de: recipient(message?.from),
    fecha: localDateTime(message?.receivedDateTime || message?.sentDateTime || message?.dateTime),
    leido: typeof message?.isRead === 'boolean' ? message.isRead : null,
    tiene_adjuntos: typeof message?.hasAttachments === 'boolean' ? message.hasAttachments : null,
    preview: String(message?.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

function escapeSearch(value) {
  return String(value || '').replace(/["\\]/g, (char) => `\\${char}`).slice(0, 200);
}

function escapeOData(value) {
  return String(value || '').replace(/'/g, "''").slice(0, 200);
}

async function searchMailDirect(username, { busqueda, de, no_leidos, limite }) {
  const qs = new URLSearchParams({
    $top: String(limite),
    $select: 'id,subject,from,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview',
  });
  const search = [];
  if (busqueda) search.push(`"${escapeSearch(busqueda)}"`);
  if (de) search.push(`from:"${escapeSearch(de)}"`);
  if (search.length) qs.set('$search', search.join(' AND '));
  if (no_leidos === true) qs.set('$filter', 'isRead eq false');
  if (!search.length) qs.set('$orderby', 'receivedDateTime desc');

  const data = await graphJson(username, `/me/messages?${qs.toString()}`, { area: 'correo' });
  if (!Array.isArray(data?.value)) throw toolError('Microsoft Graph devolvió una lista de correo inválida.');
  return data.value.slice(0, limite).map(messageSummary);
}

async function searchMail(owner, params) {
  try {
    return await searchMailDirect(owner, params);
  } catch (err) {
    // La muestra existente es un respaldo útil sólo para el caso simple; no se
    // usa con filtros porque no conserva suficientes campos para aplicarlos bien.
    if (params.busqueda || params.de || params.no_leidos || err?.status !== 400) throw err;
    const sample = await fetchMailSample(owner, { maxMessages: Math.max(12, params.limite) });
    if (!sample?.ok) throw toolError(sample?.message || 'No se pudo consultar el correo de Microsoft.');
    return [...sample.messages]
      .sort((a, b) => new Date(b?.dateTime || 0) - new Date(a?.dateTime || 0))
      .slice(0, params.limite)
      .map(messageSummary);
  }
}

function emailRecipients(addresses) {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

function bogotaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function rangeBoundary(value, fallbackDay) {
  const normalized = String(value || '').trim().toLowerCase();
  const today = bogotaDateParts();
  if (!normalized) return `${fallbackDay}T00:00:00-05:00`;
  if (normalized === 'hoy') return `${today}T00:00:00-05:00`;
  if (normalized === 'mañana' || normalized === 'manana') return `${addDays(today, 1)}T00:00:00-05:00`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return `${normalized}T00:00:00-05:00`;
  const graphValue = normalized
    .replace(/^(\d{4}-\d{2}-\d{2})t/, '$1T')
    .replace(/z$/, 'Z');
  const parsed = new Date(graphValue);
  if (!Number.isFinite(parsed.getTime())) {
    throw toolError('La fecha no es válida. Usá ISO 8601, "hoy" o "mañana".');
  }
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(graphValue)) return graphValue;
  return /T\d\d:\d\d/.test(graphValue) ? `${graphValue}-05:00` : graphValue;
}

function calendarError(err) {
  const message = String(err?.message || '');
  if (/Graph 401:/i.test(message)) return graphFailure(401, 'calendario');
  if (/Graph 403:/i.test(message)) return graphFailure(403, 'calendario');
  if (/no está conectado|sin conexión/i.test(message)) {
    return toolError('Microsoft no está conectado para vos: conectalo en ⚙ Sistema → Conexiones.');
  }
  return toolError('No se pudo completar la operación de calendario con Microsoft 365.');
}

function eventSummary(event) {
  return {
    id: event?.id || null,
    asunto: event?.subject || '(sin asunto)',
    inicio: localDateTime(event?.start?.dateTime),
    fin: localDateTime(event?.end?.dateTime),
    zona_horaria: TIME_ZONE,
    organizador: recipient(event?.organizer),
    asistentes: (event?.attendees || []).map((item) => ({
      ...recipient(item),
      tipo: item?.type || null,
      respuesta: item?.status?.response || null,
    })),
    online: Boolean(event?.isOnlineMeeting || event?.onlineMeeting),
  };
}

function encodedPath(value) {
  return String(value || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function isTextFile(metadata) {
  const mime = String(metadata?.file?.mimeType || '').toLowerCase();
  const name = String(metadata?.name || '').toLowerCase();
  return mime.startsWith('text/')
    || ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mime)
    || /\.(?:txt|md|markdown|csv|json|xml|ya?ml|log)$/i.test(name);
}

async function readLimitedText(res) {
  if (!res.body?.getReader) {
    const text = await res.text();
    const limited = boundedText(text, MAX_TEXT_FILE_BYTES);
    return { contenido: limited.texto, truncado: limited.truncado };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_TEXT_FILE_BYTES - bytes;
    if (value.byteLength > remaining) {
      output += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
      truncated = true;
      await reader.cancel();
      break;
    }
    bytes += value.byteLength;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  if (truncated) output += '\n\n[Contenido truncado por longitud]';
  return { contenido: output, truncado: truncated };
}

async function downloadText(username, path) {
  let res = await graphFetch(username, path, { area: 'archivos', redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location || !location.startsWith('https://')) throw toolError('Microsoft Graph devolvió una descarga de archivo inválida.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    try {
      // La URL firmada ya autoriza la descarga; omitir Authorization impide que
      // el token de Graph viaje a un host de almacenamiento distinto.
      res = await fetch(location, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') throw toolError('La descarga del archivo agotó el tiempo de espera.');
      throw toolError('No se pudo descargar el archivo desde Microsoft 365.');
    } finally {
      clearTimeout(timer);
    }
  }
  if (!res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(await res.text()); } catch { parsed = null; }
    throw graphFailure(res.status, 'archivos', parsed);
  }
  return readLimitedText(res);
}

export function createMicrosoftToolServer(username) {
  const owner = String(username || '').trim();
  if (!owner) return null;

  const correoBuscar = tool(
    'ms_correo_buscar',
    'Busca correo de la cuenta Microsoft 365 de la persona y devuelve una lista acotada con ID, asunto, remitente, fecha, estado de lectura, adjuntos y preview.',
    {
      busqueda: z.string().optional(),
      de: z.string().optional(),
      no_leidos: z.boolean().optional(),
      limite: z.number().int().min(1).max(50).default(15),
    },
    async ({ busqueda, de, no_leidos, limite }) => {
      try {
        return textResult(await searchMail(owner, {
          busqueda: String(busqueda || '').trim(),
          de: String(de || '').trim(),
          no_leidos,
          limite: clampLimit(limite, 15, 50),
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const correoLeer = tool(
    'ms_correo_leer',
    'Lee un correo por ID y devuelve su cuerpo en texto legible, destinatarios, CC, fecha y nombres de adjuntos; los cuerpos excepcionalmente largos se truncan de forma explícita.',
    { id: z.string().min(1) },
    async ({ id }) => {
      try {
        const safeId = encodeURIComponent(id);
        const qs = new URLSearchParams({
          $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime',
          $expand: 'attachments($select=name)',
        });
        const message = await graphJson(owner, `/me/messages/${safeId}?${qs.toString()}`, { area: 'correo' });
        const bodies = await fetchMailBodies(owner, [{ id: message.id }], { limit: 1 });
        if (!bodies?.ok) throw toolError(bodies?.message || 'No se pudo leer el cuerpo del correo.');
        const body = bodies.messages?.[0]?.body || {};
        const plain = String(body.contentType || '').toLowerCase() === 'html'
          ? htmlToText(body.content)
          : String(body.content || '').trim();
        const sourceText = body.truncated === true
          ? `${plain}\n\n[Contenido truncado por longitud]`
          : plain;
        const limited = boundedText(sourceText);
        return textResult({
          id: message.id,
          asunto: message.subject || '(sin asunto)',
          de: recipient(message.from),
          para: (message.toRecipients || []).map(recipient),
          cc: (message.ccRecipients || []).map(recipient),
          fecha: localDateTime(message.receivedDateTime || message.sentDateTime),
          adjuntos: (message.attachments || []).map((item) => item?.name).filter(Boolean).slice(0, 50),
          cuerpo: limited.texto,
          cuerpo_truncado: limited.truncado || body.truncated === true,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const correoEnviar = tool(
    'ms_correo_enviar',
    'ENVÍA un correo real desde la cuenta Microsoft 365 de la persona. Usar sólo cuando la persona lo pidió explícitamente; devuelve confirmación y destinatarios.',
    {
      para: z.array(z.string().email()).min(1).max(50),
      asunto: z.string().min(1).max(500),
      cuerpo: z.string().min(1),
      cc: z.array(z.string().email()).max(50).optional(),
      cco: z.array(z.string().email()).max(50).optional(),
    },
    async ({ para, asunto, cuerpo, cc = [], cco = [] }) => {
      try {
        await graphJson(owner, '/me/sendMail', {
          area: 'envío de correo',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              subject: asunto,
              body: { contentType: 'Text', content: cuerpo },
              toRecipients: emailRecipients(para),
              ccRecipients: emailRecipients(cc),
              bccRecipients: emailRecipients(cco),
            },
            saveToSentItems: true,
          }),
        });
        return textResult({ enviado: true, para, cc, cco, asunto });
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const correoResponder = tool(
    'ms_correo_responder',
    'ENVÍA una respuesta real a un correo desde Microsoft 365. Usar sólo cuando la persona lo pidió explícitamente; puede responder sólo al remitente o a todos.',
    {
      id: z.string().min(1),
      cuerpo: z.string().min(1),
      responder_a_todos: z.boolean().optional(),
    },
    async ({ id, cuerpo, responder_a_todos }) => {
      try {
        const action = responder_a_todos === true ? 'replyAll' : 'reply';
        await graphJson(owner, `/me/messages/${encodeURIComponent(id)}/${action}`, {
          area: 'respuesta de correo',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ comment: cuerpo }),
        });
        return textResult({ enviado: true, id, respuesta_a_todos: responder_a_todos === true });
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const calendarioAgenda = tool(
    'ms_calendario_agenda',
    'Lista una agenda acotada de Microsoft 365 en hora de Bogotá con asunto, organizador, asistentes y modalidad online. Por defecto consulta desde hoy hasta siete días.',
    {
      desde: z.string().optional(),
      hasta: z.string().optional(),
      limite: z.number().int().min(1).max(50).default(25),
    },
    async ({ desde, hasta, limite }) => {
      try {
        const today = bogotaDateParts();
        const from = rangeBoundary(desde, today);
        const to = rangeBoundary(hasta, addDays(today, 7));
        if (new Date(to) <= new Date(from)) throw toolError('El final de la agenda debe ser posterior al inicio.');
        let events;
        try {
          events = await listEvents(owner, { from, to, timeZone: TIME_ZONE, top: clampLimit(limite, 25, 50) });
        } catch (err) {
          throw calendarError(err);
        }
        return textResult(events.slice(0, clampLimit(limite, 25, 50)).map(eventSummary));
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const calendarioCrear = tool(
    'ms_calendario_crear',
    'Crea un evento real en el calendario Microsoft 365 de la persona, opcionalmente con asistentes y reunión online, y devuelve la confirmación en hora de Bogotá.',
    {
      titulo: z.string().min(1).max(500),
      inicio: z.string().min(1),
      fin: z.string().min(1),
      asistentes: z.array(z.string().email()).max(50).optional(),
      descripcion: z.string().optional(),
      online: z.boolean().optional(),
    },
    async ({ titulo, inicio, fin, asistentes = [], descripcion, online }) => {
      try {
        if (new Date(inicio) >= new Date(fin)) throw toolError('El fin del evento debe ser posterior al inicio.');
        let event;
        try {
          event = await createEvent(owner, {
            subject: titulo,
            start: inicio,
            end: fin,
            timeZone: TIME_ZONE,
            bodyHtml: descripcion ? escapeHtml(descripcion).replace(/\n/g, '<br>') : null,
          });
        } catch (err) {
          throw calendarError(err);
        }
        if (asistentes.length || online === true) {
          event = await graphJson(owner, `/me/events/${encodeURIComponent(event.id)}`, {
            area: 'calendario',
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...(asistentes.length ? { attendees: asistentes.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
              ...(online === true ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
            }),
          });
        }
        return textResult({ creado: true, evento: eventSummary(event) });
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const archivosBuscar = tool(
    'ms_archivos_buscar',
    'Busca archivos en el OneDrive de la persona y devuelve una lista acotada con ID, nombre, ruta, tamaño y fecha de modificación.',
    {
      busqueda: z.string().min(1).max(200),
      limite: z.number().int().min(1).max(50).default(15),
    },
    async ({ busqueda, limite }) => {
      try {
        const max = clampLimit(limite, 15, 50);
        const term = encodeURIComponent(escapeOData(busqueda)).replace(/'/g, '%27');
        const qs = new URLSearchParams({
          $top: String(max),
          $select: 'id,name,size,lastModifiedDateTime,parentReference,file,folder',
        });
        const data = await graphJson(owner, `/me/drive/root/search(q='${term}')?${qs.toString()}`, { area: 'archivos' });
        if (!Array.isArray(data?.value)) throw toolError('Microsoft Graph devolvió una lista de archivos inválida.');
        return textResult(data.value.slice(0, max).map((item) => ({
          id: item?.id || null,
          nombre: item?.name || null,
          ruta: [item?.parentReference?.path?.replace(/^\/drive\/root:?/, '') || '', item?.name || ''].join('/').replace(/\/{2,}/g, '/'),
          tamaño: item?.size ?? null,
          fecha: localDateTime(item?.lastModifiedDateTime),
          tipo: item?.folder ? 'carpeta' : item?.file?.mimeType || 'archivo',
        })));
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const archivosLeer = tool(
    'ms_archivos_leer',
    'Lee por ID o ruta un archivo textual de OneDrive. Para PDF, imágenes y Office devuelve sólo metadatos y aclara que todavía no puede convertir ese binario a texto.',
    {
      id: z.string().min(1).optional(),
      ruta: z.string().min(1).optional(),
    },
    async ({ id, ruta }) => {
      try {
        if (!id && !ruta) throw toolError('Indicá el ID o la ruta del archivo que querés leer.');
        const itemPath = id
          ? `/me/drive/items/${encodeURIComponent(id)}`
          : `/me/drive/root:/${encodedPath(ruta)}`;
        const qs = new URLSearchParams({ $select: 'id,name,size,lastModifiedDateTime,parentReference,file,folder' });
        const metadata = await graphJson(owner, `${itemPath}?${qs.toString()}`, { area: 'archivos' });
        const result = {
          id: metadata?.id || null,
          nombre: metadata?.name || null,
          tamaño: metadata?.size ?? null,
          fecha: localDateTime(metadata?.lastModifiedDateTime),
          tipo: metadata?.folder ? 'carpeta' : metadata?.file?.mimeType || 'desconocido',
        };
        if (metadata?.folder) {
          return textResult({
            ...result,
            legible_como_texto: false,
            mensaje: 'La ruta corresponde a una carpeta, no a un archivo de texto.',
          });
        }
        if (!isTextFile(metadata)) {
          return textResult({
            ...result,
            legible_como_texto: false,
            mensaje: 'Este tipo binario (PDF, imagen u Office) todavía no se puede leer como texto.',
          });
        }
        const contentPath = id
          ? `/me/drive/items/${encodeURIComponent(id)}/content`
          : `/me/drive/root:/${encodedPath(ruta)}:/content`;
        return textResult({ ...result, legible_como_texto: true, ...await downloadText(owner, contentPath) });
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const contactosBuscar = tool(
    'ms_contactos_buscar',
    'Busca contactos de Microsoft 365 por nombre o correo y devuelve una lista acotada con nombre, correos y empresa.',
    {
      busqueda: z.string().min(1).max(200),
      limite: z.number().int().min(1).max(50).default(15),
    },
    async ({ busqueda, limite }) => {
      try {
        const max = clampLimit(limite, 15, 50);
        const filter = `contains(displayName,'${escapeOData(busqueda)}') or emailAddresses/any(a:contains(a/address,'${escapeOData(busqueda)}'))`;
        const qs = new URLSearchParams({
          $top: String(max),
          $select: 'id,displayName,emailAddresses,companyName',
          $filter: filter,
        });
        let data;
        try {
          data = await graphJson(owner, `/me/contacts?${qs.toString()}`, { area: 'contactos' });
        } catch (err) {
          if (err?.status !== 400) throw err;
          // Algunos tenants no admiten `contains` sobre la colección de mails;
          // el fallback sigue acotado y filtra localmente sin descargar la agenda.
          const fallback = new URLSearchParams({
            $top: '100',
            $select: 'id,displayName,emailAddresses,companyName',
          });
          data = await graphJson(owner, `/me/contacts?${fallback.toString()}`, { area: 'contactos' });
          const needle = String(busqueda).toLocaleLowerCase('es');
          data.value = (data.value || []).filter((contact) => (
            String(contact?.displayName || '').toLocaleLowerCase('es').includes(needle)
            || (contact?.emailAddresses || []).some((email) => String(email?.address || '').toLocaleLowerCase('es').includes(needle))
          ));
        }
        if (!Array.isArray(data?.value)) throw toolError('Microsoft Graph devolvió una lista de contactos inválida.');
        return textResult(data.value.slice(0, max).map((contact) => ({
          nombre: contact?.displayName || null,
          correos: (contact?.emailAddresses || []).map((email) => email?.address).filter(Boolean),
          empresa: contact?.companyName || null,
        })));
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  return createSdkMcpServer({
    name: 'microsoft',
    version: '1.0.0',
    tools: [
      correoBuscar,
      correoLeer,
      correoEnviar,
      correoResponder,
      calendarioAgenda,
      calendarioCrear,
      archivosBuscar,
      archivosLeer,
      contactosBuscar,
    ],
  });
}
