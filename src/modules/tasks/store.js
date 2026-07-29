// modules/tasks/store.js — registro PRIVADO de tareas pendientes + PLANES de
// ESTE proyecto (nada sale al exterior, no se pushea).
//
// MIGRACIÓN A PAD LOCAL (2026-07-12, ROAD-110 / TASK-123): la fuente de verdad
// de tareas y planes dejó de ser el archivo ~/.cwc-data/tasks.json — ahora son
// las colecciones `pendientes` (prefix PEND) y `planes` (prefix PLAN) del Pad
// LOCAL self-hosted (workspace `console`), vía src/core/pad-service-client.js.
// TODAS las funciones son ahora ASYNC (antes eran síncronas) — mismos NOMBRES y
// mismas firmas de argumentos que antes, así que el único caller (index.js) solo
// necesitó sumar `await`. El LOG DE ACTIVIDAD (`listActivity`/appendActivity)
// sigue local, síncrono y atómico, pero vive en el dataDir del dueño que
// `index.js` resuelve por operación.
//
// GOTCHAS CRÍTICOS descubiertos con pruebas reales contra el server (ver también
// los comentarios en pad-service-client.js, fuente de verdad de estos matices):
//   1. Los campos custom del schema (status/priority/owner/estimate/dueDate/type/
//      source/sourceRef/phase/targetDate) van SIEMPRE anidados en `fields:{...}`
//      al crear/editar — mandarlos "planos" los ignora en silencio y aplica el
//      default del schema. Solo `title`/`content`/`tags` van planos.
//   2. Un PATCH de `fields` REEMPLAZA el objeto entero (no lo mergea) — por eso
//      updateTask/updatePlan hacen SIEMPRE read-modify-write (getItem primero).
//   3. `planId` (tarea/plan → plan) es la relación nativa "parent" de Pad
//      (pad.setParent) — fijar un parent nuevo reemplaza el anterior solo, sin
//      necesidad de unlink previo; y un plan archivado hace que `parent_ref`
//      desaparezca solo de los items que apuntaban a él (no hace falta cascada
//      manual al borrar un plan, verificado).
//   4. `blocks[]` es la relación nativa "blocks" (pad.addLink/deleteLink) — NO
//      viene decorada en list/get como el parent, hay que pedirla aparte con
//      listLinks() por cada ítem, con CONCURRENCIA ACOTADA (mapPooled, tope
//      LINKS_CONCURRENCY) — un Promise.all sin tope sobre 60-100 ítems agotaba
//      el rate limiter por-usuario de Pad local (bug real 2026-07-12, ver el
//      comentario de mapPooled más abajo).
//   5. Borrar un comentario NO cuelga del item (`/items/:ref/comments/:cid` da
//      404) — es un recurso propio del workspace por el UUID del comentario
//      (`/comments/:cid`), SÍ soportado (a diferencia de lo que el plan
//      contemplaba como posible "no soportado").
//   6. `doneAt` no es un campo nativo de Pad: se guarda como custom field STRING
//      (epoch ms) dentro de `fields`, igual lógica que antes (se setea al pasar
//      a 'hecha', se limpia al salir de ese estado).
//
// Modelo de una tarea (shape que YA consumía el frontend, sin cambios):
//   { id, title, description, type, status, priority, tags[], planId, owner,
//     estimate, dueDate, blocks[], source, sourceRef, createdAt, updatedAt, doneAt }
// Modelo de un plan:
//   { id: 'PLAN-<n>', title, description, status, owner, phase, targetDate,
//     blocks[], createdAt, updatedAt }
//   (+ taskCount/doneCount/pct DERIVADOS al leer, nunca persistidos)
// Modelo de un evento de actividad (SIN CAMBIOS, sigue 100% local):
//   { id, ts, kind, entity, refId, title, detail }
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { runAdaptivePool } from '../../core/pool.js';
import {
  listItems, getItem, createItem, updateItem, deleteItem as padDeleteItem,
  listComments, addComment as padAddComment, deleteComment as padDeleteComment,
  listLinks, addLink, deleteLink, setParent,
} from '../../core/pad-service-client.js';

const TASKS_COLLECTION = 'pendientes';
const PLANS_COLLECTION = 'planes';

