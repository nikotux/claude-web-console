// modules/mcps/infisical-shared.js — Infisical no es un MCP ni una cuenta:
// es la LLAVE de la que cuelga el MCP `tolkien-mordor`. Si el login vence,
// ese MCP no arranca y hasta ahora el panel no tenía ninguna señal propia para
// avisar que la llave se había roto.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hostUser,
  readInfisicalAccountEmail,
  userInfisicalConfigPath,
} from '../../core/user-space.js';
import { commandEnvFor, worldCwd } from './login-shared.js';

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function cleanText(s) {
  return String(s || '').replace(ANSI_RE, '').trim();
}

function cleanInfisicalError(s) {
  return cleanText(s)
    .split('\n')
    .filter((line) => !/^\s*-\s*(User ID|Organization):/i.test(line))
    .join('\n')
    .trim();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Compatibilidad con el runner histórico del host, que importa esta sonda sin
// request. Los handlers HTTP siempre pasan el systemScope explícito; el runner
// ya recibe HOME aislado en su env cuando corresponde.
function runnerScopeFor() {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('HOME del runner no configurado');
  return {
    user: process.env.USER || 'runner',
    isHost: true,
    home,
    dataDir: process.env.CWC_DATA_DIR || path.join(home, '.cwc-data'),
    claudeDir: path.join(home, '.claude'),
    workspace: home,
  };
}

function parseExpiresInMs(text) {
  const src = String(text || '');
  let total = 0;
  let matched = false;
  const units = [
    [/(\d+)\s*d/g, 24 * 60 * 60 * 1000],
    [/(\d+)\s*h/g, 60 * 60 * 1000],
    [/(\d+)\s*m/g, 60 * 1000],
    [/(\d+)\s*s/g, 1000],
  ];
  for (const [re, mult] of units) {
    for (const m of src.matchAll(re)) {
      matched = true;
      total += Number(m[1]) * mult;
    }
  }
  return matched ? total : null;
}

function runFile(cmd, args, { cwd, timeout, env }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

export function readInfisicalIdentity(scope) {
  const j = readJson(path.join(scope.home, '.infisical', 'infisical-config.json'));
  if (!j) return { email: null, domain: null, vaultBackend: null, accounts: [] };
  // Este archivo contiene `vaultBackendPassphrase`: jamás debe salir de esta
  // función ni aparecer en logs/respuestas. Por eso usamos allowlist explícita.
  return {
    email: j.loggedInUserEmail || null,
    domain: j.LoggedInUserDomain || null,
    vaultBackend: j.vaultBackendType || null,
    accounts: Array.isArray(j.loggedInUsers)
      ? j.loggedInUsers.map((u) => ({ email: u.email || null, domain: u.domain || null }))
      : [],
  };
}

export async function probeInfisicalStatus(scope = runnerScopeFor(), timeoutMs = 12000) {
  try {
    const { err, stdout, stderr } = await runFile('infisical', ['login', 'status'], {
      cwd: worldCwd(scope, 'tolkien') || scope.home,
      timeout: timeoutMs,
      env: commandEnvFor(scope),
    });
    const out = cleanText(`${stdout}\n${stderr}`);
    const seconds = Math.round(timeoutMs / 1000);
    if (err?.code === 'ENOENT') return { ok: false, code: 'missing', error: 'el CLI de infisical no está instalado' };
    if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
      return { ok: false, code: 'timeout', error: `no respondió en ${seconds}s` };
    }
    const email = out.match(/Authenticated as\s+(\S+)/)?.[1] || null;
    if (!email) {
      return { ok: false, code: 'logged-out', error: cleanInfisicalError(stderr || stdout).slice(0, 300) || 'sin sesión activa' };
    }
    const domain = out.match(/^\s*-\s*Domain:\s*(.+)$/m)?.[1]?.trim() || null;
    const method = out.match(/^\s*-\s*Auth method:\s*(.+)$/m)?.[1]?.trim() || null;
    const expiresInText = out.match(/^\s*-\s*Token expiration:\s*(.+)$/m)?.[1]?.trim() || null;
    return { ok: true, email, domain, method, expiresInText, expiresInMs: parseExpiresInMs(expiresInText) };
  } catch (e) {
    return { ok: false, code: 'logged-out', error: String(e?.message || e || '').slice(0, 300) };
  }
}

export async function probeInfisicalProject(scope, timeoutMs = 20000) {
  const projectDir = worldCwd(scope, 'tolkien');
  // `env-vars` permite instalaciones sin proyecto externo; en ese caso la
  // sonda debe devolver estado, no romper antes con path.join/cwd.
  if (!projectDir) return { ok: false, code: 'no-project', error: 'no hay proyecto externo configurado' };
  const projectCfg = readJson(path.join(projectDir, '.infisical.json')) || {};
  const projectId = scope.isHost
    ? (process.env.CWC_TOLKIEN_INFISICAL_ID?.trim()
      || (projectCfg.workspaceId ? String(projectCfg.workspaceId) : null)
      || '25b6c300-7686-4cf0-b8e3-ed808a529638')
    : (projectCfg.workspaceId ? String(projectCfg.workspaceId) : null);
  const env = projectCfg.defaultEnvironment || 'prod';
  if (!projectId) return { ok: false, code: 'no-project', error: 'no hay projectId de Infisical configurado' };
  try {
    const { err, stderr } = await runFile('infisical', [
      'run', '--projectId', projectId, '--env', env, '--silent', '--', 'true',
    ], { cwd: projectDir, timeout: timeoutMs, env: commandEnvFor(scope) });
    // REGLA DURA: de `infisical run` se mira ÚNICAMENTE exit code y STDERR.
    // Nunca leer, guardar ni loguear STDOUT: si el comando probado cambia, ese
    // canal podría traer secretos inyectados por Infisical.
    const cleanErr = cleanText(stderr);
    const seconds = Math.round(timeoutMs / 1000);
    if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
      return { ok: false, code: 'timeout', projectId, env, error: `no respondió en ${seconds}s` };
    }
    const secretCountRaw = cleanErr.match(/Injecting\s+(\d+)\s+Infisical secrets/)?.[1];
    const secretCount = secretCountRaw == null ? null : Number(secretCountRaw);
    if (!err) return { ok: true, projectId, env, secretCount };
    return { ok: false, code: 'no-access', projectId, env, error: cleanErr.slice(0, 300) || 'sin acceso al proyecto' };
  } catch (e) {
    return { ok: false, code: 'no-access', projectId, env, error: String(e?.message || e || '').slice(0, 300) };
  }
}

