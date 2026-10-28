// modules/health/scan-shared.js — ESCANEO DE SALUD UNIFICADO (2026-07-12).
//
// Un solo "botón" que corre TODO en una pasada: Revisión Exhaustiva + Optimización
// IA + Coherencia, bajo UN pool adaptativo compartido (paralelización aplicada a
// TODO, no solo a la Revisión) + cross-check contra el backlog de Pad. La lógica
// de cada motor NO se reescribe: el orquestador (bin/cwc-health-scan-runner.js)
// invoca los prompts/parsers/escritores YA existentes (health/shared,
// optimize-shared, coherence-shared) y escribe los MISMOS archivos de resultado
// (review/optimization/coherence.json) — así todas las acciones de aprobar/fix
// siguen funcionando sin cambios. Este módulo aporta solo la ORQUESTACIÓN: lock +
// estado por fases (health-scan.json) + el cross-check con Pad.
//
// SEGURIDAD (regla 6): el orquestador NO debilita nada — cada query mantiene su
// allowlist read-only doble capa. Esto es plomería (estado/lock/reconciliación),
// como scan no toca herramientas del modelo.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import * as padLocal from '../../core/pad-service-client.js';
import { loadArquiIndex, linkItemToArqui } from './arqui-link-shared.js';
import { loadCorpus, classifyFinding, rulesStatus } from './finding-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const SCAN_FILE = path.join(DATA_DIR, 'health-scan.json');
export const SCAN_LOCK_FILE = path.join(DATA_DIR, 'health-scan.lock');
const SCAN_LOG = path.join(DATA_DIR, 'health-scan.log');
const SCAN_RUNNER = path.join(ROOT, 'bin', 'cwc-health-scan-runner.js');
export const SCAN_HEARTBEAT_MS = 3000;
export const SCAN_LOCK_FRESH_MS = 20000;
// Corte duro: el escaneo completo (Revisión ~16 unidades + Optim + Coherencia +
// síntesis) puede tardar varios minutos; más allá de esto un 'running' se reporta
// como error (runner muerto) sin colgar el botón.
export const SCAN_STALE_MS = 20 * 60 * 1000;

// ===== Estado (health-scan.json) =====
export function readScan() {
  try { return JSON.parse(fss.readFileSync(SCAN_FILE, 'utf8')); } catch { return null; }
}
export function writeScan(data) {
  try { fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); writeJsonAtomic(SCAN_FILE, data); }
  catch (err) { console.error('[health-scan] no pude escribir estado:', err?.message); }
}
export function isScanFresh(job) {
  return !!job && job.running === true && (Date.now() - (job.startedAt || 0)) <= SCAN_STALE_MS;
}
// Estado EFECTIVO para el front: si quedó 'running' pasado el corte → error.
export function scanStatus(job) {
  if (!job) return { running: false, phase: null, progress: null, pad: null, verdict: null, error: null, startedAt: null, finishedAt: null };
  if (job.running && !isScanFresh(job)) {
    return { ...job, running: false, error: 'El escaneo no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return job;
}

// ===== Lock del orquestador (heartbeat, reserva pid-aware — patrón BUG-48) =====
export function writeScanLock(pid) {
  try { fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fss.writeFileSync(SCAN_LOCK_FILE, JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 }); }
  catch { /* noop */ }
}
export function clearScanLock() { try { fss.unlinkSync(SCAN_LOCK_FILE); } catch { /* noop */ } }
export function readScanLock() {
  try { return JSON.parse(fss.readFileSync(SCAN_LOCK_FILE, 'utf8')); } catch { return null; }
}
export function isScanRunning() {
  try { const { ts } = JSON.parse(fss.readFileSync(SCAN_LOCK_FILE, 'utf8')); return Date.now() - ts < SCAN_LOCK_FRESH_MS; }
  catch { return false; }
}

// Lanza el orquestador DETACHED (regla de oro). El server reserva el lock con
// pid:0 ANTES (spawnScan en index.js) para cerrar la ventana TOCTOU; el runner lo
// reclama con su pid. `mode` = 'incremental' (default) | 'full'.
export function spawnScanRunner(mode = 'incremental') {
  fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const logFd = fss.openSync(SCAN_LOG, 'a');
  const args = [SCAN_RUNNER];
  if (mode === 'full') args.push('--full');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
  child.on('error', () => { try { clearScanLock(); } catch { /* noop */ } }); // spawn falló → liberar la reserva (patrón BUG-44)
  child.unref();
  fss.closeSync(logFd);
}

// ===== Cross-check con el backlog de Pad (0 tokens, best-effort) =====
// Reconciliación HEURÍSTICA de los hallazgos de la Revisión contra la colección
// Bugs de Pad (workspace console): cada hallazgo se etiqueta
//   · rastreado  → matchea un BUG ABIERTO (no re-reportar, ya está en el backlog)
//   · regresion  → matchea un BUG fixed/wontfix (¡volvió pese a estar cerrado!)
//   · nuevo      → sin match (candidato a crear BUG en Pad, con confirmación)
// El match es conservador (mismo módulo + solape de términos): ante la duda,
// "nuevo" (que el humano linkee), nunca un falso "rastreado" que oculte algo real.
const STOP = new Set(['the', 'and', 'que', 'los', 'las', 'del', 'con', 'por', 'para', 'una', 'este', 'esta', 'sin', 'más', 'como', 'que', 'sus', 'the']);
function terms(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9áéíóúñ_]+/gi, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}
function moduleKeyOfFinding(f) {
  const file = String(f.file || '');
  const m = file.match(/src\/modules\/([a-z0-9-]+)/i) || file.match(/(?:^|\/)(core|bin)\b/i);
  if (m) return m[1].toLowerCase();
  const mm = String(f.module || f.unit || '').match(/([a-z0-9-]+)\s*$/i);
  return mm ? mm[1].toLowerCase() : '';
}
function parseBugFields(item) {
  const f = item?.fields;
  if (f && typeof f === 'object') return f;
  if (typeof f === 'string') { try { return JSON.parse(f); } catch { return {}; } }
  return {};
}

