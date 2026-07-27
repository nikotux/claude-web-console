// core/bus.js — "Interfono" entre sesiones de Claude Code.
//
// Problema que resuelve: varias sesiones de Claude Code (TUIs tmux + chats del
// SDK) corriendo a la vez sobre el MISMO repo pueden pisarse. Hoy la única
// forma de que se "hablen" era que el usuario hiciera de cartero. Este módulo
// es un BUS DE ARCHIVOS (0 tokens, determinístico) con dos capacidades:
//
//   1) MENSAJERÍA  — una sesión deja un mensaje para otra (o broadcast); la
//      destinataria lo recibe inyectado por su hook en el próximo turno.
//   2) CLAIMS      — antes de editar un archivo, una sesión reclama un "claim";
//      si otra sesión VIVA ya lo tiene, se frena y coordina. Los claims de
//      sesiones muertas (zombis) se detectan y roban con red de seguridad.
//
// TODO el estado vive en ~/.cwc-data/session-bus/ (sobrevive reinicios del
// server — regla de oro del proyecto). Nada colgado del proceso Node: las
// sesiones y los hooks invocan este core a través de bin/cwc-bus.js; el módulo
// backend (src/modules/interfono) lo importa para el panel.
//
// Identidad de una sesión = uno o más "handles":
//   - TUI  (tmux): `tmux:<nombre-de-sesión-tmux>`  (estable; emisor y receptor
//                   lo derivan de $TMUX_PANE — ver bin/cwc-bus.js)
//   - chat (SDK):  `claude:<sessionId>`             (id de sesión de Claude)
// Una TUI escucha en AMBOS (su claude sid y su tmux name); un chat solo en el
// claude sid. Así el emisor puede direccionar por nombre de tarjeta (tmux) y el
// receptor igual se reconoce.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { runTmux, tmuxDir } from './tmux.js';
import { loadTitles, titleKey } from './session-names.js';
import { worldLabelFor } from './worlds.js';
// Registro de paquetes-sesión (F2b, session-packages.json) — para direccionar por
// ref estable PKG-N en el interfono (PLAN-469 · 1a). Lee el JSON directo, como
// buildDirectory lee chats.json (sin importar el módulo chat, evita acoplar core).
function readPackages() {
  const db = readJson(path.join(config.home, '.cwc-data', 'session-packages.json'));
  return (db && db.items && typeof db.items === 'object') ? db.items : {};
}

// ===== Rutas y constantes =====
const ROOT = path.join(config.home, '.cwc-data', 'session-bus');
const MSG_DIR = path.join(ROOT, 'messages');
const CLAIM_DIR = path.join(ROOT, 'claims');
const TOMB_DIR = path.join(ROOT, 'tombstones');
const STATE_DIR = path.join(config.home, '.cwc-state'); // observador (cwc-observe.js)

// Umbrales del árbol de decisión de claims (ver evaluateClaim).
export const HOT_MS = 5 * 60 * 1000;      // claim "caliente": editado hace <5min
export const GRAY_MS = 30 * 60 * 1000;    // zona gris: viva pero inactiva <30min
export const OBS_FRESH_MS = 5 * 60 * 1000; // ts del observador considerado fresco
export const MSG_TTL_MS = 6 * 60 * 60 * 1000;   // mensajes viven 6h
export const TOMB_TTL_MS = 24 * 60 * 60 * 1000; // lápidas viven 24h
export const MAX_HOPS = 6; // corta cadenas de respuesta infinitas

function ensureDirs() {
  for (const d of [MSG_DIR, CLAIM_DIR, TOMB_DIR]) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* noop */ }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj)); return true; } catch { return false; }
}
function listJson(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const j = readJson(path.join(dir, n));
    if (j) out.push({ _file: path.join(dir, n), ...j });
  }
  return out;
}

// Id sin depender de Math.random (vetado en algunos contextos del proyecto):
// contador de proceso + pid + tiempo. Único dentro de una corrida y entre
// procesos distintos.
let _seq = 0;
function newId(prefix) {
  _seq += 1;
  return `${prefix}${process.pid.toString(36)}${Date.now().toString(36)}${_seq.toString(36)}`;
}

