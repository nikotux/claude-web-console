// modules/tickets/views.js — agregaciones para las vistas del dashboard One
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

  // 6. Nuevos · sin triar: abiertos que esperan triage (recién creados, sin
  //    asignar, todavía sin vencer). Es el punto ciego que dejaban las otras
  //    listas — un ticket nuevo no es overdue (reloj sin correr) ni aging (7+
  //    días) ni resuelto ni tiene PR, así que sólo se veía como número en "Por
  //    carril". Más NUEVO primero (menos días de antigüedad arriba).
  const needsTriage = open.filter((t) => t.waitingOn === 'triage')
    .sort((a, b) => a.aging.days - b.aging.days).map(slim);

  // 7 y 8. Estados de TRABAJO que antes caían en el limbo (abiertos, recién
  //    tocados → ni vencidos ni aging, ni nuevos ni resueltos, sin PR): un
  //    ticket se volvía invisible justo cuando MÁS se lo trabajaba. Ahora tienen
  //    hogar propio. Más ESTANCADO primero (más horas sin update arriba).
  //    EXCLUYEN los vencidos/aging (opción B, pedido Niko): un ticket urgente
  //    vive SOLO en su columna de alerta (Vencidos/Aging), no se duplica acá →
  //    cada ticket aparece en UN solo lugar. Estas columnas = "en curso sano".
  const healthy = (t) => !t.clock.overdue && !t.aging.aging;
  const byStale = (a, b) => b.clock.businessHoursSinceUpdate - a.clock.businessHoursSinceUpdate;
  const inProgress = open.filter((t) => t.waitingOn === 'dev' && healthy(t)).sort(byStale).map(slim);
  const waitingClient = open.filter((t) => t.waitingOn === 'requester' && healthy(t)).sort(byStale).map(slim);

  return {
    generatedAt: nowMs,
    counts: {
      open: open.length, total: tickets.length, overdue: overdue.length, aging: aging.length,
      resolvedThisWeek: resolvedThisWeek.length, needsTriage: needsTriage.length,
      inProgress: inProgress.length, waitingClient: waitingClient.length,
    },
    openByLane,
    waitingOn,
    needsTriage,
    inProgress,
    waitingClient,
    overdue,
    aging,
    resolvedThisWeek,
  };
}
