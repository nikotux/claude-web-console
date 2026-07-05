// modules/chat/index.js — chat nativo con Claude vía Agent SDK (Fase 4a).
//
// RESILIENCIA: el motor de cada conversación (query() del SDK) ya NO vive en
// este proceso. Corre en un RUNNER independiente (bin/cwc-chat-runner.js,
// detached, socket Unix en ~/.cwc-data/chats/<id>.sock). Este módulo solo
// lanza runners, se conecta y traduce: si el server crashea a mitad de un
// turno, el runner sigue trabajando y al volver nos reconectamos.
//
// HTTP:
//   POST /api/chat/create {cwd?, model?, permissionMode?} -> { chat }
//   GET  /api/chat/list                                   -> { chats }
//   POST /api/chat/close {id}
//   POST /api/chat/model {id, model}  -> cambia el modelo (en vivo si el
//        motor está corriendo — q.setModel() del SDK, igual que setMode con
//        permisos —, o solo actualiza this.model para el próximo arranque si
//        está dormido). Antes SOLO existía para sesiones tmux (/model
//        tipeado a la TUI); ahora las conversaciones también lo tienen desde
//        el menú ⋯ de Sesiones.
// WS  /ws/chat?id=<id>
//   c->s: {type:'user', text} · {type:'permission_response', id, allow}
//         {type:'interrupt'} · {type:'set_mode', mode} · {type:'set_model', model}
//   s->c: {type:'history', events, slashCommands} · {type:'user', text} · {type:'delta', text}
//         {type:'tool_use', name, summary} · {type:'result', costUsd, usage, ms}
//         {type:'permission_request', id, tool, input} · {type:'status', state}
//         {type:'mode', mode} · {type:'model', model} · {type:'error', message} · {type:'closed'}
//         {type:'meta', slashCommands:[{name,description|null}]} (Fase 8:
//          comandos del init, enriquecidos con el frontmatter de los SKILL.md)
import express from 'express';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../../core/config.js';
import { clampToHome } from '../../core/paths.js';
import { VALID_MODELS, encodeCwd } from '../../core/claude-model.js';
import { sessionIdForCwd } from '../../core/claude-state.js';
import { generateInventory, ROOT as CONSOLE_ROOT } from '../../core/inventory.js';
import { sessionManager, tmuxArgs, bareTmuxAlive, listBareTmuxIds, killBareTmux } from '../terminal/sessions.js';
import {
  UUID_RE, PERMISSION_MODES, PERMISSION_TIMEOUT_MS, SLEEP_MS, HISTORY_MAX, CHATS_DIR,
  trim, toolSummary, toolDetail, resultText,
} from './shared.js';
import { spawnRunner, connectRunner, tryConnectRunner } from './runner-link.js';
import { recordBugfix } from '../bugfixes/store.js';
import { uniqueName, registerNameProvider } from '../../core/session-names.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const FORGET_MS = 24 * 3600 * 1000; // dormida sin uso => recién ahí se descarta la tarjeta (sigue retomable desde el lanzador)

// ===== Auto-título con IA (Haiku) =====
// En cada mensaje del usuario se extrae EN PARALELO (jamás bloquea el turno)
// un título de máx. 20 caracteres que describe qué se está haciendo, y la
// tarjeta/cabecera se renombran solas (la UI lo levanta por el poll de 8 s).
// Guardas de costo: Haiku + un mensaje mínimo + throttle por conversación.
const AUTOTITLE_MAX_LEN = 20;
const AUTOTITLE_MIN_INTERVAL_MS = 20000; // máx. una extracción cada 20 s por chat
const AUTOTITLE_TIMEOUT_MS = 30000;

