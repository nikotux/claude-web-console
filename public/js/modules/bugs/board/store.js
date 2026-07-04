// board/store.js — estado ÚNICO del tablero (R1: el DOM nunca guarda estado).
//
// Todo lo que antes vivía en variables del closure + atributos del DOM
// ([hidden], dataset.loaded, spans de frescura) vive acá. El render es una
// función pura de este estado; re-renderizar es SIEMPRE seguro (por eso el
// auto-refresh de GitHub ya no se pausa con un detalle abierto).
//
// API mínima sin librerías: get() / set(patch) / mutate(fn) / subscribe(fn).
// mutate(fn) es para tocar estructuras anidadas (expanded, live, desk…);
// cualquier cambio emite a los suscriptores (el render de index.js).

const initial = () => ({
  // ----- datos -----
  entries: [],        // tickets del motor aplanados por ticketToRow
  ghRows: [],         // PRs solo-GitHub (refresh-prs)
  triage: { updatedAt: null, tickets: [], running: false },
  loadError: false,   // GET /tickets falló (tabla muestra el error)

  // ----- frescura -----
  lastGhAt: null,     // última sync GitHub (auto, barata)
  lastDeskAt: null,   // última sync Desk bulk (bajo botón, tokens)
  ghError: false,     // el último ghSync falló (header lo refleja)

  // ----- estado UI (antes en el DOM) -----
  expanded: new Set(),   // claves de fila con el detalle abierto (rowKey)
  archOpen: false,       // sección 📦 Archivo desplegada
  busy: {},              // botones en vuelo: send/scan/ghsync/desksync/act:<key>
  deskSyncProgress: null, // {done,total} del bulk "🎫 Desk"

  // ----- paneles lazy del detalle (antes dataset.loaded + innerHTML) -----
  // Cada slot: { loading:true } | { running:true } | { data|st } | { error }.
  // Sobreviven al re-render: el detalle abierto se repinta desde acá.
  live: {},    // prNumber -> panel "GitHub en vivo" (pr-live)
  inv: {},     // prNumber -> investigación a fondo del PR
  tktInv: {},  // ticket   -> investigación de contexto (sin PR)
  desk: {},    // ticket   -> estado en vivo de Zoho Desk
});

let state = initial();
const listeners = new Set();

export function get() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() { for (const fn of listeners) fn(state); }

export function set(patch) {
  Object.assign(state, patch);
  emit();
}

export function mutate(fn) {
  fn(state);
  emit();
}

// El módulo es singleton (los import de ES se cachean): cada apertura del
// tablero arranca de cero — sin filas viejas ni suscriptores muertos.
export function reset() {
  state = initial();
  listeners.clear();
}

// ===== Puente motor→filas: un Ticket consolidado se aplana a la forma que
// esperan labels/render (prEstado, pipelineHtml, prCellFor, deskCellFor,
// detailHtml). 1 fila = 1 TICKET (sus chats van en attempts).
export function ticketToRow(t) {
  const gh = t.external?.github || [];
  // "mejor" PR: mergeado > abierto > cerrado (el que define el estado).
  const best = gh.find((p) => p.state === 'merged') || gh.find((p) => p.state === 'open') || gh[0] || null;
  const desk = t.external?.desk || {};
  const mainAttempt = t.attempts.find((a) => a.pr) || t.attempts.find((a) => a.files?.length) || t.attempts[t.attempts.length - 1] || {};
  const allFiles = [...new Set(t.attempts.flatMap((a) => a.files || []))];
  const deskStatus = desk.answered ? 'ok' : desk.updating ? 'updating' : desk.error ? 'error' : null;
  const status = best ? (best.state === 'merged' ? 'subido' : 'pendiente') : (allFiles.length ? 'pendiente' : 'pendiente');
  return {
    // identidad + acción (las acciones operan sobre el attempt principal)
    sessionId: mainAttempt.sessionId || null,
    ticketNumber: t.number, ticketUrl: t.url, title: t.title,
    summary: mainAttempt.summary || (t.attempts.find((a) => a.summary)?.summary) || '',
    files: allFiles, stats: best ? mainAttempt.stats : mainAttempt.stats,
    branch: mainAttempt.branch || null,
    // PR consolidado (el "mejor")
    prNumber: best?.number || null, prUrl: best?.url || null, prState: best?.state || null,
    mergedBy: best?.mergedBy || null, mergedAt: best?.mergedAt || null,
    // Desk consolidado
    deskStatus, deskReplied: desk.replied || null, deskResolved: desk.resolved || null,
    deskClosed: desk.closed || null, deskStatusText: desk.statusText || null, deskCheckedAt: desk.checkedAt || null,
    // estado del motor (derivado) + historial unificado + attempts para el detalle
    status, resolution: t.resolution, engineState: t.state,
    history: t.history || [], attempts: t.attempts || [], archived: t.archived,
    allSessionIds: t.attempts.map((a) => a.sessionId).filter(Boolean),
    similar: t.similar || [],
    feedback: t.external?.feedback || [], // comentarios de Chris persistidos
  };
}
