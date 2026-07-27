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
import { principalOf } from '../../core/auth.js';
import { config } from '../../core/config.js';
import { listSockets, runTmux, validateSocketPath, isValidSessionName } from '../../core/tmux.js';
import { modelForCwd, VALID_MODELS } from '../../core/claude-model.js';
import { stateForCwd, stateForPane } from '../../core/claude-state.js';
import { sessionManager, PREFIX, BARE_PREFIX } from '../terminal/sessions.js';
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

function worldFromCwd(cwd) {
  if (!cwd) return 'otros';
  if (/tolkien/i.test(cwd)) return 'tolkien';
  if (/claude-web-console/i.test(cwd)) return 'console';
  return 'otros';
}

// Ownership guard (BUG-685, espejo de ownedSession de terminal/index.js): un
// inquilino no-admin SOLO puede operar (kill/set-model/title) sobre SU sesión de
// la consola. Admin/host (owner null) → todo (retrocompat: controla todos los
// sockets). Para un no-admin exige: socket cwc + sesión de la consola (cwc-/cwct-)
// cuya Session.owner coincida. Otro socket, sesión ajena, o sin dueño conocido
// (p.ej. rehidratada tras un reinicio → owner=null) → false (fail-closed).
function consoleSession(socketName, session) {
  if (socketName !== config.tmuxSocket) return null;
  let id = null;
  if (session.startsWith(BARE_PREFIX)) id = session.slice(BARE_PREFIX.length);
  else if (session.startsWith(PREFIX)) id = session.slice(PREFIX.length);
  else return null;
  return sessionManager.get(id) || null;
}

function ownsSession(req, socketName, session) {
  const p = principalOf(req);
  if (p.admin) return true;
  const s = consoleSession(socketName, session);
  return !!s && s.owner === p.username;
}

// Mapa sesión→panes del socket (para el estado por pane del observador).
// Best-effort: si list-panes falla, se devuelve un mapa vacío y el estado cae
// al mapeo por carpeta de siempre.
function panesBySession(sock, opts) {
  const map = new Map();
  try {
    const out = runTmux(sock.path, ['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}'], opts);
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [sess, pane] = line.split('\t');
      if (!sess || !pane) continue;
      if (!map.has(sess)) map.set(sess, []);
      map.get(sess).push(pane);
    }
  } catch { /* fallback por carpeta */ }
  return map;
}

