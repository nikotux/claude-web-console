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

// Base para args de tmux sobre nuestro socket + config aislados.
function tmuxArgs(...rest) {
  return ['-L', config.tmuxSocket, '-f', TMUX_CONF, ...rest];
}

class Session {
  constructor({ id, cwd, title, attach = null }) {
    this.id = id;
    this.tmuxName = PREFIX + id;
    this.cwd = cwd || config.home;
    this.title = title || 'terminal';
    // Si viene `attachSpec` = { socket, session }, esta sesión NO crea una tmux
    // propia: envuelve (adjunta) a una sesión tmux existente de cualquier
    // socket. No lleva prefijo cwc y NO se rehidrata al reiniciar Node.
    // (Ojo: NO usar `this.attach`, que es el método de adjuntar WebSockets.)
    this.attachSpec = attach;
    this.cols = 80;
    this.rows = 24;
    this.buffer = []; // ring buffer de chunks de salida
    this.bufferLen = 0;
    this.clients = new Set(); // WebSockets adjuntos
    this.proc = null;
    this.alive = false;
  }

  spawn({ runClaude = false } = {}) {
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
    // Limpiamos TMUX/TMUX_PANE del hijo para no anidar tmux (el server puede
    // haber sido lanzado desde dentro de una sesión tmux).
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.TMUX;
    delete env.TMUX_PANE;
    this.proc = pty.spawn('tmux', args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });
    this.alive = true;

    this.proc.onData((data) => this._onData(data));
    this.proc.onExit(() => {
      this.alive = false;
      this._broadcast(JSON.stringify({ type: 'exit' }));
      for (const ws of this.clients) {
        try { ws.close(); } catch { /* noop */ }
      }
      this.clients.clear();
    });

    if (runClaude) {
      // Lanza Claude Code dentro de la sesión (para "Abrir Claude Code aquí").
      this.proc.write('claude\r');
    }
    return this;
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
    return { id: this.id, title: this.title, cwd: this.cwd, alive: this.alive };
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

  create({ cwd, runClaude = false, title, attach = null } = {}) {
    const id = this._nextId();
    const session = new Session({ id, cwd, title, attach }).spawn({ runClaude });
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  remove(id) {
    this.sessions.delete(id);
  }
}

export const sessionManager = new SessionManager();
export { PREFIX, tmuxArgs };
