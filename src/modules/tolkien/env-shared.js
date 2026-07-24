// modules/tolkien/env-shared.js — ciclo de vida de entornos Tolkien efímeros
// por sesión: worktree, DB clonada, proceso systemd y reconciliación.
import { execFileSync, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { findZeroTierIp } from '../../core/zerotier.js';
import { cloneTemplateInto, dropEnvDb } from './template-shared.js';
import {
  DEV_DB_PASSWORD,
  ROOT,
  readInfisicalWorkspaceId,
  readTolkienDbPort,
} from './refresh-shared.js';
import {
  ENVS_DIR,
  assertSafeId,
  getEnv,
  heartbeat,
  isEnvAlive,
  listEnvs,
  patchEnv,
  removeEnvRecord,
  unitNameFor,
  worktreePathFor,
} from './env-store.js';

const CWD_BASE = config.projectDir;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

function gitBase(args) {
  return execFileSync('git', ['-C', CWD_BASE, ...args], { encoding: 'utf8', maxBuffer: EXEC_MAX_BUFFER });
}

function gitWt(wt, args) {
  return execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', maxBuffer: EXEC_MAX_BUFFER });
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function appendProvisionLog(id, msg) {
  assertSafeId(id);
  const dir = path.join(ENVS_DIR, id);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'provision.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* noop */ }
}

function execFileResult(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err || null,
      });
    });
  });
}

export function envDbUrl(db) {
  return `postgresql://tolkien:${DEV_DB_PASSWORD}@localhost:${readTolkienDbPort()}/${db}?schema=public`;
}

