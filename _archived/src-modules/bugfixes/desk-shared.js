// modules/bugfixes/desk-shared.js — lo COMPARTIDO entre el módulo server y el
// runner desacoplado de la consulta a Zoho Desk (bin/cwc-desk-runner.js).
//
// La consulta desk-live pasó de correr INLINE (atada al request HTTP — se
// perdía si cambiabas de pestaña o el server reiniciaba) a un RUNNER DETACHED
// (patrón triage/health, regla 2): la corrida SIGUE aunque cambies de vista o
// el server se reinicie, y el resultado se PERSISTE en disco (sobrevive). El
// front dispara y encuesta, en vez de esperar un fetch largo que el navegador
// móvil puede abortar en background.
//
// SEGURIDAD (regla 6, sub-excepción de LECTURA): la corrida es READ-ONLY
// blindada por DOS capas con la allowlist ESTRICTA de tools desk_* de LECTURA
// (deskReadAllowed): la tool debe (a) NO tener verbo de escritura y (b) SÍ uno
// de lectura. Bash/Edit/Write/git y cualquier desk_* de escritura → denegados.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBugfixes, saveBugfixes, addEvent } from './store.js';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const DESK_DIR = path.join(DATA_DIR, 'desk-live');      // resultado por ticket
export const DESK_LOCK = path.join(DATA_DIR, 'desk.lock');     // heartbeat de la corrida
export const DESK_LOG = path.join(DATA_DIR, 'desk.log');

export const DESK_TIMEOUT_MS = 4 * 60000;   // corte por ticket
export const DESK_TTL_MS = 60000;           // "fresco": no re-consultar si es más nuevo que esto
export const DESK_HEARTBEAT_MS = 3000;
export const DESK_LOCK_FRESH_MS = 20000;    // lock más viejo = runner muerto

// ===== Allowlist ESTRICTA: SOLO tools desk_* de LECTURA (regla 6) =====
const DESK_WRITE_VERB = /(add|create|update|reply|post|delete|remove|close|set|write|send|move|assign|merge|edit|patch|put)/i;
const DESK_READ_VERB = /(get|list|search|view|read|find|fetch|detail|show|info|history|thread|conversation)/i;
export const deskReadAllowed = (name) => {
  const s = String(name);
  if (s === 'TodoWrite') return true; // estado interno del modelo, no toca nada externo
  const m = s.match(/^mcp__[a-z0-9_-]+__desk_([a-z0-9_]+)$/i);
  if (!m) return false;
  const op = m[1];
  return !DESK_WRITE_VERB.test(op) && DESK_READ_VERB.test(op); // deny por defecto
};

export function deskPrompt(ticketNumber) {
  const key = String(ticketNumber);
  return [
    `Necesito el estado ACTUAL del ticket de Zoho Desk #${key}. Es SOLO lectura: no modifiques nada.`,
    '',
    'Con las tools desk_* de LECTURA del MCP:',
    `1. Buscá el ticket #${key} y abrilo.`,
    '2. Leé su estado actual y sus comentarios/hilos más recientes.',
    '',
    'Respondé ÚNICAMENTE con un bloque JSON (nada de texto fuera de él):',
    '```json',
    '{"found":true,"status":"<estado legible, p.ej. On Hold>","closed":true|false,"requesterReplied":true|false,"subject":"<asunto corto>","comments":[{"author":"<quién>","at":"<fecha ISO o texto>","visibility":"public|private","excerpt":"<~200 chars del comentario>"}]}',
    '```',
    'Reglas para esos campos:',
    '- "closed": true si el estado indica cerrado/resuelto (Closed, Resolved, Cerrado, Completed…), false si sigue abierto/en curso.',
    '- "requesterReplied": true si el ÚLTIMO comentario visible lo escribió QUIEN REPORTÓ el ticket (el cliente/solicitante) DESPUÉS de la última respuesta del equipo de soporte — es decir, el ticket "tiene respuesta" del cliente. false si el último movimiento fue del equipo o no hay respuesta del cliente.',
    'Máximo los 5 comentarios más recientes (el más nuevo primero). Si no encontrás el ticket: {"found":false}.',
  ].join('\n');
}

