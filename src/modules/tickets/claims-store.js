// modules/tickets/claims-store.js — "quién está trabajando cada TKT" (pedido Niko
// 2026-07-07). Es estado NUESTRO (no de Zoho), así que vive en su propia tabla
// persistente `~/.cwc-data/ticket-claims.json` (misma carpeta de datos que el
// snapshot, tabla aparte a propósito): así una pasada de Zoho no lo pisa y las
// escrituras concurrentes no se pierden. El campo `workingBy` se SUPERPONE sobre
// cada ticket al servir (overlay) — el frontend lo ve como un campo del ticket.
//
// Hard lock (aprobado): si un TKT lo tiene OTRO usuario (no expirado), no se puede
// tomar/trabajar; solo el dueño lo suelta, un admin lo fuerza, o expira por TTL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.cwc-data', 'ticket-claims.json');
const TTL_MS = 8 * 3600_000; // 8h — auto-liberación de un claim olvidado

let claims = null; // { [id]: { by, label, at } }

function load() {
  if (claims) return claims;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    claims = raw && typeof raw === 'object' ? raw : {};
  } catch { claims = {}; }
  return claims;
}
function persist() {
  try {
    // Poda de vencidos (BUG-37): expired() los ocultaba al leer, pero sin barrido
    // quedaban en disco para siempre. Cada persist (claim/release) limpia los que
    // ya vencieron — hygiene barata, acotada al nº de tickets.
    for (const k of Object.keys(claims || {})) if (expired(claims[k])) delete claims[k];
    fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(claims), { mode: 0o600 });
    fs.renameSync(tmp, FILE); // rename = escritura atómica (no deja archivo a medias)
  } catch (err) { console.error('[tickets] no pude persistir ticket-claims:', err?.message); }
}
function expired(c) { return !c || !c.at || (Date.now() - c.at) > TTL_MS; }
function actorId(actor) { return actor?.username || (actor?.type === 'token' ? 'token-maestro' : 'desconocido'); }

// Claim activo de un TKT (null si no hay o si expiró por TTL). El TTL se evalúa
// al leer, así un claim vencido "desaparece" solo sin barrido.
export function getActiveClaim(id) {
  const c = load()[String(id)];
  return expired(c) ? null : { by: c.by, label: c.label || c.by, at: c.at };
}

// Overlay: devuelve una copia del item con `workingBy` seteado (o null).
export function withClaim(item, idField = 'ticketNumber') {
  if (!item || item[idField] == null) return item;
  return { ...item, workingBy: getActiveClaim(item[idField]) };
}

// Tomar. Hard lock: si lo tiene OTRO (no expirado) y no se fuerza → {ok:false,heldBy}.
// force solo lo pasa un admin (verificado en la ruta).
export function claim(id, actor, { force = false } = {}) {
  const store = load();
  const key = String(id);
  const cur = expired(store[key]) ? null : store[key];
  const by = actorId(actor);
  if (cur && cur.by !== by && !force) return { ok: false, heldBy: getActiveClaim(key) };
  store[key] = { by, label: actor?.label || by, at: Date.now() };
  persist();
  return { ok: true, claim: getActiveClaim(key) };
}

// Soltar. Solo el dueño o un admin (el admin puede forzar la liberación de cualquiera).
export function release(id, actor) {
  const store = load();
  const key = String(id);
  const cur = store[key];
  if (!cur) return { ok: true, claim: null };
  const by = actorId(actor);
  if (cur.by !== by && !actor?.admin) return { ok: false, heldBy: getActiveClaim(key) };
  delete store[key];
  persist();
  return { ok: true, claim: null };
}