export const STATUSES = ['pendiente', 'en-progreso', 'hecha'];
export const PRIORITIES = ['alta', 'media', 'baja'];
export const TYPES = ['task', 'idea', 'nota', 'feature'];
export const PLAN_STATUSES = ['active', 'done', 'cancelled', 'proposed'];
const MAX_ACTIVITY = 300; // poda del log (uso personal, volumen chico)

function activityFile(dataDir) {
  return path.join(dataDir, 'tasks-activity.json');
}

function ensureDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
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

// ---- Campos "estilo Pad" (2026-07-07): owner/estimate/fecha + relaciones ----
const normDate = (d) => {
  const s = clampStr(d, 10).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};
const PLAN_ID_RE = /^PLAN-\d+$/;
const REL_ID_RE = /^(PEND-\d+|PLAN-\d+)$/;
// Candidatos de relación "bloquea": formato válido, sin el propio, deduplicados.
// La EXISTENCIA real la valida Pad al crear el link (addLink falla si el target
// no existe) — no hace falta traer todos los ids para chequear de antemano.
function normBlockCandidates(ids, selfId) {
  if (!Array.isArray(ids)) return [];
  const set = new Set();
  for (const x of ids) {
    const s = clampStr(x, 20).trim();
    if (REL_ID_RE.test(s) && s !== selfId) set.add(s);
  }
  return [...set].slice(0, 30);
}

