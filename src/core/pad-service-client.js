// core/pad-service-client.js — cliente REST HTTP reusable al Pad LOCAL self-hosted
// (workspace `console`). Distinto de src/modules/tickets/pad-client.js (que habla con
// el Pad CLOUD de Tolkien vía MCP+OAuth de Claude Code, sin cambios, ver CLAUDE.md).
//
// MECANISMO (investigado 2026-07-12, Fase 0 de ROAD-110): el binario local del Pad
// expone una API REST propia en /api/v1/... (la misma que usa su web UI/CLI), NO
// requiere el protocolo MCP para operaciones simples. Auth por Bearer con el token
// de SESIÓN del CLI (`padsess_...`), leído FRESCO de ~/.pad/credentials.json en cada
// llamada — es un token propio del server local (creado por `pad auth login`,
// aprobado por Niko en su navegador), INDEPENDIENTE del OAuth de Claude Code que
// usa pad-client.js (ese vence cada ~1h y depende de que Claude Code esté corriendo;
// éste no tiene ninguna de las dos limitaciones).
//
// RESILIENCIA (regla de oro / patrón best-effort de todo el proyecto): si el Pad
// local está caído o el token no existe/es inválido, las funciones devuelven
// { ok:false, error } en vez de tirar una excepción sin control — un módulo que
// use este cliente debe degradar con gracia (cache/último estado bueno), nunca
// tumbar el resto de Consola.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CREDS = path.join(os.homedir(), '.pad', 'credentials.json');
const DEFAULT_URL = process.env.CWC_PAD_URL || 'http://10.213.222.62:7777';
const DEFAULT_WORKSPACE = process.env.CWC_PAD_WORKSPACE || 'console';
const REQUEST_TIMEOUT_MS = 10_000;

// ───────────────────────────────────────────────────────────────────────────
// TRANSPORTE PROTEGIDO (2026-07-12, RDA-347 / TDA-348 — optimización del Banco
// de Conocimiento). Dos capas sobre el fetch crudo, porque TODOS los módulos
// comparten este cliente y el punto de estrangulamiento es el rate-limiter
// POR-USUARIO de Pad local:
//
//  1) GATE GLOBAL — un semáforo de proceso (MAX_CONCURRENT) + back-off ante 429.
//     Aunque un caller olvide acotar su fan-out, nunca habrá más de N requests
//     simultáneos contra Pad, y un 429 PAUSA todo el tráfico por BACKOFF_MS y
//     reintenta (hasta MAX_RETRIES_429). Es la red de seguridad transversal que
//     complementa al mapPooled por-módulo (tasks 756c036).
//  2) CACHÉ DE LECTURA — los GET se sirven de memoria (TTL corto + invalidación
//     inmediata en cada write + barrido de refresco en background). El dashboard
//     deja de pegarle a Pad local en cada carga (de ~25ms bajo contención a ~0ms).
//
// Kill switches: CWC_PAD_CACHE=0 apaga la caché; CWC_PAD_MAXCONC / CWC_PAD_BACKOFF_MS
// / CWC_PAD_CACHE_TTL_MS ajustan los topes. Ante cualquier rareza, apagar la caché
// deja el comportamiento idéntico al histórico (fetch directo, sin memoria).
const MAX_CONCURRENT = Number(process.env.CWC_PAD_MAXCONC) || 6;             // tope POR-USUARIO (por token)
const GLOBAL_MAX = Number(process.env.CWC_PAD_GLOBAL_MAXCONC) || Math.max(MAX_CONCURRENT * 4, MAX_CONCURRENT); // tope AGREGADO (todos los usuarios juntos)
const BACKOFF_MS = Number(process.env.CWC_PAD_BACKOFF_MS) || 3000;
const MAX_RETRIES_429 = 3;
const CACHE_ENABLED = process.env.CWC_PAD_CACHE !== '0';
const CACHE_TTL_MS = Number(process.env.CWC_PAD_CACHE_TTL_MS) || 30_000;

function readSessionToken(serverUrl) {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const entry = raw?.credentials?.[serverUrl];
    if (!entry?.token) return null;
    return entry.token;
  } catch {
    return null;
  }
}

// Resuelve la identidad de la operación. Sin ctx es el HOST y conserva el
// comportamiento histórico (token de Niko de ~/.pad + 'console'). CON ctx, su
// token es la ÚNICA credencial válida: si falta debe fallar limpio, nunca pedir
// prestada la del host (console:BUG-2287).
function resolveCtx(opts = {}) {
  const ctx = opts.ctx || null;
  const url = (ctx && ctx.url) || DEFAULT_URL;
  const token = ctx ? (ctx.token || null) : readSessionToken(url);
  const workspace = (ctx && ctx.workspace) || opts.workspace || DEFAULT_WORKSPACE;
  return { url, token, workspace };
}

