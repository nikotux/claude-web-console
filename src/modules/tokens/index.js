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
//   GET /api/tokens/summary  -> { totals, today, projects[], engines[], updatedAt }
//   Cada proyecto incluye `models[]` (tokens+costo por CADA modelo usado, no
//   solo el principal) e input/output/cache totales, para el desglose del panel.
//   `engines[]` es el MISMO desglose pero atribuido al motor de origen (chat,
//   auto-fix de salud, tolkien, cli, headless) — alimenta el detalle del modal
//   Uso. `models[].lastMtime` es el timestamp del ÚLTIMO mensaje de ESE modelo
//   (no el mtime del archivo): así el Pac-Man "consumiendo ahora" no titila en
//   modelos secundarios del mismo transcript.
//   GET /api/tokens/limits   -> { limits[], credits, subscription, updatedAt, stale? }
//   % usado y reset de las ventanas del PLAN (sesión 5 h / semanales) + los
//   CRÉDITOS de uso extra (extra_usage), vía el endpoint OAuth de Anthropic con
//   el token del CLI (solo lectura). El último resultado bueno se PERSISTE en
//   ~/.cwc-data/plan-limits.json: ante 429/corte de red/reinicio se sirve ese
//   snapshot marcado `stale:true` en vez de perder el dato.
//   GET /api/tokens/history?range=day|week|month -> serie de tiempo por modelo
//   para las gráficas de tendencia del modal Uso. Sale del histórico PERSISTENTE
//   (~/.cwc-data/usage-history.json, ver history-store.js): buildSummary calcula
//   el desglose diario por modelo y lo snapshotea (independiente de la poda de
//   transcripts que hace el CLI). Reemplazó al viejo POST /reset (2026-07-10):
//   con historial persistente no hace falta "poner en cero".
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { keyOf } from '../../core/claude-model.js';
import { runAdaptivePool } from '../health/pool.js';
import {
  mergeDaily, readSeries, buildSeries,
  // Fuente única (BUG-21): antes DAY_MS/PROJECT_KEYS/mergeModels estaban duplicados acá.
  DAY_MS, PROJECTS as PROJECT_KEYS, addModels as mergeModels,
} from './history-store.js';
import { localHourKey, localHourStartMs, localTodayStr, localDateStartMs, localDayStr, localHourNow } from './time.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Estado de la consola: mapea sessionId -> chat. Se usa para atribuir cada
// transcript a su MOTOR de origen (un .jsonl cuyo sessionId figura acá salió
// del motor de conversaciones; el resto se clasifica por directorio/entrypoint).
const CHATS_FILE = path.join(os.homedir(), '.cwc-data', 'chats.json');
// Registro DURABLE append-only de sessionIds que ALGUNA VEZ fueron chat (lo
// escribe el módulo chat, nunca se poda): chats.json solo tiene los VIVOS —
// un chat cerrado/olvidado (FORGET_MS) salía de ahí y su transcript caía en
// "Motores headless" aunque fuera una conversación normal en fable/opus.
const CHAT_IDS_FILE = path.join(os.homedir(), '.cwc-data', 'chat-session-ids.json');
// Backfill retroactivo: cada registro de bugfixes.json ES un chat que trabajó
// un ticket (clave sessionId) — recupera la atribución de chats cerrados antes
// de que existiera el registro durable. Solo lectura.
const BUGFIXES_FILE = path.join(os.homedir(), '.cwc-data', 'bugfixes.json');
// Registro DURABLE de sessionIds de las corridas del MÓDULO DE APRENDIZAJE
// (explain/context/analyze), lo escriben esos runners vía learning/session-log.js.
// Esos transcripts corren con cwd = la consola, así que projectOf() los vería como
// 'consola'; este registro permite atribuirlos al bucket 'aprendizaje' aparte
// (pedido del usuario 2026-07-10: auditar tokens de ESTUDIO vs DESARROLLO de la
// consola). Solo lectura. Mismo archivo que learning/session-log.js declara.
const LEARNING_IDS_FILE = path.join(os.homedir(), '.cwc-data', 'learning-session-ids.json');

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
// LRU acotado: sin límite, cada .jsonl visto alguna vez (proyectos/sesiones
// viejas incluidas) quedaba en memoria para siempre → crecimiento sin fin.
const fileCache = new Map();
const FILE_CACHE_MAX = 1000;

