#!/usr/bin/env node
// Organizador determinístico del pozo común (console:PLAN-3595). Reconcilia
// tema principal, tags e implements sin IA. Dry-run es el modo por defecto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../src/core/atomic-write.js';
import {
  poolLessonTags, POOL_TOPICS_COLLECTION, POOL_TOPIC_FALLBACK, POOL_TOPIC_SLUGS,
} from '../src/modules/retro/pool-topics.js';

const RUN_DIR = path.join(os.homedir(), '.cwc-data', 'retro-pool-organize');
const DEFAULT_MAP_FILE = path.join(RUN_DIR, 'temas.json');
const PROGRESS_FILE = path.join(RUN_DIR, 'progress.json');
const REPORT_FILE = path.join(RUN_DIR, 'report.json');
const LOCK_FILE = path.join(RUN_DIR, 'pool-organize.lock');
const LOCK_STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const APPLY_PAUSE_MS = 250;
const ALL_TOPIC_SLUGS = [...POOL_TOPIC_SLUGS, POOL_TOPIC_FALLBACK];

class IntegrityError extends Error {}

function usage() {
  return [
    'Uso:',
    '  node bin/cwc-pool-organize.js [--dry-run] [--map <archivo>] [--reparent]',
    '  node bin/cwc-pool-organize.js --apply [--map <archivo>] [--reparent]',
    '',
    'Dry-run es el modo por defecto. --reparent habilita cambiar padres no fallback.',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function parseArgs(argv) {
  const options = {
    apply: false, help: false, mapFile: DEFAULT_MAP_FILE, mapExplicit: false, reparent: false,
  };
  let modeSeen = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run' || arg === '--apply') {
      if (modeSeen && modeSeen !== arg) throw usageError('--dry-run y --apply son excluyentes.');
      modeSeen = arg;
      options.apply = arg === '--apply';
    } else if (arg === '--map') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw usageError('Falta el archivo de --map.');
      options.mapFile = path.resolve(value);
      options.mapExplicit = true;
      index += 1;
    } else if (arg === '--reparent') {
      options.reparent = true;
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

function readTopicMap(options) {
  if (!fs.existsSync(options.mapFile)) {
    if (options.mapExplicit) throw new Error(`No existe el archivo de mapa: ${options.mapFile}`);
    return {};
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(options.mapFile, 'utf8')); }
  catch (error) { throw new Error(`No se pudo leer el mapa ${options.mapFile}: ${error?.message || error}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('El mapa debe ser un objeto JSON por ref de lección.');
  }

  const invalid = [];
  for (const [ref, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid.push(`${ref}: entrada inválida`);
      continue;
    }
    if (!ALL_TOPIC_SLUGS.includes(entry.tema)) invalid.push(`${ref}: ${String(entry.tema)}`);
    if (entry.otros !== undefined && !Array.isArray(entry.otros)) {
      invalid.push(`${ref}: otros no es un array`);
      continue;
    }
    for (const slug of (entry.otros || [])) {
      if (!ALL_TOPIC_SLUGS.includes(slug)) invalid.push(`${ref}: ${String(slug)}`);
    }
  }
  if (invalid.length) {
    throw new Error(`Slugs inválidos en el mapa: ${[...new Set(invalid)].join(', ')}`);
  }
  return parsed;
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
  writeJsonAtomic(LOCK_FILE, lock);
}

function releaseLock(lock) {
  if (!ownsLock(lock)) return;
  try { fs.unlinkSync(LOCK_FILE); }
  catch (error) {
    if (error?.code !== 'ENOENT') console.error(`No se pudo liberar el lock: ${error?.message || error}`);
  }
}

function dataArray(data, key) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

function parseFields(item) {
  if (item?.fields && typeof item.fields === 'object') return item.fields;
  try { return JSON.parse(item?.fields || '{}'); }
  catch { return {}; }
}

function parseTags(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function targetRef(link) {
  return link?.target_ref || link?.target?.ref || link?.target_item?.ref || null;
}

function outgoingLinks(ref, links) {
  return dataArray(links, 'links').filter((link) => !link?.source_ref || link.source_ref === ref);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function contentHash(item) {
  return crypto.createHash('sha256')
    .update(String(item?.title || ''))
    .update('\0')
    .update(String(item?.content || ''))
    .digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureOk(result, message) {
  if (!result?.ok) throw new Error(result?.error || message);
  return result;
}

function initialProgress(options) {
  const previous = readJson(PROGRESS_FILE, {});
  return {
    version: 1,
    mode: options.apply ? 'apply' : 'dry-run',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    mapFile: options.mapFile,
    reparent: options.reparent,
    items: previous?.items && typeof previous.items === 'object' ? previous.items : {},
  };
}

function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  writeJsonAtomic(PROGRESS_FILE, progress, { space: 2 });
}

function recordProgress(progress, ref, status, detail = {}) {
  progress.items[ref] = {
    ...(progress.items[ref] || {}),
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
    aConectar: 0,
    reparentar: 0,
    conflicto: 0,
    sinMapa: 0,
    tagsACambiar: 0,
    implementsACrear: 0,
    errores: 0,
    porTema: Object.fromEntries(ALL_TOPIC_SLUGS.map((slug) => [slug, 0])),
  };
}

async function loadTopics(ctx, deps) {
  const listed = ensureOk(
    await deps.listItems(POOL_TOPICS_COLLECTION, { ctx }),
    `No se pudo listar ${POOL_TOPICS_COLLECTION}.`,
  );
  const bySlug = new Map();
  for (const item of dataArray(listed.data, 'items')) {
    const slug = parseFields(item).slug;
    if (slug && item?.ref && !bySlug.has(slug)) bySlug.set(slug, item);
  }
  const missing = ALL_TOPIC_SLUGS.filter((slug) => !bySlug.has(slug));
  if (missing.length) throw new Error(`Faltan temas requeridos en Pad: ${missing.join(', ')}`);
  return bySlug;
}

async function planLesson(summaryItem, topicMap, topics, ctx, options, summary, deps) {
  const detailResult = ensureOk(await deps.getItem(summaryItem.ref, { ctx }), `No se pudo leer ${summaryItem.ref}.`);
  const item = detailResult.data;
  const linksResult = ensureOk(await deps.listLinks(item.ref, { ctx }), `No se pudieron leer links de ${item.ref}.`);
  const links = outgoingLinks(item.ref, linksResult.data);
  const parentLinks = links.filter((link) => link?.link_type === 'parent');
  if (parentLinks.length > 1) throw new Error(`${item.ref} tiene más de un parent real.`);

  const mapped = topicMap[item.ref];
  const topic = mapped?.tema || POOL_TOPIC_FALLBACK;
  const otherTopics = [...new Set((mapped?.otros || []).filter((slug) => slug !== topic))];
  const desiredTopic = topics.get(topic);
  const fallbackRef = topics.get(POOL_TOPIC_FALLBACK).ref;
  const fields = parseFields(item);
  const existingTags = parseTags(item.tags);
  const tags = poolLessonTags({
    topic,
    project: fields.project,
    category: fields.category,
    existing: existingTags,
  });
  const currentParent = parentLinks[0] || (item.parent_ref ? {
    id: item.parent_link_id,
    target_ref: item.parent_ref,
    link_type: 'parent',
  } : null);
  const currentParentRef = targetRef(currentParent);
  let parentAction = null;
  let conflict = false;
  if (!currentParentRef) {
    parentAction = 'connect';
  } else if (currentParentRef !== desiredTopic.ref) {
    const fallbackUpgrade = currentParentRef === fallbackRef && topic !== POOL_TOPIC_FALLBACK;
    // --reparent exige una entrada explícita en el mapa.
    if (fallbackUpgrade || (options.reparent && mapped)) parentAction = 'reparent';
    else conflict = true;
  }

  const tagsChange = !conflict && !sameStrings(existingTags, tags);
  const missingImplements = conflict ? [] : otherTopics.filter((slug) => {
    const target = topics.get(slug)?.ref;
    return !links.some((link) => link?.link_type === 'implements' && targetRef(link) === target);
  });

  if (parentAction === 'connect') summary.aConectar += 1;
  if (parentAction === 'reparent') summary.reparentar += 1;
  if (conflict) summary.conflicto += 1;
  if (tagsChange) summary.tagsACambiar += 1;
  summary.implementsACrear += missingImplements.length;
  if (!conflict && !parentAction && !tagsChange && missingImplements.length === 0) summary.sinCambios += 1;

  return {
    item,
    topic,
    desiredTopic,
    currentParent,
    parentAction,
    conflict,
    tags,
    tagsChange,
    missingImplements,
  };
}

async function applyLesson(plan, topics, ctx, deps) {
  const beforeHash = contentHash(plan.item);
  let wrote = false;
  let operationError = null;
  try {
    if (plan.parentAction === 'reparent') {
      if (!plan.currentParent?.id) throw new Error(`${plan.item.ref}: parent sin parent_link_id.`);
      ensureOk(await deps.deleteLink(plan.currentParent.id, { ctx }), `No se pudo borrar el parent de ${plan.item.ref}.`);
      wrote = true;
    }
    if (plan.parentAction) {
      ensureOk(
        await deps.setParent(plan.item.ref, plan.desiredTopic.ref, { ctx }),
        `No se pudo fijar el parent de ${plan.item.ref}.`,
      );
      wrote = true;
    }
    if (plan.tagsChange) {
      ensureOk(
        await deps.updateItem(plan.item.ref, { tags: plan.tags }, { ctx }),
        `No se pudieron actualizar los tags de ${plan.item.ref}.`,
      );
      wrote = true;
    }
    for (const slug of plan.missingImplements) {
      ensureOk(
        await deps.addLink(plan.item.ref, topics.get(slug).ref, 'implements', { ctx }),
        `No se pudo crear implements ${plan.item.ref} → ${slug}.`,
      );
      wrote = true;
    }
  } catch (error) {
    operationError = error;
  }

  if (wrote) {
    const fresh = ensureOk(
      await deps.getItem(plan.item.ref, { ctx }),
      `No se pudo verificar título/contenido de ${plan.item.ref}.`,
    );
    if (contentHash(fresh.data) !== beforeHash) {
      throw new IntegrityError(`${plan.item.ref}: cambió title o content; se detiene toda la corrida.`);
    }
  }
  if (operationError) throw operationError;
}

function reportFor(summary, progress) {
  const { options, ...publicSummary } = summary;
  return {
    generatedAt: new Date().toISOString(),
    startedAt: progress.startedAt,
    summary: publicSummary,
  };
}

function printSummary(summary) {
  console.log(`MODO ${summary.mode.toUpperCase()} · total=${summary.total} · sin cambios=${summary.sinCambios}`);
  console.log(`A conectar=${summary.aConectar} · reparentar=${summary.reparentar} · conflicto=${summary.conflicto} · sin-mapa=${summary.sinMapa}`);
  console.log(`Tags a cambiar=${summary.tagsACambiar} · implements a crear=${summary.implementsACrear} · errores=${summary.errores}`);
  console.log(`Por tema: ${Object.entries(summary.porTema).map(([slug, count]) => `${slug}:${count}`).join(', ')}`);
}

async function run(options, topicMap, progress) {
  // Los imports runtime se difieren para que --help y los errores de mapa no
  // carguen config ni dependencias del server.
  const [{ sharedPadContextForUser }, deps, { POOL_COLLECTION }] = await Promise.all([
    import('../src/core/pad-context.js'),
    import('../src/core/pad-service-client.js'),
    import('../src/modules/retro/pool.js'),
  ]);
  const ctx = sharedPadContextForUser(null);
  if (!ctx?.token) throw new Error('Falta el token del host para el workspace comunidad.');
  // Esta validación completa ocurre antes de cualquier escritura en Pad.
  const topics = await loadTopics(ctx, deps);
  const listed = ensureOk(await deps.listItems(POOL_COLLECTION, { ctx }), `No se pudo listar ${POOL_COLLECTION}.`);
  const lessons = dataArray(listed.data, 'items');
  const summary = freshSummary(options);
  summary.total = lessons.length;
  for (const lesson of lessons) {
    const mapped = topicMap[lesson.ref];
    const topic = mapped?.tema || POOL_TOPIC_FALLBACK;
    summary.porTema[topic] += 1;
    if (!mapped) summary.sinMapa += 1;
  }
  let integrityError = null;

  try {
    for (let index = 0; index < lessons.length; index += 1) {
      const lesson = lessons[index];
      try {
        const plan = await planLesson(lesson, topicMap, topics, ctx, options, summary, deps);
        if (plan.conflict) {
          recordProgress(progress, lesson.ref, 'conflicto', {
            actual: targetRef(plan.currentParent),
            deseado: plan.desiredTopic.ref,
          });
        } else if (!options.apply) {
          recordProgress(progress, lesson.ref, 'planificado', {
            tema: plan.topic,
            parent: plan.parentAction,
            tags: plan.tagsChange,
            implements: plan.missingImplements,
          });
        } else {
          await applyLesson(plan, topics, ctx, deps);
          recordProgress(progress, lesson.ref, 'ok', { tema: plan.topic });
        }
      } catch (error) {
        if (error instanceof IntegrityError) {
          integrityError = error;
          summary.errores += 1;
          recordProgress(progress, lesson.ref, 'integridad', { error: error.message });
          break;
        }
        summary.errores += 1;
        const message = String(error?.message || error).slice(0, 500);
        recordProgress(progress, lesson.ref || `item-${index}`, 'error', { error: message });
        console.error(`[${lesson.ref || index}] ${message}`);
      }
      if (options.apply && index < lessons.length - 1) await sleep(APPLY_PAUSE_MS);
    }
  } finally {
    writeJsonAtomic(REPORT_FILE, reportFor(summary, progress), { space: 2 });
    printSummary(summary);
    console.log(`Reporte: ${REPORT_FILE}`);
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
    process.exit(1);
  }
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  let topicMap;
  try { topicMap = readTopicMap(options); }
  catch (error) {
    console.error(`FALLO: ${error?.message || error}`);
    process.exit(1);
  }

  const lock = acquireLock();
  if (!lock) {
    console.error('Ya hay una corrida viva de cwc-pool-organize.js.');
    process.exit(2);
  }
  const heartbeat = setInterval(() => refreshLock(lock), HEARTBEAT_MS);
  heartbeat.unref?.();
  const progress = initialProgress(options);
  saveProgress(progress);
  let exitCode = 1;
  try {
    exitCode = await run(options, topicMap, progress);
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
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`FALLO inesperado: ${error?.message || error}`);
  process.exit(1);
});
