// core/pad-index.js — generador del índice ENRUTADOR de contexto de Pad.
//
// El índice no copia fichas ni enumera módulos: sólo publica contratos,
// autoridades y punteros a catálogos. Los módulos bajo src/modules/* y
// public/js/modules/* ya reciben su CLAUDE.md por path desde el harness.
// Por defecto la salida es un preview en ~/.cwc-data; apply() actualiza el
// bloque gestionado del CLAUDE.md de destino con escritura atómica.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-write.js';
import { resolveDataDir } from './data-dir.js';
import { listItems } from './pad-service-client.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY_FILE = path.join(resolveDataDir(), 'inventory.json');
const PREVIEW_FILE = path.join(resolveDataDir(), 'pad-index.preview.md');
const MARK_START = '<!-- cwc:pad-index:start -->';
const MARK_END = '<!-- cwc:pad-index:end -->';
const INDEX_HEADING = '## Índice enrutador de Pad (auto)';
const CEILING_LIMIT = 26074;
const PAD_FALLBACK_CHARS = 4 * 1024;

export const DEFAULT_PROFILE = {
  workspace: 'console',
  dest: path.join(ROOT, 'CLAUDE.md'),
  lang: 'es',
  contracts: ['CONVE-1943', 'CONVE-1944', 'CONVE-1945', 'CONVE-1958'],
};

// Perfil del mundo EXTERNO (Regla dura 12): se LEE el repo Tolkien y se escribe
// SIEMPRE en el Pad interno. `dest: null` ⇒ apply() se niega a escribir un MD allá.
export const TOLKIEN_PROFILE = {
  workspace: 'console',
  dest: null,
  lang: 'es',
  contracts: ['CONVE-1964'],
  checks: 'tolkien',
};

function emptyInventory() {
  return { modules: [], runners: [], frontend: [], vocabulary: {} };
}

function readInventory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
    return {
      modules: Array.isArray(parsed?.modules) ? parsed.modules : [],
      runners: Array.isArray(parsed?.runners) ? parsed.runners : [],
      frontend: Array.isArray(parsed?.frontend) ? parsed.frontend : [],
      vocabulary: parsed?.vocabulary && typeof parsed.vocabulary === 'object'
        ? parsed.vocabulary
        : {},
    };
  } catch {
    return emptyInventory();
  }
}

// El REST de Pad devuelve fields como STRING JSON, a diferencia del MCP.
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

// Replica el patrón best-effort de health/shared.js: REST HTTP plano mediante
// el cliente local (que resuelve CWC_PAD_URL, token y timeout), nunca MCP.
async function collectPad(profile) {
  try {
    const [arquiResult, conventionsResult, lessonsResult] = await Promise.all([
      listItems('arquitectura', { workspace: profile.workspace }),
      listItems('conventions', { workspace: profile.workspace }),
      listItems('mejora-continua', { workspace: profile.workspace }),
    ]);
    const arqui = itemsArray(arquiResult);
    const wanted = new Set(profile.contracts || []);
    const byRef = new Map(
      itemsArray(conventionsResult)
        .filter((item) => wanted.has(item.ref))
        .map((item) => [item.ref, item]),
    );
    const contracts = (profile.contracts || []).map((ref) => byRef.get(ref)).filter(Boolean);
    const lessonsCount = lessonsResult?.ok ? itemsArray(lessonsResult).length : null;
    return { arqui, contracts, lessonsCount };
  } catch {
    return { arqui: [], contracts: [], lessonsCount: null };
  }
}

