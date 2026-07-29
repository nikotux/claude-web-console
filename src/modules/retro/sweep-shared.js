// modules/retro/sweep-shared.js — BUG-2068: descubre transcripts TUI que no
// pasan por Chat.close y encola su destilación de Mejora Continua. El barrido
// consume 0 TOKENS (no usa el SDK, así que la regla 6 no aplica) y corre en un
// runner desacoplado por la regla dura 2, con estado en archivos y lock
// pid-aware con heartbeat (patrón calcado de verify-shared.js).
//
// retro-swept.json es un registro DURABLE que NUNCA se poda, con el mismo
// espíritu que chat-session-ids.json: evita reevaluar para siempre tanto lo
// encolado como lo descartado por el filtro híbrido. El barrido enumera el
// `.claude/projects` del host y de cada inquilino, y conserva el owner hasta el
// job/runner/Pad de destino.
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import {
  hostUser, userClaudeDir, userDataDir, userSpace,
} from '../../core/user-space.js';
import { queueRetroDistill, readRetroJob, retroJobId } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
// Una ventana corta partiría en dos una sesión larga que simplemente hizo una pausa.
export const SWEEP_QUIET_MS = 6 * 60 * 60 * 1000;
export const SWEEP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const SWEEP_MAX_PER_RUN = 5;
export const SWEEP_EVERY_MS = 60 * 60 * 1000;
export const SWEEP_BOOT_DELAY_MS = 2 * 60 * 1000;
export const SWEEP_LOCK_FRESH_MS = 30000;
export const SWEEP_HEARTBEAT_MS = 5000;
export const SWEEP_MAX_BYTES = 8 * 1024 * 1024;

const HEAD_BYTES = 256 * 1024;
const RUNNER = path.join(ROOT, 'bin', 'cwc-retro-sweep-runner.js');
const EMPTY_STATE = {
  status: 'idle',
  startedAt: 0,
  finishedAt: 0,
  result: null,
  error: null,
};

function dataDir() { return userDataDir(hostUser()); }
function sweepStateFile() { return path.join(dataDir(), 'retro-sweep.json'); }
function sweepLockFile() { return path.join(dataDir(), 'retro-sweep.lock'); }
function sweepLogFile() { return path.join(dataDir(), 'retro-sweep.log'); }
function sweptFile() { return path.join(dataDir(), 'retro-swept.json'); }

export function ensureDir() {
  try { fss.mkdirSync(dataDir(), { recursive: true, mode: 0o700 }); }
  catch { /* noop */ }
}

export function readSwept() {
  try {
    const data = JSON.parse(fss.readFileSync(sweptFile(), 'utf8'));
    if (!data?.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) {
      return { sessions: {} };
    }
    return data;
  } catch {
    return { sessions: {} };
  }
}

export function writeSwept(data) {
  try {
    ensureDir();
    writeJsonAtomic(sweptFile(), { ...data, updatedAt: Date.now() });
  } catch { /* best-effort */ }
}

