// core/microsoft-mail-client.js — cliente directo a Graph Mail con identidad de USUARIO.
//
// El barrido de onboarding usa siempre getAccessToken(username, 'microsoft'):
// no lee, persiste ni conserva tokens por su cuenta. La primera pasada trae
// metadatos; una segunda pasada acotada trae cuerpos solo de los mensajes más
// representativos para dar contexto real al modelo sin agotar su ventana.
import { getAccessToken } from './connections-store.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN = new URL(GRAPH_BASE).origin;
const NETWORK_TIMEOUT_MS = 15_000;
const MAIL_MONTHS = 6;
const PAGE_SIZE = 50;

// Ochenta cuerpos conservan una muestra útil sin acercarse a los ~190k tokens
// que ocuparían los 240 mensajes completos y que dejarían poco margen al chat.
const DEFAULT_MAIL_BODY_LIMIT = 80;
// Un hilo reenviado puede ser enorme: 6000 caracteres por mensaje limita el
// peor caso a ~120k tokens entre 80 cuerpos y reparte el presupuesto entre ellos.
const MAX_MAIL_BODY_CHARS = 6_000;

// Tope global deliberadamente chico: 20 mensajes por cada combinación de
// mes × dirección (6 × recibidos/enviados = 12 estratos, 240 en total). Así
// una bandeja con decenas de miles no se descarga completa y cada tramo del
// semestre pesa igual, en vez de sesgar el retrato hacia los últimos días.
const MAX_MAIL_MESSAGES = 240;
const MAIL_FIELDS = [
  'id',
  'subject',
  'bodyPreview',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
].join(',');

function failure(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.trunc(number), max));
}

function retryAfterSeconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function graphFailure(status, headers) {
  if (status === 401) {
    return failure('unauthorized', 'La conexión de Microsoft no está autorizada. Reconectala en ⚙ Sistema → Conexiones.', { status });
  }
  if (status === 403) {
    return failure('missing-scope', 'Falta el permiso Mail.Read. Reconectá Microsoft cuando la consola incorpore ese permiso.', { status });
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds(headers.get('retry-after'));
    // No se reintenta acá: el caller recibe cuándo puede volver a programar
    // el barrido, evitando tanto ignorar Retry-After como entrar en un loop.
    return failure('rate-limited', 'Microsoft Graph limitó temporalmente las consultas de correo.', {
      status,
      retryAfterSeconds: retryAfter,
    });
  }
  if (status >= 500) {
    return failure('network', 'Microsoft Graph no está disponible temporalmente.', { status });
  }
  return failure('unknown', `Microsoft Graph rechazó la consulta de correo (HTTP ${status}).`, { status });
}

function resolveGraphUrl(input) {
  try {
    const raw = String(input);
    const url = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(`${GRAPH_BASE}${raw.startsWith('/') ? '' : '/'}${raw}`);
    if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith('/v1.0/')) return null;
    return url;
  } catch {
    return null;
  }
}

function tokenFailure(err) {
  const networkError = err?.name === 'AbortError'
    || err instanceof TypeError
    || /^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT)$/.test(err?.cause?.code || err?.code || '');
  return networkError
    ? failure('network', 'No se pudo renovar la conexión con Microsoft.')
    : failure('unauthorized', 'Microsoft no está conectado para este usuario. Conectalo en ⚙ Sistema → Conexiones.');
}

async function graphRequest(username, input, { timeoutMs = NETWORK_TIMEOUT_MS, headers = {} } = {}) {
  let token;
  try {
    token = await getAccessToken(username, 'microsoft');
  } catch (err) {
    return tokenFailure(err);
  }
  if (!token) {
    return failure('unauthorized', 'Microsoft no está conectado para este usuario. Conectalo en ⚙ Sistema → Conexiones.');
  }

  const url = resolveGraphUrl(input);
  if (!url) return failure('unknown', 'Microsoft Graph devolvió una URL de paginación inválida.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('authorization', 'Bearer ' + token);
    const res = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!res.ok) return graphFailure(res.status, res.headers);

    let data;
    try {
      data = await res.json();
    } catch {
      return failure('unknown', 'Microsoft Graph devolvió una respuesta de correo inválida.');
    }
    return { ok: true, data };
  } catch (err) {
    const timedOut = controller.signal.aborted || err?.name === 'AbortError';
    return failure('network', timedOut
      ? 'La consulta de correo a Microsoft Graph agotó el tiempo de espera.'
      : 'No se pudo conectar con Microsoft Graph.');
  } finally {
    clearTimeout(timer);
  }
}

