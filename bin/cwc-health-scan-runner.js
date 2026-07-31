#!/usr/bin/env node
// bin/cwc-health-scan-runner.js — ORQUESTADOR del ESCANEO DE SALUD UNIFICADO.
//
// Corre en UNA pasada, bajo UN pool adaptativo compartido:
//   Fase 0 (0 tokens): censos — discoverUnits(+caché), aiEnginesCensus,
//           buildSummary(consumo), coherenceCensus+evaluateCoherence, padContext.
//   Fase 1 (tokens, PARALELO): TODAS las queries read-only en un solo
//           runAdaptivePool → [ ...unidades-de-Revisión-que-cambiaron,
//           Optimización, Coherencia ]. Cada una escribe su resultado en el
//           MISMO archivo que hoy (review/optimization/coherence.json).
//   Fase 2 (tokens): síntesis del veredicto de la Revisión (tras la barrera).
//   Fase 3 (0 tokens): cross-check de los hallazgos contra el backlog de Pad.
//
// REUSA la lógica de los 3 motores (prompts/parsers/escritores/allowlists) — NO
// la reescribe. DESACOPLADO (regla de oro): detached, estado en disco, reanudable.
// SEGURIDAD (regla 6): cada query mantiene su allowlist read-only doble capa.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { aiEnginesCensus, coherenceCensus } from '../src/core/inventory.js';
import { buildSummary } from '../src/modules/tokens/index.js';
import { runAdaptivePool } from '../src/core/pool.js';
import {
  RETRY_BACKOFF_MS as BACKOFF_MS, MAX_RETRIES as MAX_429_RETRIES, withRateLimitRetry,
} from '../src/core/query-retry.js';
import {
  ROOT, discoverUnits, unitPrompt, synthesisPrompt, parseFindings, parseSynthesis,
  toolAllowed, writeReview, writeLock, clearLock,
  readAuditCache, writeAuditCache, unitFingerprint, auditModelFor,
  UNIT_TIMEOUT_MS, SYNTH_TIMEOUT_MS, UNIT_MAX_TURNS, padContext,
} from '../src/modules/health/shared.js';
import {
  optToolAllowed, optimizePrompt, parseOptimization, writeOpt, writeOptLock, clearOptLock,
  OPT_TIMEOUT_MS, OPT_MAX_TURNS,
} from '../src/modules/health/optimize-shared.js';
import {
  cohToolAllowed, evaluateCoherence, coherencePrompt, parseCoherence, writeCoh, writeCohLock, clearCohLock,
  COH_TIMEOUT_MS, COH_MAX_TURNS,
} from '../src/modules/health/coherence-shared.js';
import {
  writeScan, writeScanLock, clearScanLock, readScanLock, isScanRunning, crossCheckPad, SCAN_HEARTBEAT_MS,
} from '../src/modules/health/scan-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const FULL = process.argv.includes('--full');

// Reserva pid-aware (patrón BUG-48): el server escribió el lock con pid:0. Esa es
// MI reserva → NO me suicido; solo salgo si hay un lock fresco con pid REAL ajeno.
const _lk = readScanLock();
if (_lk && _lk.pid && _lk.pid !== process.pid && isScanRunning()) {
  log(`ya hay un escaneo corriendo (lock ajeno pid=${_lk.pid}): salgo.`); process.exit(0);
}

// El orquestador SOSTIENE los 4 locks (scan + review + opt + coh) con su pid: así
// ningún runner viejo de esos motores arranca en paralelo, y los GET de estado los
// ven "corriendo" durante el escaneo.
const beat = () => {
  writeScanLock(process.pid); writeLock(process.pid);
  writeOptLock({ pid: process.pid, phase: 'escaneo unificado' });
  writeCohLock({ pid: process.pid, phase: 'escaneo unificado' });
};
beat();
const heartbeat = setInterval(beat, SCAN_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearScanLock(); clearLock(); clearOptLock(); clearCohLock(); process.exit(code); }