// Corrida IA mínima y READ-ONLY (doble capa, regla 6 del CLAUDE.md: hook
// PreToolUse + canUseTool — acá directamente se deniega TODA herramienta:
// el modelo solo resume texto). Haiku: el más barato, sobra para 20 chars.
async function extractTitle({ cwd, current, text }) {
  const q = query({
    prompt:
      `Resumí en un título de MÁXIMO ${AUTOTITLE_MAX_LEN} caracteres (español, sin comillas ni punto final) qué se está haciendo en esta sesión de trabajo.\n` +
      `Proyecto: ${path.basename(cwd) || '~'}\n` +
      `Título actual: «${current}»\n` +
      `Último pedido del usuario: «${text.slice(0, 500)}»\n` +
      `Si el pedido no cambia de tema, respondé el título actual tal cual. Respondé SOLO el título, nada más.`,
    options: {
      cwd,
      model: 'haiku',
      maxTurns: 1,
      permissionMode: 'default',
      settingSources: [], // sin NINGÚN setting (ni project/local): no usa herramientas — cero MCP/skills/CLAUDE.md, solo resume texto (patrón projects/analyzeChange)
      hooks: {
        PreToolUse: [{
          hooks: [async () => ({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Extracción de título: sin herramientas.',
            },
          })],
        }],
      },
      canUseTool: async () => ({ behavior: 'deny', message: 'Extracción de título: sin herramientas.' }),
    },
  });
  let out = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), AUTOTITLE_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text;
      } else if (m.type === 'result') break;
    }
  })();
  try {
    await Promise.race([pump, timeout]);
  } catch (err) {
    try { q.interrupt?.(); } catch { /* noop */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  // Saneo duro: una línea, sin comillas, tope de caracteres SIEMPRE.
  return out.replace(/["'«»`]/g, '').split('\n')[0].trim().slice(0, AUTOTITLE_MAX_LEN);
}

// Persistencia de conversaciones abiertas (para sobrevivir reinicios del server).
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

// Registro DURABLE append-only de TODOS los sessionIds que ALGUNA VEZ
// pertenecieron a un chat de la consola. A diferencia de chats.json (que
// persist() poda al cerrar y el reaper al olvidar a las 24 h), este archivo
// NUNCA se poda: lo lee el módulo tokens (buildSummary) para atribuir cada
// transcript al motor "chat" aunque la conversación ya no exista — sin él,
// un chat cerrado se contaba como "Motores headless" en el panel de Uso
// (fable/opus fantasma). Set en memoria (lazy) + escritura SOLO si aparecen
// ids nuevos; best-effort: jamás rompe persist()/rehydrate().
const CHAT_IDS_FILE = path.join(DATA_DIR, 'chat-session-ids.json');
let _chatIdsReg = null;
function registerChatSessionIds(ids) {
  try {
    if (!_chatIdsReg) {
      _chatIdsReg = new Set();
      try {
        const arr = JSON.parse(fss.readFileSync(CHAT_IDS_FILE, 'utf8'));
        if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string' && id) _chatIdsReg.add(id);
      } catch { /* primera vez: el archivo todavía no existe */ }
    }
    let dirty = false;
    for (const id of ids) {
      if (id && typeof id === 'string' && !_chatIdsReg.has(id)) { _chatIdsReg.add(id); dirty = true; }
    }
    if (dirty) {
      fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fss.writeFileSync(CHAT_IDS_FILE, JSON.stringify([..._chatIdsReg]), { mode: 0o600 });
    }
  } catch { /* best-effort */ }
}

// Traspaso Chat <-> TUI (una misma conversación, un solo modo a la vez).
const SWITCH_CLOSE_MS = 8000; // T1: esperar a que muera el motor de chat
const SWITCH_CTRLC_MS = 8000; // T2: esperar a que `claude` salga tras Ctrl-C x2
const SWITCH_KILL_MS = 5000;  // T3: esperar tras kill() forzado

// Anti traversal: resuelve contra el home y cae a él si escapa (core/paths.js).
const safeCwd = clampToHome;

// ===== Comandos slash (Fase 8) =====
// El system/init del SDK llega recién con el PRIMER mensaje de cada
// conversación. Esta caché por cwd (en memoria; se repuebla con el primer
// turno tras un reinicio) permite que un chat nuevo en un cwd ya visto tenga
// la lista al instante en el attach.
const slashByCwd = new Map();
const MAX_CACHED_CWDS = 50; // invariante 17: la caché no puede crecer sin límite

// set() con expulsión LRU: reinsertar (recencia) y, si excede el límite,
// descartar el cwd más viejo (primera clave del Map preserva orden de inserción).
function cacheSlash(cwd, list) {
  slashByCwd.delete(cwd);
  slashByCwd.set(cwd, list);
  if (slashByCwd.size > MAX_CACHED_CWDS) slashByCwd.delete(slashByCwd.keys().next().value);
}
const SKILL_NAME_RE = /^[a-z0-9_-]+$/i; // solo nombres saneados van a disco

// description: del frontmatter de un SKILL.md (una línea plana; los bloques
// YAML multilínea quedan sin descripción, no vale la pena parsear YAML acá).
function skillDescription(file) {
  try {
    const head = fss.readFileSync(file, 'utf8').slice(0, 2000);
    const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const m = fm && fm[1].match(/^description:[ \t]*(.+)$/m);
    if (!m) return null;
    return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 160) || null;
  } catch { return null; }
}

// Nombres crudos del init -> [{name, description|null}]. Lee (SOLO lectura)
// los SKILL.md del proyecto del cwd y del usuario; los built-ins del CLI no
// tienen archivo y quedan sin descripción.
function enrichSlashCommands(cwd, names) {
  return (Array.isArray(names) ? names : []).slice(0, 200).map((n) => {
    const name = String(n).slice(0, 80);
    let description = null;
    if (SKILL_NAME_RE.test(name)) {
      for (const base of [path.join(cwd, '.claude', 'skills'), path.join(os.homedir(), '.claude', 'skills')]) {
        description = skillDescription(path.join(base, name, 'SKILL.md'));
        if (description) break;
      }
    }
    return { name, description };
  });
}

// ===== Adopción TUI(tmux) -> Chat =====
// Comando en primer plano del pane de una sesión tmux nuestra.
function paneCommand(tmuxName) {
  return new Promise((resolve) => {
    execFile('tmux', tmuxArgs('display-message', '-p', '-t', tmuxName, '#{pane_current_command}'),
      { timeout: 5000 }, (err, out) => resolve(err ? null : (out || '').trim()));
  });
}
const SHELL_RE = /^(bash|zsh|sh|fish|dash)$/;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Reconstruye eventos de UI desde el transcript de una sesión (para que al
// RETOMAR se vea la conversación anterior). Dedup por message.id/uuid: cada
// mensaje aparece repetido en el jsonl (misma lección que el módulo tokens).
// `untilMs`: corte superior (excluyente) por timestamp de línea — se usa al
// reconectar con un runner vivo: lo anterior a su arranque sale del
// transcript, lo posterior lo aporta el runner (sin duplicados).
function loadTranscriptEvents(cwd, sessionId, untilMs = null) {
  const file = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
  let txt;
  try { txt = fss.readFileSync(file, 'utf8'); } catch { return []; }
  const seen = new Set();
  const events = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o.message;
    if (!msg) continue;
    if (untilMs && o.timestamp) {
      const ts = Date.parse(o.timestamp);
      if (Number.isFinite(ts) && ts >= untilMs) continue;
    }
    // Dedup: el mismo msg.id aparece en VARIAS líneas con distinto contenido
    // (p.ej. una con thinking y otra con text), y además cada mensaje se
    // repite entero. Clave = id + firma del contenido.
    const sig = Array.isArray(msg.content)
      ? msg.content.map((b) => `${b.type}:${(b.text || b.id || '').length}`).join(',')
      : typeof msg.content === 'string' ? `s:${msg.content.length}` : '';
    const dedupKey = msg.id ? `${msg.id}|${sig}` : o.uuid;
    if (dedupKey) {
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
    }
    if (o.type === 'user' && msg.role === 'user') {
      const c = msg.content;
      if (typeof c === 'string') {
        if (c.trim()) events.push({ type: 'user', text: c });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text?.trim()) events.push({ type: 'user', text: b.text });
          if (b.type === 'tool_result') {
            events.push({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, output: trim(resultText(b.content), 2000) });
          }
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) events.push({ type: 'assistant', text: b.text });
        if (b.type === 'tool_use') {
          events.push({ type: 'tool_use', id: b.id, name: b.name, summary: toolSummary(b.name, b.input), detail: toolDetail(b.name, b.input) });
        }
      }
    }
  }
  return events.slice(-400);
}

