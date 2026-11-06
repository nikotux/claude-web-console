#!/usr/bin/env node
// Backfill determinístico del pozo COMÚN (console:PLAN-3595). Recorre los
// registros propios, vuelve a aplicar opt-out/vetos y publica sin LLM. Dry-run
// es el default: sólo lee Pad y escribe reporte/progreso local.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, writeJsonAtomic } from '../src/core/atomic-write.js';
import { resolveDataDir } from '../src/core/data-dir.js';
import { padContextForUser, sharedPadContextForUser } from '../src/core/pad-context.js';
import { hostUser } from '../src/core/user-space.js';
// Este entry point del host lee registros por dueño, por eso instala los resolvers.
import '../src/modules/retro/server-shared.js';
import {
  computeFingerprint, listLessons, ownerFor, retroDataDirFor,
} from '../src/modules/retro/store.js';
import {
  isShareOptedOut, isUnsharedFingerprint, listPoolLessons,
  markUnsharedFingerprint, shareLessonToPool,
} from '../src/modules/retro/pool.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERS_FILE = path.join(PROJECT_ROOT, 'users.json');
const RUN_DIR = path.join(resolveDataDir(), 'retro-pool-backfill');
const REPORT_FILE = path.join(RUN_DIR, 'report.json');
const MARKED_LIST_FILE = path.join(RUN_DIR, 'lista-marcadas.md');
const PROGRESS_FILE = path.join(RUN_DIR, 'progress.json');
const LOCK_FILE = path.join(RUN_DIR, 'pool-backfill.lock');
const HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const PUBLISH_PAUSE_MS = 400;
const PROJECTS = ['console', 'tolkien', 'otros'];

const FLAG_RULES = [
  ['ref-interna', /(?:console:|\b(?:PLAN-\d+|BUG-\d+|CONVE-\d+|ARQUI-\d+|TASK-\d+)\b)/i],
  ['secreto', /(?:token|password|api[-_\s]*key|credencial|secret)/i],
  ['ruta-local', /(?:\/home\/|~\/\.|\.cwc-|(?:^|[\/\s])\.env\b)/i],
  ['ip', /(?:\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b)/i],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['chris', /\bchris\b/i],
  ['ceo', /\bceo\b/i],
  ['credencial-literal', /(?:\bpadsess_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._-]{20,}|\bCWC_TOKEN=\S+)/i],
];

function usage() {
  return [
    'Uso:',
    '  node bin/cwc-pool-backfill.js [--dry-run] [--only <usuario>] [--skip-refs owner:MC-n,...]',
    '  node bin/cwc-pool-backfill.js --apply [--only <usuario>] [--skip-refs owner:MC-n,...]',
    '',
    'Dry-run es el modo por defecto y no escribe en Pad.',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function parseArgs(argv) {
  const options = { apply: false, only: null, skipRefs: new Set(), help: false };
  let modeSeen = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run' || arg === '--apply') {
      if (modeSeen && modeSeen !== arg) throw usageError('--dry-run y --apply son excluyentes.');
      modeSeen = arg;
      options.apply = arg === '--apply';
    } else if (arg === '--only') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw usageError('Falta el usuario de --only.');
      options.only = value;
      index += 1;
    } else if (arg === '--skip-refs') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw usageError('Falta la lista de --skip-refs.');
      for (const ref of value.split(',').map((item) => item.trim()).filter(Boolean)) {
        if (!/^[a-zA-Z0-9_.-]+:MC-\d+$/.test(ref)) {
          throw usageError(`Referencia inválida en --skip-refs: ${ref}`);
        }
        options.skipRefs.add(ref);
      }
      index += 1;
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
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
      catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
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

function configuredUsers() {
  const configured = readJson(USERS_FILE, { users: [] });
  const host = hostUser();
  const ids = new Set([host]);
  for (const user of (Array.isArray(configured?.users) ? configured.users : [])) {
    const username = String(user?.username || '').trim();
    if (/^[a-zA-Z0-9_.-]{1,32}$/.test(username)) ids.add(username);
  }
  return [...ids]
    .map((userId) => ({ userId, owner: userId === host ? 'host' : userId }))
    .sort((a, b) => (a.owner === 'host' ? -1 : b.owner === 'host' ? 1 : a.owner.localeCompare(b.owner)));
}

function selectUsers(users, only) {
  if (!only) return users;
  const selected = users.filter((user) => user.owner === only || user.userId === only);
  if (selected.length === 0) throw usageError(`Usuario inexistente para --only: ${only}`);
  return selected;
}

function sharedByForContext(ctx) {
  const tenant = String(ctx?.workspace || '').match(/^tenant-(.+)$/);
  return tenant ? tenant[1] : 'host';
}

function flagsFor(lesson) {
  const text = `${lesson?.title || ''}\n${lesson?.body || ''}`;
  return FLAG_RULES.filter(([, pattern]) => pattern.test(text)).map(([flag]) => flag);
}

function emptyUserSummary() {
  return {
    lessons: 0,
    candidates: 0,
    excluded: {},
    wouldMerge: 0,
    projectMismatches: 0,
    published: 0,
    failed: 0,
  };
}

function emptyProjectSummary() {
  return { lessons: 0, candidates: 0, excluded: {}, wouldMerge: 0, projectMismatches: 0 };
}

function freshSummary(mode) {
  return {
    mode,
    users: {},
    projects: Object.fromEntries(PROJECTS.map((project) => [project, emptyProjectSummary()])),
    excludedByReason: {},
    totals: {
      users: 0,
      lessons: 0,
      candidates: 0,
      excluded: 0,
      wouldMerge: 0,
      projectMismatches: 0,
      published: 0,
      failed: 0,
    },
  };
}

function addCount(object, key, amount = 1) {
  object[key] = (Number(object[key]) || 0) + amount;
}

function recordExcluded(summary, owner, project, reason) {
  addCount(summary.users[owner].excluded, reason);
  addCount(summary.projects[project].excluded, reason);
  addCount(summary.excludedByReason, reason);
  summary.totals.excluded += 1;
}

function initialProgress(mode, options) {
  const previous = readJson(PROGRESS_FILE, {});
  return {
    version: 1,
    mode,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    only: options.only,
    items: previous?.items && typeof previous.items === 'object' ? previous.items : {},
  };
}

function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  writeJsonAtomic(PROGRESS_FILE, progress, { space: 2 });
}