// --- Gate POR-USUARIO (TASK-670): segmentado por clave = url + token. Cada
// inquilino tiene su propio bucket de rate-limit en el Pad; con un gate global
// el back-off de un usuario ruidoso PENALIZABA a todos. Ahora un 429 pausa SOLO
// la cola de ESE usuario. Encima hay un cap AGREGADO (GLOBAL_MAX) que acota el
// total en vuelo de todos juntos, para proteger al host/Pad aunque N usuarios
// disparen a la vez. Retrocompat: el host (token de ~/.pad) es una clave mas.
function gateKey(url, token) { return String(url) + '::' + (token || 'anon'); }
const gates = new Map(); // key -> { inFlight, pauseUntil, waiters }
function gateFor(key) {
  let g = gates.get(key);
  if (!g) { g = { inFlight: 0, pauseUntil: 0, waiters: [] }; gates.set(key, g); }
  return g;
}
// Cap agregado (sin back-off propio: el back-off es siempre por-usuario).
let globalInFlight = 0;
const globalWaiters = [];
function acquireGlobal() {
  return new Promise((resolve) => {
    const attempt = () => {
      if (globalInFlight < GLOBAL_MAX) { globalInFlight += 1; resolve(); return; }
      globalWaiters.push(attempt);
    };
    attempt();
  });
}
function releaseGlobal() {
  globalInFlight = Math.max(0, globalInFlight - 1);
  const next = globalWaiters.shift();
  if (next) next();
}
// Adquiere PRIMERO el slot por-usuario (respeta su semaforo + su back-off) y
// LUEGO el slot agregado. Un 429 de otro usuario nunca frena esta cola.
async function acquire(key) {
  const g = gateFor(key);
  await new Promise((resolve) => {
    const attempt = () => {
      const wait = g.pauseUntil - Date.now();
      if (wait > 0) { setTimeout(attempt, wait); return; } // back-off de ESTE usuario
      if (g.inFlight < MAX_CONCURRENT) { g.inFlight += 1; resolve(); return; }
      g.waiters.push(attempt); // sin slot propio: encolar; release(key) reintenta
    };
    attempt();
  });
  await acquireGlobal();
}
function release(key) {
  releaseGlobal();
  const g = gates.get(key);
  if (!g) return;
  g.inFlight = Math.max(0, g.inFlight - 1);
  const next = g.waiters.shift();
  if (next) next();
  // GC: bucket vacio y sin back-off vigente -> liberar la entrada del mapa (evita
  // fuga de memoria con muchos usuarios efimeros). Un gate pausado se conserva.
  if (g.inFlight === 0 && g.waiters.length === 0 && g.pauseUntil <= Date.now()) gates.delete(key);
}
function signal429(key) { gateFor(key).pauseUntil = Date.now() + BACKOFF_MS; }

// --- Caché de lectura: urlPath -> { data, ts }. Solo GET. --------------------
const readCache = new Map();
function cacheGet(urlPath) {
  const hit = readCache.get(urlPath);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.data;
  return undefined;
}
function cacheSet(urlPath, data) { readCache.set(urlPath, { data, ts: Date.now() }); }
// Un write invalida TODAS las lecturas cacheadas de ese workspace (coarse pero
// correcto: los writes son raros vs. los reads, y así jamás servimos algo viejo
// tras editar). Si no se puede parsear el workspace, se limpia todo por las dudas.
function invalidateForWrite(urlPath) {
  const m = urlPath.match(/\/workspaces\/([^/]+)\//);
  const ws = m ? m[1] : null;
  if (!ws) { readCache.clear(); return; }
  const needle = `/workspaces/${ws}/`;
  for (const key of readCache.keys()) if (key.includes(needle)) readCache.delete(key);
}

// Fetch crudo, SIEMPRE a través del gate (semáforo + back-off/retry ante 429).
async function doFetch(method, urlPath, { body, url, token } = {}) {
  if (!token) return { ok: false, error: 'Pad local: sin token de sesión (correr `pad auth login` contra el server local).' };
  const key = gateKey(url, token); // gate segmentado por usuario (url+token)
  for (let attempt = 0; ; attempt += 1) {
    await acquire(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (res.status === 429 && attempt < MAX_RETRIES_429) {
        signal429(key); // pausa SOLO la cola de ESTE usuario y reintenta tras el back-off
        continue;
      }
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
        return { ok: false, error: msg, status: res.status };
      }
      return { ok: true, data, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 200) };
    } finally {
      clearTimeout(timer);
      release(key);
    }
  }
}