class Chat {
  constructor({ id, cwd, model, permissionMode, resume = null, title = null, ticket = null }) {
    this.id = id;
    this.cwd = cwd;
    this.model = model || null;
    this.permissionMode = permissionMode || 'default';
    this.title = (title && String(title).slice(0, 60)) || path.basename(cwd) || '~';
    this.ticket = ticket; // {number, url} si nació de un bug de Desk (registro al cerrar)
    this.resume = resume;
    this.sessionId = resume || null;
    this.alive = false;       // motor (runner) conectado y corriendo
    this.closed = false;      // conversación terminada de verdad (cerrada por el usuario)
    this.viewMode = 'chat';   // chat | switching | tui
    this.terminalId = null;   // id de la sesión TUI (tmux oculta) cuando viewMode==='tui'
    this.status = 'waiting'; // waiting | working
    this.lastActivity = Date.now();
    this.history = [];       // eventos de UI para replay al re-adjuntar
    this.slashCommands = []; // comandos slash del init del SDK (depende del cwd)
    this.clients = new Set();
    this.link = null;        // RunnerLink al runner (motor desacoplado)
    this._engineP = null;     // promesa del arranque en curso (dedup)
    this._engineStopping = false; // cierre esperado (traspaso/sueño pedido): no anunciar 'closed'
    this._engineWaiters = [];     // callbacks al morir el motor (traspaso a TUI)
    this._downAnnounced = true;   // ya anunciamos la muerte de la vida actual del motor
    // Motor Pac-Man — estado "delegando" (2026-07-05): ids de tool_use Task/
    // Agent aún sin su tool_result. >0 ⇒ está esperando la vuelta de un
    // subagente, visible en /api/chat/list como `delegating` sin necesitar
    // la pestaña del chat abierta (antes esto solo vivía en el frontend,
    // como ícono de tool call, invisible para la tarjeta de Sesiones).
    this._delegatingIds = new Set();
  }

  start() {
    // Al retomar: el SDK restaura el contexto; la UI muestra lo anterior
    // reconstruyéndolo desde el transcript.
    if (this.resume) this.history = loadTranscriptEvents(this.cwd, this.resume);
    this._ensureEngine();
    return this;
  }

  // Garantiza UN runner corriendo y conectado (dedup de arranques en paralelo).
  _ensureEngine() {
    if (this.link) return Promise.resolve(true);
    if (!this._engineP) {
      this._engineP = this._startEngine().finally(() => { this._engineP = null; });
    }
    return this._engineP;
  }

  // Lanza el runner (proceso independiente) y se conecta. Si ya había un
  // runner vivo para este id (p.ej. carrera), el nuevo proceso se suicida y
  // acá simplemente nos conectamos al que quedó.
  async _startEngine() {
    const resumeId = this.sessionId || this.resume;
    try {
      spawnRunner({
        id: this.id, cwd: this.cwd, model: this.model,
        mode: this.permissionMode, resume: resumeId,
      });
    } catch (err) {
      this._push({ type: 'error', message: `No pude lanzar el motor: ${String(err?.message || err).slice(0, 200)}` });
      return false;
    }
    const link = await connectRunner(this.id);
    if (!link) {
      this._push({ type: 'error', message: 'El motor de chat no arrancó (mirá ~/.cwc-data/chats/*.log).' });
      return false;
    }
    this._adoptLink(link);
    return true;
  }

  // Cablea un link (recién lanzado o reconectado tras un reinicio del server).
  _adoptLink(link) {
    this.link = link;
    this.alive = true;
    this._engineStopping = false;
    this._downAnnounced = false;
    link.onEvent = (e) => this._onRunnerEvent(e);
    link.onClose = () => {
      if (this.link !== link) return;
      this.link = null;
      // Si el runner murió sin mandar 'closed' (kill duro), anunciamos acá.
      this._engineDown(!this.closed && !!this.sessionId);
    };
  }

  _onRunnerEvent(e) {
    this.lastActivity = Date.now();
    switch (e.type) {
      case 'init': {
        const hadSession = !!this.sessionId;
        this.sessionId = e.sessionId || this.sessionId;
        if (!hadSession && this.sessionId) this.onUpdate?.(); // recién ahora es persistible
        this._push({ ...e, chatId: this.id }, { record: false });
        return;
      }
      case 'delta':
        this._broadcast(e); // deltas NO van al history
        return;
      case 'meta':
        // Comandos slash disponibles (Fase 8). El runner manda nombres crudos;
        // acá se enriquecen con descripciones y se cachean por cwd. No va al
        // history: los clientes nuevos lo reciben en el payload del attach.
        this.slashCommands = enrichSlashCommands(this.cwd, e.slashCommands);
        cacheSlash(this.cwd, this.slashCommands);
        this._broadcast({ type: 'meta', slashCommands: this.slashCommands });
        return;
      case 'status':
        this._setStatus(e.state);
        return;
      case 'mode':
        this.permissionMode = e.mode;
        this._push(e);
        this.onUpdate?.(); // persistir el modo de permisos confirmado por el runner
        return;
      case 'model':
        this.model = e.model;
        this._push(e);
        this.onUpdate?.(); // persistir el modelo confirmado por el runner
        return;
      case 'result': {
        const hadSession = !!this.sessionId;
        this.sessionId = e.sessionId || this.sessionId;
        if (!hadSession && this.sessionId) this.onUpdate?.();
        this._setStatus('waiting');
        this._push(e);
        return;
      }
      case 'closed':
        this._engineDown(e.resumable);
        return;
      default:
        // assistant / tool_use / tool_result / permission_* / error / user
        // permission_request: sellar la hora de llegada si el runner no la
        // trajo (runners viejos, pre-deploy) — el centro global de permisos
        // la usa para la cuenta regresiva de expiración (PERMISSION_TIMEOUT_MS).
        if (e.type === 'permission_request' && !e.ts) e.ts = Date.now();
        // Estado "delegando" (ver PAC_STATES en ui/pacman.js): un tool_use
        // Task/Agent abre la espera de un subagente; su tool_result la cierra
        // (mismo patrón de matching que TOOL_TYPE_ICONS del frontend, acá
        // server-side para que /api/chat/list lo vea sin la pestaña abierta).
        if (e.type === 'tool_use' && /^(Task|Agent)/i.test(e.name || '')) {
          this._delegatingIds.add(e.id);
        } else if (e.type === 'tool_result' && this._delegatingIds.has(e.id)) {
          this._delegatingIds.delete(e.id);
        }
        this._push(e);
    }
  }

