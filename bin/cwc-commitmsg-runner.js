#!/usr/bin/env node
// bin/cwc-commitmsg-runner.js — generación IA del mensaje de commit del panel
// Backup, DESACOPLADA del proceso del server (regla de oro: se spawnea
// detached+unref, un reinicio de la web a mitad NO la mata).
//
// El endpoint POST /api/backup/commit-message (modules/backup/index.js) solo
// escribe el job PENDIENTE en ~/.cwc-data/commitmsg/<id>.json (con el diff ya
// capturado por el server) y spawnea esto; acá se hace la corrida real (SDK,
// sonnet, 1 turno, CERO herramientas — dos capas de denegación, regla 6: el
// diff viaja entero en el prompt) y se persiste el resultado en el MISMO
// archivo. El front encuesta GET /commit-message/:id hasta que status deja de
// ser 'running'. Mismo patrón que bin/cwc-projects-analyze-runner.js.
import { textOnlyQuery } from '../src/core/text-only-query.js';
import {
  ROOT, COMMITMSG_TIMEOUT_MS, commitMsgPrompt, parseCommitMsg,
  readCommitMsgJob, writeCommitMsgJob,
} from '../src/modules/backup/commitmsg-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = process.argv[2];

async function runGeneration(job) {
  const text = await textOnlyQuery(commitMsgPrompt(job), {
    cwd: ROOT,
    model: 'sonnet',
    effort: 'low',
    maxTurns: 1,
    timeoutMs: COMMITMSG_TIMEOUT_MS,
    denyReason: 'La generación del mensaje de commit no usa herramientas.',
    timeoutMessage: 'La generación tardó demasiado.',
  });
  const message = parseCommitMsg(text);
  if (!message) throw new Error('No se pudo interpretar el mensaje generado.');
  return message;
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  const job = readCommitMsgJob(id);
  if (!job) { log(`job ${id} inexistente (¿se limpió antes de arrancar?).`); process.exit(0); return; }
  try {
    const message = await runGeneration(job);
    writeCommitMsgJob(id, { ...job, status: 'done', message, error: null, updatedAt: Date.now() });
    log(`OK job ${id}: "${message.split('\n')[0].slice(0, 80)}"`);
  } catch (err) {
    writeCommitMsgJob(id, { ...job, status: 'error', message: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
