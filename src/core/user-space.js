// core/user-space.js — helpers del ROOT por-usuario para el multi-tenant.
//
// Cada usuario tiene un root privado en ~/.cwc-users/<userId>/ con sus
// subdirectorios .claude, .cwc-data, workspace, etc. Estas funciones son
// plomería server-side: el SERVER y los runners guiados las usan para
// direccionar ese root y armar el env limpio por-usuario.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const USERS_ROOT = path.join(config.home, '.cwc-users');
// El usuario HOST (el admin que corre el server hoy) mapea a su HOME real:
// retrocompat total — sus creds/datos/config se quedan donde están, cero
// reubicación. Solo los usuarios NUEVOS obtienen un root aislado. Se puede
// override con CWC_HOST_USER; por defecto = el usuario del SO que corre el server.
const HOST_USER = process.env.CWC_HOST_USER || os.userInfo().username;
const USER_ID_RE = /^[a-zA-Z0-9_.-]{1,32}$/;
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'NODE_EXTRA_CA_CERTS'];

// Valida el userId contra traversal y nombres fuera del contrato multi-tenant.
export function sanitizeUserId(userId) {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    throw new Error(`userId inválido: ${userId}`);
  }
  return userId;
}

// Nombre del usuario host (dueño de la máquina). Sus runners heredan el
// entorno completo; los inquilinos arrancan aislados.
export function hostUser() {
  return HOST_USER;
}

// Root privado del usuario dentro del HOME del server.
export function userSpace(userId) {
  const id = sanitizeUserId(userId);
  if (id === HOST_USER) return config.home; // host: su home real (retrocompat)
  return path.join(USERS_ROOT, id);
}

// Credencial Codex por-usuario: para el HOST userSpace(host) === config.home y
// conserva ~/.codex/auth.json; para un inquilino apunta dentro de su root aislado.
export function userCodexDir(userId) {
  return path.join(userSpace(userId), '.codex');
}

export function userCodexAuthPath(userId) {
  return path.join(userCodexDir(userId), 'auth.json');
}

// Chequeo best-effort: un userId inválido o cualquier error de FS equivale a no tener credencial.
export function hasCodexCreds(userId) {
  try {
    return fs.existsSync(userCodexAuthPath(userId));
  } catch {
    return false;
  }
}

// El CLI de Infisical guarda su sesión en
// ~/.infisical/infisical-config.json; alcanza con detectar ese archivo dentro
// del espacio del usuario.
export function userInfisicalDir(userId) {
  return path.join(userSpace(userId), '.infisical');
}

export function userInfisicalConfigPath(userId) {
  return path.join(userInfisicalDir(userId), 'infisical-config.json');
}

export function hasInfisicalCreds(userId) {
  try {
    return fs.existsSync(userInfisicalConfigPath(userId));
  } catch {
    return false;
  }
}

// Directorio de datos persistentes de la consola para ese usuario.
export function userDataDir(userId) {
  return path.join(userSpace(userId), '.cwc-data');
}

// Workspace principal del usuario.
export function userWorkspace(userId) {
  return path.join(userSpace(userId), 'workspace');
}

// Root de ACCESO A ARCHIVOS del usuario (cwd de chats, explorador). El host ve
// su home completo (retrocompat); el inquilino queda confinado a su workspace
// (NO a su userSpace entero — ahí viven .claude/.cwc-data con sus secretos).
export function userFileRoot(userId) {
  const id = sanitizeUserId(userId);
  if (id === HOST_USER) return config.home;  // host: home completo (retrocompat)
  return userWorkspace(id);                   // inquilino: solo su workspace
}

// HOME de Claude Code para ese usuario.
export function userClaudeDir(userId) {
  return path.join(userSpace(userId), '.claude');
}

// Ruta del CLAUDE.md GLOBAL per-user (comportamiento de la IA: comunicación
// visual, Relato Anclado, la pelota...). Host -> ~/.claude/CLAUDE.md real;
// inquilino -> ~/.cwc-users/<u>/.claude/CLAUDE.md. Confinado por userId saneado.
export function userGlobalClaudePath(userId) {
  return path.join(userClaudeDir(userId), 'CLAUDE.md');
}

// Ruta del OAuth token del usuario (lo deja el onboarding con `claude setup-token`).
// El runner del inquilino lo inyecta como CLAUDE_CODE_OAUTH_TOKEN al arrancar.
export function userOauthTokenPath(userId) {
  return path.join(userClaudeDir(userId), 'oauth-token');
}

