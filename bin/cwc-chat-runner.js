#!/usr/bin/env node
// bin/cwc-chat-runner.js — motor de UNA conversación de chat, DESACOPLADO del server.
//
// Corre la query() del Agent SDK en un proceso PROPIO (el server lo lanza
// detached/setsid): si el server web crashea o se reinicia, el turno en curso
// SIGUE — requisito duro del proyecto. El server habla con el runner por un
// socket Unix (~/.cwc-data/chats/<id>.sock) con JSON por línea:
//
//   server->runner: {t:'hello'} · {t:'user',text} · {t:'perm',id,allow[,answers]}
//                   {t:'interrupt'} · {t:'set_mode',mode} · {t:'set_model',model}
//                   {t:'sleep'[,force]} · {t:'close'}
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
// Orden significativo: _env-boot debe ser el PRIMER import; no mover.
import { scrubEnvSecrets } from './_env-boot.js';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  PERMISSION_MODES, PERMISSION_TIMEOUT_MS, SLEEP_MS, BG_MAX_HOLD_MS, HISTORY_MAX,
  trim, toolSummary, toolDetail, resultText, makeInput,
} from '../src/modules/chat/shared.js';
import {
  chatQueryOptions, autoApprovesAll, tandemPreToolUseHook, tolkienEnvPreToolUseHook,
  lessonsPreToolUseHook, autonomyStopHook, mergeHookSets, isConsoleCwd,
  aduanaPadMcpServer, aduanaPadGuardHook,
} from '../src/core/tool-policy.js';
import {
  buildUserContent, chatAttachDir, safeAttachName, IMAGE_MIME,
} from '../src/modules/chat/attachments.js';
import { createCodexToolServer } from '../src/modules/chat/codex-tool.js';
import {
  CODEX_JOB_TERMINAL_STATUSES,
  listCodexJobs,
  readCodexJob,
} from '../src/modules/chat/codex-shared.js';
import { createUnifiToolServer } from '../src/modules/unifi/unifi-tool.js';
import { encodeCwd, resolveModelArg } from '../src/core/claude-model.js';
import { hostUser } from '../src/core/user-space.js';
import { worldLabelFor } from '../src/core/worlds.js';

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
let RESUME = args.resume || null;
// BUG-496: sessionId FORZADO — CREA la conversación con NUESTRO UUID (chat nuevo,
// durable desde el segundo cero) en vez de esperar al `system/init`. Exactamente
// uno con RESUME (el SDK prohíbe combinarlos sin forkSession). Lo decide el server.
let SESSION_ID = args['session-id'] || null;
// Eje thinking effort (PEND-391 #3): opción de SPAWN del Agent SDK (no hay
// setEffort() en vivo). Whitelist estricta; cualquier otro valor => sin effort
// (el SDK aplica el default del modelo). No confundir con 'auto'/'default' del
// selector de modelo (esos son alias de modelo, no niveles de effort).
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT = EFFORT_LEVELS.has(args.effort) ? args.effort : null;
// Modelo TÁNDEM (PLAN-507): Claude razona/planea, Codex ejecuta. En este modo se
// AGREGA la tool delegate_to_codex y se DENIEGAN las tools de escritura (abajo).
const TANDEM = args.tandem === '1';
// Entorno Tolkien efímero: hook instalado solo en spawns cuyo cwd es el Tolkien base.
const TOLKIEN_ENV_AUTO = args['tolkien-env-auto'] === '1';
// PLAN-519 F2: ejecutor Codex de Tándem configurable (modelo+esfuerzo). Sin arg
// = defaults de gama alta (createCodexToolServer valida contra su whitelist).
const CODEX_MODEL = args['codex-model'] || null;
const CODEX_EFFORT = args['codex-effort'] || null;
// Una delegación de Codex corre en su propio proceso y puede llegar al tope real
// CODEX_MAX_MS (60 min, en codex-shared.js). El SDK corta antes el stream si no
// lo subimos: invariante obligatorio, stream close > CODEX_MAX_MS.
if (TANDEM) process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '3900000';
// Herramientas de escritura que Tándem le niega a Claude: sin ellas, su único
// camino para tocar un archivo es delegate_to_codex → el split es estructural.
const TANDEM_BLOCKED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
if (!ID || !CWD || !SOCK) {
  console.error('[runner] uso: cwc-chat-runner --id <id> --cwd <abs> --sock <path> [--model m] [--mode m] [--resume uuid] [--effort low|medium|high|xhigh|max]');
  process.exit(2);
}
// ── Blindaje anticonsumo multi-tenant (PLAN-592/TASK-612): un runner de INQUILINO
// NUNCA debe caer por accidente en las creds del server (quemaría los tokens del
// admin). La única excepción es NOMINAL: --sponsored-by declara que el token del
// env fue prestado deliberadamente por ese sponsor. El HOME aislado sigue siendo
// obligatorio en ambos modos. Esta es la CAPA fail-closed de defensa en profundidad:
// si el aislamiento o la credencial esperada no llegaron, ABORTAMOS antes de query().
const OWNER = args.owner || null;
const SPONSORED_BY = args['sponsored-by'] || null;
const IS_TENANT = !!OWNER && OWNER !== hostUser();
if (IS_TENANT) {
  // El helper de env ya permitió que config.js capture la configuración del
  // host; desde acá el inquilino no debe conservar esos secretos en
  // process.env (su Bash puede leer /proc/self/environ y los hijos heredan).
  scrubEnvSecrets();
  const home = process.env.HOME || '';
  // El HOME del inquilino debe ser su root aislado: ~/.cwc-users/<owner>.
  const expected = path.sep + path.join('.cwc-users', OWNER);
  const isolatedHome = !!home && home.endsWith(expected);
  // En modo estándar debe existir una fuente PROPIA, exactamente como antes. En
  // modo patrocinado el token del env es prestado y obligatorio; no se acepta un
  // --sponsored-by vacío de credencial como atajo al archivo del server.
  const hasOwnCreds = !!process.env.CLAUDE_CODE_OAUTH_TOKEN
    || fs.existsSync(path.join(home, '.claude', '.credentials.json'));
  const hasSponsoredCreds = !!SPONSORED_BY && !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const credentialsValid = SPONSORED_BY ? hasSponsoredCreds : hasOwnCreds;
  if (!isolatedHome || !credentialsValid) {
    const credentialMode = SPONSORED_BY
      ? `patrocinado por ${SPONSORED_BY}, tokenPatrocinado=${hasSponsoredCreds}`
      : `estándar, credsPropias=${hasOwnCreds}`;
    console.error(`[runner] FAIL-CLOSED anticonsumo: inquilino ${OWNER} sin aislamiento válido (HOME=${home}, modo=${credentialMode}). No arranco para no usar una cuenta no autorizada.`);
    process.exit(3);
  }
}
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// cache_creation_input_tokens puede venir como número plano o como objeto
// {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens} según el modelo — lo
// normalizamos a un total (instrumentación de caché, PEND-391).
function normCacheCreate(cc) {
  if (cc == null) return 0;
  if (typeof cc === 'number') return cc;
  if (typeof cc === 'object') {
    return (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0);
  }
  return 0;
}

