// modules/tasks/store.js — registro PRIVADO de tareas pendientes + PLANES +
// LOG de actividad de ESTE proyecto (nada sale al exterior; no se pushea).
// Estado file-based en ~/.cwc-data/tasks.json (tareas + planes) y
// ~/.cwc-data/tasks-activity.json (log append-only) → sobrevive reinicios del
// server SIN runner (el CRUD es síncrono y determinístico, escritura atómica
// tmp+rename, como el registro de bugfixes). Se alimenta manualmente Y desde el
// módulo `audio` (tareas propuestas por la IA que el usuario aprueba).
//
// FASE 2 (dashboard estilo Pad, 2026-07-06): se sumaron (A) PLANES que agrupan
// tareas con progreso %, (B) un LOG de actividad REAL persistido (antes el
// "Recent Activity" del panel se derivaba de timestamps, sin historial de
// cambios), y (C) el campo `type` de la tarea (task/idea/nota/feature) para
// clasificar. Pad sigue siendo solo el REFERENTE de diseño; los datos son 100%
// locales.
//
// Modelo de una tarea:
//   { id, title, description, type, status, priority, tags[], planId,
//     source, sourceRef, createdAt, updatedAt, doneAt }
// Modelo de un plan:
//   { id: 'PLAN-<n>', title, description, status, createdAt, updatedAt }
//   (+ taskCount/doneCount/pct DERIVADOS al leer, nunca persistidos)
// Modelo de un evento de actividad:
//   { id, ts, kind, entity, refId, title, detail }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const FILE = path.join(DATA_DIR, 'tasks.json');
const ACT_FILE = path.join(DATA_DIR, 'tasks-activity.json');

export const STATUSES = ['pendiente', 'en-progreso', 'hecha'];
export const PRIORITIES = ['alta', 'media', 'baja'];
export const TYPES = ['task', 'idea', 'nota', 'feature'];
export const PLAN_STATUSES = ['active', 'done', 'cancelled', 'proposed'];
const MAX_ACTIVITY = 300; // poda del log (uso personal, volumen chico)

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      seq: Number(raw.seq) || 0,
      planSeq: Number(raw.planSeq) || 0,
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      plans: Array.isArray(raw.plans) ? raw.plans : [],
    };
  } catch {
    return { seq: 0, planSeq: 0, tasks: [], plans: [] };
  }
}

// Escritura atómica (tmp + rename): un corte a mitad no deja el JSON corrupto.
function save(db) {
  writeJsonAtomic(FILE, db); // atómico tmp-por-PID (fix B4 2026-07-11, fuente única)
}

const clampStr = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const normStatus = (s) => (STATUSES.includes(s) ? s : 'pendiente');
const normPriority = (p) => (PRIORITIES.includes(p) ? p : 'media');
const normType = (t) => (TYPES.includes(t) ? t : 'task');
const normPlanStatus = (s) => (PLAN_STATUSES.includes(s) ? s : 'active');
function normTags(t) {
  if (!Array.isArray(t)) return [];
  return t.map((x) => clampStr(x, 40).trim()).filter(Boolean).slice(0, 10);
}
// Sólo acepta un planId que EXISTA (evita tareas colgando de un plan borrado).
function validPlanId(plans, id) {
  const s = id ? clampStr(id, 20) : null;
  if (!s) return null;
  return plans.some((p) => p.id === s) ? s : null;
}

// ---- Campos "estilo Pad" (2026-07-07): owner/estimate/fecha + relaciones ----
const normDate = (d) => {
  const s = clampStr(d, 10).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};
const REL_ID_RE = /^(T\d+|PLAN-\d+)$/;
// ids que existen (tareas + planes) para validar relaciones "blocks".
function allIdsOf(db) {
  const s = new Set();
  for (const t of db.tasks) s.add(t.id);
  for (const p of db.plans) s.add(p.id);
  return s;
}
// Relación "bloquea": ids válidos, existentes, sin el propio, deduplicados.
function normBlocks(ids, allIds, selfId) {
  if (!Array.isArray(ids)) return [];
  const set = new Set();
  for (const x of ids) {
    const s = clampStr(x, 20).trim();
    if (REL_ID_RE.test(s) && s !== selfId && allIds.has(s)) set.add(s);
  }
  return [...set].slice(0, 30);
}

// ---- Comentarios por ítem (append + borrar; sin editar, a pedido) ----
const MAX_COMMENTS = 200;
let commentCounter = 0;
function newComment(text) {
  commentCounter += 1;
  return { id: `C${Date.now()}-${commentCounter}`, ts: Date.now(), text: clampStr(text, 4000) };
}
function findItem(db, kind, id) {
  return kind === 'plan' ? db.plans.find((x) => x.id === id) : db.tasks.find((x) => x.id === id);
}

