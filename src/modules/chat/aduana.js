// modules/chat/aduana.js — suelo neutral persistente de las salas de Aduana.
//
// Los mensajes HUMANOS de una sala no viven en el transcript del SDK, que solo
// conoce sus propios turnos. Sin este log la conversación se evaporaría cuando
// el chat se duerme; por la regla dura 2, además debe sobrevivir a un reinicio
// del server.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';

export const ADUANA_ROOT = path.join(config.home, '.cwc-aduana', 'salas');
export const MAX_SAY_LEN = 4000;
export const MAX_SAY_ATTACHMENTS = 8;
export const SALA_LOG_MAX_LINES = 5000;

const SALA_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

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

export function salaLogPath(id) {
  return path.join(salaRoot(id), 'sala.jsonl');
}

export function appendSay(id, { by, text, ts, attachments }) {
  ensureSala(id);
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
  const rec = {
    t: 'say',
    by: String(by),
    text: String(text).slice(0, MAX_SAY_LEN),
    ts: ts || Date.now(),
    ...(safeAttachments.length ? { attachments: safeAttachments } : {}),
  };
  // Es append-only: el tmp+rename de CONVE-5 reescribiría el archivo entero
  // por mensaje; un append chico obtiene atomicidad del O_APPEND de POSIX.
  fs.appendFileSync(salaLogPath(id), JSON.stringify(rec) + '\n');
  return rec;
}

export function appendCut(id, { by, ts, count }) {
  ensureSala(id);
  const rec = {
    t: 'cut',
    by,
    ts: ts || Date.now(),
    count: Number(count) || 0,
  };
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
