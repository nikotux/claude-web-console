#!/usr/bin/env node
// bin/cwc-chat-runner.js — motor de UNA conversación de chat, DESACOPLADO del server.
//
// Corre la query() del Agent SDK en un proceso PROPIO (el server lo lanza
// detached/setsid): si el server web crashea o se reinicia, el turno en curso
// SIGUE — requisito duro del proyecto. El server habla con el runner por un
// socket Unix (~/.cwc-data/chats/<id>.sock) con JSON por línea:
//
//   server->runner: {t:'hello'} · {t:'user',text} · {t:'perm',id,allow}
//                   {t:'interrupt'} · {t:'set_mode',mode} · {t:'set_model',model}
//                   {t:'sleep'} · {t:'close'}
//   runner->server: {t:'hello', id, sessionId, model, mode, status, startedAt,
//                    slashCommands, events:[...historial de ESTA vida]} (respuesta)
//                   {t:'event', event:{...}}                          (en vivo)
//                   (evento nuevo Fase 8: {type:'meta', slashCommands:[...]}
//                    con la lista de comandos slash del system/init del SDK)
//
// Vida = una vida del motor: nace con spawn del server, se AUTO-DUERME a los
// 45 min sin actividad (sale limpio; el próximo mensaje lo relanza con resume)
// y muere al cerrar la conversación. Los permisos pendientes viven acá con su
// timeout de 5 min: sobreviven a un server caído y se responden al reconectar.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  PERMISSION_MODES, PERMISSION_TIMEOUT_MS, SLEEP_MS, HISTORY_MAX,
  trim, toolSummary, toolDetail, resultText, makeInput,
} from '../src/modules/chat/shared.js';
import { chatQueryOptions, autoApprovesAll } from '../src/core/tool-policy.js';

// ---- argv ----
const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}
const ID = args.id;
const CWD = args.cwd;
const SOCK = args.sock;
const MODEL = args.model || null;
let currentModel = MODEL; // puede cambiar en vivo (set_model) o al resolverse el init del SDK
let mode = PERMISSION_MODES.has(args.mode) ? args.mode : 'default';
const RESUME = args.resume || null;
if (!ID || !CWD || !SOCK) {
  console.error('[runner] uso: cwc-chat-runner --id <id> --cwd <abs> --sock <path> [--model m] [--mode m] [--resume uuid]');
  process.exit(2);
}
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// Marca heredable: el claude del SDK (y sus hooks, ahora que settingSources
// carga la config del usuario) corren con esta env. El observador
// (cwc-observe.js) la usa para NO escribir estado de sesiones de chat en
// ~/.cwc-state: ese estado es SOLO de TUIs (sessionIdForCwd alimenta el
// traspaso TUI->Chat y no debe ver la sesión del propio chat); el chat ya
// reporta su estado por el socket del runner.
process.env.CWC_CHAT_RUNNER = '1';

// ---- estado ----
const startedAt = Date.now();
let sessionId = RESUME;
let slashCommands = []; // lista del system/init (depende del cwd; Fase 8)
let status = 'waiting';
let lastActivity = Date.now();
let closedByUser = false;
let exiting = false;
const history = []; // eventos de UI de ESTA vida del motor (para replay al reconectar)
const clients = new Set();
const pendingPerms = new Map(); // permId -> { resolve, timer, input }
let permSeq = 0;

function writeTo(c, obj) {
  try { c.write(`${JSON.stringify(obj)}\n`); } catch { /* cliente roto */ }
}

// Evento de UI: se guarda en el historial (para el hello de una reconexión)
// y/o se emite en vivo a los servers conectados.
function emit(event, { record = true, broadcast = true } = {}) {
  if (record) {
    history.push(event);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  }
  if (broadcast) for (const c of clients) writeTo(c, { t: 'event', event });
}

function setStatus(state) {
  if (status === state) return;
  status = state;
  emit({ type: 'status', state }, { record: false });
}

// ---- motor (query del SDK) ----
// `q` se crea recién DESPUÉS de reclamar el socket (claimSocket): si ya hay
// otro runner vivo para esta conversación, salimos sin lanzar un claude de más.
const input = makeInput();
let q = null;
function startEngine() {
  // Opciones armadas por el NÚCLEO de gobernanza (core/tool-policy.js): fuente
  // única que garantiza `allowDangerouslySkipPermissions` para que el modo
  // "Todo" (bypassPermissions) realmente saltee permisos. Ver ese archivo.
  q = query({
    prompt: input.gen(),
    options: chatQueryOptions({
      cwd: CWD,
      model: MODEL,
      resume: RESUME,
      mode,
      canUseTool: (toolName, toolInput, ctx) => askPermission(toolName, toolInput, ctx),
    }),
  });
}

