// modules/connections/index.js — endpoints de credenciales para conectores externos.
//
// Este módulo existe para exponer una capa HTTP chica sobre el store y los
// proveedores ya implementados: la configuración OAuth puede venir de la app
// global (admin-only) o de un override completo del usuario, mientras que los
// tokens y API keys quedan siempre por usuario. Por eso el deviceCode de
// Microsoft se persiste en el job (mode 600, directorio privado del usuario)
// para que el canje sobreviva a reinicios; ningún endpoint devuelve ni loguea
// tokens, API keys, secrets o códigos internos.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { principalOf, isAdmin } from '../../core/auth.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { config } from '../../core/config.js';
import {
  codexCredState,
  hostUser,
  userClaudeDir,
  userDataDir,
  userOauthTokenPath,
} from '../../core/user-space.js';
import {
  PROVIDERS,
  readAppConfig,
  writeAppConfig,
  appConfigured,
  readUserAppConfig,
  writeUserAppConfig,
  clearUserAppConfig,
  userAppComplete,
  effectiveAppConfig,
  appConfiguredFor,
  readConnection,
  writeConnection,
  getAccessToken,
  getApiCredential,
  deleteConnection,
  cancelAttempts,
  connectionStatus,
  lastAttempt,
  newJobId,
  readJob,
  writeJob,
  JOB_ID_RE,
} from '../../core/connections-store.js';
import {
  MS_SCOPES,
  startDeviceFlow,
  pollDeviceToken,
  getMe as getMicrosoftMe,
} from '../../core/connections-microsoft.js';
import {
  ZOHO_SCOPES,
  authUrl,
  exchangeCode,
  explainZohoError,
  getOrg,
  getMe as getZohoMe,
} from '../../core/connections-zoho.js';
import {
  freshserviceBaseUrl,
  verifyFreshservice,
} from '../../core/connections-freshservice.js';
import {
  deleteTolkienConnection,
  isValidTolkienCookie,
  tolkienStatus,
} from '../../core/connections-tolkien.js';
import { hasGithubAuth } from '../onboard/capabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-codex-login-runner.js');
const CODEX_LOGIN_JOBS_DIR = path.join(config.home, '.cwc-data', 'codex-login-jobs');
const GH_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-gh-login-runner.js');
const GH_JOBS_DIR = path.join(config.home, '.cwc-data', 'gh-login-jobs');
const CLAUDE_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-claude-login-runner.js');
const CLAUDE_LOGIN_JOBS_DIR = path.join(config.home, '.cwc-data', 'claude-login-jobs');
const PAD_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-pad-login-runner.js');
const PAD_LOGIN_JOBS_DIR = path.join(config.home, '.cwc-data', 'pad-login-jobs');
const TOLKIEN_LOGIN_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-tolkien-login-runner.js');
const TOLKIEN_LOGIN_JOBS_DIR = path.join(config.home, '.cwc-data', 'tolkien-login-jobs');
function codexLoginJobPath(user) { return path.join(CODEX_LOGIN_JOBS_DIR, `${user}.json`); }
function readCodexLoginJob(user) {
  try { return JSON.parse(fs.readFileSync(codexLoginJobPath(user), 'utf8')); } catch { return null; }
}
function writeCodexLoginJob(user, job) {
  fs.mkdirSync(CODEX_LOGIN_JOBS_DIR, { recursive: true });
  fs.writeFileSync(
    codexLoginJobPath(user),
    JSON.stringify({ ...job, user, ts: Date.now() }),
    { mode: 0o600 },
  );
}
// Estos helpers duplican deliberadamente el contrato corto de onboarding:
// mantener ambos módulos desacoplados evita que un refactor cambie los dos flujos.
function ghJobPath(user) { return path.join(GH_JOBS_DIR, `${user}.json`); }
function readGhJob(user) {
  try { return JSON.parse(fs.readFileSync(ghJobPath(user), 'utf8')); } catch { return null; }
}
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
function claudeLoginJobPath(user) { return path.join(CLAUDE_LOGIN_JOBS_DIR, `${user}.json`); }
function claudeLoginCodePath(user) { return path.join(CLAUDE_LOGIN_JOBS_DIR, `${user}.code`); }
function claudeLoginLogPath(user) { return path.join(CLAUDE_LOGIN_JOBS_DIR, `${user}.log`); }
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
function cleanClaudeLoginJob(user) {
  for (const file of [
    claudeLoginJobPath(user),
    claudeLoginCodePath(user),
    claudeLoginLogPath(user),
  ]) {
    try { fs.unlinkSync(file); } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
}
function padLoginJobPath(user) { return path.join(PAD_LOGIN_JOBS_DIR, `${user}.json`); }
function readPadLoginJob(user) {
  try { return JSON.parse(fs.readFileSync(padLoginJobPath(user), 'utf8')); } catch { return null; }
}
function writePadLoginJob(user, job) {
  fs.mkdirSync(PAD_LOGIN_JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(PAD_LOGIN_JOBS_DIR, 0o700);
  writeJsonAtomic(padLoginJobPath(user), {
    ...job,
    user,
    ts: Date.now(),
  }, { mode: 0o600 });
}
function padLoginRunnerAlive(job) {
  const pid = Number(job?.pid);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cwc-pad-login-runner.js');
  } catch {
    return false;
  }
}
function tolkienLoginJobPath(user) { return path.join(TOLKIEN_LOGIN_JOBS_DIR, `${user}.json`); }
function readTolkienLoginJob(user) {
  try { return JSON.parse(fs.readFileSync(tolkienLoginJobPath(user), 'utf8')); } catch { return null; }
}
function writeTolkienLoginJob(user, job) {
  fs.mkdirSync(TOLKIEN_LOGIN_JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(TOLKIEN_LOGIN_JOBS_DIR, 0o700);
  writeJsonAtomic(tolkienLoginJobPath(user), {
    ...job,
    user,
    ts: Date.now(),
  }, { mode: 0o600 });
}
function tolkienLoginRunnerAlive(job) {
  const pid = Number(job?.pid);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cwc-tolkien-login-runner.js');
  } catch {
    return false;
  }
}
function claudeCredentialSource(user) {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(userClaudeDir(user), '.credentials.json'), 'utf8'),
    );
    if (
      typeof data?.claudeAiOauth?.accessToken === 'string'
      && data.claudeAiOauth.accessToken.length > 0
    ) {
      return 'credentials';
    }
  } catch { /* fallback al setup-token */ }
  try {
    if (fs.existsSync(userOauthTokenPath(user))) return 'setup-token';
  } catch { /* sin credencial */ }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const activePolls = new Set();

