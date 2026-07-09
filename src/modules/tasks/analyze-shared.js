// modules/tasks/analyze-shared.js — persistencia + prompt del ANÁLISIS GENERAL
// IA del tablero de Pendientes (botón "🧠 Análisis general"). Dos alcances:
//   scope='tasks' → revisa TODAS las tareas: cuáles están DUPLICADAS, cuáles se
//     pueden UNIFICAR y cuáles tienen INFO FALTANTE que se completa con los
//     INFORMES de audio ya procesados.
//   scope='plans' → lo mismo sobre los PLANES (unir/duplicar/completar).
//
// REGLA DE ORO: consume tokens y puede tardar ⇒ RUNNER DESACOPLADO
// (bin/cwc-tasks-analyze-runner.js, detached+unref). El endpoint POST solo
// escribe el job PENDIENTE acá y lo spawnea; el runner persiste el resultado en
// el MISMO archivo (por alcance). El front encuesta el GET (0 tokens). Mismo
// patrón que audio/shared.js.
//
// REGLA 6 (blindaje read-only): el análisis NO usa NINGUNA herramienta — los
// datos (tareas + planes + informes) se juntan EN NODE (determinístico) y viajan
// enteros en el prompt; el runner deniega TODO en las dos capas. NUNCA escribe
// código ni lee disco fuera de lo que le pasa el server.
//
// Las propuestas NUNCA se auto-aplican: la UI las muestra y el usuario aprueba
// cada una; aplicar reusa el CRUD determinístico de store.js (delete/update).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTasks, listPlans } from './store.js';
import { listAudioJobs, readAudioJob } from '../audio/shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo (cwd del SDK)

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const LOG_FILE = path.join(DATA_DIR, 'tasks-analyze.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-tasks-analyze-runner.js');

export const SCOPES = ['tasks', 'plans'];
export const ANALYZE_TIMEOUT_MS = 4 * 60 * 1000;
export const ANALYZE_STALE_MS = ANALYZE_TIMEOUT_MS + 30 * 1000;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
export function normScope(s) {
  return SCOPES.includes(s) ? s : 'tasks';
}
function jobPath(scope) {
  return path.join(DATA_DIR, `tasks-analysis-${normScope(scope)}.json`);
}

