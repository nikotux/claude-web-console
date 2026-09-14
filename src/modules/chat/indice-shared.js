// modules/chat/indice-shared.js — destilación IA del Índice de una conversación.
// Compartido entre el server (snapshot incremental + spawn detached) y el runner.
// El modelo recibe el texto ya condensado en el prompt y no necesita herramientas.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { resolveDataDir } from '../../core/data-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'bin', 'cwc-indice-runner.js');
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const INDICE_TIMEOUT_MS = 4 * 60 * 1000;
export const INDICE_HEARTBEAT_MS = 5000;
export const INDICE_LOCK_FRESH_MS = 30000;
export const INDICE_AUTO_AGENT_RESPONSES = 10;
const MAX_CONTEXT = 120 * 1000;
const MAX_EVENT_TEXT = 6000;
const MAX_NEW_MOMENTS = 30;
const KINDS = new Set(['decision', 'tema', 'hallazgo', 'entrega', 'bloqueo']);

// El server conoce al dueño del chat e inyecta su data-dir. En el runner el
// resolver queda vacío y resolveDataDir() honra el CWC_DATA_DIR de su env aislado.
let indiceDataDirResolver = null;
export function setIndiceDataDirResolver(fn) {
  indiceDataDirResolver = typeof fn === 'function' ? fn : null;
}
function validId(chatId) { return ID_RE.test(String(chatId || '')); }
function dataDirForChat(chatId) {
  if (indiceDataDirResolver) {
    try {
      const dir = indiceDataDirResolver(chatId);
      if (dir && typeof dir === 'string') return dir;
    } catch { /* un resolver roto no debe cruzar al espacio de otro usuario */ }
  }
  return resolveDataDir();
}
export function indiceDirFor(chatId) {
  return validId(chatId) ? path.join(dataDirForChat(chatId), 'chat-indices') : null;
}
function statePath(chatId) { return path.join(indiceDirFor(chatId), `${chatId}.json`); }
function jobPath(chatId) { return path.join(indiceDirFor(chatId), '_jobs', `${chatId}.json`); }
function lockPath(chatId) { return path.join(indiceDirFor(chatId), '_locks', `${chatId}.json`); }
function logPath(chatId) { return path.join(indiceDirFor(chatId), 'indice.log'); }
function ensureDirs(chatId) {
  const dir = indiceDirFor(chatId);
  if (!dir) throw new Error('Id de conversación inválido.');
  fs.mkdirSync(path.join(dir, '_jobs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, '_locks'), { recursive: true, mode: 0o700 });
  return dir;
}

export function readIndiceState(chatId) {
  if (!validId(chatId)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath(chatId), 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch { return null; }
}

export function writeIndiceState(chatId, state) {
  ensureDirs(chatId);
  const moments = Array.isArray(state?.moments) ? state.moments : [];
  writeJsonAtomic(statePath(chatId), {
    chatId: String(chatId),
    status: ['ready', 'running', 'stale', 'error'].includes(state?.status) ? state.status : 'error',
    generatedAt: Number.isFinite(state?.generatedAt) ? state.generatedAt : 0,
    upToEvent: Number.isInteger(state?.upToEvent) ? state.upToEvent : -1,
    error: state?.error == null ? null : String(state.error).slice(0, 300),
    moments,
  });
}

export function readIndiceJob(chatId) {
  if (!validId(chatId)) return null;
  try { return JSON.parse(fs.readFileSync(jobPath(chatId), 'utf8')); }
  catch { return null; }
}
export function writeIndiceJob(chatId, job) {
  ensureDirs(chatId);
  writeJsonAtomic(jobPath(chatId), job);
}

function rawLock(chatId) {
  if (!validId(chatId)) return null;
  try { return JSON.parse(fs.readFileSync(lockPath(chatId), 'utf8')); }
  catch { return null; }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}
export function readIndiceLock(chatId) {
  const lock = rawLock(chatId);
  if (!lock || !lock.token || !Number.isFinite(lock.ts)) return null;
  if (Date.now() - lock.ts >= INDICE_LOCK_FRESH_MS) return null;
  if (lock.pid && !pidAlive(lock.pid)) return null;
  return lock;
}
export function isIndiceRunning(chatId) { return !!readIndiceLock(chatId); }

export function writeIndiceLock(chatId, state) {
  ensureDirs(chatId);
  writeJsonAtomic(lockPath(chatId), { ...state, ts: Date.now() });
}
export function clearIndiceLock(chatId, token) {
  try {
    const lock = rawLock(chatId);
    if (!lock || lock.token !== token) return;
    fs.unlinkSync(lockPath(chatId));
  } catch { /* noop */ }
}

// Reserva cross-process con O_EXCL. Un lock fresco bloquea; uno huérfano o con
// heartbeat vencido se reemplaza. El token permite que sólo su dueño lo refresque
// o libere, incluso si dos procesos server se solapan durante un reinicio.
function reserveIndiceLock(chatId) {
  ensureDirs(chatId);
  const file = lockPath(chatId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: 0, token, ts: Date.now() }));
      fs.closeSync(fd);
      return token;
    } catch (err) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
      if (err?.code !== 'EEXIST') throw err;
      if (readIndiceLock(chatId)) return null;
      const stale = rawLock(chatId);
      try {
        const current = rawLock(chatId);
        if (current?.token === stale?.token && current?.ts === stale?.ts) fs.unlinkSync(file);
      } catch { /* otro proceso ganó la carrera; reintentar */ }
    }
  }
  return null;
}

