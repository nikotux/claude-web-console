#!/usr/bin/env node
// bin/cwc-health-runner.js — revisión exhaustiva de salud, DESACOPLADA del server.
//
// Barrido módulo por módulo (haiku, read-only doble capa) + síntesis final
// (sonnet). Escribe progreso incremental a health-review.json a medida que
// cada unidad termina — el server lo sirve y el front lo muestra en vivo. El
// server lo lanza detached (setsid): un reinicio a mitad NO lo mata (regla 2).
//
// SEGURIDAD (regla 6): cada corrida es READ-ONLY blindada por DOS capas —
// hook PreToolUse (deniega ANTES de la evaluación de permisos) + canUseTool
// como allowlist de solo-lectura. La revisión NUNCA modifica código: los
// hallazgos accionables se trabajan después en un chat supervisado.
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, discoverUnits, unitPrompt, synthesisPrompt, parseFindings, parseSynthesis,
  toolAllowed, readReview, writeReview, writeLock, clearLock, isRunning,
  readAuditCache, writeAuditCache, unitFingerprint, auditModelFor,
  UNIT_TIMEOUT_MS, SYNTH_TIMEOUT_MS, UNIT_MAX_TURNS, HEARTBEAT_MS,
} from '../src/modules/health/shared.js';
import { runAdaptivePool } from '../src/modules/health/pool.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ===== Pool de auditoría PARALELA ADAPTATIVA (F2.5) =====
// Solo la fase de ANÁLISIS (haiku, read-only) corre en paralelo; la SÍNTESIS es
// serial y va tras la barrera. Concurrencia DINÁMICA: rampa según CPU/RAM
// libres, back-off ante 429/overload; tope duro = nº de unidades a auditar.
const MIN_CONC = 2;      // piso de concurrencia
const START_CONC = 4;    // arranque moderado (rampa hacia arriba)
const RAMP_LOAD = 0.75;  // subir solo si loadavg[0] < núcleos * esto
const RAMP_FREE = 0.15;  // y si queda > 15% de RAM libre
const BACKOFF_MS = 15000;
const MAX_429_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isRateLimit(err) {
  const m = String((err && err.message) || err).toLowerCase();
  return /429|rate.?limit|overloaded|too many requests|529|503/.test(m);
}

if (isRunning()) { log('ya hay una revisión corriendo (lock fresco): salgo.'); process.exit(0); }

writeLock(process.pid);
const heartbeat = setInterval(() => writeLock(process.pid), HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearLock(); process.exit(code); }

// Corrida read-only del SDK: junta el texto del asistente hasta el result.
async function readOnlyRun(prompt, model, timeoutMs, maxTurns) {
  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Revision de salud: read-only.',
    },
  };
  const q = query({
    prompt,
    options: {
      cwd: ROOT,
      model,
      maxTurns,
      permissionMode: 'default',
      settingSources: [],
      hooks: { PreToolUse: [{ hooks: [async (input) => (toolAllowed(input.tool_name) ? {} : deny)] }] },
      canUseTool: async (name, input) => (toolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Revision de salud: read-only.' }),
    },
  });
  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') break;
    }
  })();
  try { await Promise.race([pump, timeout]); }
  finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  return text;
}