export function readAnalysisJob(scope) {
  try { return JSON.parse(fs.readFileSync(jobPath(scope), 'utf8')); }
  catch { return null; }
}
export function writeAnalysisJob(scope, data) {
  ensureDir();
  const tmp = `${jobPath(scope)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, jobPath(scope));
}

export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= ANALYZE_STALE_MS;
}
// Estado EFECTIVO: un 'running' pasado el corte se reporta error (runner muerto).
export function jobResult(job) {
  if (!job) return { status: 'idle', result: null, error: null };
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', result: null, error: 'El análisis no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, result: job.result || null, error: job.error || null };
}

export function spawnTasksAnalyzeRunner(scope) {
  ensureDir();
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER, normScope(scope)], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

// ===== Contexto determinístico que va en el prompt (0 tokens de recolección) =====
// Junta los informes de audio con su detalle (summary + tareas propuestas + plan)
// para que el modelo pueda COMPLETAR info faltante de las tareas.
function reportsContext() {
  const out = [];
  for (const j of listAudioJobs()) {
    const job = readAudioJob(j.id);
    const r = job?.result;
    if (!r) continue;
    out.push({
      title: j.title || '(sin título)',
      summary: r.summary || '',
      proposedTasks: (r.proposedTasks || []).map((t) => ({ title: t.title, description: t.description || '' })),
      plan: (r.plan || []).map((p) => p.step).filter(Boolean),
    });
  }
  return out;
}

// Devuelve { context, count } para el alcance dado (o null si no hay nada que analizar).
export function buildContext(scope) {
  const s = normScope(scope);
  if (s === 'plans') {
    const { tasks } = listTasks();
    const plans = listPlans();
    if (!plans.length) return null;
    const items = plans.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description || '',
      status: p.status,
      tasks: tasks.filter((t) => t.planId === p.id).map((t) => t.title),
    }));
    return { context: { plans: items, reports: reportsContext() }, count: plans.length };
  }
  const { tasks } = listTasks();
  if (!tasks.length) return null;
  const items = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description || '',
    type: t.type,
    priority: t.priority,
    status: t.status,
    tags: t.tags || [],
    planId: t.planId || null,
  }));
  return { context: { tasks: items, reports: reportsContext() }, count: tasks.length };
}

export function analyzePrompt(scope, context) {
  const s = normScope(scope);
  const entity = s === 'plans' ? 'PLANES' : 'TAREAS';
  const idNote = s === 'plans'
    ? 'Los ids son de la forma PLAN-<n>. NO inventes ids: usá SOLO los que aparecen en los datos.'
    : 'Los ids son de la forma T<n>. NO inventes ids: usá SOLO los que aparecen en los datos.';
  return [
    `Sos un asistente que ordena un tablero de ${entity} pendientes. Te paso en`,
    `JSON la lista COMPLETA de ${entity.toLowerCase()} y los INFORMES de audio ya`,
    'procesados (con su resumen, tareas propuestas y plan). Tu trabajo es detectar:',
    `  1. DUPLICADOS: ${entity.toLowerCase()} que son lo mismo (mismo objetivo real,`,
    '     aunque el texto difiera) → sugerí conservar UNO y quitar el resto.',
    `  2. UNIFICABLES: ${entity.toLowerCase()} distintos pero que conviene FUSIONAR en`,
    '     uno solo (parte de la misma cosa) → sugerí un título y detalle fusionados.',
    '  3. COMPLETAR: elementos con info faltante/pobre que se puede enriquecer con el',
    '     contexto de los INFORMES → sugerí un detalle (y tags) mejor.',
    'Respondé en ESPAÑOL y ÚNICAMENTE con un bloque ```json con esta forma EXACTA:',
    '{',
    '  "resumen": "1-2 líneas: qué encontraste en general",',
    '  "duplicados": [',
    '    { "keep": "<id a conservar>", "remove": ["<id a eliminar>"], "why": "por qué son el mismo" }',
    '  ],',
    '  "unificables": [',
    '    { "ids": ["<id>","<id>"], "title": "título fusionado", "description": "detalle fusionado", "why": "por qué unir" }',
    '  ],',
    '  "completar": [',
    '    { "id": "<id>", "description": "detalle sugerido más completo",',
    s === 'plans' ? '      "why": "de qué informe/idea sale" }' : '      "tags": ["tags sugeridos"], "why": "de qué informe sale" }',
    '  ]',
    '}',
    `Reglas: ${idNote} Sé CONSERVADOR: solo marcá duplicados/unificables si estás`,
    'razonablemente seguro (ante la duda, no lo incluyas). Si una categoría no tiene',
    'nada, devolvé su array vacío. NO propongas eliminar algo sin dejar un reemplazo',
    '(keep). Sé específico y conciso.',
    '',
    '=== DATOS (JSON) ===',
    JSON.stringify(context),
  ].join('\n');
}

// ===== Parseo defensivo del JSON de la respuesta =====
const clamp = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const ID_RE = /^(T\d+|PLAN-\d+)$/;
const cleanId = (x) => { const s = clamp(x, 20).trim(); return ID_RE.test(s) ? s : null; };
const arr = (x, n, mapFn) => (Array.isArray(x) ? x.slice(0, n).map(mapFn).filter(Boolean) : []);

export function parseAnalysis(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const dedupeIds = (list) => [...new Set(list.map(cleanId).filter(Boolean))];
  return {
    resumen: clamp(o.resumen, 600),
    duplicados: arr(o.duplicados, 50, (d) => {
      const keep = cleanId(d?.keep);
      const remove = dedupeIds(Array.isArray(d?.remove) ? d.remove : []).filter((x) => x !== keep);
      if (!keep || !remove.length) return null;
      return { keep, remove, why: clamp(d?.why, 400) };
    }),
    unificables: arr(o.unificables, 50, (u) => {
      const ids = dedupeIds(Array.isArray(u?.ids) ? u.ids : []);
      if (ids.length < 2) return null;
      return { ids, title: clamp(u?.title, 200).trim(), description: clamp(u?.description, 2000), why: clamp(u?.why, 400) };
    }),
    completar: arr(o.completar, 80, (c) => {
      const id = cleanId(c?.id);
      if (!id) return null;
      return {
        id,
        description: clamp(c?.description, 2000),
        tags: Array.isArray(c?.tags) ? c.tags.map((x) => clamp(x, 40).trim()).filter(Boolean).slice(0, 8) : [],
        why: clamp(c?.why, 400),
      };
    }),
  };
}
