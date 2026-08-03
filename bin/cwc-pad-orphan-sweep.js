#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readHostPadToken } from '../src/core/pad-provision.js';

const PAD_URL = process.env.CWC_PAD_URL || 'http://10.213.222.62:7777';
const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const BACKUP_DIR = path.join(os.homedir(), '.cwc-backups');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERS_PATH = path.join(REPO_ROOT, 'users.json');

// El alcance está fijado por código: no existe una opción para elegir otro
// workspace ni otro prefijo.
const TENANT_PREFIX = 'tenant-';
const TENANT_WORKSPACE_RE = /^tenant-[a-z0-9_-]+$/;
const HARD_PROTECTED_WORKSPACES = new Set(['console', 'tolkien', 'comunidad', 'aduana']);
const MAX_LIVE_ITEMS = 5;
const MAX_RATE_RETRIES = 8;

function usage() {
  return [
    'Uso: node bin/cwc-pad-orphan-sweep.js [--apply] [--via-db] [--json]',
    '',
    'Sin --apply ejecuta un dry-run total y no escribe nada.',
    '--via-db solo escribe si también se indica --apply; hace el soft delete directo en pad.db.',
    'Sin --via-db, --apply usa la API REST del Pad.',
    'El alcance está fijado por código a workspaces tenant-* del Pad local.',
    'El borrado es soft delete: queda restaurable y visible en GET /api/v1/workspaces/deleted.',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    help: false,
    json: false,
    viaDb: false,
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--via-db') options.viaDb = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw usageError(`argumento desconocido: ${arg}`);
  }
  return options;
}

function readLiveUsers() {
  const parsed = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  if (!parsed || !Array.isArray(parsed.users)) {
    throw new Error(`${USERS_PATH} no contiene un array users válido`);
  }
  return new Set(parsed.users.flatMap((user) => (
    typeof user?.username === 'string' && user.username ? [user.username] : []
  )));
}

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function openWritableDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH);
  db.exec('PRAGMA busy_timeout = 8000');
  return db;
}

function readActiveWorkspaces(db) {
  return db.prepare(`
    SELECT w.slug, COUNT(i.id) AS liveItems
    FROM workspaces w
    LEFT JOIN items i
      ON i.workspace_id = w.id
      AND i.deleted_at IS NULL
    WHERE w.deleted_at IS NULL
    GROUP BY w.id, w.slug
    ORDER BY w.slug
  `).all();
}

function isHardProtected(slug) {
  if (HARD_PROTECTED_WORKSPACES.has(slug)) return true;
  if (!slug.startsWith(TENANT_PREFIX)) return false;
  return HARD_PROTECTED_WORKSPACES.has(slug.slice(TENANT_PREFIX.length));
}

