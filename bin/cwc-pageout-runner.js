#!/usr/bin/env node
// bin/cwc-pageout-runner.js — barrido DESACOPLADO de procesos dormidos.
// Persiste estado y lock con heartbeat para sobrevivir a reinicios del server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../src/core/atomic-write.js';
import { resolveDataDir } from '../src/core/data-dir.js';

const DATA_DIR = resolveDataDir();
const STATE_FILE = path.join(DATA_DIR, 'pageout.json');
const LOCK_FILE = path.join(DATA_DIR, 'pageout.lock');
const PAGEOUT_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cwc-pageout');
const UID = process.getuid();
const HOST = os.hostname();

function positiveEnv(name, fallback, { allowZero = false } = {}) {
  const value = Number(process.env[name]);
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  return valid ? value : fallback;
}

const INTERVAL_MS = positiveEnv('CWC_PAGEOUT_INTERVAL_MS', 60_000);
const IDLE_MS = positiveEnv('CWC_PAGEOUT_IDLE_MS', 300_000, { allowZero: true });
const MIN_RSS_KB = positiveEnv('CWC_PAGEOUT_MIN_RSS_MB', 100, { allowZero: true }) * 1024;
const DRY_RUN = process.env.CWC_PAGEOUT_DRY_RUN !== '0';
const HEARTBEAT_MS = Math.min(15_000, Math.max(1_000, INTERVAL_MS));
const LOCK_STALE_MS = Math.max(45_000, HEARTBEAT_MS * 3);
const MATCHERS = ['cwc-chat-runner.js', 'claude-agent-sdk', 'cwc-codex-runner.js'];

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    log(`estado ilegible en ${file}: ${error?.message || error}; se reconstruye`);
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockIsStale(lock) {
  if (!lock || typeof lock !== 'object') return true;
  const heartbeatAt = Date.parse(lock.heartbeatAt);
  return lock.host !== HOST
    ? !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > LOCK_STALE_MS
    : !pidAlive(Number(lock.pid))
      || !Number.isFinite(heartbeatAt)
      || Date.now() - heartbeatAt > LOCK_STALE_MS;
}

function acquireLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = {
      pid: process.pid,
      host: HOST,
      token: `${process.pid}-${Date.now()}`,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
      return lock;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readJson(LOCK_FILE);
      if (!lockIsStale(current)) return null;
      try { fs.unlinkSync(LOCK_FILE); } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  return null;
}

function ownsLock(lock) {
  const current = readJson(LOCK_FILE);
  return current?.token === lock.token;
}

function refreshLock(lock) {
  if (!ownsLock(lock)) return false;
  lock.heartbeatAt = new Date().toISOString();
  writeJsonAtomic(LOCK_FILE, lock);
  return true;
}

function releaseLock(lock) {
  if (!lock || !ownsLock(lock)) return;
  try { fs.unlinkSync(LOCK_FILE); } catch (error) {
    if (error?.code !== 'ENOENT') log(`no se pudo liberar el lock: ${error?.message || error}`);
  }
}

function initialState() {
  return {
    updatedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    sweeps: 0,
    procs: {},
    totals: { pageouts: 0, bytesAdvised: 0, wouldPageout: 0 },
  };
}

function loadState() {
  const loaded = readJson(STATE_FILE);
  if (!loaded || typeof loaded !== 'object') return initialState();
  return {
    updatedAt: typeof loaded.updatedAt === 'string' ? loaded.updatedAt : new Date().toISOString(),
    dryRun: DRY_RUN,
    sweeps: Number.isFinite(loaded.sweeps) ? loaded.sweeps : 0,
    procs: loaded.procs && typeof loaded.procs === 'object' ? loaded.procs : {},
    totals: {
      pageouts: Number(loaded.totals?.pageouts) || 0,
      bytesAdvised: Number(loaded.totals?.bytesAdvised) || 0,
      wouldPageout: Number(loaded.totals?.wouldPageout) || 0,
    },
  };
}

function readProc(pid) {
  const procDir = `/proc/${pid}`;
  const stat = fs.statSync(procDir);
  if (stat.uid !== UID) return null;

  const cmd = fs.readFileSync(path.join(procDir, 'cmdline'))
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .join(' ')
    .trim();
  // El server atiende HTTP/WS continuamente; desalojarlo sería contraproducente.
  if (!cmd || cmd.includes('src/server.js')) return null;
  if (!MATCHERS.some((matcher) => cmd.includes(matcher))) return null;

  const rawStat = fs.readFileSync(path.join(procDir, 'stat'), 'utf8');
  const commEnd = rawStat.lastIndexOf(')');
  if (commEnd < 0) return null;
  const fields = rawStat.slice(commEnd + 2).trim().split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;

  const status = fs.readFileSync(path.join(procDir, 'status'), 'utf8');
  const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  const rssKb = rssMatch ? Number(rssMatch[1]) : 0;
  return { cmd, cpu: utime + stime, rssKb };
}