export function infisicalDependents(cliCfg) {
  const out = new Set();
  const addFrom = (servers) => {
    for (const [name, decl] of Object.entries(servers || {})) {
      if (decl?.command === 'infisical') out.add(name);
    }
  };
  for (const project of Object.values(cliCfg?.projects || {})) addFrom(project?.mcpServers);
  addFrom(cliCfg?.mcpServers);
  return [...out].sort((a, b) => a.localeCompare(b));
}

const INFISICAL_LOGIN_ID = 'infisical';
const LOGIN_TERMINAL = new Set(['done', 'error']);

function infisicalLoginJobsDirFor(scope) {
  return path.join(scope.dataDir, 'infisical-login');
}

function infisicalLoginRunnerFor() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  return path.join(root, 'bin', 'cwc-infisical-login-runner.js');
}

const loginIdOk = (id) => /^[A-Za-z0-9_-]+$/.test(String(id || ''));

function infisicalLoginJobFileFor(scope, id) {
  return path.join(infisicalLoginJobsDirFor(scope), `${id}.json`);
}

function infisicalLoginTokenFileFor(scope, id) {
  return path.join(infisicalLoginJobsDirFor(scope), `${id}.token`);
}

// Evita que un login hecho con la identidad del anfitrión quede aceptado dentro
// del HOME de un inquilino. Si coincide, elimina el config ajeno antes de fallar.
export function assertOwnInfisicalAccount(scope) {
  if (scope.isHost) return;
  const email = readInfisicalAccountEmail(scope.user);
  const hostEmail = readInfisicalAccountEmail(hostUser());
  if (!email || !hostEmail || email !== hostEmail) return;
  try {
    fs.rmSync(userInfisicalConfigPath(scope.user), { force: true });
  } catch {
    throw new Error('Esa es la cuenta del anfitrión y no pude quitarla: cada usuario debe entrar con la suya.');
  }
  throw new Error('Esa es la cuenta del anfitrión: cada usuario debe entrar con la suya.');
}

