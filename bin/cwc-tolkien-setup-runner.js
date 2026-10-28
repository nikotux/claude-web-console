#!/usr/bin/env node
// bin/cwc-tolkien-setup-runner.js — prepara el clon de Tolkien de UN
// inquilino fuera del ciclo de vida del server. Comparte el store de pnpm
// mediante hardlinks, instala dependencias, compila y corre el typecheck. El
// progreso queda por paso en un job del HOME del host para poder reanudar una
// corrida interrumpida sin repetir trabajo ya terminado.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileAtomic, writeJsonAtomic } from '../src/core/atomic-write.js';
import {
  ensureUserSpace,
  hostUser,
  sanitizeUserId,
  userRunnerEnv,
  userSpace,
  userWorkspace,
} from '../src/core/user-space.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}

if (!args.user) {
  console.error('[tolkien-setup] falta --user');
  process.exit(2);
}

let USER;
try {
  USER = sanitizeUserId(args.user);
} catch (e) {
  console.error('[tolkien-setup] usuario inválido:', e?.message || e);
  process.exit(2);
}

const HOST_HOME = os.homedir();
const JOBS_DIR = path.join(HOST_HOME, '.cwc-data', 'tolkien-setup');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
const logFile = path.join(JOBS_DIR, `${USER}.log`);
const cloneDir = path.join(userWorkspace(USER), 'tolkien');
// El store del host ya contiene las dependencias públicas de Tolkien: compartirlo
// permite que el primer inquilino también use hardlinks y tenga costo marginal mínimo.
const SHARED_STORE = process.env.CWC_PNPM_SHARED_STORE
  || path.join(HOST_HOME, '.local', 'share', 'pnpm', 'store');
const configuredTimeout = Number(process.env.CWC_TOLKIEN_INSTALL_TIMEOUT_MS);
const INSTALL_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : 20 * 60 * 1000;

try {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(logFile, 'a', 0o600));
  fs.chmodSync(logFile, 0o600);
} catch (e) {
  console.error(`[tolkien-setup] no pude preparar ${JOBS_DIR}: ${e?.message || e}`);
  process.exit(1);
}

const SECRET_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, 'sk-ant-***REDACTADO***'],
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_]{20,})\b/g, '***REDACTADO***'],
  [/((?:_authToken|authToken|password|CWC_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)\s*=\s*)[^\s]+/gi, '$1***REDACTADO***'],
  [/(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1***REDACTADO***@'],
];

function redactSecrets(value) {
  let result = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function logLine(value) {
  try {
    fs.appendFileSync(logFile, redactSecrets(value) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // El log nunca puede tumbar el runner ni ocultar el estado del job.
  }
}

function previousState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    return parsed?.user === USER && parsed?.steps && typeof parsed.steps === 'object'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const previous = previousState();
if (previous?.status === 'running' && previous.pid !== process.pid && pidIsAlive(previous.pid)) {
  console.error(`[tolkien-setup] ya hay una corrida activa para ${USER} (pid ${previous.pid})`);
  process.exit(3);
}

// Los jobs anteriores a la incorporación de build deben reiniciarse completos.
const resumable = Boolean(previous && previous.status !== 'done' && previous.steps?.build);
const completedStep = (name) => {
  const step = resumable ? previous.steps?.[name] : null;
  return step?.status === 'done' || step?.status === 'skipped'
    ? step
    : { status: 'pending' };
};

let state = {
  user: USER,
  startedAt: resumable && previous.startedAt ? previous.startedAt : new Date().toISOString(),
  ts: Date.now(),
  status: 'running',
  pid: process.pid,
  steps: {
    store: completedStep('store'),
    install: completedStep('install'),
    build: completedStep('build'),
    typecheck: completedStep('typecheck'),
  },
  error: null,
};

function writeState() {
  state = { ...state, user: USER, ts: Date.now(), pid: process.pid };
  writeJsonAtomic(jobFile, state, { mode: 0o600, space: 2 });
}

function updateStep(name, patch) {
  state.steps[name] = { ...state.steps[name], ...patch };
  writeState();
}

function fail(message) {
  state.status = 'error';
  state.error = message;
  writeState();
  logLine(`[error] ${message}`);
}

function resolvePnpmBin() {
  const candidates = [];
  const configured = process.env.CWC_TOLKIEN_PNPM_BIN;
  if (configured) candidates.push(configured);
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'pnpm'));
  }
  candidates.push(
    path.join(HOST_HOME, '.local', 'share', 'pnpm', 'pnpm'),
    '/usr/local/bin/pnpm',
    '/usr/bin/pnpm',
  );

  for (const candidate of [...new Set(candidates)]) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Probamos la siguiente ubicación conocida.
    }
  }
  return null;
}

