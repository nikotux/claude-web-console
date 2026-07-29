#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  getItem,
  updateItem,
} from '../src/core/pad-service-client.js';

const WORKSPACE = 'console';
const PAD_OPTS = Object.freeze({ workspace: WORKSPACE });
const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const WIKILINK_RE = /\[\[(console|tolkien):([A-Z][A-Z]*-\d+)\]\]/g;
const REF_RE = /^[A-Z][A-Z]*-\d+$/;
const MAX_RATE_RETRIES = 8;

function usage() {
  return [
    'Uso: node bin/cwc-pad-wikilinks-fix.js [--apply] [--ref=<REF>] [--json]',
    'Sin --apply hace dry-run completo y no escribe nada.',
    `El workspace está fijado por código a ${WORKSPACE}.`,
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
    ref: null,
  };

  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--ref=')) {
      if (options.ref !== null) throw usageError('--ref solo puede indicarse una vez');
      options.ref = arg.slice('--ref='.length);
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

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readCandidates(refFilter) {
  const db = openDatabase();
  try {
    const workspace = db.prepare(
      'SELECT id FROM workspaces WHERE slug = ?',
    ).get(WORKSPACE);
    if (!workspace?.id) {
      throw new Error(`no existe el workspace ${WORKSPACE} en ${PAD_DB_PATH}`);
    }

    const refClause = refFilter
      ? " AND (c.prefix || '-' || i.item_number) = ?"
      : '';
    const sql = `
      SELECT
        c.prefix || '-' || i.item_number AS ref,
        i.content,
        i.updated_at
      FROM items i
      JOIN collections c
        ON c.id = i.collection_id
        AND c.workspace_id = i.workspace_id
      WHERE i.workspace_id = ?
        AND i.deleted_at IS NULL
        AND (
          instr(COALESCE(i.content, ''), '[[console:') > 0
          OR instr(COALESCE(i.content, ''), '[[tolkien:') > 0
        )
        ${refClause}
      ORDER BY c.prefix, i.item_number
    `;
    const rows = refFilter
      ? db.prepare(sql).all(workspace.id, refFilter)
      : db.prepare(sql).all(workspace.id);

    return rows
      .map((row) => {
        const change = transformContent(row.content);
        return {
          ref: row.ref,
          snapshotUpdatedAt: row.updated_at,
          ...change,
        };
      })
      .filter((item) => item.changed);
  } finally {
    db.close();
  }
}

function lineEnd(content, start) {
  const newline = content.indexOf('\n', start);
  return newline === -1 ? content.length : newline;
}

function lineAfter(content, end) {
  return end < content.length ? end + 1 : end;
}

function fenceAtLineStart(content, start, openingFence = null) {
  const end = lineEnd(content, start);
  let cursor = start;
  let indentation = 0;
  while (cursor < end && content[cursor] === ' ' && indentation < 4) {
    cursor += 1;
    indentation += 1;
  }
  if (indentation > 3) return null;

  const marker = content[cursor];
  if (openingFence && marker !== openingFence.marker) return null;
  if (!openingFence && marker !== '`' && marker !== '~') return null;

  let markerEnd = cursor;
  while (markerEnd < end && content[markerEnd] === marker) markerEnd += 1;
  const length = markerEnd - cursor;
  if (length < 3 || (openingFence && length < openingFence.length)) return null;

  const remainder = content.slice(markerEnd, end).replace(/\r$/, '');
  if (openingFence) {
    if (!/^[ \t]*$/.test(remainder)) return null;
  } else if (marker === '`' && remainder.includes('`')) {
    return null;
  }

  return { marker, length, end };
}

function pushSegment(segments, code, content) {
  if (content.length === 0) return;
  const previous = segments.at(-1);
  if (previous?.code === code) previous.content += content;
  else segments.push({ code, content });
}

function tokenizeMarkdownCode(content) {
  const segments = [];
  let cursor = 0;
  let plainStart = 0;
  let codeStart = null;
  let fence = null;
  let inlineTicks = null;

  while (cursor < content.length) {
    const atLineStart = cursor === 0 || content[cursor - 1] === '\n';

    if (fence) {
      const closing = atLineStart
        ? fenceAtLineStart(content, cursor, fence)
        : null;
      if (closing) {
        cursor = lineAfter(content, closing.end);
        pushSegment(segments, true, content.slice(codeStart, cursor));
        codeStart = null;
        fence = null;
        plainStart = cursor;
      } else {
        cursor = lineAfter(content, lineEnd(content, cursor));
      }
      continue;
    }

    if (inlineTicks === null && atLineStart) {
      const opening = fenceAtLineStart(content, cursor);
      if (opening) {
        pushSegment(segments, false, content.slice(plainStart, cursor));
        codeStart = cursor;
        fence = opening;
        cursor = lineAfter(content, opening.end);
        continue;
      }
    }

    if (content[cursor] !== '`') {
      cursor += 1;
      continue;
    }

    let runEnd = cursor;
    while (runEnd < content.length && content[runEnd] === '`') runEnd += 1;
    const runLength = runEnd - cursor;
    if (inlineTicks === null) {
      pushSegment(segments, false, content.slice(plainStart, cursor));
      codeStart = cursor;
      inlineTicks = runLength;
    } else if (runLength === inlineTicks) {
      pushSegment(segments, true, content.slice(codeStart, runEnd));
      codeStart = null;
      inlineTicks = null;
      plainStart = runEnd;
    }
    cursor = runEnd;
  }

  if (fence) {
    pushSegment(segments, true, content.slice(codeStart));
  } else if (inlineTicks !== null) {
    // Un delimitador inline sin cierre es texto literal, no código Markdown.
    pushSegment(segments, false, content.slice(codeStart));
  } else {
    pushSegment(segments, false, content.slice(plainStart));
  }
  return segments;
}

export function transformContent(content) {
  const examples = [];
  let occurrences = 0;
  const before = String(content ?? '');
  // Pad ignora los wiki-links dentro de código. Excluirlos alinea el CLI con
  // su parser y evita corromper ejemplos pedagógicos que enseñan la sintaxis.
  const after = tokenizeMarkdownCode(before)
    .map((segment) => {
      if (segment.code) return segment.content;
      // Idempotente: la forma alias empieza por `[[REF|`, no por
      // `[[console:` o `[[tolkien:`, así que no vuelve a matchearla.
      return segment.content.replace(WIKILINK_RE, (match, world, ref) => {
        const replacement = `[[${ref}|${world}:${ref}]]`;
        occurrences += 1;
        if (examples.length < 2) examples.push({ before: match, after: replacement });
        return replacement;
      });
    })
    .join('');
  return {
    content: after,
    changed: after !== before,
    occurrences,
    examples,
  };
}

function isRateLimitError(result) {
  const message = String(result?.error || '').toLowerCase();
  return result?.status === 429
    || message.includes('429')
    || message.includes('too many')
    || message.includes('rate limit');
}

function isConflictError(result) {
  const message = String(result?.error || '').toLowerCase();
  return result?.status === 409
    || message.includes('update_conflict')
    || message.includes('conflict');
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

function exampleText(item) {
  return item.examples
    .map((example) => `${example.before} → ${example.after}`)
    .join(' · ');
}

function baseSummary(candidates) {
  return {
    itemsScanned: candidates.length,
    itemsToTouch: candidates.length,
    itemsTouched: 0,
    occurrencesToReplace: candidates.reduce((sum, item) => sum + item.occurrences, 0),
    occurrencesReplaced: 0,
    conflicts: 0,
    errors: 0,
  };
}

function printHumanPlan(candidates, options) {
  console.log(`MODO DRY-RUN · workspace=${WORKSPACE} · escrituras=0${options.ref ? ` · ref=${options.ref}` : ''}`);
  console.table(candidates.map((item) => ({
    ref: item.ref,
    ocurrencias: item.occurrences,
    'primeras 2 transformaciones de ejemplo': exampleText(item),
  })));
}

function printHumanSummary(summary, mode, conflicts, errors) {
  console.log(`RESUMEN ${mode}`);
  console.log(`items_escaneados=${summary.itemsScanned}`);
  console.log(`items_a_tocar=${summary.itemsToTouch}`);
  console.log(`items_tocados=${summary.itemsTouched}`);
  console.log(`ocurrencias_a_reemplazar=${summary.occurrencesToReplace}`);
  console.log(`ocurrencias_reemplazadas=${summary.occurrencesReplaced}`);
  console.log(`conflictos=${summary.conflicts}`);
  console.log(`errores=${summary.errors}`);
  if (conflicts.length > 0) {
    console.log(`CONFLICTOS · reintento manual: ${conflicts.join(', ')}`);
  }
  if (errors.length > 0) {
    console.log('ERRORES PARCIALES');
    for (const error of errors) console.log(`  ${error.ref}: ${error.error}`);
  }
}

async function applyCandidates(candidates, log) {
  const results = [];
  const conflicts = [];
  const errors = [];
  let itemsTouched = 0;
  let occurrencesReplaced = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const position = `${index + 1}/${candidates.length}`;
    const fresh = await withRateRetry(
      () => getItem(candidate.ref, PAD_OPTS),
      `getItem ${candidate.ref}`,
      log,
    );
    if (!fresh?.ok || !fresh.data) {
      const error = fresh?.error || 'respuesta vacía al leer el ítem fresco';
      errors.push({ ref: candidate.ref, error });
      results.push({ ref: candidate.ref, status: 'error', error });
      log(`[${position}] [error] ${candidate.ref}: GET falló: ${error}`);
      continue;
    }

    const change = transformContent(fresh.data.content);
    if (!change.changed) {
      results.push({ ref: candidate.ref, status: 'sin-cambios', occurrences: 0 });
      log(`[${position}] [skip] ${candidate.ref}: el contenido fresco ya no requiere cambios`);
      continue;
    }
    if (!fresh.data.updated_at) {
      const error = 'el GET fresco no devolvió updated_at';
      errors.push({ ref: candidate.ref, error });
      results.push({ ref: candidate.ref, status: 'error', error });
      log(`[${position}] [error] ${candidate.ref}: ${error}`);
      continue;
    }

    const updated = await withRateRetry(
      () => updateItem(candidate.ref, {
        content: change.content,
        expected_updated_at: fresh.data.updated_at,
      }, PAD_OPTS),
      `updateItem ${candidate.ref}`,
      log,
    );
    if (isConflictError(updated)) {
      conflicts.push(candidate.ref);
      results.push({
        ref: candidate.ref,
        status: 'conflicto',
        occurrences: change.occurrences,
      });
      log(`[${position}] [conflicto] ${candidate.ref}: no se reintenta`);
      continue;
    }
    if (!updated?.ok) {
      const error = updated?.error || 'error desconocido al actualizar';
      errors.push({ ref: candidate.ref, error });
      results.push({ ref: candidate.ref, status: 'error', error });
      log(`[${position}] [error] ${candidate.ref}: PATCH falló: ${error}`);
      continue;
    }

    itemsTouched += 1;
    occurrencesReplaced += change.occurrences;
    results.push({
      ref: candidate.ref,
      status: 'tocado',
      occurrences: change.occurrences,
    });
    log(`[${position}] [tocado] ${candidate.ref}: ocurrencias=${change.occurrences}`);
  }

  return {
    results,
    conflicts,
    errors,
    itemsTouched,
    occurrencesReplaced,
  };
}

function dryRunItems(candidates) {
  return candidates.map((item) => ({
    ref: item.ref,
    updatedAt: item.snapshotUpdatedAt,
    occurrences: item.occurrences,
    examples: item.examples,
  }));
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
  let candidates = [];
  try {
    candidates = readCandidates(options.ref);
  } catch (error) {
    const summary = baseSummary(candidates);
    summary.errors = 1;
    const errors = [{ ref: options.ref || '[descubrimiento]', error: error.message }];
    const output = {
      ok: false,
      mode: mode.toLowerCase(),
      workspace: WORKSPACE,
      ref: options.ref,
      items: [],
      summary,
      conflicts: [],
      errors,
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else printHumanSummary(summary, mode, [], errors);
    return 2;
  }

  const summary = baseSummary(candidates);
  if (!options.apply) {
    const output = {
      ok: true,
      mode: 'dry-run',
      workspace: WORKSPACE,
      ref: options.ref,
      items: dryRunItems(candidates),
      summary,
      conflicts: [],
      errors: [],
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else {
      printHumanPlan(candidates, options);
      printHumanSummary(summary, mode, [], []);
    }
    return 0;
  }

  log(`MODO APPLY · workspace=${WORKSPACE}${options.ref ? ` · ref=${options.ref}` : ''}`);
  let applied;
  try {
    applied = await applyCandidates(candidates, log);
  } catch (error) {
    const errors = [{ ref: '[apply]', error: error.message }];
    summary.errors = 1;
    const output = {
      ok: false,
      mode: 'apply',
      workspace: WORKSPACE,
      ref: options.ref,
      items: [],
      summary,
      conflicts: [],
      errors,
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else printHumanSummary(summary, mode, [], errors);
    return 2;
  }
  summary.itemsTouched = applied.itemsTouched;
  summary.occurrencesReplaced = applied.occurrencesReplaced;
  summary.conflicts = applied.conflicts.length;
  summary.errors = applied.errors.length;
  const ok = summary.conflicts === 0 && summary.errors === 0;
  const output = {
    ok,
    mode: 'apply',
    workspace: WORKSPACE,
    ref: options.ref,
    items: applied.results,
    summary,
    conflicts: applied.conflicts,
    errors: applied.errors,
  };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printHumanSummary(summary, mode, applied.conflicts, applied.errors);
  return ok ? 0 : 2;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
