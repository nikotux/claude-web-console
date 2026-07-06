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
import { listBugfixes, saveBugfixes, addEvent } from './store.js';

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

  // FEATURES sin ticket de Desk: el merge cierra el ciclo (no hay etapas Desk).
  if (t.kind === 'feature' && anyMerged) return 'resolved';
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
  // Un FEATURE no tiene confirmación de Desk: mergeado = completo.
  if (anyMerged) return t.kind === 'feature' ? 'complete' : 'partial';
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

// ===== Sidecar: dimensiones curadas + biblioteca de soluciones + feedback =====
export function loadSidecar() {
  try {
    const sc = JSON.parse(fss.readFileSync(SIDECAR_FILE, 'utf8'));
    sc.tickets = sc.tickets || {};
    sc.solutions = sc.solutions || [];
    sc.feedback = sc.feedback || {}; // ticketNumber -> { prNumber, items[], fetchedAt }
    return sc;
  } catch { return { schema: ENGINE_SCHEMA, tickets: {}, solutions: [], feedback: {} }; }
}
export function saveSidecar(sc) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(SIDECAR_FILE, JSON.stringify(sc, null, 1), { mode: 0o600 });
  } catch (err) { console.error('[engine] no pude escribir el sidecar:', err?.message); }
}

// ===== Feedback de Chris en los PRs (memoria persistente del ticket) =====
// Lo alimenta el panel vivo del PR (prLive ya trae reviews+comentarios de gh,
// que si no se persisten se pierden a los 60 s / al reiniciar). Guardamos el
// timeline por ticket: sobrevive reinicios y sirve de base de conocimiento.
export function saveFeedback(ticketNumber, prNumber, items) {
  if (!ticketNumber || !Array.isArray(items)) return;
  const key = String(ticketNumber);
  const sc = loadSidecar();
  const clean = items.map((f) => ({
    author: String(f.author || '?').slice(0, 60),
    at: f.at || null,
    kind: String(f.kind || 'comment').slice(0, 24),
    body: String(f.body || '').slice(0, 1000),
  })).filter((f) => f.body);
  const prev = sc.feedback[key];
  // Escribir solo si cambió (evita reescrituras inútiles del sidecar).
  const sig = (arr) => JSON.stringify((arr || []).map((f) => [f.author, f.at, f.body.length]));
  if (prev && prev.prNumber === prNumber && sig(prev.items) === sig(clean)) return;
  sc.feedback[key] = { prNumber: prNumber || prev?.prNumber || null, items: clean, fetchedAt: Date.now() };
  saveSidecar(sc);
}
export function loadFeedback(ticketNumber) {
  const sc = loadSidecar();
  return sc.feedback[String(ticketNumber)] || null;
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
        kind: b.kind === 'feature' ? 'feature' : 'bug',
        spec: b.spec || null, // enunciado ORIGINAL del feature (no lo pisa el resumen del chat)
        source: b.kind === 'feature' ? 'feature' : (b.ticketNumber ? 'desk' : 'manual'),
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
    if (b.kind === 'feature') t.kind = 'feature';
    if (b.spec && !t.spec) t.spec = b.spec;
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
  // Si la fila ya trae ticketNumber (lo adjunta refresh-prs con ESTE mismo
  // ticketOfPr), se reusa; recalcular es solo para filas viejas sin el campo.
  for (const pr of ghRows) {
    const num = pr.ticketNumber !== undefined ? pr.ticketNumber : ticketOfPr(pr);
    if (!num) continue;
    const key = `#${num}`;
    const t = byNum.get(key);
    if (t && !t.external.github.some((p) => p.number === pr.number)) {
      t.external.github.push({ number: pr.number, url: pr.url, state: pr.state, mergedBy: pr.mergedBy || null, mergedAt: pr.mergedAt || null, checkedAt: pr.fetchedAt || null, orphan: true });
    }
  }

  // Cerrar: ordenar attempts/history, derivar estado y resolución. Al vuelo:
  // adjuntar el feedback persistido de Chris y AUTO-LLENAR la biblioteca de
  // soluciones cuando un ticket llega a un estado "aprendible" (merged+).
  const tickets = [];
  let scDirty = false;
  for (const t of byNum.values()) {
    t.attempts.sort((a, b) => (a.at || 0) - (b.at || 0));
    t.history.sort((a, b) => (a.t || 0) - (b.t || 0));
    t.external.desk = t._desk; delete t._desk;
    // Feedback de Chris persistido (sidecar) → parte del ticket vivo.
    const fb = t.number ? sc.feedback[String(t.number)] : null;
    t.external.feedback = fb?.items || [];
    t.state = deriveState(t);
    t.resolution = deriveResolution(t);
    // Biblioteca de soluciones: destilar (determinístico) y upsert idempotente.
    if (upsertSolutionInto(sc, deriveSolution(t))) scDirty = true;
    t.schemaVersion = ENGINE_SCHEMA;
    tickets.push(t);
  }
  if (scDirty) saveSidecar(sc); // una sola escritura por build, y solo si cambió
  // Orden del tablero: lo accionable primero, resueltos al fondo.
  const rank = (t) => (t.resolution === 'complete' ? 3 : t.state === 'pr-merged' || t.state === 'desk-answered' ? 2 : t.attempts.some((a) => a.files?.length) ? 0 : 1);
  tickets.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return tickets;
}

