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

// Lock SINCRÓNICO de arranque (INVARIANTE aprendido: toda función que decide
// spawnear un proceso exclusivo debe chequear Y escribir su propio lock
// DENTRO de sí misma, sin depender de guardas asíncronas del hijo — mismo
// patrón que health/shared.js writeFixLock/isFixing + health/index.js
// spawnFix/spawnOrchestrator, ver el comentario ahí sobre el TOCTOU). Antes
// spawnRunner() dependía por completo de claimSocket() (async, corre DENTRO
// del hijo bin/cwc-chat-runner.js DESPUÉS del spawn) para que un runner
// duplicado se suicide: si dos spawns para el MISMO id se disparaban casi
// juntos (p.ej. dos procesos server solapados en un restart), ambos podían
// llegar a `server.listen()` del mismo socket antes de que cualquiera se
// enterara del otro. Acá el chequeo+escritura pasa en el MISMO turno de JS
// que decide spawnear, sin ningún `await` de por medio (Node es
// single-thread: nada puede intercalarse en el medio) — cierra la ventana de
// raíz en vez de confiar en que el hijo llegue a tiempo. La ventana de
// frescura es corta a propósito: solo cubre fork+exec+bind del socket: la
// autoridad de "¿sigue vivo?" a mediano/largo plazo sigue siendo el socket
// (tryConnectRunner/claimSocket), esto no la reemplaza.
const SPAWN_LOCK_FRESH_MS = 10000;
const spawnLockPath = (id) => path.join(CHATS_DIR, `${id}.spawnlock`);
function spawnLockAlive(id) {
  try {
    const { ts } = JSON.parse(fs.readFileSync(spawnLockPath(id), 'utf8'));
    return Date.now() - ts < SPAWN_LOCK_FRESH_MS;
  } catch { return false; }
}
function writeSpawnLock(id, pid) {
  try { fs.writeFileSync(spawnLockPath(id), JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 }); }
  catch { /* best-effort: un fallo de disco acá no debe tumbar el spawn */ }
}

// Lanza el runner de una conversación como proceso INDEPENDIENTE: detached
// (sesión POSIX propia = setsid) + unref, con stdout/err a su log. Un crash
// del server no lo toca. OJO systemd: además la unidad usa KillMode=process,
// si no el cgroup entero (runners incluidos) moriría en cada restart.
export function spawnRunner({ id, cwd, model, mode, resume, selfHandle, effort }) {
  fs.mkdirSync(CHATS_DIR, { recursive: true, mode: 0o700 });
  // Chequeo+escritura sincrónicos ANTES de spawnear (ver comentario arriba).
  if (spawnLockAlive(id)) {
    throw new Error('Ya se está lanzando (o ya corre) un runner para esta conversación.');
  }
  writeSpawnLock(id, 0); // placeholder inmediato; se pisa con el pid real abajo
  const log = fs.openSync(logPath(id), 'a');
  const args = [RUNNER, '--id', id, '--cwd', cwd, '--sock', sockPath(id), '--mode', mode || 'default'];
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  // Eje thinking effort (PEND-391 #3): el effort es opción de SPAWN del Agent
  // SDK (no hay q.setEffort() en vivo — ver la decisión de arquitectura en Pad),
  // así que viaja como argv al nacer el runner. Un cambio de effort a mitad de
  // vida se aplica por "Reabrir para cambios" (respawn) o al dormir/despertar.
  if (effort) args.push('--effort', effort);
  // Identidad del chat en el Interfono (rediseño 2026-07-10, Fase 0.4): una Bash
  // tool que ejecute `cwc-bus.js send` hereda este env, así el mensaje sale con
  // `from: claude:<sessionId>` real en vez de `from: null` (selfIdentity de
  // bin/cwc-bus.js lo lee primero). Se pasa solo cuando ya conocemos el
  // sessionId (resume/reopen — la mayoría de los chats de larga vida que
  // coordinan); el primerísimo arranque de un chat nuevo aún no lo tiene y cae
  // al fallback (from null), sin regresión.
  const env = selfHandle ? { ...process.env, CWC_SELF_HANDLE: selfHandle } : process.env;
  const child = spawn(process.execPath, args, {
    cwd, detached: true, stdio: ['ignore', log, log], env,
  });
  writeSpawnLock(id, child.pid);
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
