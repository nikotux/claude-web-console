// modules/learning/store.js — MÓDULO DE APRENDIZAJE: registro PRIVADO de los
// TEMAS que el dueño va aprendiendo/reforzando (instrucciones de Chris, cómo
// funciona el backend, GetPad, GitHub, cómo proponer un fix, etc.).
//
// MIGRACIÓN A PAD LOCAL (2026-07-12, ROAD-110 Fase 2 / TASK-232): la fuente de
// verdad dejó de ser ~/.cwc-data/learning.json — ahora son las colecciones
// `temas-de-aprendizaje` (prefix TDA) y `rutas-de-aprendizaje` (prefix RDA) del
// Pad LOCAL self-hosted (workspace `console`), vía
// src/core/pad-service-client.js. Mismo patrón EXACTO que la migración de
// tasks/store.js (ver TASK-123). TODAS las funciones de I/O son ahora ASYNC
// (antes eran síncronas) — mismos NOMBRES y firmas de argumentos, así que los 6
// consumidores reales (learning/index.js, learning/explain-shared.js,
// learning/analyze-shared.js, tasks/analyze-shared.js, chat/index.js,
// bin/cwc-learning-context-runner.js, bin/cwc-learning-explain-runner.js)
// solo necesitaron sumar `await` + actualizar sus regex de id (ver abajo).
// `listActivity`/`normScope`/`contextoText` NO se tocaron: siguen 100% locales
// y síncronas (el log de actividad por decisión de alcance; normScope/
// contextoText porque son funciones PURAS sin I/O).
//
// GOTCHAS CRÍTICOS descubiertos con pruebas reales contra el server (ver
// también los comentarios en pad-service-client.js y en tasks/store.js, que
// documentó los mismos matices primero):
//   1. Los campos custom del schema (status/priority/area/scope/question/
//      source/contextoEntradas/explanation) van SIEMPRE anidados en
//      `fields:{...}` al crear/editar — mandarlos "planos" los ignora en
//      silencio y aplica el default del schema. Solo `title`/`content`/`tags`
//      van planos.
//   2. Un PATCH de `fields` REEMPLAZA el objeto entero (no lo mergea) — por
//      eso TODA escritura hace read-modify-write (getItem primero, mergear,
//      mandar el objeto COMPLETO de vuelta).
//   3. `routeId` (tema → ruta) es la relación nativa "parent" de Pad
//      (pad.setParent) — fijar un parent nuevo reemplaza el anterior solo, sin
//      necesidad de unlink previo; y una ruta archivada hace que `parent_ref`
//      desaparezca solo de los temas que apuntaban a ella (no hace falta
//      cascada manual al borrar una ruta, verificado en la migración de tasks).
//   4. `contextoEntradas[]` y `explanation` (empaquetada junto con su
//      metadata: model/at/fingerprint/files/versions) son campos custom tipo
//      `json` — se guardan/leen como el ARRAY/OBJETO completo tal cual, mismo
//      read-modify-write que cualquier otro campo de `fields`.
//
// Modelo de un tema (shape que YA consumía el frontend, sin cambios):
//   { id: 'TDA-<n>', title, area, scope ('console'|'tolkien'), status
//     ('por-aprender'|'reforzando'|'dominado'), priority, tags[], routeId,
//     notes, question, contextoEntradas[], explanation, explainModel,
//     explainedAt, explainFingerprint, explainFiles[], explainVersions[],
//     source, createdAt, updatedAt }
// contextoEntradas[]: "🎙️ Contexto adicional" — LISTA de entradas
// {id 'CX<ts>-<n>', at, source ('ia'|'manual'|'chat'), text}: cada charla
// interpretada por IA (context-shared.js), nota manual o resumen de un chat
// "Profundizar" es una tarjeta propia (no se sobrescriben entre sí). TODAS se
// INYECTAN en el prompt de explicación (ver contextoText).
// Modelo de una ruta: { id: 'RDA-<n>', title, description, status,
//   createdAt, updatedAt } (+ topicCount/doneCount/pct DERIVADOS al leer).
// Modelo de un evento de actividad (SIN CAMBIOS, sigue 100% local):
//   { id, ts, kind, refId, title, detail }
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { hostUser, userDataDir } from '../../core/user-space.js';
import {
  listItems, getItem, createItem, updateItem, deleteItem as padDeleteItem,
  deleteLink, setParent,
} from '../../core/pad-service-client.js';

