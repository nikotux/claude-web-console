// modules/tolkien/stack.js — identidad y referencia contada del stack N2.
//
// El estado vive en el HOME del host, no en el HOME aislado del inquilino:
// ~/.cwc-data/tolkien-stacks/<user>.json. Cada sesión viva agrega un claim y
// ningún claim se retira por tiempo; solo una fuente de liveness existente
// puede confirmar que la sesión murió.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { runAdaptivePool } from '../../core/pool.js';
import { runTmux, tmuxDir, tmuxSessionExists } from '../../core/tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'bin', 'cwc-tolkien-stack-runner.js');
const HOST_USER = process.env.CWC_HOST_USER || os.userInfo().username;
const DATA_ROOT = process.env.CWC_TOLKIEN_STACK_DATA_ROOT
  || path.join(os.homedir(), '.cwc-data');
export const STACKS_DIR = path.join(DATA_ROOT, 'tolkien-stacks');
const CHATS_FILE = path.join(DATA_ROOT, 'chats.json');
const CHATS_DIR = path.join(DATA_ROOT, 'chats');
const OWNERS_FILE = path.join(ROOT, 'session-owners.json');
const USER_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const SESSION_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const INDEX_COUNT = 400;
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 30 * 60_000;

const PORT_BASES = Object.freeze({
  DB_HOST_PORT: 5433,
  REDIS_HOST_PORT: 6380,
  CONSOLE_HOST_PORT: 3001,
  API_HOST_PORT: 3500,
});

function cleanUser(user) {
  const value = String(user || '');
  if (!USER_RE.test(value)) throw new Error(`Usuario de consola inválido: ${value}`);
  return value;
}

function cleanSessionId(sessionId) {
  const value = String(sessionId || '');
  if (!SESSION_RE.test(value)) throw new Error('sessionId inválido.');
  return value;
}

function composeNameFor(user) {
  const slug = cleanUser(user).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error(`El usuario ${user} no produce un nombre Compose seguro.`);
  }
  return `tolkien-${slug}`;
}

function hostIndex() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return uid >= 1000 ? (uid - 1000) % INDEX_COUNT : 0;
}