async function main() {
  const units = discoverUnits();
  const state = {
    running: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    phase: units[0] ? units[0].label : null,
    done: 0,
    total: units.length + 1, // +1 = sintesis
    units: units.map((u) => ({ name: u.name, label: u.label, status: 'pending', findings: 0 })),
    findings: [],
    verdict: null,
    summary: null,
    error: null,
  };
  const flush = () => { state.updatedAt = Date.now(); writeReview(state); };
  flush();
  log(`revision arrancando: ${units.length} unidad(es).`);

  // INCREMENTAL (Fase 2): con --full se ignora la caché y se re-audita todo.
  const FULL = process.argv.includes('--full');
  const cache = FULL ? {} : readAuditCache();
  // Audita UNA unidad (haiku, read-only) con reintento + back-off ante 429.
  // ANTI-COLISIÓN: no edita código; muta SU casillero del `state` compartido y
  // su propia key del `cache`. Nadie relee archivos → imposible pisar a otro.
  // `ctl` viene del pool: ctl.backoff() baja la concurrencia y pausa nuevos.
  async function auditUnit(entry, ctl) {
    const { i, u, fp } = entry;
    state.units[i].status = 'running';
    flush();
    let attempt = 0;
    for (;;) {
      try {
        const text = await readOnlyRun(unitPrompt(u), auditModelFor(u), UNIT_TIMEOUT_MS, UNIT_MAX_TURNS);
        const found = parseFindings(text);
        if (!found) throw new Error('respuesta no interpretable');
        cache[u.name] = { fingerprint: fp, findings: found, auditedAt: Date.now() }; // findings CRUDOS
        for (const f of found) state.findings.push({ ...f, module: u.label, unit: u.name });
        state.units[i].status = 'done';
        state.units[i].findings = found.length;
        log(`  OK ${u.label}: ${found.length} hallazgo(s).`);
        break;
      } catch (err) {
        if (isRateLimit(err) && attempt < MAX_429_RETRIES) {
          attempt += 1;
          ctl.backoff(); // avisa al pool: baja concurrencia + pausa lanzamientos
          log(`  429/overload en ${u.label}: back-off, reintento ${attempt}.`);
          await sleep(BACKOFF_MS);
          continue;
        }
        state.units[i].status = 'error';
        state.units[i].error = String((err && err.message) || err).slice(0, 120);
        log(`  FAIL ${u.label}: ${state.units[i].error}`);
        break;
      }
    }
    state.done += 1;
    flush();
  }

  // PASO 1 — resolver al instante las unidades SIN cambios (cacheadas) y juntar
  // las que hay que auditar de verdad.
  const toAudit = [];
  let reused = 0;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    const fp = unitFingerprint(u);
    const hit = cache[u.name];
    if (hit && hit.fingerprint === fp && Array.isArray(hit.findings)) {
      for (const f of hit.findings) state.findings.push({ ...f, module: u.label, unit: u.name });
      state.units[i].status = 'cached';
      state.units[i].cached = true;
      state.units[i].findings = hit.findings.length;
      reused += 1;
      log(`  = ${u.label}: sin cambios (cacheado, ${hit.findings.length}).`);
    } else {
      toAudit.push({ i, u, fp });
    }
  }
  state.done = reused;
  state.phase = toAudit.length ? `analizando ${toAudit.length} unidad(es) en paralelo…` : null;
  flush();

  // PASO 2 — ANÁLISIS en PARALELO (barrera antes de la síntesis).
  if (toAudit.length) {
    await runAdaptivePool(toAudit, auditUnit, {
      min: MIN_CONC, start: START_CONC, backoffMs: BACKOFF_MS,
      rampLoad: RAMP_LOAD, rampFree: RAMP_FREE,
    });
  }

  // Podar del cache las unidades que ya no existen y persistir (UNA sola vez).
  for (const k of Object.keys(cache)) if (!units.some((u) => u.name === k)) delete cache[k];
  writeAuditCache(cache);
  log(`unidades: ${units.length} · reusadas del cache: ${reused} · auditadas: ${units.length - reused}.`);

  state.phase = 'Sintesis del veredicto';
  flush();
  try {
    const text = await readOnlyRun(synthesisPrompt(state.findings), 'sonnet', SYNTH_TIMEOUT_MS, 1);
    const synth = parseSynthesis(text);
    if (synth) { state.verdict = synth.verdict; state.summary = synth.summary; }
    else { state.verdict = state.findings.length ? 'atencion' : 'ok'; state.summary = 'No se pudo sintetizar; ver hallazgos.'; }
  } catch (err) {
    const sev = new Set(state.findings.map((f) => f.severity));
    state.verdict = sev.has('critical') || sev.has('high') ? 'critico' : state.findings.length ? 'atencion' : 'ok';
    state.summary = `Sintesis IA no disponible (${String(err && err.message || err).slice(0, 80)}). Veredicto por severidad.`;
  }
  state.done = state.total;
  state.phase = null;
  state.running = false;
  state.updatedAt = Date.now();
  writeReview(state);
  log(`revision OK: veredicto ${state.verdict}, ${state.findings.length} hallazgo(s).`);
  finish(0);
}

main().catch((err) => {
  const prev = readReview();
  writeReview({ ...prev, running: false, error: String(err && err.message || err).slice(0, 300) });
  log('revision FALLO:', err && err.message || err);
  finish(1);
});
