#!/usr/bin/env node

/**
 * Un worker del censo paralelo. Toma tickets de scan_queue, los lee con su
 * propio Chromium y persiste el resultado en la base local. No escribe JSON:
 * el orquestador es el único dueño de esos artefactos. Un ticket fallido queda
 * registrado sin abortar la corrida; el proceso separado existe porque cada
 * worker necesita aislar su navegador.
 */

import {
  InvalidSessionError,
  errorMessage,
  launchContext,
  scrapeWithRetry,
  tolkienPaths,
} from './cwc-tolkien.js';
import * as store from './cwc-tolkien-store.js';

function log(workerId, message) {
  process.stderr.write(`[cwc-tolkien-worker ${workerId}] ${message}\n`);
}

function usage(message = null) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Uso: node bin/cwc-tolkien-worker.js --run <runUid> '
      + '[--worker-id <id>] [--max-attempts <n>]\n',
  );
}

function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Falta el valor de ${option}.`);
  return value;
}

function parseArgs(args) {
  let runUid = null;
  let workerId = `w${process.pid}`;
  let maxAttempts = 3;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--run') {
      runUid = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === '--worker-id') {
      workerId = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === '--max-attempts') {
      const raw = valueAfter(args, index, arg);
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error('--max-attempts debe ser un entero mayor que cero.');
      }
      maxAttempts = Number(raw);
      index += 1;
    } else {
      throw new Error(`Opción desconocida: ${arg}`);
    }
  }
  if (!runUid) throw new Error('Falta --run <runUid>.');
  return { runUid, workerId, maxAttempts };
}

async function runWorker() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(errorMessage(error));
    return 1;
  }

  const { runUid, workerId, maxAttempts } = options;
  const paths = tolkienPaths();
  let db = null;
  let browser = null;
  let context = null;
  let page = null;
  let actual = null;
  let heartbeat = null;
  let stopping = false;
  let cleanupPromise = null;

  const returnActualToQueue = () => {
    if (!db || !actual) return;
    const ticketWorkflowId = actual;
    actual = null;
    try {
      store.finishScanTarget(db, runUid, ticketWorkflowId, { status: 'pending' });
    } catch (error) {
      log(workerId, `${ticketWorkflowId}: no se pudo devolver a pending (${errorMessage(error)})`);
    }
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    cleanupPromise = (async () => {
      if (heartbeat) clearInterval(heartbeat);
      returnActualToQueue();
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      try { db?.close(); } catch { /* la base ya estaba cerrada */ }
    })();
    return cleanupPromise;
  };

  const stopOnSignal = () => { void cleanup(); };
  process.on('SIGTERM', stopOnSignal);
  process.on('SIGINT', stopOnSignal);

  let exitCode = 0;
  try {
    try {
      db = store.openStore(paths.dbFile);
    } catch (error) {
      log(workerId, `no se pudo abrir la base local: ${errorMessage(error)}`);
      return 3;
    }
    ({ browser, context } = await launchContext(paths.sessionFile));
    if (stopping) return 0;
    page = await context.newPage();
    if (stopping) return 0;

    // Un único timer sigue al ticket vigente; recrearlo por claim dejaría
    // intervalos huérfanos capaces de mantener vivos tickets ya terminados.
    heartbeat = setInterval(() => {
      if (!actual || stopping) return;
      try {
        store.heartbeatScanTarget(db, runUid, actual, workerId);
      } catch (error) {
        log(workerId, `${actual}: falló el heartbeat (${errorMessage(error)})`);
      }
    }, 15_000);
    heartbeat.unref();

    while (!stopping) {
      const target = store.claimScanTarget(db, runUid, { workerId, maxAttempts });
      if (target === null) break;
      actual = target.ticketWorkflowId;
      const record = await scrapeWithRetry(page, target.listed);
      if (stopping) break;
      store.upsertTickets(db, runUid, [record]);
      store.finishScanTarget(db, runUid, actual, {
        status: record.error ? 'failed' : 'done',
        error: record.error ?? null,
      });
      log(
        workerId,
        record.error
          ? `${actual}: error (${errorMessage(record.error)})`
          : `${actual}: ok`,
      );
      actual = null;
    }
  } catch (error) {
    if (stopping) {
      exitCode = 0;
    } else if (error instanceof InvalidSessionError) {
      returnActualToQueue();
      log(workerId, `sesión de Tolkien inválida: ${errorMessage(error)}`);
      exitCode = 2;
    } else {
      returnActualToQueue();
      log(workerId, `error fatal: ${errorMessage(error)}`);
      exitCode = 1;
    }
  } finally {
    await cleanup();
    process.removeListener('SIGTERM', stopOnSignal);
    process.removeListener('SIGINT', stopOnSignal);
  }
  return exitCode;
}

process.exitCode = await runWorker();
