// modules/tokens/codex-usage.js — consumo local de CODEX CLI.
//
// Codex no escribe transcripts en ~/.claude/projects: sus sesiones viven en
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl y traen una mezcla muy ruidosa
// de eventos internos (reasoning, function_call_output, diffs, etc.). Este
// módulo extrae SOLO el contador acumulable: cada event_msg token_count trae
// last_token_usage, que representa el delta desde el conteo anterior de ESA
// sesión. El resumen de la consola lo cuenta en TOKENS, con costo 0: no hay
// tarifa local confiable que inventar, y los límites de OpenAI se consultan por
// otro camino (ver getCodexBlock en index.js). Todo es best-effort: un rollout
// corrupto, ausente o todavía escribiéndose no debe romper el resumen de Claude.
import fs from 'node:fs/promises';
import path from 'node:path';
import { hostUser, userSpace } from '../../core/user-space.js';
import { localHourKey } from './time.js';

const codexSessionsDir = (owner) => path.join(userSpace(owner), '.codex', 'sessions');
const FILE_CACHE_MAX = 1000;
const fileCache = new Map();

function emptyBucket() {
  return { input: 0, output: 0, cachedInput: 0, ts: 0 };
}

// Espejo deliberado de projectOf() en index.js, pero acá recibimos el cwd real
// absoluto de Codex (no el nombre de directorio codificado que usa Claude).
// OJO — el separador NO es el mismo en las dos fuentes (bug 2026-07-26): Claude
// codifica el cwd con GUIONES ('-home-nmosquera-tolkien') y su projectOf usa
// `(^|-)tolkien(-|$)`; Codex graba la ruta absoluta REAL, donde el separador es
// la BARRA ('/home/nmosquera/tolkien'). El regex se había copiado tal cual del
// espejo, así que TODO el consumo de Codex hecho en Tolkien caía en 'otros'
// (335 entradas mal atribuidas al detectarlo). Acá se aceptan AMBOS separadores
// para que el worktree ('/home/nmosquera/tolkien-wt-phase3') y un subdirectorio
// ('/home/nmosquera/tolkien/src') también resuelvan, sin tragarse un falso
// positivo tipo '/home/nmosquera/mitolkien'.
function projectOfPath(absPath) {
  if (/claude-web-console|healthfix-wt-/.test(absPath || '')) return 'consola';
  if (/(^|[-/])tolkien([-/]|$)/.test(absPath || '')) return 'tolkien';
  return 'otros';
}

async function collectRollouts(dir, out) {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await collectRollouts(full, out);
    } else if (ent.isFile() && /^rollout-.*\.jsonl$/.test(ent.name)) {
      out.push(full);
    }
  }
}

async function parseFile(file) {
  const txt = await fs.readFile(file, 'utf8');
  const rows = {};
  let cwd = '';
  let model = 'gpt-5';

  for (const line of txt.split('\n')) {
    if (!line) continue;
    if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'session_meta') {
      if (typeof obj.payload?.cwd === 'string') cwd = obj.payload.cwd;
      continue;
    }
    if (obj.type === 'turn_context') {
      if (typeof obj.payload?.model === 'string' && obj.payload.model) model = obj.payload.model;
      continue;
    }
    if (obj.type !== 'event_msg' || obj.payload?.type !== 'token_count') continue;

    const usage = obj.payload?.info?.last_token_usage;
    if (!usage) continue;
    const ts = Date.parse(obj.timestamp || '') || 0;
    const hourKey = ts ? localHourKey(ts) : 'unknown';
    const key = `${hourKey}\t${model}`;
    const b = (rows[key] ||= emptyBucket());
    const cachedInput = usage.cached_input_tokens || 0;
    // GOTCHA verificado en flow.js / rollouts: input_tokens YA INCLUYE
    // cached_input_tokens, y total_tokens = input_tokens + output_tokens. Para
    // que input+output+cachedInput no cuente el cache dos veces, lo descontamos
    // del input "nuevo" y lo mandamos aparte como cache read.
    b.cachedInput += cachedInput;
    b.input += Math.max(0, (usage.input_tokens || 0) - cachedInput);
    b.output += usage.output_tokens || 0;
    b.ts = Math.max(b.ts, ts);
  }

  const proj = projectOfPath(cwd);
  const entries = Object.entries(rows).map(([key, b]) => {
    const [hourKey, rowModel] = key.split('\t');
    return {
      proj,
      hourKey,
      model: rowModel || 'gpt-5',
      input: b.input,
      output: b.output,
      cachedInput: b.cachedInput,
      ts: b.ts,
    };
  });
  return entries;
}

async function parseCached(file) {
  let st;
  try { st = await fs.stat(file); } catch { return { entries: [], mtimeMs: 0 }; }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    fileCache.delete(file);
    fileCache.set(file, cached);
    return { entries: cached.data, mtimeMs: st.mtimeMs };
  }

  let data = [];
  try { data = await parseFile(file); } catch { data = []; }
  fileCache.delete(file);
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  if (fileCache.size > FILE_CACHE_MAX) {
    const oldestKey = fileCache.keys().next().value;
    fileCache.delete(oldestKey);
  }
  return { entries: data, mtimeMs: st.mtimeMs };
}

export async function scanCodexUsage(owner = hostUser()) {
  const sessionsDir = codexSessionsDir(owner);
  try {
    const st = await fs.stat(sessionsDir);
    if (!st.isDirectory()) return { entries: [], lastMtime: 0 };

    const files = [];
    await collectRollouts(sessionsDir, files);

    const entries = [];
    let lastMtime = 0;
    for (const file of files) {
      const parsed = await parseCached(file);
      lastMtime = Math.max(lastMtime, parsed.mtimeMs || 0);
      entries.push(...parsed.entries);
    }
    return { entries, lastMtime };
  } catch {
    return { entries: [], lastMtime: 0 };
  }
}