function subtractUtcMonthsClamped(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

function monthlyWindows(now) {
  const boundaries = [];
  for (let monthsAgo = MAIL_MONTHS; monthsAgo >= 0; monthsAgo--) {
    boundaries.push(subtractUtcMonthsClamped(now, monthsAgo));
  }
  return boundaries.slice(0, -1).map((from, index) => ({
    from,
    to: boundaries[index + 1],
  }));
}

function distributeLimit(total, slots) {
  const base = Math.floor(total / slots);
  const remainder = total % slots;
  return Array.from({ length: slots }, (_, index) => base + (index < remainder ? 1 : 0));
}

function pageUrl(input, remaining, pageSize) {
  const url = resolveGraphUrl(input);
  if (!url) return null;
  url.searchParams.set('$top', String(Math.min(remaining, pageSize)));
  return url;
}

function normalizeRecipient(recipient) {
  const email = recipient?.emailAddress;
  return {
    name: String(email?.name || '').trim() || null,
    address: String(email?.address || '').trim().toLowerCase() || null,
  };
}

function normalizeMessage(message, direction, dateField) {
  return {
    id: String(message?.id || ''),
    direction,
    dateTime: message?.[dateField] || null,
    subject: String(message?.subject || '').slice(0, 300),
    bodyPreview: String(message?.bodyPreview || '').slice(0, 255),
    from: normalizeRecipient(message?.from),
    toRecipients: Array.isArray(message?.toRecipients) ? message.toRecipients.map(normalizeRecipient) : [],
    ccRecipients: Array.isArray(message?.ccRecipients) ? message.ccRecipients.map(normalizeRecipient) : [],
  };
}

async function fetchWindow(username, { folder, dateField, direction, from, to, limit, pageSize, timeoutMs }) {
  const qs = new URLSearchParams({
    $select: MAIL_FIELDS,
    $filter: `${dateField} ge ${from.toISOString()} and ${dateField} lt ${to.toISOString()}`,
    $orderby: `${dateField} desc`,
  });
  let next = `/me/mailFolders/${folder}/messages?${qs.toString()}`;
  const messages = [];

  while (next && messages.length < limit) {
    const url = pageUrl(next, limit - messages.length, pageSize);
    if (!url) return failure('unknown', 'Microsoft Graph devolvió una URL de paginación inválida.');
    const result = await graphRequest(username, url, { timeoutMs });
    if (!result.ok) return result;
    if (!Array.isArray(result.data?.value)) {
      return failure('unknown', 'Microsoft Graph devolvió una página de correo inválida.');
    }

    for (const message of result.data.value) {
      if (messages.length >= limit) break;
      messages.push(normalizeMessage(message, direction, dateField));
    }
    next = result.data['@odata.nextLink'] || '';
  }

  return { ok: true, messages };
}

export async function fetchMailSample(username, options = {}) {
  options = options && typeof options === 'object' ? options : {};
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) return failure('unknown', 'La fecha de referencia para el barrido no es válida.');

  const timeoutMs = clampInteger(options.timeoutMs, NETWORK_TIMEOUT_MS, 1_000, 60_000);
  const pageSize = clampInteger(options.pageSize, PAGE_SIZE, 1, 100);
  // Menos de 12 impediría reservar al menos un mensaje para cada estrato.
  const maxMessages = clampInteger(options.maxMessages, MAX_MAIL_MESSAGES, 12, MAX_MAIL_MESSAGES);
  const windows = monthlyWindows(now);
  const strata = windows.flatMap((window) => [
    { ...window, folder: 'inbox', dateField: 'receivedDateTime', direction: 'received' },
    { ...window, folder: 'sentitems', dateField: 'sentDateTime', direction: 'sent' },
  ]);
  const limits = distributeLimit(maxMessages, strata.length);
  const messages = [];
  const buckets = windows.map(({ from, to }) => ({
    from: from.toISOString(),
    to: to.toISOString(),
    received: 0,
    sent: 0,
  }));

  for (let index = 0; index < strata.length; index++) {
    const stratum = strata[index];
    const result = await fetchWindow(username, {
      ...stratum,
      limit: limits[index],
      pageSize,
      timeoutMs,
    });
    if (!result.ok) return result;
    messages.push(...result.messages);
    buckets[Math.floor(index / 2)][stratum.direction] = result.messages.length;
  }

  return {
    ok: true,
    range: {
      from: windows[0].from.toISOString(),
      to: now.toISOString(),
    },
    maxMessages,
    count: messages.length,
    sampling: { months: MAIL_MONTHS, strategy: 'monthly-direction-strata', buckets },
    messages,
  };
}

