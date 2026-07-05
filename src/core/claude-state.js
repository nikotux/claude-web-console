// core/claude-state.js — estado REAL de Claude Code por carpeta.
//
// Lee ~/.cwc-state/*.json (los escribe bin/cwc-observe.js desde la statusline
// y los hooks de Claude Code): { sessionId, cwd, model, status, ts }.
// Es la fuente primaria de estado (working/waiting) y de modelo en tiempo
// real; la inferencia por transcript (claude-model.js) queda como fallback.
//
// Identidad: mapeo PRIMARIO por pane de tmux (tmuxPane que captura el
// observador desde $TMUX_PANE — cada sesión tmux tiene su estado propio) con
// FALLBACK por carpeta para estados viejos sin pane (o claudes fuera de tmux).
// La limitación histórica "dos sesiones en el mismo cwd comparten estado"
// (contexto-ui §4.3) solo persiste en ese fallback: con pane presente, una
// sesión trabajando ya no es pisada por la statusline de una hermana ociosa
// del mismo cwd (bug del Pac-Man con el interfono, 2026-07-05).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeId } from './claude-model.js';

const DIR = path.join(os.homedir(), '.cwc-state');
const STALE_MS = 10 * 60 * 1000;      // "working" sin señales > 10 min => stale
const PRUNE_MS = 7 * 24 * 3600 * 1000; // archivos > 7 días se eliminan
const CACHE_MS = 2000;

let cache = { t: 0, byCwd: new Map(), byPane: new Map() };

function scan() {
  const byCwd = new Map();
  const byPane = new Map();
  let files = [];
  try { files = fs.readdirSync(DIR); } catch { return { byCwd, byPane }; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(DIR, f);
    let st;
    try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (now - (st.ts || 0) > PRUNE_MS) {
      try { fs.rmSync(p, { force: true }); } catch { /* noop */ }
      continue;
    }
    if (st.status === 'ended') continue;
    // El más fresco gana en ambos mapas (dos sessionIds en el mismo pane =
    // claude reiniciado dentro de la misma tmux: vale el último).
    if (st.cwd) {
      const cur = byCwd.get(st.cwd);
      if (!cur || (st.ts || 0) > (cur.ts || 0)) byCwd.set(st.cwd, st);
    }
    if (st.tmuxPane) {
      const cur = byPane.get(st.tmuxPane);
      if (!cur || (st.ts || 0) > (cur.ts || 0)) byPane.set(st.tmuxPane, st);
    }
  }
  return { byCwd, byPane };
}

function ensureFresh() {
  const now = Date.now();
  if (now - cache.t > CACHE_MS) cache = { t: now, ...scan() };
}

// Normaliza un registro crudo del scan a { status, ts, model } con staleness.
function describeState(st, now) {
  let status = st.status === 'working' || st.status === 'waiting' ? st.status : 'waiting';
  if (status === 'working' && now - (st.ts || 0) > STALE_MS) status = 'stale';
  const model = st.model?.id ? describeId(st.model.id) : null;
  return { status, ts: st.ts || 0, model };
}

// session_id de la sesión de Claude ACTIVA (no ended) en esa carpeta, o null.
// Lo usa el traspaso TUI(tmux) -> Chat: es el puente al mismo transcript.
export function sessionIdForCwd(absCwd) {
  if (!absCwd) return null;
  ensureFresh();
  return cache.byCwd.get(absCwd)?.sessionId || null;
}

// Devuelve { status: 'working'|'waiting'|'stale', ts, model } o null.
export function stateForCwd(absCwd) {
  if (!absCwd) return null;
  ensureFresh();
  const st = cache.byCwd.get(absCwd);
  return st ? describeState(st, Date.now()) : null;
}

// Estado por pane de tmux (identidad EXACTA de la sesión, sin colisión por
// carpeta). `paneId` = "%N" como lo reporta tmux/$TMUX_PANE. null si ese pane
// no tiene estado (claude viejo que aún no re-tickeó, o sin observador).
export function stateForPane(paneId) {
  if (!paneId) return null;
  ensureFresh();
  const st = cache.byPane.get(paneId);
  return st ? describeState(st, Date.now()) : null;
}
