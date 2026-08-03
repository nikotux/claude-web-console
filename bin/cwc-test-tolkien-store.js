#!/usr/bin/env node
// Test funcional, determinista y aislado del store local de Tolkien.
// No toca ~/.cwc-data ni usa el SDK. Uso: node bin/cwc-test-tolkien-store.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};

async function workerMain() {
  const worker = argumentValue('--worker');
  const dbFile = argumentValue('--db');
  if (worker === null || dbFile === null) throw new Error('worker sin --worker o --db');
  const db = store.openStore(dbFile);
  try {
    const runUid = store.startRun(db, { kind: 'concurrency-worker' });
    for (let index = 0; index < 50; index += 1) {
      store.recordOp(db, {
        runUid,
        ticketWorkflowId: `w${worker}-op${index}`,
        workKey: `WORK-${worker}-${index}`,
        phase: 'worker',
        outcome: 'ok',
        reason: null,
        before: { worker: Number(worker), index },
        after: { worker: Number(worker), index, done: true },
        payload: { unique: `${worker}-${index}` },
        actor: `worker-${worker}`,
      });
    }
    for (let index = 0; index < 25; index += 1) {
      store.upsertTickets(db, runUid, [{
        ticketWorkflowId: `w${worker}-t${index}`,
        workKey: `WORK-W${worker}-${index}`,
        workNumber: `WORK-W${worker}-${index}`,
        title: `Ticket ${worker}/${index}`,
        executionState: 'active',
        hasDesiredOutcome: false,
        isWaiting: false,
        url: `https://example.test/w${worker}-t${index}`,
      }]);
    }
    store.finishRun(db, runUid, { counts: { ops: 50, tickets: 25 } });
  } finally {
    db.close();
  }
}

function syntheticTickets() {
  return [0, 1, 2].map((index) => ({
    ticketWorkflowId: `ticket-${index}`,
    workNumber: `WORK-${index}`,
    workKey: `WORK-${index}`,
    title: `Ticket ${index}`,
    executionState: 'active',
    deskTicketNumber: String(700 + index),
    deskTicketId: String(9000 + index),
    hasDesiredOutcome: index !== 0,
    desiredOutcome: index === 0 ? null : `Outcome ${index}`,
    isWaiting: index === 2,
    assignee: 'Tester',
    priority: 'normal',
    bucketKey: 'test',
    targetAt: '2026-08-01',
    externalCommitmentAt: null,
    createdAt: '2026-07-01',
    lastMovementAt: '2026-07-30',
    lastMovement: 'Movimiento',
    url: `https://example.test/ticket-${index}`,
    extraField: { survives: true, index },
  }));
}

function reconcileFixture(prefix = 'reconcile') {
  const entries = (bucket, count) => Array.from({ length: count }, (_, index) => ({
    ticketWorkflowId: `${prefix}-${bucket}-${index}`,
    workKey: `WORK-${bucket}-${index}`,
    reason: bucket === 'closable' ? null : `${bucket}-reason`,
    detail: `Detalle ${bucket} ${index}`,
    deskTicketId: `${bucket}-desk-${index}`,
    deskTicketNumber: `${800 + index}`,
    zoho: {
      status: bucket === 'realOpen' ? 'Open' : 'Closed',
      statusType: bucket === 'realOpen' ? 'Open' : 'Closed',
      closedTime: bucket === 'realOpen' ? null : '2026-07-31T10:00:00.000Z',
    },
    evidenceSummary: bucket === 'closable' ? `Evidencia ${index}` : null,
    desiredOutcomeProposal: bucket === 'closable' ? `Propuesta ${index}` : null,
  }));
  return {
    generatedAt: '2026-07-31T12:00:00.000Z',
    viewerEmail: 'tester@example.test',
    counts: { total: 6, closable: 2, realOpen: 3, unpaired: 1 },
    closable: entries('closable', 2),
    realOpen: entries('realOpen', 3),
    unpaired: entries('unpaired', 1),
  };
}

function spawnWorker(scriptFile, dbFile, worker) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      scriptFile,
      '--worker',
      String(worker),
      '--db',
      dbFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ worker, code: null, stderr, error: error.message }));
    child.on('close', (code) => resolve({ worker, code, stderr }));
  });
}

