// modules/chat/index.js — chat nativo con Claude vía Agent SDK (Fase 4a).
//
// Cada conversación = UNA query() del SDK en streaming input mode: un
// subproceso vivo que recibe mensajes del usuario por un generador async y
// emite eventos (deltas, tool calls, resultado con costo) que traducimos a
// JSON por WebSocket. Auth: hereda la suscripción del CLI (verificado por
// spike — sin API key, sin facturación aparte).
//
// HTTP:
//   POST /api/chat/create {cwd?, model?, permissionMode?} -> { chat }
//   GET  /api/chat/list                                   -> { chats }
//   POST /api/chat/close {id}
// WS  /ws/chat?id=<id>
//   c->s: {type:'user', text} · {type:'permission_response', id, allow}
//         {type:'interrupt'} · {type:'set_mode', mode}
//   s->c: {type:'history', events} · {type:'user', text} · {type:'delta', text}
//         {type:'tool_use', name, summary} · {type:'result', costUsd, usage, ms}
//         {type:'permission_request', id, tool, input} · {type:'status', state}
//         {type:'mode', mode} · {type:'error', message} · {type:'closed'}
import express from 'express';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../core/config.js';
import { VALID_MODELS, encodeCwd } from '../../core/claude-model.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // sin respuesta => denegar
const IDLE_CLOSE_MS = 45 * 60 * 1000;        // conversación inactiva => cerrar subproceso
const HISTORY_MAX = 600;

function safeCwd(requested) {
  if (!requested) return config.home;
  const resolved = path.resolve(config.home, String(requested));
  return resolved.startsWith(config.home) ? resolved : config.home;
}

// Cola de mensajes del usuario -> AsyncIterable para el streaming input mode.
function makeInput() {
  const queue = [];
  let notify = null;
  let done = false;
  return {
    push(msg) { queue.push(msg); notify?.(); },
    end() { done = true; notify?.(); },
    async *gen() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (done) return;
        await new Promise((r) => { notify = r; });
        notify = null;
      }
    },
  };
}

function toolSummary(name, input) {
  try {
    if (name === 'Bash') return String(input?.command || '').slice(0, 120);
    if (name === 'Read') return String(input?.file_path || '');
    if (name === 'Write' || name === 'Edit') return String(input?.file_path || '');
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch { return ''; }
}

// Detalle del input para la UI (diffs en Edit/Write, comando en Bash).
const trim = (s, n = 4000) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
function toolDetail(name, input) {
  try {
    if (name === 'Edit') return { file: input?.file_path, old: trim(input?.old_string), new: trim(input?.new_string) };
    if (name === 'Write') return { file: input?.file_path, new: trim(input?.content) };
    if (name === 'Bash') return { command: trim(input?.command, 1000) };
    return null;
  } catch { return null; }
}

// Texto plano del tool_result (string o bloques de texto).
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

// Reconstruye eventos de UI desde el transcript de una sesión (para que al
// RETOMAR se vea la conversación anterior). Dedup por message.id/uuid: cada
// mensaje aparece repetido en el jsonl (misma lección que el módulo tokens).
function loadTranscriptEvents(cwd, sessionId) {
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
  constructor({ id, cwd, model, permissionMode, resume = null }) {
    this.id = id;
    this.cwd = cwd;
    this.model = model || null;
    this.permissionMode = permissionMode || 'default';
    this.title = path.basename(cwd) || '~';
    this.resume = resume;
    this.sessionId = resume || null;
    this.alive = true;
    this.status = 'waiting'; // waiting | working
    this.lastActivity = Date.now();
    this.history = [];       // eventos de UI para replay al re-adjuntar
    this.clients = new Set();
    this.pendingPerms = new Map(); // permId -> { resolve, timer }
    this._permSeq = 0;
    this.input = makeInput();
  }

  start() {
    // Al retomar: el SDK restaura el contexto; la UI muestra lo anterior
    // reconstruyéndolo desde el transcript.
    if (this.resume) this.history = loadTranscriptEvents(this.cwd, this.resume);
    this.q = query({
      prompt: this.input.gen(),
      options: {
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.resume ? { resume: this.resume } : {}),
        permissionMode: this.permissionMode,
        includePartialMessages: true,
        canUseTool: (toolName, input, ctx) => this._askPermission(toolName, input, ctx),
      },
    });
    this._pump();
    return this;
  }

  async _pump() {
    try {
      for await (const m of this.q) this._onMessage(m);
    } catch (err) {
      this._push({ type: 'error', message: String(err?.message || err).slice(0, 400) });
    } finally {
      this.alive = false;
      this._setStatus('waiting');
      this._push({ type: 'closed' });
      // Denegar permisos colgados.
      for (const [, p] of this.pendingPerms) p.resolve({ behavior: 'deny', message: 'Conversación cerrada.' });
      this.pendingPerms.clear();
    }
  }

  _onMessage(m) {
    this.lastActivity = Date.now();
    if (m.type === 'system' && m.subtype === 'init') {
      this.sessionId = m.session_id || this.sessionId;
      this._push({ type: 'init', chatId: this.id, sessionId: this.sessionId, model: m.model || this.model, cwd: this.cwd, mode: this.permissionMode }, { record: false });
      return;
    }
    if (m.type === 'stream_event') {
      const ev = m.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        this._broadcast({ type: 'delta', text: ev.delta.text }); // deltas NO van al history
      }
      return;
    }
    if (m.type === 'assistant') {
      // Mensaje completo: el texto final TAMBIÉN va en vivo (el cliente
      // reemplaza la burbuja de streaming por la versión markdown).
      const blocks = m.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) this._push({ type: 'assistant', text: b.text });
        if (b.type === 'tool_use') {
          this._push({
            type: 'tool_use', id: b.id, name: b.name,
            summary: toolSummary(b.name, b.input),
            detail: toolDetail(b.name, b.input),
          });
        }
      }
      return;
    }
    if (m.type === 'user') {
      // Resultados de herramientas (los mensajes user del SDK traen tool_result).
      const blocks = m.message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            this._push({
              type: 'tool_result', id: b.tool_use_id,
              ok: !b.is_error,
              output: trim(resultText(b.content), 2000),
            });
          }
        }
      }
      return;
    }
    if (m.type === 'result') {
      this.sessionId = m.session_id || this.sessionId;
      this._setStatus('waiting');
      this._push({
        type: 'result',
        subtype: m.subtype,
        costUsd: m.total_cost_usd ?? null,
        usage: m.usage ? { input: m.usage.input_tokens, output: m.usage.output_tokens } : null,
        ms: m.duration_ms ?? null,
      });
    }
  }

  _askPermission(toolName, input, ctx) {
    return new Promise((resolve) => {
      const id = `p${++this._permSeq}`;
      const timer = setTimeout(() => {
        this.pendingPerms.delete(id);
        resolve({ behavior: 'deny', message: 'Sin respuesta del usuario (timeout).' });
        this._push({ type: 'permission_closed', id, allow: false, reason: 'timeout' });
      }, PERMISSION_TIMEOUT_MS);
      ctx?.signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        this.pendingPerms.delete(id);
        resolve({ behavior: 'deny', message: 'Cancelado.' });
      });
      this.pendingPerms.set(id, { resolve, timer, input });
      this._push({
        type: 'permission_request', id, tool: toolName,
        summary: toolSummary(toolName, input),
        detail: toolDetail(toolName, input),
      });
    });
  }

  answerPermission(id, allow) {
    const p = this.pendingPerms.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingPerms.delete(id);
    p.resolve(allow
      ? { behavior: 'allow', updatedInput: p.input }
      : { behavior: 'deny', message: 'Denegado por el usuario.' });
    this._push({ type: 'permission_closed', id, allow });
  }

  sendUser(text) {
    if (!this.alive) return;
    this.lastActivity = Date.now();
    this._setStatus('working');
    this._push({ type: 'user', text });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    });
  }

  async interrupt() {
    try { await this.q?.interrupt?.(); } catch { /* noop */ }
    this._setStatus('waiting');
  }

  async setMode(mode) {
    if (!PERMISSION_MODES.has(mode)) return;
    try {
      await this.q?.setPermissionMode?.(mode);
      this.permissionMode = mode;
      this._push({ type: 'mode', mode });
    } catch { /* noop */ }
  }

  close() {
    this.input.end();
    try { this.q?.close?.(); } catch { /* noop */ }
    this.alive = false;
  }

  _setStatus(state) {
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

  attach(ws) {
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: 'history', events: this.history, mode: this.permissionMode, status: this.status }));
  }

  detach(ws) { this.clients.delete(ws); }

  info() {
    return {
      id: this.id, title: this.title, cwd: this.cwd, model: this.model,
      mode: this.permissionMode, status: this.status, alive: this.alive,
      sessionId: this.sessionId,
    };
  }
}

