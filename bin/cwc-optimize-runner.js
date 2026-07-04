#!/usr/bin/env node
// bin/cwc-optimize-runner.js — análisis de OPTIMIZACIÓN IA de los motores de
// la consola, DESACOPLADO del server (patrón desk/triage/health, regla 2).
//
// QUÉ HACE: junta (1) el CENSO determinístico de motores IA (core/inventory.js
// → qué modelo/turnos/timeouts/blindaje usa cada corrida del SDK) y (2) el
// CONSUMO REAL por motor (módulo tokens, lectura de transcripts cacheada), y
// se los da a UNA corrida de sonnet que VERIFICA leyendo el código y devuelve
// propuestas de optimización (modelo, turnos, fusión, paralelismo, flujo
// nuevo). El resultado se PERSISTE en ~/.cwc-data/optimization.json; el front
// encuesta. Las propuestas NUNCA se auto-aplican (Aprobar = chat supervisado).
//
// SEGURIDAD (regla 6): READ-ONLY blindada por DOS capas (hook PreToolUse +
// canUseTool) con la MISMA allowlist que el auditor de salud
// (Read/Grep/Glob/TodoWrite — optToolAllowed). cwd = la consola,
// settingSources: [] (cero MCP ni permisos pre-aprobados). NUNCA escribe código.
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiEnginesCensus } from '../src/core/inventory.js';
import { buildSummary } from '../src/modules/tokens/index.js';
import {
  optToolAllowed, optimizePrompt, parseOptimization,
  readOpt, writeOpt, writeOptLock, clearOptLock, otherOptAlive,
  OPT_TIMEOUT_MS, OPT_MAX_TURNS, OPT_HEARTBEAT_MS,
} from '../src/modules/health/optimize-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// Dedup entre procesos: si OTRO runner ya late (pid real), este sobra. La
// reserva del server (pid:0) no cuenta: la reclamamos con nuestro heartbeat.
if (otherOptAlive()) { log('ya hay una optimización corriendo (lock fresco): salgo.'); process.exit(0); }

let phase = 'arrancando…';
const beat = () => writeOptLock({ pid: process.pid, phase });
beat();
const heartbeat = setInterval(beat, OPT_HEARTBEAT_MS);
heartbeat.unref?.();

function finish(code) { clearInterval(heartbeat); clearOptLock(); process.exit(code); }

const denyMsg = 'Optimización IA: corrida de SOLO LECTURA (Read/Grep/Glob).';
const denyHook = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg,
  },
};

async function analyze(census, usage) {
  let out = '';
  const q = query({
    prompt: optimizePrompt(census, usage),
    options: {
      cwd: ROOT,
      model: 'sonnet',
      maxTurns: OPT_MAX_TURNS,
      permissionMode: 'default',
      settingSources: [], // sin user/project: cero MCP ni permisos pre-aprobados
      // Capa 1: PreToolUse deniega ANTES de la evaluación de permisos.
      hooks: {
        PreToolUse: [{ hooks: [async (input) => (optToolAllowed(input.tool_name) ? {} : denyHook)] }],
      },
      // Capa 2: allowlist para todo lo que pida permiso.
      canUseTool: async (name, input) => (optToolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMsg }),
    },
  });
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('El análisis tardó demasiado (timeout).')), OPT_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text;
      } else if (m.type === 'result') break;
    }
  })();
  try { await Promise.race([pump, timeout]); } finally {
    clearTimeout(timer);
    try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  return out;
}

async function run() {
  const startedAt = Date.now();

  phase = 'censando motores IA…'; beat();
  const census = aiEnginesCensus();
  log(`censo: ${census.length} motor(es) IA detectado(s).`);

  phase = 'midiendo consumo real…'; beat();
  let usage = null;
  try {
    const s = await buildSummary();
    // Solo lo que necesita el análisis (los engines ya vienen consolidados).
    usage = { engines: s.engines, today: s.today, totals: { tokens: s.totals.tokens, cost: s.totals.cost } };
  } catch (err) { log('sin consumo real (no rompe):', err?.message); }

  phase = 'analizando con sonnet…'; beat();
  const out = await analyze(census, usage);
  const parsed = parseOptimization(out);
  if (!parsed) {
    // Cola del texto al log para diagnosticar (¿se quedó sin turnos? ¿fence roto?).
    log(`respuesta no parseable (${out.length} chars). Cola: …${out.slice(-400).replace(/\n/g, ' ⏎ ')}`);
    throw new Error('No se pudo interpretar la respuesta del análisis.');
  }

  writeOpt({
    startedAt, updatedAt: Date.now(),
    enginesCount: census.length,
    resumen: parsed.resumen,
    propuestas: parsed.propuestas,
    flujoNuevo: parsed.flujoNuevo,
    error: null,
  });
  log(`optimización OK: ${parsed.propuestas.length} propuesta(s).`);
}

log(`optimize-runner arrancando (pid ${process.pid})`);
run().then(() => finish(0))
  .catch((err) => {
    const msg = String(err?.message || err).slice(0, 300);
    log('optimize-runner FALLÓ:', msg);
    // Conserva el resultado anterior (foto vieja > nada) y deja el error visible.
    writeOpt({ ...readOpt(), error: msg, failedAt: Date.now() });
    finish(1);
  });
