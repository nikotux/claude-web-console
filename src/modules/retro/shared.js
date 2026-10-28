// modules/retro/shared.js — MEJORA CONTINUA (ROAD-256): lógica COMPARTIDA entre
// el server (que encola al cerrar un chat) y el runner desacoplado
// bin/cwc-retro-runner.js. Destila LECCIONES DE PROCESO (metodología, flujo,
// instrucciones) de la transcripción de un chat — NO bugs de código.
//
// Patrón calcado de audio/shared.js (job file-based determinístico + spawn
// detached + staleness pasiva). REGLA DE ORO: todo lo que corre en el tiempo va
// en el runner desacoplado; acá solo va el filtro determinístico (0 tokens, lee
// el transcript) + la plomería del job. NO importa el SDK; el runner carga este
// archivo y resuelve su data dir desde el CWC_DATA_DIR aislado de su dueño.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { encodeCwd } from '../../core/claude-model.js';
import {
  retroClaudeDirFor, retroDataDirFor, retroHostUser, retroRunnerEnvFor,
} from './owner-dirs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'bin', 'cwc-retro-runner.js');

export const RETRO_TIMEOUT_MS = 4 * 60 * 1000;
export const RETRO_STALE_MS = RETRO_TIMEOUT_MS + 30 * 1000;
// BUG-1930: limita el prompt (275 lecciones rondan 25 KB solo en títulos).
// El caller debe priorizar bien: si deja promovidas fuera de esta ventana, el
// medidor de efectividad pierde recurrencias y queda ciego.
export const RETRO_DEDUP_LIMIT = 120;
// El pozo comparte el mismo presupuesto: las propias mandan porque son las que
// el usuario ve en su tablero, pero cada lista le presta a la otra su sobrante.
export const RETRO_DEDUP_LIMIT_OWN = 90;
export const RETRO_DEDUP_LIMIT_POOL = 30;
const MAX_CONTEXT = 60 * 1000;   // tope del texto condensado que viaja al modelo
const MAX_TRANSCRIPT_FILES = 40;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_USER_TURNS = 3;        // filtro híbrido: menos que esto y sin código tocado ⇒ trivial, no se destila
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ===== Job file-based (server escribe 'running', runner escribe 'done') =====
function dataDirFor(owner = null) {
  return retroDataDirFor(owner);
}
export function retroJobsDirFor(owner = null) {
  return path.join(dataDirFor(owner), 'retro');
}
function jobPath(id, owner = null) { return path.join(retroJobsDirFor(owner), `${id}.json`); }
function ensureDir(owner = null) { fs.mkdirSync(retroJobsDirFor(owner), { recursive: true, mode: 0o700 }); }
function logFileFor(owner = null) { return path.join(dataDirFor(owner), 'retro.log'); }
export function retroJobId(sessionId) {
  return crypto.createHash('sha1').update(String(sessionId || '')).digest('hex').slice(0, 24);
}

export function readRetroJob(id, owner = null) {
  try { return JSON.parse(fs.readFileSync(jobPath(id, owner), 'utf8')); }
  catch { return null; }
}

export function writeRetroJob(id, data, owner = null) {
  ensureDir(owner);
  writeJsonAtomic(jobPath(id, owner), data);   // tmp por-PID: server y runner escriben el mismo archivo
  pruneOldJobs(owner);
}

function pruneOldJobs(owner = null) {
  const dataDir = retroJobsDirFor(owner);
  let files = [];
  try { files = fs.readdirSync(dataDir); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dataDir, f);
    try { if (now - fs.statSync(full).mtimeMs > MAX_AGE_MS) fs.unlinkSync(full); }
    catch { /* noop */ }
  }
}

export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= RETRO_STALE_MS;
}
export function jobResult(job) {
  if (!job) return { status: 'none', result: null, error: null };
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', result: null, error: 'La destilación no respondió a tiempo (el runner se interrumpió).' };
  }
  return { status: job.status, result: job.result || null, error: job.error || null };
}

