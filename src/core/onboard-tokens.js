// core/onboard-tokens.js — store de tokens de INVITACIÓN de un solo uso para el
// auto-registro multi-tenant (SP7). El admin genera un token (crypto random,
// inadivinable) y se lo pasa a la persona nueva; ésta lo usa para auto-registrarse
// y configurar sus credenciales. Al COMPLETAR el onboarding el token se consume
// atómicamente (no reusable). Se persiste HASHEADO (sha256): una fuga del JSON no
// expone tokens usables. El token CRUDO se devuelve una única vez, al generarlo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';

const FILE = path.join(config.home, '.cwc-data', 'onboard-tokens.json');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const GC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // consumidos/revocados: se podan tras 7 días

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data && Array.isArray(data.invites)) return data;
  } catch { /* inexistente o corrupto */ }
  return { invites: [] };
}

// Poda: consumidos/revocados viejos (>7 días) y pending vencidos hace rato.
function gc(data) {
  const cutoff = Date.now() - GC_RETENTION_MS;
  data.invites = data.invites.filter((i) => {
    if ((i.status === 'consumed' || i.status === 'revoked') && (i.consumedAt || i.createdAt || 0) < cutoff) return false;
    if (i.status === 'pending' && i.expiresAt < cutoff) return false; // pending vencido hace >7d
    return true;
  });
  return data;
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  writeJsonAtomic(FILE, data);
}

// Genera una invitación. Devuelve el token CRUDO una única vez (no se re-muestra).
export function generateInvite({ admin = false, sponsored = false, createdBy = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (admin && sponsored) throw new Error('Una invitación no puede ser admin y patrocinada a la vez.');
  const token = crypto.randomBytes(24).toString('base64url'); // ~32 chars, inadivinable
  const data = gc(load());
  const rec = {
    id: 'inv-' + crypto.randomBytes(4).toString('hex'),
    tokenHash: hashToken(token),
    admin: !!admin,
    sponsored: !!sponsored,
    createdBy: createdBy || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS),
    status: 'pending',
    lockedTo: null,
    consumedAt: null,
  };
  data.invites.push(rec);
  save(data);
  return { id: rec.id, token, admin: rec.admin, sponsored: rec.sponsored, expiresAt: rec.expiresAt };
}

function findRec(data, token) {
  const h = hashToken(token);
  return data.invites.find((i) => i.tokenHash === h) || null;
}

// Valida un token presentado. `forUsername` (opcional): si el token ya está
// 'locked' a otro username, lo rechaza (evita que dos personas usen el mismo).
export function validateInvite(token, { forUsername = null } = {}) {
  if (!token) return { valid: false, reason: 'sin token' };
  const rec = findRec(load(), token);
  if (!rec) return { valid: false, reason: 'inexistente' };
  if (rec.status === 'consumed') return { valid: false, reason: 'ya usado' };
  if (rec.status === 'revoked') return { valid: false, reason: 'revocado' };
  if (rec.expiresAt < Date.now()) return { valid: false, reason: 'expirado' };
  if (rec.status === 'locked' && forUsername && rec.lockedTo !== forUsername) {
    return { valid: false, reason: 'en uso por otro registro' };
  }
  return { valid: true, admin: !!rec.admin, sponsored: !!rec.sponsored, status: rec.status, lockedTo: rec.lockedTo, id: rec.id };
}

// Lectura LENIENTE por token (para el endpoint de status del onboarding): devuelve
// metadata aunque esté consumido/expirado. El token es el gate: sin él, found:false.
export function peekInvite(token) {
  if (!token) return { found: false };
  const rec = findRec(load(), token);
  if (!rec) return { found: false };
  return { found: true, status: rec.status, lockedTo: rec.lockedTo, admin: !!rec.admin, sponsored: !!rec.sponsored, id: rec.id };
}

// LOCK: al auto-registrarse, se ata el token al username (aún NO consumido, para
// permitir reintentar el paso de credenciales). Devuelve true si quedó lockeado.
export function lockInvite(token, username) {
  const data = load();
  const rec = findRec(data, token);
  if (!rec || rec.status === 'consumed' || rec.status === 'revoked' || rec.expiresAt < Date.now()) return false;
  if (rec.status === 'locked' && rec.lockedTo !== username) return false; // ya tomado por otro
  rec.status = 'locked';
  rec.lockedTo = username || rec.lockedTo;
  save(data);
  return true;
}

// CONSUME: al completar el onboarding OK. Atómico-por-escritura. Idempotente-seguro:
// devuelve false si ya estaba consumido.
export function consumeInvite(token) {
  const data = load();
  const rec = findRec(data, token);
  if (!rec || rec.status === 'consumed') return false;
  rec.status = 'consumed';
  rec.consumedAt = Date.now();
  save(data);
  return true;
}

// REVOKE por id (admin). Devuelve true si existía y no estaba consumido.
export function revokeInvite(id) {
  const data = load();
  const rec = data.invites.find((i) => i.id === id);
  if (!rec || rec.status === 'consumed') return false;
  rec.status = 'revoked';
  save(data);
  return true;
}

// Lista para el admin — NUNCA expone el tokenHash ni el token (solo metadata).
export function listInvites() {
  return gc(load()).invites
    .map((i) => ({ id: i.id, admin: !!i.admin, sponsored: !!i.sponsored, createdBy: i.createdBy, createdAt: i.createdAt, expiresAt: i.expiresAt, status: i.status, lockedTo: i.lockedTo, consumedAt: i.consumedAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
