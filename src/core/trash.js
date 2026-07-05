// core/trash.js — papelera con purga automática (red de seguridad al eliminar).
//
// Eliminar NO borra: mueve el ítem a ~/.cwc-trash/ y registra su origen y la
// fecha. Se puede restaurar. Lo que lleve más de TTL_DAYS días se purga solo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { resolveWithinHome } from './paths.js';

export const TRASH_DIRNAME = '.cwc-trash';
const TRASH_DIR = path.join(config.home, TRASH_DIRNAME);
const INDEX = path.join(TRASH_DIR, 'index.json');
const TTL_DAYS = 30;
const TTL_MS = TTL_DAYS * 86400000;

function ensureDir() {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')).items || []; }
  catch { return []; }
}
function saveIndex(items) {
  ensureDir();
  fs.writeFileSync(INDEX, JSON.stringify({ items }, null, 2));
}

// Mueve un absoluto (ya validado dentro del home) a la papelera.
export function moveToTrash(absPath, originalRel) {
  // Defensa en profundidad: aunque restoreFromTrash revalida al restaurar,
  // no persistimos una originalRel que escape del home (ej. '../../etc/passwd').
  if (resolveWithinHome(originalRel) === null) {
    throw new Error(`moveToTrash: originalRel fuera del home permitido: ${originalRel}`);
  }
  ensureDir();
  const st = fs.lstatSync(absPath);
  const id = crypto.randomBytes(8).toString('hex');
  const dest = path.join(TRASH_DIR, id);
  fs.renameSync(absPath, dest); // mismo filesystem => instantáneo
  const items = loadIndex();
  items.push({
    id,
    name: path.basename(absPath),
    originalRel,
    isDir: st.isDirectory(),
    deletedAt: Date.now(),
  });
  saveIndex(items);
  return id;
}

export function listTrash() {
  autoPurge();
  return loadIndex()
    .map((it) => ({
      ...it,
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
// vez resueltos symlinks) escapa del home real. resolveWithinHome() de arriba
// solo valida el string (ver core/paths.js), así que sin este chequeo un
// symlink que reemplazó a `originalRel` entre el trash y el restore movería
// el contenido de la papelera fuera del home sin que nada lo detecte —
// a diferencia de mkdir/rename/trash, que sí validan la carpeta contenedora
// REAL antes de mutar (ver statSafeSync en modules/files/index.js).
export function restoreFromTrash(id, assertContainerSafe) {
  const items = loadIndex();
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const it = items[idx];
  const src = path.join(TRASH_DIR, id);
  let targetRel = it.originalRel;
  let target = resolveWithinHome(targetRel);
  if (!target) target = path.join(config.home, it.name);
  // Evita pisar: si existe, agrega " (restaurado)".
  if (fs.existsSync(target)) {
    const ext = it.isDir ? '' : path.extname(it.name);
    const base = it.isDir ? it.name : path.basename(it.name, ext);
    target = path.join(path.dirname(target), `${base} (restaurado)${ext}`);
    targetRel = path.relative(config.home, target);
  }
  if (typeof assertContainerSafe === 'function') assertContainerSafe(path.dirname(target));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(src, target);
  items.splice(idx, 1);
  saveIndex(items);
  return targetRel;
}

// Purga definitiva de un id (o de todos los vencidos si id es null).
export function purgeTrash(id = null) {
  let items = loadIndex();
  const kill = (entry) => {
    try { fs.rmSync(path.join(TRASH_DIR, entry.id), { recursive: true, force: true }); } catch { /* noop */ }
  };
  if (id) {
    const entry = items.find((i) => i.id === id);
    if (entry) { kill(entry); items = items.filter((i) => i.id !== id); }
  } else {
    for (const e of items) kill(e);
    items = [];
  }
  saveIndex(items);
}

// Elimina los ítems vencidos (> TTL_DAYS). Se llama al listar y al iniciar.
export function autoPurge() {
  const now = Date.now();
  const items = loadIndex();
  const expired = items.filter((i) => now - i.deletedAt > TTL_MS);
  if (!expired.length) return 0;
  for (const e of expired) {
    try { fs.rmSync(path.join(TRASH_DIR, e.id), { recursive: true, force: true }); } catch { /* noop */ }
  }
  saveIndex(items.filter((i) => now - i.deletedAt <= TTL_MS));
  return expired.length;
}

export { TTL_DAYS };
