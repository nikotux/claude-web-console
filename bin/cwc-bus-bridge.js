#!/usr/bin/env node
// bin/cwc-bus-bridge.js — puente DESACOPLADO del Interfono entre máquinas.
// El timer ejecuta ciclos one-shot; outbox, estado, lock y log sobreviven a
// reinicios de la interfaz web porque viven bajo ~/.cwc-data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeJsonAtomic } from '../src/core/atomic-write.js';

const HOME = os.homedir();
const HOST = os.hostname().toLowerCase();
const DATA_DIR = path.join(HOME, '.cwc-data');
const PEERS_FILE = path.join(DATA_DIR, 'bus-peers.json');
const OUTBOX_DIR = path.join(DATA_DIR, 'bus-outbox');
const DONE_DIR = path.join(OUTBOX_DIR, 'done');
const FAILED_DIR = path.join(OUTBOX_DIR, 'failed');
const STATE_FILE = path.join(DATA_DIR, 'bus-bridge-state.json');
const LOCK_FILE = path.join(DATA_DIR, 'bus-bridge.lock');
const LOG_FILE = path.join(DATA_DIR, 'bus-bridge.log');
const MAX_ATTEMPTS = 5;
const MAX_HOPS_FALLBACK = 6;
const MSG_TTL_MS_FALLBACK = 6 * 60 * 60 * 1000;
const STALE_LOCK_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 60_000;
const DELIVERY_TIMEOUT_MS = 60_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
const SEND_KINDS = new Set(['note', 'heads-up']);
let activeChild = null;

const usage = () => console.log(`Uso:
  node bin/cwc-bus-bridge.js send <máquina>:<handle> "<texto>" [--kind <note|heads-up>]
  node bin/cwc-bus-bridge.js --once
  node bin/cwc-bus-bridge.js --status
  node bin/cwc-bus-bridge.js --help

Sin flags corre un único ciclo de entrega, igual que --once.

Configuración: ${PEERS_FILE}
Outbox:       ${OUTBOX_DIR}`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ensureRuntimeDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(DONE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FAILED_DIR, { recursive: true, mode: 0o700 });
}

function rotateLogIfNeeded() {
  try {
    if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
    try { fs.rmSync(`${LOG_FILE}.1`, { force: true }); } catch { /* noop */ }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function log(message, { strong = false } = {}) {
  const prefix = strong ? 'ERROR CRÍTICO' : 'bus-bridge';
  const line = `[${new Date().toISOString()}] [${prefix}] ${message}`;
  (strong ? console.error : console.log)(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[bus-bridge] No se pudo escribir el log: ${error?.message || error}`);
  }
}

function loadPeers() {
  const raw = readJson(PEERS_FILE);
  if (raw === null) return new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${PEERS_FILE} debe contener un objeto JSON.`);
  }

  const peers = new Map();
  for (const [rawName, value] of Object.entries(raw)) {
    const name = rawName.trim().toLowerCase();
    if (!name) throw new Error('Hay un peer con nombre vacío.');
    if (name === HOST) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`El peer "${rawName}" debe ser un objeto.`);
    }
    const ssh = String(value.ssh || '').trim();
    const repo = String(value.repo || '').trim();
    if (!ssh || !repo || !path.posix.isAbsolute(repo)) {
      throw new Error(`El peer "${rawName}" necesita ssh y una ruta repo absoluta.`);
    }
    if (peers.has(name)) throw new Error(`Peer duplicado al normalizar: ${name}.`);
    peers.set(name, { name, ssh, repo });
  }
  return peers;
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
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
  const heartbeat = Date.parse(lock.heartbeatAt);
  const stale = !Number.isFinite(heartbeat) || Date.now() - heartbeat > STALE_LOCK_MS;
  const dead = lock.host === HOST && !pidAlive(Number(lock.pid));
  return stale || dead;
}

function claimEmptyLock(lock) {
  const tmp = `${LOCK_FILE}.claim.${process.pid}`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, `${JSON.stringify(lock)}\n`, { mode: 0o600, flag: 'wx' });
    // link(2) da no-clobber al tomarlo; luego CONVE-5 mantiene su contenido.
    fs.linkSync(tmp, LOCK_FILE);
    fs.unlinkSync(tmp);
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
    try { current = readJson(LOCK_FILE); } catch { current = null; }
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

