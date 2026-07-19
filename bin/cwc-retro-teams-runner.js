#!/usr/bin/env node
// bin/cwc-retro-teams-runner.js — ESCANEO AUTOMÁTICO de Microsoft Teams (DM
// con Chris) para Mejora Continua, DESACOPLADO (regla de oro). Hermano de
// cwc-retro-email-runner.js — misma estructura, MISMO allowlist read-only ya
// probado en producción del escaneo de Teams de Comunicaciones
// (comms/teams-shared.js:graphReadAllowed).
//
// SEGURIDAD (regla 6): READ-ONLY blindada por DOS capas con graphReadAllowed
// (list/read/get/members/presence/detail/view/info sobre graph_*/teams_* —
// send/reply/write/create/etc. quedan denegados). settingSourcesFor('headless'),
// cwd=config.projectDir (Tolkien, de donde cuelga el MCP con Graph).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import { readContacts, readSelf } from '../src/modules/comms/shared.js';
import { graphReadAllowed } from '../src/modules/comms/teams-shared.js';
import {
  teamsFeedbackPrompt, parseTeamsFeedback,
  readTeamsFeedbackScan, writeTeamsFeedbackScan,
  writeTeamsFbLock, clearTeamsFbLock, readTeamsFbLock,
  TEAMS_FB_TIMEOUT_MS, TEAMS_FB_HEARTBEAT_MS,
} from '../src/modules/retro/teams-feedback-shared.js';
import { upsertLesson, computeFingerprint } from '../src/modules/retro/store.js';
import { padContextForUser } from '../src/core/pad-context.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, '[retro-teams]', ...a);
const FEEDBACK_CONTACT_ID = 'chris';

// Dedup pid-aware (el server ya reservó el lock con MI pid al spawnearme).
const _resv = readTeamsFbLock();
if (_resv && _resv.pid !== process.pid) { log('ya hay otro escaneo de Teams (lock fresco ajeno): salgo.'); process.exit(0); }

const beat = () => writeTeamsFbLock({ pid: process.pid });
const heartbeat = setInterval(beat, TEAMS_FB_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearTeamsFbLock(); process.exit(code); }

const denyMsg = 'Escaneo de Teams: SOLO tools graph_*/teams_* de lectura.';
const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };

async function fetchTeams(contact, self, sinceIso) {
  let out = '';
  const q = query({
    prompt: teamsFeedbackPrompt(contact, self, sinceIso),
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
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TEAMS_FB_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text; }
      else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); }
  finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  return out;
}

async function persist(items, ctx) {
  let created = 0;
  let merged = 0;
  let lastErr = null;
  for (const it of items) {
    try {
      const fingerprint = computeFingerprint('feedback-cliente', it.title);
      const stamp = it.msgAt ? it.msgAt.slice(0, 10) : '';
      const obsWithSource = `${it.observation ? `${it.observation} ` : ''}(vía Teams${stamp ? `, ${stamp}` : ''})`.trim();
      const r = await upsertLesson({
        title: it.title,
        category: 'feedback-cliente',
        observation: obsWithSource,
        lesson: it.lesson,
        destination: 'contexto',
        project: 'otros',
        confidence: it.confidence,
        fingerprint,
        sourceRefs: it.refs,
      }, ctx);
      if (r?.created) created += 1; else merged += 1;
    } catch (err) { lastErr = err; log('no pude guardar feedback:', err?.message || err); }
  }
  if (items.length && created + merged === 0) {
    throw new Error(`No se pudo guardar ninguna de las ${items.length} pieza(s) interpretadas: ${lastErr?.message || 'error desconocido'}`);
  }
  return { created, merged };
}

async function run() {
  const contacts = readContacts();
  const contact = contacts.find((c) => c.id === FEEDBACK_CONTACT_ID);
  if (!contact) throw new Error(`No hay un contacto "${FEEDBACK_CONTACT_ID}" configurado en Comunicaciones — agregalo primero para poder escanear su Teams.`);
  const self = readSelf();
  const prev = readTeamsFeedbackScan();
  const ctx = padContextForUser(null); // corrida bajo botón admin del host ⇒ Pad de 'console'
  const out = await fetchTeams(contact, self, prev.lastProcessedAt || null);
  const parsed = parseTeamsFeedback(out);
  if (!parsed) throw new Error('No se pudo interpretar el escaneo de Teams (respuesta inválida).');
  const summary = await persist(parsed.items, ctx);
  writeTeamsFeedbackScan({
    items: parsed.items,
    lastProcessedAt: parsed.lastProcessedAt || prev.lastProcessedAt || null,
    scannedAt: Date.now(),
    lastSummary: summary,
    note: parsed.note || null,
    error: null,
  });
  log(`OK: ${parsed.items.length} mensaje(s) con feedback · ${summary.created} nueva(s) · ${summary.merged} recurrente(s).`);
}

log(`retro-teams arrancando (pid ${process.pid})`);
run().then(() => finish(0)).catch((err) => {
  log('FALLÓ:', err?.message || err);
  const prev = readTeamsFeedbackScan();
  writeTeamsFeedbackScan({ ...prev, error: String(err?.message || err).slice(0, 300), scannedAt: Date.now() });
  finish(1);
});