// Marca heredable: el claude del SDK (y sus hooks, ahora que settingSources
// carga la config del usuario) corren con esta env. El observador
// (cwc-observe.js) la usa para NO escribir estado de sesiones de chat en
// ~/.cwc-state: ese estado es SOLO de TUIs (sessionIdForCwd alimenta el
// traspaso TUI->Chat y no debe ver la sesión del propio chat); el chat ya
// reporta su estado por el socket del runner.
process.env.CWC_CHAT_RUNNER = '1';

// ---- estado ----
const startedAt = Date.now();
let sessionId = RESUME || SESSION_ID; // BUG-496: nace conocido (forzado o retomado)
let slashCommands = []; // lista del system/init (depende del cwd; Fase 8)
let status = 'waiting';
let lastActivity = Date.now();
const bgWork = new Map(); // taskId -> { id, kind, label, startedAt }
const recentToolUse = new Map(); // toolUseId -> { name, summary, desc }
let lastBgLaunch = 0;
let lastBgHoldLog = 0;
let closedByUser = false;
let exiting = false;
const history = []; // eventos de UI de ESTA vida del motor (para replay al reconectar)
const clients = new Set();
const pendingPerms = new Map(); // permId -> { resolve, timer, input }
let permSeq = 0;
let autonomyTurns = 0; // continuaciones desde el último mensaje humano

