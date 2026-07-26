// core/pad-contracts.js — verificador determinístico y emisor idempotente de
// tareas para los contratos frontend/backend del índice enrutador de Pad.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, DEFAULT_PROFILE, TOLKIEN_PROFILE } from './pad-index.js';
import {
  createItem,
  deleteItem,
  listItems,
  setParent,
  updateItem,
} from './pad-service-client.js';
import { collectTolkienChecks, TOLKIEN_CHECKS } from './tolkien-checks.js';
import { resolveDataDir } from './data-dir.js';
import { writeJsonAtomic } from './atomic-write.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY_FILE = path.join(os.homedir(), '.cwc-data', 'inventory.json');
const FRONTEND_CONTRACT = 'CONVE-1943';
const BACKEND_CONTRACT = 'CONVE-1944';
const TERMINAL_STATUSES = new Set(['hecha', 'done', 'closed', 'cerrada', 'cancelled', 'canceled']);

// Módulos que legítimamente NO se registran en registry.js. Documentar SIEMPRE
// el motivo: una exención sin motivo es un bug escondido.
const REGISTRY_EXEMPT = new Map([
  ['comms', 'librerías compartidas (pr-read-shared, gateway-shared, puente WhatsApp), no expone endpoints propios — declarado así en el mapa del CLAUDE.md'],
]);

const CONSOLE_CHECKS = {
  frontend: {
    help: {
      origin: FRONTEND_CONTRACT,
      obligation: 'El módulo ofrece ayuda contextual',
    },
    i18n: {
      origin: FRONTEND_CONTRACT,
      obligation: 'El módulo tiene traducción base en inglés',
    },
    helpIndex: {
      origin: FRONTEND_CONTRACT,
      obligation: 'El módulo está incluido en el índice de ayuda',
    },
    dataModule: {
      origin: FRONTEND_CONTRACT,
      obligation: 'El módulo está montado en el HTML principal',
    },
    noInlineSvg: {
      origin: FRONTEND_CONTRACT,
      obligation: 'El módulo no incluye SVG inline en JavaScript',
    },
  },
  backend: {
    ficha: {
      origin: BACKEND_CONTRACT,
      obligation: 'El módulo tiene ficha de contexto propia',
    },
    registered: {
      origin: BACKEND_CONTRACT,
      obligation: 'El módulo está registrado en el inventario',
    },
    enMapa: {
      origin: BACKEND_CONTRACT,
      obligation: 'El módulo aparece en el mapa raíz',
    },
    arqui: {
      origin: BACKEND_CONTRACT,
      obligation: 'El módulo tiene un ítem en la colección arquitectura',
    },
  },
};

// ===== Capa `leccion` — obligaciones nacidas de Mejora Continua (PLAN-1936) =====
// Una lección adoptada al destino `contrato` deja de ser texto que el modelo
// puede ignorar: se vuelve una fila de obligación en un contrato de Pad + (si es
// mecanizable) su regla acá. A partir de ese momento el emisor la vigila solo.
// El registro es DATO y no código porque las lecciones nacen en RUNTIME: no hay
// forma de declararlas en un objeto literal como los checks frontend/backend.
// resolveDataDir() (no ~/.cwc-data hardcodeado) para que un inquilino tenga el
// suyo — regla multi-tenant "dato user-scoped nunca global".
const LESSON_CONTRACTS_FILE = path.join(resolveDataDir(), 'lesson-contracts.json');
const LESSON_KIND = 'leccion';
const LESSON_RULE_TYPES = new Set(['fileExists', 'grepPresent', 'grepAbsent']);
const LESSON_REF_RE = /^MC-\d+$/;
const LESSON_CHECK_RE = /^[a-z0-9][a-z0-9-]*$/;   // sin barras: el marcador cwc-contract no las admite en ese segmento
const CONTRACT_REF_RE = /^CONVE-\d+$/;