function emptyBucket() {
  return { input: 0, output: 0, cw1h: 0, cw5m: 0, cr: 0 };
}
function addInto(dst, src) {
  dst.input += src.input; dst.output += src.output;
  dst.cw1h += src.cw1h; dst.cw5m += src.cw5m; dst.cr += src.cr;
}

// Parsea un jsonl deduplicando por message.id. Devuelve:
//   rows      -> buckets por (HORA local, modelo) — clave 'YYYY-MM-DDTHH\tmodel'.
//                Granularidad horaria (no diaria) para poder derivar las horas
//                de HOY (gráfica día) y la ventana de 5 h sin re-parsear; el día
//                se obtiene con hourKey.slice(0,10). Cacheable: la clave es tiempo
//                ABSOLUTO local, no cambia con `now`.
//   modelTs   -> timestamp (ms) del ÚLTIMO mensaje de CADA modelo (para que
//                "consumiendo ahora" corresponda al modelo real, no al mtime
//                del archivo — un jsonl multi-modelo lo compartía con TODOS
//                sus modelos, así el Haiku de auto-título titilaba en falso
//                en un chat que corre en Sonnet).
//   entrypoint-> 'cli' | 'sdk-ts' | '' (clasifica CLI interactivo vs headless).
async function parseFile(file) {
  const txt = await fs.readFile(file, 'utf8');
  const seen = new Set();
  const rows = {};
  const modelTs = {};
  let entrypoint = '';
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!entrypoint && obj.entrypoint) entrypoint = obj.entrypoint;
    const msg = obj.message;
    if (!msg || !msg.usage || !msg.id) continue;
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    const u = msg.usage;
    const model = msg.model || 'unknown';
    const ts = Date.parse(obj.timestamp || '') || 0;
    if (ts && ts > (modelTs[model] || 0)) modelTs[model] = ts;
    // Bucket por HORA local (fecha derivable con slice(0,10)).
    const hourKey = ts ? localHourKey(ts) : 'unknown';
    const key = `${hourKey}\t${model}`;
    const b = (rows[key] ||= emptyBucket());
    b.input += u.input_tokens || 0;
    b.output += u.output_tokens || 0;
    b.cw1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    b.cw5m += u.cache_creation?.ephemeral_5m_input_tokens || 0;
    b.cr += u.cache_read_input_tokens || 0;
  }
  return { rows, modelTs, entrypoint };
}

// Cachea el parseo por archivo (mtime+size). El valor cacheado es el objeto
// completo { rows, modelTs, entrypoint } — solo se re-parsea lo que cambió.
async function parseCached(file) {
  let st;
  try { st = await fs.stat(file); } catch { return { rows: {}, modelTs: {}, entrypoint: '' }; }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    // Re-insertar mueve la entrada al final (orden de inserción del Map):
    // mantiene el orden de "usado más recientemente" para el LRU de abajo.
    fileCache.delete(file);
    fileCache.set(file, cached);
    return cached.data;
  }
  const data = await parseFile(file);
  fileCache.delete(file);
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  // Evita crecimiento sin límite: con muchos proyectos/sesiones, cada .jsonl
  // nuevo se acumulaba para siempre. Se descarta el menos usado recientemente.
  if (fileCache.size > FILE_CACHE_MAX) {
    const oldestKey = fileCache.keys().next().value;
    fileCache.delete(oldestKey);
  }
  return data;
}

// Etiqueta corta del proyecto a partir del nombre de directorio codificado.
function labelFor(dirName) {
  const stripped = dirName.replace(/^-home-[^-]+-?/, '');
  return stripped || '~';
}