function writeTo(c, obj) {
  try { c.write(`${JSON.stringify(obj)}\n`); } catch { /* cliente roto */ }
}

// Evento de UI: se guarda en el historial (para el hello de una reconexión)
// y/o se emite en vivo a los servers conectados.
// Imágenes que DEVUELVE una herramienta (p.ej. Read de un PNG, un screenshot
// de Playwright): el SDK las entrega como bloques `image` base64 dentro del
// tool_result. Las materializamos en la MISMA carpeta de adjuntos del chat que
// usan los archivos que sube el usuario (dirección asistente→humano, mismo
// flujo que los adjuntos) y devolvemos SOLO la referencia {name,type,mime} — el
// base64 NUNCA viaja por el WS (pesado); el front pide la miniatura a
// GET /api/chat/attachment. Best-effort: cualquier falla no rompe el turno.
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TOOL_IMG_MAX = 4;                        // imágenes materializadas por tool_result
const TOOL_IMG_BYTES_MAX = 12 * 1024 * 1024;   // 12 MB por imagen (tope defensivo)
let toolImgSeq = 0;

function saveToolImages(content, toolUseId) {
  if (!Array.isArray(content)) return null;
  const dir = chatAttachDir(ID);
  if (!dir) return null;
  const out = [];
  for (const b of content) {
    if (out.length >= TOOL_IMG_MAX) break;
    if (b?.type !== 'image' || b?.source?.type !== 'base64') continue;
    const mime = IMAGE_MIME[String(b.source.media_type || '').toLowerCase()];
    const ext = mime && MIME_EXT[mime];
    if (!ext) continue;
    let buf;
    try { buf = Buffer.from(b.source.data || '', 'base64'); } catch { continue; }
    if (!buf.length || buf.length > TOOL_IMG_BYTES_MAX) continue;
    toolImgSeq += 1;
    const safeId = String(toolUseId || 'tool').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'tool';
    const name = safeAttachName(`asst-${safeId}-${toolImgSeq}.${ext}`);
    if (!name) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
      out.push({ name, type: 'image', mime });
    } catch { /* best-effort: si no se pudo escribir, seguimos sin miniatura */ }
  }
  return out.length ? out : null;
}

function emit(event, { record = true, broadcast = true } = {}) {
  if (record) {
    history.push(event);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  }
  if (broadcast) for (const c of clients) writeTo(c, { t: 'event', event });
}

function bgList() { return [...bgWork.values()]; }
function bgLiveCount() { return bgList().filter((b) => !b.ready).length; }
function emitBg() { emit({ type: 'bg', tasks: bgList() }, { record: false }); }

// El radar reúne DOS fuentes: subagentes/workflows del SDK detectados por su
// salida, y delegaciones a Codex avisadas por callbacks desde la tool.
function bgAdd({ id, kind, label, startedAt = Date.now() }) {
  bgWork.set(id, { id, kind, label, startedAt });
  lastBgLaunch = Date.now();
  emitBg();
}

function bgDone(id) {
  if (!bgWork.delete(id)) return false;
  emitBg();
  return true;
}

// Retiene el motor mientras haya trabajo de fondo vivo (PLAN-892), con tope
// para no volverlo inmortal si una tarea queda colgada.
function bgHolds() { return bgLiveCount() > 0 && (Date.now() - lastBgLaunch) < BG_MAX_HOLD_MS; }

