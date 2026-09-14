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
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { config } from '../../core/config.js';
import { createUser, isValidUsername, listUsers, setAwaitingSponsor, setUserLang, setUserSponsor, sponsorshipState } from '../../core/users.js';
import { sponsorTokenReady } from '../../core/sponsorship.js';
import {
  ensureUserSpace,
  hasCodexCreds,
  hasInfisicalCreds,
  readUserOauthToken,
} from '../../core/user-space.js';
import { generateInvite, listInvites, revokeInvite, validateInvite, peekInvite, lockInvite, consumeInvite } from '../../core/onboard-tokens.js';
import {
  blockingFor,
  CAPABILITIES,
  capabilityStatus,
  hasClaudeAccountCreds,
  hasGithubAuth,
  pendingFor,
  requiredFor,
} from './capabilities.js';
import { tolkienMcpStatus } from './tolkien-mcp-shared.js';
import { readProvisionState } from './provision-state.js';
import { provisionNewUser, provisionTolkienBestEffort } from './provision-user.js';
import { myConfigRouter } from './my-config.js';
import { mailScanRouter } from './mail-scan.js';
import { runSmokeChecks } from './smoke.js';

const DEFAULT_TTL_H = 24;

// Rate-limit por IP para la superficie PÚBLICA: las acciones conservan el tope
// anti fuerza-bruta, mientras los *-status tienen un bucket separado y más
// amplio porque el wizard los pollea durante sus pasos largos.
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 30;
const RL_STATUS_MAX = 240;
const rlMap = new Map(); // ip -> { act, status, resetAt }
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let e = rlMap.get(ip);
  if (!e || now > e.resetAt) { e = { act: 0, status: 0, resetAt: now + RL_WINDOW_MS }; rlMap.set(ip, e); }
  const bucket = req.path.endsWith('-status') ? 'status' : 'act';
  const max = bucket === 'status' ? RL_STATUS_MAX : RL_MAX;
  e[bucket] += 1;
  if (rlMap.size > 5000) { for (const [k, v] of rlMap) if (now > v.resetAt) rlMap.delete(k); } // GC oportunista
  if (e[bucket] > max) return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto.' });
  next();
}

// PUBLIC router — lo monta server.js ANTES del gate de auth.
export const publicRouter = express.Router();
publicRouter.use(rateLimit);

function userExists(username) {
  return !!username && listUsers().some((user) => user.username === username);
}

// Resuelve el usuario habilitado a ejecutar un paso del wizard. Acepta la
// invitación LOCKED (alta en curso) y también la ya CONSUMIDA cuyo usuario
// existe: es la reentrada para completar pasos pendientes (Codex/Infisical),
// que nunca puede registrar a nadie porque /register sigue exigiendo
// validateInvite. Una invitación REVOCADA no habilita nada.
function stepUser(token) {
  let v;
  try {
    v = validateInvite(token);
  } catch (e) {
    return {
      statusCode: 500,
      error: 'No se pudo validar la invitación: ' + (e.message || e),
    };
  }
  if (v.valid) {
    if (v.status === 'locked' && v.lockedTo) return { user: v.lockedTo };
    return { statusCode: 409, error: 'Registrate primero.' };
  }
  if (v.reason === 'ya usado') {
    let p;
    try {
      p = peekInvite(token);
    } catch (e) {
      return {
        statusCode: 500,
        error: 'No se pudo validar la invitación: ' + (e.message || e),
      };
    }
    if (p.found && p.status === 'consumed' && p.lockedTo) {
      if (userExists(p.lockedTo)) return { user: p.lockedTo };
      return { statusCode: 409, error: 'Registrate primero.' };
    }
  }
  return {
    statusCode: 403,
    error: `Invitación ${v.reason || 'inválida'}.`,
  };
}

