#!/usr/bin/env node

// Migración one-shot de console:PLAN-3052 (criterio C4): mueve las lecciones
// directas de MC · Procedimientos y MC · Metodología a los 15 grupos temáticos
// ya creados por el workflow. El journal es la fuente del mapeo; este CLI nunca
// crea grupos. Sin --apply hace dry-run y no escribe nada.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// La topología debe releerse después de cada escritura: una respuesta cacheada puede
// ocultar que clear_parent dejó una lección sin padre.
process.env.CWC_PAD_CACHE = '0';

const WORKSPACE = 'console';
const COLLECTION = 'arquitectura';
const LESSON_COLLECTION = 'mejora-continua';
const DEFAULT_JOURNAL = '/home/nmosquera/.claude/projects/-home-nmosquera-claude-web-console/cbd84a6e-8dd1-45aa-a986-56d86d41ccb9/subagents/workflows/wf_bbd5a8f2-297/journal.jsonl';
const PAD_OPTS = Object.freeze({ workspace: WORKSPACE });
const MAX_RATE_RETRIES = 5;
const WRITE_PAUSE_MS = 750;
const PROGRESS_EVERY = 25;

function usage() {
  return [
    'Uso: node bin/cwc-pad-mc-regroup.js [--dry-run | --apply] [--journal <ruta>] [--limit N]',
    'Sin --apply hace dry-run completo. El workspace está fijado a console.',
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
  const options = { apply: false, dryRun: false, help: false, journal: DEFAULT_JOURNAL, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--journal' || arg.startsWith('--journal=')) {
      options.journal = arg === '--journal'
        ? valueAfter(argv, index++, '--journal')
        : arg.slice('--journal='.length);
      if (!options.journal) throw usageError('--journal requiere una ruta');
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
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
  if (options.apply && options.dryRun) {
    throw usageError('--apply y --dry-run son mutuamente excluyentes');
  }
  if (process.env.CWC_PAD_WORKSPACE && process.env.CWC_PAD_WORKSPACE !== WORKSPACE) {
    throw usageError(`CWC_PAD_WORKSPACE=${process.env.CWC_PAD_WORKSPACE} no está permitido`);
  }
  return options;
}

function loadTaxonomy(journalPath) {
  let raw;
  try {
    raw = fs.readFileSync(journalPath, 'utf8');
  } catch (error) {
    throw new Error(`no se pudo leer el journal ${journalPath}: ${error.message}`);
  }

  const matches = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`journal inválido en línea ${index + 1}: ${error.message}`);
    }
    const result = entry?.result;
    if (entry?.type === 'result' && result && typeof result === 'object'
      && Array.isArray(result.groups) && Array.isArray(result.assignments)) {
      matches.push(result);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`se esperaba un único result con groups+assignments; encontrados=${matches.length}`);
  }

  const taxonomy = matches[0];
  const titles = new Set();
  for (const group of taxonomy.groups) {
    if (!group?.title || typeof group.title !== 'string') {
      throw new Error('el journal contiene un grupo sin title válido');
    }
    if (titles.has(group.title)) throw new Error(`grupo duplicado en journal: ${group.title}`);
    titles.add(group.title);
  }

  const refs = new Set();
  const counts = new Map(taxonomy.groups.map((group) => [group.title, 0]));
  for (const assignment of taxonomy.assignments) {
    if (!assignment?.ref || !assignment?.group_title) {
      throw new Error('el journal contiene una asignación sin ref o group_title');
    }
    if (refs.has(assignment.ref)) throw new Error(`asignación duplicada: ${assignment.ref}`);
    if (!titles.has(assignment.group_title)) {
      throw new Error(`${assignment.ref} apunta a un grupo ausente de groups: ${assignment.group_title}`);
    }
    refs.add(assignment.ref);
    counts.set(assignment.group_title, counts.get(assignment.group_title) + 1);
  }
  for (const group of taxonomy.groups) {
    if (Number(group.size) !== counts.get(group.title)) {
      throw new Error(
        `conteo inconsistente para ${group.title}: size=${group.size}, assignments=${counts.get(group.title)}`,
      );
    }
  }
  return taxonomy;
}

function dataArray(data, key) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

