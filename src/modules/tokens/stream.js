// Vista Raw — extracción del TEXTO REAL que las sesiones están escribiendo, para
// que la lluvia estilo Matrix sea lo que la consola procesa de verdad (no glifos
// decorativos). Hermano de flow.js: MISMO patrón de lectura por-bytes-apendeados
// de los transcripts locales, pero en vez de CONTAR tokens EXTRAE el texto.
//   - Claude: ~/.claude/projects/<proj>/*.jsonl  (bloques text/thinking/tool_use
//             del message; el proj codifica el cwd → mundo; el archivo = sessionId)
//   - Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  (deltas de
//             agent_message/agent_reasoning; el cwd sale del session_meta si está)
//
// CURSORES PROPIOS (Map aparte del de flow.js): esto NO comparte estado con el
// contador de tokens — leer un poco el mismo archivo dos veces es barato y aísla
// el riesgo (flow.js alimenta la manguera que Niko ya usa; no lo tocamos).
//
// BASELINE crítico (igual que flow.js): al ver un archivo por primera vez se fija
// el cursor al tamaño ACTUAL sin parsear el histórico — así la lluvia no vomita
// toda la conversación vieja al abrir; solo cae lo que se escribe desde ahora.
//
// Es efímero y SOLO-LECTURA: un buffer rodante en memoria de los últimos
// fragmentos, con seq monotónica; el cliente pide ?since=<seq> (multi-ventana
// safe, sin cursor por-cliente). Nada se persiste; un reinicio arranca de cero.
import fs from 'node:fs/promises';
import path from 'node:path';
import { hostUser, userClaudeDir, userSpace } from '../../core/user-space.js';

const RECENT_MS = 5 * 60 * 1000;      // solo archivos tocados hace <5min
const MAX_APPEND = 512 * 1024;         // techo de bytes leídos por archivo/pasada
const MAX_FRAGMENTS = 400;             // buffer rodante
const FRAG_TEXT_CAP = 2000;            // tope de chars por fragmento (es muestreo, no volcado)
const SCAN_MIN_MS = 300;               // no re-escanear más seguido que esto
const SEEN_TTL_MS = 3 * 60 * 1000;     // dedup de message.id de Claude

const OWNER_STATE_MAX = 32;
const ownerStates = new Map();

function stateFor(owner) {
  let state = ownerStates.get(owner);
  if (state) {
    ownerStates.delete(owner);
    ownerStates.set(owner, state);
    return state;
  }
  state = {
    cursors: new Map(),  // file -> {offset}
    seenIds: new Map(),  // message.id -> ts (dedup Claude)
    fileCwd: new Map(),  // rollout Codex -> cwd (o null)
    fragments: [],       // {seq, ts, source, sessionId, world, model, text}
    seq: 0,
    inFlight: false,
    lastScan: 0,
  };
  ownerStates.set(owner, state);
  if (ownerStates.size > OWNER_STATE_MAX) ownerStates.delete(ownerStates.keys().next().value);
  return state;
}

function worldFromClaudeDir(name) {
  if (/tolkien/i.test(name)) return 'tolkien';
  if (/claude-web-console/i.test(name)) return 'console';
  return 'otros';
}
function worldFromCwd(cwd) {
  if (!cwd) return null;
  if (/tolkien/i.test(cwd)) return 'tolkien';
  if (/claude-web-console/i.test(cwd)) return 'console';
  return 'otros';
}

// Aplana a un chorro de caracteres: colapsa espacios/saltos y recorta al tope.
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, FRAG_TEXT_CAP);
}

function pruneSeen(now, state) {
  for (const [id, ts] of state.seenIds) if (ts < now - SEEN_TTL_MS) state.seenIds.delete(id);
}

function pushFragment(f, state) {
  const text = clean(f.text);
  if (!text) return;
  state.seq += 1;
  state.fragments.push({ seq: state.seq, ts: Date.now(), ...f, text });
  if (state.fragments.length > MAX_FRAGMENTS) {
    state.fragments.splice(0, state.fragments.length - MAX_FRAGMENTS);
  }
}

