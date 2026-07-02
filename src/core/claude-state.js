// core/claude-state.js — estado REAL de Claude Code por carpeta.
//
// Lee ~/.cwc-state/*.json (los escribe bin/cwc-observe.js desde la statusline
// y los hooks de Claude Code): { sessionId, cwd, model, status, ts }.
// Es la fuente primaria de estado (working/waiting) y de modelo en tiempo
// real; la inferencia por transcript (claude-model.js) queda como fallback.
//
// Limitación conocida: el mapeo a sesiones tmux es POR CARPETA — dos sesiones
// de Claude en el mismo cwd comparten estado (documentado en contexto-ui §4.3).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeId } from './claude-model.js';

const DIR = path.join(os.homedir(), '.cwc-state');
const STALE_MS = 10 * 60 * 1000;      // "working" sin señales > 10 min => stale
const PRUNE_MS = 7 * 24 * 3600 * 1000; // archivos > 7 días se eliminan
const CACHE_MS = 2000;

let cache = { t: 0, byCwd: new Map() };

function scan() {
  const byCwd = new Map();
  let files = [];
  try { files = fs.readdirSync(DIR); } catch { return byCwd; }
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
    if (!st.cwd || st.status === 'ended') continue;
    const cur = byCwd.get(st.cwd);
    if (!cur || (st.ts || 0) > (cur.ts || 0)) byCwd.set(st.cwd, st);
  }
  return byCwd;
}

// Devuelve { status: 'working'|'waiting'|'stale', ts, model } o null.
export function stateForCwd(absCwd) {
  if (!absCwd) return null;
  const now = Date.now();
  if (now - cache.t > CACHE_MS) cache = { t: now, byCwd: scan() };
  const st = cache.byCwd.get(absCwd);
  if (!st) return null;
  let status = st.status === 'working' || st.status === 'waiting' ? st.status : 'waiting';
  if (status === 'working' && now - (st.ts || 0) > STALE_MS) status = 'stale';
  const model = st.model?.id ? describeId(st.model.id) : null;
  return { status, ts: st.ts || 0, model };
}
