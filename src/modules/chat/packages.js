// modules/chat/packages.js — F2(b) de PLAN-373 (PEND-461): "clon de Pad" para
// las SESIONES. Registro DURABLE y auto-contenido de los PAQUETES-SESIÓN: cada
// conversación tiene un ref ESTABLE (PKG-<n>) que SOBREVIVE a los moves entre
// mundos (el mundo cambia, el ref NO). Es la capa estructurada tipo-Pad (ítems/
// campos/refs) que habilita F5 (referenciar/buscar un paquete desde otra sesión).
// NO es el Pad vivo: es un JSON local (~/.cwc-data/session-packages.json),
// self-contained, actualizado en los eventos de ciclo de vida (create/move/
// archive/revive/close). Best-effort: jamás rompe el flujo del chat.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { resolveDataDir } from '../../core/data-dir.js';
import { hostUser } from '../../core/user-space.js';

const FILE = path.join(resolveDataDir(), 'session-packages.json');

function load() {
  try {
    const j = JSON.parse(fss.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object' && j.items) return j;
  } catch { /* archivo nuevo o corrupto */ }
  return { seq: 0, items: {} };
}
function save(db) { try { writeJsonAtomic(FILE, db); } catch { /* best-effort */ } }

// Asigna un ref nuevo (PKG-<n>) incremental. Se llama UNA vez por conversación
// (en create); el ref se persiste en chats.json y sobrevive a los moves.
export function nextPackageRef(owner = null) {
  const db = load();
  db.seq = (db.seq || 0) + 1;
  const ref = `PKG-${db.seq}`;
  db.items[ref] = { ref, owner, status: 'active', createdAt: Date.now(), updatedAt: Date.now() };
  save(db);
  return ref;
}

// Upsert del registro estructurado (change-detecting: solo escribe si cambió algo
// relevante, para poder llamarse sin miedo en los eventos de ciclo de vida).
// F2(b): capa estructurada tipo-Pad — el paquete es un ÍTEM con timeline
// (`history[]`: un evento por transición de ciclo de vida) + `tags[]`. Si `rec`
// trae `event`, se apendea al timeline (created/moved/archived/revived/closed).
export function upsertPackage(rec) {
  if (!rec?.ref) return;
  const db = load();
  const prev = db.items[rec.ref];
  const next = {
    ref: rec.ref,
    owner: rec.owner ?? prev?.owner ?? null,
    chatId: rec.chatId ?? prev?.chatId ?? null,
    sessionId: rec.sessionId ?? prev?.sessionId ?? null,
    cwd: rec.cwd ?? prev?.cwd ?? null,
    world: rec.world ?? prev?.world ?? null,
    title: rec.title ?? prev?.title ?? null,
    status: rec.status ?? prev?.status ?? 'active',
    tags: Array.isArray(rec.tags) ? rec.tags.map((t) => String(t).slice(0, 40)).slice(0, 12) : (prev?.tags || []),
    history: Array.isArray(prev?.history) ? prev.history.slice() : [],
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (rec.event) { // timeline: un evento por transición de ciclo de vida (cap 30)
    next.history.push({ at: Date.now(), event: String(rec.event).slice(0, 24), world: next.world });
    if (next.history.length > 30) next.history = next.history.slice(-30);
  }
  const KEYS = ['owner', 'chatId', 'sessionId', 'cwd', 'world', 'title', 'status'];
  const unchanged = prev && KEYS.every((k) => prev[k] === next[k]) && (prev.tags || []).join('|') === (next.tags || []).join('|');
  if (unchanged && !rec.event) return; // nada cambió y no hay evento nuevo que loguear
  db.items[rec.ref] = next;
  save(db);
}

// No filtra por dueño: el endpoint que expone el detalle valida el principal aparte.
export function getPackage(ref) { return load().items?.[ref] || null; }
// Un owner ausente/null es el HOST (registros previos al multi-tenant): hay que
// normalizar ambos lados o el host se silencia sus propios paquetes viejos,
// con el mismo criterio que ChatManager.list.
const normOwner = (o) => (o == null ? hostUser() : o);
function sameOwner(a, b) { return normOwner(a) === normOwner(b); }
export function listPackages(owner) {
  const all = Object.values(load().items || {});
  return owner === undefined ? all : all.filter((p) => sameOwner(p.owner, owner));
}

// F5: buscar paquetes por texto (ref/título/mundo). Case-insensitive, tope 20.
export function searchPackages(q, owner) {
  const s = String(q || '').trim().toLowerCase();
  const all = listPackages(owner).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!s) return all.slice(0, 20);
  return all.filter((p) =>
    String(p.ref || '').toLowerCase().includes(s)
    || String(p.title || '').toLowerCase().includes(s)
    || String(p.world || '').toLowerCase().includes(s)).slice(0, 20);
}
