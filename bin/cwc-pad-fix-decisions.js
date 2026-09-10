#!/usr/bin/env node

// Reparación de datos para console:BUG-3042 (auditoría console:PLAN-2851, F4).
// Pad puede guardar el rationale de `pad_item action=decide` concatenado dentro
// de `decision`, junto con el markup crudo de la tool-call. Este CLI separa esos
// dos valores de forma idempotente y solo escribe con `--apply` explícito.
//
// IMPORTANTE: una decisión guardada en el ítem equivocado es otro problema. En
// particular, CONVE-1944 contiene una decisión sobre el monitoreo MikroTik de
// Princeton ya reubicada en PLAN-160; mover o borrar esa entrada se resuelve a
// mano y queda deliberadamente fuera de esta reparación textual.

import {
  getItem,
  listCollections,
  listItems,
  parseItemFields,
  updateItem,
} from '../src/core/pad-service-client.js';

const DEFAULT_WORKSPACE = 'console';
const CORRUPTION_RE = /<\/decision>\s*<parameter name="rationale">/;
const PREVIEW_LENGTH = 80;
const MAX_RATE_RETRIES = 6;
const WRITE_PAUSE_MS = 750;

function usage() {
  return [
    'Uso: node bin/cwc-pad-fix-decisions.js [--dry-run | --apply] [--workspace <slug>]',
    `Sin flags hace dry-run. Workspace por defecto: ${DEFAULT_WORKSPACE}.`,
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apply: false, dryRun: false, help: false, workspace: DEFAULT_WORKSPACE };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--workspace') {
      index += 1;
      if (!argv[index]) throw new Error('--workspace requiere un slug');
      options.workspace = argv[index];
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
    } else {
      throw new Error(`argumento desconocido: ${arg}`);
    }
  }

  if (options.apply && options.dryRun) {
    throw new Error('--apply y --dry-run son mutuamente excluyentes');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.workspace)) {
    throw new Error(`workspace inválido: ${options.workspace || '[vacío]'}`);
  }
  return options;
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

function splitCorruptDecision(value) {
  if (typeof value !== 'string') return null;
  const marker = CORRUPTION_RE.exec(value);
  if (!marker) return null;
  return {
    decision: value.slice(0, marker.index).trim(),
    rationale: value.slice(marker.index + marker[0].length).trim(),
  };
}

function transformDecisionLog(decisionLog) {
  if (!Array.isArray(decisionLog)) {
    return { decisionLog, repairs: [], omitted: [] };
  }

  const repairs = [];
  const omitted = [];
  const transformed = decisionLog.map((entry, index) => {
    const split = splitCorruptDecision(entry?.decision);
    if (!split) return entry;

    if (String(entry?.rationale ?? '').trim()) {
      omitted.push({ index, entry, split });
      return entry;
    }

    repairs.push({ index, entry, split });
    return {
      ...entry,
      decision: split.decision,
      rationale: split.rationale,
    };
  });

  return { decisionLog: transformed, repairs, omitted };
}

function preview(value) {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  return chars.length <= PREVIEW_LENGTH
    ? compact
    : `${chars.slice(0, PREVIEW_LENGTH).join('')}…`;
}

function printCandidate(candidate) {
  console.log(
    `ITEM ${candidate.ref} repararía=${candidate.change.repairs.length} `
    + `omitidas=${candidate.change.omitted.length}`,
  );
  for (const repair of candidate.change.repairs) {
    console.log(`  [${repair.index}] decision: ${preview(repair.split.decision)}`);
    console.log(`  [${repair.index}] rationale: ${preview(repair.split.rationale)}`);
  }
  for (const omitted of candidate.change.omitted) {
    console.log(`  [${omitted.index}] OMITIDA: ya tiene rationale no vacío`);
  }
}

async function scanCandidates(workspace, summary) {
  const opts = { workspace };
  const collectionsResult = await withRateRetry(
    () => listCollections(opts),
    `listCollections ${workspace}`,
  );
  if (!collectionsResult?.ok) {
    throw new Error(collectionsResult?.error || 'no se pudieron listar las colecciones');
  }

  const candidates = [];
  const collections = dataArray(collectionsResult.data, 'collections');
  for (const collection of collections) {
    if (!collection?.slug) continue;
    const listed = await withRateRetry(
      () => listItems(collection.slug, opts),
      `listItems ${collection.slug}`,
    );
    if (!listed?.ok) {
      summary.errores += 1;
      console.error(
        `[error] colección ${collection.slug}: ${listed?.error || 'respuesta vacía'}`,
      );
      continue;
    }

    for (const item of dataArray(listed.data, 'items')) {
      try {
        const fields = parseItemFields(item);
        const change = transformDecisionLog(fields.decision_log);
        if (change.repairs.length === 0 && change.omitted.length === 0) continue;
        if (!item?.ref) {
          summary.errores += 1;
          console.error(`[error] ítem sin ref en colección ${collection.slug}`);
          continue;
        }
        candidates.push({ ref: item.ref, change });
      } catch (error) {
        summary.errores += 1;
        console.error(`[error] ${item?.ref || collection.slug}: ${error?.message || error}`);
      }
    }
  }
  return candidates;
}

async function applyCandidates(candidates, workspace, summary) {
  const opts = { workspace };
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const fresh = await withRateRetry(
        () => getItem(candidate.ref, opts),
        `getItem ${candidate.ref}`,
      );
      if (!fresh?.ok || !fresh.data) {
        throw new Error(fresh?.error || 'respuesta vacía al releer el ítem');
      }

      const fields = parseItemFields(fresh.data);
      const change = transformDecisionLog(fields.decision_log);
      summary.omitidas += change.omitted.length;
      if (change.repairs.length === 0) {
        console.log(`[skip] ${candidate.ref}: ya no requiere reparación`);
        continue;
      }

      const updated = await withRateRetry(
        () => updateItem(candidate.ref, {
          fields: { ...fields, decision_log: change.decisionLog },
          ...(fresh.data.updated_at ? { expected_updated_at: fresh.data.updated_at } : {}),
        }, opts),
        `updateItem ${candidate.ref}`,
      );
      if (!updated?.ok) throw new Error(updated?.error || 'error desconocido al actualizar');

      summary.reparadas += change.repairs.length;
      console.log(`[reparado] ${candidate.ref}: decisiones=${change.repairs.length}`);
    } catch (error) {
      summary.errores += 1;
      console.error(`[error] ${candidate.ref}: ${error?.message || error}`);
    }

    if (index < candidates.length - 1) await sleep(WRITE_PAUSE_MS);
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(1);
}

if (options.help) {
  console.log(usage());
  process.exit(0);
}

const summary = { items: 0, reparadas: 0, omitidas: 0, errores: 0 };

try {
  console.log(`MODO ${options.apply ? 'APPLY' : 'DRY-RUN'} workspace=${options.workspace}`);
  const candidates = await scanCandidates(options.workspace, summary);
  summary.items = candidates.length;

  for (const candidate of candidates) printCandidate(candidate);

  if (options.apply) {
    await applyCandidates(candidates, options.workspace, summary);
  } else {
    summary.reparadas = candidates.reduce(
      (total, candidate) => total + candidate.change.repairs.length,
      0,
    );
    summary.omitidas = candidates.reduce(
      (total, candidate) => total + candidate.change.omitted.length,
      0,
    );
  }
} catch (error) {
  summary.errores += 1;
  console.error(`[error] ${error?.message || error}`);
}

console.log(`RESUMEN ${JSON.stringify(summary)}`);
if (summary.errores > 0) process.exitCode = 1;