  // Permisos PENDIENTES derivados del history (request sin su closed): cero
  // estado duplicado — sobrevive reinicios del server porque la reconexión a
  // un runner sobreviviente (rehydrate) reconstruye el history con los eventos
  // permission_* de la vida del runner (hello.events). Solo con motor VIVO:
  // muerto, el runner ya resolvió todo como deny (y _engineDown los cierra).
  _unmatchedPerms() {
    const closed = new Set();
    for (const e of this.history) {
      if (e.type === 'permission_closed' && e.id) closed.add(e.id);
    }
    const out = [];
    for (const e of this.history) {
      if (e.type === 'permission_request' && e.id && !closed.has(e.id)) out.push(e);
    }
    return out;
  }

  pendingPerms() {
    if (!this.alive || this.closed) return [];
    return this._unmatchedPerms().map((e) => ({
      id: e.id,
      tool: String(e.tool || '').slice(0, 200),
      summary: String(e.summary || '').slice(0, 400),
      detail: e.detail || null,
      ts: e.ts || null,
      expiresAt: e.ts ? e.ts + PERMISSION_TIMEOUT_MS : null,
    }));
  }

  // El motor murió (evento 'closed' del runner, o socket cortado sin aviso).
  _engineDown(resumable) {
    if (this._downAnnounced) return;
    this._downAnnounced = true;
    this.alive = false;
    // Permisos que quedaron abiertos: el runner ya los resolvió como deny al
    // salir, pero sin emitir permission_closed por cada uno. Cerrarlos acá
    // (sintético) para que el history quede apareado — sin esto, una vida
    // futura del motor los "resucitaría" en pendingPerms() y la tarjeta
    // inline del chat quedaría clickeable para siempre.
    for (const e of this._unmatchedPerms()) {
      this._push({ type: 'permission_closed', id: e.id, allow: false, reason: 'engine_down' });
    }
    const waiters = this._engineWaiters;
    this._engineWaiters = [];
    for (const w of waiters) { try { w(); } catch { /* noop */ } }
    if (!this._engineStopping) {
      this._setStatus('waiting');
      // resumable: el motor murió (sueño, crash) pero la conversación NO — el
      // próximo mensaje la revive con resume.
      this._push({ type: 'closed', resumable: !!resumable && !this.closed && !!this.sessionId }, { record: false });
    }
  }

  // Duerme el motor por inactividad: el runner sale limpio SIN cerrar la
  // conversación. (El runner además se auto-duerme aunque el server no esté.)
  sleep() {
    if (!this.alive || this.viewMode !== 'chat') return;
    this.link?.send({ t: 'sleep' });
  }

