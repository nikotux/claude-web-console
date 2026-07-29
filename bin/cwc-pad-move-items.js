#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Este CLI necesita estado realmente fresco por ítem. El cliente compartido
// lee esta variable al importarse, por eso sus imports son dinámicos en main().
process.env.CWC_PAD_CACHE = '0';

const WORKSPACE = 'console';
const PAD_OPTS = Object.freeze({ workspace: WORKSPACE });
const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const BACKUP_DIR = path.join(os.homedir(), '.cwc-backups');
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const REF_RE = /^[A-Z]+-\d+$/;
const MAX_RATE_RETRIES = 8;

function usage() {
  return [
    'Uso: node bin/cwc-pad-move-items.js --from <slug> --to <slug> [opciones]',
    '',
    'Opciones:',
    '  --ref <REF>                         Repetible; sin refs toma todos los ítems vivos de --from.',
    '  --limit N                           Limita la cantidad de ítems.',
    '  --set key=value                     Repetible; escribe un campo después del move.',
    '  --map-status viejo=nuevo            Repetible; tiene prioridad sobre --set status=...',
    '  --preserve origen=destino           Repetible; copia un valor previo no vacío.',
    '  --backup-db                         Copia pad.db antes de la primera escritura.',
    '  --apply                             Ejecuta los cambios; sin este flag es dry-run total.',
    '  --json                              Emite el resultado como JSON.',
    '  --help, -h                          Muestra esta ayuda.',
    '',
    `El workspace está fijado por código a ${WORKSPACE}.`,
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw usageError(`${flag} requiere un valor`);
  return value;
}

function assignment(raw, flag, { requireValue = false } = {}) {
  const separator = raw.indexOf('=');
  if (separator < 1) throw usageError(`${flag} requiere formato clave=valor`);
  const key = raw.slice(0, separator);
  const value = raw.slice(separator + 1);
  if (requireValue && !value) throw usageError(`${flag} requiere formato clave=valor`);
  return [key, value];
}

function parseArgs(argv) {
  const options = {
    apply: false,
    backupDb: false,
    from: null,
    help: false,
    json: false,
    limit: null,
    mapStatus: [],
    preserve: [],
    refs: [],
    set: [],
    to: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--backup-db') options.backupDb = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--from' || arg.startsWith('--from=')) {
      if (options.from !== null) throw usageError('--from solo puede indicarse una vez');
      options.from = arg === '--from'
        ? valueAfter(argv, index++, '--from')
        : arg.slice('--from='.length);
    } else if (arg === '--to' || arg.startsWith('--to=')) {
      if (options.to !== null) throw usageError('--to solo puede indicarse una vez');
      options.to = arg === '--to'
        ? valueAfter(argv, index++, '--to')
        : arg.slice('--to='.length);
    } else if (arg === '--ref' || arg.startsWith('--ref=')) {
      const ref = arg === '--ref'
        ? valueAfter(argv, index++, '--ref')
        : arg.slice('--ref='.length);
      options.refs.push(ref);
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      if (options.limit !== null) throw usageError('--limit solo puede indicarse una vez');
      const raw = arg === '--limit'
        ? valueAfter(argv, index++, '--limit')
        : arg.slice('--limit='.length);
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw usageError(`limit inválido: ${raw || '[vacío]'}`);
      }
      options.limit = Number(raw);
    } else if (arg === '--set' || arg.startsWith('--set=')) {
      const raw = arg === '--set'
        ? valueAfter(argv, index++, '--set')
        : arg.slice('--set='.length);
      options.set.push(assignment(raw, '--set'));
    } else if (arg === '--map-status' || arg.startsWith('--map-status=')) {
      const raw = arg === '--map-status'
        ? valueAfter(argv, index++, '--map-status')
        : arg.slice('--map-status='.length);
      options.mapStatus.push(assignment(raw, '--map-status', { requireValue: true }));
    } else if (arg === '--preserve' || arg.startsWith('--preserve=')) {
      const raw = arg === '--preserve'
        ? valueAfter(argv, index++, '--preserve')
        : arg.slice('--preserve='.length);
      options.preserve.push(assignment(raw, '--preserve', { requireValue: true }));
    } else {
      throw usageError(`argumento desconocido: ${arg}`);
    }
  }

  if (!options.help) {
    if (!options.from) throw usageError('--from es obligatorio');
    if (!options.to) throw usageError('--to es obligatorio');
  }
  if (options.from && !SLUG_RE.test(options.from)) {
    throw usageError(`slug --from inválido: ${options.from || '[vacío]'}`);
  }
  if (options.to && !SLUG_RE.test(options.to)) {
    throw usageError(`slug --to inválido: ${options.to || '[vacío]'}`);
  }
  if (options.from && options.to && options.from === options.to) {
    throw usageError('--from y --to deben ser distintos');
  }
  for (const ref of options.refs) {
    if (!REF_RE.test(ref)) throw usageError(`ref inválido: ${ref || '[vacío]'}`);
  }
  options.refs = [...new Set(options.refs)];
  if (process.env.CWC_PAD_WORKSPACE && process.env.CWC_PAD_WORKSPACE !== WORKSPACE) {
    throw usageError(
      `CWC_PAD_WORKSPACE=${process.env.CWC_PAD_WORKSPACE} no está permitido; `
      + `este CLI solo opera en ${WORKSPACE}`,
    );
  }
  return options;
}

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readCollection(db, slug) {
  return db.prepare(`
    SELECT c.id, c.slug, c.prefix, c.schema
    FROM collections c
    JOIN workspaces w
      ON w.id = c.workspace_id
    WHERE w.slug = ?
      AND w.deleted_at IS NULL
      AND c.slug = ?
      AND c.deleted_at IS NULL
  `).get(WORKSPACE, slug);
}

