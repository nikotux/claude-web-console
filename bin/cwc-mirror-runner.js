#!/usr/bin/env node
// bin/cwc-mirror-runner.js — espejo DESACOPLADO y reanudable de Rivendell a
// mordoria. El timer ejecuta un ciclo one-shot; estado, lock y log sobreviven
// por archivos bajo ~/.cwc-data aunque la interfaz web se reinicie.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as sqlite from 'node:sqlite';
import { writeJsonAtomic } from '../src/core/atomic-write.js';

const HOME = os.homedir();
const HOST = os.hostname();
const DATA_DIR = path.join(HOME, '.cwc-data');
const STATE_FILE = path.join(DATA_DIR, 'mirror-state.json');
const LOCK_FILE = path.join(DATA_DIR, 'mirror.lock');
const LOG_FILE = path.join(DATA_DIR, 'mirror.log');
const PAD_DIR = path.join(HOME, '.pad');
const PAD_DB = path.join(PAD_DIR, 'pad.db');
const ATTIC_ROOT = '/srv/cwc-mirror-attic';
const STAGING_ROOT = '/var/tmp/cwc-mirror-staging';
const PAD_STAGING_DIR = path.join(STAGING_ROOT, 'pad');
const PAD_STAGING_DB = path.join(PAD_STAGING_DIR, 'pad.db');
const REMOTE = 'mordoria-mirror';
const REMOTE_HOME = '/home/nmosquera';
const ATTIC_DAYS = 14;
const STALE_MIN = 30;
const HEARTBEAT_MS = 60_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const RSYNC_TIMEOUT_S = 300;
const DEFAULT_BWLIMIT_KBPS = 0;
const SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
const REMOTE_CONSOLE_STATUS_COMMAND = 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active claude-web-console.service';
const DESTINATION_IN_USE_MESSAGE = 'destino EN USO: la consola de mordoria está activa; se omite el ciclo para no pisar trabajo nuevo';
let logToFile = true;

/*
 * Este espejo cubre el HOME COMPLETO, sin exclusiones, por decisión explícita
 * del dueño. Agregar cualquier exclusión requiere su aprobación.
 *
 * La maquinaria vive fuera del HOME a propósito. Si el attic estuviera dentro
 * del HOME destino, --delete lo trataría como sobrante y lo metería dentro de
 * sí mismo; si el staging estuviera dentro del HOME origen, se copiaría a sí
 * mismo en cada ciclo.
 *
 * ~/.ssh/authorized_keys de Rivendell contiene deliberadamente la clave del
 * espejo para que sobreviva al --delete en destino; sin ella, el espejo se
 * rompe a sí mismo de forma permanente.
 *
 * Como el HOME incluye ~/.config/systemd/user/, las unidades del destino quedan
 * pisadas por las del origen, que tienen escrita la IP de Rivendell. La
 * adaptación al host se hace durante el failover, no en disco.
 */
const TARGETS = [
  // 1) El home ENTERO, sin una sola exclusión. Es la decisión de Niko.
  { name: 'home', src: '', exclude: [] },
  // 2) Sobrescribe pad.db con el snapshot consistente. Corre DESPUÉS del home:
  //    el home ya copió una posible versión rota (SQLite en WAL copiado en plano)
  //    y este paso la reemplaza por la verificada.
  { name: 'pad-db', src: '.pad/', exclude: [], prepare: preparePadSnapshot, padOnly: true },
];

