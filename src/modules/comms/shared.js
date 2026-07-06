// modules/comms/shared.js — MOTOR de Comunicaciones: lo COMPARTIDO entre el
// módulo server (index.js), el runner desacoplado (bin/cwc-comms-runner.js) y
// el CLI transversal (bin/cwc-comms.js).
//
// Es un motor FILE-BASED al estilo del Interfono (src/core/bus.js): TODO el
// estado vive en archivos en ~/.cwc-data/comms/ — 0 tokens, sobrevive a
// reinicios del server por construcción (regla 2/regla de oro), y cualquier
// sesión de Claude Code puede alimentarlo/consultarlo por el CLI sin depender
// del proceso del server. El eje primario es el CONTACTO/usuario (Chris es el
// primero — seed): a futuro escala a muchos usuarios sumando entradas, cero
// código.
//
// Fuentes de comunicación:
//   - github.json : lo escribe el runner (reviews/comentarios de gh, 0 tokens).
//   - manual.json : lo escribe el CLI o la web (comunicaciones registradas a mano).
//   - overrides.json: reasignación de proyecto / visto / archivado por hilo.
// buildIndex() los MERGEA determinísticamente en la vista que consume la UI.
import crypto from 'node:crypto';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const COMMS_DIR = path.join(DATA_DIR, 'comms');
export const CONTACTS_FILE = path.join(COMMS_DIR, 'contacts.json');
export const PROJECTS_FILE = path.join(COMMS_DIR, 'projects.json');
export const GITHUB_FILE = path.join(COMMS_DIR, 'github.json');   // lo escribe el runner
export const GH_CACHE_FILE = path.join(COMMS_DIR, 'gh-cache.json'); // caché incremental por PR
export const TEAMS_FILE = path.join(COMMS_DIR, 'teams.json');     // lo escribe el runner de Teams
export const CHATBOT_FILE = path.join(COMMS_DIR, 'chatbot.json'); // Chris vía el bot Tolkien (TheEye) en Teams
export const MANUAL_FILE = path.join(COMMS_DIR, 'manual.json');   // lo escribe CLI/web
export const OVERRIDES_FILE = path.join(COMMS_DIR, 'overrides.json');
export const SELF_FILE = path.join(COMMS_DIR, 'self.json');       // identidad del dueño (yo)
export const OUTBOX_FILE = path.join(COMMS_DIR, 'outbox.json');   // ledger de TODO envío ejecutado por el gateway
export const LOCK_FILE = path.join(COMMS_DIR, 'comms.lock');
export const LOG_FILE = path.join(COMMS_DIR, 'comms.log');

export const HEARTBEAT_MS = 3000;
export const LOCK_FRESH_MS = 12000;
export const PR_SCAN_LIMIT = 40;   // PRs a listar por corrida
export const PR_DETAIL_CAP = 30;   // PRs a los que pedimos detalle (reviews/comments)

// ===== IO base =====
export function ensureDir() {
  try { fss.mkdirSync(COMMS_DIR, { recursive: true, mode: 0o700 }); } catch { /* noop */ }
}
function readJson(file, fallback) {
  try { return JSON.parse(fss.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  for (let i = 0; i < 2; i += 1) {
    try { ensureDir(); fss.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); return true; }
    catch (err) { if (i === 1) console.error('[comms] no se pudo escribir', file, err?.message); }
  }
  return false;
}

let _seq = 0;
// ID sin Math.random (patrón del proyecto: determinístico y ordenable).
export function newId(prefix) {
  _seq += 1;
  return `${prefix}${process.pid.toString(36)}${Date.now().toString(36)}${_seq.toString(36)}`;
}
export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}
function uniqueId(base, taken) {
  let id = base; let n = 1;
  while (taken.includes(id)) { n += 1; id = `${base}-${n}`; }
  return id;
}

// ===== Contactos (usuarios). Chris es el primero (seed). =====
export const DEFAULT_CONTACTS = [
  { id: 'chris', name: 'Chris', github: 'cswenor', createdAt: 0 },
];
export function readContacts() {
  const o = readJson(CONTACTS_FILE, null);
  const arr = o && Array.isArray(o.contacts) ? o.contacts : null;
  return (arr && arr.length) ? arr : DEFAULT_CONTACTS.map((c) => ({ ...c }));
}
export function writeContacts(contacts) { return writeJson(CONTACTS_FILE, { contacts }); }
// Escribe el seed a disco SOLO si el archivo no existe (idempotente).
export function ensureSeed() {
  ensureDir();
  if (!fss.existsSync(CONTACTS_FILE)) writeContacts(DEFAULT_CONTACTS.map((c) => ({ ...c })));
  if (!fss.existsSync(SELF_FILE)) writeSelf(DEFAULT_SELF);
}
export function addContact({ name, github, email }) {
  const contacts = readContacts();
  const gh = String(github || '').replace(/^@/, '').trim().slice(0, 60) || null;
  const em = String(email || '').trim().slice(0, 120) || null;
  const id = uniqueId(slug(name || gh || em), contacts.map((c) => c.id));
  const c = { id, name: String(name || gh || em || id).slice(0, 60), github: gh, email: em, createdAt: Date.now() };
  contacts.push(c);
  writeContacts(contacts);
  return c;
}
export function contactName(contacts, id) {
  return contacts.find((c) => c.id === id)?.name || id;
}

