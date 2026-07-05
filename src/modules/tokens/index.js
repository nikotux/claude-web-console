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
//   GET /api/tokens/limits   -> { limits[], subscription, updatedAt }
//   % usado y reset de las ventanas del PLAN (sesión 5 h / semanales), vía el
//   endpoint OAuth de Anthropic con el token del CLI (solo lectura, ver abajo).
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { keyOf } from '../../core/claude-model.js';

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
//   rows      -> buckets por (día, modelo)
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
    const day = (obj.timestamp || '').slice(0, 10) || 'unknown';
    const model = msg.model || 'unknown';
    const ts = Date.parse(obj.timestamp || '') || 0;
    if (ts && ts > (modelTs[model] || 0)) modelTs[model] = ts;
    const key = `${day}\t${model}`;
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
  healthfix: 'Auto-fix de salud',
  tolkien: 'Tolkien · bugfix',
  cli: 'CLI interactivo',
  headless: 'Motores headless',
};
function classifyEngine(dir, sessionId, entrypoint, chatIds) {
  let key;
  if (chatIds.has(sessionId)) key = 'chat';
  else if (/healthfix-wt-/.test(dir)) key = 'healthfix';
  else if (/(^|-)tolkien(-|$)/.test(dir)) key = 'tolkien';
  else if (entrypoint === 'cli') key = 'cli';
  else key = 'headless';
  return { key, label: ENGINE_LABELS[key] };
}

// Exportada a propósito: el runner de Optimización IA (bin/cwc-optimize-runner.js)
// la usa para cruzar el censo de motores con el CONSUMO REAL (solo lectura de
// transcripts, mismo caché por mtime+size — no toca nada).
export async function buildSummary() {
  const today = new Date().toISOString().slice(0, 10);
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

  const totals = emptyBucket();
  let totalCost = 0;
  const todayB = emptyBucket();
  let todayCost = 0;
  const projects = [];

  // Acumulador por MOTOR (mismo shape que un proyecto: bucket + modelStats).
  const engineMap = new Map();
  const engineFor = ({ key, label }) => {
    let e = engineMap.get(key);
    if (!e) { e = { key, label, B: emptyBucket(), cost: 0, modelStats: {} }; engineMap.set(key, e); }
    return e;
  };

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
    const modelStats = {}; // model -> { tokens, cost, lastMtime }

    for (const file of files) {
      let fileMtime = 0;
      try { fileMtime = (await fs.stat(file)).mtimeMs; } catch { /* noop */ }
      lastMtime = Math.max(lastMtime, fileMtime);
      const { rows, modelTs, entrypoint } = await parseCached(file);
      // Motor de origen de ESTE transcript (sessionId = nombre del archivo).
      const sessionId = path.basename(file, '.jsonl');
      const engine = engineFor(classifyEngine(dir, sessionId, entrypoint, chatIds));
      for (const [key, b] of Object.entries(rows)) {
        const [day, model] = key.split('\t');
        const c = costOf(model, b);
        const tok = b.input + b.output + b.cw1h + b.cw5m + b.cr;
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

  // Motores consolidados (mismo shape que projects[]: label + models[]).
  const engines = [...engineMap.values()].map((e) => {
    const models = Object.entries(e.modelStats)
      .map(([model, v]) => ({ model, key: keyOf(model), tokens: v.tokens, cost: v.cost, lastMtime: v.lastMtime }))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.cost - a.cost);
    const lastMtime = models.reduce((mx, m) => Math.max(mx, m.lastMtime), 0);
    return { key: e.key, label: e.label, tokens: tok(e.B), cost: e.cost, lastMtime, models };
  }).filter((e) => e.tokens > 0).sort((a, b) => b.cost - a.cost);

  return {
    totals: { ...totals, tokens: tok(totals), cost: totalCost },
    today: { ...todayB, tokens: tok(todayB), cost: todayCost },
    projects,
    engines,
    updatedAt: new Date().toISOString(),
  };
}

// Cache del summary completo (evita re-escanear en ráfagas de polling).
let summaryCache = null;
let summaryAt = 0;
const SUMMARY_TTL_MS = 4000;
// Promesa compartida: evita buildSummary() concurrentes (dos requests casi
// simultáneas que pasan el check de TTL antes de que la primera actualice
// summaryAt re-parsearían todos los transcripts en paralelo).
let summaryBuildPromise = null;

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
      const now = process.hrtime.bigint();
      const ms = Number(now) / 1e6;
      if (!req.query.fresh && summaryCache && ms - summaryAt < SUMMARY_TTL_MS) {
        return res.json(summaryCache);
      }
      try {
        if (!summaryBuildPromise) {
          summaryBuildPromise = buildSummary()
            .then((result) => {
              // Solo la promesa que efectivamente construyó el resultado
              // actualiza el TTL: evita que un request concurrente que
              // llega más tarde pise summaryAt con su propio timestamp.
              summaryCache = result;
              summaryAt = Number(process.hrtime.bigint()) / 1e6;
              return result;
            })
            .finally(() => {
              summaryBuildPromise = null;
            });
        }
        const result = await summaryBuildPromise;
        res.json(result);
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
        if (!limitsFetchPromise) {
          limitsFetchPromise = fetchPlanLimits()
            .then((result) => {
              // Igual que en /summary: solo la promesa que construyó el
              // resultado actualiza limitsAt, para que el TTL se cuente
              // desde el momento real de la construcción.
              limitsCache = result;
              limitsAt = Number(process.hrtime.bigint()) / 1e6;
              return result;
            })
            .finally(() => {
              limitsFetchPromise = null;
            });
        }
        const result = await limitsFetchPromise;
        res.json(result);
      } catch (err) {
        // Status derivado de una propiedad explícita del error (invariante
        // 29): credenciales/token local -> 400, fallo real de Anthropic ->
        // 502, cualquier otra cosa no reconocida -> 500 (nunca hardcodear
        // un 4xx por defecto).
        const status = err.badRequest ? 400 : err.upstream ? 502 : 500;
        res.status(status).json({ error: err.message || 'No se pudieron leer los límites del plan.' });
      }
    });

    router.use('/tokens', r);
  },
};
