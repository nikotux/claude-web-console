// modules/learning/analyze-shared.js — ANÁLISIS IA del MÓDULO DE APRENDIZAJE
// (botón "🧠 Analizar aprendizaje"). Mira TODOS los temas del Banco de
// conocimiento y devuelve cómo organizarlos: duplicados, unificables, completar
// info, AGRUPAR en RUTAS de aprendizaje, QUÉ APRENDER PRIMERO (orden sugerido) y
// TEMAS NUEVOS que le faltan (gaps).
//
// REGLA DE ORO: consume tokens ⇒ RUNNER DESACOPLADO
// (bin/cwc-learning-analyze-runner.js, detached+unref). El endpoint POST solo
// escribe el job PENDIENTE acá y lo spawnea; el runner persiste el resultado en
// el MISMO archivo. El front encuesta el GET (0 tokens). Mismo patrón que
// tasks/analyze-shared.js.
//
// REGLA 6 (blindaje read-only): a diferencia de "🎓 Explicame esto" (que SÍ lee
// código), este análisis NO usa NINGUNA herramienta — los temas se juntan EN
// NODE y viajan enteros en el prompt; el runner deniega TODO en las dos capas.
//
// Las propuestas NUNCA se auto-aplican: la UI las muestra y el usuario aprueba
// cada una; aplicar reusa el CRUD determinístico de store.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTopics, listRoutes } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const LOG_FILE = path.join(DATA_DIR, 'learning-analyze.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-learning-analyze-runner.js');
const FILE = path.join(DATA_DIR, 'learning-analysis.json');