function representativePeerKeys(message) {
  const peers = message?.direction === 'sent'
    ? [...(message?.toRecipients || []), ...(message?.ccRecipients || [])]
    : [message?.from];
  const keys = new Set();
  for (const peer of peers) {
    const address = String(peer?.address || '').trim().toLowerCase();
    const name = String(peer?.name || '').trim().toLowerCase();
    const key = address || (name ? `name:${name}` : '');
    if (key) keys.add(key);
  }
  return [...keys];
}

function representativeMonth(message) {
  const date = new Date(message?.dateTime);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : 'sin-fecha';
}

// Dentro de cada estrato mes × dirección se intercalan colas por interlocutor:
// primero aparece cada contacto disponible y después la frecuencia global le
// da más turnos a quienes más participan. Luego se toma un mensaje por vuelta
// de cada estrato, conservando parejas la cobertura temporal y las direcciones.
// Los desempates usan datos estables (interlocutor, fecha, id y asunto), sin
// azar, por lo que la misma entrada produce la misma salida.
export function selectRepresentative(messages, limit) {
  if (!Array.isArray(messages)) return [];
  const requested = Number(limit);
  const target = Number.isFinite(requested)
    ? Math.min(messages.length, Math.max(0, Math.trunc(requested)))
    : 0;
  if (!target) return [];

  const peerFrequency = new Map();
  for (const message of messages) {
    for (const key of representativePeerKeys(message)) {
      peerFrequency.set(key, (peerFrequency.get(key) || 0) + 1);
    }
  }

  const buckets = new Map();
  messages.forEach((message, index) => {
    const direction = message?.direction === 'sent' ? 'sent' : 'received';
    const month = representativeMonth(message);
    const key = `${month}\u0000${direction}`;
    if (!buckets.has(key)) buckets.set(key, { month, direction, messages: [] });
    const peerKeys = representativePeerKeys(message).sort((a, b) => (
      (peerFrequency.get(b) || 0) - (peerFrequency.get(a) || 0)
      || a.localeCompare(b)
    ));
    const frequencies = peerKeys.map((peer) => peerFrequency.get(peer) || 0);
    buckets.get(key).messages.push({
      message,
      index,
      peerKeys,
      primaryFrequency: frequencies.length ? Math.max(...frequencies) : 0,
      totalFrequency: frequencies.reduce((sum, value) => sum + value, 0),
      timestamp: Number.isFinite(new Date(message?.dateTime).getTime())
        ? new Date(message.dateTime).getTime()
        : 0,
    });
  });

  const strata = [...buckets.values()].sort((a, b) => (
    a.month.localeCompare(b.month)
    || a.direction.localeCompare(b.direction)
  ));
  for (const stratum of strata) {
    stratum.messages.sort((a, b) => (
      b.primaryFrequency - a.primaryFrequency
      || b.totalFrequency - a.totalFrequency
      || b.timestamp - a.timestamp
      || String(a.message?.id || '').localeCompare(String(b.message?.id || ''))
      || String(a.message?.subject || '').localeCompare(String(b.message?.subject || ''))
      || a.index - b.index
    ));

    const peerGroups = new Map();
    for (const item of stratum.messages) {
      const keys = item.peerKeys.length ? item.peerKeys : [''];
      for (const key of keys) {
        if (!peerGroups.has(key)) {
          peerGroups.set(key, {
            key,
            weight: key ? peerFrequency.get(key) || 1 : 1,
            represented: 0,
            cursor: 0,
            messages: [],
          });
        }
        peerGroups.get(key).messages.push(item);
      }
    }

    const groups = [...peerGroups.values()].sort((a, b) => (
      b.weight - a.weight || a.key.localeCompare(b.key)
    ));
    const ordered = [];
    const usedIndexes = new Set();
    while (ordered.length < stratum.messages.length) {
      const available = groups.filter((group) => {
        while (usedIndexes.has(group.messages[group.cursor]?.index)) group.cursor++;
        return group.cursor < group.messages.length;
      });
      if (!available.length) break;

      available.sort((a, b) => (
        a.represented * b.weight - b.represented * a.weight
        || b.weight - a.weight
        || a.key.localeCompare(b.key)
      ));
      const chosen = available[0].messages[available[0].cursor++];
      usedIndexes.add(chosen.index);
      ordered.push(chosen);
      const representedKeys = chosen.peerKeys.length ? chosen.peerKeys : [''];
      for (const key of representedKeys) peerGroups.get(key).represented++;
    }
    stratum.messages = ordered;
  }

  const selected = [];
  for (let round = 0; selected.length < target; round++) {
    let added = 0;
    for (const stratum of strata) {
      if (selected.length >= target) break;
      const item = stratum.messages[round];
      if (!item) continue;
      selected.push(item.message);
      added++;
    }
    if (!added) break;
  }
  return selected;
}

