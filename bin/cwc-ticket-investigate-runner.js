#!/usr/bin/env node
// bin/cwc-ticket-investigate-runner.js — "investigación de CONTEXTO" de un ticket
// SIN PR, DESACOPLADA del server (patrón desk/triage/health/investigate, regla 2).
//
// POR QUÉ: un ticket sin PR no tiene diff. Para decir "¿por qué NO se resolvió?"
// hay que LEER el código de Tolkien. Este runner hace esa lectura read-only,
// formula la causa raíz y explica qué falta. Vive en su propio proceso: sigue
// aunque cambien de pestaña o reinicien el server; el resultado se PERSISTE en
// ~/.cwc-data/ticket-investigations/<ticket>.json. El front dispara y encuesta.
//
// Uso:  cwc-ticket-investigate-runner.js <ticket>
//   El "problema" (qué se rompió, ruta, contexto…) lo escribió el server en
//   ~/.cwc-data/ticket-investigations/<ticket>.req.json (así no viaja por argv).
//
// SEGURIDAD (regla 6): read-only blindada por las DOS capas (hook PreToolUse +
// canUseTool). A diferencia de la investigación de PR (SIN herramientas), ésta
// usa lecturas locales — MISMA allowlist que el auditor de Salud:
// Read/Grep/Glob/TodoWrite y nada más. cwd = Tolkien. NUNCA escribe.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import {
  ticketInvestigatePrompt, parseTicketVerdict, ticketInvToolAllowed, gatherCandidates,
  readTicketInvRequest, writeTicketInvestigation,
  writeTktInvLock, clearTktInvLock, isTicketInvestigating,
  TKTINV_TIMEOUT_MS, TKTINV_HEARTBEAT_MS, TKTINV_MAX_TURNS,
} from '../src/modules/bugfixes/ticket-investigate-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const ticket = String(process.argv[2] || '').replace(/[^\w.-]/g, '').slice(0, 20);
if (!ticket) { log('sin ticket: salgo.'); process.exit(0); }

if (isTicketInvestigating()) { log('ya hay una investigación de contexto corriendo (lock fresco): salgo.'); process.exit(0); }

writeTktInvLock({ pid: process.pid, ticket });
const heartbeat = setInterval(() => writeTktInvLock({ pid: process.pid, ticket }), TKTINV_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearTktInvLock(); process.exit(code); }

const denyMsg = 'Investigación de contexto: read-only (solo lectura).';
const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };

async function run() {
  const problem = readTicketInvRequest(ticket) || { ticket };
  // Recolección determinística EN NODE (grep + snippets) para acotar la exploración.
  let ctx = { candidates: [], snippets: [] };
  try { ctx = await gatherCandidates(config.projectDir, problem); } catch (e) { log('gatherCandidates falló:', e?.message); }
  log(`candidatos: ${ctx.candidates.length} (${ctx.candidates.slice(0, 6).join(', ')})`);
  const prompt = ticketInvestigatePrompt(problem, ctx);
  let out = '';
  const q = query({
    prompt,
    options: {
      cwd: config.projectDir,                 // lee el código de Tolkien
      model: 'sonnet',
      maxTurns: TKTINV_MAX_TURNS,
      permissionMode: 'default',
      settingSources: [],                     // sin settings de usuario/proyecto (nada de MCP ni permisos pre-aprobados)
      hooks: { PreToolUse: [{ hooks: [async (input) => (ticketInvToolAllowed(input.tool_name) ? {} : denyHook)] }] },
      canUseTool: async (name, input) => (ticketInvToolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMsg }),
    },
  });
  let timer = null;
  let resultSubtype = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TKTINV_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += `${b.text}\n`; }
      else if (m.type === 'result') { resultSubtype = m.subtype || null; break; }
    }
  })();
  try { await Promise.race([pump, timeout]); } finally {
    clearTimeout(timer);
    try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  const lectura = parseTicketVerdict(out);
  log(`result=${resultSubtype || '?'} out.len=${out.length} parsed=${lectura.ok}`);
  return { lectura, fetchedAt: Date.now(), ticket };
}

log(`ticket-investigate arrancando (pid ${process.pid}, TKT ${ticket})`);
run()
  .then((data) => { writeTicketInvestigation(ticket, data); log(`ticket-investigate OK: complejidad=${data.lectura?.complejidad || '?'} conf=${data.lectura?.confianza || '?'}`); finish(0); })
  .catch((err) => { writeTicketInvestigation(ticket, { lectura: { ok: false, error: String(err?.message || err).slice(0, 200) }, fetchedAt: Date.now(), ticket }); log('ticket-investigate FALLÓ:', err?.message || err); finish(1); });
