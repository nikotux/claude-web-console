// modules/tolkien/refresh-shared.js — refresh de la DB LOCAL de Tolkien
// (importers Zoho → Postgres), lógica COMPARTIDA por el server y el runner
// desacoplado bin/cwc-tolkien-refresh-runner.js.
//
// REGLA DE ORO / REGLA 2 (2026-07-12): antes esta operación larga (~20s a varios
// minutos: TRUNCATE + 3 importers) corría en background DENTRO del proceso del
// server, trackeada solo en una variable module-level (`dataJob`). Un reinicio de
// la web a mitad la mataba sin dejar rastro (DB a medias, estado perdido). Ahora
// vive en un RUNNER DESACOPLADO (detached+unref) con estado PERSISTIDO en disco
// (~/.cwc-data/tolkien-refresh.json): sobrevive al reinicio y el front lo observa
// por polling del archivo. NO usa el SDK (0 tokens): son comandos locales
// (psql/infisical/pnpm) — la regla 6 (blindaje read-only headless) no aplica acá.
//
// Botón "Vista fresca": deja la DB LOCAL de dev como snapshot LIMPIO y ACTUAL de
// Zoho. NO mergea ni preserva ediciones locales — es un server de pruebas y la
// vista debe ser siempre fresca. TRUNCATE de las tablas OPERATIVAS (empleados,
// clientes + todo lo que cuelga por FK) y reimport desde cero. Se PRESERVAN login
// (users), config, países y holiday_lists (no cascadean desde employees/clients).
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { ensureLocalUsers } from './local-users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');
const CWD = config.projectDir;

export const IMPORTERS = ['clients', 'employees', 'employee-client-links'];
export const DEV_DB_PASSWORD = 'tolkien_dev_only'; // password fijo de la DB de dev (ver CLAUDE.md de tolkien)

export function readTolkienDbPort() {
  if (process.env.CWC_TOLKIEN_DB_PORT?.trim()) return process.env.CWC_TOLKIEN_DB_PORT.trim();
  try {
    const env = fs.readFileSync(path.join(CWD, '.env'), 'utf8');
    const m = env.match(/^DB_HOST_PORT=(\d+)/m);
    if (m) return m[1];
  } catch { /* usa fallback */ }
  return '5435';
}

// Nombre de la DB local de Tolkien. Default `tolkien`, pero el server managed
// :3010 usa una DB DEDICADA (`tolkien_console`) para aislarse de los otros
// worktrees — se setea con CWC_TOLKIEN_DB_NAME en el .env de la consola. Así el
// botón de refresh apunta SIEMPRE a la misma DB que el server que la lee.
export function readTolkienDbName() {
  return process.env.CWC_TOLKIEN_DB_NAME?.trim() || 'tolkien';
}

export function readInfisicalWorkspaceId() {
  if (process.env.CWC_TOLKIEN_INFISICAL_ID?.trim()) return process.env.CWC_TOLKIEN_INFISICAL_ID.trim();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CWD, '.infisical.json'), 'utf8'));
    if (j.workspaceId) return String(j.workspaceId);
  } catch { /* usa fallback */ }
  return '25b6c300-7686-4cf0-b8e3-ed808a529638';
}

const localDbUrl = () =>
  `postgresql://tolkien:${DEV_DB_PASSWORD}@localhost:${readTolkienDbPort()}/${readTolkienDbName()}?schema=public`;