// Nota VISIBLE si el motor se duerme/cierra con trabajo de fondo vivo: sin
// esto el chat queda diciendo "corriendo" para siempre (el SDK no deja marcador).
function warnBgKilled() {
  if (!bgWork.size) return;
  // Un resultado listo sigue en el radar para que lo recojan, pero ya no es
  // trabajo en curso y no debe producir una advertencia que diga lo contrario.
  const work = bgList().filter((b) => !b.ready);
  const codex = work.filter((b) => b.kind === 'Codex');
  const sdk = work.filter((b) => b.kind !== 'Codex');
  if (codex.length) {
    const labels = codex.map((b) => b.label).join(' · ');
    emit({ type: 'error', message: `⚠️ El motor se durmió con ${codex.length} delegación(es) a Codex en curso — siguen corriendo en su propio proceso: ${labels}. Recuperá el resultado con collect_codex.` });
  }
  if (sdk.length) {
    const labels = sdk.map((b) => b.label).join(' · ');
    emit({ type: 'error', message: `⚠️ El motor se durmió con ${sdk.length} trabajo(s) en segundo plano en curso — se cortaron: ${labels}. Volvé a lanzarlos si hacen falta.` });
  }
  bgWork.clear();
  emitBg();
}

function logBgHold(message) {
  const now = Date.now();
  if (now - lastBgHoldLog < 10 * 60 * 1000) return;
  lastBgHoldLog = now;
  log(message);
}

// Dos formatos REALES de lanzamiento en segundo plano (verificados en vivo):
// el tool Workflow anuncia "launched in background. Task ID: <id>"; el tool
// Agent (subagente asincrono, el caso mas comun) anuncia "Async agent
// launched successfully" + "agentId: <id>". Los DOS cierran despues con el
// mismo bloque <task-notification>, asi que solo cambia la deteccion de alta.
const BG_LAUNCH_RE = /launched in background\.\s*Task ID:\s*([A-Za-z0-9_-]+)/i;
const BG_AGENT_RE = /Async agent launched successfully[\s\S]*?\bagentId:\s*([A-Za-z0-9_-]+)/i;
const TASK_NOTIFICATION_RE = /<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/gi;
const TRANSCRIPT_SWEEP_TAIL_BYTES = 256 * 1024;
const CODEX_HEARTBEAT_EXPIRED_MS = 90 * 1000;

function bgLaunchId(out) {
  return (BG_LAUNCH_RE.exec(out)?.[1]) || (BG_AGENT_RE.exec(out)?.[1]) || null;
}

function firstTagText(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(xml);
  return match ? match[1].trim() : null;
}

// El SDK escribe el <task-notification> de fin en el transcript apenas el
// trabajo termina, pero sólo lo ENTREGA al stream en el próximo turno (lo
// encola). Sin esto un trabajo ya terminado seguiría "vivo" en el radar y
// retendría el motor despierto hasta el tope. Leemos la MISMA señal de disco.
function sweepBgFromTranscript() {
  if (bgWork.size <= 0 || !sessionId) return;
  let fd;
  try {
    const transcript = path.join(os.homedir(), '.claude', 'projects', encodeCwd(CWD), `${sessionId}.jsonl`);
    fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_SWEEP_TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8').replace(/\\n/g, '\n');
    let removed = 0;
    TASK_NOTIFICATION_RE.lastIndex = 0;
    let note;
    while ((note = TASK_NOTIFICATION_RE.exec(text))) {
      const id = firstTagText(note[0], 'task-id');
      const statusText = firstTagText(note[0], 'status');
      if (!id || !statusText || !bgWork.has(id)) continue;
      if (bgDone(id)) removed += 1;
    }
    if (removed > 0) log(`barrido de transcript: ${removed} trabajo(s) de fondo cerrado(s)`);
  } catch {
    // Best-effort: el transcript puede no existir todavía o estar rotando.
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* noop */ } }
  }
}

// Codex persiste el estado real aunque el agente no recoja el job por id. El
// resultado queda visible para recordar que falta recogerlo, pero deja de
// contar como trabajo vivo apenas el store confirma que terminó.
function sweepCodexBg() {
  if (!TANDEM || bgWork.size === 0) return;
  try {
    let changed = 0;
    for (const [id, work] of bgWork) {
      if (work.kind !== 'Codex') continue;
      const job = readCodexJob(id);
      if (!job || !CODEX_JOB_TERMINAL_STATUSES.includes(job.status)) continue;
      if (work.ready && work.outcome === job.status) continue;
      work.ready = true;
      work.readyAt ||= Date.now();
      work.outcome = job.status;
      changed += 1;
    }
    if (changed > 0) emitBg();
  } catch {
    // Best-effort: el job puede desaparecer o estar reemplazándose al leerlo.
  }
}