const usage = () => console.log(`Uso:
  node bin/cwc-mirror-runner.js [--dry-run] [--target=<nombre>] [--bwlimit=<N>] [--whole-file] [--force]
  node bin/cwc-mirror-runner.js --status
  node bin/cwc-mirror-runner.js --help

Targets: ${TARGETS.map((target) => target.name).join(', ')}

Opciones:
  --dry-run         Ejecuta rsync con -n y no escribe log ni estado. Para el
                    target pad-db prepara y verifica el snapshot bajo
                    /var/tmp/cwc-mirror-staging/pad/; esa es su única escritura.
  --target=<nombre> Sincroniza solamente el target indicado.
  --bwlimit=<N>     Limita el caudal de rsync a N KiB/s (entero mayor que cero).
  --whole-file      Transfiere archivos completos, sin usar el algoritmo delta.
  --force           OMITE el guard de destino en uso y sincroniza aunque la
                    consola de mordoria esté activa; puede pisar trabajo nuevo.
  --status          Muestra el último estado persistido y sale.
  --help            Muestra esta ayuda.

Cuándo usarlos: --bwlimit si el enlace está congestionado; --whole-file solo para la puesta al día inicial.`);

function rotateLogIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (!logToFile) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[mirror] No se pudo escribir el log: ${error?.message || error}`);
  }
}

function excludeFromPadSnapshot(name) {
  return name === 'pad.db'
    || name === 'pad.db-wal'
    || name === 'pad.db-shm'
    || name.startsWith('pad.db.pre-')
    || name === 'logs';
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createOnlineBackup(sourceDb, destination) {
  if (typeof sqlite.backup === 'function') {
    await sqlite.backup(sourceDb, destination);
    return 'backup()';
  }
  sourceDb.exec(`VACUUM INTO ${sqlString(destination)}`);
  return 'VACUUM INTO';
}

async function preparePadSnapshot({ dryRun = false } = {}) {
  if (dryRun) {
    log('pad-db: DRY-RUN escribirá únicamente el staging local del snapshot bajo /var/tmp/cwc-mirror-staging/pad/.');
  }
  log('pad-db: preparando snapshot WAL-aware de la base viva.');

  try {
    fs.mkdirSync(STAGING_ROOT, { recursive: true, mode: 0o700 });
    fs.rmSync(PAD_STAGING_DIR, { recursive: true, force: true });
    fs.mkdirSync(PAD_STAGING_DIR, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(PAD_DIR, { withFileTypes: true })) {
      if (excludeFromPadSnapshot(entry.name)) continue;
      fs.cpSync(
        path.join(PAD_DIR, entry.name),
        path.join(PAD_STAGING_DIR, entry.name),
        { recursive: true, preserveTimestamps: true },
      );
    }

    let backupMethod;
    const sourceDb = new sqlite.DatabaseSync(PAD_DB, { readOnly: true });
    try {
      backupMethod = await createOnlineBackup(sourceDb, PAD_STAGING_DB);
    } finally {
      sourceDb.close();
    }

    const snapshotDb = new sqlite.DatabaseSync(PAD_STAGING_DB, { readOnly: true });
    try {
      snapshotDb.exec('PRAGMA query_only = ON');
      const integrityRows = snapshotDb.prepare('PRAGMA integrity_check').all();
      const integrityResults = integrityRows.map(
        (row) => row.integrity_check ?? Object.values(row)[0],
      );
      const integrityCheck = integrityResults.join('; ');
      if (integrityResults.length !== 1 || integrityResults[0] !== 'ok') {
        throw new Error(`PRAGMA integrity_check devolvió ${integrityCheck || '[sin resultado]'}`);
      }

      const itemCount = Number(snapshotDb.prepare('SELECT count(*) AS count FROM items').get().count);
      if (!Number.isSafeInteger(itemCount) || itemCount <= 0) {
        throw new Error(`SELECT count(*) FROM items devolvió ${itemCount}; se esperaba un valor mayor que cero`);
      }
      log(`pad-db: snapshot verificado con ${backupMethod}: integrity_check=${integrityCheck}, items=${itemCount}.`);
    } finally {
      snapshotDb.close();
    }
    fs.rmSync(`${PAD_STAGING_DB}-wal`, { force: true });
    fs.rmSync(`${PAD_STAGING_DB}-shm`, { force: true });
  } catch (error) {
    throw new Error(`snapshot Pad rechazado; no se ejecutará rsync: ${error?.message || error}`);
  }

  return `${PAD_STAGING_DIR}${path.sep}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
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

