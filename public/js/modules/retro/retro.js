// modules/retro/retro.js — MEJORA CONTINUA (ROAD-256): sección de sidebar
// (izquierda) + tablero modal de LECCIONES DE PROCESO destiladas al cerrar
// chats. Registro propio con aprobación humana; se promueven a las memorias
// reales del proyecto. Colapsable + árbol (regla de UI del proyecto).
//
// NO confundir con "🎓 Aprendizaje" (temas de estudio de Niko): esto es el
// SISTEMA aprendiendo a mejorar su propio proceso.
import { pacman } from '../../ui/pacman.js';
import { t } from '../../ui/i18n.js';

const CAT_ICON = {
  regla: '⛔', convencion: '📏', metodologia: '🧭', procedimiento: '📋', herramienta: '🔧', nota: '📝', 'feedback-cliente': '💬',
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mdMini = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export default {
  name: 'retro',

  mount(el, ctx) {
    const { icon, dialog, whoami } = ctx;
    const PROJ_LABEL = {
      console: t('retro.proj.console', '🖥️ Consola'),
      tolkien: t('retro.proj.tolkien', '🌳 Tolkien'),
      otros: t('retro.proj.otros', '📦 Otros'),
    };
    const STATUS_GROUPS = [
      { key: 'propuesta', label: t('retro.group.propuesta', '🟡 Nuevas (por decidir)'), open: true },
      { key: 'aprobada', label: t('retro.group.aprobada', '🔖 Guardadas para después'), open: true },
      { key: 'promovida', label: t('retro.group.promovida', '✅ Adoptadas'), open: false },
      { key: 'descartada', label: t('retro.group.descartada', '🗑️ Descartadas'), open: false },
    ];
    // Destinos de promoción, con nombres HUMANOS (sin jerga) para la UI.
    const TARGET_LABEL = {
      memoria: {
        short: t('retro.target.memoria.short', '📓 Recordatorio'),
        full: t('retro.target.memoria.full', 'un recordatorio del proyecto (la próxima sesión lo lee en su memoria)'),
      },
      'claude-md': {
        short: t('retro.target.claudemd.short', '📕 Regla permanente'),
        full: t('retro.target.claudemd.full', 'una regla permanente del CLAUDE.md (rige toda sesión; solo la sección gestionada, no toca tus reglas escritas a mano)'),
      },
      contexto: {
        short: t('retro.target.contexto.short', '🎫 Guía tickets/PRs'),
        full: t('retro.target.contexto.full', 'la guía de trabajo de tickets/PRs (se inyecta en esos chats y se espeja a Tolkien)'),
      },
      playbook: {
        short: t('retro.target.playbook.short', '📘 Procedimiento'),
        full: t('retro.target.playbook.full', 'un procedimiento invocable (Playbook de Pad)'),
      },
    };
    let isAdmin = false;
    whoami?.then?.((me) => { isAdmin = !!me?.admin; });

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot sec-dot--idle" title="${t('retro.sidebar.title', 'Mejora Continua')}"></span>
        <span class="sec-title">${t('retro.sidebar.title', 'Mejora Continua')}</span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="${t('retro.sidebar.refresh', 'Refrescar')}">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="bv2-sum" data-ref="sum"><span class="bf-sub">${t('retro.sidebar.notLoaded', 'sin cargar')}</span></div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm btn--block" data-ref="open">${icon('grid', { size: 13 })}<span>${t('retro.sidebar.openBoard', 'Abrir tablero')}</span></button>
        </div>
      </div>`;
    const refs = {
      sum: el.querySelector('[data-ref="sum"]'),
      refresh: el.querySelector('[data-ref="refresh"]'),
      open: el.querySelector('[data-ref="open"]'),
    };

    const renderSummary = (data) => {
      if (!data) { refs.sum.innerHTML = `<span class="bf-sub">${t('retro.sidebar.notLoadedTap', 'sin cargar · tocá ↻')}</span>`; return; }
      if (data.error) { refs.sum.innerHTML = `<span class="bf-err">${esc(data.error)}</span>`; return; }
      const c = data.counts || {};
      refs.sum.innerHTML = `
        <div class="bv2-sum-main">${t('retro.summary.proposals', '{n} propuesta(s)', { n: c.propuesta ?? 0 })}</div>
        <div class="bv2-sum-chips">
          <span class="bb-chip bb-chip--info" title="${t('retro.summary.approved', 'Aprobadas')}">✅ ${c.aprobada ?? 0}</span>
          <span class="bb-chip" title="${t('retro.summary.promoted', 'Promovidas a memoria')}">📥 ${c.promovida ?? 0}</span>
          <span class="bb-chip bb-chip--muted" title="${t('retro.summary.total', 'Total registrado')}">Σ ${c.total ?? 0}</span>
        </div>`;
    };

    const loadSummary = async () => {
      try { renderSummary(await getJSON('/api/retro')); }
      catch (e) { renderSummary({ error: e.message }); }
    };

    // ===== Tablero modal =====
    const openBoard = async () => {
      let curation = null;   // resultado de la curaduría IA (Fase 5)
      let curating = false;  // corrida en vuelo
      let pollTimer = null;
      let lastData = { lessons: [] };
      const m = dialog.openModal({ title: t('retro.board.title', '🔄 Mejora Continua'), width: 'min(880px, 96vw)', onClose: () => { if (pollTimer) clearTimeout(pollTimer); } });
      const body = m.body;
      body.innerHTML = `<div class="bf-sub" style="padding:1rem">${pacman({ size: 'sm' })} ${t('retro.board.loading', 'Cargando lecciones…')}</div>`;

      let targets = ['memoria', 'claude-md'];
      try { const t = await getJSON('/api/retro/targets'); if (Array.isArray(t.targets) && t.targets.length) targets = t.targets; } catch { /* usa el default */ }

      // Fase 6: badge de efectividad de una lección promovida.
      const effHtml = (l) => {
        const e = l.effectiveness;
        if (!e) return '';
        if (e.state === 'efectiva') return `<span class="bb-chip" title="${t('retro.eff.effective.title', 'Sin reincidencias desde la promoción')}">${t('retro.eff.effective.label', '🟢 efectiva')}</span>`;
        if (e.state === 'reincide') return `<span class="bb-chip bb-chip--warn" title="${esc(t('retro.eff.recur.title', 'Volvió a pasar {hits} vez/veces pese a estar promovida — conviene escalar el destino', { hits: e.hits }))}">${t('retro.eff.recur.label', '🔴 reincide ×{hits}', { hits: e.hits })}</span>`;
        return `<span class="bb-chip bb-chip--muted" title="${t('retro.eff.watching.title', 'Recién promovida, observando')}">${t('retro.eff.watching.label', '⚪ observando')}</span>`;
      };

      // Destinos aplicables a una lección (memoria/claude-md exigen proyecto con
      // filesystem; contexto/playbook aplican siempre). El destino SUGERIDO por
      // la IA se resalta como acción primaria; el resto va en el menú "▾".
      const NEED_DIR = ['memoria', 'claude-md'];
      const applicableTargets = (l) => {
        const hasDir = l.project === 'console' || l.project === 'tolkien';
        return targets.filter((t) => (NEED_DIR.includes(t) ? hasDir : true));
      };

      // Bloque "Adoptar → <destino sugerido>" + menú ▾ con los otros destinos.
      const adoptBlock = (l, escalate) => {
        const app = applicableTargets(l);
        if (!isAdmin || !app.length) return '';
        const sugg = app.includes(l.destination) ? l.destination : app[0];
        const verb = escalate ? t('retro.adopt.escalate', '⬆️ Escalar') : t('retro.adopt.adopt', '👍 Adoptar');
        const title = `${escalate ? t('retro.adopt.wordEscalate', 'Escalar') : t('retro.adopt.wordAdopt', 'Adoptar')}: ${t('retro.adopt.sendTo', 'mandar a')} ${TARGET_LABEL[sugg]?.full || sugg}`;
        let h = `<span class="mc-adopt">
          <button class="btn btn--sm" data-act="promote" data-target="${sugg}" title="${esc(title)}">${verb} → ${TARGET_LABEL[sugg]?.short || sugg}</button>
          ${app.length > 1 ? `<button class="btn btn--sm mc-more" data-act="more" title="${t('retro.adopt.more', 'Elegir otro destino')}">▾</button>` : ''}
        </span>`;
        if (app.length > 1) {
          h += `<span class="mc-dests" hidden>${app.map((t) => `<button class="btn-ghost btn--sm" data-act="promote" data-target="${t}" title="${esc(TARGET_LABEL[t]?.full || t)}">${TARGET_LABEL[t]?.short || t}</button>`).join('')}</span>`;
        }
        return h;
      };

      const lessonCard = (l) => {
        const reincide = l.effectiveness?.state === 'reincide';
        const acts = [];
        if (l.status === 'propuesta' || l.status === 'aprobada') {
          acts.push(adoptBlock(l, false));
          if (l.status === 'propuesta') acts.push(`<button class="btn-ghost btn--sm" data-act="save" title="${t('retro.card.saveTitle', 'Guardar para decidir el destino más tarde')}">${t('retro.card.save', '🔖 Guardar')}</button>`);
          acts.push(`<button class="btn-ghost btn--sm" data-act="dismiss">${t('retro.card.dismiss', '👎 Descartar')}</button>`);
        } else if (l.status === 'promovida') {
          if (reincide) acts.push(adoptBlock(l, true));
        } else if (l.status === 'descartada') {
          acts.push(`<button class="btn-ghost btn--sm" data-act="reopen">${t('retro.card.reopen', '↩️ Reabrir')}</button>`);
          acts.push(`<button class="btn-ghost btn--sm" data-act="delete" title="${t('retro.card.deleteTitle', 'Eliminar del registro para siempre')}">${t('retro.card.delete', '✕ Eliminar')}</button>`);
        }
        const chats = (l.sourceChats || []).length;
        const refs = l.sourceRefs || [];
        const refsChips = refs.length ? refs.map((r) => `<span class="bb-chip bb-chip--info" title="${esc(t('retro.card.refTitle', 'Feedback vinculado a {ref}', { ref: r }))}" data-ref-filter="${esc(r)}">${esc(r)}</span>`).join('') : '';
        const suggMeta = (l.destination && l.destination !== 'registro' && TARGET_LABEL[l.destination]) ? `${t('retro.card.suggested', 'sugerido')}: <b>${TARGET_LABEL[l.destination].short}</b> · ` : '';
        return `
          <details class="mc-lesson" data-id="${esc(l.id)}" ${l.status === 'propuesta' ? 'open' : ''}>
            <summary>
              <span class="mc-cat" title="${esc(l.category)}">${CAT_ICON[l.category] || '📝'}</span>
              <span class="mc-title">${esc(l.title)}</span>
              ${l.recurrence > 1 ? `<span class="bb-chip bb-chip--warn" title="${esc(t('retro.card.recurTitle', 'Se repitió en {n} chats', { n: l.recurrence }))}">×${l.recurrence}</span>` : ''}
              ${effHtml(l)}
              ${refsChips}
              <span class="bb-chip bb-chip--muted">${PROJ_LABEL[l.project] || l.project}</span>
            </summary>
            <div class="mc-body">
              <div class="mc-md">${mdMini(l.body)}</div>
              <div class="mc-meta bf-sub">
                ${suggMeta}${t('retro.card.confidence', 'confianza')}: ${esc(l.confidence)} · ${l.id}${chats ? ` · ${t('retro.card.chats', '{n} chat(s)', { n: chats })}` : ''}${l.status === 'promovida' && l.promotedTo ? ` · <b>${t('retro.card.adoptedAs', 'adoptada como {label}', { label: (TARGET_LABEL[l.promotedTo]?.short || l.promotedTo) })}</b>` : ''}
              </div>
              <div class="mc-acts">${acts.join('')}</div>
            </div>
          </details>`;
      };

      // Fase 5: bloque de resultado de la curaduría IA (proposals con apply).
      const curationHtml = () => {
        if (curating) return `<div class="mc-cur"><b>${t('retro.cur.running', '🧹 Curando el registro con IA…')}</b> ${pacman({ state: 'delegating', size: 'sm' })}</div>`;
        if (!curation) return '';
        const c = curation;
        const sec = (title, items, fn) => (items && items.length ? `<details class="mc-group" open><summary>${title} <span class="bb-chip bb-chip--muted">${items.length}</span></summary><div class="mc-group-body">${items.map(fn).join('')}</div></details>` : '');
        return `<div class="mc-cur">
          <div class="bf-sub" style="margin:.2rem 0 .5rem; display:flex; justify-content:space-between; gap:.5rem; align-items:center">
            <span><b>${t('retro.cur.title', '🧹 Orden del registro')}</b> — ${esc(c.resumen || t('retro.cur.noSummary', 'sin resumen'))}</span>
            <button class="btn-ghost btn--sm" data-act="cur-close">${t('retro.cur.close', '✕ cerrar')}</button>
          </div>
          ${sec(t('retro.cur.duplicates', '🔗 Duplicados'), c.duplicados, (d, i) => `<div class="mc-cur-item">${t('retro.cur.keep', 'Conservar')} <b>${esc(d.keep)}</b>, ${t('retro.cur.merge', 'fusionar')} <b>${esc(d.merge.join(', '))}</b>. <span class="bf-sub">${esc(d.why)}</span> <button class="btn btn--sm" data-act="cur-merge" data-i="${i}">${t('retro.cur.mergeBtn', 'Fusionar')}</button></div>`)}
          ${sec(t('retro.cur.contradictions', '⚠️ Contradicciones'), c.contradicciones, (x) => `<div class="mc-cur-item"><b>${esc(x.ids.join(' ↔ '))}</b>: ${esc(x.why)} <span class="bf-sub">${t('retro.cur.reviewManually', '(revisá a mano)')}</span></div>`)}
          ${sec(t('retro.cur.redundant', '♻️ Redundantes (ya cubiertas por una regla)'), c.redundantes, (x, i) => `<div class="mc-cur-item"><b>${esc(x.id)}</b> — ${esc(x.rule)} <button class="btn-ghost btn--sm" data-act="cur-dismiss" data-i="${i}">${t('retro.cur.dismiss', 'Descartar')}</button></div>`)}
          ${sec(t('retro.cur.consolidatable', '🧩 Consolidables'), c.consolidables, (x, i) => `<div class="mc-cur-item">${esc(x.ids.join(' + '))} → <b>${esc(x.title)}</b> <button class="btn btn--sm" data-act="cur-consolidate" data-i="${i}">${t('retro.cur.createConsolidated', 'Crear consolidada')}</button></div>`)}
          ${sec(t('retro.cur.gaps', '🕳️ Huecos'), c.huecos, (x) => `<div class="mc-cur-item"><b>${esc(x.tema)}</b> — ${esc(x.why)}</div>`)}
        </div>`;
      };

      let refFilter = '';   // filtro "por ticket" (chip clickeado o tipeado)
      let emailScanning = false;
      let teamsScanning = false;

      const feedbackComposer = () => `
        <details class="mc-group" data-role="fb-composer">
          <summary>${t('retro.fb.title', '💬 Feedback de Chris')} <span class="bb-chip bb-chip--muted">${t('retro.fb.chip', 'registrar / traer')}</span></summary>
          <div class="mc-group-body">
            <div class="bf-sub" style="margin-bottom:.4rem">${t('retro.fb.instr', 'Pegá acá un correo, mensaje de Teams o notas de una llamada de Chris — la IA lo interpreta y lo deja listo para adoptar (se inyecta solo en todo chat de bug futuro).')}</div>
            <textarea class="mc-fb-text" placeholder="${t('retro.fb.placeholder', 'Pegá el texto acá…')}" rows="4" style="width:100%; resize:vertical"></textarea>
            <div style="display:flex; gap:.4rem; margin-top:.4rem; align-items:center; flex-wrap:wrap">
              <input class="mc-fb-ref" type="text" placeholder="${t('retro.fb.refPlaceholder', 'TKT-519 / PR-245 (opcional)')}" style="max-width:160px">
              <button class="btn btn--sm" data-act="fb-submit">${t('retro.fb.submit', 'Interpretar y registrar')}</button>
              ${isAdmin ? `<button class="btn-ghost btn--sm" data-act="email-scan" title="${t('retro.fb.emailTitle', 'Buscar feedback nuevo en el correo de Chris. Consume tokens.')}">${emailScanning ? t('retro.fb.emailScanning', '📧 Buscando…') : t('retro.fb.emailScan', '📧 Traer feedback de correo')}</button>` : ''}
              ${isAdmin ? `<button class="btn-ghost btn--sm" data-act="teams-scan" title="${t('retro.fb.teamsTitle', 'Buscar feedback nuevo en el DM de Teams con Chris. Consume tokens.')}">${teamsScanning ? t('retro.fb.teamsScanning', '📨 Buscando…') : t('retro.fb.teamsScan', '📨 Traer feedback de Teams')}</button>` : ''}
            </div>
          </div>
        </details>`;

      // Historial COMPLETO de feedback (2026-07-19, pedido de Niko): a diferencia
      // de los grupos de arriba (que agrupan por ESTADO/flujo de decisión), esto
      // agrupa por TICKET/PR — muestra TODO lo que dijo Chris sobre un ticket,
      // decidido o no, para no perder la vista acumulada al ir adoptando/
      // descartando piezas sueltas. Ignora refFilter a propósito (es la vista
      // "todo", no la filtrada).
      const FB_STATUS_ICON = { propuesta: '🟡', aprobada: '🔖', promovida: '✅', descartada: '🗑️' };
      const feedbackHistoryHtml = (all) => {
        const fb = all.filter((l) => l.category === 'feedback-cliente');
        if (!fb.length) return '';
        const byRef = new Map();
        const noRef = [];
        for (const l of fb) {
          const refs = (l.sourceRefs || []).length ? l.sourceRefs : null;
          if (!refs) { noRef.push(l); continue; }
          for (const r of refs) { if (!byRef.has(r)) byRef.set(r, []); byRef.get(r).push(l); }
        }
        const miniCard = (l) => `
          <div class="mc-fbh-item">
            <span class="bb-chip bb-chip--muted" title="${esc(l.status)}">${FB_STATUS_ICON[l.status] || '•'}</span>
            <span class="mc-fbh-title">${esc(l.title)}</span>
            <span class="bf-sub">${esc(l.confidence)} · ${esc(l.id)}</span>
          </div>`;
        const ticketGroups = [...byRef.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([ref, items]) => `
            <details class="mc-group">
              <summary>🎫 ${esc(ref)} <span class="bb-chip bb-chip--muted">${items.length}</span></summary>
              <div class="mc-group-body">${items.map(miniCard).join('')}</div>
            </details>`).join('');
        const noRefHtml = noRef.length ? `
          <details class="mc-group">
            <summary>${t('retro.fbh.noRef', '📦 Sin ticket vinculado')} <span class="bb-chip bb-chip--muted">${noRef.length}</span></summary>
            <div class="mc-group-body">${noRef.map(miniCard).join('')}</div>
          </details>` : '';
        return `
          <details class="mc-group" open data-role="fb-history">
            <summary>${t('retro.fbh.title', '📜 Historial de feedback (por ticket)')} <span class="bb-chip bb-chip--muted">${fb.length}</span></summary>
            <div class="mc-group-body">${ticketGroups}${noRefHtml}</div>
          </details>`;
      };

      const render = (data) => {
        lastData = data;
        const all = data.lessons || [];
        const visible = refFilter ? all.filter((l) => (l.sourceRefs || []).includes(refFilter)) : all;
        const groups = STATUS_GROUPS.map((g) => {
          const items = visible.filter((l) => l.status === g.key);
          if (!items.length) return '';
          return `
            <details class="mc-group" ${g.open && items.length ? 'open' : ''}>
              <summary>${g.label} <span class="bb-chip bb-chip--muted">${items.length}</span></summary>
              <div class="mc-group-body">${items.map(lessonCard).join('')}</div>
            </details>`;
        }).join('');
        const total = all.length;
        body.innerHTML = `
          <div class="bf-sub" style="margin-bottom:.6rem; display:flex; justify-content:space-between; gap:.5rem; align-items:center">
            <span>${t('retro.render.intro', 'Lecciones de proceso que la consola destila sola al cerrar chats, más el feedback de Chris que registrás. <b>Adoptá</b> las que sirvan (van a donde la IA sugiere) o <b>descartalas</b>. Nada se auto-aplica.')}</span>
            ${isAdmin && total >= 2 ? `<button class="btn-ghost btn--sm" data-act="curate" title="${t('retro.render.curateTitle', 'De vez en cuando: revisá duplicados, contradicciones y huecos del registro. Consume tokens.')}">${t('retro.render.curate', '🧹 Ordenar el registro')}</button>` : ''}
          </div>
          ${feedbackComposer()}
          ${feedbackHistoryHtml(all)}
          ${refFilter ? `<div class="bf-sub" style="margin:.4rem 0"><span class="bb-chip bb-chip--info">${t('retro.render.filterBy', 'Filtrando por')} ${esc(refFilter)}</span> <button class="btn-ghost btn--sm" data-act="clear-ref-filter">${t('retro.render.clearFilter', '✕ quitar filtro')}</button></div>` : ''}
          ${curationHtml()}
          ${total ? (visible.length ? groups : `<div class="bf-sub" style="padding:1rem">${t('retro.render.noRef', 'Nada con esa referencia todavía.')}</div>`) : `<div class="bf-sub" style="padding:1rem">${t('retro.render.empty', 'Todavía no hay lecciones. Se destilan solas al cerrar chats con sustancia (que tocaron código o de varios turnos), o registrá feedback de Chris arriba.')}</div>`}`;
      };

      const reload = async () => {
        try { render(await getJSON('/api/retro')); }
        catch (e) { body.innerHTML = `<div class="bf-err" style="padding:1rem">${esc(e.message)}</div>`; }
      };

      const pollCuration = async () => {
        try {
          const j = await getJSON('/api/retro/curation');
          if (j.status === 'done') { curation = j.result; curating = false; render(lastData); return; }
          if (j.status === 'error' || j.status === 'idle') { curating = false; render(lastData); if (j.error) await dialog.alertDialog({ title: t('retro.dlg.curation', 'Curaduría'), message: j.error }); return; }
        } catch { /* reintenta */ }
        pollTimer = setTimeout(pollCuration, 3000);
      };

      const startCurate = async () => {
        const ok = await dialog.confirmDialog({ title: t('retro.dlg.curateTitle', 'Curar con IA'), message: t('retro.dlg.curateMsg', 'Se analiza todo el registro con IA (duplicados, contradicciones, redundantes, huecos). Consume tokens. ¿Seguir?') });
        if (!ok) return;
        curating = true; curation = null; render(lastData);
        try { await postJSON('/api/retro/curate'); pollTimer = setTimeout(pollCuration, 2500); }
        catch (e) { curating = false; render(lastData); await dialog.alertDialog({ title: t('retro.dlg.failed', 'No se pudo'), message: e.message }); }
      };

      // Poll de un job de feedback manual (0 tokens por poll, mismo patrón de pollCuration).
      const pollFeedback = (jobId, resolve) => {
        setTimeout(async () => {
          try {
            const j = await getJSON(`/api/retro/feedback/${jobId}`);
            if (j.status === 'done' || j.status === 'error') { resolve(j); return; }
          } catch { /* reintenta */ }
          pollFeedback(jobId, resolve);
        }, 2500);
      };

      // Poll del escaneo de correo (0 tokens por poll).
      const pollEmailScan = (resolve) => {
        setTimeout(async () => {
          try {
            const j = await getJSON('/api/retro/email-scan');
            if (!j.running) { resolve(j); return; }
          } catch { /* reintenta */ }
          pollEmailScan(resolve);
        }, 3000);
      };

      // Poll del escaneo de Teams (0 tokens por poll).
      const pollTeamsScan = (resolve) => {
        setTimeout(async () => {
          try {
            const j = await getJSON('/api/retro/teams-scan');
            if (!j.running) { resolve(j); return; }
          } catch { /* reintenta */ }
          pollTeamsScan(resolve);
        }, 3000);
      };

      body.addEventListener('click', async (ev) => {
        const refChip = ev.target.closest('[data-ref-filter]');
        if (refChip && !ev.target.closest('[data-act]')) {
          refFilter = refChip.dataset.refFilter;
          render(lastData);
          return;
        }
        const btn = ev.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        ev.preventDefault();
        try {
          if (act === 'clear-ref-filter') { refFilter = ''; render(lastData); return; }
          if (act === 'fb-submit') {
            const wrap = btn.closest('[data-role="fb-composer"]');
            const text = wrap?.querySelector('.mc-fb-text')?.value.trim() || '';
            const ticketRef = wrap?.querySelector('.mc-fb-ref')?.value.trim() || '';
            if (!text) { await dialog.alertDialog({ title: t('retro.dlg.missingTextTitle', 'Falta el texto'), message: t('retro.dlg.missingTextMsg', 'Pegá el correo/Teams/llamada antes de interpretar.') }); return; }
            btn.disabled = true; btn.textContent = t('retro.fb.interpreting', 'Interpretando…');
            try {
              const r = await postJSON('/api/retro/feedback', { text, ticketRef });
              const done = await new Promise((resolve) => pollFeedback(r.id, resolve));
              if (done.status === 'error') throw new Error(done.error || t('retro.dlg.cantInterpret', 'No se pudo interpretar.'));
              await reload(); await loadSummary();
            } catch (e) {
              await dialog.alertDialog({ title: t('retro.dlg.cantRecord', 'No se pudo registrar'), message: e.message });
              btn.disabled = false; btn.textContent = t('retro.fb.submit', 'Interpretar y registrar');
            }
            return;
          }
          if (act === 'email-scan') {
            const ok = await dialog.confirmDialog({ title: t('retro.dlg.emailScanTitle', 'Traer feedback de correo'), message: t('retro.dlg.emailScanMsg', 'Se escanea el correo de Chris buscando feedback de desarrollo (solo lectura, nunca envía nada). Consume tokens. ¿Seguir?') });
            if (!ok) return;
            emailScanning = true; render(lastData);
            try {
              await postJSON('/api/retro/email-refresh');
              const done = await new Promise((resolve) => pollEmailScan(resolve));
              emailScanning = false;
              if (done.error) { await dialog.alertDialog({ title: t('retro.dlg.scanError', 'El escaneo tuvo un error'), message: done.error }); }
              else {
                const s = done.lastSummary || {};
                await dialog.alertDialog({
                  title: t('retro.dlg.emailDoneTitle', 'Escaneo de correo listo'),
                  message: t('retro.dlg.emailDoneMsg', '{n} correo(s) con feedback revisados · {created} lección(es) nueva(s) · {merged} recurrente(s).', { n: done.items?.length ?? 0, created: s.created ?? 0, merged: s.merged ?? 0 }),
                });
              }
              await reload(); await loadSummary();
            } catch (e) {
              emailScanning = false; render(lastData);
              await dialog.alertDialog({ title: t('retro.dlg.cantScan', 'No se pudo escanear'), message: e.message });
            }
            return;
          }
          if (act === 'teams-scan') {
            const ok = await dialog.confirmDialog({ title: t('retro.dlg.teamsScanTitle', 'Traer feedback de Teams'), message: t('retro.dlg.teamsScanMsg', 'Se escanea el DM de Teams con Chris buscando feedback de desarrollo (solo lectura, nunca envía nada). Consume tokens. ¿Seguir?') });
            if (!ok) return;
            teamsScanning = true; render(lastData);
            try {
              await postJSON('/api/retro/teams-refresh');
              const done = await new Promise((resolve) => pollTeamsScan(resolve));
              teamsScanning = false;
              if (done.error) { await dialog.alertDialog({ title: t('retro.dlg.scanError', 'El escaneo tuvo un error'), message: done.error }); }
              else {
                const s = done.lastSummary || {};
                await dialog.alertDialog({
                  title: t('retro.dlg.teamsDoneTitle', 'Escaneo de Teams listo'),
                  message: `${t('retro.dlg.teamsDoneMsg', '{n} mensaje(s) con feedback revisados · {created} lección(es) nueva(s) · {merged} recurrente(s).', { n: done.items?.length ?? 0, created: s.created ?? 0, merged: s.merged ?? 0 })}${done.note ? ` (${done.note})` : ''}`,
                });
              }
              await reload(); await loadSummary();
            } catch (e) {
              teamsScanning = false; render(lastData);
              await dialog.alertDialog({ title: t('retro.dlg.cantScan', 'No se pudo escanear'), message: e.message });
            }
            return;
          }
          // --- acciones de curaduría (no cuelgan de una lección) ---
          if (act === 'curate') { await startCurate(); return; }
          if (act === 'cur-close') { curation = null; render(lastData); return; }
          if (act === 'cur-merge') {
            const d = curation?.duplicados?.[+btn.dataset.i]; if (!d) return;
            const ok = await dialog.confirmDialog({ title: t('retro.dlg.mergeTitle', 'Fusionar duplicados'), message: t('retro.dlg.mergeMsg', 'Conservar {keep} y fusionar {merge} (se suma su recurrencia y se borran). ¿Confirmás?', { keep: d.keep, merge: d.merge.join(', ') }) });
            if (!ok) return;
            btn.disabled = true;
            await postJSON('/api/retro/curate/apply', { action: 'merge', keep: d.keep, merge: d.merge });
            const ix = curation.duplicados.indexOf(d); if (ix >= 0) curation.duplicados.splice(ix, 1);
            await reload(); await loadSummary(); return;
          }
          if (act === 'cur-dismiss') {
            const d = curation?.redundantes?.[+btn.dataset.i]; if (!d) return;
            btn.disabled = true;
            await postJSON('/api/retro/curate/apply', { action: 'dismiss', id: d.id });
            const ix = curation.redundantes.indexOf(d); if (ix >= 0) curation.redundantes.splice(ix, 1);
            await reload(); await loadSummary(); return;
          }
          if (act === 'cur-consolidate') {
            const d = curation?.consolidables?.[+btn.dataset.i]; if (!d) return;
            const ok = await dialog.confirmDialog({ title: t('retro.dlg.consolidateTitle', 'Consolidar'), message: t('retro.dlg.consolidateMsg', 'Crear «{title}» y borrar {ids}. ¿Confirmás?', { title: d.title, ids: d.ids.join(', ') }) });
            if (!ok) return;
            btn.disabled = true;
            await postJSON('/api/retro/curate/apply', { action: 'consolidate', ids: d.ids, title: d.title, lesson: d.lesson, category: d.category });
            const ix = curation.consolidables.indexOf(d); if (ix >= 0) curation.consolidables.splice(ix, 1);
            await reload(); await loadSummary(); return;
          }
          // --- acciones sobre una lección ---
          const card = btn.closest('.mc-lesson');
          const id = card?.dataset.id;
          if (!id) return;
          if (act === 'more') { // solo abre/cierra el menú de destinos, no recarga
            const dests = btn.closest('.mc-acts')?.querySelector('.mc-dests');
            if (dests) dests.hidden = !dests.hidden;
            return;
          }
          if (act === 'delete') {
            const ok = await dialog.confirmDialog({ title: t('retro.dlg.deleteTitle', 'Eliminar lección'), message: t('retro.dlg.deleteMsg', '¿Eliminar esta lección del registro para siempre? No se puede deshacer.') });
            if (!ok) return;
            await postJSON(`/api/retro/${id}/delete`);
          } else if (act === 'promote') {
            const target = btn.dataset.target || 'memoria';
            const ok = await dialog.confirmDialog({ title: t('retro.dlg.adoptTitle', 'Adoptar lección'), message: t('retro.dlg.adoptMsg', 'Se va a adoptar como {label}. ¿Confirmás?', { label: (TARGET_LABEL[target]?.full || target) }) });
            if (!ok) return;
            btn.disabled = true;
            await postJSON(`/api/retro/${id}/promote`, { target });
          } else if (act === 'save') {
            btn.disabled = true;
            await postJSON(`/api/retro/${id}/approve`); // "Guardar para después" = estado guardada
          } else if (act === 'reopen') {
            btn.disabled = true;
            await postJSON(`/api/retro/${id}/reopen`);
          } else {
            btn.disabled = true;
            await postJSON(`/api/retro/${id}/${act}`);
          }
          await reload();
          await loadSummary();
        } catch (e) {
          await dialog.alertDialog({ title: t('retro.dlg.failed', 'No se pudo'), message: e.message });
          btn.disabled = false;
          await reload(); // reflejar el estado REAL (p.ej. promoción revertida en el server)
        }
      });

      await reload();
    };

    refs.refresh.addEventListener('click', loadSummary);
    refs.open.addEventListener('click', openBoard);
    loadSummary();
  },
};
