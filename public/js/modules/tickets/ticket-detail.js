// modules/tickets/ticket-detail.js — ventana de DETALLE de un ticket (One Front
// Door). Trae todo lo que el MCP expone (propiedades, personas, tiempos,
// descripción) desde el snapshot (GET /api/tickets/ticket/:num, sin IA) y ofrece
// 3 acciones: continuar en el chat, verificar en GitHub (si aplica), Zoho Desk.
//
// PENDIENTE (decidido con Niko 2026-07-07): las CONVERSACIONES y el HISTORIAL de
// actividad NO los expone el MCP actual (no hay tool de threads/history). Por
// ahora se ven en Zoho (botón). Futuro: agregar desk_get_threads/history al MCP
// de Tolkien (requiere ticket/TASK + OK de Chris). Ver plan en pool of documents.
import { openModal, confirmDialog } from '../../ui/dialog.js';
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';
import { metaSideHtml, wireMetaPanel, metaPromptBlocks, fetchWorkflowContexts, workflowContextBlocks } from './meta-panel.js';
import { t } from '../../ui/i18n.js';

const LANE_LABEL = {
  bug: '🐞 bug', feature: '💡 feature', hardware: '🖥 hardware', access: '🔑 access',
  platform: '⚙️ platform', onboarding: '🌱 onboarding', other: '· other',
};
const WAIT_LABEL = { dev: 'dev', requester: t('tickets.ticket.waitRequester', 'solicitante'), triage: t('tickets.ticket.waitTriage', 'triage/decisión') };
const TOLKIEN_REPO = 'Mordor-Staffing/tolkien';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(11, 16);
}
function fmtAgo(ms) {
  if (!Number.isFinite(ms) || !ms) return null;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return t('tickets.common.justNow', 'recién');
  if (s < 3600) return t('tickets.common.agoMin', 'hace {n} min', { n: Math.floor(s / 60) });
  return t('tickets.common.agoHours', 'hace {n} h', { n: Math.floor(s / 3600) });
}
function field(label, value) {
  if (value == null || value === '') return '';
  return `<div class="bv2-field"><span class="bv2-field-k">${esc(label)}</span><span class="bv2-field-v">${esc(value)}</span></div>`;
}
function stripHtml(s) {
  return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}
// Contexto para el chat, generado desde la MISMA estructura que renderiza la
// tarjeta (`sections` + descripción). Regla: lo que se ve, se exporta. Si se
// agrega un campo a `sections`, aparece en la tarjeta Y en el contexto — sin
// tener que acordarse de tocar dos lados.
function buildContext(t, sections, desc, meta, contexts) {
  const lines = [`Trabajemos el ticket de Zoho Desk #${t.ticketNumber} — ${t.subject || ''}`, ''];
  for (const [title, fields] of sections) {
    const present = fields.filter(([, v]) => v != null && v !== '' && v !== '—');
    if (!present.length) continue;
    lines.push(`== ${title} ==`);
    for (const [k, v] of present) lines.push(`${k}: ${v}`);
    lines.push('');
  }
  if (desc) lines.push('== Descripción ==', stripHtml(desc), '');
  // Contexto adicional (charla interpretada) + Histórico del trabajo de sesiones
  // previas — para continuar con TODO el contexto acumulado (pedido de Niko).
  lines.push(...metaPromptBlocks(meta));
  if (t.webUrl) lines.push(`Ticket: ${t.webUrl}`, '');
  lines.push('Entendé el pedido y proponé un plan antes de tocar nada.');
  // Contextos de trabajo editables (Sistema → Proyectos → "Tickets & Features"):
  // CÓMO se trabaja un ticket (Pensamiento Profundo, triage, gate de push) + CÓMO
  // se redacta el PR. Van AL FINAL para que gobiernen el resto del prompt.
  lines.push(...workflowContextBlocks(contexts));
  return lines.join('\n');
}