function lockOrphaned(lock) {
  if (!lock || typeof lock !== 'object') return true;
  const heartbeatMs = Date.parse(lock.heartbeatAt);
  const stale = !Number.isFinite(heartbeatMs)
    || Date.now() - heartbeatMs > STALE_MIN * 60_000;
  const dead = lock.host === HOST && !pidAlive(Number(lock.pid));
  return stale || dead;
}

function claimEmptyLock(lock) {
  const tmp = `${LOCK_FILE}.claim.${process.pid}`;
  const body = `${JSON.stringify(lock)}\n`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    // link(2) aporta el no-clobber atómico que rename no ofrece al tomar lock.
    fs.linkSync(tmp, LOCK_FILE);
    fs.unlinkSync(tmp);
    // Una vez ganado el lock, su estado durable sigue CONVE-5: tmp por PID + rename.
    writeJsonAtomic(LOCK_FILE, lock, { mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
  }
}

function acquireLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const ours = { pid: process.pid, host: HOST, startedAt: now, heartbeatAt: now };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (claimEmptyLock(ours)) return ours;

    let current;
    try {
      current = readJson(LOCK_FILE);
    } catch {
      current = null;
    }
    if (!lockOrphaned(current)) return null;

    try {
      fs.unlinkSync(LOCK_FILE);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function ownsLock(lock) {
  try {
    const current = readJson(LOCK_FILE);
    return current?.pid === lock.pid
      && current?.host === lock.host
      && current?.startedAt === lock.startedAt;
  } catch {
    return false;
  }
}

function refreshLock(lock) {
  if (!ownsLock(lock)) return false;
  lock.heartbeatAt = new Date().toISOString();
  writeJsonAtomic(LOCK_FILE, lock, { mode: 0o600 });
  return true;
}

function releaseLock(lock) {
  if (!lock || !ownsLock(lock)) return;
  try { fs.unlinkSync(LOCK_FILE); } catch { /* noop */ }
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    targetName: null,
    status: false,
    help: false,
    bwlimitKbps: DEFAULT_BWLIMIT_KBPS,
    wholeFile: false,
    force: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--status') options.status = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--whole-file') options.wholeFile = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--bwlimit=')) {
      const value = Number(arg.slice('--bwlimit='.length));
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('--bwlimit debe ser un entero mayor que cero (KiB/s).');
      }
      options.bwlimitKbps = value;
    }
    else if (arg.startsWith('--target=')) options.targetName = arg.slice('--target='.length);
    else throw new Error(`Argumento desconocido: ${arg}`);
  }
  if (options.status && (
    options.dryRun
    || options.targetName
    || options.bwlimitKbps > 0
    || options.wholeFile
    || options.force
  )) {
    throw new Error('--status no se combina con --dry-run, --target, --bwlimit, --whole-file ni --force.');
  }
  if (options.targetName && !TARGETS.some((target) => target.name === options.targetName)) {
    throw new Error(`Target desconocido: ${options.targetName}`);
  }
  return options;
}

function initialTargetState(previous) {
  return {
    lastOk: previous?.lastOk || null,
    lastError: null,
    durationMs: null,
    bytesSent: 0,
    filesChanged: 0,
    status: 'pending',
  };
}

function newCycle(previous, selected) {
  const targets = {};
  for (const target of selected) {
    targets[target.name] = initialTargetState(previous?.targets?.[target.name]);
  }
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cycle: (Number(previous?.cycle) || 0) + 1,
    targets,
  };
}

function resumableCycle(previous, selected) {
  if (!previous || previous.finishedAt || !previous.targets) return false;
  const expected = selected.map((target) => target.name);
  const actual = Object.keys(previous.targets);
  return expected.length === actual.length && expected.every((name) => actual.includes(name));
}

function loadCycle(selected) {
  let previous = null;
  try {
    previous = readJson(STATE_FILE);
  } catch (error) {
    log(`Estado anterior ilegible; se inicia un ciclo nuevo: ${error?.message || error}`);
  }
  if (resumableCycle(previous, selected)) {
    log(`Reanudando ciclo ${previous.cycle} desde el primer target incompleto.`);
    return previous;
  }
  return newCycle(previous, selected);
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, state, { mode: 0o600, space: 2 });
}

