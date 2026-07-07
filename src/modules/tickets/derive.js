// modules/bugs-v2/derive.js — FUNCIONES PURAS estado-de-Zoho → campos del
// dashboard One Front Door. Cero I/O, cero estado, cero IA: entra un ticket
// normalizado (getTicketState) y sale su lane/waiting-on/reloj/aging/resolved.
// Esto es el corazón determinístico de v2: testeable en aislamiento, imposible
// que se desincronice porque no guarda nada — recalcula al vuelo desde la fuente.
//
// Catálogo de lanes descubierto de Zoho el 2026-07-06 (muestra real del dept
// Mordor Staffing + Tolkien). Ver plan:
// ~/pool of documents/2026-07-06_plan-backend-deterministico-lectura-desk_v01.md

export const DEPT_TOLKIEN = '813994000003710353';       // bugs / features
export const DEPT_MORDOR = '813994000000006907';        // hw / access / platform / onboarding / client

// cf_related_to (picklist real) → lane del One Front Door. Se evalúa en orden;
// primer match gana. Los valores llegan como "Hardware (Computador - …)" etc.,
// por eso se matchea por prefijo/keyword, no por igualdad exacta.
const RELATED_TO_LANE = [
  [/^hardware/i, 'hardware'],
  [/^software/i, 'platform'],
  [/internet/i, 'access'],
  [/correo/i, 'access'],
  [/new\s*hire/i, 'onboarding'],
];

function relatedTo(t) {
  return t.customFields?.['Related to'] ?? t.customFields?.cf_related_to ?? '';
}

// Lane. dept Tolkien → bug (feature se distingue por triage/subject, TODO Fase 3);
// [NEW HIRE] en subject SIEMPRE gana (onboarding). Si nada matchea → 'other'.
export function deriveLane(t) {
  if (t.departmentId === DEPT_TOLKIEN) {
    return /\bfeature\b|feature request|would be (great|nice)/i.test(t.subject || '') ? 'feature' : 'bug';
  }
  if (/\[new\s*hire\]/i.test(t.subject || '')) return 'onboarding';
  const rel = relatedTo(t);
  for (const [re, lane] of RELATED_TO_LANE) if (re.test(rel)) return lane;
  return 'other';
}

// Prioridad Zoho (mezcla ES/EN: Alto/Medio/Bajo/High/Medium/Low) → P1/P2/P3.
// null si Zoho no la seteó (frecuente) — el dashboard lo muestra como "sin priorizar".
export function derivePriority(t) {
  const p = String(t.priority || '').toLowerCase();
  if (/alto|high|urgent|p1/.test(p)) return 'P1';
  if (/medio|medium|p2/.test(p)) return 'P2';
  if (/bajo|low|p3/.test(p)) return 'P3';
  return null;
}

// Waiting-on (APROXIMADO por diseño — derivado read-only, ver §5.1 del plan).
// Closed → nadie (resuelto). On Hold/En espera → el solicitante respondió/le toca.
// En progreso o con assignee → el dev. Abierto sin dueño → triage/decisión.
export function deriveWaitingOn(t) {
  if (t.statusType === 'Closed') return null;
  const s = String(t.status || '').toLowerCase();
  if (/hold|espera/.test(s)) return 'requester';
  if (t.assigneeId || /progreso|progress/.test(s)) return 'dev';
  return 'triage';
}

// Lifecycle One Front Door: New → Triaged → In progress → Waiting on → Resolved → Closed.
// Mapeo aproximado desde el status localizado de Zoho.
export function deriveLifecycle(t) {
  if (t.statusType === 'Closed') return 'closed';
  const s = String(t.status || '').toLowerCase();
  if (/hold|espera/.test(s)) return 'waiting';
  if (/progreso|progress/.test(s)) return 'in_progress';
  if (t.assigneeId) return 'triaged';
  return 'new';
}

