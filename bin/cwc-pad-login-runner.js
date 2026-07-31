#!/usr/bin/env node
// bin/cwc-pad-login-runner.js — runner PTY del login guiado del Pad local.
// Publica únicamente la URL de autorización y estados operativos; jamás
// expone la salida de `pad auth whoami` ni material de credenciales.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import pty from 'node-pty';
import { writeJsonAtomic } from '../src/core/atomic-write.js';
import {
  ensureUserSpace,
  hostUser,
  sanitizeUserId,
  userFileRoot,
  userPadDir,
  userRunnerEnv,
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
  console.error('[pad-login-runner] falta o es inválido --user:', error?.message || error);
  process.exit(2);
}

const PAD_BIN = path.join(os.homedir(), '.local', 'bin', 'pad');
const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'pad-login-jobs');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
const logFile = path.join(JOBS_DIR, `${USER}.log`);
const credBackupFile = path.join(JOBS_DIR, `${USER}.credentials.bak`);

try {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(JOBS_DIR, 0o700);
  fs.closeSync(fs.openSync(logFile, 'a', 0o600));
  fs.chmodSync(logFile, 0o600);
} catch (error) {
  console.error('[pad-login-runner] no pude preparar los archivos del runner:', error?.message || error);
  process.exit(1);
}

