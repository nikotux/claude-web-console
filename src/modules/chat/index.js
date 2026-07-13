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
//   c->s: {type:'user', text} · {type:'permission_response', id, allow[, answers]}
//         {type:'interrupt'} · {type:'set_mode', mode} · {type:'set_model', model}
//   s->c: {type:'history', events, slashCommands} · {type:'user', text} · {type:'delta', text}
//         {type:'tool_use', name, summary} · {type:'result', costUsd, usage, ms}
//         {type:'permission_request', id, tool, input} · {type:'status', state}
//         {type:'mode', mode} · {type:'model', model} · {type:'error', message} · {type:'closed'}
//         {type:'meta', slashCommands:[{name,description|null}]} (Fase 8:
//          comandos del init, enriquecidos con el frontmatter de los SKILL.md)
//
// ROUTER DE MODELO AUTOMÁTICO — AutoTux (núcleo en core/model-router.js).
// v2 (2026-07-10, rediseño tras revisión externa + simulacros con datos reales;
// ver docs/autotux-analisis-externo.md). v1 colapsaba en un flip-flop Sonnet↔
// Opus (49 subidas / 13 bajadas / 0 a haiku en el log real). v2 "segura":
//  - FABLE PROHIBIDO (fuera de la escala + guard en setModel).
//  - Movimientos SIEMPRE ±1 (nunca saltos directos al techo).
//  - COOLDOWN de 2 turnos tras cada cambio (anti-rebote, estilo route-flap).
//  - NIVEL BASE (pegajoso) separado del OVERRIDE DE TURNO: un ack de CIERRE
//    (perfecto/gracias/listo…) corre ESE turno en Haiku sin tocar el base —
//    NUNCA un go-ahead (dale/ok/sí), que suele disparar trabajo (correr una
//    implementación en Haiku es frágil, hallazgo del simulacro).
//  - Escalada por EVIDENCIA de insuficiencia: corrección del usuario ("no
//    funciona", "está mal") = sube en el acto (etiqueta de calidad gratis) ·
//    ≥2 errores de tool o ≥10 tools con ≥1 error = sube para el próximo turno.
//    (El auto-redo automático del turno se DESCARTÓ: disparó 0 veces en los
//    simulacros — la corrección escala un turno antes y gratis.)
//  - Bajada por INACTIVIDAD (idle ≥60 min ⇒ decae 1 escalón al reanudar).
// En cada turno real (sendUser) _applyModelRouter() clasifica el TEXTO (0
// costo) y, si el mensaje es ambiguo, consulta a Haiku EN SEGUNDO PLANO
// (classifyRelative, fire-and-forget, patrón extractTitle — ~2-3s de arranque,
// nunca se espera en línea; gobierna el PRÓXIMO turno). Inerte si el modelo no
// mapea a la escala (clampLevel==-1: opusplan/default). Estado persistido
// MÍNIMO: `_routerDownStreak` + `_routerCooldown`; el nivel se deriva de
// `this.model`. La insuficiencia se evalúa al cerrar el turno
// (_setStatus('waiting') → _applyInsufficiencyEscalation), contando tool_use y
// tool_result con ok:false del turno (_turnToolCount / _turnToolErrors).
import express from 'express';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../../core/config.js';
import { clampToHome } from '../../core/paths.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { VALID_MODELS, encodeCwd } from '../../core/claude-model.js';
import { appendHistorico, extractSessionWork } from '../tickets/meta-store.js';
import { appendChatContext as appendLearningChatContext } from '../learning/store.js';
import { queueRetroDistill } from '../retro/shared.js';
import { sessionIdForCwd } from '../../core/claude-state.js';
import { classifySignal, signalToMove, turnOverride, decideBase, insufficiencyEscalation, idleDecayMove, clampLevel, logDecision, logTurn, readTurnMetrics, analyzeCalibration, learnedSignalBias, MODEL_LEVELS, FORBIDDEN_AUTO, EFFORT_LEVELS, effortForModel, effortForLevel, effortIdx, decideUpAxis, decideDownAxis, AUTO_EFFORT_MAX_IDX, readWindowPressure, WINDOW_PRESSURE_CONSERVE } from '../../core/model-router.js';
import { generateInventory, ROOT as CONSOLE_ROOT } from '../../core/inventory.js';
import { sessionManager, tmuxArgs, bareTmuxAlive, listBareTmuxIds, killBareTmux } from '../terminal/sessions.js';
import {
  UUID_RE, PERMISSION_MODES, PERMISSION_TIMEOUT_MS, SLEEP_MS, HISTORY_MAX, CHATS_DIR,
  trim, toolSummary, toolDetail, resultText,
} from './shared.js';
import { spawnRunner, connectRunner, tryConnectRunner } from './runner-link.js';
import {
  attachUpload, existingAttachments, attachPath,
  attachRelForExplorer, chatAttachDir, classifyAttachment,
} from './attachments.js';
// [2026-07-07] recordBugfix (tracking de v1 "Bugs & Features") removido al
// archivar v1: "Tickets & Features" lee de Zoho/GitHub directo, no registra
// chats. Ver _archived/ARCHIVED.md.
import { uniqueName, registerNameProvider } from '../../core/session-names.js';
import * as bus from '../../core/bus.js';
import { logDelivery } from '../../core/interfono-log.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const FORGET_MS = 24 * 3600 * 1000; // dormida sin uso => recién ahí se descarta la tarjeta (sigue retomable desde el lanzador)

// Respuesta de AskUserQuestion desde el cliente: mapa texto-de-pregunta -> label
// elegido (string; multiSelect = labels con coma). Se sanea antes de reenviarla
// al runner: solo pares string->string, claves/valores acotados, tope de 4
// preguntas (contrato del SDK). Devuelve null si no hay nada válido.
function sanitizeAnswers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 4) break;
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const key = k.slice(0, 400);
    const val = v.slice(0, 600);
    if (!key || !val) continue;
    out[key] = val;
    n += 1;
  }
  return n ? out : null;
}

// ===== Entrega del INTERFONO a los chats (core/bus.js) =====
// Una TUI recibe un mensaje del interfono por un "nudge" (send-keys) que la
// despierta EN VIVO; un chat del SDK NO: solo "ve" el mensaje cuando toma un
// turno (el hook-inject corre en UserPromptSubmit — settingSources: ['user']).
// Por eso, para el chat visual (superficie principal de trabajo; la TUI es
// backup), esta plomería (a) AUTO-ENTREGA el mensaje a los chats abiertos y
// ociosos inyectando un turno sintético (paridad con el nudge idle de la TUI),
// y (b) expone los pendientes en /api/chat/list para el popup global
// (public/js/ui/interfono-center.js) + el botón "Retomar" (que despierta
// incluso un chat dormido, a demanda del usuario — 0 tokens fantasma).
const CWC_BUS = path.join(CONSOLE_ROOT, 'bin', 'cwc-bus.js'); // CLI del interfono
const INTERFONO_POLL_MS = 12000; // watcher server-side de entrega a chats abiertos+ociosos

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
      effort: 'low', // F5(a) PEND-405: clasificadores/extracción Haiku a esfuerzo bajo — más baratos y rápidos, misma señal
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

// ===== Router de modelo: clasificador barato para turnos ambiguos (Fase 2) =====
// Cuando la heurística 0-costo de core/model-router.js no sabe qué opinar
// (ni obviamente trivial ni obviamente pesado), esta corrida MÍNIMA con Haiku
// (1 turno, READ-ONLY doble capa regla 6 — mismo patrón defensivo que
// extractTitle de arriba) devuelve un nivel sugerido. Confirmado con datos
// reales de esta consola (2026-07-06): clasificar con Haiku sale ~0,005% del
// gasto real medido — no hace falta pelear por evitarlo. OJO DE LATENCIA
// (verificado en caliente 2026-07-06): el arranque de query() por sí solo
// (proceso del SDK + init) tarda ~2-3s ANTES de que Haiku responda una sola
// palabra — muy por encima de lo que un turno puede esperar sin sentirse
// roto. Por eso esto NUNCA bloquea el despacho del turno (ver
// _applyModelRouter): corre en SEGUNDO PLANO, patrón fire-and-forget idéntico
// a _autoTitle, con timeout+interrupt generoso (mismo orden que
// AUTOTITLE_TIMEOUT_MS) solo para no dejar el proceso colgado para siempre.
const ROUTER_CLASSIFY_TIMEOUT_MS = 20000;
// Clasificador RELATIVO (v2): mapea la respuesta al MOVIMIENTO del base. La
// pregunta relativa ("dado que estás en X…") tiene deadband en 'suficiente'
// (no mueve nada) — mucho más estable turno a turno que la clasificación
// absoluta de v1, que alimentaba el yo-yo.
const ROUTER_MOVE_BY_WORD = { sobrado: 'down', suficiente: null, insuficiente: 'up' };