function assertBridgeLoopGuards({ fromName, hops = 0, maxHops = MAX_HOPS_FALLBACK }) {
  // GUARD ANTI-BUCLE: un mensaje ya inyectado por otro puente jamás vuelve al
  // outbox. Dos puentes enfrentados se lo reenviarían para siempre sin esto.
  if (String(fromName || '').includes('[via ')) {
    throw new Error('Guard anti-bucle: no se re-encola un mensaje cuyo fromName ya contiene "[via ".');
  }
  const hopCount = Number(hops) || 0;
  if (hopCount >= maxHops) {
    throw new Error(`Guard anti-bucle: el mensaje alcanzó MAX_HOPS=${maxHops}.`);
  }
  return hopCount;
}

async function loadBus() {
  return import('../src/core/bus.js');
}

async function localIdentity() {
  const bus = await loadBus();
  const handle = String(process.env.CWC_SELF_HANDLE || '').trim();
  const directory = bus.buildDirectory();
  const own = handle ? directory.find((entry) => entry.handle === handle) : null;
  return {
    from: handle || null,
    fromName: own?.name || `una sesión en ${HOST}`,
  };
}

function parseSendArgs(argv) {
  if (!argv.length) throw new Error('Falta el destino <máquina>:<handle>.');
  const destination = argv[0];
  let kind = 'note';
  const textParts = [];
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--kind') {
      if (!argv[index + 1]) throw new Error('Falta el valor de --kind.');
      kind = argv[index + 1];
      index += 1;
    } else {
      textParts.push(argv[index]);
    }
  }
  const match = destination.match(/^([^:]+):(.+)$/);
  if (!match) throw new Error('El destino debe tener la forma <máquina>:<handle>.');
  const text = textParts.join(' ').trim();
  if (!text) throw new Error('El texto del mensaje no puede estar vacío.');
  if (!SEND_KINDS.has(kind)) {
    throw new Error(`Kind desconocido "${kind}". Kinds válidos: ${[...SEND_KINDS].join(', ')}.`);
  }
  return { machine: match[1].toLowerCase(), handle: match[2], text, kind };
}

function availablePeers(peers) {
  return [...peers.keys()].sort().join(', ') || '(ninguno)';
}

async function enqueue(argv) {
  const peers = loadPeers();
  const parsed = parseSendArgs(argv);
  if (!peers.has(parsed.machine)) {
    throw new Error(
      `Máquina desconocida "${parsed.machine}". Peers disponibles: ${availablePeers(peers)}.`,
    );
  }
  const identity = await localIdentity();
  assertBridgeLoopGuards({ fromName: identity.fromName });
  ensureRuntimeDirs();
  const id = crypto.randomUUID();
  const message = {
    id,
    createdAt: new Date().toISOString(),
    toMachine: parsed.machine,
    toHandle: parsed.handle,
    text: parsed.text,
    kind: parsed.kind,
    fromMachine: HOST,
    from: identity.from,
    fromName: identity.fromName,
    attempts: 0,
    lastError: null,
    hops: 0,
  };
  writeJsonAtomic(path.join(OUTBOX_DIR, `${id}.json`), message, { mode: 0o600, space: 2 });
  console.log(`Mensaje ${id} encolado para ${parsed.machine}:${parsed.handle}; lo entregará el próximo ciclo.`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function appendLimited(current, chunk) {
  return `${current}${chunk.toString()}`.slice(-16_000);
}

function deliveryError(result) {
  if (result.timedOut) return `ssh superó el timeout duro de ${DELIVERY_TIMEOUT_MS / 1000} s`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return (detail || `ssh terminó con código ${result.code}`).slice(0, 2000);
}

function deliverMessage(peer, message) {
  /*
   * cwc-bus.js send recibe el texto como argumento (no por stdin) y deriva por
   * sí mismo fromName/hops. Eso impediría marcar [via origen] y subir hops. El
   * modo interno --inject-stdin de ESTE runner decodifica el sobre base64 y usa
   * sendMessage() del bus existente: no crea un segundo bus ni otro protocolo.
   */
  const payload = Buffer.from(JSON.stringify(message), 'utf8').toString('base64');
  const remoteScript = path.posix.join(peer.repo, 'bin', 'cwc-bus-bridge.js');
  const remoteCommand = `cd ${shellQuote(peer.repo)} && base64 -d | /usr/bin/node ${shellQuote(remoteScript)} --inject-stdin`;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    const child = spawn('ssh', [...SSH_OPTIONS, peer.ssh, remoteCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    activeChild = child;

    const finish = (code, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChild = null;
      resolve({ code: Number.isInteger(code) ? code : 1, signal, stdout, stderr, timedOut });
    };
    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') stderr = appendLimited(stderr, error.message);
    });
    child.once('error', (error) => {
      stderr = appendLimited(stderr, error.message);
      finish(1);
    });
    child.once('close', (code, signal) => finish(code, signal));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DELIVERY_TIMEOUT_MS);
    child.stdin.end(payload);
  });
}

