#!/usr/bin/env node
// bin/cwc-comms-analyze-runner.js — ANÁLISIS IA de UN hilo de comunicaciones,
// DESACOPLADO (regla de oro: detached+unref, un reinicio de la web NO lo mata).
// El POST /thread/:id/analyze escribe el job pendiente y spawnea esto; acá se
// hace la corrida SDK (haiku, 1 turno, CERO herramientas — dos capas de
// denegación, regla 6: solo resume el texto del hilo) y se persiste el
// resultado en el MISMO archivo. El front encuesta GET hasta que status deja de
// ser 'running'. Clon de bin/cwc-projects-analyze-runner.js.
import { textOnlyQuery } from '../src/core/text-only-query.js';
import {
  ROOT, ANALYZE_TIMEOUT_MS, analyzePrompt, parseAnalysis, readAnalyzeJob, writeAnalyzeJob,
} from '../src/modules/comms/analyze-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = process.argv[2];

async function runAnalysis(text, contactName) {
  const out = await textOnlyQuery(analyzePrompt(text, contactName), {
    cwd: ROOT,
    model: 'sonnet',
    effort: 'low',
    maxTurns: 1,
    timeoutMs: ANALYZE_TIMEOUT_MS,
    denyReason: 'El análisis de hilo no usa herramientas.',
    timeoutMessage: 'El análisis tardó demasiado.',
  });
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
