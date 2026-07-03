// modules/bugfixes/engine.js — MOTOR de tickets: la columna vertebral viva.
//
// Filosofía (alineada con core/inventory.js, el "sistema nervioso"):
// DETERMINÍSTICO primero. El log físico de intentos vive en bugfixes.json
// (cada registro = un ATTEMPT: un chat que trabajó un ticket). El motor NO
// duplica ese dato: DERIVA los Tickets consolidados al vuelo (barato, ms),
// agrupando por número de ticket. Así es IMPOSIBLE tener tickets duplicados
// y el estado nunca se desincroniza del log.
//
// Un TICKET es la entidad central:
//   { number, url, source, title, severity, area, tags[],
//     attempts[],                     // los chats que lo trabajaron
//     external: { github[], desk },   // estado real + frescura (checkedAt)
//     state,                          // DERIVADO (pipeline), no un campo plano
//     resolution,                     // active | partial | complete
//     meta{},                         // variables futuras SIN migración
//     history[], createdAt, updatedAt }
//
// Lo que NO se puede derivar del log (dimensiones curadas a mano: tags, area,
// severity override, y la BIBLIOTECA DE SOLUCIONES) vive en un sidecar
// indexado por número de ticket (tickets-meta.json). Extensible por diseño.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBugfixes } from './store.js';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const SIDECAR_FILE = path.join(DATA_DIR, 'tickets-meta.json');
export const ENGINE_SCHEMA = 2;

// ===== Estado del ticket = FUNCIÓN PURA (nunca un campo que se desincroniza) =====
// Pipeline: triaged → working → pr-open → pr-merged → desk-answered → resolved.
// Se calcula de: attempts (¿código? ¿PR?) + external.github (¿mergeado?) +
// external.desk (¿respondido/cerrado?). Agregar una etapa = agregar un caso acá.
export const PIPELINE = ['triaged', 'working', 'pr-open', 'pr-merged', 'desk-answered', 'resolved'];

export function deriveState(t) {
  const prs = t.external?.github || [];
  const anyMerged = prs.some((p) => p.state === 'merged') || t.attempts.some((a) => a.pr?.state === 'merged');
  const anyOpen = prs.some((p) => p.state === 'open') || t.attempts.some((a) => a.pr?.state === 'open');
  const desk = t.external?.desk || {};
  const answered = !!desk.replied || !!desk.answered;
  const resolved = !!desk.resolved || !!desk.closed;
  const hasCode = t.attempts.some((a) => (a.files?.length || 0) > 0);

  if (resolved && anyMerged) return 'resolved';
  if (answered && anyMerged) return 'desk-answered';
  if (anyMerged) return 'pr-merged';
  if (anyOpen) return 'pr-open';
  if (hasCode || t.attempts.some((a) => a.outcome === 'coded' || a.outcome === 'pr-sent')) return 'working';
  return 'triaged';
}

// Resolución consolidada (para el chip del tablero): complete si Desk lo
// confirmó; partial si hay merge pero Desk sin confirmar; active si no.
export function deriveResolution(t) {
  const desk = t.external?.desk || {};
  if (desk.resolved) return 'complete';
  const anyMerged = (t.external?.github || []).some((p) => p.state === 'merged')
    || t.attempts.some((a) => a.pr?.state === 'merged');
  if (anyMerged) return 'partial';
  return 'active';
}

// Un ATTEMPT (intento de resolución) a partir de un registro plano del log.
// outcome resume el destino del chat: empty (dedo resbalado) · plan · coded ·
// pr-sent · merged · abandoned.
function attemptOf(b) {
  const files = b.files || [];
  let outcome;
  if (b.prState === 'merged') outcome = 'merged';
  else if (b.prNumber) outcome = 'pr-sent';
  else if (files.length) outcome = 'coded';
  else outcome = 'empty';
  return {
    sessionId: b.sessionId,
    chatId: b.chatId || null,
    cwd: b.cwd || null,
    at: b.updatedAt || b.createdAt || 0,
    files,
    stats: b.stats || null,
    summary: b.summary || '',
    branch: b.branch || null,
    pr: b.prNumber ? { number: b.prNumber, url: b.prUrl || null, state: b.prState || 'open', mergedBy: b.mergedBy || null, mergedAt: b.mergedAt || null } : null,
    outcome,
  };
}

// ===== Sidecar: dimensiones curadas + biblioteca de soluciones =====
export function loadSidecar() {
  try { return JSON.parse(fss.readFileSync(SIDECAR_FILE, 'utf8')); }
  catch { return { schema: ENGINE_SCHEMA, tickets: {}, solutions: [] }; }
}
export function saveSidecar(sc) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(SIDECAR_FILE, JSON.stringify(sc, null, 1), { mode: 0o600 });
  } catch (err) { console.error('[engine] no pude escribir el sidecar:', err?.message); }
}