const TOPICS_COLLECTION = 'temas-de-aprendizaje';
const ROUTES_COLLECTION = 'rutas-de-aprendizaje';

export const STATUSES = ['por-aprender', 'reforzando', 'dominado'];
export const PRIORITIES = ['alta', 'media', 'baja'];
export const SCOPES = ['console', 'tolkien'];
export const ROUTE_STATUSES = ['activa', 'propuesta', 'completada', 'archivada'];
const MAX_ACTIVITY = 300;
const ACTIVITY_LOCK_TIMEOUT_MS = 2000;
const ACTIVITY_LOCK_STALE_MS = 30000;
const ACTIVITY_LOCK_RETRY_MS = 25;
const activityLockWait = new Int32Array(new SharedArrayBuffer(4));
const ROUTE_ID_RE = /^RDA-\d+$/;
const TOPIC_ID_RE = /^TDA-\d+$/;
const topicMutationQueues = new Map();

function ownerFor(ctx = null, owner = null) {
  if (owner) return owner;
  const tenant = String(ctx?.workspace || '').match(/^tenant-(.+)$/);
  return tenant ? tenant[1] : hostUser();
}
export function learningActivityFileFor(owner) {
  return path.join(userDataDir(owner), 'learning-activity.json');
}
function ensureDir(ctx = null, owner = null) {
  fs.mkdirSync(userDataDir(ownerFor(ctx, owner)), { recursive: true, mode: 0o700 });
}

const clampStr = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const normStatus = (s) => (STATUSES.includes(s) ? s : 'por-aprender');
const normPriority = (p) => (PRIORITIES.includes(p) ? p : 'media');
export const normScope = (s) => (SCOPES.includes(s) ? s : 'console');
const normRouteStatus = (s) => (ROUTE_STATUSES.includes(s) ? s : 'activa');
function normTags(t) {
  if (!Array.isArray(t)) return [];
  return t.map((x) => clampStr(x, 40).trim()).filter(Boolean).slice(0, 10);
}

