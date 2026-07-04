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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, '..', '..', 'users.json');

const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,32}$/;
// Mínimo endurecido (antes 4): la consola expone terminal/archivos/chat con
// permisos reales, incluso para cuentas admin. Solo aplica a contraseñas
// NUEVAS (crear usuario / cambiar contraseña); las existentes siguen válidas.
const MIN_PASSWORD = 10;

let users = new Map(); // username -> { username, hash, admin }

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
    users = new Map((raw.users || []).map((u) => [u.username, u]));
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

export function listUsers() {
  return [...users.values()]
    .map((u) => ({ username: u.username, admin: !!u.admin }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// Crea un usuario. Lanza Error con mensaje claro si algo no valida.
export function createUser(username, password, admin = false) {
  if (!isValidUsername(username)) throw new Error('Usuario inválido (letras, números, . _ - ; máx 32).');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  if (users.has(username)) throw new Error('Ese usuario ya existe.');
  users.set(username, { username, hash: hashPassword(password), admin: !!admin });
  persist();
}

export function setPassword(username, password) {
  const u = users.get(username);
  if (!u) throw new Error('Usuario inexistente.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  u.hash = hashPassword(password);
  persist();
}

export function setAdmin(username, admin) {
  const u = users.get(username);
  if (!u) throw new Error('Usuario inexistente.');
  u.admin = !!admin;
  persist();
}

export function deleteUser(username) {
  if (!users.delete(username)) throw new Error('Usuario inexistente.');
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
