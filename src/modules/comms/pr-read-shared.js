// modules/comms/pr-read-shared.js — LECTOR ÚNICO de un PR de GitHub (Fase C de
// la centralización 2026-07-05). Antes tres motores hacían su propio
// `gh pr view --json …` del MISMO PR (comms runner, bugfixes/prLive,
// investigate-runner) con cachés separadas → triple lectura de red.
//
// Ahora hay UN fetch con SUPERSET de campos (unión de lo que necesita cada
// consumidor) y UNA caché de archivo con TTL corto en ~/.cwc-data/comms/pr-cache/.
// Cada consumidor sigue parseando SOLO los campos que le importan (misma salida
// que antes); lo único que se unifica es el fetch+caché. Si dos consumidores
// piden el mismo PR dentro del TTL, el segundo no toca la red.
import { execFile } from 'node:child_process';
import fss from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { COMMS_DIR, ensureDir } from './shared.js';

const PR_CACHE_DIR = path.join(COMMS_DIR, 'pr-cache');
export const PR_CACHE_TTL_MS = 60 * 1000;

// SUPERSET: unión de los --json de prLive + investigate + comms runner. Si un
// consumidor nuevo necesita otro campo, se agrega ACÁ (una sola fuente).
export const PR_RICH_FIELDS = [
  'number', 'title', 'url', 'state', 'headRefName', 'mergeable', 'reviewDecision',
  'updatedAt', 'createdAt', 'additions', 'deletions', 'changedFiles',
  'statusCheckRollup', 'reviews', 'comments', 'commits', 'author', 'reviewRequests',
].join(',');

function cachePath(n) { return path.join(PR_CACHE_DIR, `${String(n).replace(/[^\d]/g, '')}.json`); }

function readCache(n) {
  try {
    const o = JSON.parse(fss.readFileSync(cachePath(n), 'utf8'));
    if (o && o.ts && Date.now() - o.ts < PR_CACHE_TTL_MS) return o.data;
  } catch { /* miss */ }
  return null;
}
function writeCache(n, data) {
  try { ensureDir(); fss.mkdirSync(PR_CACHE_DIR, { recursive: true, mode: 0o700 }); fss.writeFileSync(cachePath(n), JSON.stringify({ ts: Date.now(), data }), { mode: 0o600 }); }
  catch { /* best-effort */ }
}

function ghView(prNumber, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'view', String(prNumber), '--json', PR_RICH_FIELDS], { cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh pr view #${prNumber}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

// Devuelve el objeto RICO del PR (parseado). fresh=true fuerza red (igual
// escribe la caché para que otros reusen). Lanza si gh falla.
export async function fetchPrRich(prNumber, { fresh = false, cwd = config.projectDir } = {}) {
  if (!fresh) { const c = readCache(prNumber); if (c) return c; }
  const pr = JSON.parse(await ghView(prNumber, cwd));
  writeCache(prNumber, pr);
  return pr;
}
