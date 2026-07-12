// modules/tickets/sources.js — capa de LECTURA read-only de las fuentes
// externas (por ahora Zoho Desk; GitHub/PRs para el dev-lane se integra en
// Fase 3 reusando el patrón `gh` de v1). El listado ABIERTO/dev-lane sigue con
// cache EN MEMORIA con TTL. La vista RESUELTOS (más abajo) SÍ persiste a disco
// — ver esa sección.
//
// Nota de costo: el listado de Desk viene "trimmed" (sin customFields ni
// modifiedTime/closedTime), así que para derivar lane/aging/resolved hay que
// enriquecer cada ticket con desk_get_ticket. Se hace con concurrencia
// limitada (pool) y se cachea el resultado enriquecido.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { runAdaptivePool } from '../../core/pool.js';
import { listTicketsByDepartment, getTicketState } from './desk-mcp-client.js';
import { DEPT_TOLKIEN, DEPT_MORDOR } from './derive.js';
import { fetchPrRich, listPrs } from '../comms/pr-read-shared.js';

const DEPARTMENTS = [DEPT_MORDOR, DEPT_TOLKIEN];
const CACHE_TTL_MS = 60_000;      // "fresco": no recargar si es más nuevo que esto
const ENRICH_CONCURRENCY = 5;     // gets en paralelo (regla de oro: paralelo lo que LEE)
const LIST_LIMIT = 100;
// Sólo se enriquecen (get individual) los tickets que ALIMENTAN alguna vista:
// todos los ABIERTOS + los CERRADOS recientes (para "resolved this week"). Los
// cerrados viejos no aparecen en ninguna vista, así que enriquecerlos era puro
// costo (la 1ª carga tardaba 125s por 89 gets + rate-limit de Zoho; con esto
// bajan a ~30). El listado NO trae closedTime, así que se usa createdTime como
// proxy de "reciente" — ventana generosa (21 d) para no perder un cerrado de
// un ticket creado hace un par de semanas. Edge case aceptado: un ticket
// viejo (creado hace >21 d) cerrado esta semana no contaría en resolved-this-week.
const RECENT_CLOSED_DAYS = 21;

let cache = null;       // { at, tickets: [...] }
let inFlight = null;    // promesa de carga en curso (dedup de requests concurrentes)

// Pool de concurrencia limitada, adoptando el pool ADAPTATIVO canónico
// (core/pool.js · runAdaptivePool — coherencia 2026-07-12). Mantiene el contrato
// histórico: mapea `items` con `fn` a lo sumo `n` a la vez, DEVUELVE un array de
// resultados EN ORDEN, y los errores por item no tumban el lote (se capturan como
// {__error}). El techo se fija en `n` (max=start=min) para NO cambiar la carga a
// Zoho (rate-limit): la concurrencia base es idéntica a la anterior; lo que se
// GANA es el back-off adaptativo cuando Zoho tira 429/overload (ctl.backoff()).
const RATE_LIMIT_RE = /429|rate.?limit|too many|overload/i;
async function pool(items, n, fn) {
  const out = new Array(items.length);
  // Índice estable por item: runAdaptivePool no garantiza orden de finalización,
  // así que se guarda el idx original con cada item para escribir en su casillero.
  const indexed = items.map((item, idx) => ({ item, idx }));
  await runAdaptivePool(indexed, async ({ item, idx }, ctl) => {
    try { out[idx] = await fn(item, idx); }
    catch (err) {
      const msg = String(err?.message || err);
      if (RATE_LIMIT_RE.test(msg)) ctl.backoff(); // señal de sobrecarga → baja la concurrencia
      out[idx] = { __error: msg, item };
    }
  }, { min: n, start: n, max: n });
  return out;
}

