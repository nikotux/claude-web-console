// modules/retro/email-shared.js — ingesta AUTOMÁTICA de "Feedback de Chris"
// desde CORREO, para Mejora Continua (2026-07-19). Usa el MISMO MCP de Graph
// que ya usa Teams (graph_read_email/graph_read_email_body) — el scope
// Mail.Read/Mail.Send YA está concedido en la app de Entra de Tolkien
// (verificado: Tolkien ya envía mail en prod), así que esto NO pide ningún
// consentimiento nuevo, solo suma un lector más.
//
// CONSUME TOKENS ⇒ bajo botón (admin), RUNNER DESACOPLADO
// (bin/cwc-retro-email-runner.js, regla de oro).
//
// SEGURIDAD (regla 6): READ-ONLY doble capa con allowlist EXPLÍCITA POR
// NOMBRE (no por verbo, a diferencia de graphReadAllowed de comms/teams-
// shared.js) — la mailbox es más sensible que Teams: se listan los DOS tools
// de lectura tal cual existen HOY en el MCP (graph_read_email,
// graph_read_email_body). graph_send_email/graph_reply_email/
// graph_create_draft/graph_list_attachments/graph_save_attachment NUNCA
// pasan, aunque el MCP los tenga.
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { retroDataDirFor, retroRunnerEnvFor } from './owner-dirs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'bin', 'cwc-retro-email-runner.js');

export const EMAIL_TIMEOUT_MS = 5 * 60 * 1000;
export const EMAIL_HEARTBEAT_MS = 3000;
export const EMAIL_LOCK_FRESH_MS = 20000;

const EMAIL_READ_TOOLS = new Set(['graph_read_email', 'graph_read_email_body']);
export const emailReadAllowed = (name) => {
  const s = String(name);
  if (s === 'TodoWrite' || s === 'ToolSearch') return true;
  const m = s.match(/^mcp__[a-z0-9_-]+__([a-z0-9_]+)$/i);
  if (!m) return false;
  return EMAIL_READ_TOOLS.has(m[1]);
};

function dataDirFor(owner = null) { return retroDataDirFor(owner); }
function scanFileFor(owner = null) { return path.join(dataDirFor(owner), 'retro-email-scan.json'); }
function lockFileFor(owner = null) { return path.join(dataDirFor(owner), 'retro-email.lock'); }
function logFileFor(owner = null) { return path.join(dataDirFor(owner), 'retro-email.log'); }
function ensureDir(owner = null) { try { fss.mkdirSync(dataDirFor(owner), { recursive: true, mode: 0o700 }); } catch { /* noop */ } }
export function readEmailScan(owner = null) {
  try { return JSON.parse(fss.readFileSync(scanFileFor(owner), 'utf8')); } catch { return { items: [], lastReceivedAt: null, scannedAt: 0, error: null }; }
}
export function writeEmailScan(data, owner = null) { ensureDir(owner); writeJsonAtomic(scanFileFor(owner), data); }

export function writeEmailLock(state, owner = null) {
  try { ensureDir(owner); fss.writeFileSync(lockFileFor(owner), JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 }); }
  catch { /* noop */ }
}
export function clearEmailLock(owner = null) { try { fss.unlinkSync(lockFileFor(owner)); } catch { /* noop */ } }
export function readEmailLock(owner = null) {
  try {
    const l = JSON.parse(fss.readFileSync(lockFileFor(owner), 'utf8'));
    if (Date.now() - l.ts >= EMAIL_LOCK_FRESH_MS) return null;
    return l;
  } catch { return null; }
}
export function isEmailScanRunning(owner = null) { return !!readEmailLock(owner); }

