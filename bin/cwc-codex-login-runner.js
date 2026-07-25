#!/usr/bin/env node
// bin/cwc-codex-login-runner.js — runner PTY del login de Codex por usuario.
// Usa `codex login --device-auth` porque el flujo web normal abre un callback
// localhost que no sirve en un server remoto. Regla de oro: el proceso corre
// con HOME = espacio AISLADO del dueño y nunca expone auth.json; el job solo
// publica la URL, el código de un solo uso y el estado del flujo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import {
  ensureUserSpace,
  hasCodexCreds,
  userRunnerEnv,
  userWorkspace,
} from '../src/core/user-space.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}
const USER = args.user;
if (!USER) { console.error('[codex-login-runner] falta --user'); process.exit(2); }

// Este job pertenece al server host (que debe poder leerlo), no al userDataDir
// del inquilino. El runner hereda el entorno del server, así que os.homedir()
// resuelve el HOME del host, igual que en cwc-onboard-runner.js.
const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'codex-login-jobs');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
try {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
} catch (e) {
  console.error('[codex-login-runner] no pude crear el directorio de jobs:', e.message);
  process.exit(1);
}

function writeState(s) {
  try { fs.writeFileSync(jobFile, JSON.stringify({ ...s, user: USER, ts: Date.now() }), { mode: 0o600 }); }
  catch (e) { console.error('[codex-login-runner] no pude escribir estado:', e.message); }
}

const stripAnsi = (s) => s
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');
const URL_RE = /https:\/\/auth\.openai\.com\/[^\s'"\x1b]*/;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/;

try {
  ensureUserSpace(USER);
} catch (e) {
  writeState({ status: 'error', error: 'No pude preparar el espacio del usuario: ' + (e?.message || e) });
  process.exit(1);
}
writeState({ status: 'starting' });

let env;
let cwd;
try {
  env = userRunnerEnv(USER);
  cwd = userWorkspace(USER);
} catch (e) {
  writeState({ status: 'error', error: 'No pude preparar el entorno de Codex: ' + (e?.message || e) });
  process.exit(1);
}

let proc;
try {
  proc = pty.spawn('codex', ['login', '--device-auth'], {
    name: 'xterm-color',
    cols: 1000,
    rows: 50, // cols ALTO: evita que el PTY parta la URL y el regex la capture truncada
    cwd,
    env,
  });
} catch (e) {
  writeState({ status: 'error', error: 'No pude lanzar codex login: ' + (e?.message || e) });
  process.exit(1);
}

let buf = '';
let currentUrl = null;
let currentCode = null;
let done = false;
let cancelled = false;
let terminal = false;
let watchTimer = null;
let timeoutTimer = null;

function clearTimers() {
  if (watchTimer) clearInterval(watchTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
}

function stopWithError(error) {
  if (done || cancelled || terminal) return;
  terminal = true;
  clearTimers();
  writeState({ status: 'error', error });
  try { proc.kill(); } catch { /* noop */ }
  process.exit(0);
}

proc.onData((data) => {
  try {
    buf += data;
    if (buf.length > 200000) buf = buf.slice(-100000); // cap
    const clean = stripAnsi(buf);
    if (!currentUrl) {
      const urlMatch = clean.match(URL_RE);
      if (urlMatch) currentUrl = urlMatch[0];
    }
    // El código se busca solo después de ver la URL para no capturar basura
    // alfanumérica previa emitida por el CLI.
    if (currentUrl && !currentCode) {
      const afterUrl = clean.slice(clean.indexOf(currentUrl) + currentUrl.length);
      const codeMatch = afterUrl.match(CODE_RE);
      if (codeMatch) {
        currentCode = codeMatch[0];
        writeState({ status: 'awaiting-auth', url: currentUrl, code: currentCode });
      }
    }
  } catch (e) {
    stopWithError('Fallo inesperado procesando la salida de codex login: ' + (e?.message || e));
  }
});

watchTimer = setInterval(() => {
  try {
    let job;
    try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { job = null; }
    if (job?.status === 'cancelled') {
      cancelled = true;
      clearTimers();
      try { proc.kill(); } catch { /* noop */ }
      process.exit(0);
    }

    if (hasCodexCreds(USER)) {
      done = true;
      clearTimers();
      writeState({ status: 'done', done: true });
      try { proc.kill(); } catch { /* noop */ }
      process.exit(0);
    }
  } catch (e) {
    stopWithError('Fallo inesperado monitoreando codex login: ' + (e?.message || e));
  }
}, 2000);

proc.onExit(({ exitCode }) => {
  clearTimers();
  try {
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    if (job?.status === 'cancelled') cancelled = true;
  } catch { /* noop */ }
  // El CLI puede escribir auth.json y salir entre dos ticks del intervalo.
  if (!cancelled && !done && hasCodexCreds(USER)) {
    done = true;
    writeState({ status: 'done', done: true });
  }
  if (!done && !cancelled && !terminal) {
    writeState({ status: 'error', error: `codex login terminó (code ${exitCode}) sin credencial` });
  }
  process.exit(0);
});

// Timeout de seguridad: el código del dispositivo expira a los 15 minutos.
timeoutTimer = setTimeout(() => {
  stopWithError('timeout (15 min)');
}, 15 * 60 * 1000);
