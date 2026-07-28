#!/usr/bin/env node
import { scrubEnvSecrets } from './_env-boot.js';
// bin/cwc-projects-analyze-runner.js — análisis IA de UN cambio de sección de
// contexto (CLAUDE.md), DESACOPLADO del proceso del server (regla de oro: un
// reinicio de la web a mitad NO lo mata porque se spawnea detached+unref).
//
// El endpoint POST /:key/context/section/:i/analyze (modules/projects/index.js)
// solo escribe el job PENDIENTE en el projects-analyze del dueño y spawnea
// esto con <id> <owner>; acá se hace la corrida real (SDK, sonnet, 1 turno,
// CERO herramientas — dos capas de denegación, el análisis solo necesita el
// prompt) y se persiste el resultado en el MISMO archivo per-usuario. El front
// encuesta GET .../analyze/:id hasta que status deja de ser 'running'.
import { textOnlyQuery } from '../src/core/text-only-query.js';
import {
  ROOT, ANALYZE_TIMEOUT_MS, analyzePrompt, parseAnalysis, readAnalyzeJob, writeAnalyzeJob,
} from '../src/modules/projects/analyze-shared.js';
import { hostUser } from '../src/core/user-space.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = process.argv[2];
const owner = process.argv[3] || hostUser(); // argv ausente: job viejo del host
if (owner !== hostUser()) scrubEnvSecrets();

async function runAnalysis(before, after) {
  const text = await textOnlyQuery(analyzePrompt(before, after), {
    cwd: ROOT,
    model: 'sonnet',
    maxTurns: 1,
    timeoutMs: ANALYZE_TIMEOUT_MS,
    denyReason: 'El análisis de cambios no usa herramientas.',
    timeoutMessage: 'El análisis tardó demasiado.',
  });
  const analysis = parseAnalysis(text);
  if (!analysis) throw new Error('No se pudo interpretar el análisis.');
  return analysis;
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  const job = readAnalyzeJob(id, owner);
  if (!job) { log(`job ${id} inexistente (¿se limpió antes de arrancar?).`); process.exit(0); return; }
  try {
    const analysis = await runAnalysis(job.before, job.after);
    writeAnalyzeJob(id, { ...job, status: 'done', analysis, error: null, updatedAt: Date.now() }, owner);
    log(`OK job ${id}: riesgo ${analysis.risk}.`);
  } catch (err) {
    writeAnalyzeJob(id, { ...job, status: 'error', analysis: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() }, owner);
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
