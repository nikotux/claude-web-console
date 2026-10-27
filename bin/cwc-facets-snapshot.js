#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { uidFamily, uidTarget } from '../src/core/arch-uid.js';

// El auditor de Salud corre dentro de runners y no puede depender de la red ni
// de que el Pad esté arriba. Este snapshot es JSON de datos versionado en el
// repo, con el mismo criterio que src/modules/health/invariants-learned.json.

export const UNIT_FACETS = {
  // `core` = src/server.js + todo src/core/. No tiene nodo propio en
  // `arquitectura` (no hay ningún `file:src/core/*`), pero es material del
  // edificio que SABE de apartamentos: user-space.js, data-dir.js y
  // pad-context.js resuelven rutas y credenciales por dueño ⇒ mixto.
  'unit:core': { plano: 'mixto', audiencia: 'todos', perfil: 'general', familia: 'backend' },
  // `frontend-core` = public/js/main.js + public/js/ui/ + public/css/.
  // Shell del edificio + primitivos que usa todo el mundo.
  'unit:frontend-core': { plano: 'mixto', audiencia: 'todos', perfil: 'general', familia: 'frontend' },
  // La Forja es user-scoped: guarda el detalle privado por dueño y publica una
  // arena agregada para todos los autenticados. Declaración manual hasta que el
  // catálogo arquitectura incorpore su nodo propio.
  'unit:mod:forja': { plano: 'usuario', audiencia: 'todos', perfil: 'general', familia: 'backend' },
};

const WORKSPACE = 'console';
const COLLECTION = 'arquitectura';
const VERSION = 1;
const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_REL = 'src/modules/health/facets-snapshot.json';
const SNAPSHOT_PATH = path.join(REPO_ROOT, SNAPSHOT_REL);
const SOURCE = 'pad:console/arquitectura + UNIT_FACETS (bin/cwc-facets-snapshot.js)';

