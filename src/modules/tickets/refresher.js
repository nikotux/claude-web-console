// modules/tickets/refresher.js — "base de datos" con timer (pedido de Niko).
// Cada REFRESH_MS pre-computa en background el SNAPSHOT completo (dashboard +
// tickets por número con su detalle + dev-lane) leyendo Zoho/GitHub de forma
// determinística (sin IA, sin tokens). El servidor sirve SIEMPRE del snapshot,
// así el dashboard y el detalle de cada ticket abren instantáneo, sin golpear
// Zoho en cada apertura.
//
// Es un CACHE derivado: se re-computa solo cada minuto desde la fuente, así que
// no "desincroniza" (el problema de v1 era estado escrito por un proceso frágil
// que NO se refrescaba). Persistido en disco → arranque instantáneo tras reboot.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getTickets, getDevLanePRs, getPrDetail } from './sources.js';
import { listAgents, listContacts } from './desk-mcp-client.js';
import { extractPadRefs, getPadItemsForPr } from './pad-client.js';
import { buildDashboard } from './views.js';
import { enrich, derivePrStatus } from './derive.js';

const SNAP_FILE = path.join(os.homedir(), '.cwc-data', 'bugs-v2-snapshot.json');
const REFRESH_MS = Number(process.env.BUGS_V2_REFRESH_MS) || 60_000;

let snapshot = null;   // { generatedAt, dashboard, ticketsById, error, lastError }
let timer = null;
let refreshing = null; // promesa del refresh en curso (dedup)

function loadFromDisk() {
  try { snapshot = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8')); } catch { /* sin snapshot previo */ }
}
function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(SNAP_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SNAP_FILE, JSON.stringify(snapshot), { mode: 0o600 });
  } catch (err) { console.error('[tickets] no pude persistir el snapshot:', err?.message); }
}

