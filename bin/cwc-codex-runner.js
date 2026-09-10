#!/usr/bin/env node
// bin/cwc-codex-runner.js — ejecutor DESACOPLADO de UNA delegación Tándem a
// Codex. El job vive en disco y el heartbeat se actualiza mientras trabaja, de
// modo que la operación larga no dependa del ciclo de vida de la interfaz web y
// B2 pueda lanzarla detached/reengancharse por polling sin perder el resultado.
//
// Este runner es config-free a propósito: resuelve el directorio multi-tenant
// desde CWC_DATA_DIR/HOME y no importa core/config.js.
import {
  applyDeclaredBack,
  buildDelegationReport,
  CODEX_HEARTBEAT_MS,
  CODEX_JOB_TERMINAL_STATUSES,
  codexJobPath,
  createDelegationWorktree,
  diffSnapshots,
  pruneCodexJobs,
  readCodexJob,
  removeDelegationWorktree,
  runCodex,
  seedWorktree,
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
    const declared = Array.isArray(job.files) && job.files.length ? job.files : null;
    const before = await snapshotTree(job.cwd, { withContents: true });

    if (declared && job.fullAccess !== true) {
      let worktreePath = null;
      let preserveWorktree = false;
      let isolationFailure = null;
      try {
        try {
          const worktree = await createDelegationWorktree(job.cwd, id);
          worktreePath = worktree.path;
          const seeded = await seedWorktree(worktreePath, job.cwd);
          if (!seeded.ok) isolationFailure = seeded.error || 'falló el sembrado del estado actual';
        } catch (err) {
          isolationFailure = String(err?.message || err);
        }

        if (!isolationFailure) {
          const res = await runCodex(
            worktreePath,
            job.task,
            job.model,
            job.effort,
            false,
            Array.isArray(job.writableRoots) ? job.writableRoots : [],
            (threadId) => { try { writeCodexJob(id, { threadId }); } catch { /* noop */ } },
          );
          const applied = await applyDeclaredBack(worktreePath, job.cwd, declared);
          if (applied.conflict === true) {
            preserveWorktree = true;
            const report = [
              '⚠️ CONFLICTO AL APLICAR LA DELEGACIÓN AISLADA',
              `Archivos declarados:\n${declared.join('\n')}`,
              'Otro proceso modificó alguno de estos archivos durante la corrida y el parche de Codex entró en conflicto.',
              `stderr de git apply:\n${applied.error || '(sin detalle en stderr)'}`,
              'El cambio de Codex NO se aplicó al proyecto real.',
              `El trabajo quedó preservado en el worktree: ${worktreePath}`,
            ].join('\n\n');
            writeCodexJob(id, {
              status: 'done',
              report,
              isError: true,
              threadId: res.threadId,
              finishedAt: Date.now(),
            });
            activeJobId = null;
            log(`Job ${id} terminado con conflicto; se conserva ${worktreePath}.`);
            return;
          }

          let text;
          let isError;
          if (applied.empty === true) {
            const parts = [];
            if (res.error) parts.push(`⚠️ Codex terminó con problema: ${res.error}`);
            else if (res.code !== 0) parts.push(`⚠️ Codex salió con código ${res.code}${res.stderr ? ` — ${res.stderr.slice(0, 300)}` : ''}`);
            parts.push(`RESUMEN DE CODEX:\n${res.msgs.length ? res.msgs.join('\n\n') : '(Codex no devolvió mensaje final)'}`);
            parts.push(`ARCHIVOS DECLARADOS SIN CAMBIOS:\n${declared.join('\n')}`);
            parts.push('DIFF: (Codex no modificó ninguno de los archivos declarados; los cambios del resto del árbol son ajenos a esta delegación)');
            if (res.threadId) parts.push(`(codex thread: ${res.threadId})`);
            text = parts.join('\n\n');
            isError = !!res.error;
          } else {
            const appliedFiles = Array.isArray(applied.applied) ? applied.applied : [];
            const existedBefore = (rel) => before.tracked.has(rel) || before.contents?.has(rel);
            const changes = {
              touched: appliedFiles.filter(existedBefore),
              newFiles: appliedFiles.filter((rel) => !existedBefore(rel)),
            };
            const after = await snapshotTree(job.cwd);
            ({ text, isError } = await buildDelegationReport({
              res,
              before,
              after,
              cwd: job.cwd,
              startedAt,
              changes,
              attributed: true,
            }));
          }
          writeCodexJob(id, {
            status: 'done',
            report: text,
            isError,
            threadId: res.threadId,
            finishedAt: Date.now(),
          });
          activeJobId = null;
          log(`Job ${id} terminado${isError ? ' con problema informado por Codex' : ''}.`);
          return;
        }
      } finally {
        if (worktreePath && !preserveWorktree) {
          await removeDelegationWorktree(job.cwd, worktreePath);
        }
      }

      const report = [
        '⛔ DELEGACIÓN NO EJECUTADA: no se pudo montar el aislamiento solicitado.',
        `La delegación declaró ${declared.length} archivo${declared.length === 1 ? '' : 's'}:\n${declared.join('\n')}`,
        `Motivo exacto:\n${isolationFailure}`,
        'No se ejecutó Codex ni se aplicó ningún cambio, para no arriesgar el trabajo de otras sesiones.',
        'Podés reintentar cuando el árbol esté más quieto, o repetir la delegación SIN `files` si aceptás ejecutarla sin aislamiento.',
      ].join('\n\n');
      writeCodexJob(id, {
        status: 'done',
        report,
        isError: true,
        finishedAt: Date.now(),
      });
      activeJobId = null;
      log(`Job ${id} no ejecutado porque no se pudo montar el aislamiento.`);
      return;
    }

    const res = await runCodex(
      job.cwd,
      job.task,
      job.model,
      job.effort,
      job.fullAccess === true,
      Array.isArray(job.writableRoots) ? job.writableRoots : [],
      (threadId) => { try { writeCodexJob(id, { threadId }); } catch { /* noop */ } },
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
    const isolationNote = declared && job.fullAccess === true
      ? 'NOTA DE AISLAMIENTO: se declararon archivos, pero la delegación usó full_access y por diseño se ejecutó sobre el árbol real.'
      : '';
    writeCodexJob(id, {
      status: 'done',
      report: isolationNote ? `${text}\n\n${isolationNote}` : text,
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