function readSourceScope(db, collectionId) {
  return db.prepare(`
    SELECT i.id AS itemId
    FROM items i
    WHERE i.workspace_id = (
      SELECT id FROM workspaces WHERE slug = ? AND deleted_at IS NULL
    )
      AND i.collection_id = ?
      AND i.deleted_at IS NULL
    ORDER BY i.item_number
  `).all(WORKSPACE, collectionId);
}

function readRefScope(db, refs) {
  const find = db.prepare(`
    SELECT i.id AS itemId
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    JOIN workspaces w
      ON w.id = i.workspace_id
    WHERE w.slug = ?
      AND w.deleted_at IS NULL
      AND c.deleted_at IS NULL
      AND i.deleted_at IS NULL
      AND c.prefix || '-' || i.item_number = ?
  `);
  return refs.map((ref) => ({ ref, itemId: find.get(WORKSPACE, ref)?.itemId || null }));
}

function readItemState(db, itemId) {
  return db.prepare(`
    SELECT
      i.id,
      i.item_number AS itemNumber,
      c.prefix || '-' || i.item_number AS ref,
      c.slug AS collectionSlug,
      i.fields
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    JOIN workspaces w
      ON w.id = i.workspace_id
    WHERE w.slug = ?
      AND w.deleted_at IS NULL
      AND c.deleted_at IS NULL
      AND i.deleted_at IS NULL
      AND i.id = ?
  `).get(WORKSPACE, itemId);
}

function parseFields(item) {
  const raw = item?.fields;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseSchema(raw, slug) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.fields)) throw new Error('fields no es un array');
    return parsed.fields.filter((field) => field && typeof field.key === 'string');
  } catch (error) {
    throw new Error(`schema inválido en la colección ${slug}: ${error.message}`);
  }
}

function isRateLimitError(result) {
  const message = String(result?.error || '').toLowerCase();
  return result?.status === 429
    || message.includes('429')
    || message.includes('too many')
    || message.includes('rate limit');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateRetry(operation, label, log) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (!isRateLimitError(result) || attempt >= MAX_RATE_RETRIES) return result;
    const waitMs = Math.min(3000 * (2 ** attempt), 30000);
    log(`[rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`);
    await sleep(waitMs);
  }
}

function emptySummary() {
  return {
    movido: 0,
    'ya-en-destino': 0,
    'fuera-de-alcance': 0,
    'campos-descartados': 0,
    errores: 0,
  };
}

function schemaWarnings(fields, schemaFields) {
  const byKey = new Map(schemaFields.map((field) => [field.key, field]));
  const discarded = Object.entries(fields)
    .filter(([key]) => !byKey.has(key))
    .map(([campo, valor]) => ({ campo, valor }));
  const invalidEnums = [];
  for (const field of schemaFields) {
    if (field.type !== 'select' || !Object.hasOwn(fields, field.key)) continue;
    if (!Array.isArray(field.options) || field.options.includes(fields[field.key])) continue;
    invalidEnums.push({
      campo: field.key,
      valor: fields[field.key],
      opciones: field.options,
      default: Object.hasOwn(field, 'default') ? field.default : null,
    });
  }
  return { discarded, invalidEnums };
}

