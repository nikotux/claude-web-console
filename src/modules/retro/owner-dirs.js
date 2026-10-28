// Puente config-free entre server y runners: el runner de un inquilino arranca
// con env limpio y todo dato user-scoped debe resolverse por dueño, nunca desde
// globales. El server inyecta resolvers; el runner valida CWC_DATA_DIR y falla
// cerrado antes de aceptar un owner que no coincida con su aislamiento.
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '../../core/data-dir.js';

let server = null;

export function installRetroServerResolvers({ hostUser, userDataDir, userClaudeDir, runnerEnvFor }) {
  const resolvers = { hostUser, userDataDir, userClaudeDir, runnerEnvFor };
  for (const [name, resolver] of Object.entries(resolvers)) {
    if (typeof resolver !== 'function') throw new TypeError(`[retro] resolver de server inválido: ${name}`);
  }
  if (server) {
    if (Object.entries(resolvers).every(([name, resolver]) => server[name] === resolver)) return;
    throw new Error('[retro] los resolvers de server ya fueron instalados');
  }
  server = Object.freeze(resolvers);
}

export function retroHostUser() {
  return server ? server.hostUser() : null;
}

function isolatedDataDirFor(owner) {
  const configured = String(process.env.CWC_DATA_DIR || '').trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (path.basename(path.dirname(resolved)) === String(owner)) return resolved;
  }
  throw new Error(`[retro] dataDir de un dueño sin resolver de server (fail-closed): ${owner}`);
}

export function retroDataDirFor(owner = null) {
  if (server) return owner ? server.userDataDir(owner) : resolveDataDir();
  return owner ? isolatedDataDirFor(owner) : resolveDataDir();
}

export function retroClaudeDirFor(owner = null) {
  if (server) return server.userClaudeDir(owner || server.hostUser());
  if (!owner) return path.join(os.homedir(), '.claude');
  return path.join(path.dirname(isolatedDataDirFor(owner)), '.claude');
}

export function retroRunnerEnvFor(owner, opts = {}) {
  if (!server) throw new Error('[retro] spawn de runner solo desde el server (fail-closed)');
  return server.runnerEnvFor(owner, opts);
}
