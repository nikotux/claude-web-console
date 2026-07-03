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
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, discoverUnits, unitPrompt, synthesisPrompt, parseFindings, parseSynthesis,
  toolAllowed, readReview, writeReview, writeLock, clearLock, isRunning,
  UNIT_TIMEOUT_MS, SYNTH_TIMEOUT_MS, UNIT_MAX_TURNS, HEARTBEAT_MS,
} from '../src/modules/health/shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

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

  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    state.units[i].status = 'running';
    state.phase = u.label;
    flush();
    try {
      const text = await readOnlyRun(unitPrompt(u), 'haiku', UNIT_TIMEOUT_MS, UNIT_MAX_TURNS);
      const found = parseFindings(text);
      if (!found) throw new Error('respuesta no interpretable');
      for (const f of found) state.findings.push({ ...f, module: u.label, unit: u.name });
      state.units[i].status = 'done';
      state.units[i].findings = found.length;
      log(`  OK ${u.label}: ${found.length} hallazgo(s).`);
    } catch (err) {
      state.units[i].status = 'error';
      state.units[i].error = String(err && err.message || err).slice(0, 120);
      log(`  FAIL ${u.label}: ${state.units[i].error}`);
    }
    state.done = i + 1;
    flush();
  }

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
