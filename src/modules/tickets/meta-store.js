// modules/tickets/meta-store.js — metadata NUESTRA por ticket/PR que Zoho/GitHub
// no exponen: "Contexto adicional" (una charla/reunión interpretada por IA) +
// "Histórico del trabajo" (resumen de cada sesión de chat que trabajó el ítem).
//
// MIGRACIÓN A PAD LOCAL (2026-07-12, ROAD-110 Fase 3 / TASK-249): la fuente de
// verdad dejó de ser ~/.cwc-data/ticket-meta.json — ahora es la colección
// `contexto-de-tickets` (prefix CDT) del Pad LOCAL (workspace `console`), vía
// src/core/pad-service-client.js. Es el "mundo INTERNO" del patrón de dos
// mundos: notas propias de Consola sobre un ticket/PR de Tolkien — NUNCA el
// ticket/PR en sí (eso sigue siendo Zoho Desk + GitHub + el Pad de Tolkien en
// la nube vía `pad-client.js`, TODO intocado por esta migración).
//
// A DIFERENCIA de tasks/learning (que usan el `ref` de Pad como id principal,
// ej. PEND-5), acá la clave (`ticketNumber` '123' o 'pr:<n>') YA EXISTÍA como
// STRING ARBITRARIO ajeno a Pad — no es un ref. Mapeo: 1 item de
// `contexto-de-tickets` por clave, con `title` = la clave exacta y custom
// field `ticketKey` = la misma clave (redundante a propósito). Buscar = pedir
// TODOS los items de la colección y filtrar por título exacto en memoria
// (findItemByTitle de pad-service-client.js) — volumen esperado bajo
// (decenas/pocas centenas de tickets trabajados), sin endpoint de búsqueda
// por custom field todavía.
//
// TODAS las funciones son ahora ASYNC (antes eran síncronas) — MISMOS
// nombres/firma, así que los 3 consumidores reales (tickets/index.js,
// chat/index.js, bin/cwc-ticket-context-runner.js) solo necesitaron sumar
// `await`. GOTCHA CRÍTICO (ver también pad-service-client.js): un PATCH de
// `fields` REEMPLAZA el objeto entero (no lo mergea) — toda mutación acá es
// read-modify-write (leer el item completo, mutar SOLO el campo que cambia,
// mandar TODOS los fields de vuelta) para no pisar `contexto`/`historico`
// escritos por otro proceso entre medio (el mismo problema que resolvía el
// "sin caché en memoria" de la versión file-based).
//
// `contexto` (custom field json) = {text, at} — reemplaza
// contextoAdicional/contextoAt. `historico` (custom field json) = array de
// {at, sessionId, resumen, files[]} tal cual, mismo tope HISTORY_MAX de 40.
//
// `extractSessionWork()` (mismo archivo) es PURA — lee un transcript .jsonl,
// no hace NINGÚN I/O de meta-store — se queda 100% igual, sin tocar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd } from '../../core/claude-model.js';
import { findItemByTitle, createItem, updateItem } from '../../core/pad-service-client.js';

const COLLECTION = 'contexto-de-tickets';
const HISTORY_MAX = 40;     // tope de entradas de histórico por ítem
const CONTEXT_MAX = 20000;  // tope de chars del contexto adicional
const SUMMARY_MAX = 4000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function keyOf(id) { return String(id); }
function blankEntry() { return { contextoAdicional: '', contextoAt: null, historico: [] }; }

