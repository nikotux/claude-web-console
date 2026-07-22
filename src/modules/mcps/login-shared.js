// modules/mcps/login-shared.js — lógica compartida de la RECONEXIÓN OAuth
// GUIADA (Fase 2) del módulo `mcps`. Corre en el proceso del server: resuelve
// el cwd del mundo, spawnea el runner pty (bin/cwc-mcp-login-runner.js) y
// media el archivo con la URL de redirect que pega el usuario.
//
// Patrón calcado de onboard (bin/cwc-onboard-runner.js): `claude mcp login`
// EXIGE un TTY (stdin no-terminal aborta) → node-pty. Estado en archivos
// (~/.cwc-data/mcp-login/<id>.json) → sobrevive a un reinicio del server: si el
// pty muere, el job queda 'error'/stale y el usuario reintenta (Regla 2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';

const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNNER = path.join(CONSOLE_ROOT, 'bin', 'cwc-mcp-login-runner.js');
const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'mcp-login');

// --- Parseo del estado que imprime `claude mcp list` (FUENTE ÚNICA: la usan
// tanto el censo del módulo `mcps` como el runner de login, que la necesita
// para VERIFICAR que una reconexión quedó de verdad conectada antes de
// reportar éxito — ver runMcpList más abajo). ---
export function classifyStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (raw.includes('✔') || s.includes('connected')) return { code: 'connected', light: 'ok', label: 'Conectado' };
  if (raw.includes('!') || s.includes('authentication') || s.includes('needs auth')) return { code: 'needs-auth', light: 'warn', label: 'Requiere reconexión' };
  if (raw.includes('⏸') || s.includes('pending')) return { code: 'pending', light: 'info', label: 'Pendiente de aprobación' };
  if (raw.includes('✘') || s.includes('failed') || s.includes('disconnect') || s.includes('error')) return { code: 'error', light: 'danger', label: 'Error de conexión' };
  return { code: 'unknown', light: 'neutral', label: raw.trim() || 'Desconocido' };
}

// name lazy hasta el primer ":", endpoint lazy, status anclado al final por su
// símbolo/keyword conocido (así un endpoint con " -- " no confunde el split).
// El status arranca por un símbolo (✔✘!⏸⚠) o keyword conocido tras " - ". Sin
// \b: ✔/! seguidos de espacio no forman word-boundary, y el \b anulaba el match.
const LINE_RE = /^(.+?):\s+(.*?)\s+-\s+((?:[✔✘!⏸⚠]|Connected|Failed|Needs|Pending|Disconnected).*)$/;

export function parseList(stdout) {
  const servers = [];
  let hasWarnings = false;
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    if (/config diagnostics|conflicting scopes|multiple scopes|^[├└]/i.test(t)) { hasWarnings = true; continue; }
    const m = t.match(LINE_RE);
    if (!m) continue;
    servers.push({ name: m[1].trim(), endpoint: m[2].trim(), statusRaw: m[3].trim(), status: classifyStatus(m[3]) });
  }
  return { servers, hasWarnings };
}

export function runMcpList(cwd) {
  return new Promise((resolve) => {
    execFile('claude', ['mcp', 'list'], { cwd, timeout: 30000, env: process.env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // `claude mcp list` sale 0 aun con diagnostics; el health-check tarda por
        // los HTTP. Si falla del todo, devolvemos vacío + el error para la UI.
        if (err && !stdout) { resolve({ servers: [], hasWarnings: false, error: (stderr || err.message || '').trim().slice(0, 300) }); return; }
        resolve(parseList((stdout || '') + '\n' + (stderr || '')));
      });
  });
}

// Health-check de UN SOLO server (`claude mcp get <name>`), con timeout propio.
// A diferencia de `claude mcp list` (que chequea TODOS los servers del mundo en
// un comando y por eso un server colgado bloquea el mundo entero), esto acota
// el daño a la tarjeta de ese server — es la base de la resiliencia por item.
export function runMcpGet(cwd, name, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!/^[A-Za-z0-9_-]+$/.test(String(name || ''))) {
      resolve({ status: { code: 'error', light: 'danger', label: 'nombre inválido' }, statusRaw: '', error: 'nombre inválido' });
      return;
    }
    execFile('claude', ['mcp', 'get', name], { cwd, timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`;
        const statusRaw = (out.match(/^\s*Status:\s*(.+)$/m)?.[1] || '').trim();
        if (statusRaw) { resolve({ status: classifyStatus(statusRaw), statusRaw }); return; }
        if (err && (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')) {
          resolve({ status: { code: 'timeout', light: 'warn', label: 'No respondió' }, statusRaw: '', timedOut: true, timeoutMs });
          return;
        }
        if (err) {
          resolve({ status: { code: 'error', light: 'danger', label: 'Error de conexión' }, statusRaw: '', error: (stderr || err.message || '').trim().slice(0, 300) });
          return;
        }
        resolve({ status: { code: 'unknown', light: 'neutral', label: 'Desconocido' }, statusRaw: '' });
      });
  });
}

// Los mundos donde viven MCP con cwd propio (per-project scope). El global
// (user scope) aparece dentro de cada uno; no tiene cwd separado.
export const WORLDS = [
  { world: 'console', label: '🏠 Mi Consola' },
  { world: 'tolkien', label: '🌳 Tolkien' },
];

export function worldCwd(world) {
  if (world === 'console') return CONSOLE_ROOT;
  if (world === 'tolkien') return config.projectDir || null;
  return null;
}

const idOk = (id) => /^[A-Za-z0-9_-]+$/.test(String(id || ''));
const jobFile = (id) => path.join(JOBS_DIR, `${id}.json`);
const codeFile = (id) => path.join(JOBS_DIR, `${id}.url`);

export function readLoginJob(id) {
  if (!idOk(id)) return null;
  try { return JSON.parse(fs.readFileSync(jobFile(id), 'utf8')); } catch { return null; }
}

// El usuario pega la URL de redirect completa (localhost:.../callback?code=…)
// o el code pelado; el runner la vigila y la escribe al stdin del pty.
function badRequest(message) {
  const e = new Error(message);
  e.badRequest = true;
  return e;
}

export function writeLoginCode(id, value) {
  if (!idOk(id)) throw badRequest('id inválido');
  const v = String(value || '').trim();
  if (!v || v.length > 4000 || /[\r\n]/.test(v)) throw badRequest('valor inválido');
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(codeFile(id), v, { mode: 0o600 });
}

const TERMINAL = new Set(['done', 'error']);

export function spawnLogin(world, name) {
  const cwd = worldCwd(world);
  if (!cwd) throw new Error('mundo desconocido');
  if (!/^[A-Za-z0-9_-]+$/.test(String(name || ''))) throw new Error('nombre inválido');
  const id = `${world}-${name}`;
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  // Dedup: un job fresco no-terminal se reusa (no relanzamos otro pty).
  const existing = readLoginJob(id);
  if (existing && !TERMINAL.has(existing.status) && Date.now() - (existing.ts || 0) < 10 * 60 * 1000) return id;
  try { fs.unlinkSync(codeFile(id)); } catch { /* noop */ }
  fs.writeFileSync(jobFile(id), JSON.stringify({ id, world, name, status: 'starting', ts: Date.now() }), { mode: 0o600 });
  const child = spawn('node', [RUNNER, '--cwd', cwd, '--name', name, '--id', id], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.on('error', (err) => {
    try {
      fs.writeFileSync(jobFile(id), JSON.stringify({ id, world, name, status: 'error', error: String(err.message || err), ts: Date.now() }), { mode: 0o600 });
    } catch { /* best-effort */ }
  });
  child.unref();
  return id;
}