// Spawn con reserva SINCRÓNICA del lock usando el pid REAL del hijo (mismo
// patrón que bugs/index.js:spawnTriage / comms-teams): child_process.spawn
// devuelve el pid YA antes de que el hijo ejecute su propio código, así que
// escribir el lock JUSTO DESPUÉS gana la carrera contra el propio chequeo
// pid-aware del runner (ver bin/cwc-retro-email-runner.js).
export function spawnRetroEmailRunner(owner) {
  ensureDir(owner);
  const logFile = logFileFor(owner);
  let logFd = null;
  try {
    logFd = fss.openSync(logFile, 'a');
    const child = spawn(process.execPath, [RUNNER], {
      detached: true, stdio: ['ignore', logFd, logFd],
      env: retroRunnerEnvFor(owner, { missingOauthMessage: 'Necesitás conectar tu cuenta de Claude para traer feedback del correo.' }),
    });
    writeEmailLock({ pid: child.pid }, owner);
    child.on('error', (err) => {
      try { fss.appendFileSync(logFile, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ }
      try { clearEmailLock(owner); } catch { /* noop */ }
    });
    child.unref();
  } finally {
    if (logFd !== null) { try { fss.closeSync(logFd); } catch { /* noop */ } }
  }
}

export function emailScanPrompt(contact, self, sinceIso) {
  const name = contact.name || contact.id;
  const cEmail = contact.email ? ` (email ${contact.email})` : '';
  const sinceLine = sinceIso
    ? `Priorizá correos recibidos DESPUÉS de ${sinceIso} (los anteriores probablemente ya se procesaron), pero si algo relevante quedó sin leer antes, igual incluilo.`
    : '';
  return [
    'Es SOLO LECTURA de correo: usá EXCLUSIVAMENTE graph_read_email y graph_read_email_body.',
    'NUNCA envíes, respondas ni crees borradores — no tenés esas herramientas disponibles.',
    '',
    `Buscá correos RECIENTES en mi bandeja (${self?.email || 'mi cuenta'}) enviados por`,
    `"${name}"${cEmail} que sean FEEDBACK sobre un bug/ticket/PR de nuestro sistema de`,
    'desarrollo (comentarios de revisión, correcciones pedidas, preferencias sobre',
    `cómo resolver algo). ${sinceLine}`,
    '',
    'Pasos:',
    `1. graph_read_email para listar correos recientes de/con "${name}"${cEmail}.`,
    '2. Para cada uno que PAREZCA feedback de desarrollo (no ruido administrativo),',
    '   leé el cuerpo completo con graph_read_email_body.',
    '3. Para cada correo relevante, extraé si menciona un ticket/PR (formato',
    '   "TKT-519", "#245", "FEAT-3" en el asunto o cuerpo) y destilá el feedback en',
    '   una lección ACCIONABLE concreta (NO un resumen del mail).',
    '',
    'Respondé ÚNICAMENTE con un bloque JSON (nada de texto fuera):',
    '```json',
    '{"items":[{"emailId":"<id>","subject":"<asunto>","receivedAt":"<fecha ISO>","refs":["TKT-519"],"title":"...","lesson":"...","observation":"...","confidence":"media"}],"lastReceivedAt":"<fecha ISO del más reciente que revisaste, o null>"}',
    '```',
    'Si no hay correos relevantes: {"items":[],"lastReceivedAt":null}.',
    'Máximo 15 correos. Sé conservador: solo feedback REAL y accionable, no ruido.',
  ].filter(Boolean).join('\n');
}

const clamp = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const CONFS = ['alta', 'media', 'baja'];
const pick = (v, list, def) => (list.includes(v) ? v : def);

export function parseEmailScan(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const items = Array.isArray(o?.items) ? o.items.slice(0, 20).map((it) => ({
    emailId: clamp(it?.emailId, 200),
    subject: clamp(it?.subject, 300),
    receivedAt: clamp(it?.receivedAt, 40),
    refs: Array.isArray(it?.refs) ? it.refs.map((r) => clamp(r, 24)).filter(Boolean).slice(0, 10) : [],
    title: clamp(it?.title, 200).trim(),
    lesson: clamp(it?.lesson, 2000),
    observation: clamp(it?.observation, 2000),
    confidence: pick(it?.confidence, CONFS, 'media'),
  })).filter((it) => it.title && it.lesson) : [];
  const lastReceivedAt = clamp(o?.lastReceivedAt, 40) || null;
  return { items, lastReceivedAt };
}
