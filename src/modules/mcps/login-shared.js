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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';

const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNNER = path.join(CONSOLE_ROOT, 'bin', 'cwc-mcp-login-runner.js');
const JOBS_DIR = path.join(os.homedir(), '.cwc-data', 'mcp-login');

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
export function writeLoginCode(id, value) {
  if (!idOk(id)) throw new Error('id inválido');
  const v = String(value || '').trim();
  if (!v || v.length > 4000 || /[\r\n]/.test(v)) throw new Error('valor inválido');
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
  child.unref();
  return id;
}
