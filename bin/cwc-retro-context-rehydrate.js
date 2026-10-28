#!/usr/bin/env node
// Rehidrata, por dueño, las referencias compactadas de Mejora Continua que
// quedaron en la sección §6 de los contextos de trabajo. Pad es solo lectura:
// la única escritura posible es al master local y su espejo, vía saveContext.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { padContextForUser } from '../src/core/pad-context.js';
import { systemScopeFor } from '../src/core/system-scope.js';
import { hostUser } from '../src/core/user-space.js';
import { listUsers } from '../src/core/users.js';
// Instala los resolvers owner-scoped antes de leer stores de inquilinos.
import '../src/modules/retro/server-shared.js';
import {
  contextPathsFor,
  getContext,
  parseFeedbackSection,
  planContextWindows,
  saveContext,
  splitTopSections,
} from '../src/modules/tickets/context-store.js';
import {
  buildContextEntry,
  compactContextMaster,
  contextMarkerFor,
} from '../src/modules/retro/promote-shared.js';
import { listLessons } from '../src/modules/retro/store.js';

const KINDS = ['work', 'pr'];
const FEEDBACK_HEADING_RE = /^##\s*6\./;
const MARKER_KEY_RE = /<!-- cwc:retro-context:([a-f0-9]{12}) -->/;

function usage() {
  return [
    'Uso: node bin/cwc-retro-context-rehydrate.js [--apply] [--user <id>]',
    'Sin --apply hace dry-run y no escribe nada.',
    'Lee las lecciones únicamente del Pad propio de cada usuario.',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function parseArgs(argv) {
  const options = { apply: false, help: false, user: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--user' || arg.startsWith('--user=')) {
      if (options.user !== null) throw usageError('--user solo puede indicarse una vez');
      const value = arg === '--user' ? argv[++index] : arg.slice('--user='.length);
      if (!value || value.startsWith('-')) throw usageError('--user requiere un id');
      options.user = value;
    } else {
      throw usageError(`argumento desconocido: ${arg}`);
    }
  }
  return options;
}

function principalFor(user, host) {
  if (user.username === host) return { type: 'token', admin: true };
  return { type: 'session', username: user.username, admin: !!user.admin };
}

function discoverOwners(selectedUser) {
  const host = hostUser();
  const byName = new Map([[host, { username: host, admin: true, host: true }]]);
  for (const user of listUsers()) {
    if (user?.username && !byName.has(user.username)) byName.set(user.username, user);
  }

  if (selectedUser && !byName.has(selectedUser)) {
    throw usageError(`usuario inexistente: ${selectedUser}`);
  }

  const owners = [];
  for (const user of byName.values()) {
    if (selectedUser && user.username !== selectedUser) continue;
    const scope = systemScopeFor(principalFor(user, host));
    const hasStore = KINDS.some((kind) => fs.existsSync(contextPathsFor(scope, kind).storeFile));
    if (scope.isHost || hasStore) owners.push({ user, scope });
  }
  return { host, owners };
}

function markerKey(lessonId) {
  return contextMarkerFor(lessonId).match(MARKER_KEY_RE)?.[1] || null;
}

function lessonsByMarker(lessons) {
  const mapped = new Map();
  for (const lesson of lessons) {
    const key = markerKey(lesson.id);
    if (key) mapped.set(key, lesson);
  }
  return mapped;
}

function referenceTitle(unit) {
  const text = String(unit?.text || '');
  const quoted = text.match(/Referencia de Mejora Continua:\**\s*“([^”\n]+)”/i)
    || text.match(/Referencia de Mejora Continua:\**\s*"([^"\n]+)"/i);
  if (quoted?.[1]) return quoted[1].trim();
  return `(referencia ${unit?.key || 'sin clave'})`;
}

// buildContextEntry devuelve una unidad sin separación exterior. El parser da
// rangos de unidades completos; al reemplazarlos normalizamos a una línea en
// blanco, la misma separación que usa la promoción de contexto.
function entryWithSeparator(entry) {
  return `${String(entry || '').trimEnd()}\n\n`;
}

