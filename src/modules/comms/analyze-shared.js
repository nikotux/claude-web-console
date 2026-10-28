// modules/comms/analyze-shared.js — persistencia + prompt del ANÁLISIS IA de UN
// hilo de comunicaciones (resumen + clasificación de "qué estamos hablando").
//
// REGLA DE ORO: corre DESACOPLADO (bin/cwc-comms-analyze-runner.js, detached+
// unref) — un reinicio de la web a mitad NO lo mata. El POST escribe el job
// PENDIENTE acá y spawnea el runner; el runner persiste el resultado en el
// MISMO archivo; el GET (y el front por polling) solo leen. Mismo patrón que
// projects/analyze-shared.js. La corrida es SDK haiku, 1 turno, CERO
// herramientas (doble capa de denegación, regla 6): solo resume el TEXTO del
// hilo que ya tenemos indexado — sin tokens de MCP, sin claves nuevas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');

const DATA_DIR = path.join(os.homedir(), '.cwc-data', 'comms', 'analyze');
const LOG_FILE = path.join(os.homedir(), '.cwc-data', 'comms', 'analyze.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-comms-analyze-runner.js');

export const ANALYZE_TIMEOUT_MS = 60 * 1000;
export const ANALYZE_STALE_MS = ANALYZE_TIMEOUT_MS + 30 * 1000;

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); }
function jobPath(id) {
  const safeId = String(id || '');
  if (!/^[a-f0-9]{24}$/.test(safeId)) throw new Error('Id de análisis inválido');
  return path.join(DATA_DIR, `${safeId}.json`);
}

// Texto plano del hilo para el prompt (más viejo → más nuevo).
export function threadText(thread, contactName) {
  const lines = [`Tema/asunto: ${thread.title || ''}`];
  if (thread.project) lines.push(`Proyecto actual: ${thread.project}`);
  lines.push('Mensajes:');
  for (const m of (thread.messages || [])) {
    const who = m.fromContact ? (contactName || 'contacto') : 'yo';
    lines.push(`- [${who}] ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 800)}`);
  }
  return lines.join('\n');
}
export function threadHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}
// Identidad DETERMINÍSTICA del job: mismo (hilo, contenido) => mismo id (lock
// implícito por identidad — doble click reusa el job, no spawnea duplicado).
export function analyzeJobId(threadId, hash) {
  return crypto.createHash('sha1').update(`${threadId}|${hash}`).digest('hex').slice(0, 24);
}

export function readAnalyzeJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
function pruneOldJobs() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { if (now - fs.statSync(path.join(DATA_DIR, f)).mtimeMs > MAX_AGE_MS) fs.unlinkSync(path.join(DATA_DIR, f)); }
    catch { /* noop */ }
  }
}
export function writeAnalyzeJob(id, data) {
  ensureDir();
  fs.writeFileSync(jobPath(id), JSON.stringify(data), { mode: 0o600 });
  pruneOldJobs();
}

export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= ANALYZE_STALE_MS;
}
export function jobResult(job) {
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', analysis: null, error: 'El análisis no respondió a tiempo. Reintentá.' };
  }
  return { status: job.status, analysis: job.analysis || null, error: job.error || null };
}

export function spawnAnalyzeRunner(id) {
  ensureDir();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const markSpawnError = (err) => {
    try { console.error('[comms] no se pudo lanzar el analyze-runner:', String(err?.message || err)); } catch { /* noop */ }
    const job = readAnalyzeJob(id);
    if (job?.status === 'running') {
      writeAnalyzeJob(id, {
        ...job,
        status: 'error',
        analysis: null,
        error: 'No se pudo lanzar el runner de análisis.',
        updatedAt: Date.now(),
      });
    }
  };
  try {
    const child = spawn(process.execPath, [RUNNER, id], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
    child.on('error', markSpawnError);
    child.unref();
  } catch (err) {
    markSpawnError(err);
    throw err;
  } finally {
    fs.closeSync(logFd);
  }
}

export function analyzePrompt(text, contactName) {
  return [
    `Analizás una conversación de trabajo entre "yo" y "${contactName || 'un contacto'}".`,
    'Leé el hilo y respondé ÚNICAMENTE con un bloque ```json así:',
    '{',
    '  "summary":   "2-4 líneas en criollo: de qué se trata y en qué estado está",',
    '  "topic":     "el tema en 2-5 palabras",',
    '  "project":   "proyecto sugerido en 1-3 palabras (o \\"\\" si no se infiere)",',
    '  "status":    "esperando-al-contacto" | "esperando-a-mi" | "resuelto" | "bloqueado" | "en-curso",',
    '  "nextStep":  "1 línea: la próxima acción concreta para avanzar la comunicación",',
    '  "sentiment": "positivo" | "neutral" | "tenso"',
    '}',
    'Criterio de status: "esperando-al-contacto" = la pelota la tiene el contacto;',
    '"esperando-a-mi" = la pelota es mía; "bloqueado" = trabado por algo externo.',
    'Sé específico y breve. No inventes datos que no estén en el hilo.',
    '',
    '=== HILO ===',
    text || '(sin mensajes)',
  ].join('\n');
}

export function parseAnalysis(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const STATUS = ['esperando-al-contacto', 'esperando-a-mi', 'resuelto', 'bloqueado', 'en-curso'];
  const SENT = ['positivo', 'neutral', 'tenso'];
  return {
    summary: String(o.summary || '').slice(0, 800),
    topic: String(o.topic || '').slice(0, 80),
    project: String(o.project || '').slice(0, 60),
    status: STATUS.includes(o.status) ? o.status : 'en-curso',
    nextStep: String(o.nextStep || '').slice(0, 400),
    sentiment: SENT.includes(o.sentiment) ? o.sentiment : 'neutral',
  };
}
