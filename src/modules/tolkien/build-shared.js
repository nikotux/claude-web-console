// modules/tolkien/build-shared.js — build serializado de packages/* de Tolkien
// y estado persistido del post-pull desacoplado.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { runCmd } from './refresh-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
const BUILD_LOCK = path.join(config.home, '.cwc-data', 'tolkien-build.lock');
const LOCK_POLL_MS = 2_000;
const LOCK_WAIT_MS = 20 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;

const POSTPULL_JOB_FILE = path.join(config.home, '.cwc-data', 'tolkien-postpull.json');
const POSTPULL_LOG_FILE = path.join(config.home, '.cwc-data', 'tolkien-postpull.log');
const POSTPULL_RUNNER = path.join(ROOT, 'bin', 'cwc-tolkien-postpull-runner.js');
export const POSTPULL_STALE_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function commandErrorDetail(res, fallback) {
  const output = `${res?.stdout || ''}\n${res?.stderr || ''}`;
  const errorLine = output.split('\n').map((line) => line.trim()).find((line) => /error/i.test(line));
  return (errorLine || fallback).slice(0, 200);
}

async function acquireBuildLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(BUILD_LOCK), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      fs.mkdirSync(BUILD_LOCK, { mode: 0o700 });
      try {
        writeJsonAtomic(path.join(BUILD_LOCK, 'pid.json'), {
          pid: process.pid,
          startedAt: Date.now(),
          cwd: config.projectDir,
        });
      } catch (err) {
        fs.rmSync(BUILD_LOCK, { recursive: true, force: true });
        throw err;
      }
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(BUILD_LOCK);
        if ((Date.now() - stat.mtimeMs) > LOCK_STALE_MS) {
          // Renombrar primero evita que dos waiters borren por carrera el lock
          // fresco que uno de ellos acaba de adquirir.
          const stalePath = `${BUILD_LOCK}.stale-${process.pid}-${Date.now()}`;
          fs.renameSync(BUILD_LOCK, stalePath);
          fs.rmSync(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') continue;
        throw statErr;
      }
      if (Date.now() >= deadline) {
        throw new Error('timeout esperando el lock compartido de build de Tolkien');
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

export async function ensurePackagesBuilt() {
  try {
    await acquireBuildLock();
  } catch (err) {
    return { ok: false, step: 'build paquetes', detail: String(err?.message || err).slice(0, 200) };
  }

  try {
    const install = await runCmd('pnpm', [
      'install', '--frozen-lockfile', '--prefer-offline',
    ], { timeout: 10 * 60 * 1000 });
    if (install.code !== 0) {
      return {
        ok: false,
        step: 'build paquetes',
        detail: commandErrorDetail(install, `pnpm install falló (código ${install.code})`),
      };
    }

    const build = await runCmd('pnpm', [
      'turbo', 'run', 'build', '--filter=./packages/*',
    ], {
      timeout: 15 * 60 * 1000,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
    });
    if (build.code !== 0) {
      return {
        ok: false,
        step: 'build paquetes',
        detail: commandErrorDetail(build, `pnpm turbo build falló (código ${build.code})`),
      };
    }
    return { ok: true, step: 'build paquetes', detail: '' };
  } catch (err) {
    return { ok: false, step: 'build paquetes', detail: String(err?.message || err).slice(0, 200) };
  } finally {
    try { fs.rmSync(BUILD_LOCK, { recursive: true, force: true }); } catch { /* otro proceso lo limpiará por stale */ }
  }
}

export function readPostpullJob() {
  try { return JSON.parse(fs.readFileSync(POSTPULL_JOB_FILE, 'utf8')); }
  catch { return null; }
}

export function writePostpullJob(data) {
  fs.mkdirSync(path.dirname(POSTPULL_JOB_FILE), { recursive: true, mode: 0o700 });
  writeJsonAtomic(POSTPULL_JOB_FILE, data);
}

export function isPostpullRunning(job) {
  return !!job && job.running === true && (Date.now() - (job.startedAt || 0)) <= POSTPULL_STALE_MS;
}

export function postpullStatus(job) {
  if (!job) return { running: false, result: null, error: null, startedAt: null, finishedAt: null };
  if (job.running && !isPostpullRunning(job)) {
    return {
      running: false,
      result: null,
      error: 'El post-pull no respondió a tiempo (el runner se interrumpió). Reintentá.',
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
    };
  }
  return {
    running: !!job.running,
    result: job.result || null,
    error: job.error || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  };
}

export function spawnPostpullRunner() {
  fs.mkdirSync(path.dirname(POSTPULL_LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(POSTPULL_LOG_FILE, 'a');
  try {
    const child = spawn(process.execPath, [POSTPULL_RUNNER], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.on('error', (err) => {
      try { fs.appendFileSync(POSTPULL_LOG_FILE, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ }
      try {
        const job = readPostpullJob();
        if (job?.running) writePostpullJob({ ...job, running: false, error: 'No se pudo iniciar el runner post-pull.', finishedAt: Date.now() });
      } catch { /* noop */ }
    });
    child.unref();
  } catch (err) {
    try { fs.appendFileSync(POSTPULL_LOG_FILE, `[${new Date().toISOString()}] spawn THROW: ${err?.message || err}\n`); } catch { /* noop */ }
    try {
      const job = readPostpullJob();
      if (job?.running) writePostpullJob({ ...job, running: false, error: 'No se pudo iniciar el runner post-pull.', finishedAt: Date.now() });
    } catch { /* noop */ }
  } finally {
    fs.closeSync(logFd);
  }
}
