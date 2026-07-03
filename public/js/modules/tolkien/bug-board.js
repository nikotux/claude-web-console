// modules/tolkien/bug-board.js — tablero unificado "Bugs & PRs" (admin).
//
// UNA vista para toda la línea de trabajo del bug: triage de Desk → chat de
// trabajo → fix registrado → PR → feedback/iteraciones → merge → ticket.
// Fuentes por fila (correlación por número de ticket):
//   - registro de bugfixes (~/.cwc-data/bugfixes.json, con history[])
//   - triage de Desk (caché /api/bugs: severidad, duplicado, frescura)
//   - PRs propios SOLO en GitHub (refresh-prs)
// DATOS EN VIVO (no persistidos): al expandir una fila con PR se consulta
// /api/bugfixes/pr-live/:n (gh, caché 60 s) — reviews, comentarios de Chris,
// checks y commits. Si GitHub no responde, la fila degrada a datos locales.
// Lo abren el botón "Bugs & PRs" de Tolkien y el de la sección Bugs.
import { pacman } from '../../ui/pacman.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Ticket de un PR solo-GitHub: los branches del flujo son `bugfix/tkt-<N>-…` y
// los títulos `Fix/Update TKT #<N>: …`, así que el número sale del título o del
// branch sin backend nuevo. null si el PR no sigue la convención.
function ticketOfPr(pr) {
  const t = String(pr.title || '').match(/TKT\s*#?\s*([\w.-]+)/i);
  if (t) return t[1];
  const b = String(pr.branch || '').match(/(?:tkt|ticket)-([\w.]+?)-[0-9a-f]{6,}$/i)
    || String(pr.branch || '').match(/(?:tkt|ticket)[-_]?#?([\w.]+)/i);
  return b ? b[1] : null;
}

const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};
function fmtAgo(ms) {
  if (!ms) return 'sin datos';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

// Timeline: history[] real, o sintetizado para registros anteriores al cambio.
function timelineOf(b) {
  if (Array.isArray(b.history) && b.history.length) return b.history;
  const ev = [];
  if (b.createdAt) ev.push({ t: b.createdAt, type: 'creado' });
  if (b.sentAt) ev.push({ t: b.sentAt, type: 'pr_creado', pr: b.prNumber });
  if (b.mergedAt) ev.push({ t: b.mergedAt, type: 'pr_mergeado', by: b.mergedBy });
  return ev;
}
const EV_LABEL = {
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

// Nivel de resolución (espeja resolutionOf del backend; el server ya manda
// b.resolution, esto es el fallback si faltara). merge ≠ resuelto.
function resolutionOf(b) {
  if (b.resolution) return b.resolution;
  if (b.deskResolved === true) return 'complete';
  if (b.prState === 'merged') return 'partial';
  return 'active';
}
const RES_CHIP = {
  partial: '<span class="bb-chip bb-chip--warn" title="Nuestro PR ya se mergeó, pero el ticket NO confirmó todavía: solución PARCIAL hasta que el cliente responda o se cierre">🟡 parcial · falta confirmar ticket</span>',
  complete: '<span class="bb-chip bb-chip--ok" title="El ticket se cerró o el cliente respondió: solución CONFIRMADA, se puede cerrar/archivar">🟢 completo · se puede cerrar</span>',
};

export function openBugBoard({ dialog, icon, openChat, projectRel, updateRepo, onClose }) {
  const m = dialog.openModal({ title: 'Bugs & PRs — Tolkien', width: '90vw', onClose });
  m.card.classList.add('dlg-card--tickets');
  // El maxWidth INLINE de openModal le ganaría al media query fullscreen de
  // .dlg-card--tickets en móvil: se limpia para que mande el CSS.
  m.card.style.maxWidth = '';
  const wrap = document.createElement('div');
  wrap.className = 'bb';
  wrap.innerHTML = `
    <div class="bb-actions">
      <button class="btn btn--sm" data-ref="send" disabled>${icon('gitBranch', { size: 13 })}<span>Enviar pendientes</span></button>
      <button class="btn-ghost btn--sm" data-ref="scan" title="Re-busca en los chats de tickets cambios sin registrar">${icon('sparkle', { size: 13 })}<span>Buscar bugfixes</span></button>
      <button class="btn-ghost btn--sm" data-ref="ghsync" title="Refresca desde GitHub el estado de los PRs (automático mientras el tablero está abierto)">${icon('refresh', { size: 13 })}<span>GitHub</span></button>
      <button class="btn-ghost btn--sm" data-ref="desksync" title="Consulta Zoho Desk el estado REAL de los tickets activos (respuesta publicada, resuelto). CONSUME TOKENS — con confirmación">${icon('download', { size: 13 })}<span>🎫 Desk</span></button>
      <button class="btn-ghost btn--sm btn--icon" data-ref="help" title="¿Cómo leer este tablero? (pipeline, chips, estados)">${icon('help', { size: 15 })}</button>
      <span class="bb-state" data-ref="ghstate"></span>
      <span class="bb-triage" data-ref="triage"></span>
    </div>
    <div class="bb-box">
      <table class="bfm-table bb-table">
        <thead><tr><th></th><th>TKT</th><th>Título</th><th>Pipeline</th><th>Cambios</th><th title="¿Implementado en un PR?">PR</th><th title="¿Respondido en Zoho Desk?">Desk</th><th>Estado</th></tr></thead>
        <tbody data-ref="tbody"><tr><td colspan="8"><span class="cwc-spinner"></span></td></tr></tbody>
      </table>
    </div>`;
  m.body.appendChild(wrap);
  const mr = {};
  for (const r of wrap.querySelectorAll('[data-ref]')) mr[r.dataset.ref] = r;

  let entries = [];   // registro de bugfixes
  let lastGhAt = null;    // última sync de GitHub (auto, barato)
  let lastDeskAt = null;  // última sync de Desk (bajo botón, tokens)
  function updateFreshness() {
    const gh = lastGhAt ? `GitHub: ${fmtAgo(lastGhAt)}` : 'GitHub: —';
    const dk = lastDeskAt ? `Desk: ${fmtAgo(lastDeskAt)}` : 'Desk: sin consultar';
    if (mr.ghstate) mr.ghstate.innerHTML = `<span class="bb-fresh">${gh} · ${dk}</span>`;
  }
  let ghRows = [];    // PRs solo-GitHub
  let triage = { updatedAt: null, tickets: [], running: false };

  const triageByNum = () => new Map((triage.tickets || []).map((t) => [String(t.ticketNumber), t]));
  const entriesByTicket = () => {
    const map = new Map();
    for (const b of entries) {
      if (!b.ticketNumber) continue;
      const k = String(b.ticketNumber);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  };

  // ===== Chips de verificación (cruce registro × triage × historial) =====
  function chipsFor(b) {
    const chips = [];
    const tk = b.ticketNumber ? triageByNum().get(String(b.ticketNumber)) : null;
    if (tk) {
      chips.push(`<span class="tk-sev tk-sev-${esc(tk.severity)}">${esc(tk.severity)}</span>`);
      chips.push('<span class="bb-chip bb-chip--ok" title="El ticket aparece en el último triage de Desk (sigue abierto)">🎫 abierto en Desk</span>');
      if (tk.duplicate) chips.push(`<span class="bb-chip bb-chip--warn" title="El triage lo marcó como posible duplicado">👥 dup: ${esc(tk.duplicate)}</span>`);
    } else if (b.ticketNumber && triage.updatedAt) {
      chips.push('<span class="bb-chip bb-chip--warn" title="No aparece en el último triage: puede estar resuelto/cerrado — verificá antes de enviar">🎫 no está en el triage</span>');
    }
    const tl = timelineOf(b);
    const reaperturas = tl.filter((e) => e.type === 'trabajo_nuevo').length;
    if (reaperturas) chips.push(`<span class="bb-chip bb-chip--info" title="El fix se retrabajó tras enviar el PR">🔁 reabierto ×${reaperturas}</span>`);
    if (b.ticketNumber && (entriesByTicket().get(String(b.ticketNumber)) || 0) > 1) {
      chips.push('<span class="bb-chip bb-chip--danger" title="Hay MÁS de un registro local para este ticket: riesgo de PRs duplicados">⚠ doble registro</span>');
    }
    // Ticket en Desk (auto tras el 1er PR / por chat en iteraciones).
    const desk = [...tl].reverse().find((e) => e.type === 'ticket_actualizado');
    if (b.deskStatus === 'updating') chips.push('<span class="bb-chip bb-chip--info">🎫 actualizando…</span>');
    else if (desk) {
      chips.push(desk.ok
        ? '<span class="bb-chip bb-chip--ok" title="Última actualización del ticket en Desk: OK">🎫 ticket ✓</span>'
        : '<span class="bb-chip bb-chip--danger" title="La última actualización del ticket FALLÓ — hacela por chat o a mano">🎫 ticket ✗</span>');
    } else if (b.status === 'subido' && b.ticketNumber) {
      chips.push('<span class="bb-chip bb-chip--warn" title="El PR se envió pero el ticket no registra actualización en Desk">🎫 sin actualizar</span>');
    }
    return chips.join(' ');
  }

  // Advertencias (texto) para la confirmación de envío.
  function warningsFor(b) {
    const w = [];
    const tk = b.ticketNumber ? triageByNum().get(String(b.ticketNumber)) : null;
    if (b.ticketNumber && triage.updatedAt && !tk) w.push('no aparece en el último triage (¿ya resuelto/cerrado?)');
    if (timelineOf(b).some((e) => e.type === 'trabajo_nuevo')) w.push('fix retrabajado (actualiza un PR existente)');
    if (b.ticketNumber && (entriesByTicket().get(String(b.ticketNumber)) || 0) > 1) w.push('DOBLE registro local para este ticket');
    if (tk?.duplicate) w.push(`posible duplicado de ${tk.duplicate}`);
    return w;
  }

  // Pipeline visual: 5 etapas del ciclo. La ÚLTIMA es "ticket confirmado"
  // (cerrado o cliente respondió) — verde SOLO cuando está completo de verdad:
  // un PR mergeado (barra 4) es solución parcial hasta que el ticket confirma.
  function pipelineHtml(b) {
    const tk = b.ticketNumber ? triageByNum().get(String(b.ticketNumber)) : null;
    const seg = (on, cls, label) => `<span class="bb-seg ${on ? `bb-seg--${cls}` : ''}" title="${esc(label)}"></span>`;
    const confirmLabel = b.deskResolved
      ? (b.deskClosed ? 'Ticket cerrado/resuelto en Desk — completo' : 'El cliente respondió — completo')
      : (b.prState === 'merged' ? 'PR mergeado pero ticket SIN confirmar (parcial): revisá el estado de Desk' : 'Ticket sin confirmar');
    return `<span class="bb-pipe">${[
      seg(!!(tk || b.ticketNumber), 'ok', tk ? 'Triage: ticket abierto en Desk' : 'Ticket referenciado (no está en el triage actual)'),
      seg(!!(b.files?.length), 'ok', b.files?.length ? `Trabajo: ${b.files.length} archivo/s editados` : 'Sin trabajo aún'),
      seg(!!b.prNumber, b.prState === 'closed' ? 'fail' : 'ok', b.prNumber ? `PR #${b.prNumber} (${b.prState || '?'})` : 'Sin PR'),
      seg(b.prState === 'merged', 'ok', b.prState === 'merged' ? `Mergeado por ${b.mergedBy || '?'}` : 'Sin merge'),
      seg(b.deskResolved === true, 'ok', confirmLabel),
    ].join('')}</span>`;
  }

  function prEstado(b) {
    if (b.status !== 'subido') {
      return b.prNumber
        ? { dot: 'warn', label: `PR #${b.prNumber} abierto · cambios sin subir` }
        : { dot: 'warn', label: b.files?.length ? 'pendiente' : 'en plan (sin archivos)' };
    }
    if (b.prState === 'merged') return { dot: 'ok', label: `mergeado por ${b.mergedBy || '?'}` };
    if (b.prState === 'closed') return { dot: 'fail', label: 'cerrado sin merge' };
    return { dot: 'warn', label: 'PR abierto (sin mergear)' };
  }

  // ===== Columnas "PR" y "Desk" (íconos compactos, datos ya presentes) =====
  // ¿El ticket fue implementado en algún PR? Cruce por número de ticket sobre
  // TODOS los registros + PRs solo-GitHub: si alguno con ese ticket está
  // mergeado -> implementado; si hay uno abierto -> en curso.
  function prCellFor(b) {
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

  // ¿El ticket ya tiene respuesta en Desk? Señales SIN tokens: deskStatus 'ok'
  // (deskUpdateAuto publicó), deskReplied (el cliente respondió — vía
  // desk-live), o un evento ticket_actualizado/ticket_respondido en el
  // historial. deskResolved (cerrado/confirmado) implica respuesta.
  function deskAnswered(b) {
    if (b.deskStatus === 'ok' || b.deskReplied || b.deskResolved) return true;
    const h = Array.isArray(b.history) ? b.history : [];
    return h.some((e) => (e.type === 'ticket_actualizado' && e.ok !== false) || e.type === 'ticket_respondido');
  }
  function deskCellFor(b) {
    if (!b.ticketNumber) return '<span class="bb-icell bb-icell--none">—</span>';
    if (b.deskStatus === 'updating') return '<span class="bb-icell bb-icell--warn" title="Publicando la respuesta en Desk…">⏳</span>';
    if (b.deskResolved) return '<span class="bb-icell bb-icell--ok" title="Ticket resuelto/confirmado en Desk">🎫✅</span>';
    if (deskAnswered(b)) return '<span class="bb-icell bb-icell--ok" title="Respuesta publicada en el ticket de Desk">🎫✔</span>';
    if (b.deskStatus === 'error') return '<span class="bb-icell bb-icell--fail" title="El último intento de actualizar Desk falló">🎫✕</span>';
    if (b.deskCheckedAt) return '<span class="bb-icell bb-icell--none" title="Consultado en Desk: aún sin respuesta">🎫○</span>';
    return '<span class="bb-icell bb-icell--none" title="Desk sin consultar (usá 🎫 Desk)">—</span>';
  }

  function statsHtml(s) {
    if (!s) return '<span class="bfm-nostats">—</span>';
    return `<span class="bfm-add">+${s.add}</span> <span class="bfm-del">−${s.del}</span>` +
      `<span class="bfm-nfiles"> · ${s.files}a</span>`;
  }

  // ===== Detalle expandible =====
  // Los INTENTOS del ticket (cada chat que lo trabajó): el motor consolidó
  // el ticket, acá se despliega su historia de resoluciones. Un ✓ = tiene
  // código/PR; ○ = vacío (dedo resbalado / quedó en plan).
  const OUTCOME_LABEL = {
    empty: 'vacío (sin trabajo)', plan: 'quedó en plan', coded: 'con código',
    'pr-sent': 'PR enviado', merged: 'PR mergeado', abandoned: 'abandonado',
  };
  function attemptsHtml(b) {
    const at = b.attempts || [];
    if (at.length <= 1) return ''; // un solo intento: no vale la pena la sección
    return `<div class="bb-attempts"><div class="bb-attempts-h">${at.length} intentos de resolución</div>${at.map((a) => `
      <div class="bb-attempt bb-attempt--${a.outcome === 'empty' ? 'empty' : 'real'}">
        <span class="hp-dot hp-dot--${a.outcome === 'merged' ? 'ok' : a.outcome === 'empty' ? 'fail' : 'warn'}"></span>
        <span class="bb-attempt-txt">${esc(OUTCOME_LABEL[a.outcome] || a.outcome)}${a.files?.length ? ` · ${a.files.length} archivo(s)` : ''}${a.pr ? ` · PR #${a.pr.number}` : ''}</span>
        <span class="bb-attempt-at">${fmtDate(a.at)}</span>
      </div>`).join('')}</div>`;
  }

  // Soluciones pasadas parecidas (biblioteca del motor). Gancho: hoy vacío,
  // se llena cuando se destilen soluciones de tickets resueltos.
  function similarHtml(b) {
    const sim = b.similar || [];
    if (!sim.length) return '';
    return `<div class="bb-similar"><div class="bb-similar-h">💡 Soluciones parecidas de tickets pasados</div>${sim.map((s) => `
      <div class="bb-similar-item">TKT #${esc(s.ticketNumber)}: ${esc(s.fix || s.rootCause || '')}${s.files?.length ? ` <code>${esc(s.files[0])}</code>` : ''}</div>`).join('')}</div>`;
  }

  function detailHtml(b) {
    const tl = timelineOf(b);
    const timeline = tl.length
      ? `<div class="bb-tl">${tl.map((e) => `
          <div class="bb-tl-ev">
            <span class="hp-dot hp-dot--${EV_DOT[e.type] || 'warn'}"></span>
            <span class="bb-tl-date">${fmtDate(e.t)}</span>
            <span class="bb-tl-txt">${esc((EV_LABEL[e.type] || (() => e.type))(e))}</span>
          </div>`).join('')}</div>`
      : '';
    return `
      <div class="bb-chips">${chipsFor(b)}</div>
      <p class="hp-bf-summary">${esc(b.summary || '(sin resumen)')}</p>
      ${b.files?.length ? `<p class="hp-bf-files">${b.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
      : '<p class="hp-bf-files hp-bf-files--none">Sin archivos editados (quedó en plan).</p>'}
      ${attemptsHtml(b)}
      ${similarHtml(b)}
      ${timeline}
      ${b.prNumber ? `<div class="bb-live" data-live="${b.prNumber}"><div class="cwc-loading">${pacman()}consultando GitHub en vivo…</div></div>` : ''}
      ${b.ticketNumber ? deskSectionHtml(b.ticketNumber) : ''}
      <p class="bfm-links">
        ${b.ticketUrl ? `<a href="${esc(b.ticketUrl)}" target="_blank" rel="noopener">Ticket #${esc(b.ticketNumber)} ↗</a>` : ''}
        ${b.prUrl ? `<a href="${esc(b.prUrl)}" target="_blank" rel="noopener">PR ${b.prNumber ? `#${esc(b.prNumber)}` : ''} ↗</a>` : ''}
        ${b.branch ? `<code>${esc(b.branch)}</code>` : ''}
        <button class="btn btn--sm" data-act="work">${icon('sparkle', { size: 13 })}<span>Trabajar en esto</span></button>
        ${b.ticketNumber
      ? `<button class="btn-ghost btn--sm" data-act="deskchat" title="Abre un chat con TODO el contexto para redactar (en inglés) y publicar una respuesta en el ticket de Zoho Desk — vos aprobás la escritura">${icon('edit', { size: 13 })}<span>Responder ticket (chat)</span></button>` : ''}
        ${b.status === 'subido' && b.prState !== 'merged'
      ? `<button class="btn-ghost btn--sm btn--danger" data-act="cancelpr">${icon('trash', { size: 13 })}<span>Cancelar PR</span></button>` : ''}
        ${b.archived
      ? `<button class="btn-ghost btn--sm" data-act="unarchive" title="Devolver a la lista activa">${icon('refresh', { size: 13 })}<span>Restaurar</span></button>`
      : `<button class="${resolutionOf(b) === 'complete' ? 'btn' : 'btn-ghost'} btn--sm" data-act="archive" title="Mover al Archivo (no toca código ni PRs). Sugerido cuando el ticket ya está confirmado">${icon('check', { size: 13 })}<span>Archivar</span></button>`}
        <button class="btn-ghost btn--sm" data-act="del" title="Borra SOLO el registro local (no toca código ni PRs)">${icon('close', { size: 13 })}<span>Descartar registro</span></button>
      </p>`;
  }

  // Sección "Estado de Desk": bajo botón (consume tokens), no auto al expandir.
  function deskSectionHtml(ticket) {
    return `<div class="bb-desk" data-desktkt="${esc(ticket)}">
      <button class="btn-ghost btn--sm bb-desk-btn" data-deskload="${esc(ticket)}" title="Trae el estado ACTUAL del ticket desde Zoho Desk (consume tokens) — para ver si tu comentario ya quedó publicado">${icon('download', { size: 13 })}<span>🎫 Traer estado de Desk</span></button>
    </div>`;
  }

  // Detalle de un PR solo-GitHub (sin registro local): ticket detectado +
  // panel de commits/reviews en vivo + estado de Desk + acción de actualizar.
  function ghDetailHtml(pr) {
    const ticket = ticketOfPr(pr);
    return `
      <div class="bb-chips">${ticket
    ? `<span class="bb-chip bb-chip--info" title="Ticket detectado del título/branch del PR">🎫 pertenece a TKT #${esc(ticket)}</span>`
    : '<span class="bb-chip bb-chip--warn" title="El título/branch no sigue la convención bugfix/tkt-N">sin ticket detectable</span>'}</div>
      ${pr.branch ? `<p class="hp-bf-files"><code>${esc(pr.branch)}</code></p>` : ''}
      <div class="bb-live" data-live="${pr.number}"><div class="cwc-loading">${pacman()}consultando GitHub en vivo…</div></div>
      ${ticket ? deskSectionHtml(ticket) : ''}
      <p class="bfm-links">
        <a href="${esc(pr.url)}" target="_blank" rel="noopener">Ver PR #${esc(pr.number)} en GitHub ↗</a>
        ${ticket ? `<button class="btn-ghost btn--sm" data-act="ghdeskchat" data-prnum="${pr.number}" title="Abre un chat para redactar y publicar la actualización del ticket en Desk (vos aprobás la escritura)">${icon('edit', { size: 13 })}<span>Actualizar ticket (chat)</span></button>` : ''}
      </p>`;
  }

  // Panel EN VIVO de Desk: se llena al tocar el botón (y con ↻ fuerza fresh).
  async function fillDesk(box, ticket, fresh) {
    box.innerHTML = `<div class="cwc-loading">${pacman()}consultando Zoho Desk…</div>`;
    try {
      const res = await fetch(`/api/bugfixes/desk-live/${encodeURIComponent(ticket)}${fresh ? '?fresh=1' : ''}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Desk no disponible.');
      const d = data.desk || {};
      const head = (extra) => `
        <div class="bb-desk-head">
          <b>Zoho Desk · #${esc(ticket)}</b>
          ${extra}
          <button class="btn-ghost btn--sm btn--icon" data-deskfresh="${esc(ticket)}" title="Consultar de nuevo (saltea la caché de 60 s)">${icon('refresh', { size: 12 })}</button>
          <span class="bb-live-at">${fmtAgo(d.fetchedAt)}</span>
        </div>`;
      if (!d.found) {
        box.innerHTML = head(`<span class="bb-chip bb-chip--warn">${esc(d.error || 'ticket no encontrado')}</span>`);
        return;
      }
      // El backend ya persistió deskResolved en los registros del ticket;
      // reflejamos EN MEMORIA para que la próxima render del tablero lo muestre
      // sin re-consultar (no re-renderizamos ahora: no perder este panel).
      for (const en of entries) {
        if (String(en.ticketNumber) === String(ticket)) {
          en.deskResolved = d.resolved; en.deskClosed = d.closed;
          en.deskReplied = d.replied; en.deskStatusText = d.status; en.deskCheckedAt = d.fetchedAt;
          en.resolution = d.resolved ? 'complete' : (en.prState === 'merged' ? 'partial' : 'active');
          // Y reflejar IN-PLACE en la fila visible (pipeline, celda Desk y
          // chip de resolución) sin re-render: un re-render destruiría este
          // panel abierto. Solo se tocan celdas de la fila resumen, nunca la
          // fila de detalle donde vive el panel.
          const row = mr.tbody.querySelector(`.bfm-row[data-sid="${en.sessionId}"]`);
          if (row && row.children.length >= 8) {
            const arch = row.classList.contains('bb-arch-row');
            const est = prEstado(en);
            const resChip = !arch && RES_CHIP[resolutionOf(en)] ? ` ${RES_CHIP[resolutionOf(en)]}` : '';
            row.children[3].innerHTML = pipelineHtml(en);
            row.children[6].innerHTML = deskCellFor(en);
            row.children[7].innerHTML = `${esc(est.label)}${resChip}`;
          }
        }
      }
      const verdict = d.resolved
        ? `<div class="bb-desk-verdict bb-desk-verdict--ok">🟢 Ticket confirmado (${d.closed ? 'cerrado/resuelto' : 'el cliente respondió'}) — este fix está <b>completo</b>. Podés archivarlo.</div>`
        : `<div class="bb-desk-verdict bb-desk-verdict--wait">🟡 Ticket sin confirmar todavía${d.status ? ` (${esc(d.status)})` : ''} — solución parcial hasta que el cliente responda o se cierre.</div>`;
      box.innerHTML = `
        ${head(d.status ? `<span class="bb-chip bb-chip--${d.resolved ? 'ok' : 'info'}" title="Estado actual del ticket en Desk">${esc(d.status)}</span>` : '')}
        ${verdict}
        ${d.subject ? `<div class="bb-desk-subj">${esc(d.subject)}</div>` : ''}
        ${d.comments.length ? `<div class="bb-live-fb">${d.comments.map((c) => `
          <div class="bb-fb">
            <span class="bb-fb-head"><b>${esc(c.author)}</b> · <span class="bb-vis bb-vis--${c.visibility}">${c.visibility === 'private' ? 'interno' : 'público'}</span>${c.at ? ` · ${esc(c.at)}` : ''}</span>
            ${c.excerpt ? `<span class="bb-fb-body">${esc(c.excerpt)}</span>` : ''}
          </div>`).join('')}</div>`
    : '<div class="bb-live-fb bb-live-empty">El ticket no tiene comentarios visibles.</div>'}`;
    } catch (err) {
      box.innerHTML = `<div class="bb-live-err">⚠ ${esc(err.message)} — reintentá con ↻.</div>
        <div class="bb-desk-head"><button class="btn-ghost btn--sm btn--icon" data-deskfresh="${esc(ticket)}" title="Reintentar">${icon('refresh', { size: 12 })}</button></div>`;
    }
  }

  // Panel EN VIVO del PR: se llena al expandir (y con ↻ fuerza fresh).
  async function fillLive(box, prNumber, fresh) {
    box.innerHTML = `<div class="cwc-loading">${pacman()}consultando GitHub en vivo…</div>`;
    try {
      const res = await fetch(`/api/bugfixes/pr-live/${prNumber}${fresh ? '?fresh=1' : ''}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'GitHub no disponible.');
      const L = data.live;
      const dec = L.reviewDecision === 'APPROVED' ? ['ok', 'review: aprobado ✓']
        : L.reviewDecision === 'CHANGES_REQUESTED' ? ['danger', 'review: CAMBIOS PEDIDOS']
        : L.reviewDecision === 'REVIEW_REQUIRED' ? ['warn', 'review: pendiente'] : null;
      const checksOk = L.checks.filter((c) => ['success', 'neutral', 'skipped'].includes(c.status)).length;
      const checksBad = L.checks.filter((c) => ['failure', 'error', 'timed_out', 'cancelled'].includes(c.status)).length;
      box.innerHTML = `
        <div class="bb-live-head">
          <b>GitHub en vivo</b>
          <span class="bb-chip bb-chip--${L.state === 'merged' ? 'ok' : L.state === 'closed' ? 'danger' : 'info'}">${esc(L.state)}</span>
          ${dec ? `<span class="bb-chip bb-chip--${dec[0]}">${esc(dec[1])}</span>` : ''}
          ${L.mergeable === 'CONFLICTING' ? '<span class="bb-chip bb-chip--danger">⚠ conflictos con main</span>' : ''}
          ${L.checks.length ? `<span class="bb-chip bb-chip--${checksBad ? 'danger' : 'ok'}">checks ${checksOk}/${L.checks.length}${checksBad ? ` · ${checksBad} ✗` : ''}</span>` : ''}
          <button class="btn-ghost btn--sm btn--icon" data-livefresh="${prNumber}" title="Consultar de nuevo (saltea la caché de 60 s)">${icon('refresh', { size: 12 })}</button>
          <span class="bb-live-at">${fmtAgo(L.fetchedAt)}</span>
        </div>
        ${L.commits.length ? `<div class="bb-live-commits">${L.commits.map((c) => `<div class="bb-commit"><code>${esc(c.sha)}</code> ${esc(c.msg)} <span class="bb-tl-date">${fmtDate(c.at)}</span></div>`).join('')}</div>` : ''}
        ${L.feedback.length ? `<div class="bb-live-fb">${L.feedback.map((f) => `
          <div class="bb-fb">
            <span class="bb-fb-head"><b>${esc(f.author)}</b> · ${esc(f.kind)} · ${fmtDate(f.at)}</span>
            ${f.body ? `<span class="bb-fb-body">${esc(f.body)}</span>` : ''}
          </div>`).join('')}</div>`
      : '<div class="bb-live-fb bb-live-empty">Sin comentarios ni reviews todavía.</div>'}`;
    } catch (err) {
      box.innerHTML = `<div class="bb-live-err">⚠ ${esc(err.message)} — datos locales abajo.</div>`;
    }
  }

  // ===== Puente motor→helpers: un Ticket consolidado se aplana a la forma
  // que esperan los helpers existentes (prEstado, pipelineHtml, prCellFor,
  // deskCellFor, detailHtml). 1 fila = 1 TICKET (sus chats van en attempts).
  function ticketToRow(t) {
    const gh = t.external?.github || [];
    // "mejor" PR: mergeado > abierto > cerrado (el que define el estado).
    const best = gh.find((p) => p.state === 'merged') || gh.find((p) => p.state === 'open') || gh[0] || null;
    const desk = t.external?.desk || {};
    const mainAttempt = t.attempts.find((a) => a.pr) || t.attempts.find((a) => a.files?.length) || t.attempts[t.attempts.length - 1] || {};
    const allFiles = [...new Set(t.attempts.flatMap((a) => a.files || []))];
    const deskStatus = desk.answered ? 'ok' : desk.updating ? 'updating' : desk.error ? 'error' : null;
    const status = best ? (best.state === 'merged' ? 'subido' : 'pendiente') : (allFiles.length ? 'pendiente' : 'pendiente');
    return {
      // identidad + acción (las acciones operan sobre el attempt principal)
      sessionId: mainAttempt.sessionId || null,
      ticketNumber: t.number, ticketUrl: t.url, title: t.title,
      summary: mainAttempt.summary || (t.attempts.find((a) => a.summary)?.summary) || '',
      files: allFiles, stats: best ? mainAttempt.stats : mainAttempt.stats,
      branch: mainAttempt.branch || null,
      // PR consolidado (el "mejor")
      prNumber: best?.number || null, prUrl: best?.url || null, prState: best?.state || null,
      mergedBy: best?.mergedBy || null, mergedAt: best?.mergedAt || null,
      // Desk consolidado
      deskStatus, deskReplied: desk.replied || null, deskResolved: desk.resolved || null,
      deskClosed: desk.closed || null, deskStatusText: desk.statusText || null, deskCheckedAt: desk.checkedAt || null,
      // estado del motor (derivado) + historial unificado + attempts para el detalle
      status, resolution: t.resolution, engineState: t.state,
      history: t.history || [], attempts: t.attempts || [], archived: t.archived,
      allSessionIds: t.attempts.map((a) => a.sessionId).filter(Boolean),
      similar: t.similar || [],
    };
  }

  // ===== Render de la tabla =====
  function renderTable() {
    const pendientes = entries.filter((b) => b.status === 'pendiente' && b.files?.length);
    mr.send.disabled = !pendientes.length;
    mr.send.querySelector('span').textContent = pendientes.length ? `Enviar pendientes (${pendientes.length})` : 'Enviar pendientes';
    mr.triage.innerHTML = triage.updatedAt
      ? `triage: ${fmtAgo(triage.updatedAt)}${Date.now() - triage.updatedAt > 86400000 ? ' <span class="bb-chip bb-chip--warn">viejo</span>' : ''}`
      : 'triage: sin datos';

    const cubiertos = new Set(entries.map((b) => String(b.ticketNumber)).filter(Boolean));
    const soloTriage = (triage.tickets || []).filter((t) => !cubiertos.has(String(t.ticketNumber)));

    if (!entries.length && !ghRows.length && !soloTriage.length) {
      mr.tbody.innerHTML = '<tr><td colspan="8" class="hp-empty">Sin bugs en triage, fixes registrados ni PRs en GitHub.</td></tr>';
      return;
    }
    // Una fila de registro (activa o archivada). El chip de resolución
    // (parcial/completo) va en la celda de estado.
    const rowFor = (b, arch) => {
      const est = prEstado(b);
      const res = resolutionOf(b);
      const resChip = !arch && RES_CHIP[res] ? ` ${RES_CHIP[res]}` : '';
      return `
        <tr class="bfm-row${arch ? ' bb-arch-row' : ''}" data-sid="${esc(b.sessionId)}"${arch ? ' hidden' : ''}>
          <td><span class="hp-dot hp-dot--${est.dot}"></span></td>
          <td class="bfm-tkt">${b.ticketNumber ? `#${esc(b.ticketNumber)}` : '—'}</td>
          <td class="bfm-title">${esc(b.title)}</td>
          <td>${pipelineHtml(b)}</td>
          <td class="bfm-stats">${statsHtml(b.stats)}</td>
          <td class="bb-col-pr">${prCellFor(b)}</td>
          <td class="bb-col-desk">${deskCellFor(b)}</td>
          <td class="bfm-state">${esc(est.label)}${resChip}</td>
        </tr>
        <tr class="bfm-detail${arch ? ' bb-arch-row' : ''}" hidden><td colspan="8">${detailHtml(b)}</td></tr>`;
    };

    const activos = entries.filter((b) => !b.archived);
    const archivados = entries.filter((b) => b.archived);
    // Orden activo: primero lo accionable (pendiente con archivos), completos al
    // fondo (ya resueltos, listos para archivar).
    const rank = (b) => (resolutionOf(b) === 'complete' ? 3
      : b.status === 'pendiente' ? (b.files?.length ? 0 : 1) : 2);
    const orden = [...activos].sort((a, b) => rank(a) - rank(b)
      || (b.sentAt || b.updatedAt || 0) - (a.sentAt || a.updatedAt || 0));
    const rows = [];
    for (const b of orden) rows.push(rowFor(b, false));
    // Tickets del triage SIN trabajo todavía: parte de la misma línea de trabajo.
    for (const t of soloTriage) {
      rows.push(`
        <tr class="bfm-row bb-row--triage" data-tkt="${esc(t.ticketNumber)}">
          <td><span class="hp-dot hp-dot--warn"></span></td>
          <td class="bfm-tkt">#${esc(t.ticketNumber)}</td>
          <td class="bfm-title">${esc(t.whatBroke)}</td>
          <td>${`<span class="bb-pipe"><span class="bb-seg bb-seg--ok" title="En triage"></span><span class="bb-seg"></span><span class="bb-seg"></span><span class="bb-seg"></span><span class="bb-seg"></span></span>`}</td>
          <td class="bfm-stats"><span class="tk-sev tk-sev-${esc(t.severity)}">${esc(t.severity)}</span></td>
          <td class="bb-col-pr"><span class="bb-icell bb-icell--none" title="Sin PR todavía">—</span></td>
          <td class="bb-col-desk"><span class="bb-icell bb-icell--none" title="Ticket sin responder en Desk">—</span></td>
          <td class="bfm-state">sin trabajo aún</td>
        </tr>
        <tr class="bfm-detail" hidden><td colspan="8">
          <p class="hp-bf-summary">${esc(t.whatBroke)}${t.route ? ` · <code>${esc(t.route)}</code>` : ''}${t.reporter ? ` · reportó ${esc(t.reporter)}` : ''}</p>
          ${t.duplicate ? `<p class="bb-chips"><span class="bb-chip bb-chip--warn">👥 dup: ${esc(t.duplicate)}</span></p>` : ''}
          ${t.context ? `<p class="hp-bf-summary">${esc(t.context)}</p>` : ''}
          <p class="bfm-links">
            ${t.webUrl ? `<a href="${esc(t.webUrl)}" target="_blank" rel="noopener">Ticket #${esc(t.ticketNumber)} ↗</a>` : ''}
            <button class="btn btn--sm" data-act="triagework" data-tkt="${esc(t.ticketNumber)}">${icon('sparkle', { size: 13 })}<span>Trabajar en Chat (plan)</span></button>
          </p>
        </td></tr>`);
    }
    // Los PRs solo-GitHub cuyo ticket YA está consolidado en una fila del
    // motor no se repiten (el motor los enganchó a external.github).
    const ticketsEnTablero = new Set(entries.map((b) => String(b.ticketNumber)).filter(Boolean));
    for (const pr of ghRows) {
      const dot = pr.state === 'merged' ? 'ok' : pr.state === 'closed' ? 'fail' : 'warn';
      const ticket = ticketOfPr(pr);
      if (ticket && ticketsEnTablero.has(String(ticket))) continue;
      // Pipeline mínimo del PR solo-GitHub: PR (siempre) + merge (si aplica).
      const pipe = `<span class="bb-pipe">
        <span class="bb-seg ${ticket ? 'bb-seg--ok' : ''}" title="${ticket ? `Ticket #${esc(ticket)} (detectado del título/branch)` : 'Sin ticket detectable'}"></span>
        <span class="bb-seg"></span>
        <span class="bb-seg bb-seg--${pr.state === 'closed' ? 'fail' : 'ok'}" title="PR #${pr.number} (${esc(pr.state)})"></span>
        <span class="bb-seg ${pr.state === 'merged' ? 'bb-seg--ok' : ''}" title="${pr.state === 'merged' ? 'Mergeado' : 'Sin merge'}"></span>
        <span class="bb-seg" title="Estado del ticket en Desk: abrí la fila y tocá “Traer estado de Desk”"></span>
      </span>`;
      rows.push(`
        <tr class="bfm-row bfm-row--gh" data-prnum="${pr.number}">
          <td><span class="hp-dot hp-dot--${dot}"></span></td>
          <td class="bfm-tkt" title="${ticket ? `Ticket #${esc(ticket)} detectado del PR` : 'PR en GitHub sin ticket detectable'}">${ticket ? `#${esc(ticket)}` : 'GitHub'}</td>
          <td class="bfm-title">#${esc(pr.number)} ${esc(pr.title)}</td>
          <td>${pipe}</td>
          <td class="bfm-stats">${statsHtml(pr.stats)}</td>
          <td class="bb-col-pr">${prCellFor({ ticketNumber: ticket, prState: pr.state, prNumber: pr.number, status: 'subido' })}</td>
          <td class="bb-col-desk">${deskCellFor({ ticketNumber: ticket })}</td>
          <td class="bfm-state">${pr.state === 'merged' ? `mergeado${pr.mergedBy ? ` por ${esc(pr.mergedBy)}` : ''}` : pr.state === 'closed' ? 'cerrado' : 'abierto'}</td>
        </tr>
        <tr class="bfm-detail" hidden><td colspan="8">${ghDetailHtml(pr)}</td></tr>`);
    }
    // ===== Sección Archivo · resueltos (colapsable, al fondo) =====
    if (archivados.length) {
      const arch = [...archivados].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      rows.push(`
        <tr class="bb-arch-header" data-arch-toggle="1">
          <td colspan="8">${icon('chevronDown', { size: 13 })} 📦 Archivo · ${arch.length} resuelto/s <span class="bb-arch-hint">(mostrar/ocultar)</span></td>
        </tr>`);
      for (const b of arch) rows.push(rowFor(b, true));
    }
    mr.tbody.innerHTML = rows.join('');
  }

  // ===== Interacción =====
  mr.tbody.addEventListener('click', async (e) => {
    const liveBtn = e.target.closest('[data-livefresh]');
    if (liveBtn) {
      const n = Number(liveBtn.dataset.livefresh);
      const box = liveBtn.closest('.bb-live');
      if (box) await fillLive(box, n, true);
      return;
    }
    // Desk: botón "Traer estado" (primera carga) y ↻ (fresca).
    const deskLoad = e.target.closest('[data-deskload]');
    if (deskLoad) {
      const box = deskLoad.closest('.bb-desk');
      if (box) await fillDesk(box, deskLoad.dataset.deskload, false);
      return;
    }
    const deskFresh = e.target.closest('[data-deskfresh]');
    if (deskFresh) {
      const box = deskFresh.closest('.bb-desk');
      if (box) await fillDesk(box, deskFresh.dataset.deskfresh, true);
      return;
    }
    // Cabecera "Archivo": muestra/oculta las filas archivadas.
    const archToggle = e.target.closest('[data-arch-toggle]');
    if (archToggle) {
      archToggle.classList.toggle('open');
      for (const r of mr.tbody.querySelectorAll('.bb-arch-row')) {
        // solo las filas base (no los detalles) togglean; los detalles quedan
        // ocultos hasta que se expanden.
        if (r.classList.contains('bfm-detail')) continue;
        r.hidden = !r.hidden;
      }
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      // Acción sobre un PR solo-GitHub (sin registro local).
      if (act.dataset.act === 'ghdeskchat') {
        const pr = ghRows.find((p) => String(p.number) === act.dataset.prnum);
        if (pr) {
          const ticket = ticketOfPr(pr);
          m.close();
          await doDeskChat({ ticketNumber: ticket, prNumber: pr.number, prUrl: pr.url, ticketUrl: null, summary: '', history: [] });
        }
        return;
      }
      const det = act.closest('.bfm-detail');
      const sid = det?.previousElementSibling?.dataset?.sid;
      const b = entries.find((x) => x.sessionId === sid);
      if (act.dataset.act === 'triagework') {
        const t = (triage.tickets || []).find((x) => String(x.ticketNumber) === act.dataset.tkt);
        if (t) { m.close(); await workOnTriage(t); }
      } else if (act.dataset.act === 'work' && b) { m.close(); await doWorkOn(b); }
      else if (act.dataset.act === 'deskchat' && b) { m.close(); await doDeskChat(b); }
      else if (act.dataset.act === 'cancelpr' && b) await doCancelPr(b, act);
      else if (act.dataset.act === 'archive' && b) await doArchive(b, true, act);
      else if (act.dataset.act === 'unarchive' && b) await doArchive(b, false, act);
      else if (act.dataset.act === 'del' && b) await doDiscard(b, act);
      return;
    }
    if (e.target.closest('a')) return;
    const row = e.target.closest('.bfm-row');
    if (!row) return; // las filas solo-GitHub ahora TAMBIÉN expanden
    const det = row.nextElementSibling;
    if (!det?.classList.contains('bfm-detail')) return;
    det.hidden = !det.hidden;
    // Al expandir una fila con PR: cargar el panel EN VIVO (una vez por apertura).
    if (!det.hidden) {
      const box = det.querySelector('.bb-live');
      if (box && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        fillLive(box, Number(box.dataset.live), false);
      }
    }
  });

  async function fetchContexts() {
    try {
      return (await Promise.all([
        fetch('/api/bugfixes/context?kind=work').then((r) => r.json()),
        fetch('/api/bugfixes/context?kind=pr').then((r) => r.json()),
      ])).map((d) => d.context || '');
    } catch { return ['', '']; }
  }

  // Texto del historial para inyectar contexto COMPLETO en los chats del ciclo.
  const historyText = (b) => timelineOf(b)
    .map((e) => `- ${fmtDate(e.t)}: ${(EV_LABEL[e.type] || (() => e.type))(e)}`).join('\n');

  async function doWorkOn(b) {
    const [workContext, prContext] = await fetchContexts();
    const est = prEstado(b);
    const prompt = [
      `Retomemos el fix del ticket Desk #${b.ticketNumber} para refinarlo a mano antes de ${b.status === 'subido' ? 'MODIFICAR el PR ya existente' : 'subir el PR'}.`,
      '',
      `Estado actual del registro: ${est.label}.`,
      b.prUrl ? `PR: ${b.prUrl}` : '',
      b.ticketUrl ? `Ticket: ${b.ticketUrl}` : '',
      b.files?.length ? `Archivos del fix hasta ahora:\n${b.files.map((f) => `- ${f}`).join('\n')}` : 'Todavía sin archivos editados (quedó en plan).',
      b.summary ? `\nResumen registrado del fix:\n${b.summary}` : '',
      `\nHISTORIAL del ciclo de este fix (tenelo presente):\n${historyText(b) || '(sin eventos)'}`,
      b.prNumber ? `\nSi el PR tiene feedback de Chris, revisalo primero: gh pr view ${b.prNumber} --comments` : '',
      workContext ? `\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${workContext}\n---` : '',
      prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
      '',
      'Empezá mostrándome el diff actual de esos archivos contra origin/main y tu evaluación de qué falta o qué mejorarías.',
    ].filter(Boolean).join('\n');
    await openChat({
      cwd: projectRel(), mode: 'default', prompt,
      title: `PR en progreso · TKT #${b.ticketNumber}`.slice(0, 60),
      ticket: { number: b.ticketNumber, url: b.ticketUrl || null },
    });
  }

  // Chat "Actualizar ticket": redacta la nota EN INGLÉS y actualiza Desk con
  // aprobación del usuario (tarjeta de permiso del MCP). SIN ticket:{} a
  // propósito — un chat de comunicación no debe re-registrar trabajo de código
  // (recordBugfix devolvería el fix a 'pendiente').
  async function doDeskChat(b) {
    // Sirve para un ticket CON PR (nota de novedades) o SIN PR todavía
    // (responder/pedir info al solicitante). El prompt se adapta al caso.
    const hasPr = !!b.prNumber;
    const prompt = [
      hasPr
        ? `Actualicemos el ticket de Zoho Desk #${b.ticketNumber} con las novedades del PR #${b.prNumber}.`
        : `Respondamos el ticket de Zoho Desk #${b.ticketNumber} (todavía sin PR asociado).`,
      b.ticketUrl ? `Ticket: ${b.ticketUrl}` : '',
      hasPr && b.prUrl ? `PR: ${b.prUrl}` : '',
      '',
      `HISTORIAL del fix:\n${historyText(b) || '(sin eventos)'}`,
      b.summary ? `\nResumen del fix:\n${b.summary.slice(0, 1200)}` : '',
      '',
      'Proceso (en este orden):',
      hasPr
        ? `1. Mirá el estado real y el feedback del PR: gh pr view ${b.prNumber} --comments`
        : '1. Repasá el historial del fix y lo que ya sabemos del problema.',
      '2. Verificá el ticket y su hilo en Desk con las tools desk_* del MCP (mirá si ya hay una respuesta nuestra para no repetir).',
      hasPr
        ? '3. Redactá una actualización EN INGLÉS, corta y humana (2-4 frases) con lo que cambió desde la última nota (qué se corrigió/mejoró y que el despliegue sigue en curso). MOSTRÁMELA y esperá mi OK.'
        : '3. Redactá EN INGLÉS una respuesta corta y humana (2-4 frases) apropiada al estado real: un avance, un pedido de información, o el próximo paso. MOSTRÁMELA y esperá mi OK.',
      '4. Recién con mi OK, publicala en el ticket (visible al solicitante si se puede) y ajustá el estado si corresponde.',
      'NO toques código ni envíes PRs desde este chat.',
    ].filter(Boolean).join('\n');
    await openChat({
      cwd: projectRel(), mode: 'default', prompt,
      title: `Ticket #${b.ticketNumber} · ${hasPr ? 'update' : 'respuesta'}`.slice(0, 60),
    });
  }

  // Ticket del triage sin trabajo: mismo flujo que la sección Bugs.
  async function workOnTriage(t) {
    const [workContext, prContext] = await fetchContexts();
    const prompt = [
      `Trabajemos el bug del ticket Desk #${t.ticketNumber}.`,
      '',
      `Qué se rompió: ${t.whatBroke}`,
      `Ruta: ${t.route || '(sin ruta)'}`,
      `Severidad: ${t.severity} · Recomendación del triage: ${t.recommendation}`,
      t.reporter ? `Reportó: ${t.reporter}` : '',
      t.webUrl ? `Ticket: ${t.webUrl}` : '',
      t.context ? `\nContexto del triage:\n${t.context}` : '',
      workContext ? `\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${workContext}\n---` : '',
      prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
      '',
      'Estás en modo PLAN: investigá el código relevante y proponé un plan de arreglo antes de tocar nada.',
    ].filter(Boolean).join('\n');
    await openChat({
      cwd: projectRel(), mode: 'plan', prompt,
      title: `TKT #${t.ticketNumber} — ${t.whatBroke}`.slice(0, 60),
      ticket: { number: t.ticketNumber, url: t.webUrl || null },
    });
  }

  async function doCancelPr(b, btn) {
    const ok = await dialog.confirmDialog({
      title: `Cancelar PR — TKT #${b.ticketNumber || '?'}`,
      message: `Se cierra el PR${b.prNumber ? ` #${b.prNumber}` : ''} en GitHub (sin mergear), se borra el branch remoto${b.branch ? ` (${b.branch})` : ''} y el fix vuelve a PENDIENTE.\n\nNo se toca tu árbol de trabajo ni los archivos del fix.`,
      confirmLabel: 'Cancelar PR', danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/bugfixes/cancel-pr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo cancelar el PR.');
      await dialog.alertDialog({ title: 'PR cancelado', message: `${(data.steps || []).map((s) => `• ${s}`).join('\n') || '• Listo.'}` });
    } catch (err) {
      await dialog.alertDialog({ title: 'Cancelar PR', message: err.message });
    } finally {
      await reload(); ghSync(true);
    }
  }

  // Archivar / restaurar: solo organización del tablero (no toca código ni PRs).
  async function doArchive(b, archived, btn) {
    if (btn) btn.disabled = true;
    // Un ticket puede tener varios intentos: archivar/restaurar TODOS para
    // que el estado consolidado del motor quede coherente.
    const ids = b.allSessionIds?.length ? b.allSessionIds : [b.sessionId];
    try {
      for (const id of ids) {
        const res = await fetch('/api/bugfixes/archive', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, archived }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo archivar.');
      }
    } catch (err) {
      await dialog.alertDialog({ title: 'Archivo', message: err.message });
    } finally { await reload(); }
  }

  async function doDiscard(b, btn) {
    const ok = await dialog.confirmDialog({
      title: `Descartar registro — TKT #${b.ticketNumber || '?'}`,
      message: 'Se borra SOLO el registro local del fix (no toca código, branches ni PRs en GitHub).',
      confirmLabel: 'Descartar', danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    const ids = b.allSessionIds?.length ? b.allSessionIds : [b.sessionId];
    try {
      for (const id of ids) {
        const res = await fetch('/api/bugfixes/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo descartar el registro.');
      }
    } catch (err) {
      await dialog.alertDialog({ title: 'Descartar registro', message: err.message });
    } finally { await reload(); }
  }

  async function reload() {
    try {
      // FUENTE = el MOTOR: tickets consolidados (1 por número, attempts
      // embebidos, estado derivado). Se aplanan con ticketToRow para los
      // helpers. Reemplaza el array plano de registros por-chat de antes.
      const [bf, tk] = await Promise.all([
        fetch('/api/bugfixes/tickets').then((r) => r.json()),
        fetch('/api/bugs').then((r) => r.json()).catch(() => triage),
      ]);
      entries = (bf.tickets || []).map(ticketToRow);
      triage = tk || triage;
      renderTable();
    } catch {
      mr.tbody.innerHTML = '<tr><td colspan="8" class="hp-empty">No se pudo leer el registro.</td></tr>';
    }
  }

  async function ghSync(silent) {
    mr.ghsync.disabled = true;
    mr.ghstate.innerHTML = `${pacman()} GitHub…`;
    try {
      const res = await fetch('/api/bugfixes/refresh-prs', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falló la consulta a GitHub.');
      ghRows = data.github || [];
      await reload(); // re-deriva los tickets del motor (ghRows ya enganchados server-side)
      lastGhAt = Date.now(); updateFreshness();
      if (data.errors?.length && !silent) {
        await dialog.alertDialog({ title: 'GitHub', message: `Algunos PRs no se pudieron consultar:\n${data.errors.join('\n')}` });
      }
    } catch (err) {
      if (mr.ghstate) mr.ghstate.innerHTML = `<span class="bb-fresh">GitHub no disponible · ${lastDeskAt ? `Desk: ${fmtAgo(lastDeskAt)}` : 'Desk: sin consultar'}</span>`;
      if (!silent) await dialog.alertDialog({ title: 'GitHub', message: err.message });
    } finally { mr.ghsync.disabled = false; }
  }

  // Enviar pendientes: advertencias de verificación + repo al día + subida.
  mr.send.addEventListener('click', async () => {
    const pendientes = entries.filter((b) => b.status === 'pendiente' && b.files?.length);
    if (!pendientes.length) return;
    const lineas = pendientes.map((b) => {
      const w = warningsFor(b);
      return `   • TKT #${b.ticketNumber} (${b.files.length} archivo/s) — ${b.prNumber ? `ACTUALIZA el PR #${b.prNumber}` : 'PR nuevo'}${w.length ? `\n     ⚠ ${w.join(' · ')}` : ''}`;
    });
    const conDeskAuto = pendientes.filter((b) => !b.sentAt && !b.prNumber && b.ticketNumber);
    const ok = await dialog.confirmDialog({
      title: 'Enviar PR a Tolkien',
      message: `1. Se actualiza el repo (stash → pull → stash pop).\n2. Por cada fix pendiente (${pendientes.length}):\n${lineas.join('\n')}\n${conDeskAuto.length ? `\n3. Los PRs NUEVOS actualizan su ticket en Desk automáticamente (On Hold + nota corta en inglés): ${conDeskAuto.map((b) => `#${b.ticketNumber}`).join(', ')}.` : ''}\n\nSolo se toca ~/tolkien; tu árbol no cambia de branch.`,
      confirmLabel: `Actualizar y subir ${pendientes.length} PR(s)`,
      danger: pendientes.some((b) => warningsFor(b).length > 0),
    });
    if (!ok) return;
    mr.send.disabled = true;
    mr.send.innerHTML = `${pacman()}<span>Subiendo…</span>`;
    try {
      const up = await updateRepo();
      if (!up.ok) return await dialog.alertDialog({ title: 'Enviar PR — actualización falló', message: up.message });
      const results = [];
      for (const b of pendientes) {
        try {
          const res = await fetch('/api/bugfixes/pr', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: b.sessionId }),
          });
          const data = await res.json().catch(() => ({}));
          results.push(res.ok
            ? `✓ TKT #${b.ticketNumber}: ${data.updated
              ? `PR ACTUALIZADO · commit ${data.commit || '?'}${data.commitCount ? ` (${data.commitCount}º del branch)` : ''} — el ticket NO se tocó: usá "Actualizar ticket (chat)"`
              : `PR nuevo${data.deskAuto ? ' · ticket de Desk actualizándose (auto)' : ''}`} → ${data.prUrl || data.branch}`
            : `✗ TKT #${b.ticketNumber}: ${data.error || 'falló'}`);
        } catch { results.push(`✗ TKT #${b.ticketNumber}: error de red`); }
      }
      await dialog.alertDialog({ title: 'Enviar PR — resultado', message: results.join('\n') });
    } finally {
      mr.send.innerHTML = `${icon('gitBranch', { size: 13 })}<span>Enviar pendientes</span>`;
      await reload();
      ghSync(true);
    }
  });

  mr.scan.addEventListener('click', async () => {
    mr.scan.disabled = true;
    try {
      const res = await fetch('/api/bugfixes/scan', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falló la búsqueda.');
      await reload(); // re-deriva del motor
      await dialog.alertDialog({
        title: 'Buscar bugfixes',
        message: data.added ? `Se registraron ${data.added} fix(es) nuevos (${data.scanned} transcripts revisados).`
          : `Nada nuevo (${data.scanned} transcripts revisados).`,
      });
    } catch (err) { await dialog.alertDialog({ title: 'Buscar bugfixes', message: err.message }); }
    finally { mr.scan.disabled = false; }
  });

  mr.ghsync.addEventListener('click', () => ghSync(false));
  mr.help.addEventListener('click', showHelp);

  // Modal "Cómo leer este tablero": explica la nomenclatura del tablero.
  function showHelp() {
    const h = dialog.openModal({ title: 'Cómo leer este tablero', width: 460 });
    h.body.innerHTML = `
      <div class="bb-help">
        <div class="bb-help-sec">
          <b>Pipeline</b> <span class="bb-help-dim">— las 5 barritas del ciclo del bug</span>
          <div class="bb-help-pipe">
            <span class="bb-pipe">
              <span class="bb-seg bb-seg--ok"></span><span class="bb-seg bb-seg--ok"></span>
              <span class="bb-seg bb-seg--ok"></span><span class="bb-seg"></span><span class="bb-seg"></span>
            </span>
          </div>
          <ol class="bb-help-steps">
            <li>🎫 <b>Triage</b> — el ticket está en el último triage de Desk</li>
            <li>🛠 <b>Trabajo</b> — hay archivos editados en el fix</li>
            <li>⬆ <b>PR</b> — se creó el pull request</li>
            <li>✅ <b>Merge</b> — Chris lo mergeó a main</li>
            <li>🎫 <b>Ticket confirmado</b> — el ticket se cerró o el cliente respondió (verde SOLO acá = completo de verdad)</li>
          </ol>
          <p class="bb-help-dim">Color de cada barra: <span class="bb-help-c bb-help-c--ok">verde</span> hecho · <span class="bb-help-c bb-help-c--fail">rojo</span> falló/cerrado · <span class="bb-help-c">gris</span> pendiente.</p>
        </div>
        <div class="bb-help-sec">
          <b>Resolución</b> <span class="bb-help-dim">— merge ≠ terminado</span>
          <ul class="bb-help-list">
            <li>${RES_CHIP.partial} nuestro PR se mergeó, pero el ticket todavía NO confirmó: puede ser fix parcial o total, aún sin verificar</li>
            <li>${RES_CHIP.complete} el ticket se cerró o el cliente respondió → confirmado, listo para archivar</li>
          </ul>
          <p class="bb-help-dim">El paso de parcial → completo se detecta al tocar <i>🎫 Traer estado de Desk</i> en el detalle de la fila.</p>
        </div>
        <div class="bb-help-sec">
          <b>📦 Archivo · resueltos</b> — sección colapsable al fondo. Los fixes confirmados (o archivados a mano con "Archivar") salen de la lista activa y quedan acá con su historial completo. "Restaurar" los devuelve.
        </div>
        <div class="bb-help-sec">
          <b>Chips</b> <span class="bb-help-dim">(en el detalle de cada fila)</span>
          <ul class="bb-help-list">
            <li><span class="bb-chip bb-chip--ok">🎫 abierto en Desk</span> el ticket sigue en el triage</li>
            <li><span class="bb-chip bb-chip--warn">👥 dup</span> posible duplicado</li>
            <li><span class="bb-chip bb-chip--info">🔁 reabierto</span> el fix se retrabajó tras el PR</li>
            <li><span class="bb-chip bb-chip--danger">⚠ doble registro</span> hay 2+ registros del mismo ticket</li>
            <li><span class="bb-chip bb-chip--ok">🎫 ticket ✓</span> / <span class="bb-chip bb-chip--danger">✗</span> última actualización de Desk OK / falló</li>
          </ul>
        </div>
        <div class="bb-help-sec">
          <b>Punto de estado</b> <span class="bb-help-dim">(a la izquierda de la fila)</span>
          <ul class="bb-help-list">
            <li><span class="hp-dot hp-dot--ok"></span> mergeado / al día</li>
            <li><span class="hp-dot hp-dot--warn"></span> en curso (pendiente, PR abierto)</li>
            <li><span class="hp-dot hp-dot--fail"></span> cerrado sin merge</li>
          </ul>
        </div>
        <div class="bb-help-sec">
          <b>GitHub en vivo</b> — al expandir un PR: review, checks, conflictos, commits y feedback de Chris, en el momento (caché 60 s, ↻ refresca).
        </div>
        <div class="bb-help-sec">
          <b>Desk en vivo</b> — botón <i>🎫 Traer estado de Desk</i>: consulta Zoho Desk y muestra el estado real del ticket y sus últimos comentarios, para ver si tu actualización ya quedó. <span class="bb-help-dim">Consume tokens; por eso es bajo botón.</span>
        </div>
        <div class="bb-help-sec">
          <b>Fila “#N …” (GitHub)</b> — un PR tuyo en GitHub sin registro local. El <b>#N</b> del ticket se detecta del título/branch; expandila para ver commits y actualizar su ticket.
        </div>
      </div>`;
  }

  // Sincronización Desk de los tickets ACTIVOS (no resueltos): CONSUME TOKENS,
  // por eso con confirm. Cada consulta persiste el snapshot en el registro y
  // el motor lo refleja (deskReplied/deskResolved) — resuelve el "aparece sin
  // datos aunque ya tiene respuesta". Desk NUNCA se consulta solo.
  mr.desksync.addEventListener('click', async () => {
    const activos = entries.filter((b) => b.ticketNumber && b.resolution !== 'complete');
    if (!activos.length) return dialog.alertDialog({ title: 'Desk', message: 'No hay tickets activos para consultar.' });
    const ok = await dialog.confirmDialog({
      title: 'Sincronizar Desk',
      message: `Se consulta Zoho Desk el estado real de ${activos.length} ticket(s) activo(s) (respuesta publicada, resuelto).\n\nCONSUME TOKENS (una corrida de lectura por ticket). Los resueltos no se re-consultan.`,
      confirmLabel: `Consultar ${activos.length}`,
    });
    if (!ok) return;
    mr.desksync.disabled = true;
    const orig = mr.desksync.innerHTML;
    let done = 0;
    for (const b of activos) {
      mr.desksync.innerHTML = `${pacman()}<span>Desk ${++done}/${activos.length}…</span>`;
      try { await fetch(`/api/bugfixes/desk-live/${encodeURIComponent(b.ticketNumber)}`); } catch { /* sigue */ }
    }
    mr.desksync.disabled = false; mr.desksync.innerHTML = orig;
    lastDeskAt = Date.now();
    await reload(); // el motor ya lee los deskReplied/deskResolved recién persistidos
    updateFreshness();
  });

  // Auto-refresco de GitHub (BARATO: solo gh, sin tokens) mientras el tablero
  // está abierto, para que los merges de Chris aparezcan solos. Se limpia al
  // cerrar y al ocultar la pestaña; se re-dispara al volver.
  const GH_AUTO_MS = 45000;
  let ghTimer = setInterval(() => { if (!document.hidden) ghSync(true); }, GH_AUTO_MS);
  let freshTimer = setInterval(updateFreshness, 20000); // solo re-pinta "hace X"
  const onVis = () => { if (!document.hidden) ghSync(true); };
  document.addEventListener('visibilitychange', onVis);
  const origClose = m.close;
  m.close = () => { clearInterval(ghTimer); clearInterval(freshTimer); document.removeEventListener('visibilitychange', onVis); origClose(); };

  // Al abrir: registro + triage al instante; GitHub completa enseguida.
  reload().then(() => ghSync(true));
  return m;
}
