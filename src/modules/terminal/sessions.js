// modules/terminal/sessions.js — gestor de sesiones de terminal.
//
// Estrategia de persistencia (aprobada): HÍBRIDO tmux aislado.
//   - Cada sesión es un `tmux -L cwc new-session -A -s cwc-<id>` envuelto por
//     un node-pty que actúa de viewport.
//   - El proceso REAL vive dentro del servidor tmux del socket dedicado `cwc`,
//     así que sobrevive tanto a la desconexión del navegador como a un reinicio
//     del proceso Node (rehidratamos al arrancar).
//   - Mantenemos un ring buffer en memoria con la salida reciente para
//     re-pintar el terminal al reconectar.
import pty from 'node-pty';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_CONF = path.join(__dirname, 'tmux.cwc.conf');
const PREFIX = 'cwc-'; // prefijo de nombres de sesión tmux de este proyecto
// Prefijo de las sesiones tmux OCULTAS de las vistas TUI de conversaciones
// (bare). Distinto de PREFIX a propósito: no se listan ni se rehidratan como
// terminales normales, pero al vivir en tmux SOBREVIVEN un crash del server.
const BARE_PREFIX = 'cwct-';

// Base para args de tmux sobre nuestro socket + config aislados.
function tmuxArgs(...rest) {
  return ['-L', config.tmuxSocket, '-f', TMUX_CONF, ...rest];
}

