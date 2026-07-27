#!/usr/bin/env node
// bin/cwc-onboard-runner.js — runner PTY del onboarding (SP7). Corre
// `claude setup-token` con HOME = espacio AISLADO del inquilino, parsea la URL
// OAuth (flujo code=true, ver PLAN-561), espera el código pegado (archivo
// <hash?>.code → lo escribimos por username), lo inyecta al stdin del PTY,
// captura el token de salida y lo guarda en userOauthTokenPath (mode 600). Al
// FINALIZAR el wizard, el server consume la invitación vía POST /public/finish:
// así los pasos posteriores (Codex) todavía pueden validarla. Hasta ese cierre
// o su TTL queda locked. Estado en ~/.cwc-data/onboard-jobs/<user>.json.
// Reanudable en el sentido de que el estado persiste: si el PTY muere en un
// reinicio, el job queda 'error'/stale y el usuario reintenta. setup-token
// REQUIERE TTY → node-pty.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { userWorkspace, userRunnerEnv, userOauthTokenPath, ensureUserSpace } from '../src/core/user-space.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}
const USER = args.user;
if (!USER) { console.error('[onboard-runner] falta --user'); process.exit(2); }

const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'onboard-jobs');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
const codeFile = path.join(JOBS_DIR, `${USER}.code`);
const logFile = path.join(JOBS_DIR, `${USER}.log`);
fs.mkdirSync(JOBS_DIR, { recursive: true });

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{10,}/g;
function redactSecrets(s) {
  return String(s).replace(SECRET_RE, 'sk-ant-***REDACTADO***');
}

function logLine(s) {
  try { fs.appendFileSync(logFile, redactSecrets(s) + '\n', { mode: 0o600 }); }
  catch { /* el log nunca puede tumbar el runner */ }
}

function writeState(s) {
  logLine(`[estado] ${s.status || 'desconocido'}`);
  try { fs.writeFileSync(jobFile, JSON.stringify({ ...s, user: USER, pid: process.pid, ts: Date.now() }), { mode: 0o600 }); }
  catch (e) { console.error('[onboard-runner] no pude escribir estado:', e.message); }
}