// Slug estable de una ruta absoluta para nombre de archivo de claim.
function claimFileFor(absPath) {
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  return path.join(CLAIM_DIR, `${hash}.json`);
}

// ===== Observador (estado real trabajando/esperando por sesión de Claude) =====
export function readObserver(claudeSid) {
  if (!claudeSid) return null;
  return readJson(path.join(STATE_DIR, `${claudeSid}.json`));
}

// ===== tmux =====
function cwcSocketPath() {
  return path.join(tmuxDir(), config.tmuxSocket);
}
// ¿Existe una sesión tmux con ese nombre en el socket cwc?
export function tmuxHasSession(name) {
  if (!name) return false;
  const out = runTmux(cwcSocketPath(), ['has-session', '-t', `=${name}`], { throwOnError: false });
  // has-session no imprime nada en éxito y falla (runTmux => '') si no existe.
  // Distinguimos con list para no depender del throw: preguntamos la lista.
  if (out !== '') return true;
  const list = runTmux(cwcSocketPath(), ['list-sessions', '-F', '#{session_name}']);
  return list.split('\n').some((l) => l.trim() === name);
}

// ===== Directorio de sesiones (nombre amigable <-> handle) =====
// Reconstruye, SIN estado del server, el mismo mapa que muestran las tarjetas
// de "Sesiones": TUIs tmux (nombre = título custom || basename del cwd) + chats
// del SDK (de chats.json). Cada entrada trae su handle canónico para ruteo.
export function buildDirectory() {
  const entries = [];
  // --- TUIs tmux del socket cwc ---
  const titles = loadTitles();
  const raw = runTmux(cwcSocketPath(), ['list-sessions', '-F', '#{session_name}\t#{pane_current_path}\t#{pane_pid}']);
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [name, cwd, pid] = line.split('\t');
    if (!name) continue;
    const isBare = name.startsWith('cwct-'); // vistas TUI de conversaciones
    const friendly = titles[titleKey(config.tmuxSocket, name)] || path.basename(cwd || '') || name;
    entries.push({
      handle: `tmux:${name}`,
      name: friendly,
      kind: isBare ? 'tui-chat' : 'tui',
      tmux: name,
      cwd: cwd || null,
      world: worldLabelFor(cwd), // PLAN-469 · 2a
      pid: pid ? parseInt(pid, 10) : null,
      alive: true,
    });
  }
  // --- Chats del SDK (chats.json) ---
  const chats = readJson(path.join(config.home, '.cwc-data', 'chats.json'));
  if (Array.isArray(chats)) {
    for (const c of chats) {
      if (!c || !c.sessionId) continue;
      // Un chat en modo TUI ya aparece como sesión tmux bare: no duplicar.
      if (c.viewMode === 'tui') continue;
      entries.push({
        handle: `claude:${c.sessionId}`,
        name: c.title || c.id || 'chat',
        kind: 'chat',
        cwd: c.cwd || null,
        world: worldLabelFor(c.cwd), // PLAN-469 · 2a
        packageRef: c.packageRef || null, // PLAN-469 · 1b (ref estable en el panel)
        archived: !!c.archived, // PLAN-469 · 3a (status de la sesión destino)
        claudeSid: c.sessionId,
        alive: null, // se completa con el observador al evaluar
      });
    }
  }
  return entries;
}

// Separa el argv de `send` en {targetArg, text}. DOS modos de invocación:
//   - Directo desde una sesión: `send "<destino>" "<texto>"` → el shell YA
//     separó los argumentos; usarlos tal cual (un nombre con espacios NO se
//     debe re-partir). Este es el modo que rompía BUG-936.
//   - /btw: pasa "$ARGUMENTS" como UN solo argumento → ahí sí partimos por el
//     primer bloque de espacios (destino = primer token, resto = mensaje).
// Devuelve {targetArg, text} o {error} si no hay suficiente.
export function parseSendArgs(rawArgs) {
  let args = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  if (args[0] === '--') args = args.slice(1);
  if (args.length >= 2) {
    return { targetArg: args[0], text: args.slice(1).join(' ') };
  }
  const raw = (args[0] || '').trim();
  const m = raw.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return { error: 'faltan argumentos' };
  return { targetArg: m[1], text: m[2] };
}

