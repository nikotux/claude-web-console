// modules/learning/store.js — MÓDULO DE APRENDIZAJE: registro PRIVADO de los
// TEMAS que el dueño va aprendiendo/reforzando (instrucciones de Chris, cómo
// funciona el backend, GetPad, GitHub, cómo proponer un fix, etc.). Estado
// file-based en ~/.cwc-data/learning.json + learning-activity.json (log
// append-only) → sobrevive reinicios del server SIN runner: el CRUD es síncrono
// y determinístico, escritura atómica tmp+rename (mismo patrón que tasks/store.js
// y el registro de bugfixes).
//
// La ÚNICA parte que consume tokens (y por eso va desacoplada a un runner, ver
// explain-shared.js) es "🎓 Explicame esto": una corrida IA read-only que NAVEGA
// el código real (consola o Tolkien) y redacta una explicación guiada que se
// AUTO-GUARDA en el tema (campo `explanation`) como material de estudio editable.
//
// Modelo de un tema:
//   { id: 'LT<n>', title, area, scope ('console'|'tolkien'), status
//     ('por-aprender'|'reforzando'|'dominado'), priority, tags[], notes,
//     question, contextoAdicional, contextoAt, explanation, explainModel,
//     explainedAt, explainFingerprint, explainFiles[], explainVersions[],
//     source, createdAt, updatedAt }
// contextoEntradas[]: "🎙️ Contexto adicional" — LISTA de entradas
// {id 'CX<n>', at, source ('ia'|'manual'), text}: cada charla interpretada por
// IA (ver context-shared.js) o nota manual es una tarjeta propia (no se
// sobrescriben entre sí). TODAS se INYECTAN en el prompt de explicación. El
// string viejo contextoAdicional/contextoAt se migra a una entrada al leer
// (normalizeTopic). explainFingerprint/explainFiles
// sostienen la REGENERACIÓN INTELIGENTE (ver explain-shared.js checkStaleness):
// huella de texto (notes+question+contextoAdicional) + snapshot de los
// archivos que la IA citó, para saber si conviene adaptar o si ya está al día
// sin gastar tokens. explainVersions guarda el historial (cap 5) de
// explicaciones anteriores para poder "releer lo que ya tenía".
// Modelo de un evento de actividad:
//   { id, ts, kind, refId, title, detail }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const FILE = path.join(DATA_DIR, 'learning.json');
const ACT_FILE = path.join(DATA_DIR, 'learning-activity.json');

export const STATUSES = ['por-aprender', 'reforzando', 'dominado'];
export const PRIORITIES = ['alta', 'media', 'baja'];
export const SCOPES = ['console', 'tolkien'];
export const ROUTE_STATUSES = ['activa', 'propuesta', 'completada', 'archivada'];
const MAX_ACTIVITY = 300;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