// ===== Identidad propia (YO): ancla para atribuir "conversación conmigo" =====
// Sin esto el motor no sabe quién sos y podría indexar un DM de un contacto con
// OTRA persona. Se siembra con tus datos; editable por archivo si cambia.
export const DEFAULT_SELF = { name: 'Nicolás Mosquera', email: 'nmosquera@mordorstaffing.com', github: 'nmosqueramordor' };
export function readSelf() {
  const o = readJson(SELF_FILE, null);
  return (o && typeof o === 'object') ? { ...DEFAULT_SELF, ...o } : { ...DEFAULT_SELF };
}
export function writeSelf(self) { return writeJson(SELF_FILE, { ...DEFAULT_SELF, ...self }); }

// ===== Outbox: ledger append-only de TODA comunicación EJECUTADA por el
// gateway (auditoría central: canal, acción, destino, texto, resultado). Es la
// prueba de "comms administra y ejecuta todo lo saliente". Independiente del
// modelo de hilos: acá cae también lo que va a clientes (Desk), no solo a un
// contacto del tablero.
export function readOutbox() { const o = readJson(OUTBOX_FILE, null); return (o && Array.isArray(o.entries)) ? o.entries : []; }
export function appendOutbox(entry) {
  const entries = readOutbox();
  const e = {
    id: entry.id || newId('o'),
    channel: String(entry.channel || '').slice(0, 20),      // github | desk | teams
    action: String(entry.action || '').slice(0, 40),
    to: String(entry.to || '').slice(0, 120),               // a quién (login/email/ticket)
    ref: entry.ref ? String(entry.ref).slice(0, 60) : null, // PR #, ticket #, chatId
    contactId: entry.contactId || null,
    text: String(entry.text || '').slice(0, 4000),
    actor: String(entry.actor || 'system').slice(0, 40),    // qué motor/sesión lo pidió
    ok: entry.ok !== false,
    error: entry.error ? String(entry.error).slice(0, 300) : null,
    dryRun: !!entry.dryRun,
    ts: entry.ts || Date.now(),
  };
  entries.push(e);
  // Poda blanda: conservar los últimos 500 (auditoría, no archivo histórico infinito).
  const trimmed = entries.slice(-500);
  writeJson(OUTBOX_FILE, { entries: trimmed });
  return e;
}


// ===== Proyectos definidos por el usuario =====
export function readProjects() {
  const o = readJson(PROJECTS_FILE, null);
  return (o && Array.isArray(o.projects)) ? o.projects : [];
}
export function writeProjects(projects) { return writeJson(PROJECTS_FILE, { projects }); }
export function addProject({ name }) {
  const projects = readProjects();
  const id = uniqueId(slug(name), projects.map((p) => p.id));
  const p = { id, name: String(name || id).slice(0, 60), createdAt: Date.now() };
  projects.push(p);
  writeProjects(projects);
  return p;
}

// ===== GitHub (lo escribe el runner) =====
export function readGithub() { return readJson(GITHUB_FILE, { threads: [], scannedAt: null, error: null }); }
export function writeGithub(data) { return writeJson(GITHUB_FILE, data); }
export function readGhCache() { const o = readJson(GH_CACHE_FILE, null); return (o && typeof o === 'object') ? o : {}; }
export function writeGhCache(c) { return writeJson(GH_CACHE_FILE, c); }

// ===== Teams (lo escribe el runner de Teams, consume tokens) =====
export function readTeams() { return readJson(TEAMS_FILE, { threads: [], scannedAt: null, error: null }); }
export function writeTeams(data) { return writeJson(TEAMS_FILE, data); }

// ===== Chatbot (comunicaciones de Chris relayadas por el bot Tolkien/TheEye en
// Teams). Un mensaje del bot puede ser en realidad Chris hablando ("disfrazado
// de Tolkien"). Hoy se seedea/registra a mano; a futuro lo escribirá el escáner
// de Graph con source:'chatbot'. Mismo shape que teams.json. =====
export function readChatbot() { return readJson(CHATBOT_FILE, { threads: [], scannedAt: null, error: null }); }
export function writeChatbot(data) { return writeJson(CHATBOT_FILE, data); }

// ===== Manual (lo escribe el CLI / la web) =====
export function readManual() { const o = readJson(MANUAL_FILE, null); return (o && Array.isArray(o.entries)) ? o.entries : []; }
export function writeManual(entries) { return writeJson(MANUAL_FILE, { entries }); }
export function appendManual(entry) {
  const entries = readManual();
  const e = {
    id: entry.id || newId('m'),
    contactId: entry.contactId || 'chris',
    project: entry.project ? String(entry.project).slice(0, 60) : null,
    title: String(entry.title || entry.text || '').split('\n')[0].slice(0, 120),
    text: String(entry.text || '').slice(0, 4000),
    // 'in' = lo dijo el contacto; 'out' = lo dije yo/el equipo.
    direction: entry.direction === 'in' ? 'in' : 'out',
    url: /^https?:\/\//.test(entry.url || '') ? String(entry.url).slice(0, 400) : null,
    channel: String(entry.channel || 'manual').slice(0, 24),
    ts: entry.ts || Date.now(),
  };
  entries.push(e);
  writeManual(entries);
  return e;
}