// Resuelve el argumento de `/btw <destino>` a un handle (o 'all').
// Acepta: "all"/"todos" (broadcast); un handle explícito (tmux:… / claude:…);
// o un nombre amigable (case-insensitive, match exacto y luego por inclusión).
export function resolveTarget(arg) {
  const q = String(arg || '').trim();
  if (!q) return { error: 'Falta el destino' };
  if (/^(all|todos|todas|broadcast)$/i.test(q)) return { handle: 'all', name: 'todas las sesiones' };
  if (/^(tmux|claude):/.test(q)) return { handle: q, name: q };
  // PLAN-469 · 1a: direccionar por REF ESTABLE del paquete-sesión (PKG-N). Es
  // inmune a renames y a los moves entre mundos (el nombre es frágil, el ref no).
  const pkgMatch = q.match(/^(PKG-\d+)$/i);
  if (pkgMatch) {
    const ref = pkgMatch[1].toUpperCase();
    const rec = readPackages()[ref];
    if (!rec || !rec.sessionId) return { error: `No encontré el paquete ${ref} (o aún no tiene sesión).` };
    const name = `${rec.title || ref} [${ref}]`;
    return { handle: `claude:${rec.sessionId}`, name, entry: { ...rec, handle: `claude:${rec.sessionId}`, name } };
  }
  const dir = buildDirectory();
  const lc = q.toLowerCase();
  const exact = dir.filter((e) => e.name.toLowerCase() === lc);
  let hit = exact.find((e) => !e.archived) || exact[0];
  if (!hit) {
    const partial = dir.filter((e) => e.name.toLowerCase().includes(lc));
    const live = partial.filter((e) => !e.archived);
    const pool = live.length ? live : partial;
    if (pool.length === 1) {
      [hit] = pool;
      if (hit.archived) {
        return { error: `La única sesión que coincide con "${q}" está ARCHIVADA (${hit.name}). Usá el handle claude:<sessionId> o PKG-N si querés mandarle igual.` };
      }
    } else if (pool.length > 1) {
      return { error: `"${q}" es ambiguo: ${pool.map((e) => e.name).join(', ')}` };
    }
  }
  if (!hit) return { error: `No encontré una sesión llamada "${q}". Sesiones: ${dir.map((e) => e.name).join(', ') || '(ninguna)'}` };
  return { handle: hit.handle, name: hit.name, entry: hit };
}

// ===== Niveles de interrupción (rediseño 2026-07-10, Fase 4) =====
// FUENTE ÚNICA de "qué interrumpe y qué no", sin IA (R1). Dos niveles:
//   active  — merece atención inmediata (toast no-modal en la ventana que ve el
//             chat). HOY solo el 'heads-up' de una colisión real: otra sesión
//             EDITÓ un archivo que vos reservabas → tenés que releerlo. (El
//             bloqueo duro hot/alive ya lo maneja hook-guard en la sesión que
//             intenta editar; no genera mensaje.)
//   passive — badge + bitácora, no interrumpe: coordinación manual (notes),
//             broadcasts, avisos informativos.
// Regla por defecto: kind 'heads-up' ⇒ active; todo lo demás ⇒ passive. Un
// mensaje viejo sin `level` se trata como passive en los lectores.
export function levelForKind(kind) {
  return kind === 'heads-up' ? 'active' : 'passive';
}

// ===== Mensajería =====
// Crea un mensaje. `from`/`fromName` identifican al emisor (best-effort).
export function sendMessage({ from, fromName, to, toName, text, kind = 'note', level, hops = 0, packageRef = null }) {
  ensureDirs();
  const id = newId('m');
  const msg = {
    id, from: from || null, fromName: fromName || 'una sesión',
    to, toName: toName || to, text: String(text || '').slice(0, 4000),
    // PLAN-469 · 4a: un mensaje puede TRANSFERIR un paquete-sesión ("te paso PKG-5")
    // — la sesión receptora lo trae con el 🔗 del composer (F5). Validado PKG-<n>.
    ...(/^PKG-\d+$/i.test(String(packageRef || '')) ? { packageRef: String(packageRef).toUpperCase() } : {}),
    kind, level: level || levelForKind(kind), hops, ts: Date.now(), deliveredTo: {}, ackBy: {},
  };
  writeJson(path.join(MSG_DIR, `${id}.json`), msg);
  return msg;
}