class ChatManager {
  constructor() {
    this.chats = new Map();
    this._seq = 0;
    // Cierre por inactividad: libera el subproceso (RAM) de chats olvidados.
    setInterval(() => {
      const now = Date.now();
      for (const [id, c] of this.chats) {
        if (c.alive && now - c.lastActivity > IDLE_CLOSE_MS) c.close();
        if (!c.alive && now - c.lastActivity > IDLE_CLOSE_MS * 2) this.chats.delete(id);
      }
    }, 60 * 1000).unref();
  }

  create({ cwd, model, permissionMode, resume = null }) {
    const id = `c${process.pid}-${++this._seq}`;
    const chat = new Chat({ id, cwd, model, permissionMode, resume }).start();
    this.chats.set(id, chat);
    return chat;
  }

  liveSessionIds() {
    return new Set([...this.chats.values()].filter((c) => c.alive && c.sessionId).map((c) => c.sessionId));
  }

  get(id) { return this.chats.get(id); }
  list() { return [...this.chats.values()].filter((c) => c.alive).map((c) => c.info()); }
}

const manager = new ChatManager();

export default {
  name: 'chat',

  registerHttp(router) {
    const r = express.Router();

    r.post('/create', (req, res) => {
      const { cwd, model, permissionMode, resume } = req.body || {};
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
      });
      res.json({ chat: chat.info() });
    });

    r.get('/list', (req, res) => res.json({ chats: manager.list() }));

    // Conversaciones PASADAS de una carpeta (para "Retomar" del lanzador).
    r.get('/history', (req, res) => {
      const cwdAbs = safeCwd(req.query.cwd || '');
      const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwdAbs));
      let files = [];
      try {
        files = fss.readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ f, mtime: fss.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 10);
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
        if (out.length >= 5) break;
      }
      res.json({ conversations: out });
    });

    r.post('/close', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      chat.close();
      res.json({ ok: true });
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
        }
      });
      ws.on('close', () => chat.detach(ws));
      ws.on('error', () => chat.detach(ws));
    });
  },
};