const SECRET_PATTERNS = [
  [/\bpadsess_[A-Za-z0-9._~-]+\b/gi, 'padsess_***REDACTADO***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***REDACTADO***'],
  [/(?:"|')?(?:access[_-]?token|refresh[_-]?token|token)(?:"|')?\s*[:=]\s*(?:"|')[^"']+(?:"|')/gi, 'token: "***REDACTADO***"'],
];

function redactSecrets(value) {
  let redacted = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function logLine(value) {
  try {
    fs.appendFileSync(logFile, redactSecrets(value) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // El diagnóstico nunca puede tumbar el runner.
  }
}

function writeState(state) {
  logLine(`[estado] ${state.status || 'desconocido'}`);
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
    console.error('[pad-login-runner] no pude escribir estado:', redactSecrets(error?.message || error));
  }
}

if (!fs.existsSync(PAD_BIN)) {
  writeState({
    status: 'error',
    error: 'No encontré el CLI de Pad en ~/.local/bin/pad.',
    done: true,
  });
  process.exit(1);
}

const stripAnsi = (value) => String(value)
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');
const URL_RE = /https?:\/\/\S+/;

let workspace;
let credentialsFile;
let env;
try {
  ensureUserSpace(USER);
  workspace = userFileRoot(USER);
  credentialsFile = USER === hostUser()
    ? path.join(os.homedir(), '.pad', 'credentials.json')
    : path.join(userPadDir(USER), 'credentials.json');
  env = userRunnerEnv(USER);
} catch (error) {
  writeState({
    status: 'error',
    error: 'No pude preparar el espacio del usuario: ' + redactSecrets(error?.message || error),
    done: true,
  });
  process.exit(1);
}

// Red de seguridad de console:PLAN-2446: un login interrumpido nunca debe
// romper la sesión de Pad que sostiene Pendientes, Aprendizaje, Mejora Continua
// y el tablero. La copia es privada, temporal y se elimina en todo cierre.
let hadCredentialsAtStart = false;
function backupCredentials() {
  if (!dropCredentialBackup()) return false;
  try {
    fs.copyFileSync(credentialsFile, credBackupFile);
    fs.chmodSync(credBackupFile, 0o600);
    hadCredentialsAtStart = true;
    logLine('[backup] credencial previa resguardada');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      hadCredentialsAtStart = false;
      return true;
    }
    logLine('[backup] no pude resguardar la credencial: ' + error.code);
    dropCredentialBackup();
    return false;
  }
}

function restoreCredentials() {
  if (!hadCredentialsAtStart) {
    try {
      fs.unlinkSync(credentialsFile);
      logLine('[restore] restaurado el estado previo sin credencial');
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      logLine('[restore] no pude quitar la credencial incompleta: ' + error.code);
      return false;
    }
  }
  try {
    fs.mkdirSync(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
    fs.copyFileSync(credBackupFile, credentialsFile);
    fs.chmodSync(credentialsFile, 0o600);
    logLine('[restore] credencial previa restaurada tras un login fallido');
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') logLine('[restore] no pude restaurar la credencial: ' + error.code);
    return false;
  }
}

function dropCredentialBackup() {
  try {
    fs.unlinkSync(credBackupFile);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    logLine('[backup] no pude borrar la copia temporal: ' + error.code);
    return false;
  }
}

function failAndRestore(error) {
  const restored = restoreCredentials();
  dropCredentialBackup();
  writeState({
    status: 'error',
    error: redactSecrets(error)
      + (restored && hadCredentialsAtStart ? ' La credencial anterior quedó restaurada.' : ''),
    done: true,
  });
}

logLine(`[inicio] usuario=${USER} cwd=${workspace} hora=${new Date().toISOString()}`);
writeState({ status: 'starting', done: false });

let proc;
if (!backupCredentials()) {
  writeState({
    status: 'error',
    error: 'No pude resguardar la credencial actual de Pad; no inicié el login.',
    done: true,
  });
  process.exit(1);
}
try {
  proc = pty.spawn(PAD_BIN, ['auth', 'login'], {
    name: 'xterm-color',
    cols: 1000,
    rows: 50,
    cwd: workspace,
    env,
  });
} catch (error) {
  failAndRestore('No pude lanzar pad auth login: ' + redactSecrets(error?.message || error));
  process.exit(1);
}

let buffer = '';
let currentUrl = null;
let done = false;
let cancelled = false;
let terminal = false;
let urlTimer = null;
let timeoutTimer = null;

function clearTimers() {
  if (urlTimer) clearTimeout(urlTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
}

function padSessionIsValid() {
  try {
    const result = spawnSync(PAD_BIN, ['auth', 'whoami'], {
      cwd: workspace,
      env,
      stdio: 'ignore',
      timeout: 15_000,
    });
    const valid = result.status === 0;
    logLine(`[verificación] sesión válida=${valid}`);
    return valid;
  } catch {
    logLine('[verificación] sesión válida=false');
    return false;
  }
}

function finishVerification(exitCode) {
  if (done || cancelled || terminal) return;
  terminal = true;
  clearTimers();
  writeState({ status: 'verifying', done: false });
  const valid = padSessionIsValid();
  done = true;
  if (valid) {
    dropCredentialBackup();
    writeState({ status: 'ok', done: true });
    process.exit(0);
  }
  failAndRestore(`Pad terminó (code ${exitCode}) pero pad auth whoami no confirmó una sesión válida.`);
  process.exit(1);
}

function cancel() {
  if (done || cancelled) return;
  cancelled = true;
  terminal = true;
  clearTimers();
  try { proc.kill(); } catch { /* ya terminó */ }
  restoreCredentials();
  dropCredentialBackup();
  process.exit(0);
}
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);

proc.onData((data) => {
  try {
    const clean = stripAnsi(data);
    logLine(clean);
    buffer += clean;
    if (buffer.length > 200_000) buffer = buffer.slice(-100_000);
    if (!currentUrl) {
      const match = buffer.match(URL_RE);
      if (match) {
        currentUrl = match[0];
        if (urlTimer) clearTimeout(urlTimer);
        writeState({ status: 'awaiting-auth', url: currentUrl, done: false });
      }
    }
  } catch (error) {
    terminal = true;
    clearTimers();
    failAndRestore('Fallo inesperado procesando la salida de pad auth login: ' + (error?.message || error));
    try { proc.kill(); } catch { /* ya terminó */ }
    process.exit(1);
  }
});

proc.onExit(({ exitCode }) => {
  logLine(`[salida] exitCode=${exitCode}`);
  finishVerification(exitCode);
});

// Si el CLI depende de abrir un navegador y no imprime la URL, degradamos con
// una explicación útil en vez de dejar el panel esperando indefinidamente.
urlTimer = setTimeout(() => {
  if (done || cancelled || terminal || currentUrl) return;
  terminal = true;
  clearTimers();
  try { proc.kill(); } catch { /* ya terminó */ }
  failAndRestore('El CLI de Pad no publicó una URL de autorización; puede requerir un navegador local. Probá `pad auth login` en una terminal.');
  process.exit(1);
}, 90_000);

// Timeout de seguridad global (10 min).
timeoutTimer = setTimeout(() => {
  if (done || cancelled || terminal) return;
  terminal = true;
  clearTimers();
  try { proc.kill(); } catch { /* ya terminó */ }
  failAndRestore('El login de Pad expiró, volvé a intentarlo.');
  process.exit(1);
}, 10 * 60 * 1000);