// Punto único de todas las operaciones. GET pasa por la caché; los writes la
// invalidan. La forma del retorno ({ ok, data } / { ok:false, error }) no cambia.
async function request(method, urlPath, { body, url = DEFAULT_URL, token } = {}) {
  const isGet = method === 'GET';
  if (isGet && CACHE_ENABLED) {
    const cached = cacheGet(urlPath);
    // Clon defensivo: el caché guarda una sola referencia; sin copiar, un caller
    // que mute el resultado (p.ej. `.sort()` in-place) corrompería a los demás.
    if (cached !== undefined) return { ok: true, data: structuredClone(cached), cached: true };
  }
  const r = await doFetch(method, urlPath, { body, url, token });
  if (isGet) {
    if (CACHE_ENABLED && r.ok) cacheSet(urlPath, r.data);
  } else if (r.ok && CACHE_ENABLED) {
    invalidateForWrite(urlPath);
  }
  return r;
}

// --- API de alto nivel (colección/ítem), workspace por defecto = 'console' ---

export async function listCollections(opts = {}) {
  // Compat histórica: listCollections('console') sigue funcionando como antes.
  if (typeof opts === 'string') opts = { workspace: opts };
  const { url, token, workspace } = resolveCtx(opts);
  return request('GET', `/api/v1/workspaces/${workspace}/collections`, { url, token });
}

// Crea una colección conservando `schema` como string crudo. El caller es
// responsable de NO parsearlo/re-serializarlo antes de llegar acá (DOC-633).
export async function createCollection(collection, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('POST', `/api/v1/workspaces/${workspace}/collections`, {
    body: {
      name: collection.name,
      slug: collection.slug,
      icon: collection.icon,
      prefix: collection.prefix,
      schema: collection.schema,
    },
    url,
    token,
  });
}

export async function updateCollection(collectionSlug, fields, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('PATCH', `/api/v1/workspaces/${workspace}/collections/${collectionSlug}`, {
    body: fields,
    url,
    token,
  });
}

// Bootstrap consolidado que consume `pad_set_workspace`. Va directo a doFetch
// (sin caché) porque Salud audita el tamaño REAL de la respuesta HTTP de esta
// corrida; reserializar el objeto o servir un hit sin sus bytes escondería
// cambios en el blob generado por el server.
export async function getBootstrap(opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return doFetch('GET', `/api/v1/workspaces/${workspace}/agent/bootstrap`, { url, token });
}

// OJO verificado 2026-07-12 (migración tasks/store.js): `all=true` NO es "incluir
// archivados/terminados" — en pruebas reales devolvió MENOS resultados (a veces 0)
// que el default. El default (`all=false`, es decir NO mandar el query param) SÍ
// trae todo lo vivo, incluidos los items en estado terminal (ej. `hecha`/`done`) —
// solo excluye los soft-deleted (`deleted_at` seteado). Para un listado completo
// de una colección, USAR EL DEFAULT (no pasar `all: true`) hasta que se entienda
// mejor la semántica real de ese flag en el server.
export async function listItems(collectionSlug, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  const qs = opts.all ? '?all=true' : '';
  return request('GET', `/api/v1/workspaces/${workspace}/collections/${collectionSlug}/items${qs}`, { url, token });
}

export async function getItem(ref, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('GET', `/api/v1/workspaces/${workspace}/items/${ref}`, { url, token });
}

// Buscar UN item de una colección por su TÍTULO EXACTO — para módulos cuya
// "clave" no es un ref humano de Pad sino un string arbitrario preexistente
// (ej. tickets/meta-store.js: ticketNumber '123' / 'pr:<n>'). No hay
// (todavía) un endpoint de búsqueda por custom field en el server, así que
// esto trae TODOS los items de la colección (listItems, ya cacheable a
// futuro) y filtra en memoria por `title`. Aceptable para volúmenes bajos
// (decenas/pocas centenas de items) — si un consumidor futuro crece mucho,
// conviene pedir un endpoint de filtro server-side en vez de escalar esto.
// Devuelve null si no hay match O si Pad falla (best-effort, nunca tira).
export async function findItemByTitle(collectionSlug, title, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  const qs = opts.all ? '?all=true' : '';
  const r = await request('GET', `/api/v1/workspaces/${workspace}/collections/${collectionSlug}/items${qs}`, { url, token });
  if (!r.ok) return null;
  return r.data.find((it) => it.title === title) || null;
}

