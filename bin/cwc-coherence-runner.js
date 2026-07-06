#!/usr/bin/env node
// bin/cwc-coherence-runner.js — MÓDULO DE COHERENCIA: análisis de cómo se usan
// entre sí los motores y módulos de la consola, DESACOPLADO del server (patrón
// optimize/desk/triage, regla 2).
//
// QUÉ HACE: junta (1) el CENSO determinístico de coherencia (core/inventory.js
// → coherenceCensus: grafo quién-usa-a-quién + servicios transversales +
// señales) y (2) los HALLAZGOS de cableado determinísticos (evaluateCoherence),
// y se los da a UNA corrida de sonnet que VERIFICA leyendo el código y devuelve
// propuestas de cableado/deduplicación/fuente-única. El resultado se PERSISTE en
// ~/.cwc-data/coherence.json; el front encuesta. Las propuestas NUNCA se
// auto-aplican (Aprobar = chat supervisado).
//
// SEGURIDAD (regla 6): READ-ONLY blindada por DOS capas (hook PreToolUse +
// canUseTool) con la MISMA allowlist que el auditor de salud
// (Read/Grep/Glob/TodoWrite — cohToolAllowed). cwd = la consola,
// settingSources: [] (cero MCP ni permisos pre-aprobados). NUNCA escribe código.
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coherenceCensus } from '../src/core/inventory.js';
import {
  cohToolAllowed, evaluateCoherence, coherencePrompt, parseCoherence,
  readCoh, writeCoh, writeCohLock, clearCohLock, otherCohAlive,
  COH_TIMEOUT_MS, COH_MAX_TURNS, COH_HEARTBEAT_MS,
} from '../src/modules/health/coherence-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// Dedup entre procesos: si OTRO runner ya late (pid real), este sobra. La
// reserva del server (pid:0) no cuenta: la reclamamos con nuestro heartbeat.
if (otherCohAlive()) { log('ya hay un análisis de coherencia corriendo (lock fresco): salgo.'); process.exit(0); }

let phase = 'arrancando…';
const beat = () => writeCohLock({ pid: process.pid, phase });
beat();
const heartbeat = setInterval(beat, COH_HEARTBEAT_MS);
heartbeat.unref?.();

function finish(code) { clearInterval(heartbeat); clearCohLock(); process.exit(code); }

const denyMsg = 'Coherencia: corrida de SOLO LECTURA (Read/Grep/Glob).';
const denyHook = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg,
  },
};

async function analyze(census, findings) {
  let out = '';
  const q = query({
    prompt: coherencePrompt(census, findings),
    options: {
      cwd: ROOT,
      model: 'sonnet',
      maxTurns: COH_MAX_TURNS,
      permissionMode: 'default',
      settingSources: [], // sin user/project: cero MCP ni permisos pre-aprobados
      // Capa 1: PreToolUse deniega ANTES de la evaluación de permisos.
      hooks: {
        PreToolUse: [{ hooks: [async (input) => (cohToolAllowed(input.tool_name) ? {} : denyHook)] }],
      },
      // Capa 2: allowlist para todo lo que pida permiso.
      canUseTool: async (name, input) => (cohToolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMsg }),
    },
  });
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('El análisis tardó demasiado (timeout).')), COH_TIMEOUT_MS); });
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

  phase = 'censando el grafo de dependencias…'; beat();
  const census = coherenceCensus();
  const findings = evaluateCoherence(census);
  log(`censo: ${census.counts.modules} módulos · ${census.counts.edges} aristas · ${findings.length} hallazgo(s) determinístico(s).`);

  phase = 'analizando la coherencia con sonnet…'; beat();
  const out = await analyze(census, findings);
  const parsed = parseCoherence(out);
  if (!parsed) {
    log(`respuesta no parseable (${out.length} chars). Cola: …${out.slice(-400).replace(/\n/g, ' ⏎ ')}`);
    throw new Error('No se pudo interpretar la respuesta del análisis.');
  }

  writeCoh({
    startedAt, updatedAt: Date.now(),
    findingsCount: findings.length,
    findings, // los hallazgos determinísticos (0 tokens) quedan persistidos también
    resumen: parsed.resumen,
    propuestas: parsed.propuestas,
    flujoNuevo: parsed.flujoNuevo,
    error: null,
  });
  log(`coherencia OK: ${parsed.propuestas.length} propuesta(s).`);
}

log(`coherence-runner arrancando (pid ${process.pid})`);
run().then(() => finish(0))
  .catch((err) => {
    const msg = String(err?.message || err).slice(0, 300);
    log('coherence-runner FALLÓ:', msg);
    writeCoh({ ...readCoh(), error: msg, failedAt: Date.now() });
    finish(1);
  });
