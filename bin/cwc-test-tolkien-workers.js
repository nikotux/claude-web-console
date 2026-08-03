#!/usr/bin/env node
// Test funcional, determinista y aislado de la cola paralela de Tolkien.
// No toca ~/.cwc-data ni usa Chromium o el SDK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspect, isDeepStrictEqual } from 'node:util';
import * as store from './cwc-tolkien-store.js';

let pass = 0, fail = 0;
const fmt = (value) => inspect(value, { depth: null, sorted: true, breakLength: 120 });
const ok = (name, condition, detail = null) => {
  if (condition) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail === null ? '' : `\n   detalle: ${fmt(detail)}`}`);
  }
};
const eq = (name, got, expected) => {
  if (isDeepStrictEqual(got, expected)) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   esperado: ${fmt(expected)}\n   obtenido: ${fmt(got)}`);
  }
};

function targets(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    ticketWorkflowId: `${prefix}-${index}`,
    url: `https://example.test/${prefix}-${index}`,
    listingText: `WORK-${index} · Ticket ${index}`,
  }));
}

function writeChildScript(testRoot) {
  const scriptFile = path.join(testRoot, 'queue-child.mjs');
  const storeUrl = new URL('./cwc-tolkien-store.js', import.meta.url).href;
  const source = [
    "import fs from 'node:fs';",
    `import * as store from ${JSON.stringify(storeUrl)};`,
    "const value = (name) => process.argv[process.argv.indexOf(name) + 1];",
    "const db = store.openStore(value('--db'));",
    'const processed = [];',
    'try {',
    "  const runUid = value('--run');",
    "  const workerId = value('--worker');",
    '  while (true) {',
    '    const target = store.claimScanTarget(db, runUid, { workerId });',
    '    if (target === null) break;',
    '    processed.push(target.ticketWorkflowId);',
    "    store.finishScanTarget(db, runUid, target.ticketWorkflowId, { status: 'done' });",
    '  }',
    '} finally {',
    '  db.close();',
    '}',
    "fs.writeFileSync(value('--out'), JSON.stringify(processed));",
  ].join('\n');
  fs.writeFileSync(scriptFile, `${source}\n`, { mode: 0o600 });
  return scriptFile;
}

function spawnQueueChild(scriptFile, dbFile, runUid, worker) {
  return new Promise((resolve) => {
    const outputFile = path.join(path.dirname(scriptFile), `${worker}.json`);
    const child = spawn(process.execPath, [
      scriptFile,
      '--db',
      dbFile,
      '--run',
      runUid,
      '--worker',
      worker,
      '--out',
      outputFile,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ worker, outputFile, code: null, stdout, stderr, error }));
    child.once('close', (code) => resolve({ worker, outputFile, code, stdout, stderr }));
  });
}