const stripAnsi = (s) => s
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');
const URL_RE = /https:\/\/claude\.com\/[^\s'"\x1b]*oauth\/authorize\?[^\s'"\x1b]+/;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}/; // token largo de setup-token (validar formato EN VIVO)

const workspace = userWorkspace(USER);
logLine(`[inicio] usuario=${USER} cwd=${workspace} hora=${new Date().toISOString()}`);
ensureUserSpace(USER);
writeState({ status: 'starting' });

const env = userRunnerEnv(USER); // HOME = espacio del inquilino, env limpio
delete env.CLAUDE_CODE_OAUTH_TOKEN; // login FRESCO (que use la cuenta del inquilino)

let proc;
try {
  proc = pty.spawn('claude', ['setup-token'], {
    name: 'xterm-color', cols: 1000, rows: 50, // cols ALTO: la URL OAuth es larga; con cols chico el PTY la parte en líneas y el regex la captura truncada
    cwd: workspace, env,
  });
} catch (e) {
  writeState({ status: 'error', error: 'No pude lanzar setup-token: ' + e.message });
  process.exit(1);
}

let buf = '';
let currentUrl = null;
let urlSent = false;
let codesSent = 0;
let pendingSince = 0;
let done = false;
let watchTimer = null;

function outputNote() {
  const lines = stripAnsi(buf)
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/https?:\/\//i.test(line))
    .filter((line) => !/^\*+$/.test(line))
    .filter((line) => !/^[\x00-\x1f\x7f-\x9f]+$/.test(line))
    .filter((line) => {
      const normalized = line.replace(/\s/g, '').toLowerCase();
      return ![
        'pastecodehere',
        'browserdidntopen',
        "browserdidn'topen",
        'usetheurlbelow',
        'presenter',
        'pressentertoretry',
        'retrying',
      ].some((noise) => normalized.includes(noise));
    });
  const errorLine = lines
    .slice()
    .reverse()
    .find((line) => /error|failed|invalid|expired|denied|unauthorized|forbidden|timeout/i.test(line));
  if (errorLine) {
    return redactSecrets(errorLine).slice(0, 300);
  }
  return redactSecrets('No hubo respuesta del canje. Verificá que hayas copiado el código COMPLETO (incluida la parte después del #) y que la cuenta de Claude con la que autorizaste tenga una suscripción activa.');
}

function watchForCode() {
  watchTimer = setInterval(() => {
    if (done) return;
    if (pendingSince && Date.now() - pendingSince > 20000) {
      pendingSince = 0;
      writeState({ status: 'awaiting-code', url: currentUrl, note: outputNote() });
    }
    let code = '';
    try { code = fs.readFileSync(codeFile, 'utf8').trim(); } catch { /* todavía no hay código */ }
    if (code) {
      // El Enter va APARTE y con retardo: `claude setup-token` (Ink) detecta el
      // pegado y, si el \r viaja en el mismo chunk que un código largo, se lo
      // traga como parte del texto y nunca envía el formulario. Verificado con
      // el log del PTY: un código de 35 chars se enviaba, uno de 92 no.
      try { proc.write(code); } catch { /* noop */ }
      setTimeout(() => { try { proc.write('\r'); } catch { /* noop */ } }, 300);
      logLine(`[codigo] ${code.length} chars enviados; Enter diferido 300 ms`);
      try { fs.unlinkSync(codeFile); } catch { /* noop */ }
      codesSent += 1;
      pendingSince = Date.now();
      writeState({ status: 'exchanging', url: currentUrl });
    }
  }, 700);
}

function cancel() {
  done = true;
  if (watchTimer) clearInterval(watchTimer);
  writeState({ status: 'error', error: 'cancelado' });
  try { proc.kill(); } catch { /* noop */ }
  process.exit(0);
}
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);

proc.onData((data) => {
  try {
    logLine(stripAnsi(data));
    buf += data;
    if (buf.length > 200000) buf = buf.slice(-100000); // cap
    const clean = stripAnsi(buf);
    if (!urlSent) {
      const m = clean.match(URL_RE);
      if (m) { currentUrl = m[0]; urlSent = true; writeState({ status: 'awaiting-code', url: currentUrl }); watchForCode(); }
    }
    if (codesSent > 0 && !done) {
      const t = clean.match(TOKEN_RE);
      if (t) {
        done = true;
        pendingSince = 0;
        try {
          fs.writeFileSync(userOauthTokenPath(USER), t[0], { mode: 0o600 });
          writeState({ status: 'done', done: true });
        } catch (e) {
          writeState({ status: 'error', error: 'No pude guardar el token: ' + e.message });
        }
        if (watchTimer) clearInterval(watchTimer);
        try { proc.kill(); } catch { /* noop */ }
      }
    }
  } catch (e) {
    writeState({ status: 'error', error: 'Fallo inesperado procesando la salida de setup-token: ' + (e?.message || e) });
    if (watchTimer) clearInterval(watchTimer);
    done = true;
    try { proc.kill(); } catch { /* noop */ }
  }
});

proc.onExit(({ exitCode }) => {
  logLine(`[salida] exitCode=${exitCode}`);
  if (watchTimer) clearInterval(watchTimer);
  if (!done) writeState({ status: 'error', error: `setup-token terminó (code ${exitCode}) sin emitir token` });
  process.exit(0);
});

// Timeout de seguridad (10 min).
setTimeout(() => {
  if (!done) { try { proc.kill(); } catch { /* noop */ } writeState({ status: 'error', error: 'timeout (10 min)' }); process.exit(0); }
}, 10 * 60 * 1000);
