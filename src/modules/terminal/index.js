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
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canUseTmuxSession, sessionManager } from './sessions.js';
import { config } from '../../core/config.js';
import { clampToRoot } from '../../core/paths.js';
import { principalOf } from '../../core/auth.js';
import { userFileRoot, hostUser } from '../../core/user-space.js';
import { validateSocketPath, isValidSessionName, tmuxSessionExists } from '../../core/tmux.js';
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

// Anti traversal + confinamiento por dueño (BUG-680): el host (admin/token,
// owner null) conserva su home completo; un inquilino queda clampeado a SU
// workspace. Espejo EXACTO de safeCwd(cwd, owner) de chat/index.js.
const safeCwd = (cwd, owner) => clampToRoot(userFileRoot(owner || hostUser()), cwd);

// Resuelve una sesión SOLO si el request es de su dueño (o admin). Ajena/
// inexistente → null → 404, sin revelar existencia. Espejo de ownedChat.
function ownedSession(req, id) {
  const session = sessionManager.get(id);
  if (!session) return null;
  const p = principalOf(req);
  if (p.admin) return session;
  if (session.owner === p.username) return session;
  return null;
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
      try {
        res.json({ sessions: sessionManager.list(principalOf(req)) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Modelo de Claude en uso por esta sesión (para el banderín del rail).
    // Preferimos el observador (tiempo real); transcript como fallback.
    r.get('/model', (req, res) => {
      try {
        const session = ownedSession(req, req.query.id);
        if (!session) return res.status(404).json({ error: 'Sesión inexistente.' });
        const st = stateForCwd(session.cwd);
        res.json({ model: st?.model || modelForCwd(session.cwd) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    r.post('/sessions', (req, res) => {
      const { cwd, runClaude, title, attach, model } = req.body || {};
      // multi-tenant (BUG-680): dueño del request (null = host/admin/token).
      const owner = principalOf(req).username;
      // Si sessionManager.create() llega a completar, guardamos el id acá
      // para poder limpiarla si algo posterior (persistencia de título,
      // recientes) falla — evita sesión huérfana viva pero invisible al cliente.
      let createdId = null;

      try {
        // Adjuntado a una sesión tmux existente: validamos socket + nombre para
        // no ejecutar tmux con argumentos arbitrarios; luego aplicamos ownership.
        if (attach) {
          const socketPath = validateSocketPath(attach.socket);
          if (!socketPath || !isValidSessionName(attach.session)) {
            console.warn('[terminal] Adjuntado rechazado — owner:', String(owner).slice(0, 200), '· socket:', String(attach.socket).slice(0, 200), '· sesión:', String(attach.session).slice(0, 200));
            return res.status(400).json({ error: 'Destino de adjuntado inválido.' });
          }
          // validateSocketPath normaliza a ruta absoluta; el guard compartido
          // compara el nombre lógico del socket, igual que el módulo tmux.
          if (!canUseTmuxSession(principalOf(req), path.basename(socketPath), attach.session)) {
            console.warn('[terminal] Adjuntado DENEGADO por ownership — owner:', String(owner).slice(0, 200), '· socket:', String(attach.socket).slice(0, 200), '· sesión:', String(attach.session).slice(0, 200));
            return res.status(404).json({ error: 'Sesión inexistente.' });
          }
          // Entre el listado que pintó la tarjeta y este click la tmux pudo
          // morir. Sin este guard el attach devolvía 200 y abría una pestaña
          // fantasma que se cerraba sola, sin decir por qué (console:PLAN-2115).
          if (!tmuxSessionExists(socketPath, attach.session)) {
            console.warn('[terminal] Adjuntado a sesión muerta — owner:', String(owner).slice(0, 200), '· sesión:', String(attach.session).slice(0, 200));
            return res.status(400).json({ error: `La sesión "${attach.session}" ya no existe: su terminal se cerró. Creá una nueva desde "Nueva sesión".` });
          }
          const session = sessionManager.create({
            attach: { socket: socketPath, session: attach.session },
            title: title || attach.session,
            owner,
          });
          createdId = session.id;
          return res.json({ session: session.info() });
        }

        // Modelo inicial opcional (lanzador): se arranca `claude --model <x>`.
        // El texto va DIRECTO al modal del usuario: nombrar el modelo y los
        // válidos, porque "Modelo inválido." no le decía a nadie qué hacer.
        // Caso real: el launcher mandaba el alias de chat 'tandem' en una
        // sesión TUI (console:PLAN-2115).
        if (model != null && !VALID_MODELS.has(model)) {
          const pedido = String(model).slice(0, 40);
          console.warn('[terminal] Modelo rechazado — owner:', String(owner).slice(0, 200), '· modelo:', String(model).slice(0, 200));
          return res.status(400).json({ error: `El modelo "${pedido}" no existe para una sesión de terminal. Elegí uno de: ${[...VALID_MODELS].join(', ')}.` });
        }

        if (runClaude != null && typeof runClaude !== 'boolean') {
          console.warn('[terminal] runClaude rechazado — owner:', String(owner).slice(0, 200), '· tipo:', typeof runClaude);
          return res.status(400).json({ error: 'runClaude debe ser booleano.' });
        }

        const cwdAbs = safeCwd(cwd, owner);
        try {
          if (!fs.statSync(cwdAbs).isDirectory()) throw new Error('not-directory');
        } catch {
          console.warn('[terminal] cwd inexistente — owner:', String(owner).slice(0, 200), '· pedido:', String(cwd).slice(0, 200), '· resuelto:', cwdAbs);
          const requested = typeof cwd === 'string' ? cwd.trim() : '';
          const named = requested && requested.length <= 80 ? ` "${requested}"` : '';
          return res.status(400).json({ error: `El destino${named} no existe en tu espacio de trabajo. Elegí otro destino.` });
        }
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
          owner,
        });
        createdId = session.id;
        if (cardName !== baseName) {
          const titles = loadTitles();
          titles[titleKey(config.tmuxSocket, session.tmuxName)] = cardName;
          saveTitles(titles);
        }
        // Alimenta "Recientes" del lanzador (el home no se registra: es atajo fijo).
        // Solo el host: el cwd de un inquilino (~/.cwc-users/<u>/workspace) cae
        // dentro de home y se filtraría al launcher del host (recents es global).
        if (!owner) recordRecent(path.relative(config.home, cwdAbs));
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
      try {
        res.json({ recents: listRecents() });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
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

      // multi-tenant (BUG-680): guard de ownership, espejo del WS de chat.
      // No revela existencia (mismo mensaje que "inexistente"). El handshake ya
      // pasó por isAuthenticated (core/wss.js), así que principalOf no es null.
      const p = principalOf(req);
      if (!p.admin && session.owner !== p.username) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sesión inexistente o terminada.' }));
        ws.close();
        return;
      }

      session.attach(ws);

      // try/catch en TODO el cuerpo (no solo el JSON.parse) — invariante 5: este
      // listener corre en un emisor externo (ws), FUERA de la ventana try/catch
      // de core/wss.js, que solo envuelve la invocación síncrona del handler.
      // Sin esto, un frame literal `null` (JSON.parse('null') === null) o un
      // session.write() que lance tiraba abajo el proceso entero — no hay
      // uncaughtException global en src/server.js.
      ws.on('message', (raw) => {
        try {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return; // ignoramos frames no-JSON del cliente
          }
          if (!msg || typeof msg !== 'object') return; // null, número, string suelto…
          if (msg.type === 'input') {
            session.write(msg.data);
          } else if (msg.type === 'resize') {
            session.resize(msg.cols, msg.rows);
          }
        } catch (e) {
          console.error('[terminal] mensaje WS inválido o fallo al despacharlo:', e?.message);
        }
      });

      // try/catch en los handlers de emisores externos (invariante 5): un fallo
      // en detach() no debe propagarse como excepción no atrapada del WS.
      ws.on('close', () => { try { session.detach(ws); } catch (e) { console.error('[terminal] detach (close) falló:', e?.message); } });
      ws.on('error', () => { try { session.detach(ws); } catch (e) { console.error('[terminal] detach (error) falló:', e?.message); } });
    });
  },
};