async function main() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-tolkien-workers-'));
  const dbFile = path.join(testRoot, 'state.db');
  let db = null;
  try {
    db = store.openStore(dbFile);

    console.log('\nT1 · ENQUEUE IDEMPOTENTE');
    const t1Run = store.startRun(db, { kind: 'test-queue', runUid: 't1-run' });
    eq(
      'T1.a encola los 10 targets nuevos',
      store.enqueueScanTargets(db, t1Run, targets('t1', 10)),
      { enqueued: 10, existing: 0, skipped: 0 },
    );
    eq(
      'T1.b re-encolar no duplica',
      store.enqueueScanTargets(db, t1Run, targets('t1', 10)),
      { enqueued: 0, existing: 10, skipped: 0 },
    );
    eq('T1.c el total sigue siendo 10', store.scanQueueCounts(db, t1Run).total, 10);

    console.log('\nT2 · CONCURRENCIA REAL');
    const concurrencyDbFile = path.join(testRoot, 'concurrency.db');
    const concurrencyRun = 't2-concurrency-run';
    const concurrencyDb = store.openStore(concurrencyDbFile);
    store.startRun(concurrencyDb, { kind: 'test-concurrency', runUid: concurrencyRun });
    store.enqueueScanTargets(concurrencyDb, concurrencyRun, targets('concurrent', 200));
    concurrencyDb.close();
    const childScript = writeChildScript(testRoot);
    const childResults = await Promise.all(
      Array.from(
        { length: 8 },
        (_, index) => spawnQueueChild(
          childScript,
          concurrencyDbFile,
          concurrencyRun,
          `worker-${index + 1}`,
        ),
      ),
    );
    const processed = childResults.flatMap((result) => {
      try {
        return JSON.parse(fs.readFileSync(result.outputFile, 'utf8'));
      } catch {
        return [];
      }
    });
    const checkedDb = store.openStore(concurrencyDbFile);
    const rows = store.scanQueueRows(checkedDb, concurrencyRun);
    const integrity = checkedDb.prepare('PRAGMA integrity_check').get().integrity_check;
    checkedDb.close();
    console.log(
      `T2 números reales: hijos=8 · filas=${rows.length} · procesados=${processed.length}`,
    );
    eq(
      'T2.a los 8 hijos terminan con código 0',
      childResults.filter((result) => result.code === 0).length,
      8,
    );
    ok(
      'T2.b ningún hijo informa un error',
      childResults.every((result) => !result.stderr && !result.error),
      childResults,
    );
    ok(
      'T2.c cada fila queda done exactamente una vez',
      rows.length === 200
        && rows.every((row) => row.status === 'done' && Number(row.attempts) === 1),
      rows.filter((row) => row.status !== 'done' || Number(row.attempts) !== 1),
    );
    eq('T2.d los hijos procesan exactamente 200 tickets', processed.length, 200);
    eq('T2.e no hay tickets repetidos entre hijos', new Set(processed).size, 200);
    eq('T2.f integrity_check devuelve ok', integrity, 'ok');

    console.log('\nT3 · RECLAMO DE STALE');
    const t3Run = store.startRun(db, { kind: 'test-stale', runUid: 't3-run' });
    store.enqueueScanTargets(db, t3Run, targets('stale', 1));
    const firstClaim = store.claimScanTarget(db, t3Run, { workerId: 'stale-owner' });
    db.prepare(`
      UPDATE scan_queue SET heartbeat_at = ?
      WHERE run_uid = ? AND ticket_workflow_id = ?
    `).run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      t3Run,
      firstClaim.ticketWorkflowId,
    );
    eq(
      'T3.a reclaimStaleScanTargets recupera una fila',
      store.reclaimStaleScanTargets(db, t3Run),
      1,
    );
    eq('T3.b el target vuelve a pending', store.scanQueueCounts(db, t3Run).pending, 1);
    const secondClaim = store.claimScanTarget(db, t3Run, { workerId: 'new-owner' });
    eq('T3.c otro worker puede reclamarlo', secondClaim.ticketWorkflowId, firstClaim.ticketWorkflowId);
    store.finishScanTarget(db, t3Run, secondClaim.ticketWorkflowId, { status: 'done' });

    console.log('\nT4 · REINTENTOS ACOTADOS');
    const t4Run = store.startRun(db, { kind: 'test-retries', runUid: 't4-run' });
    store.enqueueScanTargets(db, t4Run, targets('retry', 1));
    const attempts = [];
    for (let index = 0; index < 3; index += 1) {
      const claim = store.claimScanTarget(db, t4Run, {
        workerId: `retry-worker-${index}`,
        maxAttempts: 3,
      });
      attempts.push(claim?.attempts ?? null);
      store.finishScanTarget(db, t4Run, claim.ticketWorkflowId, {
        status: 'failed',
        error: `falla ${index + 1}`,
      });
    }
    eq('T4.a los intentos crecen hasta el máximo', attempts, [1, 2, 3]);
    eq(
      'T4.b al llegar al máximo no vuelve a claimear',
      store.claimScanTarget(db, t4Run, { workerId: 'retry-final', maxAttempts: 3 }),
      null,
    );
    eq('T4.c ya no figura como retryable', store.scanQueueCounts(db, t4Run, 3).retryable, 0);

    console.log('\nT5 · AISLAMIENTO POR CORRIDA');
    const runA = store.startRun(db, { kind: 'test-isolation', runUid: 't5-run-a' });
    const runB = store.startRun(db, { kind: 'test-isolation', runUid: 't5-run-b' });
    store.enqueueScanTargets(db, runA, targets('run-a', 2));
    store.enqueueScanTargets(db, runB, targets('run-b', 3));
    store.upsertTickets(db, runA, [
      { ticketWorkflowId: 'observation-a', title: 'Sólo A' },
    ]);
    store.upsertTickets(db, runB, [
      { ticketWorkflowId: 'observation-b-1', title: 'Sólo B1' },
      { ticketWorkflowId: 'observation-b-2', title: 'Sólo B2' },
    ]);
    eq('T5.a el conteo de A no suma B', store.scanQueueCounts(db, runA).total, 2);
    eq('T5.b el conteo de B no suma A', store.scanQueueCounts(db, runB).total, 3);
    eq(
      'T5.c runTickets de A devuelve sólo A',
      store.runTickets(db, runA).map((ticket) => ticket.ticketWorkflowId),
      ['observation-a'],
    );
    eq(
      'T5.d runTickets de B devuelve sólo B',
      store.runTickets(db, runB).map((ticket) => ticket.ticketWorkflowId),
      ['observation-b-1', 'observation-b-2'],
    );

    ok(
      'AISLAMIENTO · las bases están dentro del temporal',
      dbFile.startsWith(`${testRoot}${path.sep}`)
        && concurrencyDbFile.startsWith(`${testRoot}${path.sep}`),
      { testRoot, dbFile, concurrencyDbFile },
    );
  } catch (error) {
    fail++;
    console.log(`❌ ejecución completa sin excepciones\n   detalle: ${error?.stack || error}`);
  } finally {
    try { db?.close(); } catch { /* ya estaba cerrada */ }
    fs.rmSync(testRoot, { recursive: true, force: true });
    eq('LIMPIEZA · el directorio temporal fue borrado', fs.existsSync(testRoot), false);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} tolkien-workers: ${pass} pass / ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
}

await main();
