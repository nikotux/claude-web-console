// modules/tickets/meta-store.js — metadata NUESTRA por ticket/PR que Zoho/GitHub
// no exponen: "Contexto adicional" (una charla/reunión interpretada por IA) +
// "Histórico del trabajo" (resumen de cada sesión de chat que trabajó el ítem).
//
// Estado persistente propio en ~/.cwc-data/ticket-meta.json — TABLA APARTE del
// snapshot y de los claims: escritura atómica (writeJsonAtomic tmp+rename),
// overlay al servir. Sobrevive reinicios por construcción (todo en disco).
// Clave = ticketNumber ('123' — tickets Y features usan la misma ventana) o
// 'pr:<n>' (PRs, mismo prefijo que los claims). El frontend lo ve como `item.meta`
// (el overlay lo arma cada handler con getMeta()).
//
// SIN CACHÉ EN MEMORIA (fix B1 2026-07-11): el archivo lo escriben DOS procesos
// distintos — el server (appendHistorico al cerrar chat, saveContexto/clearContexto
// desde POST /meta/context) y el RUNNER DESACOPLADO `bin/cwc-ticket-context-runner.js`
// (auto-guarda la interpretación IA con saveContexto en SU proceso). Antes este
// módulo memoizaba `meta` en el proceso del server y nunca lo recargaba: la copia
// del server quedaba stale (el contexto auto-guardado por el runner no aparecía
// hasta reiniciar) y peor, el próximo write del server persistía SU copia vieja y
// PISABA lo que había escrito el runner (pérdida de datos). Ahora cada acceso lee
// FRESCO del disco (archivo chico, escrituras raras) y cada mutación es
// read-modify-write dentro de la misma llamada.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { encodeCwd } from '../../core/claude-model.js';

const FILE = path.join(os.homedir(), '.cwc-data', 'ticket-meta.json');
const HISTORY_MAX = 40;     // tope de entradas de histórico por ítem
const CONTEXT_MAX = 20000;  // tope de chars del contexto adicional
const SUMMARY_MAX = 4000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Lee TODO el store fresco del disco (sin caché — ver cabecera). {} si no existe.
function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
// Persiste el store completo (atómico tmp+rename vía el helper compartido).
function writeAll(store) {
  try { writeJsonAtomic(FILE, store); }
  catch (err) { console.error('[tickets] no pude persistir ticket-meta:', err?.message); }
}
function keyOf(id) { return String(id); }
function blankEntry() { return { contextoAdicional: '', contextoAt: null, historico: [] }; }
// Devuelve la entrada del store para `key`, creándola si no existía (muta `store`).
function entryIn(store, key) {
  if (!store[key]) store[key] = blankEntry();
  return store[key];
}

// Lectura null-safe de la metadata de un ítem (lee fresco del disco).
export function getMeta(id) {
  const e = readAll()[keyOf(id)];
  if (!e) return blankEntry();
  return {
    contextoAdicional: e.contextoAdicional || '',
    contextoAt: e.contextoAt || null,
    historico: Array.isArray(e.historico) ? e.historico : [],
  };
}

// Guardar/editar el contexto adicional (texto interpretado por la IA o edición
// manual del usuario). Auto-guardado por el runner al terminar la interpretación.
// Read-modify-write fresco: no pisa lo que otro proceso haya escrito recién.
export function saveContexto(id, text) {
  const store = readAll();
  const e = entryIn(store, keyOf(id));
  e.contextoAdicional = String(text || '').slice(0, CONTEXT_MAX);
  e.contextoAt = Date.now();
  writeAll(store);
  return getMeta(id);
}
export function clearContexto(id) {
  const store = readAll();
  const e = entryIn(store, keyOf(id));
  e.contextoAdicional = '';
  e.contextoAt = null;
  writeAll(store);
  return getMeta(id);
}

// Agregar una entrada al histórico del trabajo (al cerrar un chat del ítem).
// Read-modify-write fresco: preserva el contextoAdicional que el runner haya
// auto-guardado entre medio (ese era el bug de pérdida de datos).
export function appendHistorico(id, { sessionId, resumen, files }) {
  if (!resumen && !(files && files.length)) return; // nada útil que guardar
  const store = readAll();
  const e = entryIn(store, keyOf(id));
  e.historico.push({
    at: Date.now(),
    sessionId: String(sessionId || '').slice(0, 80),
    resumen: String(resumen || '').slice(0, SUMMARY_MAX),
    files: Array.isArray(files) ? files.slice(0, 60).map((f) => String(f).slice(0, 300)) : [],
  });
  if (e.historico.length > HISTORY_MAX) e.historico.splice(0, e.historico.length - HISTORY_MAX);
  writeAll(store);
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