export function readLessonContracts() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(LESSON_CONTRACTS_FILE, 'utf8')); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(list)) return [];
  // Una entrada mal formada se DESCARTA en silencio: el registro es un archivo
  // de datos y no puede tumbar el emisor entero (mismo criterio fail-open que
  // core/forbidden-actions.js).
  return list.filter((entry) => entry && typeof entry === 'object'
    && LESSON_REF_RE.test(String(entry.lesson || ''))
    && LESSON_CHECK_RE.test(String(entry.check || ''))
    && CONTRACT_REF_RE.test(String(entry.contract || '')));
}

// Valida la regla ANTES de tocar nada. Una regla inválida TIRA (el operador la
// ve al adoptar), nunca degrada silenciosamente a "no verificable".
function normalizeLessonRule(rule) {
  if (rule == null) return null;
  const type = String(rule.type || '').trim();
  if (!LESSON_RULE_TYPES.has(type)) {
    throw new Error(`Tipo de regla "${type}" no soportado (fileExists | grepPresent | grepAbsent).`);
  }
  if (type === 'fileExists') {
    const target = String(rule.path || '').trim();
    if (!target || path.isAbsolute(target) || target.split('/').includes('..')) {
      throw new Error('`path` debe ser una ruta relativa dentro del repo.');
    }
    return { type, path: target };
  }
  const glob = String(rule.glob || '').trim();
  const pattern = String(rule.pattern || '');
  if (!glob) throw new Error('La regla necesita un `glob` de archivos.');
  if (!pattern) throw new Error('La regla necesita un `pattern`.');
  try { new RegExp(pattern); } catch { throw new Error('El `pattern` no es una expresión regular válida.'); }
  return { type, glob, pattern, flags: rule.flags === 'i' ? 'i' : '' };
}

// Alta idempotente de una obligación de lección. La llama el destino `contrato`
// de Mejora Continua (retro/promote-shared.js).
export function appendLessonContract(entry = {}) {
  const lesson = String(entry.lesson || '').trim();
  const check = String(entry.check || '').trim();
  const contract = String(entry.contract || '').trim();
  const obligation = String(entry.obligation || '').trim();
  if (!LESSON_REF_RE.test(lesson)) throw new Error('El registro de lecciones exige un ref MC-n.');
  if (!LESSON_CHECK_RE.test(check)) throw new Error('El slug del check debe ser kebab-case sin barras.');
  if (!CONTRACT_REF_RE.test(contract)) throw new Error('El contrato origen debe ser un ref CONVE-n.');
  if (!obligation) throw new Error('Falta el texto de la obligación.');
  const rule = normalizeLessonRule(entry.rule);
  const profile = entry.profile === 'tolkien' ? 'tolkien' : 'console';
  const list = readLessonContracts();
  const next = { lesson, check, contract, obligation: obligation.slice(0, 400), profile, rule };
  const i = list.findIndex((item) => item.lesson === lesson && item.check === check);
  if (i >= 0) list[i] = { ...next, addedAt: list[i].addedAt || Date.now() };
  else list.push({ ...next, addedAt: Date.now() });
  fs.mkdirSync(path.dirname(LESSON_CONTRACTS_FILE), { recursive: true });
  writeJsonAtomic(LESSON_CONTRACTS_FILE, list, { space: 2 });
  return next;
}

// Mismo dialecto de glob que los invariantes de Salud (`**` cruza directorios,
// `*` se queda dentro del segmento). Se reimplementa acá A PROPÓSITO: `core/`
// no puede importar de `src/modules/` sin invertir las capas.
function lessonGlobToRegExp(glob) {
  const source = String(glob || '').trim();
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '*') {
      if (source[i + 1] === '*') { i += 1; if (source[i + 1] === '/') i += 1; out += '.*'; }
      else out += '[^/]*';
    } else if ('.+?()[]{}^$|\\/'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return `${out}$`;
}

// Archivos del repo (rutas relativas con `/`) que matchean el glob. `null` si el
// glob no compila — el llamador lo traduce a skipped, nunca a incumplido.
function filesMatchingGlob(glob) {
  let re;
  try { re = new RegExp(lessonGlobToRegExp(glob)); } catch { return null; }
  const found = [];
  const walk = (absoluteDir, relativeDir) => {
    let entries = [];
    try { entries = fs.readdirSync(absoluteDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(absoluteDir, entry.name), relative);
      else if (entry.isFile() && re.test(relative)) found.push(relative);
    }
  };
  walk(ROOT, '');
  return found;
}