function bgLabelFromOutput(out) {
  const lines = String(out || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    // El formato real del SDK trae `Summary:` y el texto en la MISMA línea; si
    // alguna versión vuelve a dejarlo vacío, conservamos el fallback a la línea
    // siguiente no vacía para no perder el label del trabajo.
    const m = /^\s*Summary:\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) return inline.slice(0, 120);
    for (let j = i + 1; j < lines.length; j += 1) {
      const label = lines[j].trim();
      if (label) return label.slice(0, 120);
    }
  }
  return null;
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
let sawInit = false;
let lastUserPush = null;

// El HOME de ESTE proceso es el del DUEÑO (multi-tenant), así que es la única
// autoridad sobre dónde vive el transcript; el server puede haber elegido mal
// --session-id vs --resume porque resuelve la ruta contra su propio HOME.
function reconcileSessionArgs() {
  const sid = RESUME || SESSION_ID;
  if (!sid) return;
  let exists = false;
  try {
    exists = fs.existsSync(path.join(os.homedir(), '.claude', 'projects', encodeCwd(CWD), `${sid}.jsonl`));
  } catch { return; } // sin certeza, respetamos lo que decidió el server
  if (exists && !RESUME) {
    RESUME = sid; SESSION_ID = null;
    log(`la sesión ${sid} YA tiene transcript en este HOME: corrijo --session-id -> --resume`);
  } else if (!exists && !SESSION_ID) {
    SESSION_ID = sid; RESUME = null;
    log(`la sesión ${sid} no tiene transcript en este HOME: corrijo --resume -> --session-id`);
  }
}

function startEngine() {
  // Opciones armadas por el NÚCLEO de gobernanza (core/tool-policy.js): fuente
  // única que garantiza `allowDangerouslySkipPermissions` para que el modo
  // "Todo" (bypassPermissions) realmente saltee permisos. Ver ese archivo.
  const mcpServers = {};
  const isAduana = worldLabelFor(CWD) === 'Aduana';
  if (TANDEM) {
    mcpServers.codex = createCodexToolServer({
      cwd: CWD,
      model: CODEX_MODEL,
      effort: CODEX_EFFORT,
      chatDir: chatAttachDir(ID),
      chatId: ID,
      onBgStart: ({ id, kind, label }) => bgAdd({ id, kind, label }),
      onBgEnd: (id) => bgDone(id),
    });
  }
  try {
    if (isConsoleCwd(CWD)) mcpServers.unifi = createUnifiToolServer();
  } catch (e) {
    console.error('[runner] no se pudo cargar la tool unifi:', e?.message);
  }
  if (isAduana) {
    const padServer = aduanaPadMcpServer();
    if (padServer) mcpServers.pad = padServer;
  }
  const hookSets = [];
  if (TANDEM) hookSets.push(tandemPreToolUseHook());
  if (isAduana) hookSets.push(aduanaPadGuardHook());
  if (TOLKIEN_ENV_AUTO) {
    hookSets.push(tolkienEnvPreToolUseHook({
      onNeed: () => emit({ type: 'tolkien-env-needed', chatId: ID }, { record: false }),
    }));
  }
  // M5 (PLAN-1934): gate DURO de lecciones prohibitivas. Va en TODO chat —
  // cualquier modelo, cualquier mundo — porque "nunca ejecutes X" no depende del
  // modo. Ver src/core/forbidden-actions.js y bin/cwc-forbidden-override.js.
  hookSets.push(lessonsPreToolUseHook({
    chatId: ID,
    onDeny: (rule) => log(`acción prohibida por lección DENEGADA (${rule.id})`),
    onOverride: (rule, grant) => log(`override consciente aplicado a ${rule.id} (${grant.id}: ${grant.motivo})`),
  }));
  hookSets.push(autonomyStopHook({
    onContinue: () => {
      autonomyTurns += 1;
      emit({ type: 'autonomy', turn: autonomyTurns }, { record: false });
      log(`continuación autónoma #${autonomyTurns}`);
    },
  }));
  const mergedHooks = mergeHookSets(...hookSets);
  q = query({
    prompt: input.gen(),
    options: chatQueryOptions({
      cwd: CWD,
      model: resolveModelArg(MODEL),
      resume: RESUME,
      sessionId: SESSION_ID, // BUG-496: primer arranque de un chat nuevo (excluye resume)
      mode,
      effort: EFFORT,
      chatId: ID, // regla de carpeta de trabajo del paquete-sesión (PLAN-447)
      // Modelo TÁNDEM: instrucción + tool de Codex in-process (PLAN-507).
      tandem: TANDEM,
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(mergedHooks ? { hooks: mergedHooks } : {}),
      canUseTool: (toolName, toolInput, ctx) => askPermission(toolName, toolInput, ctx),
    }),
  });
}

