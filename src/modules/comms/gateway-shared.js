// modules/comms/gateway-shared.js — GATEWAY de ENVÍO del motor Comunicaciones.
//
// comms deja de ser solo un visor read-only: es el ÚNICO punto que EJECUTA
// comunicaciones externas (a Chris/clientes) con permisos + validaciones
// centralizadas, las REGISTRA (outbox + hilo) y DEVUELVE el resultado al motor
// o sesión que las pidió. Nadie más debe hacer `gh pr comment`/escritura Desk
// por su cuenta (ver auditoría 2026-07-05 en CLAUDE.md).
//
// Canales:
//   - github: DETERMINÍSTICO (gh CLI en Node, 0 tokens) — se ejecuta inline.
//   - desk / teams: consume TOKENS (MCP vía SDK) — se DESACOPLA a
//     bin/cwc-comms-send-runner.js (regla de oro), con allowlist de ESCRITURA
//     GOBERNADA (doble capa regla 6, ahora permitiendo verbos de envío
//     puntuales del canal, y NADA más).
//
// SEGURIDAD: la inversión read-only→escritura es DELIBERADA (pedido del
// usuario). Toda escritura pasa por (1) contacto/identidad validados,
// (2) firma centralizada para canales de identidad ajena (Desk/Teams),
// (3) allowlist estricta por canal, (4) registro en outbox.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import {
  readContacts, appendManual, appendOutbox, ensureDir, COMMS_DIR,
} from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEND_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-comms-send-runner.js');

// Firma centralizada (antes hardcodeada en bugfixes/index.js y prompts.js).
// Aplica SOLO a canales donde publicamos con identidad ajena (Desk/Teams): la
// API publica como otro y el autor real tiene que quedar claro.
export const SIGNATURE = '— Nicolás (dev team)';
export function ensureSignature(text) {
  const t = String(text || '').trim();
  return t.includes(SIGNATURE) ? t : `${t}\n\n${SIGNATURE}`;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout).trim());
    });
  });
}

// Acciones válidas por canal (whitelist de lo que el gateway sabe ejecutar).
export const GITHUB_ACTIONS = new Set(['pr_comment', 'pr_add_reviewer', 'pr_close_comment', 'pr_edit_body', 'record']);
export const DESK_ACTIONS = new Set(['ticket_reply', 'ticket_auto_update']);
export const TEAMS_ACTIONS = new Set(['dm']);

// Ejecutor GitHub (determinístico, 0 tokens). cwd = repo Tolkien.
async function githubExecute(action, payload, dryRun) {
  const cwd = config.projectDir;
  const pr = String(payload.prNumber || payload.ref || '').replace(/[^\d]/g, '');
  if (action === 'record') return { executed: false, recorded: true }; // solo ledger (ej. pr_create hecho por el push)
  if (!pr) throw new Error('Falta prNumber para la acción de GitHub.');
  if (dryRun) return { executed: false, dryRun: true, wouldRun: `gh ${action} #${pr}` };
  if (action === 'pr_comment') { await run('gh', ['pr', 'comment', pr, '--body', String(payload.text || '')], { cwd }); }
  else if (action === 'pr_add_reviewer') { await run('gh', ['pr', 'edit', pr, '--add-reviewer', String(payload.reviewer || '')], { cwd }); }
  else if (action === 'pr_close_comment') { await run('gh', ['pr', 'close', pr, '--comment', String(payload.text || '')], { cwd }); }
  else if (action === 'pr_edit_body') { await run('gh', ['pr', 'edit', pr, '--body', String(payload.text || '')], { cwd }); }
  else throw new Error(`Acción GitHub desconocida: ${action}`);
  return { executed: true };
}

// Resuelve el contacto (por id o por login de github) — para atribuir el hilo.
function resolveContact(contactId, githubLogin) {
  const contacts = readContacts();
  if (contactId) return contacts.find((c) => c.id === contactId) || null;
  if (githubLogin) return contacts.find((c) => (c.github || '').toLowerCase() === String(githubLogin).toLowerCase()) || null;
  return null;
}

