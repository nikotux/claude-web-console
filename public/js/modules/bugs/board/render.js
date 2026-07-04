// board/render.js — funciones PURAS estado→HTML + el único punto de re-render.
//
// R1: acá no se guarda NADA — todo sale del store (expansión, paneles lazy,
// frescura, busy). Re-renderizar es siempre seguro: el detalle abierto, los
// paneles GitHub/Desk/investigación y el scroll se reconstruyen del estado.
// Por eso el auto-refresh de GitHub ya no necesita pausarse.
//
// initRender() inyecta las dependencias del shell (icon de ctx + refs del
// modal); render(state) es el suscriptor del store.

import { pacman } from '../../../ui/pacman.js';
import { esc, fmtDate, fmtAgo } from './util.js';
import {
  ticketOfPr, timelineOf, EV_LABEL, evDot, resolutionOf, RES_CHIP, prEstado,
  prCellFor, deskCellFor, OUTCOME_LABEL, rowKey, triageKey, ghKey,
  triageByNum, entriesByTicket,
} from './labels.js';

let icon = null;
let mr = null; // refs del modal: send/scan/ghsync/desksync/help/ghstate/triage/tbody/box

export function initRender(deps) { icon = deps.icon; mr = deps.refs; }

// Pendientes de envío (la MISMA definición que usa el action de enviar).
export const pendingOf = (entries) => entries.filter((b) => b.status === 'pendiente' && b.files?.length);

// ===== Header (toolbar): solo muta innerHTML/disabled de refs estables =====
// (los listeners viven en los elementos, jamás se recrean — R1 sin sorpresas)
export function renderHeader(state) {
  const pendientes = pendingOf(state.entries);
  // Enviar pendientes
  if (state.busy.send) {
    mr.send.disabled = true;
    mr.send.innerHTML = `${pacman()}<span>Subiendo…</span>`;
  } else {
    mr.send.disabled = !pendientes.length;
    mr.send.innerHTML = `${icon('gitBranch', { size: 13 })}<span>${pendientes.length ? `Enviar pendientes (${pendientes.length})` : 'Enviar pendientes'}</span>`;
  }
  // Buscar bugfixes / GitHub
  mr.scan.disabled = !!state.busy.scan;
  mr.ghsync.disabled = !!state.busy.ghsync;
  // 🎫 Desk (bulk)
  if (state.busy.desksync) {
    mr.desksync.disabled = true;
    const p = state.deskSyncProgress;
    mr.desksync.innerHTML = `${pacman()}<span>Desk${p && p.total ? ` ${p.done}/${p.total}` : ''}…</span>`;
  } else {
    mr.desksync.disabled = false;
    mr.desksync.innerHTML = `${icon('download', { size: 13 })}<span>🎫 Desk</span>`;
  }
  // Frescura GitHub · Desk
  if (state.busy.ghsync) {
    mr.ghstate.innerHTML = `${pacman()} GitHub…`;
  } else {
    const dk = state.lastDeskAt ? `Desk: ${fmtAgo(state.lastDeskAt)}` : 'Desk: sin consultar';
    mr.ghstate.innerHTML = state.ghError
      ? `<span class="bb-fresh">GitHub no disponible · ${dk}</span>`
      : `<span class="bb-fresh">${state.lastGhAt ? `GitHub: ${fmtAgo(state.lastGhAt)}` : 'GitHub: —'} · ${dk}</span>`;
  }
  // Frescura del triage
  mr.triage.innerHTML = state.triage.updatedAt
    ? `triage: ${fmtAgo(state.triage.updatedAt)}${Date.now() - state.triage.updatedAt > 86400000 ? ' <span class="bb-chip bb-chip--warn">viejo</span>' : ''}`
    : 'triage: sin datos';
}

