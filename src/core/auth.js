// core/auth.js — autenticación: token maestro + sesiones de usuario.
//
// La red ZeroTier controla QUIÉN llega; esta capa controla QUIÉN entra.
// Dos credenciales válidas (cookie/header en HTTP y en el handshake WS):
//   1) Sesión de usuario  -> cookie cwc_session (login con usuario+contraseña).
//   2) Token maestro       -> cookie cwc_token / header x-cwc-token / Bearer.
//      El token da acceso ADMIN (emergencia y bootstrap del primer usuario).
import { parseCookie } from 'cookie';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write.js';
import { config } from './config.js';
import { adminFor, oversightFor } from './users.js';

const COOKIE_NAME = 'cwc_token';      // token maestro
const SESSION_COOKIE = 'cwc_session'; // sesión de usuario

// --- Sesiones de usuario (persistentes a reinicios del server) ---
// Se guardan en sessions.json (permisos 600) para no obligar a re-login tras
// un reinicio. Cada sesión tiene expiración; las vencidas se descartan.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.join(__dirname, '..', '..', 'sessions.json');
const TTL_MS = config.sessionDays * 86400000;

const sessions = new Map(); // sessionId -> { username, admin, created, expires }

function persistSessions() {
  const data = { sessions: [...sessions.entries()].map(([id, s]) => ({ id, ...s })) };
  try {
    writeJsonAtomic(SESSIONS_FILE, data, { mode: 0o600 });
    fs.chmodSync(SESSIONS_FILE, 0o600);
  } catch (err) {
    // La sesión sigue viva en RAM (el login no debe fallar por esto), pero el
    // fallo tiene que VERSE: sin persistencia, un reinicio desloguea a todos.
    console.error('[auth] no se pudo persistir sessions.json:', err?.message || err);
  }
}

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const s of raw.sessions || []) {
      if (s.id && s.expires > now) {
        sessions.set(s.id, { username: s.username, admin: !!s.admin, created: s.created, expires: s.expires });
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error('[auth] no se pudo leer sessions.json:', err?.message || err);
  }
}

export function createSession({ username, admin }) {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { username, admin: !!admin, created: now, expires: now + TTL_MS });
  persistSessions();
  return id;
}
export function destroySession(id) {
  if (id && sessions.delete(id)) persistSessions();
}

// Revoca TODAS las sesiones activas de un usuario (borrado o democión de rol):
// sin esto, una cookie viva seguiría operando con los privilegios viejos hasta
// vencer. Devuelve cuántas sesiones se eliminaron.
export function invalidateSessionsForUser(username) {
  if (!username) return 0;
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s.username === username) {
      sessions.delete(id);
      removed++;
    }
  }
  if (removed) persistSessions();
  return removed;
}

// Comparación en tiempo constante para evitar timing attacks.
function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Extrae el token maestro de una request HTTP: cookie, header x-cwc-token, o Bearer.
function extractToken(req) {
  const cookies = parseCookie(req.headers.cookie || '');
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  if (req.headers['x-cwc-token']) return req.headers['x-cwc-token'];
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// Devuelve el id de sesión de usuario presente en la cookie (o null).
export function sessionIdOf(req) {
  const cookies = parseCookie(req.headers.cookie || '');
  return cookies[SESSION_COOKIE] || null;
}

// Resuelve el "principal" de la request: usuario, token o null.
// { type: 'user'|'token', username: string|null, admin: boolean, oversight: boolean }
export function principalOf(req) {
  const sid = sessionIdOf(req);
  if (sid && sessions.has(sid)) {
    const s = sessions.get(sid);
    if (s.expires > Date.now()) {
      // `admin` y `oversight` se resuelven EN VIVO contra el registro de
      // usuarios: promover o degradar surte efecto en el request siguiente,
      // sin re-login ni revocar la cookie. El `admin` guardado en la sesión
      // queda solo como rastro histórico y ya no autoriza nada.
      return { type: 'user', username: s.username, admin: adminFor(s.username), oversight: oversightFor(s.username) };
    }
    sessions.delete(sid); // sesión vencida: la descartamos
    persistSessions();
  }
  if (tokenMatches(extractToken(req))) {
    return { type: 'token', username: null, admin: true, oversight: true };
  }
  return null;
}

export function isAuthenticated(req) {
  return principalOf(req) != null;
}

export function isAdmin(req) {
  const p = principalOf(req);
  return !!p && p.admin;
}

// Middleware Express: protege rutas de API.
export function httpAuthMiddleware(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'No autorizado.' });
}

loadSessions();

export { COOKIE_NAME, SESSION_COOKIE, tokenMatches };