function projectFields(fields, schemaFields) {
  const projected = {};
  for (const field of schemaFields) {
    if (Object.hasOwn(fields, field.key)) {
      const value = fields[field.key];
      if (field.type === 'select'
        && Array.isArray(field.options)
        && !field.options.includes(value)) {
        if (Object.hasOwn(field, 'default')) projected[field.key] = field.default;
      } else {
        projected[field.key] = value;
      }
    } else if (Object.hasOwn(field, 'default')) {
      projected[field.key] = field.default;
    }
  }
  return projected;
}

function isPreservable(value) {
  return value !== null && value !== undefined && value !== '';
}

function plannedWrites(fields, baseFields, options) {
  const desired = {};
  for (const [source, target] of options.preserve) {
    if (isPreservable(fields[source])) desired[target] = fields[source];
  }
  for (const [key, value] of options.set) desired[key] = value;
  const statusMap = new Map(options.mapStatus);
  if (statusMap.has(fields.status)) desired.status = statusMap.get(fields.status);

  const changes = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!Object.hasOwn(baseFields, key) || !Object.is(baseFields[key], value)) {
      changes[key] = value;
    }
  }
  return changes;
}

function jsonValue(value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function printHumanItem(result) {
  const parts = [`${result.refActual} → ${result.refDestino}`, result.status];
  for (const warning of result.camposDescartados) {
    parts.push(`campo-descartado ${warning.campo}=${jsonValue(warning.valor)}`);
  }
  for (const warning of result.valoresFueraDeEnum) {
    parts.push(
      `valor-fuera-de-enum ${warning.campo}=${jsonValue(warning.valor)}`
      + ` (default=${jsonValue(warning.default)})`,
    );
  }
  const writes = Object.entries(result.camposAEscribir);
  if (writes.length > 0) {
    parts.push(`escribir ${writes.map(([key, value]) => `${key}=${jsonValue(value)}`).join(', ')}`);
  }
  if (result.errors.length > 0) parts.push(`ERROR ${result.errors.join('; ')}`);
  console.log(parts.join(' · '));
}

function printHumanSummary(summary, mode, itemCount, options, errors, backupPath) {
  const scope = [
    `MODO ${mode}`,
    `workspace=${WORKSPACE}`,
    `escrituras=${options.apply ? 'habilitadas' : '0'}`,
    `items=${itemCount}`,
    `from=${options.from}`,
    `to=${options.to}`,
  ];
  if (options.refs.length > 0) scope.push(`refs=${options.refs.length}`);
  if (options.limit) scope.push(`limit=${options.limit}`);
  console.log(scope.join(' · '));
  if (backupPath) console.log(`backup-db=${backupPath}`);
  console.log(`movido=${summary.movido}`);
  console.log(`ya-en-destino=${summary['ya-en-destino']}`);
  console.log(`fuera-de-alcance=${summary['fuera-de-alcance']}`);
  console.log(`campos-descartados=${summary['campos-descartados']}`);
  console.log(`errores=${summary.errores}`);
  if (errors.length > 0) {
    console.log('ERRORES PARCIALES');
    for (const error of errors) console.log(`  ${error.ref}: ${error.error}`);
  }
}

function addResultToSummary(summary, result, apply) {
  if (result.status === 'mover' && (!apply || result.moveAplicado)) summary.movido += 1;
  if (result.status === 'ya-en-destino') summary['ya-en-destino'] += 1;
  if (result.status === 'fuera-de-alcance') summary['fuera-de-alcance'] += 1;
  summary['campos-descartados'] += result.camposDescartados.length;
  summary.errores += result.errors.length;
}

async function makeBackup(db, log) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '');
  const backupPath = path.join(BACKUP_DIR, `pad-premove-${stamp}.db`);
  await backup(db, backupPath);
  log(`Backup DB: ${backupPath}`);
  return backupPath;
}

