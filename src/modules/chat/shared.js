// modules/chat/shared.js — piezas compartidas entre el SERVER (index.js) y el
// RUNNER desacoplado (bin/cwc-chat-runner.js): constantes, rutas del socket
// Unix por conversación y la traducción de tool calls a eventos de UI.
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '../../core/data-dir.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Modos de permiso del chat: la FUENTE ÚNICA vive en el núcleo core/tool-policy.js
// (gobernanza de permisos). Se re-exporta acá para no romper a los importadores
// del módulo chat (server + runner). 'bypassPermissions' = "Todo": acepta TODA
// acción sin canUseTool — SOLO en chats interactivos; las corridas headless
// (tickets/salud) siguen blindadas read-only con sus propias allowlists (regla 6).
export { PERMISSION_MODES } from '../../core/tool-policy.js';
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // sin respuesta => denegar
export const SLEEP_MS = 45 * 60 * 1000; // inactiva => el runner se auto-duerme
export const HISTORY_MAX = 600;

// Cada conversación tiene su runner con socket Unix + log propios acá.
export const DATA_DIR = resolveDataDir();
export const CHATS_DIR = path.join(DATA_DIR, 'chats');
export const sockPath = (id) => path.join(CHATS_DIR, `${id}.sock`);
export const logPath = (id) => path.join(CHATS_DIR, `${id}.log`);

export const trim = (s, n = 4000) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

export function toolSummary(name, input) {
  try {
    if (name === 'Bash') return String(input?.command || '').slice(0, 120);
    if (name === 'Read') return String(input?.file_path || '');
    if (name === 'Write' || name === 'Edit') return String(input?.file_path || '');
    // AskUserQuestion: el summary es el texto de la 1ª pregunta (el detalle lleva
    // las opciones completas para el render especial de la tarjeta).
    if (name === 'AskUserQuestion') {
      const q = input?.questions?.[0]?.question;
      return q ? String(q).slice(0, 120) : 'Pregunta del asistente';
    }
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch { return ''; }
}

// Detalle del input para la UI (diffs en Edit/Write, comando en Bash, preguntas
// con opciones en AskUserQuestion).
export function toolDetail(name, input) {
  try {
    if (name === 'Edit') return { file: input?.file_path, old: trim(input?.old_string), new: trim(input?.new_string) };
    if (name === 'Write') return { file: input?.file_path, new: trim(input?.content) };
    if (name === 'Bash') return { command: trim(input?.command, 1000) };
    // AskUserQuestion: viajan las preguntas normalizadas para que el front las
    // renderice como opciones seleccionables (inline + centro global de permisos,
    // que reenvía este `detail`). Cada opción = { label, description, preview? }.
    if (name === 'AskUserQuestion') {
      const questions = (Array.isArray(input?.questions) ? input.questions : []).slice(0, 4).map((q) => ({
        question: trim(String(q?.question || ''), 400),
        header: trim(String(q?.header || ''), 40),
        multiSelect: !!q?.multiSelect,
        options: (Array.isArray(q?.options) ? q.options : []).slice(0, 4).map((o) => ({
          label: trim(String(o?.label || ''), 120),
          description: trim(String(o?.description || ''), 300),
        })),
      }));
      return { askQuestions: questions };
    }
    return null;
  } catch { return null; }
}

// Texto plano del tool_result (string o bloques de texto).
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

// Cola de mensajes del usuario -> AsyncIterable para el streaming input mode.
export function makeInput() {
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
