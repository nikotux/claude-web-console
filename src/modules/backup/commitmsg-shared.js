// modules/backup/commitmsg-shared.js — persistencia + prompt de la generación
// IA del mensaje de commit (botón "Commit (sin push)" del panel Backup).
//
// REGLA DE ORO: toda corrida IA sobrevive a un reinicio de la web. El endpoint
// POST /api/backup/commit-message solo escribe el job PENDIENTE acá y spawnea
// bin/cwc-commitmsg-runner.js DETACHED (unref); el runner hace la corrida
// (haiku, 1 turno, CERO herramientas — regla 6 con TODO denegado: el diff va
// entero en el prompt) y persiste el resultado en el MISMO archivo. El front
// encuesta GET /commit-message/:id — mismo patrón que projects/analyze-shared.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo (cwd del SDK)

const DATA_DIR = path.join(os.homedir(), '.cwc-data', 'commitmsg');
const LOG_FILE = path.join(os.homedir(), '.cwc-data', 'commitmsg.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-commitmsg-runner.js');

export const COMMITMSG_TIMEOUT_MS = 60 * 1000;
// Corte de un job 'running' cuyo runner murió sin escribir resultado.
export const COMMITMSG_STALE_MS = COMMITMSG_TIMEOUT_MS + 30 * 1000;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function jobPath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

// Identidad DETERMINÍSTICA: mismo estado del árbol (diff + untracked elegidos)
// => mismo id. Un doble click apunta al MISMO job en vez de duplicar corridas.
export function commitMsgJobId(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 24);
}

export function readCommitMsgJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); }
  catch { return null; }
}

// Higiene oportunista: un job por estado del árbol; se poda lo más viejo que
// un día en cada escritura (mismo criterio que projects-analyze).
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
function pruneOldJobs() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(DATA_DIR, f);
    try {
      if (now - fs.statSync(full).mtimeMs > MAX_AGE_MS) fs.unlinkSync(full);
    } catch { /* noop */ }
  }
}

export function writeCommitMsgJob(id, data) {
  ensureDir();
  fs.writeFileSync(jobPath(id), JSON.stringify(data), { mode: 0o600 });
  pruneOldJobs();
}

export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= COMMITMSG_STALE_MS;
}

// Estado EFECTIVO para el front: un 'running' pasado el corte se reporta como
// error sin depender de que alguien más actualice el archivo.
export function jobResult(job) {
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', message: null, error: 'La generación no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, message: job.message || null, error: job.error || null };
}

// Lanza el runner DETACHED (unref): un reinicio de la web NO lo mata.
export function spawnCommitMsgRunner(id) {
  ensureDir();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER, id], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

export function commitMsgPrompt({ files, untracked, diff }) {
  return [
    'Redactás el mensaje de commit de un repo personal (una consola web Node).',
    'Convención del repo: mensajes EN ESPAÑOL, descriptivos, estilo imperativo.',
    'Mirá los cambios y respondé ÚNICAMENTE con un bloque ```json así:',
    '{ "message": "asunto de ≤72 caracteres, sin punto final\\n\\ncuerpo opcional: 1-4 líneas con el porqué/detalle si aporta" }',
    'Si hay varios temas sin relación, resumí el conjunto en el asunto y detallá',
    'por tema en el cuerpo (una línea por tema, con guiones).',
    '',
    '=== ARCHIVOS TRACKEADOS QUE CAMBIAN (letra de git: M/A/D/R) ===',
    (files || []).join('\n') || '(ninguno)',
    '',
    '=== ARCHIVOS NUEVOS QUE SE INCLUYEN ===',
    (untracked || []).join('\n') || '(ninguno)',
    '',
    '=== DIFF (puede estar truncado) ===',
    diff || '(sin diff disponible: guiate por la lista de archivos)',
  ].join('\n');
}

export function parseCommitMsg(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const msg = String(o.message || '').replace(/\r/g, '').trim().slice(0, 2000);
  return msg || null;
}