export function readSweepState() {
  try {
    const data = JSON.parse(fss.readFileSync(sweepStateFile(), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...EMPTY_STATE };
    return { ...EMPTY_STATE, ...data };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function writeSweepState(data) {
  try {
    ensureDir();
    writeJsonAtomic(sweepStateFile(), { ...EMPTY_STATE, ...data });
  } catch { /* best-effort */ }
}

export function writeSweepLock(state) {
  try {
    ensureDir();
    fss.writeFileSync(sweepLockFile(), JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}

export function clearSweepLock() {
  try { fss.unlinkSync(sweepLockFile()); }
  catch { /* noop */ }
}

export function readSweepLock() {
  try {
    const l = JSON.parse(fss.readFileSync(sweepLockFile(), 'utf8'));
    if (Date.now() - l.ts >= SWEEP_LOCK_FRESH_MS) return null; // heartbeat vencido
    // pid-aware: un lock fresco cuyo proceso YA murió (kill -9, reinicio) no puede
    // bloquear el reintento — el heartbeat solo no alcanza dentro de su ventana.
    if (l.pid && l.pid !== process.pid) {
      try { process.kill(l.pid, 0); }
      catch (e) { if (e?.code === 'ESRCH') return null; }
    }
    return l;
  } catch {
    return null;
  }
}

export function isSweepRunning() {
  return !!readSweepLock();
}

// Reserva SINCRÓNICA del lock usando el pid REAL del hijo: el pid ya existe al
// volver spawn, antes de que el runner ejecute su chequeo pid-aware.
export function spawnRetroSweepRunner(args = []) {
  ensureDir();
  const logFile = sweepLogFile();
  let logFd = null;
  try {
    logFd = fss.openSync(logFile, 'a');
    const child = spawn(process.execPath, [RUNNER, ...args], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    writeSweepLock({ pid: child.pid });
    child.on('error', (err) => {
      try {
        fss.appendFileSync(
          logFile,
          `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`,
        );
      } catch { /* noop */ }
      clearSweepLock();
    });
    child.unref();
    fss.closeSync(logFd);
    return child.pid;
  } catch (err) {
    try {
      fss.appendFileSync(
        logFile,
        `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`,
      );
    } catch { /* noop */ }
    clearSweepLock();
    if (logFd !== null) {
      try { fss.closeSync(logFd); } catch { /* noop */ }
    }
    return null;
  }
}

export function readHead(file, bytes = HEAD_BYTES) {
  let fd = null;
  try {
    fd = fss.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fss.readSync(fd, buffer, 0, bytes, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const end = text.lastIndexOf('\n');
    return end >= 0 ? text.slice(0, end) : '';
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fss.closeSync(fd); } catch { /* noop */ }
    }
  }
}

export function transcriptMeta(file) {
  let entrypoint = '';
  let cwd = '';
  let title = '';
  let titleFromAi = false;
  try {
    for (const line of readHead(file).split('\n')) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!entrypoint && o?.entrypoint) entrypoint = String(o.entrypoint);
      if (!cwd && o?.cwd) cwd = String(o.cwd);

      if (o?.type === 'ai-title' && o.aiTitle) {
        title = String(o.aiTitle).slice(0, 120).trim();
        titleFromAi = !!title;
      } else if (!title && o?.type === 'user') {
        const content = o?.message?.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          if (content.some((block) => block?.type === 'tool_result')) continue;
          text = content
            .filter((block) => block?.type === 'text')
            .map((block) => block.text || '')
            .join(' ');
        }
        text = String(text || '').trim();
        if (text && !text.startsWith('<')) title = text.slice(0, 120).trim();
      }

      // Si el título vino de ai-title ya no puede aparecer uno de mayor
      // prioridad; si vino del usuario seguimos para permitir que ai-title gane.
      if (entrypoint && cwd && title && titleFromAi) break;
    }
  } catch { /* best-effort */ }
  return { entrypoint, cwd, title };
}

export function knownSessionIds(owner = hostUser()) {
  const ids = new Set();
  const ownerDataDir = userDataDir(owner);

  // Cinturón y tirantes: entrypoint === 'cli' ya deja fuera los motores del
  // SDK, pero un chat que pasó a modo TUI escribe líneas cli en el MISMO
  // transcript y Chat.close ya lo cubre.
  try {
    const data = JSON.parse(fss.readFileSync(path.join(ownerDataDir, 'chat-session-ids.json'), 'utf8'));
    if (Array.isArray(data)) {
      for (const id of data) if (typeof id === 'string' && id) ids.add(id);
    }
  } catch { /* best-effort independiente */ }

  try {
    const data = JSON.parse(fss.readFileSync(path.join(ownerDataDir, 'chats.json'), 'utf8'));
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item?.sessionId === 'string' && item.sessionId) ids.add(item.sessionId);
      }
    }
  } catch { /* best-effort independiente */ }

  try {
    const data = JSON.parse(fss.readFileSync(path.join(ownerDataDir, 'learning-session-ids.json'), 'utf8'));
    if (Array.isArray(data)) {
      for (const id of data) if (typeof id === 'string' && id) ids.add(id);
    }
  } catch { /* best-effort independiente */ }

  try {
    const data = JSON.parse(fss.readFileSync(path.join(ownerDataDir, 'bugfixes.json'), 'utf8'));
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item?.sessionId === 'string' && item.sessionId) ids.add(item.sessionId);
      }
    }
  } catch { /* best-effort independiente */ }

  return ids;
}

function ownersWithClaudeHomes() {
  const host = hostUser();
  const owners = [host];
  const tenantsRoot = path.join(userSpace(host), '.cwc-users');
  let entries = [];
  try { entries = fss.readdirSync(tenantsRoot, { withFileTypes: true }); }
  catch { return owners; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      // userClaudeDir valida el id con la misma whitelist de todo user-space.
      userClaudeDir(entry.name);
      owners.push(entry.name);
    } catch { /* directorio fuera del contrato: no se barre */ }
  }
  return owners;
}

