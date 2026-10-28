// Refresh completo de fuentes para el workboard de Tolkien. El server solo
// reserva/spawnea; este flujo corre en bin/cwc-tolkien-sources-runner.js y deja
// estado persistido para sobrevivir reinicios de la interfaz (regla 2).
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { localDayStr, localHourKey } from '../tokens/time.js';
import { localTolkienPeople } from './local-users.js';
import {
  DEV_DB_PASSWORD,
  ROOT,
  isRefreshRunning,
  parseImporterOutput,
  readInfisicalWorkspaceId,
  readRefreshJob,
  readTolkienDbName,
  readTolkienDbPort,
} from './refresh-shared.js';

const TOLKIEN_ROOT = config.projectDir;
const WORKER_CWD = path.join(TOLKIEN_ROOT, 'apps', 'worker');
const TSX = path.join(WORKER_CWD, 'node_modules', '.bin', 'tsx');
const GLUE = path.join(ROOT, 'bin', 'cwc-tolkien-glue.mts');
const JOB_FILE = path.join(config.home, '.cwc-data', 'tolkien-sources.json');
const LOG_FILE = path.join(config.home, '.cwc-data', 'tolkien-sources.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-tolkien-sources-runner.js');
const AUTO_REFRESH_MS = 30 * 60 * 1000;
const FORBIDDEN_DB_ENV = [
  'REDIS_URL',
  'WATCHDOG_REDIS_URL',
  'TOLKIEN_WORKER_DATABASE_URL',
  'TOLKIEN_CONSOLE_DATABASE_URL',
  'TOLKIEN_API_DATABASE_URL',
  'TOLKIEN_MIGRATION_DATABASE_URL',
];

export const SOURCES_STALE_MS = 60 * 60 * 1000;

const localDbUrl = () =>
  `postgresql://tolkien:${DEV_DB_PASSWORD}@localhost:${readTolkienDbPort()}/${readTolkienDbName()}?schema=public`;

function runCmd(cmd, args, { timeout = 120000, env = process.env, cwd = TOLKIEN_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal || typeof err.code !== 'number')) {
          const failure = new Error(err.killed || err.signal
            ? `"${cmd}" terminó anormalmente (timeout/señal).`
            : `no se pudo ejecutar "${cmd}": ${err.code || err.message}`);
          failure.killed = !!err.killed;
          failure.timedOut = !!err.killed;
          failure.signal = err.signal || null;
          return reject(failure);
        }
        resolve({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

function minimalEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: config.home,
    ...extra,
  };
}

