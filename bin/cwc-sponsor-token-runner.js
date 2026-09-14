#!/usr/bin/env node
// bin/cwc-sponsor-token-runner.js — runner PTY para generar el token propio de
// patrocinio. Corre `claude setup-token` con un HOME DESCARTABLE para no tocar
// las credenciales vivas del usuario, espera el código en <user>.code, captura
// el token y lo guarda en userOauthTokenPath (mode 600). Estado persistente en
// ~/.cwc-data/sponsor-token-jobs/<user>.json: si el server se reinicia, el job
// desacoplado sigue vivo y el panel puede reanudar el polling.
// El parseo del PTY de `claude setup-token` está duplicado con
// bin/cwc-onboard-runner.js; si cambia, hay que actualizar los dos.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { userRunnerEnv, userOauthTokenPath, ensureUserSpace } from '../src/core/user-space.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}
const USER = args.user;
if (!USER) { console.error('[sponsor-token-runner] falta --user'); process.exit(2); }
try {
  ensureUserSpace(USER);
} catch (e) {
  console.error('[sponsor-token-runner] usuario inválido o inaccesible:', e.message);
  process.exit(1);
}

const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'sponsor-token-jobs');
const jobFile = path.join(JOBS_DIR, `${USER}.json`);
const codeFile = path.join(JOBS_DIR, `${USER}.code`);
const logFile = path.join(JOBS_DIR, `${USER}.log`);
const scratchHome = path.join(JOBS_DIR, `${USER}.home`);
fs.mkdirSync(JOBS_DIR, { recursive: true });

function cleanupScratch() {
  try { fs.rmSync(scratchHome, { recursive: true, force: true }); }
  catch { /* la limpieza nunca puede tumbar el runner */ }
}

process.once('exit', cleanupScratch);
cleanupScratch();
fs.mkdirSync(scratchHome, { recursive: true, mode: 0o700 });

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
  catch (e) { console.error('[sponsor-token-runner] no pude escribir estado:', e.message); }
}

const stripAnsi = (s) => s
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');
const URL_RE = /https:\/\/claude\.com\/[^\s'"\x1b]*oauth\/authorize\?[^\s'"\x1b]+/;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;

logLine(`[inicio] usuario=${USER} cwd=${scratchHome} hora=${new Date().toISOString()}`);
writeState({ status: 'starting' });

const env = userRunnerEnv(USER); // env limpio por allowlist
env.HOME = scratchHome; // HOME descartable, NO el del usuario
delete env.CLAUDE_CODE_OAUTH_TOKEN; // login FRESCO

let proc;
try {
  proc = pty.spawn('claude', ['setup-token'], {
    name: 'xterm-color', cols: 1000, rows: 50,
    cwd: scratchHome, env,
  });
} catch (e) {
  writeState({ status: 'error', error: 'No pude lanzar setup-token: ' + e.message });
  cleanupScratch();
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
      // Ink se come el Enter cuando viaja en el mismo chunk que un código largo.
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
  cleanupScratch();
  process.exit(0);
}
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);

proc.onData((data) => {
  try {
    logLine(stripAnsi(data));
    buf += data;
    if (buf.length > 200000) buf = buf.slice(-100000);
    const clean = stripAnsi(buf);
    if (!urlSent) {
      const m = clean.match(URL_RE);
      if (m) {
        currentUrl = m[0];
        urlSent = true;
        writeState({ status: 'awaiting-code', url: currentUrl });
        watchForCode();
      }
    }
    if (codesSent > 0 && !done) {
      const t = clean.match(TOKEN_RE);
      if (t) {
        done = true;
        pendingSince = 0;
        try {
          fs.mkdirSync(path.dirname(userOauthTokenPath(USER)), { recursive: true, mode: 0o700 });
          fs.writeFileSync(userOauthTokenPath(USER), t[0], { mode: 0o600 });
          writeState({ status: 'done', done: true });
        } catch (e) {
          writeState({ status: 'error', error: 'No pude guardar el token: ' + e.message });
        }
        if (watchTimer) clearInterval(watchTimer);
        try { proc.kill(); } catch { /* noop */ }
        cleanupScratch();
      }
    }
  } catch (e) {
    writeState({ status: 'error', error: 'Fallo inesperado procesando la salida de setup-token: ' + (e?.message || e) });
    if (watchTimer) clearInterval(watchTimer);
    done = true;
    try { proc.kill(); } catch { /* noop */ }
    cleanupScratch();
  }
});

proc.onExit(({ exitCode }) => {
  logLine(`[salida] exitCode=${exitCode}`);
  if (watchTimer) clearInterval(watchTimer);
  if (!done) writeState({ status: 'error', error: `setup-token terminó (code ${exitCode}) sin emitir token` });
  cleanupScratch();
  process.exit(0);
});

// Timeout de seguridad (10 min).
setTimeout(() => {
  if (!done) {
    done = true;
    try { proc.kill(); } catch { /* noop */ }
    writeState({ status: 'error', error: 'timeout (10 min)' });
    cleanupScratch();
    process.exit(0);
  }
}, 10 * 60 * 1000);