// ===== LOG DE ACTIVIDAD (append-only con poda; archivo aparte) =====
function loadActivity() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACT_FILE, 'utf8'));
    return Array.isArray(raw.events) ? raw.events : [];
  } catch { return []; }
}
function saveActivity(events) {
  writeJsonAtomic(ACT_FILE, { events }); // atómico tmp-por-PID (fix B4 2026-07-11)
}
let actCounter = 0;
function appendActivity(ev) {
  const events = loadActivity();
  actCounter += 1;
  events.push({ id: `A${Date.now()}-${actCounter}`, ts: Date.now(), ...ev });
  saveActivity(events.slice(-MAX_ACTIVITY)); // conservar los más recientes
}
// Los N eventos más recientes primero (para el panel "Actividad reciente").
export function listActivity(limit = 40) {
  return loadActivity().slice(-limit).reverse();
}

// ===== PLANES (progreso derivado de sus tareas) =====
function plansWithProgress(plans, tasks) {
  return plans.map((p) => {
    const own = tasks.filter((t) => t.planId === p.id);
    const doneCount = own.filter((t) => t.status === 'hecha').length;
    const pct = own.length ? Math.round((doneCount / own.length) * 100) : 0;
    return { ...p, taskCount: own.length, doneCount, pct };
  });
}

export function listPlans() {
  const { plans, tasks } = load();
  // Activos primero, luego por fecha de creación desc.
  const rank = { active: 0, proposed: 1, done: 2, cancelled: 3 };
  return plansWithProgress(plans, tasks).sort((a, b) =>
    (rank[a.status] - rank[b.status]) || ((b.createdAt || 0) - (a.createdAt || 0)));
}

export function createPlan(input = {}) {
  const db = load();
  db.planSeq += 1;
  const now = Date.now();
  const id = `PLAN-${db.planSeq}`;
  const plan = {
    id,
    title: clampStr(input.title, 200).trim() || 'Plan sin título',
    description: clampStr(input.description, 4000),
    status: normPlanStatus(input.status),
    owner: clampStr(input.owner, 120),
    phase: clampStr(input.phase, 20),
    targetDate: normDate(input.targetDate),
    comments: [],
    blocks: normBlocks(input.blocks, allIdsOf(db), id),
    createdAt: now,
    updatedAt: now,
  };
  db.plans.push(plan);
  save(db);
  appendActivity({ kind: 'created', entity: 'plan', refId: plan.id, title: plan.title });
  return plansWithProgress([plan], db.tasks)[0];
}

export function updatePlan(id, patch = {}) {
  const db = load();
  const p = db.plans.find((x) => x.id === id);
  if (!p) { const e = new Error('Plan inexistente.'); e.notFound = true; throw e; }
  if (patch.title != null) p.title = clampStr(patch.title, 200).trim() || p.title;
  if (patch.description != null) p.description = clampStr(patch.description, 4000);
  if (patch.owner != null) p.owner = clampStr(patch.owner, 120);
  if (patch.phase != null) p.phase = clampStr(patch.phase, 20);
  if (patch.targetDate != null) p.targetDate = normDate(patch.targetDate);
  if (patch.blocks != null) p.blocks = normBlocks(patch.blocks, allIdsOf(db), p.id);
  let statusChanged = null;
  if (patch.status != null) {
    const next = normPlanStatus(patch.status);
    if (next !== p.status) { statusChanged = next; p.status = next; }
  }
  p.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: statusChanged ? 'status' : 'updated', entity: 'plan', refId: p.id, title: p.title, detail: statusChanged || null });
  return plansWithProgress([p], db.tasks)[0];
}

export function deletePlan(id) {
  const db = load();
  const i = db.plans.findIndex((x) => x.id === id);
  if (i < 0) { const e = new Error('Plan inexistente.'); e.notFound = true; throw e; }
  const [removed] = db.plans.splice(i, 1);
  // Desasignar (no borrar) las tareas que colgaban del plan.
  for (const t of db.tasks) if (t.planId === removed.id) t.planId = null;
  save(db);
  appendActivity({ kind: 'deleted', entity: 'plan', refId: removed.id, title: removed.title });
  return removed;
}

