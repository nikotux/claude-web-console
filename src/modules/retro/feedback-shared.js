// modules/retro/feedback-shared.js — ingesta MANUAL de "Feedback de Chris" (o
// cualquier cliente/revisor) para Mejora Continua: pegás un texto (correo
// copiado, mensaje de Teams, notas de una llamada) y la IA lo interpreta en
// una o varias lecciones categoría 'feedback-cliente', vinculadas al
// ticket/PR si corresponde. Patrón calcado de learning/context-shared.js —
// TEXTO PURO, CERO herramientas (regla 6, vía core/text-only-query.js).
//
// REGLA DE ORO: consume tokens ⇒ RUNNER DESACOPLADO
// (bin/cwc-retro-feedback-runner.js, detached+unref). El endpoint POST
// /api/retro/feedback persiste el job PENDIENTE acá y lo spawnea; el runner
// persiste el resultado en el MISMO archivo y hace el UPSERT en el store de
// retro (destino sugerido 'contexto': al adoptarla, se inyecta sola en TODO
// chat de bug futuro).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const LOG_FILE = path.join(DATA_DIR, 'retro-feedback.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-retro-feedback-runner.js');

export const FEEDBACK_TIMEOUT_MS = 4 * 60 * 1000;
export const FEEDBACK_STALE_MS = FEEDBACK_TIMEOUT_MS + 30 * 1000;

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); }
function jobPath(id) { return path.join(DATA_DIR, `retro-feedback-${id}.json`); }

// id DETERMINÍSTICO por texto+ticket: reintentar el mismo pegado reusa el
// MISMO job (no gasta tokens de nuevo), mismo patrón que tickets/learning.
export function feedbackJobId(text, ticketRef) {
  return crypto.createHash('sha1').update(`${ticketRef || ''}\n${text}`).digest('hex').slice(0, 24);
}

export function readFeedbackJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}
export function writeFeedbackJob(id, data) {
  ensureDir();
  writeJsonAtomic(jobPath(id), data);
}
export function isFeedbackFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= FEEDBACK_STALE_MS;
}
export function feedbackJobResult(job) {
  if (!job) return { status: 'idle', result: null, error: null };
  if (job.status === 'running' && !isFeedbackFreshRunning(job)) {
    return { status: 'error', result: null, error: 'La interpretación no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, result: job.result || null, error: job.error || null };
}

export function spawnRetroFeedbackRunner(id) {
  ensureDir();
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER, id], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.on('error', (err) => {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn FAIL job ${id}: ${err?.message || err}\n`); } catch { /* noop */ }
    try {
      const job = readFeedbackJob(id);
      if (job && job.status === 'running') writeFeedbackJob(id, { ...job, status: 'error', result: null, error: 'No se pudo iniciar el runner de feedback.', updatedAt: Date.now() });
    } catch { /* noop */ }
  });
  child.unref();
  fs.closeSync(logFd);
}

export function feedbackPrompt(job) {
  const { text, ticketRef } = job || {};
  const refLine = ticketRef
    ? `Este feedback fue etiquetado por el usuario al ticket/PR "${ticketRef}" — asumí que aplica ahí salvo que el texto mencione claramente otro.`
    : 'El usuario NO indicó a qué ticket/PR aplica. Si el texto lo menciona (p.ej. "tkt-519", "#245", "FEAT-3"), extraelo en "refs"; si no, dejalo vacío (aplica en general, no a un ticket puntual).';
  return [
    'Sos un analista que ayuda a un equipo de desarrollo a capturar FEEDBACK de un cliente/revisor (típicamente "Chris") sobre bugs/PRs — retroalimentación que llegó por correo, Teams, o una llamada, y que el equipo pegó tal cual.',
    refLine,
    '',
    'Tu tarea: identificar cada pieza de feedback DISTINTA en el texto (puede haber más de una) y convertirla en una lección ACCIONABLE para que las PRÓXIMAS sesiones de trabajo la tengan en cuenta ANTES de tocar un bug — NO es un resumen del texto, es una preferencia/regla/corrección concreta.',
    '',
    'Para cada pieza de feedback devolvé:',
    '- title: imperativa y corta (≤80 chars), lo más específica posible (p.ej. "Validar el input del lado del servidor, no solo en el front").',
    '- lesson: qué hacer distinto de ahora en más (accionable, concreto).',
    '- observation: qué dijo exactamente el cliente/revisor que lo disparó (1-2 frases, puede citar).',
    '- confidence: alta | media | baja (qué tan seguro estás de que es una regla generalizable vs una opinión puntual de este caso).',
    '- refs: array de tickets/PRs que el texto menciona EXPLÍCITAMENTE (formato "TKT-519", "PR-245", "FEAT-3"); vacío si no menciona ninguno.',
    '',
    'Sé CONSERVADOR: si el texto es puro ruido de conversación sin una recomendación concreta, devolvé una lista vacía. Preferí pocas piezas de calidad a muchas triviales. En español.',
    '',
    'Respondé ÚNICAMENTE con un bloque ```json``` con esta forma EXACTA, sin texto fuera del bloque:',
    '```json',
    '{ "items": [ { "title": "...", "lesson": "...", "observation": "...", "confidence": "media", "refs": ["TKT-519"] } ] }',
    '```',
    '',
    '=== TEXTO PEGADO ===',
    String(text || ''),
  ].join('\n');
}

const CONFS = ['alta', 'media', 'baja'];
const clamp = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const pick = (v, list, def) => (list.includes(v) ? v : def);

export function parseFeedback(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const items = Array.isArray(o?.items) ? o.items.slice(0, 12).map((it) => ({
    title: clamp(it?.title, 200).trim(),
    lesson: clamp(it?.lesson, 2000),
    observation: clamp(it?.observation, 2000),
    confidence: pick(it?.confidence, CONFS, 'media'),
    refs: Array.isArray(it?.refs) ? it.refs.map((r) => clamp(r, 24)).filter(Boolean).slice(0, 10) : [],
  })).filter((it) => it.title && it.lesson) : [];
  return { items };
}
