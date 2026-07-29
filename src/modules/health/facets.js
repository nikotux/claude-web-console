// modules/health/facets.js — resuelve las facetas arquitectónicas de una
// unidad de auditoría desde la foto local del Pad. Existe para que Salud pueda
// aplicar invariantes por lo que una unidad ES, además de hacerlo por sus rutas,
// sin cargar la configuración del server en runners con entorno limpio.
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uidTarget, uidFamily } from '../../core/arch-uid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, 'facets-snapshot.json');

let cachedMtimeMs = null;
let cachedSnapshot = null;
const snapshotIndexes = new WeakMap();

export const FACET_KEYS = ['plano', 'audiencia', 'perfil', 'familia'];

export function loadFacetsSnapshot() {
  let mtimeMs;
  try {
    mtimeMs = fss.statSync(SNAPSHOT_FILE).mtimeMs;
  } catch {
    cachedMtimeMs = null;
    cachedSnapshot = null;
    return null;
  }
  if (mtimeMs === cachedMtimeMs) return cachedSnapshot;
  try {
    const parsed = JSON.parse(fss.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new Error('Snapshot de facetas inválido');
    }
    cachedMtimeMs = mtimeMs;
    cachedSnapshot = parsed;
    return cachedSnapshot;
  } catch {
    cachedMtimeMs = mtimeMs;
    cachedSnapshot = null;
    return null;
  }
}

function indexFor(snapshot) {
  let index = snapshotIndexes.get(snapshot);
  if (index) return index;
  const exactFiles = new Map();
  const dirs = [];
  for (const [uid, entry] of Object.entries(snapshot.entries || {})) {
    const target = uidTarget(uid);
    if (!target) continue;
    if (target.kind === 'file') {
      const matches = exactFiles.get(target.rel) || [];
      matches.push([uid, entry]);
      exactFiles.set(target.rel, matches);
    } else {
      dirs.push({ uid, entry, rel: target.rel });
    }
  }
  index = { exactFiles, dirs };
  snapshotIndexes.set(snapshot, index);
  return index;
}

function resolvedEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return {
    plano: entry.plano ?? null,
    audiencia: entry.audiencia ?? null,
    perfil: entry.perfil ?? null,
    familia: entry.familia ?? null,
  };
}

export function facetsForUnit(unit, snapshot = loadFacetsSnapshot()) {
  const entries = [];
  const via = [];
  const seenEntries = new Set();
  const seenVia = new Set();
  const add = (uid, source) => {
    const entry = resolvedEntry(source);
    if (!entry) return;
    if (!seenVia.has(uid)) {
      seenVia.add(uid);
      via.push(uid);
    }
    const key = JSON.stringify(FACET_KEYS.map((facet) => entry[facet]));
    if (!seenEntries.has(key)) {
      seenEntries.add(key);
      entries.push(entry);
    }
  };

  if (snapshot?.entries && typeof snapshot.entries === 'object') {
    const unitName = typeof unit?.name === 'string' ? unit.name : '';
    const unitKey = `unit:${unitName}`;
    if (Object.hasOwn(snapshot.entries, unitKey)) add(unitKey, snapshot.entries[unitKey]);
    if (Object.hasOwn(snapshot.entries, unitName)) add(unitName, snapshot.entries[unitName]);

    const index = indexFor(snapshot);
    for (const rawFile of Array.isArray(unit?.files) ? unit.files : []) {
      const file = String(rawFile).replaceAll('\\', '/');
      for (const [uid, entry] of index.exactFiles.get(file) || []) add(uid, entry);
      for (const dir of index.dirs) {
        if (file.startsWith(`${dir.rel}/`)) add(dir.uid, dir.entry);
      }
    }
  }

  if (entries.length) return { known: true, entries, via };

  // FAIL-CLOSED (obligación 5 de CONVE-2279): un módulo cuya clase no se
  // declaró se trata como si fuera un apartamento, no como si fuera nada. Lo
  // contrario es exactamente el fail-open que este bloque cierra.
  const families = new Set();
  for (const rawFile of Array.isArray(unit?.files) ? unit.files : []) {
    const file = String(rawFile).replaceAll('\\', '/');
    families.add(uidFamily(`file:${file}`) || 'backend');
  }
  if (!families.size) families.add('backend');
  return {
    known: false,
    entries: [...families].map((familia) => ({
      plano: 'usuario',
      audiencia: 'usuario',
      perfil: null,
      familia,
    })),
    via: [],
  };
}

export function isValidFacetPredicate(predicate) {
  if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) return false;
  const keys = Object.keys(predicate);
  if (!keys.length || keys.some((key) => !FACET_KEYS.includes(key))) return false;
  return keys.every((key) => (
    Array.isArray(predicate[key])
    && predicate[key].length > 0
    && predicate[key].every((value) => typeof value === 'string')
  ));
}

export function matchesFacets(predicate, unitFacets) {
  if (!isValidFacetPredicate(predicate) || !Array.isArray(unitFacets?.entries)) return false;
  return unitFacets.entries.some((entry) => (
    entry && typeof entry === 'object'
    && Object.entries(predicate).every(([key, values]) => values.includes(entry[key]))
  ));
}
