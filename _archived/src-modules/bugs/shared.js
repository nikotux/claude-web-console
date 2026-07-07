// modules/bugs/shared.js — lo COMPARTIDO entre el módulo server y el
// runner desacoplado del triage (bin/cwc-triage-runner.js): prompts de las
// DOS fases (listado + triage por ticket), allowlist de seguridad, parsers
// del resultado, caché y lock de "corriendo".
//
// El triage corría DENTRO del proceso Node y cada reinicio del server (deploy,
// push/pull, otra sesión trabajando en la consola) lo mataba a mitad de
// corrida — el bug de "no se pudo correr el triage". Ahora corre en un proceso
// detached (regla 2: nada en curso atado al ciclo de vida del Node) y ESTOS
// dos archivos son su interfaz:
//   - CACHE_FILE (tickets.json): el resultado (tickets o error del último intento).
//   - LOCK_FILE  (triage.lock):  heartbeat {pid, ts} del runner vivo; "corriendo"
//     = lock con ts fresco (LOCK_FRESH_MS). Un runner muerto a lo bestia deja
//     lock viejo => se considera no-corriendo y se puede relanzar.
import crypto from 'node:crypto';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Motor transversal de Comunicaciones (comms): buildIndex() es 100% lectura
// de disco (~/.cwc-data/comms/*.json ya indexados), 0 tokens, sin red. Se usa
// para inyectar al triage lo YA hablado con el contacto sobre cada ticket
// (espejo backend de fetchCommsContext del front — hallazgo del Módulo de
// Coherencia 2026-07-06: el ciclo de bugs debe consumir comms, no ignorarlo).
import { buildIndex as buildCommsIndex } from '../comms/shared.js';

export const DATA_DIR = path.join(os.homedir(), '.cwc-data');
// El módulo se llama `bugs`, pero el archivo de caché conserva el nombre
// `tickets.json` a propósito: describe el DATO (tickets [Tolkien Bug] de Zoho
// Desk), no el módulo, y renombrarlo perdería la caché actual del triage
// (que cuesta tokens regenerar).
export const CACHE_FILE = path.join(DATA_DIR, 'tickets.json');
export const LOCK_FILE = path.join(DATA_DIR, 'triage.lock');
export const LOG_FILE = path.join(DATA_DIR, 'triage.log');

// DOS FASES (optimización IA 2026-07-05, patrón desk-runner): antes una ÚNICA
// query() serial listaba Y analizaba todos los tickets (6 min de timeout
// global: con varios tickets las idas y vueltas MCP escalaban y un timeout a
// mitad de camino tiraba el intento COMPLETO gastando tokens sin resultado).
// Ahora: (1) un listado barato, (2) triage de cada ticket EN PARALELO
// (runAdaptivePool) — cada query es corta, aislada y escribe SU entrada
// incremental; un timeout pierde solo ESE ticket, nunca el batch.
export const LIST_TIMEOUT_MS = 2 * 60 * 1000;   // fase 1: solo listar (MCP list, sin análisis)
export const TICKET_TIMEOUT_MS = 3 * 60 * 1000; // fase 2: triage de UN ticket (get + pad_search + repo)
export const LIST_MAX_TURNS = 12;               // cota de coste del listado
export const TICKET_MAX_TURNS = 20;             // cota de coste por ticket
export const HEARTBEAT_MS = 3000;             // latido del runner al lock
export const LOCK_FRESH_MS = 12000;           // lock más viejo que esto = runner muerto

const SEVERITY = new Set(['critical', 'high', 'medium', 'low']);
const RECOMMENDATION = new Set(['fix', 'needs-info', 'duplicate', 'wont-fix']);

// Allowlist de herramientas: SOLO lecturas (dos capas: hook PreToolUse +
// canUseTool — ver regla 6 de CLAUDE.md).
export function toolAllowed(name) {
  // TodoWrite es la lista de tareas INTERNA del modelo (Agent SDK): solo toca
  // estado conversacional, nunca disco ni sistemas externos — es seguro en
  // una corrida read-only y ayuda al modelo a organizarse.
  // ToolSearch es la META-tool del SDK para tools DIFERIDAS: solo devuelve el
  // SCHEMA de una tool para poder invocarla (no ejecuta nada); sin ella el
  // modelo no puede ni nombrar las tools MCP de lectura (visto 2026-07-05: el
  // listado moría con "herramienta no permitida" en ToolSearch). La ejecución
  // real de cada tool sigue pasando por estas DOS capas.
  if (['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite', 'ToolSearch'].includes(name)) return true;
  // Herramientas MCP de lectura (desk_list/get/search, pad_search, graph_list…).
  // Regex ANCLADA al final: get_and_delete NO pasa (hallazgo de la revisión de salud).
  if (/^mcp__[a-z0-9_-]+__[a-z0-9_]*(list|get|search|read|find)[a-z0-9_]*$/i.test(name) && !/(delete|update|create|write|set|add|remove|send)/i.test(name)) return true;
  return false; // todo lo demás (mutaciones, Bash, Write/Edit) -> denegado
}