// ===== Overrides por hilo (proyecto reasignado, visto, archivado) =====
export function readOverrides() { const o = readJson(OVERRIDES_FILE, null); return (o && typeof o === 'object') ? o : {}; }
export function writeOverrides(o) { return writeJson(OVERRIDES_FILE, o); }
export function setOverride(threadId, patch) {
  const o = readOverrides();
  o[threadId] = { ...(o[threadId] || {}), ...patch };
  writeOverrides(o);
  return o[threadId];
}

// ===== Normalización + índice consolidado (determinístico, 0 tokens) =====
function normThread(t) {
  const messages = (t.messages || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const last = messages[messages.length - 1] || null;
  return {
    id: t.id,
    contactId: t.contactId,
    source: t.source,
    project: t.project || null,
    title: String(t.title || '').slice(0, 200),
    url: t.url || null,
    state: t.state || null,
    participants: Array.isArray(t.participants) ? t.participants : null,
    chatId: t.chatId || null,
    messages,
    lastTs: last ? last.ts : (t.lastTs || t.ts || 0),
    lastFromContact: last ? !!last.fromContact : false,
  };
}

// Une github.json + teams.json + chatbot.json + manual.json, aplica overrides y deriva las señales que la
// UI necesita: newFromContact (mensaje nuevo del contacto que aún no vi) y
// awaitingReply (el último mensaje es MÍO ⇒ estoy esperando al contacto).
export function buildIndex() {
  const contacts = readContacts();
  const contactIds = new Set(contacts.map((c) => c.id));
  const projects = readProjects();
  const overrides = readOverrides();
  const gh = readGithub();
  const teams = readTeams();
  const chatbot = readChatbot();
  const manual = readManual();

  const raw = [];
  for (const t of (gh.threads || [])) raw.push(normThread(t));
  for (const t of (teams.threads || [])) raw.push(normThread(t));
  for (const t of (chatbot.threads || [])) raw.push(normThread(t));
  for (const e of manual) {
    raw.push(normThread({
      id: `manual:${e.id}`,
      contactId: e.contactId,
      source: 'manual',
      project: e.project,
      title: e.title,
      url: e.url,
      messages: [{
        author: e.direction === 'in' ? contactName(contacts, e.contactId) : 'Yo',
        ts: e.ts,
        text: e.text,
        url: e.url,
        kind: 'manual',
        channel: e.channel,
        fromContact: e.direction === 'in',
      }],
    }));
  }

  const threads = [];
  for (const t of raw) {
    if (!contactIds.has(t.contactId)) continue; // contacto borrado ⇒ ocultar
    const ov = overrides[t.id] || {};
    const archived = !!ov.archived;
    const seenTs = ov.seenTs || 0;
    const hasMsgs = t.messages.length > 0;
    threads.push({
      ...t,
      project: ov.project || t.project || null,
      archived,
      newFromContact: !archived && hasMsgs && t.lastFromContact && t.lastTs > seenTs,
      awaitingReply: !archived && hasMsgs && !t.lastFromContact,
    });
  }
  threads.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return { threads, contacts, projects, self: readSelf(), scannedAt: gh.scannedAt || null, ghError: gh.error || null };
}

// Estado agregado para el status del panel izquierdo (barato).
export function buildStatus() {
  const { threads, contacts, scannedAt, ghError } = buildIndex();
  let newCount = 0; let awaiting = 0;
  const perContact = {};
  for (const c of contacts) perContact[c.id] = { newFromContact: 0, awaiting: 0, total: 0 };
  for (const t of threads) {
    if (t.archived) continue;
    const pc = perContact[t.contactId] || (perContact[t.contactId] = { newFromContact: 0, awaiting: 0, total: 0 });
    pc.total += 1;
    if (t.newFromContact) { newCount += 1; pc.newFromContact += 1; }
    if (t.awaitingReply) { awaiting += 1; pc.awaiting += 1; }
  }
  return { newCount, awaiting, perContact, contacts, scannedAt, ghError };
}

// ===== Lock de "escaneo corriendo" (heartbeat del runner) =====
export function writeLock(pid) {
  try {
    ensureDir();
    fss.writeFileSync(LOCK_FILE, JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearLock() { try { fss.unlinkSync(LOCK_FILE); } catch { /* noop */ } }
export function readLock() {
  try { return JSON.parse(fss.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}
export function isRunning() {
  const lock = readLock();
  return !!lock && Date.now() - lock.ts < LOCK_FRESH_MS;
}

// Fingerprint de un PR para la caché incremental (número + updatedAt).
export function prFingerprint(pr) {
  return crypto.createHash('sha1').update(`${pr?.number}:${pr?.updatedAt || ''}`).digest('hex').slice(0, 12);
}