// Detecta el ID de trabajo del título/branch de un PR y lo devuelve en la MISMA
// forma que viaja en ticketNumber ('519' o 'FEAT-2'), así el PR engancha con
// `#${id}` en buildTickets. Orden deliberado: tkt-N primero (la convención del
// módulo manda), FEAT-n después PERO antes de "#N" — un título
// "Feature FEAT-2 (#245)" debe dar FEAT-2, no 245. Antes del bug 2026-07-05
// (FEAT-2/PR #249) los features NUNCA se auto-vinculaban: solo dígitos.
export function ticketOfPr(pr) {
  const s = `${pr.headRefName || pr.branch || ''} ${pr.title || ''}`;
  const t = s.match(/tkt[-_ ]?(\d+)/i);
  if (t) return t[1];
  const f = s.match(/feat[-_ ]?(\d+)/i);
  if (f) return `FEAT-${f[1]}`;
  const m = s.match(/#(\d{2,})/) || s.match(/desk[-_ #]*(\d+)/i);
  return m ? m[1] : null;
}

// ===== Biblioteca de soluciones (se llena SOLA al mergear; determinística) =====
// Parseo del resumen del cierre del chat: los marcadores Problema:/Qué hice:/
// Mejor solución: (los pide el contexto de trabajo; los usa formatPrBody).
function parseSummary(summary) {
  const s = String(summary || '');
  const grab = (label) => {
    const re = new RegExp(`^\\**${label}\\**\\s*:\\s*([\\s\\S]*?)(?=^\\**(?:Problema|Qu[eé] hice|Mejor soluci[oó]n)\\**\\s*:|\\s*$)`, 'im');
    return (s.match(re) || [])[1]?.trim() || null;
  };
  return {
    rootCause: grab('Problema'),
    fix: grab('Qu[eé] hice') || (s && !grab('Problema') ? s : null),
    best: grab('Mejor soluci[oó]n'),
  };
}

// Destila una solución REUSABLE de un ticket (determinístico, sin LLM). Solo
// para tickets con PR mergeado (o resueltos): ahí el fix quedó validado. La
// "lección" es, por ahora, la mejor-solución del cierre; el feedback de Chris
// se adjunta como conocimiento crudo (una capa IA podría destilarlo mejor).
// Devuelve null si el ticket todavía no es aprendible.
export function deriveSolution(t) {
  if (!t.number) return null;
  const anyMerged = (t.external?.github || []).some((p) => p.state === 'merged')
    || t.attempts.some((a) => a.pr?.state === 'merged');
  if (!anyMerged && t.resolution !== 'complete') return null;
  const withCode = [...t.attempts].reverse().find((a) => a.summary && (a.files?.length || a.pr));
  const summary = withCode?.summary || t.attempts.find((a) => a.summary)?.summary || '';
  const parsed = parseSummary(summary);
  const files = [...new Set(t.attempts.flatMap((a) => a.files || []))];
  if (!parsed.rootCause && !parsed.fix && !files.length) return null; // nada útil que guardar
  const fb = (t.external?.feedback || []).filter((f) => f.author && !/^(github-actions|dependabot)/i.test(f.author));
  return {
    id: `sol-${t.number}`,
    ticketNumber: t.number,
    title: t.title || '',
    rootCause: (parsed.rootCause || '').slice(0, 1000),
    fix: (parsed.fix || '').slice(0, 1000),
    lesson: (parsed.best || '').slice(0, 600), // "¿es la mejor solución?" del cierre
    files, area: t.area || null, tags: t.tags || [],
    prNumber: (t.external?.github || []).find((p) => p.state === 'merged')?.number || null,
    // Conocimiento de la revisión: los comentarios de Chris que marcaron rumbo.
    feedback: fb.slice(-4).map((f) => ({ author: f.author, kind: f.kind, body: f.body.slice(0, 400) })),
    at: t.updatedAt || 0,
  };
}

// Upsert idempotente en un sidecar YA cargado (1 solución por ticket). Devuelve
// true si cambió algo (para que el caller decida si reescribe el sidecar).
function upsertSolutionInto(sc, sol) {
  if (!sol) return false;
  sc.solutions = sc.solutions || [];
  const i = sc.solutions.findIndex((x) => String(x.ticketNumber) === String(sol.ticketNumber));
  const sig = (x) => JSON.stringify([x.rootCause, x.fix, x.lesson, x.files, x.tags, x.area, x.prNumber, (x.feedback || []).map((f) => [f.author, f.body])]);
  if (i >= 0) {
    if (sig(sc.solutions[i]) === sig(sol)) return false; // idéntica: no reescribir
    sc.solutions[i] = { ...sc.solutions[i], ...sol };
    return true;
  }
  sc.solutions.push(sol);
  return true;
}

// API pública: registra/actualiza una solución (persiste al toque). La usan
// futuras capas (p.ej. la destilación IA opcional) para enriquecer una entrada.
export function recordSolution(sol) {
  const sc = loadSidecar();
  if (upsertSolutionInto(sc, { id: `sol-${sol.ticketNumber}`, at: Date.now(), ...sol })) saveSidecar(sc);
}

// Busca soluciones pasadas parecidas a un ticket (por archivos/área/tags —
// determinístico, sin LLM). La sugerencia con IA será una capa opcional.
export function findSimilarSolutions(ticket, { limit = 3 } = {}) {
  const sc = loadSidecar();
  // Excluir la propia solución del ticket (no se sugiere a sí mismo).
  const sols = (sc.solutions || []).filter((s) => String(s.ticketNumber) !== String(ticket.number));
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

// ===== FEATURES: alta manual con id sintético FEAT-n =====
// Un FEATURE es un item de trabajo de TOLKIEN sin ticket de Desk (por ahora:
// el intake automático desde la página Tolkien es fase futura). Reusa TODO el
// ciclo del motor: su id sintético viaja en ticketNumber (el motor ya agrupa
// por [\w-]+), y `kind:'feature'` lo distingue donde importa (pipeline sin
// etapas Desk, branch feature/, nunca deskUpdateAuto). REGLA de clasificación
// (pedido del usuario 2026-07-04): el tablero es SOLO Tolkien — un feature de
// la consola o de otro proyecto NO se da de alta acá.
export function nextFeatureId() {
  const sc = loadSidecar();
  sc.featureSeq = (sc.featureSeq || 0) + 1;
  saveSidecar(sc);
  return `FEAT-${sc.featureSeq}`;
}

export function createFeature({ title, description }) {
  const id = nextFeatureId();
  const all = listBugfixes();
  const entry = {
    sessionId: `feature-${id.toLowerCase()}`, // clave inicial; el 1er chat de trabajo la reemplaza (recordBugfix mergea por ticketNumber)
    chatId: null,
    cwd: null, // se fija al trabajarlo (config.projectDir del chat)
    kind: 'feature',
    ticketNumber: id,
    ticketUrl: null,
    title: `${id} — ${String(title).slice(0, 100)}`,
    spec: String(description || '').slice(0, 4000), // enunciado original, permanente
    summary: String(description || '').slice(0, 4000),
    files: [],
    status: 'pendiente',
    branch: null,
    prUrl: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  addEvent(entry, 'creado', { feature: id });
  saveBugfixes([entry, ...all]);
  return entry;
}

// ===== Curación de dimensiones (tags/area/severity/meta) por ticket =====
export function setTicketMeta(ticketNumber, patch) {
  const sc = loadSidecar();
  sc.tickets = sc.tickets || {};
  const cur = sc.tickets[String(ticketNumber)] || {};
  sc.tickets[String(ticketNumber)] = { ...cur, ...patch };
  saveSidecar(sc);
}