// ===== Spawn desacoplado (regla de oro) =====
export function spawnRetroRunner(id, owner = null) {
  ensureDir(owner);
  const logFile = logFileFor(owner);
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  let logFd = null;
  try {
    logFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [RUNNER, id], {
      detached: true, stdio: ['ignore', logFd, logFd],
      env: retroRunnerEnvFor(owner, { missingOauthMessage: 'Necesitás conectar tu cuenta de Claude para destilar la sesión.' }),
    });
    child.on('error', (err) => {
      try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] spawn FAIL job ${id}: ${err?.message || err}\n`); }
      catch { /* noop */ }
      try {
        const job = readRetroJob(id, owner);
        if (job && job.status === 'running') {
          writeRetroJob(id, { ...job, status: 'error', result: null, error: 'No se pudo iniciar el runner de mejora continua.', updatedAt: Date.now() }, owner);
        }
      } catch { /* noop */ }
    });
    child.unref();
  } finally {
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* noop */ } }
  }
}

// ===== Lectura + condensado determinístico del transcript (0 tokens) =====
function relOf(cwd, fp) {
  try { return path.isAbsolute(fp) ? path.relative(cwd, fp) : fp; } catch { return fp; }
}
function clampMiddle(s, max) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[recorte del medio]…\n${s.slice(s.length - tail)}`;
}

// Lee el jsonl del transcript de la sesión y arma: turnos reales del usuario,
// archivos tocados por herramientas de edición, y un texto CONDENSADO
// (usuario/asistente/marcadores de tool) para alimentar la destilación.
export function readTranscript(cwd, sessionId, claudeDir = null, owner = null) {
  // En multi-tenant, el .claude es el del DUEÑO. El llamador puede pasarlo ya
  // resuelto; si no, se deriva con el resolver aislado del dueño.
  const base = claudeDir || retroClaudeDirFor(owner);
  const file = path.join(base, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);
  let userTurns = 0;
  const files = new Set();
  const parts = [];
  for (const ln of lines) {
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    const m = o.message;
    if (o.type === 'user' && m) {
      const c = m.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        if (c.some((b) => b?.type === 'tool_result')) continue; // respuesta de herramienta, no turno humano
        text = c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
      }
      text = String(text || '').trim();
      if (!text || text.startsWith('<')) continue; // vacío o inyección sintética (hooks/interfono)
      userTurns += 1;
      parts.push(`👤 ${text}`);
    } else if (o.type === 'assistant' && m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'text' && b.text) parts.push(`🤖 ${String(b.text).trim()}`);
        else if (b?.type === 'tool_use') {
          parts.push(`[🔧 ${b.name}]`);
          if (EDIT_TOOLS.has(b.name)) {
            const fp = b.input?.file_path || b.input?.notebook_path;
            if (fp) files.add(relOf(cwd, fp));
          }
        }
      }
    }
  }
  if (!parts.length) return null;
  return { userTurns, files, condensed: clampMiddle(parts.join('\n'), MAX_CONTEXT) };
}

function classifyProject(cwd) {
  const base = path.basename(cwd || '');
  if (base === 'claude-web-console') return 'console';
  if (/tolkien/i.test(cwd || '')) return 'tolkien';
  return 'otros';
}