function listProcesses() {
  const processes = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const info = readProc(name);
      if (info) processes.set(name, info);
    } catch (error) {
      // El proceso puede desaparecer entre cualquiera de las lecturas de /proc.
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error?.code)) {
        log(`no se pudo inspeccionar pid ${name}: ${error?.message || error}`);
      }
    }
  }
  return processes;
}

function runPageout(pid) {
  return new Promise((resolve) => {
    const child = execFile(PAGEOUT_BIN, [pid], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      activeChild = null;
      let result = null;
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        if (line) result = JSON.parse(line);
      } catch { /* el error de parseo se informa en el resumen del barrido */ }
      resolve({ error, result, stderr: stderr.trim() });
    });
    activeChild = child;
  });
}

let state = loadState();
let previousSweepAt = Date.parse(state.updatedAt);
if (!Number.isFinite(previousSweepAt)) previousSweepAt = Date.now();
let activeChild = null;
let stopping = false;
let waitTimer = null;
let wakeWait = null;

async function sweep() {
  const now = Date.now();
  const elapsedMs = Math.max(0, now - previousSweepAt);
  const live = listProcesses();
  const nextProcs = {};
  let candidates = 0;
  let acted = 0;
  let bytes = 0;
  let errors = 0;

  for (const [pid, info] of live) {
    const old = state.procs[pid];
    const sameProcess = old?.cmd === info.cmd && Number.isFinite(old?.lastCpu);
    const idleMs = sameProcess && old.lastCpu === info.cpu
      ? (Number(old.idleMs) || 0) + elapsedMs
      : 0;
    const procState = {
      cmd: info.cmd,
      idleMs,
      rssKb: info.rssKb,
      lastCpu: info.cpu,
      lastPageoutAt: sameProcess ? Number(old.lastPageoutAt) || 0 : 0,
      bytesTotal: sameProcess ? Number(old.bytesTotal) || 0 : 0,
      pageouts: sameProcess ? Number(old.pageouts) || 0 : 0,
    };
    nextProcs[pid] = procState;

    const cooldownOk = now - procState.lastPageoutAt >= IDLE_MS;
    if (idleMs < IDLE_MS || info.rssKb < MIN_RSS_KB || !cooldownOk) continue;
    candidates += 1;
    if (DRY_RUN) {
      state.totals.wouldPageout += 1;
      continue;
    }

    const outcome = await runPageout(pid);
    const advised = Number(outcome.result?.bytes_advised) || 0;
    const failedBatches = Number(outcome.result?.batches_failed) || 0;
    if (advised > 0 || (outcome.result && !outcome.error && failedBatches === 0)) {
      procState.lastPageoutAt = now;
      procState.bytesTotal += advised;
      procState.pageouts += 1;
      state.totals.pageouts += 1;
      state.totals.bytesAdvised += advised;
      acted += 1;
      bytes += advised;
    }
    if (outcome.error || !outcome.result || failedBatches > 0) {
      errors += 1;
      const detail = outcome.stderr || outcome.error?.message || 'salida JSON inválida';
      log(`pageout pid=${pid} falló: ${detail.replaceAll('\n', ' | ').slice(0, 300)}`);
    }
  }

  state.procs = nextProcs;
  state.dryRun = DRY_RUN;
  state.sweeps += 1;
  state.updatedAt = new Date(now).toISOString();
  previousSweepAt = now;
  writeJsonAtomic(STATE_FILE, state, { space: 2 });
  log(`barrido=${state.sweeps} procesos=${live.size} candidatos=${candidates} modo=${DRY_RUN ? 'dry-run' : 'activo'} pageouts=${acted} bytes=${bytes} errores=${errors}`);
}

function waitInterval() {
  return new Promise((resolve) => {
    wakeWait = resolve;
    waitTimer = setTimeout(resolve, INTERVAL_MS);
  }).finally(() => {
    waitTimer = null;
    wakeWait = null;
  });
}

let lock = null;
let lockError = null;
try {
  lock = acquireLock();
} catch (error) {
  lockError = error;
}

if (lockError) {
  console.error(`[${new Date().toISOString()}] no se pudo tomar el lock de pageout: ${lockError?.message || lockError}`);
  process.exitCode = 1;
} else if (!lock) {
  log('ya hay un runner pageout activo; salgo');
  process.exitCode = 2;
} else {
  const heartbeat = setInterval(() => {
    try {
      if (!refreshLock(lock)) {
        log('se perdió el lock de pageout; el runner se detendrá');
        stopping = true;
        if (wakeWait) wakeWait();
      }
    } catch (error) {
      log(`no se pudo actualizar el heartbeat: ${error?.message || error}`);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (waitTimer) clearTimeout(waitTimer);
    if (wakeWait) wakeWait();
    if (activeChild) activeChild.kill('SIGTERM');
    log(`runner interrumpido por ${signal}; el estado queda reanudable`);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  try {
    while (!stopping) {
      await sweep();
      if (!stopping) await waitInterval();
    }
  } catch (error) {
    log(`FALLÓ: ${error?.message || error}`);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    releaseLock(lock);
  }
}