function cleanText(value, max = MAX_EVENT_TEXT) {
  const text = String(value ?? '').replace(/\r/g, '').trim();
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  return `${text.slice(0, head)}\n…[evento recortado]…\n${text.slice(-(max - head))}`;
}

function eventEntry(event, eventIndex) {
  const type = String(event?.type || '');
  let speaker = '';
  let text = '';
  if (type === 'user') { speaker = 'USUARIO'; text = event?.text; }
  else if (type === 'assistant') { speaker = 'AGENTE'; text = event?.text; }
  else if (type === 'say') { speaker = `PARTICIPANTE ${event?.by || ''}`.trim(); text = event?.text; }
  else if (type === 'tool_use') { speaker = 'HERRAMIENTA'; text = event?.summary || event?.name; }
  else if (type === 'error') { speaker = 'ERROR'; text = event?.message; }
  else return null;
  const clean = cleanText(text);
  return clean ? { eventIndex, text: `[evento ${eventIndex}] ${speaker}: ${clean}` } : null;
}

// Produce un tramo CONTIGUO. Si alcanza el presupuesto, deja el resto para la
// corrida incremental siguiente en vez de saltarlo y marcarlo como procesado.
export function buildIndiceJob({ chatId, title = '', events = [], fromEvent = 0, existingMoments = [] } = {}) {
  const start = Math.max(0, Number.isInteger(fromEvent) ? fromEvent : 0);
  const entries = [];
  let chars = 0;
  let upToEvent = start - 1;
  for (let i = start; i < events.length; i += 1) {
    const entry = eventEntry(events[i], i);
    if (entry && entries.length && chars + entry.text.length + 1 > MAX_CONTEXT) break;
    if (entry) {
      entries.push(entry);
      chars += entry.text.length + 1;
    }
    upToEvent = i;
  }
  if (upToEvent < start) return null;
  return {
    chatId: String(chatId),
    title: cleanText(title, 120),
    fromEvent: start,
    upToEvent,
    observedUpToEvent: events.length - 1,
    events: entries,
    existingMoments: (Array.isArray(existingMoments) ? existingMoments : []).slice(-30),
    createdAt: Date.now(),
  };
}

export function countAgentResponses(events, fromEvent = 0) {
  let results = 0;
  let replies = 0;
  let replySeen = false;
  for (let i = Math.max(0, fromEvent); i < events.length; i += 1) {
    const event = events[i];
    if (event?.type === 'result') results += 1; // historial vivo: una por turno
    if (event?.type === 'user') replySeen = false;
    if (event?.type === 'assistant' && String(event?.text || '').trim() && !replySeen) {
      replies += 1;
      replySeen = true; // tools/textos adicionales del mismo turno no duplican
    }
  }
  // El replay desde transcript no conserva `result`; ahí usamos un bloque de
  // respuesta por turno de usuario como aproximación equivalente.
  return results || replies;
}

function staleState(chatId, current, lastEvent) {
  if (!current) return null;
  const next = { ...current, status: 'stale', error: null };
  if (current.status !== 'stale' || current.error != null) writeIndiceState(chatId, next);
  return next;
}