function classifyWorkspace(row, liveUsers) {
  const slug = String(row.slug || '');
  const liveItems = Number(row.liveItems);

  // La lista negra se evalúa antes que la whitelist, incluyendo un eventual
  // renombre tenant-<reservado>.
  if (isHardProtected(slug)) return { slug, liveItems, verdict: 'protegido' };
  // Todo slug que no matchee exactamente la whitelist queda visible pero fuera
  // del alcance de escritura.
  if (!TENANT_WORKSPACE_RE.test(slug)) return { slug, liveItems, verdict: 'protegido' };

  const owner = slug.slice(TENANT_PREFIX.length);
  if (liveUsers.has(owner)) return { slug, liveItems, verdict: 'usuario-vivo' };
  if (liveItems > MAX_LIVE_ITEMS) return { slug, liveItems, verdict: 'requiere-revision' };
  return { slug, liveItems, verdict: 'borrar' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseData(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function deleteWorkspace(slug, token) {
  const response = await fetch(
    `${PAD_URL}/api/v1/workspaces/${encodeURIComponent(slug)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    },
  );
  return { status: response.status, ok: response.ok, data: await readResponseData(response) };
}

async function withRateRetry(operation, label, log) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (result.status !== 429 || attempt >= MAX_RATE_RETRIES) return result;
    const waitMs = Math.min(3000 * (2 ** attempt), 30000);
    log(`[rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`);
    await sleep(waitMs);
  }
}

function formatErrorData(data) {
  if (typeof data === 'string') return data.slice(0, 200);
  try {
    return JSON.stringify(data).slice(0, 200);
  } catch {
    return String(data).slice(0, 200);
  }
}

function printTable(results) {
  console.log('slug · ítems vivos · veredicto');
  for (const result of results) {
    console.log(`${result.slug} · ${result.liveItems} · ${result.verdict}`);
  }
}

function countVerdicts(results) {
  const counts = {
    borrar: 0,
    'usuario-vivo': 0,
    'requiere-revision': 0,
    protegido: 0,
  };
  for (const result of results) counts[result.verdict] += 1;
  return counts;
}

async function makeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `pad-pre-orphan-sweep-${stamp}.db`);
  let db;
  try {
    db = openDatabase();
    await backup(db, backupPath);
  } finally {
    if (db) db.close();
  }
  return backupPath;
}

function applyDatabaseDeletes(candidates) {
  const db = openWritableDatabase();
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;

    // Revalidar bajo el lock de escritura evita aplicar una decisión tomada
    // sobre un conteo de ítems que haya quedado viejo desde el escaneo inicial.
    const liveUsers = readLiveUsers();
    const freshResults = readActiveWorkspaces(db)
      .map((row) => classifyWorkspace(row, liveUsers));
    const freshBySlug = new Map(freshResults.map((result) => [result.slug, result]));
    for (const candidate of candidates) {
      const fresh = freshBySlug.get(candidate.slug);
      if (!fresh || fresh.verdict !== 'borrar') {
        throw new Error(
          `guard rechazó ${candidate.slug} al revalidar antes del UPDATE`
          + `${fresh ? ` (veredicto=${fresh.verdict}, ítems vivos=${fresh.liveItems})` : ' (ya no está activo)'}`,
        );
      }
    }

    const deletedAt = new Date().toISOString();
    const update = db.prepare(`
      UPDATE workspaces
      SET deleted_at = ?
      WHERE slug = ?
        AND deleted_at IS NULL
        AND (
          SELECT COUNT(*)
          FROM items
          WHERE workspace_id = workspaces.id
            AND deleted_at IS NULL
        ) <= ?
    `);
    let deleted = 0;
    for (const candidate of candidates) {
      const result = update.run(deletedAt, candidate.slug, MAX_LIVE_ITEMS);
      if (Number(result.changes) !== 1) {
        throw new Error(`UPDATE inesperado para ${candidate.slug}: cambios=${result.changes}`);
      }
      deleted += 1;
    }

    db.exec('COMMIT');
    transactionOpen = false;
    return { deleted, deletedAt };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Se conserva el error original, que explica por qué no se aplicó el lote.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

function verifyDatabaseDeletes(candidates, preserved) {
  const db = openDatabase();
  const failures = [];
  const find = db.prepare(`
    SELECT slug, deleted_at AS deletedAt
    FROM workspaces
    WHERE slug = ?
  `);
  try {
    for (const candidate of candidates) {
      const row = find.get(candidate.slug);
      if (!row || row.deletedAt === null) {
        failures.push(`${candidate.slug} no quedó con deleted_at no nulo`);
      }
    }
    for (const expected of preserved) {
      const row = find.get(expected.slug);
      if (!row || row.deletedAt !== null) {
        failures.push(`${expected.slug} (${expected.verdict}) no siguió activo`);
      }
    }
  } finally {
    db.close();
  }
  return {
    ok: failures.length === 0,
    deletedChecked: candidates.length,
    preservedChecked: preserved.length,
    failures,
  };
}

function restoreSql(candidates) {
  const slugs = candidates.map(({ slug }) => `'${slug.replaceAll("'", "''")}'`);
  return `UPDATE workspaces SET deleted_at = NULL WHERE slug IN (${slugs.join(', ')});`;
}

function printHumanSummary(options, results, errors, deleted, databaseResult) {
  const counts = countVerdicts(results);
  console.log('');
  if (options.apply) {
    const method = options.viaDb ? 'VIA-DB' : 'REST';
    console.log(`MODO APPLY ${method} · borrados=${deleted} · fallidos=${errors.length}`);
  } else {
    const method = options.viaDb ? ' VIA-DB' : '';
    console.log(`MODO DRY-RUN${method} · escrituras=0 · se-borrarían=${counts.borrar}`);
    if (options.viaDb) {
      console.log('No se escribió nada: no se creó backup ni se ejecutó ningún UPDATE.');
      console.log(`Plan DB: soft delete de ${counts.borrar} workspace(s) con deleted_at=<ahora>.`);
      console.log('Para ejecutar este plan por base, usar --via-db --apply.');
    } else {
      console.log('No se escribió nada. Para ejecutar el soft delete por REST, usar --apply.');
    }
  }
  console.log(`usuario-vivo=${counts['usuario-vivo']}`);
  console.log(`requiere-revision=${counts['requiere-revision']}`);
  console.log(`protegido=${counts.protegido}`);
  if (databaseResult.backupPath) console.log(`Backup DB: ${databaseResult.backupPath}`);
  if (databaseResult.restoreSql) console.log(`Revertir: ${databaseResult.restoreSql}`);
  if (databaseResult.verification) {
    const verification = databaseResult.verification;
    if (verification.ok) {
      console.log(
        `VERIFICACIÓN POSTERIOR: OK · borrados=${verification.deletedChecked}`
        + ` · preservados=${verification.preservedChecked}`,
      );
    } else {
      console.log('¡¡¡ VERIFICACIÓN POSTERIOR FALLÓ !!!');
      for (const failure of verification.failures) console.log(`  ${failure}`);
    }
  }
  if (errors.length > 0) {
    console.log('ERRORES');
    for (const error of errors) console.log(`  ${error.slug}: ${error.error}`);
  }
  console.log('Recordatorio: el borrado es soft delete, es reversible y queda visible en GET /api/v1/workspaces/deleted.');
  console.log('ADVERTENCIA: pad-local.service está corriendo y puede conservar estado en memoria; si algo se ve raro, reiniciar pad-local.service hace que relea la base.');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonRequested = rawArgs.includes('--json');
  let options;
  try {
    options = parseArgs(rawArgs);
  } catch (error) {
    if (jsonRequested) {
      console.log(JSON.stringify({ ok: false, error: error.message, usage: usage() }, null, 2));
    } else {
      console.error(`${error.message}\n${usage()}`);
    }
    return error.exitCode || 1;
  }

  if (options.help) {
    if (options.json) console.log(JSON.stringify({ ok: true, usage: usage() }, null, 2));
    else console.log(usage());
    return 0;
  }

  const log = options.json ? () => {} : (message) => console.log(message);
  let db;
  let results;
  try {
    const liveUsers = readLiveUsers();
    db = openDatabase();
    results = readActiveWorkspaces(db).map((row) => classifyWorkspace(row, liveUsers));
  } catch (error) {
    const message = error?.message || String(error);
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(`ERROR: ${message}`);
    return 1;
  } finally {
    if (db) db.close();
  }

  const candidates = results.filter((result) => result.verdict === 'borrar');
  const preserved = results.filter((result) => result.verdict !== 'borrar');
  const errors = [];
  let deleted = 0;
  let fatalExitCode = null;
  const databaseResult = {
    backupPath: null,
    deletedAt: null,
    restoreSql: null,
    verification: null,
  };

  if (options.apply && candidates.length > 0) {
    if (options.viaDb) {
      try {
        databaseResult.backupPath = await makeBackup();
      } catch (error) {
        fatalExitCode = 1;
        errors.push({
          slug: '[backup]',
          error: `falló el backup WAL-aware; ABORTADO sin escribir: ${error?.message || String(error)}`,
        });
      }

      if (!fatalExitCode) {
        try {
          const applied = applyDatabaseDeletes(candidates);
          deleted = applied.deleted;
          databaseResult.deletedAt = applied.deletedAt;
          databaseResult.restoreSql = restoreSql(candidates);
        } catch (error) {
          errors.push({ slug: '[base]', error: error?.message || String(error) });
        }

        if (deleted > 0) {
          try {
            // Debe ser una conexión nueva, abierta después de cerrar la conexión
            // que ejecutó el UPDATE.
            databaseResult.verification = verifyDatabaseDeletes(candidates, preserved);
          } catch (error) {
            databaseResult.verification = {
              ok: false,
              deletedChecked: 0,
              preservedChecked: 0,
              failures: [`no se pudo completar la verificación: ${error?.message || String(error)}`],
            };
          }
          if (!databaseResult.verification.ok) {
            for (const failure of databaseResult.verification.failures) {
              errors.push({ slug: '[VERIFICACIÓN]', error: failure });
            }
          }
        }
      }
    } else {
      const token = readHostPadToken();
      if (!token) {
        const message = 'sin token del host para el Pad local; no se borró ningún workspace';
        if (options.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
        else console.error(`ERROR: ${message}`);
        return 1;
      }

      for (const candidate of candidates) {
        try {
          const response = await withRateRetry(
            () => deleteWorkspace(candidate.slug, token),
            `DELETE ${candidate.slug}`,
            log,
          );
          if (response.ok) deleted += 1;
          else {
            errors.push({
              slug: candidate.slug,
              error: `Pad respondió HTTP ${response.status}: ${formatErrorData(response.data)}`,
            });
          }
        } catch (error) {
          errors.push({ slug: candidate.slug, error: error?.message || String(error) });
        }
      }
    }
  }

  const counts = countVerdicts(results);
  const output = {
    ok: errors.length === 0,
    mode: options.apply ? 'apply' : 'dry-run',
    method: options.viaDb ? 'database' : 'rest',
    writes: options.apply ? 'enabled' : 0,
    padUrl: PAD_URL,
    padDbPath: options.viaDb ? PAD_DB_PATH : null,
    backupDb: databaseResult.backupPath,
    deletedAt: databaseResult.deletedAt,
    restoreSql: databaseResult.restoreSql,
    verification: databaseResult.verification,
    scope: 'active workspaces; exact whitelist ^tenant-[a-z0-9_-]+$',
    softDelete: 'reversible; visible en GET /api/v1/workspaces/deleted',
    serviceWarning: 'pad-local.service puede conservar estado en memoria; si algo se ve raro, reiniciar pad-local.service hace que relea la base',
    workspaces: results,
    summary: {
      ...counts,
      ...(options.apply ? { borrados: deleted, fallidos: errors.length } : { 'se-borrarían': counts.borrar }),
    },
    errors,
  };

  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    printTable(results);
    printHumanSummary(options, results, errors, deleted, databaseResult);
  }
  return fatalExitCode || (errors.length === 0 ? 0 : 2);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
