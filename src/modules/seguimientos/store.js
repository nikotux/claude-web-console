// modules/seguimientos/store.js — snapshot del dashboard "Seguimientos"
// (primer habitante de LIMBO, PLAN-553 · Regla dura #13). El snapshot vive en
// ~/.cwc-data/seguimientos/snapshot.json: Limbo lo HOSPEDA en la infra de
// Consola, pero su data es sombra agregada de ambos mundos (entrada read-only).
// Escritura atómica (core/atomic-write). El dashboard lee SIEMPRE de acá; nunca
// golpea el mundo externo en vivo (Aduana / Regla 12-13).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic } from '../../core/atomic-write.js';

const DIR = path.join(os.homedir(), '.cwc-data', 'seguimientos');
const SNAPSHOT = path.join(DIR, 'snapshot.json');

const EMPTY = { frentes: [], updatedAt: null, refreshing: false, counts: {} };

export function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

// Lee el snapshot persistido; si no existe todavía, devuelve uno vacío.
export function readSnapshot() {
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (!Array.isArray(snap.frentes)) snap.frentes = [];
    return snap;
  } catch {
    return { ...EMPTY };
  }
}

// Persiste el snapshot completo (atómico). Devuelve lo escrito.
export function writeSnapshot(snap) {
  ensureDir();
  const out = { ...EMPTY, ...snap, updatedAt: snap.updatedAt || new Date().toISOString() };
  writeJsonAtomic(SNAPSHOT, out);
  return out;
}

export { DIR, SNAPSHOT };