function noteActivityDuringRun(chatId, lastEvent) {
  const job = readIndiceJob(chatId);
  if (!job || !Number.isInteger(lastEvent) || lastEvent <= Number(job.observedUpToEvent ?? -1)) return;
  writeIndiceJob(chatId, { ...job, observedUpToEvent: lastEvent });
}

// Encola desde el server: snapshot en disco primero, luego runner detached. La
// query del modelo jamás corre en el proceso web. `force` procesa cualquier
// tramo nuevo; el automático espera aproximadamente diez respuestas del agente.
export function queueIndiceDistill({ chatId, title, events, env, force = false } = {}) {
  if (!validId(chatId) || !Array.isArray(events)) throw new Error('Conversación inválida para el Índice.');
  const current = readIndiceState(chatId);
  const lastEvent = events.length - 1;
  if (isIndiceRunning(chatId)) {
    noteActivityDuringRun(chatId, lastEvent);
    return { started: false, state: current || { status: 'running', moments: [] } };
  }

  const fromEvent = Number.isInteger(current?.upToEvent) ? current.upToEvent + 1 : 0;
  if (fromEvent > lastEvent) {
    if (current?.status === 'running') {
      const ready = { ...current, status: 'ready', error: null };
      writeIndiceState(chatId, ready);
      return { started: false, state: ready };
    }
    return { started: false, state: current };
  }
  if (!force && countAgentResponses(events, fromEvent) < INDICE_AUTO_AGENT_RESPONSES) {
    return { started: false, state: staleState(chatId, current, lastEvent) };
  }

  const token = reserveIndiceLock(chatId);
  if (!token) return { started: false, state: current || { status: 'running', moments: [] } };
  const job = buildIndiceJob({
    chatId, title, events, fromEvent,
    existingMoments: current?.moments || [],
  });
  if (!job) {
    clearIndiceLock(chatId, token);
    return { started: false, state: current };
  }

  const running = {
    chatId: String(chatId),
    status: 'running',
    generatedAt: Number.isFinite(current?.generatedAt) ? current.generatedAt : 0,
    upToEvent: Number.isInteger(current?.upToEvent) ? current.upToEvent : -1,
    error: null,
    moments: Array.isArray(current?.moments) ? current.moments : [],
  };
  writeIndiceJob(chatId, job);
  writeIndiceState(chatId, running);

  const logFile = logPath(chatId);
  let logFd;
  try {
    logFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [RUNNER, chatId, token], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: typeof env === 'function' ? env() : env,
    });
    writeIndiceLock(chatId, { pid: child.pid, token });
    child.on('error', (err) => {
      try {
        const state = readIndiceState(chatId) || running;
        writeIndiceState(chatId, { ...state, status: 'error', error: 'No se pudo iniciar el runner del Índice.' });
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] spawn FAIL ${chatId}: ${err?.message || err}\n`);
      } catch { /* noop */ }
      clearIndiceLock(chatId, token);
    });
    child.unref();
    fs.closeSync(logFd);
    return { started: true, state: running };
  } catch (err) {
    if (logFd !== undefined) try { fs.closeSync(logFd); } catch { /* noop */ }
    clearIndiceLock(chatId, token);
    writeIndiceState(chatId, { ...running, status: 'error', error: 'No se pudo iniciar el runner del Índice.' });
    throw err;
  }
}

export function reconcileIndiceState(chatId, lastEvent = null) {
  const state = readIndiceState(chatId);
  if (!state) return null;
  if (state.status === 'running') {
    if (isIndiceRunning(chatId)) return state;
    const interrupted = { ...state, status: 'error', error: 'La destilación se interrumpió; podés reintentarla.' };
    writeIndiceState(chatId, interrupted);
    return interrupted;
  }
  if (state.status === 'ready' && Number.isInteger(lastEvent) && lastEvent > Number(state.upToEvent)) {
    const stale = { ...state, status: 'stale', error: null };
    writeIndiceState(chatId, stale);
    return stale;
  }
  return state;
}

// ===== Prompt + parseo: contrato semántico del Índice =====
export function indicePrompt(job) {
  const prior = Array.isArray(job?.existingMoments) && job.existingMoments.length
    ? `\n\nMOMENTOS YA GUARDADOS (no los repitas; solo sirven para evitar duplicados conceptuales):\n${job.existingMoments.map((m) => `- [evento ${m.eventIndex}] [${m.kind}] ${m.title}`).join('\n')}`
    : '';
  const transcript = (job?.events || []).map((event) => event.text).join('\n');
  return `Sos el editor del Índice de una conversación con IA. Vas a leer un TRAMO INCREMENTAL de la conversación "${job?.title || 'Sin título'}". Cada entrada empieza con [evento N], donde N es el índice EXACTO en el array de eventos del historial.${prior}

Tu tarea es destilar MOMENTOS QUE IMPORTAN, no registrar interacciones.

SÍ incluir:
- decisiones tomadas y su porqué;
- cambios de rumbo;
- hallazgos que cambiaron el plan;
- entregas o cosas que quedaron funcionando;
- bloqueos y, cuando conste, lo que los destrabó;
- temas nuevos relevantes que se abrieron.

NO incluir:
- saludos, cortesías ni despedidas;
- confirmaciones como "ok", "dale" o "listo";
- acuses de recibo;
- reportes de progreso sin contenido;
- intenciones futuras como "voy a hacer X";
- cada pregunta/respuesta por separado si pertenecen al mismo momento importante.

Sé MUY selectivo. Una conversación larga completa debería producir del orden de 10 a 25 momentos, no uno por interacción. Este es solo un tramo incremental: devolvé únicamente los momentos NUEVOS y sustantivos que aparezcan acá. Si no hay ninguno, devolvé una lista vacía.

Anclaje obligatorio:
- eventIndex debe ser uno de los índices [evento N] visibles en el tramo y debe apuntar al evento concreto que expresa mejor ese momento;
- no inventes ni aproximes índices;
- si no podés anclar un momento a un evento concreto, NO lo incluyas;
- es mejor un índice corto que uno que lleve al lugar equivocado.

Para cada momento:
- kind: exactamente decision | tema | hallazgo | entrega | bloqueo;
- title: en español, descriptivo, máximo 70 caracteres, sin markdown;
- detail: una sola frase breve de contexto; es opcional y se omite si no aporta.

Respondé ÚNICAMENTE con un bloque \`\`\`json con esta forma exacta, sin texto fuera del bloque:
\`\`\`json
{ "moments": [ { "eventIndex": 12, "kind": "decision", "title": "Título breve", "detail": "Una frase de contexto." } ] }
\`\`\`

=== TRAMO INCREMENTAL (${job?.fromEvent ?? 0}–${job?.upToEvent ?? -1}) ===
${transcript}`;
}

function cleanTitle(value) {
  return String(value ?? '')
    .replace(/\r|\n/g, ' ')
    .replace(/[*_`#~]/g, '')
    .replace(/^[-–—•]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}
function cleanDetail(value) {
  return String(value ?? '').replace(/\r|\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function parseIndice(text, allowedEventIndexes = []) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const allowed = new Set(allowedEventIndexes.filter(Number.isInteger));
  const seen = new Set();
  const moments = [];
  for (const moment of Array.isArray(parsed?.moments) ? parsed.moments.slice(0, MAX_NEW_MOMENTS) : []) {
    const eventIndex = Number(moment?.eventIndex);
    const kind = String(moment?.kind || '').toLowerCase();
    const title = cleanTitle(moment?.title);
    if (!Number.isInteger(eventIndex) || !allowed.has(eventIndex) || !KINDS.has(kind) || !title) continue;
    const key = `${eventIndex}:${kind}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = cleanDetail(moment?.detail);
    moments.push({ eventIndex, kind, title, ...(detail ? { detail } : {}) });
  }
  moments.sort((a, b) => a.eventIndex - b.eventIndex);
  return { moments };
}

export function mergeIndiceMoments(existing, additions) {
  const out = [];
  const seen = new Set();
  for (const moment of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(additions) ? additions : [])]) {
    if (!Number.isInteger(moment?.eventIndex) || !KINDS.has(moment?.kind) || !moment?.title) continue;
    const key = `${moment.eventIndex}:${moment.kind}:${String(moment.title).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(moment);
  }
  return out.sort((a, b) => a.eventIndex - b.eventIndex);
}