function isRateLimitError(result) {
  const message = String(result?.error || '').toLowerCase();
  return result?.status === 429
    || message.includes('429')
    || message.includes('too many requests')
    || message.includes('rate limit');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateRetry(operation, label) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (!isRateLimitError(result) || attempt >= MAX_RATE_RETRIES) return result;
    const waitMs = Math.min(1000 * (2 ** attempt), 15000);
    console.error(
      `[rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`,
    );
    await sleep(waitMs);
  }
}

function targetRef(link) {
  return link?.target_ref || link?.target?.ref || link?.target_item?.ref || null;
}

function currentParents(ref, data) {
  return [...new Set(dataArray(data, 'links')
    .filter((link) => (!link?.source_ref || link.source_ref === ref) && link?.link_type === 'parent')
    .map(targetRef)
    .filter(Boolean))];
}

async function readParents(ref, deps) {
  const result = await withRateRetry(
    () => deps.listLinks(ref, PAD_OPTS),
    `listLinks ${ref}`,
  );
  if (!result?.ok) throw new Error(result?.error || `no se pudieron leer links de ${ref}`);
  return currentParents(ref, result.data);
}

async function resolveGroups(groups, deps) {
  const listed = await withRateRetry(
    () => deps.listItems(COLLECTION, PAD_OPTS),
    `listItems ${COLLECTION}`,
  );
  if (!listed?.ok) throw new Error(listed?.error || `no se pudo listar ${COLLECTION}`);

  const byTitle = new Map();
  for (const item of dataArray(listed.data, 'items')) {
    if (deps.parseItemFields(item).kind !== 'grupo' || !item?.title || !item?.ref) continue;
    const matches = byTitle.get(item.title) || [];
    matches.push(item.ref);
    byTitle.set(item.title, matches);
  }

  const resolved = new Map();
  for (const group of groups) {
    const refs = byTitle.get(group.title) || [];
    if (refs.length === 0) {
      throw new Error(`falta el grupo vivo kind=grupo con título exacto: ${group.title}`);
    }
    if (refs.length > 1) {
      throw new Error(`título de grupo ambiguo ${group.title}: ${refs.join(', ')}`);
    }
    resolved.set(group.title, refs[0]);
  }
  return resolved;
}

async function listLiveLessons(deps) {
  const listed = await withRateRetry(
    () => deps.listItems(LESSON_COLLECTION, PAD_OPTS),
    `listItems ${LESSON_COLLECTION}`,
  );
  if (!listed?.ok) throw new Error(listed?.error || `no se pudo listar ${LESSON_COLLECTION}`);
  return new Set(dataArray(listed.data, 'items').map((item) => item?.ref).filter(Boolean));
}

function freshGroupStats(groups, assignments) {
  const selected = new Map();
  for (const assignment of assignments) {
    selected.set(assignment.group_title, (selected.get(assignment.group_title) || 0) + 1);
  }
  return new Map(groups.map((group) => [group.title, {
    total: selected.get(group.title) || 0,
    movidas: 0,
    ya_ok: 0,
    no_encontradas: 0,
    errores: 0,
  }]));
}

function exactParent(parents, expected) {
  return parents.length === 1 && parents[0] === expected;
}

async function applyAssignment(assignment, groupRef, deps) {
  const before = await readParents(assignment.ref, deps);
  if (exactParent(before, groupRef)) return 'ya_ok';

  let cleared;
  try {
    cleared = await withRateRetry(
      () => deps.updateItem(assignment.ref, { clear_parent: true }, PAD_OPTS),
      `clear_parent ${assignment.ref}`,
    );
  } catch (error) {
    cleared = { ok: false, error: error.message || String(error) };
  }
  await sleep(WRITE_PAUSE_MS);

  if (!cleared?.ok) {
    let afterFailedClear;
    try {
      afterFailedClear = await readParents(assignment.ref, deps);
    } catch (error) {
      const unsafe = new Error(
        `${assignment.ref}: clear_parent pudo haberse aplicado y no se pudo verificar: ${error.message}`,
      );
      unsafe.fatalOrphan = true;
      throw unsafe;
    }
    if (exactParent(afterFailedClear, groupRef)) return 'ya_ok';
    if (afterFailedClear.length > 0) {
      throw new Error(
        `clear_parent falló y conservó parent=${afterFailedClear.join(',')}: ${cleared?.error || 'error desconocido'}`,
      );
    }
    console.error(`[alerta] ${assignment.ref}: clear_parent respondió error pero el parent desapareció; se completa el reparent`);
  }

  let assigned;
  try {
    assigned = await withRateRetry(
      () => deps.setParent(assignment.ref, groupRef, PAD_OPTS),
      `parent ${assignment.ref}->${groupRef}`,
    );
  } catch (error) {
    assigned = { ok: false, error: error.message || String(error) };
  }
  await sleep(WRITE_PAUSE_MS);

  let after;
  try {
    after = await readParents(assignment.ref, deps);
  } catch (error) {
    const unsafe = new Error(`no se pudo verificar después de reparentar: ${error.message}`);
    unsafe.fatalOrphan = true;
    throw unsafe;
  }
  if (exactParent(after, groupRef)) return 'movida';
  if (after.length === 0) {
    const error = new Error(
      `${assignment.ref} quedó HUÉRFANA después de clear_parent; se aborta (${assigned?.error || 'parent nuevo ausente'})`,
    );
    error.fatalOrphan = true;
    throw error;
  }
  throw new Error(
    `parent final inesperado=${after.join(',')}; esperado=${groupRef}; respuesta=${assigned?.error || 'sin error REST'}`,
  );
}