async function parentMain() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-tolkien-store-'));
  const dbFile = path.join(testRoot, 'state.db');
  let db = null;
  try {
    console.log('\nT1 · ESQUEMA');
    db = store.openStore(dbFile);
    eq('T1.a openStore crea el archivo', fs.existsSync(dbFile), true);
    eq('T1.b journal_mode queda en WAL', db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    eq('T1.c existen las 8 tablas', tables, [
      'meta',
      'ops',
      'reconcile',
      'runs',
      'scan_queue',
      'schema_snapshot',
      'ticket_observations',
      'tickets',
    ]);
    eq(
      'T1.d meta.store_schema_version es 1',
      db.prepare(`SELECT value FROM meta WHERE key = 'store_schema_version'`).get()?.value,
      '1',
    );
    db.close();
    db = store.openStore(dbFile);
    eq('T1.e reabrir conserva el esquema idempotente', db.prepare(`SELECT COUNT(*) AS count FROM meta`).get().count, 1);

    console.log('\nT2 · UPSERT');
    const firstRun = store.startRun(db, { kind: 'census' });
    const tickets = syntheticTickets();
    eq('T2.a inserta tres tickets', store.upsertTickets(db, firstRun, tickets), { inserted: 3, skipped: 0 });
    store.finishRun(db, firstRun, { counts: { total: 3 } });
    eq('T2.b tickets contiene 3 filas', db.prepare(`SELECT COUNT(*) AS count FROM tickets`).get().count, 3);
    const secondRun = store.startRun(db, { kind: 'census' });
    const changed = tickets.map((ticket, index) => ({
      ...ticket,
      title: index === 1 ? 'Ticket uno actualizado' : ticket.title,
    }));
    store.upsertTickets(db, secondRun, changed);
    store.finishRun(db, secondRun, { counts: { total: 3 } });
    eq('T2.c el segundo upsert no duplica tickets', db.prepare(`SELECT COUNT(*) AS count FROM tickets`).get().count, 3);
    const updated = db.prepare(`
      SELECT title, first_seen_run FROM tickets WHERE ticket_workflow_id = 'ticket-1'
    `).get();
    eq('T2.d el campo cambió', updated.title, 'Ticket uno actualizado');
    eq('T2.e first_seen_run conserva la corrida original', updated.first_seen_run, firstRun);
    eq(
      'T2.f hay 6 observaciones para dos corridas por tres tickets',
      db.prepare(`SELECT COUNT(*) AS count FROM ticket_observations`).get().count,
      6,
    );

    console.log('\nT3 · RECONCILE');
    const reconcileRun = store.startRun(db, { kind: 'reconcile' });
    const reconciliation = reconcileFixture();
    eq(
      'T3.a recordReconcile devuelve los conteos por pila',
      store.recordReconcile(db, reconcileRun, reconciliation, reconciliation.generatedAt),
      { closable: 2, realOpen: 3, unpaired: 1 },
    );
    store.finishRun(db, reconcileRun, { counts: reconciliation.counts });
    eq(
      'T3.b storeStats devuelve la última distribución exacta',
      store.storeStats(db).bucketCounts,
      { closable: 2, realOpen: 3, unpaired: 1 },
    );

    console.log('\nT4 · OPS');
    const opsRun = store.startRun(db, { kind: 'close' });
    for (let index = 0; index < 4; index += 1) {
      store.recordOp(db, {
        runUid: opsRun,
        ticketWorkflowId: `ticket-${index}`,
        workKey: `WORK-${index}`,
        phase: index % 2 === 0 ? 'set_outcome' : 'close',
        outcome: 'ok',
        reason: null,
        before: { value: index },
        after: { value: index + 1 },
        payload: { test: true },
        actor: 'tester@example.test',
      });
    }
    store.finishRun(db, opsRun, { counts: { recorded: 4 } });
    eq('T4.a registra 4 ops', db.prepare(`SELECT COUNT(*) AS count FROM ops`).get().count, 4);
    const op = db.prepare(`SELECT before_json, after_json FROM ops ORDER BY rowid LIMIT 1`).get();
    eq('T4.b before_json round-tripea', JSON.parse(op.before_json), { value: 0 });
    eq('T4.c after_json round-tripea', JSON.parse(op.after_json), { value: 1 });

    console.log('\nT5 · SCHEMA SNAPSHOT');
    const snapshotA = { version: 1, fields: { b: 'text', a: 'number' } };
    const snapshotAReordered = { fields: { a: 'number', b: 'text' }, version: 1 };
    const snapshotB = { version: 2, fields: { a: 'number', b: 'text' } };
    const firstSnapshot = store.recordSchemaSnapshot(db, { source: 'tolkien', snapshot: snapshotA });
    const sameSnapshot = store.recordSchemaSnapshot(db, { source: 'tolkien', snapshot: snapshotAReordered });
    const differentSnapshot = store.recordSchemaSnapshot(db, { source: 'tolkien', snapshot: snapshotB });
    eq('T5.a el mismo snapshot estable da el mismo fingerprint', sameSnapshot.fingerprint, firstSnapshot.fingerprint);
    eq('T5.b el segundo snapshot igual no cambió', sameSnapshot.changed, false);
    eq('T5.c un snapshot distinto sí cambió', differentSnapshot.changed, true);

    console.log('\nT6 · MIGRACIÓN IDEMPOTENTE');
    const censusFile = path.join(testRoot, 'census.json');
    const reconcileFile = path.join(testRoot, 'reconcile.json');
    const opsDir = path.join(testRoot, 'ops-import');
    const censusSource = {
      generatedAt: '2026-07-30T10:00:00.000Z',
      viewerEmail: 'import@example.test',
      count: 2,
      tickets: syntheticTickets().slice(0, 2).map((ticket, index) => ({
        ...ticket,
        ticketWorkflowId: `import-ticket-${index}`,
      })),
    };
    const reconcileSource = reconcileFixture('import');
    fs.writeFileSync(censusFile, `${JSON.stringify(censusSource, null, 2)}\n`);
    fs.writeFileSync(reconcileFile, `${JSON.stringify(reconcileSource, null, 2)}\n`);
    const paths = { censusFile, reconcileFile, opsDir };
    const firstMigration = store.migrateFromJson(db, paths);
    eq('T6.a la primera migración se ejecuta', firstMigration.skipped, false);
    eq('T6.b importa los dos tickets del census', firstMigration.census.imported, 2);
    eq(
      'T6.c importa el reconcile sintético',
      {
        closable: firstMigration.reconcile.closable,
        realOpen: firstMigration.reconcile.realOpen,
        unpaired: firstMigration.reconcile.unpaired,
      },
      { closable: 2, realOpen: 3, unpaired: 1 },
    );
    const countsBeforeSecond = store.storeStats(db);
    const secondMigration = store.migrateFromJson(db, paths);
    eq('T6.d la segunda migración se salta', secondMigration, { skipped: true, reason: 'ya-importado' });
    const countsAfterSecond = store.storeStats(db);
    eq(
      'T6.e la segunda migración no duplica conteos',
      {
        tickets: countsAfterSecond.tickets,
        runs: countsAfterSecond.runs,
        reconcileRows: countsAfterSecond.reconcileRows,
        ops: countsAfterSecond.ops,
      },
      {
        tickets: countsBeforeSecond.tickets,
        runs: countsBeforeSecond.runs,
        reconcileRows: countsBeforeSecond.reconcileRows,
        ops: countsBeforeSecond.ops,
      },
    );
    eq('T6.f census.json sigue en disco', fs.existsSync(censusFile), true);
    eq('T6.g reconcile.json sigue en disco', fs.existsSync(reconcileFile), true);

    console.log('\nT7 · CONCURRENCIA REAL');
    const concurrencyDb = path.join(testRoot, 'concurrency.db');
    const initialized = store.openStore(concurrencyDb);
    initialized.close();
    const scriptFile = fileURLToPath(import.meta.url);
    const workerResults = await Promise.all(
      Array.from({ length: 8 }, (_, worker) => spawnWorker(scriptFile, concurrencyDb, worker)),
    );
    const successfulWorkers = workerResults.filter((result) => result.code === 0).length;
    const concurrencyStore = store.openStore(concurrencyDb);
    const realOps = Number(concurrencyStore.prepare(`SELECT COUNT(*) AS count FROM ops`).get().count);
    const realTickets = Number(
      concurrencyStore.prepare(`SELECT COUNT(*) AS count FROM tickets`).get().count,
    );
    const uniqueOps = Number(
      concurrencyStore.prepare(`SELECT COUNT(DISTINCT op_uid) AS count FROM ops`).get().count,
    );
    const integrity = concurrencyStore.prepare('PRAGMA integrity_check').get().integrity_check;
    concurrencyStore.close();
    console.log(
      `T7 números reales: hijos=${successfulWorkers}/8 · ops=${realOps} · `
        + `tickets=${realTickets} · op_uid únicos=${uniqueOps} · integrity_check=${integrity}`,
    );
    eq('T7.a los 8 procesos hijo terminaron con código 0', successfulWorkers, 8);
    ok(
      'T7.b ningún proceso hijo informó errores',
      workerResults.every((result) => !result.stderr && !result.error),
      workerResults,
    );
    eq('T7.c hay exactamente 400 ops', realOps, 400);
    eq('T7.d hay exactamente 200 tickets', realTickets, 200);
    eq('T7.e los 400 op_uid son únicos', uniqueOps, 400);
    eq('T7.f integrity_check devuelve ok', integrity, 'ok');

    ok(
      'AISLAMIENTO · las dos bases están dentro del temporal',
      dbFile.startsWith(`${testRoot}${path.sep}`)
        && concurrencyDb.startsWith(`${testRoot}${path.sep}`),
      { testRoot, dbFile, concurrencyDb },
    );
  } catch (error) {
    fail++;
    console.log(`❌ ejecución completa sin excepciones\n   detalle: ${error?.stack || error}`);
  } finally {
    try { db?.close(); } catch { /* ya estaba cerrada */ }
    fs.rmSync(testRoot, { recursive: true, force: true });
    eq('LIMPIEZA · el directorio temporal fue borrado', fs.existsSync(testRoot), false);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} tolkien-store: ${pass} pass / ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
}

if (process.argv.includes('--worker')) {
  try {
    await workerMain();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
} else {
  await parentMain();
}
