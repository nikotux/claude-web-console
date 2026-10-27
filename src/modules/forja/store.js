import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { hostUser, userDataDir } from '../../core/user-space.js';

const snapshots = new Map();
let arena = null;

// Las rutas se resuelven por llamada: nunca congelar un dataDir de usuario en
// una constante de módulo (invariante multi-tenant BUG-2185).
function meFile(owner) { return path.join(userDataDir(owner), 'forja', 'me.json'); }
function arenaFile() { return path.join(userDataDir(hostUser()), 'forja', 'arena.json'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

export function loadFromDisk(owners = []) {
  for (const owner of owners) {
    const saved = readJson(meFile(owner));
    if (saved) snapshots.set(owner, saved);
  }
  arena = readJson(arenaFile());
  return { snapshots, arena };
}

export function getMeSnapshot(owner) {
  if (snapshots.has(owner)) return snapshots.get(owner);
  const saved = readJson(meFile(owner));
  if (saved) snapshots.set(owner, saved);
  return saved;
}

export function saveMeSnapshot(owner, snapshot) {
  writeJsonAtomic(meFile(owner), snapshot, { space: 2 });
  snapshots.set(owner, snapshot);
  return snapshot;
}

export function getArenaSnapshot() {
  if (arena) return arena;
  arena = readJson(arenaFile());
  return arena;
}

export function saveArenaSnapshot(snapshot) {
  writeJsonAtomic(arenaFile(), snapshot, { space: 2 });
  arena = snapshot;
  return snapshot;
}

export function snapshotAgeMs(owner, now = Date.now()) {
  const timestamp = Date.parse(getMeSnapshot(owner)?.generatedAt || '');
  return Number.isNaN(timestamp) ? Infinity : Math.max(0, now - timestamp);
}
