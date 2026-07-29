// modules/retro/verify-shared.js — MEDIDOR REAL de efectividad de Mejora
// Continua (M1 de DOC-1926, PLAN-1937). BUG-1930 dejó el semáforo
// estructuralmente ciego al feedback de Chris: su `recurrence` interno no puede
// subir nunca. La única señal posible es EXTERNA: rondas de review de Chris
// sobre los PRs de `sourceRefs` posteriores a `promotedAt`.
//
// 0 TOKENS: no usa el SDK; lee los PRs con el lector único ya cacheado
// comms/pr-read-shared.js. Runner DESACOPLADO por regla dura 2: estado en
// archivos, lock con heartbeat pid-aware y progreso incremental REANUDABLE;
// sobrevive a un reinicio de la interfaz web.
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { resolveDataDir } from '../../core/data-dir.js';
import { hostUser, userDataDir, userRunnerEnv } from '../../core/user-space.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'bin', 'cwc-retro-verify-runner.js');

export const VERIFY_HEARTBEAT_MS = 5000;
export const VERIFY_LOCK_FRESH_MS = 30000;
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
export const VERIFY_TTL_MS = 6 * 60 * 60 * 1000;
export const PR_ENTRY_TTL_MS = 30 * 60 * 1000;
export const ROUND_EXCERPT = 240;
export const MAX_ROUNDS_PER_PR = 40;

function dataDirFor(owner = null) { return owner ? userDataDir(owner) : resolveDataDir(); }
export function verifyFileFor(owner = null) { return path.join(dataDirFor(owner), 'retro-verify.json'); }
function lockFileFor(owner = null) { return path.join(dataDirFor(owner), 'retro-verify.lock'); }
function logFileFor(owner = null) { return path.join(dataDirFor(owner), 'retro-verify.log'); }
function ensureDir(owner = null) { try { fss.mkdirSync(dataDirFor(owner), { recursive: true, mode: 0o700 }); } catch { /* noop */ } }

export function emptyVerifyState() {
  return {
    status: 'idle',
    startedAt: 0,
    scannedAt: 0,
    error: null,
    progress: { done: 0, total: 0 },
    prs: {},
    lessons: {},
    summary: null,
  };
}

const memoByFile = new Map();

export function readVerifyState(owner = null) {
  const file = verifyFileFor(owner);
  const memo = memoByFile.get(file);
  try {
    const stat = fss.statSync(file);
    if (memo?.data && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.data;
    const data = JSON.parse(fss.readFileSync(file, 'utf8'));
    memoByFile.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    // SOLO LECTURA para consumidores: el objeto está compartido por el memo.
    return data;
  } catch {
    return emptyVerifyState();
  }
}

export function writeVerifyState(data, owner = null) {
  ensureDir(owner);
  const file = verifyFileFor(owner);
  writeJsonAtomic(file, data);
  memoByFile.delete(file);
}

export function writeVerifyLock(state, owner = null) {
  try { ensureDir(owner); fss.writeFileSync(lockFileFor(owner), JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 }); }
  catch { /* noop */ }
}
export function clearVerifyLock(owner = null) { try { fss.unlinkSync(lockFileFor(owner)); } catch { /* noop */ } }
export function readVerifyLock(owner = null) {
  try {
    const l = JSON.parse(fss.readFileSync(lockFileFor(owner), 'utf8'));
    if (Date.now() - l.ts >= VERIFY_LOCK_FRESH_MS) return null; // heartbeat vencido
    // pid-aware: un lock fresco cuyo proceso YA murió (kill -9, reinicio) no puede
    // bloquear el reintento — el heartbeat solo no alcanza dentro de su ventana.
    if (l.pid && l.pid !== process.pid) {
      try { process.kill(l.pid, 0); } catch (e) { if (e?.code === 'ESRCH') return null; }
    }
    return l;
  } catch { return null; }
}
export function isVerifyRunning(owner = null) { return !!readVerifyLock(owner); }
export function isVerifyStale(state, owner = null) {
  const s = state || readVerifyState(owner);
  return !s?.scannedAt || (Date.now() - s.scannedAt) > VERIFY_TTL_MS;
}

