// modules/onboard/capabilities.js — catálogo declarativo de pasos del onboarding.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import {
  hasCodexCreds,
  hasInfisicalCreds,
  hostUser,
  sanitizeUserId,
  userClaudeDir,
  userRunnerEnv,
  userSpace,
} from '../../core/user-space.js';
import { resolveClaudeCredential } from '../../core/sponsorship.js';
import { sponsorshipState, listUsers } from '../../core/users.js';

// El HOST no pasa por el wizard: su credencial es la del login real del CLI
// (`.credentials.json`), no el `oauth-token` que deja `claude setup-token`.
export function isHostUser(user) {
  try { return !!user && sanitizeUserId(user) === hostUser(); } catch { return false; }
}

// Detecta la credencial de cuenta completa que habilita el medidor de consumo.
export function hasClaudeAccountCreds(user) {
  try {
    const credentialFile = path.join(userClaudeDir(user), '.credentials.json');
    const data = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    const accessToken = data?.claudeAiOauth?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) return false;
    if (isHostUser(user)) return true;

    // console:BUG-2338: la mera presencia daba verde aun usando la identidad del host.
    const hostCredentialFile = path.join(userClaudeDir(hostUser()), '.credentials.json');
    const credentialRealpath = fs.realpathSync(credentialFile);
    try {
      if (credentialRealpath === fs.realpathSync(hostCredentialFile)) return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }

    let hostData;
    try {
      hostData = JSON.parse(fs.readFileSync(hostCredentialFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      return false;
    }
    const hostOauth = hostData?.claudeAiOauth;
    if (accessToken === hostOauth?.accessToken) return false;
    const refreshToken = data?.claudeAiOauth?.refreshToken;
    if (typeof refreshToken === 'string' && refreshToken
      && typeof hostOauth?.refreshToken === 'string' && hostOauth.refreshToken
      && refreshToken === hostOauth.refreshToken) return false;
    return true;
  } catch {
    return false;
  }
}

const GH_ARGS = ['auth', 'status', '--json', 'hosts', '--hostname', 'github.com', '--active'];
const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 1024 * 1024;
const GH_CACHE_TTL_MS = 30_000;
const HOST_LOGIN_CACHE_TTL_MS = 5 * 60_000;
const githubCache = new Map();
const githubInflight = new Map();
const githubInflightStarted = new WeakMap();
let hostLoginCache = null;
let hostLoginInflight = null;

export function parseGhLogin(stdout) {
  const parsed = JSON.parse(String(stdout || ''));
  const entries = parsed?.hosts?.['github.com'];
  if (!Array.isArray(entries)) return null;
  const session = entries.find((entry) => (
    entry?.state === 'success'
    && typeof entry?.login === 'string'
    && entry.login.trim()
  ));
  return session ? session.login.trim() : null;
}

function freshGithubCache(user, notBefore = 0) {
  const entry = githubCache.get(user);
  return entry && Date.now() - entry.ts < GH_CACHE_TTL_MS && entry.ts >= notBefore
    ? entry.value
    : undefined;
}

function cacheGithubAuth(user, value) {
  githubCache.delete(user);
  githubCache.set(user, { value: !!value, ts: Date.now() });
  while (githubCache.size > 500) {
    githubCache.delete(githubCache.keys().next().value);
  }
  return !!value;
}

function runGhStatus(user) {
  return new Promise((resolve) => {
    try {
      execFile('gh', GH_ARGS, {
        cwd: userSpace(user),
        env: userRunnerEnv(user),
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
      }, (error, stdout) => {
        if (error) return resolve({ ok: false });
        try {
          return resolve({ ok: true, login: parseGhLogin(stdout) });
        } catch {
          return resolve({ ok: false });
        }
      });
    } catch {
      resolve({ ok: false });
    }
  });
}

function runGhStatusSync(user) {
  try {
    const result = spawnSync('gh', GH_ARGS, {
      cwd: userSpace(user),
      env: userRunnerEnv(user),
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
    });
    if (result.error || result.status !== 0) return { ok: false };
    return { ok: true, login: parseGhLogin(result.stdout) };
  } catch {
    return { ok: false };
  }
}

function freshHostLogin() {
  const ttl = hostLoginCache?.result.ok ? HOST_LOGIN_CACHE_TTL_MS : GH_CACHE_TTL_MS;
  return hostLoginCache && Date.now() - hostLoginCache.ts < ttl
    ? hostLoginCache.result
    : null;
}

function cacheHostLogin(result) {
  hostLoginCache = { result, ts: Date.now() };
  return result;
}

async function getHostLogin() {
  const cached = freshHostLogin();
  if (cached) return cached;
  if (hostLoginInflight) return hostLoginInflight;
  const promise = runGhStatus(hostUser())
    .then(cacheHostLogin)
    .finally(() => {
      if (hostLoginInflight === promise) hostLoginInflight = null;
    });
  hostLoginInflight = promise;
  return promise;
}

function getHostLoginSync() {
  return freshHostLogin() || cacheHostLogin(runGhStatusSync(hostUser()));
}

function githubConnected(user, own, host) {
  if (!own.ok || own.login === null) return false;
  if (user === hostUser()) return true;
  return !!host.ok && (
    host.login === null || own.login.toLowerCase() !== host.login.toLowerCase()
  );
}

export function invalidateGithubAuth(user) {
  try { githubCache.delete(sanitizeUserId(user)); } catch { /* usuario inválido: no hay caché que borrar */ }
}

export function githubAuthStatus(user, { notBefore = 0 } = {}) {
  let id;
  try {
    id = sanitizeUserId(user);
    const cached = freshGithubCache(id, notBefore);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = githubInflight.get(id);
    if (inflight && (githubInflightStarted.get(inflight) || 0) >= notBefore) return inflight;

    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const own = await runGhStatus(id);
        let host;
        if (id === hostUser()) {
          host = cacheHostLogin(own);
        } else {
          host = await getHostLogin();
        }
        return cacheGithubAuth(id, githubConnected(id, own, host));
      } catch {
        return cacheGithubAuth(id, false);
      }
    })().finally(() => {
      if (githubInflight.get(id) === promise) githubInflight.delete(id);
    });
    githubInflightStarted.set(promise, startedAt);
    githubInflight.set(id, promise);
    return promise;
  } catch {
    return Promise.resolve(false);
  }
}

