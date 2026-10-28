// modules/tolkien/template-shared.js — DB plantilla dormida para entornos Tolkien
// efímeros por sesión. Construye `tolkien_template` desde cero, la sella como
// template sin conexiones y permite clonar/dropear DBs efímeras validadas.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from '../../core/config.js';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { ensureLocalUsers } from './local-users.js';
import { ensurePackagesBuilt } from './build-shared.js';
import {
  ROOT,
  DEV_DB_PASSWORD,
  IMPORTERS,
  ensureZohoReachable,
  parseImporterOutput,
  readInfisicalWorkspaceId,
  readTolkienDbPort,
  runCmd,
} from './refresh-shared.js';

const ENV_DB_RE = /^tolkien_env_[A-Za-z0-9_]+$/;

const JOB_FILE = path.join(config.home, '.cwc-data', 'tolkien-template.json');
const LOG_FILE = path.join(config.home, '.cwc-data', 'tolkien-template.log');
const RUNNER = path.join(ROOT, 'bin', 'cwc-tolkien-template-build.js');
export const TEMPLATE_STALE_MS = 40 * 60 * 1000;

export function templateDbName() {
  return process.env.CWC_TOLKIEN_TEMPLATE_DB?.trim() || 'tolkien_template';
}

export function templateDbUrl(dbName = templateDbName()) {
  return `postgresql://tolkien:${DEV_DB_PASSWORD}@localhost:${readTolkienDbPort()}/${dbName}?schema=public`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function ensureEnvDbName(dbName) {
  if (!ENV_DB_RE.test(dbName || '')) {
    throw new Error(`nombre de DB Tolkien efímera inválido: ${dbName || '(vacío)'}`);
  }
}

function summarizeCommand(res) {
  if (!res) return '';
  const text = `${res.stderr || ''}\n${res.stdout || ''}`.trim();
  return text.split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
}

function psqlAdmin(sql) {
  return runCmd('psql', [
    '-h', 'localhost',
    '-p', readTolkienDbPort(),
    '-U', 'tolkien',
    '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1',
    '-c', sql,
  ], { env: { ...process.env, PGPASSWORD: DEV_DB_PASSWORD }, timeout: 30000 });
}

async function runBuildStep(steps, step, fn) {
  try {
    const res = await fn();
    const detail = summarizeCommand(res);
    const ok = !res || res.code === 0;
    steps.push({ step, ok, detail: ok ? detail : (detail || 'comando falló') });
    return { ok, res };
  } catch (err) {
    steps.push({ step, ok: false, detail: String(err?.message || err).slice(0, 300) });
    return { ok: false, res: null };
  }
}

export async function buildTemplate() {
  const started = Date.now();
  const steps = [];
  const t = templateDbName();
  const tIdent = quoteIdentifier(t);
  const next = `${t}_new`;
  const nextIdent = quoteIdentifier(next);
  const previous = `${t}_old`;
  const previousIdent = quoteIdentifier(previous);
  const wsId = readInfisicalWorkspaceId();

  // Igual que el refresh local: validar/compilar dist ANTES de tocar la DB
  // plantilla, para conservar la última plantilla sana si el build falla.
  const packages = await ensurePackagesBuilt();
  steps.push({ step: 'build paquetes', ok: packages.ok, detail: packages.detail });
  if (!packages.ok) return { ok: false, steps, durationMs: Date.now() - started };

  const zoho = await ensureZohoReachable();
  steps.push({ step: 'chequeo Zoho', ok: zoho.ok, detail: zoho.detail });
  if (!zoho.ok) return { ok: false, steps, durationMs: Date.now() - started };

  const detect = async (name, label) => {
    const found = await runBuildStep(steps, label, () =>
      psqlAdmin(`SELECT 1 FROM pg_database WHERE datname=${quoteLiteral(name)};`));
    return { ok: found.ok, exists: /\b1\b/.test(found.res?.stdout || '') };
  };

  let current = await detect(t, 'detect template database');
  if (!current.ok) return { ok: false, steps, durationMs: Date.now() - started };
  const backup = await detect(previous, 'detect previous template backup');
  if (!backup.ok) return { ok: false, steps, durationMs: Date.now() - started };

  // Recuperación de un swap interrumpido entre ambos rename: la plantilla vieja
  // sigue intacta bajo *_old y vuelve a su nombre contractual antes de construir.
  if (!current.exists && backup.exists) {
    const restore = await runBuildStep(steps, 'restore previous template database', () =>
      psqlAdmin(`ALTER DATABASE ${previousIdent} RENAME TO ${tIdent};`));
    if (!restore.ok) return { ok: false, steps, durationMs: Date.now() - started };
    current = { ok: true, exists: true };
  } else if (current.exists && backup.exists) {
    const unsealBackup = await runBuildStep(steps, 'unseal stale template backup', () =>
      psqlAdmin(`ALTER DATABASE ${previousIdent} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true;`));
    if (!unsealBackup.ok) return { ok: false, steps, durationMs: Date.now() - started };
    const dropBackup = await runBuildStep(steps, 'drop stale template backup', () =>
      psqlAdmin(`DROP DATABASE ${previousIdent};`));
    if (!dropBackup.ok) return { ok: false, steps, durationMs: Date.now() - started };
  }

  const staleNext = await detect(next, 'detect temporary template database');
  if (!staleNext.ok) return { ok: false, steps, durationMs: Date.now() - started };
  if (staleNext.exists) {
    const unsealNext = await runBuildStep(steps, 'unseal temporary template database', () =>
      psqlAdmin(`ALTER DATABASE ${nextIdent} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true;`));
    if (!unsealNext.ok) return { ok: false, steps, durationMs: Date.now() - started };
    const dropNext = await runBuildStep(steps, 'drop temporary template database', () =>
      psqlAdmin(`DROP DATABASE ${nextIdent};`));
    if (!dropNext.ok) return { ok: false, steps, durationMs: Date.now() - started };
  }

  const create = await runBuildStep(steps, 'create temporary template database', () =>
    psqlAdmin(`CREATE DATABASE ${nextIdent} OWNER tolkien;`));
  if (!create.ok) return { ok: false, steps, durationMs: Date.now() - started };

  const url = templateDbUrl(next);
  const migrate = await runBuildStep(steps, 'migrate template database', () =>
    runCmd('infisical', [
      'run', '--projectId', wsId, '--env', 'prod', '--silent', '--', 'bash', '-c',
      `export DATABASE_URL=${quoteShell(url)}; cd ${quoteShell(config.projectDir)}; pnpm --filter @tolkien/db exec prisma migrate deploy`,
    ], { timeout: 180000 }));
  if (!migrate.ok) return { ok: false, steps, durationMs: Date.now() - started };

  for (const name of IMPORTERS) {
    try {
      const res = await runCmd('infisical', [
        'run', '--projectId', wsId, '--env', 'prod', '--', 'bash', '-c',
        `export DATABASE_URL='${url}'; pnpm --filter @tolkien/worker importer ${name} --apply`,
      ], { timeout: 180000 });
      const parsed = parseImporterOutput(name, `${res.stdout}\n${res.stderr}`);
      steps.push({
        step: `import ${name}`,
        ok: res.code === 0 && !parsed.failed,
        detail: parsed.failed
          ? parsed.error
          : `creates=${parsed.creates} updates=${parsed.updates} softDeletes=${parsed.softDeletes}`,
      });
    } catch (err) {
      steps.push({ step: `import ${name}`, ok: false, detail: String(err?.message || err).slice(0, 300) });
    }
  }
  if (!steps.every((s) => s.ok)) return { ok: false, steps, durationMs: Date.now() - started };

  await runBuildStep(steps, 'seed local users (dev-login)', async () => {
    const result = await ensureLocalUsers(next);
    if (!result.ok) throw new Error(result.detail);
    return { code: 0, stdout: `upserted=${result.upserted}`, stderr: '' };
  });
  if (!steps.at(-1)?.ok) return { ok: false, steps, durationMs: Date.now() - started };

  await runBuildStep(steps, 'seal template database', () =>
    psqlAdmin(`ALTER DATABASE ${nextIdent} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false;`));
  if (!steps.at(-1)?.ok) return { ok: false, steps, durationMs: Date.now() - started };

  // PostgreSQL no ofrece rename atómico de dos bases. La anterior se conserva
  // como *_old hasta que la nueva toma el nombre contractual; si el segundo
  // rename falla se restaura inmediatamente. No se terminan sesiones: una
  // conexión inesperada hace fallar el swap y deja la plantilla vieja intacta.
  if (current.exists) {
    const park = await runBuildStep(steps, 'park previous template database', () =>
      psqlAdmin(`ALTER DATABASE ${tIdent} RENAME TO ${previousIdent};`));
    if (!park.ok) return { ok: false, steps, durationMs: Date.now() - started };
  }
  const install = await runBuildStep(steps, 'install new template database', () =>
    psqlAdmin(`ALTER DATABASE ${nextIdent} RENAME TO ${tIdent};`));
  if (!install.ok) {
    if (current.exists) {
      await runBuildStep(steps, 'restore previous template after failed swap', () =>
        psqlAdmin(`ALTER DATABASE ${previousIdent} RENAME TO ${tIdent};`));
    }
    return { ok: false, steps, durationMs: Date.now() - started };
  }

  if (current.exists) {
    try {
      const unseal = await psqlAdmin(`ALTER DATABASE ${previousIdent} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true;`);
      const drop = unseal.code === 0 ? await psqlAdmin(`DROP DATABASE ${previousIdent};`) : unseal;
      const cleaned = unseal.code === 0 && drop.code === 0;
      steps.push({
        step: 'cleanup previous template backup',
        ok: true,
        detail: cleaned ? 'respaldo anterior eliminado' : `plantilla nueva activa; respaldo conservado: ${summarizeCommand(drop) || 'cleanup falló'}`,
      });
    } catch (err) {
      steps.push({
        step: 'cleanup previous template backup',
        ok: true,
        detail: `plantilla nueva activa; respaldo conservado: ${String(err?.message || err).slice(0, 220)}`,
      });
    }
  }

  return {
    ok: steps.every((s) => s.ok),
    steps,
    durationMs: Date.now() - started,
  };
}

export async function cloneTemplateInto(dbName) {
  ensureEnvDbName(dbName);
  try {
    const drop = await psqlAdmin(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)};`);
    if (drop.code !== 0) return { ok: false, detail: summarizeCommand(drop) || 'psql falló' };
    const create = await psqlAdmin(`CREATE DATABASE ${quoteIdentifier(dbName)} TEMPLATE ${quoteIdentifier(templateDbName())} OWNER tolkien;`);
    return { ok: create.code === 0, detail: summarizeCommand(create) || (create.code === 0 ? '' : 'psql falló') };
  } catch (err) {
    return { ok: false, detail: String(err?.message || err).slice(0, 300) };
  }
}

export async function dropEnvDb(dbName) {
  ensureEnvDbName(dbName);
  try {
    const res = await psqlAdmin(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)};`);
    return { ok: res.code === 0, detail: summarizeCommand(res) || (res.code === 0 ? '' : 'psql falló') };
  } catch (err) {
    return { ok: false, detail: String(err?.message || err).slice(0, 300) };
  }
}