// Encola una destilación al cerrar un chat, SI supera el filtro híbrido.
// Best-effort total: cualquier falla se traga (nunca bloquea el cierre del chat).
export async function queueRetroDistill({ cwd, sessionId, title, ticketNumber, learningId, owner, claudeDir } = {}) {
  if (!cwd || !sessionId) return;
  const effectiveOwner = owner || retroHostUser();
  const sig = readTranscript(cwd, sessionId, claudeDir, effectiveOwner);
  if (!sig) return;
  // FILTRO: solo destilamos chats con sustancia (tocó código, o conversación de
  // varios turnos, o fue trabajo de ticket/tema). Los triviales ("gracias") no gastan tokens.
  const substantive = sig.files.size > 0 || sig.userTurns >= MIN_USER_TURNS || !!ticketNumber || !!learningId;
  if (!substantive) return;
  const id = retroJobId(sessionId);
  const existing = readRetroJob(id, effectiveOwner);
  if (existing && (existing.status === 'done' || isFreshRunning(existing))) return; // dedup: no re-gastar
  writeRetroJob(id, {
    id,
    status: 'running',
    startedAt: Date.now(),
    // Registros históricos del barrido host usaban null; conservar ese byte
    // mientras la ruta efectiva igual se resuelve con el hostUser.
    owner: owner || null,
    context: sig.condensed,
    meta: {
      title: String(title || '').slice(0, 120),
      project: classifyProject(cwd),
      sessionId,
      ticketNumber: ticketNumber || null,
      learningId: learningId || null,
      userTurns: sig.userTurns,
      files: [...sig.files].slice(0, MAX_TRANSCRIPT_FILES),
    },
    result: null,
    error: null,
  }, effectiveOwner);
  try {
    spawnRetroRunner(id, effectiveOwner);
  } catch (err) {
    const job = readRetroJob(id, effectiveOwner);
    if (job?.status === 'running') {
      writeRetroJob(id, {
        ...job,
        status: 'error',
        result: null,
        error: String(err?.message || err).slice(0, 300),
        updatedAt: Date.now(),
      }, effectiveOwner);
    }
    throw err;
  }
}