// FASE 1: solo LISTAR los tickets abiertos (barata, sin razonamiento). El
// skill bug-triage va cargado porque ahí viven el department_id de Tolkien y
// los nombres de las tools Desk — si el skill cambia, esto no queda viejo.
export const LIST_PROMPT = [
  'Ejecutá SOLO el paso 1 del skill bug-triage: obtener la LISTA de tickets de',
  'bug ABIERTOS de Tolkien ([Tolkien Bug] en Zoho Desk). Es una corrida NO',
  'interactiva y de SOLO LECTURA.',
  '',
  'Usá desk_list_tickets (o desk_search_tickets) con el department_id de',
  'Tolkien que indica el skill y quedate con los tickets cuyo subject empieza',
  'con [Tolkien Bug] y siguen abiertos (statusType "Open" — NO el status',
  'localizado). NO llames desk_get_ticket, NO analices ningún ticket, NO uses',
  'pad_search: solo el listado.',
  '',
  'Cuando termines, respondé ÚNICAMENTE con un bloque de código ```json que',
  'contenga un array de objetos, uno por ticket abierto, con exactamente estas',
  'claves:',
  '  - ticketNumber (string o número, el # del ticket de Desk)',
  '  - subject      (string, el asunto del ticket)',
  '  - webUrl       (string: el webUrl del ticket; "" si no lo tenés)',
  '  - status       (string, el estado EXACTO del ticket tal como lo reporta Desk)',
  '  - modifiedTime (string, el timestamp de última modificación que reporta',
  '    Desk para el ticket; "" si no lo tenés)',
  '',
  'Si no hay tickets abiertos, respondé con ```json\n[]\n```. No agregues texto',
  'fuera del bloque json.',
].join('\n');

// Contexto de COMUNICACIONES para UN ticket: hilos del motor comms (GitHub/
// Teams/chatbot/manual) que mencionen el ticket (tkt-N / TKT #N / #N). Si hay
// un PR en discusión o el contacto ya habló del bug, el triage lo tiene que
// saber (mejor detección de duplicate/ya-trabajado). Best-effort por diseño:
// cualquier falla (comms sin datos, json roto) devuelve '' y el triage sigue
// igual que antes — NUNCA rompe la corrida.
export function commsContextFor(ticketNumber) {
  try {
    const n = String(ticketNumber || '').trim();
    if (!/^\d+$/.test(n)) return '';
    // Boundary numérico a mano: "#519" no debe matchear "#5192".
    const re = new RegExp(`(?:tkt[\\s#_-]*|#)${n}(?![0-9])`, 'i');
    const { threads } = buildCommsIndex();
    const hits = [];
    for (const t of threads || []) {
      if (t.archived) continue;
      const lastMsgs = (t.messages || []).slice(-5);
      const haystack = [t.title || '', ...lastMsgs.map((m) => String(m.text || ''))].join('\n');
      if (!re.test(haystack)) continue;
      const last = lastMsgs[lastMsgs.length - 1];
      hits.push(`  - [${t.source}] ${t.title}${t.awaitingReply ? ' (esperando respuesta del contacto)' : ''}${last ? `: "${String(last.text || '').slice(0, 200)}"` : ''}`);
      if (hits.length >= 3) break; // tope: contexto acotado, no un chorizo
    }
    if (!hits.length) return '';
    return [
      'COMUNICACIONES ya registradas sobre este ticket (motor Comunicaciones,',
      'datos ya indexados — si acá se ve un PR/charla en curso, este bug puede',
      'estar YA trabajado o ser duplicado; pesalo en recommendation):',
      ...hits,
    ].join('\n');
  } catch { return ''; }
}

