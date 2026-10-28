// modules/terminal/sessions.js — gestor de sesiones de terminal.
//
// Estrategia de persistencia (aprobada): HÍBRIDO tmux aislado.
//   - Cada sesión se crea detached por un source-file efímero y un node-pty se
//     adjunta después como viewport.
//   - El proceso REAL vive dentro del servidor tmux del socket dedicado `cwc`,
//     así que sobrevive tanto a la desconexión del navegador como a un reinicio
//     del proceso Node (rehidratamos al arrancar).
//   - Mantenemos un ring buffer en memoria con la salida reciente para
//     re-pintar el terminal al reconectar.
import pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { resolveModelArg } from '../../core/claude-model.js';
import { CONSOLE_ROOT } from '../../core/paths.js';
import { resolveClaudeCredential } from '../../core/sponsorship.js';
import {
  ensureCliOnboarded,
  ensureUserSpace,
  hostUser,
  userDataDir,
  userRunnerEnv,
} from '../../core/user-space.js';
// Títulos humanos custom (titles.json), compartidos con el módulo tmux: se
// consultan acá para que una sesión rehidratada tras un reinicio de Node
// recupere el título que tenía antes de reiniciar (ver rehydrate() abajo —
// antes SIEMPRE usaba basename(cwd) para el título en memoria, ignorando
// cualquier customTitle ya persistido para esa misma sesión tmux).
import { loadOwners, loadTitles, setSessionOwner, titleKey } from '../../core/session-names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_CONF = path.join(__dirname, 'tmux.cwc.conf');
const PREFIX = 'cwc-'; // prefijo de nombres de sesión tmux de este proyecto
// Prefijo de las sesiones tmux OCULTAS de las vistas TUI de conversaciones
// (bare). Distinto de PREFIX a propósito: no se listan ni se rehidratan como
// terminales normales, pero al vivir en tmux SOBREVIVEN un crash del server.
const BARE_PREFIX = 'cwct-';
let tmuxCommandSeq = 0;

// El server tmux es compartido y de vida larga: un pane hereda SU entorno, no el
// del cliente que lo crea. Por eso toda variable que una sesión necesite se pasa
// explícita con `-e`, tanto al host como a un inquilino (console:BUG-2350).
const TMUX_ENV_KEYS = [
  'HOME', 'CWC_DATA_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH', 'TERM',
  'LANG', 'TZ', 'NODE_EXTRA_CA_CERTS', 'TOLKIEN_MCP_TOKEN',
];

// Lookup compartido con el módulo tmux: reconoce únicamente sesiones creadas
// por la consola en su socket propio. Devuelve null ante cualquier destino
// externo o sesión que ya no tenga una envoltura viva en sessionManager.
export function consoleSession(socketName, sessionName) {
  if (socketName !== config.tmuxSocket) return null;
  let id = null;
  if (sessionName.startsWith(BARE_PREFIX)) id = sessionName.slice(BARE_PREFIX.length);
  else if (sessionName.startsWith(PREFIX)) id = sessionName.slice(PREFIX.length);
  else return null;
  return sessionManager.get(id) || null;
}

// ¿Este principal puede adjuntarse/controlar la tmux <socketName>/<sessionName>?
// Oversight: todo, porque adjuntarse expone y permite controlar contenido ajeno.
// Sin oversight (candado ESTRICTO, decisión de Niko 2026-07-27): SOLO sesiones
// de la consola (socket propio + prefijo conocido) cuyo Session.owner sea él.
// Ser admin no alcanza. Otro socket, tmux externa u owner desconocido/null ⇒
// false. Fail-closed: nunca se adivina el dueño de una sesión.
export function canUseTmuxSession(principal, socketName, sessionName) {
  if (principal.oversight) return true;
  const session = consoleSession(socketName, sessionName);
  return !!session && session.owner === principal.username;
}

// Base para args de tmux sobre nuestro socket + config aislados.
function tmuxArgs(...rest) {
  return ['-L', config.tmuxSocket, '-f', TMUX_CONF, ...rest];
}