// Spawn con reserva SINCRÓNICA del lock usando el pid REAL del hijo: el pid ya
// existe al volver spawn, antes de que el runner ejecute su chequeo pid-aware.
export function spawnRetroVerifyRunner({ full = false, owner = null } = {}) {
  ensureDir(owner);
  const logFile = logFileFor(owner);
  const logFd = fss.openSync(logFile, 'a');
  const env = owner && owner !== hostUser() ? userRunnerEnv(owner) : process.env;
  const child = spawn(process.execPath, [RUNNER, ...(full ? ['--full'] : [])], {
    detached: true, stdio: ['ignore', logFd, logFd], env,
  });
  writeVerifyLock({ pid: child.pid }, owner);
  child.on('error', (err) => {
    try { fss.appendFileSync(logFile, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ }
    try { clearVerifyLock(owner); } catch { /* noop */ }
  });
  child.unref();
  fss.closeSync(logFd);
}

// Resuelve los sourceRefs de una lección a números de PR.
// `PR-n` es DIRECTO. `TKT-n` es CANDIDATO: la ingesta de julio-2026 guardó
// números de PR bajo el prefijo TKT (MC-740/741/742/743/745/746), pero TKT-n
// también puede ser un ticket de Desk (MC-744 → TKT-617, que no es un PR).
// Por eso un candidato solo cuenta si ese PR EXISTE y lo escribimos nosotros
// (lo decide el runner tras el fetch). DESK-n / FEAT-n nunca son PRs.
export function prRefsFrom(sourceRefs = []) {
  const direct = []; const candidates = []; const ignored = [];
  for (const raw of (Array.isArray(sourceRefs) ? sourceRefs : [])) {
    const s = String(raw || '').trim().toUpperCase();
    let m = s.match(/^PR-(\d+)$/);
    if (m) { const n = Number(m[1]); if (!direct.includes(n)) direct.push(n); continue; }
    m = s.match(/^TKT-(\d+)$/);
    if (m) { const n = Number(m[1]); if (!candidates.includes(n)) candidates.push(n); continue; }
    if (s) ignored.push(s);
  }
  return { direct, candidates, ignored };
}

const excerptOf = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, ROUND_EXCERPT);

// Extrae las RONDAS de Chris de un PR ya traído por fetchPrRich.
// Una review APPROVED NO es una ronda: es lo contrario (evidencia de que la
// entrega pasó). Cuentan las reviews CHANGES_REQUESTED/COMMENTED/DISMISSED y
// TODOS los comentarios de issue del revisor — medido sobre el histórico real
// de Tolkien, el feedback sustantivo de Chris llega casi siempre como comment.
export function chrisRoundsFromPr(pr, login) {
  const rounds = [];
  for (const r of (pr?.reviews || [])) {
    if (String(r?.author?.login || '') !== login) continue;
    const state = String(r?.state || '');
    if (state === 'APPROVED') continue;
    const at = Date.parse(r?.submittedAt || '');
    if (!Number.isFinite(at)) continue;
    rounds.push({ at, kind: 'review', state, excerpt: excerptOf(r?.body) });
  }
  for (const c of (pr?.comments || [])) {
    if (String(c?.author?.login || '') !== login) continue;
    const at = Date.parse(c?.createdAt || '');
    if (!Number.isFinite(at)) continue;
    rounds.push({ at, kind: 'comment', state: '', excerpt: excerptOf(c?.body) });
  }
  rounds.sort((a, b) => a.at - b.at);
  return rounds.slice(-MAX_ROUNDS_PER_PR);
}

// Agrega la evidencia de UNA lección: rondas posteriores a promotedAt sobre sus PRs.
// target = { id, promotedAt, prs:[n], unresolved:[string] }; prsState = mapa nro→{rounds:[]}
export function aggregateLesson(target, prsState) {
  const rounds = [];
  for (const n of (target.prs || [])) {
    for (const r of (prsState?.[n]?.rounds || [])) {
      if (r.at > target.promotedAt) rounds.push({ pr: n, ...r });
    }
  }
  rounds.sort((a, b) => a.at - b.at);
  return {
    prs: target.prs || [],
    unresolved: target.unresolved || [],
    rounds: rounds.length,
    lastAt: rounds.length ? rounds[rounds.length - 1].at : 0,
    sample: rounds.slice(-3),
    checkedAt: Date.now(),
  };
}

export function verifyForLesson(state, id) {
  const l = state && state.lessons && typeof state.lessons === 'object' ? state.lessons[id] : null;
  return (l && typeof l === 'object') ? l : null;
}
