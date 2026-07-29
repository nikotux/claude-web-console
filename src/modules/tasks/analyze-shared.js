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
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTasks, listPlans } from './store.js';
import { listAudioJobs, readAudioJob } from '../audio/shared.js';
import { listTopics as listLearningTopics } from '../learning/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo (cwd del SDK)

const RUNNER = path.join(ROOT, 'bin', 'cwc-tasks-analyze-runner.js');

export const SCOPES = ['tasks', 'plans', 'global'];
export const ANALYZE_TIMEOUT_MS = 4 * 60 * 1000;
export const ANALYZE_STALE_MS = ANALYZE_TIMEOUT_MS + 30 * 1000;

function ensureDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
function logFile(dataDir) {
  return path.join(dataDir, 'tasks-analyze.log');
}
export function normScope(s) {
  return SCOPES.includes(s) ? s : 'tasks';
}
function jobPath(dataDir, scope) {
  return path.join(dataDir, `tasks-analysis-${normScope(scope)}.json`);
}

export function readAnalysisJob(dataDir, scope) {
  try { return JSON.parse(fs.readFileSync(jobPath(dataDir, scope), 'utf8')); }
  catch { return null; }
}
export function writeAnalysisJob(dataDir, scope, data) {
  ensureDir(dataDir);
  // atómico tmp-por-PID (fix B4 2026-07-11): lo escriben DOS procesos (server → 'running',
  // runner → 'done'/'error') — el tmp de nombre fijo podía colisionar en el respawn por stale.
  writeJsonAtomic(jobPath(dataDir, scope), data);
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

export function spawnTasksAnalyzeRunner(dataDir, scope, env) {
  ensureDir(dataDir);
  const logFd = fs.openSync(logFile(dataDir), 'a');
  const child = spawn(process.execPath, [RUNNER, normScope(scope), '--data-dir', dataDir], {
    detached: true, stdio: ['ignore', logFd, logFd], env: env ?? process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

// ===== Contexto determinístico que va en el prompt (0 tokens de recolección) =====
// Junta los informes de audio con su detalle (summary + tareas propuestas + plan)
// para que el modelo pueda COMPLETAR info faltante de las tareas.
function reportsContext(dataDir) {
  const out = [];
  for (const j of listAudioJobs(dataDir)) {
    const job = readAudioJob(dataDir, j.id);
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

// Mapea las tareas a lo esencial para el prompt (id/título/detalle/tipo/etc.).
function tasksBrief(tasks) {
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description || '',
    type: t.type,
    priority: t.priority,
    status: t.status,
    tags: t.tags || [],
    planId: t.planId || null,
  }));
}
// Mapea los planes con los títulos+ids de sus tareas ya asignadas.
function plansBrief(plans, tasks) {
  return plans.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description || '',
    status: p.status,
    tasks: tasks.filter((t) => t.planId === p.id).map((t) => ({ id: t.id, title: t.title })),
  }));
}

// Devuelve { context, count } para el alcance dado (o null si no hay nada que
// analizar). ASYNC desde la migración a Pad local (2026-07-12): listTasks()/
// listPlans() de store.js ahora son promesas (llaman al Pad local por HTTP) —
// este es el SEGUNDO consumidor directo de store.js además de tasks/index.js
// (detectado durante la migración; sus dos call sites — el endpoint POST
// /analyze y bin/cwc-tasks-analyze-runner.js — ya lo esperan con await).
export async function buildContext(dataDir, scope) {
  const s = normScope(scope);
  if (s === 'global') {
    // Vista HOLÍSTICA: tareas + planes + informes juntos, para reorganizar todo
    // (agrupar en planes, unificar, completar, crear las tareas de informes que
    // todavía no se cargaron). El modelo ve qué tareas ya tienen plan y cuáles no.
    const { tasks } = await listTasks();
    const plans = await listPlans();
    const reports = reportsContext(dataDir);
    // Temas del Banco de conocimiento YA existentes: para NO duplicarlos al
    // sugerir temas nuevos derivados del trabajo pendiente (puente Pendientes → Aprendizaje).
    let learningTopics = [];
    try { learningTopics = (await listLearningTopics()).topics.map((t) => ({ title: t.title, area: t.area || '', status: t.status })); }
    catch { /* módulo learning ausente o Pad caído: no rompe el análisis */ }
    if (!tasks.length && !plans.length && !reports.length) return null;
    return {
      context: { tasks: tasksBrief(tasks), plans: plansBrief(plans, tasks), reports, learningTopics },
      count: tasks.length + plans.length,
    };
  }
  if (s === 'plans') {
    const { tasks } = await listTasks();
    const plans = await listPlans();
    if (!plans.length) return null;
    const items = plans.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description || '',
      status: p.status,
      tasks: tasks.filter((t) => t.planId === p.id).map((t) => t.title),
    }));
    return { context: { plans: items, reports: reportsContext(dataDir) }, count: plans.length };
  }
  const { tasks } = await listTasks();
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
  return { context: { tasks: items, reports: reportsContext(dataDir) }, count: tasks.length };
}