export function createWorktree(id, baseRef = 'main') {
  assertSafeId(id);
  const dir = path.join(ENVS_DIR, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const worktree = worktreePathFor(id);
  if (fs.existsSync(worktree) && fs.existsSync(path.join(worktree, '.git'))) {
    return { worktree, branch: `cwc-env/${id}` };
  }

  const branch = `cwc-env/${id}`;
  let branchExists = false;
  try {
    gitBase(['rev-parse', '--verify', branch]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    gitBase(['worktree', 'add', worktree, branch]);
  } else {
    gitBase(['worktree', 'add', '-b', branch, worktree, baseRef]);
  }

  return { worktree, branch };
}

export function writeLaunchScript(id, wt, port, db) {
  assertSafeId(id);
  const ztIp = findZeroTierIp()?.ip || '10.213.222.62';
  const projectId = readInfisicalWorkspaceId();
  const consoleDir = path.join(wt, 'apps', 'console');
  const inner = [
    'set -e',
    `export DATABASE_URL=${shQuote(envDbUrl(db))}`,
    `export NEXTAUTH_URL=${shQuote(`http://${ztIp}`)}`,
    `export AUTH_URL=${shQuote(`http://${ztIp}`)}`,
    'export NEXTAUTH_SECRET=local-dev-secret-change-me',
    'export AUTH_SECRET=local-dev-secret-change-me',
    'export AUTH_TRUST_HOST=true',
    'export DEV_AUTH_ENABLED=1',
    `export DEV_AUTH_PASSWORD=${shQuote('Colombia2026*')}`,
    'export NODE_ENV=development',
    'export PRISMA_QUERY_ENGINE_LIBRARY=""',
    `cd ${shQuote(wt)}`,
    'pnpm --filter @tolkien/db exec prisma migrate deploy',
    `cd ${shQuote(consoleDir)}`,
    `exec pnpm exec next dev -p ${shQuote(port)} -H 0.0.0.0`,
  ].join('\n');
  const script = [
    '#!/usr/bin/env bash',
    'export PATH="/usr/bin:/usr/local/bin:$PATH"',
    `infisical run --projectId ${shQuote(projectId)} --env prod --silent -- bash -c ${shQuote(inner)}`,
    '',
  ].join('\n');
  const file = path.join(ENVS_DIR, id, 'launch.sh');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, script, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

export async function startDevServer(id, launchScript) {
  const unit = unitNameFor(id);
  await execFileResult('systemctl', ['--user', 'reset-failed', unit], { env: process.env });
  const res = await execFileResult('systemd-run', [
    '--user',
    `--unit=${unit}`,
    '--collect',
    'bash',
    launchScript,
  ], { env: process.env });
  return {
    ok: res.code === 0,
    detail: `${res.stderr}\n${res.stdout}`.trim() || (res.error ? String(res.error.message || res.error) : ''),
  };
}

export async function stopDevServer(id) {
  const unit = unitNameFor(id);
  await execFileResult('systemctl', ['--user', 'stop', unit], { env: process.env });
  await execFileResult('systemctl', ['--user', 'reset-failed', unit], { env: process.env });
}

export async function unitActive(id) {
  const res = await execFileResult('systemctl', ['--user', 'is-active', unitNameFor(id)], { env: process.env });
  return res.stdout.trim() || 'unknown';
}

export async function provisionEnv(id) {
  assertSafeId(id);
  appendProvisionLog(id, 'provision start');
  const rec = getEnv(id);
  if (!rec) {
    appendProvisionLog(id, 'provision error: record no encontrado');
    throw new Error(`env ${id} no encontrado`);
  }

  patchEnv(id, { status: 'provisioning', error: '' });
  try {
    const wt = createWorktree(id, rec.base || 'main');
    patchEnv(id, { worktree: wt.worktree, branch: wt.branch, status: 'worktree-ready' });
    heartbeat(id);
    appendProvisionLog(id, `worktree ready: ${wt.worktree}`);

    const cloned = await cloneTemplateInto(rec.db);
    if (!cloned.ok) throw new Error(cloned.detail || 'no se pudo clonar la DB template');
    patchEnv(id, { status: 'db-ready' });
    appendProvisionLog(id, `db ready: ${rec.db}`);

    const launchScript = writeLaunchScript(id, wt.worktree, rec.port, rec.db);
    const started = await startDevServer(id, launchScript);
    if (!started.ok) throw new Error(started.detail || 'no se pudo iniciar el server dev');
    patchEnv(id, { status: 'serving', error: '' });
    heartbeat(id);
    appendProvisionLog(id, 'serving');
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    patchEnv(id, { status: 'error', error: msg });
    appendProvisionLog(id, `provision error: ${msg}`);
  }
}

export async function teardownEnv(id, { force = false } = {}) {
  assertSafeId(id);
  const rec = getEnv(id);
  if (!rec) return { ok: true, missing: true };

  if (rec.worktree && !force) {
    let dirty = '';
    try {
      dirty = gitWt(rec.worktree, ['status', '--porcelain']);
    } catch (err) {
      return { ok: false, dirty: true, detail: String(err?.message || err).slice(0, 300) };
    }
    if (dirty.trim()) return { ok: false, dirty: true };
  }

  await stopDevServer(id);
  if (rec.db) {
    try { await dropEnvDb(rec.db); } catch { /* noop */ }
  }
  if (rec.worktree) {
    try { gitBase(['worktree', 'remove', '--force', rec.worktree]); } catch { /* noop */ }
  }
  try { fs.rmSync(path.join(ENVS_DIR, id), { recursive: true, force: true }); } catch { /* noop */ }
  try { gitBase(['branch', '-D', `cwc-env/${id}`]); } catch { /* noop */ }
  removeEnvRecord(id);
  return { ok: true };
}

export async function reattachEnvs() {
  for (const rec of listEnvs()) {
    if (!rec?.id || rec.status !== 'serving') continue;
    try {
      if (await unitActive(rec.id) !== 'active') patchEnv(rec.id, { status: 'down' });
    } catch {
      patchEnv(rec.id, { status: 'down' });
    }
  }
  try { gitBase(['worktree', 'prune']); } catch { /* noop */ }
}

export async function recloneLiveEnvs() {
  const results = [];
  let envs = [];
  try {
    envs = listEnvs();
  } catch (err) {
    return [{ id: null, ok: false, detail: String(err?.message || err).slice(0, 300) }];
  }

  for (const rec of envs) {
    if (!isEnvAlive(rec) || !rec?.db || !rec?.worktree) continue;
    try {
      await stopDevServer(rec.id);
      const cloned = await cloneTemplateInto(rec.db);
      if (!cloned.ok) {
        const detail = cloned.detail || 'no se pudo clonar la DB template';
        appendProvisionLog(rec.id, `reclone error: ${detail}`);
        results.push({ id: rec.id, ok: false, detail });
        continue;
      }
      const script = writeLaunchScript(rec.id, rec.worktree, rec.port, rec.db);
      const started = await startDevServer(rec.id, script);
      const detail = started.detail || (started.ok ? 'reclonado y reiniciado' : 'no se pudo reiniciar el server dev');
      if (!started.ok) appendProvisionLog(rec.id, `reclone start error: ${detail}`);
      else appendProvisionLog(rec.id, 'recloned from fresh template');
      results.push({ id: rec.id, ok: started.ok, detail });
    } catch (err) {
      const detail = String(err?.message || err).slice(0, 300);
      try { appendProvisionLog(rec.id, `reclone error: ${detail}`); } catch { /* noop */ }
      results.push({ id: rec?.id || null, ok: false, detail });
    }
  }
  return results;
}

export async function reapEnvs({ idleMs, closedChatIds = [] }) {
  const now = Date.now();
  const closed = new Set(closedChatIds.map((id) => String(id)));
  const hasIdleCutoff = Number.isFinite(idleMs) && idleMs >= 0;
  for (const rec of listEnvs()) {
    if (!rec?.id) continue;
    const idle = hasIdleCutoff && now - Number(rec.heartbeatAt || 0) > idleMs;
    const closedChat = closed.has(String(rec.chatId));
    if (idle || closedChat) await teardownEnv(rec.id, { force: false });
  }
}

export function spawnEnvProvision(id) {
  assertSafeId(id);
  const dir = path.join(ENVS_DIR, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dir, 'provision.log');
  const logFd = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'cwc-tolkien-env-runner.js'), id], {
      detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
    });
    child.on('error', (err) => {
      try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ }
      try { patchEnv(id, { status: 'error', error: 'No se pudo iniciar el runner de entorno.' }); } catch { /* noop */ }
    });
    child.unref();
  } catch (err) {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] spawn THROW: ${err?.message || err}\n`); } catch { /* noop */ }
    try { patchEnv(id, { status: 'error', error: 'No se pudo iniciar el runner de entorno.' }); } catch { /* noop */ }
  } finally {
    fs.closeSync(logFd);
  }
}
