#!/usr/bin/env node
// bin/cwc-audio-runner.js — análisis IA de UNA transcripción de audio,
// DESACOPLADO del server (regla de oro: detached+unref, un reinicio de la web a
// mitad NO lo mata).
//
// El endpoint POST /api/audio/analyze (modules/audio/index.js) escribe el job
// PENDIENTE en ~/.cwc-data/audio/<id>.json (con la transcripción ya capturada)
// y spawnea esto; acá se hace la corrida real (SDK, sonnet, 1 turno, CERO
// herramientas — dos capas de denegación, regla 6: el texto viaja entero en el
// prompt) y se persiste el resultado en el MISMO archivo. El front encuesta
// GET /api/audio/:id hasta que status deja de ser 'running'. Mismo patrón que
// bin/cwc-commitmsg-runner.js / bin/cwc-projects-analyze-runner.js.
import { textOnlyQuery } from '../src/core/text-only-query.js';
import {
  ROOT, AUDIO_TIMEOUT_MS, audioPrompt, parseAudio,
  readAudioJob, writeAudioJob,
} from '../src/modules/audio/shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = process.argv[2];

async function runAnalysis(job) {
  const text = await textOnlyQuery(audioPrompt(job.transcript), {
    cwd: ROOT,
    model: 'sonnet',
    maxTurns: 1,
    timeoutMs: AUDIO_TIMEOUT_MS,
    denyReason: 'El análisis de audio no usa herramientas.',
    timeoutMessage: 'El análisis tardó demasiado.',
  });
  const result = parseAudio(text);
  if (!result) throw new Error('No se pudo interpretar la respuesta del análisis.');
  return result;
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  const job = readAudioJob(id);
  if (!job) { log(`job ${id} inexistente (¿se limpió antes de arrancar?).`); process.exit(0); return; }
  try {
    const result = await runAnalysis(job);
    // Releemos el job DEL DISCO justo antes de persistir: durante los hasta
    // 4 min de la corrida el usuario pudo (a) BORRAR el análisis — no lo
    // recreamos, respetamos el borrado — o (b) EDITAR el título — lo
    // preservamos en vez de pisarlo con el snapshot viejo (`job`).
    const cur = readAudioJob(id);
    if (!cur) { log(`job ${id} fue borrado durante el análisis; no lo recreo.`); return; }
    // Título AUTOMÁTICO: si el usuario no puso/editó uno propio (titleAuto),
    // usamos el que generó la IA; el usuario puede editarlo después
    // (POST /api/audio/:id/title, que fija titleAuto=false).
    const title = (cur.titleAuto || !cur.title)
      ? (result.title || 'Transcripción sin título')
      : cur.title;
    writeAudioJob(id, { ...cur, title, status: 'done', result, error: null, updatedAt: Date.now() });
    log(`OK job ${id}: "${title}" · ${result.proposedTasks.length} tarea(s), ${result.segments.length} segmento(s)`);
  } catch (err) {
    // Mismo cuidado en el camino de error: si lo borraron mientras corría, no
    // resucitamos el job con un estado de error.
    const cur = readAudioJob(id);
    if (!cur) { log(`job ${id} fue borrado durante el análisis; no lo recreo.`); return; }
    writeAudioJob(id, { ...cur, status: 'error', result: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