// ===== Prompt de destilación (texto puro, doble deny en el runner) =====
// `existing` y `poolExisting` = lecciones YA registradas ({category, title});
// si el modelo repite un concepto, debe reusar el título EXACTO para que el
// fingerprint coincida y suba la recurrencia en vez de crear un duplicado.
export function retroPrompt(job, existing = [], poolExisting = []) {
  const meta = job?.meta || {};
  const filesLine = (meta.files || []).length ? `\nArchivos tocados en la sesión: ${(meta.files || []).join(', ')}` : '';
  // Se calculan ambos cupos antes de recortar: si una lista no llena su parte,
  // la otra aprovecha ese lugar sin superar nunca el techo total del prompt.
  let ownLimit = Math.min(existing.length, RETRO_DEDUP_LIMIT_OWN);
  let poolLimit = Math.min(poolExisting.length, RETRO_DEDUP_LIMIT_POOL);
  let remaining = RETRO_DEDUP_LIMIT - ownLimit - poolLimit;
  const ownExtra = Math.min(Math.max(0, existing.length - ownLimit), remaining);
  ownLimit += ownExtra;
  remaining -= ownExtra;
  poolLimit += Math.min(Math.max(0, poolExisting.length - poolLimit), remaining);
  const ownOmitted = Math.max(0, existing.length - ownLimit);
  const poolOmitted = Math.max(0, poolExisting.length - poolLimit);
  if (ownOmitted) console.warn(`[retro] dedup propio: ${ownOmitted} lección(es) quedaron fuera del tope compartido de ${RETRO_DEDUP_LIMIT}.`);
  if (poolOmitted) console.warn(`[retro] dedup pozo común: ${poolOmitted} lección(es) quedaron fuera del tope compartido de ${RETRO_DEDUP_LIMIT}.`);

  const ownVisible = existing.slice(0, ownLimit);
  const poolVisible = poolExisting.slice(0, poolLimit);
  const existingBlock = ownVisible.length
    ? `\n\nLECCIONES YA REGISTRADAS. Si una lección que ibas a proponer YA figura acá (mismo concepto, aunque vos lo dirías distinto), NO la reformules: devolvela con el MISMO título y la MISMA categoría EXACTOS de esta lista, para que el sistema la reconozca como la misma y cuente su recurrencia en vez de duplicarla:\n${ownVisible.map((l) => `- [${l.category}] ${l.title}`).join('\n')}`
    : '';
  const poolBlock = poolVisible.length
    ? `\n\nLECCIONES YA REGISTRADAS POR OTROS USUARIOS (pozo común). Si una lección que ibas a proponer YA figura acá (mismo concepto, aunque vos lo dirías distinto), NO la reformules: devolvela con el MISMO título y la MISMA categoría EXACTOS de esta lista, para que el sistema la reconozca como la misma y cuente su recurrencia en vez de duplicarla:\n${poolVisible.map((l) => `- [${l.category}] ${l.title}`).join('\n')}`
    : '';
  return `Sos un analista de PROCESO de un equipo de desarrollo. Te paso la TRANSCRIPCIÓN CONDENSADA de una sesión de trabajo de Claude Code sobre el proyecto "${meta.project || 'otros'}" (título: "${meta.title || 's/título'}").${filesLine}${existingBlock}${poolBlock}

Tu ÚNICA tarea: destilar LECCIONES DE PROCESO / METODOLOGÍA / FLUJO DE TRABAJO que convenga sistematizar para que las PRÓXIMAS sesiones trabajen mejor. NO son bugs de código, NO es un resumen de qué se hizo.

Buscá momentos donde:
- se descubrió TARDE algo que debió hacerse antes (p.ej. no se leyó la documentación oficial de una herramienta nueva y se integró a ciegas);
- se repitió un error evitable, o faltó un paso clave (testear antes de cerrar, verificar contra la fuente autoritativa, etc.);
- se encontró una forma MÁS eficiente o correcta de hacer algo;
- una instrucción / contexto / regla del proyecto debería cambiar o agregarse.

Ejemplos del TIPO de lección esperada:
- "Al integrar una herramienta nueva, leer PRIMERO su documentación oficial antes de asumir su API."
- "Todo cambio de código pasa por un test que lo ejercite antes de darlo por cerrado."

Sé CONSERVADOR: solo lecciones REALES, accionables y generalizables a futuras sesiones. Si esta sesión no dejó ninguna lección de proceso valiosa, devolvé una lista VACÍA. Preferí 0-3 lecciones de calidad a muchas triviales u obvias. En español.

Para cada lección devolvé:
- title: imperativa y corta (≤80 chars).
- category: uno de regla | convencion | metodologia | procedimiento | herramienta | nota.
- observation: qué pasó en ESTA sesión que la disparó (1-2 frases).
- lesson: qué hacer distinto de ahora en más (accionable, concreto).
- destination: dónde debería vivir para cambiar el comportamiento futuro — uno de memoria | claude-md | contexto | convencion | registro.
- project: uno de console | tolkien | otros (a qué proyecto aplica; si es universal, usá el de la sesión).
- confidence: alta | media | baja.

Respondé ÚNICAMENTE con un bloque \`\`\`json con esta forma EXACTA, sin texto fuera del bloque:
\`\`\`json
{ "lessons": [ { "title": "...", "category": "metodologia", "observation": "...", "lesson": "...", "destination": "memoria", "project": "console", "confidence": "media" } ] }
\`\`\`

=== TRANSCRIPCIÓN CONDENSADA ===
${job?.context || ''}`;
}

const CATS = ['regla', 'convencion', 'metodologia', 'procedimiento', 'herramienta', 'nota'];
const DESTS = ['memoria', 'claude-md', 'contexto', 'convencion', 'registro'];
const PROJS = ['console', 'tolkien', 'otros'];
const CONFS = ['alta', 'media', 'baja'];
const clamp = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const pick = (v, list, def) => (list.includes(v) ? v : def);

export function parseRetro(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const lessons = Array.isArray(o?.lessons) ? o.lessons.slice(0, 12).map((l) => ({
    title: clamp(l?.title, 200).trim(),
    category: pick(l?.category, CATS, 'nota'),
    observation: clamp(l?.observation, 2000),
    lesson: clamp(l?.lesson, 2000),
    destination: pick(l?.destination, DESTS, 'registro'),
    project: pick(l?.project, PROJS, 'otros'),
    confidence: pick(l?.confidence, CONFS, 'media'),
  })).filter((l) => l.title && l.lesson) : [];
  return { lessons };
}
