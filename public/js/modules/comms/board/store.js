// board/store.js — estado ÚNICO del tablero de Comunicaciones (R1: el DOM nunca
// guarda estado). Pestaña primaria = CONTACTO/usuario (dinámica). Clon del
// patrón de bugs/board/store.js.
const initial = () => ({
  threads: [],
  contacts: [],
  projects: [],
  self: null,
  scannedAt: null,
  running: false,
  teamsRunning: false,
  loadError: false,
  tab: null,             // contactId activo (pestaña primaria)
  expanded: new Set(),   // ids de hilo con el detalle abierto
  busy: {},              // acciones en vuelo
  showArchived: false,
  analysis: {},          // threadId -> { status, data, error } (análisis IA lazy)
});

let state = initial();
const listeners = new Set();

export function get() { return state; }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(state); }
export function set(patch) { Object.assign(state, patch); emit(); }
export function mutate(fn) { fn(state); emit(); }
export function reset() { state = initial(); listeners.clear(); }