async function listDir(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

// Lee los bytes recién apendeados a un archivo y entrega las líneas JSON nuevas.
// Mismo mecanismo cursor+baseline que flow.js (cursores propios).
async function readAppendedLines(file, state) {
  const now = Date.now();
  let st;
  try { st = await fs.stat(file); } catch { return []; }
  if (st.mtimeMs < now - RECENT_MS) {
    // Archivo frío: no se re-visita mientras siga así — soltar el cursor evita
    // que el Map crezca sin límite con cada sesión que alguna vez existió
    // (mismo criterio que flow.js). Re-baselinea si vuelve a tocarse.
    state.cursors.delete(file);
    return [];
  }

  let cur = state.cursors.get(file);
  if (!cur) { state.cursors.set(file, { offset: st.size }); return []; } // baseline
  if (st.size < cur.offset) cur.offset = 0;
  if (st.size <= cur.offset) return [];

  const toRead = Math.min(st.size - cur.offset, MAX_APPEND);
  const buf = Buffer.allocUnsafe(toRead);
  let bytesRead = 0;
  try {
    const fh = await fs.open(file, 'r');
    try { ({ bytesRead } = await fh.read(buf, 0, toRead, cur.offset)); }
    finally { await fh.close().catch(() => {}); }
  } catch { return []; }
  if (bytesRead <= 0) return [];

  const chunk = buf.subarray(0, bytesRead);
  const lastNL = chunk.lastIndexOf(0x0A);
  if (lastNL < 0) {
    // Sin salto de línea completo: si topamos el techo, saltamos adelante para no colgarnos.
    if (bytesRead >= MAX_APPEND) cur.offset += bytesRead;
    return [];
  }
  const consumed = chunk.subarray(0, lastNL + 1);
  cur.offset += consumed.length;

  const out = [];
  for (const line of consumed.toString('utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* línea partida/corrupta */ }
  }
  return out;
}

// Preview compacto del input de una tool (sin volcar diffs enteros).
function toolPreview(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.path || input.pattern
    || input.query || input.description || '';
  return v ? ' ' + String(v).slice(0, 80) : '';
}

// Texto "crudo" de un mensaje de Claude: razonamiento + salida + llamadas a tools.
function claudeText(obj, now, state) {
  if (obj?.type !== 'assistant') return null;
  const msg = obj.message;
  if (!msg || !Array.isArray(msg.content)) return null;
  const id = msg.id;
  if (id) {
    if (state.seenIds.has(id)) return null;
    state.seenIds.set(id, Date.parse(obj.timestamp || '') || now);
  }
  const parts = [];
  for (const b of msg.content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
    else if (b.type === 'tool_use') parts.push(`«${b.name || 'tool'}»${toolPreview(b.input)}`);
  }
  if (!parts.length) return null;
  return { text: parts.join('  ·  '), model: msg.model || null };
}

// Texto de un evento de Codex: preferimos los deltas (chorro en tiempo real).
function codexText(obj) {
  if (obj?.type !== 'event_msg') return null;
  const p = obj.payload || {};
  let text = null;
  if (p.type === 'agent_message_delta' || p.type === 'agent_reasoning_delta') text = p.delta;
  else if (p.type === 'agent_message') text = p.message;
  else if (p.type === 'agent_reasoning') text = p.text;
  if (typeof text !== 'string' || !text.trim()) return null;
  return text;
}

async function readCodexCwd(file, state) {
  if (state.fileCwd.has(file)) return state.fileCwd.get(file);
  let cwd = null;
  const buf = Buffer.allocUnsafe(4096);
  try {
    const fh = await fs.open(file, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const first = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0];
      if (first) {
        const obj = JSON.parse(first);
        if (obj?.type === 'session_meta') cwd = obj.payload?.cwd || obj.cwd || null;
      }
    } finally { await fh.close().catch(() => {}); }
  } catch { cwd = null; }
  state.fileCwd.set(file, cwd);
  return cwd;
}

async function scanClaude(now, owner, state) {
  const base = path.join(userClaudeDir(owner), 'projects');
  for (const dirent of await listDir(base)) {
    if (!dirent.isDirectory()) continue;
    const world = worldFromClaudeDir(dirent.name);
    const dir = path.join(base, dirent.name);
    for (const f of await listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sessionId = path.basename(f.name, '.jsonl');
      for (const obj of await readAppendedLines(path.join(dir, f.name), state)) {
        const t = claudeText(obj, now, state);
        if (!t) continue;
        const isSub = obj.isSidechain === true;
        pushFragment({
          source: 'claude',
          sessionId: isSub ? `${sessionId}~sub` : sessionId,
          world,
          model: t.model,
          text: t.text,
          sub: isSub,
        }, state);
      }
    }
  }
}

function localDayDirs(owner) {
  const days = [];
  for (let i = 0; i < 2; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    days.push(path.join(userSpace(owner), '.codex', 'sessions', yyyy, mm, dd));
  }
  return days;
}

async function scanCodex(owner, state) {
  const seen = new Set();
  for (const dir of localDayDirs(owner)) {
    for (const f of await listDir(dir)) {
      if (!f.isFile() || !/^rollout-.*\.jsonl$/.test(f.name)) continue;
      const file = path.join(dir, f.name);
      seen.add(file);
      const cwd = await readCodexCwd(file, state);
      const sessionId = path.basename(f.name, '.jsonl');
      for (const obj of await readAppendedLines(file, state)) {
        const text = codexText(obj);
        if (text) {
          pushFragment({ source: 'codex', sessionId, world: worldFromCwd(cwd), model: 'codex', text }, state);
        }
      }
    }
  }
  // localDayDirs() solo cubre HOY+AYER: un rollout que sale de esa ventana ya
  // no se vuelve a visitar — soltar su entrada de fileCwd (mismo criterio que flow.js).
  for (const file of state.fileCwd.keys()) if (!seen.has(file)) state.fileCwd.delete(file);
}

async function computeStream(owner, state) {
  const now = Date.now();
  if (state.inFlight || now - state.lastScan < SCAN_MIN_MS) return;
  state.inFlight = true;
  try {
    pruneSeen(now, state);
    await scanClaude(now, owner, state);
    await scanCodex(owner, state);
    state.lastScan = Date.now();
  } finally {
    state.inFlight = false;
  }
}

// SEED (Vista Raw): al descubrir una sesión, el front pide su texto RECIENTE para
// que su banda tenga log desde el arranque (si no, una sesión ociosa desde que se
// abrió la vista quedaría sin texto). Lee la cola del transcript de ESA sesión —
// NO toca los cursores ni el dedup del streaming (extractor propio sin seenIds).
// v6: el panel de log de la Vista Raw mide ~64 líneas; con 3.000 chars llegaba
// a la mitad y el resto quedaba negro. 40.000 alcanza para llenarlo de una.
const SEED_TAIL_BYTES = 512 * 1024;
const SEED_TEXT_CAP = 40000;

function seedTextFromLine(obj) {
  if (obj?.type !== 'assistant') return null;
  const msg = obj.message;
  if (!msg || !Array.isArray(msg.content)) return null;
  const parts = [];
  for (const b of msg.content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking' && b.thinking) parts.push(b.thinking);
    else if (b.type === 'tool_use') parts.push(`«${b.name || 'tool'}»${toolPreview(b.input)}`);
  }
  return parts.length ? clean(parts.join('  ·  ')) : null;
}

export async function getSeed(sessionId, owner = hostUser()) {
  if (!/^[\w.-]+$/.test(sessionId || '')) return { text: '' };
  const base = path.join(userClaudeDir(owner), 'projects');
  for (const dirent of await listDir(base)) {
    if (!dirent.isDirectory()) continue;
    const file = path.join(base, dirent.name, `${sessionId}.jsonl`);
    let st;
    try { st = await fs.stat(file); } catch { continue; }
    const from = Math.max(0, st.size - SEED_TAIL_BYTES);
    const len = st.size - from;
    if (len <= 0) return { text: '' };
    const buf = Buffer.allocUnsafe(len);
    try {
      const fh = await fs.open(file, 'r');
      try { await fh.read(buf, 0, len, from); }
      finally { await fh.close().catch(() => {}); }
    } catch { return { text: '' }; }
    const parts = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      try { const t = seedTextFromLine(JSON.parse(line)); if (t) parts.push(t); } catch { /* línea partida */ }
    }
    const text = parts.join('\n');
    return { text: text.length > SEED_TEXT_CAP ? text.slice(text.length - SEED_TEXT_CAP) : text };
  }
  return { text: '' };
}

// Devuelve los fragmentos con seq > since + el seq actual (para el próximo poll).
export async function getStream(since, owner = hostUser()) {
  const state = stateFor(owner);
  await computeStream(owner, state);
  const from = Number.isFinite(since) ? since : 0;
  return {
    fragments: state.fragments.filter((f) => f.seq > from),
    lastSeq: state.seq,
    updatedAt: new Date().toISOString(),
  };
}