// Mensajes pendientes para un conjunto de handles propios (no entregados aún a
// ninguno de ellos, no emitidos por uno mismo, dentro del TTL). NO muta.
export function pendingFor(handles) {
  const set = new Set(handles || []);
  const now = Date.now();
  return listJson(MSG_DIR).filter((m) => {
    if (now - (m.ts || 0) > MSG_TTL_MS) return false;
    if (set.has(m.from)) return false; // no me muestro mis propios mensajes
    const forMe = m.to === 'all' || set.has(m.to);
    if (!forMe) return false;
    return !handles.some((h) => m.deliveredTo && m.deliveredTo[h]);
  }).sort((a, b) => a.ts - b.ts);
}

// Marca como entregados a estos handles (idempotente) y persiste.
export function markDelivered(messages, handles) {
  const now = Date.now();
  for (const m of messages) {
    m.deliveredTo = m.deliveredTo || {};
    for (const h of handles) m.deliveredTo[h] = now;
    writeJson(m._file || path.join(MSG_DIR, `${m.id}.json`), stripMeta(m));
  }
}
function stripMeta(o) { const { _file, ...rest } = o; return rest; }

// Todos los mensajes vivos (para el panel).
// `directory` opcional: si el llamador ya construyó el directorio (el endpoint del
// panel lo hace), se reutiliza en vez de recalcularlo — buildDirectory() lanza
// subprocess de tmux y este endpoint se consulta seguido.
export function allMessages(directory = null) {
  const now = Date.now();
  const entries = directory || buildDirectory();
  const liveHandles = new Set(entries.map((entry) => entry.handle));
  return listJson(MSG_DIR)
    .filter((m) => now - (m.ts || 0) <= MSG_TTL_MS)
    .map((m) => ({ ...stripMeta(m), undeliverable: !liveHandles.has(m.to) }))
    .sort((a, b) => b.ts - a.ts);
}

// ===== Claims =====
export function getClaim(absPath) {
  return readJson(claimFileFor(absPath));
}
export function allClaims() {
  return listJson(CLAIM_DIR).map(stripMeta);
}

// Crea o renueva el claim de `owner` sobre un archivo.
export function claimFile({ absPath, handle, claudeSid, name, kind, tmux, note }) {
  ensureDirs();
  const file = claimFileFor(absPath);
  const prev = readJson(file);
  const now = Date.now();
  const claim = {
    file: absPath,
    handle,
    claudeSid: claudeSid || (prev && prev.handle === handle ? prev.claudeSid : null) || null,
    name: name || (prev && prev.name) || handle,
    kind: kind || (prev && prev.kind) || null,
    tmux: tmux || (prev && prev.handle === handle ? prev.tmux : null) || null,
    note: note || (prev && prev.handle === handle ? prev.note : null) || null,
    ts: prev && prev.handle === handle ? (prev.ts || now) : now,
    renewedAt: now,
  };
  writeJson(file, claim);
  return claim;
}

// Libera el claim de un archivo si pertenece a alguno de estos handles.
export function releaseFile(absPath, handles) {
  const file = claimFileFor(absPath);
  const c = readJson(file);
  if (c && handles.includes(c.handle)) {
    try { fs.unlinkSync(file); } catch { /* noop */ }
    return true;
  }
  return false;
}

// Libera TODOS los claims de estos handles (cierre de sesión).
export function releaseAll(handles) {
  const set = new Set(handles || []);
  let n = 0;
  for (const c of listJson(CLAIM_DIR)) {
    if (set.has(c.handle)) {
      try { fs.unlinkSync(c._file); n += 1; } catch { /* noop */ }
    }
  }
  return n;
}

