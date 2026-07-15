// Manguera de tokens: estima el caudal reciente (tokens/segundo) leyendo solo
// bytes nuevos apendeados a los logs locales de Claude y Codex. Fuentes:
//   - Claude: ~/.claude/projects/<proj>/*.jsonl
//   - Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// BASELINE crítico: cuando un archivo aparece por primera vez, se fija el cursor
// al tamaño actual y NO se parsea su histórico. Así el consumo viejo ya presente
// en disco no se transforma en una ráfaga falsa; solo cuenta lo que se apende
// después de empezar a observar.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LEDGER_MS = 120000;
const RECENT_MS = 5 * 60 * 1000;
const INSTANT_MS = 10000;
const MAX_APPEND = 4 * 1024 * 1024;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const cursors = new Map();
const seenClaudeIds = new Map();
const fileCwd = new Map();
const claudeTotals = new Map();
const codexTotals = new Map();
let ledger = [];
let inFlight = false;
let lastSummary = {
  claude: { tps: 0, tokens60: 0, lastTs: 0 },
  codex: { tps: 0, tokens60: 0, lastTs: 0 },
  bySession: {},
  byCwd: {},
  updatedAt: new Date().toISOString(),
};

function numeric(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function prune(now) {
  const minTs = now - LEDGER_MS;
  ledger = ledger.filter((e) => e.ts >= minTs);
  for (const [id, ts] of seenClaudeIds) {
    if (ts < minTs) seenClaudeIds.delete(id);
  }
}

function pruneTotals(now) {
  const minTs = now - SESSION_TTL_MS;
  for (const [sid, e] of claudeTotals) {
    if (e.lastTs < minTs) claudeTotals.delete(sid);
  }
  for (const [cwd, e] of codexTotals) {
    if (e.lastTs < minTs) codexTotals.delete(cwd);
  }
}

function addTotal(map, key, ev) {
  if (key == null) return;
  const e = map.get(key) || { total: 0, lastTs: 0 };
  e.total += ev.tokens;
  e.lastTs = Math.max(e.lastTs, ev.ts);
  map.set(key, e);
}

function bumpGroupedTps(grouped, side, key, tokens) {
  if (key == null) return;
  let byKey = grouped.get(side);
  if (!byKey) {
    byKey = new Map();
    grouped.set(side, byKey);
  }
  byKey.set(key, (byKey.get(key) || 0) + tokens);
}

function buildBreakdown(totals, instantGrouped) {
  const out = {};
  for (const [key, e] of totals) {
    if (e.total <= 0) continue;
    out[key] = {
      tps: (instantGrouped.get(key) || 0) / (INSTANT_MS / 1000),
      total: e.total,
      lastTs: e.lastTs,
    };
  }
  return out;
}

function summarize() {
  const now = Date.now();
  prune(now);
  pruneTotals(now);

  const global = {
    claude: { instantTokens: 0, tokens60: 0, lastTs: 0 },
    codex: { instantTokens: 0, tokens60: 0, lastTs: 0 },
  };
  const grouped = new Map();
  for (const e of ledger) {
    const g = global[e.side];
    if (!g) continue;
    if (e.ts >= now - INSTANT_MS) {
      g.instantTokens += e.tokens;
      bumpGroupedTps(grouped, e.side, e.key, e.tokens);
    }
    if (e.ts >= now - 60000) g.tokens60 += e.tokens;
    if (e.ts > g.lastTs) g.lastTs = e.ts;
  }

  return {
    claude: {
      tps: global.claude.instantTokens / (INSTANT_MS / 1000),
      tokens60: global.claude.tokens60,
      lastTs: global.claude.lastTs,
    },
    codex: {
      tps: global.codex.instantTokens / (INSTANT_MS / 1000),
      tokens60: global.codex.tokens60,
      lastTs: global.codex.lastTs,
    },
    bySession: buildBreakdown(claudeTotals, grouped.get('claude') || new Map()),
    byCwd: buildBreakdown(codexTotals, grouped.get('codex') || new Map()),
    updatedAt: new Date().toISOString(),
  };
}

async function listDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readAppendedEvents(file, extractEvent) {
  const now = Date.now();
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return [];
  }
  if (st.mtimeMs < now - RECENT_MS) return [];

  let cur = cursors.get(file);
  if (!cur) {
    cursors.set(file, { offset: st.size, size: st.size });
    return [];
  }
  if (st.size < cur.offset) cur.offset = 0;
  if (st.size <= cur.offset) {
    cur.size = st.size;
    return [];
  }

  const toRead = Math.min(st.size - cur.offset, MAX_APPEND);
  const buf = Buffer.allocUnsafe(toRead);
  let bytesRead = 0;
  try {
    const fh = await fs.open(file, 'r');
    try {
      ({ bytesRead } = await fh.read(buf, 0, toRead, cur.offset));
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return [];
  }

  if (bytesRead <= 0) {
    cur.size = st.size;
    return [];
  }

  const chunk = buf.subarray(0, bytesRead);
  const lastNL = chunk.lastIndexOf(0x0A);
  let consumed;
  if (lastNL >= 0) {
    consumed = chunk.subarray(0, lastNL + 1);
  } else if (bytesRead >= MAX_APPEND) {
    cur.offset += bytesRead;
    cur.size = st.size;
    return [];
  } else {
    cur.size = st.size;
    return [];
  }

  cur.offset += consumed.length;
  cur.size = st.size;

  const out = [];
  for (const line of consumed.toString('utf8').split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = extractEvent(obj, now);
    if (ev && ev.tokens > 0) out.push(ev);
  }
  return out;
}

async function readCodexCwd(file) {
  if (fileCwd.has(file)) return fileCwd.get(file);

  let cwd = null;
  const buf = Buffer.allocUnsafe(4096);
  try {
    const fh = await fs.open(file, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const first = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0];
      if (first) {
        const obj = JSON.parse(first);
        if (obj?.type === 'session_meta') cwd = obj.payload?.cwd || obj.cwd || null;
      }
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    cwd = null;
  }
  fileCwd.set(file, cwd);
  return cwd;
}

function extractClaudeEvent(obj, now) {
  if (obj?.type !== 'assistant') return null;
  const msg = obj.message;
  const id = msg?.id;
  const u = msg?.usage;
  if (!id || !u || seenClaudeIds.has(id)) return null;
  const tokens = numeric(u.input_tokens)
    + numeric(u.output_tokens)
    + numeric(u.cache_creation_input_tokens)
    + numeric(u.cache_read_input_tokens);
  seenClaudeIds.set(id, Date.parse(obj.timestamp || '') || now);
  return {
    ts: Date.parse(obj.timestamp || '') || now,
    tokens,
  };
}

function extractCodexEvent(obj, now) {
  if (obj?.type !== 'event_msg' || obj.payload?.type !== 'token_count') return null;
  const usage = obj.payload?.info?.last_token_usage;
  if (!usage) return null;
  const tokens = typeof usage.total_tokens === 'number'
    ? numeric(usage.total_tokens)
    : numeric(usage.input_tokens) + numeric(usage.output_tokens);
  return {
    ts: Date.parse(obj.timestamp || '') || now,
    tokens,
  };
}

async function scanClaude() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const projects = await listDir(base);
  for (const dirent of projects) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(base, dirent.name);
    const files = await listDir(dir);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sid = path.basename(f.name, '.jsonl');
      const events = await readAppendedEvents(path.join(dir, f.name), extractClaudeEvent);
      for (const ev of events) {
        ledger.push({ ...ev, side: 'claude', key: sid });
        addTotal(claudeTotals, sid, ev);
      }
    }
  }
}

function localDayDirs() {
  const days = [];
  for (let i = 0; i < 2; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    days.push(path.join(os.homedir(), '.codex', 'sessions', yyyy, mm, dd));
  }
  return days;
}

async function scanCodex() {
  for (const dir of localDayDirs()) {
    const files = await listDir(dir);
    for (const f of files) {
      if (!f.isFile() || !/^rollout-.*\.jsonl$/.test(f.name)) continue;
      const file = path.join(dir, f.name);
      const cwd = await readCodexCwd(file);
      const events = await readAppendedEvents(file, extractCodexEvent);
      for (const ev of events) {
        ledger.push({ ...ev, side: 'codex', key: cwd });
        addTotal(codexTotals, cwd, ev);
      }
    }
  }
}

export async function computeFlow() {
  if (inFlight) return lastSummary;
  inFlight = true;
  try {
    await scanClaude();
    await scanCodex();
  } finally {
    inFlight = false;
  }
  lastSummary = summarize();
  return lastSummary;
}