function listSessionsForSocket(sock, opts) {
  const out = runTmux(sock.path, ['list-sessions', '-F', FMT], opts);
  const panes = panesBySession(sock, opts);
  const sessions = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue; // formato inesperado de tmux: skip, no campos undefined
    const [name, windows, attached, created, cwd] = parts;
    // Estado real (observador statusline/hooks): PRIMERO por pane (identidad
    // exacta de la sesión — dos claudes en el mismo cwd ya no comparten
    // Pac-Man); si ningún pane tiene estado (claude viejo sin re-tick, o sin
    // observador), fallback al mapeo por carpeta de siempre.
    let st = null;
    for (const pane of panes.get(name) || []) {
      st = stateForPane(pane);
      if (st) break;
    }
    if (!st && cwd) st = stateForCwd(cwd);
    sessions.push({
      socket: sock.path,
      socketName: sock.name,
      name,
      windows: parseInt(windows, 10) || 0,
      attached: (parseInt(attached, 10) || 0) > 0,
      created: parseInt(created, 10) || 0,
      cwd: cwd || '',
      // "owned" = sesiones creadas por esta consola (socket cwc + prefijo
      // cwc- de terminales O cwct- de vistas TUI ocultas de conversaciones —
      // ambas nacen de esta consola en el mismo socket; 'cwct-' NO matchea
      // startsWith('cwc-') porque el 4º carácter es 't', no '-').
      owned: sock.name === config.tmuxSocket && (name.startsWith(PREFIX) || name.startsWith(BARE_PREFIX)),
      owner: consoleSession(sock.name, name)?.owner ?? null,
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
    // throwOnError: igual que en GET /sessions (ver comentario más abajo), un
    // fallo transitorio de list-sessions no debe leerse como "socket sin
    // sesiones" — eso liberaría nombres en uso por sesiones vivas. Si falla,
    // excluimos ese socket de este cálculo en vez de tratarlo como vacío.
    let sessions;
    try {
      sessions = listSessionsForSocket(sock, { throwOnError: true });
    } catch {
      console.error(`[tmux] list-sessions falló en el socket "${sock.name}" al calcular nombres únicos; se omite esta pasada.`);
      continue;
    }
    for (const s of sessions) {
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
      try {
        const all = [];
        // throwOnError: un fallo transitorio de tmux (ENOMEM, fork ocupado,
        // exec momentáneo) NO debe leerse como "socket sin sesiones" — eso
        // llevaría a podar como huérfanos títulos de sesiones que siguen
        // vivas. Si list-sessions falla, tratamos ese socket como "no
        // verificado esta pasada" y no tocamos sus títulos custom.
        const unverifiedSockets = new Set();
        let sockets;
        let enumFailed = false;
        try {
          sockets = listSockets({ throwOnError: true });
        } catch (e) {
          // No pudimos ENUMERAR los sockets (distinto de "no hay ninguno"): si
          // podáramos ahora, borraríamos títulos de sesiones vivas no verificadas.
          console.error('[tmux] no se pudo enumerar los sockets; se omite la poda de títulos esta pasada:', e?.message);
          enumFailed = true;
          sockets = [];
        }
        for (const sock of sockets) {
          try {
            all.push(...listSessionsForSocket(sock, { throwOnError: true }));
          } catch {
            unverifiedSockets.add(sock.name);
            console.error(`[tmux] list-sessions falló en el socket "${sock.name}"; se omite la poda de sus títulos esta vez.`);
          }
        }
        all.sort((a, b) =>
          a.socketName === b.socketName ? a.name.localeCompare(b.name) : a.socketName.localeCompare(b.socketName),
        );
        // Títulos custom + poda de huérfanos (sesiones que ya no existen).
        const titles = loadTitles();
        const valid = new Set(all.map((s) => titleKey(s.socketName, s.name)));
        let dirty = false;
        // Solo podar si la ENUMERACIÓN de sockets fue confiable: si falló, no
        // sabemos qué sesiones siguen vivas y no tocamos ningún título.
        if (!enumFailed) {
          for (const k of Object.keys(titles)) {
            if (valid.has(k)) continue;
            // No podar títulos de un socket cuya consulta falló esta pasada:
            // no sabemos si sus sesiones siguen vivas o no.
            const sockName = k.slice(0, k.indexOf('/'));
            if (unverifiedSockets.has(sockName)) continue;
            delete titles[k];
            dirty = true;
          }
        }
        if (dirty && !saveTitles(titles)) {
          // No abortamos la respuesta (los títulos podados ya están correctos
          // en memoria para esta petición); solo dejamos rastro de que la
          // poda no se persistió, para no fallar en silencio.
          console.error('[tmux] No se pudo persistir la poda de títulos huérfanos.');
        }
        for (const s of all) s.customTitle = titles[titleKey(s.socketName, s.name)] || null;
        // multi-tenant (BUG-685, mismo guard que title/set-model/kill/raw-feed):
        // un no-admin solo ve SUS propias sesiones — la poda de títulos de
        // arriba SÍ usa el `all` completo (evita podar títulos válidos de
        // sesiones que este request no puede ver), el filtro va solo en la
        // salida. Admin/host: sin cambios (ve todo, retrocompat).
        const visible = principalOf(req).admin ? all : all.filter((s) => ownsSession(req, s.socketName, s.name));
        res.json({ sessions: visible });
      } catch {
        res.status(500).json({ error: 'No se pudo listar sesiones.' });
      }
    });

    // Feed para la Vista Raw: sesiones tmux OWNED vivas + su texto de pane
    // reciente (capture-pane). Excluye las vistas TUI ocultas de chats (cwct-)
    // porque ya salen por su transcript. `isClaude` = tiene estado del observador
    // (corre Claude Code) → el frontend las omite para no duplicar; las bash sí
    // se muestran. Tope de 20 para no spawnear demasiados capture-pane.
    r.get('/raw-feed', (req, res) => {
      try {
        const titles = loadTitles();
        const out = [];
        for (const sock of listSockets()) {
          let sessions;
          try { sessions = listSessionsForSocket(sock, { throwOnError: true }); } catch { continue; }
          for (const s of sessions) {
            if (!s.owned) continue;
            if (s.name.startsWith(BARE_PREFIX)) continue; // TUI oculta de chat → ya llueve por transcript
            // multi-tenant (BUG-685, mismo guard que title/set-model/kill): un
            // no-admin solo ve el feed de SUS propias sesiones; admin/host ven todo.
            if (!ownsSession(req, s.socketName, s.name)) continue;
            if (out.length >= 20) break;
            if (!isValidSessionName(s.name)) continue;
            let text = '';
            try { text = runTmux(sock.path, ['capture-pane', '-p', '-t', s.name, '-S', '-30'], { throwOnError: false }) || ''; } catch { text = ''; }
            out.push({
              name: s.name,
              socketName: s.socketName,
              cwd: s.cwd,
              world: worldFromCwd(s.cwd),
              isClaude: !!s.state,
              attached: s.attached,
              customTitle: titles[titleKey(s.socketName, s.name)] || null,
              text: text.slice(-4000),
            });
          }
        }
        res.json({ terminals: out });
      } catch {
        res.status(500).json({ error: 'No se pudo obtener el feed de terminales.' });
      }
    });

    // Nombre humano de una tarjeta (vacío = volver al nombre por defecto).
    r.post('/title', (req, res) => {
      const { socket, session, title } = req.body || {};
      const socketPath = validateSocketPath(socket);
      if (!socketPath) return res.status(400).json({ error: 'Socket inválido.' });
      if (!isValidSessionName(session)) return res.status(400).json({ error: 'Nombre de sesión inválido.' });
      // multi-tenant (BUG-685): solo el dueño (o admin) puede operar sobre la
      // sesión. Ajena/desconocida → 404 sin revelar existencia (espejo de ownedSession).
      if (!ownsSession(req, path.basename(socketPath), session)) {
        return res.status(404).json({ error: 'Sesión inexistente.' });
      }
      try {
        const clean = String(title || '').trim().slice(0, 60);
        const titles = loadTitles();
        const key = titleKey(path.basename(socketPath), session);
        if (clean) titles[key] = clean;
        else delete titles[key];
        // saveTitles no lanza (atrapa I/O internamente, ver core/session-names.js):
        // hay que mirar su valor de retorno para detectar un guardado fallido
        // (permisos, disco lleno) y no responder ok:true sin haber persistido.
        if (!saveTitles(titles)) {
          return res.status(500).json({ error: 'No se pudo guardar el título de la sesión.' });
        }
        res.json({ ok: true, title: clean || null });
      } catch {
        res.status(500).json({ error: 'No se pudo guardar el título de la sesión.' });
      }
    });

    // Fija el modelo de una sesión de Claude Code inyectando `/model <x>` por
    // send-keys. Solo tiene efecto si en esa sesión corre Claude Code.
    r.post('/set-model', (req, res) => {
      const { socket, session, model } = req.body || {};
      const socketPath = validateSocketPath(socket);
      if (!socketPath) return res.status(400).json({ error: 'Socket inválido.' });
      if (!isValidSessionName(session)) return res.status(400).json({ error: 'Nombre de sesión inválido.' });
      // multi-tenant (BUG-685): solo el dueño (o admin) puede operar sobre la
      // sesión. Ajena/desconocida → 404 sin revelar existencia (espejo de ownedSession).
      if (!ownsSession(req, path.basename(socketPath), session)) {
        return res.status(404).json({ error: 'Sesión inexistente.' });
      }
      if (!VALID_MODELS.has(model)) return res.status(400).json({ error: 'Modelo inválido.' });
      // -l = literal (no interpretar el texto como nombres de tecla); luego Enter.
      // throwOnError: sin él runTmux traga el fallo y responderíamos ok:true
      // con la sesión muerta (mismo patrón que /kill).
      // Un solo runTmux (dos comandos tmux encadenados con ';') en vez de dos
      // llamadas separadas: si la sesión muere entre el texto y el Enter, con
      // dos invocaciones el texto queda tipeado a medias en el pane y el
      // endpoint responde 500 sin poder avisar ni revertir. Encadenados en una
      // sola invocación no queda ventana entre nuestro proceso y tmux.
      try {
        runTmux(
          socketPath,
          ['send-keys', '-t', session, '-l', `/model ${model}`, ';', 'send-keys', '-t', session, 'Enter'],
          { throwOnError: true }
        );
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
      // multi-tenant (BUG-685): solo el dueño (o admin) puede operar sobre la
      // sesión. Ajena/desconocida → 404 sin revelar existencia (espejo de ownedSession).
      if (!ownsSession(req, path.basename(socketPath), session)) {
        return res.status(404).json({ error: 'Sesión inexistente.' });
      }
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
