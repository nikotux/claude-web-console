// modules/tokens/history-store.js — HISTÓRICO PERSISTENTE de consumo por día.
//
// El módulo tokens calcula el consumo leyendo los transcripts ~/.claude/
// projects/*.jsonl, pero esos archivos los poda el CLI de Claude Code: un día
// viejo puede desaparecer del disco. Para que las gráficas de tendencia
// (semana/mes) sean PERSISTENTES snapshoteamos acá el desglose diario por
// PROYECTO×MODELO en ~/.cwc-data/usage-history.json. Fechas LOCALES (America/
// Bogota, ver time.js) — misma convención que buildSummary o los días no cierran.
//
// Estructura (2026-07-10, filtro por proyecto): days[fecha][proyecto][modelKey]
//   = {tokens,cost}. proyecto ∈ 'consola'|'tolkien'|'otros'|'aprendizaje' (el
//   bucket 'aprendizaje' se resuelve por sessionId en index.js, ver learningIds).
//   Días en formato VIEJO (flat days[fecha][modelKey]) se normalizan a {otros:
//   ...} al leer (transición: se reescriben nuevos en el próximo parse). Días
//   viejos sin la clave 'aprendizaje' simplemente no la tienen (no es retroactivo:
//   su consumo de estudio ya quedó contado en 'consola').
//
// Contrato:
//   • mergeDaily(daily): UPSERT de los días presentes en transcripts + CONGELA
//     los podados. Throttle 5 min (atómica tmp+rename).
//   • readSeries(range, project): serie {range, keys, points, totals} filtrada por
//     proyecto ('all' = suma todos). day (hoy por hora) NO sale de acá (lo sirve
//     buildSummary.hourlyToday, que necesita resolución horaria).
//   • buildSeries(range, entries): helper compartido (lo reusa index.js).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localTodayStr, localDateStartMs, localDayStr } from './time.js';

const HISTORY_FILE = path.join(os.homedir(), '.cwc-data', 'usage-history.json');
const RETAIN_DAYS = 400;
const WRITE_THROTTLE_MS = 300000;

// Orden CANÓNICO por PRECIO (más económico → más costoso): fija el apilado de la
// gráfica (base = más barato) y la leyenda. Es el orden de las `keys` de las
// series; la columna "General" lo INVIERTE (más caro arriba). Pedido del usuario
// 2026-07-10. Precios: haiku $1 < sonnet $3 < opus $5 < fable $10 (input $/M).
const MODEL_ORDER = ['haiku', 'sonnet', 'opus', 'fable', 'unknown'];
// Buckets de proyecto (documental: las funciones de abajo son genéricas sobre las
// claves presentes en cada día, no dependen de esta lista). 'aprendizaje' se
// separa de 'consola' para auditar tokens de estudio vs desarrollo.
const PROJECTS = ['consola', 'tolkien', 'otros', 'aprendizaje'];
const DAY_MS = 86400000;

let lastWriteMs = 0;

function emptyStore() { return { days: {}, months: {}, updatedAt: null }; }

async function loadHistory() {
  try {
    const obj = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8'));
    if (obj && typeof obj === 'object') {
      return { days: obj.days || {}, months: obj.months || {}, updatedAt: obj.updatedAt || null };
    }
  } catch { /* no existe / corrupto → vacío */ }
  return emptyStore();
}

async function writeHistory(store) {
  try {
    await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${HISTORY_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
    await fs.rename(tmp, HISTORY_FILE);
  } catch { /* best-effort */ }
}

// Suma el mapa {modelKey:{tokens,cost}} `src` dentro de `dst` (muta dst).
function addModels(dst, src) {
  for (const [k, v] of Object.entries(src || {})) {
    const d = (dst[k] ||= { tokens: 0, cost: 0 });
    d.tokens += v.tokens || 0;
    d.cost += v.cost || 0;
  }
}

// Devuelve el desglose por proyecto de un día, normalizando el formato viejo
// (flat = {modelKey:{tokens,cost}}) a {otros: ...}. Detección: en el nested el
// primer valor es un mapa de modelos ({haiku:{tokens}}); en el flat es un bucket
// ({tokens: N}) → tiene `.tokens` numérico directo.
function projectsOfDay(dayVal) {
  if (!dayVal) return {};
  const first = Object.values(dayVal)[0];
  if (first && typeof first.tokens === 'number') return { otros: dayVal }; // legacy flat
  return dayVal;
}

// Modelos de un día para el proyecto pedido ('all' = suma todos).
function modelsFor(dayVal, project) {
  const dp = projectsOfDay(dayVal);
  if (project && project !== 'all') return dp[project] || {};
  const out = {};
  for (const p of Object.keys(dp)) addModels(out, dp[p]);
  return out;
}

// UPSERT de los días de transcripts (nested {proyecto:{modelo:bucket}}) + poda.
export async function mergeDaily(daily) {
  if (!daily || typeof daily !== 'object') return;
  const now = Date.now();
  if (now - lastWriteMs < WRITE_THROTTLE_MS) return;

  const store = await loadHistory();
  for (const [day, projects] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    store.days[day] = projects;
  }

  // Poda: días > RETAIN_DAYS se compactan una vez en su mes (por proyecto) y se borran.
  const cutoff = localDayStr(localDateStartMs(localTodayStr()) - RETAIN_DAYS * DAY_MS);
  for (const day of Object.keys(store.days)) {
    if (day < cutoff) {
      const ym = day.slice(0, 7);
      const dp = projectsOfDay(store.days[day]);
      const mMonth = (store.months[ym] ||= {});
      for (const p of Object.keys(dp)) addModels((mMonth[p] ||= {}), dp[p]);
      delete store.days[day];
    }
  }

  store.updatedAt = new Date(now).toISOString();
  lastWriteMs = now;
  await writeHistory(store);
}

// Une las claves de modelo presentes en el orden canónico por PRECIO.
function unionKeys(maps) {
  const present = new Set();
  for (const m of maps) for (const k of Object.keys(m || {})) present.add(k);
  const ordered = MODEL_ORDER.filter((k) => present.has(k));
  for (const k of present) if (!ordered.includes(k)) ordered.push(k);
  return ordered;
}

// Arma {range, keys, points, totals} de entries=[{label, models}]. `totals` =
// suma por modelo del período (columna "General"). COMPARTIDO con index.js.
export function buildSeries(range, entries) {
  const maps = entries.map((e) => e.models || {});
  const totals = {};
  const points = entries.map((e) => {
    let tokens = 0;
    let cost = 0;
    for (const v of Object.values(e.models || {})) { tokens += v.tokens || 0; cost += v.cost || 0; }
    addModels(totals, e.models);
    return { label: e.label, tokens, cost, models: e.models || {} };
  });
  return { range, keys: unionKeys(maps), points, totals };
}

// Serie por día filtrada por proyecto. range: 'week'=7 días · 'month'=30 días.
// project: 'all'|'consola'|'tolkien'|'otros'|'aprendizaje'.
export async function readSeries(range = 'week', project = 'all') {
  const store = await loadHistory();
  const n = range === 'month' ? 30 : 7;
  const anchor = localDateStartMs(localTodayStr());
  const entries = [];
  for (let i = n - 1; i >= 0; i--) {
    const iso = localDayStr(anchor - i * DAY_MS);
    entries.push({ label: iso.slice(5), models: modelsFor(store.days[iso], project) });
  }
  return { ...buildSeries(range, entries), project, updatedAt: store.updatedAt };
}