// MIGRACIÓN al vuelo: el string único contextoAdicional/contextoAt (versión
// previa del feature) se convierte en UNA entrada de la lista contextoEntradas.
// Idempotente: si ya existe la lista, no toca nada. Se aplica al leer así todos
// los caminos ven la forma nueva sin un paso de migración explícito.
function normalizeTopic(t) {
  if (!Array.isArray(t.contextoEntradas)) {
    t.contextoEntradas = (t.contextoAdicional && String(t.contextoAdicional).trim())
      ? [{ id: 'CX0', at: t.contextoAt || t.updatedAt || Date.now(), source: 'manual', text: t.contextoAdicional }]
      : [];
  }
  // Los campos viejos quedan inertes (no se vuelven a escribir); no los borro
  // para no romper una lectura concurrente de una versión anterior del código.
  return t;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const topics = (Array.isArray(raw.topics) ? raw.topics : []).map(normalizeTopic);
    return {
      seq: Number(raw.seq) || 0,
      routeSeq: Number(raw.routeSeq) || 0,
      cxSeq: Number(raw.cxSeq) || 0,
      topics,
      routes: Array.isArray(raw.routes) ? raw.routes : [],
    };
  } catch {
    return { seq: 0, routeSeq: 0, cxSeq: 0, topics: [], routes: [] };
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
const normStatus = (s) => (STATUSES.includes(s) ? s : 'por-aprender');
const normPriority = (p) => (PRIORITIES.includes(p) ? p : 'media');
export const normScope = (s) => (SCOPES.includes(s) ? s : 'console');
const normRouteStatus = (s) => (ROUTE_STATUSES.includes(s) ? s : 'activa');
function normTags(t) {
  if (!Array.isArray(t)) return [];
  return t.map((x) => clampStr(x, 40).trim()).filter(Boolean).slice(0, 10);
}
// Sólo acepta una routeId que EXISTA (evita temas colgando de una ruta borrada).
function validRouteId(routes, id) {
  const s = id ? clampStr(id, 20) : null;
  if (!s) return null;
  return routes.some((r) => r.id === s) ? s : null;
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
  saveActivity(events.slice(-MAX_ACTIVITY));
}
export function listActivity(limit = 40) {
  return loadActivity().slice(-limit).reverse();
}

// ===== RUTAS DE APRENDIZAJE (progreso derivado de sus temas) =====
// Progreso = temas dominados / total asignados (0 si no tiene temas).
function routesWithProgress(routes, topics) {
  return routes.map((r) => {
    const own = topics.filter((t) => t.routeId === r.id);
    const doneCount = own.filter((t) => t.status === 'dominado').length;
    const pct = own.length ? Math.round((doneCount / own.length) * 100) : 0;
    return { ...r, topicCount: own.length, doneCount, pct };
  });
}

export function listRoutes() {
  const { routes, topics } = load();
  const rank = { activa: 0, propuesta: 1, completada: 2, archivada: 3 };
  return routesWithProgress(routes, topics).sort((a, b) =>
    (rank[a.status] - rank[b.status]) || ((b.createdAt || 0) - (a.createdAt || 0)));
}

export function createRoute(input = {}) {
  const db = load();
  db.routeSeq += 1;
  const now = Date.now();
  const id = `LR${db.routeSeq}`;
  const route = {
    id,
    title: clampStr(input.title, 200).trim() || 'Ruta sin título',
    description: clampStr(input.description, 4000),
    status: normRouteStatus(input.status),
    createdAt: now,
    updatedAt: now,
  };
  db.routes.push(route);
  save(db);
  appendActivity({ kind: 'created', entity: 'route', refId: route.id, title: route.title });
  return routesWithProgress([route], db.topics)[0];
}

export function updateRoute(id, patch = {}) {
  const db = load();
  const r = db.routes.find((x) => x.id === id);
  if (!r) { const e = new Error('Ruta inexistente.'); e.notFound = true; throw e; }
  if (patch.title != null) r.title = clampStr(patch.title, 200).trim() || r.title;
  if (patch.description != null) r.description = clampStr(patch.description, 4000);
  let statusChanged = null;
  if (patch.status != null) {
    const next = normRouteStatus(patch.status);
    if (next !== r.status) { statusChanged = next; r.status = next; }
  }
  r.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: statusChanged ? 'status' : 'updated', entity: 'route', refId: r.id, title: r.title, detail: statusChanged || null });
  return routesWithProgress([r], db.topics)[0];
}

export function deleteRoute(id) {
  const db = load();
  const i = db.routes.findIndex((x) => x.id === id);
  if (i < 0) { const e = new Error('Ruta inexistente.'); e.notFound = true; throw e; }
  const [removed] = db.routes.splice(i, 1);
  // Desasignar (no borrar) los temas que colgaban de la ruta.
  for (const t of db.topics) if (t.routeId === removed.id) t.routeId = null;
  save(db);
  appendActivity({ kind: 'deleted', entity: 'route', refId: removed.id, title: removed.title });
  return removed;
}