// ===== Helpers de mapeo Pad ⇄ shape del frontend (patrón tasks/store.js) =====
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
// Campo custom tipo `json` (contextoEntradas/explanation): puede llegar ya
// como objeto/array (lo normal) o como string serializado — se normaliza igual.
function parseJsonField(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { const p = JSON.parse(v); return p == null ? fallback : p; } catch { return fallback; }
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
function notFound(entityLabel) {
  const e = new Error(`${entityLabel} inexistente.`);
  e.notFound = true;
  return e;
}
function badInput(message) {
  const e = new Error(message);
  e.badInput = true;
  return e;
}
function requireId(id, re, entityLabel) {
  if (!re.test(String(id))) throw notFound(entityLabel);
}
async function serializeTopicMutation(id, task) {
  const previous = topicMutationQueues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  topicMutationQueues.set(id, current);
  try {
    return await current;
  } finally {
    if (topicMutationQueues.get(id) === current) topicMutationQueues.delete(id);
  }
}
// notFound se marca SOLO ante un 404 real de Pad — cualquier otro fallo (Pad
// caído, timeout, token vencido) es un 500 genérico, nunca un 404 engañoso.
function notFoundOr500(action, entityLabel, r) {
  if (r.status === 404) return notFound(entityLabel);
  return padError(action, r);
}

function topicFromPadItem(item) {
  const f = parseFields(item);
  const exp = parseJsonField(f.explanation, {});
  return {
    id: item.ref,
    title: item.title || 'Tema sin título',
    area: f.area || '',
    scope: normScope(f.scope),
    status: normStatus(f.status),
    priority: normPriority(f.priority),
    tags: parseTagsField(item),
    routeId: item.parent_ref || null,
    notes: item.content || '',
    question: f.question || '',
    contextoEntradas: parseJsonField(f.contextoEntradas, []),
    explanation: exp.text || '',
    explainModel: exp.model || '',
    explainedAt: exp.at || null,
    explainFingerprint: exp.fingerprint || '',
    explainFiles: Array.isArray(exp.files) ? exp.files : [],
    explainVersions: Array.isArray(exp.versions) ? exp.versions : [],
    source: f.source === 'chris' ? 'chris' : 'manual',
    createdAt: tsMs(item.created_at),
    updatedAt: tsMs(item.updated_at),
  };
}

function routeFromPadItem(item) {
  const f = parseFields(item);
  return {
    id: item.ref,
    title: item.title || 'Ruta sin título',
    description: item.content || '',
    status: normRouteStatus(f.status),
    createdAt: tsMs(item.created_at),
    updatedAt: tsMs(item.updated_at),
  };
}

// Temas ya mapeados, usados por listRoutes/createRoute/updateRoute para
// derivar topicCount/doneCount/pct.
async function topicsForProgress(ctx = null) {
  const r = await listItems(TOPICS_COLLECTION, { ctx });
  if (!r.ok) throw padError('topicsForProgress', r);
  return r.data.map(topicFromPadItem);
}

// ===== LOG DE ACTIVIDAD (append-only local, con poda y lock entre procesos) =====
function loadActivity(ctx = null, owner = null) {
  try {
    const raw = JSON.parse(fs.readFileSync(learningActivityFileFor(ownerFor(ctx, owner)), 'utf8'));
    return Array.isArray(raw.events) ? raw.events : [];
  } catch { return []; }
}
function saveActivity(events, ctx = null, owner = null) {
  ensureDir(ctx, owner);
  writeJsonAtomic(learningActivityFileFor(ownerFor(ctx, owner)), { events }); // atómico tmp-por-PID (fix B3 2026-07-11)
}
function acquireActivityLock(file) {
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + ACTIVITY_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      return { fd, lockFile };
    } catch (err) {
      if (err?.code !== 'EEXIST') return null;
    }

    // Un proceso muerto puede dejar el vecino bloqueado: pasados 30 s se
    // considera rancio y se retira antes del siguiente intento.
    try {
      const stat = fs.statSync(lockFile);
      if ((Date.now() - stat.mtimeMs) > ACTIVITY_LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        continue;
      }
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    Atomics.wait(activityLockWait, 0, 0, Math.min(ACTIVITY_LOCK_RETRY_MS, remaining));
  }
}
function releaseActivityLock(lock) {
  let owned = null;
  try {
    owned = fs.fstatSync(lock.fd);
  } catch {}
  try {
    // No borrar un lock nuevo si el nuestro fue reemplazado por considerarse
    // rancio mientras este proceso estuvo suspendido.
    const stat = fs.statSync(lock.lockFile);
    if (owned && stat.dev === owned.dev && stat.ino === owned.ino) fs.unlinkSync(lock.lockFile);
  } catch {}
  try {
    fs.closeSync(lock.fd);
  } catch {}
}
let actCounter = 0;
function appendActivity(ev, ctx = null, owner = null) {
  ensureDir(ctx, owner);
  const file = learningActivityFileFor(ownerFor(ctx, owner));
  actCounter += 1;
  // pid en el id (BUG-29): actCounter es por-proceso; server + runner en el mismo
  // ms generaban el mismo id. El pid lo hace único entre procesos.
  const event = { id: `A${Date.now()}-${process.pid.toString(36)}-${actCounter}`, ts: Date.now(), ...ev };
  const persist = () => {
    const events = loadActivity(ctx, owner);
    events.push(event);
    saveActivity(events.slice(-MAX_ACTIVITY), ctx, owner);
  };
  const lock = acquireActivityLock(file);
  if (!lock) {
    // El log nunca debe romper al caller: tras agotar el lock se intenta una
    // escritura final sin bloqueo, aceptando que siga siendo best-effort.
    try { persist(); } catch {}
    return;
  }
  try {
    persist();
  } finally {
    releaseActivityLock(lock);
  }
}
export function listActivity(limit = 40, owner = hostUser()) {
  return loadActivity(null, owner).slice(-limit).reverse();
}

// ===== RUTAS DE APRENDIZAJE (progreso derivado de sus temas) =====
function routesWithProgress(routes, topics) {
  return routes.map((r) => {
    const own = topics.filter((t) => t.routeId === r.id);
    const doneCount = own.filter((t) => t.status === 'dominado').length;
    const pct = own.length ? Math.round((doneCount / own.length) * 100) : 0;
    return { ...r, topicCount: own.length, doneCount, pct };
  });
}

export async function listRoutes(ctx = null) {
  const [routesR, topics] = await Promise.all([listItems(ROUTES_COLLECTION, { ctx }), topicsForProgress(ctx)]);
  if (!routesR.ok) throw padError('listRoutes', routesR);
  const routes = routesR.data.map(routeFromPadItem);
  const rank = { activa: 0, propuesta: 1, completada: 2, archivada: 3 };
  return routesWithProgress(routes, topics).sort((a, b) =>
    (rank[a.status] - rank[b.status]) || ((b.createdAt || 0) - (a.createdAt || 0)));
}