function badRequest(message) {
  const e = new Error(message);
  e.badRequest = true;
  return e;
}

function normalizeInfisicalDomain(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  let u;
  try { u = new URL(raw); } catch { throw new Error('dominio de Infisical inválido'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('dominio de Infisical inválido');
  return raw;
}

export function readInfisicalLoginJob(scope, id) {
  if (!loginIdOk(id)) return null;
  try {
    const file = infisicalLoginJobFileFor(scope, id);
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!LOGIN_TERMINAL.has(job.status)) return job;
    try {
      assertOwnInfisicalAccount(scope);
      return job;
    } catch (e) {
      const failed = {
        ...job,
        status: 'error',
        done: false,
        error: String(e?.message || e),
        ts: Date.now(),
      };
      fs.writeFileSync(file, JSON.stringify(failed), { mode: 0o600 });
      return failed;
    }
  } catch { return null; }
}

export function writeInfisicalLoginToken(scope, id, value) {
  if (!loginIdOk(id)) throw badRequest('id inválido');
  const v = String(value || '').trim();
  if (!v || v.length > 6000 || /[\r\n]/.test(v)) throw badRequest('valor inválido');
  fs.mkdirSync(infisicalLoginJobsDirFor(scope), { recursive: true });
  // Token real de acceso: se persiste solo como buzón 0600 para el runner y no
  // se loguea ni se copia al estado del job.
  fs.writeFileSync(infisicalLoginTokenFileFor(scope, id), v, { mode: 0o600 });
}

export function spawnInfisicalLogin(scope) {
  const id = INFISICAL_LOGIN_ID;
  const domain = normalizeInfisicalDomain(
    readInfisicalIdentity(scope).domain
      || (scope.isHost ? process.env.INFISICAL_DOMAIN : null)
      || 'https://app.infisical.com',
  );
  const cwd = worldCwd(scope, 'tolkien') || scope.home;
  fs.mkdirSync(infisicalLoginJobsDirFor(scope), { recursive: true });
  // Dedup: Infisical tiene una sola sesión por usuario; reusamos un job fresco
  // en curso para no dejar dos PTY compitiendo por el mismo keyring.
  const existing = readInfisicalLoginJob(scope, id);
  if (existing && !LOGIN_TERMINAL.has(existing.status) && Date.now() - (existing.ts || 0) < 10 * 60 * 1000) return id;
  try { fs.unlinkSync(infisicalLoginTokenFileFor(scope, id)); } catch { /* noop */ }
  fs.writeFileSync(infisicalLoginJobFileFor(scope, id), JSON.stringify({ id, status: 'starting', ts: Date.now() }), { mode: 0o600 });
  const child = spawn('node', [infisicalLoginRunnerFor(), '--id', id, '--user', scope.user, '--domain', domain, '--cwd', cwd], {
    detached: true,
    stdio: 'ignore',
    env: commandEnvFor(scope),
  });
  child.on('error', (err) => {
    try {
      fs.writeFileSync(infisicalLoginJobFileFor(scope, id), JSON.stringify({
        id,
        status: 'error',
        error: String(err.message || err),
        ts: Date.now(),
      }), { mode: 0o600 });
    } catch { /* best-effort */ }
  });
  child.unref();
  return id;
}