function archiveMessage(source, destinationDir, message) {
  const destination = path.join(destinationDir, path.basename(source));
  writeJsonAtomic(source, message, { mode: 0o600, space: 2 });
  fs.renameSync(source, destination);
}

function loadState() {
  try {
    return readJson(STATE_FILE) || {};
  } catch (error) {
    log(`Estado anterior ilegible; se inicia uno nuevo: ${error?.message || error}`);
    return {};
  }
}

function beginCycle(previous, peers) {
  const peerState = { ...(previous.peers || {}) };
  for (const name of peers.keys()) {
    peerState[name] = {
      delivered: Number(peerState[name]?.delivered) || 0,
      failed: Number(peerState[name]?.failed) || 0,
      lastOk: peerState[name]?.lastOk || null,
      lastError: peerState[name]?.lastError || null,
      lastAttemptAt: peerState[name]?.lastAttemptAt || null,
    };
  }
  return {
    cycle: (Number(previous.cycle) || 0) + 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    delivered: Number(previous.delivered) || 0,
    failed: Number(previous.failed) || 0,
    pending: listJsonFiles(OUTBOX_DIR).length,
    lastError: previous.lastError || null,
    peers: peerState,
  };
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, state, { mode: 0o600, space: 2 });
}

function markTerminalFailure(source, message, state, reason) {
  const now = new Date().toISOString();
  const failedMessage = { ...message, lastError: reason, failedAt: now };
  archiveMessage(source, FAILED_DIR, failedMessage);
  state.failed += 1;
  const peer = state.peers[String(message.toMachine || '').toLowerCase()];
  if (peer) peer.failed += 1;
  log(
    `Mensaje ${message.id || path.basename(source)} movido a failed/: NADIE LO RECIBIÓ. ${reason}`,
    { strong: true },
  );
}

