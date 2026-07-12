// modules/projects/analyze-shared.js — persistencia + prompt del análisis IA
// de UN cambio de sección de contexto (guardián del CLAUDE.md).
//
// REGLA DE ORO (2026-07-04): toda implementación nueva debe sobrevivir a un
// reinicio de la interfaz web. Antes esta corrida (hasta 60s, SDK con haiku)
// vivía DENTRO del handler Express de modules/projects/index.js, atada al
// ciclo de vida del proceso Node — un reinicio a mitad (deploy) la perdía sin
// dejar rastro y sin poder reanudarla (tokens gastados, resultado tirado).
//
// Ahora: el endpoint POST solo escribe el job PENDIENTE acá y spawnea
// bin/cwc-projects-analyze-runner.js DETACHED (unref, sobrevive al proceso
// padre); el runner hace la corrida y persiste el resultado en el MISMO
// archivo. El endpoint GET (y el front, por polling) solo leen el job — igual
// patrón que health/shared.js (readReview/writeReview + runner desacoplado).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo (cwd del SDK)

const DATA_DIR = path.join(os.homedir(), '.cwc-data', 'projects-analyze');
const LOG_FILE = path.join(os.homedir(), '.cwc-data', 'projects-analyze.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-projects-analyze-runner.js');

export const ANALYZE_TIMEOUT_MS = 60 * 1000;
// Corte de un job 'running' cuyo runner murió sin escribir resultado (kill
// -9/OOM): más allá de esto el GET lo reporta como fallido aunque el archivo
// siga diciendo 'running' — nadie más va a actualizarlo.
export const ANALYZE_STALE_MS = ANALYZE_TIMEOUT_MS + 30 * 1000;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function jobPath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

// Identidad DETERMINÍSTICA del job: mismo (proyecto, sección, hash de lo
// anterior, contenido nuevo) => mismo id. Así un doble click o un reintento
// del POST antes de que termine el primero apunta al MISMO job en vez de
// spawnear un runner duplicado (lock implícito por identidad, sin archivo
// .lock aparte — no hay carrera real porque nada relee/pisa el job de otro).
export function analyzeJobId(key, i, hash, after) {
  return crypto.createHash('sha1').update(`${key}|${i}|${hash}|${after}`).digest('hex').slice(0, 24);
}

export function readAnalyzeJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); }
  catch { return null; }
}

// Higiene oportunista: cada job es una foto chica (antes/después de UNA
// sección), pero uno por cada intento de guardado se acumularía sin límite.
// Se poda lo más viejo que un día en cada escritura — no amerita un cron
// aparte para algo tan liviano.
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

export function writeAnalyzeJob(id, data) {
  ensureDir();
  writeJsonAtomic(jobPath(id), data); // atómico tmp-por-PID (BUG-12)
  pruneOldJobs();
}

// ¿Sigue 'corriendo' de verdad? (no superó el corte por staleness).
export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= ANALYZE_STALE_MS;
}

// Estado EFECTIVO para servir al front (GET y respuesta inmediata del POST
// cuando el job ya existía): si quedó 'running' más allá del corte, se
// reporta como error sin depender de que alguien más lo actualice.
export function jobResult(job) {
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', analysis: null, error: 'El análisis no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, analysis: job.analysis || null, error: job.error || null };
}

// Lanza el runner DETACHED (unref): no depende del ciclo de vida del proceso
// Express — un reinicio de la web a mitad de la corrida NO lo mata.
export function spawnAnalyzeRunner(id) {
  ensureDir();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER, id], {
    detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

export function analyzePrompt(before, after) {
  return [
    'Sos el guardián de un CLAUDE.md: la guía operativa que una IA lee antes de',
    'trabajar en un proyecto (reglas duras, prohibiciones, invariantes, mapa).',
    'Compará la versión ANTERIOR y la NUEVA de UNA sección y respondé ÚNICAMENTE',
    'con un bloque ```json así:',
    '{',
    '  "removed":  ["cada regla/prohibición/dato operativo que DESAPARECE"],',
    '  "added":    ["qué se agrega"],',
    '  "modified": ["qué cambia de sentido o se debilita"],',
    '  "risk":     "ok" | "atencion" | "critico",',
    '  "riskWhy":  "1-2 líneas: por qué ese nivel",',
    '  "summary":  "1-2 líneas en criollo: qué hace este cambio"',
    '}',
    'Criterio de risk: "critico" = borra o debilita reglas duras, guardas de',
    'seguridad o invariantes (aunque sea de forma sutil); "atencion" = elimina',
    'contenido operativo o cambia semántica; "ok" = agrega/mejora/reformula sin',
    'pérdida. Arrays vacíos si no aplica. Sé específico y breve.',
    '',
    '=== SECCIÓN ANTERIOR ===',
    before || '(sección nueva: no había contenido)',
    '',
    '=== SECCIÓN NUEVA ===',
    after || '(la sección queda VACÍA: se elimina todo su contenido)',
  ].join('\n');
}

export function parseAnalysis(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  const arr = (x) => (Array.isArray(x) ? x.map((s) => String(s).slice(0, 300)).slice(0, 20) : []);
  return {
    removed: arr(o.removed),
    added: arr(o.added),
    modified: arr(o.modified),
    risk: ['ok', 'atencion', 'critico'].includes(o.risk) ? o.risk : 'atencion',
    riskWhy: String(o.riskWhy || '').slice(0, 500),
    summary: String(o.summary || '').slice(0, 500),
  };
}
