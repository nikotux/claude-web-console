#!/usr/bin/env node
// bin/cwc-projects-analyze-runner.js — análisis IA de UN cambio de sección de
// contexto (CLAUDE.md), DESACOPLADO del proceso del server (regla de oro: un
// reinicio de la web a mitad NO lo mata porque se spawnea detached+unref).
//
// El endpoint POST /:key/context/section/:i/analyze (modules/projects/index.js)
// solo escribe el job PENDIENTE en ~/.cwc-data/projects-analyze/<id>.json y
// spawnea esto; acá se hace la corrida real (SDK, haiku, 1 turno, CERO
// herramientas — dos capas de denegación, el análisis solo necesita el
// prompt) y se persiste el resultado en el MISMO archivo. El front encuesta
// GET .../analyze/:id hasta que status deja de ser 'running'.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, ANALYZE_TIMEOUT_MS, analyzePrompt, parseAnalysis, readAnalyzeJob, writeAnalyzeJob,
} from '../src/modules/projects/analyze-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = process.argv[2];

async function runAnalysis(before, after) {
  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'El análisis de cambios no usa herramientas.',
    },
  };
  const q = query({
    prompt: analyzePrompt(before, after),
    options: {
      cwd: ROOT,
      settingSources: [], // nada de settings/skills: análisis puro de texto
      model: 'haiku',     // rápido y barato; el criterio viene entero en el prompt
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
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();
  // Si `timeout` gana la carrera, `pump` sigue viva y nadie más la espera; sin
  // este catch, un rechazo tardío se cuela como unhandledRejection.
  pump.catch(() => {});
  try {
    await Promise.race([pump, timeout]);
  } finally {
    clearTimeout(timer);
    try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  const analysis = parseAnalysis(text);
  if (!analysis) throw new Error('No se pudo interpretar el análisis.');
  return analysis;
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  const job = readAnalyzeJob(id);
  if (!job) { log(`job ${id} inexistente (¿se limpió antes de arrancar?).`); process.exit(0); return; }
  try {
    const analysis = await runAnalysis(job.before, job.after);
    writeAnalyzeJob(id, { ...job, status: 'done', analysis, error: null, updatedAt: Date.now() });
    log(`OK job ${id}: riesgo ${analysis.risk}.`);
  } catch (err) {
    writeAnalyzeJob(id, { ...job, status: 'error', analysis: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