async function processPending(peers, state, lock) {
  const bus = await loadBus();
  const maxHops = Number(bus.MAX_HOPS) || MAX_HOPS_FALLBACK;
  const messageTtlMs = Number(bus.MSG_TTL_MS) || MSG_TTL_MS_FALLBACK;
  let hadFailure = false;

  for (const source of listJsonFiles(OUTBOX_DIR)) {
    if (!ownsLock(lock)) throw new Error('El runner perdió el lock durante el ciclo.');
    let message;
    try {
      message = readJson(source);
    } catch (error) {
      hadFailure = true;
      const destination = path.join(FAILED_DIR, path.basename(source));
      fs.renameSync(source, destination);
      const reason = `Outbox ilegible: ${error?.message || error}`;
      state.failed += 1;
      state.lastError = reason;
      saveState(state);
      log(`${path.basename(source)} movido a failed/. ${reason}`, { strong: true });
      continue;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      hadFailure = true;
      const reason = 'Descartado: el archivo de outbox no contiene un objeto JSON.';
      markTerminalFailure(source, { id: path.basename(source), value: message }, state, reason);
      state.lastError = reason;
      saveState(state);
      continue;
    }

    try {
      assertBridgeLoopGuards({ fromName: message.fromName, hops: message.hops, maxHops });
    } catch (error) {
      hadFailure = true;
      const reason = `Descartado por anti-bucle: ${error.message}`;
      markTerminalFailure(source, message, state, reason);
      state.lastError = reason;
      saveState(state);
      continue;
    }

    const age = Date.now() - Date.parse(message?.createdAt);
    if (!Number.isFinite(age) || age > messageTtlMs) {
      hadFailure = true;
      markTerminalFailure(source, message, state, 'Descartado: venció el TTL del bus antes de entregarse.');
      saveState(state);
      continue;
    }

    const peer = peers.get(String(message.toMachine || '').toLowerCase());
    const attemptedAt = new Date().toISOString();
    if (!peer) {
      const reason = `El peer "${message.toMachine}" ya no está configurado.`;
      message.attempts = (Number(message.attempts) || 0) + 1;
      message.lastError = reason;
      hadFailure = true;
      if (message.attempts >= MAX_ATTEMPTS) markTerminalFailure(source, message, state, reason);
      else writeJsonAtomic(source, message, { mode: 0o600, space: 2 });
      state.lastError = reason;
      saveState(state);
      continue;
    }

    state.peers[peer.name].lastAttemptAt = attemptedAt;
    log(`Entregando ${message.id} a ${peer.name}:${message.toHandle} (intento ${(Number(message.attempts) || 0) + 1}/${MAX_ATTEMPTS}).`);
    const result = await deliverMessage(peer, message);
    if (result.code === 0) {
      const deliveredAt = new Date().toISOString();
      archiveMessage(source, DONE_DIR, { ...message, deliveredAt, lastError: null });
      state.delivered += 1;
      state.peers[peer.name].delivered += 1;
      state.peers[peer.name].lastOk = deliveredAt;
      log(`Mensaje ${message.id} entregado a ${peer.name}:${message.toHandle}.`);
    } else {
      hadFailure = true;
      const reason = deliveryError(result);
      message.attempts = (Number(message.attempts) || 0) + 1;
      message.lastError = reason;
      state.lastError = reason;
      state.peers[peer.name].lastError = reason;
      if (message.attempts >= MAX_ATTEMPTS) {
        markTerminalFailure(source, message, state, `Agotó ${MAX_ATTEMPTS} intentos. Último error: ${reason}`);
      } else {
        writeJsonAtomic(source, message, { mode: 0o600, space: 2 });
        log(`Mensaje ${message.id} falló y queda pendiente: ${reason}`);
      }
    }
    state.pending = listJsonFiles(OUTBOX_DIR).length;
    saveState(state);
    refreshLock(lock);
  }
  return hadFailure;
}

