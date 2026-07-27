#!/usr/bin/env node
// bin/cwc-infisical-login-runner.js — runner PTY del LOGIN GUIADO de
// Infisical. `infisical login` necesita interacción: imprime una URL, queda
// esperando un token de browser y termina escribiendo la sesión en el keyring
// propio del CLI. El server solo orquesta por archivos en ~/.cwc-data.
//
// SIEMPRE pasamos `--domain`: sin ese flag el CLI abre un menú de flechas para
// elegir hosting, imposible de guiar de forma estable desde la web.
//
// REGLA DURA DE SEGURIDAD: el valor que pega el usuario es un TOKEN DE ACCESO
// REAL. Nunca se escribe en el JSON del job, nunca se loguea y nunca se copia a
// campos de error. El archivo .token se crea 0600 desde el server y este runner
// lo borra inmediatamente después de escribirlo al pty. El buffer del pty puede
// contener el token ecoado, así que jamás volcamos la salida cruda a stdout ni a
// estado; exponemos únicamente la URL de login detectada.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import {
  ensureUserSpace,
  hasInfisicalCreds,
  hostUser,
  userRunnerEnv,
  userSpace,
} from '../src/core/user-space.js';
import { probeInfisicalStatus } from '../src/modules/mcps/infisical-shared.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}

const ID = args.id;
const USER = args.user;
const DOMAIN = args.domain || 'https://app.infisical.com';
if (!ID) { console.error('[infisical-login] falta --id'); process.exit(2); }

// El job pertenece siempre al server host, incluso cuando el PTY corre con el
// HOME aislado de un inquilino. Sin --user se conserva exactamente el flujo
// histórico de ⚙ Sistema → Conexiones.
const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'infisical-login');
const jobFile = path.join(JOBS_DIR, `${ID}.json`);
const tokenFile = path.join(JOBS_DIR, `${ID}.token`);
fs.mkdirSync(JOBS_DIR, { recursive: true });

function writeState(s) {
  try { fs.writeFileSync(jobFile, JSON.stringify({ ...s, id: ID, ts: Date.now() }), { mode: 0o600 }); }
  catch (e) { console.error('[infisical-login] no pude escribir estado:', e.message); }
}

const stripAnsi = (s) => String(s || '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');
const URL_RE = /https?:\/\/[^\s'"\x1b]+\/login\?[^\s'"\x1b]*callback_port=\d+/;

const isolatedUser = USER && USER !== hostUser();
let cwd = args.cwd || os.homedir();
let env = process.env;
if (isolatedUser) {
  try {
    ensureUserSpace(USER);
    cwd = userSpace(USER);
    env = userRunnerEnv(USER);
  } catch (e) {
    writeState({ status: 'error', error: 'No pude preparar el espacio del usuario: ' + (e?.message || e) });
    process.exit(1);
  }
}

writeState({ status: 'starting' });

let proc;
try {
  proc = pty.spawn('infisical', ['login', '--domain', DOMAIN], {
    name: 'xterm-color',
    cols: 1000,
    rows: 50,
    cwd,
    env,
  });
} catch (e) {
  writeState({ status: 'error', error: 'No pude lanzar infisical login: ' + e.message });
  process.exit(1);
}

let buf = '';
let url = null;
let tokenWritten = false;
let promptSeen = false;
let finalizing = false;
let terminal = false;
let watch = null;

function watchForToken() {
  if (watch) return;
  watch = setInterval(() => {
    if (tokenWritten || terminal) return;
    let v;
    try { v = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return; }
    if (!v) return;
    try { proc.write(v + '\r'); } catch { /* noop */ }
    tokenWritten = true;
    try { fs.unlinkSync(tokenFile); } catch { /* noop */ }
    writeState({ status: 'exchanging', url });
  }, 700);
}

async function finalize() {
  if (finalizing || terminal) return;
  finalizing = true;
  if (watch) clearInterval(watch);
  writeState({ status: 'verifying' });
  // La sonda compartida corre con el HOME del proceso (host). Para un
  // inquilino, la señal equivalente y suficiente es que el CLI haya escrito
  // su config dentro del HOME aislado.
  const st = isolatedUser
    ? { ok: hasInfisicalCreds(USER), email: null, expiresInText: null }
    : await probeInfisicalStatus();
  terminal = true;
  if (st.ok) {
    writeState({ status: 'done', done: true, email: st.email, expiresInText: st.expiresInText });
  } else {
    writeState({
      status: 'error',
      error: 'El login terminó pero la sesión no quedó activa (infisical login status sigue sin autenticar). El token pegado puede haber llegado tarde o incompleto — reintentá desde cero.',
    });
  }
  try { proc.kill(); } catch { /* noop */ }
  process.exit(0);
}

proc.onData((data) => {
  buf += data;
  if (buf.length > 200000) buf = buf.slice(-100000);
  const clean = stripAnsi(buf);
  if (!url) {
    const m = clean.match(URL_RE);
    if (m) {
      url = m[0];
      writeState({ status: 'awaiting-url', url });
      watchForToken();
    }
  }
  if (!promptSeen && /Paste your browser token here/i.test(clean)) promptSeen = true;
});

proc.onExit(({ exitCode }) => {
  if (watch) clearInterval(watch);
  if (finalizing || terminal) return;
  if (tokenWritten || exitCode === 0) { finalize(); return; }
  terminal = true;
  writeState({
    status: 'error',
    error: `infisical login terminó (code ${exitCode})` + (url ? '' : ' sin emitir la URL de autorización'),
  });
  process.exit(0);
});

setTimeout(() => {
  if (terminal || finalizing) return;
  terminal = true;
  if (watch) clearInterval(watch);
  writeState({ status: 'error', error: 'el login expiró por inactividad' });
  try { proc.kill(); } catch { /* noop */ }
  process.exit(0);
}, 10 * 60 * 1000);
