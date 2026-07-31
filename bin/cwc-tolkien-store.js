import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_uid      TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      status       TEXT NOT NULL,
      viewer_email TEXT,
      scope_json   TEXT,
      counts_json  TEXT,
      pid          INTEGER,
      error        TEXT
    );

    CREATE TABLE IF NOT EXISTS tickets (
      ticket_workflow_id     TEXT PRIMARY KEY,
      work_key               TEXT,
      work_number            TEXT,
      title                  TEXT,
      url                    TEXT,
      execution_state        TEXT,
      desk_ticket_id         TEXT,
      desk_ticket_number     TEXT,
      has_desired_outcome    INTEGER,
      desired_outcome        TEXT,
      is_waiting             INTEGER,
      assignee               TEXT,
      priority               TEXT,
      bucket_key             TEXT,
      target_at              TEXT,
      external_commitment_at TEXT,
      created_at             TEXT,
      last_movement_at       TEXT,
      last_movement          TEXT,
      scrape_error           TEXT,
      raw_json               TEXT NOT NULL,
      first_seen_run         TEXT,
      last_seen_run          TEXT NOT NULL,
      updated_at             TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_observations (
      run_uid            TEXT NOT NULL,
      ticket_workflow_id TEXT NOT NULL,
      observed_at        TEXT NOT NULL,
      raw_json           TEXT NOT NULL,
      PRIMARY KEY (run_uid, ticket_workflow_id)
    );

    CREATE TABLE IF NOT EXISTS reconcile (
      run_uid                  TEXT NOT NULL,
      ticket_workflow_id       TEXT NOT NULL,
      bucket                   TEXT NOT NULL,
      reason                   TEXT,
      detail                   TEXT,
      desk_ticket_id           TEXT,
      desk_ticket_number       TEXT,
      zoho_status              TEXT,
      zoho_status_type         TEXT,
      zoho_closed_time         TEXT,
      evidence_summary         TEXT,
      desired_outcome_proposal TEXT,
      entry_json               TEXT NOT NULL,
      observed_at              TEXT NOT NULL,
      PRIMARY KEY (run_uid, ticket_workflow_id)
    );

    CREATE TABLE IF NOT EXISTS ops (
      op_uid             TEXT PRIMARY KEY,
      run_uid            TEXT NOT NULL,
      ticket_workflow_id TEXT,
      work_key           TEXT,
      phase              TEXT NOT NULL,
      outcome            TEXT NOT NULL,
      reason             TEXT,
      before_json        TEXT,
      after_json         TEXT,
      payload_json       TEXT,
      actor              TEXT,
      pid                INTEGER,
      at                 TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_snapshot (
      snapshot_uid   TEXT PRIMARY KEY,
      run_uid        TEXT,
      captured_at    TEXT NOT NULL,
      source         TEXT NOT NULL,
      schema_version TEXT,
      fingerprint    TEXT NOT NULL,
      snapshot_json  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reconcile_bucket
      ON reconcile(bucket);
    CREATE INDEX IF NOT EXISTS idx_reconcile_ticket_workflow_id
      ON reconcile(ticket_workflow_id);
    CREATE INDEX IF NOT EXISTS idx_ops_ticket_workflow_id
      ON ops(ticket_workflow_id);
    CREATE INDEX IF NOT EXISTS idx_ops_run_uid
      ON ops(run_uid);
    CREATE INDEX IF NOT EXISTS idx_ticket_observations_ticket_workflow_id
      ON ticket_observations(ticket_workflow_id);
    CREATE INDEX IF NOT EXISTS idx_schema_snapshot_fingerprint
      ON schema_snapshot(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_runs_kind_started_at
      ON runs(kind, started_at);
  `);
  db.prepare(`
    INSERT OR IGNORE INTO meta (key, value)
    VALUES ('store_schema_version', '1')
  `).run();
}

export function openStore(dbFile) {
  const dir = path.dirname(dbFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const db = new DatabaseSync(dbFile);

  // WAL permite N lectores concurrentes con un escritor. El busy_timeout hace
  // que otro escritor espere el lock en vez de fallar apenas lo encuentra.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 15000;');

  fs.chmodSync(dbFile, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (fs.existsSync(`${dbFile}${suffix}`)) fs.chmodSync(`${dbFile}${suffix}`, 0o600);
    } catch {
      // Los archivos auxiliares pueden desaparecer entre existsSync y chmod.
    }
  }
  ensureSchema(db);
  return db;
}

function lockError(error) {
  const detail = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|busy/i.test(detail);
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withWrite(db, fn, { attempts = 6, baseDelayMs = 50 } = {}) {
  let lastError = null;
  const totalAttempts = Math.max(1, attempts);
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      // IMMEDIATE toma el lock de escritura al abrir: el conflicto aparece al
      // principio y no a mitad de una transacción que ya hizo trabajo.
      db.exec('BEGIN IMMEDIATE;');
      const result = fn(db);
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // La transacción puede haber terminado junto con el error original.
      }
      if (!lockError(error)) throw error;
      lastError = error;
      if (attempt + 1 < totalAttempts) {
        const backoff = baseDelayMs * (2 ** attempt);
        const jitter = Math.floor(Math.random() * (baseDelayMs + 1));
        waitSync(backoff + jitter);
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const exhausted = new Error(
    `La base siguió bloqueada después de ${totalAttempts} intentos: ${detail}`,
    { cause: lastError },
  );
  if (lastError?.code) exhausted.code = lastError.code;
  throw exhausted;
}

export function newUid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function fingerprint(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function jsonOrNull(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function startRun(
  db,
  { kind, viewerEmail = null, scope = null, runUid = newUid(kind) },
) {
  const startedAt = new Date().toISOString();
  withWrite(db, (writeDb) => {
    writeDb.prepare(`
      INSERT INTO runs (
        run_uid, kind, started_at, status, viewer_email, scope_json, pid
      ) VALUES (?, ?, ?, 'running', ?, ?, ?)
    `).run(runUid, kind, startedAt, viewerEmail, jsonOrNull(scope), process.pid);
  });
  return runUid;
}

export function finishRun(
  db,
  runUid,
  { status = 'done', counts = null, error = null } = {},
) {
  return withWrite(db, (writeDb) => writeDb.prepare(`
    UPDATE runs
    SET finished_at = ?, status = ?, counts_json = ?, error = ?
    WHERE run_uid = ?
  `).run(new Date().toISOString(), status, jsonOrNull(counts), error, runUid));
}

export function upsertTickets(db, runUid, tickets, observedAt = new Date().toISOString()) {
  return withWrite(db, (writeDb) => {
    const upsert = writeDb.prepare(`
      INSERT INTO tickets (
        ticket_workflow_id, work_key, work_number, title, url,
        execution_state, desk_ticket_id, desk_ticket_number,
        has_desired_outcome, desired_outcome, is_waiting, assignee, priority,
        bucket_key, target_at, external_commitment_at, created_at,
        last_movement_at, last_movement, scrape_error, raw_json,
        first_seen_run, last_seen_run, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(ticket_workflow_id) DO UPDATE SET
        work_key = excluded.work_key,
        work_number = excluded.work_number,
        title = excluded.title,
        url = excluded.url,
        execution_state = excluded.execution_state,
        desk_ticket_id = excluded.desk_ticket_id,
        desk_ticket_number = excluded.desk_ticket_number,
        has_desired_outcome = excluded.has_desired_outcome,
        desired_outcome = excluded.desired_outcome,
        is_waiting = excluded.is_waiting,
        assignee = excluded.assignee,
        priority = excluded.priority,
        bucket_key = excluded.bucket_key,
        target_at = excluded.target_at,
        external_commitment_at = excluded.external_commitment_at,
        created_at = excluded.created_at,
        last_movement_at = excluded.last_movement_at,
        last_movement = excluded.last_movement,
        scrape_error = excluded.scrape_error,
        raw_json = excluded.raw_json,
        first_seen_run = COALESCE(tickets.first_seen_run, excluded.first_seen_run),
        last_seen_run = excluded.last_seen_run,
        updated_at = excluded.updated_at
    `);
    const observe = writeDb.prepare(`
      INSERT OR REPLACE INTO ticket_observations (
        run_uid, ticket_workflow_id, observed_at, raw_json
      ) VALUES (?, ?, ?, ?)
    `);
    let inserted = 0;
    let skipped = 0;
    for (const ticket of tickets) {
      if (!ticket?.ticketWorkflowId) {
        skipped += 1;
        continue;
      }
      const raw = JSON.stringify(ticket);
      upsert.run(
        ticket.ticketWorkflowId,
        ticket.workKey ?? null,
        ticket.workNumber ?? null,
        ticket.title ?? null,
        ticket.url ?? null,
        ticket.executionState ?? null,
        ticket.deskTicketId ?? null,
        ticket.deskTicketNumber ?? null,
        ticket.hasDesiredOutcome ? 1 : 0,
        ticket.desiredOutcome ?? null,
        ticket.isWaiting ? 1 : 0,
        ticket.assignee ?? null,
        ticket.priority ?? null,
        ticket.bucketKey ?? null,
        ticket.targetAt ?? null,
        ticket.externalCommitmentAt ?? null,
        ticket.createdAt ?? null,
        ticket.lastMovementAt ?? null,
        ticket.lastMovement ?? null,
        ticket.error ?? null,
        raw,
        runUid,
        runUid,
        observedAt,
      );
      observe.run(runUid, ticket.ticketWorkflowId, observedAt, raw);
      inserted += 1;
    }
    return { inserted, skipped };
  });
}

export function recordReconcile(db, runUid, result, observedAt) {
  const at = observedAt ?? result.generatedAt ?? new Date().toISOString();
  return withWrite(db, (writeDb) => {
    const insert = writeDb.prepare(`
      INSERT OR REPLACE INTO reconcile (
        run_uid, ticket_workflow_id, bucket, reason, detail,
        desk_ticket_id, desk_ticket_number, zoho_status, zoho_status_type,
        zoho_closed_time, evidence_summary, desired_outcome_proposal,
        entry_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const counts = { closable: 0, realOpen: 0, unpaired: 0 };
    for (const bucket of Object.keys(counts)) {
      const entries = Array.isArray(result?.[bucket]) ? result[bucket] : [];
      for (const entry of entries) {
        insert.run(
          runUid,
          entry.ticketWorkflowId,
          bucket,
          entry.reason ?? null,
          entry.detail ?? null,
          entry.deskTicketId ?? null,
          entry.deskTicketNumber ?? null,
          entry.zoho?.status ?? null,
          entry.zoho?.statusType ?? null,
          entry.zoho?.closedTime ?? null,
          entry.evidenceSummary ?? null,
          entry.desiredOutcomeProposal ?? null,
          JSON.stringify(entry),
          at,
        );
        counts[bucket] += 1;
      }
    }
    return counts;
  });
}

export function recordOp(
  db,
  {
    runUid,
    ticketWorkflowId = null,
    workKey = null,
    phase,
    outcome,
    reason = null,
    before = null,
    after = null,
    payload = null,
    actor = null,
  },
) {
  const opUid = newUid('op');
  const at = new Date().toISOString();
  withWrite(db, (writeDb) => {
    writeDb.prepare(`
      INSERT INTO ops (
        op_uid, run_uid, ticket_workflow_id, work_key, phase, outcome,
        reason, before_json, after_json, payload_json, actor, pid, at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opUid,
      runUid,
      ticketWorkflowId,
      workKey,
      phase,
      outcome,
      reason,
      jsonOrNull(before),
      jsonOrNull(after),
      jsonOrNull(payload),
      actor,
      process.pid,
      at,
    );
  });
  return opUid;
}

export function recordSchemaSnapshot(
  db,
  { runUid = null, source, schemaVersion = null, snapshot },
) {
  const snapshotUid = newUid('snap');
  const capturedAt = new Date().toISOString();
  const currentFingerprint = fingerprint(snapshot);
  const changed = withWrite(db, (writeDb) => {
    const previous = writeDb.prepare(`
      SELECT fingerprint
      FROM schema_snapshot
      WHERE source = ?
      ORDER BY captured_at DESC, rowid DESC
      LIMIT 1
    `).get(source);
    writeDb.prepare(`
      INSERT INTO schema_snapshot (
        snapshot_uid, run_uid, captured_at, source, schema_version,
        fingerprint, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotUid,
      runUid,
      capturedAt,
      source,
      schemaVersion,
      currentFingerprint,
      JSON.stringify(snapshot),
    );
    return !previous || previous.fingerprint !== currentFingerprint;
  });
  return { snapshotUid, fingerprint: currentFingerprint, changed };
}

function countTable(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

export function storeStats(db) {
  const latestRun = db.prepare(`
    SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 1
  `).get() ?? null;
  const latestReconcile = db.prepare(`
    SELECT run_uid
    FROM runs
    WHERE kind IN ('reconcile', 'import-reconcile')
      AND EXISTS (SELECT 1 FROM reconcile WHERE reconcile.run_uid = runs.run_uid)
    ORDER BY started_at DESC, rowid DESC
    LIMIT 1
  `).get();
  const bucketCounts = {};
  if (latestReconcile) {
    const rows = db.prepare(`
      SELECT bucket, COUNT(*) AS count
      FROM reconcile
      WHERE run_uid = ?
      GROUP BY bucket
    `).all(latestReconcile.run_uid);
    for (const row of rows) bucketCounts[row.bucket] = Number(row.count);
  }
  return {
    tickets: countTable(db, 'tickets'),
    runs: countTable(db, 'runs'),
    reconcileRows: countTable(db, 'reconcile'),
    ops: countTable(db, 'ops'),
    schemaSnapshots: countTable(db, 'schema_snapshot'),
    latestRun,
    bucketCounts,
  };
}

export function latestReconcileByBucket(db, bucket) {
  return db.prepare(`
    SELECT reconcile.*
    FROM reconcile
    JOIN runs ON runs.run_uid = reconcile.run_uid
    WHERE reconcile.bucket = ?
      AND reconcile.run_uid = (
        SELECT candidate.run_uid
        FROM reconcile AS candidate
        JOIN runs AS candidate_run ON candidate_run.run_uid = candidate.run_uid
        WHERE candidate.bucket = ?
        ORDER BY candidate_run.started_at DESC, candidate_run.rowid DESC
        LIMIT 1
      )
    ORDER BY reconcile.ticket_workflow_id
  `).all(bucket, bucket);
}

export function listRuns(db, limit = 20) {
  return db.prepare(`
    SELECT * FROM runs
    ORDER BY started_at DESC, rowid DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 20));
}

function readJsonMigration(file, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push({ source: label, file, error: error?.message ?? String(error) });
    return null;
  }
}

function finishImportRun(db, runUid, counts, error = null) {
  finishRun(db, runUid, {
    status: error ? 'partial' : 'done',
    counts,
    error,
  });
}

export function migrateFromJson(db, paths, { force = false } = {}) {
  const imported = db.prepare(`
    SELECT value FROM meta WHERE key = 'json_import_done'
  `).get();
  if (!force && imported?.value === '1') {
    return { skipped: true, reason: 'ya-importado' };
  }

  const errors = [];
  const summary = {
    skipped: false,
    census: { found: false, imported: 0, skipped: 0, runUid: null },
    reconcile: {
      found: false,
      closable: 0,
      realOpen: 0,
      unpaired: 0,
      runUid: null,
    },
    ops: { found: false, files: 0, imported: 0, runMarkers: 0, runUid: null },
    errors,
  };

  if (paths.censusFile && fs.existsSync(paths.censusFile)) {
    summary.census.found = true;
    const source = readJsonMigration(paths.censusFile, 'census', errors);
    if (source) {
      const runUid = startRun(db, {
        kind: 'import-census',
        viewerEmail: source.viewerEmail ?? null,
        scope: { file: paths.censusFile, generatedAt: source.generatedAt ?? null },
      });
      summary.census.runUid = runUid;
      try {
        const written = upsertTickets(
          db,
          runUid,
          Array.isArray(source.tickets) ? source.tickets : [],
          source.generatedAt ?? new Date().toISOString(),
        );
        summary.census.imported = written.inserted;
        summary.census.skipped = written.skipped;
        finishImportRun(db, runUid, written);
      } catch (error) {
        const message = error?.message ?? String(error);
        errors.push({ source: 'census', file: paths.censusFile, error: message });
        finishImportRun(db, runUid, null, message);
      }
    }
  }

  if (paths.reconcileFile && fs.existsSync(paths.reconcileFile)) {
    summary.reconcile.found = true;
    const source = readJsonMigration(paths.reconcileFile, 'reconcile', errors);
    if (source) {
      const runUid = startRun(db, {
        kind: 'import-reconcile',
        viewerEmail: source.viewerEmail ?? null,
        scope: { file: paths.reconcileFile, generatedAt: source.generatedAt ?? null },
      });
      summary.reconcile.runUid = runUid;
      try {
        const written = recordReconcile(
          db,
          runUid,
          source,
          source.generatedAt ?? new Date().toISOString(),
        );
        Object.assign(summary.reconcile, written);
        finishImportRun(db, runUid, written);
      } catch (error) {
        const message = error?.message ?? String(error);
        errors.push({ source: 'reconcile', file: paths.reconcileFile, error: message });
        finishImportRun(db, runUid, null, message);
      }
    }
  }

  if (paths.opsDir && fs.existsSync(paths.opsDir)) {
    summary.ops.found = true;
    const runUid = startRun(db, {
      kind: 'import-ops',
      scope: { directory: paths.opsDir },
    });
    summary.ops.runUid = runUid;
    let files = [];
    try {
      files = fs.readdirSync(paths.opsDir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort();
    } catch (error) {
      errors.push({ source: 'ops', file: paths.opsDir, error: error?.message ?? String(error) });
    }
    summary.ops.files = files.length;
    for (const name of files) {
      const file = path.join(paths.opsDir, name);
      let contents;
      try {
        contents = fs.readFileSync(file, 'utf8');
      } catch (error) {
        errors.push({ source: 'ops', file, error: error?.message ?? String(error) });
        continue;
      }
      const lines = contents.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          errors.push({
            source: 'ops',
            file,
            line: index + 1,
            error: error?.message ?? String(error),
          });
          continue;
        }
        if (entry?.kind === 'run-start' || entry?.kind === 'run-end') {
          summary.ops.runMarkers += 1;
          continue;
        }
        try {
          recordOp(db, {
            runUid,
            ticketWorkflowId: entry?.ticketWorkflowId ?? null,
            workKey: entry?.workKey ?? null,
            phase: entry?.phase ?? entry?.kind ?? 'import',
            outcome: entry?.outcome ?? entry?.result ?? 'unknown',
            reason: entry?.reason ?? entry?.errorCode ?? null,
            before: entry?.before ?? null,
            after: entry?.after ?? null,
            payload: entry?.payload ?? null,
            actor: entry?.actor ?? entry?.viewer ?? null,
          });
          summary.ops.imported += 1;
        } catch (error) {
          errors.push({
            source: 'ops',
            file,
            line: index + 1,
            error: error?.message ?? String(error),
          });
        }
      }
    }
    finishImportRun(db, runUid, {
      files: summary.ops.files,
      imported: summary.ops.imported,
      runMarkers: summary.ops.runMarkers,
    }, errors.length > 0 ? `${errors.length} errores durante la importación` : null);
  }

  withWrite(db, (writeDb) => {
    writeDb.prepare(`
      INSERT INTO meta (key, value) VALUES ('json_import_done', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  });
  return summary;
}
