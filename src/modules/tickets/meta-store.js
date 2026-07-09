// modules/tickets/meta-store.js — metadata NUESTRA por ticket/PR que Zoho/GitHub
// no exponen: "Contexto adicional" (una charla/reunión interpretada por IA) +
// "Histórico del trabajo" (resumen de cada sesión de chat que trabajó el ítem).
//
// Estado persistente propio en ~/.cwc-data/ticket-meta.json — TABLA APARTE del
// snapshot y de los claims (patrón claims-store.js: escritura atómica tmp+rename,
// overlay al servir). Sobrevive reinicios por construcción (todo en disco).
// Clave = ticketNumber ('123' — tickets Y features usan la misma ventana) o
// 'pr:<n>' (PRs, mismo prefijo que los claims). Se superpone (overlay) sobre
// cada ticket/PR al servir vía withMeta() — el frontend lo ve como `item.meta`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../../core/claude-model.js';

const FILE = path.join(os.homedir(), '.cwc-data', 'ticket-meta.json');
const HISTORY_MAX = 40;     // tope de entradas de histórico por ítem
const CONTEXT_MAX = 20000;  // tope de chars del contexto adicional
const SUMMARY_MAX = 4000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

let meta = null; // { [key]: { contextoAdicional, contextoAt, historico:[{at,sessionId,resumen,files[]}] } }

function load() {
  if (meta) return meta;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    meta = raw && typeof raw === 'object' ? raw : {};
  } catch { meta = {}; }
  return meta;
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(tmp, FILE); // rename = escritura atómica (no deja archivo a medias)
  } catch (err) { console.error('[tickets] no pude persistir ticket-meta:', err?.message); }
}
function keyOf(id) { return String(id); }
function entryOf(key) {
  const store = load();
  if (!store[key]) store[key] = { contextoAdicional: '', contextoAt: null, historico: [] };
  return store[key];
}

// Lectura null-safe de la metadata de un ítem.
export function getMeta(id) {
  const e = load()[keyOf(id)];
  if (!e) return { contextoAdicional: '', contextoAt: null, historico: [] };
  return {
    contextoAdicional: e.contextoAdicional || '',
    contextoAt: e.contextoAt || null,
    historico: Array.isArray(e.historico) ? e.historico : [],
  };
}

// Overlay: copia del item con `meta` seteado (para el frontend), sin mutar el
// snapshot compartido. Mismo patrón que withClaim de claims-store.js.
export function withMeta(item, idField = 'ticketNumber') {
  if (!item || item[idField] == null) return item;
  return { ...item, meta: getMeta(item[idField]) };
}

// Guardar/editar el contexto adicional (texto interpretado por la IA o edición
// manual del usuario). Auto-guardado por el runner al terminar la interpretación.
export function saveContexto(id, text) {
  const e = entryOf(keyOf(id));
  e.contextoAdicional = String(text || '').slice(0, CONTEXT_MAX);
  e.contextoAt = Date.now();
  persist();
  return getMeta(id);
}
export function clearContexto(id) {
  const e = entryOf(keyOf(id));
  e.contextoAdicional = '';
  e.contextoAt = null;
  persist();
  return getMeta(id);
}

// Agregar una entrada al histórico del trabajo (al cerrar un chat del ítem).
export function appendHistorico(id, { sessionId, resumen, files }) {
  if (!resumen && !(files && files.length)) return; // nada útil que guardar
  const e = entryOf(keyOf(id));
  e.historico.push({
    at: Date.now(),
    sessionId: String(sessionId || '').slice(0, 80),
    resumen: String(resumen || '').slice(0, SUMMARY_MAX),
    files: Array.isArray(files) ? files.slice(0, 60).map((f) => String(f).slice(0, 300)) : [],
  });
  if (e.historico.length > HISTORY_MAX) e.historico.splice(0, e.historico.length - HISTORY_MAX);
  persist();
}

// ===== Extracción determinística del trabajo de una sesión (0 tokens) =====
// Porta la lógica del board v1 (archivado _archived/.../store.js): recorre el
// transcript .jsonl y saca los archivos editados (rutas relativas al cwd) + el
// último texto sustancial del asistente (el cierre suele resumir qué se hizo).
function transcriptPath(cwdAbs, sessionId) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwdAbs), `${sessionId}.jsonl`);
}
export function extractSessionWork(cwdAbs, sessionId) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath(cwdAbs, sessionId), 'utf8'); } catch { return null; }
  const files = new Set();
  let summary = '';
  let lastText = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) {
        lastText = b.text.trim();
        if (lastText.length >= 40) summary = lastText;
      }
      if (b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
        const abs = b.input?.file_path || b.input?.notebook_path;
        if (!abs) continue;
        const rel = path.relative(cwdAbs, String(abs));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) files.add(rel);
      }
    }
  }
  return { files: [...files], summary: (summary || lastText).slice(0, SUMMARY_MAX) };
}