function onMessage(m) {
  lastActivity = Date.now();
  if (m.type === 'system' && m.subtype === 'init') {
    sawInit = true;
    sessionId = m.session_id || sessionId;
    // Los comandos slash disponibles (built-ins + skills + custom del cwd)
    // vienen SOLO en el init: la lista del init es la fuente de verdad.
    if (Array.isArray(m.slash_commands)) slashCommands = m.slash_commands;
    currentModel = m.model || MODEL;
    // El runner es la fuente de verdad de su propio flag de spawn.
    emit({ type: 'init', chatId: ID, sessionId, model: currentModel, cwd: CWD, mode, tandem: TANDEM }, { record: false });
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
        const summary = toolSummary(b.name, b.input);
        recentToolUse.set(b.id, {
          name: b.name,
          summary,
          // El tool Agent trae una descripcion corta y humana en el input; es
          // mejor etiqueta que el resumen JSON del tool para el radar de fondo.
          desc: (typeof b.input?.description === 'string' && b.input.description.trim())
            || (typeof b.input?.name === 'string' && b.input.name.trim())
            || null,
        });
        if (recentToolUse.size > 50) recentToolUse.delete(recentToolUse.keys().next().value);
        emit({
          type: 'tool_use', id: b.id, name: b.name,
          summary,
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
          const images = saveToolImages(b.content, b.tool_use_id);
          const out = trim(resultText(b.content), 2000);
          emit({
            type: 'tool_result', id: b.tool_use_id, ok: !b.is_error,
            output: out,
            ...(images ? { images } : {}),
          });
          const bgId = bgLaunchId(out);
          if (bgId && !b.is_error) {
            const recent = recentToolUse.get(b.tool_use_id);
            const id = bgId;
            const kind = recent?.name || 'Task';
            const label = (bgLabelFromOutput(out) || recent?.desc || recent?.summary || kind).slice(0, 120);
            // Limitacion conocida: SendMessage a un agente reanudado no emite
            // una nueva alta, asi que no se re-registra; la notificacion previa
            // ya lo dio por cerrado y el peor caso queda igual que antes.
            bgAdd({ id, kind, label });
          }
        }
      }
    } else if (typeof blocks === 'string') {
      for (const note of blocks.matchAll(TASK_NOTIFICATION_RE)) {
        const id = firstTagText(note[0], 'task-id');
        const statusText = firstTagText(note[0], 'status');
        if (!id || !statusText || !bgWork.has(id)) continue;
        bgDone(id);
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
      // Instrumentación de caché de prompt (PEND-391 / auditoría #2): propagamos
      // los tokens de caché que el SDK reporta por turno (antes se descartaban).
      // El chat los usa para MEDIR si el switch de modelo invalida el caché
      // (cambiar de modelo => cache_read cae a 0 / cache_creation sube el turno
      // siguiente) y si el closing-ack→Haiku da AHORRO NEGATIVO. cache_creation
      // llega como objeto {ephemeral_5m,ephemeral_1h} en algunos modelos o como
      // número plano — normalizamos a total sumando lo que haya.
      usage: m.usage ? {
        input: m.usage.input_tokens,
        output: m.usage.output_tokens,
        cacheCreate: normCacheCreate(m.usage.cache_creation_input_tokens),
        cacheRead: m.usage.cache_read_input_tokens ?? 0,
      } : null,
      ms: m.duration_ms ?? null,
    });
  }
}