// Devuelve 'up' | 'down' | null (suficiente/timeout/error). NUNCA sugiere fable
// (la escala del núcleo no lo incluye; un 'up' desde opus queda inerte en
// decideBase). READ-ONLY doble capa (regla 6): sin herramientas, solo texto.
async function classifyRelative({ cwd, currentModel, text }) {
  const q = query({
    prompt:
      `El modelo actual de esta conversación es "${currentModel}" (escala barato→caro: haiku < sonnet < opus). ` +
      'Para el SIGUIENTE pedido del usuario, respondé UNA sola palabra, sin nada más: ' +
      '"sobrado" (un modelo más chico alcanzaría de sobra), "suficiente" (el nivel actual está bien) ' +
      'o "insuficiente" (hace falta un modelo más capaz: requiere código, análisis profundo o tocar varias partes).\n' +
      `Pedido: «${String(text || '').slice(0, 1000)}»`,
    options: {
      cwd,
      model: 'haiku',
      effort: 'low', // F5(a) PEND-405: clasificadores/extracción Haiku a esfuerzo bajo — más baratos y rápidos, misma señal
      maxTurns: 1,
      permissionMode: 'default',
      settingSources: [], // patrón projects/analyzeChange: sin herramientas, solo clasifica texto
      hooks: {
        PreToolUse: [{
          hooks: [async () => ({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Router de modelo: sin herramientas.',
            },
          })],
        }],
      },
      canUseTool: async () => ({ behavior: 'deny', message: 'Router de modelo: sin herramientas.' }),
    },
  });
  let out = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ROUTER_CLASSIFY_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text;
      } else if (m.type === 'result') break;
    }
  })();
  try {
    await Promise.race([pump, timeout]);
  } catch {
    try { q.interrupt?.(); } catch { /* noop */ }
    return null; // timeout u otro error: seguimos tratando el turno como ambiguo
  } finally {
    clearTimeout(timer);
  }
  const word = out.toLowerCase().replace(/[^a-záéíóúñ]/g, '').trim();
  return Object.prototype.hasOwnProperty.call(ROUTER_MOVE_BY_WORD, word) ? ROUTER_MOVE_BY_WORD[word] : null;
}

