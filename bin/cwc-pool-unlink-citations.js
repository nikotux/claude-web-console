#!/usr/bin/env node
// Reparación determinística de citas del registro personal publicadas en el
// pozo común (console:BUG-3631). Dry-run es el modo por defecto.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../src/core/atomic-write.js';

const RUN_DIR = path.join(os.homedir(), '.cwc-data', 'retro-pool-citations');
const PROGRESS_FILE = path.join(RUN_DIR, 'progress.json');
const REPORT_FILE = path.join(RUN_DIR, 'report.json');
const LOCK_FILE = path.join(RUN_DIR, 'pool-citations.lock');
const LOCK_STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const APPLY_PAUSE_MS = 250;

export class IntegrityError extends Error {}

function usage() {
  return [
    'Uso: node bin/cwc-pool-unlink-citations.js [--dry-run|--apply]',
    '',
    'Dry-run es el modo por defecto. Solo opera en comunidad/mejora-continua.',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function parseArgs(argv) {
  const options = { apply: false, help: false };
  let modeSeen = null;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run' || arg === '--apply') {
      if (modeSeen && modeSeen !== arg) throw usageError('--dry-run y --apply son excluyentes.');
      modeSeen = arg;
      options.apply = arg === '--apply';
    } else {
      throw usageError(`Argumento desconocido: ${arg}`);
    }
  }
  return options;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function liveLock(lock) {
  const heartbeatAt = Date.parse(lock?.heartbeatAt || '');
  return pidAlive(Number(lock?.pid))
    && Number.isFinite(heartbeatAt)
    && Date.now() - heartbeatAt <= LOCK_STALE_MS;
}

function acquireLock() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date().toISOString();
    const lock = {
      pid: process.pid,
      host: os.hostname(),
      token: `${process.pid}-${Date.now()}`,
      startedAt: now,
      heartbeatAt: now,
    };
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
      return lock;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readJson(LOCK_FILE);
      if (liveLock(current)) return null;
      try { fs.unlinkSync(LOCK_FILE); }
      catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return null;
}

function ownsLock(lock) {
  return readJson(LOCK_FILE)?.token === lock?.token;
}

function refreshLock(lock) {
  if (!ownsLock(lock)) return;
  lock.heartbeatAt = new Date().toISOString();
  writeJsonAtomic(LOCK_FILE, lock, { mode: 0o600 });
}

function releaseLock(lock) {
  if (!ownsLock(lock)) return;
  try { fs.unlinkSync(LOCK_FILE); }
  catch (error) {
    if (error?.code !== 'ENOENT') console.error(`No se pudo liberar el lock: ${error?.message || error}`);
  }
}

// Misma segmentación de bin/cwc-pad-wikilinks-fix.js y de pool.js: el guard
// debe demostrar por separado que ningún byte de código fue modificado.
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
    pushSegment(segments, false, content.slice(codeStart));
  } else {
    pushSegment(segments, false, content.slice(plainStart));
  }
  return segments;
}

function citationAt(content, start) {
  if (!content.startsWith('[[', start)) return null;
  const end = content.indexOf(']]', start + 2);
  if (end === -1) return null;
  const inner = content.slice(start + 2, end);
  if (/[\r\n]/.test(inner)) return null;
  const separator = inner.indexOf('|');
  const source = separator === -1 ? inner : inner.slice(0, separator);
  const label = separator === -1 ? null : inner.slice(separator + 1);
  if (!source.trim() || (label !== null && !label.trim())) return null;
  return {
    end: end + 2,
    original: content.slice(start, end + 2),
    replacement: label === null ? source : label,
  };
}

function inspectPlainChanges(before, after) {
  const citations = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    const citation = citationAt(before, beforeIndex);
    if (citation && after.startsWith(citation.replacement, afterIndex)) {
      citations.push(citation.original);
      beforeIndex = citation.end;
      afterIndex += citation.replacement.length;
      continue;
    }
    if (beforeIndex < before.length
      && afterIndex < after.length
      && before[beforeIndex] === after[afterIndex]) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    return { ok: false, citations: [] };
  }
  return { ok: true, citations };
}