// Quote para el parser de comandos de tmux 3.x: dentro de comillas dobles,
// backslash, comillas, dólar y tilde tienen semántica propia.
// Un newline crudo rompería la línea del archivo de comandos, por eso va como escape \n de tmux.
function tmuxQuote(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/~/g, '\\~')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function sessionExists(name) {
  try {
    execFileSync('tmux', tmuxArgs('has-session', '-t', `=${name}`), { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function createTmuxSessionViaFile({ owner, name, envMap, cols, rows, cwd, command, env }) {
  const dir = path.join(userDataDir(owner || hostUser()), 'terminal-spawn');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best-effort sobre directorios existentes */ }

  // Limpia restos de un crash; nunca impide crear la sesión actual.
  try {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tmux')) continue;
      const stale = path.join(dir, entry.name);
      try {
        if (fs.statSync(stale).mtimeMs < cutoff) fs.rmSync(stale, { force: true });
      } catch { /* barrido best-effort */ }
    }
  } catch { /* barrido best-effort */ }

  tmuxCommandSeq += 1;
  const file = path.join(dir, `${name}-${process.pid}-${Date.now()}-${tmuxCommandSeq}.tmux`);
  let content = 'new-session -d';
  for (const [key, value] of envMap) content += ` -e ${tmuxQuote(`${key}=${value}`)}`;
  content += ` -s ${tmuxQuote(name)} -x ${cols} -y ${rows} -c ${tmuxQuote(cwd)}`;
  if (command) {
    content += ` ${tmuxQuote(command.file)}`;
    for (const arg of command.args) content += ` ${tmuxQuote(arg)}`;
  }
  content += '\n';

  try {
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    execFileSync('tmux', tmuxArgs('start-server', ';', 'source-file', file), {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    const detail = String(e?.stderr || e?.message || e).trim();
    throw new Error(`No se pudo crear la sesión tmux: ${detail}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const validDim = (value) => Number.isInteger(value) && value >= 1 && value <= 1000;

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
  constructor({ id, cwd, title, attach = null, bare = false, command = null, owner = null }) {
    this.id = id;
    this.tmuxName = (bare ? BARE_PREFIX : PREFIX) + id;
    this.cwd = cwd || config.home;
    this.title = title || 'terminal';
    // multi-tenant (BUG-680): username del dueño (de principalOf al crear).
    // null = host/admin (retrocompat). Gobierna la visibilidad en list() y el
    // guard de ownership del WS. Espejo de Chat.owner.
    this.owner = owner;
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
    // BUG-2104: espejo del blindaje anticonsumo del chat para inquilinos; el
    // host conserva exactamente el entorno completo anterior.
    const isTenant = !!this.owner && this.owner !== hostUser();
    let env;
    if (isTenant) {
      ensureUserSpace(this.owner);
      // Repara también inquilinos existentes al spawnear; es idempotente y la
      // segunda vez no escribe.
      ensureCliOnboarded(this.owner);
      const credential = resolveClaudeCredential(this.owner);
      const oauthToken = credential.token;
      // FAIL-CLOSED: correr `claude` sin credencial propia o patrocinada caería
      // a una cuenta no autorizada. Un shell pelado NO necesita token.
      const needsClaude = this.bare || runClaude;
      if (needsClaude && !oauthToken) {
        this.alive = false;
        if (credential.sponsor) {
          const msg = `El usuario ${this.owner} está patrocinado por ${credential.sponsor}, pero ${credential.sponsor} no tiene un token de patrocinio. Generalo con \`claude setup-token\` y guardalo en su oauth-token.`;
          throw Object.assign(new Error(msg), { statusCode: 409, publicMessage: msg });
        }
        const msg = `El usuario ${this.owner} no tiene credencial propia de Claude: completá el paso de credenciales del onboarding antes de abrir una sesión de Claude.`;
        throw Object.assign(new Error(msg), { statusCode: 409, publicMessage: msg });
      }
      env = { ...userRunnerEnv(this.owner, { oauthToken }), TERM: 'xterm-256color' };
    } else {
      env = { ...process.env, TERM: 'xterm-256color' };  // host: retrocompat TOTAL
    }
    // Misma raíz de consola que reciben los runners de chat: una skill del
    // catálogo invocada desde una TUI necesita poder resolver los CLIs de bin/.
    env.CWC_CONSOLE_ROOT = CONSOLE_ROOT;
    delete env.TMUX;
    delete env.TMUX_PANE;
    const tmuxEnv = new Map();
    if (isTenant) {
      try {
        const globalEnv = execFileSync('tmux', tmuxArgs('show-environment', '-g'), {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        for (const line of globalEnv.split('\n')) {
          const separator = line.indexOf('=');
          const key = line.startsWith('-')
            ? line.slice(1)
            : separator === -1 ? line : line.slice(0, separator);
          if (key && (key.startsWith('CWC_') || /(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL)/i.test(key))) {
            tmuxEnv.set(key, '');
          }
        }
      } catch {
        // Best-effort: si no se puede leer, seguimos con la allowlist existente.
      }
      // El server tmux es compartido: su entorno global se filtra a cada pane.
      // `-e CLAVE=` en este mismo new-session es la única forma de neutralizarlo
      // al crear el primer pane; la allowlist owner-scoped se aplica después.
    }
    for (const key of [
      ...TMUX_ENV_KEYS,
      ...Object.keys(env).filter((key) => /^(CWC_|TOLKIEN_)/.test(key)),
    ]) {
      if (env[key] !== undefined) tmuxEnv.set(key, env[key]);
    }
    // IMPORTANTE: si la sesión ya existe no se reescribe su entorno. Equivale
    // a que `new-session -A` ignoraba los `-e`: para aplicar un entorno nuevo
    // hay que matar y recrear, no puede corregirse durante la rehidratación.
    if (this.bare) {
      // tmux oculta corriendo el comando DIRECTO (sin shell debajo): cuando
      // `claude` sale, la sesión tmux muere y el pty también (waitForExit).
      // Si sobrevivió a un reinicio, se re-adjunta en vez de lanzar otro claude.
      if (!sessionExists(this.tmuxName)) {
        try {
          createTmuxSessionViaFile({
            owner: this.owner,
            name: this.tmuxName,
            envMap: tmuxEnv,
            cols: this.cols,
            rows: this.rows,
            cwd: this.cwd,
            command: this.command,
            env,
          });
        } catch (e) {
          this.proc = null;
          this.alive = false;
          throw e;
        }
      }
      const args = tmuxArgs('attach-session', '-t', `=${this.tmuxName}`);
      try {
        this.proc = pty.spawn('tmux', args, {
          name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
        });
      } catch (e) {
        this.proc = null;
        this.alive = false;
        throw new Error(`No se pudo lanzar el pty de la sesión (bare): ${e?.message || e}`);
      }
    } else {
      let args;
      if (this.attachSpec) {
        // attach-session -d: nos adjuntamos como ÚNICO cliente (desadjunta a
        // otros), evitando la guerra de redimensionado entre clientes de tmux.
        args = ['-S', this.attachSpec.socket, 'attach-session', '-d', '-t', this.attachSpec.session];
      } else {
        if (!sessionExists(this.tmuxName)) {
          try {
            createTmuxSessionViaFile({
              owner: this.owner,
              name: this.tmuxName,
              envMap: tmuxEnv,
              cols: this.cols,
              rows: this.rows,
              cwd: this.cwd,
              command: null,
              env,
            });
          } catch (e) {
            this.proc = null;
            this.alive = false;
            throw e;
          }
        }
        args = tmuxArgs('attach-session', '-t', `=${this.tmuxName}`);
      }
      try {
        this.proc = pty.spawn('tmux', args, {
          name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
        });
      } catch (e) {
        this.proc = null;
        this.alive = false;
        throw new Error(`No se pudo lanzar el pty de la sesión: ${e?.message || e}`);
      }
    }
    // Defensa en profundidad: si por lo que sea this.proc no quedó seteado
    // (sin haber tirado excepción), no registramos handlers sobre undefined.
    if (!this.proc) {
      this.alive = false;
      throw new Error('No se pudo lanzar el pty de la sesión: pty.spawn() no devolvió proceso.');
    }
    this.alive = true;

    this.proc.onData((data) => {
      try { this._onData(data); } catch (e) { console.error('[terminal]', e); }
    });
    this.proc.onExit(() => {
      try {
        this.alive = false;
        this._broadcast(JSON.stringify({ type: 'exit' }));
        for (const ws of this.clients) {
          try { ws.close(); } catch { /* noop */ }
        }
        this.clients.clear();
        const waiters = this._exitWaiters;
        this._exitWaiters = [];
        for (const w of waiters) { try { w(); } catch { /* noop */ } }
      } catch (e) { console.error('[terminal]', e); }
    });

    if (!this.bare && runClaude) {
      // Lanza Claude Code en la sesión; el modelo va como flag del CLI
      // (validado upstream contra VALID_MODELS — nunca texto arbitrario).
      // Default "Todo": arranca en modo bypass (--dangerously-skip-permissions)
      // — pedido del usuario 2026-07-06: sesión TUI nueva no pide permisos.
      const claudeCmd = model
        ? `claude --dangerously-skip-permissions --model ${resolveModelArg(model)}`
        : 'claude --dangerously-skip-permissions';
      this.proc.write(`${claudeCmd}\r`);
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
    // Tope DURO: si el único chunk sobreviviente excede por sí solo el máximo
    // (burst gigante del pty), conservar solo su cola — el replay ya arranca
    // en un límite arbitrario de chunk, así que esto no agrega corte nuevo.
    if (this.bufferLen > maxBytes && this.buffer.length === 1) {
      this.buffer[0] = this.buffer[0].slice(-maxBytes);
      this.bufferLen = this.buffer[0].length;
    }
    this._broadcast(data, /*raw*/ true);
  }

  _broadcast(payload, raw = false) {
    // Salida del PTY -> frame BINARIO. Control (JSON) -> frame de TEXTO.
    // OJO: con raw=true `payload` es un STRING (node-pty se spawnea sin
    // `encoding` => default 'utf8' => onData entrega strings, NO Buffers);
    // Buffer.from(string,'utf8') lo re-codifica sin pérdida y fuerza el frame
    // binario en ws. NO invertir este ternario: mandar el string crudo saldría
    // como frame de TEXTO y el cliente lo confundiría con JSON de control.
    const frame = raw ? Buffer.from(payload, 'utf8') : payload;
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  }

  attach(ws) {
    this.clients.add(ws);
    // Re-pinta el buffer reciente al reconectar (frame binario).
    // Los chunks del ring buffer son STRINGS (node-pty default encoding
    // 'utf8', ver _broadcast): join('') + Buffer.from(...,'utf8') es la
    // conversión sin pérdida. NO usar Buffer.concat acá: sobre strings LANZA
    // TypeError y el catch del router ws cierra la conexión => reconectar a
    // una terminal con scrollback quedaba roto (regresión de un auto-fix
    // previo que asumió Buffers, revertida 2026-07-04).
    const replay = this.buffer.join('');
    if (replay && ws.readyState === ws.OPEN) ws.send(Buffer.from(replay, 'utf8'));
  }

  detach(ws) {
    this.clients.delete(ws);
    // NO se mata el proceso: persiste (requisito de reconexión).
  }

  write(data) {
    // try/catch como resize(): un write a un PTY que se cerró entre el check y
    // la escritura no debe tumbar el handler del WebSocket (invariante 5).
    if (this.alive && this.proc) {
      try { this.proc.write(data); } catch (e) { console.error('[terminal] write falló:', e?.message); }
    }
  }

  resize(cols, rows) {
    if (!validDim(cols) || !validDim(rows)) return;
    if (this.alive && this.proc) {
      try { this.proc.resize(cols, rows); } catch (e) {
        console.error('[terminal] resize falló:', e?.message);
        return;
      }
    }
    this.cols = cols;
    this.rows = rows;
  }

  info() {
    return { id: this.id, title: this.title, cwd: this.cwd, alive: this.alive, bare: this.bare, owner: this.owner };
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
  // cada `cwc-*` que siga vivo. spawn() detecta la existente y se re-adjunta
  // sin crear una nueva. Solo tocamos nuestro prefijo: nunca
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
    // Títulos custom persistidos (titles.json): mismo mecanismo que usa el
    // módulo tmux para mostrar la tarjeta. Sin esto, una sesión con customTitle
    // (p.ej. "tolkien 1" por colisión de basename al crearla) recupera SOLO el
    // basename crudo al rehidratar tras un reinicio de Node.
    const titles = loadTitles();
    const owners = loadOwners();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [name, cwdRaw] = line.split('\t');
      if (!name || !name.startsWith(PREFIX)) continue;
      const id = name.slice(PREFIX.length);
      if (this.sessions.has(id)) continue;
      const cwd = (cwdRaw && cwdRaw.trim()) || config.home;
      const title = titles[titleKey(config.tmuxSocket, name)] || path.basename(cwd) || 'terminal';
      // Dueño persistido (session-owners.json): sin esto la sesión rehidratada
      // nace con owner=null y su dueño deja de verla tras un reinicio
      // del server (la tmux sigue viva). FAIL-CLOSED: si no hay entrada, sigue
      // siendo null (solo quien tiene oversight la ve) — nunca se adivina un
      // dueño.
      const session = new Session({ id, cwd, title, owner: owners[id] || null });
      try {
        session.spawn({ runClaude: false });
      } catch (e) {
        console.error(`[terminal] Error rehidratando sesión ${id}:`, e);
        continue; // no registrarla; seguimos con las siguientes
      }
      this.sessions.set(id, session);
      count += 1;
    }
    return count;
  }

  create({ cwd, runClaude = false, model = null, title, attach = null, owner = null } = {}) {
    const id = this._nextId();
    const session = new Session({ id, cwd, title, attach, owner });
    try {
      session.spawn({ runClaude, model });
    } catch (e) {
      // No la registramos (this.sessions.set) si el spawn falló: evita dejar
      // una sesión "fantasma" en el mapa (mismo criterio que createBare()).
      console.error(`[terminal] Error creando sesión ${id}:`, e);
      throw e;
    }
    this.sessions.set(id, session);
    if (owner) {
      let ok = false;
      try {
        ok = setSessionOwner(id, owner) === true;
      } catch (e) {
        console.error('[terminal] Error persistiendo el dueño de la sesión', id, e?.message || e);
      }
      if (!ok) {
        console.error('[terminal] No se pudo persistir el dueño de la sesión', id, '· owner:', owner);
        if (owner !== hostUser()) {
          try { session.kill(); } catch { /* best-effort */ }
          this.sessions.delete(id);
          throw new Error('No se pudo registrar el dueño de la sesión.');
        }
      }
    }
    return session;
  }

  // Sesión "bare" (tmux oculta cwct-): la usa el modo TUI del chat para correr
  // `claude --resume <sessionId>`. Acepta `id` explícito para RE-ADJUNTAR una
  // tmux que sobrevivió a un reinicio del server (spawn detecta y la retoma).
  createBare({ cwd, command, title, id = null, owner = null } = {}) {
    const sid = id && !this.sessions.has(id) ? id : this._nextId();
    const session = new Session({ id: sid, cwd, title, bare: true, command, owner });
    try {
      session.spawn();
    } catch (e) {
      // No la registramos (this.sessions.set) si el spawn falló: evita dejar
      // una sesión "fantasma" en el mapa. Logueamos acá para que quede
      // rastro aunque el caller no maneje la excepción, y la repropagamos
      // (mismo contrato de antes) porque los callers (chat/_toTui, rehydrate)
      // ya la contemplan.
      console.error(`[terminal] Error creando sesión bare ${sid}:`, e);
      throw e;
    }
    this.sessions.set(sid, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  // Las sesiones "bare" (vistas TUI de conversaciones) NO se listan: se
  // reconstruyen desde /api/chat/list, no como pestañas PTY sueltas.
  // multi-tenant (BUG-680): filtra por dueño salvo que haya oversight, porque
  // listar sesiones ajenas revela contenido; ser admin no alcanza. Espejo de
  // Chat.list(principal). Las sesiones rehidratadas recuperan el owner desde
  // session-owners.json; sin entrada quedan con owner=null y solo quien tiene
  // oversight las ve (fail-closed: nunca se adivina el dueño de una sesión).
  list(principal) {
    const visible = [...this.sessions.values()].filter((s) => {
      if (s.bare) return false;
      if (principal && principal.oversight) return true;
      return s.owner === (principal ? principal.username : null);
    });
    return visible.map((s) => s.info());
  }

  remove(id) {
    this.sessions.delete(id);
  }
}

export const sessionManager = new SessionManager();
export { PREFIX, BARE_PREFIX, tmuxArgs };
