import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { hostUser, userDataDir } from '../../core/user-space.js';

const snapshots = new Map();
let arena = null;
let botPrs = null;

// Las rutas se resuelven por llamada: nunca congelar un dataDir de usuario en
// una constante de módulo (invariante multi-tenant BUG-2185).
function meFile(owner) { return path.join(userDataDir(owner), 'forja', 'me.json'); }
function festejosFile(owner) { return path.join(userDataDir(owner), 'forja', 'festejos.json'); }
function githubProfileFile(owner) { return path.join(userDataDir(owner), 'forja', 'github-profile.json'); }
function arenaFile() { return path.join(userDataDir(hostUser()), 'forja', 'arena.json'); }
function botPrsFile() { return path.join(userDataDir(hostUser()), 'forja', 'bot-prs.json'); }

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
  const savedBotPrs = readJson(botPrsFile());
  botPrs = Array.isArray(savedBotPrs) ? savedBotPrs : [];
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

export function getFestejos(owner) {
  const saved = readJson(festejosFile(owner));
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  return {
    login: typeof saved.login === 'string' ? saved.login : '',
    initializedAt: typeof saved.initializedAt === 'string' ? saved.initializedAt : null,
    celebrated: Array.isArray(saved.celebrated)
      ? saved.celebrated.filter(Number.isSafeInteger)
      : [],
    deployed: Array.isArray(saved.deployed)
      ? saved.deployed.filter(Number.isSafeInteger)
      : null,
    deployCelebrated: Array.isArray(saved.deployCelebrated)
      ? saved.deployCelebrated.filter((value) => typeof value === 'string')
      : [],
    pending: Array.isArray(saved.pending) ? saved.pending : [],
  };
}

export function saveFestejos(owner, state) {
  const next = {
    login: String(state?.login || ''),
    initializedAt: typeof state?.initializedAt === 'string'
      ? state.initializedAt : new Date().toISOString(),
    celebrated: Array.isArray(state?.celebrated)
      ? [...new Set(state.celebrated.filter(Number.isSafeInteger))]
      : [],
    deployCelebrated: Array.isArray(state?.deployCelebrated)
      ? [...new Set(state.deployCelebrated.filter((value) => typeof value === 'string'))]
      : [],
    pending: Array.isArray(state?.pending) ? state.pending.slice(-10) : [],
  };
  // Ausente/null conserva el marcador de migración: el refresher debe sembrar
  // todos los PR actuales antes de empezar a detectar producción.
  if (Array.isArray(state?.deployed)) {
    next.deployed = [...new Set(state.deployed.filter(Number.isSafeInteger))];
  }
  writeJsonAtomic(festejosFile(owner), next, { space: 2 });
  return next;
}

export function pendingFestejos(owner) {
  return getFestejos(owner)?.pending.length || 0;
}

export function markFestejosSeen(owner, { ids = [], numbers = [] } = {}) {
  const state = getFestejos(owner);
  if (!state) return { pending: [] };
  const seenIds = new Set(ids);
  const seenNumbers = new Set(numbers);
  return saveFestejos(owner, {
    ...state,
    pending: state.pending.filter((festejo) => {
      if (typeof festejo?.id === 'string' && seenIds.has(festejo.id)) return false;
      return !seenNumbers.has(festejo?.number);
    }),
  });
}

export function getGithubProfile(owner) {
  const saved = readJson(githubProfileFile(owner));
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const login = typeof saved.login === 'string' ? saved.login.trim() : '';
  if (!login) return null;
  return {
    login,
    name: typeof saved.name === 'string' ? saved.name.trim() : '',
    validatedAt: typeof saved.validatedAt === 'string' ? saved.validatedAt : null,
  };
}

export function saveGithubProfile(owner, profile) {
  const next = {
    login: String(profile?.login || '').trim(),
    name: String(profile?.name || '').trim(),
    validatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(githubProfileFile(owner), next, { space: 2 });
  return next;
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

export function getBotPrs() {
  if (botPrs) return botPrs;
  const saved = readJson(botPrsFile());
  botPrs = Array.isArray(saved) ? saved : [];
  return botPrs;
}

export function saveBotPrs(prs) {
  const next = Array.isArray(prs) ? prs : [];
  writeJsonAtomic(botPrsFile(), next, { space: 2 });
  botPrs = next;
  return next;
}

export function snapshotAgeMs(owner, now = Date.now()) {
  const snapshot = getMeSnapshot(owner);
  const timestamps = [snapshot?.fetchedAt, snapshot?.lastAttemptAt]
    .map((value) => Date.parse(value || ''))
    .filter((value) => !Number.isNaN(value));
  return timestamps.length ? Math.max(0, now - Math.max(...timestamps)) : Infinity;
}