// CAMPOS CUSTOM (schema-declared: status/priority/owner/etc.) — OJO CRÍTICO
// verificado 2026-07-12 con pruebas reales contra el server: van SIEMPRE anidados
// bajo una clave `fields: {...}` dentro del objeto que se pasa acá. Si se mandan
// "planos" (ej. `{title, status:'alta', owner:'nico'}` en vez de
// `{title, fields:{status:'alta', owner:'nico'}}`) el server los IGNORA
// silenciosamente y aplica los defaults del schema — sin error, sin pista. Los
// únicos campos que SÍ van planos (no dentro de `fields`) son los nativos del
// item: `title`, `content` (cuerpo markdown) y `tags` (array de strings).
export async function createItem(collectionSlug, fields, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('POST', `/api/v1/workspaces/${workspace}/collections/${collectionSlug}/items`, { body: fields, url, token });
}

// OJO CRÍTICO #2 (verificado 2026-07-12): a diferencia de `title`/`content`/`tags`
// (que si se omiten del body quedan TAL CUAL estaban), el objeto `fields` en un
// PATCH NO se mergea con el existente — lo REEMPLAZA ENTERO. Mandar
// `{fields:{owner:'x'}}` borra silenciosamente status/priority/etc. que no se
// repitan (vuelven al default del schema). Todo caller que actualice `fields`
// debe hacer read-modify-write: leer el item con `getItem`, mergear sus `fields`
// actuales con el patch, y mandar el objeto COMPLETO de vuelta.
export async function updateItem(ref, fields, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('PATCH', `/api/v1/workspaces/${workspace}/items/${ref}`, { body: fields, url, token });
}

// Mover cambia el ref (cambia el prefijo y conserva el número) y el server
// aplica el schema de la colección destino.
export async function moveItem(ref, targetCollectionSlug, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('POST', `/api/v1/workspaces/${workspace}/items/${ref}/move`, {
    body: { target_collection: targetCollectionSlug },
    url,
    token,
  });
}

export async function deleteItem(ref, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('DELETE', `/api/v1/workspaces/${workspace}/items/${ref}`, { url, token });
}

// --- Comentarios (usados por el timeline de un ítem) ---

export async function listComments(ref, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('GET', `/api/v1/workspaces/${workspace}/items/${ref}/comments`, { url, token });
}

export async function addComment(ref, text, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('POST', `/api/v1/workspaces/${workspace}/items/${ref}/comments`, { body: { body: text }, url, token });
}

// Borrar un comentario. OJO verificado 2026-07-12: el endpoint NO cuelga del item
// (no es /items/:ref/comments/:cid, eso da 404) — es un recurso propio del
// workspace direccionado por el UUID del comentario: /workspaces/:ws/comments/:cid.
export async function deleteComment(commentId, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('DELETE', `/api/v1/workspaces/${workspace}/comments/${commentId}`, { url, token });
}

