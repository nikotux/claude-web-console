// modules/seguimientos/store.js — snapshot del dashboard "Seguimientos"
// (primer habitante de LIMBO, PLAN-553 · Regla dura #13). El snapshot vive en
// <dataDir-del-dueño>/seguimientos/snapshot.json: Limbo lo HOSPEDA en la infra
// de Consola, pero su data es sombra agregada de ambos mundos (entrada
// read-only). Escritura atómica (core/atomic-write). El dashboard lee SIEMPRE
// de acá; nunca golpea el mundo externo en vivo (Aduana / Regla 12-13).
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';

const moduleDir = (dataDir) => path.join(dataDir, 'seguimientos');
const snapshotPath = (dataDir) => path.join(moduleDir(dataDir), 'snapshot.json');

const EMPTY = { frentes: [], done: [], updatedAt: null, refreshing: false, counts: {} };

export function ensureDir(dataDir) {
  fs.mkdirSync(moduleDir(dataDir), { recursive: true, mode: 0o700 });
}

// Lee el snapshot persistido; si no existe todavía, devuelve uno vacío.
export function readSnapshot(dataDir) {
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotPath(dataDir), 'utf8'));
    if (!Array.isArray(snap.frentes)) snap.frentes = [];
    return snap;
  } catch {
    return { ...EMPTY };
  }
}

// Persiste el snapshot completo (atómico). Devuelve lo escrito.
export function writeSnapshot(dataDir, snap) {
  ensureDir(dataDir);
  const out = { ...EMPTY, ...snap, updatedAt: snap.updatedAt || new Date().toISOString() };
  writeJsonAtomic(snapshotPath(dataDir), out);
  return out;
}
