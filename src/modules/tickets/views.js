// modules/bugs-v2/views.js — agregaciones para las vistas del dashboard One
// Front Door, a partir de los tickets enriquecidos (derive.enrich). Funciones
// puras: entra la lista + now, sale el shape que consume el frontend.
import { enrich } from './derive.js';

const LANES = ['bug', 'feature', 'hardware', 'access', 'platform', 'onboarding', 'other'];

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

  // 3. Overdue follow-ups (lista roja), más viejos primero
  const overdue = open.filter((t) => t.clock.overdue)
    .sort((a, b) => b.clock.businessHoursSinceUpdate - a.clock.businessHoursSinceUpdate).map(slim);

  // 4. Aging (7+ días sin update), más viejos primero
  const aging = open.filter((t) => t.aging.aging)
    .sort((a, b) => b.aging.days - a.aging.days).map(slim);

  // 5. Resolved this week
  const resolvedThisWeek = tickets.filter((t) => t.resolvedThisWeek).map(slim);

  return {
    generatedAt: nowMs,
    counts: { open: open.length, total: tickets.length, overdue: overdue.length, aging: aging.length, resolvedThisWeek: resolvedThisWeek.length },
    openByLane,
    waitingOn,
    overdue,
    aging,
    resolvedThisWeek,
  };
}