function formatValue(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function showStatus() {
  let state;
  try {
    state = readJson(STATE_FILE);
  } catch (error) {
    console.error(`Espejo: no se pudo leer ${STATE_FILE}: ${error?.message || error}`);
    process.exitCode = 1;
    return;
  }
  if (!state) {
    console.log(`Espejo: todavía no hay estado en ${STATE_FILE}.`);
    return;
  }

  const cycleStatus = state.skippedAt ? 'saltado' : (state.finishedAt ? 'terminado' : 'en curso');
  console.log(`Espejo — ciclo ${formatValue(state.cycle)} (${cycleStatus})`);
  console.log(`Inicio: ${formatValue(state.startedAt)}`);
  console.log(`Fin:    ${formatValue(state.finishedAt)}`);
  if (state.skipReason) console.log(`Motivo: ${state.skipReason}`);
  for (const [name, target] of Object.entries(state.targets || {})) {
    const metrics = `${formatValue(target.durationMs)} ms, ${formatValue(target.bytesSent)} bytes enviados, ${formatValue(target.filesChanged)} archivos cambiados`;
    console.log(`- ${name}: ${formatValue(target.status)} · ${metrics}`);
    if (target.lastOk) console.log(`  último OK: ${target.lastOk}`);
    if (target.skipReason) console.log(`  omitido: ${target.skipReason}`);
    if (target.lastError) console.log(`  error: ${target.lastError}`);
  }
}

let activeChild = null;

function runProcess(command, args, { echo = true } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (echo) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (echo) process.stderr.write(text);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve({ code: Number.isInteger(code) ? code : 1, signal, stdout, stderr });
    });
  });
}

async function guardDestinationInUse({ force }) {
  if (force) {
    log('home: --force activo; se omite el guard de destino en uso.');
    return false;
  }

  const result = await runProcess('ssh', [
    ...SSH_ARGS,
    REMOTE,
    REMOTE_CONSOLE_STATUS_COMMAND,
  ], { echo: false });
  const remoteStatus = result.stdout.trim();
  if (remoteStatus === 'active') return true;

  if (result.code !== 0 && remoteStatus !== 'inactive' && remoteStatus !== 'failed') {
    const detail = result.stderr.trim().split('\n').slice(-2).join(' | ')
      || `ssh terminó con código ${result.code}`;
    // Ante un error transitorio de SSH se sincroniza igual: se prefiere no
    // bloquear el espejo; si el destino es inalcanzable, rsync dará su error.
    log(`home: no se pudo determinar si el destino está en uso (${detail}); se sincroniza igual.`);
  }
  return false;
}