function askPermission(toolName, toolInput, ctx) {
  // BLOQUEO ESTRUCTURAL DE TÁNDEM (PLAN-507): en este modo Claude no edita
  // código — se le niega Edit/Write/MultiEdit/NotebookEdit SIN tarjeta (auto-deny
  // silencioso) para forzarlo a delegar en Codex vía delegate_to_codex. El
  // `message` le explica al modelo por qué y qué usar en su lugar. Esto es lo
  // que GARANTIZA el split (una tool solo "disponible" podría ser ignorada).
  // Defensa en profundidad: la capa autoritativa ahora es PreToolUse, porque
  // canUseTool queda shadoweado por bypassPermissions y por allow-rules del usuario.
  if (TANDEM && TANDEM_BLOCKED.has(toolName)) {
    return Promise.resolve({
      behavior: 'deny',
      message: 'Modo Tándem: Claude no edita archivos. Usá la herramienta delegate_to_codex con un plan concreto para que Codex haga el cambio.',
    });
  }
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

let sessionRetried = false;

async function pump() {
  for (;;) {
    try {
      for await (const m of q) onMessage(m);
      break;
    } catch (err) {
      const msg = String(err?.message || err);
      // El CLI rechaza el id (ya existe, o no existe): es un error de ARRANQUE,
      // no del turno. Reintentamos UNA vez con el modo opuesto en vez de dejar
      // la conversación muerta para siempre.
      const collision = /Session ID .* is already in use/i.test(msg);
      const missing = /No conversation found with session ID/i.test(msg);
      if (!sessionRetried && !sawInit && (collision || missing)) {
        sessionRetried = true;
        const sid = RESUME || SESSION_ID;
        if (collision) { RESUME = sid; SESSION_ID = null; } else { SESSION_ID = sid; RESUME = null; }
        log(`arranque rechazado (${msg.slice(0, 120)}): reintento con ${RESUME ? '--resume' : '--session-id'}`);
        // El motor nunca llegó al init, así que ese turno no se procesó: si el
        // SDK ya se llevó el mensaje de la cola, lo reponemos para no perderlo.
        if (lastUserPush && input.size() === 0) input.push(lastUserPush);
        startEngine();
        continue;
      }
      emit({ type: 'error', message: msg.slice(0, 400) });
      log('motor con error:', err?.message || err);
      break;
    }
  }
  for (const [, p] of pendingPerms) p.resolve({ behavior: 'deny', message: 'Conversación cerrada.' });
  pendingPerms.clear();
  // Anuncia la muerte del motor y sale: el runner ES una vida del motor.
  emit({ type: 'closed', resumable: !closedByUser && !!sessionId }, { record: false });
  shutdown(0);
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
    // El runner es la fuente de verdad de su propio flag de spawn.
    writeTo(c, { t: 'hello', id: ID, sessionId, model: currentModel, mode, status, startedAt, slashCommands, tandem: TANDEM, bgTasks: bgList(), events: history });
    return;
  }
  if (msg.t === 'user' && typeof msg.text === 'string'
      && (msg.text.trim() || (Array.isArray(msg.attachments) && msg.attachments.length))) {
    lastActivity = Date.now();
    autonomyTurns = 0;
    setStatus('working');
    // Va al historial (para el replay de una reconexión) pero NO en vivo: el
    // server que lo mandó ya lo pintó localmente. Los adjuntos viajan como
    // REFERENCIA {name,type,mime} (no base64): la burbuja de replay pinta la
    // miniatura pidiéndola por nombre a GET /api/chat/attachment.
    const atts = Array.isArray(msg.attachments) ? msg.attachments : null;
    emit({ type: 'user', text: msg.text, ...(atts && atts.length ? { attachments: atts } : {}) }, { broadcast: false });
    // content = string sin adjuntos (camino histórico) o array de bloques
    // image/document/text según el tipo de cada archivo (attachments.js LEE el
    // disco y arma los bloques de visión / inline / referencia).
    const userPush = {
      type: 'user',
      message: { role: 'user', content: buildUserContent(ID, msg.text, atts) },
      parent_tool_use_id: null,
      session_id: sessionId || '',
    };
    lastUserPush = userPush;
    input.push(userPush);
    return;
  }
  if (msg.t === 'perm') {
    const p = pendingPerms.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingPerms.delete(msg.id);
    // AskUserQuestion: la RESPUESTA elegida viaja en msg.answers (mapa
    // texto-de-pregunta -> label elegido; multiSelect = labels con coma) y se
    // materializa en el updatedInput.answers que el SDK pasa a la tool. Para el
    // resto de tools, updatedInput sigue siendo el input original.
    const updatedInput = (msg.answers && typeof msg.answers === 'object')
      ? { ...p.input, answers: msg.answers }
      : p.input;
    p.resolve(msg.allow
      ? { behavior: 'allow', updatedInput }
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
    Promise.resolve(q?.setModel?.(resolveModelArg(msg.model))).then(() => {
      currentModel = msg.model;
      emit({ type: 'model', model: currentModel });
    }).catch((err) => {
      emit({ type: 'error', message: `No se pudo cambiar el modelo: ${String(err?.message || err).slice(0, 200)}` });
    });
    return;
  }
  if (msg.t === 'sleep' || msg.t === 'close') {
    if (msg.t === 'sleep' && !msg.force && bgHolds()) {
      logBgHold(`sueño rechazado: ${bgLiveCount()} trabajo(s) de fondo vivo(s)`);
      return;
    }
    if (msg.t === 'close') closedByUser = true;
    log(msg.t === 'close' ? 'cierre pedido por el server' : 'sueño pedido por el server');
    if (bgWork.size > 0) warnBgKilled();
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

function rehydrateCodexBg() {
  if (!TANDEM) return;
  try {
    const now = Date.now();
    let recovered = 0;
    for (const job of listCodexJobs(ID)) {
      if (!['pending', 'running'].includes(job.status)) continue;
      const heartbeatExpired = job.status === 'running'
        && now - Number(job.heartbeatAt || 0) > CODEX_HEARTBEAT_EXPIRED_MS;
      if (heartbeatExpired) continue;
      bgAdd({
        id: job.id,
        kind: 'Codex',
        label: job.label,
        startedAt: job.startedAt,
      });
      recovered += 1;
    }
    log(`radar Tándem rehidratado: ${recovered} delegación(es) a Codex recuperada(s)`);
  } catch (err) {
    log('no se pudo rehidratar el radar de Codex (continúo igual):', err?.message || err);
  }
}

// La auto-siesta: sin actividad por SLEEP_MS, el motor se cierra solo (aunque
// el server no exista para pedírselo). El pump termina y el proceso sale.
setInterval(() => {
  if (Date.now() - lastActivity > SLEEP_MS) {
    sweepBgFromTranscript();
    sweepCodexBg();
    if (bgHolds()) {
      logBgHold(`siesta pospuesta: ${bgLiveCount()} trabajo(s) de fondo vivo(s)`);
      return;
    }
    if (bgWork.size > 0) warnBgKilled();
    log('auto-sueño por inactividad');
    input.end();
    Promise.resolve(q?.close?.()).catch(() => {});
  }
}, 60 * 1000).unref();

setInterval(() => {
  sweepBgFromTranscript();
  sweepCodexBg();
}, 20 * 1000).unref();

process.on('SIGTERM', () => { input.end(); Promise.resolve(q?.close?.()).catch(() => {}); });

fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
await claimSocket();
rehydrateCodexBg();
server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600); } catch { /* noop */ }
  log(`runner ${ID} escuchando en ${SOCK} (cwd=${CWD}, resume=${RESUME || 'nueva'})`);
});
reconcileSessionArgs();
startEngine();
pump();
