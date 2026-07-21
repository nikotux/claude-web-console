#!/usr/bin/env node
// bin/cwc-mcp-login-runner.js — runner PTY de la RECONEXIÓN OAuth guiada del
// módulo `mcps` (Fase 2). Corre `claude mcp login <name>` con el cwd del mundo,
// captura la URL de authorize que imprime, espera la URL de redirect que el
// usuario pega (archivo <id>.url → la escribe al stdin del pty), detecta el
// éxito y persiste el estado en ~/.cwc-data/mcp-login/<id>.json.
//
// `claude mcp login` EXIGE un TTY (con stdin no-terminal aborta: "stdin isn't a
// terminal") → node-pty. Mismo patrón y cuidados que bin/cwc-onboard-runner.js
// (cols alto para no truncar la URL larga; estado en disco reanudable). NO
// importa core/config.js: el cwd llega por --cwd (el server ya lo resolvió).
//
// VERIFICACIÓN ANTES DE "done" (2026-07-20, bug real: el proceso puede
// terminar con exit 0 —o imprimir un texto que matchea OK_RE— sin que el
// intercambio de código OAuth haya quedado realmente conectado, p.ej. si el
// código pegado ya expiró. Antes el runner confiaba en esa señal débil y
// reportaba "done" con la conexión todavía en `Needs authentication`,
// confundiendo al usuario). Ahora, antes de escribir 'done', se re-verifica
// con `claude mcp list` (misma fuente que usa el panel) — solo si el server
// aparece de verdad como conectado se reporta éxito.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { runMcpList } from '../src/modules/mcps/login-shared.js';

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}
const CWD = args.cwd;
const NAME = args.name;
const ID = args.id;
if (!CWD || !NAME || !ID) { console.error('[mcp-login] faltan --cwd/--name/--id'); process.exit(2); }

const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'mcp-login');
const jobFile = path.join(JOBS_DIR, `${ID}.json`);
const codeFile = path.join(JOBS_DIR, `${ID}.url`);
fs.mkdirSync(JOBS_DIR, { recursive: true });

function writeState(s) {
  try { fs.writeFileSync(jobFile, JSON.stringify({ ...s, id: ID, name: NAME, ts: Date.now() }), { mode: 0o600 }); }
  catch (e) { console.error('[mcp-login] no pude escribir estado:', e.message); }
}

const stripAnsi = (s) => s
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][AB012]/g, '');
// URL de authorize de CUALQUIER proveedor OAuth (getpad, honcho, claude.ai…).
const URL_RE = /https?:\/\/[^\s'"\x1b]+authorize\?[^\s'"\x1b]+/;
const OK_RE = /authenticat|success|logged in|now connected/i;

writeState({ status: 'starting' });

let proc;
try {
  proc = pty.spawn('claude', ['mcp', 'login', NAME], {
    name: 'xterm-color', cols: 1000, rows: 50, // cols alto: la URL OAuth es larga; con cols chico el PTY la parte y el regex la trunca
    cwd: CWD, env: process.env,
  });
} catch (e) {
  writeState({ status: 'error', error: 'No pude lanzar claude mcp login: ' + e.message });
  process.exit(1);
}

let buf = '';
let url = null;
let urlWritten = false;
let done = false;
let watch = null;

function watchForCode() {
  watch = setInterval(() => {
    if (urlWritten || done) return;
    let v;
    try { v = fs.readFileSync(codeFile, 'utf8').trim(); } catch { return; }
    if (v) {
      try { proc.write(v + '\r'); } catch { /* noop */ }
      urlWritten = true;
      try { fs.unlinkSync(codeFile); } catch { /* noop */ }
      writeState({ status: 'exchanging', url });
    }
  }, 700);
}

async function verifyConnected() {
  try {
    const { servers } = await runMcpList(CWD);
    const s = servers.find((x) => x.name === NAME);
    return !!(s && s.status && s.status.code === 'connected');
  } catch { return false; }
}

// Punto ÚNICO de cierre exitoso: NUNCA escribe 'done' a ciegas — re-verifica
// contra `claude mcp list` antes de confirmar. `finalizing` evita doble
// disparo si onData y onExit calzan casi juntos.
let finalizing = false;
async function finalize() {
  if (finalizing) return;
  finalizing = true;
  writeState({ status: 'verifying', url });
  const connected = await verifyConnected();
  if (connected) {
    writeState({ status: 'done', done: true, url });
  } else {
    writeState({
      status: 'error',
      error: 'El login se cerró pero la conexión no quedó activa (claude mcp list la sigue mostrando sin autenticar). El código pegado puede haber llegado tarde/incompleto — reintentá desde cero con la URL completa.',
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
    if (m) { url = m[0]; writeState({ status: 'awaiting-url', url }); watchForCode(); }
  }
  // Solo consideramos éxito DESPUÉS de haber pegado la URL de redirect.
  if (!done && urlWritten && OK_RE.test(clean)) {
    done = true;
    if (watch) clearInterval(watch);
    finalize();
  }
});

proc.onExit(({ exitCode }) => {
  if (watch) clearInterval(watch);
  if (done) return; // ya lo maneja finalize() desde onData
  if (urlWritten && exitCode === 0) { done = true; finalize(); return; }
  writeState({ status: 'error', error: `claude mcp login terminó (code ${exitCode})` + (url ? '' : ' sin emitir URL de autorización') });
  process.exit(0);
});

// Timeout de seguridad (10 min), igual que el runner de onboarding.
setTimeout(() => {
  if (!done) { try { proc.kill(); } catch { /* noop */ } writeState({ status: 'error', error: 'timeout (10 min)' }); process.exit(0); }
}, 10 * 60 * 1000);
