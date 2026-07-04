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
import { clampToHome } from '../../core/paths.js';
import { validateSocketPath, isValidSessionName } from '../../core/tmux.js';
import { modelForCwd, VALID_MODELS } from '../../core/claude-model.js';
import { stateForCwd } from '../../core/claude-state.js';
import { recordRecent, listRecents } from '../../core/recents.js';
import { uniqueName, loadTitles, saveTitles, titleKey } from '../../core/session-names.js';

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

// Anti traversal: resuelve contra el home y cae a él si escapa (core/paths.js).
const safeCwd = clampToHome;

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
    // Preferimos el observador (tiempo real); transcript como fallback.
    r.get('/model', (req, res) => {
      const session = sessionManager.get(req.query.id);
      if (!session) return res.status(404).json({ error: 'Sesión inexistente.' });
      const st = stateForCwd(session.cwd);
      res.json({ model: st?.model || modelForCwd(session.cwd) });
    });

    r.post('/sessions', (req, res) => {
      const { cwd, runClaude, title, attach, model } = req.body || {};
      // Si sessionManager.create() llega a completar, guardamos el id acá
      // para poder limpiarla si algo posterior (persistencia de título,
      // recientes) falla — evita sesión huérfana viva pero invisible al cliente.
      let createdId = null;

      try {
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
          createdId = session.id;
          return res.json({ session: session.info() });
        }

        // Modelo inicial opcional (lanzador): se arranca `claude --model <x>`.
        if (model != null && !VALID_MODELS.has(model)) {
          return res.status(400).json({ error: 'Modelo inválido.' });
        }

        if (runClaude != null && typeof runClaude !== 'boolean') {
          return res.status(400).json({ error: 'runClaude debe ser booleano.' });
        }

        const cwdAbs = cwd ? safeCwd(cwd) : config.home;
        // Nombre ÚNICO de tarjeta: el display name de una sesión tmux es
        // customTitle || basename(cwd) — si el basename ya está en uso (por
        // otra tmux O una conversación de chat), se persiste "tolkien 1" como
        // customTitle. Calculado ANTES de crear (así la propia sesión nueva no
        // cuenta como colisión contra sí misma).
        const baseName = path.basename(cwdAbs) || 'terminal';
        const cardName = uniqueName(baseName);
        const session = sessionManager.create({
          cwd: cwdAbs,
          runClaude: !!runClaude,
          model: model || null,
          title,
        });
        createdId = session.id;
        if (cardName !== baseName) {
          const titles = loadTitles();
          titles[titleKey(config.tmuxSocket, session.tmuxName)] = cardName;
          saveTitles(titles);
        }
        // Alimenta "Recientes" del lanzador (el home no se registra: es atajo fijo).
        recordRecent(path.relative(config.home, cwdAbs));
        res.json({ session: session.info() });
      } catch (err) {
        console.error('[terminal] Error creando sesión:', err);
        if (createdId) {
          // La sesión llegó a crearse (tmux/pty pudo haber arrancado) pero el
          // request no puede responder OK: la matamos y la sacamos del mapa
          // para no dejarla viva-pero-invisible para el cliente.
          const orphan = sessionManager.get(createdId);
          try { orphan?.kill(); } catch { /* noop */ }
          sessionManager.remove(createdId);
        }
        if (!res.headersSent) res.status(500).json({ error: 'No se pudo crear la sesión.' });
      }
    });

    // Carpetas recientes donde se crearon sesiones (para el lanzador).
    r.get('/recents', (req, res) => {
      res.json({ recents: listRecents() });
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
