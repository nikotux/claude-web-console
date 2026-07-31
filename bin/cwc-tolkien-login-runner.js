#!/usr/bin/env node
// Recibe la cookie de Tolkien exclusivamente por STDIN —nunca por argv ni por
// un archivo intermedio—, la verifica contra Tolkien y recién entonces la
// persiste. El job es estado administrativo host-owned, como los demás login
// runners; el dato del usuario vive en userDataDir(USER).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic } from '../src/core/atomic-write.js';
import { sanitizeUserId, userDataDir } from '../src/core/user-space.js';
import {
  TOLKIEN_COOKIE_NAME,
  buildTolkienStorageState,
  isValidTolkienCookie,
  readTolkienSessionState,
  tolkienSessionFile,
  verifyTolkienSession,
  writeTolkienConnection,
  writeTolkienSessionState,
} from '../src/core/connections-tolkien.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const key = process.argv[i];
  if (key.startsWith('--')) args[key.slice(2)] = process.argv[i + 1];
}

let USER;
try {
  USER = sanitizeUserId(args.user);
} catch (error) {
  console.error('[tolkien-login-runner] falta o es inválido --user:', error?.message || error);
  process.exit(2);
}

// Estado ADMINISTRATIVO host-owned indexado por <user>: lo escribe y consulta
// el server. El dato del usuario NO vive acá, sino en userDataDir(USER).
const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'tolkien-login-jobs');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
const logFile = path.join(JOBS_DIR, `${USER}.log`);

try {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(JOBS_DIR, 0o700);
  fs.closeSync(fs.openSync(logFile, 'a', 0o600));
  fs.chmodSync(logFile, 0o600);
} catch (error) {
  console.error('[tolkien-login-runner] no pude preparar los archivos del runner:', error?.message || error);
  process.exit(1);
}

let cookie = null;
let terminal = false;
let globalTimer = null;

function redact(text) {
  let safe = String(text ?? '');
  if (cookie) safe = safe.split(cookie).join('***COOKIE***');
  return safe.replace(
    /__Secure-tolkien\.session=[^\s;]+/g,
    '__Secure-tolkien.session=***',
  );
}

function logLine(text) {
  try {
    fs.appendFileSync(logFile, redact(text) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // El diagnóstico nunca puede tumbar el runner.
  }
}

function writeState(state) {
  logLine(`[estado] ${state.status || 'desconocido'}`);
  try {
    const safeState = {
      ...state,
      ...(state.error ? { error: redact(state.error) } : {}),
    };
    writeJsonAtomic(jobFile, {
      ...safeState,
      user: USER,
      pid: process.pid,
      ts: Date.now(),
    }, { mode: 0o600 });
  } catch (error) {
    console.error('[tolkien-login-runner] no pude escribir estado:', redact(error?.message || error));
  }
}

function finish(state, exitCode) {
  if (terminal) return;
  terminal = true;
  if (globalTimer) clearTimeout(globalTimer);
  writeState(state);
  process.exit(exitCode);
}

function cancel() {
  finish({ status: 'cancelled', done: true }, 0);
}
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);

function readCookieFromStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('No recibí la cookie de sesión.'));
    }, 15_000);

    function cleanup() {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    }
    function onData(chunk) {
      input += chunk;
    }
    function onEnd() {
      cleanup();
      const value = input.trim();
      if (!value) {
        reject(new Error('No recibí la cookie de sesión.'));
        return;
      }
      resolve(value);
    }
    function onError() {
      cleanup();
      reject(new Error('No recibí la cookie de sesión.'));
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

async function main() {
  writeState({ status: 'starting', done: false });
  globalTimer = setTimeout(() => {
    finish({
      status: 'error',
      error: 'La verificación de la sesión de Tolkien tardó demasiado.',
      done: true,
    }, 1);
  }, 120_000);

  try {
    cookie = await readCookieFromStdin();
  } catch {
    finish({ status: 'error', error: 'No recibí la cookie de sesión.', done: true }, 1);
    return;
  }

  if (!isValidTolkienCookie(cookie)) {
    finish({
      status: 'error',
      error: 'El valor recibido no tiene la forma de una cookie de sesión de Tolkien.',
      done: true,
    }, 1);
    return;
  }

  writeState({ status: 'verifying', done: false });
  const dataDir = userDataDir(USER);
  const result = await verifyTolkienSession(cookie);
  if (!result.ok) {
    // Hasta acá no se escribió ningún dato del usuario: una verificación
    // fallida deja intacta la conexión anterior y no necesita backup previo.
    finish({ status: 'error', error: result.message, done: true }, 1);
    return;
  }

  const previousSession = readTolkienSessionState(dataDir);
  writeTolkienSessionState(
    dataDir,
    buildTolkienStorageState(result.cookieValue, Math.floor(result.expiresAt / 1000)),
  );
  const nowIso = new Date().toISOString();
  try {
    writeTolkienConnection(dataDir, {
      provider: 'tolkien',
      account: result.email,
      name: result.name,
      cookieName: TOLKIEN_COOKIE_NAME,
      sessionFile: tolkienSessionFile(dataDir),
      connectedAt: nowIso,
      verifiedAt: nowIso,
      expiresAt: result.expiresAt,
      expiresAtSource: result.expiresAtSource,
      rotated: result.rotated,
      error: null,
    });
  } catch (error) {
    try {
      if (previousSession) {
        writeTolkienSessionState(dataDir, previousSession);
      } else {
        try { fs.unlinkSync(tolkienSessionFile(dataDir)); } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
      }
    } catch (restoreError) {
      logLine('[restore] no pude restaurar la sesión anterior: ' + restoreError?.message);
    }
    throw error;
  }

  finish({
    status: 'ok',
    done: true,
    account: result.email,
    expiresAt: result.expiresAt,
    expiresAtSource: result.expiresAtSource,
    error: null,
  }, 0);
}

main().catch((error) => {
  finish({
    status: 'error',
    error: redact(error?.message || error),
    done: true,
  }, 1);
});