// ===== Atribución por MOTOR de origen (para el detalle del modal Uso) =====
// Reemplaza el desglose por "carpetas" (nombres de directorio crudos) por uno
// legible: qué MOTOR de la consola gastó cada modelo. Heurística determinística
// (0 tokens) sobre datos ya en disco: sessionId ∈ unión chats.json +
// chat-session-ids.json + bugfixes.json (ver buildSummary) + directorio +
// entrypoint. Los motores headless (triage/salud/desk/auto-título) no se
// distinguen entre sí sin instrumentar cada runner, así que quedan agrupados.
const ENGINE_LABELS = {
  chat: 'Chat · conversaciones',
  learning: 'Aprendizaje · estudio',
  healthfix: 'Auto-fix de salud',
  tolkien: 'Tolkien · bugfix',
  cli: 'CLI interactivo',
  headless: 'Motores headless',
};
function classifyEngine(dir, sessionId, entrypoint, chatIds, learningIds) {
  let key;
  // Aprendizaje primero: su transcript comparte cwd/dir con la consola, así que
  // solo el sessionId registrado lo distingue (mismo criterio que el bucket).
  if (learningIds.has(sessionId)) key = 'learning';
  else if (chatIds.has(sessionId)) key = 'chat';
  else if (/healthfix-wt-/.test(dir)) key = 'healthfix';
  else if (/(^|-)tolkien(-|$)/.test(dir)) key = 'tolkien';
  else if (entrypoint === 'cli') key = 'cli';
  else key = 'headless';
  return { key, label: ENGINE_LABELS[key] };
}

// Proyecto de un transcript según su directorio codificado (el filtro por
// proyecto del modal Uso, pedido del usuario 2026-07-10): la propia consola, el
// repo de Tolkien, o "otros". Los worktrees de auto-fix (healthfix-wt-) son
// trabajo SOBRE la consola → cuentan como 'consola'.
// OJO: el bucket 'aprendizaje' NO se detecta acá (su cwd es la consola/Tolkien,
// directorio indistinguible) — se resuelve por sessionId en buildSummary
// (learningIds), que prevalece sobre el resultado de esta función.
function projectOf(dir) {
  if (/claude-web-console|healthfix-wt-/.test(dir)) return 'consola';
  if (/(^|-)tolkien(-|$)/.test(dir)) return 'tolkien';
  return 'otros';
}
// Suma el mapa {modelKey:{tokens,cost}} `src` en `dst` (muta dst).

