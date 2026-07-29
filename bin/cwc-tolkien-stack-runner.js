#!/usr/bin/env node
// bin/cwc-tolkien-stack-runner.js — ejecutor desacoplado del stack N2.
//
// `up` hace el onboarding idempotente la primera vez y luego usa Compose
// directamente. `down` conserva los volúmenes y vuelve a comprobar que no
// quede ningún claim antes de tocar contenedores.
import './_env-boot.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  hostUser,
  sanitizeUserId,
  userRunnerEnv,
  userSpace,
  userWorkspace,
} from '../src/core/user-space.js';
import {
  assertIdentityGuards,
  identityEnv,
  readStackState,
  reconcileClaimsState,
  verifyIdentityPorts,
  withStackLock,
  writeStackState,
} from '../src/modules/tolkien/stack.js';

const args = {};
for (let index = 2; index < process.argv.length - 1; index += 2) {
  const key = process.argv[index];
  if (key.startsWith('--')) args[key.slice(2)] = process.argv[index + 1];
}

let USER;
try {
  USER = sanitizeUserId(args.user);
} catch (err) {
  console.error('[tolkien-stack] usuario inválido:', err?.message || err);
  process.exit(2);
}

const ACTION = args.action;
const TMUX_SOCKET = String(args['tmux-socket'] || 'cwc');
if (!['up', 'down'].includes(ACTION)) {
  console.error('[tolkien-stack] --action debe ser up o down');
  process.exit(2);
}

const cloneDir = USER === hostUser()
  ? path.join(userSpace(USER), 'tolkien')
  : path.join(userWorkspace(USER), 'tolkien');
const onboardScript = path.join(cloneDir, 'scripts', 'onboard.sh');
let activeChild = null;
let stopping = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] [tolkien-stack:${USER}] ${message}`);
}

function commandEnv(identity) {
  const base = USER === hostUser()
    ? { ...process.env }
    : userRunnerEnv(USER);
  return { ...base, ...identityEnv(identity) };
}

function runCommand(file, commandArgs, env) {
  return new Promise((resolve, reject) => {
    log(`ejecutando ${path.basename(file)} ${commandArgs.join(' ')}`);
    const child = spawn(file, commandArgs, {
      cwd: cloneDir,
      env,
      stdio: 'inherit',
    });
    activeChild = child;
    child.once('error', (err) => {
      activeChild = null;
      reject(err);
    });
    child.once('exit', (code, signal) => {
      activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} terminó con ${signal || `código ${code}`}`));
    });
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  try { activeChild?.kill('SIGTERM'); } catch { /* noop */ }
  // Si hay un comando, su exit rechazará runCommand y el catch persistirá el
  // error después de liberar cualquier lock. Salir desde acá intentaría tomar
  // de nuevo el mismo lock del `down` y podría auto-bloquear al runner.
  if (!activeChild) {
    markError(new Error(`runner cancelado por ${signal}`))
      .catch(() => {})
      .finally(() => process.exit(1));
  }
}

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

function requireClone() {
  if (!fs.existsSync(cloneDir)) {
    throw new Error(`No existe el clon de Tolkien del usuario: ${cloneDir}`);
  }
}

async function markError(err) {
  const message = String(err?.message || err).slice(0, 500);
  try {
    await withStackLock(USER, async () => {
      const state = readStackState(USER);
      if (!state) return;
      writeStackState(USER, {
        ...state,
        status: 'error',
        runner: null,
        error: message,
      });
    });
  } catch (stateErr) {
    console.error('[tolkien-stack] tampoco se pudo persistir el error:', stateErr?.message || stateErr);
  }
  throw err;
}

async function runDown() {
  return withStackLock(USER, async () => {
    let state = readStackState(USER);
    if (!state) throw new Error(`No existe una identidad persistida para ${USER}.`);
    assertIdentityGuards(USER, state.identity);
    const reconciled = await reconcileClaimsState(state, { tmuxSocket: TMUX_SOCKET });
    state = reconciled.state;
    if (state.claims.length > 0) {
      writeStackState(USER, {
        ...state,
        desired: 'up',
        status: 'running',
        runner: null,
        error: null,
      });
      log(`down cancelado: quedan ${state.claims.length} claim(s) vivo(s) o incierto(s)`);
      return { skipped: true };
    }

    state = writeStackState(USER, {
      ...state,
      desired: 'down',
      status: 'stopping',
      runner: { pid: process.pid, action: 'down', startedAt: Date.now() },
      error: null,
    });
    requireClone();
    // El lock se conserva durante `down`: una sesión nueva espera y recién
    // reclama cuando la operación terminó, evitando una carrera destructiva.
    await runCommand('docker', ['compose', 'down'], commandEnv(state.identity));
    writeStackState(USER, {
      ...readStackState(USER),
      desired: 'down',
      status: 'stopped',
      runner: null,
      error: null,
      stoppedAt: Date.now(),
    });
    return { skipped: false };
  });
}

async function runUp() {
  let state = readStackState(USER);
  if (!state) throw new Error(`No existe una identidad persistida para ${USER}.`);
  assertIdentityGuards(USER, state.identity);
  requireClone();

  const portCheck = await verifyIdentityPorts(state.identity, { allowOwned: true });
  if (!portCheck.ok) {
    throw new Error(
      'Puertos del stack ocupados por otro proceso/proyecto: '
      + portCheck.conflicts.map((item) => item.port).join(', '),
    );
  }

  const env = commandEnv(state.identity);
  if (!state.initializedAt) {
    if (!fs.existsSync(onboardScript)) {
      throw new Error(`No existe el script externo de onboarding: ${onboardScript}`);
    }
    await runCommand('bash', [onboardScript, '--yes'], env);
  } else {
    await runCommand('docker', ['compose', 'up', '-d', 'postgres', 'redis'], env);
  }

  let shouldStop = false;
  await withStackLock(USER, async () => {
    state = readStackState(USER);
    assertIdentityGuards(USER, state.identity);
    const reconciled = await reconcileClaimsState(state, { tmuxSocket: TMUX_SOCKET });
    state = reconciled.state;
    shouldStop = state.desired === 'down' && state.claims.length === 0;
    writeStackState(USER, {
      ...state,
      status: shouldStop ? 'stopping' : 'running',
      desired: shouldStop ? 'down' : 'up',
      runner: shouldStop
        ? { pid: process.pid, action: 'down', startedAt: Date.now() }
        : null,
      initializedAt: state.initializedAt || Date.now(),
      startedAt: Date.now(),
      error: null,
    });
  });

  // Si /down llegó mientras terminaba el onboarding, honra esa intención
  // después de volver a comprobar los claims bajo el lock.
  if (shouldStop) await runDown();
}

async function main() {
  log(`inicio action=${ACTION} pid=${process.pid}`);
  if (ACTION === 'up') await runUp();
  else await runDown();
  log(`fin action=${ACTION}`);
}

main().catch(async (err) => {
  try { await markError(err); } catch (finalErr) {
    console.error(`[${new Date().toISOString()}] [tolkien-stack:${USER}] fatal:`, finalErr?.stack || finalErr);
  }
  process.exit(1);
});