// ===== TAREAS =====
// Vista pública (ordenada: sin terminar primero por prioridad, luego por fecha)
// + conteos + planes con progreso (todo lo que el dashboard necesita).
export function listTasks() {
  const { tasks, plans } = load();
  const prioRank = { alta: 0, media: 1, baja: 2 };
  const statusRank = { pendiente: 0, 'en-progreso': 1, hecha: 2 };
  const sorted = [...tasks].sort((a, b) => {
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    if (prioRank[a.priority] !== prioRank[b.priority]) return (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  const counts = { pendiente: 0, 'en-progreso': 0, hecha: 0, total: tasks.length };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return { tasks: sorted, counts, plans: plansWithProgress(plans, tasks) };
}

export function createTask(input = {}) {
  const db = load();
  db.seq += 1;
  const now = Date.now();
  const status = normStatus(input.status);
  const id = `T${db.seq}`;
  const task = {
    id,
    title: clampStr(input.title, 200).trim() || 'Sin título',
    description: clampStr(input.description, 4000),
    type: normType(input.type),
    status,
    priority: normPriority(input.priority),
    tags: normTags(input.tags),
    planId: validPlanId(db.plans, input.planId),
    owner: clampStr(input.owner, 120),
    estimate: clampStr(input.estimate, 40),
    dueDate: normDate(input.dueDate),
    comments: [],
    blocks: normBlocks(input.blocks, allIdsOf(db), id),
    source: input.source === 'audio' ? 'audio' : 'manual',
    sourceRef: input.sourceRef ? clampStr(input.sourceRef, 64) : null,
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'hecha' ? now : null,
  };
  db.tasks.push(task);
  save(db);
  appendActivity({ kind: 'created', entity: 'task', refId: task.id, title: task.title });
  return task;
}

export function updateTask(id, patch = {}) {
  const db = load();
  const t = db.tasks.find((x) => x.id === id);
  if (!t) { const e = new Error('Tarea inexistente.'); e.notFound = true; throw e; }
  if (patch.title != null) t.title = clampStr(patch.title, 200).trim() || t.title;
  if (patch.description != null) t.description = clampStr(patch.description, 4000);
  if (patch.priority != null) t.priority = normPriority(patch.priority);
  if (patch.type != null) t.type = normType(patch.type);
  if (patch.tags != null) t.tags = normTags(patch.tags);
  if (patch.planId !== undefined) t.planId = validPlanId(db.plans, patch.planId);
  if (patch.owner != null) t.owner = clampStr(patch.owner, 120);
  if (patch.estimate != null) t.estimate = clampStr(patch.estimate, 40);
  if (patch.dueDate != null) t.dueDate = normDate(patch.dueDate);
  if (patch.blocks != null) t.blocks = normBlocks(patch.blocks, allIdsOf(db), t.id);
  let statusChanged = null;
  if (patch.status != null) {
    const next = normStatus(patch.status);
    if (next !== t.status) {
      statusChanged = next;
      t.status = next;
      t.doneAt = next === 'hecha' ? Date.now() : null;
    }
  }
  t.updatedAt = Date.now();
  save(db);
  if (statusChanged) appendActivity({ kind: statusChanged === 'hecha' ? 'completed' : 'status', entity: 'task', refId: t.id, title: t.title, detail: statusChanged });
  else appendActivity({ kind: 'updated', entity: 'task', refId: t.id, title: t.title });
  return t;
}

export function deleteTask(id) {
  const db = load();
  const i = db.tasks.findIndex((x) => x.id === id);
  if (i < 0) { const e = new Error('Tarea inexistente.'); e.notFound = true; throw e; }
  const [removed] = db.tasks.splice(i, 1);
  save(db);
  appendActivity({ kind: 'deleted', entity: 'task', refId: removed.id, title: removed.title });
  return removed;
}

// ===== COMENTARIOS + TIMELINE por ítem (tarea o plan) =====
// kind = 'task' | 'plan'. Agregar un comentario también deja un evento en el log.
export function addComment(kind, id, text) {
  const clean = clampStr(text, 4000).trim();
  if (!clean) { const e = new Error('El comentario está vacío.'); e.bad = true; throw e; }
  const db = load();
  const it = findItem(db, kind, id);
  if (!it) { const e = new Error('Ítem inexistente.'); e.notFound = true; throw e; }
  if (!Array.isArray(it.comments)) it.comments = [];
  const c = newComment(clean);
  it.comments.push(c);
  it.comments = it.comments.slice(-MAX_COMMENTS);
  it.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: 'comment', entity: kind, refId: id, title: it.title, detail: clean.slice(0, 80) });
  return c;
}
export function deleteComment(kind, id, cid) {
  const db = load();
  const it = findItem(db, kind, id);
  if (!it) { const e = new Error('Ítem inexistente.'); e.notFound = true; throw e; }
  it.comments = (it.comments || []).filter((c) => c.id !== cid);
  save(db);
  return true;
}
// Timeline del ítem: sus comentarios + los eventos del log que lo referencian
// (excluye los eventos 'comment', que ya vienen del array de comentarios), desc.
export function timelineFor(kind, id) {
  const db = load();
  const it = findItem(db, kind, id);
  if (!it) return { events: [] };
  const events = [];
  for (const c of it.comments || []) events.push({ type: 'comment', ts: c.ts, cid: c.id, text: c.text });
  for (const ev of loadActivity()) {
    if (ev.refId === id && ev.kind !== 'comment') events.push({ type: 'event', ts: ev.ts, kind: ev.kind, detail: ev.detail || null });
  }
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { events: events.slice(0, 100) };
}

// Alta EN LOTE desde una propuesta del módulo audio (el usuario ya aprobó cada
// una en la UI). Devuelve las tareas creadas.
export function createFromAudio(jobId, items = []) {
  const created = [];
  for (const it of Array.isArray(items) ? items.slice(0, 50) : []) {
    created.push(createTask({ ...it, source: 'audio', sourceRef: jobId }));
  }
  return created;
}
