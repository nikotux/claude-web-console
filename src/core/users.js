// core/users.js — almacén de usuarios con contraseñas hasheadas (scrypt).
//
// Persistimos en users.json (permisos 600) junto al proyecto. Es la mínima
// desviación del "sin base de datos" del brief: un archivo para que los
// usuarios sobrevivan al reinicio. El CWC_TOKEN del .env sigue siendo la
// LLAVE MAESTRA (acceso admin de emergencia y bootstrap del primer usuario).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostUser } from './user-space.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, '..', '..', 'users.json');

const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,32}$/;
// Mínimo endurecido (antes 4): la consola expone terminal/archivos/chat con
// permisos reales, incluso para cuentas admin. Solo aplica a contraseñas
// NUEVAS (crear usuario / cambiar contraseña); las existentes siguen válidas.
const MIN_PASSWORD = 10;

let users = new Map(); // username -> { username, hash, admin, oversight, lang?, tier?, sponsor? }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${dk}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, dk] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !dk) return false;
  const cand = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(dk, 'hex');
  return cand.length === known.length && crypto.timingSafeEqual(cand, known);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    users = new Map((raw.users || []).map((u) => [u.username, { ...u, oversight: !!u.oversight }]));
  } catch {
    users = new Map(); // sin archivo aún: arranca vacío
  }
}

function persist() {
  const data = { users: [...users.values()] };
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(USERS_FILE, 0o600); } catch { /* noop */ }
}

export function isValidUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

export function userCount() {
  return users.size;
}

export function oversightFor(username) {
  if (!username || username === hostUser()) return true;
  const u = users.get(username);
  return u ? !!u.oversight : false;
}

// `admin` se resuelve EN VIVO (igual que oversightFor) para que promover o
// degradar a alguien surta efecto en el request siguiente, sin re-login.
// Fail-closed: un username desconocido (cuenta borrada, sesión huérfana) NO
// es admin. El token maestro NO pasa por acá: su admin lo fija auth.js.
export function adminFor(username) {
  if (!username) return false;
  const u = users.get(username);
  return u ? !!u.admin : false;
}

export function sponsorshipState(username) {
  const u = users.get(username);
  if (u?.tier !== 'sponsored') return 'none';
  return typeof u.sponsor === 'string' && u.sponsor.trim()
    ? 'sponsored'
    : 'awaiting-sponsor';
}

export function getUserTier(username) {
  // Este contrato representa el tier operativo: un perfil en espera todavía
  // es `standard` acá porque solo un patrocinio completo habilita consumidores.
  // sponsorshipState() conserva la distinción del perfil persistido.
  return sponsorshipState(username) === 'sponsored' ? 'sponsored' : 'standard';
}

export function sponsorOf(username) {
  return getUserTier(username) === 'sponsored' ? users.get(username).sponsor : null;
}

export function listUsers() {
  return [...users.values()]
    .map((u) => ({
      username: u.username,
      admin: !!u.admin,
      oversight: oversightFor(u.username),
      tier: getUserTier(u.username),
      sponsor: sponsorOf(u.username),
      sponsorshipState: sponsorshipState(u.username),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// Crea un usuario. Lanza Error con mensaje claro si algo no valida.
function badRequest(message) {
  const e = new Error(message);
  e.badRequest = true;
  return e;
}

export function createUser(username, password, admin = false) {
  if (!isValidUsername(username)) throw badRequest('Usuario inválido (letras, números, . _ - ; máx 32).');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw badRequest(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  if (users.has(username)) throw badRequest('Ese usuario ya existe.');
  users.set(username, { username, hash: hashPassword(password), admin: !!admin });
  persist();
}

export function setPassword(username, password) {
  const u = users.get(username);
  if (!u) throw badRequest('Usuario inexistente.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw badRequest(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  u.hash = hashPassword(password);
  persist();
}

export function setAdmin(username, admin) {
  const u = users.get(username);
  if (!u) throw badRequest('Usuario inexistente.');
  u.admin = !!admin;
  persist();
}

export function setOversight(username, value) {
  const u = users.get(username);
  if (!u) throw badRequest('Usuario inexistente.');
  u.oversight = !!value;
  persist();
}

export function setAwaitingSponsor(username) {
  const u = users.get(username);
  if (!u) throw badRequest('Usuario inexistente.');
  u.tier = 'sponsored';
  delete u.sponsor;
  persist();
}

export function setUserSponsor(username, sponsor) {
  const u = users.get(username);
  if (!u) throw badRequest('Usuario inexistente.');

  if (sponsor === null || sponsor === '') {
    delete u.tier;
    delete u.sponsor;
    persist();
    return;
  }
  if (typeof sponsor !== 'string') throw badRequest('Sponsor inválido.');

  const sponsorUser = users.get(sponsor);
  if (!sponsorUser) throw badRequest('Sponsor inexistente.');
  if (sponsor === username) throw badRequest('Un usuario no puede patrocinarse a sí mismo.');
  // Un perfil patrocinado normalmente no tiene credencial propia que prestar,
  // así que la cadena ya fallaría al resolver el token. La prohibimos igual
  // como defensa en profundidad y para devolver un error claro desde el alta.
  if (sponsorshipState(sponsor) !== 'none') {
    throw badRequest('Un usuario patrocinado no puede patrocinar a otro usuario.');
  }

  u.tier = 'sponsored';
  u.sponsor = sponsor;
  persist();
}

// Idioma de interfaz (PLAN i18n, 2026-07-19): preferencia PERSONAL, self-service
// (no admin-gated) — cada usuario elige el suyo. Default 'es' si nunca lo tocó.
const VALID_LANGS = ['es', 'en'];

export function getUserLang(username) {
  return users.get(username)?.lang === 'en' ? 'en' : 'es';
}

export function setUserLang(username, lang) {
  const u = users.get(username);
  if (!u) throw badRequest('Usuario inexistente.');
  if (!VALID_LANGS.includes(lang)) throw badRequest('Idioma inválido.');
  u.lang = lang;
  persist();
}

export function deleteUser(username) {
  if (!users.delete(username)) throw badRequest('Usuario inexistente.');
  persist();
}

// Hash señuelo para usuarios inexistentes: igualar el costo (scrypt) entre
// "usuario no existe" y "contraseña incorrecta" evita enumerar usuarios por
// timing en /login (mismo cuidado que tokenMatches en auth.js).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// Verifica credenciales. Devuelve { username, admin } o null.
export function verifyUser(username, password) {
  const u = users.get(username);
  if (!u) {
    // Mismo trabajo que con un usuario real antes de rechazar (anti-timing).
    // String() defensivo: con u real un password no-string ya lanzaba igual.
    verifyPassword(String(password ?? ''), DUMMY_HASH);
    return null;
  }
  return verifyPassword(password, u.hash) ? { username: u.username, admin: !!u.admin } : null;
}

load();