// Lápida: aviso persistido de que a `formerHandle` le robaron el claim de un
// archivo. Su próximo turno lo recibe inyectado (ver bin/cwc-bus.js hook-inject).
export function tombstone({ file, formerHandle, byHandle, byName }) {
  ensureDirs();
  const id = newId('t');
  writeJson(path.join(TOMB_DIR, `${id}.json`), {
    id, type: 'claim_stolen', file, formerHandle, byHandle, byName: byName || byHandle, ts: Date.now(),
  });
}
// Lápidas pendientes para un conjunto de handles (no entregadas).
export function tombstonesFor(handles) {
  const set = new Set(handles || []);
  const now = Date.now();
  return listJson(TOMB_DIR).filter((t) =>
    now - (t.ts || 0) <= TOMB_TTL_MS && set.has(t.formerHandle) && !(t.delivered));
}
export function markTombstonesDelivered(tombs) {
  for (const t of tombs) {
    t.delivered = Date.now();
    writeJson(t._file || path.join(TOMB_DIR, `${t.id}.json`), stripMeta(t));
  }
}

// ===== Árbol de decisión de un claim ajeno (¿sigue viva la dueña?) =====
// Devuelve { state, label, reason }. state ∈ hot | alive | gray | zombie | stale
export function evaluateClaim(claim) {
  if (!claim) return { state: 'none' };
  const now = Date.now();
  const age = now - (claim.renewedAt || claim.ts || 0);

  // 1) Caliente: editó ese archivo hace <5min => está EN el archivo ahora.
  if (age < HOT_MS) {
    return { state: 'hot', label: '🔴 editando ahora', reason: `${claim.name} editó este archivo hace menos de 5 minutos` };
  }

  // 2) Estado real del observador (si es una sesión con claude sid conocido).
  const obs = readObserver(claim.claudeSid);
  if (obs) {
    if (obs.status === 'ended') {
      return { state: 'zombie', label: '🟢 sesión terminada', reason: `${claim.name} ya cerró su sesión` };
    }
    if (obs.status === 'working' && now - (obs.ts || 0) < OBS_FRESH_MS) {
      return { state: 'alive', label: '🔴 trabajando', reason: `${claim.name} está trabajando activamente` };
    }
  }

  // 3) Signo vital físico: para TUIs, ¿existe todavía la sesión tmux?
  if (claim.tmux && !tmuxHasSession(claim.tmux)) {
    return { state: 'zombie', label: '🟢 tmux caída', reason: `La sesión tmux de ${claim.name} ya no existe` };
  }

  // 4) Viva pero inactiva: zona gris (<30min) vs TTL vencido.
  if (age < GRAY_MS) {
    return { state: 'gray', label: '🟡 inactiva', reason: `${claim.name} tenía el claim pero está inactiva (sin editar hace ${Math.round(age / 60000)} min)` };
  }
  return { state: 'stale', label: '🟢 claim vencido', reason: `El claim de ${claim.name} venció (sin actividad hace ${Math.round(age / 60000)} min)` };
}

// ¿Este estado bloquea la edición ajena?
export function blocks(state) { return state === 'hot' || state === 'alive'; }
// ¿Este estado permite robar el claim?
export function stealable(state) { return state === 'zombie' || state === 'stale' || state === 'none'; }

// ===== Recolección de basura oportunista =====
// La corre cualquier invocación del CLI: barre mensajes/lápidas/claims vencidos.
export function gc() {
  const now = Date.now();
  for (const m of listJson(MSG_DIR)) {
    if (now - (m.ts || 0) > MSG_TTL_MS) { try { fs.unlinkSync(m._file); } catch { /* noop */ } }
  }
  for (const t of listJson(TOMB_DIR)) {
    if (now - (t.ts || 0) > TOMB_TTL_MS) { try { fs.unlinkSync(t._file); } catch { /* noop */ } }
  }
  // Claims: se limpian por evaluación perezosa al chocar; acá solo barremos los
  // que superan LARGAMENTE el TTL gris y cuya tmux ya no existe (huérfanos).
  for (const c of listJson(CLAIM_DIR)) {
    const age = now - (c.renewedAt || c.ts || 0);
    if (age > GRAY_MS && c.tmux && !tmuxHasSession(c.tmux)) {
      try { fs.unlinkSync(c._file); } catch { /* noop */ }
    }
  }
}

export const paths = { ROOT, MSG_DIR, CLAIM_DIR, TOMB_DIR };
