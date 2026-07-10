// modules/tickets/pr-detail.js — ventana de DETALLE de un PR (dev-lane), gemela
// de ticket-detail. A diferencia de los tickets de Desk, GitHub SÍ expone todo
// vía gh: info + conversaciones (comments + reviews) + checks (CI) + archivos.
// Consume GET /api/tickets/pr/:number. 2 acciones: trabajar en un chat, abrir en GitHub.
import { openModal, confirmDialog } from '../../ui/dialog.js';
import { icon } from '../../ui/icons.js';
import { metaSideHtml, wireMetaPanel, metaPromptBlocks, fetchWorkflowContexts, workflowContextBlocks } from './meta-panel.js';

const TOLKIEN_CWD = 'tolkien';

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(11, 16);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
function fmtAgo(ms) {
  if (!Number.isFinite(ms) || !ms) return null;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  return `hace ${Math.floor(s / 3600)} h`;
}
function ciClass(concl) {
  const c = String(concl || '').toUpperCase();
  if (/SUCCESS|NEUTRAL|SKIPPED/.test(c)) return 'bb-chip--ok';
  if (/FAIL|ERROR|CANCELL|TIMED/.test(c)) return 'bb-chip--danger';
  return 'bb-chip--warn';
}
function reviewClass(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'APPROVED') return 'bb-chip--ok';
  if (s === 'CHANGES_REQUESTED') return 'bb-chip--danger';
  return 'bb-chip--info';
}
function padStatusClass(s) {
  const x = String(s || '').toLowerCase();
  if (/done|hecho|closed|merged|complete/.test(x)) return 'bb-chip--ok';
  if (/progress|doing|review/.test(x)) return 'bb-chip--warn';
  if (/block/.test(x)) return 'bb-chip--danger';
  return 'bb-chip--info';
}
// Contexto para el chat, generado desde los MISMOS datos que renderiza la
// tarjeta (resumen + body + checks + conversaciones + archivos). Lo que se ve,
// se exporta; auto-extensible (pedido de Niko).
function buildPrContext(pr, conv, checks, files, contexts) {
  const lines = [`Revisemos el PR #${pr.number} de Tolkien (Mordor-Staffing/tolkien) — ${pr.title || ''}`, ''];
  lines.push('== Resumen ==');
  lines.push(`Rama: ${pr.headRefName || '?'} → ${pr.baseRefName || 'main'}`);
  lines.push(`Review: ${pr.reviewDecision || 'sin review'} · mergeable: ${pr.mergeable || '?'}${pr.isDraft ? ' · draft' : ''}`);
  lines.push(`Cambios: +${pr.additions ?? 0}/-${pr.deletions ?? 0} en ${pr.changedFiles ?? files.length} archivos`);
  if (pr.url) lines.push(`PR: ${pr.url}`);
  lines.push('');
  if (pr.body) lines.push('== Descripción del PR ==', String(pr.body).trim(), '');
  if (pr.padItems?.length) {
    lines.push('== Pad (items referenciados) ==');
    for (const it of pr.padItems) {
      lines.push(`- ${it.ref}${it.status ? ` [${it.status}]` : ''}: ${it.title}${it.parentRef ? ` (parent: ${it.parentRef})` : ''}`);
      if (it.content) lines.push(`  ${String(it.content).slice(0, 500).replace(/\s+/g, ' ')}`);
    }
    lines.push('');
  }
  if (checks.length) { lines.push('== Checks (CI) =='); for (const k of checks) lines.push(`- ${k.name}: ${String(k.conclusion || k.status || '').toLowerCase()}`); lines.push(''); }
  if (conv.length) { lines.push('== Conversaciones =='); for (const m of conv) lines.push(`- ${m.who}${m.state ? ` [${m.state}]` : ''} (${fmtDate(m.when)}): ${String(m.body || '').slice(0, 600)}`); lines.push(''); }
  if (files.length) { lines.push('== Archivos cambiados =='); for (const fl of files.slice(0, 50)) lines.push(`- ${fl.path} (+${fl.additions ?? 0}/-${fl.deletions ?? 0})`); lines.push(''); }
  // Contexto adicional (charla interpretada) + Histórico del trabajo de sesiones
  // previas sobre este PR (pedido de Niko: continuar con todo el contexto).
  lines.push(...metaPromptBlocks(pr.meta));
  lines.push('Mirá el diff, los comentarios de review y el estado de CI; decime qué falta o qué hay que ajustar.');
  // Contextos de trabajo editables (Sistema → Proyectos → "Tickets & Features"):
  // CÓMO se trabaja + CÓMO se redacta el PR (house style). Al final para que
  // gobiernen el resto del prompt.
  lines.push(...workflowContextBlocks(contexts));
  return lines.join('\n');
}