publicRouter.post('/validate', (req, res) => {
  try {
    const token = req.body?.token;
    const v = validateInvite(token);
    // validateInvite mantiene su semántica estricta: una invitación consumida
    // sigue siendo inválida. Solo para armar el checklist de reentrada leemos
    // su metadata leniente y recuperamos el usuario al que había quedado atada.
    let meta = v;
    if (!v.valid && v.reason === 'ya usado') {
      const p = peekInvite(token);
      if (p.found) meta = { ...v, ...p };
    }
    const lockedTo = meta.lockedTo || null;
    const status = meta.status || null;
    const capability = capabilityStatus(lockedTo);
    const hasToken = capability.claude;
    const hasClaudeAccount = capability.account;
    const hasCodex = capability.codex;
    const hasInfisical = capability.infisical;
    const hasGithub = capability.github;
    const hasTolkienMcp = !!(lockedTo && tolkienMcpStatus(lockedTo).registered);
    const pending = pendingFor(lockedTo);
    const capabilities = [...CAPABILITIES]
      .sort((a, b) => a.order - b.order)
      .map((item) => ({
        id: item.id,
        required: requiredFor(item, lockedTo),
        labelEs: item.labelEs,
        complete: !!capability[item.id],
      }));
    const resume = !!(lockedTo && status !== 'revoked' && userExists(lockedTo));
    res.json({
      valid: v.valid,
      admin: meta.admin || false,
      sponsored: meta.sponsored || false,
      sponsor: meta.sponsor || null,
      reason: v.reason || null,
      status,
      lockedTo,
      hasToken,
      hasClaudeAccount,
      hasCodex,
      hasInfisical,
      hasGithub,
      hasTolkienMcp,
      pending,
      capabilities,
      resume,
    });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo validar la invitación: ' + (e.message || e) });
  }
});

publicRouter.post('/register', (req, res) => {
  const { token, username, password, lang } = req.body || {};
  let v;
  try {
    v = validateInvite(token, { forUsername: username });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo validar la invitación: ' + (e.message || e) });
  }
  if (!v.valid) return res.status(403).json({ error: `Invitación ${v.reason || 'inválida'}.` });
  if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Falta el campo "username" en el body (letras, números, . _ - ; máx 32).' });
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Usuario inválido: el campo "username" admite letras, números, . _ - ; máx 32.' });
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
    createUser(username, password, !!v.admin && !v.sponsored); // patrocinado NUNCA nace admin
  } catch (e) {
    return res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo crear el usuario.' });
  }
  if (v.sponsored) {
    const planned = typeof v.sponsor === 'string' && v.sponsor ? v.sponsor : null;
    // El sponsor previsto se RE-VALIDA acá: entre la invitación y el alta pudo
    // perder su token propio o pasar a ser patrocinado él mismo.
    const usable = planned && sponsorshipState(planned) === 'none' && sponsorTokenReady(planned);
    try {
      if (usable) setUserSponsor(username, planned);
      else setAwaitingSponsor(username);
    } catch (e) {
      console.error('[onboard] No se pudo fijar el patrocinio del alta:', e.message || e);
      try { setAwaitingSponsor(username); } catch { /* la marca es recuperable desde el panel de Usuarios */ }
    }
  }
  if (lang === 'es' || lang === 'en') {
    try { setUserLang(username, lang); } catch { /* best-effort: el default sigue siendo 'es' */ }
  }
  provisionNewUser(username);
  res.json({ ok: true, username });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONBOARD_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-onboard-runner.js');
const JOBS_DIR = path.join(config.home, '.cwc-data', 'onboard-jobs');
const CLAUDE_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-claude-login-runner.js');
const CLAUDE_LOGIN_JOBS_DIR = path.join(config.home, '.cwc-data', 'claude-login-jobs');
const CODEX_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-codex-login-runner.js');
const CODEX_JOBS_DIR = path.join(config.home, '.cwc-data', 'codex-login-jobs');
const GH_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-gh-login-runner.js');
const GH_JOBS_DIR = path.join(config.home, '.cwc-data', 'gh-login-jobs');
const INFISICAL_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-infisical-login-runner.js');
const INFISICAL_JOBS_DIR = path.join(config.home, '.cwc-data', 'infisical-login');
function jobPath(user) { return path.join(JOBS_DIR, `${user}.json`); }
function readJob(user) { try { return JSON.parse(fs.readFileSync(jobPath(user), 'utf8')); } catch { return null; } }
// ¿El runner de ESE job sigue vivo? Miramos el pid persistido y confirmamos
// por /proc que sea realmente nuestro runner (un pid se recicla).
function runnerAlive(job) {
  const pid = Number(job?.pid);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cwc-onboard-runner.js'); }
  catch { return false; }
}
function claudeLoginJobPath(user) { return path.join(CLAUDE_LOGIN_JOBS_DIR, `${user}.json`); }
function claudeLoginCodePath(user) { return path.join(CLAUDE_LOGIN_JOBS_DIR, `${user}.code`); }
const CLAUDE_LOGIN_TERMINAL_TTL_MS = 10 * 60 * 1000;
function readClaudeLoginJob(user) {
  try { return JSON.parse(fs.readFileSync(claudeLoginJobPath(user), 'utf8')); } catch { return null; }
}
// Un job terminal viejo hacía que el modal mostrara "ya estás conectado" y
// nunca relanzara el login; pasado el TTL debe volver a comportarse como idle.
function claudeLoginJobIsStale(job) {
  return ['ok', 'error', 'cancelled'].includes(job?.status)
    && Date.now() - (job.ts || 0) > CLAUDE_LOGIN_TERMINAL_TTL_MS;
}
function writeClaudeLoginJob(user, job) {
  fs.mkdirSync(CLAUDE_LOGIN_JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    claudeLoginJobPath(user),
    JSON.stringify({ ...job, user, ts: Date.now() }),
    { mode: 0o600 },
  );
}
function claudeLoginRunnerAlive(job) {
  const pid = Number(job?.pid);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cwc-claude-login-runner.js');
  } catch {
    return false;
  }
}
function codexJobPath(user) { return path.join(CODEX_JOBS_DIR, `${user}.json`); }
function readCodexJob(user) { try { return JSON.parse(fs.readFileSync(codexJobPath(user), 'utf8')); } catch { return null; } }
function ghJobPath(user) { return path.join(GH_JOBS_DIR, `${user}.json`); }
function readGhJob(user) { try { return JSON.parse(fs.readFileSync(ghJobPath(user), 'utf8')); } catch { return null; } }
function ghLoginRunnerAlive(job) {
  const pid = Number(job?.pid);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cwc-gh-login-runner.js');
  } catch {
    return false;
  }
}
function infisicalJobPath(user) { return path.join(INFISICAL_JOBS_DIR, `${user}.json`); }
function infisicalTokenPath(user) { return path.join(INFISICAL_JOBS_DIR, `${user}.token`); }
function readInfisicalJob(user) {
  try { return JSON.parse(fs.readFileSync(infisicalJobPath(user), 'utf8')); } catch { return null; }
}