// ===== Consolidación: attempts del log -> Tickets (la columna vertebral) =====
// `ghRows` opcional: PRs solo-GitHub (sin registro) para enriquecer external.
export function buildTickets({ ghRows = [] } = {}) {
  const log = listBugfixes();
  const sc = loadSidecar();
  const byNum = new Map();

  const keyOf = (b) => (b.ticketNumber ? `#${b.ticketNumber}` : `sid:${b.sessionId}`); // sin ticket = su propio grupo

  for (const b of log) {
    const key = keyOf(b);
    if (!byNum.has(key)) {
      const meta = (b.ticketNumber && sc.tickets[String(b.ticketNumber)]) || {};
      byNum.set(key, {
        number: b.ticketNumber || null,
        url: b.ticketUrl || null,
        source: b.ticketNumber ? 'desk' : 'manual',
        title: b.title || '',
        severity: meta.severity || null,
        area: meta.area || null,
        tags: meta.tags || [],
        attempts: [],
        external: { github: [], desk: {} },
        history: [],
        archived: true, // se relaja abajo: un ticket archivado solo si TODOS sus attempts lo están
        createdAt: b.createdAt || b.updatedAt || 0,
        updatedAt: 0,
        meta: meta.meta || {},
        _desk: {}, // acumulador de señales de Desk del log
      });
    }
    const t = byNum.get(key);
    t.attempts.push(attemptOf(b));
    if (Array.isArray(b.history)) t.history.push(...b.history);
    // Título: preferí el del intento con más contenido (código > plan).
    if (!t.title || (b.files?.length && b.summary)) t.title = t.title || b.title || '';
    if ((b.createdAt || Infinity) < t.createdAt) t.createdAt = b.createdAt;
    t.updatedAt = Math.max(t.updatedAt, b.updatedAt || 0);
    if (!b.archived) t.archived = false;
    // Señales de Desk del log (deskUpdateAuto / desk-live).
    if (b.deskStatus === 'ok') t._desk.answered = true;
    if (b.deskStatus === 'updating') t._desk.updating = true;
    if (b.deskStatus === 'error') t._desk.error = true;
    if (b.deskReplied) t._desk.replied = true;
    if (b.deskResolved) t._desk.resolved = true;
    if (b.deskClosed) t._desk.closed = true;
    if (b.deskCheckedAt) t._desk.checkedAt = Math.max(t._desk.checkedAt || 0, b.deskCheckedAt);
    if (b.deskStatusText) t._desk.statusText = b.deskStatusText;
    // PR del intento -> external.github (dedup por número).
    if (b.prNumber && !t.external.github.some((p) => p.number === b.prNumber)) {
      t.external.github.push({ number: b.prNumber, url: b.prUrl || null, state: b.prState || 'open', mergedBy: b.mergedBy || null, mergedAt: b.mergedAt || null, checkedAt: b.updatedAt || null });
    }
  }

  // PRs solo-GitHub: engancharlos al ticket detectado de su título/branch.
  for (const pr of ghRows) {
    const num = ticketOfPr(pr);
    if (!num) continue;
    const key = `#${num}`;
    const t = byNum.get(key);
    if (t && !t.external.github.some((p) => p.number === pr.number)) {
      t.external.github.push({ number: pr.number, url: pr.url, state: pr.state, mergedBy: pr.mergedBy || null, mergedAt: pr.mergedAt || null, checkedAt: pr.fetchedAt || null, orphan: true });
    }
  }

  // Cerrar: ordenar attempts/history, derivar estado y resolución.
  const tickets = [];
  for (const t of byNum.values()) {
    t.attempts.sort((a, b) => (a.at || 0) - (b.at || 0));
    t.history.sort((a, b) => (a.t || 0) - (b.t || 0));
    t.external.desk = t._desk; delete t._desk;
    t.state = deriveState(t);
    t.resolution = deriveResolution(t);
    t.schemaVersion = ENGINE_SCHEMA;
    tickets.push(t);
  }
  // Orden del tablero: lo accionable primero, resueltos al fondo.
  const rank = (t) => (t.resolution === 'complete' ? 3 : t.state === 'pr-merged' || t.state === 'desk-answered' ? 2 : t.attempts.some((a) => a.files?.length) ? 0 : 1);
  tickets.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return tickets;
}

// Detecta el número de ticket del título/branch de un PR (bugfix/tkt-N o "#N").
export function ticketOfPr(pr) {
  const s = `${pr.headRefName || pr.branch || ''} ${pr.title || ''}`;
  const m = s.match(/tkt[-_ ]?(\d+)/i) || s.match(/#(\d{2,})/) || s.match(/desk[-_ #]*(\d+)/i);
  return m ? m[1] : null;
}

// ===== Biblioteca de soluciones (gancho preparado; matching determinístico) =====
// Destila una solución de un ticket resuelto (para reusar en tickets futuros).
// Se llena en una fase próxima; el gancho ya deja la estructura y la búsqueda.
export function recordSolution({ ticketNumber, rootCause, fix, files = [], area = null, tags = [] }) {
  const sc = loadSidecar();
  sc.solutions = sc.solutions || [];
  sc.solutions.push({
    id: `sol-${ticketNumber}-${Date.now()}`,
    ticketNumber, rootCause: String(rootCause || '').slice(0, 1000),
    fix: String(fix || '').slice(0, 1000), files, area, tags,
    at: Date.now(),
  });
  saveSidecar(sc);
}

// Busca soluciones pasadas parecidas a un ticket (por archivos/área/tags —
// determinístico, sin LLM). La sugerencia con IA será una capa opcional.
export function findSimilarSolutions(ticket, { limit = 3 } = {}) {
  const sc = loadSidecar();
  const sols = sc.solutions || [];
  if (!sols.length) return [];
  const files = new Set(ticket.attempts.flatMap((a) => a.files || []));
  const tags = new Set(ticket.tags || []);
  const score = (s) => {
    let n = 0;
    for (const f of s.files || []) if (files.has(f)) n += 2;
    for (const g of s.tags || []) if (tags.has(g)) n += 1;
    if (s.area && s.area === ticket.area) n += 1;
    return n;
  };
  return sols.map((s) => ({ s, n: score(s) })).filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n).slice(0, limit).map((x) => x.s);
}

// ===== Curación de dimensiones (tags/area/severity/meta) por ticket =====
export function setTicketMeta(ticketNumber, patch) {
  const sc = loadSidecar();
  sc.tickets = sc.tickets || {};
  const cur = sc.tickets[String(ticketNumber)] || {};
  sc.tickets[String(ticketNumber)] = { ...cur, ...patch };
  saveSidecar(sc);
}
