#!/usr/bin/env node
// bin/cwc-claude-login-runner.js — runner PTY del login COMPLETO de Claude
// por usuario. Corre `claude auth login --claudeai` con HOME = espacio
// AISLADO del inquilino, publica la URL OAuth, espera el código pegado en
// <user>.code y lo inyecta al stdin del PTY. El CLI guarda por sí mismo
// <userSpace>/.claude/.credentials.json; el runner jamás lee ni publica su
// contenido salvo para verificar que exista claudeAiOauth.accessToken.
// Estado en ~/.cwc-data/claude-login-jobs/<user>.json. El usuario HOST queda
// excluido fail-closed: sus credenciales se administran con su propio CLI.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import pty from 'node-pty';
import {
  ensureUserSpace,
  hostUser,
  userClaudeDir,
  userRunnerEnv,
  userWorkspace,
} from '../src/core/user-space.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}
const USER = args.user;
if (!USER) { console.error('[claude-login-runner] falta --user'); process.exit(2); }
if (USER === hostUser()) {
  console.error('[claude-login-runner] el usuario host no puede usar este runner; administrá su credencial con el CLI de Claude.');
  process.exit(2);
}

const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'claude-login-jobs');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
const codeFile = path.join(JOBS_DIR, `${USER}.code`);
const logFile = path.join(JOBS_DIR, `${USER}.log`);
try {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(codeFile); } catch { /* no había un código pendiente */ }
} catch (e) {
  console.error('[claude-login-runner] no pude preparar el directorio de jobs:', e.message);
  process.exit(1);
}

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{10,}/g;
let submittedCode = null;
function redactSecrets(s) {
  let redacted = String(s).replace(SECRET_RE, 'sk-ant-***REDACTADO***');
  if (submittedCode) redacted = redacted.replaceAll(submittedCode, '***CODIGO-REDACTADO***');
  return redacted;
}

function logLine(s) {
  try { fs.appendFileSync(logFile, redactSecrets(s) + '\n', { mode: 0o600 }); }
  catch { /* el log nunca puede tumbar el runner */ }
}

function writeState(s) {
  logLine(`[estado] ${s.status || 'desconocido'}`);
  try {
    fs.writeFileSync(
      jobFile,
      JSON.stringify({ ...s, user: USER, pid: process.pid, ts: Date.now() }),
      { mode: 0o600 },
    );
  } catch (e) {
    console.error('[claude-login-runner] no pude escribir estado:', e.message);
  }
}