function onMessage(m) {
  lastActivity = Date.now();
  if (m.type === 'system' && m.subtype === 'init') {
    sessionId = m.session_id || sessionId;
    // Los comandos slash disponibles (built-ins + skills + custom del cwd)
    // vienen SOLO en el init: la lista del init es la fuente de verdad.
    if (Array.isArray(m.slash_commands)) slashCommands = m.slash_commands;
    currentModel = m.model || MODEL;
    emit({ type: 'init', chatId: ID, sessionId, model: currentModel, cwd: CWD, mode }, { record: false });
    emit({ type: 'meta', slashCommands }, { record: false });
    return;
  }
  if (m.type === 'stream_event') {
    const ev = m.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      emit({ type: 'delta', text: ev.delta.text }, { record: false }); // deltas NO van al historial
    }
    return;
  }
  if (m.type === 'assistant') {
    const blocks = m.message?.content || [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) emit({ type: 'assistant', text: b.text });
      if (b.type === 'tool_use') {
        emit({
          type: 'tool_use', id: b.id, name: b.name,
          summary: toolSummary(b.name, b.input),
          detail: toolDetail(b.name, b.input),
        });
      }
    }
    return;
  }
  if (m.type === 'user') {
    const blocks = m.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          emit({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, output: trim(resultText(b.content), 2000) });
        }
      }
    }
    return;
  }
  if (m.type === 'result') {
    sessionId = m.session_id || sessionId;
    setStatus('waiting');
    emit({
      type: 'result',
      sessionId,
      subtype: m.subtype,
      costUsd: m.total_cost_usd ?? null,
      usage: m.usage ? { input: m.usage.input_tokens, output: m.usage.output_tokens } : null,
      ms: m.duration_ms ?? null,
    });
  }
}

function askPermission(toolName, toolInput, ctx) {
  return new Promise((resolve) => {
    const id = `p${++permSeq}`;
    const timer = setTimeout(() => {
      pendingPerms.delete(id);
      resolve({ behavior: 'deny', message: 'Sin respuesta del usuario (timeout).' });
      emit({ type: 'permission_closed', id, allow: false, reason: 'timeout' });
    }, PERMISSION_TIMEOUT_MS);
    ctx?.signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      pendingPerms.delete(id);
      resolve({ behavior: 'deny', message: 'Cancelado.' });
    });
    pendingPerms.set(id, { resolve, timer, input: toolInput });
    emit({
      type: 'permission_request', id, tool: toolName,
      summary: toolSummary(toolName, toolInput),
      detail: toolDetail(toolName, toolInput),
      // Hora de emisión: el centro global de permisos calcula la cuenta
      // regresiva (PERMISSION_TIMEOUT_MS) con esto. El server la sella igual
      // si falta (runners viejos de antes del deploy).
      ts: Date.now(),
    });
  });
}

// Auto-aprueba TODA solicitud pendiente (al pasar a modo "Todo"). Usa la MISMA
// forma de "allow" que la respuesta manual del usuario (t:'perm', allow:true).
function approveAllPending() {
  for (const [id, p] of pendingPerms) {
    clearTimeout(p.timer);
    p.resolve({ behavior: 'allow', updatedInput: p.input });
    emit({ type: 'permission_closed', id, allow: true, reason: 'bypass' });
  }
  pendingPerms.clear();
}

async function pump() {
  try {
    for await (const m of q) onMessage(m);
  } catch (err) {
    emit({ type: 'error', message: String(err?.message || err).slice(0, 400) });
    log('motor con error:', err?.message || err);
  } finally {
    for (const [, p] of pendingPerms) p.resolve({ behavior: 'deny', message: 'Conversación cerrada.' });
    pendingPerms.clear();
    // Anuncia la muerte del motor y sale: el runner ES una vida del motor.
    emit({ type: 'closed', resumable: !closedByUser && !!sessionId }, { record: false });
    shutdown(0);
  }
}

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  log(`saliendo (code=${code}, sessionId=${sessionId || 'sin sesión'})`);
  // Margen para que el evento 'closed' llegue por el socket antes de morir.
  setTimeout(() => {
    for (const c of clients) { try { c.end(); } catch { /* noop */ } }
    try { server.close(); } catch { /* noop */ }
    try { fs.unlinkSync(SOCK); } catch { /* noop */ }
    process.exit(code);
  }, 300);
}