// Lee el OAuth token del inquilino (trim), o null si no hay (best-effort).
export function readUserOauthToken(userId) {
  try {
    const t = fs.readFileSync(userOauthTokenPath(userId), 'utf8').trim();
    return t || null;
  } catch { return null; }
}

// BUG-2104: sin esta clave, el CLI interactivo del inquilino muestra el
// onboarding/login aunque tenga CLAUDE_CODE_OAUTH_TOKEN. Es siempre un merge:
// jamás reemplaza el resto del estado real guardado en .claude.json.
export function ensureCliOnboarded(userId) {
  let tempPath;
  try {
    const id = sanitizeUserId(userId);
    if (id === HOST_USER) return false;
    const target = path.join(userSpace(id), '.claude.json');
    let state;
    try {
      state = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') return false;
      state = {};
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (state.hasCompletedOnboarding === true) return false;

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify({ ...state, hasCompletedOnboarding: true }, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, target);
    tempPath = null;
    return true;
  } catch (e) {
    if (tempPath && e?.code !== 'EEXIST') {
      try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
    }
    return false;
  }
}

// Token per-dev del MCP hosteado de Tolkien; gemelo del oauth-token del usuario.
export function userTolkienMcpTokenPath(userId) {
  return path.join(userClaudeDir(userId), 'tolkien-mcp-token');
}

export function readUserTolkienMcpToken(userId) {
  try {
    const t = fs.readFileSync(userTolkienMcpTokenPath(userId), 'utf8').trim();
    return t || null;
  } catch { return null; }
}

export function hasTolkienMcpToken(userId) {
  try {
    return fs.existsSync(userTolkienMcpTokenPath(userId));
  } catch {
    return false;
  }
}

// Crea idempotentemente la estructura privada mínima del usuario.
export function ensureUserSpace(userId) {
  const id = sanitizeUserId(userId);
  if (id === HOST_USER) return config.home; // host: su home ya está armado, no crear nada
  const root = userSpace(id);
  const workspace = userWorkspace(id);
  const dirs = [
    root,
    userDataDir(id),
    workspace,
    path.join(workspace, 'mi-espacio'),
    userClaudeDir(id),
    userPadDir(id),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  return root;
}

// Arma un env fail-closed por allowlist; decidir exigir token es del caller.
export function userRunnerEnv(userId, { oauthToken } = {}) {
  const env = {};

  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  env.HOME = userSpace(userId);
  env.CWC_DATA_DIR = userDataDir(userId);
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

  return env;
}

// ─── Pad per-usuario (B2 multi-tenant, ver DOC-633) ───
// El inquilino tiene su propia cuenta+workspace Pad; su token padsess_ vive
// aislado en su espacio, igual que su .claude. La consola lee/escribe acá.

// Directorio .pad del usuario (credenciales del Pad local).
export function userPadDir(userId) {
  return path.join(userSpace(userId), '.pad');
}

// Ruta del credentials.json del Pad del usuario (shape del CLI de Pad:
// { credentials: { [serverUrl]: { token } } }).
export function userPadCredsPath(userId) {
  return path.join(userPadDir(userId), 'credentials.json');
}

// Slug del workspace Pad propio del inquilino.
export function userPadWorkspace(userId) {
  return 'tenant-' + sanitizeUserId(userId);
}

// Lee el token padsess_ del Pad del usuario para un serverUrl dado (best-effort → null).
export function readUserPadToken(userId, serverUrl) {
  try {
    const raw = JSON.parse(fs.readFileSync(userPadCredsPath(userId), 'utf8'));
    return raw?.credentials?.[serverUrl]?.token || null;
  } catch { return null; }
}

// Escribe/mergea el token padsess_ del Pad del usuario para un serverUrl (mode 600).
// Preserva otras entradas de credentials si el archivo ya existe.
export function writeUserPadToken(userId, serverUrl, token) {
  const p = userPadCredsPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  let data = { credentials: {} };
  try {
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cur && typeof cur === 'object') { data = cur; data.credentials = data.credentials || {}; }
  } catch { /* inexistente o corrupto: arrancamos limpio */ }
  data.credentials[serverUrl] = { ...(data.credentials[serverUrl] || {}), token };
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
  return p;
}