function safeShellValue(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function safeCommand(command) {
  const unsets = `unset ${FORBIDDEN_DB_ENV.join(' ')}`;
  return `export DATABASE_URL=${safeShellValue(localDbUrl())}; ${unsets}; cd ${safeShellValue(TOLKIEN_ROOT)}; ${command}`;
}

function scrubDetail(value, secrets = []) {
  let text = String(value || '').replaceAll(DEV_DB_PASSWORD, '***').replaceAll(localDbUrl(), '***');
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(String(secret), '***');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function commandFailure(result, fallback, secrets = []) {
  return scrubDetail(result?.stderr || result?.stdout || fallback, secrets) || fallback;
}

function firstRelevantLine(output, fallback) {
  const lines = String(output || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const relevant = lines.find((line) => /confirm-source-digest|source\s+digest|confirmationValue|error|fail|fatal/i.test(line));
  return relevant || lines[0] || fallback;
}

function sourceDigest(output) {
  const text = String(output || '');
  const patterns = [
    /--confirm-source-digest\s+([a-f0-9]{64})/i,
    /source\s+digest:\s*([a-f0-9]{64})/i,
    /"confirmationValue"\s*:\s*"([a-f0-9]{64})"/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

async function measuredStep(step, work) {
  const started = Date.now();
  try {
    const detail = await work();
    return { step, ok: true, detail: scrubDetail(detail), durationMs: Date.now() - started };
  } catch (error) {
    return {
      step,
      ok: false,
      ...(error?.partial === true ? { partial: true } : {}),
      detail: scrubDetail(error?.message || error || 'falló'),
      durationMs: Date.now() - started,
    };
  }
}

async function importerStep(name) {
  const result = await runCmd('infisical', [
    'run', '--projectId', readInfisicalWorkspaceId(), '--env', 'prod', '--silent',
    '--', 'bash', '-c', safeCommand(`pnpm --filter @tolkien/worker importer ${name} --apply`),
  ], { timeout: 300000 });
  const parsed = parseImporterOutput(name, `${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || parsed.failed) {
    throw new Error(parsed.error || commandFailure(result, `${name} falló`));
  }
  return `${name}: ${parsed.creates} altas, ${parsed.updates} actualizaciones, ${parsed.softDeletes} bajas`;
}

async function reviewedDeskFieldOptionsStep() {
  const baseArgs = [
    'run', '--projectId', readInfisicalWorkspaceId(), '--env', 'prod', '--silent',
    '--', 'bash', '-c',
  ];
  const dryRun = await runCmd('infisical', [
    ...baseArgs,
    safeCommand('pnpm --filter @tolkien/worker importer desk-field-options'),
  ], { timeout: 300000 });
  const dryOutput = `${dryRun.stdout}\n${dryRun.stderr}`;
  const digest = sourceDigest(dryOutput);
  if (dryRun.code !== 0 || !digest) {
    throw new Error(firstRelevantLine(dryOutput, 'desk-field-options dry-run no informó el source digest'));
  }

  // La DB objetivo es local y está guardada: el dry-run automatizado es la
  // revisión, y el digest garantiza que apply use exactamente esa fuente.
  const apply = await runCmd('infisical', [
    ...baseArgs,
    safeCommand(`pnpm --filter @tolkien/worker importer desk-field-options --apply --confirm-source-digest ${digest}`),
  ], { timeout: 300000 });
  const parsed = parseImporterOutput('desk-field-options', `${apply.stdout}\n${apply.stderr}`);
  if (apply.code !== 0 || parsed.failed) {
    throw new Error(parsed.error || commandFailure(apply, 'desk-field-options falló'));
  }
  return `desk-field-options: ${parsed.creates} altas, ${parsed.updates} actualizaciones, ${parsed.softDeletes} bajas`;
}

function parseGlueResult(output, expectedStep) {
  const lines = String(output || '').trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.step === expectedStep && typeof parsed?.ok === 'boolean') return parsed;
    } catch { /* sigue buscando la línea final del glue */ }
  }
  return null;
}

async function teamStep() {
  const emails = localTolkienPeople().map((person) => person.email).filter(Boolean);
  const result = await runCmd(TSX, [GLUE, 'team'], {
    cwd: WORKER_CWD,
    timeout: 60000,
    env: minimalEnv({ DATABASE_URL: localDbUrl(), CWC_IT_EMAILS: emails.join(',') }),
  });
  const final = parseGlueResult(result.stdout, 'team');
  if (result.code !== 0 || !final?.ok) {
    throw new Error(final?.summary?.error || commandFailure(result, 'team falló'));
  }
  const skipped = final.summary?.skippedEmails || [];
  return `dev: ${final.summary?.members ?? 0} miembros, ${final.summary?.added ?? 0} agregados`
    + (skipped.length ? `; sin empleado activo: ${skipped.join(', ')}` : '');
}

async function runDeskGlueStep(step, timeout) {
  const command = `cd ${safeShellValue(WORKER_CWD)}; ${safeShellValue(TSX)} ${safeShellValue(GLUE)} ${step}`;
  const result = await runCmd('infisical', [
    'run', '--projectId', readInfisicalWorkspaceId(), '--env', 'prod', '--silent',
    '--', 'bash', '-c', safeCommand(command),
  ], { timeout });
  const final = parseGlueResult(result.stdout, step);
  if (result.code !== 0 || !final?.ok) {
    throw new Error(final?.summary?.error || commandFailure(result, `${step} falló`));
  }
  return final.summary || {};
}

async function deskCatalogueStep() {
  const summary = await runDeskGlueStep('desk-catalogue', 15 * 60 * 1000);
  return `Desk: ${summary.upserts ?? 0} tickets`;
}

async function deskSourceStep() {
  try {
    const summary = await runDeskGlueStep('desk-source', 25 * 60 * 1000);
    return `Desk fuentes: ${summary.synced ?? 0} sincronizadas, ${summary.failed ?? 0} fallidas`;
  } catch (error) {
    if (error?.timedOut) {
      error.partial = true;
      error.message = 'parcial: enriquecimiento incremental, continúa en la próxima corrida';
    }
    throw error;
  }
}

async function padStep() {
  const secret = await runCmd('infisical', [
    'secrets', 'get', 'PAD_API_TOKEN', '--projectId', readInfisicalWorkspaceId(),
    '--env', 'prod', '--path=/kamal', '--plain', '--silent',
  ], { timeout: 30000 });
  const token = secret.code === 0 ? secret.stdout.trim() : '';
  if (!token) throw new Error('sin PAD_API_TOKEN');
  const result = await runCmd('pnpm', ['--filter', '@tolkien/worker', 'pad-sync'], {
    timeout: 5 * 60 * 1000,
    env: minimalEnv({ DATABASE_URL: localDbUrl(), PAD_API_TOKEN: token }),
  });
  if (result.code !== 0) throw new Error(commandFailure(result, 'pad-sync falló', [token]));
  return 'Pad sincronizado';
}

async function githubStep() {
  const auth = await runCmd('gh', ['auth', 'token'], { timeout: 15000 });
  const token = auth.code === 0 ? auth.stdout.trim() : '';
  if (!token) throw new Error('sin token de GitHub');
  const result = await runCmd('pnpm', ['--filter', '@tolkien/worker', 'github-sync'], {
    timeout: 5 * 60 * 1000,
    env: minimalEnv({
      DATABASE_URL: localDbUrl(),
      GITHUB_TOKEN: token,
      GITHUB_REPO: 'Mordor-Staffing/tolkien',
    }),
  });
  if (result.code !== 0) throw new Error(commandFailure(result, 'github-sync falló', [token]));
  return 'GitHub sincronizado';
}

export async function refreshSources() {
  const started = Date.now();
  const steps = [];
  const refreshRunning = isRefreshRunning(readRefreshJob());
  steps.push({
    step: 'guard',
    ok: !refreshRunning,
    detail: refreshRunning ? 'Hay un refresh base en curso; se evita competir con TRUNCATE.' : 'DB base libre.',
    durationMs: 0,
  });
  if (refreshRunning) return { ok: false, steps, durationMs: Date.now() - started };

  steps.push(await measuredStep('identity-map', () => importerStep('identity-map')));
  steps.push(await measuredStep('desk-field-options', reviewedDeskFieldOptionsStep));
  steps.push(await measuredStep('team', teamStep));
  steps.push(await measuredStep('desk-catalogue', deskCatalogueStep));
  steps.push(await measuredStep('desk-source', deskSourceStep));
  steps.push(await measuredStep('pad', padStep));
  steps.push(await measuredStep('github', githubStep));
  return { ok: steps.every((step) => step.ok || step.partial === true), steps, durationMs: Date.now() - started };
}

export function readSourcesJob() {
  try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')); }
  catch { return null; }
}

export function writeSourcesJob(data) {
  fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true, mode: 0o700 });
  writeJsonAtomic(JOB_FILE, data);
}

export function isSourcesRunning(job, now = Date.now()) {
  return !!job && job.running === true && (now - (job.startedAt || 0)) <= SOURCES_STALE_MS;
}

export function sourcesStatus(job) {
  if (!job) return { running: false, result: null, error: null, startedAt: null, finishedAt: null };
  if (job.running && !isSourcesRunning(job)) {
    return {
      running: false,
      result: null,
      error: 'El refresh de fuentes no respondió a tiempo (el runner se interrumpió). Reintentá.',
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

function markSpawnFailure(message) {
  try {
    const job = readSourcesJob();
    if (job?.running) writeSourcesJob({ ...job, running: false, error: message, finishedAt: Date.now() });
  } catch { /* no tapa el error original de spawn */ }
}

export function spawnSourcesRunner() {
  if (isSourcesRunning(readSourcesJob())) return false;
  writeSourcesJob({ running: true, result: null, error: null, startedAt: Date.now(), finishedAt: null });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  let logFd;
  try {
    logFd = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [RUNNER], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.on('error', (error) => {
      try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn FAIL: ${error?.message || error}\n`); } catch { /* noop */ }
      markSpawnFailure('No se pudo iniciar el runner de fuentes Tolkien.');
    });
    child.unref();
    return true;
  } catch (error) {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn THROW: ${error?.message || error}\n`); } catch { /* noop */ }
    markSpawnFailure('No se pudo iniciar el runner de fuentes Tolkien.');
    return false;
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd);
  }
}

export function withinAutoWindow(now = Date.now()) {
  const day = new Date(`${localDayStr(now)}T00:00:00Z`).getUTCDay();
  const hour = Number(localHourKey(now).slice(11, 13));
  return day >= 1 && day <= 5 && hour >= 7 && hour < 19;
}

export function maybeAutoRefresh(now = Date.now()) {
  if (!withinAutoWindow(now)) return false;
  if (isRefreshRunning(readRefreshJob())) return false;
  const job = readSourcesJob();
  if (isSourcesRunning(job, now)) return false;
  const lastAt = Number(job?.finishedAt || job?.startedAt || 0);
  if (lastAt > 0 && now - lastAt < AUTO_REFRESH_MS) return false;
  return spawnSourcesRunner();
}
