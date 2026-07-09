// modules/tickets/sources.js — capa de LECTURA read-only de las fuentes
// externas (por ahora Zoho Desk; GitHub/PRs para el dev-lane se integra en
// Fase 3 reusando el patrón `gh` de v1). Sin estado en disco: sólo un cache
// EN MEMORIA con TTL, para no re-pegarle a Zoho en cada request del dashboard.
//
// Nota de costo: el listado de Desk viene "trimmed" (sin customFields ni
// modifiedTime/closedTime), así que para derivar lane/aging/resolved hay que
// enriquecer cada ticket con desk_get_ticket. Se hace con concurrencia
// limitada (pool) y se cachea el resultado enriquecido.
import { execFile } from 'node:child_process';
import { listTicketsByDepartment, getTicketState } from './desk-mcp-client.js';
import { DEPT_TOLKIEN, DEPT_MORDOR } from './derive.js';
import { config } from '../../core/config.js';
import { fetchPrRich } from '../comms/pr-read-shared.js';

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

// Pool simple de concurrencia limitada (sin dependencias). Mapea `items` con
// `fn` corriendo hasta `n` a la vez; los errores por item no tumban el lote.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (err) { out[idx] = { __error: String(err?.message || err), item: items[idx] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
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
// Wrapper propio de gh (v2 no depende de v1). cwd = repo Tolkien.
function runGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd: config.projectDir, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args[0]}: ${String(stderr || err.message).trim().slice(0, 200)}`));
      else resolve(String(stdout));
    });
  });
}

let prCache = null;
export async function getDevLanePRs({ force = false } = {}) {
  if (!force && prCache && Date.now() - prCache.at < CACHE_TTL_MS) return prCache.result;
  let result;
  try {
    const out = await runGh(['pr', 'list', '--state', 'open', '--limit', '30',
      '--json', 'number,title,url,headRefName,reviewDecision,statusCheckRollup,isDraft,updatedAt,author']);
    result = { prs: JSON.parse(out), error: null };
  } catch (err) {
    result = { prs: [], error: String(err?.message || err).slice(0, 200) };
  }
  prCache = { at: Date.now(), result };
  return result;
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