export async function crossCheckPad(findings = []) {
  // Orden DOC-1925: anillo determinista (reglas medidas) → dedup heurístico
  // contra Pad (nunca auto-mergea: etiqueta y deja link) → IA sólo sobre el
  // residuo. Hoy activeRules=0 porque ninguna regla fue aprobada, por lo que
  // deterministic queda null y el comportamiento observable no cambia; el
  // cableado se enciende solo cuando una regla supera la vara medida.
  const corpus = loadCorpus();
  const rules = rulesStatus();
  const classified = findings.map((finding) => ({
    finding,
    deterministic: classifyFinding(finding, corpus) ?? null,
  }));
  let bugs = [];
  try {
    // BUG-1792: sin `all` solo se omiten soft-deleted, no terminales (fixed/wontfix), preservando regresiones; `all=true` dio 0 vs 60 en el Pad local (verificado en vivo 2026-07-24; ver nota en pad-service-client.js).
    const r = await padLocal.listItems('bugs', { workspace: 'console' });
    if (!r || !r.ok) return { available: false, error: String(r?.error || 'Pad no respondió').slice(0, 160), nuevo: [], rastreado: [], regresion: [], openCount: 0, rules };
    bugs = (r && (r.data || r.items || r)) || [];
    if (!Array.isArray(bugs)) bugs = [];
  } catch (err) {
    return { available: false, error: String(err?.message || err).slice(0, 160), nuevo: [], rastreado: [], regresion: [], openCount: 0, rules };
  }
  const bugIndex = bugs.map((b) => {
    const bf = parseBugFields(b);
    return { ref: b.ref, title: b.title || '', status: bf.status || 'open', module: String(bf.module || '').toLowerCase(), terms: terms(`${b.title} ${b.content || ''}`) };
  });
  const OPEN = new Set(['open', 'verifying']);
  const out = { available: true, error: null, nuevo: [], rastreado: [], regresion: [], openCount: bugIndex.filter((b) => OPEN.has(b.status)).length, rules };
  for (const { finding: f, deterministic } of classified) {
    const fk = moduleKeyOfFinding(f);
    const ft = terms(`${f.area || ''} ${f.detail || ''}`);
    let best = null; let bestScore = 0;
    for (const b of bugIndex) {
      if (fk && b.module && b.module !== fk) continue; // mismo módulo (si ambos lo declaran)
      const s = jaccard(ft, b.terms);
      if (s > bestScore) { bestScore = s; best = b; }
    }
    const compact = { area: f.area, detail: String(f.detail || '').slice(0, 200), file: f.file || null, module: fk || null, severity: f.severity || 'medium', kind: f.kind || null, match: best ? { ref: best.ref, title: best.title, score: Math.round(bestScore * 100) } : null, deterministic };
    if (best && bestScore >= 0.18) {
      if (OPEN.has(best.status)) out.rastreado.push(compact);
      else out.regresion.push(compact); // matchea un BUG fixed/wontfix → reapareció
    } else {
      out.nuevo.push(compact);
    }
  }
  return out;
}

// Write-back: crear un BUG en Pad desde un hallazgo NUEVO confirmado (con OK del
// humano en el front). 0 tokens (HTTP a Pad). Devuelve el ref creado.
export async function createBugFromFinding(finding = {}) {
  const SEV = { critical: 'alta', high: 'alta', medium: 'media', low: 'baja' };
  const title = String(finding.area || finding.detail || 'Hallazgo de salud').split('\n')[0].slice(0, 140);
  const body = [
    finding.detail ? String(finding.detail).slice(0, 1000) : '',
    finding.file ? `\n\nArchivo: ${finding.file}` : '',
    '\n\n(Creado desde el Escaneo de Salud unificado — hallazgo NUEVO no rastreado.)',
  ].join('');
  const r = await padLocal.createItem('bugs', {
    title,
    content: body,
    fields: {
      status: 'open',
      severity: SEV[finding.severity] || 'media',
      module: String(finding.module || '').toLowerCase() || undefined,
      codex: 'pending',
    },
  }, { workspace: 'console' });
  if (!r || !r.ok) {
    const err = new Error(`Pad no aceptó el BUG: ${r?.error || 'error'}`);
    err.upstream = true;
    throw err;
  }
  const ref = r.data?.ref || null;
  if (ref) {
    try { const idx = await loadArquiIndex(); await linkItemToArqui(ref, finding, idx); }
    catch (err) { console.error('[health-scan] link ARQUI del BUG falló (best-effort):', err?.message); }
  }
  return ref;
}
