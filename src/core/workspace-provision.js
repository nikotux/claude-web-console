// core/workspace-provision.js — clona el repo de trabajo (Tolkien u otro) en el
// workspace del INQUILINO, segun la politica SP9-6 (docs/decision-sp9-clones-retencion.md).
// Default: clon SHALLOW (--depth 1 --single-branch --branch main). Escalable a
// --reference/--dissociate o full via env. Best-effort (nunca tira) e idempotente
// (no re-clona si el destino ya tiene .git). El HOST usa su propio clon (se saltea).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { userWorkspace, ensureUserSpace, hostUser, sanitizeUserId } from './user-space.js';

// Estrategia: 'shallow' (default) | 'reference' | 'full'. Ver decision-doc SP9-6.
const STRATEGY = (process.env.CWC_CLONE_STRATEGY || 'shallow').toLowerCase();
const REFERENCE_BASE = process.env.CWC_CLONE_REFERENCE_BASE || ''; // clon base para --reference
const CLONE_TIMEOUT_MS = Number(process.env.CWC_CLONE_TIMEOUT_MS) || 180000;
const TENANT_GIT_EMAIL_DOMAIN = process.env.CWC_TENANT_GIT_EMAIL_DOMAIN || 'mordorstaffing.com';
const GIT_COMMAND_TIMEOUT_MS = 10000;
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOLKIEN_SETUP_RUNNER = fileURLToPath(new URL('../../bin/cwc-tolkien-setup-runner.js', import.meta.url));

// Arma los args de `git clone` segun la estrategia.
function cloneArgs(source, dest) {
  if (STRATEGY === 'full') return ['clone', source, dest];
  if (STRATEGY === 'reference' && REFERENCE_BASE) {
    // --reference comparte objetos con el base; --dissociate los copia y quita el
    // acople fragil (el base puede moverse/gc sin romper el clon). Ver SP9-6.
    return ['clone', '--reference', REFERENCE_BASE, '--dissociate', source, dest];
  }
  return ['clone', '--depth', '1', '--single-branch', '--branch', 'main', source, dest]; // default shallow
}

// Ejecuta un comando git corto y conserva su salida para reportar fallos sin tirar.
function runGit(args) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
}

function gitFailure(result) {
  return String(result?.error?.message || result?.stderr || `exit ${result?.status ?? 'desconocido'}`).trim().slice(0, 200);
}

// Lanza best-effort la preparación pesada del clon en un runner desacoplado.
// El caller futuro debe invocarla únicamente después de un clone exitoso; no
// altera provisionUserWorkspace ni convierte el setup en parte de su promesa.
export function launchTolkienSetupRunner(userId) {
  try {
    const id = sanitizeUserId(userId);
    const child = spawn(process.execPath, [TOLKIEN_SETUP_RUNNER, '--user', id], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.once('error', () => { /* best-effort: el job reporta errores propios */ });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// Provisiona (idempotente, best-effort) el clon de trabajo del inquilino.
// source = repo origen (default = config.projectDir, el Tolkien del host). Cloneamos
// desde el path LOCAL: rapido y sin auth. repoName = nombre del dir destino.
// Devuelve una Promise que SIEMPRE resuelve (nunca rejecta): {ok, dest?, error?, ...}.
export function provisionUserWorkspace(userId, { source, repoName } = {}) {
  return new Promise((resolve) => {
    try {
      const id = sanitizeUserId(userId);
      if (id === hostUser()) return resolve({ ok: true, skipped: 'host' }); // el host usa su propio clon
      ensureUserSpace(id);
      const src = source || config.projectDir;
      if (!src || !fs.existsSync(path.join(src, '.git'))) return resolve({ ok: false, error: 'repo fuente inexistente' });
      const name = repoName || path.basename(src);
      const ws = userWorkspace(id);
      const dest = path.join(ws, name);
      // Un clon preexistente puede conservar el origin local viejo; corregirlo al
      // re-provisionar queda para una tarea aparte.
      if (fs.existsSync(path.join(dest, '.git'))) return resolve({ ok: true, alreadyCloned: true, dest });
      const child = spawn('git', cloneArgs(src, dest), { cwd: ws, stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } resolve({ ok: false, error: 'timeout' }); }, CLONE_TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message || e).slice(0, 200) }); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ ok: false, error: `git clone exit ${code}` });

        const result = { ok: true, dest, strategy: STRATEGY };
        try {
          const upstream = runGit(['-C', src, 'remote', 'get-url', 'origin']);
          const upstreamUrl = String(upstream.stdout || '').trim();
          if (upstream.error) {
            result.originRewritten = false;
            result.originReason = `falló la lectura del remote upstream: ${gitFailure(upstream)}`;
          } else if (upstream.status !== 0 || !upstreamUrl) {
            result.originRewritten = false;
            result.originReason = 'fuente sin remote upstream';
          } else if (!/^(git@|ssh:\/\/|https?:\/\/)/.test(upstreamUrl)) {
            result.originRewritten = false;
            result.originReason = 'remote upstream de la fuente es un path local';
          } else {
            const rewrite = runGit(['-C', dest, 'remote', 'set-url', 'origin', upstreamUrl]);
            result.originRewritten = rewrite.status === 0 && !rewrite.error;
            if (result.originRewritten) result.originUrl = upstreamUrl;
            else result.originReason = `falló la reescritura de origin: ${gitFailure(rewrite)}`;
          }
        } catch (e) {
          result.originRewritten = false;
          result.originReason = `falló la normalización de origin: ${String(e?.message || e).slice(0, 200)}`;
        }

        const identityErrors = [];
        try {
          const userName = runGit(['-C', dest, 'config', 'user.name', id]);
          if (userName.status !== 0 || userName.error) identityErrors.push(`user.name: ${gitFailure(userName)}`);
        } catch (e) {
          identityErrors.push(`user.name: ${String(e?.message || e).slice(0, 200)}`);
        }
        try {
          const userEmail = runGit(['-C', dest, 'config', 'user.email', `${id}@${TENANT_GIT_EMAIL_DOMAIN}`]);
          if (userEmail.status !== 0 || userEmail.error) identityErrors.push(`user.email: ${gitFailure(userEmail)}`);
        } catch (e) {
          identityErrors.push(`user.email: ${String(e?.message || e).slice(0, 200)}`);
        }
        result.gitIdentityConfigured = identityErrors.length === 0;
        if (identityErrors.length) result.gitIdentityReason = identityErrors.join('; ').slice(0, 400);

        return resolve(result);
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });
}