const stripAnsi = (s) => s
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');
const URL_RE = /https:\/\/claude\.(?:ai|com)\/[^\s'"\x1b]*oauth\/authorize\?[^\s'"\x1b]+/;

let workspace;
let credentialsFile;
let env;
try {
  ensureUserSpace(USER);
  workspace = userWorkspace(USER);
  credentialsFile = path.join(userClaudeDir(USER), '.credentials.json');
  env = userRunnerEnv(USER);
  // Imprescindible: con el setup-token inyectado el CLI se considera ya
  // autenticado y no ofrece el login completo de la cuenta del inquilino.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
} catch (e) {
  writeState({ status: 'error', error: 'No pude preparar el espacio del usuario: ' + (e?.message || e) });
  process.exit(1);
}

logLine(`[inicio] usuario=${USER} cwd=${workspace} hora=${new Date().toISOString()}`);
writeState({ status: 'starting' });

let proc;
try {
  proc = pty.spawn('claude', ['auth', 'login', '--claudeai'], {
    name: 'xterm-color',
    cols: 1000,
    rows: 50, // cols ALTO: evita que el PTY parta la URL OAuth
    cwd: workspace,
    env,
  });
  writeState({ status: 'waiting-url' });
} catch (e) {
  writeState({ status: 'error', error: 'No pude lanzar claude auth login: ' + e.message });
  process.exit(1);
}

let buf = '';
let currentUrl = null;
let done = false;
let cancelled = false;
let terminal = false;
let watchTimer = null;
let urlTimer = null;
let timeoutTimer = null;

function clearTimers() {
  if (watchTimer) clearInterval(watchTimer);
  if (urlTimer) clearTimeout(urlTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
}

function credentialsAreValid() {
  try {
    const data = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    return typeof data?.claudeAiOauth?.accessToken === 'string'
      && data.claudeAiOauth.accessToken.length > 0;
  } catch {
    return false;
  }
}

function logAuthStatus() {
  try {
    const result = spawnSync('claude', ['auth', 'status', '--json'], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    logLine(`[auth-status] exitCode=${result.status ?? 'null'} signal=${result.signal || 'none'}`);
    if (result.stdout) logLine('[auth-status stdout] ' + stripAnsi(result.stdout).trim().slice(0, 4000));
    if (result.stderr) logLine('[auth-status stderr] ' + stripAnsi(result.stderr).trim().slice(0, 4000));
    if (result.error) logLine('[auth-status error] ' + (result.error.message || result.error));
  } catch (e) {
    logLine('[auth-status error] ' + (e?.message || e));
  }
}

function finishVerification(exitCode) {
  if (done || cancelled || terminal) return;
  terminal = true;
  clearTimers();
  writeState({ status: 'verifying' });
  const valid = credentialsAreValid();
  logAuthStatus(); // best-effort; toda salida pasa por redactSecrets()
  done = true;
  if (valid) {
    writeState({ status: 'ok' });
  } else {
    writeState({
      status: 'error',
      error: `Claude terminó (code ${exitCode}) pero no creó una credencial de cuenta válida.`,
    });
  }
  process.exit(0);
}

function watchForCode() {
  watchTimer = setInterval(() => {
    if (done || cancelled || terminal || submittedCode) return;
    let rawCode = '';
    try { rawCode = fs.readFileSync(codeFile, 'utf8'); } catch { /* todavía no hay código */ }
    const code = rawCode.trim();
    if (!rawCode) return;
    if (!code || code.length > 512 || /[\r\n]/.test(code)) {
      try { fs.unlinkSync(codeFile); } catch { /* noop */ }
      writeState({
        status: 'waiting-code',
        url: currentUrl,
        error: 'El código de autorización no tiene un formato válido. Pegalo de nuevo.',
      });
      return;
    }

    // Guardarlo antes de escribir al PTY permite redactar cualquier eco del
    // terminal. El código nunca se vuelca al log ni al estado.
    submittedCode = code;
    try { fs.unlinkSync(codeFile); } catch { /* noop */ }
    writeState({ status: 'verifying' });
    try { proc.write(code); } catch { /* noop */ }
    setTimeout(() => { try { proc.write('\r'); } catch { /* noop */ } }, 300);
    logLine(`[codigo] ${code.length} chars enviados; Enter diferido 300 ms`);
  }, 700);
}

function cancel() {
  if (done || cancelled) return;
  cancelled = true;
  clearTimers();
  try { proc.kill(); } catch { /* noop */ }
  process.exit(0);
}
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);

proc.onData((data) => {
  try {
    // Tras inyectar el código no se loguea más salida del PTY: algunos
    // terminales ecoan el pegado en fragmentos que no pueden redactarse con
    // seguridad comparando contra el valor completo.
    if (!submittedCode) logLine(stripAnsi(data));
    buf += data;
    if (buf.length > 200000) buf = buf.slice(-100000); // cap
    if (!currentUrl) {
      const match = stripAnsi(buf).match(URL_RE);
      if (match) {
        currentUrl = match[0];
        writeState({ status: 'url', url: currentUrl });
        watchForCode();
        // Deja `url` observable y luego explicita que el PTY espera el código.
        urlTimer = setTimeout(() => {
          if (!done && !cancelled && !terminal && !submittedCode) {
            writeState({ status: 'waiting-code', url: currentUrl });
          }
        }, 750);
      }
    }
  } catch (e) {
    terminal = true;
    clearTimers();
    writeState({ status: 'error', error: 'Fallo inesperado procesando la salida de claude auth login: ' + (e?.message || e) });
    try { proc.kill(); } catch { /* noop */ }
    process.exit(1);
  }
});

proc.onExit(({ exitCode }) => {
  logLine(`[salida] exitCode=${exitCode}`);
  finishVerification(exitCode);
});

// Timeout de seguridad (10 min).
timeoutTimer = setTimeout(() => {
  if (done || cancelled || terminal) return;
  terminal = true;
  clearTimers();
  try { proc.kill(); } catch { /* noop */ }
  writeState({ status: 'error', error: 'El login expiró, volvé a intentarlo.' });
  process.exit(0);
}, 10 * 60 * 1000);