function hashIndex(user) {
  let hash = 2166136261;
  for (const byte of Buffer.from(cleanUser(user).toLowerCase(), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % INDEX_COUNT;
}

function preferredIndex(user, hostOwner = HOST_USER) {
  return user === hostOwner ? hostIndex() : hashIndex(user);
}

export function identityForIndex(user, index) {
  const owner = cleanUser(user);
  if (!Number.isInteger(index) || index < 0 || index >= INDEX_COUNT) {
    throw new Error(`Índice de stack inválido: ${index}`);
  }
  return {
    index,
    COMPOSE_PROJECT_NAME: composeNameFor(owner),
    DB_HOST_PORT: PORT_BASES.DB_HOST_PORT + index,
    REDIS_HOST_PORT: PORT_BASES.REDIS_HOST_PORT + index,
    CONSOLE_HOST_PORT: PORT_BASES.CONSOLE_HOST_PORT + index,
    API_HOST_PORT: PORT_BASES.API_HOST_PORT + index,
  };
}

export function identityEnv(identity) {
  return Object.fromEntries(
    ['COMPOSE_PROJECT_NAME', ...Object.keys(PORT_BASES)]
      .map((key) => [key, String(identity[key])]),
  );
}

export function stackFileFor(user) {
  return path.join(STACKS_DIR, `${cleanUser(user)}.json`);
}

function ensureStacksDir() {
  fs.mkdirSync(STACKS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STACKS_DIR, 0o700); } catch { /* best-effort */ }
}

export function readStackState(user) {
  const owner = cleanUser(user);
  try {
    const state = JSON.parse(fs.readFileSync(stackFileFor(owner), 'utf8'));
    if (!state || state.user !== owner || !state.identity || !Array.isArray(state.claims)) {
      throw new Error('estructura inválida');
    }
    return state;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(`No se pudo leer el estado del stack de ${owner}: ${err?.message || err}`);
  }
}

export function writeStackState(user, state) {
  const owner = cleanUser(user);
  if (!state || state.user !== owner || !state.identity || !Array.isArray(state.claims)) {
    throw new Error(`Estado de stack inválido para ${owner}.`);
  }
  ensureStacksDir();
  const next = { ...state, version: 1, user: owner, updatedAt: Date.now() };
  writeJsonAtomic(stackFileFor(owner), next, { mode: 0o600, space: 2 });
  fs.chmodSync(stackFileFor(owner), 0o600);
  return next;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireLock(lockFile, timeoutMs = LOCK_WAIT_MS) {
  ensureStacksDir();
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return () => {
        try { fs.closeSync(fd); } catch { /* noop */ }
        try { fs.unlinkSync(lockFile); } catch { /* noop */ }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (
          (!pidAlive(Number(lock?.pid)) && Date.now() - Number(lock?.ts || 0) > 1000)
          || Date.now() - Number(lock?.ts || 0) > LOCK_STALE_MS
        ) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (readErr) {
        if (readErr?.code === 'ENOENT') continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timeout esperando el lock ${path.basename(lockFile)}.`);
      }
      await wait(50);
    }
  }
}

export async function withStackLock(user, fn, { timeoutMs = LOCK_WAIT_MS } = {}) {
  const owner = cleanUser(user);
  const release = await acquireLock(path.join(STACKS_DIR, `${owner}.lock`), timeoutMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function withAllocationLock(fn) {
  const release = await acquireLock(path.join(STACKS_DIR, '.allocation.lock'));
  try {
    return await fn();
  } finally {
    release();
  }
}

function allPorts(identity) {
  return Object.keys(PORT_BASES).map((key) => Number(identity[key]));
}

function readAssignments() {
  ensureStacksDir();
  const out = [];
  for (const name of fs.readdirSync(STACKS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const user = name.slice(0, -5);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(STACKS_DIR, name), 'utf8'));
    } catch (err) {
      throw new Error(`Asignación Tolkien ilegible (${name}): ${err?.message || err}`);
    }
    if (!state?.identity || state.user !== user) {
      throw new Error(`Asignación Tolkien inválida (${name}); se aborta para no ocultar una colisión.`);
    }
    out.push(state);
  }
  return out;
}

export function assertIdentityGuards(user, identity, assignments = readAssignments()) {
  const owner = cleanUser(user);
  const expectedProject = composeNameFor(owner);
  const hostProject = composeNameFor(HOST_USER);
  if (identity?.COMPOSE_PROJECT_NAME !== expectedProject) {
    throw new Error(
      `GUARD DURO: ${owner} tiene COMPOSE_PROJECT_NAME=${identity?.COMPOSE_PROJECT_NAME || '(vacío)'}, `
      + `pero debe ser ${expectedProject}.`,
    );
  }
  if (owner !== HOST_USER && identity.COMPOSE_PROJECT_NAME === hostProject) {
    throw new Error(
      `GUARD DURO: el stack del inquilino ${owner} coincide con el stack del host ${hostProject}.`,
    );
  }
  for (const state of assignments) {
    if (!state || state.user === owner) continue;
    if (state.identity?.COMPOSE_PROJECT_NAME === identity.COMPOSE_PROJECT_NAME) {
      throw new Error(
        `GUARD DURO: ${identity.COMPOSE_PROJECT_NAME} ya pertenece a ${state.user}; `
        + `no se operará el stack de ${owner}.`,
      );
    }
    const otherPorts = new Set(allPorts(state.identity));
    const collision = allPorts(identity).find((port) => otherPorts.has(port));
    if (collision) {
      throw new Error(
        `GUARD DURO: el puerto ${collision} del stack de ${owner} ya está asignado a ${state.user}.`,
      );
    }
  }
  return true;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => resolve(err?.code === 'EADDRINUSE' ? false : null));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function execResult(file, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        error: String(stderr || err?.message || '').trim(),
      });
    });
  });
}

async function dockerPortsForProject(project) {
  const result = await execResult('docker', [
    'ps',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--format', '{{.Ports}}',
  ]);
  if (!result.ok) return null;
  const ports = new Set();
  for (const match of result.stdout.matchAll(/:(\d+)->\d+\/(?:tcp|udp)/g)) {
    ports.add(Number(match[1]));
  }
  return ports;
}

export async function verifyIdentityPorts(identity, { allowOwned = true } = {}) {
  const ports = allPorts(identity);
  const probes = await Promise.all(ports.map(async (port) => ({ port, free: await portIsFree(port) })));
  const occupied = probes.filter((probe) => probe.free !== true);
  if (!occupied.length) return { ok: true, conflicts: [] };

  const owned = allowOwned
    ? await dockerPortsForProject(identity.COMPOSE_PROJECT_NAME)
    : new Set();
  const conflicts = occupied
    .filter(({ port, free }) => free === null || !owned?.has(port))
    .map(({ port, free }) => ({
      port,
      reason: free === null
        ? 'no se pudo verificar si está libre'
        : 'está bindeado por otro proceso o proyecto',
    }));
  return { ok: conflicts.length === 0, conflicts };
}

export function previewStackIdentity(
  user,
  {
    occupiedPorts = [],
    assignments = [],
    hostOwner = HOST_USER,
    preserveHostIndex = true,
  } = {},
) {
  const owner = cleanUser(user);
  const project = composeNameFor(owner);
  const hostProject = composeNameFor(hostOwner);
  if (owner !== hostOwner && project === hostProject) {
    throw new Error(`GUARD DURO: ${owner} colisiona con el proyecto del host.`);
  }
  if (assignments.some((state) => state.user !== owner && state.identity?.COMPOSE_PROJECT_NAME === project)) {
    throw new Error(`GUARD DURO: ${project} ya está asignado a otro usuario.`);
  }
  const blocked = new Set(occupiedPorts.map(Number));
  for (const state of assignments) {
    if (state.user !== owner && state.identity) {
      for (const port of allPorts(state.identity)) blocked.add(port);
    }
  }
  const start = preferredIndex(owner, hostOwner);
  for (let step = 0; step < INDEX_COUNT; step += 1) {
    const index = (start + step) % INDEX_COUNT;
    const identity = identityForIndex(owner, index);
    if (owner === hostOwner && preserveHostIndex && step === 0) return identity;
    if (allPorts(identity).every((port) => !blocked.has(port))) return identity;
  }
  throw new Error(`No quedan índices de puertos libres para ${owner}.`);
}

export async function resolveStackIdentity(
  user,
  { verifyPorts = verifyIdentityPorts } = {},
) {
  const owner = cleanUser(user);
  return withAllocationLock(async () => {
    const assignments = readAssignments();
    const existing = assignments.find((state) => state.user === owner);
    if (existing) {
      assertIdentityGuards(owner, existing.identity, assignments);
      return existing.identity;
    }

    const project = composeNameFor(owner);
    if (owner !== HOST_USER && project === composeNameFor(HOST_USER)) {
      throw new Error(`GUARD DURO: ${project} es el stack del host.`);
    }
    if (assignments.some((state) => state.identity.COMPOSE_PROJECT_NAME === project)) {
      throw new Error(`GUARD DURO: ${project} ya pertenece a otro usuario.`);
    }

    const assignedPorts = new Set(assignments.flatMap((state) => allPorts(state.identity)));
    const start = preferredIndex(owner);
    for (let step = 0; step < INDEX_COUNT; step += 1) {
      const index = (start + step) % INDEX_COUNT;
      const identity = identityForIndex(owner, index);
      if (allPorts(identity).some((port) => assignedPorts.has(port))) continue;
      const portCheck = await verifyPorts(identity, { allowOwned: owner === HOST_USER });
      if (!portCheck.ok) continue;
      assertIdentityGuards(owner, identity, assignments);
      writeStackState(owner, {
        version: 1,
        user: owner,
        identity,
        claims: [],
        desired: 'down',
        status: 'stopped',
        runner: null,
        initializedAt: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return identity;
    }
    throw new Error(`No hay un índice con los cuatro puertos libres para ${owner}.`);
  });
}

function readJsonStatus(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, missing: err?.code === 'ENOENT', error: err };
  }
}

function normalizedOwner(owner) {
  return owner || HOST_USER;
}

function runnerSocketResponds(sessionId) {
  return new Promise((resolve) => {
    const socket = net.connect(path.join(CHATS_DIR, `${sessionId}.sock`));
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

// alive/dead/unknown: SOLO "dead" autoriza retirar un claim.
export async function inspectSessionLiveness(user, sessionId, { tmuxSocket = 'cwc' } = {}) {
  const owner = cleanUser(user);
  const id = cleanSessionId(sessionId);
  const chats = readJsonStatus(CHATS_FILE);
  if (chats.ok && Array.isArray(chats.value)) {
    const chat = chats.value.find((item) => item?.id === id || item?.sessionId === id);
    if (chat) {
      return normalizedOwner(chat.owner) === owner
        ? { status: 'alive', source: 'chat-registry' }
        : { status: 'unknown', source: 'chat-owner-mismatch' };
    }
  }

  // Señal positiva del mismo mecanismo que usa ChatManager.rehydrate():
  // conectar al socket prueba que el runner desacoplado sigue vivo.
  if (await runnerSocketResponds(id)) {
    return { status: 'alive', source: 'chat-runner-socket' };
  }

  const owners = readJsonStatus(OWNERS_FILE);
  if (owners.ok && owners.value && typeof owners.value === 'object') {
    const terminalOwner = normalizedOwner(owners.value.owners?.[id]);
    if (owners.value.owners?.[id] && terminalOwner !== owner) {
      return { status: 'unknown', source: 'tmux-owner-mismatch' };
    }
    if (terminalOwner === owner && owners.value.owners?.[id]) {
      const socketPath = path.join(tmuxDir(), tmuxSocket);
      const names = [`cwc-${id}`, `cwct-${id}`];
      if (names.some((name) => tmuxSessionExists(socketPath, name))) {
        return { status: 'alive', source: 'tmux-has-session' };
      }
      // El helper histórico devuelve false tanto para "no existe" como para
      // fallos de tmux. Para autorizar un down exigimos una segunda prueba:
      // socket ausente = server muerto; o listado exitoso sin el nombre exacto.
      try {
        if (!fs.existsSync(socketPath)) {
          return { status: 'dead', source: 'tmux-has-session' };
        }
        const listed = runTmux(socketPath, ['list-sessions', '-F', '#{session_name}'], { throwOnError: true })
          .split('\n')
          .map((name) => name.trim())
          .filter(Boolean);
        return {
          status: names.some((name) => listed.includes(name)) ? 'alive' : 'dead',
          source: 'tmux-has-session',
        };
      } catch {
        return { status: 'unknown', source: 'tmux-error' };
      }
    }
  }

  // Un chats.json válido y sin la sesión prueba que el chat ya fue cerrado.
  // Si el archivo falta/está corrupto, no sabemos: conservar el claim.
  if (chats.ok && Array.isArray(chats.value)) {
    return { status: 'dead', source: 'chat-registry' };
  }
  return { status: 'unknown', source: chats.missing ? 'chat-registry-missing' : 'chat-registry-error' };
}

export function addClaimToState(state, { sessionId, owner, ts = Date.now() }) {
  const id = cleanSessionId(sessionId);
  const user = cleanUser(owner);
  const claims = Array.isArray(state?.claims) ? state.claims : [];
  if (claims.some((claim) => claim.sessionId === id && claim.owner === user)) {
    return { ...state, claims };
  }
  return { ...state, claims: [...claims, { sessionId: id, owner: user, ts }] };
}

export function removeClaimIfDead(state, sessionId, liveness) {
  const id = cleanSessionId(sessionId);
  if (liveness !== 'dead') return state;
  return {
    ...state,
    claims: (Array.isArray(state?.claims) ? state.claims : [])
      .filter((claim) => claim.sessionId !== id),
  };
}

export async function reconcileClaimsState(
  state,
  {
    tmuxSocket = 'cwc',
    inspect = inspectSessionLiveness,
  } = {},
) {
  let next = { ...state, claims: Array.isArray(state?.claims) ? [...state.claims] : [] };
  const checks = new Array(next.claims.length);
  const indexed = next.claims.map((claim, index) => ({ claim, index }));
  // Las inspecciones son LECTURAS independientes. El pool termina en barrera;
  // la mutación de `next` queda serial debajo para conservar orden y seguridad.
  await runAdaptivePool(indexed, async ({ claim, index }) => {
    let liveness;
    try {
      liveness = await inspect(claim.owner, claim.sessionId, { tmuxSocket });
    } catch {
      liveness = { status: 'unknown', source: 'liveness-error' };
    }
    checks[index] = { sessionId: claim.sessionId, ...liveness };
  });
  for (const check of checks) {
    next = removeClaimIfDead(next, check.sessionId, check.status);
  }
  return { state: next, checks };
}

function spawnStackRunnerUnlocked(owner, action, state, { tmuxSocket = 'cwc' } = {}) {
  ensureStacksDir();
  const logFile = path.join(STACKS_DIR, `${owner}.log`);
  const logFd = fs.openSync(logFile, 'a', 0o600);
  fs.chmodSync(logFile, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [
      RUNNER,
      '--user', owner,
      '--action', action,
      '--tmux-socket', tmuxSocket,
    ], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.once('error', (err) => {
      // Un error de spawn puede llegar después de que spawn() devolvió. Tener
      // listener evita un `error` no manejado que tumbe el server; el estado
      // persistido permite reintentar sin perder identidad ni claims.
      withStackLock(owner, async () => {
        const latest = readStackState(owner);
        if (!latest || latest.runner?.pid !== child.pid) return;
        writeStackState(owner, {
          ...latest,
          status: 'error',
          runner: null,
          error: `No se pudo iniciar el runner: ${String(err?.message || err).slice(0, 300)}`,
        });
      }).catch(() => {});
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  return writeStackState(owner, {
    ...state,
    desired: action === 'up' ? 'up' : 'down',
    status: action === 'up' ? 'starting' : 'stopping',
    runner: { pid: child.pid, action, startedAt: Date.now() },
    error: null,
  });
}

export async function requestStackUp(
  user,
  sessionId,
  {
    tmuxSocket = 'cwc',
    inspect = inspectSessionLiveness,
  } = {},
) {
  const owner = cleanUser(user);
  const id = cleanSessionId(sessionId);
  const identity = await resolveStackIdentity(owner);
  const liveness = await inspect(owner, id, { tmuxSocket });
  // Un socket solo prueba que hay UN runner, no de quién es. Sirve para
  // conservar un claim ya existente ante un registro ilegible, pero nunca
  // alcanza para que un request nuevo se apropie de una sesión ajena.
  const ownerProven = ['chat-registry', 'tmux-has-session'].includes(liveness?.source);
  if (liveness?.status !== 'alive' || !ownerProven) {
    throw new Error(
      `No se puede reclamar el stack: la sesión ${id} no está confirmada como viva para ${owner}.`,
    );
  }
  const portCheck = await verifyIdentityPorts(identity, { allowOwned: true });
  if (!portCheck.ok) {
    throw new Error(
      `Los puertos persistidos del stack de ${owner} no están libres: `
      + portCheck.conflicts.map((item) => `${item.port} (${item.reason})`).join(', '),
    );
  }

  return withStackLock(owner, async () => {
    let state = readStackState(owner);
    assertIdentityGuards(owner, state.identity);
    state = addClaimToState(state, { sessionId: id, owner });
    if (
      state.status === 'running'
      || (state.status === 'starting' && pidAlive(Number(state.runner?.pid)))
    ) {
      state = writeStackState(owner, { ...state, desired: 'up' });
      return { started: false, state, liveness };
    }
    state = spawnStackRunnerUnlocked(owner, 'up', state, { tmuxSocket });
    return { started: true, state, liveness };
  });
}

export async function requestStackDown(
  user,
  {
    tmuxSocket = 'cwc',
    inspect = inspectSessionLiveness,
  } = {},
) {
  const owner = cleanUser(user);
  return withStackLock(owner, async () => {
    let state = readStackState(owner);
    if (!state) return { started: false, configured: false, state: null, checks: [] };
    assertIdentityGuards(owner, state.identity);
    const reconciled = await reconcileClaimsState(state, { tmuxSocket, inspect });
    state = writeStackState(owner, reconciled.state);
    if (state.claims.length > 0) {
      return { started: false, configured: true, claimed: true, state, checks: reconciled.checks };
    }
    if (state.status === 'stopped') {
      return { started: false, configured: true, claimed: false, state, checks: reconciled.checks };
    }
    if (pidAlive(Number(state.runner?.pid))) {
      state = writeStackState(owner, { ...state, desired: 'down' });
      return {
        started: false,
        configured: true,
        claimed: false,
        pending: true,
        state,
        checks: reconciled.checks,
      };
    }
    state = spawnStackRunnerUnlocked(owner, 'down', state, { tmuxSocket });
    return { started: true, configured: true, claimed: false, state, checks: reconciled.checks };
  });
}

export function stackStatus(user) {
  const owner = cleanUser(user);
  const state = readStackState(owner);
  if (!state) return { configured: false, user: owner, status: 'unconfigured', claims: [] };
  assertIdentityGuards(owner, state.identity);
  return {
    configured: true,
    user: owner,
    identity: state.identity,
    status: state.status,
    desired: state.desired,
    initializedAt: state.initializedAt || null,
    error: state.error || null,
    claims: state.claims,
    claimCount: state.claims.length,
    runner: state.runner
      ? { ...state.runner, alive: pidAlive(Number(state.runner.pid)) }
      : null,
    updatedAt: state.updatedAt,
  };
}
