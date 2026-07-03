// modules/tmux/index.js — control de sesiones tmux (Fase extra).
//
// Alcance: control TOTAL sobre todos los sockets tmux del usuario
// (/tmp/tmux-<uid>/*). Permite listar, matar y —vía el módulo terminal—
// adjuntarse a cualquier sesión. El adjuntado real lo hace el endpoint
// POST /api/terminal/sessions con { attach } (misma vía de creación).
//
// HTTP:
//   GET  /api/tmux/sessions            -> sesiones de todos los sockets
//   POST /api/tmux/kill  { socket, session }  -> mata una sesión
//   POST /api/tmux/set-model { socket, session, model }
//   POST /api/tmux/title { socket, session, title } -> nombre humano custom
import express from 'express';
import path from 'node:path';
import { config } from '../../core/config.js';
import { listSockets, runTmux, validateSocketPath, isValidSessionName } from '../../core/tmux.js';
import { modelForCwd, VALID_MODELS } from '../../core/claude-model.js';
import { stateForCwd } from '../../core/claude-state.js';
// Títulos humanos custom (renombrar tarjetas sin tocar el nombre tmux, que es
// plomería y sostiene la rehidratación): persisten en titles.json vía el core
// compartido (core/session-names.js — también los usa el módulo terminal para
// los nombres únicos al crear).
import { loadTitles, saveTitles, titleKey, registerNameProvider } from '../../core/session-names.js';

// Formato tabulado para parsear sin ambigüedad.
const FMT = [
  '#{session_name}',
  '#{session_windows}',
  '#{session_attached}',
  '#{session_created}',
  '#{pane_current_path}',
].join('\t');

function listSessionsForSocket(sock) {
  const out = runTmux(sock.path, ['list-sessions', '-F', FMT]);
  const sessions = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue; // formato inesperado de tmux: skip, no campos undefined
    const [name, windows, attached, created, cwd] = parts;
    // Estado real (observador statusline/hooks); transcript como fallback.
    const st = cwd ? stateForCwd(cwd) : null;
    sessions.push({
      socket: sock.path,
      socketName: sock.name,
      name,
      windows: parseInt(windows, 10) || 0,
      attached: (parseInt(attached, 10) || 0) > 0,
      created: parseInt(created, 10) || 0,
      cwd: cwd || '',
      // "owned" = sesiones creadas por esta consola (socket cwc + prefijo cwc-).
      owned: sock.name === config.tmuxSocket && name.startsWith('cwc-'),
      // Modelo: en tiempo real vía observador; si no, inferido del transcript.
      model: st?.model || (cwd ? modelForCwd(cwd) : null),
      state: st ? { status: st.status, ts: st.ts } : null,
    });
  }
  return sessions;
}

// Proveedor de nombres para el uniquificador (core/session-names.js): los
// display names de TODAS las sesiones tmux, igual que los calcula la tarjeta
// del frontend (customTitle || basename(cwd) || nombre tmux).
registerNameProvider(() => {
  const titles = loadTitles();
  const names = [];
  for (const sock of listSockets()) {
    for (const s of listSessionsForSocket(sock)) {
      names.push(titles[titleKey(s.socketName, s.name)] || (s.cwd ? path.basename(s.cwd) : s.name));
    }
  }
  return names;
});

export default {
  name: 'tmux',

  registerHttp(router) {
    const r = express.Router();

    r.get('/sessions', (req, res) => {
      const all = [];
      for (const sock of listSockets()) all.push(...listSessionsForSocket(sock));
      all.sort((a, b) =>
        a.socketName === b.socketName ? a.name.localeCompare(b.name) : a.socketName.localeCompare(b.socketName),
      );
      // Títulos custom + poda de huérfanos (sesiones que ya no existen).
      const titles = loadTitles();
      const valid = new Set(all.map((s) => titleKey(s.socketName, s.name)));
      let dirty = false;
      for (const k of Object.keys(titles)) {
        if (!valid.has(k)) { delete titles[k]; dirty = true; }
      }
      if (dirty) saveTitles(titles);
      for (const s of all) s.customTitle = titles[titleKey(s.socketName, s.name)] || null;
      res.json({ sessions: all });
    });

    // Nombre humano de una tarjeta (vacío = volver al nombre por defecto).
    r.post('/title', (req, res) => {
      const { socket, session, title } = req.body || {};
      const socketPath = validateSocketPath(socket);
      if (!socketPath) return res.status(400).json({ error: 'Socket inválido.' });
      if (!isValidSessionName(session)) return res.status(400).json({ error: 'Nombre de sesión inválido.' });
      const clean = String(title || '').trim().slice(0, 60);
      const titles = loadTitles();
      const key = titleKey(path.basename(socketPath), session);
      if (clean) titles[key] = clean;
      else delete titles[key];
      saveTitles(titles);
      res.json({ ok: true, title: clean || null });
    });

    // Fija el modelo de una sesión de Claude Code inyectando `/model <x>` por
    // send-keys. Solo tiene efecto si en esa sesión corre Claude Code.
    r.post('/set-model', (req, res) => {
      const { socket, session, model } = req.body || {};
      const socketPath = validateSocketPath(socket);
      if (!socketPath) return res.status(400).json({ error: 'Socket inválido.' });
      if (!isValidSessionName(session)) return res.status(400).json({ error: 'Nombre de sesión inválido.' });
      if (!VALID_MODELS.has(model)) return res.status(400).json({ error: 'Modelo inválido.' });
      // -l = literal (no interpretar el texto como nombres de tecla); luego Enter.
      // throwOnError: sin él runTmux traga el fallo y responderíamos ok:true
      // con la sesión muerta (mismo patrón que /kill).
      try {
        runTmux(socketPath, ['send-keys', '-t', session, '-l', `/model ${model}`], { throwOnError: true });
        runTmux(socketPath, ['send-keys', '-t', session, 'Enter'], { throwOnError: true });
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo enviar /model a la sesión (¿ya no existe?).' });
      }
    });

    r.post('/kill', (req, res) => {
      const { socket, session } = req.body || {};
      const socketPath = validateSocketPath(socket);
      if (!socketPath) return res.status(400).json({ error: 'Socket inválido.' });
      if (!isValidSessionName(session)) return res.status(400).json({ error: 'Nombre de sesión inválido.' });
      try {
        runTmux(socketPath, ['kill-session', '-t', session], { throwOnError: true });
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo matar la sesión (¿ya no existe?).' });
      }
    });

    router.use('/tmux', r);
  },
};