// Evalúa las obligaciones de lección del perfil pedido. REGLA HEREDADA de
// PLAN-1955: un check que no aplica devuelve `ok: null` con un `detail` que
// EMPIEZA con `skipped:` — jamás "incumplido". 6 de los primeros 11
// incumplimientos que emitió el motor eran falsos; una regla débil cuesta más
// que no tener regla.
function lessonChecks(profileName) {
  const cache = new Map();
  return readLessonContracts()
    .filter((entry) => (entry.profile || 'console') === profileName)
    .map((entry) => {
      const base = { module: entry.lesson, kind: LESSON_KIND, check: entry.check };
      if (!entry.rule) {
        return { ...base, ok: null, detail: `skipped: la obligación de ${entry.lesson} no declara regla mecánica; se verifica a mano` };
      }
      try {
        if (entry.rule.type === 'fileExists') {
          const exists = fs.existsSync(path.join(ROOT, entry.rule.path));
          return { ...base, ok: exists, detail: `${entry.rule.path} ${exists ? 'existe' : 'no existe'}` };
        }
        if (!cache.has(entry.rule.glob)) cache.set(entry.rule.glob, filesMatchingGlob(entry.rule.glob));
        const files = cache.get(entry.rule.glob);
        if (files === null) return { ...base, ok: null, detail: `skipped: el glob "${entry.rule.glob}" no compila` };
        if (!files.length) return { ...base, ok: null, detail: `skipped: ningún archivo del repo coincide con "${entry.rule.glob}"` };
        const re = new RegExp(entry.rule.pattern, entry.rule.flags || '');
        const hits = files.filter((file) => re.test(readText(file)));
        const sample = hits.slice(0, 5).join(', ');
        if (entry.rule.type === 'grepPresent') {
          return {
            ...base,
            ok: hits.length > 0,
            detail: hits.length ? `patrón exigido presente en ${sample}` : `patrón exigido ausente en los ${files.length} archivo(s) de "${entry.rule.glob}"`,
          };
        }
        return {
          ...base,
          ok: hits.length === 0,
          detail: hits.length ? `patrón prohibido presente en ${sample}` : `${files.length} archivo(s) de "${entry.rule.glob}" sin el patrón prohibido`,
        };
      } catch (error) {
        return { ...base, ok: null, detail: `skipped: la regla falló al evaluarse (${error?.message || 'sin detalle'})` };
      }
    });
}

// Specs por PERFIL. `console` es el perfil histórico; `tolkien` verifica reglas
// mecánicas sobre un diff del repo externo (Regla 12: read-only siempre).
const CHECK_SPECS = {
  console: CONSOLE_CHECKS,
  tolkien: TOLKIEN_CHECKS,
};

function checksProfileName(profile) {
  return profile?.checks === 'tolkien' ? 'tolkien' : 'console';
}

function specFor(profileName, kind, check, moduleName) {
  if (kind === LESSON_KIND) {
    const entry = readLessonContracts().find((item) => item.lesson === moduleName && item.check === check);
    return entry ? { origin: entry.contract, obligation: entry.obligation } : null;
  }
  return CHECK_SPECS[profileName]?.[kind]?.[check] || null;
}

function effectiveProfile(profile) {
  return { ...DEFAULT_PROFILE, ...(profile || {}) };
}

function directoryNames(relativeDir) {
  try {
    return fs.readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readText(relativeFile) {
  try { return fs.readFileSync(path.join(ROOT, relativeFile), 'utf8'); } catch { return ''; }
}

function readInventoryModules() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
    return Array.isArray(parsed?.modules) ? parsed.modules : [];
  } catch {
    return [];
  }
}

