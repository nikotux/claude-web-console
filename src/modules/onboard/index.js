// modules/onboard/index.js — onboarding por token de invitación (SP7 multi-tenant).
// ADMIN (auth-gated, apiRouter): generar/listar/revocar invitaciones.
// PÚBLICO (montado ANTES del gate en server.js, gateado por el TOKEN no por login):
// validar el token + auto-registrarse (crear usuario+contraseña). El paso de
// credenciales (setup-token PTY) es capa 3b, se suma después.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isAdmin, principalOf } from '../../core/auth.js';
import { config } from '../../core/config.js';
import { provisionUserPad } from '../../core/pad-provision.js';
import { provisionUserWorkspace } from '../../core/workspace-provision.js';
import { createUser, isValidUsername } from '../../core/users.js';
import { ensureUserSpace, readUserOauthToken } from '../../core/user-space.js';
import { generateInvite, listInvites, revokeInvite, validateInvite, peekInvite, lockInvite } from '../../core/onboard-tokens.js';

const DEFAULT_TTL_H = 24;

// Rate-limit simple por IP para la superficie PÚBLICA (anti fuerza-bruta de tokens).
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 30;
const rlMap = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let e = rlMap.get(ip);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW_MS }; rlMap.set(ip, e); }
  e.count += 1;
  if (rlMap.size > 5000) { for (const [k, v] of rlMap) if (now > v.resetAt) rlMap.delete(k); } // GC oportunista
  if (e.count > RL_MAX) return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto.' });
  next();
}

// PUBLIC router — lo monta server.js ANTES del gate de auth.
export const publicRouter = express.Router();
publicRouter.use(rateLimit);

publicRouter.post('/validate', (req, res) => {
  try {
    const v = validateInvite(req.body?.token);
    res.json({ valid: v.valid, admin: v.admin || false, reason: v.reason || null });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo validar la invitación: ' + (e.message || e) });
  }
});

