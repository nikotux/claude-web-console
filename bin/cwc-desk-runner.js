#!/usr/bin/env node
// bin/cwc-desk-runner.js — consulta EN VIVO del estado de un ticket en Zoho
// Desk, DESACOPLADA del server (patrón triage/health, regla 2 de CLAUDE.md).
//
// POR QUÉ: antes la consulta corría INLINE dentro del request HTTP. Al cambiar
// de pestaña en el navegador (sobre todo móvil), el fetch en background podía
// abortarse y la corrida —que consume tokens— se perdía a mitad; un reinicio
// del server la mataba igual. Ahora la corrida vive en ESTE proceso detached:
// sigue aunque cambies de vista o el server reinicie, y el resultado se
// PERSISTE en ~/.cwc-data/desk-live/<ticket>.json. El front dispara y encuesta.
//
// Uso:  cwc-desk-runner.js <ticket> [<ticket> ...]
// Interfaz por archivos (desk-shared.js):
//   desk.lock                  heartbeat {pid, ts, tickets, done, total}
//   desk-live/<ticket>.json    resultado por ticket
// Log en ~/.cwc-data/desk.log (lo redirige el spawn).
//
// SEGURIDAD (regla 6, sub-excepción de LECTURA): READ-ONLY blindada por DOS
// capas (hook PreToolUse + canUseTool) con la allowlist ESTRICTA de tools
// desk_* de LECTURA (deskReadAllowed). settingSources 'headless' (sin user).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import {
  deskReadAllowed, deskPrompt, parseDeskResponse,
  writeDeskResult, persistDeskSnapshot,
  writeDeskLock, clearDeskLock, isDeskRunning,
  DESK_TIMEOUT_MS, DESK_HEARTBEAT_MS,
} from '../src/modules/bugfixes/desk-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// Tickets de la línea de comandos (únicos, saneados).
const tickets = [...new Set(process.argv.slice(2).map((t) => String(t).replace(/[^\w.-]/g, '')).filter(Boolean))];
if (!tickets.length) { log('sin tickets: salgo.'); process.exit(0); }

// Dedup entre procesos: si otro runner ya late, este sobra (doble POST / server
// que relanzó sin ver el lock). El front seguirá encuestando el mismo lock.
if (isDeskRunning()) { log('ya hay una consulta Desk corriendo (lock fresco): salgo.'); process.exit(0); }

let done = 0;
const beat = () => writeDeskLock({ pid: process.pid, tickets, done, total: tickets.length });
beat();
const heartbeat = setInterval(beat, DESK_HEARTBEAT_MS);
heartbeat.unref?.();

function finish(code) { clearInterval(heartbeat); clearDeskLock(); process.exit(code); }

const denyMsg = 'Lectura de Desk: SOLO tools desk_* de lectura.';
const denyHook = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg,
  },
};

async function fetchOne(ticket) {
  let out = '';
  try {
    const q = query({
      prompt: deskPrompt(ticket),
      options: {
        cwd: config.projectDir,
        model: 'sonnet',
        maxTurns: 12,
        permissionMode: 'default',
        settingSources: settingSourcesFor('headless'), // MCP del proyecto, sin settings de user
        // Capa 1: PreToolUse deniega ANTES de la evaluación de permisos.
        hooks: {
          PreToolUse: [{ hooks: [async (input) => (deskReadAllowed(input.tool_name) ? {} : denyHook)] }],
        },
        // Capa 2: allowlist para todo lo que pida permiso.
        canUseTool: async (name, input) => (deskReadAllowed(name)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: denyMsg }),
      },
    });
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), DESK_TIMEOUT_MS); });
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
  } catch (err) {
    return { found: false, error: String(err?.message || err).slice(0, 160), fetchedAt: Date.now() };
  }
  return parseDeskResponse(out);
}

async function run() {
  for (const ticket of tickets) {
    log(`consultando Desk #${ticket}…`);
    let data;
    try { data = await fetchOne(ticket); }
    catch (err) { data = { found: false, error: String(err?.message || err).slice(0, 160), fetchedAt: Date.now() }; }
    writeDeskResult(ticket, data);                 // persiste SIEMPRE (found o error) para el front
    if (data.found) persistDeskSnapshot(ticket, data); // marca resolución en los registros del ticket
    done += 1; beat();
    log(`Desk #${ticket}: ${data.found ? (data.status || 'ok') : (data.error || 'no encontrado')}`);
  }
}

log(`desk-runner arrancando (pid ${process.pid}, tickets ${tickets.join(', ')})`);
run().then(() => { log('desk-runner OK.'); finish(0); })
  .catch((err) => { log('desk-runner FALLÓ:', err?.message || err); finish(1); });