function updateTenantNpmrc() {
  fs.mkdirSync(SHARED_STORE, { recursive: true, mode: 0o755 });
  const npmrc = path.join(userSpace(USER), '.npmrc');
  let current = '';
  let mode = 0o600;
  try {
    current = fs.readFileSync(npmrc, 'utf8');
    mode = fs.statSync(npmrc).mode & 0o777;
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }

  const lines = current.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let updated = false;
  const next = [];
  for (const line of lines) {
    if (/^\s*store-dir\s*=/.test(line)) {
      if (!updated) next.push(`store-dir=${SHARED_STORE}`);
      updated = true;
    } else {
      next.push(line);
    }
  }
  if (!updated) next.push(`store-dir=${SHARED_STORE}`);
  writeFileAtomic(npmrc, next.join('\n') + '\n', { mode });
  return npmrc;
}

let activeChild = null;
let stopping = false;

function killActiveChild(signal = 'SIGKILL') {
  if (!activeChild?.pid) return;
  try {
    if (process.platform === 'win32') activeChild.kill(signal);
    else process.kill(-activeChild.pid, signal);
  } catch {
    try { activeChild.kill(signal); } catch { /* ya terminó */ }
  }
}

function cancel(signal) {
  if (stopping) return;
  stopping = true;
  killActiveChild('SIGTERM');
  const activeStep = Object.entries(state.steps).find(([, step]) => step.status === 'running');
  if (activeStep) {
    state.steps[activeStep[0]] = {
      ...activeStep[1],
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: `cancelado por ${signal}`,
    };
  }
  fail(`cancelado por ${signal}`);
  process.exit(1);
}

process.once('SIGTERM', () => cancel('SIGTERM'));
process.once('SIGINT', () => cancel('SIGINT'));

function runPnpm(pnpmBin, pnpmArgs, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const label = `pnpm ${pnpmArgs.join(' ')}`;
    logLine(`[comando] ${label}`);
    const outputBuffers = { stdout: '', stderr: '' };
    let outputTail = '';
    let timedOut = false;
    let settled = false;
    let timer = null;

    const flushLines = (stream, final = false) => {
      const parts = outputBuffers[stream].split(/\r?\n|\r/);
      outputBuffers[stream] = final ? '' : parts.pop();
      const complete = final ? parts : parts;
      for (const line of complete) {
        if (line) logLine(`[${stream}] ${line}`);
      }
      if (final && outputBuffers[stream]) {
        logLine(`[${stream}] ${outputBuffers[stream]}`);
        outputBuffers[stream] = '';
      }
    };

    const onData = (stream, data) => {
      const text = String(data);
      outputTail = (outputTail + text).slice(-100000);
      outputBuffers[stream] += text;
      flushLines(stream);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      flushLines('stdout', true);
      flushLines('stderr', true);
      activeChild = null;
      logLine(`[salida] ${label} code=${result.code ?? 'null'}${timedOut ? ' timeout' : ''}`);
      resolve({ ...result, timedOut, outputTail });
    };

    try {
      activeChild = spawn(pnpmBin, pnpmArgs, {
        cwd: cloneDir,
        env: userRunnerEnv(USER),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ code: null, error: e?.message || String(e) });
      return;
    }

    activeChild.stdout.on('data', (data) => onData('stdout', data));
    activeChild.stderr.on('data', (data) => onData('stderr', data));
    activeChild.once('error', (e) => finish({ code: null, error: e?.message || String(e) }));
    activeChild.once('exit', (code, signal) => finish({ code, signal }));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        logLine(`[timeout] ${label} superó ${timeoutMs} ms`);
        killActiveChild('SIGKILL');
      }, timeoutMs);
    }
  });
}

function lockfileMismatch(output) {
  return /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile[^]*(?:out.of.date|not.up.to.date|mismatch)|pnpm-lock\.yaml[^]*(?:not.up.to.date|doesn.t match)|specifiers in the lockfile[^]*don.t match/i.test(output);
}