// Juez post-turno "AutoMix" (F3 de la investigación externa, PEND-391 #1 / D1):
// tras un turno SUSTANCIAL evalúa con Haiku (background, read-only, MISMO
// blindaje doble capa que classifyRelative) si la respuesta se quedó CORTA y un
// modelo más fuerte lo haría notablemente mejor. Devuelve true (=insuficiente,
// ofrecer subir) | false (ok) | null (timeout/error/duda). NUNCA actúa solo:
// solo alimenta un banner de CONSENTIMIENTO [Reintentar/Ignorar] en el chat —
// el auto-redo automático se DESCARTÓ por diseño (0 disparos en simulacro).
const JUDGE_TIMEOUT_MS = 20000;
async function judgeAnswer({ cwd, currentModel, userText, answerText }) {
  const q = query({
    prompt:
      `Sos un juez de calidad. El modelo "${currentModel}" (escala barato→caro: haiku < sonnet < opus) ` +
      'respondió el pedido de abajo. Decidí si la respuesta se quedó CLARAMENTE corta y un modelo MÁS CAPAZ ' +
      'probablemente lo haría notablemente mejor (razonamiento incompleto o erróneo, evasivas, o el pedido ' +
      'requería código/análisis profundo que no se cubrió). Respondé UNA sola palabra, sin nada más: ' +
      '"insuficiente" (conviene reintentar con un modelo más fuerte) o "ok" (la respuesta alcanza).\n' +
      `Pedido: «${String(userText || '').slice(0, 800)}»\n` +
      `Respuesta: «${String(answerText || '').slice(0, 2000)}»`,
    options: {
      cwd, model: 'haiku', effort: 'low', maxTurns: 1, permissionMode: 'default', // F5(a): juez a esfuerzo bajo
      settingSources: [],
      hooks: {
        PreToolUse: [{
          hooks: [async () => ({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Juez AutoMix: sin herramientas.',
            },
          })],
        }],
      },
      canUseTool: async () => ({ behavior: 'deny', message: 'Juez AutoMix: sin herramientas.' }),
    },
  });
  let out = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), JUDGE_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text;
      } else if (m.type === 'result') break;
    }
  })();
  try { await Promise.race([pump, timeout]); } catch { try { q.interrupt?.(); } catch { /* noop */ } return null; } finally { clearTimeout(timer); }
  const w = out.toLowerCase().replace(/[^a-z]/g, '').trim();
  if (w.includes('insuficiente')) return true;
  if (w.includes('ok')) return false;
  return null;
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
      writeJsonAtomic(CHAT_IDS_FILE, [..._chatIdsReg]); // atómico (fix B3.3 2026-07-11): registro durable append-only
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
        // Adjuntos del turno (bloques image/document del SDK): en el replay
        // desde el transcript NO tenemos el nombre en disco, así que se pintan
        // como CHIPS de tipo (sin miniatura) — la imagen real sigue accesible
        // por "Abrir carpeta del chat". Se adosan a la 1ª burbuja de texto (o a
        // una burbuja vacía si el turno fue solo-adjunto).
        const atts = c
          .filter((b) => b.type === 'image' || b.type === 'document')
          .map((b) => ({ type: b.type === 'image' ? 'image' : 'pdf' }));
        let attsAttached = false;
        let emittedText = false;
        for (const b of c) {
          if (b.type === 'text' && b.text?.trim()) {
            const ev = { type: 'user', text: b.text };
            if (atts.length && !attsAttached) { ev.attachments = atts; attsAttached = true; }
            events.push(ev);
            emittedText = true;
          }
          if (b.type === 'tool_result') {
            events.push({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, output: trim(resultText(b.content), 2000) });
          }
        }
        if (atts.length && !emittedText) events.push({ type: 'user', text: '', attachments: atts });
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
  constructor({ id, cwd, model, permissionMode, resume = null, title = null, ticket = null, learningId = null, effort = null }) {
    this.id = id;
    this.cwd = cwd;
    // AutoTux (2026-07-06): `modelChoice` es QUÉ ELIGIÓ LA PERSONA (auto |
    // opusplan | fable | opus | sonnet | haiku | default | null=sin elegir);
    // `this.model` es lo que corre DE VERDAD contra el SDK/CLI real y NUNCA
    // vale 'auto' (el CLI no conoce ese alias — ver core/model-router.js y
    // setModelChoice() para el porqué). Con 'auto', el router (Fase 1-3)
    // gestiona `this.model` mientras `modelChoice` se queda fijo en 'auto'
    // para siempre — el badge nunca deja de decir "AutoTux". Con cualquier
    // otro valor, modelChoice y model son EL MISMO valor (forzado, sin
    // router) — así una creación directa con model:'sonnet' (sin pasar por
    // setModelChoice) ya queda coherente sin casos especiales aparte.
    if (model === 'auto') {
      this.modelChoice = 'auto';
      this.model = 'sonnet'; // punto de partida razonable; el router lo ajusta desde acá
    } else {
      this.modelChoice = model || null;
      this.model = model || null;
    }
    // Eje thinking effort (PEND-391 #3): esfuerzo de razonamiento del chat.
    // Si la persona lo eligió (`effort` explícito) se respeta; si no, se deriva
    // del nivel actual del modelo (haiku→low · sonnet→medium · opus→high) para
    // que un chat 'auto' nazca con un effort coherente con su tier. Con AutoTux
    // el default lo mantiene alineado al nivel; el usuario puede fijarlo a mano.
    this.effort = (EFFORT_LEVELS.includes(effort) ? effort : null) || effortForModel(this.model);
    this.permissionMode = permissionMode || 'default';
    this.title = (title && String(title).slice(0, 60)) || path.basename(cwd) || '~';
    this.ticket = ticket; // {number, url} si nació de un bug de Desk (registro al cerrar)
    this.learningId = learningId; // 'TDA-<n>' si nació de "Profundizar en chat" de un tema de Aprendizaje (write-back al cerrar)
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
    this._pendingModelAuto = [];  // COLA FIFO de flags auto por set_model en vuelo (BUG-24)
    this._downAnnounced = true;   // ya anunciamos la muerte de la vida actual del motor
    // Motor Pac-Man — estado "delegando" (2026-07-05): ids de tool_use Task/
    // Agent aún sin su tool_result. >0 ⇒ está esperando la vuelta de un
    // subagente, visible en /api/chat/list como `delegating` sin necesitar
    // la pestaña del chat abierta (antes esto solo vivía en el frontend,
    // como ícono de tool call, invisible para la tarjeta de Sesiones).
    this._delegatingIds = new Set();
    // Momento (ts) en que arrancó la delegación ACTUAL (0→>0 subagentes). Lo
    // consume el panel de Actividad en Segundo Plano (ui/activity-widget.js) para
    // la columna "tiempo corriendo" del subagente. Efímero como _turnToolCount:
    // no se persiste (un chat dormido no tiene subagente vivo).
    this._delegatingSince = null;
    // Router de modelo automático — AutoTux v2 (núcleo: core/model-router.js).
    // Estado PERSISTIDO mínimo (ver persist()/rehydrate()): contador de turnos
    // "down" seguidos para la histéresis de bajada + turnos restantes de
    // cooldown anti-rebote. El NIVEL no se duplica: se deriva de `this.model`.
    this._routerDownStreak = 0;
    this._routerCooldown = 0;
    // Efímeros (NO se persisten): señales del turno EN CURSO para la escalada
    // por insuficiencia (_applyInsufficiencyEscalation al pasar a 'waiting').
    this._turnToolCount = 0;   // cualquier tool_use del turno
    this._turnToolErrors = 0;  // tool_result con ok:false (herramienta falló)
    // Override efímero de turno (ack de cierre → Haiku SOLO este turno): al
    // cerrarlo se restaura el base guardado. Efímero: un reinicio a mitad como
    // mucho deja el turno en Haiku, sin afectar el base persistido.
    this._overrideRestore = null; // nombre del modelo base a restaurar, o null
    // Throttle del clasificador relativo: no reclasificar si ya se clasificó
    // hace poco con el mismo nivel vigente (reduce llamadas + volatilidad).
    this._routerClassifyThrottle = 0;
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
        effort: this.effort, // eje thinking effort (spawn-time, PEND-391 #3)
        // Identidad del chat en el Interfono (Fase 0.4): handle canónico
        // claude:<sessionId> — mismo que _busHandle(). Solo si ya lo conocemos.
        selfHandle: resumeId ? `claude:${resumeId}` : null,
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
      case 'model': {
        this.model = e.model;
        // `auto` (Fase 3, indicador visible): el router marca la intención
        // ANTES de mandar set_model al runner; acá se consume para taguear el eco
        // real con el mismo origen — el frontend usa `auto` para mostrar la notita
        // "🤖 cambió solo" vs. un cambio manual del selector.
        // COLA FIFO (BUG-24): con un booleano único, dos set_model antes de que
        // llegaran sus ecos se pisaban y mal-etiquetaban la nota. Consumimos el
        // flag MÁS VIEJO (los ecos llegan en orden por el mismo WS).
        const auto = this._pendingModelAuto.length ? this._pendingModelAuto.shift() : false;
        this._push({ ...e, auto });
        this.onUpdate?.(); // persistir el modelo confirmado por el runner
        return;
      }
      case 'result': {
        const hadSession = !!this.sessionId;
        this.sessionId = e.sessionId || this.sessionId;
        if (!hadSession && this.sessionId) this.onUpdate?.();
        this._logTurnAtResult(e); // ANTES de _setStatus: usa _turnTool* que waiting resetea
        this._maybeJudge();       // juez AutoMix (D1): ANTES de _setStatus (usa _turnTool* / _turnAnswerText)
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
        // Juez AutoMix (D1): acumulamos el texto de la respuesta del turno para
        // que el juez post-turno pueda evaluar si se quedó corta (cap defensivo).
        if (e.type === 'assistant' && e.text && (this._turnAnswerText || '').length < 8000) {
          this._turnAnswerText = (this._turnAnswerText || '') + e.text;
        }
        if (e.type === 'tool_use') {
          // Contador del turno en curso (AutoTux v2 — ver _endTurnRouter /
          // insufficiencyEscalation): CUALQUIER herramienta cuenta, no solo
          // Task/Agent.
          this._turnToolCount = (this._turnToolCount || 0) + 1;
          // Estado "delegando" (ver PAC_STATES en ui/pacman.js): un tool_use
          // Task/Agent abre la espera de un subagente; su tool_result la
          // cierra (mismo patrón de matching que TOOL_TYPE_ICONS del
          // frontend, acá server-side para que /api/chat/list lo vea sin la
          // pestaña abierta).
          if (/^(Task|Agent)/i.test(e.name || '')) {
            this._delegatingIds.add(e.id);
            // Sella el inicio de la delegación al pasar de 0→>0 (para "tiempo corriendo").
            if (this._delegatingIds.size === 1) this._delegatingSince = Date.now();
          }
        } else if (e.type === 'tool_result') {
          // AutoTux v2 (C5): una herramienta que falló (ok:false, ver runner)
          // es evidencia barata de "el nivel se quedó corto" — la cuenta el
          // escalado por insuficiencia al cerrar el turno.
          if (e.ok === false) this._turnToolErrors = (this._turnToolErrors || 0) + 1;
          if (this._delegatingIds.has(e.id)) this._delegatingIds.delete(e.id);
          if (this._delegatingIds.size === 0) this._delegatingSince = null;
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

  // ===== Interfono (mensajería entre sesiones, core/bus.js) =====
  // Handle canónico de este chat en el bus (mismo que deriva el hook-inject
  // desde el session_id del SDK — bin/cwc-bus.js selfIdentity).
  _busHandle() { return this.sessionId ? `claude:${this.sessionId}` : null; }

  // Mensajes del interfono aún NO entregados a este chat (para el popup global
  // y el botón "Retomar"). Solo LEE el bus (0 tokens); no marca entregado — así
  // el aviso persiste hasta que el chat lo toma (turno/hook o botón).
  pendingInterfono() {
    const h = this._busHandle();
    if (this.closed || !h) return [];
    let msgs;
    try { msgs = bus.pendingFor([h]); } catch { return []; }
    return msgs.map((m) => ({
      id: m.id,
      fromName: String(m.fromName || 'sesión').slice(0, 60),
      text: String(m.text || '').slice(0, 400),
      ts: m.ts || null,
      // Nivel de interrupción (Fase 4): 'active' surfacea toast; 'passive' solo
      // badge. Mensajes viejos sin level ⇒ passive.
      level: m.level || 'passive',
    }));
  }

  // Señal EN VIVO del interfono (rediseño 2026-07-10, Fase 3): empuja los
  // pendientes por _broadcast, que llega SOLO a los WS de este chat = las
  // ventanas que lo tienen abierto (scoping server-side, sin windowId). El
  // frontend lo consume para refrescar el badge/aviso al instante en esas
  // ventanas, sin esperar el poll de 8 s ni molestar a las demás.
  signalInterfono() {
    if (this.closed) return;
    if (!this.clients.size) return; // nadie mirando: no cuesta nada saltearlo
    this._broadcast({ type: 'interfono', pending: this.pendingInterfono() });
  }

  // Inyecta los mensajes pendientes como UN turno sintético (equivalente al
  // nudge send-keys de la TUI). Marca ENTREGADO antes de disparar el turno para
  // que el hook-inject de ese mismo UserPromptSubmit no re-inyecte el mismo
  // mensaje (doble). Revive el motor con resume si estaba dormido (_ensureEngine).
  deliverInterfono(msgs, route = 'auto-deliver') {
    const h = this._busHandle();
    if (this.closed || !h || !Array.isArray(msgs) || !msgs.length) return;
    try { bus.markDelivered(msgs, [h]); } catch { /* noop */ }
    for (const m of msgs) {
      logDelivery({ route, msgId: m.id, from: m.from || null, to: h, kind: m.kind || 'note', level: m.level || 'passive', chatId: this.id });
    }
    const body = msgs.map((m) => {
      const when = new Date(m.ts || Date.now()).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      return `• [${when}] ${m.fromName || 'una sesión'}: ${m.text}`;
    }).join('\n');
    const text =
      '📨 INTERFONO — mensaje(s) de otra(s) sesión(es) de Claude Code:\n' +
      `${body}\n` +
      `Si alguno requiere respuesta, contestá UNA vez con: node ${CWC_BUS} send "<nombre-de-la-sesión>" "<respuesta>".`;
    this.lastActivity = Date.now();
    this._setStatus('working');
    this._push({ type: 'user', text }); // visible como burbuja en la conversación
    this._ensureEngine().then((ok) => {
      if (ok !== false) this.link?.send({ t: 'user', text });
      else this._setStatus('waiting'); // fix B3.3 2026-07-11: idem sendUser — no dejar "working" pegado si el motor no arrancó
    });
  }

  // Acción del popup/botón: 'deliver' inyecta (y despierta si hace falta),
  // 'dismiss' marca entregado SIN actuar (limpia el aviso). Idempotente.
  consumeInterfono(action) {
    const h = this._busHandle();
    if (this.closed || !h) return { ok: false, error: 'La conversación no tiene una sesión activa.' };
    let msgs;
    try { msgs = bus.pendingFor([h]); } catch { msgs = []; }
    if (!msgs.length) return { ok: true }; // ya no hay nada: idempotente
    if (action === 'dismiss') {
      try { bus.markDelivered(msgs, [h]); } catch { /* noop */ }
      for (const m of msgs) {
        logDelivery({ route: 'popup-dismiss', msgId: m.id, from: m.from || null, to: h, kind: m.kind || 'note', level: m.level || 'passive', chatId: this.id });
      }
      return { ok: true };
    }
    this.deliverInterfono(msgs, 'popup-resume');
    return { ok: true };
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
      const waiter = () => finish(true);
      const timer = setTimeout(() => {
        // Sacar el waiter del array al vencer (BUG-23): sin esto quedaba colgado en
        // _engineWaiters hasta que muriera el motor (fuga acotada pero innecesaria).
        const i = this._engineWaiters.indexOf(waiter);
        if (i >= 0) this._engineWaiters.splice(i, 1);
        finish(false);
      }, timeoutMs);
      this._engineWaiters.push(waiter);
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

  // Reabre el motor sobre la MISMA sesión: duerme el runner vivo (sale limpio
  // con resume disponible), ESPERA su muerte verificada y re-spawnea uno FRESCO.
  // Sirve para que una conversación viva tome cambios de CÓDIGO nuevos tras un
  // deploy: un runner spawneado antes del deploy importó el código viejo
  // (PERMISSION_MODES, bypassPermissions, allowlists) y no los toma hasta
  // dormirse/reabrirse. No cierra la conversación ni pierde contexto.
  async reopen() {
    if (this.closed) return { ok: false, error: 'La conversación está cerrada.' };
    if (this.viewMode !== 'chat') return { ok: false, error: 'Solo se puede reabrir en modo Chat (una TUI se reinicia desde la terminal).' };
    // Motor dormido/caído: no hay proceso viejo que matar. Un arranque fresco
    // ya toma el código nuevo.
    if (!this.alive || !this.link) {
      const ok = await this._ensureEngine();
      if (ok === false) return { ok: false, error: 'El motor no arrancó (mirá ~/.cwc-data/chats/*.log).' };
      // Motor fresco sin turno en curso: el runner arranca en 'waiting' pero no
      // emite un 'status' si no cambia, así que lo fijamos acá (evita que quede
      // un 'working'/'delegating' stale de una vida anterior del motor).
      this._setStatus('waiting');
      this._push({ type: 'reopened' }, { record: false });
      return { ok: true };
    }
    // Motor vivo: dormirlo (sale con resume) y ESPERAR su muerte verificada
    // antes de re-spawnear. 'sleep' y no 'close': la conversación sigue viva.
    // _engineStopping suprime la nota "dormida por inactividad" en el relevo.
    this._engineStopping = true;
    this.link.send({ t: 'sleep' });
    // OJO: el runner emite el evento 'closed' y RECIÉN ~2s después cierra el
    // socket (bin/cwc-chat-runner.js: margen para que 'closed' llegue). Ese
    // evento resuelve _waitEngineDown con this.link TODAVÍA seteado, así que no
    // alcanza: si re-spawneáramos ahí, (a) _ensureEngine haría early-return por
    // el link viejo y (b) el runner nuevo se suicidaría porque el viejo aún
    // escucha ("ya hay un runner vivo"). Esperamos el descarte REAL del link
    // (onClose lo nula al cerrarse el socket: ahí el runner viejo dejó de
    // escuchar y su lock quedó liberable).
    await this._waitEngineDown(SWITCH_CLOSE_MS);
    const deadline = Date.now() + SWITCH_CLOSE_MS;
    while (this.link && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this._engineStopping = false;
    if (this.link) {
      return { ok: false, error: 'No se pudo cerrar el motor actual a tiempo; probá de nuevo.' };
    }
    // Recargar el history desde el transcript (por si el turno cortado dejó
    // algo) y levantar un runner FRESCO sobre la misma sesión.
    if (this.sessionId) this.history = loadTranscriptEvents(this.cwd, this.sessionId);
    const ok = await this._ensureEngine();
    if (ok === false) return { ok: false, error: 'El motor no volvió a arrancar (mirá ~/.cwc-data/chats/*.log).' };
    // Motor fresco sin turno en curso (matamos el que hubiera): fijar 'waiting'
    // — el runner arranca así pero no emite 'status' si no cambia, y sin esto
    // quedaría el 'working'/'delegating' del turno cortado.
    this._setStatus('waiting');
    // Reenviar el history recargado a los clientes conectados + anunciar la
    // reapertura (mismo patrón que _toChat).
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'history', events: this.history, mode: this.permissionMode, status: this.status, slashCommands: this._slashList() }));
      }
    }
    this._push({ type: 'reopened' }, { record: false });
    return { ok: true };
  }

  // `answers` (opcional) solo aplica a AskUserQuestion: mapa texto-de-pregunta ->
  // label elegido (multiSelect = labels con coma). El runner lo materializa en
  // updatedInput.answers; para el resto de tools se ignora.
  answerPermission(id, allow, answers = null) {
    const msg = { t: 'perm', id, allow: !!allow };
    if (allow && answers && typeof answers === 'object') msg.answers = answers;
    this.link?.send(msg);
  }

  // `attachments` (opcional): [{name,type,mime}] YA subidos a la carpeta del
  // chat (existingAttachments los validó contra disco). Viajan como referencia
  // al runner, que LEE cada archivo y arma los bloques image/document/text del
  // SDK (chat/attachments.js buildUserContent). SIN adjuntos, el camino es
  // idéntico al histórico (content = string).
  sendUser(text, attachments = null) {
    if (this.closed) return;
    if (!this.alive && this.viewMode !== 'chat') return;
    const atts = Array.isArray(attachments) && attachments.length ? attachments : null;
    if (!String(text || '').trim() && !atts) return; // ni texto ni adjuntos: nada que enviar
    const idleMs = Date.now() - (this.lastActivity || Date.now()); // ANTES de pisarlo: AutoTux usa el idle para decaer
    this.lastActivity = Date.now();
    // Juez post-turno AutoMix (PEND-391 #1 / D1): guardamos el pedido y
    // arrancamos en cero la acumulación de la respuesta del turno, para poder
    // evaluar al cerrar si el modelo se quedó corto (banner de consentimiento).
    this._lastUserText = String(text || '');
    this._turnAnswerText = '';
    this._applyModelRouter(text, idleMs); // sincrónico para lo obvio; lo ambiguo se resuelve en segundo plano (ver abajo) — NUNCA demora este turno
    this._setStatus('working');
    this._push({ type: 'user', text, ...(atts ? { attachments: atts } : {}) });
    this._autoTitle(text); // en paralelo: renombra la tarjeta según el pedido
    // Motor dormido (o caído): revivirlo con resume sobre la MISMA sesión.
    this._ensureEngine().then((ok) => {
      if (ok !== false) this.link?.send({ t: 'user', text, ...(atts ? { attachments: atts } : {}) });
      else this._setStatus('waiting'); // fix B3.3 2026-07-11: spawn/conexión falló → no dejar la tarjeta pegada en "working" para siempre
    });
  }

  // Router de modelo automático — AutoTux v2 (núcleo: core/model-router.js).
  // Reusa el MISMO setModel() del selector manual — solo la DECISIÓN es nueva.
  // Inerte si `modelChoice` !== 'auto' o si el modelo no mapea a la escala.
  // UN solo movimiento del base por turno (evita doble decremento de cooldown).
  _applyModelRouter(text, idleMs = 0) {
    if (this.modelChoice !== 'auto') return; // forzado a un modelo fijo: AutoTux no opina
    const base0 = clampLevel(this.model);
    if (base0 === -1) return; // opusplan/default: no gestionado
    if (this._routerClassifyThrottle > 0) this._routerClassifyThrottle--;

    let { kind } = classifySignal(text);
    // F5(b): si la heurística no opina (ambiguo), consultar las SEÑALES
    // APRENDIDAS (minadas de los logs reales, alternativa determinística al #6)
    // ANTES de gastar el clasificador Haiku — si un patrón de "up" aprendido
    // matchea, subimos sin llamar al modelo. Vacío hasta tener datos ⇒ sin efecto.
    if (kind === 'ambiguous' && learnedSignalBias(text, Date.now()) === 'up') kind = 'up';

    // Movimiento del NIVEL BASE (uno por turno). Prioridad: corrección > código/
    // largo > bajada (ack/goahead) > bajada por inactividad (solo si ambiguo).
    let move = 'same';
    if (kind === 'strong_up') move = 'strong_up';
    else if (kind === 'up') move = 'up';
    else if (kind === 'closing' || kind === 'goahead') move = 'down';
    else if (idleDecayMove({ baseLevel: base0, idleMs }) === 'down') move = 'down';

    // F1+F2 (PEND-405): EJE EFFORT en la decisión. Ante una necesidad de subir,
    // elegir entre subir effort (mismo modelo, caché intacto, más barato) o
    // saltar de tier — sesgado por el costo de caché del último turno. Si el eje
    // elegido es 'effort', bumpeamos el effort y NO movemos el modelo (move→same).
    // F4: si la ventana de rate-limit está apretada (≥75% usado), `conserve`
    // fuerza a nunca saltar de tier (solo effort) — el objetivo es no quemarla.
    const pressure = readWindowPressure();
    const conserve = typeof pressure === 'number' && pressure >= WINDOW_PRESSURE_CONSERVE;
    if (move === 'up' || move === 'strong_up') {
      const axis = decideUpAxis({ hard: move === 'strong_up', level: base0, effortIndex: effortIdx(this.effort), lastCacheRead: this._lastCacheRead || 0, pinned: !!this._effortPinned, conserve });
      if (axis === 'effort') { this._bumpEffortAuto(+1); move = 'same'; }
      else if (axis === 'none') { move = 'same'; } // conserve + sin margen de effort: no subir
    } else if (move === 'down') {
      const axis = decideDownAxis({ level: base0, effortIndex: effortIdx(this.effort), tierEffortIndex: effortIdx(effortForLevel(base0)), pinned: !!this._effortPinned });
      if (axis === 'effort') { this._bumpEffortAuto(-1); move = 'same'; }
    }

    const r = decideBase({ baseLevel: base0, move, downStreak: this._routerDownStreak, cooldown: this._routerCooldown });
    this._routerDownStreak = r.downStreak;
    this._routerCooldown = r.cooldown;
    const base = r.level; // base tras el movimiento (puede haber demotado)

    // Override efímero (C4): un ack de CIERRE corre ESTE turno en Haiku sin
    // tocar el base — se restaura al cerrar el turno (_endTurnRouter). NUNCA en
    // go-aheads (dale/ok): correr trabajo en Haiku es frágil.
    if (turnOverride(kind) === 0) {
      this._overrideRestore = MODEL_LEVELS[base];
      if (this.model !== 'haiku') {
        this.setModel('haiku', { auto: true });
        logDecision({ chatId: this.id, sessionId: this.sessionId, source: 'override', from: MODEL_LEVELS[base], to: 'haiku', text: text.slice(0, 150) });
      }
      // El logTurn se difiere al evento `result` (donde llega el usage/caché,
      // los tool counts reales y el modelo REAL del turno) — acá solo guardamos
      // la decisión del router. Ver _logTurnAtResult (instrumentación #2/#4).
      this._turnRouterMeta = { ranLevel: 0, base, override: true };
      return;
    }

    // Cambio de base (subida por código/corrección, o bajada por ack/idle).
    if (r.changed) {
      const from = this.model;
      const next = MODEL_LEVELS[base];
      if (next && next !== from) {
        this.setModel(next, { auto: true });
        const source = kind === 'strong_up' ? 'correction'
          : (kind === 'ambiguous' || kind === 'none') ? 'idle' // el único cambio posible acá es idle-decay
            : 'heuristic';
        logDecision({ chatId: this.id, sessionId: this.sessionId, source, from, to: next, text: text.slice(0, 150) });
      }
    } else if (kind === 'ambiguous' && this._routerClassifyThrottle === 0) {
      // Heurística sin opinión: clasificador RELATIVO a Haiku EN SEGUNDO PLANO
      // (fire-and-forget, patrón _autoTitle — ~2-3s de arranque, jamás demora
      // el turno). Gobierna el PRÓXIMO turno. Throttle: no reclasificar por 2 t.
      this._classifyRelative(text, base);
    }
    this._turnRouterMeta = { ranLevel: base, base, override: false };
  }

  // Instrumentación por-turno (PEND-391 #2 auditoría de caché / #4 calibración):
  // se llama en el evento `result` (fin REAL del turno, con usage/caché ya
  // disponible — a diferencia de _applyModelRouter que corre al INICIO, sin
  // usage). Registra en model-router-turns.jsonl el nivel del router + el modelo
  // REAL corrido + si CAMBIÓ de modelo vs el turno previo (para medir si el
  // switch invalida el caché de prompt: switchedFromPrev=true ⇒ esperamos
  // cache_read≈0 y cache_creation alto ese turno) + effort + tool counts + los
  // tokens de caché reales. Corre para TODO chat (auto o forzado): el switch
  // manual de modelo también invalida el caché, así que interesa medirlo.
  _logTurnAtResult(e) {
    const meta = this._turnRouterMeta || {};
    this._turnRouterMeta = null;
    const u = e && e.usage;
    const prev = this._lastResultModel || null;
    const model = this.model;
    try {
      logTurn({
        chatId: this.id,
        model,
        modelChoice: this.modelChoice,
        switchedFromPrev: prev != null && prev !== model,
        prevModel: prev,
        effort: this.effort || null,
        ranLevel: meta.ranLevel ?? null,
        base: meta.base ?? null,
        override: meta.override ?? false,
        toolCalls: this._turnToolCount || 0,
        toolErrors: this._turnToolErrors || 0,
        cacheCreate: u ? (u.cacheCreate || 0) : null,
        cacheRead: u ? (u.cacheRead || 0) : null,
        input: u ? (u.input || 0) : null,
        output: u ? (u.output || 0) : null,
      });
    } catch { /* best-effort: nunca romper el turno por logging */ }
    this._lastResultModel = model;
    // F1 (caché-aware): recordamos cuánto leyó del caché el último turno. Si es
    // alto, saltar de tier el próximo turno DESPERDICIARÍA ese prefijo cacheado
    // (cuesta tokens de la ventana) → decideUpAxis sesga hacia subir effort.
    if (u && u.cacheRead != null) this._lastCacheRead = u.cacheRead;
  }

  // Gate del juez AutoMix (D1): decide si vale gastar el juez este turno. Solo
  // AutoTux, solo si HAY margen para subir (no en el techo opus), solo turnos
  // SUSTANCIALES (usó ≥2 herramientas o respondió algo largo — los triviales ya
  // los baja el override de cierre y no valen el gasto). Throttle: no juzgar más
  // de 1 de cada 3 turnos. Fire-and-forget: NUNCA bloquea; al terminar, si el
  // juez dice "insuficiente", emite el evento `redo-suggest` (banner de
  // consentimiento en el front — NUNCA sube solo).
  _maybeJudge() {
    if (this.modelChoice !== 'auto') return;
    const level = clampLevel(this.model);
    if (level < 0 || level >= MODEL_LEVELS.length - 1) return; // ya en el techo
    const substantial = (this._turnToolCount || 0) >= 2 || (this._turnAnswerText || '').length >= 400;
    if (!substantial) return;
    if (this._judgeThrottle > 0) { this._judgeThrottle--; return; }
    if (this._judging) return;
    this._judging = true;
    this._judgeThrottle = 2; // no re-juzgar los próximos 2 turnos
    const userText = this._lastUserText;
    const answerText = this._turnAnswerText;
    judgeAnswer({ cwd: this.cwd, currentModel: this.model, userText, answerText })
      .then((insufficient) => {
        if (insufficient !== true || this.closed || this.modelChoice !== 'auto') return;
        const lvl = clampLevel(this.model);
        if (lvl < 0 || lvl >= MODEL_LEVELS.length - 1) return;
        const to = MODEL_LEVELS[lvl + 1];
        // Banner pasivo de consentimiento: el usuario decide (Reintentar/Ignorar).
        this._push({ type: 'redo-suggest', from: this.model, to });
        logDecision({ chatId: this.id, sessionId: this.sessionId, source: 'judge', from: this.model, to, text: '(juez AutoMix: respuesta insuficiente, ofrezco subir)' });
      })
      .catch(() => { /* best-effort: nunca romper el turno por el juez */ })
      .finally(() => { this._judging = false; });
  }

  // Consentimiento del juez (D1): sube UN escalón y REINTENTA el último pedido.
  // Lo dispara el botón "Reintentar en <modelo>" del banner. Solo con AutoTux y
  // margen para subir. Reusa sendUser (que re-arma el turno + re-juzga si toca).
  redo() {
    if (this.modelChoice !== 'auto') return false;
    const lvl = clampLevel(this.model);
    if (lvl < 0 || lvl >= MODEL_LEVELS.length - 1) return false;
    const text = this._lastUserText || '';
    if (!text) return false;
    this.setModel(MODEL_LEVELS[lvl + 1], { auto: true });
    this.sendUser(text);
    return true;
  }

  // Clasificador RELATIVO de Haiku (v2): en vez de "¿qué complejidad tiene?"
  // (absoluto, volátil turno a turno), pregunta "dado que estás en X, ¿sobrado/
  // suficiente/insuficiente?" — deadband natural en 'suficiente' (no mueve
  // nada), mucho más estable. Fire-and-forget en segundo plano.
  _classifyRelative(text, _baseAtDispatch) {
    if (this._routerClassifying) return;
    this._routerClassifying = true;
    this._routerClassifyThrottle = 2; // no reclasificar los próximos 2 turnos
    classifyRelative({ cwd: this.cwd, currentModel: this.model, text })
      .then((move) => { // 'up' | 'down' | null (suficiente/timeout/error)
        if (!move || this.closed) return;
        const b = clampLevel(this.model);
        if (b === -1) return; // el usuario pudo pasar a opusplan/default mientras tanto
        const r = decideBase({ baseLevel: b, move, downStreak: this._routerDownStreak, cooldown: this._routerCooldown });
        this._routerDownStreak = r.downStreak;
        this._routerCooldown = r.cooldown;
        if (r.changed) {
          const from = this.model;
          const next = MODEL_LEVELS[r.level];
          if (next && next !== from) {
            this.setModel(next, { auto: true });
            logDecision({ chatId: this.id, sessionId: this.sessionId, source: 'classifier', from, to: next, text: text.slice(0, 150) });
          }
        }
      })
      .catch(() => { /* best-effort: mejor no tocar nada que romper el turno */ })
      .finally(() => { this._routerClassifying = false; });
  }

  // Cierre de turno (v2, llamado desde _setStatus('waiting')): (1) restaura el
  // override efímero (el turno corrió en Haiku → vuelve al base); (2) escala por
  // INSUFICIENCIA para el PRÓXIMO turno si hubo evidencia (≥2 errores de tool, o
  // ≥10 tools con ≥1 error). NO re-corre el turno (auto-redo descartado, ver
  // núcleo). Cumple "detectar que el modelo no alcanzó y subir".
  _endTurnRouter() {
    // Guard PRIMERO (fix B3.3 2026-07-11): si el usuario forzó un modelo a mano
    // (modelChoice!=='auto') DURANTE un turno-override, no revertir esa elección
    // — antes la restauración del override corría antes del guard y pisaba el
    // modelo forzado (badge decía uno, corría otro).
    if (this.modelChoice !== 'auto') { this._overrideRestore = null; return; }
    if (this._overrideRestore) {
      const restore = this._overrideRestore;
      this._overrideRestore = null;
      if (this.model !== restore && MODEL_LEVELS.includes(restore)) {
        this.setModel(restore, { auto: true }); // volver del Haiku efímero al base
      }
    }
    const base = clampLevel(this.model);
    if (base === -1) return;
    const dec = insufficiencyEscalation({ baseLevel: base, toolCalls: this._turnToolCount, toolErrors: this._turnToolErrors });
    if (!dec) return;
    // F1+F2 (PEND-405): la insuficiencia es señal DURA (errores de tool ⇒ hace
    // falta capacidad) → salta de TIER, SALVO que el caché esté pegajoso: ahí
    // subir effort no desperdicia el prefijo cacheado (más barato en la ventana).
    // F4: con la ventana apretada, conservar (solo effort, nunca tier).
    const pressure = readWindowPressure();
    const conserve = typeof pressure === 'number' && pressure >= WINDOW_PRESSURE_CONSERVE;
    const axis = decideUpAxis({ hard: true, level: base, effortIndex: effortIdx(this.effort), lastCacheRead: this._lastCacheRead || 0, pinned: !!this._effortPinned, conserve });
    if (axis === 'effort') { this._bumpEffortAuto(+1); return; }
    if (axis === 'none') return;
    this._routerDownStreak = dec.downStreak;
    this._routerCooldown = dec.cooldown;
    const from = this.model;
    const next = MODEL_LEVELS[dec.level];
    if (next && next !== from) {
      this.setModel(next, { auto: true });
      logDecision({ chatId: this.id, sessionId: this.sessionId, source: 'insufficiency', from, to: next, text: `(${this._turnToolCount} tools, ${this._turnToolErrors} errores)` });
    }
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
  // (_startEngine ya lo lee para el próximo spawnRunner). `auto` (Fase 3):
  // true SOLO cuando lo llama el router de modelo (nunca el selector manual
  // ni /api/chat/model) — viaja en el evento 'model' para que el frontend
  // muestre el indicador "🤖 cambió solo" en vez de tratarlo como un cambio
  // pedido por la persona.
  setModel(model, { auto = false } = {}) {
    if (!VALID_MODELS.has(model)) return;
    // AutoTux v2 (C1): defensa en profundidad — el router NUNCA debe llevar a
    // fable solo. Un cambio MANUAL (auto:false, selector) a fable sigue OK.
    if (auto && FORBIDDEN_AUTO.has(model)) {
      logDecision({ chatId: this.id, sessionId: this.sessionId, source: 'guard', from: this.model, to: model, text: 'bloqueado: fable no es automático' });
      return;
    }
    // Eje thinking effort (PEND-391 #3): mantener el effort ALINEADO al tier del
    // modelo si la persona no lo fijó a mano. Es spawn-time (se aplica al próximo
    // arranque), así que no depende del eco del runner. Un modelo fuera de escala
    // (opusplan/default/fable) conserva el effort previo (effortForModel→null).
    if (!this._effortPinned) {
      const eff = effortForModel(model);
      if (eff && eff !== this.effort) { this.effort = eff; this._push({ type: 'effort', effort: eff, auto: true }); }
    }
    if (this.link) {
      this._pendingModelAuto.push(auto); // cola FIFO: lo consume el eco 'model' en orden (BUG-24)
      // El cambio real lo confirma el runner con su evento 'model'.
      this.link.send({ t: 'set_model', model });
    } else {
      this.model = model;
      this._push({ type: 'model', model, auto });
      this.onUpdate?.(); // persistir el nuevo modelo elegido
    }
  }

  // Fija la ELECCIÓN de la persona (AutoTux, pedido 2026-07-06): 'auto' deja
  // el router al mando (Fase 1-3, core/model-router.js) — modelChoice se
  // queda en 'auto' PARA SIEMPRE (el badge nunca deja de decir "AutoTux"
  // aunque `this.model` suba/baje por debajo). Cualquier otro valor FUERZA
  // ese único modelo real y apaga el router para esta conversación
  // (_applyModelRouter/_endTurnRouter chequean modelChoice antes
  // que nada). Es el único método que debería llamar el selector del menú
  // "Cambiar modelo" — setModel() de arriba sigue siendo el bajo nivel que
  // usa tanto este método como el propio router internamente.
  setModelChoice(choice) {
    if (choice === 'auto') {
      const wasAuto = this.modelChoice === 'auto';
      this.modelChoice = 'auto';
      this._push({ type: 'modelChoice', modelChoice: 'auto' });
      this.onUpdate?.();
      if (!wasAuto) {
        // Arranca desde el nivel actual si ya es uno gestionado; si no, un
        // punto de partida razonable (mismo criterio que el constructor).
        const start = MODEL_LEVELS.includes(this.model) ? this.model : 'sonnet';
        if (start !== this.model) this.setModel(start, { auto: true });
      }
      return;
    }
    if (!VALID_MODELS.has(choice)) return;
    this.modelChoice = choice;
    this._push({ type: 'modelChoice', modelChoice: choice });
    this.onUpdate?.();
    this.setModel(choice); // fuerza el modelo real — auto:false (elección manual)
  }

  // Fija el ESFUERZO de razonamiento (eje thinking effort, PEND-391 #3). El
  // effort es opción de SPAWN del Agent SDK (no hay q.setEffort en vivo — ver la
  // decisión de arquitectura en Pad), así que con motor VIVO el nuevo esfuerzo
  // se aplica en el PRÓXIMO arranque (Reabrir para cambios / dormir→despertar);
  // con motor dormido, directo en el próximo spawn. Fija _effortPinned para que
  // AutoTux no lo re-alinee al nivel del modelo. 'auto'/null DESFIJA (vuelve a
  // seguir el tier). Emite evento 'effort' para el badge del header/tarjeta.
  setEffort(effort) {
    if (effort === 'auto' || effort == null) {
      this._effortPinned = false;
      this.effort = effortForModel(this.model);
      // auto:true ⇒ el effort volvió a DERIVARSE del tier (no es un pin manual).
      this._push({ type: 'effort', effort: this.effort, auto: true });
      this.onUpdate?.();
      return;
    }
    if (!EFFORT_LEVELS.includes(effort)) return;
    this._effortPinned = true;
    this.effort = effort;
    this._push({ type: 'effort', effort, auto: false });
    this.onUpdate?.();
  }

  // F1+F2 (PEND-405): el router sube/baja el effort UN escalón (dir +1/-1) de
  // forma AUTOMÁTICA, respetando el techo AUTO ('high' — xhigh/max son manuales,
  // como fable en el eje modelo) y el piso 'low'. No toca si la persona lo fijó.
  // Es spawn-time; F3 (_maybeReopenForEffort) lo hace efectivo en vivo si aplica.
  _bumpEffortAuto(dir) {
    if (this._effortPinned) return;
    const cur = effortIdx(this.effort);
    if (cur < 0) return;
    let next = cur + dir;
    if (next > AUTO_EFFORT_MAX_IDX) next = AUTO_EFFORT_MAX_IDX;
    if (next < 0) next = 0;
    if (next === cur) return;
    const to = EFFORT_LEVELS[next];
    this.effort = to;
    this._push({ type: 'effort', effort: to, auto: true });
    logDecision({ chatId: this.id, sessionId: this.sessionId, source: 'effort', from: EFFORT_LEVELS[cur], to, text: dir > 0 ? '(caché-aware: subo effort en vez de saltar de tier)' : '(bajo effort antes que bajar de tier)' });
    this.onUpdate?.();
    this._maybeReopenForEffort(); // F3: aplicar en vivo si el motor está ocioso
  }

  // F3 (PEND-405): el effort es opción de SPAWN (el SDK no tiene setEffort en
  // vivo), así que para que un cambio de effort tome efecto YA reabrimos el
  // runner (respawn --resume, conserva contexto). SOLO si el motor está vivo y
  // OCIOSO (waiting) — nunca a mitad de turno (cortaría el trabajo) — y throttled
  // para no reabrir en ráfaga. Con motor dormido no hace falta: el próximo spawn
  // ya toma this.effort. Best-effort: si falla, el effort igual aplica al dormir.
  _maybeReopenForEffort() {
    if (!this.link || this.status === 'working') return; // dormido o en turno: se aplica al próximo spawn
    if (this._effortReopenAt && Date.now() - this._effortReopenAt < 30000) return; // throttle 30s
    this._effortReopenAt = Date.now();
    Promise.resolve().then(() => this.reopen()).catch(() => { /* best-effort: aplica al dormir */ });
  }

  close() {
    this.closed = true;
    // Conversación de un ticket: al finalizar queda el registro de qué hay que
    // cambiar en el código (resumen + archivos) para el PR posterior a Chris
    // (pestaña Salud). DIFERIDO 2s: el SDK puede tardar en flushear las últimas
    // líneas del transcript (verificado E2E: extraer en el instante del close
    // pierde el resumen). Best-effort: si el server muere en esa ventana, el
    // scan de la pestaña Salud lo recupera/completa.
    // (El registro de bugfix al cerrar un chat de ticket vivía en v1, ahora
    // archivado — ver import arriba.)
    //
    // HISTÓRICO DEL TRABAJO (2026-07-07, módulo tickets): si el chat trabajó un
    // ticket/PR (this.ticket.number: '123' o 'pr:<n>'), al cerrarlo guardamos un
    // resumen DETERMINÍSTICO de la sesión (archivos tocados + texto de cierre del
    // asistente, 0 tokens) en la metadata del ítem (meta-store, Pad local desde
    // ROAD-110 Fase 3/TASK-249) para que la PRÓXIMA sesión "Continuar en el chat"
    // traiga todo el historial y se pueda seguir con contexto. DIFERIDO 2s por la
    // misma razón que el resumen v1 (el SDK tarda en flushear el transcript).
    // appendHistorico es ahora ASYNC (habla con Pad local) pero sigue siendo
    // best-effort: su propio try/catch interno ya absorbe cualquier falla, y el
    // await de acá está protegido por el try/catch exterior por si algo
    // inesperado escapa (mismo patrón que appendLearningChatContext, abajo).
    if (this.ticket?.number && this.sessionId && !this._historicoDone) {
      this._historicoDone = true;
      const key = this.ticket.number;
      const cwd = this.cwd;
      const sid = this.sessionId;
      setTimeout(async () => {
        try {
          const work = extractSessionWork(cwd, sid);
          if (work) await appendHistorico(key, { sessionId: sid, resumen: work.summary, files: work.files });
        } catch (err) { console.error('[chat] no pude guardar histórico del ticket:', err?.message); }
      }, 2000).unref();
    }
    // WRITE-BACK de APRENDIZAJE (2026-07-10): si el chat nació de "💬 Profundizar
    // en chat" de un tema (this.learningId 'TDA-<n>' desde la migración a Pad
    // local, ROAD-110 Fase 2 / TASK-232 — antes 'LT<n>'), al cerrarlo agregamos
    // un resumen DETERMINÍSTICO de la sesión (0 tokens) como entrada 'chat' del
    // tema → aumenta su contexto para la próxima "Regenerar". Mismo patrón
    // diferido/best-effort que el histórico de tickets. Flag propio para no
    // colisionar con _historicoDone (un chat es de ticket O de tema, no ambos).
    // appendLearningChatContext es ahora ASYNC (habla con Pad local) pero sigue
    // siendo best-effort: su propio try/catch interno ya devuelve null ante
    // cualquier falla, y el await de acá está protegido por el try/catch
    // exterior por si algo inesperado escapa.
    if (this.learningId && this.sessionId && !this._learningDone) {
      this._learningDone = true;
      const lid = this.learningId;
      const cwd = this.cwd;
      const sid = this.sessionId;
      setTimeout(async () => {
        try {
          const work = extractSessionWork(cwd, sid);
          if (work) await appendLearningChatContext(lid, { summary: work.summary, files: work.files });
        } catch (err) { console.error('[chat] no pude guardar contexto de aprendizaje:', err?.message); }
      }, 2000).unref();
    }
    // MEJORA CONTINUA (ROAD-256): al cerrar CUALQUIER chat con sesión, encolar
    // la destilación de LECCIONES DE PROCESO (metodología/flujo) en un runner
    // desacoplado de TEXTO PURO (regla 6). GLOBAL (no solo ticket/tema): el
    // filtro híbrido dentro de queueRetroDistill descarta los chats triviales
    // (lee el transcript, 0 tokens). Best-effort, diferido 2s por la misma
    // razón que los write-backs de arriba (el SDK tarda en flushear el jsonl);
    // flag propio para no re-encolar dentro de la misma vida del proceso.
    if (this.sessionId && !this._retroDone) {
      this._retroDone = true;
      const cwd = this.cwd;
      const sid = this.sessionId;
      const title = this.title;
      const ticketNumber = this.ticket?.number || null;
      const learningId = this.learningId || null;
      setTimeout(() => {
        queueRetroDistill({ cwd, sessionId: sid, title, ticketNumber, learningId })
          .catch((err) => console.error('[chat] no pude encolar mejora continua:', err?.message));
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
    if (state === 'waiting') {
      this._delegatingIds.clear();
      this._delegatingSince = null;
      this._endTurnRouter(); // AutoTux v2: restaura override + escala por insuficiencia
      this._turnToolCount = 0;  // arranca en cero el conteo del próximo turno
      this._turnToolErrors = 0;
    }
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
      model: this.model, modelChoice: this.modelChoice, // para que el badge "🤖 AutoTux: X" nazca poblado
      effort: this.effort, effortPinned: !!this._effortPinned, // eje thinking effort (PEND-391 #3)
    }));
  }

  detach(ws) { this.clients.delete(ws); }

  info() {
    return {
      id: this.id, title: this.title, cwd: this.cwd, model: this.model, modelChoice: this.modelChoice,
      effort: this.effort, effortPinned: !!this._effortPinned, // eje thinking effort (PEND-391 #3)
      mode: this.permissionMode, status: this.status, alive: this.alive,
      sessionId: this.sessionId, viewMode: this.viewMode, terminalId: this.terminalId,
      // Motor Pac-Man: ¿hay un subagente Task corriendo ahora mismo? (ver
      // ui/pacman.js, estado 'delegating') — visible en /api/chat/list aunque
      // la pestaña del chat esté cerrada.
      delegating: this._delegatingIds.size > 0,
      // Cuántos subagentes Task/Agent en vuelo + desde cuándo (panel de Actividad
      // en Segundo Plano: ui/activity-widget.js / system/activity-modal.js).
      delegatingCount: this._delegatingIds.size,
      delegatingSince: this._delegatingSince,
      // Ticket/feature que trabaja este chat (si nació de un bug de Desk o de un
      // FEAT-n). Lo consume el panel "Bugs & Features" para pintar el Pac-Man de
      // actividad en la columna correcta sin abrir la pestaña del chat.
      ticketNumber: this.ticket?.number || null,
      // Permisos esperando respuesta: los consume el centro global de popups
      // (public/js/ui/perm-center.js) vía el poll de 8 s de /list.
      pendingPerms: this.pendingPerms(),
      // Mensajes del interfono esperando ser tomados por este chat: los consume
      // el centro global de interfono (public/js/ui/interfono-center.js).
      pendingInterfono: this.pendingInterfono(),
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

    // Watcher del INTERFONO: auto-entrega los mensajes a los chats ABIERTOS y
    // OCIOSOS (paridad con el nudge idle de la TUI). Los dormidos/ocupados NO
    // se despiertan solos (evita gastar tokens fantasma): quedan para el popup
    // global + botón "Retomar". Cadencia ~12 s (barato: solo lee el bus).
    setInterval(() => { try { this._deliverInterfono(); } catch { /* noop */ } }, INTERFONO_POLL_MS).unref();
  }

  // Recorre los chats y auto-entrega el interfono a los que están ABIERTOS
  // (algún cliente WS) y OCIOSOS (motor vivo, sin turno en curso). Un chat
  // trabajando espera a terminar; uno dormido o sin pestaña queda para el popup.
  _deliverInterfono() {
    for (const c of this.chats.values()) {
      if (c.closed || !c.sessionId || c.viewMode !== 'chat') continue;
      const open = c.clients.size > 0;
      const idle = c.alive && c.status === 'waiting';
      if (open && idle) {
        let msgs;
        try { msgs = bus.pendingFor([`claude:${c.sessionId}`]); } catch { continue; }
        if (msgs.length) c.deliverInterfono(msgs);
      } else if (open) {
        // Fase 3: chat ABIERTO pero ocupado/no-ocioso → NO auto-entregamos
        // (esperaría a terminar el turno), pero SÍ empujamos la señal EN VIVO
        // por _broadcast, que llega SOLO a las ventanas que tienen ESTE chat
        // abierto (c.clients ES el primitivo "rooms" server-side: nada de
        // broadcast global ni windowId). Las demás ventanas ni se enteran.
        c.signalInterfono();
      }
      // Chat dormido / sin pestaña: nada en vivo (0 tokens fantasma); su badge
      // pasivo en "Sesiones" lo cubre vía el poll de /api/chat/list.
    }
  }

  create({ cwd, model, permissionMode, resume = null, title = null, ticket = null, learningId = null }) {
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
    const chat = new Chat({ id, cwd, model, permissionMode, resume, title: uniqueName(base), ticket, learningId });
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
        learningId: c.learningId || null,
        // AutoTux: QUÉ ELIGIÓ la persona (separado de `model`, el real). Se
        // persiste explícito porque `model` solo no alcanza para distinguir
        // "elegí Sonnet a mano" de "AutoTux bajó a Sonnet" — ver constructor.
        modelChoice: c.modelChoice || null,
        // Eje thinking effort (PEND-391 #3): esfuerzo elegido/derivado + si la
        // persona lo FIJÓ a mano (para que AutoTux no lo re-alinee al nivel).
        effort: c.effort || null,
        effortPinned: !!c._effortPinned,
        // AutoTux v2 (core/model-router.js): el NIVEL se deriva de `model`
        // (arriba); esto es el estado MÍNIMO de histéresis — contador de turnos
        // "down" seguidos + turnos restantes de cooldown anti-rebote.
        routerDownStreak: c._routerDownStreak || 0,
        routerCooldown: c._routerCooldown || 0,
        // Modo TUI: la tmux oculta (cwct-) sobrevive reinicios del server, así
        // que persistimos lo necesario para RE-ADJUNTARLA al rehidratar.
        viewMode: c.viewMode === 'tui' ? 'tui' : 'chat',
        terminalId: c.viewMode === 'tui' ? c.terminalId : null,
      }));
    try {
      writeJsonAtomic(CHATS_FILE, open); // atómico (fix B3.3 2026-07-11): un writeFileSync directo cortado truncaba chats.json → rehydrate perdía TODAS las conversaciones abiertas
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
      if (/^TDA-\d+$/.test(String(s.learningId || ''))) chat.learningId = String(s.learningId);
      chat.lastActivity = s.lastActivity || Date.now();
      // AutoTux: restaurar la ELECCIÓN persistida tal cual (el constructor ya
      // infirió un valor razonable a partir de `model`, pero solo el campo
      // explícito distingue "elegí Sonnet a mano" de "AutoTux está en Sonnet
      // ahora" — chats viejos sin este campo se quedan con lo que infirió).
      if (s.modelChoice) chat.modelChoice = s.modelChoice;
      // Eje thinking effort: restaurar el effort persistido + si estaba fijado.
      if (EFFORT_LEVELS.includes(s.effort)) chat.effort = s.effort;
      chat._effortPinned = !!s.effortPinned;
      chat._routerDownStreak = Number.isFinite(s.routerDownStreak) ? s.routerDownStreak : 0;
      chat._routerCooldown = Number.isFinite(s.routerCooldown) ? s.routerCooldown : 0;
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
      const { cwd, model, permissionMode, resume, title, ticket, learningId } = req.body || {};
      // AutoTux (2026-07-06): 'auto' es un sentinel PROPIO de la consola —
      // nunca se le manda al CLI/SDK real (VALID_MODELS son los alias que sí
      // reconoce Claude Code). Sin `model` en el pedido, el default pasa a
      // ser 'auto' (antes quedaba null = "lo que decida el CLI"): AutoTux es
      // ahora el predeterminado de toda conversación nueva.
      if (model != null && model !== 'auto' && !VALID_MODELS.has(model)) {
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
        model: model || 'auto',
        permissionMode: permissionMode || 'default',
        resume: resume || null,
        title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : null,
        // Vínculo al bug de Desk: al cerrar la conversación deja el registro
        // del fix propuesto (módulo bugfixes).
        ticket: ticket?.number
          ? { number: String(ticket.number).slice(0, 40), url: /^https?:\/\//.test(ticket.url || '') ? String(ticket.url).slice(0, 400) : null }
          : null,
        // Vínculo a un tema de Aprendizaje: al cerrar el chat "Profundizar",
        // deja un resumen como entrada 'chat' del tema (write-back, módulo learning).
        learningId: /^TDA-\d+$/.test(String(learningId || '')) ? String(learningId) : null,
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
      chat.answerPermission(permId, !!req.body?.allow, sanitizeAnswers(req.body?.answers));
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

    // Cambia la ELECCIÓN de modelo de una conversación — AutoTux (router,
    // 'auto') o un modelo FORZADO (en vivo o para el próximo arranque).
    r.post('/model', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const model = req.body?.model;
      if (model !== 'auto' && !VALID_MODELS.has(model)) return res.status(400).json({ error: 'Modelo inválido.' });
      chat.setModelChoice(model);
      // Submenú modelo→esfuerzo (PEND-391 #3): el mismo POST puede fijar el
      // effort en la misma pasada. 'auto'/null DESFIJA (vuelve a seguir el tier
      // del modelo). setEffort se llama DESPUÉS de setModelChoice para que la
      // elección explícita del usuario gane sobre el re-alineo automático.
      const effort = req.body?.effort;
      if (effort !== undefined) {
        if (effort !== null && effort !== 'auto' && !EFFORT_LEVELS.includes(effort)) {
          return res.status(400).json({ error: 'Esfuerzo inválido.' });
        }
        chat.setEffort(effort);
      }
      manager.persist();
      res.json({ ok: true, chat: chat.info() });
    });

    // Métricas de calibración de AutoTux (PEND-391 #4, 0 tokens — solo lee el
    // jsonl de turnos): distribución por modelo, tasa de rebote y la auditoría
    // de caché (#2, switched vs notSwitched). Para calibrar el router con datos
    // reales sin re-parsear transcripts.
    r.get('/router-metrics', (req, res) => {
      try {
        const metrics = readTurnMetrics({ limit: Math.min(Number(req.query?.limit) || 4000, 20000) });
        // F5(b): sumamos el análisis de calibración (propuestas aprobables +
        // señales aprendidas gateadas por datos). 0 tokens, solo lee los jsonl.
        const calibration = req.query?.calibrate === '0' ? undefined : analyzeCalibration();
        res.json(calibration ? { ...metrics, calibration } : metrics);
      } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
    });

    // Consentimiento del juez AutoMix (D1): sube un escalón y reintenta el
    // último pedido. Lo dispara el botón "Reintentar en <modelo>" del banner.
    r.post('/redo', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const ok = chat.redo();
      if (!ok) return res.status(400).json({ error: 'No se puede reintentar (no es AutoTux o ya está en el modelo más fuerte).' });
      manager.persist();
      res.json({ ok: true, chat: chat.info() });
    });

    // Endpoint dedicado para fijar SOLO el esfuerzo (eje thinking effort). Útil
    // si la UI quiere cambiar el effort sin re-tocar el modelo.
    r.post('/effort', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const effort = req.body?.effort;
      if (effort !== null && effort !== 'auto' && !EFFORT_LEVELS.includes(effort)) {
        return res.status(400).json({ error: 'Esfuerzo inválido.' });
      }
      chat.setEffort(effort);
      manager.persist();
      res.json({ ok: true, chat: chat.info() });
    });

    // Reabre el motor de una conversación (mata el runner viejo y re-spawnea
    // uno fresco sobre la misma sesión) para que tome cambios de código nuevos.
    r.post('/reopen', async (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      let result;
      try {
        result = await chat.reopen();
      } catch (err) {
        console.error('[chat] /reopen falló:', err);
        return res.status(500).json({ error: 'No se pudo reabrir el motor (error interno).' });
      }
      if (!result.ok) return res.status(409).json({ error: result.error });
      manager.persist();
      res.json({ ok: true, chat: chat.info() });
    });

    // Interfono: el popup global responde acá. action='deliver' inyecta los
    // mensajes pendientes como un turno (despierta el chat si estaba dormido);
    // action='dismiss' los marca entregados sin actuar (limpia el aviso).
    r.post('/interfono', (req, res) => {
      const chat = manager.get(req.body?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const action = req.body?.action;
      if (action !== 'deliver' && action !== 'dismiss') {
        return res.status(400).json({ error: 'Acción inválida (deliver|dismiss).' });
      }
      const result = chat.consumeInterfono(action);
      if (!result.ok) return res.status(409).json({ error: result.error });
      res.json({ ok: true, chat: chat.info() });
    });

    // ===== ADJUNTOS del chat (imágenes, PDF, texto, binarios) =====
    // Subida de UN adjunto a la carpeta del chat (~/.cwc-data/chat-attachments/
    // <id>). multer escribe a disco con límite de tamaño DURANTE el streaming
    // (nunca buffea entero a memoria). El content del SDK lo arma el runner al
    // enviar el mensaje (chat/attachments.js). Sube el composer al elegir/pegar/
    // arrastrar; devuelve {name,type,mime,size} — la referencia que viaja luego.
    r.post('/attachment', (req, res) => {
      const chat = manager.get(req.query?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      attachUpload.single('file')(req, res, (err) => {
        if (err) {
          // Límites de multer (LIMIT_FILE_SIZE, etc.) y validaciones → 400;
          // fallas de disco (ENOSPC/EACCES) → 500.
          const code = (err.badRequest || (err.code && String(err.code).startsWith('LIMIT_'))) ? 400 : 500;
          return res.status(code).json({ error: err.message || 'No se pudo subir el adjunto.' });
        }
        if (!req.file) return res.status(400).json({ error: 'Falta el archivo.' });
        const name = req.file.filename;
        const mime = req.file.mimetype || '';
        res.json({ attachment: { name, type: classifyAttachment(mime, name), mime, size: req.file.size } });
      });
    });

    // Sirve un adjunto por nombre (miniaturas de la burbuja + "abrir en pestaña").
    // attachPath confina el nombre a la carpeta del chat (basename saneado +
    // padre exacto). Imágenes/PDF inline; el resto forzado a descarga; nosniff.
    r.get('/attachment', (req, res) => {
      const chat = manager.get(req.query?.id);
      if (!chat) return res.status(404).end();
      const name = String(req.query?.name || '');
      const abs = attachPath(req.query?.id, name);
      if (!abs) return res.status(404).end();
      const type = classifyAttachment('', name);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (type === 'image' || type === 'pdf') {
        res.type(path.extname(abs));
        res.setHeader('Content-Disposition', 'inline');
      } else {
        // Texto/binario: descarga forzada (nunca inline — evita servir HTML/SVG
        // activo con su tipo real, mismo criterio que el gestor de archivos).
        res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/["\r\n]/g, '_')}"`);
        res.type('application/octet-stream');
      }
      res.sendFile(abs);
    });

    // Asegura la carpeta de adjuntos del chat y devuelve su ruta RELATIVA al
    // home para el deep-link del Explorador ("Abrir carpeta del chat" del menú
    // ⋯ de Sesiones). Crearla si no existía deja la ventana lista aunque el
    // chat todavía no tenga adjuntos.
    r.get('/folder', (req, res) => {
      const chat = manager.get(req.query?.id);
      if (!chat) return res.status(404).json({ error: 'Conversación inexistente.' });
      const dir = chatAttachDir(chat.id);
      const rel = attachRelForExplorer(chat.id);
      if (!dir || !rel) return res.status(400).json({ error: 'Id inválido.' });
      try { fss.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
      catch { return res.status(500).json({ error: 'No se pudo crear la carpeta.' }); }
      res.json({ rel });
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
        if (msg.type === 'user' && typeof msg.text === 'string') {
          // Adjuntos: se validan contra la carpeta del chat (existingAttachments
          // filtra a los que existen en disco). Permite enviar solo-adjunto
          // (texto vacío) si hay al menos uno válido.
          const atts = existingAttachments(chat.id, msg.attachments);
          if (msg.text.trim() || atts.length) chat.sendUser(msg.text, atts);
        } else if (msg.type === 'permission_response') {
          chat.answerPermission(msg.id, !!msg.allow, sanitizeAnswers(msg.answers));
        } else if (msg.type === 'interrupt') {
          chat.interrupt();
        } else if (msg.type === 'set_mode') {
          chat.setMode(msg.mode);
        } else if (msg.type === 'set_model') {
          chat.setModelChoice(msg.model); // fix B3.3 2026-07-11: rutear por setModelChoice (valida 'auto'/VALID_MODELS + persiste modelChoice), igual que POST /api/chat/model — antes setModel directo dejaba modelChoice inconsistente
        }
      });
      ws.on('close', () => chat.detach(ws));
      ws.on('error', () => chat.detach(ws));
    });
  },
};