async function processItem(item, options, target, schemaFields, deps, ensureBackup, log) {
  const fields = parseFields(item);
  const refDestino = `${target.prefix}-${item.itemNumber}`;
  const status = item.collectionSlug === options.to
    ? 'ya-en-destino'
    : item.collectionSlug === options.from
      ? 'mover'
      : 'fuera-de-alcance';
  const warnings = schemaWarnings(fields, schemaFields);
  const result = {
    id: item.id,
    refActual: item.ref,
    refDestino,
    coleccionActual: item.collectionSlug,
    status,
    camposDescartados: warnings.discarded,
    valoresFueraDeEnum: warnings.invalidEnums,
    camposAEscribir: {},
    moveAplicado: false,
    updateAplicado: false,
    errors: [],
  };
  if (status === 'fuera-de-alcance') return result;

  const projected = projectFields(fields, schemaFields);
  const baseFields = status === 'mover' ? projected : fields;
  result.camposAEscribir = plannedWrites(fields, baseFields, options);
  if (!options.apply) return result;

  if (status === 'mover') {
    await ensureBackup();
    const moveR = await withRateRetry(
      () => deps.moveItem(item.ref, options.to, PAD_OPTS),
      `moveItem ${item.ref}`,
      log,
    );
    if (!moveR?.ok) {
      result.errors.push(moveR?.error || `no se pudo mover ${item.ref}`);
      return result;
    }
    result.moveAplicado = true;
  }

  if (Object.keys(result.camposAEscribir).length > 0) {
    await ensureBackup();
    const mergedFields = { ...projected, ...result.camposAEscribir };
    const updateR = await withRateRetry(
      () => deps.updateItem(refDestino, { fields: mergedFields }, PAD_OPTS),
      `updateItem ${refDestino}`,
      log,
    );
    if (!updateR?.ok) {
      result.errors.push(updateR?.error || `no se pudo actualizar ${refDestino}`);
      return result;
    }
    result.updateAplicado = true;
  }
  return result;
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

  const mode = options.apply ? 'APPLY' : 'DRY-RUN';
  const log = options.json ? () => {} : (message) => console.log(message);
  const { moveItem, updateItem } = await import('../src/core/pad-service-client.js');
  const deps = { moveItem, updateItem };
  const summary = emptySummary();
  const errors = [];
  const results = [];
  let backupPath = null;
  let fatalExitCode = null;
  let db = null;
  let scope = [];
  const ensureBackup = async () => {
    if (!options.backupDb || backupPath) return backupPath;
    try {
      backupPath = await makeBackup(db, log);
    } catch (error) {
      const backupError = new Error(
        `falló el backup de seguridad; no se ejecutará ningún move: ${error?.message || String(error)}`,
      );
      backupError.exitCode = 1;
      throw backupError;
    }
    return backupPath;
  };

  try {
    db = openDatabase();
    const source = readCollection(db, options.from);
    if (!source) throw new Error(`no existe la colección origen ${options.from} en ${WORKSPACE}`);
    const target = readCollection(db, options.to);
    if (!target) throw new Error(`no existe la colección destino ${options.to} en ${WORKSPACE}`);
    const schemaFields = parseSchema(target.schema, target.slug);

    if (options.refs.length > 0) {
      const requested = readRefScope(db, options.refs);
      for (const entry of requested) {
        if (entry.itemId) scope.push(entry);
        else errors.push({ ref: entry.ref, error: 'no existe como ítem vivo del workspace' });
      }
      summary.errores += errors.length;
    } else {
      scope = readSourceScope(db, source.id);
    }
    if (options.limit !== null) scope = scope.slice(0, options.limit);

    for (const entry of scope) {
      const item = readItemState(db, entry.itemId);
      if (!item) {
        const ref = entry.ref || entry.itemId;
        errors.push({ ref, error: 'el ítem dejó de estar disponible' });
        summary.errores += 1;
        continue;
      }
      try {
        const result = await processItem(
          item,
          options,
          target,
          schemaFields,
          deps,
          ensureBackup,
          log,
        );
        results.push(result);
        addResultToSummary(summary, result, options.apply);
        for (const error of result.errors) errors.push({ ref: result.refActual, error });
        if (!options.json) printHumanItem(result);
      } catch (error) {
        if (error?.exitCode === 1) throw error;
        const message = error?.message || String(error);
        const result = {
          id: item.id,
          refActual: item.ref,
          refDestino: `${target.prefix}-${item.itemNumber}`,
          coleccionActual: item.collectionSlug,
          status: 'error',
          camposDescartados: [],
          valoresFueraDeEnum: [],
          camposAEscribir: {},
          moveAplicado: false,
          updateAplicado: false,
          errors: [message],
        };
        results.push(result);
        addResultToSummary(summary, result, options.apply);
        errors.push({ ref: item.ref, error: message });
        if (!options.json) printHumanItem(result);
      }
    }
  } catch (error) {
    fatalExitCode = error?.exitCode || null;
    summary.errores += 1;
    errors.push({ ref: '[colección]', error: error?.message || String(error) });
  } finally {
    if (db) db.close();
  }

  const ok = summary.errores === 0;
  const output = {
    ok,
    mode: mode.toLowerCase(),
    workspace: WORKSPACE,
    from: options.from,
    to: options.to,
    refs: options.refs,
    limit: options.limit,
    writes: options.apply ? 'enabled' : 0,
    backupDb: backupPath,
    items: results,
    summary,
    errors,
  };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printHumanSummary(summary, mode, results.length, options, errors, backupPath);
  return fatalExitCode || (ok ? 0 : 2);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
