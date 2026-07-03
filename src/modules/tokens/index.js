// modules/tokens/index.js — uso y costo de tokens de Claude Code.
//
// Lee las transcripciones ~/.claude/projects/<proj>/*.jsonl, deduplica por
// message.id (cada mensaje aparece repetido en el jsonl) y suma
// input/output/cache. El costo usa precios OFICIALES por modelo. La misma
// contabilidad que token-usage.sh del proyecto `estadisticas`.
//
// Se cachea por archivo según mtime+size: solo se re-parsean los que cambiaron.
//
// HTTP:
//   GET /api/tokens/summary  -> { totals, today, projects[], updatedAt }
//   Cada proyecto incluye `models[]` (tokens+costo por CADA modelo usado, no
//   solo el principal) e input/output/cache totales, para el desglose del panel.
//   GET /api/tokens/limits   -> { limits[], subscription, updatedAt }
//   % usado y reset de las ventanas del PLAN (sesión 5 h / semanales), vía el
//   endpoint OAuth de Anthropic con el token del CLI (solo lectura, ver abajo).
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { keyOf } from '../../core/claude-model.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Precio de input por millón, por modelo; el resto se deriva del input.
// OJO: el costo es un EQUIVALENTE a precios de API — la suscripción del CLI
// no factura por token (no existe "gasto real" consultable; la Admin
// Usage & Cost API exige organización + admin key, no aplica acá).
function pin(m) {
  if (/fable|mythos/.test(m)) return 10.0;
  if (/opus/.test(m)) return 5.0;
  if (/sonnet/.test(m)) return 3.0;
  if (/haiku/.test(m)) return 1.0;
  return 5.0; // fallback: modelos no reconocidos se tasan como Opus
}
function pout(m) {
  if (/fable|mythos/.test(m)) return 50.0;
  if (/opus/.test(m)) return 25.0;
  if (/sonnet/.test(m)) return 15.0;
  if (/haiku/.test(m)) return 5.0;
  return 25.0;
}
function costOf(m, { input, output, cw1h, cw5m, cr }) {
  const i = pin(m);
  return (
    (input / 1e6) * i +
    (output / 1e6) * pout(m) +
    (cw1h / 1e6) * (i * 2.0) +
    (cw5m / 1e6) * (i * 1.25) +
    (cr / 1e6) * (i * 0.1)
  );
}

// Caché por archivo: path -> { mtimeMs, size, rows: {`day\tmodel`: {tok...}} }
const fileCache = new Map();

function emptyBucket() {
  return { input: 0, output: 0, cw1h: 0, cw5m: 0, cr: 0 };
}
function addInto(dst, src) {
  dst.input += src.input; dst.output += src.output;
  dst.cw1h += src.cw1h; dst.cw5m += src.cw5m; dst.cr += src.cr;
}

// Parsea un jsonl deduplicando por message.id -> rows por (día, modelo).
async function parseFile(file) {
  const txt = await fs.readFile(file, 'utf8');
  const seen = new Set();
  const rows = {};
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj.message;
    if (!msg || !msg.usage || !msg.id) continue;
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    const u = msg.usage;
    const day = (obj.timestamp || '').slice(0, 10) || 'unknown';
    const model = msg.model || 'unknown';
    const key = `${day}\t${model}`;
    const b = (rows[key] ||= emptyBucket());
    b.input += u.input_tokens || 0;
    b.output += u.output_tokens || 0;
    b.cw1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    b.cw5m += u.cache_creation?.ephemeral_5m_input_tokens || 0;
    b.cr += u.cache_read_input_tokens || 0;
  }
  return rows;
}

async function rowsForFile(file) {
  let st;
  try { st = await fs.stat(file); } catch { return {}; }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.rows;
  }
  const rows = await parseFile(file);
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows });
  return rows;
}

// Etiqueta corta del proyecto a partir del nombre de directorio codificado.
function labelFor(dirName) {
  const stripped = dirName.replace(/^-home-[^-]+-?/, '');
  return stripped || '~';
}

async function buildSummary() {
  const today = new Date().toISOString().slice(0, 10);
  let dirs = [];
  try {
    dirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { totals: emptyBucket(), today: emptyBucket(), projects: [], updatedAt: today };
  }

  const totals = emptyBucket();
  let totalCost = 0;
  const todayB = emptyBucket();
  let todayCost = 0;
  const projects = [];

  for (const dir of dirs) {
    const projPath = path.join(PROJECTS_DIR, dir);
    let files = [];
    let lastMtime = 0;
    try {
      const ents = await fs.readdir(projPath);
      files = ents.filter((f) => f.endsWith('.jsonl')).map((f) => path.join(projPath, f));
    } catch { continue; }
    if (!files.length) continue;

    const projB = emptyBucket();
    let projCost = 0;
    const modelStats = {}; // model -> { tokens, cost }

    for (const file of files) {
      let fileMtime = 0;
      try { fileMtime = (await fs.stat(file)).mtimeMs; } catch { /* noop */ }
      lastMtime = Math.max(lastMtime, fileMtime);
      const rows = await rowsForFile(file);
      for (const [key, b] of Object.entries(rows)) {
        const [day, model] = key.split('\t');
        const c = costOf(model, b);
        const tok = b.input + b.output + b.cw1h + b.cw5m + b.cr;
        addInto(projB, b); projCost += c;
        addInto(totals, b); totalCost += c;
        // lastMtime por (proyecto, modelo): alimenta la vista por modelo del
        // panel Uso ("últimos proyectos que usaron este modelo").
        const ms = (modelStats[model] ||= { tokens: 0, cost: 0, lastMtime: 0 });
        ms.tokens += tok; ms.cost += c;
        ms.lastMtime = Math.max(ms.lastMtime, fileMtime);
        if (day === today) { addInto(todayB, b); todayCost += c; }
      }
    }

    const tokens = projB.input + projB.output + projB.cw1h + projB.cw5m + projB.cr;
    if (tokens === 0) continue;
    // Desglose por modelo (consumo de CADA modelo usado, no solo el principal).
    // Se descartan entradas sin tokens (p.ej. "<synthetic>", mensajes internos
    // de Claude Code sin uso real).
    const models = Object.entries(modelStats)
      .map(([model, v]) => ({ model, key: keyOf(model), tokens: v.tokens, cost: v.cost, lastMtime: v.lastMtime }))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.cost - a.cost);
    projects.push({
      name: dir, label: labelFor(dir), tokens, cost: projCost, lastMtime,
      input: projB.input, output: projB.output,
      cacheWrite: projB.cw1h + projB.cw5m, cacheRead: projB.cr,
      models,
    });
  }

  projects.sort((a, b) => b.cost - a.cost);
  const tok = (b) => b.input + b.output + b.cw1h + b.cw5m + b.cr;
  return {
    totals: { ...totals, tokens: tok(totals), cost: totalCost },
    today: { ...todayB, tokens: tok(todayB), cost: todayCost },
    projects,
    updatedAt: new Date().toISOString(),
  };
}