function jsFilesBelow(relativeDir) {
  const files = [];
  const walk = (absoluteDir) => {
    let entries = [];
    try { entries = fs.readdirSync(absoluteDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  };
  walk(path.join(ROOT, relativeDir));
  return files;
}

function normalizePadItem(item) {
  let fields = item?.fields;
  if (typeof fields === 'string') {
    try { fields = JSON.parse(fields); } catch { fields = {}; }
  }
  return { ...item, fields: fields && typeof fields === 'object' ? fields : {} };
}

function itemsArray(result) {
  if (!result?.ok) return [];
  const items = Array.isArray(result.data) ? result.data : result.data?.items;
  return Array.isArray(items) ? items.map(normalizePadItem) : [];
}

function architectureTitleMatches(title, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(String(title || ''));
}

function consoleChecks(data, architectureAvailable) {
  const checks = [];
  const helpIndex = readText('public/js/ui/help-index.js');
  const indexHtml = readText('public/index.html');
  const inventoryByName = new Map(readInventoryModules().map((item) => [item?.name, item]));
  const rootMap = readText('CLAUDE.md');
  const rootMapTables = rootMap.split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('|'))
    .join('\n');

  for (const moduleName of directoryNames('public/js/modules')) {
    const relativeDir = `public/js/modules/${moduleName}`;
    const declaresDataModule = indexHtml.includes(`data-module="${moduleName}"`);
    const jsFiles = jsFilesBelow(relativeDir);
    const inlineSvgFiles = jsFiles
      .filter((file) => readText(path.relative(ROOT, file)).includes('<svg'))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    checks.push(
      {
        module: moduleName,
        kind: 'frontend',
        check: 'help',
        ok: fs.existsSync(path.join(ROOT, relativeDir, 'help.js')),
        detail: `${relativeDir}/help.js`,
      },
      {
        module: moduleName,
        kind: 'frontend',
        check: 'i18n',
        ok: fs.existsSync(path.join(ROOT, 'public', 'i18n', 'en', `${moduleName}.json`)),
        detail: `public/i18n/en/${moduleName}.json`,
      },
      {
        module: moduleName,
        kind: 'frontend',
        check: 'helpIndex',
        ok: helpIndex.includes(moduleName),
        detail: `${moduleName} en public/js/ui/help-index.js`,
      },
      {
        module: moduleName,
        kind: 'frontend',
        check: 'dataModule',
        ok: declaresDataModule ? true : null,
        detail: declaresDataModule
          ? `data-module="${moduleName}" en public/index.html`
          : 'montaje dinámico: no declara data-module',
      },
      {
        module: moduleName,
        kind: 'frontend',
        check: 'noInlineSvg',
        ok: inlineSvgFiles.length === 0,
        detail: inlineSvgFiles.length ? `<svg en ${inlineSvgFiles.join(', ')}` : `${jsFiles.length} archivo(s) .js sin <svg`,
      },
    );
  }

  for (const moduleName of directoryNames('src/modules')) {
    const inventoryItem = inventoryByName.get(moduleName);
    const registryExemption = REGISTRY_EXEMPT.get(moduleName);
    checks.push(
      {
        module: moduleName,
        kind: 'backend',
        check: 'ficha',
        ok: fs.existsSync(path.join(ROOT, 'src', 'modules', moduleName, 'CLAUDE.md')),
        detail: `src/modules/${moduleName}/CLAUDE.md`,
      },
      {
        module: moduleName,
        kind: 'backend',
        check: 'registered',
        ok: registryExemption ? null : inventoryItem?.registered === true,
        detail: registryExemption || `${moduleName} registrado en ~/.cwc-data/inventory.json`,
      },
      {
        module: moduleName,
        kind: 'backend',
        check: 'enMapa',
        ok: rootMapTables.includes(`\`${moduleName}/\``),
        detail: `\`${moduleName}/\` en la tabla de CLAUDE.md`,
      },
      architectureAvailable
        ? {
            module: moduleName,
            kind: 'backend',
            check: 'arqui',
            ok: (data.arqui || []).some((item) => architectureTitleMatches(item?.title, moduleName)),
            detail: `${moduleName} en colección arquitectura`,
          }
        : {
            module: moduleName,
            kind: 'backend',
            check: 'arqui',
            ok: null,
            detail: 'skipped: Pad no responde',
          },
    );
  }
  return checks;
}

async function evaluateDetailed(profile) {
  const resolvedProfile = effectiveProfile(profile);
  const profileName = checksProfileName(resolvedProfile);
  // Los contratos que citan las obligaciones de lección se suman al fetch: sin
  // esto `emitTasks` no encontraría su contrato origen y saltearía la fila. Se
  // amplía SOLO el fetch, no el perfil: el índice enrutador del CLAUDE.md sigue
  // publicando exactamente los contratos que su perfil declara (techo intacto).
  const declaredContracts = resolvedProfile.contracts || [];
  const lessonContracts = [...new Set(readLessonContracts()
    .filter((entry) => (entry.profile || 'console') === profileName)
    .map((entry) => entry.contract))].filter((ref) => !declaredContracts.includes(ref));
  const data = await collect(
    lessonContracts.length
      ? { ...resolvedProfile, contracts: [...declaredContracts, ...lessonContracts] }
      : resolvedProfile,
  );
  let checks;
  if (profileName === 'tolkien') {
    // Regla dura 12: el mundo externo se lee; las tareas emitidas viven SIEMPRE
    // en el Pad interno. Un workspace distinto de `console` es un bug de config.
    if (resolvedProfile.workspace !== 'console') {
      throw new Error(`Perfil tolkien con workspace "${resolvedProfile.workspace}": la Regla 12 prohíbe escribir fuera del Pad interno.`);
    }
    checks = collectTolkienChecks(resolvedProfile.diff || {});
  } else {
    // collect() es el colector canónico. Esta segunda lectura sólo conserva el
    // estado ok/error que collect degrada a [] para poder distinguir Pad caído.
    const architectureProbe = await listItems('arquitectura', { workspace: resolvedProfile.workspace });
    checks = consoleChecks(data, architectureProbe.ok);
  }
  checks = [...checks, ...lessonChecks(profileName)];
  return {
    checks,
    failures: checks.filter((check) => check.ok === false),
    data,
    profile: resolvedProfile,
    profileName,
  };
}

export async function evaluateContracts(profile = DEFAULT_PROFILE) {
  const { checks, failures } = await evaluateDetailed(profile);
  return { checks, failures };
}

function markerFor(moduleName, check) {
  return `<!-- cwc-contract: ${moduleName}/${check} -->`;
}

function fieldStatus(item) {
  return String(item?.fields?.status ?? item?.status ?? '').toLowerCase();
}

function isOpen(item) {
  return !TERMINAL_STATUSES.has(fieldStatus(item));
}

function markdownRows(content) {
  return String(content || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line.startsWith('|') || !line.endsWith('|')) return false;
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    return cells.length >= 4 && !cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  });
}