export function listTuiTranscripts({
  maxAgeMs = SWEEP_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  const items = [];
  const stats = { scanned: 0, viejo: 0, grande: 0, noCli: 0 };
  for (const owner of ownersWithClaudeHomes()) {
    const claudeDir = userClaudeDir(owner);
    const projectsDir = path.join(claudeDir, 'projects');
    let dirs = [];
    try { dirs = fss.readdirSync(projectsDir, { withFileTypes: true }); }
    catch { continue; }

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const projectDir = path.join(projectsDir, dir.name);
      let files = [];
      try { files = fss.readdirSync(projectDir, { withFileTypes: true }); }
      catch { continue; }

      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        stats.scanned += 1;
        const file = path.join(projectDir, entry.name);
        let stat;
        try { stat = fss.statSync(file); } catch { continue; }
        if (now - stat.mtimeMs > maxAgeMs) {
          stats.viejo += 1;
          continue;
        }
        if (stat.size > SWEEP_MAX_BYTES) {
          stats.grande += 1;
          continue;
        }
        const meta = transcriptMeta(file);
        if (meta.entrypoint !== 'cli' || !meta.cwd) {
          stats.noCli += 1;
          continue;
        }
        items.push({
          sessionId: entry.name.slice(0, -'.jsonl'.length),
          owner,
          cwd: meta.cwd,
          title: meta.title,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          file,
          claudeDir,
        });
      }
    }
  }

  return { items, stats };
}

export async function sweepTuiTranscripts({
  quietMs = SWEEP_QUIET_MS,
  maxAgeMs = SWEEP_MAX_AGE_MS,
  max = SWEEP_MAX_PER_RUN,
  dryRun = false,
  now = Date.now(),
} = {}) {
  const { items, stats } = listTuiTranscripts({ maxAgeMs, now });
  const knownByOwner = new Map();
  const knownFor = (owner) => {
    if (!knownByOwner.has(owner)) knownByOwner.set(owner, knownSessionIds(owner));
    return knownByOwner.get(owner);
  };
  const swept = readSwept();
  const skipped = {
    esChat: 0,
    yaBarrido: 0,
    activo: 0,
    viejo: stats.viejo,
    grande: stats.grande,
  };
  const eligible = [];

  for (const item of items) {
    const sweptKey = item.owner === hostUser()
      ? item.sessionId
      : `${item.owner}:${item.sessionId}`;
    if (knownFor(item.owner).has(item.sessionId)) {
      skipped.esChat += 1;
    } else if (swept.sessions[sweptKey]) {
      skipped.yaBarrido += 1;
    } else if (now - item.mtimeMs < quietMs) {
      skipped.activo += 1;
    } else {
      eligible.push(item);
    }
  }

  eligible.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = eligible.slice(0, max);
  const pendientes = Math.max(0, eligible.length - selected.length);
  const candidates = [];
  let queued = 0;
  let trivial = 0;

  if (dryRun) {
    for (const item of selected) {
      candidates.push({
        sessionId: item.sessionId,
        owner: item.owner,
        cwd: item.cwd,
        title: item.title,
        mtimeMs: item.mtimeMs,
        queued: false,
      });
    }
  } else {
    for (const item of selected) {
      let job = null;
      try {
        await queueRetroDistill({
          cwd: item.cwd,
          sessionId: item.sessionId,
          title: item.title,
          owner: item.owner === hostUser() ? null : item.owner,
          claudeDir: item.claudeDir,
        });
      } catch { /* una sesión fallida no bloquea las demás */ }
      job = readRetroJob(retroJobId(item.sessionId), item.owner);
      const didQueue = !!job;
      if (didQueue) queued += 1;
      else trivial += 1;
      const sweptKey = item.owner === hostUser()
        ? item.sessionId
        : `${item.owner}:${item.sessionId}`;
      swept.sessions[sweptKey] = {
        at: Date.now(),
        owner: item.owner,
        mtimeMs: item.mtimeMs,
        queued: didQueue,
        reason: didQueue ? 'encolado' : 'filtro-trivial',
      };
      candidates.push({
        sessionId: item.sessionId,
        owner: item.owner,
        cwd: item.cwd,
        title: item.title,
        mtimeMs: item.mtimeMs,
        queued: didQueue,
      });
    }
    writeSwept(swept);
  }

  return {
    dryRun,
    scanned: stats.scanned,
    cli: items.length,
    queued,
    trivial,
    skipped,
    pendientes,
    candidates,
  };
}
