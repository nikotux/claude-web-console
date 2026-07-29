#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Este CLI necesita listLinks realmente fresco por ítem. El cliente compartido
// lee esta variable al importarse, por eso sus imports son dinámicos en main().
process.env.CWC_PAD_CACHE = '0';

const WORKSPACE = 'console';
const PAD_OPTS = Object.freeze({ workspace: WORKSPACE });
const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const REF_RE = /^MC-\d+$/;
const MAX_RATE_RETRIES = 8;

function usage() {
  return [
    'Uso: node bin/cwc-pad-mc-parent.js [--apply] [--ref MC-n] [--json] [--limit N]',
    'Sin --apply hace dry-run completo y no escribe nada.',
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

function parseArgs(argv) {
  const options = {
    apply: false,
    help: false,
    json: false,
    limit: null,
    ref: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--ref' || arg.startsWith('--ref=')) {
      if (options.ref !== null) throw usageError('--ref solo puede indicarse una vez');
      options.ref = arg === '--ref'
        ? valueAfter(argv, index++, '--ref')
        : arg.slice('--ref='.length);
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      if (options.limit !== null) throw usageError('--limit solo puede indicarse una vez');
      const raw = arg === '--limit'
        ? valueAfter(argv, index++, '--limit')
        : arg.slice('--limit='.length);
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw usageError(`limit inválido: ${raw || '[vacío]'}`);
      }
      options.limit = Number(raw);
    } else {
      throw usageError(`argumento desconocido: ${arg}`);
    }
  }

  if (options.ref !== null && !REF_RE.test(options.ref)) {
    throw usageError(`ref inválido: ${options.ref || '[vacío]'}`);
  }
  if (process.env.CWC_PAD_WORKSPACE && process.env.CWC_PAD_WORKSPACE !== WORKSPACE) {
    throw usageError(
      `CWC_PAD_WORKSPACE=${process.env.CWC_PAD_WORKSPACE} no está permitido; `
      + `este CLI solo opera en ${WORKSPACE}`,
    );
  }
  return options;
}

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readDryRunItems(db) {
  return db.prepare(`
    SELECT
      i.id AS itemId,
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
      AND c.slug = 'mejora-continua'
      AND c.deleted_at IS NULL
      AND i.deleted_at IS NULL
    ORDER BY i.item_number
  `).all(WORKSPACE);
}

function readDryRunLinks(db, itemId) {
  return db.prepare(`
    SELECT
      l.id,
      l.link_type,
      source_collection.prefix || '-' || source_item.item_number AS source_ref,
      target_collection.prefix || '-' || target_item.item_number AS target_ref
    FROM item_links l
    JOIN items source_item
      ON source_item.id = l.source_id
      AND source_item.workspace_id = l.workspace_id
    JOIN collections source_collection
      ON source_collection.id = source_item.collection_id
      AND source_collection.workspace_id = source_item.workspace_id
    JOIN items target_item
      ON target_item.id = l.target_id
      AND target_item.workspace_id = l.workspace_id
    JOIN collections target_collection
      ON target_collection.id = target_item.collection_id
      AND target_collection.workspace_id = target_item.workspace_id
    WHERE l.workspace_id = source_item.workspace_id
      AND l.source_id = ?
    ORDER BY l.created_at, l.id
  `).all(itemId);
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

function linkTargetRef(link) {
  return link?.target_ref || link?.target?.ref || link?.target_item?.ref || null;
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
    'parent-creado': 0,
    'implements-borrado': 0,
    'ya-ok': 0,
    'parent-ajeno-saltado': 0,
    'sin-categoria': 0,
    errores: 0,
  };
}

function printHumanSummary(summary, mode, itemCount, options, errors) {
  const scope = [
    `MODO ${mode}`,
    `workspace=${WORKSPACE}`,
    `escrituras=${options.apply ? 'habilitadas' : '0'}`,
    `items=${itemCount}`,
  ];
  if (options.ref) scope.push(`ref=${options.ref}`);
  if (options.limit) scope.push(`limit=${options.limit}`);
  console.log(scope.join(' · '));
  console.log(`parent-creado=${summary['parent-creado']}`);
  console.log(`implements-borrado=${summary['implements-borrado']}`);
  console.log(`ya-ok=${summary['ya-ok']}`);
  console.log(`parent-ajeno-saltado=${summary['parent-ajeno-saltado']}`);
  console.log(`sin-categoria=${summary['sin-categoria']}`);
  console.log(`errores=${summary.errores}`);
  if (errors.length > 0) {
    console.log('ERRORES PARCIALES');
    for (const error of errors) console.log(`  ${error.ref}: ${error.error}`);
  }
}

function addResultToSummary(summary, result) {
  summary['parent-creado'] += result.parentCreated;
  summary['implements-borrado'] += result.implementsDeleted;
  if (result.status === 'ya-ok') summary['ya-ok'] += 1;
  if (result.status === 'parent-ajeno-saltado') summary['parent-ajeno-saltado'] += 1;
  if (result.status === 'sin-categoria') summary['sin-categoria'] += 1;
  summary.errores += result.errors.length;
}