// Lanza el runner de envío desk/teams (desacoplado, consume tokens).
function spawnSendRunner(jobId) {
  ensureDir();
  const child = spawn(process.execPath, [SEND_RUNNER, jobId], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', (err) => { try { console.error('[comms] no se pudo lanzar el send-runner:', String(err?.message || err)); } catch { /* noop */ } });
  child.unref();
}

// ===== API PRINCIPAL: sendComm =====
// Devuelve, para github: { ok, channel, action, result } (síncrono).
// Para desk/teams: { ok, deferred:true, jobId } (el caller encuesta el runner).
export async function sendComm({ channel, action, payload = {}, contactId = null, actor = 'system', dryRun = false }) {
  const ch = String(channel || '');
  if (ch === 'github') {
    if (!GITHUB_ACTIONS.has(action)) throw new Error(`Acción GitHub no permitida: ${action}`);
    const contact = resolveContact(contactId, payload.reviewer || 'cswenor');
    let result; let ok = true; let error = null;
    try { result = await githubExecute(action, payload, dryRun); }
    catch (e) { ok = false; error = String(e?.message || e); result = null; }
    const text = payload.text || (action === 'pr_add_reviewer' ? `Asignado ${payload.reviewer} como reviewer del PR #${payload.prNumber}` : action);
    const out = appendOutbox({ channel: 'github', action, to: payload.reviewer || contact?.github || 'github', ref: payload.prNumber ? `PR #${payload.prNumber}` : null, contactId: contact?.id || null, text, actor, ok, error, dryRun });
    // Registro en el hilo del contacto (si es atribuible y se ejecutó de verdad).
    if (ok && !dryRun && contact) {
      try { appendManual({ contactId: contact.id, text: `→ ${text}`, direction: 'out', channel: 'github', url: payload.prUrl || null, project: payload.project || null }); }
      catch { /* noop */ }
    }
    return { ok, channel: 'github', action, result, error, outboxId: out.id };
  }

  if (ch === 'desk' || ch === 'teams') {
    const actions = ch === 'desk' ? DESK_ACTIONS : TEAMS_ACTIONS;
    if (!actions.has(action)) throw new Error(`Acción ${ch} no permitida: ${action}`);
    // Desk/Teams publican con identidad ajena → firma obligatoria en el texto
    // provisto. 'ticket_auto_update' compone el texto en el runner (su prompt ya
    // exige la firma), así que no se fuerza sobre un texto vacío.
    const payload2 = (action === 'ticket_auto_update')
      ? { ...payload }
      : { ...payload, text: ensureSignature(payload.text || '') };
    const job = writeSendJob({ channel: ch, action, payload: payload2, contactId, actor, dryRun });
    if (!dryRun) spawnSendRunner(job.id);
    else finalizeDryRun(job);
    return { ok: true, deferred: true, channel: ch, action, jobId: job.id };
  }

  throw new Error(`Canal desconocido: ${channel}`);
}

// ===== Jobs de envío desk/teams (desacoplado) =====
import fss from 'node:fs';
const SEND_DIR = path.join(COMMS_DIR, 'send');
function sendJobPath(id) { return path.join(SEND_DIR, `${id}.json`); }
export function readSendJob(id) { try { return JSON.parse(fss.readFileSync(sendJobPath(id), 'utf8')); } catch { return null; } }
// Poda de send jobs viejos (BUG-32): son efímeros (el front encuesta y termina),
// pero sin poda se acumulan para siempre. Se barre lo > 7 días en cada escritura.
const SEND_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function pruneOldSendJobs() {
  let files = [];
  try { files = fss.readdirSync(SEND_DIR); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(SEND_DIR, f);
    try { if (now - fss.statSync(full).mtimeMs > SEND_JOB_MAX_AGE_MS) fss.unlinkSync(full); } catch { /* noop */ }
  }
}
export function writeSendJobRaw(id, data) {
  try { fss.mkdirSync(SEND_DIR, { recursive: true, mode: 0o700 }); fss.writeFileSync(sendJobPath(id), JSON.stringify(data), { mode: 0o600 }); pruneOldSendJobs(); }
  catch (err) { console.error('[comms] no pude escribir send job:', err?.message); }
}
let _sjseq = 0;
function writeSendJob(job) {
  _sjseq += 1;
  const id = `s${process.pid.toString(36)}${Date.now().toString(36)}${_sjseq.toString(36)}`;
  const data = { id, ...job, status: 'running', startedAt: Date.now() };
  writeSendJobRaw(id, data);
  return data;
}
function finalizeDryRun(job) {
  writeSendJobRaw(job.id, { ...job, status: 'done', result: { dryRun: true, wouldSend: job.action }, updatedAt: Date.now() });
  appendOutbox({ channel: job.channel, action: job.action, to: job.payload?.ticketNumber ? `ticket #${job.payload.ticketNumber}` : (job.contactId || 'externo'), ref: job.payload?.ticketNumber ? `ticket #${job.payload.ticketNumber}` : null, contactId: job.contactId, text: job.payload?.text || '', actor: job.actor, ok: true, dryRun: true });
}

export const SEND_STALE_MS = 6 * 60000;
export function sendJobResult(job) {
  if (!job) return null;
  if (job.status === 'running' && Date.now() - job.startedAt > SEND_STALE_MS) {
    return { status: 'error', error: 'El envío no respondió a tiempo (runner interrumpido).', result: null };
  }
  return { status: job.status, result: job.result || null, error: job.error || null };
}

// ===== Allowlists de ESCRITURA GOBERNADA por canal (las usa el send-runner) =====
// A diferencia del blindaje read-only, acá SÍ se permiten verbos de envío, pero
// SOLO los del canal y SOLO las tools esperadas. Todo lo demás sigue denegado.
export const deskWriteAllowed = (name) => {
  const s = String(name);
  if (s === 'TodoWrite' || s === 'ToolSearch') return true;
  // Lectura desk_* siempre (para ubicar el ticket) + SOLO desk_add_comment/desk_update_ticket de escritura.
  const m = s.match(/^mcp__[a-z0-9_-]+__desk_([a-z0-9_]+)$/i);
  if (!m) return false;
  const op = m[1];
  const READ = /(get|list|search|view|read|find)/i;
  // Guard anti-escritura (BUG-34): el branch de LECTURA debe excluir cualquier op
  // que ADEMÁS tenga un verbo de escritura — una tool de escritura que embeba
  // 'get'/'read' (p.ej. get_and_delete) NO puede colarse como lectura. Mismo
  // criterio que graphReadAllowed. La escritura real va SOLO por WRITE_OK.
  const WRITE_VERB = /(add|update|create|delete|remove|reply|send|post|set|move|assign|close|merge|patch|put|write)/i;
  // ANCLADO exacto (fix B3 2026-07-11): sólo las tools de escritura que el
  // send-runner realmente usa. Sin `$` final, `add_comment_x` pasaría.
  const WRITE_OK = /^(add_comment|update_ticket|reply)$/i;
  return (READ.test(op) && !WRITE_VERB.test(op)) || WRITE_OK.test(op);
};
export const teamsWriteAllowed = (name) => {
  const s = String(name);
  if (s === 'TodoWrite' || s === 'ToolSearch') return true;
  const m = s.match(/^mcp__[a-z0-9_-]+__(?:graph|teams)_([a-z0-9_]+)$/i);
  if (!m) return false;
  const op = m[1];
  const READ = /(list|read|get|members|search|find)/i;
  // Guard anti-escritura (BUG-34): la LECTURA excluye ops con verbo de escritura
  // embebido (mismo criterio que graphReadAllowed); la escritura va SOLO por WRITE_OK.
  const WRITE_VERB = /(send|create|update|write|delete|remove|post|set|add|move|assign|reply|share|save|patch|put)/i;
  // ANCLADO exacto (fix B3 2026-07-11): el `send` PELADO viejo matcheaba
  // CUALQUIER `send_*` (p.ej. graph_send_mail / send_activity_notification) —
  // hueco en la allowlist de ESCRITURA de la excepción de regla 6. Ahora sólo
  // los verbos de envío reales de Teams/Graph.
  const WRITE_OK = /^(send_message|send_chat|send_chat_message)$/i;
  return (READ.test(op) && !WRITE_VERB.test(op)) || WRITE_OK.test(op);
};