function gitDateFor(relativeFile) {
  try {
    const value = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', relativeFile],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

function fichaFor(relativeFile) {
  const absolute = path.join(ROOT, relativeFile);
  try {
    const text = fs.readFileSync(absolute, 'utf8');
    return {
      file: relativeFile,
      bytes: fs.statSync(absolute).size,
      chars: text.length,
      lastCommit: gitDateFor(relativeFile),
    };
  } catch {
    return null;
  }
}

function collectFichas() {
  const candidates = [
    'src/core/CLAUDE.md',
    'bin/CLAUDE.md',
    'public/CLAUDE.md',
    'public/js/ui/CLAUDE.md',
    'public/js/modules/CLAUDE.md',
  ];
  try {
    const moduleDirs = fs.readdirSync(path.join(ROOT, 'src', 'modules'), { withFileTypes: true });
    for (const entry of moduleDirs) {
      if (entry.isDirectory()) candidates.push(`src/modules/${entry.name}/CLAUDE.md`);
    }
  } catch { /* estructura vacía si no existe src/modules */ }
  return [...new Set(candidates)].sort().map(fichaFor).filter(Boolean);
}

export async function collect(profile = DEFAULT_PROFILE) {
  const inventory = readInventory();
  const [{ arqui, contracts, lessonsCount }, fichas] = await Promise.all([
    collectPad(profile),
    Promise.resolve(collectFichas()),
  ]);
  return {
    modules: inventory.modules,
    runners: inventory.runners,
    frontend: inventory.frontend,
    arqui,
    contracts,
    lessonsCount,
    fichas,
  };
}

// Evita que contenido proveniente de Pad pueda cerrar el bloque gestionado.
function stripMarkers(value) {
  return String(value ?? '')
    .split(MARK_START).join('cwc:pad-index:start')
    .split(MARK_END).join('cwc:pad-index:end');
}

function inline(value) {
  return stripMarkers(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function destinationChars(item) {
  if (Number.isFinite(item?.chars)) return Math.max(0, item.chars);
  for (const key of ['content', 'text', 'body']) {
    if (typeof item?.[key] === 'string') return item[key].length;
  }
  try { return JSON.stringify(item || '').length; } catch { return 0; }
}

function approxKb(chars) {
  if (!Number.isFinite(chars)) return '~? KB';
  return `~${Math.max(1, Math.ceil(chars / 1024))} KB`;
}

function contractTrigger(item, ref) {
  const match = typeof item?.content === 'string'
    ? item.content.match(/^\*\*Disparador:\*\*\s*(.+)$/m)
    : null;
  const declared = match?.[1]?.trim().replace(/\.\s*$/, '').trim();
  return declared || `⚠️ sin disparador declarado — revisar ${ref}`;
}

function contractName(item, ref) {
  // El prefijo del título ("📝 CONTRATO ·", "🧭 CONTRATO ·", …) es decoración:
  // el índice ya antepone "Contrato ·". Se limpia con cualquier emoji, o sin él.
  const title = String(item?.title || ref).replace(/^[^\p{L}\p{N}]*CONTRATO\s*·\s*/u, '').trim();
  return title || ref;
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function architectureLine(arqui) {
  const items = arqui || [];
  const when = 'vas a cruzar módulos o subsistemas y no sabés dónde vive algo';
  if (!items.length) {
    return entry(
      '📎',
      when,
      'Mapa completo no disponible: Pad devolvió arquitectura vacía',
      'pad_collection list arquitectura (Pad caído o colección vacía)',
      'mapa',
    );
  }

  const byKinds = (...kinds) => items.filter(
    (item) => kinds.includes(String(item.fields?.kind || '').toLowerCase()),
  );
  const roots = byKinds('raiz', 'root');
  const sections = byKinds('subsistema', 'subsystem', 'seccion', 'section');
  const modules = byKinds('modulo', 'module');
  const totalChars = items.reduce((total, item) => total + destinationChars(item), 0);
  const rootRef = roots[0]?.ref;
  const destination = rootRef
    ? `pad_item get ${rootRef} + sus hijos (${approxKb(totalChars)} el árbol completo)`
    : `pad_collection list arquitectura (${approxKb(totalChars)} el árbol completo; raíz no declarada)`;
  return entry(
    '📎',
    when,
    `Mapa completo: ${countLabel(roots.length, 'raíz', 'raíces')}, `
      + `${countLabel(sections.length, 'sección', 'secciones')}, `
      + countLabel(modules.length, 'módulo', 'módulos'),
    destination,
    'mapa',
  );
}

function entry(weight, when, what, where, authority) {
  return `- ${weight} | ${inline(when)} | ${inline(what)} | ${inline(where)} | ${authority}`;
}

export function renderIndex(data, profile = DEFAULT_PROFILE) {
  const contractsByRef = new Map((data.contracts || []).map((item) => [item.ref, item]));
  const inventorySections = [
    ['modules', data.modules || [], 'Si hay que descubrir superficie backend sin conocer el módulo', 'Catálogo de módulos, registro, endpoints y archivos'],
    ['runners', data.runners || [], 'Si la tarea involucra procesos desacoplados o CLIs', 'Catálogo de runners y sus archivos'],
    ['frontend', data.frontend || [], 'Si hay que descubrir mounts o superficie frontend', 'Catálogo agregado del frontend'],
  ];

  const contractLines = (profile.contracts || []).map((ref) => {
    const item = contractsByRef.get(ref);
    return entry(
      '🔒',
      contractTrigger(item, ref),
      `Contrato · ${contractName(item, ref)}`,
      `pad_item get ${ref} (${approxKb(item ? destinationChars(item) : PAD_FALLBACK_CHARS)})`,
      'manual',
    );
  });

  const arquiLines = [architectureLine(data.arqui)];

  const inventoryLines = inventorySections.map(([section, value, when, what]) => entry(
    '📎',
    when,
    what,
    `~/.cwc-data/inventory.json#${section} (${approxKb(JSON.stringify(value).length)})`,
    'mapa',
  ));

  const manualLines = [entry(
    '📎',
    'vas a CREAR un archivo en una carpeta sin abrir ninguno de los que ya están',
    'La ficha de esa carpeta no se auto-cargó: leela a mano',
    '<carpeta>/CLAUDE.md (7 fichas transversales, 6-40 KB c/u)',
    'manual',
  )];
  try {
    const catalogBytes = fs.statSync(
      path.join(ROOT, 'docs', 'reglas-catalogo.md'),
    ).size;
    manualLines.push(entry(
      '📎',
      'vas a tocar un runner de `bin/` o una corrida headless del SDK',
      'Catálogo de las reglas duras: runners, excepciones READ-ONLY y sus allowlists exactas',
      `docs/reglas-catalogo.md (${approxKb(catalogBytes)})`,
      'manual',
    ));
  } catch { /* sin catálogo no se publica una entrada rota */ }

  const lessonsLabel = Number.isInteger(data.lessonsCount)
    ? `Lecciones de proceso ya destiladas (${data.lessonsCount} lecciones)`
    : 'Lecciones de proceso ya destiladas (Pad no respondió: no se pudo contar)';
  const closingLines = [entry(
    '📎',
    'vas a cerrar una tarea o reportar un cambio',
    lessonsLabel,
    'pad_search en la colección `mejora-continua` (~168 KB, NO traer entero)',
    'historia',
  )];

  return [
    '> Traé como MÁXIMO 3 entradas por tarea. Si el trigger no se cumplió, NO traigas la entrada. Ante duda, NO.',
    '',
    '### Si aplica un contrato explícito',
    ...contractLines,
    '',
    '### Si hace falta el mapa entre subsistemas',
    ...arquiLines,
    '',
    '### Si hace falta descubrir el catálogo vivo',
    ...inventoryLines,
    '',
    '### Si el path cae en una autoridad transversal',
    '> Las fichas por carpeta se auto-cargan por path; NO hay entrada por módulo a propósito.',
    ...manualLines,
    '',
    '### Si vas a cerrar trabajo',
    ...closingLines,
  ].join('\n');
}

export function computeCeiling(indexText, data) {
  const indexChars = String(indexText || '').length;
  const contractsByRef = new Map((data.contracts || []).map((item) => [item.ref, item]));
  // Cuenta sólo los destinos que el texto efectivamente marcó bloqueantes.
  // Cuando Pad no respondió, reserva 4 KB por contrato: el techo debe degradar
  // de manera conservadora, no declarar un falso 0.
  const lockedRefs = new Set(
    String(indexText || '')
      .split('\n')
      .filter((line) => line.startsWith('- 🔒 |'))
      .map((line) => line.match(/\bpad_item get\s+([^\s(]+)/)?.[1])
      .filter(Boolean),
  );
  const lockedChars = [...lockedRefs].reduce((total, ref) => {
    const item = contractsByRef.get(ref);
    return total + (item ? destinationChars(item) : PAD_FALLBACK_CHARS);
  }, 0);
  const total = indexChars + lockedChars;
  return {
    indexChars,
    lockedChars,
    total,
    limit: CEILING_LIMIT,
    ok: total <= CEILING_LIMIT,
  };
}

export async function generate(profile = DEFAULT_PROFILE) {
  const data = await collect(profile);
  const indexText = managedBlock(renderIndex(data, profile));
  const ceiling = computeCeiling(indexText, data);
  fs.mkdirSync(path.dirname(PREVIEW_FILE), { recursive: true });
  fs.writeFileSync(PREVIEW_FILE, `${indexText}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(PREVIEW_FILE, 0o600);
  console.log(
    `[pad-index] techo: índice ${ceiling.indexChars} + bloqueantes ${ceiling.lockedChars}`
      + ` = ${ceiling.total}/${ceiling.limit} caracteres — ${ceiling.ok ? 'OK' : 'EXCEDIDO'}`,
  );
  return { previewFile: PREVIEW_FILE, indexText, ceiling, data };
}

function managedBlock(indexBody) {
  const body = stripMarkers(indexBody).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return `${INDEX_HEADING}\n${MARK_START}\n${body}\n${MARK_END}`;
}

export async function apply(profile = DEFAULT_PROFILE) {
  if (!profile?.dest) {
    throw new Error('El perfil no declara `dest`: no hay nada que escribir (Regla 12: el mundo externo no se escribe desde acá).');
  }
  const data = await collect(profile);
  const indexText = managedBlock(renderIndex(data, profile));
  const ceiling = computeCeiling(indexText, data);

  if (!ceiling.ok) {
    throw new Error(
      `Techo de contexto excedido: ${ceiling.total}/${ceiling.limit} caracteres; no se escribió ${profile.dest}.`,
    );
  }
  if (!(data.contracts || []).length && !(data.arqui || []).length) {
    throw new Error(`Pad no respondió (contratos y arquitectura vacíos); no se escribió ${profile.dest}.`);
  }

  const existing = fs.readFileSync(profile.dest, 'utf8');
  const i = existing.indexOf(MARK_START);
  const j = existing.indexOf(MARK_END);
  let withoutIndex = existing;
  if (i !== -1 || j !== -1) {
    if (i === -1 || j === -1 || j <= i) {
      throw new Error(`Marcadores del índice inválidos en ${profile.dest}; no se escribió nada.`);
    }
    let source = existing;
    const managedContents = source.slice(i + MARK_START.length, j);
    const legacyHeading = managedContents.match(
      /^## Índice enrutador de Pad \(auto\)[^\S\r\n]*$/m,
    );
    if (legacyHeading?.index !== undefined) {
      const headingStart = i + MARK_START.length + legacyHeading.index;
      source = source.slice(0, headingStart)
        + source.slice(headingStart + legacyHeading[0].length);
    }
    const markerEnd = source.indexOf(MARK_END, i + MARK_START.length);
    const beforeMarkers = source.slice(0, i);
    const attachedHeading = beforeMarkers.match(
      /(^|\r?\n)## Índice enrutador de Pad \(auto\)[^\S\r\n]*(?:\r?\n[^\S\r\n]*)*$/,
    );
    const blockStart = attachedHeading
      ? attachedHeading.index + attachedHeading[1].length
      : i;
    const before = source.slice(0, blockStart).replace(/(?:[^\S\r\n]*\r?\n)+$/, '');
    const after = source.slice(markerEnd + MARK_END.length).replace(
      /^(?:[^\S\r\n]*\r?\n)+/,
      '',
    );
    withoutIndex = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  }

  const heading = /^## Mapa del proyecto[^\S\r\n]*(?:\r?\n|$)/m;
  const match = withoutIndex.match(heading);
  if (!match || match.index === undefined) {
    throw new Error(`No se encontró "## Mapa del proyecto" en ${profile.dest}; no se escribió nada.`);
  }
  const beforeHeading = withoutIndex.slice(0, match.index).replace(
    /(?:[^\S\r\n]*\r?\n)+$/,
    '',
  );
  const fromHeading = withoutIndex.slice(match.index);
  const prefix = beforeHeading ? `${beforeHeading}\n\n` : '';
  const next = `${prefix}${indexText}\n\n${fromHeading}`;

  if (next !== existing) writeFileAtomic(profile.dest, next, { mode: 0o644 });
  console.log(
    `[pad-index] aplicado en ${profile.dest}; techo ${ceiling.total}/${ceiling.limit} caracteres — OK`,
  );
  return { dest: profile.dest, indexText, ceiling, data, changed: next !== existing };
}