function printProgress(done, total, summary) {
  console.log(
    `PROGRESO ${done}/${total} movidas=${summary.movidas} ya_ok=${summary.ya_ok} `
    + `no_encontradas=${summary.no_encontradas} errores=${summary.errores}`,
  );
}

function printGroupStats(groups, resolved, stats) {
  for (const group of groups) {
    const value = stats.get(group.title);
    console.log(
      `GRUPO ${JSON.stringify(group.title)} ref=${resolved.get(group.title)} total=${value.total} `
      + `movidas=${value.movidas} ya_ok=${value.ya_ok} `
      + `no_encontradas=${value.no_encontradas} errores=${value.errores}`,
    );
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return error.exitCode || 1;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const summary = { movidas: 0, ya_ok: 0, no_encontradas: 0, errores: 0, grupos: 0 };
  let stats;
  let resolved;
  let taxonomy;
  let fatal = false;
  try {
    taxonomy = loadTaxonomy(options.journal);
    const deps = await import('../src/core/pad-service-client.js');
    resolved = await resolveGroups(taxonomy.groups, deps);
    summary.grupos = resolved.size;
    const liveLessons = await listLiveLessons(deps);
    const assignments = options.limit === null
      ? taxonomy.assignments
      : taxonomy.assignments.slice(0, options.limit);
    stats = freshGroupStats(taxonomy.groups, assignments);

    console.log(
      `MODO ${options.apply ? 'APPLY' : 'DRY-RUN'} workspace=${WORKSPACE} `
      + `asignaciones=${assignments.length} grupos=${resolved.size}`,
    );

    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index];
      const groupRef = resolved.get(assignment.group_title);
      const groupStats = stats.get(assignment.group_title);
      if (!liveLessons.has(assignment.ref)) {
        summary.no_encontradas += 1;
        groupStats.no_encontradas += 1;
        console.error(`[no-encontrada] ${assignment.ref}: no existe viva en ${LESSON_COLLECTION}`);
      } else {
        try {
          if (options.apply) {
            const status = await applyAssignment(assignment, groupRef, deps);
            if (status === 'ya_ok') {
              summary.ya_ok += 1;
              groupStats.ya_ok += 1;
            } else {
              summary.movidas += 1;
              groupStats.movidas += 1;
            }
          } else {
            const parents = await readParents(assignment.ref, deps);
            if (exactParent(parents, groupRef)) {
              summary.ya_ok += 1;
              groupStats.ya_ok += 1;
            } else {
              summary.movidas += 1;
              groupStats.movidas += 1;
            }
          }
        } catch (error) {
          summary.errores += 1;
          groupStats.errores += 1;
          console.error(`[error] ${assignment.ref}: ${error.message || error}`);
          if (error.fatalOrphan) {
            fatal = true;
            printProgress(index + 1, assignments.length, summary);
            break;
          }
        }
      }
      if ((index + 1) % PROGRESS_EVERY === 0 || index + 1 === assignments.length) {
        printProgress(index + 1, assignments.length, summary);
      }
    }
    printGroupStats(taxonomy.groups, resolved, stats);
  } catch (error) {
    summary.errores += 1;
    console.error(`[error] ${error.message || error}`);
  }

  console.log(`RESUMEN ${JSON.stringify(summary)}`);
  return summary.errores > 0 || fatal ? 2 : 0;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
