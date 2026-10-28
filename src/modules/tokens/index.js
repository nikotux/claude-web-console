// modules/tokens/index.js — uso y costo de tokens de Claude Code.
//
// Lee las transcripciones del espacio privado de cada usuario
// (<userSpace>/.claude/projects/<proj>/*.jsonl), deduplica por message.id
// (cada mensaje aparece repetido en el jsonl) y suma input/output/cache. Para
// el host, userSpace(host) conserva exactamente el HOME real. El costo usa
// precios OFICIALES por modelo. La misma contabilidad que token-usage.sh del
// proyecto `estadisticas`.
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
//   GET /api/tokens/limits   -> { limits[], credits, subscription, updatedAt, stale?, codex?, localUsage? }
//   % usado y reset de las ventanas del PLAN (sesión 5 h / semanales) + los
//   CRÉDITOS de uso extra (extra_usage), vía el endpoint OAuth de Anthropic con
//   el token del CLI (solo lectura). El último resultado bueno se PERSISTE en
//   ~/.cwc-data/plan-limits.json: ante 429/corte de red/reinicio se sirve ese
//   snapshot marcado `stale:true` en vez de perder el dato.
//   `codex` (opcional): MISMO shape {limits[],credits,subscription} pero de
//   CODEX CLI (OpenAI), vía el endpoint interno chatgpt.com/backend-api/wham/usage
//   con la credencial local ~/.codex/auth.json. Best-effort (nunca rompe la
//   respuesta), caché+persistencia propias en ~/.cwc-data/codex-limits.json. El
//   CHAT de ChatGPT Max queda AFUERA (no tiene vía equivalente). Ver el bloque
//   "Límites de CODEX CLI" más abajo.
//   GET /api/tokens/history?range=day|week|month -> serie de tiempo por modelo
//   para las gráficas de tendencia del modal Uso. Sale del histórico PERSISTENTE
//   (~/.cwc-data/usage-history.json, ver history-store.js): buildSummary calcula
//   el desglose diario por modelo y lo snapshotea (independiente de la poda de
//   transcripts que hace el CLI). Reemplazó al viejo POST /reset (2026-07-10):
//   con historial persistente no hace falta "poner en cero".
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { principalOf } from '../../core/auth.js';
import {
  getValidClaudeAccessToken,
  readClaudeOauthMeta,
  refreshClaudeOauth,
} from '../../core/claude-oauth.js';
import { keyOf } from '../../core/claude-model.js';
import {
  hostUser,
  readUserOauthToken,
  sanitizeUserId,
  userClaudeDir,
  userCodexAuthPath,
  userDataDir,
} from '../../core/user-space.js';
import { runAdaptivePool } from '../health/pool.js';
import {
  mergeDaily, readSeries, buildSeries,
  // Fuente única (BUG-21): antes DAY_MS/PROJECT_KEYS/mergeModels estaban duplicados acá.
  DAY_MS, PROJECTS as PROJECT_KEYS, addModels as mergeModels,
} from './history-store.js';
import { computeFlow } from './flow.js';
import { getStream, getSeed } from './stream.js';
import { localHourKey, localHourStartMs, localTodayStr, localDateStartMs, localDayStr, localHourNow } from './time.js';
import { scanCodexUsage } from './codex-usage.js';

const projectsDir = (owner) => path.join(userClaudeDir(owner), 'projects');
// Estado de la consola: mapea sessionId -> chat. Se usa para atribuir cada
// transcript a su MOTOR de origen (un .jsonl cuyo sessionId figura acá salió
// del motor de conversaciones; el resto se clasifica por directorio/entrypoint).
const chatsFile = (owner) => path.join(userDataDir(owner), 'chats.json');
// Registro DURABLE append-only de sessionIds que ALGUNA VEZ fueron chat (lo
// escribe el módulo chat, nunca se poda): chats.json solo tiene los VIVOS —
// un chat CERRADO por su dueño sale de ahí (el olvido automático por
// inactividad se eliminó el 2026-08-03) y su transcript caía en
// "Motores headless" aunque fuera una conversación normal en fable/opus.
const chatIdsFile = (owner) => path.join(userDataDir(owner), 'chat-session-ids.json');
// Backfill retroactivo: cada registro de bugfixes.json ES un chat que trabajó
// un ticket (clave sessionId) — recupera la atribución de chats cerrados antes
// de que existiera el registro durable. Solo lectura.
const bugfixesFile = (owner) => path.join(userDataDir(owner), 'bugfixes.json');
// Registro DURABLE de sessionIds de las corridas del MÓDULO DE APRENDIZAJE
// (explain/context/analyze), lo escriben esos runners vía learning/session-log.js.
// Esos transcripts corren con cwd = la consola, así que projectOf() los vería como
// 'consola'; este registro permite atribuirlos al bucket 'aprendizaje' aparte
// (pedido del usuario 2026-07-10: auditar tokens de ESTUDIO vs DESARROLLO de la
// consola). Solo lectura. Mismo archivo que learning/session-log.js declara.
const learningIdsFile = (owner) => path.join(userDataDir(owner), 'learning-session-ids.json');