function contractRow(contract, check, kind, profileName, moduleName) {
  const rows = markdownRows(contract?.content);
  const escaped = check.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needle = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  const found = rows.find((row) => needle.test(row.split('`').join('')));
  if (found) return found;
  const spec = specFor(profileName, kind, check, moduleName);
  if (!spec) return `| — | (obligación no declarada) | \`${check}\` | — |`;
  return `| — | ${spec.obligation} | \`${check}\` | ${spec.origin} |`;
}

function taskContent(contract, item, profileName) {
  const spec = specFor(profileName, item.kind, item.check, item.module);
  return [
    `Origen: ${spec.origin}`,
    '',
    'Fila del contrato:',
    contractRow(contract, item.check, item.kind, profileName, item.module),
    '',
    markerFor(item.module, item.check),
  ].join('\n');
}

function skippedEntry(item, reason, extra = {}) {
  return {
    module: item?.module || null,
    check: item?.check || null,
    reason,
    ...extra,
  };
}

export async function emitTasks(profile = DEFAULT_PROFILE, { dryRun = true } = {}) {
  const evaluated = await evaluateDetailed(profile);
  const {
    checks,
    data,
    profile: resolvedProfile,
    profileName,
  } = evaluated;
  const created = [];
  const closed = [];
  const skipped = [];
  const pendingResult = await listItems('pendientes', { workspace: resolvedProfile.workspace });
  if (!pendingResult.ok) {
    skipped.push(skippedEntry(null, `Pad no responde, no se pudo verificar idempotencia: ${pendingResult.error || 'sin detalle'}`));
    return { created, closed, skipped };
  }

  const pending = itemsArray(pendingResult);
  const contractsByRef = new Map((data.contracts || []).map((item) => [item.ref, item]));
  const openByMarker = new Map();
  for (const item of pending.filter(isOpen)) {
    const matches = String(item.content || '').matchAll(/<!-- cwc-contract: ([^/\s]+)\/([^\s]+) -->/g);
    for (const match of matches) {
      const marker = markerFor(match[1], match[2]);
      if (!openByMarker.has(marker)) openByMarker.set(marker, []);
      openByMarker.get(marker).push(item);
    }
  }

  for (const check of checks) {
    if (check.ok === null) {
      skipped.push(skippedEntry(check, check.detail));
      continue;
    }
    const marker = markerFor(check.module, check.check);
    const existing = openByMarker.get(marker) || [];
    const spec = specFor(profileName, check.kind, check.check, check.module);
    if (!spec) {
      skipped.push(skippedEntry(check, `sin obligación declarada para ${check.kind}/${check.check}`));
      continue;
    }

    if (check.ok) {
      for (const item of existing) {
        if (dryRun) {
          closed.push({ ref: item.ref, module: check.module, check: check.check, dryRun: true });
          continue;
        }
        const result = await updateItem(item.ref, {
          fields: { ...item.fields, status: 'hecha', doneAt: String(Date.now()) },
        }, { workspace: resolvedProfile.workspace });
        if (result.ok) closed.push({ ref: item.ref, module: check.module, check: check.check });
        else skipped.push(skippedEntry(check, `no se pudo cerrar ${item.ref}: ${result.error || 'sin detalle'}`, { ref: item.ref }));
      }
      continue;
    }

    if (existing.length) {
      skipped.push(skippedEntry(check, `ya existe abierto: ${existing.map((item) => item.ref).join(', ')}`));
      continue;
    }

    const contract = contractsByRef.get(spec.origin);
    if (!contract) {
      skipped.push(skippedEntry(check, `no se encontró el contrato origen ${spec.origin}`));
      continue;
    }
    // Los checks frontend/backend nombran algo que FALTA en un módulo
    // ("falta help"); una obligación de lección nombra una regla que se
    // INCUMPLIÓ, y "falta leccion850" no se entiende. El título se adapta al
    // tipo de check, el marcador idempotente NO cambia.
    const title = check.kind === LESSON_KIND
      ? `Contrato · ${check.module} incumplida: ${spec.obligation}`.slice(0, 180)
      : `Contrato · ${check.module}: falta ${check.check}`;
    const content = taskContent(contract, check, profileName);
    if (dryRun) {
      created.push({
        ref: null,
        module: check.module,
        check: check.check,
        title,
        parent: spec.origin,
        dryRun: true,
      });
      continue;
    }

    const result = await createItem('pendientes', {
      title,
      content,
      tags: ['contrato'],
      fields: { status: 'pendiente', priority: 'media' },
    }, { workspace: resolvedProfile.workspace });
    const ref = result?.data?.ref;
    if (!result.ok || !ref) {
      skipped.push(skippedEntry(check, `no se pudo crear: ${result.error || 'respuesta sin ref'}`));
      continue;
    }
    const parentResult = await setParent(ref, spec.origin, { workspace: resolvedProfile.workspace });
    if (!parentResult.ok) {
      const rollback = await deleteItem(ref, { workspace: resolvedProfile.workspace });
      skipped.push(skippedEntry(
        check,
        `no se pudo enlazar parent ${spec.origin}; ${rollback.ok ? `se revirtió ${ref}` : `${ref} requiere limpieza manual`}`,
        { ref },
      ));
      continue;
    }
    created.push({ ref, module: check.module, check: check.check, title, parent: spec.origin });
  }

  return { created, closed, skipped };
}

export async function evaluateTolkien(diff = {}, profile = {}) {
  return evaluateDetailed({ ...TOLKIEN_PROFILE, ...profile, diff });
}