function parseCount(value) {
  const parsed = Number.parseInt(String(value || '').replaceAll(',', ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseHumanBytes(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGTP]?)(?:i?B)?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const power = ['', 'K', 'M', 'G', 'T', 'P'].indexOf(match[2].toUpperCase());
  return Number.isFinite(amount) && power >= 0 ? Math.round(amount * (1000 ** power)) : 0;
}

function parseRsyncStats(text) {
  const bytes = text.match(/^Total bytes sent:\s*([^\s]+)/mi);
  const transferred = text.match(/^Number of (?:regular )?files transferred:\s*([\d,]+)/mi);
  const deleted = text.match(/^Number of deleted files:\s*([\d,]+)/mi);
  return {
    bytesSent: parseHumanBytes(bytes?.[1]),
    filesChanged: parseCount(transferred?.[1]) + parseCount(deleted?.[1]),
  };
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function syncTarget(target, { dryRun, bwlimitKbps, wholeFile }) {
  const source = target.prepare
    ? await target.prepare({ dryRun })
    : `${path.join(HOME, target.src)}${path.sep}`;
  const destinationPath = `${path.posix.join(REMOTE_HOME, target.src)}/`;
  const attic = path.posix.join(ATTIC_ROOT, localDate(), target.name);
  const args = [
    '-a',
    // -a NO implica -H: sin este flag, los worktrees de git y los stores de
    // pnpm se multiplican en destino (medido: 88% y 84% de sus archivos son
    // hard links). -H construye un mapa de inodos en memoria; con ~780.000
    // archivos el costo de RAM es asumible, pero es real en árboles grandes.
    '-H',
    '-s',
    '--mkpath',
    ...(target.name === 'home' ? ['--delete'] : []),
    '--partial',
    `--timeout=${RSYNC_TIMEOUT_S}`,
    ...(bwlimitKbps > 0 ? [`--bwlimit=${bwlimitKbps}`] : []),
    ...(wholeFile ? ['--whole-file'] : []),
    '--compress',
    '--human-readable',
    '--stats',
    '--backup',
    `--backup-dir=${attic}`,
    ...target.exclude.map((pattern) => `--exclude=${pattern}`),
    '-e',
    'ssh -o BatchMode=yes -o ConnectTimeout=15',
  ];
  if (dryRun) args.push('-n');
  args.push(source, `${REMOTE}:${destinationPath}`);
  log(`${target.name}: rsync${dryRun ? ' (dry-run)' : ''} iniciado.`);
  return runProcess('rsync', args);
}

async function pruneAttic() {
  const mkdirResult = await runProcess('ssh', [...SSH_ARGS, REMOTE, 'mkdir', '-p', ATTIC_ROOT], { echo: false });
  if (mkdirResult.code !== 0) {
    throw new Error(mkdirResult.stderr.trim() || `ssh mkdir salió ${mkdirResult.code}`);
  }

  const listResult = await runProcess('ssh', [
    ...SSH_ARGS,
    REMOTE,
    'find', ATTIC_ROOT,
    '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-print',
  ], { echo: false });
  if (listResult.code !== 0) {
    throw new Error(listResult.stderr.trim() || `ssh find salió ${listResult.code}`);
  }

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - ATTIC_DAYS);
  const cutoffName = localDate(cutoff);
  const expired = listResult.stdout
    .split('\n')
    .map((line) => path.posix.basename(line.trim()))
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoffName)
    .sort();

  for (const name of expired) {
    const remotePath = path.posix.join(ATTIC_ROOT, name);
    const result = await runProcess('ssh', [...SSH_ARGS, REMOTE, 'rm', '-rf', '--', remotePath], { echo: false });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `no se pudo podar ${remotePath}`);
    }
    log(`Attic podado: ${name}.`);
  }
  log(`Poda del attic completa: ${expired.length} fecha(s) con más de ${ATTIC_DAYS} días.`);
}