// ¿Sigue viva la tmux oculta de una vista TUI? (para re-adjuntar tras reinicio)
export function bareTmuxAlive(id) {
  try {
    execFileSync('tmux', tmuxArgs('has-session', '-t', `=${BARE_PREFIX}${id}`), { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Ids de TODAS las tmux ocultas cwct-* vivas (para limpiar huérfanas al arrancar).
export function listBareTmuxIds() {
  try {
    const out = execFileSync('tmux', tmuxArgs('list-sessions', '-F', '#{session_name}'),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((n) => n.startsWith(BARE_PREFIX)).map((n) => n.slice(BARE_PREFIX.length));
  } catch { return []; }
}

export function killBareTmux(id) {
  try { execFileSync('tmux', tmuxArgs('kill-session', '-t', `=${BARE_PREFIX}${id}`), { stdio: 'ignore' }); }
  catch { /* ya no existe */ }
}

class Session {
  constructor({ id, cwd, title, attach = null, bare = false, command = null }) {
    this.id = id;
    this.tmuxName = (bare ? BARE_PREFIX : PREFIX) + id;
    this.cwd = cwd || config.home;
    this.title = title || 'terminal';
    // Si viene `attachSpec` = { socket, session }, esta sesión NO crea una tmux
    // propia: envuelve (adjunta) a una sesión tmux existente de cualquier
    // socket. No lleva prefijo cwc y NO se rehidrata al reiniciar Node.
    // (Ojo: NO usar `this.attach`, que es el método de adjuntar WebSockets.)
    this.attachSpec = attach;
    // Sesión "bare" = vista TUI de una conversación (`claude --resume`).
    // Corre DENTRO de una tmux oculta (BARE_PREFIX) para sobrevivir un crash
    // del server; no se lista como terminal ni se rehidrata acá (la rehidrata
    // el módulo chat, que es su dueño).
    this.bare = bare;
    this.command = command; // { file, args } cuando bare
    this.cols = 80;
    this.rows = 24;
    this.buffer = []; // ring buffer de chunks de salida
    this.bufferLen = 0;
    this.clients = new Set(); // WebSockets adjuntos
    this.proc = null;
    this.alive = false;
    this._exitWaiters = [];
  }

  spawn({ runClaude = false, model = null } = {}) {
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.TMUX;
    delete env.TMUX_PANE;

    if (this.bare) {
      // tmux oculta corriendo el comando DIRECTO (sin shell debajo): cuando
      // `claude` sale, la sesión tmux muere y el pty también (waitForExit).
      // new-session -A: si la tmux sobrevivió a un reinicio del server, se
      // re-adjunta (el comando se ignora) en vez de lanzar otro claude.
      const args = tmuxArgs(
        'new-session', '-A',
        '-s', this.tmuxName,
        '-x', String(this.cols),
        '-y', String(this.rows),
        '-c', this.cwd,
        this.command.file, ...this.command.args,
      );
      this.proc = pty.spawn('tmux', args, {
        name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
      });
    } else {
      let args;
      if (this.attachSpec) {
        // attach-session -d: nos adjuntamos como ÚNICO cliente (desadjunta a
        // otros), evitando la guerra de redimensionado entre clientes de tmux.
        args = ['-S', this.attachSpec.socket, 'attach-session', '-d', '-t', this.attachSpec.session];
      } else {
        // new-session -A: adjunta si existe, crea si no (idempotente = rehidratación).
        args = tmuxArgs(
          'new-session', '-A',
          '-s', this.tmuxName,
          '-x', String(this.cols),
          '-y', String(this.rows),
          '-c', this.cwd,
        );
      }
      this.proc = pty.spawn('tmux', args, {
        name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
      });
    }
    this.alive = true;

    this.proc.onData((data) => this._onData(data));
    this.proc.onExit(() => {
      this.alive = false;
      this._broadcast(JSON.stringify({ type: 'exit' }));
      for (const ws of this.clients) {
        try { ws.close(); } catch { /* noop */ }
      }
      this.clients.clear();
      const waiters = this._exitWaiters;
      this._exitWaiters = [];
      for (const w of waiters) { try { w(); } catch { /* noop */ } }
    });

    if (!this.bare && runClaude) {
      // Lanza Claude Code en la sesión; el modelo va como flag del CLI
      // (validado upstream contra VALID_MODELS — nunca texto arbitrario).
      this.proc.write(model ? `claude --model ${model}\r` : 'claude\r');
    }
    return this;
  }

  // Espera a que el pty muera; resuelve true si murió, false si expiró el timeout.
  waitForExit(timeoutMs) {
    if (!this.alive) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this._exitWaiters.push(() => finish(true));
    });
  }

  // Mata la sesión de verdad (tmux kill-session + pty). Las bare también son
  // tmux (oculta), así que el kill-session aplica igual; attachSpec no (ajena).
  kill() {
    if (!this.attachSpec) {
      try { execFileSync('tmux', tmuxArgs('kill-session', '-t', `=${this.tmuxName}`), { stdio: 'ignore' }); }
      catch { /* la sesión puede ya no existir */ }
    }
    try { this.proc?.kill(); } catch { /* noop */ }
    this.alive = false;
  }

  _onData(data) {
    // Acumula en ring buffer (recortando por cantidad de bytes aproximada).
    this.buffer.push(data);
    this.bufferLen += data.length;
    const maxBytes = config.scrollback * 120; // ~120 bytes por línea aprox.
    while (this.bufferLen > maxBytes && this.buffer.length > 1) {
      this.bufferLen -= this.buffer.shift().length;
    }
    this._broadcast(data, /*raw*/ true);
  }

  _broadcast(payload, raw = false) {
    // Salida del PTY -> frame BINARIO. Control (JSON) -> frame de TEXTO.
    const frame = raw ? Buffer.from(payload, 'utf8') : payload;
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  }

  attach(ws) {
    this.clients.add(ws);
    // Re-pinta el buffer reciente al reconectar (frame binario).
    const replay = this.buffer.join('');
    if (replay && ws.readyState === ws.OPEN) ws.send(Buffer.from(replay, 'utf8'));
  }

  detach(ws) {
    this.clients.delete(ws);
    // NO se mata el proceso: persiste (requisito de reconexión).
  }

  write(data) {
    if (this.alive && this.proc) this.proc.write(data);
  }

  resize(cols, rows) {
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.alive && this.proc) {
      try { this.proc.resize(cols, rows); } catch { /* noop */ }
    }
  }

  info() {
    return { id: this.id, title: this.title, cwd: this.cwd, alive: this.alive, bare: this.bare };
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this._seq = 0;
  }

  _nextId() {
    // id corto y único sin depender de random (que está vetado en algunos
    // contextos): contador + pid del proceso. El bucle evita colisionar con
    // una sesión rehidratada de un proceso previo que reusó este pid.
    for (;;) {
      this._seq += 1;
      const id = `${process.pid}-${this._seq}`;
      if (!this.sessions.has(id)) return id;
    }
  }

  // Rehidratación tras reinicio de Node: el proceso REAL vive en el servidor
  // tmux del socket `cwc`, así que al arrancar reconstruimos un Session por
  // cada `cwc-*` que siga vivo. spawn() con `new-session -A` se re-adjunta a
  // la existente (no crea una nueva). Solo tocamos nuestro prefijo: nunca
  // sesiones ajenas del mismo socket.
  rehydrate() {
    let out = '';
    try {
      out = execFileSync(
        'tmux',
        tmuxArgs('list-sessions', '-F', '#{session_name}\t#{pane_current_path}'),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      return 0; // sin servidor tmux o sin sesiones: nada que rehidratar
    }
    let count = 0;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [name, cwdRaw] = line.split('\t');
      if (!name || !name.startsWith(PREFIX)) continue;
      const id = name.slice(PREFIX.length);
      if (this.sessions.has(id)) continue;
      const cwd = (cwdRaw && cwdRaw.trim()) || config.home;
      const session = new Session({ id, cwd, title: path.basename(cwd) || 'terminal' });
      session.spawn({ runClaude: false });
      this.sessions.set(id, session);
      count += 1;
    }
    return count;
  }

  create({ cwd, runClaude = false, model = null, title, attach = null } = {}) {
    const id = this._nextId();
    const session = new Session({ id, cwd, title, attach }).spawn({ runClaude, model });
    this.sessions.set(id, session);
    return session;
  }

  // Sesión "bare" (tmux oculta cwct-): la usa el modo TUI del chat para correr
  // `claude --resume <sessionId>`. Acepta `id` explícito para RE-ADJUNTAR una
  // tmux que sobrevivió a un reinicio del server (new-session -A la retoma).
  createBare({ cwd, command, title, id = null } = {}) {
    const sid = id && !this.sessions.has(id) ? id : this._nextId();
    const session = new Session({ id: sid, cwd, title, bare: true, command }).spawn();
    this.sessions.set(sid, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  // Las sesiones "bare" (vistas TUI de conversaciones) NO se listan: se
  // reconstruyen desde /api/chat/list, no como pestañas PTY sueltas.
  list() {
    return [...this.sessions.values()].filter((s) => !s.bare).map((s) => s.info());
  }

  remove(id) {
    this.sessions.delete(id);
  }
}

export const sessionManager = new SessionManager();
export { PREFIX, BARE_PREFIX, tmuxArgs };