const ZOHO_PREFLIGHT_CACHE = path.join(config.home, '.cwc-data', 'tolkien-zoho-preflight.json');
const ZOHO_PREFLIGHT_LOCK = path.join(config.home, '.cwc-data', 'tolkien-zoho-preflight.lock');
const ZOHO_PREFLIGHT_CACHE_MS = 120_000;
const ZOHO_PREFLIGHT_FAIL_CACHE_MS = 60_000;
const ZOHO_PREFLIGHT_LOCK_WAIT_MS = 60_000;
const ZOHO_PREFLIGHT_LOCK_STALE_MS = 120_000;
const ZOHO_PREFLIGHT_SCRIPT = `
const emit = (value) => console.log(JSON.stringify(value));
const required = ['ZOHO_REFRESH_TOKEN', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'];
if (required.some((name) => !process.env[name])) {
  emit({ preflight: 'fail', status: 0, error: 'faltan credenciales ZOHO_* en infisical' });
} else {
  let status = 0;
  try {
    const host = process.env.ZOHO_ACCOUNTS_HOST || 'https://accounts.zoho.com';
    const body = new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
    const response = await fetch(host.replace(/\\\/$/, '') + '/oauth/v2/token', { method: 'POST', body });
    status = response.status;
    const data = await response.json();
    emit(data && data.access_token
      ? { preflight: 'ok' }
      : { preflight: 'fail', status, error: data?.error || '', description: data?.error_description || '' });
  } catch (err) {
    emit({ preflight: 'fail', status, error: String(err?.message || err) });
  }
}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readZohoPreflightCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(ZOHO_PREFLIGHT_CACHE, 'utf8'));
    if (cached?.ok === true && Number.isFinite(cached.at)
      && (Date.now() - cached.at) < ZOHO_PREFLIGHT_CACHE_MS) {
      return { ok: true, detail: '', cached: true };
    }
    if (cached?.ok === false && Number.isFinite(cached.at)
      && (Date.now() - cached.at) < ZOHO_PREFLIGHT_FAIL_CACHE_MS) {
      return {
        ok: false,
        detail: String(cached.detail || 'chequeo previo de Zoho falló hace instantes — no se borró nada.'),
        cached: true,
      };
    }
  } catch { /* sin caché vigente */ }
  return null;
}

async function acquireZohoPreflightLock() {
  const deadline = Date.now() + ZOHO_PREFLIGHT_LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(ZOHO_PREFLIGHT_LOCK), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      fs.mkdirSync(ZOHO_PREFLIGHT_LOCK, { mode: 0o700 });
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(ZOHO_PREFLIGHT_LOCK);
        if ((Date.now() - stat.mtimeMs) > ZOHO_PREFLIGHT_LOCK_STALE_MS) {
          const stalePath = `${ZOHO_PREFLIGHT_LOCK}.stale-${process.pid}-${Date.now()}`;
          fs.renameSync(ZOHO_PREFLIGHT_LOCK, stalePath);
          fs.rmSync(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') continue;
        throw statErr;
      }
      if (Date.now() >= deadline) throw new Error('timeout esperando el lock del chequeo previo de Zoho');
      await sleep(1_000);
    }
  }
}

// Ejecuta un comando local. RECHAZA ante terminación ANORMAL (timeout/kill,
// señal, o fallo de spawn sin código numérico como ENOENT/EACCES) para no
// enmascararla como un exit-code 1 normal — mismo criterio que git() de
// tolkien/index.js. Un fallo NORMAL del comando (exit code numérico ≠ 0) SÍ
// resuelve {code,stdout,stderr}, para que el caller lo inspeccione.
export function runCmd(cmd, args, { timeout = 120000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: CWD, timeout, env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal || typeof err.code !== 'number')) {
          const e = new Error(err.killed || err.signal
            ? `"${cmd}" terminó anormalmente (timeout/señal).`
            : `no se pudo ejecutar "${cmd}": ${err.code || err.message}`);
          e.killed = !!err.killed;
          e.signal = err.signal || null;
          return reject(e);
        }
        resolve({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

// Extrae {creates,updates,softDeletes,failed} del log pino de un importer.
export function parseImporterOutput(name, out) {
  const lines = (out || '').split('\n');
  let done = null;
  let failed = false;
  let failMsg = '';
  const plainLines = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/Injecting .* secrets/i.test(t) || /new release/i.test(t)) continue;
    let obj;
    try { obj = JSON.parse(t); } catch {
      plainLines.push(t);
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.msg === 'import done') done = obj;
    if (obj.msg === 'import failed') {
      failed = true;
      failMsg = obj?.err?.meta?.driverAdapterError?.cause?.originalMessage || obj?.err?.message || 'import failed';
    }
  }
  const diagnostic = plainLines.find((line) => /(SyntaxError|TypeError|ReferenceError|Error:|ERR_)/.test(line))
    || plainLines.at(-1)
    || '';
  return {
    importer: name,
    creates: done?.creates ?? 0,
    updates: done?.updates ?? 0,
    softDeletes: done?.softDeletes ?? 0,
    failed: failed || !done,
    error: failed
      ? failMsg.split('\n')[0].slice(0, 200)
      : (done ? '' : (diagnostic ? `no completó: ${diagnostic.slice(0, 200)}` : 'no completó (sin "import done")')),
  };
}

export function parsePreflightOutput(out) {
  let preflight = null;
  for (const line of String(out || '').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object'
        && Object.prototype.hasOwnProperty.call(parsed, 'preflight')) preflight = parsed;
    } catch { /* banners y salida no JSON de infisical */ }
  }

  if (preflight?.preflight === 'ok') return { ok: true, detail: '' };
  if (preflight?.preflight === 'fail') {
    const description = String(preflight.description || '');
    const error = String(preflight.error || '');
    const reason = description || error;
    if (/too many requests/i.test(description) || /too many requests/i.test(error)) {
      return {
        ok: false,
        detail: 'Zoho bloqueó temporalmente los tokens por exceso de pedidos (límite ~10 cada 10 min). Esperá ~10 minutos y reintentá — no se borró nada.',
      };
    }
    const prefix = `Zoho no respondió al chequeo previo (status=${preflight.status ?? 0}): `;
    const suffix = ' — no se borró nada.';
    return {
      ok: false,
      detail: `${prefix}${reason.slice(0, Math.max(0, 250 - prefix.length - suffix.length))}${suffix}`,
    };
  }
  return { ok: false, detail: 'chequeo previo de Zoho sin respuesta legible — no se borró nada.' };
}

export async function ensureZohoReachable() {
  const cached = readZohoPreflightCache();
  if (cached) return cached;

  try {
    await acquireZohoPreflightLock();
  } catch (err) {
    return {
      ok: false,
      detail: `chequeo previo de Zoho no ejecutó: ${String(err?.message || err).slice(0, 200)} — no se borró nada.`,
    };
  }

  try {
    const cachedAfterLock = readZohoPreflightCache();
    if (cachedAfterLock) return cachedAfterLock;

    let result;
    try {
      result = await runCmd('infisical', [
        'run', '--projectId', readInfisicalWorkspaceId(), '--env', 'prod', '--',
        'node', '-e', ZOHO_PREFLIGHT_SCRIPT,
      ], { timeout: 45_000 });
    } catch (err) {
      return {
        ok: false,
        detail: `chequeo previo de Zoho no ejecutó: ${String(err?.message || err).slice(0, 200)} — no se borró nada.`,
      };
    }

    const parsed = parsePreflightOutput(`${result.stdout}\n${result.stderr}`);
    if (!parsed.ok) {
      try {
        writeJsonAtomic(ZOHO_PREFLIGHT_CACHE, { ok: false, at: Date.now(), detail: parsed.detail });
      } catch { /* el fallo de caché no reemplaza el diagnóstico de Zoho */ }
      return parsed;
    }
    writeJsonAtomic(ZOHO_PREFLIGHT_CACHE, { ok: true, at: Date.now() });
    return parsed;
  } catch (err) {
    return {
      ok: false,
      detail: `chequeo previo de Zoho no ejecutó: ${String(err?.message || err).slice(0, 200)} — no se borró nada.`,
    };
  } finally {
    try { fs.rmSync(ZOHO_PREFLIGHT_LOCK, { recursive: true, force: true }); } catch { /* otro proceso lo limpiará por stale */ }
  }
}

export async function refreshLocalData() {
  const started = Date.now();
  const url = localDbUrl();
  const wsId = readInfisicalWorkspaceId();
  const steps = [];

  // Los importers consumen packages/* vía dist/. Se compila ANTES del reset
  // para que un build roto nunca deje la DB local vacía.
  const { ensurePackagesBuilt } = await import('./build-shared.js');
  const packages = await ensurePackagesBuilt();
  steps.push({
    importer: 'build paquetes',
    creates: 0,
    updates: 0,
    softDeletes: 0,
    failed: !packages.ok,
    error: packages.ok ? '' : packages.detail,
  });
  if (!packages.ok) return { ok: false, steps, durationMs: Date.now() - started };

  const zoho = await ensureZohoReachable();
  steps.push({
    importer: 'chequeo Zoho',
    creates: 0,
    updates: 0,
    softDeletes: 0,
    failed: !zoho.ok,
    error: zoho.ok ? '' : zoho.detail,
  });
  if (!zoho.ok) return { ok: false, steps, durationMs: Date.now() - started };

  // 1) Borrón limpio de la data operativa + defensivo del índice único
  //    (DROP INDEX clients_name_key: Zoho tiene nombres duplicados; TRUNCATE
  //    employees, clients RESTART IDENTITY CASCADE: vacía esas dos + todo lo que
  //    cuelga por FK, sin tocar users/app_config/countries/holiday_lists).
  let reset;
  try {
    reset = await runCmd('psql', [
      '-h', 'localhost', '-p', readTolkienDbPort(), '-U', 'tolkien', '-d', readTolkienDbName(),
      '-v', 'ON_ERROR_STOP=1',
      '-c', 'DROP INDEX IF EXISTS clients_name_key; TRUNCATE employees, clients RESTART IDENTITY CASCADE;',
    ], { timeout: 30000, env: { ...process.env, PGPASSWORD: DEV_DB_PASSWORD } });
  } catch (e) {
    // psql no ejecutó / timeout: abortamos sin reimportar (no dejar la DB a medias).
    steps.push({ importer: 'reset (drop-index + truncate operativas)', creates: 0, updates: 0, softDeletes: 0, failed: true, error: String(e?.message || 'psql no ejecutó').slice(0, 200) });
    return { ok: false, steps, durationMs: Date.now() - started };
  }
  steps.push({ importer: 'reset (drop-index + truncate operativas)', creates: 0, updates: 0, softDeletes: 0, failed: reset.code !== 0, error: reset.code !== 0 ? (reset.stderr.split('\n')[0] || 'psql falló') : '' });
  if (reset.code !== 0) {
    return { ok: false, steps, durationMs: Date.now() - started };
  }

  // 2) Importers en orden: clients → employees → employee-client-links.
  for (const name of IMPORTERS) {
    const inner = `export DATABASE_URL='${url}'; pnpm --filter @tolkien/worker importer ${name} --apply`;
    let res;
    try {
      res = await runCmd('infisical', [
        'run', '--projectId', wsId, '--env', 'prod', '--', 'bash', '-c', inner,
      ], { timeout: 180000 });
    } catch (e) {
      // timeout/kill del importer: se registra el paso como fallido y se sigue.
      steps.push({ importer: name, creates: 0, updates: 0, softDeletes: 0, failed: true, error: (e?.killed ? 'timeout (excedió 180s)' : String(e?.message || 'no ejecutó')).slice(0, 200) });
      continue;
    }
    steps.push(parseImporterOutput(name, `${res.stdout}\n${res.stderr}`));
  }

  const localUsers = await ensureLocalUsers(readTolkienDbName());
  steps.push({
    importer: 'usuarios locales (dev-login)',
    creates: localUsers.upserted || 0,
    updates: 0,
    softDeletes: 0,
    failed: !localUsers.ok,
    error: localUsers.ok ? '' : localUsers.detail,
  });

  return {
    ok: steps.every((s) => !s.failed),
    steps,
    durationMs: Date.now() - started,
  };
}

// ───────── Persistencia del job en disco (sobrevive al reinicio) ─────────
const JOB_FILE = path.join(config.home, '.cwc-data', 'tolkien-refresh.json');
const LOG_FILE = path.join(config.home, '.cwc-data', 'tolkien-refresh.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-tolkien-refresh-runner.js');
// Duración máx realista (build 25 min + reset 30s + 3×180s) + holgura: un job
// 'running' más viejo que esto = runner muerto, se reporta como error.
export const REFRESH_STALE_MS = 37 * 60 * 1000;

export function readRefreshJob() {
  try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')); }
  catch { return null; }
}
export function writeRefreshJob(data) {
  fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true, mode: 0o700 });
  writeJsonAtomic(JOB_FILE, data); // atómico tmp+rename (server reserva 'running' + runner escribe 'done')
}
export function isRefreshRunning(job) {
  return !!job && job.running === true && (Date.now() - (job.startedAt || 0)) <= REFRESH_STALE_MS;
}
// Estado EFECTIVO para el front: si quedó 'running' pasado el corte → error.
export function refreshStatus(job) {
  if (!job) return { running: false, result: null, error: null, startedAt: null, finishedAt: null };
  if (job.running && !isRefreshRunning(job)) {
    return { running: false, result: null, error: 'El refresh no respondió a tiempo (el runner se interrumpió). Reintentá.', startedAt: job.startedAt || null, finishedAt: job.finishedAt || null };
  }
  return { running: !!job.running, result: job.result || null, error: job.error || null, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null };
}
export function spawnRefreshRunner() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(LOG_FILE, 'a');
  try {
    const child = spawn(process.execPath, [RUNNER], {
      detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
    });
    child.on('error', (err) => {
      try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ }
      try {
        const j = readRefreshJob();
        if (j && j.running) writeRefreshJob({ ...j, running: false, error: 'No se pudo iniciar el runner de refresh.', finishedAt: Date.now() });
      } catch { /* noop */ }
    });
    child.unref();
  } catch (err) {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn THROW: ${err?.message || err}\n`); } catch { /* noop */ }
    try {
      const j = readRefreshJob();
      if (j && j.running) writeRefreshJob({ ...j, running: false, error: 'No se pudo iniciar el runner de refresh.', finishedAt: Date.now() });
    } catch { /* noop */ }
  } finally {
    fs.closeSync(logFd);
  }
}
