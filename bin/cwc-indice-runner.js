#!/usr/bin/env node
// bin/cwc-indice-runner.js — destila el Índice semántico de un chat en un
// proceso desacoplado. El server deja un snapshot incremental en disco; este
// runner manda ese TEXTO en el prompt y persiste el resultado desde Node.
import {
  ROOT,
  INDICE_HEARTBEAT_MS,
  INDICE_TIMEOUT_MS,
  clearIndiceLock,
  indicePrompt,
  mergeIndiceMoments,
  parseIndice,
  readIndiceJob,
  readIndiceLock,
  readIndiceState,
  writeIndiceLock,
  writeIndiceState,
} from '../src/modules/chat/indice-shared.js';
import { textOnlyQuery } from '../src/core/text-only-query.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const chatId = process.argv[2];
const token = process.argv[3];
let heartbeat = null;

function finishLock() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  clearIndiceLock(chatId, token);
}

function ownsLock() {
  return readIndiceLock(chatId)?.token === token;
}

async function main() {
  if (!chatId || !token) throw new Error('Faltan el chatId o el token del lock.');
  const reservation = readIndiceLock(chatId);
  if (!reservation || reservation.token !== token) {
    log(`El lock de ${chatId} no existe, venció o pertenece a otra corrida; salgo.`);
    return;
  }

  writeIndiceLock(chatId, { pid: process.pid, token });
  heartbeat = setInterval(
    () => {
      try {
        if (ownsLock()) writeIndiceLock(chatId, { pid: process.pid, token });
      } catch (err) { log(`No pude refrescar el heartbeat de ${chatId}:`, err?.message || err); }
    },
    INDICE_HEARTBEAT_MS,
  );
  heartbeat.unref();

  const job = readIndiceJob(chatId);
  if (!job || job.chatId !== chatId || !Array.isArray(job.events)) {
    throw new Error('El snapshot incremental del Índice no existe o es inválido.');
  }

  try {
    // TEXTO PURO, read-only de doble capa. textOnlyQuery fija:
    // settingSources: [] + PreToolUse deny + canUseTool deny (CERO tools).
    const text = await textOnlyQuery(indicePrompt(job), {
      model: 'sonnet',
      maxTurns: 1,
      timeoutMs: INDICE_TIMEOUT_MS,
      cwd: ROOT,
      denyReason: 'La destilación del Índice no usa herramientas.',
      timeoutMessage: 'La destilación del Índice tardó demasiado.',
    });
    const allowed = job.events.map((event) => event.eventIndex);
    const parsed = parseIndice(text, allowed);
    if (!parsed) throw new Error('No se pudo interpretar la respuesta de la destilación del Índice.');
    if (!ownsLock()) throw new Error('La corrida perdió el lock del Índice; no se persiste su resultado.');

    const current = readIndiceState(chatId) || {};
    const latestJob = readIndiceJob(chatId) || job;
    const hasLaterActivity = Number(latestJob.observedUpToEvent) > Number(job.upToEvent);
    const moments = mergeIndiceMoments(current.moments, parsed.moments);
    writeIndiceState(chatId, {
      chatId,
      status: hasLaterActivity ? 'stale' : 'ready',
      generatedAt: Date.now(),
      upToEvent: job.upToEvent,
      error: null,
      moments,
    });
    log(`OK ${chatId}: ${parsed.moments.length} momento(s) nuevo(s), ${moments.length} total(es), hasta evento ${job.upToEvent}${hasLaterActivity ? ' (quedó actividad nueva)' : ''}.`);
  } catch (err) {
    if (ownsLock()) {
      const current = readIndiceState(chatId) || {};
      writeIndiceState(chatId, {
        chatId,
        status: 'error',
        generatedAt: Number.isFinite(current.generatedAt) ? current.generatedAt : 0,
        upToEvent: Number.isInteger(current.upToEvent) ? current.upToEvent : -1,
        error: String(err?.message || err).slice(0, 300),
        moments: Array.isArray(current.moments) ? current.moments : [],
      });
    }
    log(`FAIL ${chatId}:`, err?.message || err);
    process.exitCode = 1;
  } finally {
    finishLock();
  }
}

main().catch((err) => {
  try {
    if (ownsLock()) {
      const current = readIndiceState(chatId) || {};
      writeIndiceState(chatId, {
        chatId,
        status: 'error',
        generatedAt: Number.isFinite(current.generatedAt) ? current.generatedAt : 0,
        upToEvent: Number.isInteger(current.upToEvent) ? current.upToEvent : -1,
        error: String(err?.message || err).slice(0, 300),
        moments: Array.isArray(current.moments) ? current.moments : [],
      });
    }
  } catch { /* noop */ }
  finishLock();
  log('FALLO inesperado:', err?.message || err);
  process.exitCode = 1;
});