export async function fetchMailBodies(username, messages, options = {}) {
  options = options && typeof options === 'object' ? options : {};
  const timeoutMs = clampInteger(options.timeoutMs, NETWORK_TIMEOUT_MS, 1_000, 60_000);
  const limit = clampInteger(options.limit, DEFAULT_MAIL_BODY_LIMIT, 0, DEFAULT_MAIL_BODY_LIMIT);
  const selected = Array.isArray(messages) ? messages.slice(0, limit) : [];
  const enriched = [];

  for (const message of selected) {
    const id = String(message?.id || '').trim();
    if (!id) return failure('unknown', 'La muestra de correo contiene un mensaje sin identificador de Microsoft Graph.');
    const qs = new URLSearchParams({ $select: 'id,body' });
    const result = await graphRequest(username, `/me/messages/${encodeURIComponent(id)}?${qs.toString()}`, {
      timeoutMs,
      headers: { Prefer: 'outlook.body-content-type="text"' },
    });
    if (!result.ok) return result;
    if (!result.data?.body || typeof result.data.body !== 'object') {
      return failure('unknown', 'Microsoft Graph devolvió un cuerpo de correo inválido.');
    }

    const content = String(result.data.body.content || '');
    enriched.push({
      ...message,
      body: {
        contentType: String(result.data.body.contentType || 'text').toLowerCase(),
        content: content.slice(0, MAX_MAIL_BODY_CHARS),
        truncated: content.length > MAX_MAIL_BODY_CHARS,
      },
    });
  }

  return { ok: true, messages: enriched };
}