// Prompt HOLÍSTICO (scope 'global'): reorganiza tareas + planes + informes.
function globalPrompt(context) {
  return [
    'Sos un asistente que REORGANIZA un tablero de tareas pendientes. Te paso en',
    'JSON: la lista COMPLETA de TAREAS (cada una con su planId si ya pertenece a un',
    'plan, o null si está suelta), la lista de PLANES (con las tareas que ya tienen',
    'asignadas), los INFORMES de audio ya procesados (con su resumen, tareas',
    'propuestas y plan) y los TEMAS de aprendizaje que el dueño YA está estudiando',
    '(learningTopics). Tu trabajo es dejar TODO ordenado, detectando:',
    '  1. DUPLICADOS: tareas que son lo mismo → conservar UNA y quitar el resto.',
    '  2. UNIFICABLES: tareas distintas que conviene FUSIONAR en una sola.',
    '  3. COMPLETAR: tareas con info pobre que se enriquece con los INFORMES.',
    '  4. AGRUPAR: tareas SUELTAS (o mal ubicadas) que son parte de un mismo',
    '     esfuerzo → agrupalas en un plan. Si YA existe un plan adecuado, usá su id',
    '     (planId). Si NO existe, proponé uno NUEVO con planId=null + un planTitle.',
    '  5. CREAR-DESDE-INFORME: tareas propuestas en un INFORME que TODAVÍA no',
    '     figuran en la lista de tareas (compará por objetivo real, no texto exacto)',
    '     → crealas. NO repitas una tarea que ya existe.',
    '  6. APRENDER (puente al Banco de conocimiento): mirá QUÉ se está trabajando en',
    '     las tareas/planes/informes y sugerí TEMAS DE APRENDIZAJE nuevos que el',
    '     dueño debería estudiar para hacerlo mejor (resolver, exponer PRs,',
    '     implementar). SOLO temas que NO estén ya en learningTopics (compará por',
    '     objetivo real). scope="tolkien" si es sobre el producto de la empresa,',
    '     "console" si es sobre esta consola.',
    'Respondé en ESPAÑOL y ÚNICAMENTE con un bloque ```json con esta forma EXACTA:',
    '{',
    '  "resumen": "1-2 líneas: qué encontraste y cómo quedaría ordenado",',
    '  "duplicados": [ { "keep": "PEND-<n>", "remove": ["PEND-<n>"], "why": "por qué son el mismo" } ],',
    '  "unificables": [ { "ids": ["PEND-<n>","PEND-<n>"], "title": "título fusionado", "description": "detalle fusionado", "why": "por qué unir" } ],',
    '  "completar": [ { "id": "PEND-<n>", "description": "detalle sugerido más completo", "tags": ["tags"], "why": "de qué informe sale" } ],',
    '  "agrupar": [ { "planId": "PLAN-<n> o null", "planTitle": "título si es plan nuevo", "planDescription": "detalle del plan nuevo", "taskIds": ["PEND-<n>","PEND-<n>"], "why": "qué las une" } ],',
    '  "crearTareas": [ { "fromReport": "título del informe", "tasks": [ { "title": "título", "description": "detalle", "priority": "alta|media|baja", "type": "task" } ], "why": "por qué falta" } ],',
    '  "crearTemas": [ { "title": "tema de aprendizaje", "area": "área", "scope": "console|tolkien", "why": "de qué tarea/plan sale y para qué te sirve" } ]',
    '}',
    'Reglas: los ids de tarea son PEND-<n> y los de plan PLAN-<n>. NO inventes ids: usá',
    'SOLO los que aparecen en los datos (excepto en crearTareas y en planes nuevos,',
    'donde no hay id todavía). Sé CONSERVADOR: solo marcá duplicados/unificables si',
    'estás razonablemente seguro (ante la duda, no lo incluyas). NO propongas',
    'eliminar algo sin dejar un reemplazo (keep). Si una categoría no tiene nada,',
    'devolvé su array vacío. Sé específico y conciso.',
    '',
    '=== DATOS (JSON) ===',
    JSON.stringify(context),
  ].join('\n');
}

