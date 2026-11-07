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
export const SLEEP_DONE_MS = 5 * 60 * 1000; // pelota nadie (console:PLAN-3508)
export const OTRO_CHECKIN_MS = 15 * 60 * 1000;
export const OTRO_HOLD_MS = 4 * 60 * 60 * 1000;
export const WAKE_PREFIX = '🔔 [cwc-despertador]';

// Sueño por pelota (console:PLAN-3508): manda la última línea con marcador,
// con emoji opcional, negritas y mayúsculas/acentos tolerados.
export function parsePelota(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/(?:🎾\s*)?\*{0,2}\bPelota\*{0,2}\s*:\s*\*{0,2}\s*([A-Za-zÁÉÍÓÚáéíóú]+)/i);
    if (!match) continue;
    const pelota = match[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return ['nadie', 'tuya', 'otro', 'mia'].includes(pelota) ? pelota : null;
  }
  return null;
}

// Solo «nadie» acorta la espera; los demás casos conservan 45 min.
// Los consumidores deben impedir el sueño mientras el motor esté working;
// con OTRO, runner y server además retienen mediante holdsForOtro.
export function sleepThresholdMs(pelota) {
  return pelota === 'nadie' ? SLEEP_DONE_MS : SLEEP_MS;
}

// despertador (fin de trabajo de fondo / espera activa con pelota OTRO)
export function holdsForOtro(pelota, otroSince, now = Date.now()) {
  return pelota === 'otro' && otroSince > 0 && now - otroSince < OTRO_HOLD_MS;
}

export function wakeDecision({ status, pelota, idleMs, otroSince, now, pendingCount, liveBgCount }) {
  if (status !== 'waiting') return null;
  if (pendingCount > 0) return 'bg-done';
  if (liveBgCount === 0 && holdsForOtro(pelota, otroSince, now) && idleMs >= OTRO_CHECKIN_MS) {
    return 'otro-checkin';
  }
  return null;
}

export function buildWakeText(kind, { items = [], otroElapsedMs = 0 } = {}) {
  if (kind === 'bg-done') {
    const lines = items.map((item) => {
      if (item.kind === 'Codex') return `• Codex «${item.label}» → ${item.outcome}`;
      if (item.kind === 'CI') return `• CI del PR #${item.number} → ${item.outcome}`;
      if (item.kind === 'PR') return `• PR #${item.number} → ${item.outcome}`;
      return `• Subagente «${item.label}» → terminado`;
    });
    return `${WAKE_PREFIX} Terminó trabajo de fondo que dejaste corriendo:\n${lines.join('\n')}\nRecogé el resultado (collect_codex para las delegaciones a Codex), verificalo y seguí con el próximo paso de tu plan sin esperar al usuario. Cerrá con la 🎾 Pelota que corresponda.`;
  }
  if (kind === 'otro-checkin') {
    const min = Math.round(otroElapsedMs / 60000);
    return `${WAKE_PREFIX} Pasaron ${min} min con 🎾 Pelota: OTRO. Revisá si ya llegó lo que esperabas (CI, revisión de un PR, otra sesión, una respuesta). Si llegó, seguí con el próximo paso. Si sigue pendiente, contestá en UNA línea corta qué falta y volvé a cerrar con 🎾 Pelota: OTRO: te vuelvo a despertar en 15 min, hasta 4 h desde que empezó la espera.`;
  }
  return '';
}

// Tope de retención del motor con trabajo de fondo vivo (PLAN-892): pasado
// esto duerme igual, avisando en el chat qué se cortó (no runner inmortal).
export const BG_MAX_HOLD_MS = 4 * 60 * 60 * 1000;
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
    // La delegación hoy cae al JSON fallback y deja un chip/radar ilegible.
    if (name?.endsWith('__delegate_to_codex')) {
      const firstLine = typeof input?.task === 'string' ? input.task.split(/\r?\n/).find((line) => line.trim()) : '';
      return firstLine ? firstLine.trim().slice(0, 120) : 'delegación a Codex';
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
    // Permite saber si el mensaje sigue sin consumirse al reintentar el motor.
    size() { return queue.length; },
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
