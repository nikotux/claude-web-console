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
};
const EV_DOT = {
  creado: 'warn', trabajo_nuevo: 'warn', pr_creado: 'ok', pr_actualizado: 'ok',
  pr_mergeado: 'ok', pr_cancelado: 'fail',
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
      <button class="btn-ghost btn--sm" data-ref="ghsync" title="Refresca desde GitHub el estado de los PRs">${icon('refresh', { size: 13 })}<span>GitHub</span></button>
      <button class="btn-ghost btn--sm btn--icon" data-ref="help" title="¿Cómo leer este tablero? (pipeline, chips, estados)">${icon('help', { size: 15 })}</button>
      <span class="bb-state" data-ref="ghstate"></span>
      <span class="bb-triage" data-ref="triage"></span>
    </div>
    <div class="bb-box">
      <table class="bfm-table bb-table">
        <thead><tr><th></th><th>TKT</th><th>Título</th><th>Pipeline</th><th>Cambios</th><th>Estado</th></tr></thead>
        <tbody data-ref="tbody"><tr><td colspan="6"><span class="cwc-spinner"></span></td></tr></tbody>
      </table>
    </div>`;
  m.body.appendChild(wrap);
  const mr = {};
  for (const r of wrap.querySelectorAll('[data-ref]')) mr[r.dataset.ref] = r;

  let entries = [];   // registro de bugfixes
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

  // Pipeline visual: etapas del ciclo con estado.
  function pipelineHtml(b) {
    const tk = b.ticketNumber ? triageByNum().get(String(b.ticketNumber)) : null;
    const tl = timelineOf(b);
    const deskOk = [...tl].reverse().find((e) => e.type === 'ticket_actualizado')?.ok;
    const seg = (on, cls, label) => `<span class="bb-seg ${on ? `bb-seg--${cls}` : ''}" title="${esc(label)}"></span>`;
    return `<span class="bb-pipe">${[
      seg(!!(tk || b.ticketNumber), 'ok', tk ? 'Triage: ticket abierto en Desk' : 'Ticket referenciado (no está en el triage actual)'),
      seg(!!(b.files?.length), 'ok', b.files?.length ? `Trabajo: ${b.files.length} archivo/s editados` : 'Sin trabajo aún'),
      seg(!!b.prNumber, b.prState === 'closed' ? 'fail' : 'ok', b.prNumber ? `PR #${b.prNumber} (${b.prState || '?'})` : 'Sin PR'),
      seg(b.prState === 'merged', 'ok', b.prState === 'merged' ? `Mergeado por ${b.mergedBy || '?'}` : 'Sin merge'),
      seg(deskOk === true, deskOk === false ? 'fail' : 'ok', deskOk == null ? 'Ticket sin actualizar en Desk' : deskOk ? 'Ticket actualizado en Desk' : 'Actualización de ticket FALLÓ'),
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

  function statsHtml(s) {
    if (!s) return '<span class="bfm-nostats">—</span>';
    return `<span class="bfm-add">+${s.add}</span> <span class="bfm-del">−${s.del}</span>` +
      `<span class="bfm-nfiles"> · ${s.files}a</span>`;
  }

  // ===== Detalle expandible =====
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
      ${timeline}
      ${b.prNumber ? `<div class="bb-live" data-live="${b.prNumber}"><div class="cwc-loading">${pacman()}consultando GitHub en vivo…</div></div>` : ''}
      ${b.ticketNumber ? deskSectionHtml(b.ticketNumber) : ''}
      <p class="bfm-links">
        ${b.ticketUrl ? `<a href="${esc(b.ticketUrl)}" target="_blank" rel="noopener">Ticket #${esc(b.ticketNumber)} ↗</a>` : ''}
        ${b.prUrl ? `<a href="${esc(b.prUrl)}" target="_blank" rel="noopener">PR ${b.prNumber ? `#${esc(b.prNumber)}` : ''} ↗</a>` : ''}
        ${b.branch ? `<code>${esc(b.branch)}</code>` : ''}
        <button class="btn btn--sm" data-act="work">${icon('sparkle', { size: 13 })}<span>Trabajar en esto</span></button>
        ${b.prNumber && b.ticketNumber
      ? `<button class="btn-ghost btn--sm" data-act="deskchat" title="Abre un chat con TODO el contexto para redactar (en inglés) y publicar la actualización del ticket en Desk — vos aprobás la escritura">${icon('edit', { size: 13 })}<span>Actualizar ticket (chat)</span></button>` : ''}
        ${b.status === 'subido' && b.prState !== 'merged'
      ? `<button class="btn-ghost btn--sm btn--danger" data-act="cancelpr">${icon('trash', { size: 13 })}<span>Cancelar PR</span></button>` : ''}
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
      box.innerHTML = `
        ${head(d.status ? `<span class="bb-chip bb-chip--info" title="Estado actual del ticket en Desk">${esc(d.status)}</span>` : '')}
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
      mr.tbody.innerHTML = '<tr><td colspan="6" class="hp-empty">Sin bugs en triage, fixes registrados ni PRs en GitHub.</td></tr>';
      return;
    }
    const rank = (b) => (b.status === 'pendiente' ? (b.files?.length ? 0 : 1) : 2);
    const orden = [...entries].sort((a, b) => rank(a) - rank(b)
      || (b.sentAt || b.updatedAt || 0) - (a.sentAt || a.updatedAt || 0));
    const rows = [];
    for (const b of orden) {
      const est = prEstado(b);
      rows.push(`
        <tr class="bfm-row" data-sid="${esc(b.sessionId)}">
          <td><span class="hp-dot hp-dot--${est.dot}"></span></td>
          <td class="bfm-tkt">${b.ticketNumber ? `#${esc(b.ticketNumber)}` : '—'}</td>
          <td class="bfm-title">${esc(b.title)}</td>
          <td>${pipelineHtml(b)}</td>
          <td class="bfm-stats">${statsHtml(b.stats)}</td>
          <td class="bfm-state">${esc(est.label)}</td>
        </tr>
        <tr class="bfm-detail" hidden><td colspan="6">${detailHtml(b)}</td></tr>`);
    }
    // Tickets del triage SIN trabajo todavía: parte de la misma línea de trabajo.
    for (const t of soloTriage) {
      rows.push(`
        <tr class="bfm-row bb-row--triage" data-tkt="${esc(t.ticketNumber)}">
          <td><span class="hp-dot hp-dot--warn"></span></td>
          <td class="bfm-tkt">#${esc(t.ticketNumber)}</td>
          <td class="bfm-title">${esc(t.whatBroke)}</td>
          <td>${`<span class="bb-pipe"><span class="bb-seg bb-seg--ok" title="En triage"></span><span class="bb-seg"></span><span class="bb-seg"></span><span class="bb-seg"></span><span class="bb-seg"></span></span>`}</td>
          <td class="bfm-stats"><span class="tk-sev tk-sev-${esc(t.severity)}">${esc(t.severity)}</span></td>
          <td class="bfm-state">sin trabajo aún</td>
        </tr>
        <tr class="bfm-detail" hidden><td colspan="6">
          <p class="hp-bf-summary">${esc(t.whatBroke)}${t.route ? ` · <code>${esc(t.route)}</code>` : ''}${t.reporter ? ` · reportó ${esc(t.reporter)}` : ''}</p>
          ${t.duplicate ? `<p class="bb-chips"><span class="bb-chip bb-chip--warn">👥 dup: ${esc(t.duplicate)}</span></p>` : ''}
          ${t.context ? `<p class="hp-bf-summary">${esc(t.context)}</p>` : ''}
          <p class="bfm-links">
            ${t.webUrl ? `<a href="${esc(t.webUrl)}" target="_blank" rel="noopener">Ticket #${esc(t.ticketNumber)} ↗</a>` : ''}
            <button class="btn btn--sm" data-act="triagework" data-tkt="${esc(t.ticketNumber)}">${icon('sparkle', { size: 13 })}<span>Trabajar en Chat (plan)</span></button>
          </p>
        </td></tr>`);
    }
    for (const pr of ghRows) {
      const dot = pr.state === 'merged' ? 'ok' : pr.state === 'closed' ? 'fail' : 'warn';
      const ticket = ticketOfPr(pr);
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
          <td class="bfm-state">${pr.state === 'merged' ? `mergeado${pr.mergedBy ? ` por ${esc(pr.mergedBy)}` : ''}` : pr.state === 'closed' ? 'cerrado' : 'abierto'}</td>
        </tr>
        <tr class="bfm-detail" hidden><td colspan="6">${ghDetailHtml(pr)}</td></tr>`);
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
    const prompt = [
      `Actualicemos el ticket de Zoho Desk #${b.ticketNumber} con las novedades del PR #${b.prNumber}.`,
      b.ticketUrl ? `Ticket: ${b.ticketUrl}` : '',
      `PR: ${b.prUrl}`,
      '',
      `HISTORIAL del fix:\n${historyText(b) || '(sin eventos)'}`,
      b.summary ? `\nResumen del fix:\n${b.summary.slice(0, 1200)}` : '',
      '',
      'Proceso (en este orden):',
      `1. Mirá el estado real y el feedback del PR: gh pr view ${b.prNumber} --comments`,
      '2. Verificá el ticket en Desk con las tools desk_* del MCP.',
      '3. Redactá una actualización EN INGLÉS, corta y humana (2-4 frases) con lo que cambió desde la última nota (qué se corrigió/mejoró y que el despliegue sigue en curso). MOSTRÁMELA y esperá mi OK.',
      '4. Recién con mi OK, publicala en el ticket (visible al solicitante si se puede) y ajustá el estado si corresponde.',
      'NO toques código ni envíes PRs desde este chat.',
    ].filter(Boolean).join('\n');
    await openChat({
      cwd: projectRel(), mode: 'default', prompt,
      title: `Ticket #${b.ticketNumber} · update`.slice(0, 60),
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

  async function doDiscard(b, btn) {
    const ok = await dialog.confirmDialog({
      title: `Descartar registro — TKT #${b.ticketNumber || '?'}`,
      message: 'Se borra SOLO el registro local del fix (no toca código, branches ni PRs en GitHub).',
      confirmLabel: 'Descartar', danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/bugfixes/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo descartar el registro.');
    } catch (err) {
      await dialog.alertDialog({ title: 'Descartar registro', message: err.message });
    } finally { await reload(); }
  }

  async function reload() {
    try {
      const [bf, tk] = await Promise.all([
        fetch('/api/bugfixes').then((r) => r.json()),
        fetch('/api/bugs').then((r) => r.json()).catch(() => triage),
      ]);
      entries = bf.bugfixes || [];
      triage = tk || triage;
      renderTable();
    } catch {
      mr.tbody.innerHTML = '<tr><td colspan="6" class="hp-empty">No se pudo leer el registro.</td></tr>';
    }
  }

  async function ghSync(silent) {
    mr.ghsync.disabled = true;
    mr.ghstate.innerHTML = `${pacman()} GitHub…`;
    try {
      const res = await fetch('/api/bugfixes/refresh-prs', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falló la consulta a GitHub.');
      entries = data.bugfixes || entries;
      ghRows = data.github || [];
      renderTable();
      mr.ghstate.textContent = `GitHub · ${fmtDate(Date.now())}`;
      if (data.errors?.length && !silent) {
        await dialog.alertDialog({ title: 'GitHub', message: `Algunos PRs no se pudieron consultar:\n${data.errors.join('\n')}` });
      }
    } catch (err) {
      mr.ghstate.textContent = 'GitHub no disponible';
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
      entries = data.bugfixes || [];
      renderTable();
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
            <li>📩 <b>Ticket</b> — se actualizó el ticket en Zoho Desk</li>
          </ol>
          <p class="bb-help-dim">Color de cada barra: <span class="bb-help-c bb-help-c--ok">verde</span> hecho · <span class="bb-help-c bb-help-c--fail">rojo</span> falló/cerrado · <span class="bb-help-c">gris</span> pendiente.</p>
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

  // Al abrir: registro + triage al instante; GitHub completa enseguida.
  reload().then(() => ghSync(true));
  return m;
}