// ===== Chips de verificación (cruce registro × triage × historial) =====
function chipsFor(b, state) {
  const chips = [];
  const tk = b.ticketNumber ? triageByNum(state.triage).get(String(b.ticketNumber)) : null;
  if (tk) {
    chips.push(`<span class="tk-sev tk-sev-${esc(tk.severity)}">${esc(tk.severity)}</span>`);
    chips.push('<span class="bb-chip bb-chip--ok" title="El ticket aparece en el último triage de Desk (sigue abierto)">🎫 abierto en Desk</span>');
    if (tk.duplicate) chips.push(`<span class="bb-chip bb-chip--warn" title="El triage lo marcó como posible duplicado">👥 dup: ${esc(tk.duplicate)}</span>`);
  } else if (b.ticketNumber && state.triage.updatedAt) {
    chips.push('<span class="bb-chip bb-chip--warn" title="No aparece en el último triage: puede estar resuelto/cerrado — verificá antes de enviar">🎫 no está en el triage</span>');
  }
  const tl = timelineOf(b);
  const reaperturas = tl.filter((e) => e.type === 'trabajo_nuevo').length;
  if (reaperturas) chips.push(`<span class="bb-chip bb-chip--info" title="El fix se retrabajó tras enviar el PR">🔁 reabierto ×${reaperturas}</span>`);
  if (b.ticketNumber && (entriesByTicket(state.entries).get(String(b.ticketNumber)) || 0) > 1) {
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

// Pipeline visual: 5 etapas del ciclo. La ÚLTIMA es "ticket confirmado"
// (cerrado o cliente respondió) — verde SOLO cuando está completo de verdad:
// un PR mergeado (barra 4) es solución parcial hasta que el ticket confirma.
function pipelineHtml(b, state) {
  const tk = b.ticketNumber ? triageByNum(state.triage).get(String(b.ticketNumber)) : null;
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

// Render de la celda de estado: ícono (si hay) + etiqueta, tintados por el
// dot (bfm-est--<dot> pinta el ícono con currentColor; el texto queda legible).
function estHtml(est) {
  const ic = est.icon ? `<span class="bfm-est-ic">${icon(est.icon, { size: 12 })}</span>` : '';
  return `<span class="bfm-est bfm-est--${est.dot}">${ic}<span>${esc(est.label)}</span></span>`;
}

function statsHtml(s) {
  if (!s) return '<span class="bfm-nostats">—</span>';
  return `<span class="bfm-add">+${s.add}</span> <span class="bfm-del">−${s.del}</span>` +
    `<span class="bfm-nfiles"> · ${s.files}a</span>`;
}

// ===== Detalle expandible =====
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

// Soluciones pasadas parecidas (biblioteca del motor, se llena sola al
// mergear). Muestra rootCause/fix, la lección y el feedback de Chris que la
// marcó — conocimiento reusable para este ticket.
function similarHtml(b) {
  const sim = b.similar || [];
  if (!sim.length) return '';
  return `<div class="bb-similar"><div class="bb-similar-h">💡 Soluciones parecidas de tickets pasados</div>${sim.map((s) => `
    <div class="bb-similar-item">
      <div class="bb-similar-top"><b>TKT #${esc(s.ticketNumber)}</b>${s.files?.length ? ` <code>${esc(s.files[0])}${s.files.length > 1 ? ` +${s.files.length - 1}` : ''}</code>` : ''}</div>
      ${s.rootCause ? `<div class="bb-similar-line"><span>Problema:</span> ${esc(s.rootCause.slice(0, 160))}</div>` : ''}
      ${s.fix ? `<div class="bb-similar-line"><span>Fix:</span> ${esc(s.fix.slice(0, 160))}</div>` : ''}
      ${s.lesson ? `<div class="bb-similar-line bb-similar-lesson"><span>Lección:</span> ${esc(s.lesson.slice(0, 160))}</div>` : ''}
      ${(s.feedback || []).length ? `<div class="bb-similar-fb">🗣 ${s.feedback.slice(-2).map((f) => `<span title="${esc(f.author)}">${esc((f.body || '').slice(0, 90))}</span>`).join(' · ')}</div>` : ''}
    </div>`).join('')}</div>`;
}

// Feedback de Chris persistido en ESTE ticket (memoria del PR, sobrevive
// reinicios). Se llena al abrir el panel "GitHub en vivo" del PR.
function feedbackHtml(b) {
  const fb = b.feedback || [];
  if (!fb.length) return '';
  return `<div class="bb-fbmem"><div class="bb-fbmem-h">🗣 Feedback de Chris (guardado)</div>${fb.slice(-5).map((f) => `
    <div class="bb-fb">
      <span class="bb-fb-head"><b>${esc(f.author)}</b> · ${esc(f.kind)}${f.at ? ` · ${fmtDate(f.at)}` : ''}</span>
      ${f.body ? `<span class="bb-fb-body">${esc(f.body)}</span>` : ''}
    </div>`).join('')}</div>`;
}

// 🚦 Semáforo determinístico (0 tokens) desde los datos de prLive: ¿de quién
// es la pelota? Se muestra solo, sin botón, al expandir el PR.
function semaforoHtml(L) {
  const chips = [];
  if (L.reviewDecision === 'APPROVED') chips.push(['ok', '✅ Chris aprobó']);
  else if (L.reviewDecision === 'CHANGES_REQUESTED') chips.push(['danger', '⚠ Chris pidió cambios']);
  else if (L.reviewDecision === 'REVIEW_REQUIRED') chips.push(['info', '🕐 esperando review de Chris']);
  const checksBad = (L.checks || []).filter((c) => ['failure', 'error', 'timed_out', 'cancelled'].includes(c.status)).length;
  if (checksBad) chips.push(['danger', `🔴 ${checksBad} check(s) fallando`]);
  if (L.mergeable === 'CONFLICTING') chips.push(['danger', '🔀 conflictos con main']);
  const lastCommitAt = (L.commits || []).reduce((m, c) => Math.max(m, c.at || 0), 0);
  const lastFb = (L.feedback || [])[(L.feedback || []).length - 1];
  if (lastFb && lastFb.at > lastCommitAt) chips.push(['warn', `💬 ${esc(lastFb.author)} escribió tras tu último commit`]);
  if (!chips.length) chips.push(['info', '🕐 en revisión · esperando a Chris']);
  return `<div class="bb-sem">${chips.map(([k, t]) => `<span class="bb-chip bb-chip--${k}">${t}</span>`).join('')}</div>`;
}

// ===== Panel "GitHub en vivo" (desde state.live[pr]) =====
function liveBoxHtml(prNumber, state) {
  const slot = state.live[prNumber];
  let body;
  if (!slot || slot.loading) {
    body = `<div class="cwc-loading">${pacman()}consultando GitHub en vivo…</div>`;
  } else if (slot.error) {
    body = `<div class="bb-live-err">⚠ ${esc(slot.error)} — datos locales abajo.</div>`;
  } else {
    const L = slot.data;
    const dec = L.reviewDecision === 'APPROVED' ? ['ok', 'review: aprobado ✓']
      : L.reviewDecision === 'CHANGES_REQUESTED' ? ['danger', 'review: CAMBIOS PEDIDOS']
      : L.reviewDecision === 'REVIEW_REQUIRED' ? ['warn', 'review: pendiente'] : null;
    const checksOk = L.checks.filter((c) => ['success', 'neutral', 'skipped'].includes(c.status)).length;
    const checksBad = L.checks.filter((c) => ['failure', 'error', 'timed_out', 'cancelled'].includes(c.status)).length;
    body = `
      <div class="bb-live-head">
        <b>GitHub en vivo</b>
        <span class="bb-chip bb-chip--${L.state === 'merged' ? 'ok' : L.state === 'closed' ? 'danger' : 'info'}">${esc(L.state)}</span>
        ${dec ? `<span class="bb-chip bb-chip--${dec[0]}">${esc(dec[1])}</span>` : ''}
        ${L.mergeable === 'CONFLICTING' ? '<span class="bb-chip bb-chip--danger">⚠ conflictos con main</span>' : ''}
        ${L.checks.length ? `<span class="bb-chip bb-chip--${checksBad ? 'danger' : 'ok'}">checks ${checksOk}/${L.checks.length}${checksBad ? ` · ${checksBad} ✗` : ''}</span>` : ''}
        <button class="btn-ghost btn--sm btn--icon" data-livefresh="${prNumber}" title="Consultar de nuevo (saltea la caché de 60 s)">${icon('refresh', { size: 12 })}</button>
        <span class="bb-live-at">${fmtAgo(L.fetchedAt)}</span>
      </div>
      ${semaforoHtml(L)}
      ${L.commits.length ? `<div class="bb-live-commits">${L.commits.map((c) => `<div class="bb-commit"><code>${esc(c.sha)}</code> ${esc(c.msg)} <span class="bb-tl-date">${fmtDate(c.at)}</span></div>`).join('')}</div>` : ''}
      ${L.feedback.length ? `<div class="bb-live-fb">${L.feedback.map((f) => `
        <div class="bb-fb">
          <span class="bb-fb-head"><b>${esc(f.author)}</b> · ${esc(f.kind)} · ${fmtDate(f.at)}</span>
          ${f.body ? `<span class="bb-fb-body">${esc(f.body)}</span>` : ''}
        </div>`).join('')}</div>`
    : '<div class="bb-live-fb bb-live-empty">Sin comentarios ni reviews todavía.</div>'}`;
  }
  return `<div class="bb-live" data-live="${prNumber}">${body}</div>`;
}

// ===== Investigaciones (desde state.inv / state.tktInv) =====
// Render del veredicto de la investigación IA de un PR (persistido).
function verdictHtml(inv) {
  const L = inv?.lectura;
  if (!L || !L.ok) return `<div class="bb-inv-err">No se pudo interpretar la investigación${L?.error ? `: ${esc(L.error)}` : ''}.</div>`;
  const tone = L.severidad === 'blocker' ? 'danger' : L.severidad === 'cambio' ? 'warn' : L.severidad === 'aprobacion' ? 'ok' : 'info';
  const ic = L.severidad === 'aprobacion' ? 'check' : (L.bloqueante || L.severidad === 'blocker') ? 'close' : 'clock';
  return `
    <div class="bb-verdict bb-verdict--${tone}">
      <div class="bb-verdict-head">${icon(ic, { size: 14 })}<b>${esc(L.titular || 'Investigación')}</b>${L.bloqueante ? '<span class="bb-chip bb-chip--danger">bloqueante</span>' : ''}<span class="bb-verdict-conf">confianza ${esc(L.confianza)}</span></div>
      ${L.queQuiereChris ? `<div class="bb-verdict-what">${esc(L.queQuiereChris)}</div>` : ''}
      ${L.pasos.length ? `<ul class="bb-verdict-steps">${L.pasos.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${L.archivos.length ? `<div class="bb-verdict-files">${L.archivos.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}
    </div>`;
}

// Render del veredicto de contexto (persistido): POR QUÉ no se resolvió + causa raíz.
function verdictTicketHtml(inv) {
  const L = inv?.lectura;
  if (!L || !L.ok) return `<div class="bb-inv-err">No se pudo interpretar la investigación${L?.error ? `: ${esc(L.error)}` : ''}.</div>`;
  const tone = L.necesitaMasInfo ? 'info' : L.complejidad === 'alta' ? 'danger' : L.complejidad === 'media' ? 'warn' : 'ok';
  return `
    <div class="bb-verdict bb-verdict--${tone}">
      <div class="bb-verdict-head">${icon('search', { size: 14 })}<b>${esc(L.titular || 'Investigación de contexto')}</b><span class="bb-chip bb-chip--${tone}">complejidad ${esc(L.complejidad)}</span><span class="bb-verdict-conf">confianza ${esc(L.confianza)}</span></div>
      ${L.porQueNoResuelto ? `<div class="bb-verdict-what"><b>Por qué no se resolvió:</b> ${esc(L.porQueNoResuelto)}</div>` : ''}
      ${L.causaRaiz ? `<div class="bb-verdict-what"><b>Causa raíz:</b> ${esc(L.causaRaiz)}</div>` : ''}
      ${L.pasos.length ? `<ul class="bb-verdict-steps">${L.pasos.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${L.riesgo ? `<div class="bb-verdict-what"><b>Riesgo al tocarlo:</b> ${esc(L.riesgo)}</div>` : ''}
      ${L.archivos.length ? `<div class="bb-verdict-files">${L.archivos.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>` : ''}
    </div>`;
}

// Caja DESTACADA de investigación al inicio del detalle. Dos variantes según
// la fila (0 tokens: pinta el veredicto persistido del store):
//   · CON PR  → investiga el PR (diff + comentarios de Chris): data-invtop.
//   · SIN PR  → investiga el CONTEXTO leyendo el código de Tolkien read-only
//     (POR QUÉ no se resolvió): data-tktinvtop + el enunciado del ticket.
function invTopBox(row, state) {
  if (!row) return '';
  if (row.prNumber) {
    const pr = row.prNumber;
    const slot = state.inv[pr];
    let body;
    if (!slot || slot.loading) body = `<div class="cwc-loading">${pacman()}cargando investigación…</div>`;
    else if (slot.running) body = `<div class="cwc-loading">${pacman()}investigando el PR #${esc(pr)}… (lee el diff y el feedback de Chris)</div>`;
    else {
      const inv = slot.st?.investigation;
      body = `
        <div class="bb-inv-title">${icon('search', { size: 13 })}<b>Investigación del PR #${esc(pr)}</b></div>
        ${inv ? `${verdictHtml(inv)}<div class="bb-inv-at">investigado ${fmtAgo(inv.fetchedAt)}</div>` : ''}
        <button class="btn ${inv ? 'btn-ghost' : ''} btn--sm" data-investigate="${esc(pr)}" data-invticket="${esc(row.ticketNumber || '')}">${icon('search', { size: 13 })}<span>🔍 ${inv ? 'Investigar de nuevo' : 'Investigar a fondo'}</span></button>`;
    }
    return `<div class="bb-inv bb-inv--top" data-invtop="${esc(pr)}" data-invticket="${esc(row.ticketNumber || '')}">${body}</div>`;
  }
  if (!row.ticketNumber) return '';
  const problem = {
    title: row.title || '', whatBroke: row.whatBroke || '', route: row.route || '',
    reporter: row.reporter || '', severity: row.severity || '', context: row.context || '',
    summary: row.summary || '', files: row.files || [],
  };
  const pj = esc(JSON.stringify(problem));
  const t = row.ticketNumber;
  const slot = state.tktInv[t];
  let body;
  if (!slot || slot.loading) body = `<div class="cwc-loading">${pacman()}cargando investigación…</div>`;
  else if (slot.running) body = `<div class="cwc-loading">${pacman()}investigando el ticket #${esc(t)}… (leyendo el código de Tolkien)</div>`;
  else {
    const inv = slot.st?.investigation;
    body = `
      <div class="bb-inv-title">${icon('search', { size: 13 })}<b>Investigación de contexto · TKT #${esc(t)}</b></div>
      ${inv ? `${verdictTicketHtml(inv)}<div class="bb-inv-at">investigado ${fmtAgo(inv.fetchedAt)}</div>`
      : '<div class="bb-inv-hint">Lee el código de Tolkien (read-only) y explica por qué el ticket sigue abierto.</div>'}
      <button class="btn ${inv ? 'btn-ghost' : ''} btn--sm" data-tktinvestigate="${esc(t)}" data-invproblem="${pj}">${icon('search', { size: 13 })}<span>🔍 ${inv ? 'Investigar de nuevo' : 'Investigar contexto'}</span></button>`;
  }
  return `<div class="bb-inv bb-inv--top bb-inv--tkt" data-tktinvtop="${esc(t)}" data-invproblem="${pj}">${body}</div>`;
}

// ===== Sección "Estado de Desk" (desde state.desk[ticket]) =====
// Bajo botón (consume tokens), no auto al expandir. El resultado y el
// progreso viven en el store: sobreviven re-renders y colapsos del panel.
function deskSectionHtml(ticket, state) {
  const slot = state.desk[ticket];
  let body;
  if (!slot) {
    body = `<button class="btn-ghost btn--sm bb-desk-btn" data-deskload="${esc(ticket)}" title="Trae el estado ACTUAL del ticket desde Zoho Desk (consume tokens) — para ver si tu comentario ya quedó publicado">${icon('download', { size: 13 })}<span>🎫 Traer estado de Desk</span></button>`;
  } else if (slot.loading) {
    const prog = slot.progress && slot.progress.total > 1 ? ` (${slot.progress.done}/${slot.progress.total})` : '';
    body = `<div class="cwc-loading">${pacman()}consultando Zoho Desk…${prog}</div>`;
  } else if (slot.error) {
    body = `<div class="bb-live-err">⚠ ${esc(slot.error)} — reintentá con ↻.</div>
      <div class="bb-desk-head"><button class="btn-ghost btn--sm btn--icon" data-deskfresh="${esc(ticket)}" title="Reintentar">${icon('refresh', { size: 12 })}</button></div>`;
  } else {
    const d = slot.data;
    const head = (extra) => `
      <div class="bb-desk-head">
        <b>Zoho Desk · #${esc(ticket)}</b>
        ${extra}
        <button class="btn-ghost btn--sm btn--icon" data-deskfresh="${esc(ticket)}" title="Consultar de nuevo (saltea la caché de 60 s)">${icon('refresh', { size: 12 })}</button>
        <span class="bb-live-at">${fmtAgo(d.fetchedAt)}</span>
      </div>`;
    if (!d.found) {
      body = head(`<span class="bb-chip bb-chip--warn">${esc(d.error || 'ticket no encontrado')}</span>`);
    } else {
      const verdict = d.resolved
        ? `<div class="bb-desk-verdict bb-desk-verdict--ok">🟢 Ticket confirmado (${d.closed ? 'cerrado/resuelto' : 'el cliente respondió'}) — este fix está <b>completo</b>. Podés archivarlo.</div>`
        : `<div class="bb-desk-verdict bb-desk-verdict--wait">🟡 Ticket sin confirmar todavía${d.status ? ` (${esc(d.status)})` : ''} — solución parcial hasta que el cliente responda o se cierre.</div>`;
      body = `
        ${head(d.status ? `<span class="bb-chip bb-chip--${d.resolved ? 'ok' : 'info'}" title="Estado actual del ticket en Desk">${esc(d.status)}</span>` : '')}
        ${verdict}
        ${d.subject ? `<div class="bb-desk-subj">${esc(d.subject)}</div>` : ''}
        ${(d.comments || []).length ? `<div class="bb-live-fb">${d.comments.map((c) => `
          <div class="bb-fb">
            <span class="bb-fb-head"><b>${esc(c.author)}</b> · <span class="bb-vis bb-vis--${c.visibility}">${c.visibility === 'private' ? 'interno' : 'público'}</span>${c.at ? ` · ${esc(c.at)}` : ''}</span>
            ${c.excerpt ? `<span class="bb-fb-body">${esc(c.excerpt)}</span>` : ''}
          </div>`).join('')}</div>`
      : '<div class="bb-live-fb bb-live-empty">El ticket no tiene comentarios visibles.</div>'}`;
    }
  }
  return `<div class="bb-desk" data-desktkt="${esc(ticket)}">${body}</div>`;
}

// ===== Detalle de una fila del motor =====
function detailHtml(b, state) {
  const key = rowKey(b);
  const dis = state.busy[`act:${key}`] ? ' disabled' : '';
  const tl = timelineOf(b);
  const timeline = tl.length
    ? `<div class="bb-tl">${tl.map((e) => `
        <div class="bb-tl-ev">
          <span class="hp-dot hp-dot--${evDot(e)}"></span>
          <span class="bb-tl-date">${fmtDate(e.t)}</span>
          <span class="bb-tl-txt">${esc((EV_LABEL[e.type] || (() => e.type))(e))}</span>
        </div>`).join('')}</div>`
    : '';
  return `
    ${invTopBox(b, state)}
    <div class="bb-chips">${chipsFor(b, state)}</div>
    <p class="hp-bf-summary">${esc(b.summary || '(sin resumen)')}</p>
    ${b.files?.length ? `<p class="hp-bf-files">${b.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
    : '<p class="hp-bf-files hp-bf-files--none">Sin archivos editados (quedó en plan).</p>'}
    ${attemptsHtml(b)}
    ${feedbackHtml(b)}
    ${similarHtml(b)}
    ${timeline}
    ${b.prNumber ? liveBoxHtml(b.prNumber, state) : ''}
    ${b.ticketNumber ? deskSectionHtml(b.ticketNumber, state) : ''}
    <p class="bfm-links">
      ${b.ticketUrl ? `<a href="${esc(b.ticketUrl)}" target="_blank" rel="noopener">Ticket #${esc(b.ticketNumber)} ↗</a>` : ''}
      ${b.prUrl ? `<a href="${esc(b.prUrl)}" target="_blank" rel="noopener">PR ${b.prNumber ? `#${esc(b.prNumber)}` : ''} ↗</a>` : ''}
      ${b.branch ? `<code>${esc(b.branch)}</code>` : ''}
      <button class="btn btn--sm" data-act="work"${dis}>${icon('sparkle', { size: 13 })}<span>Trabajar en esto</span></button>
      ${b.ticketNumber
    ? `<button class="btn-ghost btn--sm" data-act="deskchat"${dis} title="Abre un chat con TODO el contexto para redactar (en inglés) y publicar una respuesta en el ticket de Zoho Desk — vos aprobás la escritura">${icon('edit', { size: 13 })}<span>Responder ticket (chat)</span></button>` : ''}
      ${b.status === 'subido' && b.prState !== 'merged'
    ? `<button class="btn-ghost btn--sm btn--danger" data-act="cancelpr"${dis}>${icon('trash', { size: 13 })}<span>Cancelar PR</span></button>` : ''}
      ${b.archived
    ? `<button class="btn-ghost btn--sm" data-act="unarchive"${dis} title="Devolver a la lista activa">${icon('refresh', { size: 13 })}<span>Restaurar</span></button>`
    : `<button class="${resolutionOf(b) === 'complete' ? 'btn' : 'btn-ghost'} btn--sm" data-act="archive"${dis} title="Mover al Archivo (no toca código ni PRs). Sugerido cuando el ticket ya está confirmado">${icon('check', { size: 13 })}<span>Archivar</span></button>`}
      <button class="btn-ghost btn--sm" data-act="del"${dis} title="Borra SOLO el registro local (no toca código ni PRs)">${icon('close', { size: 13 })}<span>Descartar registro</span></button>
    </p>`;
}

// Detalle de un PR solo-GitHub (sin registro local): ticket detectado +
// panel de commits/reviews en vivo + estado de Desk + acción de actualizar.
function ghDetailHtml(pr, state) {
  const ticket = ticketOfPr(pr);
  return `
    ${invTopBox({ prNumber: pr.number, ticketNumber: ticket, title: pr.title }, state)}
    <div class="bb-chips">${ticket
  ? `<span class="bb-chip bb-chip--info" title="Ticket detectado del título/branch del PR">🎫 pertenece a TKT #${esc(ticket)}</span>`
  : '<span class="bb-chip bb-chip--warn" title="El título/branch no sigue la convención bugfix/tkt-N">sin ticket detectable</span>'}</div>
    ${pr.branch ? `<p class="hp-bf-files"><code>${esc(pr.branch)}</code></p>` : ''}
    ${liveBoxHtml(pr.number, state)}
    ${ticket ? deskSectionHtml(ticket, state) : ''}
    <p class="bfm-links">
      <a href="${esc(pr.url)}" target="_blank" rel="noopener">Ver PR #${esc(pr.number)} en GitHub ↗</a>
      ${ticket ? `<button class="btn-ghost btn--sm" data-act="ghdeskchat" data-prnum="${pr.number}" title="Abre un chat para redactar y publicar la actualización del ticket en Desk (vos aprobás la escritura)">${icon('edit', { size: 13 })}<span>Actualizar ticket (chat)</span></button>` : ''}
    </p>`;
}

// ===== Render de la tabla (único punto de re-render, con scroll preservado) =====
export function renderTable(state) {
  const { entries, ghRows, triage, expanded, archOpen } = state;
  if (state.loadError) {
    mr.tbody.innerHTML = '<tr><td colspan="8" class="hp-empty">No se pudo leer el registro.</td></tr>';
    return;
  }
  const cubiertos = new Set(entries.map((b) => String(b.ticketNumber)).filter(Boolean));
  const soloTriage = (triage.tickets || []).filter((t) => !cubiertos.has(String(t.ticketNumber)));

  if (!entries.length && !ghRows.length && !soloTriage.length) {
    mr.tbody.innerHTML = '<tr><td colspan="8" class="hp-empty">Sin bugs en triage, fixes registrados ni PRs en GitHub.</td></tr>';
    return;
  }
  const activos = entries.filter((b) => !b.archived);
  const archivados = entries.filter((b) => b.archived);

  // Fila-PR: cuando hay un PR ABIERTO, el PR es el protagonista y el/los TKT
  // que resuelve van anidados debajo. Agrupamos por número de PR abierto;
  // el primer TKT del grupo "posee" la fila, los demás se absorben (no duplican).
  const openPrGroups = new Map(); // prNumber -> [entries]
  for (const b of activos) {
    if (b.prState === 'open' && b.prNumber) {
      const k = String(b.prNumber);
      if (!openPrGroups.has(k)) openPrGroups.set(k, []);
      openPrGroups.get(k).push(b);
    }
  }
  const prRendered = new Set(); // prNumbers ya representados (para saltar secundarios)

  const subTktHtml = (g) => `<span class="bfm-subtkt">↳ 🎫 TKT #${esc(g.ticketNumber || '?')}${g.deskResolved ? ' <span class="bb-chip bb-chip--ok">resuelto</span>' : g.deskReplied ? ' <span class="bb-chip bb-chip--ok">respondido</span>' : ''}</span>`;

  // Una fila de registro (activa o archivada). El chip de resolución
  // (parcial/completo) va en la celda de estado. La expansión sale del store
  // (expanded.has(key)) — el DOM ya no guarda ese estado.
  const rowFor = (b, arch) => {
    const key = rowKey(b);
    const open = expanded.has(key);
    const est = prEstado(b);
    const res = resolutionOf(b);
    const resChip = !arch && RES_CHIP[res] ? ` ${RES_CHIP[res]}` : '';
    // ¿Fila protagonizada por un PR abierto? (no en archivo)
    const isPr = !arch && b.prState === 'open' && b.prNumber;
    const group = isPr ? (openPrGroups.get(String(b.prNumber)) || [b]) : [b];
    const tktCell = isPr ? `<span class="bfm-prnum">🔀 #${esc(b.prNumber)}</span>` : (b.ticketNumber ? `#${esc(b.ticketNumber)}` : '—');
    const titleCell = isPr
      ? `<div class="bfm-prtitle"><b>PR #${esc(b.prNumber)}</b> · ${esc(b.title)}</div><div class="bfm-prtkts">${group.map(subTktHtml).join('')}</div>`
      : esc(b.title);
    return `
      <tr class="bfm-row${isPr ? ' bfm-row--pr' : ''}${arch ? ' bb-arch-row' : ''}" data-key="${esc(key)}" data-sid="${esc(b.sessionId)}"${arch && !archOpen ? ' hidden' : ''}>
        <td><span class="hp-dot hp-dot--${est.dot}"></span></td>
        <td class="bfm-tkt">${tktCell}</td>
        <td class="bfm-title">${titleCell}</td>
        <td>${pipelineHtml(b, state)}</td>
        <td class="bfm-stats">${statsHtml(b.stats)}</td>
        <td class="bb-col-pr">${prCellFor(b, entries, ghRows)}</td>
        <td class="bb-col-desk">${deskCellFor(b)}</td>
        <td class="bfm-state">${estHtml(est)}${resChip}</td>
      </tr>
      <tr class="bfm-detail${arch ? ' bb-arch-row' : ''}" data-key="${esc(key)}"${open ? '' : ' hidden'}><td colspan="8">${detailHtml(b, state)}</td></tr>`;
  };
  // ORDEN DE FILAS (R6 — se decide ACÁ y en ningún otro lado; pisa a propósito
  // el sort del motor): primero lo accionable (pendiente con archivos → 0),
  // pendiente sin archivos → 1, resto → 2, completos al fondo → 3 (ya
  // resueltos, listos para archivar); a igual rank, más reciente primero.
  const rank = (b) => (resolutionOf(b) === 'complete' ? 3
    : b.status === 'pendiente' ? (b.files?.length ? 0 : 1) : 2);
  const orden = [...activos].sort((a, b) => rank(a) - rank(b)
    || (b.sentAt || b.updatedAt || 0) - (a.sentAt || a.updatedAt || 0));
  const rows = [];
  for (const b of orden) {
    // Secundario de un PR abierto ya representado: se absorbió en la fila-PR.
    if (b.prState === 'open' && b.prNumber) {
      const k = String(b.prNumber);
      if (prRendered.has(k)) continue;
      prRendered.add(k);
    }
    rows.push(rowFor(b, false));
  }
  // Tickets del triage SIN trabajo todavía: parte de la misma línea de trabajo.
  for (const t of soloTriage) {
    const key = triageKey(t);
    const open = expanded.has(key);
    rows.push(`
      <tr class="bfm-row bb-row--triage" data-key="${esc(key)}" data-tkt="${esc(t.ticketNumber)}">
        <td><span class="hp-dot hp-dot--warn"></span></td>
        <td class="bfm-tkt">#${esc(t.ticketNumber)}</td>
        <td class="bfm-title">${esc(t.whatBroke)}</td>
        <td>${`<span class="bb-pipe"><span class="bb-seg bb-seg--ok" title="En triage"></span><span class="bb-seg"></span><span class="bb-seg"></span><span class="bb-seg"></span><span class="bb-seg"></span></span>`}</td>
        <td class="bfm-stats"><span class="tk-sev tk-sev-${esc(t.severity)}">${esc(t.severity)}</span></td>
        <td class="bb-col-pr"><span class="bb-icell bb-icell--none" title="Sin PR todavía">—</span></td>
        <td class="bb-col-desk"><span class="bb-icell bb-icell--none" title="Ticket sin responder en Desk">—</span></td>
        <td class="bfm-state">sin trabajo aún</td>
      </tr>
      <tr class="bfm-detail" data-key="${esc(key)}"${open ? '' : ' hidden'}><td colspan="8">
        ${invTopBox({ ticketNumber: t.ticketNumber, title: t.whatBroke, whatBroke: t.whatBroke, route: t.route, reporter: t.reporter, severity: t.severity, context: t.context }, state)}
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
    const key = ghKey(pr);
    const open = expanded.has(key);
    // Pipeline mínimo del PR solo-GitHub: PR (siempre) + merge (si aplica).
    const pipe = `<span class="bb-pipe">
      <span class="bb-seg ${ticket ? 'bb-seg--ok' : ''}" title="${ticket ? `Ticket #${esc(ticket)} (detectado del título/branch)` : 'Sin ticket detectable'}"></span>
      <span class="bb-seg"></span>
      <span class="bb-seg bb-seg--${pr.state === 'closed' ? 'fail' : 'ok'}" title="PR #${pr.number} (${esc(pr.state)})"></span>
      <span class="bb-seg ${pr.state === 'merged' ? 'bb-seg--ok' : ''}" title="${pr.state === 'merged' ? 'Mergeado' : 'Sin merge'}"></span>
      <span class="bb-seg" title="Estado del ticket en Desk: abrí la fila y tocá “Traer estado de Desk”"></span>
    </span>`;
    rows.push(`
      <tr class="bfm-row bfm-row--gh" data-key="${esc(key)}" data-prnum="${pr.number}">
        <td><span class="hp-dot hp-dot--${dot}"></span></td>
        <td class="bfm-tkt" title="${ticket ? `Ticket #${esc(ticket)} detectado del PR` : 'PR en GitHub sin ticket detectable'}">${ticket ? `#${esc(ticket)}` : 'GitHub'}</td>
        <td class="bfm-title">#${esc(pr.number)} ${esc(pr.title)}</td>
        <td>${pipe}</td>
        <td class="bfm-stats">${statsHtml(pr.stats)}</td>
        <td class="bb-col-pr">${prCellFor({ ticketNumber: ticket, prState: pr.state, prNumber: pr.number, status: 'subido' }, entries, ghRows)}</td>
        <td class="bb-col-desk">${deskCellFor({ ticketNumber: ticket })}</td>
        <td class="bfm-state">${pr.state === 'merged' ? `mergeado${pr.mergedBy ? ` por ${esc(pr.mergedBy)}` : ''}` : pr.state === 'closed' ? 'cerrado' : 'abierto'}</td>
      </tr>
      <tr class="bfm-detail" data-key="${esc(key)}"${open ? '' : ' hidden'}><td colspan="8">${ghDetailHtml(pr, state)}</td></tr>`);
  }
  // ===== Sección Archivo · resueltos (colapsable, al fondo) =====
  if (archivados.length) {
    const arch = [...archivados].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    rows.push(`
      <tr class="bb-arch-header${archOpen ? ' open' : ''}" data-arch-toggle="1">
        <td colspan="8">${icon('chevronDown', { size: 13 })} 📦 Archivo · ${arch.length} resuelto/s <span class="bb-arch-hint">(mostrar/ocultar)</span></td>
      </tr>`);
    for (const b of arch) rows.push(rowFor(b, true));
  }
  // Re-render con preservación de scroll (.bb-box es la única región de scroll).
  const st = mr.box ? mr.box.scrollTop : 0;
  const sl = mr.box ? mr.box.scrollLeft : 0;
  mr.tbody.innerHTML = rows.join('');
  if (mr.box) { mr.box.scrollTop = st; mr.box.scrollLeft = sl; }
}

export function render(state) {
  renderHeader(state);
  renderTable(state);
}

// Contenido del modal "Cómo leer este tablero" (lo abre index.js).
export function helpHtml() {
  return `
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
        <b>Estado del fix</b> <span class="bb-help-dim">(punto a la izquierda + última columna)</span>
        <ul class="bb-help-list">
          <li><span class="hp-dot hp-dot--warn"></span> ${icon('upload', { size: 12 })} <b>tu acción</b> — falta que <i>vos</i> envíes el PR o subas cambios locales</li>
          <li><span class="hp-dot hp-dot--info"></span> ${icon('clock', { size: 12 })} <b>en revisión</b> — el PR ya está en GitHub, espera el merge de <i>Chris</i>. No es error ni te falta nada</li>
          <li><span class="hp-dot hp-dot--ok"></span> ${icon('check', { size: 12 })} <b>mergeado</b> — Chris integró el PR</li>
          <li><span class="hp-dot hp-dot--fail"></span> cerrado sin merge</li>
          <li><span class="hp-dot hp-dot--idle"></span> en plan — todavía sin código</li>
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
      <div class="bb-help-sec">
        <b>🔀 Fila-PR</b> — cuando un PR está <b>abierto</b>, el PR pasa a ser el protagonista de la fila y el/los <b>🎫 TKT</b> que resuelve quedan anidados debajo (<i>↳ TKT #N</i>). Al mergearse vuelve a ser fila-TKT.
      </div>
      <div class="bb-help-sec">
        <b>🔍 Investigar a fondo</b> — al expandir un PR abierto: un semáforo gratis dice de quién es la pelota, y el botón corre una lectura IA de los comentarios de Chris + el diff que te dice si tenés que corregir y qué (persistido; sobrevive reinicios). <span class="bb-help-dim">Consume tokens; por eso es bajo botón.</span>
      </div>
    </div>`;
}
