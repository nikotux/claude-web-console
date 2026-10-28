import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { resolveDataDir } from '../../core/data-dir.js';

const SCHEMA_VERSION = 1;
const DEFAULT_RAW_RETENTION_HOURS = 48;
const ROLLUP_TABLES = new Set(['rollup_hourly', 'rollup_daily']);

let database;
let databasePath;
const workerExistsStatements = new WeakMap();

function moduleDataDir() {
  return path.join(resolveDataDir(), 'mikrotik');
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  db.transaction(() => {
    const current = db.prepare(
      'SELECT version FROM schema_version WHERE id = 1',
    ).get()?.version ?? 0;

    if (current < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workers (
          id INTEGER PRIMARY KEY,
          wg_public_key TEXT UNIQUE,
          peer_name TEXT,
          display_name TEXT,
          ip TEXT,
          leader_id INTEGER NULL,
          active INTEGER DEFAULT 1,
          first_seen TEXT,
          last_seen TEXT
        );

        CREATE TABLE IF NOT EXISTS samples (
          id INTEGER PRIMARY KEY,
          worker_id INTEGER,
          ts TEXT,
          status TEXT,
          rtt_avg REAL,
          rtt_min REAL,
          rtt_max REAL,
          jitter REAL,
          stdev REAL,
          loss_percent REAL,
          loss_count INTEGER,
          sent_count INTEGER,
          response_count INTEGER,
          done_tests INTEGER,
          source TEXT,
          FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS samples_worker_ts
          ON samples (worker_id, ts);

        CREATE TABLE IF NOT EXISTS gaps (
          id INTEGER PRIMARY KEY,
          worker_id INTEGER NULL,
          started_at TEXT,
          ended_at TEXT,
          reason TEXT,
          FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS rollup_hourly (
          worker_id INTEGER,
          bucket TEXT,
          samples INTEGER,
          rtt_p50 REAL,
          rtt_p95 REAL,
          rtt_max REAL,
          jitter_avg REAL,
          loss_avg REAL,
          down_count INTEGER,
          down_minutes INTEGER,
          UNIQUE (worker_id, bucket)
        );

        CREATE TABLE IF NOT EXISTS rollup_daily (
          worker_id INTEGER,
          bucket TEXT,
          samples INTEGER,
          rtt_p50 REAL,
          rtt_p95 REAL,
          rtt_max REAL,
          jitter_avg REAL,
          loss_avg REAL,
          down_count INTEGER,
          down_minutes INTEGER,
          UNIQUE (worker_id, bucket)
        );
      `);
    }

    if (current < SCHEMA_VERSION) {
      db.prepare(`
        INSERT INTO schema_version (id, version, applied_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          applied_at = excluded.applied_at
      `).run(SCHEMA_VERSION, new Date().toISOString());
    }
  }).immediate();
}

export function openDb() {
  const dataDir = moduleDataDir();
  const nextDatabasePath = path.join(dataDir, 'monitor.db');
  if (database?.open && databasePath === nextDatabasePath) return database;
  if (database?.open) database.close();

  fs.mkdirSync(dataDir, { recursive: true });
  database = new Database(nextDatabasePath, { timeout: 5_000 });
  databasePath = nextDatabasePath;
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  // SQLite desactiva el enforcement de claves foráneas por defecto en cada conexión.
  database.pragma('foreign_keys = ON');
  migrate(database);
  return database;
}

function value(input, camelName, snakeName = camelName) {
  return input[camelName] ?? input[snakeName] ?? null;
}

export function upsertWorker(worker) {
  const db = openDb();
  const now = new Date().toISOString();
  const publicKey = value(worker, 'wgPublicKey', 'wg_public_key');
  const activeExplicit = worker.active !== undefined && worker.active !== null;

  if (!publicKey) throw new TypeError('wg_public_key es obligatorio');

  const result = db.prepare(`
    INSERT INTO workers (
      wg_public_key, peer_name, display_name, ip, leader_id,
      active, first_seen, last_seen
    ) VALUES (
      @wgPublicKey, @peerName, @displayName, @ip, @leaderId,
      COALESCE(@active, 1), @firstSeen, @lastSeen
    )
    ON CONFLICT(wg_public_key) DO UPDATE SET
      peer_name = COALESCE(excluded.peer_name, workers.peer_name),
      display_name = COALESCE(excluded.display_name, workers.display_name),
      ip = COALESCE(excluded.ip, workers.ip),
      leader_id = COALESCE(excluded.leader_id, workers.leader_id),
      active = COALESCE(@active, workers.active),
      last_seen = excluded.last_seen
  `).run({
    wgPublicKey: publicKey,
    peerName: value(worker, 'peerName', 'peer_name'),
    displayName: value(worker, 'displayName', 'display_name'),
    ip: value(worker, 'ip'),
    leaderId: value(worker, 'leaderId', 'leader_id'),
    active: activeExplicit ? Number(Boolean(worker.active)) : null,
    firstSeen: value(worker, 'firstSeen', 'first_seen') ?? now,
    lastSeen: value(worker, 'lastSeen', 'last_seen') ?? now,
  });

  return db.prepare('SELECT * FROM workers WHERE wg_public_key = ?').get(publicKey)
    ?? { id: Number(result.lastInsertRowid) };
}

export function listWorkers() {
  return openDb().prepare(
    'SELECT * FROM workers ORDER BY active DESC, display_name, peer_name, id',
  ).all();
}

function assertWorkerExists(db, workerId, { nullable = false } = {}) {
  if (nullable && (workerId === null || workerId === undefined)) return;

  let statement = workerExistsStatements.get(db);
  if (!statement) {
    statement = db.prepare('SELECT 1 FROM workers WHERE id = ?');
    workerExistsStatements.set(db, statement);
  }
  if (!statement.get(workerId)) {
    throw new TypeError(`worker_id ${workerId} no existe en workers`);
  }
}

function insertSampleWithDb(db, sample) {
  const workerId = value(sample, 'workerId', 'worker_id');
  const rawTs = value(sample, 'ts') ?? Date.now();
  const parsedTs = new Date(rawTs);
  if (Number.isNaN(parsedTs.getTime())) throw new TypeError('ts inválido');
  // Las bases existentes no se recrean para sumar la FK; esta capa también las protege.
  assertWorkerExists(db, workerId);

  const result = db.prepare(`
    INSERT INTO samples (
      worker_id, ts, status, rtt_avg, rtt_min, rtt_max, jitter, stdev,
      loss_percent, loss_count, sent_count, response_count, done_tests, source
    ) VALUES (
      @workerId, @ts, @status, @rttAvg, @rttMin, @rttMax, @jitter, @stdev,
      @lossPercent, @lossCount, @sentCount, @responseCount, @doneTests, @source
    )
  `).run({
    workerId,
    ts: parsedTs.toISOString(),
    status: value(sample, 'status'),
    rttAvg: value(sample, 'rttAvg', 'rtt_avg'),
    rttMin: value(sample, 'rttMin', 'rtt_min'),
    rttMax: value(sample, 'rttMax', 'rtt_max'),
    jitter: value(sample, 'jitter'),
    stdev: value(sample, 'stdev'),
    lossPercent: value(sample, 'lossPercent', 'loss_percent'),
    lossCount: value(sample, 'lossCount', 'loss_count'),
    sentCount: value(sample, 'sentCount', 'sent_count'),
    responseCount: value(sample, 'responseCount', 'response_count'),
    doneTests: value(sample, 'doneTests', 'done_tests'),
    source: value(sample, 'source'),
  });

  return Number(result.lastInsertRowid);
}

export function insertSample(sample) {
  return insertSampleWithDb(openDb(), sample);
}

export function insertSamples(samples) {
  if (!Array.isArray(samples)) throw new TypeError('insertSamples espera un array');

  const db = openDb();
  return db.transaction(
    (items) => items.map((sample) => insertSampleWithDb(db, sample)),
  )(samples);
}

export function recordGap(gap) {
  const db = openDb();
  const workerId = value(gap, 'workerId', 'worker_id');
  assertWorkerExists(db, workerId, { nullable: true });

  const result = db.prepare(`
    INSERT INTO gaps (worker_id, started_at, ended_at, reason)
    VALUES (@workerId, @startedAt, @endedAt, @reason)
  `).run({
    workerId,
    startedAt: value(gap, 'startedAt', 'started_at'),
    endedAt: value(gap, 'endedAt', 'ended_at'),
    reason: value(gap, 'reason'),
  });
  return Number(result.lastInsertRowid);
}

export function querySamples({ workerId, from, to } = {}) {
  const conditions = [];
  const params = {};

  if (workerId !== undefined && workerId !== null) {
    conditions.push('worker_id = @workerId');
    params.workerId = workerId;
  }
  if (from) {
    conditions.push('ts >= @from');
    params.from = from;
  }
  if (to) {
    conditions.push('ts < @to');
    params.to = to;
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return openDb().prepare(`SELECT * FROM samples${where} ORDER BY ts, id`).all(params);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * quantile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  if (!fraction) return ordered[lower];
  return ordered[lower] + (ordered[lower + 1] - ordered[lower]) * fraction;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function normalizedBucket(bucket, unit) {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Bucket ${unit} inválido`);

  if (unit === 'hour') {
    date.setUTCMinutes(0, 0, 0);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  return date;
}

function nextBucket(start, unit) {
  const end = new Date(start);
  if (unit === 'hour') end.setUTCHours(end.getUTCHours() + 1);
  else end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

function aggregateSamples(rows) {
  const rtt = rows.map((row) => row.rtt_avg).filter(Number.isFinite);
  const jitter = rows.map((row) => row.jitter).filter(Number.isFinite);
  const loss = rows.map((row) => row.loss_percent).filter(Number.isFinite);
  const down = rows.filter((row) => row.status === 'caido');
  const downMinutes = new Set(down.map((row) => row.ts.slice(0, 16))).size;

  return {
    samples: rows.length,
    rttP50: percentile(rtt, 0.5),
    rttP95: percentile(rtt, 0.95),
    rttMax: rtt.length ? Math.max(...rtt) : null,
    jitterAvg: average(jitter),
    lossAvg: average(loss),
    downCount: down.length,
    downMinutes,
  };
}

function rollup(bucket, unit, table) {
  // La allowlist mantiene segura esta interpolación si futuros callers pasan la tabla.
  if (!ROLLUP_TABLES.has(table)) throw new TypeError(`Tabla de rollup inválida: ${table}`);

  const db = openDb();
  const start = normalizedBucket(bucket, unit);
  const end = nextBucket(start, unit);
  const bucketText = start.toISOString();
  const rows = db.prepare(`
    SELECT * FROM samples
    WHERE ts >= ? AND ts < ?
    ORDER BY worker_id, ts, id
  `).all(bucketText, end.toISOString());
  const byWorker = new Map();

  for (const row of rows) {
    const workerRows = byWorker.get(row.worker_id) ?? [];
    workerRows.push(row);
    byWorker.set(row.worker_id, workerRows);
  }

  const save = db.prepare(`
    INSERT INTO ${table} (
      worker_id, bucket, samples, rtt_p50, rtt_p95, rtt_max,
      jitter_avg, loss_avg, down_count, down_minutes
    ) VALUES (
      @workerId, @bucket, @samples, @rttP50, @rttP95, @rttMax,
      @jitterAvg, @lossAvg, @downCount, @downMinutes
    )
    ON CONFLICT(worker_id, bucket) DO UPDATE SET
      samples = excluded.samples,
      rtt_p50 = excluded.rtt_p50,
      rtt_p95 = excluded.rtt_p95,
      rtt_max = excluded.rtt_max,
      jitter_avg = excluded.jitter_avg,
      loss_avg = excluded.loss_avg,
      down_count = excluded.down_count,
      down_minutes = excluded.down_minutes
  `);

  return db.transaction(() => {
    const results = [];
    for (const [workerId, workerRows] of byWorker) {
      const summary = { workerId, bucket: bucketText, ...aggregateSamples(workerRows) };
      save.run(summary);
      results.push(summary);
    }
    return results;
  })();
}

export function rollupHour(bucket) {
  return rollup(bucket, 'hour', 'rollup_hourly');
}

export function rollupDay(bucket) {
  return rollup(bucket, 'day', 'rollup_daily');
}

export function pruneRaw(retentionHours = DEFAULT_RAW_RETENTION_HOURS) {
  if (!Number.isFinite(retentionHours) || retentionHours < 0) {
    throw new TypeError('retentionHours debe ser un número no negativo');
  }
  const db = openDb();
  const safeRetentionHours = Math.max(1, retentionHours);
  const retentionCutoff = new Date(
    Date.now() - safeRetentionHours * 60 * 60 * 1_000,
  ).toISOString();
  const lastRollup = db.prepare(
    'SELECT MAX(bucket) AS bucket FROM rollup_hourly',
  ).get()?.bucket;
  if (!lastRollup) return 0;

  const cutoff = retentionCutoff < lastRollup ? retentionCutoff : lastRollup;
  return db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff).changes;
}

export function closeDb() {
  if (database?.open) database.close();
  database = undefined;
  databasePath = undefined;
}