export const ANALYZE_TIMEOUT_MS = 4 * 60 * 1000;
export const ANALYZE_STALE_MS = ANALYZE_TIMEOUT_MS + 30 * 1000;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
export function readAnalysisJob() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return null; }
}
export function writeAnalysisJob(data) {
  ensureDir();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= ANALYZE_STALE_MS;
}
export function jobResult(job) {
  if (!job) return { status: 'idle', result: null, error: null };
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', result: null, error: 'El análisis no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, result: job.result || null, error: job.error || null };
}
export function spawnLearningAnalyzeRunner() {
  ensureDir();
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

// ===== Contexto determinístico (0 tokens de recolección) =====
// Devuelve { context, count } o null si no hay temas que analizar.
export function buildContext() {
  const { topics } = listTopics();
  if (!topics.length) return null;
  const routes = listRoutes();
  const context = {
    topics: topics.map((t) => ({
      id: t.id,
      title: t.title,
      area: t.area || '',
      scope: t.scope,
      status: t.status,
      priority: t.priority,
      tags: t.tags || [],
      routeId: t.routeId || null,
      hasExplanation: !!t.explanation,
      notes: (t.notes || '').slice(0, 400),
    })),
    routes: routes.map((r) => ({ id: r.id, title: r.title, description: r.description || '', status: r.status, topicCount: r.topicCount })),
  };
  return { context, count: topics.length };
}

export function analyzePrompt(context) {
  return [
    'Sos un MENTOR que organiza el BANCO DE CONOCIMIENTO de un desarrollador para',
    'un aprendizaje asistido. Te paso en JSON: la lista COMPLETA de TEMAS que está',
    'aprendiendo (cada uno con estado por-aprender/reforzando/dominado, área,',
    'alcance console|tolkien, prioridad, tags, si ya tiene explicación, y su',
    'routeId si pertenece a una ruta) y las RUTAS de aprendizaje existentes. Tu',
    'trabajo es dejar todo ORDENADO y sugerir cómo seguir aprendiendo, detectando:',
    '  1. DUPLICADOS: temas que son lo mismo → conservar UNO y quitar el resto.',
    '  2. UNIFICABLES: temas distintos que conviene FUSIONAR en uno.',
    '  3. COMPLETAR: temas con info pobre → sugerí notas/tags mejores.',
    '  4. AGRUPAR EN RUTAS: temas relacionados que forman un camino de estudio →',
    '     agrupalos en una ruta. Si YA existe una ruta adecuada usá su id (routeId);',
    '     si no, proponé una NUEVA con routeId=null + routeTitle.',
    '  5. APRENDER PRIMERO: dado lo que sabe y lo que falta, ordená los temas por',
    '     qué conviene estudiar ANTES (dependencias, fundamentos primero).',
    '  6. TEMAS NUEVOS: gaps de conocimiento que le faltan y debería sumar (temas',
    '     que NO están en la lista pero son necesarios para lo que estudia).',
    'Respondé en ESPAÑOL y ÚNICAMENTE con un bloque ```json con esta forma EXACTA:',
    '{',
    '  "resumen": "1-2 líneas: cómo está el banco y cómo quedaría ordenado",',
    '  "duplicados": [ { "keep": "LT<n>", "remove": ["LT<n>"], "why": "por qué son el mismo" } ],',
    '  "unificables": [ { "ids": ["LT<n>","LT<n>"], "title": "título fusionado", "notes": "notas fusionadas", "why": "por qué unir" } ],',
    '  "completar": [ { "id": "LT<n>", "notes": "notas más completas sugeridas", "tags": ["tags"], "why": "qué le falta" } ],',
    '  "agrupar": [ { "routeId": "LR<n> o null", "routeTitle": "título si es ruta nueva", "routeDescription": "detalle", "topicIds": ["LT<n>","LT<n>"], "why": "qué las une" } ],',
    '  "aprenderPrimero": [ { "orderedIds": ["LT<n>","LT<n>"], "why": "por qué en ese orden" } ],',
    '  "sugerirNuevos": [ { "title": "tema nuevo", "area": "área", "scope": "console|tolkien", "why": "por qué te falta" } ]',
    '}',
    'Reglas: los ids de tema son LT<n> y los de ruta LR<n>. NO inventes ids: usá',
    'SOLO los que aparecen en los datos (excepto en sugerirNuevos y en rutas nuevas,',
    'donde no hay id todavía). Sé CONSERVADOR con duplicados/unificables (ante la',
    'duda, no los incluyas). NO elimines nada sin dejar un reemplazo (keep). Si una',
    'categoría no tiene nada, devolvé su array vacío. Sé específico y conciso.',
    '',
    '=== DATOS (JSON) ===',
    JSON.stringify(context),
  ].join('\n');
}

// ===== Parseo defensivo =====
const clamp = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const LT_RE = /^LT\d+$/;
const LR_RE = /^LR\d+$/;
const SCOPES = ['console', 'tolkien'];
const cleanLt = (x) => { const s = clamp(x, 20).trim(); return LT_RE.test(s) ? s : null; };
const arr = (x, n, mapFn) => (Array.isArray(x) ? x.slice(0, n).map(mapFn).filter(Boolean) : []);
const dedupeLt = (list) => [...new Set((Array.isArray(list) ? list : []).map(cleanLt).filter(Boolean))];

export function parseAnalysis(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  return {
    resumen: clamp(o.resumen, 600),
    duplicados: arr(o.duplicados, 50, (d) => {
      const keep = cleanLt(d?.keep);
      const remove = dedupeLt(d?.remove).filter((x) => x !== keep);
      if (!keep || !remove.length) return null;
      return { keep, remove, why: clamp(d?.why, 400) };
    }),
    unificables: arr(o.unificables, 50, (u) => {
      const ids = dedupeLt(u?.ids);
      if (ids.length < 2) return null;
      return { ids, title: clamp(u?.title, 200).trim(), notes: clamp(u?.notes, 4000), why: clamp(u?.why, 400) };
    }),
    completar: arr(o.completar, 80, (c) => {
      const id = cleanLt(c?.id);
      if (!id) return null;
      return {
        id,
        notes: clamp(c?.notes, 4000),
        tags: Array.isArray(c?.tags) ? c.tags.map((x) => clamp(x, 40).trim()).filter(Boolean).slice(0, 8) : [],
        why: clamp(c?.why, 400),
      };
    }),
    agrupar: arr(o.agrupar, 30, (g) => {
      const topicIds = dedupeLt(g?.topicIds);
      if (!topicIds.length) return null;
      const rawRoute = clamp(g?.routeId, 20).trim();
      const routeId = LR_RE.test(rawRoute) ? rawRoute : null;
      const routeTitle = clamp(g?.routeTitle, 200).trim();
      if (!routeId && !routeTitle) return null;
      return { routeId, routeTitle, routeDescription: clamp(g?.routeDescription, 2000), topicIds, why: clamp(g?.why, 400) };
    }),
    aprenderPrimero: arr(o.aprenderPrimero, 10, (a) => {
      const orderedIds = dedupeLt(a?.orderedIds);
      if (orderedIds.length < 2) return null;
      return { orderedIds, why: clamp(a?.why, 400) };
    }),
    sugerirNuevos: arr(o.sugerirNuevos, 30, (s) => {
      const title = clamp(s?.title, 200).trim();
      if (!title) return null;
      return { title, area: clamp(s?.area, 80), scope: SCOPES.includes(s?.scope) ? s.scope : 'console', why: clamp(s?.why, 400) };
    }),
  };
}