export function readTemplateJob() {
  try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')); }
  catch { return null; }
}

export function writeTemplateJob(data) {
  fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true, mode: 0o700 });
  writeJsonAtomic(JOB_FILE, data);
}

export function isTemplateBuilding(job) {
  return !!job && job.running === true && (Date.now() - (job.startedAt || 0)) <= TEMPLATE_STALE_MS;
}

export function templateStatus(job) {
  if (!job) return { running: false, result: null, error: null, startedAt: null, finishedAt: null };
  if (job.running && !isTemplateBuilding(job)) {
    return { running: false, result: null, error: 'El build de la plantilla no respondió a tiempo (el runner se interrumpió). Reintentá.', startedAt: job.startedAt || null, finishedAt: job.finishedAt || null };
  }
  return { running: !!job.running, result: job.result || null, error: job.error || null, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null };
}

export function spawnTemplateBuild() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(LOG_FILE, 'a');
  try {
    const child = spawn(process.execPath, [RUNNER], {
      detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
    });
    child.on('error', (err) => {
      try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn FAIL: ${err?.message || err}\n`); } catch { /* noop */ }
      try {
        const j = readTemplateJob();
        if (j && j.running) writeTemplateJob({ ...j, running: false, error: 'No se pudo iniciar el runner de build de plantilla.', finishedAt: Date.now() });
      } catch { /* noop */ }
    });
    child.unref();
  } catch (err) {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] spawn THROW: ${err?.message || err}\n`); } catch { /* noop */ }
    try {
      const j = readTemplateJob();
      if (j && j.running) writeTemplateJob({ ...j, running: false, error: 'No se pudo iniciar el runner de build de plantilla.', finishedAt: Date.now() });
    } catch { /* noop */ }
  } finally {
    fs.closeSync(logFd);
  }
}