function usage() {
  return [
    'Uso: node bin/cwc-facets-snapshot.js [--check] [--json] [--help]',
    '',
    'Sin flags, lee el Pad local y actualiza el snapshot si cambió.',
    '  --check  No escribe; sale con código 1 si el snapshot difiere',
    '  --json   Emite el resumen como JSON',
    '  --help   Muestra esta ayuda',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function parseArgs(argv) {
  const options = { check: false, help: false, json: false };
  for (const arg of argv) {
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw usageError(`argumento desconocido: ${arg}`);
  }
  return options;
}

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readItems(db) {
  return db.prepare(`
    SELECT
      c.prefix || '-' || i.item_number AS ref,
      i.fields
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    JOIN workspaces w
      ON w.id = i.workspace_id
    WHERE w.slug = ?
      AND w.deleted_at IS NULL
      AND c.slug = ?
      AND c.deleted_at IS NULL
      AND i.deleted_at IS NULL
    ORDER BY i.item_number
  `).all(WORKSPACE, COLLECTION);
}

function parseFields(row) {
  if (typeof row.fields !== 'string') {
    throw new Error(`${row.ref}: fields no es un string JSON`);
  }
  let fields;
  try {
    fields = JSON.parse(row.fields);
  } catch (error) {
    throw new Error(`${row.ref}: fields contiene JSON inválido (${error.message})`);
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`${row.ref}: fields no contiene un objeto JSON`);
  }
  return fields;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function sortedObject(entries) {
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function buildSnapshot(rows) {
  const padEntries = [];
  const seen = new Set();

  for (const row of rows) {
    const fields = parseFields(row);
    const { uid } = fields;
    if (!uid
      || fields.status === 'retirado'
      || uidTarget(uid) === null
      || !nonEmpty(fields.plano)
      || !nonEmpty(fields.audiencia)) {
      continue;
    }
    if (seen.has(uid)) throw new Error(`uid duplicado en arquitectura: ${uid}`);
    seen.add(uid);

    const entry = {
      ref: row.ref,
      plano: fields.plano,
      audiencia: fields.audiencia,
    };
    if (nonEmpty(fields.perfil)) entry.perfil = fields.perfil;
    entry.familia = uidFamily(uid);
    entry.fuente = 'pad';
    padEntries.push([uid, entry]);
  }

  const manualEntries = Object.entries(UNIT_FACETS).map(([uid, facets]) => [
    uid,
    { ...facets, fuente: 'manual' },
  ]);
  const counts = { pad: padEntries.length, manual: manualEntries.length };
  const entries = sortedObject([...padEntries, ...manualEntries]);
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    counts,
    entries,
  };
}

function generateSnapshot() {
  let db;
  try {
    db = openDatabase();
    return buildSnapshot(readItems(db));
  } catch (error) {
    throw new Error(`no se pudo abrir o leer ${PAD_DB_PATH}: ${error.message}`);
  } finally {
    if (db) db.close();
  }
}

function readCurrentSnapshot() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    return { data: JSON.parse(raw), error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { data: null, error: null };
    return { data: null, error: `no se pudo leer el snapshot actual: ${error.message}` };
  }
}

function comparable(snapshot) {
  if (!snapshot) return null;
  return {
    version: snapshot.version,
    counts: snapshot.counts,
    entries: snapshot.entries,
  };
}

function snapshotDiff(current, expected) {
  const currentEntries = current?.entries && typeof current.entries === 'object'
    ? current.entries
    : {};
  const expectedEntries = expected.entries;
  const currentUids = Object.keys(currentEntries);
  const expectedUids = Object.keys(expectedEntries);
  const currentSet = new Set(currentUids);
  const expectedSet = new Set(expectedUids);
  return {
    faltan: expectedUids.filter((uid) => !currentSet.has(uid)).sort(),
    sobran: currentUids.filter((uid) => !expectedSet.has(uid)).sort(),
    cambiaron: expectedUids
      .filter((uid) => currentSet.has(uid))
      .filter((uid) => !isDeepStrictEqual(currentEntries[uid], expectedEntries[uid]))
      .sort(),
  };
}

function makeSummary(status, snapshot, diff, readError = null) {
  return {
    ok: status !== 'diferente',
    status,
    archivo: SNAPSHOT_REL,
    counts: snapshot.counts,
    diff,
    ...(readError ? { error_archivo: readError } : {}),
  };
}

function printHuman(summary) {
  if (summary.status === 'escrito') {
    console.log(
      `Snapshot escrito: ${summary.archivo} · pad=${summary.counts.pad}`
      + ` · manual=${summary.counts.manual}`,
    );
    return;
  }
  if (summary.status === 'sin cambios') {
    console.log(
      `Snapshot sin cambios: ${summary.archivo} · pad=${summary.counts.pad}`
      + ` · manual=${summary.counts.manual}`,
    );
    return;
  }
  if (summary.status === 'vigente') {
    console.log(
      `Snapshot vigente: ${summary.archivo} · pad=${summary.counts.pad}`
      + ` · manual=${summary.counts.manual}`,
    );
    return;
  }

  console.log(`Snapshot diferente: ${summary.archivo}`);
  if (summary.error_archivo) console.log(`  archivo: ${summary.error_archivo}`);
  console.log(`  faltan: ${summary.diff.faltan.join(', ') || '[ninguno]'}`);
  console.log(`  sobran: ${summary.diff.sobran.join(', ') || '[ninguno]'}`);
  console.log(`  cambiaron: ${summary.diff.cambiaron.join(', ') || '[ninguno]'}`);
}

function writeSnapshot(snapshot) {
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonRequested = rawArgs.includes('--json');
  let options;
  try {
    options = parseArgs(rawArgs);
  } catch (error) {
    if (jsonRequested) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`Error: ${error.message}\n${usage()}`);
    return error.exitCode || 1;
  }

  if (options.help) {
    if (options.json) console.log(JSON.stringify({ ok: true, usage: usage() }, null, 2));
    else console.log(usage());
    return 0;
  }

  try {
    const snapshot = generateSnapshot();
    const current = readCurrentSnapshot();
    const same = current.error === null
      && isDeepStrictEqual(comparable(current.data), comparable(snapshot));
    const diff = snapshotDiff(current.data, snapshot);
    let summary;

    if (options.check) {
      summary = makeSummary(same ? 'vigente' : 'diferente', snapshot, diff, current.error);
    } else if (same) {
      summary = makeSummary('sin cambios', snapshot, diff);
    } else {
      writeSnapshot(snapshot);
      summary = makeSummary('escrito', snapshot, diff, current.error);
    }

    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else printHuman(summary);
    return options.check && !same ? 1 : 0;
  } catch (error) {
    const message = error?.message || String(error);
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(`Error: ${message}`);
    return 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