// Horas HÁBILES (excluye sábado y domingo) entre dos epochs, en zona Bogotá
// (UTC-5, sin DST). Aproximación del "business-hours clock" del One Front Door:
// cuenta horas de lunes a viernes; no modela el horario laboral 9-5 (se puede
// afinar después). Determinístico y puro.
const BOGOTA_OFFSET_MS = 5 * 3600_000; // UTC-5
export function businessHoursBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let hours = 0;
  // Avanza hora por hora (rango típico: días; barato). Cada hora cuenta si su
  // día (en Bogotá) es hábil (lun=1 … vie=5).
  for (let ms = fromMs; ms < toMs; ms += 3600_000) {
    const day = new Date(ms - BOGOTA_OFFSET_MS).getUTCDay(); // 0=dom, 6=sáb
    if (day !== 0 && day !== 6) hours += 1;
  }
  return hours;
}

// Reloj de seguimiento. `nowMs` se inyecta (testeable). Target por defecto 48h
// hábiles (el del One Front Door); overdue si se pasó. Usa modifiedTime como
// "último movimiento" (aprox del último update humano).
export function deriveClock(t, nowMs, targetBusinessHours = 48) {
  const fromMs = Date.parse(t.modifiedTime || t.createdTime || '');
  const bh = businessHoursBetween(fromMs, nowMs);
  return { businessHoursSinceUpdate: bh, target: targetBusinessHours, overdue: t.statusType !== 'Closed' && bh > targetBusinessHours };
}

// Aging: días calendario desde el último update. aging=true a los 7+ días.
export function deriveAging(t, nowMs) {
  const fromMs = Date.parse(t.modifiedTime || t.createdTime || '');
  const days = Number.isFinite(fromMs) ? Math.floor((nowMs - fromMs) / 86_400_000) : 0;
  return { days, aging: t.statusType !== 'Closed' && days >= 7 };
}

// Resolved-this-week: cerrado dentro de los últimos 7 días (ventana móvil).
export function deriveResolvedThisWeek(t, nowMs) {
  if (t.statusType !== 'Closed') return false;
  const closed = Date.parse(t.closedTime || '');
  if (!Number.isFinite(closed)) return false;
  return (nowMs - closed) <= 7 * 86_400_000;
}

// ===== Dev-lane: estado de un PR (determinístico, sobre el JSON de gh) =====
// CI: conclusión agregada del statusCheckRollup. review: reviewDecision de gh.
// ball ("de quién es la pelota"): CHANGES_REQUESTED o CI roja → tuya (hay que
// mover); APPROVED → Chris (a mergear); si no → esperando review de Chris.
export function derivePrStatus(pr) {
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  let ci = 'none';
  if (checks.length) {
    const concl = checks.map((c) => String(c.conclusion || c.state || '').toUpperCase());
    if (concl.some((c) => /FAIL|ERROR|CANCELL|TIMED_OUT/.test(c))) ci = 'failing';
    else if (concl.some((c) => /PENDING|IN_PROGRESS|QUEUED|EXPECTED|''/.test(c) || c === '')) ci = 'pending';
    else if (concl.every((c) => /SUCCESS|NEUTRAL|SKIPPED/.test(c))) ci = 'passing';
    else ci = 'mixed';
  }
  const review = pr.reviewDecision || 'PENDING'; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  let ball = 'chris';
  if (pr.isDraft) ball = 'yours';
  else if (review === 'CHANGES_REQUESTED' || ci === 'failing') ball = 'yours';
  else if (review === 'APPROVED') ball = 'chris'; // listo para merge (Chris mergea)
  return { ci, review, ball, isDraft: !!pr.isDraft };
}

// Enriquece un ticket normalizado con TODOS los campos derivados de una.
export function enrich(t, nowMs) {
  return {
    ...t,
    lane: deriveLane(t),
    priority_norm: derivePriority(t),
    waitingOn: deriveWaitingOn(t),
    lifecycle: deriveLifecycle(t),
    clock: deriveClock(t, nowMs),
    aging: deriveAging(t, nowMs),
    resolvedThisWeek: deriveResolvedThisWeek(t, nowMs),
  };
}
