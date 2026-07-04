// board/labels.js — fuente ÚNICA de etiquetas y estados derivados (R3/R4).
// Funciones PURAS: mapean datos → {dot, icon, label} / chips / celdas. El estado
// del motor (engineState/resolution) viaja en /tickets; acá solo se ETIQUETA
// (los fallbacks espejo se conservan para registros legacy sin derivación).
// Nada acá toca el DOM ni el store: todo recibe sus datos por parámetro.

// Ticket de un PR solo-GitHub: los branches del flujo son `bugfix/tkt-<N>-…` y
// los títulos `Fix/Update TKT #<N>: …`, así que el número sale del título o del
// branch sin backend nuevo. null si el PR no sigue la convención.
export function ticketOfPr(pr) {
  const t = String(pr.title || '').match(/TKT\s*#?\s*([\w.-]+)/i);
  if (t) return t[1];
  const b = String(pr.branch || '').match(/(?:tkt|ticket)-([\w.]+?)-[0-9a-f]{6,}$/i)
    || String(pr.branch || '').match(/(?:tkt|ticket)[-_]?#?([\w.]+)/i);
  return b ? b[1] : null;
}

// Timeline: history[] real, o sintetizado para registros anteriores al cambio.
export function timelineOf(b) {
  if (Array.isArray(b.history) && b.history.length) return b.history;
  const ev = [];
  if (b.createdAt) ev.push({ t: b.createdAt, type: 'creado' });
  if (b.sentAt) ev.push({ t: b.sentAt, type: 'pr_creado', pr: b.prNumber });
  if (b.mergedAt) ev.push({ t: b.mergedAt, type: 'pr_mergeado', by: b.mergedBy });
  return ev;
}

export const EV_LABEL = {
  creado: (e) => 'Fix registrado desde el chat',
  trabajo_nuevo: (e) => `Se reabrió el trabajo (chat nuevo)${e.pr ? ` sobre el PR #${e.pr}` : ''}`,
  pr_creado: (e) => `PR #${e.pr ?? '?'} creado${e.files ? ` · ${e.files} archivo/s` : ''}`,
  pr_actualizado: (e) => `PR #${e.pr ?? '?'} actualizado · commit ${e.commit || '?'}${e.commitN ? ` (${e.commitN}º del branch)` : ''}`,
  pr_mergeado: (e) => `PR #${e.pr ?? '?'} MERGEADO${e.by ? ` por ${e.by}` : ''}`,
  pr_cancelado: (e) => `PR #${e.pr ?? '?'} cancelado (fix vuelve a pendiente)`,
  ticket_actualizado: (e) => `Ticket ${e.ok ? 'actualizado en Desk' : 'NO se pudo actualizar'} (${e.mode === 'auto' ? 'automático' : 'por chat'})${e.detail ? ` — ${e.detail}` : ''}`,
  ticket_cerrado: (e) => `Ticket CERRADO/resuelto en Desk${e.status ? ` (${e.status})` : ''} — completo`,
  ticket_respondido: (e) => 'El cliente respondió el ticket — completo, se puede cerrar',
  archivado: () => 'Archivado',
  restaurado: () => 'Restaurado a la lista activa',
};

const EV_DOT = {
  creado: 'warn', trabajo_nuevo: 'warn', pr_creado: 'ok', pr_actualizado: 'ok',
  pr_mergeado: 'ok', pr_cancelado: 'fail', ticket_cerrado: 'ok', ticket_respondido: 'ok',
  archivado: 'warn', restaurado: 'warn',
};
// Color del punto de un evento (R4: ticket_actualizado ya no cae al fallback —
// depende de si la actualización de Desk salió bien o falló).
export function evDot(e) {
  if (e.type === 'ticket_actualizado') return e.ok !== false ? 'ok' : 'fail';
  return EV_DOT[e.type] || 'warn';
}

// Nivel de resolución (espeja resolutionOf del backend; el server ya manda
// b.resolution, esto es el fallback si faltara). merge ≠ resuelto.
export function resolutionOf(b) {
  if (b.resolution) return b.resolution;
  if (b.deskResolved === true) return 'complete';
  if (b.prState === 'merged') return 'partial';
  return 'active';
}
export const RES_CHIP = {
  partial: '<span class="bb-chip bb-chip--warn" title="Nuestro PR ya se mergeó, pero el ticket NO confirmó todavía: solución PARCIAL hasta que el cliente responda o se cierre">🟡 parcial · falta confirmar ticket</span>',
  complete: '<span class="bb-chip bb-chip--ok" title="El ticket se cerró o el cliente respondió: solución CONFIRMADA, se puede cerrar/archivar">🟢 completo · se puede cerrar</span>',
};

// Estado del fix. CLAVE: distingue "TU acción pendiente" (warn/amarillo:
// falta enviar o subir algo) de "esperando a alguien MÁS" (info/azul: el PR
// ya está y espera el merge de Chris — NO es error ni acción tuya). `icon` es
// el nombre del ícono (se renderiza en la celda); `label` queda como texto
// plano (lo reusa el prompt de "Trabajar en esto").
export function prEstado(b) {
  // Estados TERMINALES del PR (verdad de GitHub).
  if (b.prState === 'merged') return { dot: 'ok', icon: 'check', label: `mergeado por ${b.mergedBy || '?'}` };
  if (b.prState === 'closed') return { dot: 'fail', icon: 'close', label: 'cerrado sin merge' };
  // PR VIVO en GitHub (abierto): del lado tuyo NO falta enviar nada — falta
  // que Chris lo revise/mergee. Salvo que hayas reabierto y editado: ahí sí
  // tenés código local que todavía no empujaste al PR.
  if (b.prNumber) {
    const cambiosLocales = b.status !== 'subido' && (b.files?.length || 0) > 0;
    return cambiosLocales
      ? { dot: 'warn', icon: 'upload', label: `PR #${b.prNumber} · tenés cambios sin subir` }
      : { dot: 'info', icon: 'clock', label: `PR #${b.prNumber} en revisión · esperando a Chris` };
  }
  // Sin PR todavía.
  return b.files?.length
    ? { dot: 'warn', icon: 'upload', label: 'listo · falta enviar el PR' }
    : { dot: 'idle', icon: null, label: 'en plan (sin archivos)' };
}

// ¿El ticket ya tiene respuesta en Desk? Señales SIN tokens: deskStatus 'ok'
// (deskUpdateAuto publicó), deskReplied (el cliente respondió — vía
// desk-live), o un evento ticket_actualizado/ticket_respondido en el
// historial. deskResolved (cerrado/confirmado) implica respuesta.
export function deskAnswered(b) {
  if (b.deskStatus === 'ok' || b.deskReplied || b.deskResolved) return true;
  const h = Array.isArray(b.history) ? b.history : [];
  return h.some((e) => (e.type === 'ticket_actualizado' && e.ok !== false) || e.type === 'ticket_respondido');
}

// ===== Columnas "PR" y "Desk" (íconos compactos, datos ya presentes) =====
// ¿El ticket fue implementado en algún PR? Cruce por número de ticket sobre
// TODOS los registros + PRs solo-GitHub: si alguno con ese ticket está
// mergeado -> implementado; si hay uno abierto -> en curso.
export function prCellFor(b, entries, ghRows) {
  const tkt = b.ticketNumber ? String(b.ticketNumber) : null;
  let merged = b.prState === 'merged';
  let open = !merged && (b.prState === 'open' || (b.status !== 'subido' && b.prNumber));
  if (tkt) {
    for (const e of entries) { if (String(e.ticketNumber) === tkt) { if (e.prState === 'merged') merged = true; else if (e.prState === 'open' || e.prNumber) open = open || true; } }
    for (const p of ghRows) { if (ticketOfPr(p) === tkt) { if (p.state === 'merged') merged = true; else if (p.state === 'open') open = true; } }
  }
  if (merged) return '<span class="bb-icell bb-icell--ok" title="Implementado en un PR mergeado">✔</span>';
  if (open) return '<span class="bb-icell bb-icell--warn" title="En un PR abierto (sin mergear)">◐</span>';
  return '<span class="bb-icell bb-icell--none" title="Sin PR todavía">—</span>';
}

export function deskCellFor(b) {
  if (!b.ticketNumber) return '<span class="bb-icell bb-icell--none">—</span>';
  if (b.deskStatus === 'updating') return '<span class="bb-icell bb-icell--warn" title="Publicando la respuesta en Desk…">⏳</span>';
  if (b.deskResolved) return '<span class="bb-icell bb-icell--ok" title="Ticket resuelto/confirmado en Desk">🎫✅</span>';
  if (deskAnswered(b)) return '<span class="bb-icell bb-icell--ok" title="Respuesta publicada en el ticket de Desk">🎫✔</span>';
  if (b.deskStatus === 'error') return '<span class="bb-icell bb-icell--fail" title="El último intento de actualizar Desk falló">🎫✕</span>';
  if (b.deskCheckedAt) return '<span class="bb-icell bb-icell--none" title="Consultado en Desk: aún sin respuesta">🎫○</span>';
  return '<span class="bb-icell bb-icell--none" title="Desk sin consultar (usá 🎫 Desk)">—</span>';
}

// Etiquetas de outcome de un intento. R4: solo los que el motor EMITE de
// verdad (attemptOf: merged | pr-sent | coded | empty) — 'plan'/'abandoned'
// eran estados muertos y se eliminaron.
export const OUTCOME_LABEL = {
  empty: 'vacío (sin trabajo)', coded: 'con código',
  'pr-sent': 'PR enviado', merged: 'PR mergeado',
};

// ===== Claves de fila (estado de expansión FUERA del DOM, R1) =====
// Cada fila del tablero tiene una clave estable que sobrevive re-renders:
//   registro del motor → 'sid:<sessionId>' · triage-only → 'tkt:<n>' ·
//   PR solo-GitHub → 'pr:<n>'. Los prefijos evitan colisiones entre tipos.
export const rowKey = (b) => (b.sessionId ? `sid:${b.sessionId}` : (b.ticketNumber ? `tkt:${b.ticketNumber}` : `pr:${b.prNumber}`));
export const triageKey = (t) => `tkt:${t.ticketNumber}`;
export const ghKey = (pr) => `pr:${pr.number}`;

// ===== Cruces registro × triage (compartidos por chips y advertencias) =====
export const triageByNum = (triage) => new Map((triage.tickets || []).map((t) => [String(t.ticketNumber), t]));
export function entriesByTicket(entries) {
  const map = new Map();
  for (const b of entries) {
    if (!b.ticketNumber) continue;
    const k = String(b.ticketNumber);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

// Advertencias (texto plano) para la confirmación de envío de PRs.
export function warningsFor(b, { entries, triage }) {
  const w = [];
  const tk = b.ticketNumber ? triageByNum(triage).get(String(b.ticketNumber)) : null;
  if (b.ticketNumber && triage.updatedAt && !tk) w.push('no aparece en el último triage (¿ya resuelto/cerrado?)');
  if (timelineOf(b).some((e) => e.type === 'trabajo_nuevo')) w.push('fix retrabajado (actualiza un PR existente)');
  if (b.ticketNumber && (entriesByTicket(entries).get(String(b.ticketNumber)) || 0) > 1) w.push('DOBLE registro local para este ticket');
  if (tk?.duplicate) w.push(`posible duplicado de ${tk.duplicate}`);
  return w;
}