// FASE 2: triage de UN ticket. Recibe la lista completa de hermanos (nº +
// asunto) para no perder la detección de duplicados ENTRE tickets que tenía
// la corrida única.
export function perTicketPrompt(ticket, allTickets) {
  const siblings = (allTickets || [])
    .filter((t) => String(t.ticketNumber) !== String(ticket.ticketNumber))
    .map((t) => `  - #${t.ticketNumber}: ${String(t.subject || '').slice(0, 160)}`);
  const comms = commsContextFor(ticket.ticketNumber);
  return [
    `Triageá UN ÚNICO ticket de bug de Tolkien: el #${ticket.ticketNumber} de`,
    `Zoho Desk (asunto: ${String(ticket.subject || '').slice(0, 200)}).`,
    'Seguí la metodología del paso 2 del skill bug-triage SOLO para este',
    'ticket. Es una corrida NO interactiva y de SOLO LECTURA: NO crees TASKs',
    'en Pad, NO actualices ningún ticket de Desk, no modifiques nada.',
    '',
    'Pasos: leé el ticket completo con desk_get_ticket (el contexto capturado',
    'vive en la descripción), corré pad_search sobre el síntoma/ruta para ver',
    'si ya está trackeado, y si ayuda buscá en el repo los archivos sospechosos.',
    '',
    siblings.length
      ? ['Estos son los OTROS tickets abiertos del mismo triage (para detectar',
        'duplicados entre sí — si este ticket duplica a uno de estos, marcalo):',
        ...siblings].join('\n')
      : 'No hay otros tickets abiertos en este triage.',
    comms ? `\n${comms}` : '',
    '',
    'Cuando termines, respondé ÚNICAMENTE con un bloque de código ```json que',
    'contenga UN objeto (no un array) con exactamente estas claves:',
    '  - ticketNumber (string o número, el # del ticket de Desk)',
    '  - whatBroke     (string, una línea: qué se rompió, en criollo)',
    '  - route         (string, la ruta/página del contexto capturado; "" si no hay)',
    '  - severity      (uno de: critical | high | medium | low)',
    '  - recommendation(uno de: fix | needs-info | duplicate | wont-fix)',
    '  - duplicate     (string: link/ref del duplicado si aplica; "" si no)',
    '  - webUrl        (string: el webUrl del ticket de Desk; "" si no lo tenés)',
    '  - reporter      (string: email de quien reportó; "" si no está)',
    '  - context       (string, 3-8 líneas: el CONTEXTO del bug — qué estaba',
    '    haciendo el usuario según el breadcrumb/estado del formulario, el error',
    '    JS si hay, tu hipótesis de la causa y archivos/componentes sospechosos',
    '    del repo. Texto plano, sin markdown.)',
    '',
    'No agregues texto fuera del bloque json.',
  ].join('\n');
}

// Extrae el ÚLTIMO bloque ```json ...``` (o, como último recurso, el primer
// array/objeto JSON suelto del texto) y lo parsea. Devuelve el valor o null.
function lastJsonBlock(text, fallbackRe) {
  if (!text) return null;
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  let raw = fences.length ? fences[fences.length - 1][1].trim() : null;
  if (!raw) {
    const m = text.match(fallbackRe);
    raw = m ? m[0] : null;
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Sanea/acota UN ticket triageado al shape que consumen la caché y el front.
export function normalizeTicket(t) {
  return {
    ticketNumber: String(t.ticketNumber ?? t.number ?? '').slice(0, 40),
    whatBroke: String(t.whatBroke ?? t.title ?? '').slice(0, 400),
    route: String(t.route ?? '').slice(0, 200),
    severity: SEVERITY.has(t.severity) ? t.severity : 'medium',
    recommendation: RECOMMENDATION.has(t.recommendation) ? t.recommendation : 'needs-info',
    duplicate: String(t.duplicate ?? '').slice(0, 200),
    webUrl: /^https?:\/\//.test(t.webUrl || '') ? String(t.webUrl).slice(0, 400) : '',
    reporter: String(t.reporter ?? '').slice(0, 120),
    context: String(t.context ?? '').slice(0, 2000),
  };
}

// FASE 1: parsea el listado [{ticketNumber, subject, webUrl, status,
// modifiedTime}] (sin triage). status/modifiedTime alimentan el fingerprint
// de la caché incremental por ticket (ver ticketFingerprint).
export function parseTicketList(text) {
  const arr = lastJsonBlock(text, /\[[\s\S]*\]/);
  if (!Array.isArray(arr)) return null;
  return arr
    .map((t) => ({
      ticketNumber: String(t.ticketNumber ?? t.number ?? '').slice(0, 40),
      subject: String(t.subject ?? t.title ?? '').slice(0, 300),
      webUrl: /^https?:\/\//.test(t.webUrl || '') ? String(t.webUrl).slice(0, 400) : '',
      status: String(t.status ?? '').slice(0, 60),
      modifiedTime: String(t.modifiedTime ?? '').slice(0, 60),
    }))
    .filter((t) => t.ticketNumber);
}

// FASE 2: parsea el triage de UN ticket (objeto; tolera array de 1 elemento).
export function parseTicketTriage(text) {
  let v = lastJsonBlock(text, /\{[\s\S]*\}/);
  if (Array.isArray(v)) v = v[0];
  if (!v || typeof v !== 'object') return null;
  return normalizeTicket(v);
}

export function readCache() {
  try { return JSON.parse(fss.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { updatedAt: null, tickets: [], error: null }; }
}

export function writeCache(data) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fss.writeFileSync(CACHE_FILE, JSON.stringify(data), { mode: 0o600 });
      return;
    } catch (err) {
      if (attempt === 1) console.error('[tickets] no se pudo escribir la caché:', CACHE_FILE, err?.message);
    }
  }
}

