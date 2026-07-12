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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..');
const CWD = config.projectDir;

const IMPORTERS = ['clients', 'employees', 'employee-client-links'];
const DEV_DB_PASSWORD = 'tolkien_dev_only'; // password fijo de la DB de dev (ver CLAUDE.md de tolkien)

function readTolkienDbPort() {
  if (process.env.CWC_TOLKIEN_DB_PORT?.trim()) return process.env.CWC_TOLKIEN_DB_PORT.trim();
  try {
    const env = fs.readFileSync(path.join(CWD, '.env'), 'utf8');
    const m = env.match(/^DB_HOST_PORT=(\d+)/m);
    if (m) return m[1];
  } catch { /* usa fallback */ }
  return '5435';
}

function readInfisicalWorkspaceId() {
  if (process.env.CWC_TOLKIEN_INFISICAL_ID?.trim()) return process.env.CWC_TOLKIEN_INFISICAL_ID.trim();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CWD, '.infisical.json'), 'utf8'));
    if (j.workspaceId) return String(j.workspaceId);
  } catch { /* usa fallback */ }
  return '25b6c300-7686-4cf0-b8e3-ed808a529638';
}

const localDbUrl = () =>
  `postgresql://tolkien:${DEV_DB_PASSWORD}@localhost:${readTolkienDbPort()}/tolkien?schema=public`;

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
function parseImporterOutput(name, out) {
  const lines = (out || '').split('\n');
  let done = null;
  let failed = false;
  let failMsg = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj.msg === 'import done') done = obj;
    if (obj.msg === 'import failed') {
      failed = true;
      failMsg = obj?.err?.meta?.driverAdapterError?.cause?.originalMessage || obj?.err?.message || 'import failed';
    }
  }
  return {
    importer: name,
    creates: done?.creates ?? 0,
    updates: done?.updates ?? 0,
    softDeletes: done?.softDeletes ?? 0,
    failed: failed || !done,
    error: failed ? failMsg.split('\n')[0].slice(0, 200) : (done ? '' : 'no completó (sin "import done")'),
  };
}

export async function refreshLocalData() {
  const started = Date.now();
  const url = localDbUrl();
  const wsId = readInfisicalWorkspaceId();
  const steps = [];

  // 1) Borrón limpio de la data operativa + defensivo del índice único
  //    (DROP INDEX clients_name_key: Zoho tiene nombres duplicados; TRUNCATE
  //    employees, clients RESTART IDENTITY CASCADE: vacía esas dos + todo lo que
  //    cuelga por FK, sin tocar users/app_config/countries/holiday_lists).
  let reset;
  try {
    reset = await runCmd('psql', [
      '-h', 'localhost', '-p', readTolkienDbPort(), '-U', 'tolkien', '-d', 'tolkien',
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
// Duración máx realista (reset 30s + 3×180s) + holgura: un job 'running' más
// viejo que esto = runner muerto, se reporta como error sin colgar el botón.
export const REFRESH_STALE_MS = 12 * 60 * 1000;

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
  fs.closeSync(logFd);
}
