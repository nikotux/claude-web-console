// core/tmux.js — utilidades compartidas para hablar con tmux de forma segura.
//
// Enumeramos los sockets del usuario en /tmp/tmux-<uid>/ y ejecutamos tmux
// SIN heredar $TMUX/$TMUX_PANE (si el server corre dentro de una sesión tmux,
// heredar esas vars apuntaría al socket equivocado o anidaría).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmuxDir() {
  return path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`);
}

// Entorno para invocar tmux: el del proceso menos las vars de sesión tmux.
function tmuxEnv() {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

// Ejecuta tmux sobre un socket concreto (por path). Devuelve stdout (string)
// o '' ante error (socket muerto, sin sesiones, etc.).
export function runTmux(socketPath, args, { throwOnError = false } = {}) {
  try {
    return execFileSync('tmux', ['-S', socketPath, ...args], {
      encoding: 'utf8',
      env: tmuxEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (throwOnError || err.killed || err.signal) throw err;
    return '';
  }
}

// Lista los sockets tmux del usuario: [{ name, path }].
export function listSockets() {
  const dir = tmuxDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isSocket()) out.push({ name, path: p });
    } catch { /* noop */ }
  }
  return out;
}

// Valida que un path de socket sea legítimo: dentro de /tmp/tmux-<uid>/ y que
// exista como socket. Devuelve el path resuelto o null.
export function validateSocketPath(socketPath) {
  if (!socketPath || typeof socketPath !== 'string') return null;
  const dir = tmuxDir();
  const resolved = path.resolve(socketPath);
  if (path.dirname(resolved) !== dir) return null;
  try {
    if (!fs.statSync(resolved).isSocket()) return null;
  } catch {
    return null;
  }
  return resolved;
}

// Nombre de sesión tmux con caracteres seguros (evita inyección de flags/args).
export function isValidSessionName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._@:-]{1,128}$/.test(name);
}
