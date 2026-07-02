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
import express from 'express';
import { config } from '../../core/config.js';
import { listSockets, runTmux, validateSocketPath, isValidSessionName } from '../../core/tmux.js';
import { modelForCwd, VALID_MODELS } from '../../core/claude-model.js';

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
    const [name, windows, attached, created, cwd] = line.split('\t');
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
      // Modelo de Claude en uso (leído del transcript según el cwd), o null.
      model: cwd ? modelForCwd(cwd) : null,
    });
  }
  return sessions;
}

export default {
  name: 'tmux',

  registerHttp(router) {
    const r = express.Router();

    r.get('/sessions', (req, res) => {
      const all = [];
      for (const sock of listSockets()) all.push(...listSessionsForSocket(sock));
      // Adjuntas primero, luego por socket y nombre.
      all.sort((a, b) =>
        a.socketName === b.socketName ? a.name.localeCompare(b.name) : a.socketName.localeCompare(b.socketName),
      );
      res.json({ sessions: all });
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
      runTmux(socketPath, ['send-keys', '-t', session, '-l', `/model ${model}`]);
      runTmux(socketPath, ['send-keys', '-t', session, 'Enter']);
      res.json({ ok: true });
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
