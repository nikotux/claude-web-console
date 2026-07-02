// modules/terminal/index.js — módulo Terminal (el corazón del proyecto).
//
// Interfaz estándar de módulo:
//   { name, registerHttp(router, ctx), registerWs(wss, ctx), init(ctx) }
//
// HTTP:
//   GET  /api/terminal/sessions        -> lista de sesiones vivas
//   POST /api/terminal/sessions        -> crea una sesión { cwd?, runClaude? }
// WS:
//   /ws/terminal?id=<id>               -> se adjunta a una sesión existente
//   (mensajes cliente->servidor en JSON: {type:'input'|'resize'|'ping'})
//   (servidor->cliente: binario = salida PTY; texto JSON = control)
import express from 'express';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionManager } from './sessions.js';
import { config } from '../../core/config.js';
import { validateSocketPath, isValidSessionName } from '../../core/tmux.js';
import { modelForCwd } from '../../core/claude-model.js';

// Aplica al server tmux cwc YA en marcha las opciones de clipboard (la config
// del socket solo se lee al iniciar el server tmux; esto cubre el rehidratado).
function applyClipboardOpts() {
  const base = ['-L', config.tmuxSocket];
  const cmds = [
    ['set-option', '-g', 'set-clipboard', 'on'],
    ['set-option', '-as', 'terminal-features', ',xterm*:clipboard'],
  ];
  for (const c of cmds) {
    try { execFileSync('tmux', [...base, ...c], { stdio: 'ignore' }); } catch { /* el server puede no existir aún */ }
  }
}

function safeCwd(requested) {
  if (!requested) return config.home;
  // Se resuelve y se exige que quede dentro del home permitido (anti traversal).
  const resolved = path.resolve(config.home, requested.toString());
  return resolved.startsWith(config.home) ? resolved : config.home;
}

export default {
  name: 'terminal',

  // Al montar el módulo: reconstruimos las sesiones tmux `cwc-*` que hayan
  // sobrevivido a un reinicio de Node, para que vuelvan a listarse como
  // pestañas re-adjuntables (requisito de persistencia de la Fase 3).
  init() {
    const n = sessionManager.rehydrate();
    if (n > 0) console.log(`[terminal] Rehidratadas ${n} sesión(es) tmux existentes.`);
    applyClipboardOpts();
  },

  registerHttp(router) {
    const r = express.Router();

    r.get('/sessions', (req, res) => {
      res.json({ sessions: sessionManager.list() });
    });

    // Modelo de Claude en uso por esta sesión (para el banderín del rail).
    r.get('/model', (req, res) => {
      const session = sessionManager.get(req.query.id);
      if (!session) return res.status(404).json({ error: 'Sesión inexistente.' });
      res.json({ model: modelForCwd(session.cwd) });
    });

    r.post('/sessions', (req, res) => {
      const { cwd, runClaude, title, attach } = req.body || {};

      // Adjuntado a una sesión tmux existente (de cualquier socket): validamos
      // socket + nombre para no ejecutar tmux con argumentos arbitrarios.
      if (attach) {
        const socketPath = validateSocketPath(attach.socket);
        if (!socketPath || !isValidSessionName(attach.session)) {
          return res.status(400).json({ error: 'Destino de adjuntado inválido.' });
        }
        const session = sessionManager.create({
          attach: { socket: socketPath, session: attach.session },
          title: title || attach.session,
        });
        return res.json({ session: session.info() });
      }

      const session = sessionManager.create({
        cwd: cwd ? safeCwd(cwd) : config.home,
        runClaude: !!runClaude,
        title,
      });
      res.json({ session: session.info() });
    });

    router.use('/terminal', r);
  },

  registerWs(wss) {
    wss.route('/ws/terminal', (ws, req, url) => {
      ws.binaryType = 'nodebuffer';
      const id = url.searchParams.get('id');
      const session = id && sessionManager.get(id);

      if (!session || !session.alive) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sesión inexistente o terminada.' }));
        ws.close();
        return;
      }

      session.attach(ws);

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // ignoramos frames no-JSON del cliente
        }
        if (msg.type === 'input') {
          session.write(msg.data);
        } else if (msg.type === 'resize') {
          session.resize(msg.cols, msg.rows);
        }
      });

      ws.on('close', () => session.detach(ws));
      ws.on('error', () => session.detach(ws));
    });
  },
};