// Parseo defensivo del texto del modelo -> objeto de resultado normalizado.
export function parseDeskResponse(out) {
  const candidates = [];
  const fences = out.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fences) for (const f of fences) candidates.push(f.replace(/```(?:json)?/gi, '').trim());
  const brace = out.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  let parsed = null;
  for (const c of candidates.reverse()) {
    try { parsed = JSON.parse(c); break; } catch { /* siguiente */ }
  }
  const statusText = parsed?.status ? String(parsed.status).slice(0, 60) : null;
  const closedByStatus = /clos|resolv|cerrad|complet|solved/i.test(statusText || '');
  const closed = parsed?.closed === true || closedByStatus;
  const replied = parsed?.requesterReplied === true;
  if (!parsed || typeof parsed !== 'object') {
    return { found: false, error: 'No se pudo interpretar la respuesta de Desk.', fetchedAt: Date.now() };
  }
  return {
    found: parsed.found !== false,
    status: statusText,
    subject: parsed.subject ? String(parsed.subject).slice(0, 120) : null,
    closed, replied,
    resolved: closed || replied, // "completo": cerrado O el cliente respondió
    comments: Array.isArray(parsed.comments) ? parsed.comments.slice(0, 5).map((c) => ({
      author: String(c.author || '?').slice(0, 60),
      at: c.at ? String(c.at).slice(0, 40) : null,
      visibility: /priv/i.test(String(c.visibility)) ? 'private' : 'public',
      excerpt: String(c.excerpt || '').slice(0, 300),
    })) : [],
    fetchedAt: Date.now(),
  };
}

// ===== Resultado persistido por ticket (sobrevive al cambio de pestaña) =====
const safeKey = (t) => String(t).replace(/[^\w.-]/g, '').slice(0, 20);
export function deskResultPath(ticket) { return path.join(DESK_DIR, `${safeKey(ticket)}.json`); }

export function readDeskResult(ticket) {
  try { return JSON.parse(fss.readFileSync(deskResultPath(ticket), 'utf8')); }
  catch { return null; }
}
export function writeDeskResult(ticket, data) {
  try {
    fss.mkdirSync(DESK_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(deskResultPath(ticket), JSON.stringify(data), { mode: 0o600 });
  } catch (err) { console.error('[desk] no pude persistir el resultado:', err?.message); }
}

// Marca deskReplied/deskResolved en TODOS los registros del ticket (el motor
// los lee). Emite ticket_cerrado/ticket_respondido la 1ª vez.
export function persistDeskSnapshot(ticketKey, data) {
  const all = listBugfixes();
  let touched = false;
  for (const b of all) {
    if (String(b.ticketNumber) !== String(ticketKey)) continue;
    touched = true;
    b.deskStatusText = data.status || null;
    b.deskCheckedAt = data.fetchedAt;
    b.deskClosed = data.closed;
    b.deskReplied = data.replied;
    const wasResolved = b.deskResolved === true;
    b.deskResolved = data.resolved;
    if (data.resolved && !wasResolved) {
      addEvent(b, data.closed ? 'ticket_cerrado' : 'ticket_respondido', { status: data.status || null });
    }
    b.updatedAt = Date.now();
  }
  if (touched) saveBugfixes(all);
}

// ===== Lock de "consulta Desk corriendo" (heartbeat del runner) =====
// Guarda { pid, ts, tickets:[...], done, total } para el progreso del front.
export function writeDeskLock(state) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(DESK_LOCK, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearDeskLock() { try { fss.unlinkSync(DESK_LOCK); } catch { /* noop */ } }
export function readDeskLock() {
  try {
    const l = JSON.parse(fss.readFileSync(DESK_LOCK, 'utf8'));
    if (Date.now() - l.ts >= DESK_LOCK_FRESH_MS) return null; // lock viejo = runner muerto
    return l;
  } catch { return null; }
}
export function isDeskRunning() { return !!readDeskLock(); }
