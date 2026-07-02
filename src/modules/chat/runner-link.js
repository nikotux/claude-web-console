// modules/chat/runner-link.js — lado SERVER del runner desacoplado: lanzar el
// proceso (detached: sobrevive al server) y hablarle por su socket Unix.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHATS_DIR, sockPath, logPath } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-chat-runner.js');

const HELLO_TIMEOUT_MS = 5000;

// Lanza el runner de una conversación como proceso INDEPENDIENTE: detached
// (sesión POSIX propia = setsid) + unref, con stdout/err a su log. Un crash
// del server no lo toca. OJO systemd: además la unidad usa KillMode=process,
// si no el cgroup entero (runners incluidos) moriría en cada restart.
export function spawnRunner({ id, cwd, model, mode, resume }) {
  fs.mkdirSync(CHATS_DIR, { recursive: true, mode: 0o700 });
  const log = fs.openSync(logPath(id), 'a');
  const args = [RUNNER, '--id', id, '--cwd', cwd, '--sock', sockPath(id), '--mode', mode || 'default'];
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  const child = spawn(process.execPath, args, {
    cwd, detached: true, stdio: ['ignore', log, log], env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

// Conexión viva a un runner. Callbacks que setea el dueño (Chat):
//   link.onEvent(event)  — evento de UI en vivo
//   link.onClose()       — el runner murió o cortó el socket
export class RunnerLink {
  constructor(socket) {
    this.socket = socket;
    this.onEvent = null;
    this.onClose = null;
    this._helloWaiters = [];
    this._buf = '';
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this._onData(chunk));
    const bye = () => {
      if (this._done) return;
      this._done = true;
      for (const w of this._helloWaiters.splice(0)) w(null);
      this.onClose?.();
    };
    socket.on('close', bye);
    socket.on('error', bye);
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.t === 'hello') {
        for (const w of this._helloWaiters.splice(0)) w(msg);
      } else if (msg.t === 'event' && msg.event) {
        try { this.onEvent?.(msg.event); } catch { /* handler roto no tumba el link */ }
      }
    }
  }

  send(obj) {
    try { this.socket.write(`${JSON.stringify(obj)}\n`); return true; }
    catch { return false; }
  }

  // Pide el estado completo al runner (historial de su vida incluido).
  hello() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS);
      this._helloWaiters.push((msg) => { clearTimeout(timer); resolve(msg); });
      if (!this.send({ t: 'hello' })) { clearTimeout(timer); resolve(null); }
    });
  }

  close() {
    try { this.socket.destroy(); } catch { /* noop */ }
  }
}

// UN intento de conexión (para rehidratar: ¿sigue vivo el runner?).
export function tryConnectRunner(id, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath(id));
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(new RunnerLink(socket)); });
    socket.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// Conexión con reintentos (para el arranque: el runner tarda en escuchar).
export async function connectRunner(id, { attempts = 40, delayMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const link = await tryConnectRunner(id, 1000);
    if (link) return link;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}
