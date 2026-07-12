// modules/learning/context-shared.js — "🎙️ Contexto adicional" de un TEMA de
// aprendizaje: pegás la transcripción de una charla (con Chris, con el equipo,
// un fragmento de otro chat) y la IA la interpreta y destila lo que le sirve a
// quien va a estudiar/aplicar el tema. Mismo patrón que
// tickets/context-analyze-shared.js, pero alcance PROPIO (0 acoplamiento entre
// módulos — el aprendizaje no es del dominio de tickets/PRs).
//
// REGLA DE ORO: consume tokens ⇒ RUNNER DESACOPLADO
// (bin/cwc-learning-context-runner.js, detached+unref). El endpoint POST
// persiste el job PENDIENTE acá y lo spawnea; el runner persiste el resultado
// en el MISMO archivo y AUTO-GUARDA el texto interpretado en el tema
// (store.saveContexto). El front encuesta el GET (0 tokens).
//
// REGLA 6 (blindaje read-only): a diferencia de "Explicame esto" (que SÍ
// navega código), acá la corrida es de TEXTO PURO — CERO herramientas en las
// DOS capas (hook PreToolUse + canUseTool deniegan TODO). El texto de la
// transcripción viaja entero en el prompt; nunca lee/escribe disco.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const LOG_FILE = path.join(DATA_DIR, 'learning-context.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-learning-context-runner.js');

export const CONTEXT_MAX_TURNS = 1;
export const CONTEXT_TIMEOUT_MS = 4 * 60 * 1000;
export const CONTEXT_STALE_MS = CONTEXT_TIMEOUT_MS + 30 * 1000;
export const CONTEXT_MODEL = 'sonnet';
export const MAX_TRANSCRIPT = 120000;

// Cero herramientas: ninguna tool está permitida (regla 6, doble capa).
export function contextToolAllowed() { return false; }

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); }
function jobPath(id) { return path.join(DATA_DIR, `learning-context-${id}.json`); }

// id DETERMINÍSTICO por tema+transcripción: un reintento con el mismo texto
// reusa el MISMO job (no gasta tokens de nuevo), mismo patrón que tickets.
export function contextJobId(topicId, transcript) {
  return crypto.createHash('sha1').update(`${topicId}\n${transcript}`).digest('hex').slice(0, 24);
}

export function readContextJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}
export function writeContextJob(id, data) {
  ensureDir();
  writeJsonAtomic(jobPath(id), data); // tmp-por-PID (BUG-30)
}
export function isContextFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= CONTEXT_STALE_MS;
}
export function contextJobResult(job) {
  if (!job) return { status: 'idle', error: null };
  if (job.status === 'running' && !isContextFreshRunning(job)) {
    return { status: 'error', error: 'La interpretación no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, error: job.error || null };
}

export function spawnLearningContextRunner(id) {
  ensureDir();
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER, id], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

export function contextPrompt({ transcript, itemTitle, itemDesc }) {
  return [
    'Sos un analista que ayuda a un desarrollador a ESTUDIAR un tema técnico.',
    'Te paso la TRANSCRIPCIÓN de una charla (con un compañero, con Chris, notas de',
    'una reunión, o un fragmento de otro chat) relacionada con este tema de',
    'aprendizaje. Interpretá quién dijo qué y por qué, y destilá el CONTEXTO',
    'ADICIONAL que le sirve a quien vaya a estudiar/aplicar el tema: qué se',
    'explicó realmente, decisiones o convenciones mencionadas, datos concretos y',
    'ejemplos.',
    '',
    '== Tema ==',
    `Título: ${itemTitle || '(sin título)'}`,
    itemDesc ? `Notas previas del tema: ${String(itemDesc).slice(0, 2000)}` : '',
    '',
    'Respondé SOLO con un bloque ```json``` con esta forma exacta:',
    '{',
    '  "resumen": "2-4 frases con lo clave que aporta la charla para este tema",',
    '  "puntosClave": ["dato / explicación / convención concreta", "..."],',
    '  "ejemplos": ["ejemplo concreto mencionado en la charla", "..."],',
    '  "relevancia": "una frase: en qué cambia esto cómo entender/aplicar el tema"',
    '}',
    'No inventes: si algo no está en la charla, omitilo. Sé concreto y breve.',
    '',
    '== Transcripción ==',
    String(transcript),
  ].filter((l) => l !== '').join('\n');
}

export function parseContext(text) {
  const s = String(text || '');
  const fences = [...s.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (s.match(/\{[\s\S]*\}/) || [''])[0];
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  const arr = (a, n, m) => (Array.isArray(a) ? a.map((x) => String(x || '').slice(0, m)).filter(Boolean).slice(0, n) : []);
  return {
    resumen: String(obj.resumen || '').slice(0, 2000),
    puntosClave: arr(obj.puntosClave, 30, 500),
    ejemplos: arr(obj.ejemplos, 30, 500),
    relevancia: String(obj.relevancia || '').slice(0, 800),
  };
}

// Texto plano legible (lo que se guarda como contextoAdicional del tema).
export function renderContextText(c) {
  if (!c) return '';
  const lines = [];
  if (c.resumen) lines.push(c.resumen, '');
  if (c.puntosClave?.length) { lines.push('Puntos clave:'); c.puntosClave.forEach((p) => lines.push(`- ${p}`)); lines.push(''); }
  if (c.ejemplos?.length) { lines.push('Ejemplos:'); c.ejemplos.forEach((p) => lines.push(`- ${p}`)); lines.push(''); }
  if (c.relevancia) lines.push(`Relevancia: ${c.relevancia}`);
  return lines.join('\n').trim();
}