function pollKey(username, jobId) {
  return `${username}:${jobId}`;
}

function userOf(req) {
  const p = principalOf(req);
  // El token maestro no representa a una persona concreta; para mantener la
  // retrocompatibilidad de los datos locales cae al usuario host.
  return p?.username || hostUser();
}

function reqProvider(req, res) {
  const provider = req.params.provider;
  if (!isOAuthProvider(provider)) {
    res.status(400).json({ error: 'Proveedor desconocido.' });
    return null;
  }
  return provider;
}

function isOAuthProvider(provider) {
  return PROVIDERS.some((p) => p.id === provider && p.kind === 'oauth');
}

function labelOf(provider) {
  return PROVIDERS.find((p) => p.id === provider)?.label || provider;
}

function scopesForResponse(username, provider, requestedScopes) {
  const conn = readConnection(username, provider);
  const requested = Array.isArray(requestedScopes) ? requestedScopes : [];
  const grantedScopes = Array.isArray(conn?.scopes) ? conn.scopes : [];
  const hasStoredScopes = grantedScopes.length > 0;
  const connected = !!conn && !conn.error;
  const grantedSet = new Set(grantedScopes.map((s) => String(s).toLowerCase()));
  const missingScopes = connected && hasStoredScopes
    ? requested.filter((s) => !grantedSet.has(String(s).toLowerCase()))
    : [];
  return { grantedScopes, missingScopes };
}

function patchJob(username, jobId, fields) {
  try {
    const job = readJob(username, jobId);
    if (!job) return;
    writeJob(username, jobId, { ...job, ...fields });
  } catch {
    // El polling no debe tumbar el proceso por una carrera de archivos.
  }
}

