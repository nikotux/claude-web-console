// modules/chat/aduana.js — suelo neutral persistente de las salas de Aduana.
//
// Los mensajes HUMANOS de una sala no viven en el transcript del SDK, que solo
// conoce sus propios turnos. Sin este log la conversación se evaporaría cuando
// el chat se duerme; por la regla dura 2, además debe sobrevivir a un reinicio
// del server.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../core/config.js';

export const ADUANA_ROOT = path.join(config.home, '.cwc-aduana', 'salas');
export const ADUANA_WORKSPACE = 'aduana';
export const ADUANA_SALAS_COLLECTION = 'salas';
export const ADUANA_ACUERDOS_COLLECTION = 'acuerdos';
export const MAX_SAY_LEN = 4000;
export const MAX_SAY_ATTACHMENTS = 8;
export const MAX_CUT_AUTHORS = 12;
export const MAX_MENTIONS = 12;
export const MAX_REPLY_TO_LEN = 128;
export const MAX_REPLY_TO_BY_LEN = 80;
export const MAX_REPLY_TO_TEXT_LEN = 100;
export const SALA_LOG_MAX_LINES = 5000;
export const SALA_TTL_DAYS = 30;
export const REACTIONS = ['👍', '❓', '🔴'];
// El nombre propio de la IA de la sala (elegido por votación en la sala, 2026-07-31).
// `@cucho` SIEMPRE es la IA: si algún día existe un usuario real llamado así, el
// tag lo sigue ganando la IA dentro de una sala (decisión explícita de Niko).
export const SALA_AI_NAME = 'cucho';
export const SALA_AI_LABEL = 'Cucho';

const SALA_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_REACTION_MSG_ID_LEN = 128;
const MAX_REACTION_BY_LEN = 80;