// STORE ACUMULATIVO (pedido Niko 2026-07-07): cada pasada hace UPSERT por id y
// NUNCA borra registros anteriores. Una pasada throttled (Zoho/GitHub/Pad con
// rate-limit) que devuelve menos datos ACTUALIZA lo que llegó y CONSERVA lo que
// no llegó (marcándolo `_stale`). El dashboard se deriva del set COMPLETO mergeado,
// no de la pasada sola → los datos no "parpadean" ni se pierden entre refrescos.
//
// Fuentes best-effort: cada una se captura con .catch → un fallo de Zoho no impide
// que PRs/Pad se actualicen, y viceversa. `null` = "esta pasada no trajo datos
// frescos de esa fuente" → se conserva el store previo tal cual.
async function computeSnapshot(prev) {
  const now = Date.now();
  const [tickets, dl, agents, contacts] = await Promise.all([
    getTickets({ force: true }).catch(() => null),
    getDevLanePRs({ force: true }).catch(() => null),
    listAgents().catch(() => []),
    listContacts(100).catch(() => []),
  ]);
  const agentsById = {};
  for (const a of (agents || [])) if (a?.id) agentsById[String(a.id)] = { name: a.name || null, email: a.email || null };
  const contactsById = {};
  for (const c of (contacts || [])) if (c?.id) {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null;
    contactsById[String(c.id)] = { name, email: c.email || null };
  }

  // ── MERGE de TICKETS (raw) ──────────────────────────────────────────────
  // Arranca con TODO el store previo; upsert de lo que llegó fresco; lo que no
  // vino esta pasada queda con `_stale=true` (conservado, no borrado).
  const rawTicketsById = { ...(prev?.rawTicketsById || {}) };
  for (const k of Object.keys(rawTicketsById)) rawTicketsById[k] = { ...rawTicketsById[k], _stale: true };
  if (Array.isArray(tickets)) {
    for (const t of tickets) {
      const k = t?.ticketNumber != null ? String(t.ticketNumber) : null;
      if (!k) continue;
      const owner = t.assigneeId ? agentsById[String(t.assigneeId)] : null;
      const contact = t.contactId ? contactsById[String(t.contactId)] : null;
      rawTicketsById[k] = {
        ...t,
        ownerName: owner?.name || null, ownerEmail: owner?.email || null,
        contactName: contact?.name || null, contactEmail: contact?.email || t.email || null,
        _fetchedAt: now, _stale: false,
      };
    }
  }
  const allRaw = Object.values(rawTicketsById);

  // El dashboard se deriva del set COMPLETO mergeado (no solo de esta pasada).
  const dashboard = buildDashboard(allRaw, now);

  // ── MERGE de PR summaries (dev-lane) ────────────────────────────────────
  const prSummariesById = { ...(prev?.prSummariesById || {}) };
  for (const k of Object.keys(prSummariesById)) prSummariesById[k] = { ...prSummariesById[k], _stale: true };
  if (dl && Array.isArray(dl.prs)) {
    for (const pr of dl.prs) {
      prSummariesById[String(pr.number)] = {
        number: pr.number, title: String(pr.title || '').slice(0, 120),
        url: pr.url, branch: pr.headRefName || null,
        author: pr.author?.login || null, authorName: pr.author?.name || null,
        ...derivePrStatus(pr), _fetchedAt: now, _stale: false,
      };
    }
  }
  dashboard.devLane = {
    error: dl?.error || null,
    prs: Object.values(prSummariesById).sort((a, b) => (b.number || 0) - (a.number || 0)),
  };

  // ── MERGE de PR detail + Pad ────────────────────────────────────────────
  // Solo re-fetchea el detalle/Pad de los PRs que vinieron ESTA pasada; los que
  // no vinieron conservan su detalle previo intacto.
  const prDetailsById = { ...(prev?.prDetailsById || {}) };
  const freshPrs = (dl && Array.isArray(dl.prs)) ? dl.prs : [];
  await Promise.all(freshPrs.map(async (pr) => {
    try {
      const d = await getPrDetail(pr.number, { force: true });
      if (d.pr) prDetailsById[String(pr.number)] = { ...(prDetailsById[String(pr.number)] || {}), ...d.pr };
    } catch { /* conserva el detalle previo */ }
  }));
  for (const pr of freshPrs) {
    const num = String(pr.number);
    const det = prDetailsById[num];
    if (!det) continue;
    det.padRefs = extractPadRefs(det);
    const res = await getPadItemsForPr(det); // bidireccional: refs + branch + título
    const prevItems = prev?.prDetailsById?.[num]?.padItems || [];
    const prevFetchedAt = prev?.prDetailsById?.[num]?.padFetchedAt || null;
    if (!res.error && res.items.length) {
      // Datos frescos y no vacíos → actualiza.
      det.padItems = res.items; det.padError = null; det.padFetchedAt = now; det.padStale = false;
    } else if (res.error || (!res.items.length && prevItems.length)) {
      // Error, O vacío pero ANTES teníamos items (throttle transitorio) → CONSERVA.
      det.padItems = prevItems; det.padError = res.error || null;
      det.padFetchedAt = prevFetchedAt; det.padStale = true;
    } else {
      // Vacío legítimo (nunca tuvo items) → vacío.
      det.padItems = res.items; det.padError = null; det.padFetchedAt = now; det.padStale = false;
    }
  }

  // ── Índice enriquecido para el modal (desde el store COMPLETO mergeado) ──
  const ticketsById = {};
  for (const raw of allRaw) {
    if (raw?.ticketNumber == null) continue;
    ticketsById[String(raw.ticketNumber)] = { ...enrich(raw, now), _stale: !!raw._stale, _fetchedAt: raw._fetchedAt || null };
  }

  return { generatedAt: now, dashboard, ticketsById, prDetailsById, rawTicketsById, prSummariesById, error: null };
}

// Un refresh a la vez (dedup). Si falla, conserva el snapshot anterior y anota
// lastError (no deja al dashboard sin datos por un hipo puntual de Zoho).
export function refreshNow() {
  if (refreshing) return refreshing;
  refreshing = computeSnapshot(snapshot) // pasa el snapshot previo (merge de Pad)
    .then((snap) => { snapshot = snap; saveToDisk(); return snap; })
    .catch((err) => {
      const msg = String(err?.message || err).slice(0, 200);
      if (snapshot) snapshot.lastError = msg;
      else snapshot = { generatedAt: Date.now(), dashboard: null, ticketsById: {}, error: msg };
      return snapshot;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export function startRefresher() {
  if (timer) return;
  loadFromDisk();          // arranque instantáneo con el último snapshot en disco
  refreshNow();            // y dispara el primer refresh fresco en background
  timer = setInterval(refreshNow, REFRESH_MS);
  timer.unref?.();         // no bloquea el cierre del proceso
  console.log(`[tickets] refresher activo cada ${Math.round(REFRESH_MS / 1000)}s`);
}

export function getSnapshot() { return snapshot; }