// Corrida read-only genérica (allowlist parametrizada). Junta el texto del
// asistente hasta el result. Las DOS capas de la regla 6 son incondicionales.
async function readOnlyRun(prompt, { model, maxTurns, timeoutMs, allow }) {
  const denyMsg = 'Escaneo de salud: corrida de SOLO LECTURA.';
  const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };
  const q = query({
    prompt,
    options: {
      cwd: ROOT, model, maxTurns, permissionMode: 'default', settingSources: [],
      hooks: { PreToolUse: [{ hooks: [async (input) => (allow(input.tool_name) ? {} : denyHook)] }] },
      canUseTool: async (name, input) => (allow(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denyMsg }),
    },
  });
  let text = ''; let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`; }
      else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); }
  finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  return text;
}

// Reintento con back-off ante 429/overload (avisa al pool para bajar concurrencia).
async function withRetry(label, ctl, fn) {
  return withRateLimitRetry(fn, {
    attempts: MAX_429_RETRIES,
    backoffMs: BACKOFF_MS,
    onRetry: ({ attempt }) => {
      ctl.backoff();
      log(`  429/overload en ${label}: back-off, reintento ${attempt}.`);
    },
  });
}

async function main() {
  const startedAt = Date.now();
  const units = discoverUnits();
  // Estado de la REVISIÓN (mismo shape que cwc-health-runner.js → GET /review y el modal no cambian).
  const review = {
    running: true, startedAt, updatedAt: startedAt, phase: null,
    done: 0, total: units.length + 1,
    units: units.map((u) => ({ name: u.name, label: u.label, status: 'pending', findings: 0 })),
    findings: [], verdict: null, summary: null, error: null,
  };
  // Estado del ESCANEO (overlay de orquestación + cross-check Pad).
  const scan = {
    running: true, startedAt, updatedAt: startedAt, finishedAt: null, mode: FULL ? 'full' : 'incremental',
    phase: 'censos',
    progress: { review: { done: 0, total: units.length, reused: 0, running: true }, optimize: { status: 'pending' }, coherence: { status: 'pending' } },
    pad: null, verdict: null, error: null,
  };
  const flush = () => { const now = Date.now(); review.updatedAt = now; scan.updatedAt = now; writeReview(review); writeScan(scan); };
  flush();
  log(`escaneo unificado arrancando: ${units.length} unidad(es) · modo ${scan.mode}.`);

  // ── FASE 0: censos (0 tokens) ──
  const cache = FULL ? {} : readAuditCache();
  const aiCensus = aiEnginesCensus();
  const cohCensus = coherenceCensus();
  const cohFindings = evaluateCoherence(cohCensus);
  let usage = null;
  try { const s = await buildSummary(); usage = { engines: s.engines, today: s.today, totals: { tokens: s.totals.tokens, cost: s.totals.cost } }; }
  catch (err) { log('sin consumo real (no rompe):', err?.message); }
  const padCtx = await padContext(); // best-effort

  // Revisión incremental: resolver al instante las unidades sin cambios, juntar las que hay que auditar.
  const toAudit = []; let reused = 0;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i]; const fp = unitFingerprint(u); const hit = cache[u.name];
    if (hit && hit.fingerprint === fp && Array.isArray(hit.findings)) {
      for (const f of hit.findings) review.findings.push({ ...f, module: u.label, unit: u.name });
      review.units[i].status = 'cached'; review.units[i].cached = true; review.units[i].findings = hit.findings.length; reused += 1;
    } else { toAudit.push({ i, u, fp }); }
  }
  review.done = reused; scan.progress.review.reused = reused; scan.progress.review.done = reused;
  scan.phase = 'analisis'; flush();

  // ── FASE 1: POOL ÚNICO — unidades de Revisión + Optimización + Coherencia ──
  const tasks = [
    ...toAudit.map((e) => ({ type: 'unit', e })),
    { type: 'optimize' }, { type: 'coherence' },
  ];
  async function worker(task, ctl) {
    if (task.type === 'unit') {
      const { i, u, fp } = task.e;
      review.units[i].status = 'running'; flush();
      try {
        const text = await withRetry(u.label, ctl, () => readOnlyRun(unitPrompt(u), { model: auditModelFor(u), maxTurns: UNIT_MAX_TURNS, timeoutMs: UNIT_TIMEOUT_MS, allow: toolAllowed }));
        const found = parseFindings(text); if (!found) throw new Error('respuesta no interpretable');
        cache[u.name] = { fingerprint: fp, findings: found, auditedAt: Date.now() };
        for (const f of found) review.findings.push({ ...f, module: u.label, unit: u.name });
        review.units[i].status = 'done'; review.units[i].findings = found.length;
        log(`  OK ${u.label}: ${found.length} hallazgo(s).`);
      } catch (err) {
        review.units[i].status = 'error'; review.units[i].error = String(err?.message || err).slice(0, 120);
        log(`  FAIL ${u.label}: ${review.units[i].error}`);
      }
      review.done += 1; scan.progress.review.done = review.done; flush();
    } else if (task.type === 'optimize') {
      scan.progress.optimize.status = 'running'; flush();
      try {
        const out = await withRetry('optimización', ctl, () => readOnlyRun(optimizePrompt(aiCensus, usage, padCtx), { model: 'sonnet', maxTurns: OPT_MAX_TURNS, timeoutMs: OPT_TIMEOUT_MS, allow: optToolAllowed }));
        const parsed = parseOptimization(out); if (!parsed) throw new Error('respuesta no parseable');
        writeOpt({ startedAt, updatedAt: Date.now(), enginesCount: aiCensus.length, resumen: parsed.resumen, propuestas: parsed.propuestas, flujoNuevo: parsed.flujoNuevo, error: null });
        scan.progress.optimize.status = 'done'; scan.progress.optimize.count = parsed.propuestas.length;
        log(`  OK optimización: ${parsed.propuestas.length} propuesta(s).`);
      } catch (err) { scan.progress.optimize.status = 'error'; scan.progress.optimize.error = String(err?.message || err).slice(0, 120); log('  FAIL optimización:', scan.progress.optimize.error); }
      flush();
    } else if (task.type === 'coherence') {
      scan.progress.coherence.status = 'running'; flush();
      try {
        const out = await withRetry('coherencia', ctl, () => readOnlyRun(coherencePrompt(cohCensus, cohFindings, padCtx), { model: 'sonnet', maxTurns: COH_MAX_TURNS, timeoutMs: COH_TIMEOUT_MS, allow: cohToolAllowed }));
        const parsed = parseCoherence(out); if (!parsed) throw new Error('respuesta no parseable');
        writeCoh({ startedAt, updatedAt: Date.now(), findingsCount: cohFindings.length, findings: cohFindings, resumen: parsed.resumen, propuestas: parsed.propuestas, flujoNuevo: parsed.flujoNuevo, error: null });
        scan.progress.coherence.status = 'done'; scan.progress.coherence.count = parsed.propuestas.length;
        log(`  OK coherencia: ${parsed.propuestas.length} propuesta(s).`);
      } catch (err) { scan.progress.coherence.status = 'error'; scan.progress.coherence.error = String(err?.message || err).slice(0, 120); log('  FAIL coherencia:', scan.progress.coherence.error); }
      flush();
    }
  }
  await runAdaptivePool(tasks, worker, { min: 2, start: 4, backoffMs: BACKOFF_MS, rampLoad: 0.75, rampFree: 0.15 });
  scan.progress.review.running = false;

  // Podar caché de unidades que ya no existen + persistir (una vez).
  for (const k of Object.keys(cache)) if (!units.some((u) => u.name === k)) delete cache[k];
  writeAuditCache(cache);

  // ── FASE 2: síntesis del veredicto de la Revisión ──
  scan.phase = 'sintesis'; review.phase = 'Sintesis del veredicto'; flush();
  try {
    const text = await readOnlyRun(synthesisPrompt(review.findings, padCtx), { model: 'sonnet', maxTurns: 1, timeoutMs: SYNTH_TIMEOUT_MS, allow: toolAllowed });
    const synth = parseSynthesis(text);
    if (synth) { review.verdict = synth.verdict; review.summary = synth.summary; }
    else { review.verdict = review.findings.length ? 'atencion' : 'ok'; review.summary = 'No se pudo sintetizar; ver hallazgos.'; }
  } catch (err) {
    const sev = new Set(review.findings.map((f) => f.severity));
    review.verdict = sev.has('critical') || sev.has('high') ? 'critico' : review.findings.length ? 'atencion' : 'ok';
    review.summary = `Síntesis IA no disponible (${String(err?.message || err).slice(0, 80)}).`;
  }
  review.done = review.total; review.phase = null; review.running = false; writeReview(review);

  // ── FASE 3: cross-check con Pad (0 tokens) ──
  scan.phase = 'pad'; flush();
  scan.pad = await crossCheckPad(review.findings);
  log(`  Pad: ${scan.pad.nuevo?.length || 0} nuevo(s) · ${scan.pad.rastreado?.length || 0} rastreado(s) · ${scan.pad.regresion?.length || 0} regresión(es).`);

  scan.verdict = review.verdict; scan.phase = null; scan.running = false; scan.finishedAt = Date.now();
  writeScan(scan);
  log(`escaneo OK: veredicto ${review.verdict} · ${review.findings.length} hallazgo(s) · optim ${scan.progress.optimize.status} · coh ${scan.progress.coherence.status}.`);
  finish(0);
}

main().catch((err) => {
  try { const scan = { running: false, error: String(err?.message || err).slice(0, 300), finishedAt: Date.now() }; writeScan(scan); } catch { /* noop */ }
  log('escaneo FALLÓ:', err?.message || err);
  finish(1);
});