publicRouter.post('/register', (req, res) => {
  const { token, username, password } = req.body || {};
  let v;
  try {
    v = validateInvite(token, { forUsername: username });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo validar la invitación: ' + (e.message || e) });
  }
  if (!v.valid) return res.status(403).json({ error: `Invitación ${v.reason || 'inválida'}.` });
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Usuario inválido (letras, números, . _ - ; máx 32).' });
  // Reservar el token ANTES de crear el usuario (evita la carrera: dos
  // registros concurrentes con el mismo token no deben poder crear dos
  // usuarios y dejar uno huérfano sin invitación asociada). Reintentar con el
  // MISMO username tras un fallo de createUser sigue funcionando (lockInvite
  // es idempotente para el mismo lockedTo).
  let locked;
  try {
    locked = lockInvite(token, username);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo reservar la invitación: ' + (e.message || e) });
  }
  if (!locked) return res.status(409).json({ error: 'Invitación ya en uso por otro registro.' });
  try {
    createUser(username, password, !!v.admin); // admin SOLO si el token lo marca
  } catch (e) {
    return res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo crear el usuario.' });
  }
  try { ensureUserSpace(username); } catch { /* best-effort: el space se re-asegura al spawnear */ }
  // Provisionar el Pad PROPIO del inquilino (B2-F3), best-effort y sin bloquear
  // el registro: si el Pad local está caído, el chat funciona igual y el
  // provisioning se reintenta lazy al primer uso (F8). NUNCA await acá.
  provisionUserPad(username, { name: username })
    .then((r) => { if (!r.ok) console.error('[onboard] provisioning de Pad best-effort falló:', r.error); })
    .catch((e) => console.error('[onboard] provisioning de Pad best-effort excepción:', e?.message || e));
  // Clon del repo de trabajo (Tolkien) en el workspace del inquilino (SP9-7/TASK-673),
  // best-effort y sin bloquear el registro (idempotente; se reintenta si algun dia se cablea lazy).
  provisionUserWorkspace(username)
    .then((r) => { if (!r.ok && !r.skipped) console.error('[onboard] clon de workspace best-effort falló:', r.error); })
    .catch((e) => console.error('[onboard] clon de workspace excepción:', e?.message || e));
  res.json({ ok: true, username });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONBOARD_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-onboard-runner.js');
const JOBS_DIR = path.join(config.home, '.cwc-data', 'onboard-jobs');
function jobPath(user) { return path.join(JOBS_DIR, `${user}.json`); }
function readJob(user) { try { return JSON.parse(fs.readFileSync(jobPath(user), 'utf8')); } catch { return null; } }

// Inicia el paso de credenciales: spawnea el runner PTY de setup-token en el
// espacio del inquilino. Requiere que el token esté LOCKED (ya se auto-registró).
publicRouter.post('/creds-start', (req, res) => {
  const { token } = req.body || {};
  let v;
  try {
    v = validateInvite(token);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo validar la invitación: ' + (e.message || e) });
  }
  if (!v.valid) return res.status(403).json({ error: `Invitación ${v.reason || 'inválida'}.` });
  if (v.status !== 'locked' || !v.lockedTo) return res.status(409).json({ error: 'Registrate primero.' });
  const user = v.lockedTo;
  // Dedup: si ya hay un job fresco en curso, no relanzar.
  const job = readJob(user);
  if (job && ['starting', 'awaiting-code', 'exchanging'].includes(job.status) && (Date.now() - (job.ts || 0)) < 10 * 60 * 1000) {
    return res.json({ ok: true, already: true });
  }
  try {
    // Reserva SINCRÓNICA del job 'starting' en disco ANTES de spawnear (sin
    // ningún await entre el read de arriba y este write, así el event loop no
    // puede intercalar otra request en el medio): dos POST casi simultáneos ya
    // no pueden pasar los dos el dedup y lanzar dos runners para el mismo user
    // (antes el primer 'starting' lo escribía recién el runner hijo, async).
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(jobPath(user), JSON.stringify({ status: 'starting', user, ts: Date.now() }), { mode: 0o600 });
    spawn(process.execPath, [ONBOARD_RUNNER, '--user', user, '--token', token], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    return res.status(500).json({ error: 'No pude lanzar el paso de credenciales: ' + e.message });
  }
  res.json({ ok: true });
});

// Estado del paso de credenciales (poll). Token-gated (peek resuelve el user aun
// tras consumir, para mostrar 'done'). NO expone secretos.
publicRouter.get('/creds-status', (req, res) => {
  const token = req.query?.token;
  let p;
  try {
    p = peekInvite(token);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo consultar la invitación: ' + (e.message || e) });
  }
  if (!p.found) return res.status(403).json({ error: 'Invitación inexistente.' });
  const job = readJob(p.lockedTo) || { status: 'idle' };
  const stale = job.ts && (Date.now() - job.ts) > 30000 && ['starting', 'exchanging'].includes(job.status);
  // SP9-1 (TASK-664): check liviano — ¿el inquilino ya canjeó su suscripción Claude?
  const hasToken = !!(p.lockedTo && readUserOauthToken(p.lockedTo));
  res.json({ status: job.status, url: job.url || null, done: !!job.done, error: job.error || null, stale: !!stale, hasToken });
});

// Recibe el código pegado por el usuario → lo deja en un archivo que el runner lee.
publicRouter.post('/creds-code', (req, res) => {
  const { token, code } = req.body || {};
  let v;
  try {
    v = validateInvite(token);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo validar la invitación: ' + (e.message || e) });
  }
  if (!v.valid) return res.status(403).json({ error: `Invitación ${v.reason || 'inválida'}.` });
  if (v.status !== 'locked' || !v.lockedTo) return res.status(409).json({ error: 'Registrate primero.' });
  const clean = String(code || '').trim();
  if (!clean || clean.length > 4000) return res.status(400).json({ error: 'Código inválido.' });
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(path.join(JOBS_DIR, `${v.lockedTo}.code`), clean, { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ error: 'No pude guardar el código: ' + e.message });
  }
  res.json({ ok: true });
});

export default {
  name: 'onboard',
  registerHttp(router) {
    const r = express.Router();
    r.post('/admin/invite', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin.' });
      if (req.body?.admin !== undefined && typeof req.body.admin !== 'boolean') {
        return res.status(400).json({ error: 'admin debe ser boolean.' });
      }
      try {
        const ttlH = Number(req.body?.ttlHours) > 0 ? Number(req.body.ttlHours) : DEFAULT_TTL_H;
        const invite = generateInvite({ admin: !!req.body?.admin, createdBy: principalOf(req).username, ttlMs: ttlH * 3600 * 1000 });
        res.json({ invite }); // { id, token (crudo, una vez), admin, expiresAt }
      } catch (e) {
        res.status(500).json({ error: e.message || 'No se pudo generar la invitación.' });
      }
    });
    r.get('/admin/invites', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin.' });
      try {
        res.json({ invites: listInvites() });
      } catch (e) {
        res.status(500).json({ error: e.message || 'No se pudieron listar las invitaciones.' });
      }
    });
    r.post('/admin/invite/:id/revoke', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin.' });
      try {
        res.json({ ok: revokeInvite(req.params.id) });
      } catch (e) {
        res.status(500).json({ error: e.message || 'No se pudo revocar la invitación.' });
      }
    });
    router.use('/onboard', r); // → /api/onboard/admin/*
  },
};