// Lectura null-safe de los custom fields de un item (mismo helper que
// tasks/store.js y learning/store.js: `fields` puede venir objeto u
// stringificado según el server).
function parseFields(item) {
  const f = item?.fields;
  if (!f) return {};
  if (typeof f === 'object') return f;
  try { const p = JSON.parse(f); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}

function entryFromItem(item) {
  const f = parseFields(item);
  const ctx = f.contexto && typeof f.contexto === 'object' ? f.contexto : null;
  return {
    contextoAdicional: ctx?.text || '',
    contextoAt: ctx?.at || null,
    historico: Array.isArray(f.historico) ? f.historico : [],
  };
}

function padError(action, r) {
  const e = new Error(`Pad local (${action}): ${r?.error || 'error desconocido'}`);
  e.padError = true;
  return e;
}

// Lectura null-safe de la metadata de un ítem (findItemByTitle ya devuelve
// null best-effort si Pad falla o no hay match → blankEntry() en ambos
// casos, igual que el `{}` silencioso de la versión file-based).
export async function getMeta(id) {
  const item = await findItemByTitle(COLLECTION, keyOf(id));
  if (!item) return blankEntry();
  return entryFromItem(item);
}

// Guardar/editar el contexto adicional (texto interpretado por la IA o
// edición manual del usuario). Auto-guardado por el runner al terminar la
// interpretación. Read-modify-write: nunca pisa el `historico` existente.
export async function saveContexto(id, text) {
  const key = keyOf(id);
  const clean = String(text || '').slice(0, CONTEXT_MAX);
  const at = Date.now();
  const item = await findItemByTitle(COLLECTION, key);
  if (!item) {
    const r = await createItem(COLLECTION, {
      title: key,
      fields: { ticketKey: key, contexto: { text: clean, at }, historico: [] },
    });
    if (!r.ok) throw padError('saveContexto', r);
    return getMeta(id);
  }
  const nextFields = { ...parseFields(item), ticketKey: key, contexto: { text: clean, at } };
  const r = await updateItem(item.ref, { fields: nextFields });
  if (!r.ok) throw padError('saveContexto', r);
  return getMeta(id);
}

export async function clearContexto(id) {
  const key = keyOf(id);
  const item = await findItemByTitle(COLLECTION, key);
  if (!item) return blankEntry(); // nada que borrar: no crea un ítem vacío
  const nextFields = { ...parseFields(item), ticketKey: key, contexto: null };
  const r = await updateItem(item.ref, { fields: nextFields });
  if (!r.ok) throw padError('clearContexto', r);
  return getMeta(id);
}

// Agregar una entrada al histórico del trabajo (al cerrar un chat del ítem).
// BEST-EFFORT por diseño (igual que la versión file-based: nunca debe romper
// el cierre de un chat) — el propio try/catch de acá absorbe cualquier falla
// de Pad; el caller (chat/index.js) además envuelve el await en su propio
// try/catch como red de seguridad adicional.
export async function appendHistorico(id, { sessionId, resumen, files }) {
  if (!resumen && !(files && files.length)) return; // nada útil que guardar
  const key = keyOf(id);
  const entry = {
    at: Date.now(),
    sessionId: String(sessionId || '').slice(0, 80),
    resumen: String(resumen || '').slice(0, SUMMARY_MAX),
    files: Array.isArray(files) ? files.slice(0, 60).map((f) => String(f).slice(0, 300)) : [],
  };
  try {
    const item = await findItemByTitle(COLLECTION, key);
    if (!item) {
      const r = await createItem(COLLECTION, {
        title: key,
        fields: { ticketKey: key, contexto: null, historico: [entry] },
      });
      if (!r.ok) console.error('[tickets] no pude crear item de histórico en Pad:', r.error);
      return;
    }
    const f = parseFields(item);
    const historico = Array.isArray(f.historico) ? [...f.historico, entry] : [entry];
    if (historico.length > HISTORY_MAX) historico.splice(0, historico.length - HISTORY_MAX);
    const r = await updateItem(item.ref, { fields: { ...f, ticketKey: key, historico } });
    if (!r.ok) console.error('[tickets] no pude actualizar histórico en Pad:', r.error);
  } catch (err) {
    console.error('[tickets] no pude persistir histórico en Pad:', err?.message || err);
  }
}

// ===== Extracción determinística del trabajo de una sesión (0 tokens) =====
// Porta la lógica del board v1 (archivado _archived/.../store.js): recorre el
// transcript .jsonl y saca los archivos editados (rutas relativas al cwd) + el
// último texto sustancial del asistente (el cierre suele resumir qué se hizo).
// PURA — sin I/O de meta-store/Pad — SIN CAMBIOS respecto a la versión file-based.
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