export async function createRoute(input = {}, ctx = null) {
  const title = clampStr(input.title, 200).trim() || 'Ruta sin título';
  const fields = { status: normRouteStatus(input.status) };
  const r = await createItem(ROUTES_COLLECTION, { title, content: clampStr(input.description, 4000), fields }, { ctx });
  if (!r.ok) throw padError('createRoute', r);
  const ref = r.data.ref;
  appendActivity({ kind: 'created', entity: 'route', refId: ref, title }, ctx);
  const fresh = await getItem(ref, { ctx });
  const route = routeFromPadItem(fresh.ok ? fresh.data : r.data);
  return routesWithProgress([route], await topicsForProgress(ctx))[0];
}

export async function updateRoute(id, patch = {}, ctx = null) {
  requireId(id, ROUTE_ID_RE, 'Ruta');
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('updateRoute', 'Ruta', cur);
  const f = parseFields(cur.data);
  const body = {};
  if (patch.title != null) body.title = clampStr(patch.title, 200).trim() || cur.data.title;
  if (patch.description != null) body.content = clampStr(patch.description, 4000);

  const nextFields = { ...f };
  let statusChanged = null;
  if (patch.status != null) {
    const next = normRouteStatus(patch.status);
    if (next !== normRouteStatus(f.status)) { statusChanged = next; nextFields.status = next; }
  }
  body.fields = nextFields; // SIEMPRE el objeto completo (PATCH de fields reemplaza, no mergea)

  const r = await updateItem(id, body, { ctx });
  if (!r.ok) throw padError('updateRoute', r);

  const fresh = await getItem(id, { ctx });
  appendActivity({ kind: statusChanged ? 'status' : 'updated', entity: 'route', refId: id, title: fresh.data?.title ?? cur.data.title, detail: statusChanged || null }, ctx);
  const route = routeFromPadItem(fresh.ok ? fresh.data : cur.data);
  return routesWithProgress([route], await topicsForProgress(ctx))[0];
}

export async function deleteRoute(id, ctx = null) {
  requireId(id, ROUTE_ID_RE, 'Ruta');
  const cur = await getItem(id, { ctx });
  if (!cur.ok) throw notFoundOr500('deleteRoute', 'Ruta', cur);
  const removed = routeFromPadItem(cur.data);
  // Archivar en Pad (soft-delete): los temas que colgaban de la ruta quedan
  // desasignados solos (verificado en la migración de tasks: `parent_ref`
  // desaparece de un item cuyo padre fue archivado) — no hace falta cascada
  // manual.
  const r = await padDeleteItem(id, { ctx });
  if (!r.ok) throw padError('deleteRoute', r);
  appendActivity({ kind: 'deleted', entity: 'route', refId: id, title: removed.title }, ctx);
  return removed;
}