// ===== Caché INCREMENTAL por ticket (optimización IA 2026-07-05) =====
// Mismo patrón que health-audit-cache.json (readAuditCache/writeAuditCache/
// unitFingerprint de health/shared.js): { [ticketNumber]: {fingerprint,
// ticket, triagedAt} }. El fingerprint sale del LISTADO de la fase 1
// (status + modifiedTime de Desk): si no cambió desde el último triage, el
// resultado anterior se REUSA sin query() (0 tokens) — re-triagear lo que no
// cambió es gasto puro. Sin modifiedTime NO hay señal confiable ⇒ fingerprint
// '' ⇒ NUNCA se considera "sin cambios" (dirección segura: se re-triagea).
// Borrar el archivo solo fuerza un triage completo; --full del runner lo
// ignora (red de seguridad si la caché ensucia algo).
export const TICKET_CACHE_FILE = path.join(DATA_DIR, 'triage-cache.json');

export function readTicketCache() {
  try { const o = JSON.parse(fss.readFileSync(TICKET_CACHE_FILE, 'utf8')); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}

export function writeTicketCache(cache) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(TICKET_CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
  } catch (err) { console.error('[tickets] no pude escribir triage-cache:', err?.message); }
}

// Tope de FRESCURA de un hit de caché: la señal del listado (ver abajo) es
// ciega a un comentario nuevo sin cambio de estado, así que un triage
// cacheado de más de 12 h se re-hace aunque el fingerprint coincida —
// staleness acotada por diseño (el caso de uso real del ahorro son los
// reintentos del botón Refrescar en el mismo día).
export const TICKET_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// Fingerprint de UN ticket del listado. VERIFICADO 2026-07-05 contra el MCP
// de Tolkien (apps/mcp/src/zoho-tools.ts, summarizeTickets): el listado
// RECORTA modifiedTime del payload de Zoho (el modelo devuelve "" honesto),
// así que la señal disponible hoy es status+subject. modifiedTime queda en
// el hash igual: si el MCP algún día lo expone, se incorpora solo (y ese
// primer listado con el campo nuevo fuerza un re-triage general, correcto).
export function ticketFingerprint(t) {
  return crypto.createHash('sha1')
    .update(String(t?.status || '')).update('\0')
    .update(String(t?.subject || '')).update('\0')
    .update(String(t?.modifiedTime || ''))
    .digest('hex').slice(0, 12);
}

// ===== Lock de "triage corriendo" (heartbeat del runner) =====
export function writeLock(pid) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(LOCK_FILE, JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}

export function clearLock() {
  try { fss.unlinkSync(LOCK_FILE); } catch { /* noop */ }
}

// Lee el lock crudo ({pid, ts}) o null si no existe/está roto. Lo usa el
// runner para distinguir la RESERVA que escribió el server con SU pid
// (spawnTriage) de un triage ajeno de verdad corriendo.
export function readLock() {
  try { return JSON.parse(fss.readFileSync(LOCK_FILE, 'utf8')); }
  catch { return null; }
}

// ¿Hay un triage corriendo AHORA? Lock presente y con latido fresco.
export function isRunning() {
  const lock = readLock();
  return !!lock && Date.now() - lock.ts < LOCK_FRESH_MS;
}