async function main() {
  ensureUserSpace(USER);
  logLine(`[inicio] usuario=${USER} cwd=${cloneDir} hora=${new Date().toISOString()}`);
  if (resumable) logLine('[reanudar] se conservan los pasos ya terminados');
  writeState();

  if (state.steps.store.status === 'pending') {
    updateStep('store', { status: 'running', startedAt: new Date().toISOString() });
    try {
      if (USER === hostUser()) {
        updateStep('store', {
          status: 'skipped',
          finishedAt: new Date().toISOString(),
          reason: 'host conserva su store de pnpm',
        });
      } else {
        const npmrc = updateTenantNpmrc();
        updateStep('store', {
          status: 'done',
          finishedAt: new Date().toISOString(),
          storeDir: SHARED_STORE,
          npmrc,
        });
      }
    } catch (e) {
      const message = `No pude configurar el store compartido: ${e?.message || e}`;
      updateStep('store', { status: 'error', finishedAt: new Date().toISOString(), error: message });
      fail(message);
      return;
    }
  }

  if (!fs.existsSync(path.join(cloneDir, 'package.json'))) {
    const message = `No existe un clon de Tolkien utilizable en ${cloneDir}`;
    updateStep('install', { status: 'error', finishedAt: new Date().toISOString(), error: message });
    fail(message);
    return;
  }

  const pnpmBin = resolvePnpmBin();
  if (!pnpmBin) {
    const message = 'No encontré un binario ejecutable de pnpm. Instalalo en el host o definí CWC_TOLKIEN_PNPM_BIN con su ruta absoluta.';
    updateStep('install', { status: 'error', finishedAt: new Date().toISOString(), error: message });
    fail(message);
    return;
  }
  logLine(`[pnpm] binario=${pnpmBin}`);

  if (state.steps.install.status === 'pending') {
    updateStep('install', {
      status: 'running',
      startedAt: new Date().toISOString(),
      timeoutMs: INSTALL_TIMEOUT_MS,
      frozenLockfile: true,
      retriedWithoutFrozenLockfile: false,
    });
    const frozen = await runPnpm(
      pnpmBin,
      ['install', '--frozen-lockfile', '--store-dir', SHARED_STORE],
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    let installResult = frozen;

    if (frozen.code !== 0 && !frozen.timedOut && lockfileMismatch(frozen.outputTail)) {
      updateStep('install', {
        status: 'running',
        firstExitCode: frozen.code,
        retriedWithoutFrozenLockfile: true,
      });
      logLine('[install] lockfile desactualizado; único reintento sin --frozen-lockfile');
      installResult = await runPnpm(
        pnpmBin,
        ['install', '--store-dir', SHARED_STORE],
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
    }

    if (installResult.code !== 0) {
      const detail = installResult.timedOut
        ? `timeout tras ${INSTALL_TIMEOUT_MS} ms`
        : installResult.error || `exit ${installResult.code}${installResult.signal ? ` (${installResult.signal})` : ''}`;
      const message = `pnpm install falló: ${detail}`;
      updateStep('install', {
        status: 'error',
        finishedAt: new Date().toISOString(),
        exitCode: installResult.code,
        timedOut: installResult.timedOut,
        error: message,
      });
      fail(message);
      return;
    }

    updateStep('install', {
      status: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      timedOut: false,
    });
  }

  if (state.steps.build.status === 'pending') {
    updateStep('build', {
      status: 'running',
      startedAt: new Date().toISOString(),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const result = await runPnpm(pnpmBin, ['-r', 'build'], { timeoutMs: INSTALL_TIMEOUT_MS });
    if (result.code !== 0) {
      const detail = result.timedOut
        ? `timeout tras ${INSTALL_TIMEOUT_MS} ms`
        : result.error || `exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
      const message = `pnpm -r build falló: ${detail}`;
      updateStep('build', {
        status: 'error',
        finishedAt: new Date().toISOString(),
        exitCode: result.code,
        timedOut: result.timedOut,
        error: message,
      });
      logLine(`[error] ${message}`);
    } else {
      updateStep('build', {
        status: 'done',
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        timedOut: false,
      });
    }
  }

  if (state.steps.typecheck.status === 'pending') {
    updateStep('typecheck', { status: 'running', startedAt: new Date().toISOString() });
    const result = await runPnpm(pnpmBin, ['typecheck']);
    if (result.code !== 0) {
      const detail = result.error || `exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
      const message = `pnpm typecheck falló: ${detail}`;
      updateStep('typecheck', {
        status: 'error',
        finishedAt: new Date().toISOString(),
        exitCode: result.code,
        error: message,
      });
      logLine(`[error] ${message}`);
    } else {
      updateStep('typecheck', {
        status: 'done',
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      });
    }
  }

  const failedSteps = Object.entries(state.steps)
    .filter(([, step]) => step.status === 'error')
    .map(([name, step]) => `${name}: ${step.error || 'falló'}`);
  if (failedSteps.length > 0) {
    fail(failedSteps.join('; '));
    return;
  }

  state.status = 'done';
  state.error = null;
  writeState();
  logLine(`[fin] setup completo para ${USER}`);
}

main().catch((e) => {
  fail(`Fallo inesperado: ${e?.message || e}`);
  process.exitCode = 1;
});
