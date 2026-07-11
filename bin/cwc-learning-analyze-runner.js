#!/usr/bin/env node
// bin/cwc-learning-analyze-runner.js — ANÁLISIS IA del MÓDULO DE APRENDIZAJE
// (botón "🧠 Analizar aprendizaje"), DESACOPLADO del server (regla de oro:
// detached+unref, un reinicio de la web a mitad NO lo mata).
//
// El endpoint POST /api/learning/analyze escribe el job PENDIENTE en
// ~/.cwc-data/learning-analysis.json y spawnea esto; acá se junta el contexto EN
// NODE (todos los temas + rutas) y se hace la corrida real (SDK, sonnet, 1 turno,
// CERO herramientas — dos capas de denegación, regla 6: los datos viajan enteros
// en el prompt). El resultado se persiste en el MISMO archivo. El front encuesta
// GET /api/learning/analysis. Mismo patrón que bin/cwc-tasks-analyze-runner.js.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, ANALYZE_TIMEOUT_MS, buildContext, analyzePrompt, parseAnalysis,
  readAnalysisJob, writeAnalysisJob,
} from '../src/modules/learning/analyze-shared.js';
import { registerLearningSession } from '../src/modules/learning/session-log.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function runAnalysis(context) {
  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'El análisis de aprendizaje no usa herramientas.',
    },
  };
  const q = query({
    prompt: analyzePrompt(context),
    options: {
      cwd: ROOT,
      settingSources: [],
      model: 'sonnet',
      maxTurns: 1,
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [async () => deny] }] },
      canUseTool: async () => ({ behavior: 'deny', message: 'Sin herramientas.' }),
    },
  });
  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('El análisis tardó demasiado.')), ANALYZE_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      // Registra el session_id de ESTA corrida (system/init) para que el panel
      // de Uso la atribuya al bucket 'aprendizaje', no a 'consola' (mismo cwd).
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) registerLearningSession(m.session_id);
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); } finally {
    clearTimeout(timer);
    try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  const result = parseAnalysis(text);
  if (!result) throw new Error('No se pudo interpretar la respuesta del análisis.');
  return result;
}

async function main() {
  const job = readAnalysisJob();
  if (!job) { log('job de análisis inexistente.'); process.exit(0); return; }
  try {
    const built = buildContext();
    if (!built) throw new Error('No hay temas para analizar.');
    const result = await runAnalysis(built.context);
    writeAnalysisJob({ ...job, status: 'done', result, error: null, updatedAt: Date.now() });
    log(`OK análisis: ${result.duplicados.length} dup · ${result.unificables.length} unif · ${result.completar.length} completar · ${result.agrupar.length} rutas · ${result.sugerirNuevos.length} nuevos`);
  } catch (err) {
    writeAnalysisJob({ ...job, status: 'error', result: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log('FAIL análisis:', err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