function replaceReferences(sectionText, units, lessonMap) {
  const replacements = [];
  const unresolved = [];
  let refs = 0;

  for (const unit of units) {
    if (unit.kind !== 'ref') continue;
    refs += 1;
    const lesson = lessonMap.get(unit.key);
    if (!lesson) {
      unresolved.push(referenceTitle(unit));
      continue;
    }
    const start = Number(unit.start);
    const end = Number(unit.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > sectionText.length) {
      throw new Error(`rango inválido para referencia ${unit.key || '[sin clave]'}`);
    }
    const rank = Math.max(Number(unit.rank) || 1, Number(lesson.recurrence) || 1);
    replacements.push({
      start,
      end,
      text: entryWithSeparator(buildContextEntry(lesson, { rank })),
    });
  }

  replacements.sort((a, b) => b.start - a.start);
  let next = sectionText;
  let previousStart = sectionText.length;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error('rangos superpuestos en la sección §6');
    next = `${next.slice(0, replacement.start)}${replacement.text}${next.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return { next, refs, restored: replacements.length, unresolved };
}

function compactedCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.units)) return value.units.length;
    if (Number.isFinite(Number(value.count))) return Number(value.count);
  }
  if (Number.isFinite(Number(value))) return Number(value);
  return value ? 1 : 0;
}

function planKind(kind, original, scope, lessonMap) {
  const split = splitTopSections(original);
  const section = split.sections.find((candidate) => FEEDBACK_HEADING_RE.test(candidate.title));
  let refs = 0;
  let restored = 0;
  let unresolved = [];

  if (section) {
    const parsed = parseFeedbackSection(section.text);
    const replaced = replaceReferences(section.text, parsed.units || [], lessonMap);
    section.text = replaced.next;
    ({ refs, restored, unresolved } = replaced);
  }

  const expanded = split.preamble + split.sections.map((item) => item.text).join('');
  const compacted = compactContextMaster(kind, expanded, scope);
  return {
    kind,
    original,
    next: compacted.text,
    refs,
    restored,
    unresolved,
    compacted: compactedCount(compacted.compacted),
    changed: compacted.text !== original,
    state: 'ok',
  };
}

function timestampForBackup(date = new Date()) {
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}`
    + `-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function backupStore(storeFile, stamp) {
  const backupFile = `${storeFile}.bak-rehydrate-${stamp}`;
  fs.copyFileSync(storeFile, backupFile, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupFile, 0o600);
  return backupFile;
}

function bytesFrom(plan) {
  const bytes = Number(plan?.mirrorBytes);
  return Number.isFinite(bytes) ? bytes : '?';
}

function rowFor(owner, result, beforeBytes, afterBytes) {
  return {
    usuario: owner,
    contexto: result.kind,
    refs: result.refs,
    restauradas: result.restored,
    'sin resolver': result.unresolved.length ? result.unresolved.join(' · ') : '—',
    compactadas: result.compacted,
    mirrorBytes: `${beforeBytes} → ${afterBytes}`,
    estado: result.state,
  };
}

async function processOwner(owner, options, stamp) {
  const { user, scope } = owner;
  const originals = Object.fromEntries(KINDS.map((kind) => [kind, getContext(kind, scope)]));
  const beforePlan = planContextWindows(originals, scope);
  const ctx = padContextForUser(scope.isHost ? null : user.username);
  let lessons;
  let padState = null;

  if (ctx && !ctx.token) {
    lessons = [];
    padState = 'sin-token de Pad';
  } else {
    try {
      ({ lessons } = await listLessons(ctx));
    } catch (error) {
      lessons = [];
      padState = `error de lectura de Pad: ${error?.message || String(error)}`;
    }
  }

  const lessonMap = lessonsByMarker(lessons);
  const results = KINDS.map((kind) => planKind(kind, originals[kind], scope, lessonMap));
  if (padState) {
    for (const result of results) {
      result.state = padState;
      result.changed = false;
      result.next = result.original;
      result.compacted = 0;
    }
  }

  const proposed = Object.fromEntries(results.map((result) => [result.kind, result.next]));
  const afterPlan = planContextWindows(proposed, scope);
  const writeErrors = [];

  if (options.apply && !padState) {
    for (const result of results) {
      if (!result.changed) {
        result.state = 'sin cambios';
        continue;
      }
      const { storeFile } = contextPathsFor(scope, result.kind);
      try {
        const backupFile = backupStore(storeFile, stamp);
        saveContext(result.kind, result.next, scope);
        result.state = `aplicado; backup ${path.basename(backupFile)}`;
      } catch (error) {
        const message = error?.message || String(error);
        result.state = `ERROR de escritura: ${message}`;
        writeErrors.push({ user: user.username, kind: result.kind, error: message });
      }
    }
  } else if (!padState) {
    for (const result of results) result.state = result.changed ? 'dry-run: cambiaría' : 'sin cambios';
  }

  const beforeBytes = bytesFrom(beforePlan);
  const afterBytes = bytesFrom(afterPlan);
  return {
    rows: results.map((result) => rowFor(user.username, result, beforeBytes, afterBytes)),
    writeErrors,
  };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 1;
  }

  let discovered;
  try {
    discovered = discoverOwners(options.user);
  } catch (error) {
    console.error(error.message);
    if (error.usage) console.error(usage());
    return 1;
  }

  console.log(`MODO ${options.apply ? 'APPLY' : 'DRY-RUN'} · Pad solo lectura`);
  if (options.user && discovered.owners.length === 0) {
    console.log(`Usuario ${options.user}: no tiene masters de contexto persistidos.`);
    return 0;
  }

  const stamp = timestampForBackup();
  const rows = [];
  const writeErrors = [];
  for (const owner of discovered.owners) {
    try {
      const result = await processOwner(owner, options, stamp);
      rows.push(...result.rows);
      writeErrors.push(...result.writeErrors);
    } catch (error) {
      const message = error?.message || String(error);
      for (const kind of KINDS) {
        rows.push(rowFor(owner.user.username, {
          kind,
          refs: 0,
          restored: 0,
          unresolved: [],
          compacted: 0,
          state: `error de lectura/proceso: ${message}`,
        }, '?', '?'));
      }
    }
  }

  if (rows.length) console.table(rows);
  else console.log('No hay usuarios con contextos persistidos para procesar.');
  if (writeErrors.length) {
    console.error(`Fallaron ${writeErrors.length} escritura(s). Los demás usuarios/contextos continuaron.`);
  }
  return writeErrors.length ? 1 : 0;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();