// Variante sync solo por compatibilidad con connections; onboard usa la async.
export function hasGithubAuth(user) {
  try {
    const id = sanitizeUserId(user);
    const cached = freshGithubCache(id);
    if (cached === true) return true;
    const own = runGhStatusSync(id);
    const host = id === hostUser() ? cacheHostLogin(own) : getHostLoginSync();
    return cacheGithubAuth(id, githubConnected(id, own, host));
  } catch {
    return false;
  }
}

// `required` admite un boolean o un objeto segmentado. Las claves del objeto
// quedan deliberadamente abiertas: hoy resolvemos primero el tier patrocinado
// y, para el resto, conservamos el rol binario admin/usuario.
export const CAPABILITIES = [
  // Un patrocinado no genera credencial propia: usa la resolución central del
  // sponsor. Si ese sponsor aún no tiene oauth-token, el paso sigue incompleto.
  {
    id: 'claude',
    order: 1,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'Credencial de Claude',
    detect: (user) => !!resolveClaudeCredential(user).token
      || (isHostUser(user) && hasClaudeAccountCreds(user)),
    startPath: '/creds-start',
    statusPath: '/creds-status',
  },
  // Habilita consultar el consumo real de la cuenta Claude.
  {
    id: 'account',
    order: 2,
    required: false,
    labelEs: 'Cuenta Claude completa',
    detect: (user) => hasClaudeAccountCreds(user),
    startPath: '/claude-account-start',
    statusPath: '/claude-account-status',
  },
  // Un patrocinado tampoco pasa por el login de Codex: por definición no se le
  // exige una cuenta propia para completar el alta.
  {
    id: 'codex',
    order: 3,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'Codex',
    detect: (user) => hasCodexCreds(user),
    startPath: '/codex-start',
    statusPath: '/codex-status',
  },
  // El perfil patrocinado no es desarrollador: Infisical y GitHub se detectan
  // si existen, pero no bloquean su alta porque son herramientas de desarrollo.
  {
    id: 'infisical',
    order: 4,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'Infisical',
    detect: (user) => hasInfisicalCreds(user),
    startPath: '/infisical-start',
    statusPath: '/infisical-status',
  },
  // Habilita clonar, consultar y pushear repositorios por HTTPS.
  {
    id: 'github',
    order: 5,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'GitHub',
    detect: (user) => githubAuthStatus(user),
    startPath: '/github-start',
    statusPath: '/github-status',
  },
];

async function detected(capability, user) {
  try {
    return !!(await capability.detect(user));
  } catch {
    return false;
  }
}

export function requiredFor(capability, user) {
  if (typeof capability?.required === 'boolean') return capability.required;

  const segmented = capability?.required;
  if (!segmented || typeof segmented !== 'object' || Array.isArray(segmented)) return true;

  const knownUser = typeof user === 'string'
    ? listUsers().find((candidate) => candidate.username === user)
    : null;
  if (!knownUser) return true;

  const segment = sponsorshipState(knownUser.username) !== 'none'
    ? 'patrocinado'
    : (knownUser.admin ? 'admin' : 'usuario');
  // Ante un segmento ausente o inválido cerramos el gate: pedir un paso de más
  // es recuperable; dar el alta incompleta deja al usuario mal provisionado.
  return typeof segmented[segment] === 'boolean' ? segmented[segment] : true;
}

export async function capabilityStatus(user) {
  if (!user) return Object.fromEntries(CAPABILITIES.map((capability) => [capability.id, false]));
  const values = await Promise.all(CAPABILITIES.map((capability) => detected(capability, user)));
  return Object.fromEntries(
    CAPABILITIES.map((capability, index) => [capability.id, values[index]]),
  );
}

export async function pendingFor(user) {
  if (!user) return [];
  const ordered = [...CAPABILITIES].sort((a, b) => a.order - b.order);
  const values = await Promise.all(ordered.map((capability) => detected(capability, user)));
  return ordered.filter((_, index) => !values[index]).map((capability) => capability.id);
}

export async function blockingFor(user) {
  if (!user) return [];
  const ordered = [...CAPABILITIES].sort((a, b) => a.order - b.order);
  const values = await Promise.all(ordered.map((capability) => detected(capability, user)));
  return ordered
    .filter((capability, index) => requiredFor(capability, user) && !values[index])
    .map((capability) => capability.id);
}

export function capabilityById(id) {
  return CAPABILITIES.find((capability) => capability.id === id) || null;
}
