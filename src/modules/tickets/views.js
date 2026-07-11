// modules/tickets/views.js — agregaciones para las vistas del dashboard One
// Front Door, a partir de los tickets enriquecidos (derive.enrich). Funciones
// puras: entra la lista + now, sale el shape que consume el frontend.
import { enrich } from './derive.js';

const LANES = ['bug', 'feature', 'hardware', 'access', 'platform', 'onboarding', 'facilities-house', 'facilities-office', 'other'];

function slim(t) {
  return {
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    lane: t.lane,
    priority: t.priority_norm,
    status: t.status,
    lifecycle: t.lifecycle,
    waitingOn: t.waitingOn,
    ownerName: t.ownerName ?? null, // para el filtro por propietario (pestañas)
    businessHoursSinceUpdate: t.clock.businessHoursSinceUpdate,
    overdue: t.clock.overdue,
    agingDays: t.aging.days,
    webUrl: t.webUrl,
    stale: !!t._stale, // conservado de una pasada previa (no vino en el último refresh)
  };
}

export function buildDashboard(rawTickets, nowMs) {
  const tickets = rawTickets.map((t) => enrich(t, nowMs));
  const open = tickets.filter((t) => t.statusType !== 'Closed');

  // 1. Open by lane + priority
  const openByLane = {};
  for (const lane of LANES) openByLane[lane] = { total: 0, P1: 0, P2: 0, P3: 0, unset: 0 };
  for (const t of open) {
    const b = (openByLane[t.lane] ||= { total: 0, P1: 0, P2: 0, P3: 0, unset: 0 });
    b.total += 1;
    b[t.priority_norm || 'unset'] += 1;
  }

  // 2. Waiting-on breakdown
  const waitingOn = { dev: 0, requester: 0, triage: 0 };
  for (const t of open) if (t.waitingOn) waitingOn[t.waitingOn] = (waitingOn[t.waitingOn] || 0) + 1;

  // Rediseño 2026-07-09 (pedido Niko): la vista ACTIVA tiene 3 buckets — Nuevos,
  // Vencidos, En progreso — y cada ticket ABIERTO cae en UNO solo. Los cerrados
  // salen de acá (viven en la vista RESUELTOS, on-demand: buildResolved).
  //   · Vencidos = overdue (SLA 48h háb roto) O aging (7+ días sin update).
  //     Decisión de Niko: "sin update" NO es su propia columna, entra en Vencidos.
  //   · Nuevos = sin triar (waitingOn 'triage') que todavía no vencieron.
  //   · En progreso = todo el resto abierto (dev + espera-cliente sanos). Absorbe
  //     las viejas columnas "En espera cliente" y "Sin update", que desaparecen.
  const isVencido = (t) => t.clock.overdue || t.aging.aging;
  const byStale = (a, b) => b.clock.businessHoursSinceUpdate - a.clock.businessHoursSinceUpdate;
  const vencidos = open.filter(isVencido)
    .sort((a, b) => b.aging.days - a.aging.days).map(slim);
  const nuevos = open.filter((t) => !isVencido(t) && t.waitingOn === 'triage')
    .sort((a, b) => a.aging.days - b.aging.days).map(slim);
  const enProgreso = open.filter((t) => !isVencido(t) && t.waitingOn !== 'triage')
    .sort(byStale).map(slim);

  return {
    generatedAt: nowMs,
    counts: {
      open: open.length, total: tickets.length,
      nuevos: nuevos.length, vencidos: vencidos.length, enProgreso: enProgreso.length,
    },
    openByLane,
    waitingOn,
    nuevos,
    vencidos,
    enProgreso,
  };
}

// Vista RESUELTOS (on-demand, NO entra en el snapshot de 60s — sería carísimo
// enriquecer todo el histórico cerrado). Recibe los tickets CERRADOS ya
// enriquecidos (getResolvedTickets + ownerName) y devuelve el shape que consume
// el frontend: slim + closedTime, ordenados por cierre desc, + conteo por carril
// para los filtros. Los PRs mergeados se adjuntan aparte en el endpoint.
export function buildResolved(rawTickets, nowMs) {
  const tickets = rawTickets.map((t) => enrich(t, nowMs));
  const slimmed = tickets
    .map((t) => ({ ...slim(t), closedTime: t.closedTime || null, closedMs: Date.parse(t.closedTime || '') || 0 }))
    .sort((a, b) => b.closedMs - a.closedMs);
  const byLane = {};
  for (const lane of LANES) byLane[lane] = 0;
  for (const t of slimmed) byLane[t.lane] = (byLane[t.lane] || 0) + 1;
  return { tickets: slimmed, byLane, count: slimmed.length };
}
