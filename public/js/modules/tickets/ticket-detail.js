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
import { metaSideHtml, wireMetaPanel, metaPromptBlocks, fetchWorkflowContexts, workflowContextBlocks } from './meta-panel.js';

const LANE_LABEL = {
  bug: '🐞 bug', feature: '💡 feature', hardware: '🖥 hardware', access: '🔑 access',
  platform: '⚙️ platform', onboarding: '🌱 onboarding', other: '· other',
};
const WAIT_LABEL = { dev: 'dev', requester: 'solicitante', triage: 'triage/decisión' };
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

export function openTicketDetail(t, deps = {}) {
  const modal = openModal({ title: `#${t.ticketNumber} · ${(t.subject || '').slice(0, 44)}`, width: 'min(980px, 95vw)' });
  const c = modal.body;
  c.innerHTML = `<div class="bv2-detail"><div class="bf-sub" style="padding:.6rem">${icon('clock', { size: 12 })} cargando detalle del ticket…</div></div>`;
  const box = c.querySelector('.bv2-detail');
  const isDev = t.lane === 'bug' || t.lane === 'feature';

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
    const dueText = f.statusType === 'Closed' ? 'resuelto' : (f.clock?.overdue ? `⚠️ vencido hace ${bh - target}h háb` : `en ${Math.max(0, target - bh)}h háb`);
    const ownerStr = f.ownerName ? `${f.ownerName}${f.ownerEmail ? ` · ${f.ownerEmail}` : ''}` : (f.assigneeId ? 'sin resolver' : 'sin asignar');
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
          <span>${mine ? 'Lo estás trabajando vos' : `🔒 En uso por <b>${esc(w.label || w.by)}</b>`}${w.at ? ` · desde las ${fmtClock(w.at)}` : ''}</span>
          ${lockedByOther ? '<span class="bv2-lockbar-hint">no podés trabajarlo hasta que lo suelte</span>' : ''}
        </div>`
      : '';
    // Botones de claim según el estado. Locked-by-other: "Robar" (con confirmación,
    // cualquier usuario) + "Forzar liberación" solo admin.
    const claimActs = mine
      ? `<button class="btn-ghost btn--sm" data-act="release">${icon('close', { size: 13 })}<span>Soltar</span></button>`
      : lockedByOther
        ? `<button class="btn-ghost btn--sm bv2-danger" data-act="steal">${icon('play', { size: 13 })}<span>Robar</span></button>${youAdmin ? `<button class="btn-ghost btn--sm bv2-danger" data-act="force">${icon('close', { size: 13 })}<span>Forzar liberación</span></button>` : ''}`
        : `<button class="btn-ghost btn--sm" data-act="claim">${icon('play', { size: 13 })}<span>Tomar</span></button>`;

    // FUENTE ÚNICA: estas secciones alimentan TANTO la tarjeta (render) COMO el
    // contexto que se exporta al chat. Agregar un [label, value] acá lo hace
    // aparecer en los dos lados automáticamente (pedido de Niko: auto-extensible).
    const sections = [
      ['Propiedades', [
        ['Carril', LANE_LABEL[t.lane] || t.lane],
        ['Estado', f.status], ['Prioridad', f.priority_norm || f.priority],
        ['Esperando a', t.waitingOn ? (WAIT_LABEL[t.waitingOn] || t.waitingOn) : null],
        ['País', country], ['Tipo', ttype], ['Relacionado a', related],
        ['Cliente', client], ['Producto', product], ['Canal', f.channel],
      ]],
      ['Personas', [['Propietario', ownerStr], ['Reporter', reporterStr]]],
      ['Tiempos', [
        ['Creado', fmtDate(f.createdTime)], ['Últ. update', fmtDate(f.modifiedTime)],
        ['Vence (48h háb)', dueText],
        ['Sin update', (f.aging?.days ?? t.agingDays) != null ? `${f.aging?.days ?? t.agingDays}d` : null],
        ['On hold desde', f.onholdTime ? fmtDate(f.onholdTime) : null],
        ['Cerrado', f.closedTime ? fmtDate(f.closedTime) : null],
      ]],
    ];
    const sectionsHtml = sections.map(([title, fields]) => {
      const rows = fields.map(([k, v]) => field(k, v)).join('');
      return rows ? `<div class="bv2-sec-h">${esc(title)}</div><div class="bv2-fields">${rows}</div>` : '';
    }).join('');

    box.innerHTML = `
      ${lockBanner}
      <div class="bv2-pr-cols">
        <div class="bv2-pr-main">
          <div class="bv2-detail-meta">
            <span class="bb-chip">${esc(LANE_LABEL[t.lane] || t.lane)}</span>
            <span class="bb-chip">${esc(f.status || t.status || '')}</span>
            ${t.waitingOn ? `<span class="bb-chip bb-chip--info">espera: ${esc(WAIT_LABEL[t.waitingOn] || t.waitingOn)}</span>` : ''}
            ${f.priority_norm ? `<span class="bb-chip">${esc(f.priority_norm)}</span>` : ''}
            ${(f.aging?.days ?? t.agingDays) != null ? `<span class="bb-chip ${t.overdue ? 'bb-chip--danger' : 'bb-chip--warn'}">${f.aging?.days ?? t.agingDays}d sin update</span>` : ''}
          </div>
          ${sectionsHtml}
          <div class="bv2-sec-h">Descripción</div>
          <div class="bv2-detail-desc">${desc || '<span class="bf-sub">(sin descripción)</span>'}</div>
          <div class="bv2-note">${icon('help', { size: 11 })} Las conversaciones e historial de actividad se ven en Zoho Desk (el MCP aún no los expone — pendiente).</div>
          <div class="bv2-detail-acts">
            ${claimActs}
            <button class="btn-ghost btn--sm" data-act="chat"${lockedByOther ? ' disabled title="En uso por otro usuario"' : ''}>${icon('play', { size: 13 })}<span>Continuar en el chat</span></button>
            ${isDev ? `<button class="btn-ghost btn--sm" data-act="gh">${icon('gitBranch', { size: 13 })}<span>Verificar en GitHub</span></button>` : ''}
            <button class="btn-ghost btn--sm" data-act="zoho">${icon('upload', { size: 13 })}<span>Conversaciones en Zoho Desk</span></button>
          </div>
        </div>
        <aside class="bv2-pr-side">${metaSideHtml(f.meta)}</aside>
      </div>`;
    // 2ª columna: Contexto adicional + Histórico del trabajo (panel compartido).
    wireMetaPanel({ box, key: t.ticketNumber, itemTitle: t.subject || '', itemDesc: stripHtml(desc || ''), onChanged: reload });

    // POST a /claim o /release. Devuelve el JSON; no re-renderiza (lo hace el caller).
    async function apiClaim(action, force) {
      try {
        const res = await fetch(`/api/tickets/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: t.ticketNumber, ...(force ? { force: true } : {}) }),
        });
        return await res.json().catch(() => ({}));
      } catch { return {}; }
    }
    const postClaim = async (action, force) => { await apiClaim(action, force); reload(); };
    box.querySelector('[data-act="claim"]')?.addEventListener('click', () => postClaim('claim'));
    box.querySelector('[data-act="release"]')?.addEventListener('click', () => postClaim('release'));
    box.querySelector('[data-act="force"]')?.addEventListener('click', () => postClaim('release', true));
    box.querySelector('[data-act="steal"]')?.addEventListener('click', async () => {
      const okConfirm = await confirmDialog({
        title: 'Robar el ticket',
        message: `Este ticket lo está trabajando ${w?.label || w?.by}. ¿Tomarlo igual? Va a perder el lock y pasás a ser vos quien lo trabaja.`,
        confirmLabel: 'Robar', danger: true,
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
        prompt: buildContext(t, sections, desc, f.meta, contexts), // sections + meta + contextos de trabajo
        title: `TKT #${t.ticketNumber} — ${(t.subject || '').slice(0, 40)}`.slice(0, 60),
        ticket: { number: t.ticketNumber, url: t.webUrl || null },
      });
      modal.close();
    });
    box.querySelector('[data-act="gh"]')?.addEventListener('click', () =>
      window.open(`https://github.com/${TOLKIEN_REPO}/pulls?q=${encodeURIComponent(`is:pr ${t.ticketNumber}`)}`, '_blank', 'noopener'));
    box.querySelector('[data-act="zoho"]')?.addEventListener('click', () => {
      if (t.webUrl) window.open(t.webUrl, '_blank', 'noopener');
    });
  }

  async function reload() {
    let full = t;
    try {
      const res = await fetch(`/api/tickets/ticket/${encodeURIComponent(t.ticketNumber)}`);
      const d = await res.json();
      if (d && d.found) full = { ...t, ...d };
      if (d) { full = { ...full, workingBy: d.workingBy ?? null, you: d.you ?? null, youAdmin: d.youAdmin ?? false }; }
    } catch { /* si falla, renderizamos con lo del dashboard */ }
    render(full);
  }
  reload();

  return modal;
}
