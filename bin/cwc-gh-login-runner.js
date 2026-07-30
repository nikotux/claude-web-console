#!/usr/bin/env node
// bin/cwc-gh-login-runner.js — login GitHub por device flow para UN usuario.
// El CLI corre con HOME aislado; el job y el log quedan en el HOME del host
// para que el server pueda retomarlos. Ninguna salida llega al log sin pasar
// por la redacción de tokens de GitHub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeJsonAtomic } from '../src/core/atomic-write.js';
import {
  ensureUserSpace,
  sanitizeUserId,
  userRunnerEnv,
  userWorkspace,
} from '../src/core/user-space.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const key = process.argv[i];
  if (key.startsWith('--')) args[key.slice(2)] = process.argv[i + 1];
}

let USER;
try {
  USER = sanitizeUserId(args.user);
} catch (error) {
  console.error('[gh-login-runner] falta o es inválido --user:', error?.message || error);
  process.exit(2);
}

const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'gh-login-jobs');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
const logFile = path.join(JOBS_DIR, `${USER}.log`);
const DEVICE_URL = 'https://github.com/login/device';
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const TOKEN_PATTERNS = [
  [/\bgh[pousr]_[A-Za-z0-9_]+\b/gi, '***TOKEN-GITHUB-REDACTADO***'],
  [/\bgithub_pat_[A-Za-z0-9_]+\b/gi, '***TOKEN-GITHUB-REDACTADO***'],
];

try {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(logFile, 'a', 0o600));
  fs.chmodSync(logFile, 0o600);
} catch (error) {
  console.error('[gh-login-runner] no pude preparar los archivos del runner:', error?.message || error);
  process.exit(1);
}

function redactSecrets(value) {
  let result = String(value ?? '');
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function logLine(value) {
  try {
    fs.appendFileSync(logFile, redactSecrets(value) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // El diagnóstico nunca puede tumbar el runner.
  }
}

function writeState(state) {
  try {
    const safeState = {
      ...state,
      ...(state.error ? { error: redactSecrets(state.error) } : {}),
    };
    writeJsonAtomic(jobFile, {
      ...safeState,
      user: USER,
      pid: process.pid,
      ts: Date.now(),
    }, { mode: 0o600 });
  } catch (error) {
    console.error('[gh-login-runner] no pude escribir estado:', redactSecrets(error?.message || error));
  }
}

const stripAnsi = (value) => String(value)
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');

let env;
let cwd;
try {
  ensureUserSpace(USER);
  env = { ...userRunnerEnv(USER), GH_BROWSER: 'true' };
  cwd = userWorkspace(USER);
} catch (error) {
  writeState({
    status: 'error',
    error: 'No pude preparar el espacio del usuario: ' + redactSecrets(error?.message || error),
  });
  process.exit(1);
}

function githubConnected() {
  const result = spawnSync('gh', ['auth', 'status'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.stdout) logLine(stripAnsi(result.stdout));
  if (result.stderr) logLine(stripAnsi(result.stderr));
  return result.status === 0;
}

function setupGit() {
  writeState({ status: 'setup-git' });
  const result = spawnSync('gh', ['auth', 'setup-git'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.stdout) logLine(stripAnsi(result.stdout));
  if (result.stderr) logLine(stripAnsi(result.stderr));
  if (result.error || result.status !== 0) {
    const detail = result.stderr || result.error?.message || `exit ${result.status}`;
    return {
      ok: false,
      error: 'GitHub quedó conectado, pero no pude configurar Git HTTPS: '
        + redactSecrets(stripAnsi(detail)).trim().slice(0, 300),
    };
  }
  return { ok: true };
}

if (githubConnected()) {
  const configured = setupGit();
  writeState(configured.ok
    ? { status: 'done', done: true }
    : { status: 'error', error: configured.error });
  process.exit(configured.ok ? 0 : 1);
}

writeState({ status: 'starting' });

let proc;
try {
  // Deliberadamente NO usamos PTY: con TTY, `gh` entra en modo interactivo y
  // se cuelga esperando respuestas que no logra leer del PTY. Sin TTY va
  // directo al device flow y emite el código por stderr.
  proc = spawn('gh', [
    'auth',
    'login',
    '--hostname', 'github.com',
    '--git-protocol', 'https',
    '--web',
  ], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  writeState({
    status: 'error',
    error: 'No pude lanzar gh auth login: ' + redactSecrets(error?.message || error),
  });
  process.exit(1);
}

let output = '';
let currentCode = '';
let terminal = false;
let cancelled = false;
let timeoutTimer = null;

function clearTimer() {
  if (timeoutTimer) clearTimeout(timeoutTimer);
}

function stop(status, error) {
  if (terminal) return;
  terminal = true;
  clearTimer();
  if (output) logLine(stripAnsi(output));
  writeState({ status, ...(error ? { error: redactSecrets(error) } : {}) });
  try { proc.kill(); } catch { /* ya terminó */ }
}

function cancel() {
  cancelled = true;
  stop('error', 'Login de GitHub cancelado.');
}

process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);

function processOutput(data) {
  try {
    output += data;
    if (output.length > 200_000) output = output.slice(-100_000);
    const clean = stripAnsi(output);
    if (!currentCode) {
      const match = clean.match(CODE_RE);
      if (match) {
        currentCode = match[0];
        writeState({
          status: 'awaiting-auth',
          url: DEVICE_URL,
          code: currentCode,
        });
      }
    }
  } catch (error) {
    stop('error', 'Fallo procesando gh auth login: ' + (error?.message || error));
  }
}

proc.stdout.on('data', processOutput);
proc.stderr.on('data', processOutput);

proc.on('error', (error) => {
  stop('error', 'No pude lanzar gh auth login: ' + redactSecrets(error?.message || error));
  process.exit(1);
});

proc.on('exit', (code) => {
  clearTimer();
  if (output) logLine(stripAnsi(output));
  if (terminal || cancelled) {
    process.exit(0);
    return;
  }
  terminal = true;
  if (!githubConnected()) {
    writeState({
      status: 'error',
      error: `gh auth login terminó (code ${code}) sin una sesión válida.`,
    });
    process.exit(1);
    return;
  }
  const configured = setupGit();
  writeState(configured.ok
    ? { status: 'done', done: true }
    : { status: 'error', error: configured.error });
  process.exit(configured.ok ? 0 : 1);
});

timeoutTimer = setTimeout(() => {
  stop('error', 'El código de GitHub expiró; volvé a intentarlo.');
  process.exit(0);
}, 15 * 60 * 1000);