function inspectCitationChanges(beforeValue, afterValue) {
  const before = beforeValue == null ? '' : String(beforeValue);
  const after = afterValue == null ? '' : String(afterValue);
  const beforeSegments = tokenizeMarkdownCode(before);
  const afterSegments = tokenizeMarkdownCode(after);
  if (beforeSegments.length !== afterSegments.length) return { ok: false, citations: [] };

  const citations = [];
  for (let index = 0; index < beforeSegments.length; index += 1) {
    const left = beforeSegments[index];
    const right = afterSegments[index];
    if (left.code !== right.code) return { ok: false, citations: [] };
    if (left.code) {
      if (left.content !== right.content) return { ok: false, citations: [] };
      continue;
    }
    const inspected = inspectPlainChanges(left.content, right.content);
    if (!inspected.ok) return inspected;
    citations.push(...inspected.citations);
  }
  return { ok: true, citations };
}

export function onlyCitationBracketsChanged(before, after) {
  return inspectCitationChanges(before, after).ok;
}

function dataArray(data, key) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

function parseJsonValue(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); }
  catch { return value; }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function itemSignature(item) {
  return JSON.stringify(canonicalize({
    title: item?.title ?? null,
    fields: parseJsonValue(item?.fields, {}),
    tags: parseJsonValue(item?.tags, []),
    parent_ref: item?.parent_ref ?? null,
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureOk(result, message) {
  if (!result?.ok) throw new Error(result?.error || message);
  return result;
}

function initialProgress(options) {
  return {
    version: 1,
    mode: options.apply ? 'apply' : 'dry-run',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    items: {},
  };
}

function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  writeJsonAtomic(PROGRESS_FILE, progress, { mode: 0o600, space: 2 });
}

function recordProgress(progress, ref, status, detail = {}) {
  progress.items[ref] = {
    ...detail,
    status,
    updatedAt: new Date().toISOString(),
  };
  saveProgress(progress);
}

function freshSummary(options) {
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    total: 0,
    sinCambios: 0,
    aReparar: 0,
    reparadas: 0,
    citasQuitadas: 0,
    errores: 0,
  };
}

function printSummary(summary) {
  const changedLabel = summary.mode === 'apply'
    ? `reparadas=${summary.reparadas}`
    : `a reparar=${summary.aReparar}`;
  console.log(
    `MODO ${summary.mode.toUpperCase()} · total=${summary.total} · `
    + `sin cambios=${summary.sinCambios} · ${changedLabel}`,
  );
  console.log(`Citas quitadas=${summary.citasQuitadas} · errores=${summary.errores}`);
  console.log(`Reporte: ${REPORT_FILE}`);
}

async function run(options, progress) {
  // Los imports runtime se difieren para que --help no cargue config ni el
  // cliente de Pad.
  const [{ sharedPadContextForUser }, deps, pool] = await Promise.all([
    import('../src/core/pad-context.js'),
    import('../src/core/pad-service-client.js'),
    import('../src/modules/retro/pool.js'),
  ]);
  const ctx = sharedPadContextForUser(null);
  if (!ctx?.token || ctx.workspace !== 'comunidad') {
    throw new Error('Falta el contexto válido para el workspace comunidad.');
  }

  const listed = ensureOk(
    await deps.listItems(pool.POOL_COLLECTION, { ctx }),
    `No se pudo listar ${pool.POOL_COLLECTION}.`,
  );
  const lessons = dataArray(listed.data, 'items');
  const summary = freshSummary(options);
  summary.total = lessons.length;
  const reportItems = [];
  let integrityError = null;

  try {
    for (let index = 0; index < lessons.length; index += 1) {
      const summaryItem = lessons[index];
      const ref = summaryItem?.ref || `item-${index}`;
      try {
        if (!summaryItem?.ref) throw new Error('La colección devolvió una lección sin ref.');
        const freshResult = ensureOk(
          await deps.getItem(ref, { ctx }),
          `No se pudo leer ${ref}.`,
        );
        if (!freshResult.data) throw new Error(`La lectura de ${ref} no devolvió datos.`);
        const before = freshResult.data.content == null ? '' : String(freshResult.data.content);
        const after = pool.neutralizePoolCitations(before);
        if (after === before) {
          summary.sinCambios += 1;
          reportItems.push({
            ref,
            status: 'sin-cambios',
            citasQuitadas: 0,
            citasOriginales: [],
          });
          recordProgress(progress, ref, 'sin-cambios', { citasQuitadas: 0 });
          continue;
        }

        if (!onlyCitationBracketsChanged(before, after)) {
          throw new IntegrityError(`${ref}: el guard rechazó cambios ajenos a las citas.`);
        }
        const inspected = inspectCitationChanges(before, after);
        summary.aReparar += 1;
        const reportItem = {
          ref,
          status: options.apply ? 'pendiente' : 'a-reparar',
          citasQuitadas: inspected.citations.length,
          citasOriginales: inspected.citations,
          ...(options.apply ? { contentBefore: before } : {}),
        };
        reportItems.push(reportItem);

        if (!options.apply) {
          summary.citasQuitadas += inspected.citations.length;
          recordProgress(progress, ref, 'a-reparar', {
            citasQuitadas: inspected.citations.length,
          });
          continue;
        }

        if (!freshResult.data.updated_at) {
          throw new Error(`${ref}: el GET fresco no devolvió updated_at.`);
        }
        const signatureBefore = itemSignature(freshResult.data);
        const updated = await deps.updateItem(
          ref,
          { content: after },
          { ctx, expectedUpdatedAt: freshResult.data.updated_at },
        );
        if (!updated?.ok) throw new Error(updated?.error || `No se pudo actualizar ${ref}.`);

        // El PATCH exitoso invalida la caché del workspace; este GET relee Pad.
        const verified = await deps.getItem(ref, { ctx });
        if (!verified?.ok || !verified.data) {
          throw new IntegrityError(`${ref}: no se pudo verificar la escritura; se detiene toda la corrida.`);
        }
        if (String(verified.data.content ?? '') !== after) {
          throw new IntegrityError(`${ref}: el contenido verificado difiere; se detiene toda la corrida.`);
        }
        if (itemSignature(verified.data) !== signatureBefore) {
          throw new IntegrityError(`${ref}: cambió title, fields, tags o parent_ref; se detiene toda la corrida.`);
        }

        summary.reparadas += 1;
        summary.citasQuitadas += inspected.citations.length;
        reportItem.status = 'reparada';
        recordProgress(progress, ref, 'reparada', {
          citasQuitadas: inspected.citations.length,
        });
      } catch (error) {
        if (error instanceof IntegrityError) {
          integrityError = error;
          summary.errores += 1;
          const existing = reportItems.find((item) => item.ref === ref);
          if (existing) {
            existing.status = 'integridad';
            existing.error = error.message;
          } else {
            reportItems.push({
              ref,
              status: 'integridad',
              citasQuitadas: 0,
              citasOriginales: [],
              error: error.message,
            });
          }
          recordProgress(progress, ref, 'integridad', { error: error.message });
          break;
        }
        summary.errores += 1;
        const message = String(error?.message || error).slice(0, 500);
        const existing = reportItems.find((item) => item.ref === ref);
        if (existing) {
          existing.status = 'error';
          existing.error = message;
        } else {
          reportItems.push({
            ref,
            status: 'error',
            citasQuitadas: 0,
            citasOriginales: [],
            error: message,
          });
        }
        recordProgress(progress, ref, 'error', { error: message });
        console.error(`[${ref}] ${message}`);
      }
      if (options.apply && index < lessons.length - 1) await sleep(APPLY_PAUSE_MS);
    }
  } finally {
    writeJsonAtomic(REPORT_FILE, {
      generatedAt: new Date().toISOString(),
      startedAt: progress.startedAt,
      summary,
      items: reportItems,
    }, { mode: 0o600, space: 2 });
    printSummary(summary);
  }
  if (integrityError) throw integrityError;
  return summary.errores > 0 ? 1 : 0;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    console.error(usage());
    return 1;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const lock = acquireLock();
  if (!lock) {
    console.error('Ya hay una corrida viva de cwc-pool-unlink-citations.js.');
    return 2;
  }
  const heartbeat = setInterval(() => refreshLock(lock), HEARTBEAT_MS);
  heartbeat.unref?.();
  const progress = initialProgress(options);
  saveProgress(progress);
  let exitCode = 1;
  try {
    exitCode = await run(options, progress);
    progress.status = exitCode === 0 ? 'done' : 'partial';
  } catch (error) {
    exitCode = error instanceof IntegrityError ? 3 : 1;
    progress.status = error instanceof IntegrityError ? 'integrity-error' : 'error';
    progress.error = String(error?.message || error).slice(0, 500);
    console.error(`FALLO: ${progress.error}`);
  } finally {
    clearInterval(heartbeat);
    saveProgress(progress);
    releaseLock(lock);
  }
  return exitCode;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