function fnv1a(value) {
  let hash = 2166136261;
  for (const byte of Buffer.from(String(value ?? ''), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function sayId(rec) {
  if (typeof rec?.id === 'string' && rec.id) return rec.id;
  const ts = Number(rec?.ts);
  const tsPart = Number.isFinite(ts) && ts >= 0 ? Math.trunc(ts).toString(36) : '0';
  const textHash = fnv1a(rec?.text).toString(36);
  const identityHash = fnv1a(`${String(rec?.by ?? '')}\0${String(rec?.ts ?? '')}\0${textHash}`);
  // Los `say` legacy no se reescriben porque sala.jsonl es append-only: el id
  // se deriva de autor+timestamp+hash(texto). Limitación conocida y aceptada:
  // dos mensajes idénticos del mismo autor en el mismo milisegundo comparten id.
  return `m${tsPart}-${identityHash.toString(36)}`;
}

function reactionFields(rec) {
  const msgId = typeof rec?.msgId === 'string' ? rec.msgId.trim() : '';
  const by = typeof rec?.by === 'string' ? rec.by.trim() : '';
  const emoji = rec?.emoji;
  if (!msgId || msgId.length > MAX_REACTION_MSG_ID_LEN) return null;
  if (!by || by.length > MAX_REACTION_BY_LEN) return null;
  if (!REACTIONS.includes(emoji)) return null;
  return { msgId, by, emoji };
}

export function safeSalaId(id) {
  if (typeof id !== 'string' || !SALA_ID_RE.test(id)) {
    throw new Error('salaId inválido: ' + id);
  }
  return id;
}

export function salaRoot(id) {
  const abs = path.join(ADUANA_ROOT, safeSalaId(id));
  const rel = path.relative(ADUANA_ROOT, abs);
  // No se usa startsWith de strings: compartir un prefijo no demuestra
  // contención real (lección de console:BUG-2142).
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('salaId fuera de Aduana: ' + id);
  }
  return abs;
}

export function ensureSala(id) {
  const root = salaRoot(id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

// ¿Este cwd apunta al suelo neutral de Aduana? Contención probada con
// path.relative, NUNCA con startsWith de strings (lección de
// console:BUG-2142): compartir prefijo no demuestra contención real.
export function isSalaPath(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const rel = path.relative(ADUANA_ROOT, path.resolve(cwd));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// El salaId lo genera SIEMPRE el servidor. Si lo eligiera el cliente podría
// apuntar a una sala AJENA ya existente y entrar a su conversación
// (console:BUG-2432). Mismo molde que ChatManager.toAduana().
export function newSalaId() {
  return safeSalaId(`sala-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 10)}`);
}

export function salaLogPath(id) {
  return path.join(salaRoot(id), 'sala.jsonl');
}

export function readsPath(id) {
  return path.join(salaRoot(id), 'reads.json');
}

export function pruneSalas({ keepIds = [], maxAgeMs } = {}) {
  let removed = 0;
  try {
    const ageLimit = Number(maxAgeMs);
    if (!Number.isFinite(ageLimit) || ageLimit < 0) return 0;
    const keep = new Set();
    for (const id of Array.isArray(keepIds) ? keepIds : []) {
      try { keep.add(safeSalaId(id)); } catch { /* ids ajenos no protegen carpetas */ }
    }

    let entries;
    try {
      entries = fs.readdirSync(ADUANA_ROOT, { withFileTypes: true });
    } catch {
      return 0;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      try {
        const id = safeSalaId(entry.name);
        const stat = fs.statSync(salaLogPath(id));
        if (!stat.isFile() || now - stat.mtimeMs <= ageLimit) continue;
        fs.rmSync(salaRoot(id), { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        console.error(`[aduana] no pude podar la sala ${entry.name}:`, err?.message);
      }
    }
  } catch (err) {
    console.error('[aduana] la poda de salas falló:', err?.message);
  }
  return removed;
}

export function readReads(id) {
  let raw;
  try {
    raw = fs.readFileSync(readsPath(id), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const reads = {};
    for (const [username, ts] of Object.entries(parsed)) {
      if (!USERNAME_RE.test(username) || typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
      reads[username] = ts;
    }
    return reads;
  } catch {
    // Un archivo corrupto no debe impedir que la sala cargue.
    return {};
  }
}

export function writeRead(id, username, ts) {
  const reads = readReads(id);
  const user = typeof username === 'string' ? username.trim() : '';
  const nextTs = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : 0;
  if (!USERNAME_RE.test(user) || !nextTs || nextTs <= (reads[user] || 0)) return reads;

  ensureSala(id);
  reads[user] = nextTs;
  const target = readsPath(id);
  const tempPath = `${target}.${process.pid}.tmp`;
  try {
    // A diferencia de sala.jsonl, acá se reemplaza el conjunto entero:
    // tmp+rename evita exponer marcas parciales; appendFileSync no corresponde.
    fs.writeFileSync(tempPath, JSON.stringify(reads) + '\n', { mode: 0o600 });
    fs.renameSync(tempPath, target);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // La limpieza también es best-effort.
    }
    throw error;
  }
  return reads;
}

export function appendSay(id, {
  id: msgId, by, text, ts, attachments, mentions, askAi, replyTo, replyToBy, replyToText,
}) {
  ensureSala(id);
  const recTs = ts || Date.now();
  const safeMsgId = typeof msgId === 'string' && msgId
    ? msgId
    : `m${recTs.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
  const safeAttachments = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.name !== 'string') continue;
    const name = attachment.name.trim().slice(0, 200);
    if (!name) continue;
    // El llamador ya comprobó el archivo en disco; acá se conserva solo el
    // pasaporte mínimo para que el log siga siendo seguro y estable al reabrir.
    safeAttachments.push({
      name,
      type: String(attachment.type ?? '').slice(0, 120),
      mime: String(attachment.mime ?? '').slice(0, 120),
    });
    if (safeAttachments.length >= MAX_SAY_ATTACHMENTS) break;
  }
  const safeMentions = [];
  const seenMentions = new Set();
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const name = String(mention ?? '').trim().slice(0, 64);
    if (!name || seenMentions.has(name)) continue;
    seenMentions.add(name);
    safeMentions.push(name);
    if (safeMentions.length >= MAX_MENTIONS) break;
  }
  const safeReplyTo = String(replyTo ?? '').trim().slice(0, MAX_REPLY_TO_LEN);
  const safeReplyToBy = String(replyToBy ?? '').trim().slice(0, MAX_REPLY_TO_BY_LEN);
  const safeReplyToText = String(replyToText ?? '').trim().slice(0, MAX_REPLY_TO_TEXT_LEN);
  const rec = {
    t: 'say',
    id: safeMsgId,
    by: String(by),
    text: String(text).slice(0, MAX_SAY_LEN),
    ts: recTs,
    ...(safeAttachments.length ? { attachments: safeAttachments } : {}),
    ...(safeMentions.length ? { mentions: safeMentions } : {}),
    ...(askAi ? { askAi: true } : {}),
    // Denormalización deliberada: conservar autor y fragmento permite pintar
    // la cita y armar contexto aunque el mensaje original ya haya sido podado.
    ...(safeReplyTo ? {
      replyTo: safeReplyTo,
      replyToBy: safeReplyToBy,
      replyToText: safeReplyToText,
    } : {}),
  };
  // Es append-only: el tmp+rename de CONVE-5 reescribiría el archivo entero
  // por mensaje; un append chico obtiene atomicidad del O_APPEND de POSIX.
  fs.appendFileSync(salaLogPath(id), JSON.stringify(rec) + '\n');
  return rec;
}

export function appendReact(id, { by, msgId, emoji, off, ts }) {
  const safe = reactionFields({ by, msgId, emoji });
  if (!safe) return null;
  ensureSala(id);
  const rec = {
    t: 'react',
    by: safe.by,
    msgId: safe.msgId,
    emoji: safe.emoji,
    ts: typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    ...(off ? { off: true } : {}),
  };
  // Las reacciones también son eventos append-only. Persistir el agregado
  // obligaría a reescribir sala.jsonl entero en cada toque, justo lo que
  // appendSay evita; los eventos `off` permiten reconstruir el estado final.
  fs.appendFileSync(salaLogPath(id), JSON.stringify(rec) + '\n');
  return rec;
}

export function reactionsFromRecords(records) {
  const aggregate = new Map();
  for (const rec of Array.isArray(records) ? records : []) {
    if (rec?.t !== 'react') continue;
    const safe = reactionFields(rec);
    if (!safe) continue;
    let byEmoji = aggregate.get(safe.msgId);
    if (!byEmoji) {
      if (rec.off === true) continue;
      byEmoji = new Map();
      aggregate.set(safe.msgId, byEmoji);
    }
    let users = byEmoji.get(safe.emoji);
    if (!users) {
      if (rec.off === true) continue;
      users = new Set();
      byEmoji.set(safe.emoji, users);
    }
    if (rec.off === true) {
      users.delete(safe.by);
      if (!users.size) byEmoji.delete(safe.emoji);
      if (!byEmoji.size) aggregate.delete(safe.msgId);
    } else {
      users.add(safe.by);
    }
  }

  const result = new Map();
  for (const [msgId, byEmoji] of aggregate) {
    const reactions = {};
    for (const [emoji, users] of byEmoji) reactions[emoji] = [...users];
    result.set(msgId, reactions);
  }
  return result;
}

export function appendCut(id, { by, ts, count, authors, directed }) {
  ensureSala(id);
  const safeAuthors = [];
  for (const author of Array.isArray(authors) ? authors : []) {
    const name = String(author ?? '').trim().slice(0, 80);
    if (!name) continue;
    safeAuthors.push(name);
    if (safeAuthors.length >= MAX_CUT_AUTHORS) break;
  }
  const rec = {
    t: 'cut',
    by,
    ts: ts || Date.now(),
    count: Number(count) || 0,
    ...(safeAuthors.length ? { authors: safeAuthors } : {}),
    ...(directed ? { directed: true } : {}),
  };
  fs.appendFileSync(salaLogPath(id), JSON.stringify(rec) + '\n');
  return rec;
}

export function appendOrquestado(id, { by, ts, world, chatId, snippet }) {
  ensureSala(id);
  const rec = {
    t: 'orquestado',
    by: String(by ?? '').trim().slice(0, 80),
    ts: typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    world: String(world ?? '').trim().slice(0, 40),
    chatId: String(chatId ?? '').trim().slice(0, 64),
    snippet: String(snippet ?? '').trim().slice(0, 200),
  };
  fs.appendFileSync(salaLogPath(id), JSON.stringify(rec) + '\n');
  return rec;
}

export function appendOrigin(id, { by, ts, priorTurns, fromWorld }) {
  ensureSala(id);
  const rec = {
    t: 'origin',
    by: String(by),
    ts: ts || Date.now(),
    priorTurns: Math.max(0, Number(priorTurns) || 0),
    fromWorld: String(fromWorld || '').slice(0, 80),
  };
  // Es la declaración de Aduana del contexto que ENTRA a la sala: cumple la
  // Ley 2 («nada entra sin declararlo») y la Ley 4 («todo aporte lleva
  // pasaporte») de la Regla dura 16, y ancla los turnos previos a la conversión.
  // Por eso también es append-only: O_APPEND conserva el orden durable del log.
  fs.appendFileSync(salaLogPath(id), JSON.stringify(rec) + '\n');
  return rec;
}

export function readSala(id, { limit = 500 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(salaLogPath(id), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }

  const records = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    // Un crash puede dejar la última línea cortada; descartarla evita perder
    // también todos los mensajes anteriores que siguen siendo válidos.
    try {
      records.push(JSON.parse(line));
    } catch {
      // Una línea corrupta no invalida el resto del log.
    }
  }
  const count = Math.max(0, Number(limit) || 0);
  return count ? records.slice(-count) : [];
}

export function pruneSala(id, { maxLines = SALA_LOG_MAX_LINES } = {}) {
  let tempPath;
  try {
    const logPath = salaLogPath(id);
    tempPath = `${logPath}.${process.pid}.tmp`;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const keepCount = Math.max(0, Number(maxLines) || 0);
    if (lines.length <= keepCount) return 0;

    const kept = keepCount ? lines.slice(-keepCount) : [];
    // Acá sí se reemplaza el conjunto completo: tmp+rename evita exponer una
    // poda parcial si el proceso cae durante la reescritura.
    fs.writeFileSync(tempPath, kept.length ? kept.join('\n') + '\n' : '');
    fs.renameSync(tempPath, logPath);
    return lines.length - kept.length;
  } catch {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // La limpieza también es best-effort.
      }
    }
    return 0;
  }
}