async function loadFresh() {
  // 1) Listado trimmed de cada dept (barato: 1 llamada por dept).
  const lists = await pool(DEPARTMENTS, DEPARTMENTS.length, (dept) => listTicketsByDepartment(dept, LIST_LIMIT));
  const allStubs = lists.flat().filter((t) => t && t.id && !t.__error);

  // 2) Filtrar a lo que alimenta alguna vista: abiertos + cerrados recientes.
  const cutoff = Date.now() - RECENT_CLOSED_DAYS * 86_400_000;
  const toEnrich = allStubs.filter((s) => {
    if (s.statusType !== 'Closed') return true;               // todos los abiertos
    const created = Date.parse(s.createdTime || '');
    return Number.isFinite(created) && created >= cutoff;      // cerrados recientes (proxy)
  });

  // 3) Enriquecer sólo esos (customFields + modifiedTime + closedTime).
  //    getTicketState acepta el ID interno directo (no re-resuelve).
  const enriched = await pool(toEnrich, ENRICH_CONCURRENCY, (s) => getTicketState(s.id));
  const tickets = enriched.filter((t) => t && t.found && !t.__error);

  return { at: Date.now(), tickets, totalListed: allStubs.length, enrichedCount: tickets.length };
}

// Devuelve los tickets enriquecidos (todos los depts), usando el cache si está
// fresco. `force` salta el cache. Dedup: requests concurrentes comparten la
// misma carga en vuelo (no disparan N cargas en paralelo).
export async function getTickets({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.tickets;
  if (inFlight) return inFlight;
  inFlight = loadFresh()
    .then((fresh) => { cache = fresh; return fresh.tickets; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// ===== Dev-lane: PRs abiertos de Tolkien (GitHub, vía gh — determinístico) =====
// El `gh pr list` sale del LECTOR ÚNICO comms/pr-read-shared.js:listPrs (fuente
// canónica, coherencia 2026-07-10): antes este módulo tenía su propio wrapper
// `runGh` duplicando la llamada del comms-runner. La caché EN MEMORIA prCache
// (TTL 60s) sigue siendo el gate primario; listPrs solo unifica el fetch crudo.
let prCache = null;
export async function getDevLanePRs({ force = false } = {}) {
  if (!force && prCache && Date.now() - prCache.at < CACHE_TTL_MS) return prCache.result;
  let result;
  try {
    const prs = await listPrs({ state: 'open', limit: 30 });
    result = { prs, error: null };
  } catch (err) {
    result = { prs: [], error: String(err?.message || err).slice(0, 200) };
  }
  prCache = { at: Date.now(), result };
  return result;
}

// ===== Vista RESUELTOS: STORE PERSISTENTE (pedido Niko 2026-07-10) =====
// A diferencia del resto de este archivo (cache en memoria, se pierde al
// reiniciar), Resueltos es una "base de datos" chica en disco que SE MANTIENE
// y sólo AGREGA: un ticket cerrado no cambia nunca más (Zoho no lo reabre en la
// práctica de este flujo) y un PR mergeado tampoco — así que una vez que algo
// entró acá, NUNCA se vuelve a pedir a Zoho/GitHub. Sobrevive reinicios
// (arranque instantáneo) y con el tiempo termina cubriendo MÁS histórico del
// que cualquier listado individual puede traer (Zoho no pagina, tope ~100/depto
// por llamada — ver nota más abajo), porque cada pasada suma lo nuevo sin
// perder lo viejo.
const RESOLVED_STORE_FILE = path.join(os.homedir(), '.cwc-data', 'tickets-resolved.json');
let resolvedStore = null;        // { ticketsById: {}, prsByNumber: {} } — cargado 1 vez, en memoria de ahí en más
function loadResolvedStore() {
  if (resolvedStore) return resolvedStore;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(RESOLVED_STORE_FILE, 'utf8')); } catch { /* sin store previo */ }
  resolvedStore = {
    ticketsById: (parsed && typeof parsed.ticketsById === 'object' && parsed.ticketsById) || {},
    prsByNumber: (parsed && typeof parsed.prsByNumber === 'object' && parsed.prsByNumber) || {},
  };
  return resolvedStore;
}
function saveResolvedStore() {
  // Atómico (tmp+rename): un reinicio a mitad de escritura no corrompe el store.
  try { writeJsonAtomic(RESOLVED_STORE_FILE, resolvedStore); }
  catch (err) { console.error('[tickets] no pude persistir resueltos:', err?.message); }
}

function sortMerged(prs) {
  return prs.sort((a, b) => (Date.parse(b.mergedAt || '') || 0) - (Date.parse(a.mergedAt || '') || 0));
}

// ===== LECTURA INSTANTÁNEA del store (0 red — la usa el endpoint) =====
// Rediseño 2026-07-10 (pedido Niko): la vista Resueltos ya NO enriquece dentro
// del request (eso causaba el "pensando" de 1-2 min). El REFRESHER de fondo
// mantiene el store al día cada 60s (ver refresher.js → refreshResolved), y el
// endpoint sólo LEE de acá. Instantáneo, sin tocar Zoho/GitHub.
//   `meta`: at (última pasada OK), refreshing (hay una en curso), listed/capped
//   de la última pasada. `ready` = ya hay al menos una pasada completada.
let resolvedMeta = { at: 0, listed: null, capped: false, refreshing: false, error: null, ready: false };
export function readResolved() {
  const store = loadResolvedStore();
  return {
    tickets: Object.values(store.ticketsById),
    prs: sortMerged(Object.values(store.prsByNumber)),
    meta: { ...resolvedMeta },
  };
}

// Metadata de la última pasada (sin construir las arrays) — para el generatedAt.
export function resolvedInfo() { return { ...resolvedMeta }; }

// Busca un ticket CERRADO en el store persistido, por número humano ('527') o id
// interno de Zoho. Lo usa el detalle de ticket para servir un cerrado que vive
// SÓLO en la base de resueltos SIN golpear Zoho en vivo (fuente de consulta
// uniforme con el dashboard, 0 red). Devuelve el raw enriquecible, o null.
export function findResolvedTicket(numberOrId) {
  const store = loadResolvedStore();
  const key = String(numberOrId);
  if (store.ticketsById[key]) return store.ticketsById[key];   // match por id interno
  for (const t of Object.values(store.ticketsById)) {          // match por número humano
    if (String(t.ticketNumber) === key) return t;
  }
  return null;
}

// ===== REFRESCO EN FONDO (lo llama el refresher cada 60s) =====
// Actualiza AMBAS "tablas" del store (tickets cerrados + PRs mergeados) en una
// sola pasada dedup'd. TTL interno: aunque el refresher lo llame cada 60s, sólo
// vuelve a listar/pedir cada RESOLVED_CHECK_TTL_MS (los resueltos cambian lento).
// `force` (botón ↑) saltea el TTL. Recibe `agentsById` del refresher para stampear
// ownerName SIN una llamada extra a Desk — así el read del endpoint es 0-red.
//
// INCREMENTAL: enriquece SOLO los cerrados que TODAVÍA no están en el store — un
// ticket ya guardado NUNCA se vuelve a pedir (customFields/closedTime no cambian).
// El listado también RECONCILIA: si un guardado ahora lista como no-cerrado
// (reabierto en Zoho), sale del store, sin gastar un get extra.
// LÍMITE DE PLATAFORMA: el MCP desk_list_tickets NO pagina (`from`), así que cada
// listado topa ~100/depto. El store igual va acumulando más historial con cada
// pasada que trae cerrados nuevos.
const RESOLVED_CHECK_TTL_MS = 120_000; // cada cuánto revisar novedades (cerrados/mergeados/reaperturas)
const RESOLVED_ENRICH_CAP = 160;       // techo de gets NUEVOS por pasada (rate-limit de Zoho)
let resolvedInFlight = null;
export async function refreshResolved({ agentsById = {}, force = false } = {}) {
  const store = loadResolvedStore();
  // Re-stampea ownerName en TODOS los guardados con el mapa fresco (barato, 0 red):
  // mantiene los dueños al día y sana registros viejos guardados sin ownerName.
  for (const t of Object.values(store.ticketsById)) {
    const owner = t.assigneeId ? agentsById[String(t.assigneeId)] : null;
    t.ownerName = owner?.name || t.ownerName || null;
  }
  const fresh = !force && resolvedMeta.at > 0 && Date.now() - resolvedMeta.at < RESOLVED_CHECK_TTL_MS;
  if (fresh) { resolvedMeta.ready = true; return readResolved(); }
  if (resolvedInFlight) return resolvedInFlight;
  resolvedMeta.refreshing = true;
  resolvedInFlight = (async () => {
    // ── Tabla 1: PRs mergeados (barato, 1 llamada gh; acumula por número) ──
    // Vía la fuente única listPrs (comms/pr-read-shared.js); persistencia por
    // número en el store SIN cambios.
    let prError = null;
    try {
      const merged = await listPrs({ state: 'merged', limit: 200 });
      for (const pr of merged) store.prsByNumber[String(pr.number)] = pr;
    } catch (err) { prError = String(err?.message || err).slice(0, 200); }

    // ── Tabla 2: tickets cerrados (lista 2 deptos; enriquece sólo lo nuevo) ──
    const lists = await pool(DEPARTMENTS, DEPARTMENTS.length, (dept) => listTicketsByDepartment(dept, 100));
    const deptsOk = lists.filter((l) => Array.isArray(l));
    // Si NINGÚN depto respondió (timeout del MCP compartido con otras sesiones de
    // la máquina), NO marcamos la pasada como OK: el próximo tick reintenta en vez
    // de dejar el store "fresco" con datos incompletos por 2 minutos.
    if (!deptsOk.length) {
      saveResolvedStore(); // igual persistimos los PRs que sí llegaron
      resolvedMeta = { ...resolvedMeta, refreshing: false, ready: resolvedMeta.ready || false,
        error: 'Zoho Desk no respondió (timeout del MCP) — se reintenta en el próximo ciclo.', at: resolvedMeta.at };
      return readResolved();
    }
    const stubs = lists.flat().filter((t) => t && t.id && !t.__error);
    const listingCapped = lists.some((l) => Array.isArray(l) && l.length >= 100);
    // Reconciliación: guardado que ya NO figura cerrado → se reabrió, sale del store.
    for (const s of stubs) {
      if (s.statusType !== 'Closed' && store.ticketsById[String(s.id)]) delete store.ticketsById[String(s.id)];
    }
    const closed = stubs.filter((s) => s.statusType === 'Closed');
    const toEnrich = closed.filter((s) => !store.ticketsById[String(s.id)]);
    const enrichCapped = toEnrich.length > RESOLVED_ENRICH_CAP;
    const batch = toEnrich.slice(0, RESOLVED_ENRICH_CAP);
    let saved = 0;
    if (batch.length) {
      const enriched = await pool(batch, ENRICH_CONCURRENCY, (s) => getTicketState(s.id));
      for (const t of enriched) if (t && t.found && !t.__error && t.id != null) {
        const owner = t.assigneeId ? agentsById[String(t.assigneeId)] : null;
        store.ticketsById[String(t.id)] = { ...t, ownerName: owner?.name || null };
        saved += 1;
      }
    }
    saveResolvedStore();
    resolvedMeta = {
      at: Date.now(), listed: closed.length, capped: listingCapped || enrichCapped,
      refreshing: false, ready: true, error: prError,
    };
    return readResolved();
  })()
    .catch((err) => {
      resolvedMeta.refreshing = false;
      resolvedMeta.error = String(err?.message || err).slice(0, 200);
      return readResolved();
    })
    .finally(() => { resolvedInFlight = null; });
  return resolvedInFlight;
}

// Detalle COMPLETO de un PR (conversaciones, checks, archivos) — on-demand.
// Reusa el LECTOR ÚNICO de PRs de GitHub (comms/pr-read-shared.js, Fase C de la
// centralización 2026-07-05): UN fetch + caché de archivo (~/.cwc-data/comms/
// pr-cache/, TTL 60s) compartido con comms/bugfixes/investigate — antes v2
// duplicaba su propio `gh pr view` + caché en memoria (misma clase de
// duplicación que ya se pagó y resolvió una vez). Los campos que pedía v2
// (body/baseRefName/isDraft/files) están sumados a PR_RICH_FIELDS. `force`
// fuerza red (mapea a `fresh` de fetchPrRich, que igual reescribe la caché para
// que otros reusen). Contrato { pr, error } IDÉNTICO al anterior.
export async function getPrDetail(number, { force = false } = {}) {
  const key = String(number).replace(/[^\d]/g, '');
  try {
    const pr = await fetchPrRich(key, { fresh: force });
    return { pr, error: null };
  } catch (err) {
    return { pr: null, error: String(err?.message || err).slice(0, 200) };
  }
}

export function cacheInfo() {
  return {
    cached: !!cache,
    at: cache?.at ?? null,
    count: cache?.tickets?.length ?? 0,
    totalListed: cache?.totalListed ?? null,
    ttlMs: CACHE_TTL_MS,
  };
}