// Precio de input por millón, por modelo; el resto se deriva del input.
// OJO: el costo es un EQUIVALENTE a precios de API — la suscripción del CLI
// no factura por token (no existe "gasto real" consultable; la Admin
// Usage & Cost API exige organización + admin key, no aplica acá).
function pin(m) {
  if (/fable|mythos/.test(m)) return 10.0;
  // Opus 5.5 bajó de precio; va antes del /opus/ genérico de Opus 5/4.8/4.7.
  if (/opus-5-5/.test(m)) return 4.0;
  if (/opus/.test(m)) return 5.0;
  if (/sonnet/.test(m)) return 3.0;
  if (/haiku/.test(m)) return 1.0;
  return 5.0; // fallback: modelos no reconocidos se tasan como Opus
}
function pout(m) {
  if (/fable|mythos/.test(m)) return 50.0;
  if (/opus-5-5/.test(m)) return 20.0;
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

// Clave semántica de modelo para las series. Codex NO pasa por keyOf (que solo
// conoce los modelos de Claude y devolvería 'unknown'): cualquier gpt-*/codex
// colapsa en la ÚNICA serie 'codex' — así un cambio de versión (gpt-5.5 → 5.6)
// no parte la barra en dos.
function mkeyOf(model) {
  return /^gpt-|codex/i.test(model || '') ? 'codex' : keyOf(model);
}

// Caché por archivo: path -> { mtimeMs, size, rows: {`day\tmodel`: {tok...}} }
// LRU acotado: sin límite, cada .jsonl visto alguna vez (proyectos/sesiones
// viejas incluidas) quedaba en memoria para siempre → crecimiento sin fin.
const fileCache = new Map();
// console:BUG-3481: cacheamos buckets hora×modelo pequeños; el tope debe superar
// con holgura el corpus (1990 archivos hoy), o la LRU hace thrash y relee todo en cada poll.
const FILE_CACHE_MAX = 20000;

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
  codex: 'Codex · ejecución',
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
export async function buildSummary(owner = hostUser()) {
  sanitizeUserId(owner);
  const today = localTodayStr();
  const now = Date.now();
  const fiveHAgo = now - 5 * 3600000;
  // Acumuladores (por CLAVE semántica de modelo, anidados por PROYECTO para el
  // filtro Consola/Tolkien/Otros):
  //   hourlyByProj[proyecto][hora 0-23] -> { modelKey: {tokens,cost} }  (gráfica "Día")
  //   h5tok -> tokens totales de las últimas 5 h (ventana de sesión, cuenta entera)
  const hourlyByProj = {};
  let h5tok = 0;
  let h5cost = 0;
  let dirs = [];
  try {
    dirs = (await fs.readdir(projectsDir(owner), { withFileTypes: true }))
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
    const arr = JSON.parse(await fs.readFile(chatsFile(owner), 'utf8'));
    if (Array.isArray(arr)) for (const c of arr) if (c?.sessionId) chatIds.add(c.sessionId);
  } catch { /* noop */ }
  try {
    const arr = JSON.parse(await fs.readFile(chatIdsFile(owner), 'utf8'));
    if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string' && id) chatIds.add(id);
  } catch { /* noop */ }
  try {
    const arr = JSON.parse(await fs.readFile(bugfixesFile(owner), 'utf8'));
    if (Array.isArray(arr)) for (const r of arr) if (r?.sessionId) chatIds.add(r.sessionId);
  } catch { /* noop */ }

  // sessionIds de las corridas del MÓDULO DE APRENDIZAJE (explain/context/analyze):
  // corren con cwd = la consola/Tolkien, pero se cuentan en el bucket 'aprendizaje'
  // APARTE, no en 'consola'/'tolkien' (auditar estudio vs desarrollo). Best-effort.
  const learningIds = new Set();
  try {
    const arr = JSON.parse(await fs.readFile(learningIdsFile(owner), 'utf8'));
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
    const projPath = path.join(projectsDir(owner), dir);
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
        const mkey = mkeyOf(model);
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
        // h5cost SUMA APARTE en $ equivalente (pin/pout, YA descuenta cache read
        // ×0.1): el ritmo-vs-historial (más abajo) compara COSTO, no tokens
        // crudos — un token de cache read pesa ~10x menos que uno nuevo y puede
        // ser el 90%+ del conteo crudo de una sesión con contexto reusado
        // (verificado 2026-07-19: 95% cache reads un día con % de cupo bajo),
        // así que comparar tokens crudos contra el % real de Anthropic exagera
        // muchísimo el ritmo. El costo es la métrica que YA usa el resto de la
        // app como "equivalente a precios de API" — más cerca de lo que Anthropic
        // pesa internamente para el cupo que un conteo de tokens plano.
        if (hourKey !== 'unknown' && localHourStartMs(hourKey) >= fiveHAgo) { h5tok += tok; h5cost += c; }
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
      .map(([model, v]) => ({ model, key: mkeyOf(model), tokens: v.tokens, cost: v.cost, lastMtime: v.lastMtime }))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.cost - a.cost);
    projects.push({
      name: dir, label: labelFor(dir), tokens, cost: projCost, lastMtime,
      input: projB.input, output: projB.output,
      cacheWrite: projB.cw1h + projB.cw5m, cacheRead: projB.cr,
      models,
    });
  }

  // Codex suma al consumo GENERAL en tokens, pero queda FUERA de h5tok/h5cost:
  // esas ventanas son el token-count y el ritmo de los límites de ANTHROPIC.
  // Meter OpenAI ahí corrompería la barra "Sesión (5h)" y el ratio "N× tu ritmo
  // habitual". Todo este bloque es best-effort: el resumen de Claude nunca puede
  // romperse porque un rollout de Codex esté corrupto o en escritura.
  try {
    const { entries } = await scanCodexUsage(owner);
    for (const e of entries) {
      const b = { input: e.input, output: e.output, cw1h: 0, cw5m: 0, cr: e.cachedInput };
      const tok = e.input + e.output + e.cachedInput;
      const cost = 0;
      addInto(totals, b);

      const engine = engineFor({ key: 'codex', label: ENGINE_LABELS.codex });
      addInto(engine.B, b);
      engine.cost += cost;
      const es = (engine.modelStats[e.model] ||= { tokens: 0, cost: 0, lastMtime: 0 });
      es.tokens += tok; es.cost += cost;
      es.lastMtime = Math.max(es.lastMtime, e.ts || 0);

      const day = e.hourKey === 'unknown' ? 'unknown' : e.hourKey.slice(0, 10);
      if (day === today) {
        addInto(todayB, b);
        const hr = Number(e.hourKey.slice(11, 13));
        const hb = ((hourlyByProj[e.proj] ||= {})[hr] ||= {});
        const hm = (hb.codex ||= { tokens: 0, cost: 0 });
        hm.tokens += tok; hm.cost += cost;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const dp = ((daily[day] ||= {})[e.proj] ||= {});
        const dm = (dp.codex ||= { tokens: 0, cost: 0 });
        dm.tokens += tok; dm.cost += cost;
      }
    }
  } catch {
    // noop: Codex es una fuente auxiliar; Claude sigue siendo la respuesta base.
  }

  projects.sort((a, b) => b.cost - a.cost);
  const tok = (b) => b.input + b.output + b.cw1h + b.cw5m + b.cr;

  // Motores consolidados (mismo shape que projects[]: label + models[]).
  const engines = [...engineMap.values()].map((e) => {
    const models = Object.entries(e.modelStats)
      .map(([model, v]) => ({ model, key: mkeyOf(model), tokens: v.tokens, cost: v.cost, lastMtime: v.lastMtime }))
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
        // Codex no cuenta en las ventanas de límite de Anthropic (tiene las suyas, ver getCodexBlock).
        if (k === 'codex') continue;
        (d7ByKey[k] ||= { tokens: 0 }).tokens += v.tokens;
        d7tok += v.tokens;
      }
    }
  }

  // BASELINE de la ventana de sesión (5h, 2026-07-19, pedido de Niko: punto de
  // referencia para la barra "Sesión (5h)" — "¿voy más rápido o más lento que mi
  // ritmo habitual?"). Sale del HISTÓRICO PERSISTENTE (usage-history.json, no del
  // `daily` recién parseado: los transcripts viejos los poda el CLI, el histórico
  // no). Promedio de los últimos días COMPLETOS (excluye hoy, que está a medias),
  // escalado a un bloque de 5h. En COSTO ($ equivalente), no tokens crudos (ver
  // el comentario de h5cost arriba). Con <3 días de historial no hay base
  // confiable → h5CostBaseline queda null y el front no muestra el comparativo.
  const h5BaselineWeek = await readSeries('week', 'all', owner);
  const h5BaselineFullDays = h5BaselineWeek.points.slice(0, -1); // últimos 6, sin hoy
  const h5BaselineDays = h5BaselineFullDays.length;
  const h5CostBaseline = h5BaselineDays >= 3
    ? (h5BaselineFullDays.reduce((s, p) => s + p.cost, 0) / h5BaselineDays) * (5 / 24)
    : null;

  return {
    totals: { ...totals, tokens: tok(totals), cost: totalCost },
    today: { ...todayB, tokens: tok(todayB), cost: todayCost },
    projects,
    engines,
    hourlyToday, // {all,consola,tolkien,otros} serie horaria de hoy (gráfica "Día")
    // token-counts junto a los límites; h5Cost/h5CostBaseline = costo equivalente
    // REAL vs. ESPERADO en un bloque de 5h según tu ritmo habitual (null si no
    // hay suficiente historial todavía).
    windows: { h5: h5tok, d7: d7tok, d7ByKey, h5Cost: h5cost, h5CostBaseline, h5BaselineDays },
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
const SUMMARY_TTL_MS = 15000;
// Promesa compartida: evita buildSummary() concurrentes (dos requests casi
// simultáneas que pasan el check de TTL antes de que la primera actualice
// summaryAt re-parsearían todos los transcripts en paralelo).
const OWNER_CACHE_MAX = 32;

function cacheFor(map, owner) {
  let slot = map.get(owner);
  if (slot) {
    map.delete(owner);
    map.set(owner, slot);
    return slot;
  }
  slot = { data: null, at: 0, promise: null };
  map.set(owner, slot);
  if (map.size > OWNER_CACHE_MAX) map.delete(map.keys().next().value);
  return slot;
}

const summaryCaches = new Map();

// buildSummary con caché de TTL + dedup de concurrentes + snapshot al histórico.
// Fuente ÚNICA para /summary y /history?range=day (ambos necesitan el resultado
// fresco/cacheado). ?fresh la saltea.
async function cachedSummary(fresh, owner = hostUser()) {
  const slot = cacheFor(summaryCaches, owner);
  const ms = Number(process.hrtime.bigint()) / 1e6;
  if (!fresh && slot.data && ms - slot.at < SUMMARY_TTL_MS) return slot.data;
  if (!slot.promise) {
    slot.promise = buildSummary(owner)
      .then((result) => {
        slot.data = result;
        slot.at = Number(process.hrtime.bigint()) / 1e6;
        mergeDaily(result.daily, owner); // snapshot al histórico (throttle interno 5 min)
        return result;
      })
      .finally(() => { slot.promise = null; });
  }
  return slot.promise;
}

// Alternativa local cuando Anthropic no puede exponer los porcentajes del plan.
// Reusa el summary cacheado (nunca fuerza fresh) y es estrictamente best-effort:
// un fallo leyendo transcripts no puede romper la respuesta `unavailable`.
export async function withLocalUsage(result, owner) {
  if (!result?.unavailable) return result;
  try {
    const summary = await cachedSummary(false, owner);
    return {
      ...result,
      localUsage: {
        windowTokens: Number(summary.windows?.h5) || 0,
        windowCost: Number(summary.windows?.h5Cost) || 0,
        todayTokens: Number(summary.today?.tokens) || 0,
        todayCost: Number(summary.today?.cost) || 0,
        totalTokens: Number(summary.totals?.tokens) || 0,
        totalCost: Number(summary.totals?.cost) || 0,
        updatedAt: summary.updatedAt,
      },
    };
  } catch {
    return result;
  }
}

// ===== Límites del PLAN (lo que muestra claude.ai): % por ventana + reset ==
// Fuente: el endpoint OAuth de uso de Anthropic — el MISMO que consulta el
// /usage del CLI — con el accessToken de ~/.claude/.credentials.json (la
// credencial que ya hereda el Agent SDK). Si venció, se refresca mediante
// core/claude-oauth.js; el token nunca sale hacia el cliente: el server hace
// de proxy.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Persistencia a disco del ÚLTIMO resultado bueno de límites/créditos: el dato
// viene de Anthropic pero un 429 / corte de red / reinicio del server lo perdía
// (quedaba solo en memoria). Guardamos la última respuesta OK acá para poder
// SERVIRLA (marcada `stale`) cuando la consulta falla, y de paso reducir las
// llamadas reales al medidor OAuth. Escritura atómica (tmp+rename).
const planLimitsFile = (owner) => path.join(userDataDir(owner), 'plan-limits.json');

const LIMIT_LABELS = {
  session: 'Sesión (5 h)',
  weekly_all: 'Semana · todos los modelos',
};

// Lee el último snapshot bueno persistido (o null si no hay/está corrupto).
async function readPersistedLimits(owner = hostUser()) {
  try {
    const obj = JSON.parse(await fs.readFile(planLimitsFile(owner), 'utf8'));
    return obj && Array.isArray(obj.limits) ? obj : null;
  } catch {
    return null;
  }
}

// Persiste un snapshot bueno (best-effort: si falla el disco, no rompe la
// respuesta al cliente — el dato en memoria ya se devolvió).
async function writePersistedLimits(data, owner = hostUser()) {
  if (data?.unavailable) return;
  const file = planLimitsFile(owner);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp.${process.pid}`; // tmp por-PID (fix B4 2026-07-11)
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch { /* best-effort */ }
}

// Una llamada al medidor OAuth con el token dado. Devuelve la Response o
// lanza un error marcado `upstream` si ni siquiera se pudo hablar con Anthropic.
async function callUsage(accessToken) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    return await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
}

async function fetchPlanLimits(owner = hostUser()) {
  let oauth = null;
  let accessToken = null;
  let tokenSource = null;
  // Si el access token venció, se renueva SOLO con el refreshToken. Antes, el
  // CLI del inquilino no actualizaba este archivo y el medidor real caía a
  // localUsage después de unas 24 horas.
  const valid = await getValidClaudeAccessToken(owner);
  const oauthMeta = valid ? null : await readClaudeOauthMeta(owner);
  if (valid) {
    oauth = valid.oauth;
    accessToken = valid.token;
    tokenSource = 'credentials';
  }
  if (!accessToken) {
    accessToken = readUserOauthToken(owner);
    if (accessToken) tokenSource = 'setup-token';
  }
  if (!accessToken) {
    if (oauthMeta?.hasCreds) {
      return { unavailable: true, reason: 'credencial-vencida', authExpired: true };
    }
    return { unavailable: true, reason: 'sin-credencial' };
  }

  let res = await callUsage(accessToken);
  // 401 con credenciales: el access token puede haberse invalidado del lado de
  // Anthropic aunque su expiresAt local dijera que seguía vivo. Forzamos UN
  // refresh y reintentamos una sola vez antes de caer al setup-token.
  if (res.status === 401 && tokenSource === 'credentials') {
    const next = await refreshClaudeOauth(owner);
    if (next?.accessToken && next.accessToken !== accessToken) {
      oauth = next;
      accessToken = next.accessToken;
      res = await callUsage(accessToken);
    }
  }
  if (!res.ok) {
    if (tokenSource === 'setup-token') {
      if (oauthMeta?.hasCreds) {
        return { unavailable: true, reason: 'setup-token', authExpired: true };
      }
      return { unavailable: true, reason: 'setup-token' };
    }
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
    subscription: oauth?.subscriptionType || null,
    updatedAt: new Date().toISOString(),
  };
}

// ===== Límites de CODEX CLI (OpenAI) ======================================
// SEGUNDA fuente de "ventanas de límite", análoga a la de Claude pero para el
// agente de código Codex de OpenAI. Mismo patrón de blindaje: leemos una
// credencial LOCAL del CLI (~/.codex/auth.json), el server hace de PROXY (el
// token nunca sale al cliente) y persistimos el último snapshot bueno para
// servirlo `stale` ante un fallo.
//
// ⚠️ VÍA NO-OFICIAL: el endpoint `backend-api/wham/usage` es INTERNO de OpenAI
// (lo consume su propio CLI open-source `openai/codex`), pero NO está en su
// documentación pública → puede cambiar de forma sin aviso. Por eso todo el
// camino es best-effort: si falla, la sección de Codex simplemente no aparece;
// NUNCA tira abajo el resto de /limits (que sirve los límites de Claude). El
// CHAT de ChatGPT Max queda deliberadamente AFUERA: no tiene ninguna vía
// (ni oficial ni semi-oficial) equivalente (decisión de Niko 2026-07-15).
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const codexLimitsFile = (owner) => path.join(userDataDir(owner), 'codex-limits.json');

// Nombre legible del plan de OpenAI que reporta el endpoint.
const CODEX_PLAN_LABELS = {
  prolite: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  plus: 'ChatGPT Plus',
  team: 'ChatGPT Team',
  enterprise: 'ChatGPT Enterprise',
  free: 'ChatGPT Free',
};

// Etiqueta de una ventana según su tamaño en segundos (18000 = 5 h, 604800 = 7 d).
function codexWindowLabel(seconds, fallback) {
  if (seconds === 18000) return 'Codex · 5 h';
  if (seconds === 604800) return 'Codex · semana';
  if (seconds === 86400) return 'Codex · día';
  if (typeof seconds === 'number' && seconds > 0) {
    const h = Math.round(seconds / 3600);
    return h >= 48 ? `Codex · ${Math.round(h / 24)} d` : `Codex · ${h} h`;
  }
  return fallback || 'Codex';
}

// Normaliza un `rate_limit.primary_window` (o secondary) a nuestra fila de límite.
function codexWindowRow(win, label) {
  if (!win || typeof win.used_percent !== 'number') return null;
  return {
    kind: 'codex',
    label,
    percent: win.used_percent,
    // reset_at viene en SEGUNDOS unix → ISO (nuestro fmtReset del front lo espera).
    resetsAt: typeof win.reset_at === 'number' ? new Date(win.reset_at * 1000).toISOString() : null,
  };
}

async function readPersistedCodex(owner = hostUser()) {
  try {
    const obj = JSON.parse(await fs.readFile(codexLimitsFile(owner), 'utf8'));
    return obj && Array.isArray(obj.limits) ? obj : null;
  } catch {
    return null;
  }
}

async function writePersistedCodex(data, owner = hostUser()) {
  const file = codexLimitsFile(owner);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch { /* best-effort */ }
}

async function fetchCodexLimits(owner = hostUser()) {
  let auth;
  try {
    auth = JSON.parse(await fs.readFile(userCodexAuthPath(owner), 'utf8'));
  } catch {
    return null;
  }
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken || !accountId) {
    const e = new Error('Codex sin sesión (auth.json sin access_token/account_id).');
    e.badRequest = true;
    throw e;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  let res;
  try {
    res = await fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        'Content-Type': 'application/json',
      },
      signal: ctl.signal,
    });
  } catch {
    const e = new Error('No se pudo consultar a OpenAI (¿sin salida a internet?).');
    e.upstream = true;
    throw e;
  } finally {
    clearTimeout(t);
  }
  // 401/403 = el token de Codex venció (dura ~10 días desde el último refresh):
  // no es un fallo de OpenAI, es una credencial que hay que reconectar. Se marca
  // aparte para que el panel lo diga con todas las letras en vez de mostrar
  // números viejos bajo un "datos guardados" genérico.
  if (res.status === 401 || res.status === 403) {
    const e = new Error('La sesión de Codex venció. Reconectala en ⚙ Sistema → Conexiones.');
    e.upstream = true;
    e.expired = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`OpenAI respondió ${res.status}.`);
    e.upstream = true;
    throw e;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    const e = new Error('OpenAI respondió 200 pero el cuerpo no es JSON válido.');
    e.upstream = true;
    throw e;
  }

  // Ventanas: la principal (primary_window) + la secundaria (si existe) del
  // rate_limit general, más cada additional_rate_limits[] (features metrados
  // como GPT-5.x-Codex-Spark). Cada una con su % + reset.
  const limits = [];
  const rl = data.rate_limit || {};
  const primary = codexWindowRow(rl.primary_window, codexWindowLabel(rl.primary_window?.limit_window_seconds));
  if (primary) limits.push(primary);
  const secondary = codexWindowRow(rl.secondary_window, codexWindowLabel(rl.secondary_window?.limit_window_seconds, 'Codex · secundaria'));
  if (secondary) limits.push(secondary);
  for (const extra of (Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [])) {
    const win = extra?.rate_limit?.primary_window;
    const row = codexWindowRow(win, `Codex · ${extra.limit_name || extra.metered_feature || 'extra'}`);
    if (row) limits.push(row);
  }

  // Créditos (overage): el endpoint expone `credits` con balance y si está
  // habilitado. Se normaliza al MISMO shape que los créditos de Claude para que
  // el front los pinte con el mismo componente.
  const cr = data.credits || {};
  const credits = {
    enabled: !!cr.has_credits || (typeof cr.balance === 'string' && cr.balance !== '0'),
    usedCredits: null, // el endpoint da `balance` (restante), no consumido
    balance: cr.balance != null ? Number(cr.balance) : null,
    monthlyLimit: null,
    percent: null,
    currency: 'USD',
  };

  return {
    limits,
    credits,
    subscription: CODEX_PLAN_LABELS[data.plan_type] || (data.plan_type ? `ChatGPT (${data.plan_type})` : null),
    limitReached: !!(rl.limit_reached || data.rate_limit_reached_type),
    updatedAt: new Date().toISOString(),
  };
}

// Caché + promesa compartida de Codex (mismo patrón que Claude), por usuario.
const codexCaches = new Map();
const CODEX_TTL_MS = 120000;

// Devuelve el bloque `codex` para /limits: best-effort — ante cualquier fallo
// sirve el último snapshot bueno (`stale`) o, si nunca hubo, null (la sección
// no se muestra). NUNCA lanza: no puede romper la respuesta de límites.
async function getCodexBlock(fresh = false, owner = hostUser()) {
  const slot = cacheFor(codexCaches, owner);
  const now = Number(process.hrtime.bigint()) / 1e6;
  if (!fresh && slot.data && now - slot.at < CODEX_TTL_MS) return slot.data;
  try {
    if (!slot.promise) {
      slot.promise = fetchCodexLimits(owner)
        .then((result) => {
          slot.data = result;
          slot.at = Number(process.hrtime.bigint()) / 1e6;
          if (result) writePersistedCodex(result, owner);
          return result;
        })
        .finally(() => { slot.promise = null; });
    }
    return await slot.promise;
  } catch (err) {
    const expired = !!err?.expired;
    const fallback = slot.data || await readPersistedCodex(owner);
    if (fallback) return { ...fallback, stale: true, staleReason: err.message || null, expired };
    // Sin snapshot previo: si la sesión venció igual hay que DECIRLO (con
    // `limits: []` el front pinta el bloque y su aviso). Cualquier otro fallo
    // sigue devolviendo null y la sección no aparece.
    if (expired) {
      return { limits: [], credits: null, subscription: null, limitReached: false, stale: true, expired: true, staleReason: err.message || null, updatedAt: null };
    }
    return null;
  }
}

// Cache de límites por usuario: consulta remota, TTL más largo que el summary local.
const limitsCaches = new Map();
// TTL más largo (2 min): el medidor OAuth de Anthropic devuelve 429 si se lo
// consulta seguido (compartido con el propio CLI). Con el poll del pie cada 5 s,
// esto hace que solo ~1 de cada 24 lecturas golpee de verdad a Anthropic.
const LIMITS_TTL_MS = 120000;
const LIMITS_AUTH_EXPIRED_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Promesa compartida por usuario: evita fetchPlanLimits() concurrentes (p.ej. dos
// requests casi simultáneas que pasan el check de TTL antes de que la
// primera actualice limitsAt).
function ownerOf(req, res) {
  try {
    const principal = principalOf(req);
    const owner = principal?.username || (principal?.type === 'token' ? hostUser() : null);
    if (!owner) throw new Error('principal sin usuario');
    return sanitizeUserId(owner);
  } catch {
    res.status(400).json({ error: 'Usuario inválido.' });
    return null;
  }
}

export default {
  name: 'tokens',

  registerHttp(router) {
    // BUG-1874: todo el módulo queda aislado por el principal autenticado.
    // El owner nunca se acepta desde query ni headers.
    const r = express.Router();

    // ?fresh=1 saltea el TTL del summary (botón Actualizar del modal Uso);
    // el caché por archivo (mtime+size) queda: solo re-parsea lo que cambió.
    r.get('/summary', async (req, res) => {
      const owner = ownerOf(req, res);
      if (!owner) return;
      try {
        res.json(publicSummary(await cachedSummary(!!req.query.fresh, owner)));
      } catch (err) {
        res.status(500).json({ error: 'No se pudo calcular el uso de tokens.' });
      }
    });

    r.get('/flow', async (req, res) => {
      const owner = ownerOf(req, res);
      if (!owner) return;
      try {
        res.json(await computeFlow(owner));
      } catch (err) {
        res.status(500).json({ error: 'No se pudo calcular el caudal de tokens.' });
      }
    });

    // Vista Raw (PLAN-544): fragmentos de TEXTO REAL recién escritos por las
    // sesiones (Claude+Codex), etiquetados por mundo/sesión/modelo, para que la
    // lluvia estilo Matrix sea lo que se procesa de verdad. ?since=<seq> devuelve
    // solo lo nuevo (multi-ventana safe). 0 tokens, solo lee bytes apendeados.
    r.get('/stream', async (req, res) => {
      const owner = ownerOf(req, res);
      if (!owner) return;
      try {
        const since = Number.parseInt(req.query.since, 10);
        res.json(await getStream(Number.isFinite(since) ? since : 0, owner));
      } catch (err) {
        res.status(500).json({ error: 'No se pudo leer el flujo de texto.' });
      }
    });

    // Seed de texto reciente de UNA sesión (para poblar su banda al descubrirla).
    r.get('/stream/seed', async (req, res) => {
      const owner = ownerOf(req, res);
      if (!owner) return;
      try {
        res.json(await getSeed(String(req.query.sid || ''), owner));
      } catch (err) {
        res.status(500).json({ error: 'No se pudo leer el seed.' });
      }
    });

    // Serie de tiempo del consumo por modelo para las gráficas de tendencia:
    //   day   → HOY por hora (de buildSummary.hourlyToday — hoy siempre en disco)
    //   week  → últimos 7 días · month → últimos 30 días (histórico PERSISTENTE
    //           ~/.cwc-data/usage-history.json, independiente de la poda del CLI)
    // Devuelve {range, keys, points, totals}: `totals` (suma por modelo) alimenta
    // la columna "General" del período. 0 tokens.
    r.get('/history', async (req, res) => {
      const owner = ownerOf(req, res);
      if (!owner) return;
      const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'week';
      const project = ['all', 'consola', 'tolkien', 'otros', 'aprendizaje'].includes(req.query.project) ? req.query.project : 'all';
      try {
        if (range === 'day') {
          const sum = await cachedSummary(!!req.query.fresh, owner);
          const s = sum.hourlyToday[project] || sum.hourlyToday.all;
          return res.json({ ...s, project, updatedAt: sum.updatedAt });
        }
        res.json(await readSeries(range, project, owner));
      } catch (err) {
        res.status(500).json({ error: 'No se pudo leer el histórico de uso.' });
      }
    });

    // Límites del plan (ventanas de claude.ai): % usado y hora de reset.
    // ?fresh=1 saltea el TTL (botón Actualizar del modal Uso).
    r.get('/limits', async (req, res) => {
      const owner = ownerOf(req, res);
      if (!owner) return;
      const slot = cacheFor(limitsCaches, owner);
      // Reloj MONOTÓNICO (como /summary): Date.now() retrocede con ajustes
      // NTP y dejaba el caché de límites "fresco" para siempre.
      const now = Number(process.hrtime.bigint()) / 1e6;
      const fresh = !!req.query.fresh;
      // Bloque de Codex: best-effort, EN PARALELO con la lógica de Claude — su
      // propia caché/TTL/fallback; null si nunca hubo dato (la sección no sale).
      // Nunca lanza, así que jamás afecta el status de esta respuesta.
      const codexP = getCodexBlock(fresh, owner);
      if (!fresh && slot.data && now - slot.at < LIMITS_TTL_MS) {
        return res.json({ ...slot.data, codex: await codexP });
      }
      try {
        if (!slot.promise) {
          slot.promise = fetchPlanLimits(owner)
            .then((result) => {
              if (result.unavailable) return result;
              // Igual que en /summary: solo la promesa que construyó el
              // resultado actualiza limitsAt, para que el TTL se cuente
              // desde el momento real de la construcción.
              slot.data = result;
              slot.at = Number(process.hrtime.bigint()) / 1e6;
              // Persiste el último snapshot BUENO a disco (async, no bloquea
              // la respuesta): sobrevive a reinicios del server y sirve de
              // fallback ante un 429/corte de red posterior.
              writePersistedLimits(result, owner);
              return result;
            })
            .finally(() => {
              slot.promise = null;
            });
        }
        const result = await withLocalUsage(await slot.promise, owner);
        if (result?.unavailable && result.authExpired) {
          const snap = slot.data || await readPersistedLimits(owner);
          const fresh24h = snap?.updatedAt
            && Date.now() - new Date(snap.updatedAt).getTime() < LIMITS_AUTH_EXPIRED_SNAPSHOT_MAX_AGE_MS;
          // La sesión venció: servimos el snapshot reciente marcado stale para
          // conservar las barras y, a la vez, indicar que hay que reconectar.
          if (snap && fresh24h) {
            return res.json({
              ...snap,
              stale: true,
              staleReason: 'auth-expired',
              authExpired: true,
              localUsage: result.localUsage || null,
              codex: await codexP,
            });
          }
        }
        res.json({ ...result, codex: await codexP });
      } catch (err) {
        // FALLBACK: antes un 429/corte de red devolvía el error y el dato
        // "desaparecía" en la UI. Ahora servimos el ÚLTIMO snapshot bueno —
        // de la caché en memoria o, si el server se reinició, del disco —
        // marcado `stale:true` para que el front avise "datos de hace X".
        const fallback = slot.data || await readPersistedLimits(owner);
        if (fallback) {
          return res.json({ ...fallback, stale: true, staleReason: err.message || null, codex: await codexP });
        }
        // Sin dato de Claude previo pero SÍ de Codex: devolvemos un shell con
        // limits vacío + el bloque de Codex (no perdemos la única fuente viva).
        const codex = await codexP;
        if (codex) {
          return res.json({ limits: [], credits: { enabled: false }, subscription: null, codex });
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
