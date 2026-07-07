#!/usr/bin/env node
// bin/cwc-investigate-runner.js — "investigación a fondo" de un PR, DESACOPLADA
// del server (patrón desk/triage/health, regla 2 de CLAUDE.md).
//
// POR QUÉ desacoplado: la corrida consume tokens y puede tardar; si corriera
// inline en el request se perdería al cambiar de pestaña o al reiniciar el
// server. Acá vive en su propio proceso: sigue igual y el resultado se PERSISTE
// en ~/.cwc-data/investigations/<pr>.json. El front dispara y encuesta.
//
// Uso:  cwc-investigate-runner.js <pr> [<ticketNumber>]
// Interfaz por archivos (investigate-shared.js):
//   investigate.lock              heartbeat {pid, pr, ts}
//   investigations/<pr>.json      resultado {semaforo, lectura, fetchedAt}
// Log en ~/.cwc-data/investigate.log (lo redirige el spawn).
//
// SEGURIDAD (regla 6, la MÁS blindada): junta los datos con gh EN NODE
// (determinístico), y la corrida IA es PURA LECTURA DE TEXTO — NO usa ninguna
// herramienta ni MCP. Las DOS capas (hook PreToolUse + canUseTool) deniegan TODO.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { fetchPrRich, fetchPrDiff } from '../src/modules/comms/pr-read-shared.js';
import { listBugfixes } from '../src/modules/bugfixes/store.js';
import {
  computeSemaforo, investigatePrompt, parseVerdict, investigateToolAllowed,
  writeInvestigation, writeInvLock, clearInvLock, isInvestigating,
  INV_TIMEOUT_MS, INV_HEARTBEAT_MS, DIFF_CAP,
} from '../src/modules/bugfixes/investigate-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const pr = String(process.argv[2] || '').replace(/[^\w.-]/g, '');
const ticketNumber = process.argv[3] ? String(process.argv[3]).replace(/[^\w.-]/g, '') : null;
if (!pr) { log('sin PR: salgo.'); process.exit(0); }

if (isInvestigating()) { log('ya hay una investigación corriendo (lock fresco): salgo.'); process.exit(0); }

writeInvLock({ pid: process.pid, pr });
const heartbeat = setInterval(() => writeInvLock({ pid: process.pid, pr }), INV_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearInvLock(); process.exit(code); }

const denyMsg = 'Investigación read-only: sin herramientas.';
const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };

async function run() {
  // 1) Juntar datos con gh (determinístico).
  // Fase C: lectura de GitHub centralizada en comms (pr-read-shared, superset).
  // Coherencia 2026-07-06: el diff también sale de la fuente única (fetchPrDiff)
  // — este runner ya no tiene ningún execFile de gh propio.
  const prJson = await fetchPrRich(pr, { fresh: true });
  let diff = '';
  try { diff = await fetchPrDiff(pr, { cap: DIFF_CAP }); } catch { /* sin diff */ }

  // deskReplied del registro (si lo consultamos antes; 0 tokens).
  let deskReplied = null;
  let ticketTitle = null;
  if (ticketNumber) {
    for (const b of listBugfixes()) {
      if (String(b.ticketNumber) !== ticketNumber) continue;
      if (b.deskReplied) deskReplied = true;
      if (b.title) ticketTitle = b.title;
    }
  }

  const semaforo = computeSemaforo(prJson, { deskReplied });

  // 2) Lectura profunda con IA (SIN herramientas — pura interpretación).
  const prompt = investigatePrompt({ prNumber: prJson.number, prTitle: prJson.title, ticketTitle, semaforo, diff });
  let out = '';
  try {
    const q = query({
      prompt,
      options: {
        cwd: config.projectDir,
        model: 'sonnet',
        maxTurns: 1,
        permissionMode: 'default',
        settingSources: [], // sin user/project/local: cero MCP ni CLAUDE.md — corrida sin herramientas (patrón ticket-investigate/optimize)
        hooks: { PreToolUse: [{ hooks: [async (input) => (investigateToolAllowed(input.tool_name) ? {} : denyHook)] }] },
        canUseTool: async () => ({ behavior: 'deny', message: denyMsg }),
      },
    });
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), INV_TIMEOUT_MS); });
    const pump = (async () => {
      for await (const m of q) {
        if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text; }
        else if (m.type === 'result') break;
      }
    })();
    try { await Promise.race([pump, timeout]); } finally {
      clearTimeout(timer);
      try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
    }
  } catch (err) {
    // Sin lectura IA igual persistimos el semáforo (ya es útil).
    return { semaforo, lectura: { ok: false, error: String(err?.message || err).slice(0, 160) }, fetchedAt: Date.now() };
  }
  return { semaforo, lectura: parseVerdict(out), fetchedAt: Date.now(), ticketNumber: ticketNumber || null };
}

log(`investigate arrancando (pid ${process.pid}, PR ${pr}${ticketNumber ? `, TKT ${ticketNumber}` : ''})`);
run()
  .then((data) => { writeInvestigation(pr, data); log(`investigate OK: severidad=${data.lectura?.severidad || '?'} accion=${data.lectura?.accion || '?'}`); finish(0); })
  .catch((err) => { writeInvestigation(pr, { semaforo: null, lectura: { ok: false, error: String(err?.message || err).slice(0, 200) }, fetchedAt: Date.now() }); log('investigate FALLÓ:', err?.message || err); finish(1); });