function recordProgress(progress, key, status, detail = {}) {
  const previous = progress.items[key] || {};
  progress.items[key] = {
    ...previous,
    ...detail,
    status,
    attempts: (Number(previous.attempts) || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  saveProgress(progress);
}

function poolMap(lessons) {
  return new Map((lessons || []).filter((lesson) => lesson.fingerprint).map((lesson) => [
    lesson.fingerprint,
    { ...lesson, sharedBy: [...(lesson.sharedBy || [])] },
  ]));
}

function excludedReason({ lesson, optedOut, dataDir, skipKey, existingInPool, sharedBy }) {
  if (skipKey) return 'skip-ref';
  if (lesson.status === 'descartada') return 'descartada';
  if (optedOut) return 'opt-out';
  if (isUnsharedFingerprint(lesson.fingerprint, dataDir)) return 'vetada';
  if (existingInPool?.sharedBy?.includes(sharedBy)) return 'ya-donante';
  // Una copia adoptada conserva la huella del pozo pero no vuelve adoptante al
  // usuario donante: republicarla inflaría artificialmente la recurrencia.
  if (existingInPool) return 'ya-en-pozo';
  return null;
}

async function freshInventory(users, options, summary, progress) {
  const contexts = users.map((user) => ({
    ...user,
    ctx: padContextForUser(user.userId),
    sharedCtx: sharedPadContextForUser(user.userId),
  }));
  const readable = contexts.find((user) => user.sharedCtx?.token);
  if (!readable) throw new Error('Ningún usuario tiene token para leer el pozo comunidad.');
  const pooled = await listPoolLessons(readable.sharedCtx);
  if (!pooled.ok) throw new Error(`No se pudo leer el pozo comunidad: ${pooled.error}`);
  const initialPool = poolMap(pooled.lessons);
  const plannedPool = poolMap(pooled.lessons);
  const candidates = [];

  for (const user of contexts) {
    summary.users[user.owner] = emptyUserSummary();
    summary.totals.users += 1;
    if (!user.sharedCtx?.token) {
      recordExcluded(summary, user.owner, 'otros', 'sin-token');
      recordProgress(progress, `${user.owner}:*`, 'omitido', { reason: 'sin-token' });
      console.warn(`${user.owner}: sin token propio; se omite (fail-closed).`);
      continue;
    }

    const dataDir = retroDataDirFor(ownerFor(user.ctx, user.userId));
    const optedOut = isShareOptedOut(dataDir);
    let own;
    try {
      own = await listLessons(user.ctx);
    } catch (error) {
      recordExcluded(summary, user.owner, 'otros', 'error-lectura');
      summary.users[user.owner].failed += 1;
      summary.totals.failed += 1;
      recordProgress(progress, `${user.owner}:*`, 'error', {
        reason: 'error-lectura',
        error: String(error?.message || error).slice(0, 300),
      });
      console.error(`${user.owner}: no se pudieron leer sus lecciones: ${error?.message || error}`);
      continue;
    }

    for (const lesson of (own.lessons || [])) {
      const fingerprint = lesson.fingerprint || computeFingerprint(lesson.category, lesson.title);
      const effectiveLesson = { ...lesson, fingerprint };
      const project = PROJECTS.includes(lesson.project) ? lesson.project : 'otros';
      const key = `${user.owner}:${lesson.id}`;
      const skipKey = options.skipRefs.has(key) ? key : null;
      const existingInPool = initialPool.get(fingerprint);
      const existing = plannedPool.get(fingerprint);
      const sharedBy = sharedByForContext(user.ctx);
      summary.users[user.owner].lessons += 1;
      summary.projects[project].lessons += 1;
      summary.totals.lessons += 1;
      if (skipKey && options.apply) {
        markUnsharedFingerprint(fingerprint, dataDir);
      }
      const reason = excludedReason({
        lesson: effectiveLesson, optedOut, dataDir, skipKey, existingInPool, sharedBy,
      });
      if (reason) {
        recordExcluded(summary, user.owner, project, reason);
        recordProgress(progress, key, reason === 'skip-ref' && options.apply ? 'vetada' : 'excluida', {
          fingerprint,
          reason,
        });
        continue;
      }

      const willMerge = !!existing;
      const projectMismatch = !!existing && existing.project !== project;
      const candidate = {
        owner: user.owner,
        ref: lesson.id,
        project,
        category: lesson.category,
        title: lesson.title,
        fingerprint,
        willMerge,
        projectMismatch,
        flags: flagsFor(lesson),
      };
      Object.defineProperties(candidate, {
        lesson: { value: effectiveLesson, enumerable: false },
        sharedBy: { value: sharedBy, enumerable: false },
        sharedCtx: { value: user.sharedCtx, enumerable: false },
      });
      candidates.push(candidate);
      summary.users[user.owner].candidates += 1;
      summary.projects[project].candidates += 1;
      summary.totals.candidates += 1;
      if (willMerge) {
        summary.users[user.owner].wouldMerge += 1;
        summary.projects[project].wouldMerge += 1;
        summary.totals.wouldMerge += 1;
      }
      if (projectMismatch) {
        summary.users[user.owner].projectMismatches += 1;
        summary.projects[project].projectMismatches += 1;
        summary.totals.projectMismatches += 1;
      }

      if (existing) {
        if (!existing.sharedBy.includes(sharedBy)) existing.sharedBy.push(sharedBy);
      } else {
        plannedPool.set(fingerprint, { project, sharedBy: [sharedBy] });
      }
      if (!options.apply) recordProgress(progress, key, 'candidata', { fingerprint });
    }
  }
  return candidates;
}

function reportFor(summary, candidates, startedAt) {
  return {
    generatedAt: new Date().toISOString(),
    startedAt,
    summary,
    candidates,
  };
}

function markdownCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function markedListFor(candidates) {
  const countByOwnerProject = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.owner}\0${candidate.project}`;
    countByOwnerProject.set(key, (countByOwnerProject.get(key) || 0) + 1);
  }
  const summaryRows = [...countByOwnerProject.entries()]
    .map(([key, count]) => {
      const [owner, project] = key.split('\0');
      return { owner, project, count };
    })
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.project.localeCompare(b.project));
  const marked = candidates
    .filter((candidate) => candidate.flags.length > 0)
    .sort((a, b) => (
      Number(b.flags.includes('credencial-literal')) - Number(a.flags.includes('credencial-literal'))
      || b.flags.length - a.flags.length
      || a.ref.localeCompare(b.ref)
    ));
  const owners = [...new Set(marked.map((candidate) => candidate.owner))].sort();
  const lines = [
    '# Lista de candidatas marcadas',
    '',
    `Generada: ${new Date().toISOString()}`,
    '',
    '## Resumen de lo que se publicaría',
    '',
  ];
  if (summaryRows.length === 0) {
    lines.push('No hay candidatas para publicar.', '');
  } else {
    lines.push('| Dueño | Proyecto | Cantidad |', '| --- | --- | ---: |');
    for (const row of summaryRows) {
      lines.push(`| ${markdownCell(row.owner)} | ${markdownCell(row.project)} | ${row.count} |`);
    }
    lines.push('');
  }
  lines.push('## Candidatas con marcas', '');
  if (owners.length === 0) {
    lines.push('No hay candidatas con marcas.', '');
  }
  for (const owner of owners) {
    lines.push(`### ${markdownCell(owner)}`, '');
    lines.push('| Ref | Proyecto | Categoría | Título | Marcas |', '| --- | --- | --- | --- | --- |');
    for (const candidate of marked.filter((item) => item.owner === owner)) {
      lines.push(`| ${markdownCell(candidate.ref)} | ${markdownCell(candidate.project)} | ${markdownCell(candidate.category)} | ${markdownCell(candidate.title)} | ${candidate.flags.map(markdownCell).join(', ')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function printSummary(summary) {
  const totals = summary.totals;
  console.log(`MODO ${summary.mode.toUpperCase()} · usuarios=${totals.users} · lecciones=${totals.lessons} · candidatas=${totals.candidates}`);
  console.log(`Se fusionarían=${totals.wouldMerge} · fusiones con etiqueta distinta=${totals.projectMismatches} · excluidas=${totals.excluded} · fallos=${totals.failed}`);
  for (const [owner, item] of Object.entries(summary.users)) {
    const excluded = Object.entries(item.excluded).map(([reason, count]) => `${reason}:${count}`).join(', ') || 'ninguna';
    console.log(`  ${owner}: lecciones=${item.lessons} candidatas=${item.candidates} merge=${item.wouldMerge} mismatch=${item.projectMismatches} excluidas=[${excluded}]`);
  }
  for (const [project, item] of Object.entries(summary.projects)) {
    console.log(`  project:${project}: lecciones=${item.lessons} candidatas=${item.candidates} merge=${item.wouldMerge} mismatch=${item.projectMismatches}`);
  }
  const reasons = Object.entries(summary.excludedByReason).map(([reason, count]) => `${reason}:${count}`).join(', ') || 'ninguna';
  console.log(`  excluidas por motivo: ${reasons}`);
}

function publicLesson(lesson) {
  return {
    id: lesson.id,
    title: lesson.title,
    body: lesson.body,
    category: lesson.category,
    project: lesson.project,
    destination: lesson.destination,
    confidence: lesson.confidence,
    fingerprint: lesson.fingerprint,
    sourceRefs: lesson.sourceRefs,
  };
}

async function applyCandidates(candidates, summary, progress) {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const key = `${candidate.owner}:${candidate.ref}`;
    try {
      const result = await shareLessonToPool(publicLesson(candidate.lesson), candidate.sharedCtx, {
        sharedBy: candidate.sharedBy,
        sharedFrom: candidate.ref,
      });
      if (!result?.ok) throw new Error(result?.error || 'Pad rechazó la publicación.');
      summary.users[candidate.owner].published += 1;
      summary.totals.published += 1;
      recordProgress(progress, key, 'publicada', {
        fingerprint: candidate.fingerprint,
        poolRef: result.ref || null,
      });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      summary.users[candidate.owner].failed += 1;
      summary.totals.failed += 1;
      recordProgress(progress, key, 'error', { fingerprint: candidate.fingerprint, error: message });
      console.error(`${key}: ${message}`);
    }
    if (index < candidates.length - 1) await new Promise((resolve) => setTimeout(resolve, PUBLISH_PAUSE_MS));
  }
}

async function run(options, progress) {
  const mode = options.apply ? 'apply' : 'dry-run';
  const users = selectUsers(configuredUsers(), options.only);
  const summary = freshSummary(mode);
  // Esta lectura fresca es la reverificación de candidatas al arrancar: no se
  // confía en reportes ni progresos anteriores para decidir qué publicar.
  const candidates = await freshInventory(users, options, summary, progress);
  writeJsonAtomic(REPORT_FILE, reportFor(summary, candidates, progress.startedAt), { space: 2 });
  if (!options.apply) writeFileAtomic(MARKED_LIST_FILE, markedListFor(candidates));
  printSummary(summary);

  if (options.apply) {
    await applyCandidates(candidates, summary, progress);
    writeJsonAtomic(REPORT_FILE, reportFor(summary, candidates, progress.startedAt), { space: 2 });
    console.log(`Aplicación terminada: publicadas=${summary.totals.published} · fallos=${summary.totals.failed}`);
  } else {
    console.log(`Reporte: ${REPORT_FILE}`);
    console.log(`Lista legible: ${MARKED_LIST_FILE}`);
  }
  return summary.totals.failed > 0 ? 1 : 0;
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

  const lock = acquireLock();
  if (!lock) {
    console.error('Ya hay una corrida viva de cwc-pool-backfill.js.');
    process.exit(2);
  }
  const heartbeat = setInterval(() => refreshLock(lock), HEARTBEAT_MS);
  heartbeat.unref?.();
  const progress = initialProgress(options.apply ? 'apply' : 'dry-run', options);
  saveProgress(progress);
  let exitCode = 1;
  try {
    exitCode = await run(options, progress);
    progress.status = exitCode === 0 ? 'done' : 'partial';
  } catch (error) {
    progress.status = 'error';
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
