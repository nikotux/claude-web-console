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
  ensureDir();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
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

// ===== LOG DE ACTIVIDAD (append-only con poda; archivo aparte) =====
function loadActivity() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACT_FILE, 'utf8'));
    return Array.isArray(raw.events) ? raw.events : [];
  } catch { return []; }
}
function saveActivity(events) {
  ensureDir();
  const tmp = `${ACT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ events }), { mode: 0o600 });
  fs.renameSync(tmp, ACT_FILE);
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
  const plan = {
    id: `PLAN-${db.planSeq}`,
    title: clampStr(input.title, 200).trim() || 'Plan sin título',
    description: clampStr(input.description, 4000),
    status: normPlanStatus(input.status),
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
  const task = {
    id: `T${db.seq}`,
    title: clampStr(input.title, 200).trim() || 'Sin título',
    description: clampStr(input.description, 4000),
    type: normType(input.type),
    status,
    priority: normPriority(input.priority),
    tags: normTags(input.tags),
    planId: validPlanId(db.plans, input.planId),
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

// Alta EN LOTE desde una propuesta del módulo audio (el usuario ya aprobó cada
// una en la UI). Devuelve las tareas creadas.
export function createFromAudio(jobId, items = []) {
  const created = [];
  for (const it of Array.isArray(items) ? items.slice(0, 50) : []) {
    created.push(createTask({ ...it, source: 'audio', sourceRef: jobId }));
  }
  return created;
}
