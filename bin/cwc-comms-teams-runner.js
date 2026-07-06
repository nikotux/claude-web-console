#!/usr/bin/env node
// bin/cwc-comms-teams-runner.js — escaneo de TEAMS (mensajes directos) para el
// módulo Comunicaciones, DESACOPLADO (regla de oro). Por CADA contacto lee sus
// DMs recientes de Microsoft Teams vía el MCP tolkien-mordor (graph_* de
// LECTURA) y arma los hilos (teams.json). CONSUME TOKENS ⇒ se lanza bajo botón.
//
// SEGURIDAD (regla 6): READ-ONLY blindada por DOS capas (hook PreToolUse +
// canUseTool) con la allowlist graphReadAllowed. settingSourcesFor('headless')
// (MCP del proyecto, sin settings de user). cwd = projectDir (~/tolkien) para
// heredar el server MCP. Best-effort: si un contacto no tiene DM, se saltea.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import { readContacts, writeTeams, readTeams, readSelf } from '../src/modules/comms/shared.js';
import {
  graphReadAllowed, teamsPrompt, parseTeamsResponse,
  writeTeamsLock, clearTeamsLock, isTeamsRunning,
  TEAMS_TIMEOUT_MS, TEAMS_HEARTBEAT_MS,
} from '../src/modules/comms/teams-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, '[comms-teams]', ...a);

if (isTeamsRunning()) { log('ya hay un escaneo Teams corriendo (lock fresco): salgo.'); process.exit(0); }

const contacts = readContacts();
const self = readSelf();
let done = 0;
const beat = () => writeTeamsLock({ pid: process.pid, done, total: contacts.length });
beat();
const heartbeat = setInterval(beat, TEAMS_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearTeamsLock(); process.exit(code); }

const denyMsg = 'Escaneo de Teams: SOLO tools graph_*/teams_* de lectura.';
const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };

async function fetchOne(contact) {
  let out = '';
  try {
    const q = query({
      prompt: teamsPrompt(contact, self),
      options: {
        cwd: config.projectDir,
        model: 'sonnet',
        maxTurns: 14,
        permissionMode: 'default',
        settingSources: settingSourcesFor('headless'),
        hooks: { PreToolUse: [{ hooks: [async (input) => (graphReadAllowed(input.tool_name) ? {} : denyHook)] }] },
        canUseTool: async (name, input) => (graphReadAllowed(name)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: denyMsg }),
      },
    });
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TEAMS_TIMEOUT_MS); });
    const pump = (async () => {
      for await (const m of q) {
        if (m.type === 'assistant') {
          for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text;
        } else if (m.type === 'result') break;
      }
    })();
    try { await Promise.race([pump, timeout]); }
    finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  } catch (err) {
    return { found: false, note: String(err?.message || err).slice(0, 160) };
  }
  return parseTeamsResponse(out, contact, self);
}

async function run() {
  const threads = [];
  for (const contact of contacts) {
    log(`escaneando DMs de ${contact.name}…`);
    let res;
    try { res = await fetchOne(contact); }
    catch (err) { res = { found: false, note: String(err?.message || err).slice(0, 160) }; }
    if (res.found && res.thread) { threads.push(res.thread); log(`${contact.name}: ${res.thread.messages.length} mensajes.`); }
    else { log(`${contact.name}: descartado — ${res.note || 'no encontrado'}${res.rejected ? ' [RECHAZADO por atribución]' : ''}.`); }
    done += 1; beat();
    // Escritura incremental (preserva DMs de otros contactos ya escaneados).
    writeTeams({ threads, scannedAt: Date.now(), error: null });
  }
  writeTeams({ threads, scannedAt: Date.now(), error: null });
  log(`listo: ${threads.length} hilo(s) de Teams.`);
}

log(`comms-teams arrancando (pid ${process.pid}, ${contacts.length} contacto(s))`);
run().then(() => finish(0)).catch((err) => {
  log('FALLÓ:', err?.message || err);
  const prev = readTeams();
  writeTeams({ threads: prev.threads || [], scannedAt: Date.now(), error: String(err?.message || err).slice(0, 200) });
  finish(1);
});