// ===== TEMAS =====
// Vista pública ordenada: sin dominar primero (por prioridad), luego por fecha.
// Incluye las rutas con progreso (todo lo que la pestaña Aprendizaje necesita).
export function listTopics() {
  const { topics, routes } = load();
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

export function getTopic(id) {
  return load().topics.find((t) => t.id === id) || null;
}

export function createTopic(input = {}) {
  const db = load();
  db.seq += 1;
  const now = Date.now();
  const id = `LT${db.seq}`;
  const topic = {
    id,
    title: clampStr(input.title, 200).trim() || 'Tema sin título',
    area: clampStr(input.area, 80),
    scope: normScope(input.scope),
    status: normStatus(input.status),
    priority: normPriority(input.priority),
    tags: normTags(input.tags),
    routeId: validRouteId(db.routes, input.routeId),
    notes: clampStr(input.notes, 8000),
    question: clampStr(input.question, 1000),
    contextoEntradas: [],
    explanation: '',
    explainModel: '',
    explainedAt: null,
    explainFingerprint: '',
    explainFiles: [],
    explainVersions: [],
    source: input.source === 'chris' ? 'chris' : 'manual',
    createdAt: now,
    updatedAt: now,
  };
  db.topics.push(topic);
  save(db);
  appendActivity({ kind: 'created', refId: topic.id, title: topic.title });
  return topic;
}

export function updateTopic(id, patch = {}) {
  const db = load();
  const t = db.topics.find((x) => x.id === id);
  if (!t) { const e = new Error('Tema inexistente.'); e.notFound = true; throw e; }
  if (patch.title != null) t.title = clampStr(patch.title, 200).trim() || t.title;
  if (patch.area != null) t.area = clampStr(patch.area, 80);
  if (patch.scope != null) t.scope = normScope(patch.scope);
  if (patch.priority != null) t.priority = normPriority(patch.priority);
  if (patch.tags != null) t.tags = normTags(patch.tags);
  if (patch.routeId !== undefined) t.routeId = validRouteId(db.routes, patch.routeId);
  if (patch.notes != null) t.notes = clampStr(patch.notes, 8000);
  if (patch.question != null) t.question = clampStr(patch.question, 1000);
  // Permite editar/borrar a mano la explicación guardada (material de estudio).
  if (patch.explanation != null) t.explanation = clampStr(patch.explanation, 40000);
  let statusChanged = null;
  if (patch.status != null) {
    const next = normStatus(patch.status);
    if (next !== t.status) { statusChanged = next; t.status = next; }
  }
  t.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: statusChanged ? 'status' : 'updated', refId: t.id, title: t.title, detail: statusChanged || null });
  return t;
}

// AUTO-GUARDA la explicación guiada generada por el runner IA en el tema.
// La llama el runner (proceso aparte) al terminar OK: re-carga, setea, guarda.
// Antes de sobreescribir, empuja la versión VIEJA al historial (cap 5) — así
// "regenerar" nunca pierde lo que ya se tenía. fingerprint/files sostienen la
// regeneración inteligente (ver explain-shared.js checkStaleness).
const MAX_EXPLAIN_VERSIONS = 5;
const MAX_EXPLAIN_FILES = 40;
export function saveExplanation(id, { explanation, model, scope, fingerprint, files } = {}) {
  const db = load();
  const t = db.topics.find((x) => x.id === id);
  if (!t) { const e = new Error('Tema inexistente.'); e.notFound = true; throw e; }
  if (t.explanation) {
    const prevVersions = Array.isArray(t.explainVersions) ? t.explainVersions : [];
    t.explainVersions = [
      { explanation: t.explanation, model: t.explainModel || '', at: t.explainedAt || null },
      ...prevVersions,
    ].slice(0, MAX_EXPLAIN_VERSIONS);
  }
  t.explanation = clampStr(explanation, 40000);
  t.explainModel = clampStr(model, 40);
  t.explainFingerprint = clampStr(fingerprint, 64);
  t.explainFiles = Array.isArray(files) ? files.slice(0, MAX_EXPLAIN_FILES) : [];
  if (scope) t.scope = normScope(scope);
  t.explainedAt = Date.now();
  t.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: 'explained', refId: t.id, title: t.title, detail: t.explainModel || null });
  return t;
}

// ===== Contexto adicional (LISTA de entradas: charlas IA + notas manuales) =====
const MAX_CONTEXT_ENTRIES = 30;
const CONTEXT_ENTRY_MAX = 20000;