async function processItem(item, options, deps, log) {
  const ref = item.ref;
  const category = parseFields(item).category;
  const sun = deps.MC_SUN_BY_CATEGORY[category];
  const result = {
    ref,
    category: category || null,
    sun: sun || null,
    status: null,
    parentCreated: 0,
    implementsDeleted: 0,
    errors: [],
  };
  if (!sun) {
    result.status = 'sin-categoria';
    return result;
  }

  // Lectura fresca inmediatamente antes de decidir: la caché compartida está
  // forzada a off para que otras sesiones escribiendo en Pad sean visibles.
  const linksR = await withRateRetry(
    () => deps.readLinks(item),
    `listLinks ${ref}`,
    log,
  );
  if (!linksR?.ok) {
    result.status = 'error';
    result.errors.push(linksR?.error || 'no se pudieron listar links');
    return result;
  }

  const plan = deps.planLessonSunLinks(ref, sun, linksR.data);
  if (plan.foreignParents.length > 0) {
    result.status = 'parent-ajeno-saltado';
    result.foreignParents = plan.foreignParents.map(linkTargetRef);
    return result;
  }

  if (!options.apply) {
    result.parentCreated = plan.createParent ? 1 : 0;
    result.implementsDeleted = plan.implementsToDelete.length;
    result.status = result.parentCreated || result.implementsDeleted ? 'cambiaría' : 'ya-ok';
    return result;
  }

  if (plan.createParent) {
    const parentR = await withRateRetry(
      () => deps.setParent(ref, sun, PAD_OPTS),
      `setParent ${ref}`,
      log,
    );
    if (!parentR?.ok) {
      result.status = 'error';
      result.errors.push(parentR?.error || `no se pudo fijar parent ${sun}`);
      return result;
    }
    result.parentCreated = 1;
  }

  for (const link of plan.implementsToDelete) {
    if (!link?.id) {
      result.errors.push(`implements ${ref}->${sun} sin id`);
      continue;
    }
    const deleteR = await withRateRetry(
      () => deps.deleteLink(link.id, PAD_OPTS),
      `deleteLink ${link.id}`,
      log,
    );
    if (deleteR?.ok) result.implementsDeleted += 1;
    else result.errors.push(deleteR?.error || `no se pudo borrar el link ${link.id}`);
  }

  if (result.errors.length > 0) result.status = 'error';
  else if (result.parentCreated || result.implementsDeleted) result.status = 'cambiado';
  else result.status = 'ya-ok';
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
  const [
    { deleteLink, listItems, listLinks, setParent },
    { MC_SUN_BY_CATEGORY, planLessonSunLinks },
  ] = await Promise.all([
    import('../src/core/pad-service-client.js'),
    import('../src/modules/retro/store.js'),
  ]);
  const deps = {
    deleteLink,
    listItems,
    listLinks,
    setParent,
    MC_SUN_BY_CATEGORY,
    planLessonSunLinks,
  };

  const summary = emptySummary();
  const errors = [];
  let db = null;
  let items = [];
  const results = [];
  try {
    if (options.apply) {
      const listed = await withRateRetry(
        () => deps.listItems('mejora-continua', PAD_OPTS),
        'listItems mejora-continua',
        log,
      );
      if (!listed?.ok) {
        throw new Error(listed?.error || 'no se pudieron listar las lecciones');
      }
      items = itemsArray(listed.data);
      deps.readLinks = (item) => deps.listLinks(item.ref, PAD_OPTS);
    } else {
      // Igual que cwc-pad-wikilinks-fix.js: el dry-run abre la DB viva en modo
      // query_only. Cada ítem consulta sus aristas en un SELECT separado justo
      // antes de decidir, de modo que ve commits concurrentes sin escribir.
      db = openDatabase();
      items = readDryRunItems(db);
      deps.readLinks = (item) => ({ ok: true, data: readDryRunLinks(db, item.itemId) });
    }

    items = items
      .filter((item) => item?.ref && (!options.ref || item.ref === options.ref))
      .sort((a, b) => Number(a.ref.slice(3)) - Number(b.ref.slice(3)));
    if (options.limit !== null) items = items.slice(0, options.limit);
    if (options.ref && items.length === 0) {
      errors.push({ ref: options.ref, error: 'no existe como ítem vivo de mejora-continua' });
      summary.errores = 1;
    }

    for (const item of items) {
      try {
        const result = await processItem(item, options, deps, log);
        results.push(result);
        addResultToSummary(summary, result);
        for (const error of result.errors) errors.push({ ref: result.ref, error });
      } catch (error) {
        const message = error?.message || String(error);
        const result = {
          ref: item.ref,
          category: parseFields(item).category || null,
          sun: null,
          status: 'error',
          parentCreated: 0,
          implementsDeleted: 0,
          errors: [message],
        };
        results.push(result);
        addResultToSummary(summary, result);
        errors.push({ ref: item.ref, error: message });
      }
    }
  } catch (error) {
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
    ref: options.ref,
    limit: options.limit,
    items: results,
    summary,
    errors,
  };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printHumanSummary(summary, mode, items.length, options, errors);
  return ok ? 0 : 2;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