// ===== TEMAS =====
// Vista pública (ordenada: sin dominar primero por prioridad, luego por fecha)
// + conteos + rutas con progreso (todo lo que la pestaña Aprendizaje necesita).
export async function listTopics(ctx = null) {
  const [topicsR, routesR] = await Promise.all([listItems(TOPICS_COLLECTION, { ctx }), listItems(ROUTES_COLLECTION, { ctx })]);
  if (!topicsR.ok) throw padError('listTopics', topicsR);
  if (!routesR.ok) throw padError('listTopics:routes', routesR);
  const topics = topicsR.data.map(topicFromPadItem);
  const routes = routesR.data.map(routeFromPadItem);

  const prioRank = { alta: 0, media: 1, baja: 2 };
  const statusRank = { 'por-aprender': 0, reforzando: 1, dominado: 2 };
  const sorted = [...topics].sort((a, b) => {
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    if (prioRank[a.priority] !== prioRank[b.priority]) return (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  const counts = { 'por-aprender': 0, reforzando: 0, dominado: 0, total: topics.length };
  for (const t of topics) counts[t.status] = (counts[t.status] || 0) + 1;
  return { topics: sorted, counts, routes: routesWithProgress(routes, topics) };
}

export async function getTopic(id, ctx = null) {
  const r = await getItem(id, { ctx });
  if (!r.ok) {
    const error = notFoundOr500('getTopic', 'Tema', r);
    if (error.notFound) return null;
    throw error;
  }
  return topicFromPadItem(r.data);
}

export async function createTopic(input = {}, ctx = null) {
  const title = clampStr(input.title, 200).trim() || 'Tema sin título';
  const routeCandidate = clampStr(input.routeId, 20).trim();
  if (routeCandidate && !ROUTE_ID_RE.test(routeCandidate)) throw badInput('Ruta inválida.');
  const fields = {
    area: clampStr(input.area, 80),
    scope: normScope(input.scope),
    status: normStatus(input.status),
    priority: normPriority(input.priority),
    question: clampStr(input.question, 1000),
    source: input.source === 'chris' ? 'chris' : 'manual',
    contextoEntradas: [],
    explanation: {},
  };
  const r = await createItem(TOPICS_COLLECTION, {
    title,
    content: clampStr(input.notes, 8000),
    tags: normTags(input.tags),
    fields,
  }, { ctx });
  if (!r.ok) throw padError('createTopic', r);
  const ref = r.data.ref;

  if (routeCandidate) {
    const parentR = await setParent(ref, routeCandidate, { ctx });
    if (!parentR.ok) throw padError('createTopic:setParent', parentR);
  }

  appendActivity({ kind: 'created', refId: ref, title }, ctx);
  const fresh = await getItem(ref, { ctx });
  return topicFromPadItem(fresh.ok ? fresh.data : r.data);
}

export async function updateTopic(id, patch = {}, ctx = null) {
  requireId(id, TOPIC_ID_RE, 'Tema');
  const routeCandidate = patch.routeId == null ? '' : clampStr(patch.routeId, 20).trim();
  if (routeCandidate && !ROUTE_ID_RE.test(routeCandidate)) throw badInput('Ruta inválida.');
  return serializeTopicMutation(id, async () => {
    const cur = await getItem(id, { ctx });
    if (!cur.ok) throw notFoundOr500('updateTopic', 'Tema', cur);
    const f = parseFields(cur.data);
    const body = {};
    if (patch.title != null) body.title = clampStr(patch.title, 200).trim() || cur.data.title;
    if (patch.notes != null) body.content = clampStr(patch.notes, 8000);
    if (patch.tags != null) body.tags = normTags(patch.tags);

    const nextFields = { ...f };
    if (patch.area != null) nextFields.area = clampStr(patch.area, 80);
    if (patch.scope != null) nextFields.scope = normScope(patch.scope);
    if (patch.priority != null) nextFields.priority = normPriority(patch.priority);
    if (patch.question != null) nextFields.question = clampStr(patch.question, 1000);
    // Permite editar/borrar a mano la explicación guardada (material de estudio);
    // preserva el resto de la metadata empaquetada (model/at/fingerprint/files/versions).
    if (patch.explanation != null) {
      const exp = parseJsonField(f.explanation, {});
      nextFields.explanation = { ...exp, text: clampStr(patch.explanation, 40000) };
    }
    let statusChanged = null;
    if (patch.status != null) {
      const next = normStatus(patch.status);
      if (next !== normStatus(f.status)) { statusChanged = next; nextFields.status = next; }
    }
    body.fields = nextFields; // SIEMPRE el objeto completo (PATCH de fields reemplaza, no mergea)

    const r = await updateItem(id, body, { ctx });
    if (!r.ok) throw padError('updateTopic', r);

    if (patch.routeId !== undefined) {
      if (routeCandidate) {
        const parentR = await setParent(id, routeCandidate, { ctx });
        if (!parentR.ok) throw padError('updateTopic:setParent', parentR);
      } else if (cur.data.parent_link_id) {
        const unlinkR = await deleteLink(cur.data.parent_link_id, { ctx });
        if (!unlinkR.ok) throw padError('updateTopic:deleteLink', unlinkR);
      }
    }

    const fresh = await getItem(id, { ctx });
    appendActivity({ kind: statusChanged ? 'status' : 'updated', refId: id, title: fresh.data?.title ?? cur.data.title, detail: statusChanged || null }, ctx);
    return topicFromPadItem(fresh.ok ? fresh.data : cur.data);
  });
}

// AUTO-GUARDA la explicación guiada generada por el runner IA en el tema.
// La llama el runner (proceso aparte) al terminar OK: lee el tema, empaqueta
// {text, model, at, fingerprint, files, versions} en el ÚNICO campo custom
// `explanation` (json) y hace el read-modify-write de `fields`. Antes de
// sobreescribir, empuja la versión VIEJA al historial (cap 5) — así
// "regenerar" nunca pierde lo que ya se tenía. fingerprint/files sostienen la
// regeneración inteligente (ver explain-shared.js checkStaleness).
const MAX_EXPLAIN_VERSIONS = 5;
const MAX_EXPLAIN_FILES = 40;
export async function saveExplanation(id, { explanation, model, scope, fingerprint, files } = {}, ctx = null) {
  requireId(id, TOPIC_ID_RE, 'Tema');
  return serializeTopicMutation(id, async () => {
    const cur = await getItem(id, { ctx });
    if (!cur.ok) throw notFoundOr500('saveExplanation', 'Tema', cur);
    const f = parseFields(cur.data);
    const exp = parseJsonField(f.explanation, {});
    const nextExp = { ...exp };
    if (exp.text) {
      const prevVersions = Array.isArray(exp.versions) ? exp.versions : [];
      nextExp.versions = [
        { explanation: exp.text, model: exp.model || '', at: exp.at || null },
        ...prevVersions,
      ].slice(0, MAX_EXPLAIN_VERSIONS);
    }
    nextExp.text = clampStr(explanation, 40000);
    nextExp.model = clampStr(model, 40);
    nextExp.fingerprint = clampStr(fingerprint, 64);
    nextExp.files = Array.isArray(files) ? files.slice(0, MAX_EXPLAIN_FILES) : [];
    nextExp.at = Date.now();

    const nextFields = { ...f, explanation: nextExp };
    if (scope) nextFields.scope = normScope(scope);
    const r = await updateItem(id, { fields: nextFields }, { ctx });
    if (!r.ok) throw padError('saveExplanation', r);
    appendActivity({ kind: 'explained', refId: id, title: cur.data.title, detail: nextExp.model || null }, ctx);
    const fresh = await getItem(id, { ctx });
    return topicFromPadItem(fresh.ok ? fresh.data : cur.data);
  });
}

// ===== Contexto adicional (LISTA de entradas: charlas IA + notas manuales) =====
const MAX_CONTEXT_ENTRIES = 30;
const CONTEXT_ENTRY_MAX = 20000;
const CONTEXT_SOURCES = ['ia', 'manual', 'chat'];

// Texto plano de TODAS las entradas (para la huella de texto y el prompt de
// explicación). Marca el origen de cada una. Vacío si no hay entradas. PURA
// (sin I/O) — se queda sync, se usa tanto sobre un tema recién leído de Pad
// como sobre el snapshot que viaja en el job del runner.
export function contextoText(topic) {
  const list = (topic && Array.isArray(topic.contextoEntradas)) ? topic.contextoEntradas : [];
  if (!list.length) return '';
  return list.map((e) => {
    const source = e.source === 'ia' ? 'charla interpretada por IA' : (e.source === 'chat' ? 'resumen de chat' : 'nota manual');
    return `[${source}]\n${e.text}`;
  }).join('\n\n');
}

// id de entrada: timestamp + contador de proceso (no hace falta más rigor que
// eso — son ids opacos, el frontend nunca asume su formato, mismo criterio de
// riesgo que los ids del log de actividad `A<ts>-<n>`).
let cxCounter = 0;
// AGREGA una entrada (no sobrescribe). source 'ia' (charla interpretada),
// 'manual' (nota escrita a mano) o 'chat' (resumen de un chat "Profundizar"
// al cerrarlo). Las más nuevas van primero; cap 30.
export async function addContexto(id, { text, source } = {}, ctx = null) {
  requireId(id, TOPIC_ID_RE, 'Tema');
  const clean = clampStr(text, CONTEXT_ENTRY_MAX).trim();
  if (!clean) { const e = new Error('La entrada de contexto está vacía.'); e.badInput = true; throw e; }
  return serializeTopicMutation(id, async () => {
    const cur = await getItem(id, { ctx });
    if (!cur.ok) throw notFoundOr500('addContexto', 'Tema', cur);
    const f = parseFields(cur.data);
    const parsed = parseJsonField(f.contextoEntradas, []);
    const list = Array.isArray(parsed) ? parsed : [];
    cxCounter += 1;
    const entry = { id: `CX${Date.now()}-${process.pid.toString(36)}-${cxCounter}`, at: Date.now(), source: CONTEXT_SOURCES.includes(source) ? source : 'manual', text: clean };
    const nextList = [entry, ...list].slice(0, MAX_CONTEXT_ENTRIES);
    const r = await updateItem(id, { fields: { ...f, contextoEntradas: nextList } }, { ctx });
    if (!r.ok) throw padError('addContexto', r);
    appendActivity({ kind: 'context', refId: id, title: cur.data.title, detail: entry.source }, ctx);
    const fresh = await getItem(id, { ctx });
    return topicFromPadItem(fresh.ok ? fresh.data : cur.data);
  });
}

// AUTO write-back del "💬 Profundizar en chat": al cerrar el chat, el módulo
// chat extrae un resumen determinístico (0 tokens) y lo agrega como entrada
// 'chat' del tema, para que aumente el contexto de la próxima "Regenerar".
// Best-effort: devuelve null si no hay nada útil o si Pad falla (no debe
// romper el cierre del chat).
export async function appendChatContext(id, { summary, files } = {}, ctx = null) {
  requireId(id, TOPIC_ID_RE, 'Tema');
  const parts = [];
  if (summary && String(summary).trim()) parts.push(String(summary).trim());
  if (Array.isArray(files) && files.length) parts.push(`Archivos tocados: ${files.slice(0, 20).join(', ')}`);
  const text = parts.join('\n\n').trim();
  if (!text) return null;
  try { return await addContexto(id, { text, source: 'chat' }, ctx); }
  catch { return null; }
}

export async function updateContextoEntry(id, entryId, text, ctx = null) {
  requireId(id, TOPIC_ID_RE, 'Tema');
  const clean = clampStr(text, CONTEXT_ENTRY_MAX).trim();
  if (!clean) { const e = new Error('La entrada de contexto está vacía.'); e.badInput = true; throw e; }
  return serializeTopicMutation(id, async () => {
    const cur = await getItem(id, { ctx });
    if (!cur.ok) throw notFoundOr500('updateContextoEntry', 'Tema', cur);
    const f = parseFields(cur.data);
    const parsed = parseJsonField(f.contextoEntradas, []);
    const list = Array.isArray(parsed) ? parsed : [];
    if (!list.some((x) => x.id === entryId)) { const e = new Error('Entrada inexistente.'); e.notFound = true; throw e; }
    const nextList = list.map((entry) => (entry.id === entryId ? { ...entry, text: clean, at: Date.now() } : entry));
    const r = await updateItem(id, { fields: { ...f, contextoEntradas: nextList } }, { ctx });
    if (!r.ok) throw padError('updateContextoEntry', r);
    appendActivity({ kind: 'context', refId: id, title: cur.data.title, detail: 'edit' }, ctx);
    const fresh = await getItem(id, { ctx });
    return topicFromPadItem(fresh.ok ? fresh.data : cur.data);
  });
}

export async function deleteContextoEntry(id, entryId, ctx = null) {
  requireId(id, TOPIC_ID_RE, 'Tema');
  return serializeTopicMutation(id, async () => {
    const cur = await getItem(id, { ctx });
    if (!cur.ok) throw notFoundOr500('deleteContextoEntry', 'Tema', cur);
    const f = parseFields(cur.data);
    const parsed = parseJsonField(f.contextoEntradas, []);
    const list = Array.isArray(parsed) ? parsed : [];
    const nextList = list.filter((x) => x.id !== entryId);
    if (nextList.length === list.length) { const e = new Error('Entrada inexistente.'); e.notFound = true; throw e; }
    const r = await updateItem(id, { fields: { ...f, contextoEntradas: nextList } }, { ctx });
    if (!r.ok) throw padError('deleteContextoEntry', r);
    appendActivity({ kind: 'context', refId: id, title: cur.data.title, detail: 'delete' }, ctx);
    const fresh = await getItem(id, { ctx });
    return topicFromPadItem(fresh.ok ? fresh.data : cur.data);
  });
}

export async function deleteTopic(id, ctx = null) {
  requireId(id, TOPIC_ID_RE, 'Tema');
  return serializeTopicMutation(id, async () => {
    const cur = await getItem(id, { ctx });
    if (!cur.ok) throw notFoundOr500('deleteTopic', 'Tema', cur);
    const removed = topicFromPadItem(cur.data);
    const r = await padDeleteItem(id, { ctx });
    if (!r.ok) throw padError('deleteTopic', r);
    appendActivity({ kind: 'deleted', refId: id, title: removed.title }, ctx);
    return removed;
  });
}