// ---- comandos del server ----
function handleCommand(c, msg) {
  if (msg.t === 'hello') {
    writeTo(c, { t: 'hello', id: ID, sessionId, model: currentModel, mode, status, startedAt, slashCommands, events: history });
    return;
  }
  if (msg.t === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
    lastActivity = Date.now();
    setStatus('working');
    // Va al historial (para el replay de una reconexión) pero NO en vivo: el
    // server que lo mandó ya lo pintó localmente.
    emit({ type: 'user', text: msg.text }, { broadcast: false });
    input.push({
      type: 'user',
      message: { role: 'user', content: msg.text },
      parent_tool_use_id: null,
      session_id: sessionId || '',
    });
    return;
  }
  if (msg.t === 'perm') {
    const p = pendingPerms.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingPerms.delete(msg.id);
    p.resolve(msg.allow
      ? { behavior: 'allow', updatedInput: p.input }
      : { behavior: 'deny', message: 'Denegado por el usuario.' });
    emit({ type: 'permission_closed', id: msg.id, allow: !!msg.allow });
    return;
  }
  if (msg.t === 'interrupt') {
    q?.interrupt?.().catch(() => {});
    setStatus('waiting');
    return;
  }
  if (msg.t === 'set_mode' && PERMISSION_MODES.has(msg.mode)) {
    Promise.resolve(q?.setPermissionMode?.(msg.mode)).then(() => {
      mode = msg.mode;
      emit({ type: 'mode', mode });
      // "Todo" (bypassPermissions) aplicado EN VIVO: auto-aprobar las tarjetas
      // que ya estaban pendientes al momento del cambio, para que se resuelvan
      // YA (si no, la card que el SDK emitió antes seguiría esperando tu clic
      // aunque el modo nuevo ya no exija permiso).
      if (autoApprovesAll(mode)) approveAllPending();
    }).catch((err) => {
      // NO tragarse el error (era la causa del "drift"): si el SDK rechaza el
      // cambio, avisar y REPORTAR el modo REAL vigente para que la UI reconcilie
      // en vez de mostrar un modo que el motor no tiene.
      emit({ type: 'error', message: `No se pudo cambiar el modo a "${msg.mode}": ${String(err?.message || err).slice(0, 200)}` });
      emit({ type: 'mode', mode });
    });
    return;
  }
  if (msg.t === 'set_model' && typeof msg.model === 'string' && msg.model) {
    Promise.resolve(q?.setModel?.(msg.model)).then(() => {
      currentModel = msg.model;
      emit({ type: 'model', model: currentModel });
    }).catch((err) => {
      emit({ type: 'error', message: `No se pudo cambiar el modelo: ${String(err?.message || err).slice(0, 200)}` });
    });
    return;
  }
  if (msg.t === 'sleep' || msg.t === 'close') {
    if (msg.t === 'close') closedByUser = true;
    log(msg.t === 'close' ? 'cierre pedido por el server' : 'sueño pedido por el server');
    input.end();
    Promise.resolve(q?.close?.()).catch(() => {});
  }
}

// ---- socket Unix ----
const server = net.createServer((c) => {
  clients.add(c);
  let buf = '';
  c.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try { handleCommand(c, msg); } catch (err) { log('comando falló:', err?.message); }
    }
  });
  c.on('close', () => clients.delete(c));
  c.on('error', () => clients.delete(c));
});

// Socket stale de un runner anterior muerto: si nadie contesta, se pisa.
// Si SÍ contesta, ya hay un runner vivo para esta conversación: sobra este.
function claimSocket() {
  return new Promise((resolve) => {
    const probe = net.connect(SOCK);
    probe.once('connect', () => { probe.destroy(); log('ya hay un runner vivo; salgo'); process.exit(0); });
    probe.once('error', () => {
      try { fs.unlinkSync(SOCK); } catch { /* no existía */ }
      resolve();
    });
  });
}

// La auto-siesta: sin actividad por SLEEP_MS, el motor se cierra solo (aunque
// el server no exista para pedírselo). El pump termina y el proceso sale.
setInterval(() => {
  if (Date.now() - lastActivity > SLEEP_MS) {
    log('auto-sueño por inactividad');
    input.end();
    Promise.resolve(q?.close?.()).catch(() => {});
  }
}, 60 * 1000).unref();

process.on('SIGTERM', () => { input.end(); Promise.resolve(q?.close?.()).catch(() => {}); });

fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
await claimSocket();
server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600); } catch { /* noop */ }
  log(`runner ${ID} escuchando en ${SOCK} (cwd=${CWD}, resume=${RESUME || 'nueva'})`);
});
startEngine();
pump();
