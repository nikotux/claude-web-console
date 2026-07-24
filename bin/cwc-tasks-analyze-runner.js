#!/usr/bin/env node
// bin/cwc-tasks-analyze-runner.js — ANÁLISIS GENERAL IA del tablero de
// Pendientes, DESACOPLADO del server (regla de oro: detached+unref, un reinicio
// de la web a mitad NO lo mata).
//
// El endpoint POST /api/tasks/analyze (modules/tasks/index.js) escribe el job
// PENDIENTE en ~/.cwc-data/tasks-analysis-<scope>.json y spawnea esto con el
// alcance ('tasks' | 'plans'); acá se junta el contexto EN NODE (tareas/planes +
// informes) y se hace la corrida real (SDK, sonnet, 1 turno, CERO herramientas —
// dos capas de denegación, regla 6: los datos viajan enteros en el prompt). El
// resultado se persiste en el MISMO archivo. El front encuesta GET
// /api/tasks/analysis?scope=... hasta que status deja de ser 'running'. Mismo
// patrón que bin/cwc-audio-runner.js.
import { textOnlyQuery } from '../src/core/text-only-query.js';
import {
  ROOT, ANALYZE_TIMEOUT_MS, normScope, buildContext, analyzePrompt, parseAnalysis,
  readAnalysisJob, writeAnalysisJob,
} from '../src/modules/tasks/analyze-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const scope = normScope(process.argv[2]);

async function runAnalysis(context) {
  const text = await textOnlyQuery(analyzePrompt(scope, context), {
    cwd: ROOT,
    model: 'sonnet',
    maxTurns: 1,
    timeoutMs: ANALYZE_TIMEOUT_MS,
    denyReason: 'El análisis general no usa herramientas.',
    timeoutMessage: 'El análisis tardó demasiado.',
  });
  const result = parseAnalysis(text);
  if (!result) throw new Error('No se pudo interpretar la respuesta del análisis.');
  return result;
}

async function main() {
  const job = readAnalysisJob(scope);
  if (!job) { log(`job de análisis (${scope}) inexistente.`); process.exit(0); return; }
  try {
    const built = await buildContext(scope);
    if (!built) throw new Error('No hay datos para analizar.');
    const result = await runAnalysis(built.context);
    writeAnalysisJob(scope, { ...job, status: 'done', result, error: null, updatedAt: Date.now() });
    log(`OK análisis ${scope}: ${result.duplicados.length} dup · ${result.unificables.length} unif · ${result.completar.length} completar · ${result.agrupar.length} agrupar · ${result.crearTareas.length} crear`);
  } catch (err) {
    writeAnalysisJob(scope, { ...job, status: 'error', result: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL análisis ${scope}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