async function pollMicrosoft(username, jobId, {
  clientId,
  tenantId,
  appSource,
  deviceCode,
  interval,
  expiresIn,
}) {
  activePolls.add(pollKey(username, jobId));
  try {
    let waitMs = Math.max(interval, 5) * 1000;
    const deadline = Date.now() + expiresIn * 1000;

    while (Date.now() < deadline) {
      await sleep(waitMs);

      let job;
      try {
        job = readJob(username, jobId);
      } catch {
        return;
      }
      if (!job || job.status !== 'pending') return;

      let result;
      try {
        result = await pollDeviceToken({ clientId, tenantId, deviceCode });
      } catch (e) {
        patchJob(username, jobId, { status: 'error', error: e.message });
        return;
      }

      if (result.status === 'slow_down') {
        waitMs += 5000;
        continue;
      }
      if (result.status === 'pending') continue;
      if (result.status === 'ok') {
        try {
          const account = await getMicrosoftMe(result.tokens.access_token);
          writeConnection(username, 'microsoft', {
            provider: 'microsoft',
            appClientId: clientId,
            appSource,
            account,
            accessToken: result.tokens.access_token,
            refreshToken: result.tokens.refresh_token || null,
            expiresAt: Date.now() + (Number(result.tokens.expires_in) || 3600) * 1000,
            scopes: MS_SCOPES,
            connectedAt: new Date().toISOString(),
            error: null,
          });
          patchJob(username, jobId, { status: 'connected', account, error: null });
        } catch (e) {
          patchJob(username, jobId, { status: 'error', error: e.message });
        }
        return;
      }
    }

    patchJob(username, jobId, {
      status: 'error',
      error: 'El código expiró antes de que se completara la autorización.',
    });
  } finally {
    activePolls.delete(pollKey(username, jobId));
  }
}

function asyncHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

function appConfigResponse() {
  const cfg = readAppConfig();
  return {
    microsoft: {
      clientId: cfg.microsoft.clientId,
      tenantId: cfg.microsoft.tenantId,
    },
    zoho: {
      clientId: cfg.zoho.clientId,
      dc: cfg.zoho.dc,
      hasSecret: !!cfg.zoho.clientSecret,
    },
  };
}

// Auto-reparación: las conexiones creadas antes del fix de identidad quedaron
// sin account/agentId. Como el refresh token ya está guardado, se resuelve sin
// re-hacer OAuth (el grant code de Zoho es de un solo uso). Best-effort: nunca
// rompe la consulta de estado.
async function healZohoIdentity(username) {
  try {
    const conn = readConnection(username, 'zoho');
    if (!conn || !conn.refreshToken || conn.agentId) return;
    const token = await getAccessToken(username, 'zoho');
    if (!token) return;
    const { dc } = effectiveAppConfig(username, 'zoho');
    const me = await getZohoMe(token, dc, conn.orgId, config.instance?.identity?.email);
    if (!me) return;
    writeConnection(username, 'zoho', {
      ...conn,
      account: me.email || conn.account || null,
      agentId: me.id || null,
      agentName: me.name || null,
    });
  } catch {
    // Si falla, la tarjeta simplemente sigue sin nombre; no se rompe nada.
  }
}

