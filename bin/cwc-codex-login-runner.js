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
  codexCredState,
  ensureUserSpace,
  userFileRoot,
  userRunnerEnv,
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
  // cwd = userFileRoot(USER), NUNCA userWorkspace(USER): para un inquilino dan
  // el mismo path, pero para el HOST userWorkspace apunta a `~/workspace`, que
  // ensureUserSpace no crea (el host usa su HOME real) y por lo tanto no
  // existe. El PTY moría en el chdir con `chdir(2) failed` y exitCode 1 ANTES
  // de que codex imprimiera nada, así que el usuario tocaba "Reconectar" y
  // veía la tarjeta repintarse igual (console:BUG-2747). Mismo gotcha ya
  // documentado en cwc-claude-login-runner.js.
  cwd = userFileRoot(USER);
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
} catch (e) {
  writeState({ status: 'error', error: 'No pude preparar el entorno de Codex: ' + (e?.message || e) });
  process.exit(1);
}

// Baseline ANTES de lanzar el login: el éxito es que la credencial CAMBIE, no
// que exista. Antes se miraba sólo la existencia de auth.json y, con una sesión
// vencida en disco, el runner se declaraba `done` en su primer tick y mataba el
// `codex login` antes de que el usuario pudiera autorizar (bug real, ago-2026).
const baseline = codexCredState(USER);

function credRenewed() {
  const now = codexCredState(USER);
  if (!now.present) return false;
  if (!baseline.present) return true; // no había nada: cualquier credencial es nueva
  if (now.lastRefresh != null && (baseline.lastRefresh == null || now.lastRefresh > baseline.lastRefresh)) return true;
  if (now.mtimeMs != null && baseline.mtimeMs != null && now.mtimeMs > baseline.mtimeMs) return true;
  return false;
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

    if (credRenewed()) {
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
  if (!cancelled && !done && credRenewed()) {
    done = true;
    writeState({ status: 'done', done: true });
  }
  if (!done && !cancelled && !terminal) {
    // Si el CLI murió sin llegar a mostrar la URL, el mensaje genérico ESCONDE
    // la causa real (fue el caso de console:BUG-2747: `chdir(2) failed` invisible
    // durante toda la vida del bug). Cuando no hubo URL, el error lleva las
    // últimas líneas reales del PTY. NUNCA se incluye el código de un solo uso:
    // esa rama solo corre cuando currentUrl es null, o sea antes de que exista.
    const tail = stripAnsi(buf)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' · ')
      .slice(0, 300);
    writeState({
      status: 'error',
      error: (!currentUrl && tail)
        ? `El login de Codex terminó sin llegar a mostrar el código (salida: ${tail}). Código de salida: ${exitCode}.`
        : 'El login de Codex terminó sin renovar la credencial. Volvé a intentarlo.',
    });
  }
  process.exit(0);
});

// Timeout de seguridad: el código del dispositivo expira a los 15 minutos.
timeoutTimer = setTimeout(() => {
  stopWithError('timeout (15 min)');
}, 15 * 60 * 1000);