async function main(options) {
  logToFile = !options.dryRun;
  const selected = options.targetName
    ? TARGETS.filter((target) => target.name === options.targetName)
    : TARGETS;
  let lock = null;
  if (!options.dryRun) {
    try {
      lock = acquireLock();
    } catch (error) {
      console.error(`Espejo: no se pudo tomar el lock: ${error?.message || error}`);
      process.exitCode = 2;
      return;
    }
    if (!lock) {
      console.error('Espejo: no se pudo tomar el lock; hay otra corrida activa.');
      process.exitCode = 2;
      return;
    }
  }

  let heartbeat = null;
  if (lock) {
    heartbeat = setInterval(() => {
      try {
        if (!refreshLock(lock)) log('El runner dejó de ser dueño del lock; se detendrá al terminar el target actual.');
      } catch (error) {
        log(`No se pudo refrescar el heartbeat: ${error?.message || error}`);
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
  }

  let stopping = false;
  const stop = (signal, code) => {
    if (stopping) return;
    stopping = true;
    log(`Runner interrumpido por ${signal}; el ciclo queda reanudable.`);
    if (activeChild) activeChild.kill(signal);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    releaseLock(lock);
    process.exit(code);
  };
  process.once('SIGTERM', () => stop('SIGTERM', 143));
  process.once('SIGINT', () => stop('SIGINT', 130));

  let failed = false;
  const state = options.dryRun ? null : loadCycle(selected);
  try {
    log(`${options.dryRun ? 'DRY-RUN' : `Ciclo ${state.cycle}`} iniciado: ${selected.map((target) => target.name).join(', ')}.`);
    for (const target of selected) {
      const previous = state?.targets?.[target.name];
      if (!options.dryRun && previous?.status === 'ok') {
        log(`${target.name}: ya estaba completo en este ciclo; se omite.`);
        continue;
      }
      if (lock && !ownsLock(lock)) {
        failed = true;
        log(`${target.name}: se aborta porque el runner perdió el lock.`);
        break;
      }

      if (target.name === 'home' && await guardDestinationInUse(options)) {
        log(`GUARD: ${DESTINATION_IN_USE_MESSAGE}.`);
        if (!options.dryRun) {
          const skippedAt = new Date().toISOString();
          for (const selectedTarget of selected) {
            const targetPrevious = state.targets[selectedTarget.name];
            state.targets[selectedTarget.name] = {
              ...initialTargetState(targetPrevious),
              status: 'skipped',
              skipReason: DESTINATION_IN_USE_MESSAGE,
            };
          }
          state.skippedAt = skippedAt;
          state.skipReason = DESTINATION_IN_USE_MESSAGE;
          state.finishedAt = skippedAt;
          saveState(state);
          log(`Ciclo ${state.cycle} saltado: ${DESTINATION_IN_USE_MESSAGE}.`);
        } else {
          log(`DRY-RUN saltado: ${DESTINATION_IN_USE_MESSAGE}.`);
        }
        process.exitCode = 3;
        return;
      }

      const started = Date.now();
      if (!options.dryRun) {
        state.targets[target.name] = { ...initialTargetState(previous), status: 'running' };
        saveState(state);
      }
      let result;
      try {
        result = await syncTarget(target, options);
      } catch (error) {
        result = {
          code: 1,
          stdout: '',
          stderr: error?.message || String(error),
        };
      }
      const durationMs = Date.now() - started;
      const stats = parseRsyncStats(`${result.stdout}\n${result.stderr}`);

      if (result.code === 0) {
        log(`${target.name}: OK en ${durationMs} ms; ${stats.bytesSent} bytes enviados, ${stats.filesChanged} archivos cambiados.`);
        if (!options.dryRun) {
          state.targets[target.name] = {
            ...state.targets[target.name],
            lastOk: new Date().toISOString(),
            lastError: null,
            durationMs,
            ...stats,
            status: 'ok',
          };
          saveState(state);
        }
      } else {
        failed = true;
        const detail = result.stderr.trim().split('\n').slice(-3).join(' | ')
          || `rsync terminó con código ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
        log(`${target.name}: ERROR en ${durationMs} ms: ${detail}`);
        if (!options.dryRun) {
          state.targets[target.name] = {
            ...state.targets[target.name],
            lastError: detail.slice(0, 1000),
            durationMs,
            ...stats,
            status: 'error',
          };
          saveState(state);
        }
      }
      if (lock) refreshLock(lock);
    }

    if (options.dryRun) {
      log('DRY-RUN terminado; no se escribió estado ni se podó el attic.');
    } else {
      try {
        await pruneAttic();
      } catch (error) {
        failed = true;
        log(`ERROR al podar el attic: ${error?.message || error}`);
      }

      const allOk = Object.values(state.targets).every((target) => target.status === 'ok');
      if (allOk && !failed) state.finishedAt = new Date().toISOString();
      saveState(state);
      log(`Ciclo ${state.cycle} ${allOk && !failed ? 'completado' : 'incompleto'}.`);
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    releaseLock(lock);
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Espejo: ${error.message}`);
  usage();
  process.exitCode = 1;
}

if (options?.help) usage();
else if (options?.status) showStatus();
else if (options) await main(options);