export default {
  name: 'connections',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', asyncHandler(async (req, res) => {
      const username = userOf(req);
      await healZohoIdentity(username);
      res.json({
        providers: PROVIDERS.map((p) => {
          const isOauth = p.kind === 'oauth';
          const { grantedScopes, missingScopes } = scopesForResponse(username, p.id, p.scopes);
          return {
            id: p.id,
            label: p.label,
            kind: p.kind,
            scopes: p.scopes,
            grantedScopes,
            missingScopes,
            configured: !isOauth || appConfiguredFor(username, p.id),
            appSource: isOauth && userAppComplete(username, p.id)
              ? 'user'
              : (isOauth && appConfigured(p.id) ? 'instance' : 'none'),
            ...connectionStatus(username, p.id),
            lastAttempt: isOauth ? lastAttempt(username, p.id) : null,
          };
        }),
        isAdmin: isAdmin(req),
      });
    }));

    r.get('/app', asyncHandler((req, res) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: 'Solo un administrador puede ver la configuración de la app OAuth.' });
      }
      res.json(appConfigResponse());
    }));

    r.post('/app', asyncHandler((req, res) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: 'Solo un administrador puede ver la configuración de la app OAuth.' });
      }

      const body = req.body || {};
      const { provider } = body;
      if (!isOAuthProvider(provider)) return res.status(400).json({ error: 'Proveedor desconocido.' });

      const keys = provider === 'microsoft' ? ['clientId', 'tenantId'] : ['clientId', 'clientSecret', 'dc'];
      const patch = {};
      for (const key of keys) {
        if (Object.hasOwn(body, key)) patch[key] = body[key];
      }

      try {
        writeAppConfig({ [provider]: patch });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      res.json({ ok: true });
    }));

    r.get('/app/mine', asyncHandler((req, res) => {
      const username = userOf(req);
      const mine = readUserAppConfig(username);
      const instance = {
        microsoft: appConfigured('microsoft'),
        zoho: appConfigured('zoho'),
      };
      const configured = {
        microsoft: userAppComplete(username, 'microsoft'),
        zoho: userAppComplete(username, 'zoho'),
      };

      res.json({
        providers: {
          microsoft: {
            clientId: mine.microsoft.clientId,
            tenantId: mine.microsoft.tenantId,
            hasSecret: false,
            configured: configured.microsoft,
          },
          zoho: {
            clientId: mine.zoho.clientId,
            dc: mine.zoho.dc || 'com',
            hasSecret: !!mine.zoho.clientSecret,
            configured: configured.zoho,
          },
        },
        instance,
        effective: {
          microsoft: configured.microsoft ? 'user' : (instance.microsoft ? 'instance' : 'none'),
          zoho: configured.zoho ? 'user' : (instance.zoho ? 'instance' : 'none'),
        },
      });
    }));

    r.post('/app/mine', asyncHandler((req, res) => {
      const username = userOf(req);
      const body = req.body || {};
      const { provider } = body;
      if (!isOAuthProvider(provider)) return res.status(400).json({ error: 'Proveedor desconocido.' });

      const clientId = String(body.clientId || '').trim();
      if (!clientId) return res.status(400).json({ error: 'Falta el Client ID.' });

      const patch = { clientId };
      if (provider === 'microsoft') {
        if (Object.hasOwn(body, 'tenantId')) patch.tenantId = body.tenantId;
      } else {
        const existing = readUserAppConfig(username).zoho;
        const clientSecret = String(body.clientSecret || '').trim();
        if (!clientSecret && !existing.clientSecret) {
          return res.status(400).json({ error: 'Falta el Client Secret.' });
        }
        if (clientSecret) patch.clientSecret = clientSecret;
        if (Object.hasOwn(body, 'dc')) patch.dc = body.dc;
      }

      writeUserAppConfig(username, { [provider]: patch });
      res.json({
        ok: true,
        configured: userAppComplete(username, provider),
        source: 'user',
      });
    }));

    r.post('/app/mine/reset', asyncHandler((req, res) => {
      const username = userOf(req);
      const provider = req.body?.provider;
      if (!isOAuthProvider(provider)) return res.status(400).json({ error: 'Proveedor desconocido.' });

      clearUserAppConfig(username, provider);
      res.json({ ok: true, source: appConfigured(provider) ? 'instance' : 'none' });
    }));

    // Estas rutas deben registrarse ANTES de '/:provider/...': si no,
    // '/codex/status' matchea '/:provider/status' con provider='codex' y
    // reqProvider responde 400 "Proveedor desconocido".
    r.post('/codex/start', (req, res) => {
      const user = userOf(req);
      const job = readCodexLoginJob(user);
      if (
        job
        && ['starting', 'awaiting-auth'].includes(job.status)
        && (Date.now() - (job.ts || 0)) < 15 * 60 * 1000
      ) {
        return res.json({ ok: true, already: true });
      }
      // Cortar acá sólo si la credencial está VIVA. Antes se miraba únicamente
      // que auth.json existiera: con el token vencido el usuario tocaba
      // "Reconectar", recibía already/connected y NUNCA se relanzaba el login.
      const cred = codexCredState(user);
      if (cred.present && !cred.expired) {
        return res.json({ ok: true, already: true, connected: true });
      }

      try {
        // Reserva SINCRÓNICA del job 'starting' en disco ANTES de spawnear
        // (sin ningún await entre el read de arriba y este write): así dos POST
        // simultáneos no pueden pasar ambos el dedup y lanzar dos runners.
        writeCodexLoginJob(user, { status: 'starting' });
        spawn(process.execPath, [CODEX_LOGIN_RUNNER, '--user', user], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } catch (e) {
        return res.status(500).json({ error: 'No pude lanzar el login de Codex: ' + e.message });
      }
      res.json({ ok: true });
    });

    r.get('/codex/status', (req, res) => {
      const user = userOf(req);
      const cred = codexCredState(user);
      const connected = cred.present && !cred.expired;
      const expired = cred.present && cred.expired;
      const job = readCodexLoginJob(user);
      if (!job) {
        return res.json({ status: 'idle', connected, expired, expiresAt: cred.expiresAt });
      }

      const stale = job.status === 'starting'
        && !!job.ts
        && (Date.now() - job.ts) > 30000;
      res.json({
        status: job.status,
        url: job.url || null,
        code: job.code || null,
        done: !!job.done,
        error: job.error || null,
        stale: !!stale,
        connected,
        expired,
        expiresAt: cred.expiresAt,
        // El front necesita la edad del job para distinguir un fallo RECIÉN
        // ocurrido (el click que acaba de hacer el usuario) de uno viejo.
        ts: job.ts || null,
      });
    });

    r.post('/codex/cancel', (req, res) => {
      const user = userOf(req);
      const job = readCodexLoginJob(user);
      try {
        if (job) writeCodexLoginJob(user, { ...job, status: 'cancelled' });
      } catch (e) {
        return res.status(500).json({ error: 'No pude cancelar el login de Codex: ' + e.message });
      }
      res.json({ ok: true });
    });

    r.post('/github/start', (req, res) => {
      const user = userOf(req);
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
        // Reserva síncrona antes del spawn para que dos POST simultáneos no
        // puedan lanzar dos runners para el mismo usuario.
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

    r.get('/github/status', (req, res) => {
      const user = userOf(req);
      const job = readGhJob(user) || { status: 'idle' };
      const stale = job.status === 'starting'
        && !!job.ts
        && (Date.now() - job.ts) > 30_000;
      res.json({
        status: job.status,
        url: job.url || null,
        code: job.code || null,
        done: !!job.done,
        error: job.error || null,
        stale: !!stale,
        connected: hasGithubAuth(user),
      });
    });

    r.post('/github/cancel', (req, res) => {
      const user = userOf(req);
      const job = readGhJob(user);
      try {
        if (ghLoginRunnerAlive(job)) {
          try { process.kill(Number(job.pid), 'SIGTERM'); } catch { /* ya terminó */ }
        }
        if (job) {
          writeJsonAtomic(ghJobPath(user), {
            ...job,
            status: 'cancelled',
            user,
            ts: Date.now(),
          }, { mode: 0o600 });
        }
      } catch (e) {
        return res.status(500).json({ error: 'No pude cancelar el login de GitHub: ' + e.message });
      }
      res.json({ ok: true });
    });

    r.post('/pad/login/start', (req, res) => {
      const user = userOf(req);
      const job = readPadLoginJob(user);
      const reserved = job?.status === 'starting'
        && !!job.ts
        && (Date.now() - job.ts) < 30_000;
      const alive = padLoginRunnerAlive(job);
      if (reserved || (
        ['starting', 'awaiting-auth', 'verifying'].includes(job?.status)
        && alive
      )) {
        return res.json({ ok: true, already: true, status: job.status || 'starting' });
      }

      try {
        // Reserva síncrona antes del spawn: dos requests del mismo usuario no
        // pueden lanzar dos PTY antes de que el hijo publique su pid.
        writePadLoginJob(user, { status: 'starting', done: false });
        spawn(process.execPath, [PAD_LOGIN_RUNNER, '--user', user], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } catch (e) {
        try {
          writePadLoginJob(user, {
            status: 'error',
            error: 'No pude lanzar el login de Pad.',
            done: true,
          });
        } catch { /* noop */ }
        return res.status(500).json({ error: 'No pude lanzar el login de Pad: ' + e.message });
      }
      res.json({ ok: true, status: 'starting' });
    });

    r.get('/pad/login/status', (req, res) => {
      const job = readPadLoginJob(userOf(req)) || { status: 'idle' };
      res.json({
        status: job.status || 'error',
        url: job.url || null,
        error: job.error || null,
        done: !!job.done,
      });
    });

    r.post('/pad/login/cancel', (req, res) => {
      const user = userOf(req);
      const job = readPadLoginJob(user);
      try {
        if (padLoginRunnerAlive(job)) {
          try { process.kill(Number(job.pid), 'SIGTERM'); } catch { /* ya terminó */ }
        }
        if (job) {
          writePadLoginJob(user, {
            ...job,
            status: 'cancelled',
            done: true,
          });
        }
      } catch (e) {
        return res.status(500).json({ error: 'No pude cancelar el login de Pad: ' + e.message });
      }
      res.json({ ok: true });
    });

    // Tolkien también debe registrarse antes de '/:provider/...': si estas
    // rutas quedaran después, '/tolkien/status' matchearía '/:provider/status'
    // y respondería 400 porque Tolkien no forma parte del store OAuth.
    r.post('/tolkien/login/start', (req, res) => {
      const user = userOf(req);
      const raw = req.body?.cookie;
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'Pegá el valor de la cookie de sesión de Tolkien.' });
      }
      const cookie = raw.trim();
      if (!isValidTolkienCookie(cookie)) {
        return res.status(400).json({ error: 'El valor pegado no tiene la forma de la cookie de sesión de Tolkien.' });
      }

      const job = readTolkienLoginJob(user);
      const reserved = ['starting', 'verifying'].includes(job?.status)
        && !!job.ts
        && (Date.now() - job.ts) < 30_000;
      if (reserved || tolkienLoginRunnerAlive(job)) {
        return res.json({ ok: true, already: true, status: job.status || 'starting' });
      }

      try {
        // Reserva síncrona antes del spawn para que dos requests del mismo
        // usuario no puedan lanzar dos verificaciones en paralelo.
        writeTolkienLoginJob(user, { status: 'starting', done: false });
        const child = spawn(process.execPath, [TOLKIEN_LOGIN_RUNNER, '--user', user], {
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.stdin.on('error', () => {});
        child.on('error', () => {});
        // STDIN evita exponer la cookie en /proc/<pid>/cmdline (argv es visible
        // para cualquier proceso) y evita dejar el secreto en un archivo
        // intermedio en disco más tiempo del necesario.
        child.stdin.write(cookie);
        child.stdin.end();
        child.unref();
      } catch {
        try {
          writeTolkienLoginJob(user, {
            status: 'error',
            error: 'No pude lanzar la verificación de la sesión de Tolkien.',
            done: true,
          });
        } catch { /* noop */ }
        return res.status(500).json({ error: 'No pude lanzar la verificación de la sesión de Tolkien.' });
      }
      res.json({ ok: true, status: 'starting' });
    });

    r.get('/tolkien/login/status', (req, res) => {
      const job = readTolkienLoginJob(userOf(req)) || { status: 'idle' };
      res.json({
        status: job.status || 'error',
        error: job.error || null,
        done: !!job.done,
        account: job.account || null,
      });
    });

    r.post('/tolkien/login/cancel', (req, res) => {
      const user = userOf(req);
      const job = readTolkienLoginJob(user);
      try {
        if (tolkienLoginRunnerAlive(job)) {
          try { process.kill(Number(job.pid), 'SIGTERM'); } catch { /* ya terminó */ }
        }
        if (job) {
          writeTolkienLoginJob(user, {
            ...job,
            status: 'cancelled',
            done: true,
          });
        }
      } catch {
        return res.status(500).json({ error: 'No pude cancelar la verificación de la sesión de Tolkien.' });
      }
      res.json({ ok: true });
    });

    r.get('/tolkien/status', (req, res) => {
      // El dato se resuelve por OPERACIÓN desde el principal de la request;
      // jamás desde os.homedir() ni desde una constante calculada al importar.
      res.json(tolkienStatus(userDataDir(userOf(req))));
    });

    r.post('/tolkien/disconnect', (req, res) => {
      // Borra la sesión local del usuario; no cierra su sesión remota en Tolkien.
      try {
        const removed = deleteTolkienConnection(userDataDir(userOf(req)));
        res.json({ ok: true, ...removed });
      } catch {
        res.status(500).json({ error: 'No pude borrar la sesión guardada de Tolkien.' });
      }
    });

    // Igual que Codex, estas rutas deben quedar antes de '/:provider/...'.
    r.post('/claude/login/start', (req, res) => {
      const user = userOf(req);
      // console:PLAN-2446: el host puede usar el login guiado porque el runner
      // resguarda su credencial y la restaura si el flujo no termina bien.

      const job = readClaudeLoginJob(user);
      const reserved = job?.status === 'starting'
        && !!job.ts
        && (Date.now() - job.ts) < 30_000;
      if (reserved || claudeLoginRunnerAlive(job)) {
        return res.json({ status: job.status || 'starting' });
      }

      try {
        // Reserva síncrona antes del spawn: dos requests del mismo usuario no
        // pueden lanzar dos PTY, aun antes de que el hijo publique su pid.
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
      res.json({ status: 'starting' });
    });

    r.get('/claude/login/status', (req, res) => {
      const job = readClaudeLoginJob(userOf(req));
      if (!job || claudeLoginJobIsStale(job)) return res.json({ status: 'idle' });
      res.json({
        status: job.status || 'error',
        ...(job.url ? { url: job.url } : {}),
        ...(job.error ? { error: job.error } : {}),
      });
    });

    r.post('/claude/login/code', (req, res) => {
      const user = userOf(req);
      const job = readClaudeLoginJob(user);
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
        fs.writeFileSync(claudeLoginCodePath(user), code, { mode: 0o600 });
        fs.chmodSync(claudeLoginCodePath(user), 0o600);
      } catch (e) {
        return res.status(500).json({ error: 'No pude enviar el código al login de Claude: ' + e.message });
      }
      res.json({ ok: true });
    });

    r.post('/claude/login/cancel', (req, res) => {
      const user = userOf(req);
      const job = readClaudeLoginJob(user);
      try {
        if (claudeLoginRunnerAlive(job)) {
          process.kill(Number(job.pid), 'SIGTERM');
        }
        cleanClaudeLoginJob(user);
      } catch (e) {
        return res.status(500).json({ error: 'No pude cancelar el login de Claude: ' + e.message });
      }
      res.json({ ok: true });
    });

    r.get('/claude/status', (req, res) => {
      const source = claudeCredentialSource(userOf(req));
      res.json({ connected: source !== null, source });
    });

    // Freshservice usa una credencial estática por agente, no OAuth. Estas
    // rutas específicas deben quedar antes de '/:provider/...'.
    r.post('/freshservice/connect', asyncHandler(async (req, res) => {
      const username = userOf(req);
      let domain;
      try {
        domain = freshserviceBaseUrl(req.body?.domain);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      const apiKey = String(req.body?.apiKey || '').trim();
      if (!apiKey) return res.status(400).json({ error: 'Falta la API key de Freshservice.' });

      const verified = await verifyFreshservice({ domain, apiKey });
      if (!verified.ok) return res.status(400).json({ error: verified.error });

      writeConnection(username, 'freshservice', {
        provider: 'freshservice',
        domain,
        apiKey,
        email: verified.email,
        name: verified.name,
        id: verified.id,
        connectedAt: new Date().toISOString(),
        error: null,
      });
      res.json({ ok: true });
    }));

    r.post('/freshservice/disconnect', asyncHandler((req, res) => {
      deleteConnection(userOf(req), 'freshservice');
      res.json({ ok: true });
    }));

    r.get('/freshservice/status', asyncHandler((req, res) => {
      const username = userOf(req);
      const credential = getApiCredential(username, 'freshservice');
      const connection = credential ? readConnection(username, 'freshservice') : null;
      res.json({
        connected: !!credential,
        domain: credential?.domain ?? null,
        email: connection?.email ?? null,
        name: connection?.name ?? null,
        connectedAt: connection?.connectedAt ?? null,
      });
    }));

    r.post('/:provider/connect', asyncHandler(async (req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      const username = userOf(req);
      if (!appConfiguredFor(username, provider)) {
        const needSecret = provider === 'zoho' ? ' y el Client Secret' : '';
        return res.status(409).json({
          error: `La app OAuth de ${labelOf(provider)} todavía no está configurada. Un administrador debe cargar el Client ID${needSecret}. También podés cargar tu propia app desde este mismo panel.`,
        });
      }

      const jobId = newJobId();

      if (provider === 'microsoft') {
        const { clientId, tenantId, source: appSource } = effectiveAppConfig(username, 'microsoft');
        let flow;
        try {
          flow = await startDeviceFlow({ clientId, tenantId });
        } catch (e) {
          return res.status(502).json({ error: e.message });
        }

        writeJob(username, jobId, {
          provider: 'microsoft',
          status: 'pending',
          mode: 'device',
          createdAt: Date.now(),
          expiresAt: Date.now() + flow.expiresIn * 1000,
          deviceCode: flow.deviceCode,
          interval: flow.interval,
          appClientId: clientId,
          appSource,
          tenantId,
          error: null,
        });
        pollMicrosoft(username, jobId, {
          clientId,
          tenantId,
          appSource,
          deviceCode: flow.deviceCode,
          interval: flow.interval,
          expiresIn: flow.expiresIn,
        }).catch(() => {});

        return res.json({
          mode: 'device',
          jobId,
          userCode: flow.userCode,
          verificationUri: flow.verificationUri,
          expiresIn: flow.expiresIn,
        });
      }

      const { clientId, dc, source: appSource } = effectiveAppConfig(username, 'zoho');
      writeJob(username, jobId, {
        provider: 'zoho',
        status: 'pending',
        mode: 'paste',
        createdAt: Date.now(),
        error: null,
      });
      res.json({
        mode: 'paste',
        jobId,
        authUrl: authUrl({ clientId, dc }),
        scopes: ZOHO_SCOPES.join(','),
        appSource,
      });
    }));

    r.post('/:provider/code', asyncHandler(async (req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      const username = userOf(req);
      const jobId = req.body?.jobId;
      if (!JOB_ID_RE.test(jobId || '')) return res.status(400).json({ error: 'jobId inválido.' });

      const job = readJob(username, jobId);
      if (!job || job.provider !== provider) return res.status(404).json({ error: 'Job inexistente.' });
      if (provider === 'microsoft') {
        return res.status(400).json({ error: 'Microsoft se conecta con el código del dispositivo, no hace falta pegar nada.' });
      }

      const value = String(req.body?.value || '').trim();
      if (!value) return res.status(400).json({ error: 'Pegá el grant code de Zoho.' });

      const {
        clientId,
        clientSecret,
        dc,
        source: appSource,
      } = effectiveAppConfig(username, 'zoho');
      let tokens;
      try {
        tokens = await exchangeCode({ clientId, clientSecret, code: value, dc });
      } catch (e) {
        const rawError = e?.message || String(e);
        const error = explainZohoError(rawError);
        patchJob(username, jobId, { status: 'error', error });
        return res.status(502).json({
          error,
          ...(rawError.includes('invalid_code') ? { code: 'invalid_code' } : {}),
        });
      }

      // getOrg/getZohoMe pueden fallar (timeout, rate limit) DESPUÉS de consumir
      // el grant code (un solo uso): NO perder los tokens ya obtenidos. La
      // identidad se completa luego con healZohoIdentity. Simétrico con el flujo
      // de Microsoft (pollMicrosoft), que persiste aunque getMicrosoftMe falle.
      let org = null;
      let me = null;
      try {
        org = await getOrg(tokens.access_token, dc);
        me = await getZohoMe(tokens.access_token, dc, org?.id, config.instance?.identity?.email);
      } catch (e) {
        console.error('[connections] identidad Zoho falló tras el exchange; se persiste sin nombre:', e?.message);
      }
      const account = me?.email || null;
      writeConnection(username, 'zoho', {
        provider: 'zoho',
        appClientId: clientId,
        appSource,
        account,
        orgId: org?.id || null,
        orgName: org?.name || null,
        agentId: me?.id || null,
        agentName: me?.name || null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        scopes: ZOHO_SCOPES,
        connectedAt: new Date().toISOString(),
        error: null,
      });
      patchJob(username, jobId, { status: 'connected', account, error: null });
      res.json({ ok: true });
    }));

    r.get('/:provider/status', asyncHandler((req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      const username = userOf(req);
      const jobId = req.query.jobId;
      const job = readJob(username, jobId);
      if (!job) {
        return res.status(404).json({
          error: 'La autorización ya no está disponible (puede haber expirado o haberse limpiado). Volvé a tocar Renovar permisos.',
        });
      }
      // Auto-sanado tras reinicio: pollMicrosoft vive en memoria del proceso; si
      // el server se reinició mientras el usuario esperaba la aprobación del
      // device code, el loop murió y el job quedaría 'pending' para siempre. Si
      // ya venció, lo marcamos 'error' en la lectura para no dejar colgado al front.
      if (job.status === 'pending' && job.expiresAt && Date.now() > job.expiresAt) {
        patchJob(username, jobId, { status: 'error', error: 'El código expiró antes de completar la autorización.' });
        job.status = 'error';
        job.error = 'El código expiró antes de completar la autorización.';
      }
      // Reanuda tras reinicios del server (BUG-929, regla dura 2) sin escanear usuarios.
      if (
        job.status === 'pending'
        && job.mode === 'device'
        && job.deviceCode
        && !activePolls.has(pollKey(username, jobId))
        && job.expiresAt
        && Date.now() < job.expiresAt
      ) {
        const effectiveCfg = effectiveAppConfig(username, 'microsoft');
        const clientId = job.appClientId || effectiveCfg.clientId;
        const tenantId = job.tenantId || effectiveCfg.tenantId;
        const appSource = job.appSource || effectiveCfg.source;
        if (!clientId) {
          const error = 'La app OAuth de Microsoft ya no está configurada; pedile a un administrador que la cargue y volvé a tocar Renovar permisos.';
          patchJob(username, jobId, { status: 'error', error });
          job.status = 'error';
          job.error = error;
        } else {
          pollMicrosoft(username, jobId, {
            clientId,
            tenantId,
            appSource,
            deviceCode: job.deviceCode,
            interval: Number(job.interval) || 5,
            expiresIn: Math.max(1, Math.floor((job.expiresAt - Date.now()) / 1000)),
          }).catch(() => {});
        }
      }
      res.json({
        status: job.status,
        ...(job.account ? { account: job.account } : {}),
        ...(job.error ? { error: job.error } : {}),
      });
    }));

    r.post('/:provider/disconnect', asyncHandler((req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      // Esto solo borra el token local del usuario; la revocación remota se
      // gestiona desde el panel del proveedor.
      deleteConnection(userOf(req), provider);
      res.json({ ok: true });
    }));

    r.post('/:provider/cancel', asyncHandler((req, res) => {
      const provider = reqProvider(req, res);
      if (!provider) return;

      const removed = cancelAttempts(userOf(req), provider);
      res.json({ ok: true, removed });
    }));

    router.use('/connections', r);
  },
};
