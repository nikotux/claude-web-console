// core/trash.js — papelera con purga automática (red de seguridad al eliminar).
//
// Eliminar NO borra: mueve el ítem a .cwc-trash/ dentro del root de archivos
// de su dueño y registra su origen y fecha. Se puede restaurar. Lo que lleve
// más de TTL_DAYS días se purga solo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWithinRoot } from './paths.js';
import { writeJsonAtomic } from './atomic-write.js';
import { hostUser } from './user-space.js';

export const TRASH_DIRNAME = '.cwc-trash';
const TTL_DAYS = 30;
const TTL_MS = TTL_DAYS * 86400000;

function trashDir(root) {
  return path.join(root, TRASH_DIRNAME);
}

function indexFile(root) {
  return path.join(trashDir(root), 'index.json');
}

function ensureDir(root) {
  fs.mkdirSync(trashDir(root), { recursive: true });
}

function loadIndex(root) {
  try { return JSON.parse(fs.readFileSync(indexFile(root), 'utf8')).items || []; }
  catch { return []; }
}

function saveIndex(root, items) {
  ensureDir(root);
  writeJsonAtomic(indexFile(root), { items }, { space: 2 }); // atómico (fix B5): índice de papelera durable
}

function entryOwner(it) {
  // Migración implícita: las entradas anteriores, sin owner, pertenecen al host.
  return it.owner || hostUser();
}

// Mueve un absoluto (ya validado dentro del root) a la papelera de ese root.
export function moveToTrash(root, absPath, originalRel, owner) {
  // Defensa en profundidad: aunque restoreFromTrash revalida al restaurar,
  // no persistimos una originalRel que escape del root (ej. '../../etc/passwd').
  if (resolveWithinRoot(root, originalRel) === null) {
    throw new Error(`moveToTrash: originalRel fuera del root permitido: ${originalRel}`);
  }
  ensureDir(root);
  const st = fs.lstatSync(absPath);
  const id = crypto.randomBytes(8).toString('hex');
  const dest = path.join(trashDir(root), id);
  fs.renameSync(absPath, dest); // mismo filesystem => instantáneo
  const items = loadIndex(root);
  items.push({
    id,
    name: path.basename(absPath),
    originalRel,
    owner,
    isDir: st.isDirectory(),
    deletedAt: Date.now(),
  });
  saveIndex(root, items);
  return id;
}

export function listTrash(root, { owner, all = false }) {
  autoPurge(root);
  return loadIndex(root)
    .filter((it) => all || entryOwner(it) === owner)
    .map((it) => ({
      ...it,
      owner: entryOwner(it),
      expiresAt: it.deletedAt + TTL_MS,
      daysLeft: Math.max(0, Math.ceil((it.deletedAt + TTL_MS - Date.now()) / 86400000)),
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

// Restaura un ítem a su ruta original (con sufijo si ya existe). Devuelve la
// ruta relativa final, o null si no se encontró el id.
//
// `assertContainerSafe(containerDir)`, si se pasa, se invoca con la carpeta
// contenedora final ANTES de crear/mover nada; debe tirar si esa carpeta (una
// vez resueltos symlinks) escapa del root real. resolveWithinRoot() de arriba
// solo valida el string (ver core/paths.js), así que sin este chequeo un
// symlink que reemplazó a `originalRel` entre el trash y el restore movería
// el contenido de la papelera fuera del root sin que nada lo detecte —
// a diferencia de mkdir/rename/trash, que sí validan la carpeta contenedora
// REAL antes de mutar (ver statSafeSync en modules/files/index.js).
export function restoreFromTrash(root, id, assertContainerSafe, { owner, all = false }) {
  const items = loadIndex(root);
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const it = items[idx];
  if (!all && entryOwner(it) !== owner) return null;
  const src = path.join(trashDir(root), id);
  let targetRel = it.originalRel;
  let target = resolveWithinRoot(root, targetRel);
  if (!target) target = path.join(root, it.name);
  // Evita pisar: si existe, agrega " (restaurado)".
  if (fs.existsSync(target)) {
    const ext = it.isDir ? '' : path.extname(it.name);
    const base = it.isDir ? it.name : path.basename(it.name, ext);
    target = path.join(path.dirname(target), `${base} (restaurado)${ext}`);
    targetRel = path.relative(root, target);
  }
  if (typeof assertContainerSafe === 'function') assertContainerSafe(path.dirname(target));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(src, target);
  items.splice(idx, 1);
  saveIndex(root, items);
  return targetRel;
}

// Purga definitiva de un id o de todos los ítems autorizados si id es null.
export function purgeTrash(root, id = null, { owner, all = false }) {
  let items = loadIndex(root);
  const kill = (entry) => {
    try { fs.rmSync(path.join(trashDir(root), entry.id), { recursive: true, force: true }); } catch { /* noop */ }
  };
  if (id !== null) {
    const entry = items.find((i) => i.id === id);
    if (entry && (all || entryOwner(entry) === owner)) {
      kill(entry);
      items = items.filter((i) => i.id !== id);
    }
  } else {
    const authorized = (entry) => all || entryOwner(entry) === owner;
    for (const e of items.filter(authorized)) kill(e);
    items = items.filter((e) => !authorized(e));
  }
  saveIndex(root, items);
}

// Elimina los ítems vencidos (> TTL_DAYS). Se llama al listar y al iniciar.
export function autoPurge(root) {
  const now = Date.now();
  const items = loadIndex(root);
  const expired = items.filter((i) => now - i.deletedAt > TTL_MS);
  if (!expired.length) return 0;
  for (const e of expired) {
    try { fs.rmSync(path.join(trashDir(root), e.id), { recursive: true, force: true }); } catch { /* noop */ }
  }
  saveIndex(root, items.filter((i) => now - i.deletedAt <= TTL_MS));
  return expired.length;
}

export { TTL_DAYS };