export function openPrDetail(prLite, deps = {}) {
  const modal = openModal({ title: `PR #${prLite.number} · ${(prLite.title || '').slice(0, 44)}`, width: 'min(980px, 95vw)' });
  const c = modal.body;
  c.innerHTML = `<div class="bv2-detail"><div class="bf-sub" style="padding:.6rem">${icon('clock', { size: 12 })} cargando el PR desde GitHub…</div></div>`;
  const box = c.querySelector('.bv2-detail');

  function render(pr, error, you = null, youAdmin = false, info = {}) {
    if (error || !pr) { box.innerHTML = `<div class="bf-err" style="padding:1rem">${esc(error || 'No se pudo leer el PR.')}</div>`; return; }

    // Lock por usuario (mismo sistema que los tickets, id `pr:<number>`).
    const w = pr.workingBy || null;
    const mine = !!(w && you && w.by === you);
    const lockedByOther = !!(w && (!you || w.by !== you));
    const claimId = `pr:${pr.number}`;
    const lockBanner = w
      ? `<div class="bv2-lockbar ${mine ? 'bv2-lockbar--mine' : 'bv2-lockbar--other'}">
          ${icon(mine ? 'check' : 'clock', { size: 13 })}
          <span>${mine ? 'Lo estás trabajando vos' : `🔒 En uso por <b>${esc(w.label || w.by)}</b>`}${w.at ? ` · desde las ${fmtClock(w.at)}` : ''}</span>
          ${lockedByOther ? '<span class="bv2-lockbar-hint">no podés trabajarlo hasta que lo suelte o lo robes</span>' : ''}
        </div>`
      : '';
    const claimActs = mine
      ? `<button class="btn-ghost btn--sm" data-act="release">${icon('close', { size: 13 })}<span>Soltar</span></button>`
      : lockedByOther
        ? `<button class="btn-ghost btn--sm bv2-danger" data-act="steal">${icon('play', { size: 13 })}<span>Robar</span></button>${youAdmin ? `<button class="btn-ghost btn--sm bv2-danger" data-act="force">${icon('close', { size: 13 })}<span>Forzar liberación</span></button>` : ''}`
        : `<button class="btn-ghost btn--sm" data-act="claim">${icon('play', { size: 13 })}<span>Tomar</span></button>`;

    async function apiClaim(action, force) {
      try {
        const res = await fetch(`/api/tickets/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: claimId, ...(force ? { force: true } : {}) }),
        });
        return await res.json().catch(() => ({}));
      } catch { return {}; }
    }
    const postClaim = async (action, force) => { await apiClaim(action, force); reload(); };

    // Conversaciones = comments + reviews, en orden cronológico.
    const conv = [
      ...(pr.comments || []).map((x) => ({ who: x.author?.login || '?', when: x.createdAt, kind: 'comentario', state: null, body: x.body || '' })),
      ...(pr.reviews || []).map((x) => ({ who: x.author?.login || '?', when: x.submittedAt || x.createdAt, kind: 'review', state: x.state || null, body: x.body || '' })),
    ].filter((x) => x.body || x.state).sort((a, b) => Date.parse(a.when || 0) - Date.parse(b.when || 0));

    const checks = pr.statusCheckRollup || [];
    const files = pr.files || [];

    const padHtml = (pr.padItems || []).length
      ? (pr.padItems || []).map((it) => `<div class="bv2-pad-item">
          <div class="bv2-pad-item-h">
            <span class="bb-chip bb-chip--info">${esc(it.ref)}</span>
            ${it.status ? `<span class="bb-chip ${padStatusClass(it.status)}">${esc(it.status)}</span>` : ''}
            ${it.priority ? `<span class="bb-chip">${esc(it.priority)}</span>` : ''}
          </div>
          <div class="bv2-pad-item-t">${esc(it.title)}</div>
          ${it.parentRef ? `<div class="bf-sub">↳ ${esc(it.parentRef)}${it.parentTitle ? ` · ${esc(it.parentTitle)}` : ''}</div>` : ''}
          ${it.content ? `<div class="bv2-pad-item-c">${esc(it.content).slice(0, 320)}${it.content.length > 320 ? '…' : ''}</div>` : ''}
          ${(it.tags || []).length ? `<div class="bf-sub">${it.tags.map((t) => `#${esc(t)}`).join(' ')}</div>` : ''}
          ${it.updatedAt ? `<div class="bf-sub">act. ${fmtDate(it.updatedAt)}</div>` : ''}
        </div>`).join('')
      : `<div class="bf-sub">${(pr.padRefs || []).length ? `Refs: ${esc((pr.padRefs || []).join(', '))} — ` : ''}${esc(pr.padError || 'sin items de Pad')}</div>`;

    // Barra de FRESCURA (Fix 2 uniformidad, 2026-07-10): fuente + antigüedad + ↻.
    const ago = fmtAgo(info.generatedAt);
    const srcLabel = info.cached ? 'snapshot' : 'GitHub en vivo';
    const freshBar = `<div class="bv2-freshbar">
      <span class="bf-sub">${icon('clock', { size: 11 })} ${ago ? `actualizado ${ago}` : 'lectura en vivo'} · ${esc(srcLabel)}</span>
      <button class="btn-ghost btn--sm btn--icon" data-act="refresh" title="Actualizar PR">${icon('refresh', { size: 13 })}</button>
    </div>`;

    box.innerHTML = `
      ${freshBar}
      ${lockBanner}
      <div class="bv2-pr-cols">
        <div class="bv2-pr-main">
          <div class="bv2-detail-meta">
            <span class="bb-chip ${reviewClass(pr.reviewDecision)}">${esc(pr.reviewDecision || 'sin review')}</span>
            <span class="bb-chip">${esc(pr.headRefName || '')} → ${esc(pr.baseRefName || 'main')}</span>
            <span class="bb-chip ${/CONFLICT/i.test(pr.mergeable) ? 'bb-chip--danger' : ''}">${esc(pr.mergeable || '')}</span>
            <span class="bb-chip">+${pr.additions ?? 0}/-${pr.deletions ?? 0} · ${pr.changedFiles ?? files.length} arch.</span>
            ${pr.isDraft ? '<span class="bb-chip bb-chip--warn">draft</span>' : ''}
          </div>

          ${pr.body ? `<div class="bv2-sec-h">Descripción del PR</div>
          <div class="bv2-detail-desc">${esc(pr.body).slice(0, 6000)}</div>` : ''}

          <div class="bv2-sec-h">Checks (CI) · ${checks.length}</div>
          <div class="bv2-detail-meta">
            ${checks.length ? checks.map((k) => `<span class="bb-chip ${ciClass(k.conclusion || k.state)}" title="${esc(k.workflowName || '')}">${esc(k.name || '?')}: ${esc((k.conclusion || k.status || '').toLowerCase())}</span>`).join('') : '<span class="bf-sub">— sin checks —</span>'}
          </div>

          <div class="bv2-sec-h">Conversaciones · ${conv.length}</div>
          <div class="bv2-conv">
            ${conv.length ? conv.map((m) => `<div class="bv2-conv-item">
              <div class="bv2-conv-head"><b>${esc(m.who)}</b> ${m.state ? `<span class="bb-chip ${reviewClass(m.state)}">${esc(m.state)}</span>` : `<span class="bf-sub">${m.kind}</span>`} <span class="bf-sub">${fmtDate(m.when)}</span></div>
              ${m.body ? `<div class="bv2-conv-body">${esc(m.body).slice(0, 800)}</div>` : ''}
            </div>`).join('') : '<div class="bf-sub">— sin comentarios ni reviews —</div>'}
          </div>

          <div class="bv2-sec-h">Archivos cambiados · ${files.length}</div>
          <div class="bv2-files">
            ${files.length ? files.slice(0, 40).map((fl) => `<div class="bv2-file">
              <span class="bv2-file-path">${esc(fl.path)}</span>
              <span class="bv2-file-stat"><span class="bv2-add">+${fl.additions ?? 0}</span> <span class="bv2-del">-${fl.deletions ?? 0}</span></span>
            </div>`).join('') + (files.length > 40 ? `<div class="bf-sub">+ ${files.length - 40} más</div>` : '') : '<div class="bf-sub">— sin archivos —</div>'}
          </div>

          <div class="bv2-detail-acts">
            ${claimActs}
            <button class="btn-ghost btn--sm" data-act="chat"${lockedByOther ? ' disabled title="En uso por otro usuario"' : ''}>${icon('play', { size: 13 })}<span>Trabajar esto en un chat</span></button>
            <button class="btn-ghost btn--sm" data-act="gh">${icon('gitBranch', { size: 13 })}<span>Abrir en GitHub</span></button>
          </div>
        </div>

        <aside class="bv2-pr-side">
          <div class="bv2-sec-h">Pad · ${(pr.padItems || []).length}${pr.padStale ? ' · ⚠️' : ''}</div>
          <div class="bv2-pad-list">${padHtml}</div>
          <div class="bv2-note">${icon('help', { size: 11 })} Pad ${pr.padFetchedAt ? `act. ${fmtDate(pr.padFetchedAt)}` : '(sin traer)'} · token OAuth (~1h). <b>Pendiente:</b> refresh propio.</div>
          ${metaSideHtml(pr.meta)}
        </aside>
      </div>`;
    // 2ª columna: Contexto adicional + Histórico del trabajo (panel compartido).
    wireMetaPanel({ box, key: `pr:${pr.number}`, itemTitle: pr.title || '', itemDesc: String(pr.body || '').slice(0, 2000), onChanged: reload });

    box.querySelector('[data-act="refresh"]')?.addEventListener('click', reload);
    box.querySelector('[data-act="claim"]')?.addEventListener('click', () => postClaim('claim'));
    box.querySelector('[data-act="release"]')?.addEventListener('click', () => postClaim('release'));
    box.querySelector('[data-act="force"]')?.addEventListener('click', () => postClaim('release', true));
    box.querySelector('[data-act="steal"]')?.addEventListener('click', async () => {
      const okConfirm = await confirmDialog({
        title: 'Robar el PR',
        message: `Este PR lo está trabajando ${w?.label || w?.by}. ¿Tomarlo igual? Pasás a ser vos quien lo trabaja.`,
        confirmLabel: 'Robar', danger: true,
      });
      if (okConfirm) postClaim('claim', true);
    });

    box.querySelector('[data-act="chat"]')?.addEventListener('click', async () => {
      if (lockedByOther) return; // no se trabaja lo de otro (hay que robar primero)
      if (!mine) await apiClaim('claim'); // auto-tomar al empezar a trabajarlo
      const contexts = await fetchWorkflowContexts(); // work + pr editables (Proyectos)
      await deps.openChat?.({
        cwd: deps.projectRel ? deps.projectRel() : TOLKIEN_CWD,
        mode: 'default',
        prompt: buildPrContext(pr, conv, checks, files, contexts), // datos de la tarjeta + contextos de trabajo
        title: `PR #${pr.number} — review`.slice(0, 60),
        // clave 'pr:<n>' → al cerrar el chat se guarda el histórico del trabajo
        // bajo ESTE PR (mismo prefijo que los claims/meta de PR).
        ticket: { number: `pr:${pr.number}`, url: pr.url || null },
      });
      modal.close();
    });
    box.querySelector('[data-act="gh"]')?.addEventListener('click', () => {
      if (pr.url) window.open(pr.url, '_blank', 'noopener');
    });
  }

  async function reload() {
    try {
      const res = await fetch(`/api/tickets/pr/${encodeURIComponent(prLite.number)}`);
      const d = await res.json();
      render(d.pr, d.error, d.you || null, d.youAdmin || false, { generatedAt: d.generatedAt, cached: d.cached });
    } catch (e) {
      render(null, `Error de red: ${e?.message || e}`);
    }
  }
  reload();

  return modal;
}