async function runCycle() {
  const peers = loadPeers();
  if (!peers.size) {
    console.log(`Puente del Interfono: no hay peers configurados en ${PEERS_FILE}; no hay nada que entregar.`);
    return 0;
  }
  ensureRuntimeDirs();
  let lock;
  try {
    lock = acquireLock();
  } catch (error) {
    console.error(`Puente del Interfono: no se pudo tomar el lock: ${error?.message || error}`);
    return 2;
  }
  if (!lock) {
    console.error('Puente del Interfono: hay otro ciclo activo; se omite esta corrida.');
    return 2;
  }

  const heartbeat = setInterval(() => {
    try {
      if (!refreshLock(lock)) log('El runner dejó de ser dueño del lock.');
    } catch (error) {
      log(`No se pudo refrescar el heartbeat: ${error?.message || error}`);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const stop = (signal, code) => {
    if (activeChild) activeChild.kill(signal);
    clearInterval(heartbeat);
    releaseLock(lock);
    process.exit(code);
  };
  process.once('SIGTERM', () => stop('SIGTERM', 143));
  process.once('SIGINT', () => stop('SIGINT', 130));

  const state = beginCycle(loadState(), peers);
  saveState(state);
  let failed = false;
  try {
    log(`Ciclo ${state.cycle} iniciado con ${state.pending} mensaje(s) pendiente(s).`);
    failed = await processPending(peers, state, lock);
  } catch (error) {
    failed = true;
    state.lastError = error?.message || String(error);
    log(`Ciclo ${state.cycle} abortado: ${state.lastError}`, { strong: true });
  } finally {
    state.pending = listJsonFiles(OUTBOX_DIR).length;
    state.finishedAt = new Date().toISOString();
    saveState(state);
    clearInterval(heartbeat);
    releaseLock(lock);
  }
  log(`Ciclo ${state.cycle} terminado: ${failed ? 'con fallos' : 'OK'}; pendientes=${state.pending}.`);
  return failed ? 1 : 0;
}

function showStatus() {
  const peers = loadPeers();
  let state = null;
  try { state = readJson(STATE_FILE); } catch (error) {
    throw new Error(`No se pudo leer el estado: ${error?.message || error}`);
  }
  const pending = listJsonFiles(OUTBOX_DIR).length;
  const delivered = listJsonFiles(DONE_DIR).length;
  const failed = listJsonFiles(FAILED_DIR).length;
  console.log(`Puente del Interfono — máquina ${HOST}`);
  if (!peers.size) console.log(`Peers configurados: ninguno (${PEERS_FILE} no existe o solo declara esta máquina).`);
  else console.log(`Peers configurados (${peers.size}): ${availablePeers(peers)}.`);
  console.log(`Mensajes: ${pending} pendientes · ${delivered} entregados · ${failed} fallidos.`);
  console.log(`Último ciclo: ${state?.cycle || 'ninguno'}${state?.finishedAt ? ` · ${state.finishedAt}` : ''}.`);
  console.log(`Último error general: ${state?.lastError || 'ninguno'}.`);
  for (const name of [...peers.keys()].sort()) {
    console.log(`- ${name}: último error: ${state?.peers?.[name]?.lastError || 'ninguno'}.`);
  }
}

async function injectFromStdin() {
  // El shell remoto hace base64 -d antes de invocar Node; acá ya llega el JSON
  // decodificado y nunca se interpola texto del usuario en una línea de shell.
  const decoded = fs.readFileSync(0, 'utf8').trim();
  if (!decoded) throw new Error('No llegó el sobre decodificado por stdin.');
  let message;
  try {
    message = JSON.parse(decoded);
  } catch {
    throw new Error('El sobre remoto decodificado no contiene JSON válido.');
  }
  if (!message || typeof message !== 'object') throw new Error('Sobre remoto inválido.');
  if (!message.toHandle || !message.text || !message.fromMachine) {
    throw new Error('Sobre remoto incompleto: faltan toHandle, text o fromMachine.');
  }
  const bus = await loadBus();
  let hops;
  try {
    hops = assertBridgeLoopGuards({
      fromName: message.fromName,
      hops: message.hops,
      maxHops: bus.MAX_HOPS,
    });
  } catch (error) {
    log(`Mensaje ${message.id || '(sin id)'} descartado al recibir: ${error.message}`, { strong: true });
    throw error;
  }
  const target = bus.resolveTarget(message.toHandle);
  const directory = bus.buildDirectory();
  if (target.error) throw new Error(target.error);
  const directoryEntry = target.handle === 'all'
    ? null
    : directory.find((entry) => entry.handle === target.handle);
  if (target.handle !== 'all' && !directoryEntry) {
    throw new Error(`El handle remoto ${target.handle} no está en el directorio del Interfono.`);
  }
  const resolved = directoryEntry || target;
  const injected = bus.sendMessage({
    from: `bridge:${String(message.fromMachine).toLowerCase()}`,
    fromName: `[via ${String(message.fromMachine).toLowerCase()}] ${message.fromName || 'una sesión'}`,
    to: resolved.handle,
    toName: resolved.name,
    text: message.text,
    kind: SEND_KINDS.has(message.kind) ? message.kind : 'note',
    hops: hops + 1,
  });
  console.log(`Mensaje remoto inyectado en el bus existente: ${injected.id}.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    usage();
    return 0;
  }
  if (args[0] === '--status') {
    if (args.length !== 1) throw new Error('--status no acepta otros argumentos.');
    showStatus();
    return 0;
  }
  if (args[0] === 'send') {
    await enqueue(args.slice(1));
    return 0;
  }
  if (args[0] === '--inject-stdin') {
    await injectFromStdin();
    return 0;
  }
  if (!args.length || (args.length === 1 && args[0] === '--once')) return runCycle();
  throw new Error(`Argumento desconocido: ${args.join(' ')}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`Puente del Interfono: ${error?.message || error}`);
  process.exitCode = 1;
}