function emailDomain(address) {
  const value = String(address || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  return at > 0 && at < value.length - 1 ? value.slice(at + 1) : null;
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

function addCount(map, key, initial) {
  if (!key) return null;
  if (!map.has(key)) map.set(key, initial());
  return map.get(key);
}

function normalizeSubject(subject) {
  return String(subject || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(?:(?:re|fw|fwd|rv|enc)\s*:\s*)+/i, '')
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' email ')
    .replace(/\b(?:\d{1,4}[-/.]){1,2}\d{1,4}\b/g, ' fecha ')
    .replace(/\b\d+\b/g, ' # ')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function inferInternalDomain(messages) {
  const candidates = new Map();
  const add = (address) => {
    const domain = emailDomain(address);
    if (domain) candidates.set(domain, (candidates.get(domain) || 0) + 1);
  };

  for (const message of messages) {
    if (message?.direction === 'sent') add(message?.from?.address);
  }
  if (!candidates.size) {
    for (const message of messages) {
      if (message?.direction !== 'received') continue;
      for (const recipient of message?.toRecipients || []) add(recipient?.address);
    }
  }
  return [...candidates.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

export function summarizeMailSample(sample) {
  const messages = Array.isArray(sample) ? sample : Array.isArray(sample?.messages) ? sample.messages : [];
  const volume = new Map();
  const interlocutors = new Map();
  const subjects = new Map();
  const externalDomains = new Map();
  const internalDomain = inferInternalDomain(messages);

  for (const message of messages) {
    const direction = message?.direction === 'sent' ? 'sent' : 'received';
    const date = new Date(message?.dateTime);
    if (Number.isFinite(date.getTime())) {
      const month = date.toISOString().slice(0, 7);
      const item = addCount(volume, month, () => ({ month, received: 0, sent: 0, total: 0 }));
      item[direction]++;
      item.total++;
    }

    const normalizedSubject = normalizeSubject(message?.subject);
    if (normalizedSubject) subjects.set(normalizedSubject, (subjects.get(normalizedSubject) || 0) + 1);

    const peers = direction === 'received'
      ? [message?.from]
      : [...(message?.toRecipients || []), ...(message?.ccRecipients || [])];
    const seenPeople = new Set();
    const seenDomains = new Set();
    for (const peer of peers) {
      const address = String(peer?.address || '').trim().toLowerCase();
      const domain = emailDomain(address);
      const name = cleanName(peer?.name);
      const key = address || (name && domain ? `${name.toLowerCase()}@${domain}` : null);
      if (!key || seenPeople.has(key)) continue;
      seenPeople.add(key);

      const item = addCount(interlocutors, key, () => ({ name, domain, received: 0, sent: 0, messages: 0 }));
      item[direction]++;
      item.messages++;
      if (!item.name && name) item.name = name;

      if (domain && domain !== internalDomain) seenDomains.add(domain);
    }
    for (const domain of seenDomains) {
      externalDomains.set(domain, (externalDomains.get(domain) || 0) + 1);
    }
  }

  const byFrequency = (a, b) => b.messages - a.messages || (a.domain || '').localeCompare(b.domain || '') || (a.name || '').localeCompare(b.name || '');
  return {
    totalMessages: messages.length,
    period: sample?.range || null,
    internalDomain,
    volumeByMonth: [...volume.values()].sort((a, b) => a.month.localeCompare(b.month)),
    topInterlocutors: [...interlocutors.values()].sort(byFrequency).slice(0, 15),
    recurrentSubjects: [...subjects.entries()]
      .filter(([, count]) => count > 1)
      .map(([subject, count]) => ({ subject, count }))
      .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject))
      .slice(0, 12),
    topExternalDomains: [...externalDomains.entries()]
      .map(([domain, messagesCount]) => ({ domain, messages: messagesCount }))
      .sort((a, b) => b.messages - a.messages || a.domain.localeCompare(b.domain))
      .slice(0, 12),
  };
}

export async function mailScopeAvailable(username) {
  const qs = new URLSearchParams({ $select: 'id', $top: '1' });
  const result = await graphRequest(username, `/me/mailFolders/inbox/messages?${qs.toString()}`);
  if (!result.ok) return { ...result, available: false };
  if (!Array.isArray(result.data?.value)) {
    return { ...failure('unknown', 'Microsoft Graph devolvió una respuesta de correo inválida.'), available: false };
  }
  return { ok: true, available: true };
}