export function openTicketDetail(ticket, deps = {}) {
  const modal = openModal({ title: `#${ticket.ticketNumber} · ${(ticket.subject || '').slice(0, 44)}`, width: 'min(980px, 95vw)' });
  const c = modal.body;
  c.innerHTML = `<div class="bv2-detail"><div class="bf-sub" style="padding:.6rem">${pacman({ size: 'sm' })} ${t('tickets.ticket.loading', 'cargando detalle del ticket…')}</div></div>`;
  const box = c.querySelector('.bv2-detail');
  const isDev = ticket.lane === 'bug' || ticket.lane === 'feature';

  function render(f) {
    const cf = f.customFields || {};
    const client = cf["Mordor's Client"] || cf.cf_mordor_s_client || null;
    const related = cf['Related to'] || cf.cf_related_to || null;
    const country = cf.Country || cf.cf_country || null;
    const ttype = cf['Ticket Type'] || cf.cf_ticket_type || null;
    const product = cf.Product || cf.cf_product || null;
    const desc = f.raw?.description || '';
    // Reloj derivado (Zoho no tiene SLA: dueDate suele venir null).
    const bh = f.clock?.businessHoursSinceUpdate ?? 0;
    const target = f.clock?.target ?? 48;
    const dueText = f.statusType === 'Closed' ? t('tickets.ticket.resolved', 'resuelto') : (f.clock?.overdue ? t('tickets.ticket.overdueBy', '⚠️ vencido hace {n}h háb', { n: bh - target }) : t('tickets.ticket.dueIn', 'en {n}h háb', { n: Math.max(0, target - bh) }));
    const ownerStr = f.ownerName ? `${f.ownerName}${f.ownerEmail ? ` · ${f.ownerEmail}` : ''}` : (f.assigneeId ? t('tickets.ticket.unresolved', 'sin resolver') : t('tickets.ticket.unassigned', 'sin asignar'));
    const reporterStr = f.contactName ? `${f.contactName}${f.contactEmail ? ` · ${f.contactEmail}` : ''}` : (f.contactEmail || '—');

    // Estado del lock (hard lock por usuario). `workingBy`/`you` vienen del backend.
    const w = f.workingBy || null;
    const you = f.you || null;
    const youAdmin = !!f.youAdmin;
    const mine = !!(w && you && w.by === you);
    const lockedByOther = !!(w && (!you || w.by !== you));
    const lockBanner = w
      ? `<div class="bv2-lockbar ${mine ? 'bv2-lockbar--mine' : 'bv2-lockbar--other'}">
          ${icon(mine ? 'check' : 'clock', { size: 13 })}
          <span>${mine ? t('tickets.ticket.workingByYou', 'Lo estás trabajando vos') : t('tickets.ticket.inUseBy', '🔒 En uso por <b>{name}</b>', { name: esc(w.label || w.by) })}${w.at ? t('tickets.ticket.sinceTime', ' · desde las {time}', { time: fmtClock(w.at) }) : ''}</span>
          ${lockedByOther ? `<span class="bv2-lockbar-hint">${t('tickets.ticket.lockedHint', 'no podés trabajarlo hasta que lo suelte')}</span>` : ''}
        </div>`
      : '';
    // Botones de claim según el estado. Locked-by-other: "Robar" (con confirmación,
    // cualquier usuario) + "Forzar liberación" solo admin.
    const claimActs = mine
      ? `<button class="btn-ghost btn--sm" data-act="release">${icon('close', { size: 13 })}<span>${t('tickets.ticket.release', 'Soltar')}</span></button>`
      : lockedByOther
        ? `<button class="btn-ghost btn--sm bv2-danger" data-act="steal">${icon('play', { size: 13 })}<span>${t('tickets.common.steal', 'Robar')}</span></button>${youAdmin ? `<button class="btn-ghost btn--sm bv2-danger" data-act="force">${icon('close', { size: 13 })}<span>${t('tickets.common.forceRelease', 'Forzar liberación')}</span></button>` : ''}`
        : `<button class="btn-ghost btn--sm" data-act="claim">${icon('play', { size: 13 })}<span>${t('tickets.common.claim', 'Tomar')}</span></button>`;

    // FUENTE ÚNICA: estas secciones alimentan TANTO la tarjeta (render) COMO el
    // contexto que se exporta al chat. Agregar un [label, value] acá lo hace
    // aparecer en los dos lados automáticamente (pedido de Niko: auto-extensible).
    const sections = [
      [t('tickets.ticket.field.properties', 'Propiedades'), [
        [t('tickets.ticket.field.lane', 'Carril'), LANE_LABEL[ticket.lane] || ticket.lane],
        [t('tickets.ticket.field.status', 'Estado'), f.status], [t('tickets.ticket.field.priority', 'Prioridad'), f.priority_norm || f.priority],
        [t('tickets.ticket.field.waitingOn', 'Esperando a'), ticket.waitingOn ? (WAIT_LABEL[ticket.waitingOn] || ticket.waitingOn) : null],
        [t('tickets.ticket.field.country', 'País'), country], [t('tickets.ticket.field.type', 'Tipo'), ttype], [t('tickets.ticket.field.relatedTo', 'Relacionado a'), related],
        [t('tickets.ticket.field.client', 'Cliente'), client], [t('tickets.ticket.field.product', 'Producto'), product], [t('tickets.ticket.field.channel', 'Canal'), f.channel],
      ]],
      [t('tickets.ticket.field.people', 'Personas'), [[t('tickets.ticket.field.owner', 'Propietario'), ownerStr], ['Reporter', reporterStr]]],
      [t('tickets.ticket.field.times', 'Tiempos'), [
        [t('tickets.ticket.field.created', 'Creado'), fmtDate(f.createdTime)], [t('tickets.ticket.field.lastUpdate', 'Últ. update'), fmtDate(f.modifiedTime)],
        [t('tickets.ticket.field.due', 'Vence (48h háb)'), dueText],
        [t('tickets.ticket.field.noUpdate', 'Sin update'), (f.aging?.days ?? ticket.agingDays) != null ? `${f.aging?.days ?? ticket.agingDays}d` : null],
        [t('tickets.ticket.field.onHoldSince', 'On hold desde'), f.onholdTime ? fmtDate(f.onholdTime) : null],
        [t('tickets.ticket.field.closed', 'Cerrado'), f.closedTime ? fmtDate(f.closedTime) : null],
      ]],
    ];
    const sectionsHtml = sections.map(([title, fields]) => {
      const rows = fields.map(([k, v]) => field(k, v)).join('');
      return rows ? `<div class="bv2-sec-h">${esc(title)}</div><div class="bv2-fields">${rows}</div>` : '';
    }).join('');

    // Barra de FRESCURA (Fix 2 uniformidad, 2026-07-10): de dónde salió el dato
    // (snapshot / base de resueltos / Zoho en vivo) + hace cuánto + botón ↻ para
    // forzar relectura. Uniforme con el "actualizado hace X" del dashboard.
    const ago = fmtAgo(f.generatedAt);
    const srcLabel = f.fromResolved ? t('tickets.ticket.srcResolved', 'base de resueltos') : (f.cached ? 'snapshot' : t('tickets.ticket.srcLive', 'Zoho en vivo'));
    const freshBar = `<div class="bv2-freshbar">
      <span class="bf-sub">${icon('clock', { size: 11 })} ${ago ? t('tickets.common.updatedAgo', 'actualizado {ago}', { ago }) : t('tickets.common.liveRead', 'lectura en vivo')} · ${esc(srcLabel)}</span>
      <button class="btn-ghost btn--sm btn--icon" data-act="refresh" title="${t('tickets.ticket.refreshTitle', 'Actualizar detalle')}">${icon('refresh', { size: 13 })}</button>
    </div>`;

    box.innerHTML = `
      ${freshBar}
      ${lockBanner}
      <div class="bv2-pr-cols">
        <div class="bv2-pr-main">
          <div class="bv2-detail-meta">
            <span class="bb-chip">${esc(LANE_LABEL[ticket.lane] || ticket.lane)}</span>
            <span class="bb-chip">${esc(f.status || ticket.status || '')}</span>
            ${ticket.waitingOn ? `<span class="bb-chip bb-chip--info">${t('tickets.ticket.waitChip', 'espera: {v}', { v: esc(WAIT_LABEL[ticket.waitingOn] || ticket.waitingOn) })}</span>` : ''}
            ${f.priority_norm ? `<span class="bb-chip">${esc(f.priority_norm)}</span>` : ''}
            ${(f.aging?.days ?? ticket.agingDays) != null ? `<span class="bb-chip ${ticket.overdue ? 'bb-chip--danger' : 'bb-chip--warn'}">${t('tickets.ticket.daysNoUpdate', '{n}d sin update', { n: f.aging?.days ?? ticket.agingDays })}</span>` : ''}
          </div>
          ${sectionsHtml}
          <div class="bv2-sec-h">${t('tickets.ticket.description', 'Descripción')}</div>
          <div class="bv2-detail-desc">${desc || `<span class="bf-sub">${t('tickets.ticket.noDescription', '(sin descripción)')}</span>`}</div>
          <div class="bv2-note">${icon('help', { size: 11 })} ${t('tickets.ticket.convNote', 'Las conversaciones e historial de actividad se ven en Zoho Desk (el MCP aún no los expone — pendiente).')}</div>
          <div class="bv2-detail-acts">
            ${claimActs}
            <button class="btn-ghost btn--sm" data-act="chat"${lockedByOther ? ` disabled title="${t('tickets.common.inUseByOther', 'En uso por otro usuario')}"` : ''}>${icon('play', { size: 13 })}<span>${t('tickets.ticket.continueChat', 'Continuar en el chat')}</span></button>
            ${isDev ? `<button class="btn-ghost btn--sm" data-act="gh">${icon('gitBranch', { size: 13 })}<span>${t('tickets.ticket.verifyGithub', 'Verificar en GitHub')}</span></button>` : ''}
            <button class="btn-ghost btn--sm" data-act="zoho">${icon('upload', { size: 13 })}<span>${t('tickets.ticket.zohoConv', 'Conversaciones en Zoho Desk')}</span></button>
          </div>
        </div>
        <aside class="bv2-pr-side">${metaSideHtml(f.meta)}</aside>
      </div>`;
    // 2ª columna: Contexto adicional + Histórico del trabajo (panel compartido).
    wireMetaPanel({ box, key: ticket.ticketNumber, itemTitle: ticket.subject || '', itemDesc: stripHtml(desc || ''), onChanged: reload });

    // POST a /claim o /release. Devuelve el JSON; no re-renderiza (lo hace el caller).
    async function apiClaim(action, force) {
      try {
        const res = await fetch(`/api/tickets/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: ticket.ticketNumber, ...(force ? { force: true } : {}) }),
        });
        return await res.json().catch(() => ({}));
      } catch { return {}; }
    }
    const postClaim = async (action, force) => { await apiClaim(action, force); reload(); };
    box.querySelector('[data-act="refresh"]')?.addEventListener('click', reload);
    box.querySelector('[data-act="claim"]')?.addEventListener('click', () => postClaim('claim'));
    box.querySelector('[data-act="release"]')?.addEventListener('click', () => postClaim('release'));
    box.querySelector('[data-act="force"]')?.addEventListener('click', () => postClaim('release', true));
    box.querySelector('[data-act="steal"]')?.addEventListener('click', async () => {
      const okConfirm = await confirmDialog({
        title: t('tickets.ticket.stealTitle', 'Robar el ticket'),
        message: t('tickets.ticket.stealMsg', 'Este ticket lo está trabajando {name}. ¿Tomarlo igual? Va a perder el lock y pasás a ser vos quien lo trabaja.', { name: w?.label || w?.by }),
        confirmLabel: t('tickets.common.steal', 'Robar'), danger: true,
      });
      if (okConfirm) postClaim('claim', true);
    });

    box.querySelector('[data-act="chat"]')?.addEventListener('click', async () => {
      if (lockedByOther) return; // no se trabaja lo de otro (hay que robar primero)
      if (!mine) await apiClaim('claim'); // auto-tomar al empezar a trabajarlo (si estaba libre)
      const contexts = await fetchWorkflowContexts(); // work + pr editables (Proyectos)
      await deps.openChat?.({
        cwd: deps.projectRel ? deps.projectRel() : 'tolkien',
        mode: 'plan',
        prompt: buildContext(f, sections, desc, f.meta, contexts), // `f` (recargado): trae ticketNumber/subject/webUrl aun si se abrió por buscador
        title: `TKT #${ticket.ticketNumber} — ${(ticket.subject || '').slice(0, 40)}`.slice(0, 60),
        ticket: { number: ticket.ticketNumber, url: ticket.webUrl || null },
      });
      modal.close();
    });
    box.querySelector('[data-act="gh"]')?.addEventListener('click', () =>
      window.open(`https://github.com/${TOLKIEN_REPO}/pulls?q=${encodeURIComponent(`is:pr ${ticket.ticketNumber}`)}`, '_blank', 'noopener'));
    box.querySelector('[data-act="zoho"]')?.addEventListener('click', () => {
      // Leer del objeto RECARGADO `f` (siempre trae webUrl: snapshot / store de
      // resueltos / Zoho vivo), NO del `t` exterior — que al abrir un ticket
      // cerrado por el buscador es solo { ticketNumber } sin URL (bug 2026-07-14).
      const url = f.webUrl || ticket.webUrl;
      if (url) window.open(url, '_blank', 'noopener');
    });
  }

  async function reload() {
    let full = ticket;
    try {
      const res = await fetch(`/api/tickets/ticket/${encodeURIComponent(ticket.ticketNumber)}`);
      const d = await res.json();
      if (d && d.found) full = { ...ticket, ...d };
      if (d) { full = { ...full, workingBy: d.workingBy ?? null, you: d.you ?? null, youAdmin: d.youAdmin ?? false }; }
    } catch { /* si falla, renderizamos con lo del dashboard */ }
    render(full);
  }
  reload();

  return modal;
}
