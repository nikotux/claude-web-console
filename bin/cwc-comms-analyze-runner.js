#!/usr/bin/env node
// bin/cwc-comms-analyze-runner.js — ANÁLISIS IA de UN hilo de comunicaciones,
// DESACOPLADO (regla de oro: detached+unref, un reinicio de la web NO lo mata).
// El POST /thread/:id/analyze escribe el job pendiente y spawnea esto; acá se
// hace la corrida SDK (haiku, 1 turno, CERO herramientas — dos capas de
// denegación, regla 6: solo resume el texto del hilo) y se persiste el
// resultado en el MISMO archivo. El front encuesta GET hasta que status deja de
// ser 'running'. Clon de bin/cwc-projects-analyze-runner.js.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, ANALYZE_TIMEOUT_MS, analyzePrompt, parseAnalysis, readAnalyzeJob, writeAnalyzeJob,
} from '../src/modules/comms/analyze-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = process.argv[2];

async function runAnalysis(text, contactName) {
  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'El análisis de hilo no usa herramientas.',
    },
  };
  const q = query({
    prompt: analyzePrompt(text, contactName),
    options: {
      cwd: ROOT,
      settingSources: [],
      model: 'haiku',
      effort: 'low',      // clasificador mecánico de 1 turno (F5(a) PEND-405, mismo criterio que chat/index.js)
      maxTurns: 1,
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [async () => deny] }] },
      canUseTool: async () => ({ behavior: 'deny', message: 'Sin herramientas.' }),
    },
  });
  let out = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('El análisis tardó demasiado.')), ANALYZE_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); }
  finally {
    clearTimeout(timer);
    try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  const analysis = parseAnalysis(out);
  if (!analysis) throw new Error('No se pudo interpretar el análisis.');
  return analysis;
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  const job = readAnalyzeJob(id);
  if (!job) { log(`job ${id} inexistente.`); process.exit(0); return; }
  try {
    const analysis = await runAnalysis(job.text, job.contactName);
    writeAnalyzeJob(id, { ...job, status: 'done', analysis, error: null, updatedAt: Date.now() });
    log(`OK job ${id}: status ${analysis.status}.`);
  } catch (err) {
    writeAnalyzeJob(id, { ...job, status: 'error', analysis: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => { log('FALLO inesperado:', err?.message || err); process.exit(1); });
