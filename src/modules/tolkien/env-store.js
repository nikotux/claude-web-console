// modules/tolkien/env-store.js — registro persistente de entornos Tolkien
// efímeros por sesión, asignación de puertos y límite de concurrencia.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';

export const ENVS_DIR = path.join(config.home, '.cwc-data', 'tolkien-envs');

const DEFAULT_PORT_RANGE = [3012, 3020];
const STATUS_VALUES = new Set(['provisioning', 'worktree-ready', 'db-ready', 'serving', 'error', 'down']);

function parsePortRange(value) {
  const m = String(value || '').trim().match(/^(\d+)-(\d+)$/);
  if (!m) return DEFAULT_PORT_RANGE;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 65535) {
    return DEFAULT_PORT_RANGE;
  }
  return [min, max];
}

function parseMaxEnvs(value) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

export const PORT_RANGE = parsePortRange(process.env.CWC_TOLKIEN_ENV_PORTS || '3012-3020');
export const MAX_ENVS = parseMaxEnvs(process.env.CWC_TOLKIEN_MAX_ENVS || '4');

export function assertSafeId(id) {
  if (typeof id !== 'string' || id === '.' || id === '..' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`tolkien-env: id inválido: ${String(id).slice(0, 40)}`);
  }
  return id;
}

export function envIdForChat(chatId) {
  return `env-${String(chatId).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 24);
}

export function dbNameFor(id) {
  assertSafeId(id);
  const db = `tolkien_env_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
  if (!/^tolkien_env_[A-Za-z0-9_]+$/.test(db)) {
    throw new Error(`tolkien-env: nombre de DB inválido para id ${id}`);
  }
  return db;
}

export function unitNameFor(id) {
  assertSafeId(id);
  return `tolkien-env-${id}`;
}

export function worktreePathFor(id) {
  assertSafeId(id);
  return path.join(ENVS_DIR, id, 'tree');
}

export function recordPathFor(id) {
  assertSafeId(id);
  return path.join(ENVS_DIR, `${id}.json`);
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function listEnvs() {
  let entries;
  try {
    entries = fs.readdirSync(ENVS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readRecord(path.join(ENVS_DIR, entry.name)))
    .filter(Boolean);
}

export function getEnv(id) {
  return readRecord(recordPathFor(id));
}

export function getEnvByChat(chatId) {
  const key = String(chatId);
  return listEnvs().find((rec) => String(rec?.chatId) === key) || null;
}

export function saveEnv(rec) {
  if (!rec || typeof rec !== 'object') throw new Error('tolkien-env: record inválido');
  assertSafeId(rec.id);
  if (rec.status && !STATUS_VALUES.has(rec.status)) {
    throw new Error(`tolkien-env: status inválido: ${rec.status}`);
  }
  const next = { ...rec, updatedAt: Date.now() };
  writeJsonAtomic(recordPathFor(next.id), next);
  return next;
}

export function patchEnv(id, patch) {
  const rec = getEnv(id);
  if (!rec) return null;
  return saveEnv({ ...rec, ...patch });
}

export function removeEnvRecord(id) {
  try { fs.unlinkSync(recordPathFor(id)); } catch { /* noop */ }
}

export function heartbeat(id) {
  return patchEnv(id, { heartbeatAt: Date.now() });
}

export function isEnvAlive(rec) {
  return !!rec && !!rec.status && !['down', 'error'].includes(rec.status);
}

export function allocatePort() {
  const [min, max] = PORT_RANGE;
  const used = new Set(listEnvs()
    .filter(isEnvAlive)
    .map((rec) => Number(rec.port))
    .filter((port) => Number.isInteger(port)));
  for (let port = min; port <= max; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

export function atCap() {
  return listEnvs().filter(isEnvAlive).length >= MAX_ENVS;
}