  // Espera a que el motor muera; true si murió, false si timeout.
  _waitEngineDown(timeoutMs) {
    if (!this.alive) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this._engineWaiters.push(() => finish(true));
    });
  }

  // ===== Traspaso Chat <-> TUI (regla dura: nunca ambos a la vez) =====
  async switchMode(target) {
    if (target === this.viewMode) return { ok: true, viewMode: this.viewMode, terminalId: this.terminalId };
    if (this.viewMode === 'switching') return { ok: false, error: 'Hay un cambio de modo en curso.' };
    if (target === 'tui') return this._toTui();
    if (target === 'chat') return this._toChat();
    return { ok: false, error: 'Modo inválido.' };
  }

  async _toTui() {
    if (!this.sessionId) {
      return { ok: false, error: 'La conversación aún no tiene sesión: enviá un mensaje antes de pasar a TUI.' };
    }
    this.viewMode = 'switching';
    this._broadcast({ type: 'viewmode', viewMode: 'switching' });
    // 1. Dormir el motor (runner sale con resume disponible) y ESPERAR su
    //    muerte verificada. 'sleep' y no 'close': la conversación sigue viva.
    this._engineStopping = true;
    this.link?.send({ t: 'sleep' });
    const died = await this._waitEngineDown(SWITCH_CLOSE_MS);
    if (!died) {
      // No pudimos cerrar el chat: NO abrimos la TUI (nunca ambos activos).
      this.viewMode = 'chat';
      this._engineStopping = false;
      this._broadcast({ type: 'viewmode', viewMode: 'chat', error: 'No se pudo cerrar el chat; sigue en modo Chat.' });
      return { ok: false, error: 'No se pudo cerrar el motor de chat a tiempo.' };
    }
    // 2. Abrir la TUI (tmux oculta cwct-) retomando la MISMA sesión.
    const term = sessionManager.createBare({
      cwd: this.cwd,
      command: { file: 'claude', args: ['--resume', this.sessionId] },
      title: this.title,
    });
    this.terminalId = term.id;
    this.viewMode = 'tui';
    this._broadcast({ type: 'viewmode', viewMode: 'tui', terminalId: this.terminalId });
    return { ok: true, viewMode: 'tui', terminalId: this.terminalId };
  }

  async _toChat() {
    this.viewMode = 'switching';
    this._broadcast({ type: 'viewmode', viewMode: 'switching' });
    const term = this.terminalId ? sessionManager.get(this.terminalId) : null;
    if (term && term.alive) {
      // Salir de `claude` limpio: Ctrl-C x2. Esperamos la salida verificada.
      term.write('\x03');
      term.write('\x03');
      let exited = await term.waitForExit(SWITCH_CTRLC_MS);
      if (!exited) { term.kill(); exited = await term.waitForExit(SWITCH_KILL_MS); }
      if (!exited) {
        // No pudimos cerrar la TUI: NO abrimos el chat (nunca ambos activos).
        this.viewMode = 'tui';
        this._broadcast({ type: 'viewmode', viewMode: 'tui', terminalId: this.terminalId, error: 'No se pudo cerrar la TUI; sigue en modo Terminal.' });
        return { ok: false, error: 'No se pudo cerrar la sesión TUI a tiempo.' };
      }
    }
    if (this.terminalId) { sessionManager.remove(this.terminalId); this.terminalId = null; }
    // Recargar la conversación desde el transcript (la TUI pudo agregar turnos)
    // y reabrir el motor sobre la misma sesión.
    if (this.sessionId) this.history = loadTranscriptEvents(this.cwd, this.sessionId);
    this.viewMode = 'chat';
    await this._ensureEngine();
    // Reenviar el history recargado + anunciar el nuevo modo.
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'history', events: this.history, mode: this.permissionMode, status: this.status, slashCommands: this._slashList() }));
      }
    }
    this._broadcast({ type: 'viewmode', viewMode: 'chat' });
    return { ok: true, viewMode: 'chat' };
  }

  answerPermission(id, allow) {
    this.link?.send({ t: 'perm', id, allow: !!allow });
  }

  sendUser(text) {
    if (this.closed) return;
    if (!this.alive && this.viewMode !== 'chat') return;
    this.lastActivity = Date.now();
    this._setStatus('working');
    this._push({ type: 'user', text });
    this._autoTitle(text); // en paralelo: renombra la tarjeta según el pedido
    // Motor dormido (o caído): revivirlo con resume sobre la MISMA sesión.
    this._ensureEngine().then((ok) => {
      if (ok !== false) this.link?.send({ t: 'user', text });
    });
  }

  // Auto-título (ver extractTitle arriba). Fire-and-forget: nunca bloquea ni
  // rompe el turno; si falla, simplemente queda el título anterior.
  _autoTitle(text) {
    const t = String(text || '').trim();
    if (t.startsWith('/') || t.length < 15) return; // comandos y "ok, dale" no re-titulan
    if (this.ticket) return; // bugfixes: título curado ("PR en progreso · TKT #n"), no pisarlo
    if (this._titleBusy) return;
    if (Date.now() - (this._titleAt || 0) < AUTOTITLE_MIN_INTERVAL_MS) return;
    this._titleBusy = true;
    this._titleAt = Date.now();
    extractTitle({ cwd: this.cwd, current: this.title, text: t })
      .then((title) => {
        if (!title || this.closed || title === this.title) return;
        this.title = title;
        this.onUpdate?.(); // persiste vía el manager (mismo camino que el resto)
      })
      .catch(() => { /* mejor conservar el título viejo que molestar el turno */ })
      .finally(() => { this._titleBusy = false; });
  }

  interrupt() {
    this.link?.send({ t: 'interrupt' });
    this._setStatus('waiting');
  }

  setMode(mode) {
    if (!PERMISSION_MODES.has(mode)) return;
    if (this.link) {
      // El cambio real lo confirma el runner con su evento 'mode'.
      this.link.send({ t: 'set_mode', mode });
    } else {
      // Motor dormido: queda para el próximo arranque (--mode).
      this.permissionMode = mode;
      this._push({ type: 'mode', mode });
      this.onUpdate?.(); // persistir el nuevo modo elegido (simetría con setModel)
    }
  }

  // Cambia el MODELO de la conversación. Con motor vivo usa q.setModel() del
  // SDK (en vivo, sin perder contexto); dormido, solo actualiza this.model
  // (_startEngine ya lo lee para el próximo spawnRunner).
  setModel(model) {
    if (!VALID_MODELS.has(model)) return;
    if (this.link) {
      // El cambio real lo confirma el runner con su evento 'model'.
      this.link.send({ t: 'set_model', model });
    } else {
      this.model = model;
      this._push({ type: 'model', model });
      this.onUpdate?.(); // persistir el nuevo modelo elegido
    }
  }

  close() {
    this.closed = true;
    // Conversación de un ticket: al finalizar queda el registro de qué hay que
    // cambiar en el código (resumen + archivos) para el PR posterior a Chris
    // (pestaña Salud). DIFERIDO 2s: el SDK puede tardar en flushear las últimas
    // líneas del transcript (verificado E2E: extraer en el instante del close
    // pierde el resumen). Best-effort: si el server muere en esa ventana, el
    // scan de la pestaña Salud lo recupera/completa.
    if (this.ticket && this.sessionId) {
      const args = { cwd: this.cwd, sessionId: this.sessionId, chatId: this.id, ticket: this.ticket, title: this.title };
      setTimeout(() => {
        try {
          const entry = recordBugfix(args);
          if (entry) console.log(`[chat] bugfix registrado: TKT #${entry.ticketNumber} (${entry.files.length} archivo(s))`);
        } catch (err) { console.error('[chat] registro de bugfix falló:', err?.message); }
      }, 2000).unref();
    }
    // Si estaba en TUI, matar la tmux oculta para no dejar el claude huérfano.
    if (this.terminalId) {
      const t = sessionManager.get(this.terminalId);
      if (t) t.kill();
      sessionManager.remove(this.terminalId);
      this.terminalId = null;
    }
    this._engineStopping = true;
    this.link?.send({ t: 'close' });
    this.alive = false;
  }

  _setStatus(state) {
    // Invariante: 'delegando' solo tiene sentido con el motor 'working'. Al
    // volver a 'waiting' (turno terminado, interrumpido, o motor caído a
    // mitad de un Task) se limpia SIEMPRE — evita que un tool_result perdido
    // (interrupt, crash) deje la tarjeta pegada en "delegando" para siempre.
    if (state === 'waiting') this._delegatingIds.clear();
    if (this.status === state) return;
    this.status = state;
    this._broadcast({ type: 'status', state });
  }

  _push(event, { broadcast = true, record = true } = {}) {
    if (record) {
      this.history.push(event);
      if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    }
    if (broadcast) this._broadcast(event);
  }

  _broadcast(event) {
    const frame = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  }

  // Lista propia si el init ya llegó; si no, la caché del cwd (otro chat en la
  // misma carpeta ya la pobló). Vacía = el front muestra "cargando comandos…".
  _slashList() {
    return this.slashCommands.length ? this.slashCommands : (slashByCwd.get(this.cwd) || []);
  }

  attach(ws) {
    this.lastActivity = Date.now(); // abrir la vista cuenta como actividad
    this.clients.add(ws);
    ws.send(JSON.stringify({
      type: 'history', events: this.history, mode: this.permissionMode, status: this.status,
      viewMode: this.viewMode, terminalId: this.terminalId, slashCommands: this._slashList(),
    }));
  }

  detach(ws) { this.clients.delete(ws); }

  info() {
    return {
      id: this.id, title: this.title, cwd: this.cwd, model: this.model,
      mode: this.permissionMode, status: this.status, alive: this.alive,
      sessionId: this.sessionId, viewMode: this.viewMode, terminalId: this.terminalId,
      // Motor Pac-Man: ¿hay un subagente Task corriendo ahora mismo? (ver
      // ui/pacman.js, estado 'delegating') — visible en /api/chat/list aunque
      // la pestaña del chat esté cerrada.
      delegating: this._delegatingIds.size > 0,
      // Permisos esperando respuesta: los consume el centro global de popups
      // (public/js/ui/perm-center.js) vía el poll de 8 s de /list.
      pendingPerms: this.pendingPerms(),
    };
  }
}