// Inicia el paso de credenciales: spawnea el runner PTY de setup-token en el
// espacio del inquilino. stepUser también admite la reentrada consumida segura.
publicRouter.post('/creds-start', (req, res) => {
  const { token } = req.body || {};
  const step = stepUser(token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const user = step.user;
  // Dedup: preservar un awaiting-code vivo y proteger starting/exchanging
  // durante su primer minuto. Un job huérfano nunca bloquea el reintento.
  const job = readJob(user);
  const alive = runnerAlive(job);
  if (job && ['starting', 'awaiting-code', 'exchanging'].includes(job.status) && alive
      && (job.status === 'awaiting-code' || (Date.now() - (job.ts || 0)) < 60_000)) {
    return res.json({ ok: true, already: true });
  }
  if (alive) {
    try { process.kill(Number(job.pid), 'SIGTERM'); } catch { /* ya terminó */ }
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
  res.json({
    status: job.status,
    url: job.url || null,
    note: job.note || null,
    done: !!job.done,
    error: job.error || null,
    stale: !!stale,
    hasToken,
  });
});

// Estado del provisioning posterior al alta (lo pollea el checklist final del
// wizard — console:BUG-2118). Mismo gate que los demás *-status del router
// PÚBLICO: la invitación es la única llave, `stepUser` resuelve el usuario aun
// con el token ya consumido, y el sufijo `-status` lo mete en el bucket amplio
// del rate-limit. NO expone rutas ni secretos: el motivo ya se guardó saneado en
// disco y acá se recorta.
function publicProvisionState(user) {
  const state = user ? readProvisionState(user) : null;
  if (!state) return { status: 'idle', steps: {} };
  const steps = {};
  for (const [name, s] of Object.entries(state.steps || {})) {
    steps[name] = { status: s.status, ...(s.error ? { error: String(s.error).slice(0, 160) } : {}) };
  }
  const stale = state.status === 'pending' && !!state.ts && (Date.now() - state.ts) > 10 * 60 * 1000;
  return { status: state.status || 'pending', steps, stale };
}

publicRouter.get('/provision-status', (req, res) => {
  const step = stepUser(req.query?.token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  res.json(publicProvisionState(step.user));
});

publicRouter.post('/provision-retry', (req, res) => {
  const step = stepUser(req.body?.token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  provisionNewUser(step.user);
  res.json(publicProvisionState(step.user));
});

// Pruebas reales previas al cierre. Es una ACCIÓN (no termina en *-status)
// porque consulta servicios externos y debe conservar el rate-limit estricto.
// El usuario sale únicamente de la invitación; nunca se acepta por body.
publicRouter.post('/smoke', async (req, res) => {
  const step = stepUser(req.body?.token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  try {
    res.json(await runSmokeChecks(step.user));
  } catch {
    res.status(500).json({ error: 'No se pudieron ejecutar las pruebas de verificación.' });
  }
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

// El setup-token obligatorio alcanza para correr modelos, pero no tiene los
// scopes de cuenta que necesita el medidor de uso. Este login completo es
// OPCIONAL y comparte runner/job con ⚙ Sistema → Uso para poder retomarlo.
publicRouter.post('/claude-account-start', (req, res) => {
  const { token } = req.body || {};
  const step = stepUser(token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const user = step.user;
  if (hasClaudeAccountCreds(user)) {
    return res.json({ ok: true, already: true, connected: true });
  }

  const job = readClaudeLoginJob(user);
  const reserved = job?.status === 'starting'
    && !!job.ts
    && (Date.now() - job.ts) < 30_000;
  if (reserved || claudeLoginRunnerAlive(job)) {
    return res.json({ ok: true, already: true, status: job.status || 'starting' });
  }

  try {
    writeClaudeLoginJob(user, { status: 'starting' });
    try { fs.unlinkSync(claudeLoginCodePath(user)); } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    spawn(process.execPath, [CLAUDE_LOGIN_RUNNER, '--user', user], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (e) {
    try { writeClaudeLoginJob(user, { status: 'error', error: 'No pude lanzar el login de Claude.' }); } catch { /* noop */ }
    return res.status(500).json({ error: 'No pude lanzar el login de Claude: ' + e.message });
  }
  res.json({ ok: true, status: 'starting' });
});

publicRouter.get('/claude-account-status', (req, res) => {
  const step = stepUser(req.query?.token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const job = readClaudeLoginJob(step.user);
  if (hasClaudeAccountCreds(step.user)) return res.json({ status: 'ok' });
  if (!job || claudeLoginJobIsStale(job)) return res.json({ status: 'idle' });
  res.json({
    status: job.status || 'error',
    ...(job.url ? { url: job.url } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
});

publicRouter.post('/claude-account-code', (req, res) => {
  const { token } = req.body || {};
  const step = stepUser(token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const job = readClaudeLoginJob(step.user);
  if (!job || job.status !== 'waiting-code' || !claudeLoginRunnerAlive(job)) {
    return res.status(400).json({ error: 'No hay un login de Claude esperando un código.' });
  }

  const rawCode = req.body?.code;
  if (typeof rawCode !== 'string') {
    return res.status(400).json({ error: 'El código de autorización no es válido.' });
  }
  const code = rawCode.trim();
  if (!code || code.length > 512 || /[\r\n]/.test(code)) {
    return res.status(400).json({ error: 'El código de autorización no es válido.' });
  }

  try {
    fs.writeFileSync(claudeLoginCodePath(step.user), code, { mode: 0o600 });
    fs.chmodSync(claudeLoginCodePath(step.user), 0o600);
  } catch (e) {
    return res.status(500).json({ error: 'No pude enviar el código al login de Claude: ' + e.message });
  }
  res.json({ ok: true });
});

// Codex usa device-auth porque el login normal abre un callback en
// localhost:1455, inservible desde un server remoto. Es obligatorio y /finish
// vuelve a comprobar la credencial en el servidor.
publicRouter.post('/codex-start', (req, res) => {
  const { token } = req.body || {};
  const step = stepUser(token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const user = step.user;
  const job = readCodexJob(user);
  if (job && ['starting', 'awaiting-auth'].includes(job.status) && (Date.now() - (job.ts || 0)) < 15 * 60 * 1000) {
    return res.json({ ok: true, already: true });
  }
  if (hasCodexCreds(user)) {
    return res.json({ ok: true, already: true, connected: true });
  }
  try {
    fs.mkdirSync(CODEX_JOBS_DIR, { recursive: true });
    fs.writeFileSync(codexJobPath(user), JSON.stringify({ status: 'starting', user, ts: Date.now() }), { mode: 0o600 });
    spawn(process.execPath, [CODEX_LOGIN_RUNNER, '--user', user], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    return res.status(500).json({ error: 'No pude lanzar el login de Codex: ' + e.message });
  }
  res.json({ ok: true });
});

publicRouter.get('/codex-status', (req, res) => {
  const token = req.query?.token;
  let p;
  try {
    p = peekInvite(token);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo consultar la invitación: ' + (e.message || e) });
  }
  if (!p.found) return res.status(403).json({ error: 'Invitación inexistente.' });
  const job = readCodexJob(p.lockedTo) || { status: 'idle' };
  const stale = job.status === 'starting' && !!job.ts && (Date.now() - job.ts) > 30000;
  const connected = !!(p.lockedTo && hasCodexCreds(p.lockedTo));
  res.json({
    status: job.status,
    url: job.url || null,
    code: job.code || null,
    done: !!job.done,
    error: job.error || null,
    stale: !!stale,
    connected,
  });
});

// GitHub usa el device flow del CLI: el runner publica el código de un solo
// uso y corre siempre con el HOME aislado del usuario resuelto por el token.
publicRouter.post('/github-start', (req, res) => {
  const step = stepUser(req.body?.token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const user = step.user;
  if (hasGithubAuth(user)) {
    return res.json({ ok: true, already: true, connected: true });
  }
  const job = readGhJob(user);
  const reserved = job?.status === 'starting'
    && !!job.ts
    && (Date.now() - job.ts) < 30_000;
  const alive = ghLoginRunnerAlive(job);
  if (reserved || (
    ['awaiting-auth', 'setup-git'].includes(job?.status)
    && alive
  ) || (
    job?.status === 'starting'
    && alive
    && (Date.now() - (job.ts || 0)) <= 60_000
  )) {
    return res.json({ ok: true, already: true, status: job.status || 'starting' });
  }
  if (job?.status === 'starting' && alive) {
    try { process.kill(Number(job.pid), 'SIGTERM'); } catch { /* ya terminó */ }
  }
  try {
    writeJsonAtomic(ghJobPath(user), {
      status: 'starting',
      user,
      ts: Date.now(),
    }, { mode: 0o600 });
    spawn(process.execPath, [GH_LOGIN_RUNNER, '--user', user], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (e) {
    return res.status(500).json({ error: 'No pude lanzar el login de GitHub: ' + e.message });
  }
  res.json({ ok: true, status: 'starting' });
});

publicRouter.get('/github-status', (req, res) => {
  const step = stepUser(req.query?.token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const job = readGhJob(step.user) || { status: 'idle' };
  const stale = job.status === 'starting' && !!job.ts && (Date.now() - job.ts) > 30_000;
  res.json({
    status: job.status,
    url: job.url || null,
    code: job.code || null,
    done: !!job.done,
    error: job.error || null,
    stale,
    connected: hasGithubAuth(step.user),
  });
});

publicRouter.post('/infisical-start', (req, res) => {
  const { token } = req.body || {};
  const step = stepUser(token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const user = step.user;
  const job = readInfisicalJob(user);
  if (job && ['starting', 'awaiting-url', 'exchanging', 'verifying'].includes(job.status)
      && (Date.now() - (job.ts || 0)) < 10 * 60 * 1000) {
    return res.json({ ok: true, already: true });
  }
  if (hasInfisicalCreds(user)) {
    return res.json({ ok: true, already: true, connected: true });
  }
  try {
    fs.mkdirSync(INFISICAL_JOBS_DIR, { recursive: true });
    // Un buzón viejo nunca puede inyectarse en una corrida nueva.
    try { fs.unlinkSync(infisicalTokenPath(user)); } catch { /* inexistente */ }
    fs.writeFileSync(
      infisicalJobPath(user),
      JSON.stringify({ status: 'starting', id: user, ts: Date.now() }),
      { mode: 0o600 },
    );
    spawn(process.execPath, [
      INFISICAL_LOGIN_RUNNER,
      '--id', user,
      '--user', user,
      '--domain', 'https://app.infisical.com',
    ], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    return res.status(500).json({ error: 'No pude lanzar el login de Infisical: ' + e.message });
  }
  res.json({ ok: true });
});

publicRouter.get('/infisical-status', (req, res) => {
  const token = req.query?.token;
  let p;
  try {
    p = peekInvite(token);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo consultar la invitación: ' + (e.message || e) });
  }
  if (!p.found) return res.status(403).json({ error: 'Invitación inexistente.' });
  const job = p.lockedTo ? readInfisicalJob(p.lockedTo) : null;
  const state = job || { status: 'idle' };
  const stale = state.status === 'starting' && !!state.ts && (Date.now() - state.ts) > 30000;
  const hasInfisical = !!(p.lockedTo && hasInfisicalCreds(p.lockedTo));
  res.json({
    status: state.status,
    url: state.url || null,
    error: state.error || null,
    stale: !!stale,
    hasInfisical,
  });
});

publicRouter.post('/infisical-token', (req, res) => {
  const { token, value } = req.body || {};
  const step = stepUser(token);
  if (!step.user) return res.status(step.statusCode).json({ error: step.error });
  const clean = String(value || '').trim();
  if (!clean || clean.length > 4000) return res.status(400).json({ error: 'Token inválido.' });
  try {
    fs.mkdirSync(INFISICAL_JOBS_DIR, { recursive: true });
    fs.writeFileSync(infisicalTokenPath(step.user), clean, { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ error: 'No pude guardar el token: ' + e.message });
  }
  res.json({ ok: true });
});

// PLAN-500: el consumo vive en el cierre explícito, no en el runner de Claude,
// para que Claude y los pasos posteriores (Codex/Infisical/GitHub) validen el token
// durante TODO el wizard. Si el usuario abandona antes, queda locked a SU
// username hasta el TTL: es la misma ventana que ya existía entre registro y
// credenciales.
publicRouter.post('/finish', (req, res) => {
  const { token } = req.body || {};
  let v;
  try {
    v = validateInvite(token);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo validar la invitación: ' + (e.message || e) });
  }
  if (!v.valid) return res.status(403).json({ error: `Invitación ${v.reason || 'inválida'}.` });
  if (v.status !== 'locked' || !v.lockedTo) return res.status(409).json({ error: 'Registrate primero.' });
  const blocking = blockingFor(v.lockedTo);
  if (blocking.length) {
    const labels = blocking.map((id) => (
      CAPABILITIES.find((capability) => capability.id === id)?.labelEs || id
    ));
    return res.status(409).json({
      error: `Faltan pasos obligatorios: ${labels.join(', ')}.`,
      blocking,
    });
  }
  void provisionTolkienBestEffort(v.lockedTo);
  try {
    if (!consumeInvite(token)) return res.json({ ok: true, already: true });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo cerrar la invitación: ' + (e.message || e) });
  }
  res.json({ ok: true });
});

export default {
  name: 'onboard',
  registerHttp(router) {
    const r = express.Router();
    r.use(myConfigRouter);
    r.use(mailScanRouter);
    r.post('/admin/invite', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin.' });
      if (req.body?.admin !== undefined && typeof req.body.admin !== 'boolean') {
        return res.status(400).json({ error: 'admin debe ser boolean.' });
      }
      if (req.body?.sponsored !== undefined && typeof req.body.sponsored !== 'boolean') {
        return res.status(400).json({ error: 'sponsored debe ser boolean.' });
      }
      if (req.body?.admin === true && req.body?.sponsored === true) {
        return res.status(400).json({ error: 'admin y sponsored son mutuamente excluyentes.' });
      }
      if (req.body?.sponsor !== undefined && req.body?.sponsor !== null
        && (typeof req.body.sponsor !== 'string' || !req.body.sponsor.trim())) {
        return res.status(400).json({ error: 'sponsor debe ser un string no vacío.' });
      }
      const sponsor = typeof req.body?.sponsor === 'string' ? req.body.sponsor.trim() : null;
      if (sponsor && req.body?.sponsored !== true) {
        return res.status(400).json({ error: 'Solo una invitación patrocinada puede llevar sponsor.' });
      }
      if (sponsor && !listUsers().some((u) => u.username === sponsor)) {
        return res.status(400).json({ error: 'El sponsor indicado no existe.' });
      }
      if (sponsor && sponsorshipState(sponsor) !== 'none') {
        return res.status(400).json({ error: 'Un usuario patrocinado no puede patrocinar a otro usuario.' });
      }
      if (sponsor && !sponsorTokenReady(sponsor)) {
        return res.status(400).json({ error: `El sponsor ${sponsor} no tiene listo su token propio de patrocinio.` });
      }
      try {
        const ttlH = Number(req.body?.ttlHours) > 0 ? Number(req.body.ttlHours) : DEFAULT_TTL_H;
        const invite = generateInvite({ admin: !!req.body?.admin, sponsored: !!req.body?.sponsored, sponsor, createdBy: principalOf(req).username, ttlMs: ttlH * 3600 * 1000 });
        res.json({ invite }); // { id, token (crudo, una vez), admin, sponsored, sponsor, expiresAt }
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