export function analyzePrompt(scope, context) {
  const s = normScope(scope);
  if (s === 'global') return globalPrompt(context);
  const entity = s === 'plans' ? 'PLANES' : 'TAREAS';
  const idNote = s === 'plans'
    ? 'Los ids son de la forma PLAN-<n>. NO inventes ids: usá SOLO los que aparecen en los datos.'
    : 'Los ids son de la forma PEND-<n>. NO inventes ids: usá SOLO los que aparecen en los datos.';
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
const ID_RE = /^(PEND-\d+|PLAN-\d+)$/;
const TASK_ID_RE = /^PEND-\d+$/;
const PLAN_ID_RE = /^PLAN-\d+$/;
const PRIOS = ['alta', 'media', 'baja'];
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
    // ---- Solo scope 'global' los completa; en tasks/plans quedan vacíos ----
    // AGRUPAR: tareas sueltas → plan existente (planId) o nuevo (planTitle).
    agrupar: arr(o.agrupar, 30, (g) => {
      const taskIds = [...new Set((Array.isArray(g?.taskIds) ? g.taskIds : []).map((x) => clamp(x, 20).trim()).filter((s) => TASK_ID_RE.test(s)))];
      if (!taskIds.length) return null;
      const rawPlan = clamp(g?.planId, 20).trim();
      const planId = PLAN_ID_RE.test(rawPlan) ? rawPlan : null;
      const planTitle = clamp(g?.planTitle, 200).trim();
      if (!planId && !planTitle) return null; // plan nuevo sin título = descartar
      return { planId, planTitle, planDescription: clamp(g?.planDescription, 2000), taskIds, why: clamp(g?.why, 400) };
    }),
    // CREAR-DESDE-INFORME: tareas propuestas por informes aún no cargadas.
    crearTareas: arr(o.crearTareas, 30, (c) => {
      const tasks = arr(c?.tasks, 20, (t) => {
        const title = clamp(t?.title, 200).trim();
        if (!title) return null;
        return {
          title,
          description: clamp(t?.description, 2000),
          priority: PRIOS.includes(t?.priority) ? t.priority : 'media',
          type: clamp(t?.type, 20).trim() || 'task',
        };
      });
      if (!tasks.length) return null;
      return { fromReport: clamp(c?.fromReport, 200).trim(), tasks, why: clamp(c?.why, 400) };
    }),
    // CREAR-TEMA-DE-APRENDIZAJE (puente Pendientes → Banco): temas nuevos que
    // convendría estudiar según lo que se está trabajando. Solo scope 'global'.
    crearTemas: arr(o.crearTemas, 30, (t) => {
      const title = clamp(t?.title, 200).trim();
      if (!title) return null;
      return { title, area: clamp(t?.area, 80), scope: t?.scope === 'tolkien' ? 'tolkien' : 'console', why: clamp(t?.why, 400) };
    }),
  };
}