// Cache del summary completo (evita re-escanear en ráfagas de polling).
let summaryCache = null;
let summaryAt = 0;
const SUMMARY_TTL_MS = 4000;

// ===== Límites del PLAN (lo que muestra claude.ai): % por ventana + reset ==
// Fuente: el endpoint OAuth de uso de Anthropic — el MISMO que consulta el
// /usage del CLI — con el accessToken de ~/.claude/.credentials.json (la
// credencial que ya hereda el Agent SDK; acá SOLO se lee, jamás se escribe
// ni se refresca: si venció, el error lo dice y se arregla abriendo claude).
// El token nunca sale hacia el cliente: el server hace de proxy.
const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const LIMIT_LABELS = {
  session: 'Sesión (5 h)',
  weekly_all: 'Semana · todos los modelos',
};

async function fetchPlanLimits() {
  let oauth;
  try {
    oauth = JSON.parse(await fs.readFile(CREDS_FILE, 'utf8')).claudeAiOauth;
  } catch {
    throw new Error('No se pudieron leer las credenciales del CLI (~/.claude/.credentials.json).');
  }
  if (!oauth?.accessToken) throw new Error('Sin token OAuth del CLI.');
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    throw new Error('El token del CLI está vencido: abrí una sesión de claude para refrescarlo.');
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: ctl.signal,
    });
  } catch {
    throw new Error('No se pudo consultar a Anthropic (¿sin salida a internet?).');
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`Anthropic respondió ${res.status}.`);
  const data = await res.json();

  // Normalización: preferimos el array `limits` (trae también las ventanas
  // por modelo, p.ej. "Semana · Fable"); si no vino, caemos a los campos
  // planos five_hour/seven_day.
  const limits = (Array.isArray(data.limits) ? data.limits : [])
    .filter((l) => l && typeof l.percent === 'number')
    .map((l) => ({
      kind: l.kind,
      label: LIMIT_LABELS[l.kind]
        || (l.scope?.model?.display_name ? `Semana · ${l.scope.model.display_name}` : l.kind),
      percent: l.percent,
      severity: l.severity || 'normal',
      isActive: !!l.is_active,
      resetsAt: l.resets_at || null,
    }));
  if (!limits.length) {
    for (const [kind, src] of [['session', data.five_hour], ['weekly_all', data.seven_day]]) {
      if (src && src.utilization != null) {
        limits.push({
          kind, label: LIMIT_LABELS[kind], percent: src.utilization,
          severity: 'normal', isActive: false, resetsAt: src.resets_at || null,
        });
      }
    }
  }
  return {
    limits,
    subscription: oauth.subscriptionType || null,
    updatedAt: new Date().toISOString(),
  };
}

// Cache de límites: consulta remota, TTL más largo que el summary local.
let limitsCache = null;
let limitsAt = 0;
const LIMITS_TTL_MS = 60000;

export default {
  name: 'tokens',

  registerHttp(router) {
    const r = express.Router();

    // ?fresh=1 saltea el TTL del summary (botón Actualizar del modal Uso);
    // el caché por archivo (mtime+size) queda: solo re-parsea lo que cambió.
    r.get('/summary', async (req, res) => {
      const now = process.hrtime.bigint();
      const ms = Number(now) / 1e6;
      if (!req.query.fresh && summaryCache && ms - summaryAt < SUMMARY_TTL_MS) {
        return res.json(summaryCache);
      }
      try {
        summaryCache = await buildSummary();
        summaryAt = ms;
        res.json(summaryCache);
      } catch (err) {
        res.status(500).json({ error: 'No se pudo calcular el uso de tokens.' });
      }
    });

    // Límites del plan (ventanas de claude.ai): % usado y hora de reset.
    // ?fresh=1 saltea el TTL (botón Actualizar del modal Uso).
    r.get('/limits', async (req, res) => {
      // Reloj MONOTÓNICO (como /summary): Date.now() retrocede con ajustes
      // NTP y dejaba el caché de límites "fresco" para siempre.
      const now = Number(process.hrtime.bigint()) / 1e6;
      if (!req.query.fresh && limitsCache && now - limitsAt < LIMITS_TTL_MS) {
        return res.json(limitsCache);
      }
      try {
        limitsCache = await fetchPlanLimits();
        limitsAt = now;
        res.json(limitsCache);
      } catch (err) {
        res.status(502).json({ error: err.message || 'No se pudieron leer los límites del plan.' });
      }
    });

    router.use('/tokens', r);
  },
};