// --- Relaciones (blocks/blocked-by/parent — reemplaza el array `blocks[]`/`planId`
// a mano). OJO verificado 2026-07-12: el endpoint /links exige el UUID INTERNO del
// item destino (`target_id`), NO el ref humano (`PEND-4`) — y el `parent` mandado
// en el body de creación/edición NO se persiste (se probó y no aparece en el GET
// posterior). El único camino real para "parent" también es este mismo endpoint de
// links con link_type='parent'. resolveId() hace la traducción ref→UUID una vez,
// para que el resto del código siga hablando en refs humanos.
const idCache = new Map(); // workspace::ref -> uuid, cache chica en memoria (los ids no cambian)
export async function resolveId(ref, opts = {}) {
  const { workspace } = resolveCtx(opts);
  const cacheKey = `${workspace}::${ref}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  const r = await getItem(ref, opts);
  if (!r.ok || !r.data?.id) return null;
  idCache.set(cacheKey, r.data.id);
  return r.data.id;
}

export async function listLinks(ref, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('GET', `/api/v1/workspaces/${workspace}/items/${ref}/links`, { url, token });
}

// targetRef y ref van como REFS HUMANOS (ej. 'PLAN-3', 'PEND-9') — se resuelven a
// UUID acá adentro. linkType: 'blocks' | 'blocked-by' | 'parent' | etc (igual que
// el MCP de Pad).
export async function addLink(ref, targetRef, linkType = 'blocks', opts = {}) {
  const targetId = await resolveId(targetRef, opts);
  if (!targetId) return { ok: false, error: `Pad: no se encontró el item destino ${targetRef}` };
  const { url, token, workspace } = resolveCtx(opts);
  return request('POST', `/api/v1/workspaces/${workspace}/items/${ref}/links`, {
    body: { target_id: targetId, link_type: linkType },
    url,
    token,
  });
}

// OJO #3 (`console:BUG-2053`): `parent` es un LINK. Un update con `parent=` sobre
// un ítem que ya tenía padre responde 200 pero deja `parent_ref` viejo, crea el link
// nuevo y degrada el anterior a `implements`. Para reparentar: tomar `parent_link_id`,
// hacer `deleteLink` y después `setParent`; nunca alcanza con mandar `parent` al update.
export async function setParent(ref, parentRef, opts = {}) {
  const targetId = await resolveId(parentRef, opts);
  if (!targetId) return { ok: false, error: `Pad: no se encontró el item destino ${parentRef}` };
  const { url, token, workspace } = resolveCtx(opts);
  return request('POST', `/api/v1/workspaces/${workspace}/items/${ref}/links`, {
    body: { target_id: targetId, link_type: 'parent' },
    url,
    token,
  });
}

// Quitar un link (blocks o parent) por su id (el `id` que devuelve addLink/listLinks,
// NO un ref humano). Igual patrón que deleteComment: recurso propio del workspace.
export async function deleteLink(linkId, opts = {}) {
  const { url, token, workspace } = resolveCtx(opts);
  return request('DELETE', `/api/v1/workspaces/${workspace}/links/${linkId}`, { url, token });
}

// Chequeo barato de disponibilidad (para decidir fallback sin pagar el timeout completo
// en cada operación real — usarlo en un healthcheck periódico, no en el hot path).
export async function isAvailable() {
  const r = await listCollections(DEFAULT_WORKSPACE);
  return r.ok;
}

// ───────────────────────────────────────────────────────────────────────────
// CACHÉ: precarga + barrido + control (RDA-347 / TDA-348).
// Los llama server.js en el arranque. Todo best-effort: si Pad local está caído,
// degradan en silencio (nunca tumban el boot).

// Precarga (warm-up): trae al arranque las colecciones "calientes" que la UI
// pide al abrir, para que la PRIMERA carga ya salga de memoria. Secuencial a
// propósito (una tras otra) para no golpear a Pad local en el mismo instante en
// que arranca todo lo demás.
export async function warmCache(collections = []) {
  if (!CACHE_ENABLED) return { warmed: 0 };
  await listCollections(DEFAULT_WORKSPACE);
  let warmed = 0;
  for (const c of collections) {
    const r = await listItems(c, { workspace: DEFAULT_WORKSPACE });
    if (r.ok) warmed += 1;
  }
  return { warmed };
}

// Barrido automático: refresca en background SOLO las claves ya cacheadas (lo
// que alguien realmente usa) para captar cambios externos (otros agentes vía
// MCP, ediciones en otra sesión) sin que el usuario pague el fetch. Con
// intervalMs < CACHE_TTL_MS, las entradas nunca se enfrían: siempre hay un hit
// fresco listo. Secuencial + a través del gate: no puede saturar Pad local.
let sweepTimer = null;
export function startCacheSweep({ intervalMs = 20_000 } = {}) {
  if (!CACHE_ENABLED || sweepTimer) return null;
  sweepTimer = setInterval(async () => {
    for (const urlPath of [...readCache.keys()]) {
      const r = await doFetch('GET', urlPath, { url: DEFAULT_URL, token: readSessionToken(DEFAULT_URL) });
      if (r.ok) cacheSet(urlPath, r.data);
    }
  }, intervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}
export function stopCacheSweep() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }

// Utilidades de control/observabilidad (para un healthcheck o un panel futuro).
export function invalidateCache() { readCache.clear(); }
export function cacheStats() {
  const now = Date.now();
  let pausedForMs = 0;
  for (const g of gates.values()) pausedForMs = Math.max(pausedForMs, g.pauseUntil - now);
  return {
    enabled: CACHE_ENABLED,
    entries: readCache.size,
    inFlight: globalInFlight,        // total agregado en vuelo
    maxConcurrent: MAX_CONCURRENT,   // tope por-usuario
    globalMax: GLOBAL_MAX,           // tope agregado
    gates: gates.size,               // nro de buckets por-usuario activos
    pausedForMs: Math.max(0, pausedForMs),
  };
}