// Texto plano de TODAS las entradas (para la huella de texto y el prompt de
// explicación). Marca el origen de cada una. Vacío si no hay entradas.
export function contextoText(topic) {
  const list = (topic && Array.isArray(topic.contextoEntradas)) ? topic.contextoEntradas : [];
  if (!list.length) return '';
  return list.map((e) => `[${e.source === 'ia' ? 'charla interpretada por IA' : 'nota manual'}]\n${e.text}`).join('\n\n');
}

// AGREGA una entrada (no sobrescribe). source 'ia' (charla interpretada),
// 'manual' (nota escrita a mano) o 'chat' (resumen de un chat "Profundizar"
// al cerrarlo). Las más nuevas van primero; cap 30.
const CONTEXT_SOURCES = ['ia', 'manual', 'chat'];
export function addContexto(id, { text, source } = {}) {
  const clean = clampStr(text, CONTEXT_ENTRY_MAX).trim();
  if (!clean) { const e = new Error('La entrada de contexto está vacía.'); e.badInput = true; throw e; }
  const db = load();
  const t = db.topics.find((x) => x.id === id);
  if (!t) { const e = new Error('Tema inexistente.'); e.notFound = true; throw e; }
  db.cxSeq += 1;
  const entry = { id: `CX${db.cxSeq}`, at: Date.now(), source: CONTEXT_SOURCES.includes(source) ? source : 'manual', text: clean };
  t.contextoEntradas = [entry, ...(Array.isArray(t.contextoEntradas) ? t.contextoEntradas : [])].slice(0, MAX_CONTEXT_ENTRIES);
  t.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: 'context', refId: t.id, title: t.title, detail: entry.source });
  return t;
}

// AUTO write-back del "💬 Profundizar en chat": al cerrar el chat, el módulo
// chat extrae un resumen determinístico (0 tokens) y lo agrega como entrada
// 'chat' del tema, para que aumente el contexto de la próxima "Regenerar".
// Best-effort: devuelve null si no hay nada útil (no rompe el cierre del chat).
export function appendChatContext(id, { summary, files } = {}) {
  const parts = [];
  if (summary && String(summary).trim()) parts.push(String(summary).trim());
  if (Array.isArray(files) && files.length) parts.push(`Archivos tocados: ${files.slice(0, 20).join(', ')}`);
  const text = parts.join('\n\n').trim();
  if (!text) return null;
  try { return addContexto(id, { text, source: 'chat' }); }
  catch { return null; }
}

export function updateContextoEntry(id, entryId, text) {
  const clean = clampStr(text, CONTEXT_ENTRY_MAX).trim();
  if (!clean) { const e = new Error('La entrada de contexto está vacía.'); e.badInput = true; throw e; }
  const db = load();
  const t = db.topics.find((x) => x.id === id);
  if (!t) { const e = new Error('Tema inexistente.'); e.notFound = true; throw e; }
  const entry = (t.contextoEntradas || []).find((x) => x.id === entryId);
  if (!entry) { const e = new Error('Entrada inexistente.'); e.notFound = true; throw e; }
  entry.text = clean;
  entry.at = Date.now();
  t.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: 'context', refId: t.id, title: t.title, detail: 'edit' });
  return t;
}

export function deleteContextoEntry(id, entryId) {
  const db = load();
  const t = db.topics.find((x) => x.id === id);
  if (!t) { const e = new Error('Tema inexistente.'); e.notFound = true; throw e; }
  const before = (t.contextoEntradas || []).length;
  t.contextoEntradas = (t.contextoEntradas || []).filter((x) => x.id !== entryId);
  if (t.contextoEntradas.length === before) { const e = new Error('Entrada inexistente.'); e.notFound = true; throw e; }
  t.updatedAt = Date.now();
  save(db);
  appendActivity({ kind: 'context', refId: t.id, title: t.title, detail: 'delete' });
  return t;
}

export function deleteTopic(id) {
  const db = load();
  const i = db.topics.findIndex((x) => x.id === id);
  if (i < 0) { const e = new Error('Tema inexistente.'); e.notFound = true; throw e; }
  const [removed] = db.topics.splice(i, 1);
  save(db);
  appendActivity({ kind: 'deleted', refId: removed.id, title: removed.title });
  return removed;
}
