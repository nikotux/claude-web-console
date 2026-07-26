#!/usr/bin/env node
// bin/cwc-codex-runner.js — ejecutor DESACOPLADO de UNA delegación Tándem a
// Codex. El job vive en disco y el heartbeat se actualiza mientras trabaja, de
// modo que la operación larga no dependa del ciclo de vida de la interfaz web y
// B2 pueda lanzarla detached/reengancharse por polling sin perder el resultado.
//
// Este runner es config-free a propósito: resuelve el directorio multi-tenant
// desde CWC_DATA_DIR/HOME y no importa core/config.js.
import {
  buildDelegationReport,
  CODEX_HEARTBEAT_MS,
  CODEX_JOB_TERMINAL_STATUSES,
  codexJobPath,
  diffSnapshots,
  pruneCodexJobs,
  readCodexJob,
  runCodex,
  snapshotTree,
  writeCodexJob,
} from '../src/modules/chat/codex-shared.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const usage = () => console.error(`[${new Date().toISOString()}] Uso: node bin/cwc-codex-runner.js --job <id>`);
let activeJobId = null;
let heartbeat = null;
let handlingSignal = false;

function handleSignal(signal, exitCode) {
  if (handlingSignal) return;
  handlingSignal = true;
  if (heartbeat) clearInterval(heartbeat);
  if (activeJobId) {
    try {
      writeCodexJob(activeJobId, {
        status: 'killed',
        isError: true,
        error: `El runner de Codex recibió ${signal} y terminó antes de completar el job.`,
        finishedAt: Date.now(),
        pid: process.pid,
      });
    } catch (err) {
      log(`No se pudo persistir la señal ${signal} del job ${activeJobId}:`, err?.message || err);
    }
  }
  log(`Runner terminado por ${signal}.`);
  process.exit(exitCode);
}

process.once('SIGTERM', () => handleSignal('SIGTERM', 143));
process.once('SIGINT', () => handleSignal('SIGINT', 130));

pruneCodexJobs();

const flagIndex = process.argv.indexOf('--job');
const jobId = flagIndex >= 0 ? process.argv[flagIndex + 1] : '';
let validJobId = false;
try {
  if (jobId) {
    codexJobPath(jobId);
    validJobId = true;
  }
} catch { /* el mensaje de uso alcanza para ids inválidos */ }

async function runJob(id) {
  const job = readCodexJob(id);
  if (!job) throw new Error(`Job Codex ${id} inexistente o inválido.`);
  if (CODEX_JOB_TERMINAL_STATUSES.includes(job.status)) {
    log(`Job ${id} ya terminó con estado ${job.status}; no se vuelve a ejecutar.`);
    return;
  }

  const startedAt = Date.now();
  activeJobId = id;
  writeCodexJob(id, {
    status: 'running',
    startedAt,
    heartbeatAt: startedAt,
    pid: process.pid,
  });
  heartbeat = setInterval(() => {
    try { writeCodexJob(id, { heartbeatAt: Date.now() }); }
    catch (err) { log(`No se pudo actualizar el heartbeat del job ${id}:`, err?.message || err); }
  }, CODEX_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const before = await snapshotTree(job.cwd, { withContents: true });
    const res = await runCodex(
      job.cwd,
      job.task,
      job.model,
      job.effort,
      job.fullAccess === true,
      Array.isArray(job.writableRoots) ? job.writableRoots : [],
    );
    const after = await snapshotTree(job.cwd);
    const changes = diffSnapshots(before, after, job.cwd, startedAt);
    const { text, isError } = await buildDelegationReport({
      res,
      before,
      after,
      cwd: job.cwd,
      startedAt,
      changes,
    });
    writeCodexJob(id, {
      status: 'done',
      report: text,
      isError,
      threadId: res.threadId,
      finishedAt: Date.now(),
    });
    activeJobId = null;
    log(`Job ${id} terminado${isError ? ' con problema informado por Codex' : ''}.`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }
}

if (!validJobId) {
  usage();
  process.exitCode = 2;
} else {
  try {
    await runJob(jobId);
  } catch (err) {
    const message = String(err?.message || err);
    try {
      writeCodexJob(jobId, {
        status: 'error',
        error: message,
        finishedAt: Date.now(),
      });
      activeJobId = null;
    } catch (writeErr) {
      log(`No se pudo persistir el error del job ${jobId}:`, writeErr?.message || writeErr);
    }
    log(`FALLO job ${jobId}:`, message);
    process.exitCode = 1;
  }
}
