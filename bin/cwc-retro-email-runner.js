#!/usr/bin/env node
// bin/cwc-retro-email-runner.js — ESCANEO AUTOMÁTICO de correo (Microsoft
// Graph) para Mejora Continua, DESACOPLADO (regla de oro). Busca mails del
// contacto 'chris' (reusa el contacto ya cargado en Comunicaciones) que sean
// feedback de desarrollo y los destila en lecciones categoría
// 'feedback-cliente'. CONSUME TOKENS ⇒ bajo botón (admin).
//
// SEGURIDAD (regla 6): READ-ONLY blindada por DOS capas con la allowlist
// EXPLÍCITA emailReadAllowed (SOLO graph_read_email/graph_read_email_body —
// send/reply/draft/adjuntos quedan denegados aunque el MCP los tenga).
// settingSourcesFor('headless') (MCP del proyecto), cwd=config.projectDir
// (Tolkien, de donde cuelga el MCP con Graph — mismo cwd que usa Teams).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import { readContacts, readSelf } from '../src/modules/comms/shared.js';
import {
  emailReadAllowed, emailScanPrompt, parseEmailScan,
  readEmailScan, writeEmailScan, writeEmailLock, clearEmailLock, readEmailLock,
  EMAIL_TIMEOUT_MS, EMAIL_HEARTBEAT_MS,
} from '../src/modules/retro/email-shared.js';
import { upsertLesson, computeFingerprint, listLessons } from '../src/modules/retro/store.js';
import { padContextForUser, sharedPadContextForUser } from '../src/core/pad-context.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, '[retro-email]', ...a);
const FEEDBACK_CONTACT_ID = 'chris';
const FEEDBACK_DEDUP_LIMIT = 30;

// Dedup pid-aware (patrón bugs/index.js:spawnTriage / comms-teams-runner): el
// server ya reservó el lock con MI pid al spawnearme (mismo tick que
// spawnRetroEmailRunner). Un lock fresco AJENO ⇒ ya hay otro escaneo, salgo.
const _resv = readEmailLock();
if (_resv && _resv.pid !== process.pid) { log('ya hay otro escaneo de correo (lock fresco ajeno): salgo.'); process.exit(0); }

const beat = () => writeEmailLock({ pid: process.pid });
const heartbeat = setInterval(beat, EMAIL_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearEmailLock(); process.exit(code); }

const denyMsg = 'Escaneo de correo: SOLO graph_read_email/graph_read_email_body.';
const denyHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg } };

async function feedbackForDedup(ctx) {
  try {
    const r = await listLessons(ctx);
    // BUG-1930: acotamos el prompt y priorizamos lo reciente; la categoría ya
    // está filtrada, así no mandamos las cientos de lecciones generales.
    return (r.lessons || [])
      .filter((l) => l.category === 'feedback-cliente')
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, FEEDBACK_DEDUP_LIMIT);
  } catch (err) {
    log('no pude traer feedback existente para dedup:', err?.message || err);
    return [];
  }
}

async function fetchEmail(contact, self, sinceIso, existing = []) {
  let out = '';
  const existingBlock = existing.length
    ? `\n\nLECCIONES YA REGISTRADAS. Si una lección que ibas a proponer YA figura acá (mismo concepto, aunque vos lo dirías distinto), NO la reformules: devolvela con el MISMO título y la MISMA categoría EXACTOS de esta lista, para que el sistema la reconozca como la misma y cuente su recurrencia en vez de duplicarla:\n${existing.map((l) => `- [${l.category}] ${l.title}`).join('\n')}`
    : '';
  const q = query({
    prompt: emailScanPrompt(contact, self, sinceIso) + existingBlock,
    options: {
      cwd: config.projectDir,
      model: 'sonnet',
      maxTurns: 16,
      permissionMode: 'default',
      settingSources: settingSourcesFor('headless'),
      hooks: { PreToolUse: [{ hooks: [async (input) => (emailReadAllowed(input.tool_name) ? {} : denyHook)] }] },
      canUseTool: async (name, input) => (emailReadAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMsg }),
    },
  });
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), EMAIL_TIMEOUT_MS); });
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

async function persist(items, ctx, sharedCtx) {
  let created = 0;
  let merged = 0;
  let lastErr = null;
  for (const it of items) {
    try {
      const fingerprint = computeFingerprint('feedback-cliente', it.title);
      const stamp = it.receivedAt ? it.receivedAt.slice(0, 10) : '';
      const obsWithSource = `${it.observation ? `${it.observation} ` : ''}(vía correo${it.subject ? ` — "${it.subject}"` : ''}${stamp ? `, ${stamp}` : ''})`.trim();
      const r = await upsertLesson({
        title: it.title,
        category: 'feedback-cliente',
        observation: obsWithSource,
        lesson: it.lesson,
        destination: 'contexto',
        // BUG-1928: es feedback sobre PRs de Tolkien; "otros" bloquea los
        // destinos que necesitan el directorio del proyecto.
        project: 'tolkien',
        confidence: it.confidence,
        fingerprint,
        sourceRefs: it.refs,
      }, ctx, sharedCtx);
      if (r?.created) created += 1; else merged += 1;
    } catch (err) { lastErr = err; log('no pude guardar feedback:', err?.message || err); }
  }
  // Mismo criterio que feedback-shared: si se interpretó algo pero NADA se
  // pudo guardar, no reportar el escaneo como OK con "0 nuevas" en silencio.
  if (items.length && created + merged === 0) {
    throw new Error(`No se pudo guardar ninguna de las ${items.length} pieza(s) interpretadas: ${lastErr?.message || 'error desconocido'}`);
  }
  return { created, merged };
}

async function run() {
  const contacts = readContacts();
  const contact = contacts.find((c) => c.id === FEEDBACK_CONTACT_ID);
  if (!contact) throw new Error(`No hay un contacto "${FEEDBACK_CONTACT_ID}" configurado en Comunicaciones — agregalo con su email (⚙ Sistema o el CLI cwc-comms) para poder escanear su correo.`);
  const self = readSelf();
  const prev = readEmailScan();
  const ctx = padContextForUser(null); // corrida bajo botón admin del host ⇒ Pad de 'console' (retrocompat)
  const sharedCtx = sharedPadContextForUser(null); // mismo principal host, pero workspace común explícito
  const existing = await feedbackForDedup(ctx);
  const out = await fetchEmail(contact, self, prev.lastReceivedAt || null, existing);
  const parsed = parseEmailScan(out);
  if (!parsed) throw new Error('No se pudo interpretar el escaneo de correo (respuesta inválida).');
  const summary = await persist(parsed.items, ctx, sharedCtx);
  writeEmailScan({
    items: parsed.items,
    lastReceivedAt: parsed.lastReceivedAt || prev.lastReceivedAt || null,
    scannedAt: Date.now(),
    lastSummary: summary,
    error: null,
  });
  log(`OK: ${parsed.items.length} correo(s) con feedback · ${summary.created} nueva(s) · ${summary.merged} recurrente(s).`);
}

log(`retro-email arrancando (pid ${process.pid})`);
run().then(() => finish(0)).catch((err) => {
  log('FALLÓ:', err?.message || err);
  const prev = readEmailScan();
  writeEmailScan({ ...prev, error: String(err?.message || err).slice(0, 300), scannedAt: Date.now() });
  finish(1);
});