// ===== Helpers de mapeo Pad ⇄ shape del frontend =====
function parseFields(item) {
  const f = item?.fields;
  if (!f) return {};
  if (typeof f === 'object') return f;
  try { const p = JSON.parse(f); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}
function parseTagsField(item) {
  const t = item?.tags;
  if (Array.isArray(t)) return t;
  if (typeof t === 'string') { try { const p = JSON.parse(t); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}
function tsMs(iso) {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}
function padError(action, r) {
  const e = new Error(`Pad local (${action}): ${r?.error || 'error desconocido'}`);
  e.padError = true;
  return e;
}
// notFound se marca SOLO ante un 404 real de Pad — cualquier otro fallo (Pad
// caído, timeout, token vencido) es un 500 genérico, nunca un 404 engañoso.
function notFoundOr500(action, entityLabel, r) {
  if (r.status === 404) { const e = new Error(`${entityLabel} inexistente.`); e.notFound = true; return e; }
  return padError(action, r);
}

function taskFromPadItem(item, blocks = []) {
  const f = parseFields(item);
  return {
    id: item.ref,
    title: item.title || 'Sin título',
    description: item.content || '',
    type: normType(f.type),
    status: normStatus(f.status),
    priority: normPriority(f.priority),
    tags: parseTagsField(item),
    planId: item.parent_ref || null,
    owner: f.owner || '',
    estimate: f.estimate || '',
    dueDate: f.dueDate || '',
    blocks,
    source: f.source === 'audio' ? 'audio' : 'manual',
    sourceRef: f.sourceRef || null,
    createdAt: tsMs(item.created_at),
    updatedAt: tsMs(item.updated_at),
    doneAt: f.doneAt ? Number(f.doneAt) : null,
  };
}

function planFromPadItem(item, blocks = []) {
  const f = parseFields(item);
  return {
    id: item.ref,
    title: item.title || 'Plan sin título',
    description: item.content || '',
    status: normPlanStatus(f.status),
    owner: f.owner || '',
    phase: f.phase || '',
    targetDate: f.targetDate || '',
    blocks,
    createdAt: tsMs(item.created_at),
    updatedAt: tsMs(item.updated_at),
  };
}

// Relación "blocks" de un ítem (lo que ÉL bloquea) — no viene decorada en
// list/get, hay que pedirla aparte. Best-effort: si falla, sin bloqueos.
// `ctl` (opcional) es el control de runAdaptivePool — señala back-off si Pad
// responde 429 (ver mapPooled, más abajo).
async function blocksOf(ref, ctl, ctx = null) {
  const r = await listLinks(ref, { ctx });
  if (!r.ok) {
    if (r.status === 429) ctl?.backoff();
    return [];
  }
  return r.data
    .filter((l) => l.link_type === 'blocks' && l.source_ref === ref)
    .map((l) => l.target_ref);
}

// Links de UN ítem para el detalle (lazy): "bloquea a" (saliente) +
// "bloqueado por" (entrante), ambos de UNA sola llamada listLinks(ref).
// Reemplaza el fan-out que listTasks hacía por CADA ítem (BUG-620).
// Best-effort: si falla, sin relaciones.
export async function linksFor(ref, ctx = null) {
  const r = await listLinks(ref, { ctx });
  if (!r.ok) return { blocks: [], blockedBy: [] };
  const blocks = r.data.filter((l) => l.link_type === 'blocks' && l.source_ref === ref).map((l) => l.target_ref);
  const blockedBy = r.data.filter((l) => l.link_type === 'blocks' && l.target_ref === ref).map((l) => l.source_ref);
  return { blocks, blockedBy };
}

// Concurrencia ACOTADA para el fan-out "un listLinks() por ítem" de
// listTasks()/listPlans() (bug real 2026-07-12: sin tope, una lista de 60-100
// tareas+planes disparaba esa cantidad de requests SIMULTÁNEOS contra Pad
// local en CADA poll de 20s del board — agotaba su rate limiter por-usuario y
// tiraba "too many requests" hasta en el uso manual de Pad, web/MCP, mientras
// tanto). Mismo patrón que el `pool()` de tickets/sources.js (regla de oro:
// paralelo lo que LEE, con tope): concurrencia FIJA baja + back-off (ctl) si
// Pad devuelve 429.
const LINKS_CONCURRENCY = 4;
async function mapPooled(items, fn) {
  const out = new Array(items.length);
  const indexed = items.map((item, idx) => ({ item, idx }));
  await runAdaptivePool(indexed, async ({ item, idx }, ctl) => {
    out[idx] = await fn(item, ctl);
  }, { min: LINKS_CONCURRENCY, start: LINKS_CONCURRENCY, max: LINKS_CONCURRENCY });
  return out;
}

// Aplica la relación "blocks" deseada (diff contra la actual: agrega lo que
// falta, quita lo que sobra) — usado por updateTask/updatePlan.
async function applyBlocks(ref, desiredIds, ctx = null) {
  const desired = normBlockCandidates(desiredIds, ref);
  const linksR = await listLinks(ref, { ctx });
  const currentLinks = linksR.ok ? linksR.data.filter((l) => l.link_type === 'blocks' && l.source_ref === ref) : [];
  const currentTargets = new Set(currentLinks.map((l) => l.target_ref));
  const desiredSet = new Set(desired);
  for (const l of currentLinks) if (!desiredSet.has(l.target_ref)) await deleteLink(l.id, { ctx });
  for (const target of desired) if (!currentTargets.has(target)) await addLink(ref, target, 'blocks', { ctx });
}

// Tareas ya mapeadas (sin blocks — no hace falta para calcular progreso de
// planes), usadas por createPlan/updatePlan para derivar taskCount/doneCount/pct.
async function tasksForProgress(ctx = null) {
  const r = await listItems(TASKS_COLLECTION, { ctx });
  if (!r.ok) return [];
  return r.data.map((t) => taskFromPadItem(t));
}

// ===== LOG DE ACTIVIDAD (SIN CAMBIOS: append-only local, con poda) =====
function loadActivity(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(activityFile(dataDir), 'utf8'));
    return Array.isArray(raw.events) ? raw.events : [];
  } catch { return []; }
}
function saveActivity(dataDir, events) {
  ensureDir(dataDir);
  writeJsonAtomic(activityFile(dataDir), { events }); // atómico tmp-por-PID (fix B4 2026-07-11)
}
let actCounter = 0;
function appendActivity(dataDir, ev) {
  const events = loadActivity(dataDir);
  actCounter += 1;
  events.push({ id: `A${Date.now()}-${actCounter}`, ts: Date.now(), ...ev });
  saveActivity(dataDir, events.slice(-MAX_ACTIVITY)); // conservar los más recientes
}
// Los N eventos más recientes primero (para el panel "Actividad reciente").
export function listActivity(dataDir, limit = 40) {
  return loadActivity(dataDir).slice(-limit).reverse();
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

export async function listPlans(ctx = null) {
  const [plansR, tasks] = await Promise.all([listItems(PLANS_COLLECTION, { ctx }), tasksForProgress(ctx)]);
  if (!plansR.ok) throw padError('listPlans', plansR);
  const plans = await mapPooled(plansR.data, async (p, ctl) => planFromPadItem(p, await blocksOf(p.ref, ctl, ctx)));
  // Activos primero, luego por fecha de creación desc.
  const rank = { active: 0, proposed: 1, done: 2, cancelled: 3 };
  return plansWithProgress(plans, tasks).sort((a, b) =>
    (rank[a.status] - rank[b.status]) || ((b.createdAt || 0) - (a.createdAt || 0)));
}

export async function createPlan(dataDir, input = {}, ctx = null) {
  const title = clampStr(input.title, 200).trim() || 'Plan sin título';
  const fields = {
    status: normPlanStatus(input.status),
    owner: clampStr(input.owner, 120),
    phase: clampStr(input.phase, 20),
    targetDate: normDate(input.targetDate),
  };
  const r = await createItem(PLANS_COLLECTION, { title, content: clampStr(input.description, 4000), fields }, { ctx });
  if (!r.ok) throw padError('createPlan', r);
  const ref = r.data.ref;

  const blockIds = normBlockCandidates(input.blocks, ref);
  const blocks = [];
  for (const target of blockIds) { const lr = await addLink(ref, target, 'blocks', { ctx }); if (lr.ok) blocks.push(target); }

  appendActivity(dataDir, { kind: 'created', entity: 'plan', refId: ref, title });
  const fresh = await getItem(ref, { ctx });
  const plan = planFromPadItem(fresh.ok ? fresh.data : r.data, blocks);
  return plansWithProgress([plan], await tasksForProgress(ctx))[0];
}

export async function updatePlan(dataDir, id, patch = {}, ctx = null) {
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('updatePlan', 'Plan', cur);
  const f = parseFields(cur.data);
  const body = {};
  if (patch.title != null) body.title = clampStr(patch.title, 200).trim() || cur.data.title;
  if (patch.description != null) body.content = clampStr(patch.description, 4000);

  const nextFields = { ...f };
  if (patch.owner != null) nextFields.owner = clampStr(patch.owner, 120);
  if (patch.phase != null) nextFields.phase = clampStr(patch.phase, 20);
  if (patch.targetDate != null) nextFields.targetDate = normDate(patch.targetDate);
  let statusChanged = null;
  if (patch.status != null) {
    const next = normPlanStatus(patch.status);
    if (next !== normPlanStatus(f.status)) { statusChanged = next; nextFields.status = next; }
  }
  body.fields = nextFields; // SIEMPRE el objeto completo (PATCH de fields reemplaza, no mergea)

  const r = await updateItem(id, body, { ctx });
  if (!r.ok) throw padError('updatePlan', r);

  if (patch.blocks != null) await applyBlocks(id, patch.blocks, ctx);

  const fresh = await getItem(id, { ctx });
  const blocks = await blocksOf(id, null, ctx);
  appendActivity(dataDir, { kind: statusChanged ? 'status' : 'updated', entity: 'plan', refId: id, title: fresh.data?.title, detail: statusChanged || null });
  const plan = planFromPadItem(fresh.ok ? fresh.data : cur.data, blocks);
  return plansWithProgress([plan], await tasksForProgress(ctx))[0];
}

export async function deletePlan(dataDir, id, ctx = null) {
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('deletePlan', 'Plan', cur);
  const blocks = await blocksOf(id, null, ctx);
  const removed = planFromPadItem(cur.data, blocks);
  // Archivar en Pad (soft-delete): las tareas que colgaban del plan quedan
  // desasignadas solas (verificado: `parent_ref` desaparece de un item cuyo
  // padre fue archivado — no hace falta cascada manual).
  const r = await padDeleteItem(id, { ctx });
  if (!r.ok) throw padError('deletePlan', r);
  appendActivity(dataDir, { kind: 'deleted', entity: 'plan', refId: id, title: removed.title });
  return removed;
}

// Conteos por estado, SIN el fan-out de blocksOf() — es lo único que necesita
// el poll de 20s del sidebar (loadCounts() en tasks.js), que antes pegaba
// contra listTasks() completo y pagaba 60-100 listLinks() de más por cada
// tick, para siempre, aunque el tablero ni estuviera abierto (mismo bug real
// 2026-07-12 de mapPooled más arriba — esta es la otra mitad: evitar el
// trabajo, no solo acotar su concurrencia).
export async function listCounts(ctx = null) {
  const r = await listItems(TASKS_COLLECTION, { ctx });
  if (!r.ok) throw padError('listCounts', r);
  const counts = { pendiente: 0, 'en-progreso': 0, hecha: 0, total: r.data.length };
  for (const t of r.data) {
    const status = normStatus(parseFields(t).status);
    counts[status] = (counts[status] || 0) + 1;
  }
  return { counts };
}

// ===== TAREAS =====
// Vista pública (ordenada: sin terminar primero por prioridad, luego por fecha)
// + conteos + planes con progreso (todo lo que el dashboard necesita).
export async function listTasks(ctx = null) {
  const [tasksR, plansR] = await Promise.all([listItems(TASKS_COLLECTION, { ctx }), listItems(PLANS_COLLECTION, { ctx })]);
  if (!tasksR.ok) throw padError('listTasks', tasksR);
  if (!plansR.ok) throw padError('listTasks:plans', plansR);
  // Los blocks[] (relación "bloquea a") NO se traen acá: eran un fan-out N+1
  // (1 listLinks por ítem → ~121 requests → hasta 15s bajo el rate-limit de
  // Pad local) y SOLO se usan al abrir el detalle de UN ítem. Ahora se piden
  // lazy vía linksFor() / GET /:id/links. El render del tablero no usa blocks
  // (BUG-620). taskFromPadItem/planFromPadItem ya defaultean blocks=[].
  const tasks = tasksR.data.map((t) => taskFromPadItem(t));
  const plans = plansR.data.map((p) => planFromPadItem(p));

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

export async function createTask(dataDir, input = {}, ctx = null) {
  const status = normStatus(input.status);
  const title = clampStr(input.title, 200).trim() || 'Sin título';
  const fields = {
    status,
    priority: normPriority(input.priority),
    type: normType(input.type),
    owner: clampStr(input.owner, 120),
    estimate: clampStr(input.estimate, 40),
    dueDate: normDate(input.dueDate),
    source: input.source === 'audio' ? 'audio' : 'manual',
    sourceRef: input.sourceRef ? clampStr(input.sourceRef, 64) : '',
    doneAt: status === 'hecha' ? String(Date.now()) : '',
  };
  const r = await createItem(TASKS_COLLECTION, {
    title,
    content: clampStr(input.description, 4000),
    tags: normTags(input.tags),
    fields,
  }, { ctx });
  if (!r.ok) throw padError('createTask', r);
  const ref = r.data.ref;

  const planCandidate = clampStr(input.planId, 20).trim();
  if (planCandidate && PLAN_ID_RE.test(planCandidate)) await setParent(ref, planCandidate, { ctx });

  const blockIds = normBlockCandidates(input.blocks, ref);
  const blocks = [];
  for (const target of blockIds) { const lr = await addLink(ref, target, 'blocks', { ctx }); if (lr.ok) blocks.push(target); }

  appendActivity(dataDir, { kind: 'created', entity: 'task', refId: ref, title });
  const fresh = await getItem(ref, { ctx });
  return taskFromPadItem(fresh.ok ? fresh.data : r.data, blocks);
}

export async function updateTask(dataDir, id, patch = {}, ctx = null) {
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('updateTask', 'Tarea', cur);
  const f = parseFields(cur.data);
  const body = {};
  if (patch.title != null) body.title = clampStr(patch.title, 200).trim() || cur.data.title;
  if (patch.description != null) body.content = clampStr(patch.description, 4000);
  if (patch.tags != null) body.tags = normTags(patch.tags);

  const nextFields = { ...f };
  if (patch.priority != null) nextFields.priority = normPriority(patch.priority);
  if (patch.type != null) nextFields.type = normType(patch.type);
  if (patch.owner != null) nextFields.owner = clampStr(patch.owner, 120);
  if (patch.estimate != null) nextFields.estimate = clampStr(patch.estimate, 40);
  if (patch.dueDate != null) nextFields.dueDate = normDate(patch.dueDate);
  let statusChanged = null;
  if (patch.status != null) {
    const next = normStatus(patch.status);
    if (next !== normStatus(f.status)) {
      statusChanged = next;
      nextFields.status = next;
      nextFields.doneAt = next === 'hecha' ? String(Date.now()) : '';
    }
  }
  body.fields = nextFields; // SIEMPRE el objeto completo (PATCH de fields reemplaza, no mergea)

  const r = await updateItem(id, body, { ctx });
  if (!r.ok) throw padError('updateTask', r);

  if (patch.planId !== undefined) {
    if (patch.planId) {
      const pid = clampStr(patch.planId, 20).trim();
      if (PLAN_ID_RE.test(pid)) await setParent(id, pid, { ctx });
    } else if (cur.data.parent_link_id) {
      await deleteLink(cur.data.parent_link_id, { ctx });
    }
  }

  if (patch.blocks != null) await applyBlocks(id, patch.blocks, ctx);

  const fresh = await getItem(id, { ctx });
  const blocks = await blocksOf(id, null, ctx);
  if (statusChanged) appendActivity(dataDir, { kind: statusChanged === 'hecha' ? 'completed' : 'status', entity: 'task', refId: id, title: fresh.data?.title, detail: statusChanged });
  else appendActivity(dataDir, { kind: 'updated', entity: 'task', refId: id, title: fresh.data?.title });
  return taskFromPadItem(fresh.ok ? fresh.data : cur.data, blocks);
}

export async function deleteTask(dataDir, id, ctx = null) {
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('deleteTask', 'Tarea', cur);
  const blocks = await blocksOf(id, null, ctx);
  const removed = taskFromPadItem(cur.data, blocks);
  const r = await padDeleteItem(id, { ctx });
  if (!r.ok) throw padError('deleteTask', r);
  appendActivity(dataDir, { kind: 'deleted', entity: 'task', refId: id, title: removed.title });
  return removed;
}

// ===== COMENTARIOS + TIMELINE por ítem (tarea o plan) =====
// kind = 'task' | 'plan' — solo se usa para el LOG DE ACTIVIDAD local (Pad
// direcciona el ítem por su ref, que ya es único cruzando ambas colecciones).
// Agregar un comentario también deja un evento en el log.
export async function addComment(dataDir, kind, id, text, ctx = null) {
  const clean = clampStr(text, 4000).trim();
  if (!clean) { const e = new Error('El comentario está vacío.'); e.bad = true; throw e; }
  const r = await padAddComment(id, clean, { ctx });
  if (!r.ok) throw notFoundOr500('addComment', 'Ítem', r);
  const c = { id: r.data.id, ts: tsMs(r.data.created_at), text: r.data.body };
  const titleR = await getItem(id, { ctx });
  appendActivity(dataDir, { kind: 'comment', entity: kind, refId: id, title: titleR.ok ? titleR.data.title : id, detail: clean.slice(0, 80) });
  return c;
}
export async function deleteComment(kind, id, cid, ctx = null) {
  const r = await padDeleteComment(cid, { ctx });
  if (!r.ok) throw notFoundOr500('deleteComment', 'Comentario', r);
  return true;
}
// Timeline del ítem: sus comentarios (Pad) + los eventos del log local que lo
// referencian (excluye 'comment', que ya viene de Pad), desc. Best-effort: si
// Pad no responde los comentarios, igual devuelve los eventos del log local
// (nunca cuelga ni tira una excepción sin control).
export async function timelineFor(dataDir, kind, id, ctx = null) {
  const events = [];
  const cr = await listComments(id, { ctx });
  if (cr.ok) for (const c of cr.data) events.push({ type: 'comment', ts: tsMs(c.created_at), cid: c.id, text: c.body });
  for (const ev of loadActivity(dataDir)) {
    if (ev.refId === id && ev.kind !== 'comment') events.push({ type: 'event', ts: ev.ts, kind: ev.kind, detail: ev.detail || null });
  }
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { events: events.slice(0, 100) };
}

// Alta EN LOTE desde una propuesta del módulo audio (el usuario ya aprobó cada
// una en la UI). Devuelve las tareas creadas. Secuencial (no paralelo): mantiene
// el orden de creación en el log de actividad, igual que antes.
export async function createFromAudio(dataDir, jobId, items = [], ctx = null) {
  const created = [];
  for (const it of Array.isArray(items) ? items.slice(0, 50) : []) {
    created.push(await createTask(dataDir, { ...it, source: 'audio', sourceRef: jobId }, ctx));
  }
  return created;
}