class ChatManager {
  constructor() {
    this.chats = new Map();
    this._seq = 0;
    setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const [id, c] of this.chats) {
        // Inactiva => DORMIR el motor (el runner también se auto-duerme solo;
        // esto lo apura si el server sí está). Una TUI viva se respeta.
        if (c.viewMode === 'chat' && c.alive && now - c.lastActivity > SLEEP_MS) c.sleep();
        // Cerradas explícitamente: se descartan a los 90 min.
        if (c.closed && now - c.lastActivity > SLEEP_MS * 2) { this.chats.delete(id); dirty = true; }
        // Dormidas sin uso 24 h: recién ahí se descarta la tarjeta (la
        // conversación sigue retomable desde el lanzador vía transcript).
        if (!c.closed && !c.alive && c.viewMode === 'chat' && now - c.lastActivity > FORGET_MS) {
          c.close();
          this.chats.delete(id);
          dirty = true;
        }
      }
      if (dirty) this.persist();
    }, 60 * 1000).unref();
  }

  create({ cwd, model, permissionMode, resume = null, title = null, ticket = null }) {
    const id = `c${process.pid}-${++this._seq}`;
    // Freshness on-demand del inventario (Fase 3 del sistema nervioso): si el
    // chat es sobre la CONSOLA, regenerá el CENSO VIVO (~/.cwc-data/inventory.md)
    // para que cuando el chat lo consulte (guiado por CLAUDE.md) esté fresco.
    // Barato (solo re-parsea si cambió algo) y a prueba de fallos.
    try { if (path.resolve(cwd) === path.resolve(CONSOLE_ROOT)) generateInventory(); } catch { /* nunca bloquea la creación */ }
    // Nombre ÚNICO de tarjeta (cruzado con las sesiones tmux, vía el registro
    // de core/session-names.js): "tolkien" → "tolkien 1" si ya hay otra
    // sesión con ese nombre. Solo en creaciones nuevas — rehydrate() usa
    // `new Chat` directo y respeta los títulos ya persistidos.
    const base = (title && String(title).trim().slice(0, 60)) || path.basename(cwd) || '~';
    const chat = new Chat({ id, cwd, model, permissionMode, resume, title: uniqueName(base), ticket });
    chat.onUpdate = () => this.persist();
    chat.start();
    this.chats.set(id, chat);
    this.persist();
    return chat;
  }

  // ===== Persistencia: las conversaciones sobreviven reinicios del server =====
  persist() {
    // Registro durable append-only: TODOS los chats del map (incluidos los
    // cerrados aún no cosechados) — persist() corre en cada onUpdate, así que
    // captura el sessionId apenas existe (init/result/create con resume).
    registerChatSessionIds([...this.chats.values()].map((c) => c.sessionId).filter(Boolean));
    const open = [...this.chats.values()]
      .filter((c) => !c.closed && c.sessionId)
      .map((c) => ({
        id: c.id, cwd: c.cwd, model: c.model, permissionMode: c.permissionMode,
        sessionId: c.sessionId, title: c.title, lastActivity: c.lastActivity,
        ticket: c.ticket || null,
        // Modo TUI: la tmux oculta (cwct-) sobrevive reinicios del server, así
        // que persistimos lo necesario para RE-ADJUNTARLA al rehidratar.
        viewMode: c.viewMode === 'tui' ? 'tui' : 'chat',
        terminalId: c.viewMode === 'tui' ? c.terminalId : null,
      }));
    try {
      fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fss.writeFileSync(CHATS_FILE, JSON.stringify(open), { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  // Al arrancar: reconstruye las conversaciones guardadas. El motor pudo
  // SOBREVIVIR al server (runner desacoplado): si su socket contesta nos
  // RECONECTAMOS con historial mixto transcript(hasta que arrancó el runner) +
  // vida del runner. Si no contesta, queda DORMIDA (el próximo mensaje la
  // revive con resume). Una TUI previa (tmux cwct- viva) se re-adjunta.
  async rehydrate() {
    let saved = [];
    try { saved = JSON.parse(fss.readFileSync(CHATS_FILE, 'utf8')); } catch { saved = []; }
    // Registrar también lo rehidratado: cubre chats persistidos ANTES de que
    // existiera el registro durable (aunque nunca vuelvan a disparar persist).
    registerChatSessionIds(saved.map((s) => s?.sessionId).filter(Boolean));
    let count = 0;
    for (const s of saved) {
      if (!s?.sessionId || !UUID_RE.test(s.sessionId) || this.chats.has(s.id)) continue;
      const chat = new Chat({
        id: s.id, cwd: safeCwd(s.cwd), model: s.model || null,
        permissionMode: PERMISSION_MODES.has(s.permissionMode) ? s.permissionMode : 'default',
        resume: s.sessionId,
      });
      chat.onUpdate = () => this.persist();
      if (s.title) chat.title = String(s.title).slice(0, 60); // respeta renombres
      if (s.ticket?.number) chat.ticket = { number: String(s.ticket.number).slice(0, 40), url: s.ticket.url || null };
      chat.lastActivity = s.lastActivity || Date.now();
      if (s.viewMode === 'tui' && s.terminalId && bareTmuxAlive(s.terminalId)) {
        // La TUI sigue corriendo en su tmux oculta: re-adjuntar (new-session -A).
        const term = sessionManager.createBare({
          id: s.terminalId,
          cwd: chat.cwd,
          command: { file: 'claude', args: ['--resume', s.sessionId] },
          title: chat.title,
        });
        chat.terminalId = term.id;
        chat.viewMode = 'tui';
        chat.history = loadTranscriptEvents(chat.cwd, s.sessionId);
      } else {
        // ¿El runner sobrevivió? (crash del server con turno en curso)
        const link = await tryConnectRunner(chat.id);
        const hello = link ? await link.hello() : null;
        if (link && hello) {
          chat.sessionId = (UUID_RE.test(hello.sessionId || '') && hello.sessionId) || chat.sessionId;
          if (PERMISSION_MODES.has(hello.mode)) chat.permissionMode = hello.mode;
          const base = loadTranscriptEvents(chat.cwd, chat.sessionId, hello.startedAt || null);
          chat.history = [...base, ...(hello.events || [])].slice(-HISTORY_MAX);
          chat.status = hello.status === 'working' ? 'working' : 'waiting';
          if (Array.isArray(hello.slashCommands) && hello.slashCommands.length) {
            chat.slashCommands = enrichSlashCommands(chat.cwd, hello.slashCommands);
            cacheSlash(chat.cwd, chat.slashCommands);
          }
          chat._adoptLink(link);
          console.log(`[chat] runner de ${chat.id} seguía vivo: reconectado (${hello.status})`);
        } else {
          link?.close();
          chat.history = loadTranscriptEvents(chat.cwd, s.sessionId); // dormida
        }
      }
      this.chats.set(s.id, chat);
      count += 1;
    }
    this._cleanupOrphans();
    return count;
  }

  // Motores/TUIs sin conversación dueña (p.ej. la tarjeta se descartó mientras
  // el server no corría): cerrarlos para no dejar procesos huérfanos.
  async _cleanupOrphans() {
    const ownedTerms = new Set([...this.chats.values()].map((c) => c.terminalId).filter(Boolean));
    for (const tid of listBareTmuxIds()) {
      if (!ownedTerms.has(tid)) killBareTmux(tid);
    }
    let socks = [];
    try { socks = fss.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.sock')); } catch { return; }
    for (const f of socks) {
      const id = f.slice(0, -'.sock'.length);
      if (this.chats.has(id)) continue;
      const link = await tryConnectRunner(id);
      if (link) {
        console.log(`[chat] runner huérfano ${id}: cerrando`);
        link.send({ t: 'close' });
        setTimeout(() => link.close(), 2000).unref?.();
      } else {
        try { fss.unlinkSync(path.join(CHATS_DIR, f)); } catch { /* noop */ }
      }
    }
  }

  liveSessionIds() {
    // Una conversación en TUI (alive=false) también "ocupa" su sesión: no debe
    // ofrecerse para retomar en el lanzador.
    return new Set([...this.chats.values()].filter((c) => !c.closed && c.sessionId).map((c) => c.sessionId));
  }

  get(id) { return this.chats.get(id); }
  list() { return [...this.chats.values()].filter((c) => !c.closed).map((c) => c.info()); }
}

const manager = new ChatManager();

// Proveedor de nombres para el uniquificador (core/session-names.js): los
// títulos de las conversaciones ABIERTAS (los cerrados liberan su nombre).
registerNameProvider(() => [...manager.chats.values()].filter((c) => !c.closed).map((c) => c.title));

export default {
  name: 'chat',

  init() {
    manager.rehydrate().then((n) => {
      if (n) console.log(`[chat] ${n} conversación(es) rehidratada(s)`);
    }).catch((err) => console.error('[chat] rehidratación falló:', err));
  },

  registerHttp(router) {
    const r = express.Router();

    r.post('/create', (req, res) => {
      const { cwd, model, permissionMode, resume, title, ticket } = req.body || {};
      if (model != null && !VALID_MODELS.has(model)) {
        return res.status(400).json({ error: 'Modelo inválido.' });
      }
      if (permissionMode != null && !PERMISSION_MODES.has(permissionMode)) {
        return res.status(400).json({ error: 'Modo de permisos inválido.' });
      }
      if (resume != null && !UUID_RE.test(resume)) {
        return res.status(400).json({ error: 'Sesión a retomar inválida.' });
      }
      const chat = manager.create({
        cwd: safeCwd(cwd),
        model: model || null,
        permissionMode: permissionMode || 'default',
        resume: resume || null,
        title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : null,
        // Vínculo al bug de Desk: al cerrar la conversación deja el registro
        // del fix propuesto (módulo bugfixes).
        ticket: ticket?.number
          ? { number: String(ticket.number).slice(0, 40), url: /^https?:\/\//.test(ticket.url || '') ? String(ticket.url).slice(0, 400) : null }
          : null,
      });
      res.json({ chat: chat.info() });
    });

    r.get('/list', (req, res) => res.json({ chats: manager.list() }));

    // Conversaciones PASADAS de una carpeta (para "Retomar" del lanzador:
    // muestra 2 y el resto vive en el modal "Ver más", hasta 10 en total).
    r.get('/history', (req, res) => {
      const cwdAbs = safeCwd(req.query.cwd || '');
      const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwdAbs));
      let files = [];
      try {
        files = fss.readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ f, mtime: fss.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 25);
      } catch { return res.json({ conversations: [] }); }

      const live = manager.liveSessionIds();
      const out = [];
      for (const { f, mtime } of files) {
        const sessionId = f.replace(/\.jsonl$/, '');
        if (!UUID_RE.test(sessionId) || live.has(sessionId)) continue;
        // Snippet: primer mensaje de texto del usuario (primeras ~200 líneas).
        let snippet = '';
        try {
          const lines = fss.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, 200);
          for (const line of lines) {
            let o;
            try { o = JSON.parse(line); } catch { continue; }
            if (o.type !== 'user' || o.message?.role !== 'user') continue;
            const c = o.message.content;
            const text = typeof c === 'string' ? c
              : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text || '') : '';
            if (text.trim() && !text.startsWith('<')) { snippet = text.trim().slice(0, 90); break; }
          }
        } catch { /* noop */ }
        if (snippet) out.push({ sessionId, ts: mtime, snippet });
        if (out.length >= 10) break;
      }
      res.json({ conversations: out });
    });

    // Responder un permiso pendiente SIN WS adjunto (centro global de popups:
    // aprobar/denegar desde cualquier pantalla). Mismo camino que el WS
    // (answerPermission → runner 'perm'); el runner ignora ids ya resueltos.
    r.post('/permission', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const permId = String(req.body?.permId || '');
      if (!/^p\d{1,10}$/.test(permId)) return res.status(400).json({ error: 'Permiso inválido.' });
      if (!chat.alive) return res.status(409).json({ error: 'El motor de esa conversación no está corriendo.' });
      if (!chat.pendingPerms().some((p) => p.id === permId)) {
        return res.status(409).json({ error: 'Ese permiso ya no está pendiente (respondido o expirado).' });
      }
      chat.answerPermission(permId, !!req.body?.allow);
      res.json({ ok: true });
    });

    r.post('/close', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      chat.close();
      manager.persist();
      res.json({ ok: true });
    });

    // Adopta una sesión de Claude que corre en una TERMINAL tmux nuestra y la
    // convierte en conversación Chat (mismo transcript, vía session_id del
    // observador). Cierre secuencial y VERIFICADO: Ctrl-C x2 y se espera a que
    // el pane vuelva al shell; si no vuelve, error y NO se abre el chat.
    r.post('/adopt', async (req, res) => {
      const term = sessionManager.get(String(req.body?.terminalId || ''));
      if (!term || !term.alive || term.bare) {
        return res.status(404).json({ error: 'Sesión de terminal inexistente.' });
      }
      const sessionId = sessionIdForCwd(term.cwd);
      if (!sessionId || !UUID_RE.test(sessionId)) {
        return res.status(409).json({ error: 'No detecto una sesión de Claude activa en esa carpeta (el observador no reporta).' });
      }
      if (manager.liveSessionIds().has(sessionId)) {
        return res.status(409).json({ error: 'Esa sesión ya tiene una conversación abierta.' });
      }
      // Salir de claude en el pane: Ctrl-C x2, esperar a que vuelva el shell.
      const initial = await paneCommand(term.tmuxName);
      term.write('\x03');
      term.write('\x03');
      let backToShell = false;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await sleepMs(350);
        const cmd = await paneCommand(term.tmuxName);
        if (cmd && (SHELL_RE.test(cmd) || (initial && cmd !== initial && !/claude|node/.test(cmd)))) {
          backToShell = true;
          break;
        }
      }
      if (!backToShell) {
        return res.status(409).json({ error: 'No pude cerrar Claude en la terminal (sigue corriendo). No se abre el chat: cerralo a mano y reintentá.' });
      }
      // La TUI murió verificada: abrir la conversación sobre la MISMA sesión.
      const chat = manager.create({ cwd: term.cwd, model: null, permissionMode: 'default', resume: sessionId });
      res.json({ ok: true, chat: chat.info() });
    });

    // Renombrar conversación (para la tarjeta y la cabecera).
    r.post('/title', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const title = String(req.body?.title ?? '').trim().slice(0, 60);
      chat.title = title || path.basename(chat.cwd) || '~';
      manager.persist();
      res.json({ ok: true, chat: chat.info() });
    });

    // Traspaso Chat <-> TUI de UNA conversación (secuencial y verificado).
    r.post('/mode', async (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const target = req.body?.mode;
      if (target !== 'chat' && target !== 'tui') {
        return res.status(400).json({ error: 'Modo inválido (chat|tui).' });
      }
      let result;
      try {
        result = await chat.switchMode(target);
      } catch (err) {
        console.error('[chat] /mode falló:', err);
        return res.status(500).json({ error: 'No se pudo cambiar de modo (error interno).' });
      }
      if (!result.ok) return res.status(409).json({ error: result.error });
      manager.persist();
      res.json({ ok: true, chat: chat.info() });
    });

    // Cambia el modelo de una conversación (en vivo o para el próximo arranque).
    r.post('/model', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const model = req.body?.model;
      if (!VALID_MODELS.has(model)) return res.status(400).json({ error: 'Modelo inválido.' });
      chat.setModel(model);
      manager.persist();
      res.json({ ok: true, chat: chat.info() });
    });

    router.use('/chat', r);
  },

  registerWs(wss) {
    wss.route('/ws/chat', (ws, req, url) => {
      const chat = manager.get(url.searchParams.get('id'));
      if (!chat) {
        ws.send(JSON.stringify({ type: 'error', message: 'Conversación inexistente.' }));
        ws.close();
        return;
      }
      chat.attach(ws);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
          chat.sendUser(msg.text);
        } else if (msg.type === 'permission_response') {
          chat.answerPermission(msg.id, !!msg.allow);
        } else if (msg.type === 'interrupt') {
          chat.interrupt();
        } else if (msg.type === 'set_mode') {
          chat.setMode(msg.mode);
        } else if (msg.type === 'set_model') {
          chat.setModel(msg.model);
        }
      });
      ws.on('close', () => chat.detach(ws));
      ws.on('error', () => chat.detach(ws));
    });
  },
};