// Exportada a propósito: el runner de Optimización IA (bin/cwc-optimize-runner.js)
// la usa para cruzar el censo de motores con el CONSUMO REAL (solo lectura de
// transcripts, mismo caché por mtime+size — no toca nada).
export async function buildSummary() {
  const today = localTodayStr();
  const now = Date.now();
  const fiveHAgo = now - 5 * 3600000;
  // Acumuladores (por CLAVE semántica de modelo, anidados por PROYECTO para el
  // filtro Consola/Tolkien/Otros):
  //   hourlyByProj[proyecto][hora 0-23] -> { modelKey: {tokens,cost} }  (gráfica "Día")
  //   h5tok -> tokens totales de las últimas 5 h (ventana de sesión, cuenta entera)
  const hourlyByProj = {};
  let h5tok = 0;
  let dirs = [];
  try {
    dirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { totals: emptyBucket(), today: emptyBucket(), projects: [], engines: [], updatedAt: today };
  }

  // sessionIds de los chats de la consola (para atribuir transcripts al motor
  // de conversaciones). UNIÓN de tres fuentes — cada una best-effort (si
  // falta un archivo, las demás siguen; sin ninguna: headless/cli, no rompe):
  // chats vivos + registro durable de todo-lo-que-fue-chat + bugfixes.
  const chatIds = new Set();
  try {
    const arr = JSON.parse(await fs.readFile(CHATS_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const c of arr) if (c?.sessionId) chatIds.add(c.sessionId);
  } catch { /* noop */ }
  try {
    const arr = JSON.parse(await fs.readFile(CHAT_IDS_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string' && id) chatIds.add(id);
  } catch { /* noop */ }
  try {
    const arr = JSON.parse(await fs.readFile(BUGFIXES_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const r of arr) if (r?.sessionId) chatIds.add(r.sessionId);
  } catch { /* noop */ }

  // sessionIds de las corridas del MÓDULO DE APRENDIZAJE (explain/context/analyze):
  // corren con cwd = la consola/Tolkien, pero se cuentan en el bucket 'aprendizaje'
  // APARTE, no en 'consola'/'tolkien' (auditar estudio vs desarrollo). Best-effort.
  const learningIds = new Set();
  try {
    const arr = JSON.parse(await fs.readFile(LEARNING_IDS_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string' && id) learningIds.add(id);
  } catch { /* noop */ }

  const totals = emptyBucket();
  let totalCost = 0;
  const todayB = emptyBucket();
  let todayCost = 0;
  const projects = [];
  // Desglose DIARIO por PROYECTO×modelo: { 'YYYY-MM-DD': { consola: { opus:
  // {tokens,cost}... }, tolkien: {...}, otros: {...} } }. Alimenta el histórico
  // persistente (history-store) y el filtro por proyecto de las gráficas.
  const daily = {};

  // Acumulador por MOTOR (mismo shape que un proyecto: bucket + modelStats).
  const engineMap = new Map();
  const engineFor = ({ key, label }) => {
    let e = engineMap.get(key);
    if (!e) { e = { key, label, B: emptyBucket(), cost: 0, modelStats: {} }; engineMap.set(key, e); }
    return e;
  };

  for (const dir of dirs) {
    const proj = projectOf(dir); // consola | tolkien | otros (filtro de las gráficas)
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
    const modelStats = {}; // model -> { tokens, cost, lastMtime }

    // LECTURA en PARALELO (pool adaptativo de health F2.5, regla de oro:
    // paralelo lo que LEE, serial lo que ESCRIBE): stat + parseo cacheado son
    // independientes por archivo; cada worker escribe SOLO su casillero por
    // índice (anti-colisión, mismo patrón que la revisión de salud). La
    // ACUMULACIÓN queda SERIAL en el orden original: los costos son floats y
    // sumar siempre en el mismo orden mantiene el resultado determinístico.
    const parsed = new Array(files.length);
    await runAdaptivePool(files.map((file, i) => ({ file, i })), async ({ file, i }) => {
      let fileMtime = 0;
      try { fileMtime = (await fs.stat(file)).mtimeMs; } catch { /* noop */ }
      const data = await parseCached(file);
      parsed[i] = { file, fileMtime, ...data };
    });

    // .filter(Boolean): un worker que falló deja su casillero vacío (el pool
    // no propaga errores) — se saltea ese archivo, igual que antes un stat roto.
    for (const { file, fileMtime, rows, modelTs, entrypoint } of parsed.filter(Boolean)) {
      lastMtime = Math.max(lastMtime, fileMtime);
      // Motor de origen de ESTE transcript (sessionId = nombre del archivo).
      const sessionId = path.basename(file, '.jsonl');
      const engine = engineFor(classifyEngine(dir, sessionId, entrypoint, chatIds, learningIds));
      // Proyecto EFECTIVO de ESTE transcript: por defecto el del directorio, pero
      // una corrida de aprendizaje (sessionId registrado) va al bucket 'aprendizaje'
      // aunque su cwd sea la consola/Tolkien — así 'consola' no se infla con estudio.
      const fproj = learningIds.has(sessionId) ? 'aprendizaje' : proj;
      for (const [key, b] of Object.entries(rows)) {
        const [hourKey, model] = key.split('\t');
        const day = hourKey === 'unknown' ? 'unknown' : hourKey.slice(0, 10);
        const c = costOf(model, b);
        const tok = b.input + b.output + b.cw1h + b.cw5m + b.cr;
        const mkey = keyOf(model);
        // Timestamp del ÚLTIMO mensaje de ESTE modelo (no el mtime del archivo):
        // así "consumiendo ahora" corresponde al modelo real. Fallback al mtime.
        const ts = modelTs[model] || fileMtime;
        addInto(projB, b); projCost += c;
        addInto(totals, b); totalCost += c;
        const ms = (modelStats[model] ||= { tokens: 0, cost: 0, lastMtime: 0 });
        ms.tokens += tok; ms.cost += c;
        ms.lastMtime = Math.max(ms.lastMtime, ts);
        // Mismo desglose, agrupado por MOTOR (alimenta el detalle del modal).
        const es = (engine.modelStats[model] ||= { tokens: 0, cost: 0, lastMtime: 0 });
        es.tokens += tok; es.cost += c;
        es.lastMtime = Math.max(es.lastMtime, ts);
        addInto(engine.B, b); engine.cost += c;
        if (day === today) {
          addInto(todayB, b); todayCost += c;
          // Bucket por PROYECTO×HORA local (gráfica "Día"): hourKey='YYYY-MM-DDTHH'.
          const hr = Number(hourKey.slice(11, 13));
          const hb = ((hourlyByProj[fproj] ||= {})[hr] ||= {});
          const hm = (hb[mkey] ||= { tokens: 0, cost: 0 });
          hm.tokens += tok; hm.cost += c;
        }
        // Ventana de 5 h (token-count del límite de sesión): tokens cuyo bucket
        // horario arranca dentro de las últimas 5 h. Cuenta ENTERA (todos los
        // proyectos: los límites del plan son de la cuenta, no se filtran).
        if (hourKey !== 'unknown' && localHourStartMs(hourKey) >= fiveHAgo) h5tok += tok;
        // Acumulación por (día local, PROYECTO, modelo) para el histórico persistente.
        if (day && day !== 'unknown') {
          const dp = ((daily[day] ||= {})[fproj] ||= {});
          const dm = (dp[mkey] ||= { tokens: 0, cost: 0 });
          dm.tokens += tok; dm.cost += c;
        }
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

  // Motores consolidados (mismo shape que projects[]: label + models[]).
  const engines = [...engineMap.values()].map((e) => {
    const models = Object.entries(e.modelStats)
      .map(([model, v]) => ({ model, key: keyOf(model), tokens: v.tokens, cost: v.cost, lastMtime: v.lastMtime }))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.cost - a.cost);
    const lastMtime = models.reduce((mx, m) => Math.max(mx, m.lastMtime), 0);
    return { key: e.key, label: e.label, tokens: tok(e.B), cost: e.cost, lastMtime, models };
  }).filter((e) => e.tokens > 0).sort((a, b) => b.cost - a.cost);

  // Serie horaria de HOY (gráfica "Día") POR PROYECTO: {all, consola, tolkien,
  // otros}, cada una {keys,points,totals} — el front elige según el filtro.
  const curHour = localHourNow();
  const hourSeries = (hourMap) => {
    const entries = [];
    for (let h = 0; h <= curHour; h++) entries.push({ label: `${h}h`, models: (hourMap && hourMap[h]) || {} });
    return buildSeries('day', entries);
  };
  // Mapa horario combinado (todos los proyectos) para el 'all'.
  const allHours = {};
  for (const p of PROJECT_KEYS) {
    const hm = hourlyByProj[p];
    if (!hm) continue;
    for (const h of Object.keys(hm)) mergeModels((allHours[h] ||= {}), hm[h]);
  }
  const hourlyToday = {
    all: hourSeries(allHours),
    consola: hourSeries(hourlyByProj.consola),
    tolkien: hourSeries(hourlyByProj.tolkien),
    otros: hourSeries(hourlyByProj.otros),
    aprendizaje: hourSeries(hourlyByProj.aprendizaje),
  };

  // Ventana de 7 días (token-count de los límites semanales): total + por modelo,
  // sumando los últimos 7 días locales de TODOS los proyectos (cuenta entera).
  const anchor = localDateStartMs(today);
  const d7ByKey = {};
  let d7tok = 0;
  for (let i = 0; i < 7; i++) {
    const dayProjects = daily[localDayStr(anchor - i * DAY_MS)];
    if (!dayProjects) continue;
    for (const p of Object.keys(dayProjects)) {
      for (const [k, v] of Object.entries(dayProjects[p])) {
        (d7ByKey[k] ||= { tokens: 0 }).tokens += v.tokens;
        d7tok += v.tokens;
      }
    }
  }

  return {
    totals: { ...totals, tokens: tok(totals), cost: totalCost },
    today: { ...todayB, tokens: tok(todayB), cost: todayCost },
    projects,
    engines,
    hourlyToday, // {all,consola,tolkien,otros} serie horaria de hoy (gráfica "Día")
    windows: { h5: h5tok, d7: d7tok, d7ByKey }, // token-counts junto a los límites
    daily, // desglose por día×proyecto×modelo (lo consume el histórico; no viaja al front)
    updatedAt: new Date().toISOString(),
  };
}

// Quita el desglose `daily` del summary antes de mandarlo al cliente: es un
// insumo interno del histórico persistente (puede ser grande). Conserva
// `hourlyToday` (≤24 puntos) y `windows` (token-counts de los límites): el modal
// los usa para la gráfica "Día" y para el token-count junto a cada límite.
function publicSummary(result) {
  const { daily, ...pub } = result;
  return pub;
}

// Cache del summary completo (evita re-escanear en ráfagas de polling). El
// parseo de TODOS los transcripts tarda ~2 s: con TTL corto cada apertura del
// modal lo re-disparaba. 15 s se alinea con el poll del pie (15 s) y del modal
// → la mayoría de las lecturas caen en caché; ?fresh lo saltea (botón Actualizar).
let summaryCache = null;
let summaryAt = 0;
const SUMMARY_TTL_MS = 15000;
// Promesa compartida: evita buildSummary() concurrentes (dos requests casi
// simultáneas que pasan el check de TTL antes de que la primera actualice
// summaryAt re-parsearían todos los transcripts en paralelo).
let summaryBuildPromise = null;

// buildSummary con caché de TTL + dedup de concurrentes + snapshot al histórico.
// Fuente ÚNICA para /summary y /history?range=day (ambos necesitan el resultado
// fresco/cacheado). ?fresh la saltea.
async function cachedSummary(fresh) {
  const ms = Number(process.hrtime.bigint()) / 1e6;
  if (!fresh && summaryCache && ms - summaryAt < SUMMARY_TTL_MS) return summaryCache;
  if (!summaryBuildPromise) {
    summaryBuildPromise = buildSummary()
      .then((result) => {
        summaryCache = result;
        summaryAt = Number(process.hrtime.bigint()) / 1e6;
        mergeDaily(result.daily); // snapshot al histórico (throttle interno 5 min)
        return result;
      })
      .finally(() => { summaryBuildPromise = null; });
  }
  return summaryBuildPromise;
}

// ===== Límites del PLAN (lo que muestra claude.ai): % por ventana + reset ==
// Fuente: el endpoint OAuth de uso de Anthropic — el MISMO que consulta el
// /usage del CLI — con el accessToken de ~/.claude/.credentials.json (la
// credencial que ya hereda el Agent SDK; acá SOLO se lee, jamás se escribe
// ni se refresca: si venció, el error lo dice y se arregla abriendo claude).
// El token nunca sale hacia el cliente: el server hace de proxy.
const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Persistencia a disco del ÚLTIMO resultado bueno de límites/créditos: el dato
// viene de Anthropic pero un 429 / corte de red / reinicio del server lo perdía
// (quedaba solo en memoria). Guardamos la última respuesta OK acá para poder
// SERVIRLA (marcada `stale`) cuando la consulta falla, y de paso reducir las
// llamadas reales al medidor OAuth. Escritura atómica (tmp+rename).
const PLAN_LIMITS_FILE = path.join(os.homedir(), '.cwc-data', 'plan-limits.json');

const LIMIT_LABELS = {
  session: 'Sesión (5 h)',
  weekly_all: 'Semana · todos los modelos',
};

// Lee el último snapshot bueno persistido (o null si no hay/está corrupto).
async function readPersistedLimits() {
  try {
    const obj = JSON.parse(await fs.readFile(PLAN_LIMITS_FILE, 'utf8'));
    return obj && Array.isArray(obj.limits) ? obj : null;
  } catch {
    return null;
  }
}

// Persiste un snapshot bueno (best-effort: si falla el disco, no rompe la
// respuesta al cliente — el dato en memoria ya se devolvió).
async function writePersistedLimits(data) {
  try {
    await fs.mkdir(path.dirname(PLAN_LIMITS_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${PLAN_LIMITS_FILE}.tmp.${process.pid}`; // tmp por-PID (fix B4 2026-07-11)
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, PLAN_LIMITS_FILE);
  } catch { /* best-effort */ }
}

async function fetchPlanLimits() {
  let oauth;
  try {
    oauth = JSON.parse(await fs.readFile(CREDS_FILE, 'utf8')).claudeAiOauth;
  } catch {
    // Falla local (credenciales del CLI ilegibles/ausentes): no es culpa de
    // Anthropic, no amerita 502. `.badRequest` deja que el catch del router
    // derive el status explícitamente en vez de hardcodear uno.
    const e = new Error('No se pudieron leer las credenciales del CLI (~/.claude/.credentials.json).');
    e.badRequest = true;
    throw e;
  }
  if (!oauth?.accessToken) {
    const e = new Error('Sin token OAuth del CLI.');
    e.badRequest = true;
    throw e;
  }
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    const e = new Error('El token del CLI está vencido: abrí una sesión de claude para refrescarlo.');
    e.badRequest = true;
    throw e;
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
    // Fallo real de red al llamar a Anthropic: esto sí es un problema
    // upstream, se marca explícitamente para mapear a 502 en el catch.
    const e = new Error('No se pudo consultar a Anthropic (¿sin salida a internet?).');
    e.upstream = true;
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const e = new Error(`Anthropic respondió ${res.status}.`);
    e.upstream = true;
    throw e;
  }
  // Un 200 con cuerpo no-JSON (o vacío) sigue siendo un fallo UPSTREAM: se
  // marca igual que el resto de los caminos de error de esta llamada (502).
  let data;
  try {
    data = await res.json();
  } catch {
    const e = new Error('Anthropic respondió 200 pero el cuerpo no es JSON válido.');
    e.upstream = true;
    throw e;
  }

  // Normalización: preferimos el array `limits` (trae también las ventanas
  // por modelo, p.ej. "Semana · Fable"); si no vino, caemos a los campos
  // planos five_hour/seven_day.
  const limits = (Array.isArray(data.limits) ? data.limits : [])
    .filter((l) => l && typeof l.percent === 'number')
    .map((l) => ({
      kind: l.kind,
      label: LIMIT_LABELS[l.kind]
        || (l.scope?.model?.display_name ? `Semana · ${l.scope.model.display_name}` : l.kind),
      // Clave semántica del modelo de una ventana scoped (p.ej. "Fable"→'fable'):
      // el front la usa para mostrar el token-count de ESE modelo (windows.d7ByKey).
      modelKey: l.scope?.model?.display_name ? keyOf(l.scope.model.display_name) : null,
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

  // Créditos de uso EXTRA (el "extra usage" del plan: crédito en dólares que se
  // consume una vez agotadas las ventanas del plan). Anthropic lo reporta en
  // `extra_usage` — puede venir ausente o con todo en null si el plan no lo
  // tiene habilitado; en ese caso `enabled` queda false.
  // OJO REPRESENTACIÓN (bug 2026-07-07): los montos (`used_credits`,
  // `monthly_limit`) vienen en la UNIDAD MÍNIMA de la moneda (centavos), con
  // `decimal_places` diciendo cuántos decimales tiene → hay que dividir por
  // 10^decimal_places para pasarlos a dólares ($100 llegaba como 10000). Se usa
  // el campo, no un /100 hardcodeado. `utilization` YA viene en % (0-100).
  const eu = data.extra_usage || {};
  const dp = Number.isInteger(eu.decimal_places) ? eu.decimal_places : 2;
  const factor = Math.pow(10, dp);
  const credits = {
    enabled: !!eu.is_enabled,
    usedCredits: typeof eu.used_credits === 'number' ? eu.used_credits / factor : null,
    monthlyLimit: typeof eu.monthly_limit === 'number' ? eu.monthly_limit / factor : null,
    percent: typeof eu.utilization === 'number' ? eu.utilization : null,
    currency: eu.currency || 'USD',
  };

  return {
    limits,
    credits,
    subscription: oauth.subscriptionType || null,
    updatedAt: new Date().toISOString(),
  };
}

// Cache de límites: consulta remota, TTL más largo que el summary local.
let limitsCache = null;
let limitsAt = 0;
// TTL más largo (2 min): el medidor OAuth de Anthropic devuelve 429 si se lo
// consulta seguido (compartido con el propio CLI). Con el poll del pie cada 5 s,
// esto hace que solo ~1 de cada 24 lecturas golpee de verdad a Anthropic.
const LIMITS_TTL_MS = 120000;
// Promesa compartida: evita fetchPlanLimits() concurrentes (p.ej. dos
// requests casi simultáneas que pasan el check de TTL antes de que la
// primera actualice limitsAt).
let limitsFetchPromise = null;

export default {
  name: 'tokens',

  registerHttp(router) {
    const r = express.Router();

    // ?fresh=1 saltea el TTL del summary (botón Actualizar del modal Uso);
    // el caché por archivo (mtime+size) queda: solo re-parsea lo que cambió.
    r.get('/summary', async (req, res) => {
      try {
        res.json(publicSummary(await cachedSummary(!!req.query.fresh)));
      } catch (err) {
        res.status(500).json({ error: 'No se pudo calcular el uso de tokens.' });
      }
    });

    // Serie de tiempo del consumo por modelo para las gráficas de tendencia:
    //   day   → HOY por hora (de buildSummary.hourlyToday — hoy siempre en disco)
    //   week  → últimos 7 días · month → últimos 30 días (histórico PERSISTENTE
    //           ~/.cwc-data/usage-history.json, independiente de la poda del CLI)
    // Devuelve {range, keys, points, totals}: `totals` (suma por modelo) alimenta
    // la columna "General" del período. 0 tokens.
    r.get('/history', async (req, res) => {
      const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'week';
      const project = ['all', 'consola', 'tolkien', 'otros', 'aprendizaje'].includes(req.query.project) ? req.query.project : 'all';
      try {
        if (range === 'day') {
          const sum = await cachedSummary(!!req.query.fresh);
          const s = sum.hourlyToday[project] || sum.hourlyToday.all;
          return res.json({ ...s, project, updatedAt: sum.updatedAt });
        }
        res.json(await readSeries(range, project));
      } catch (err) {
        res.status(500).json({ error: 'No se pudo leer el histórico de uso.' });
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
        if (!limitsFetchPromise) {
          limitsFetchPromise = fetchPlanLimits()
            .then((result) => {
              // Igual que en /summary: solo la promesa que construyó el
              // resultado actualiza limitsAt, para que el TTL se cuente
              // desde el momento real de la construcción.
              limitsCache = result;
              limitsAt = Number(process.hrtime.bigint()) / 1e6;
              // Persiste el último snapshot BUENO a disco (async, no bloquea
              // la respuesta): sobrevive a reinicios del server y sirve de
              // fallback ante un 429/corte de red posterior.
              writePersistedLimits(result);
              return result;
            })
            .finally(() => {
              limitsFetchPromise = null;
            });
        }
        const result = await limitsFetchPromise;
        res.json(result);
      } catch (err) {
        // FALLBACK: antes un 429/corte de red devolvía el error y el dato
        // "desaparecía" en la UI. Ahora servimos el ÚLTIMO snapshot bueno —
        // de la caché en memoria o, si el server se reinició, del disco —
        // marcado `stale:true` para que el front avise "datos de hace X".
        const fallback = limitsCache || await readPersistedLimits();
        if (fallback) {
          return res.json({ ...fallback, stale: true, staleReason: err.message || null });
        }
        // Sin ningún dato previo: recién ahí devolvemos el error real. Status
        // derivado de una propiedad explícita del error (invariante 29):
        // credenciales/token local -> 400, fallo de Anthropic -> 502, resto -> 500.
        const status = err.badRequest ? 400 : err.upstream ? 502 : 500;
        res.status(status).json({ error: err.message || 'No se pudieron leer los límites del plan.' });
      }
    });

    router.use('/tokens', r);
  },
};
