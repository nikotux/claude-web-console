// modules/retro/retro.js — MEJORA CONTINUA (ROAD-256): sección de sidebar
// (izquierda) + tablero modal de LECCIONES DE PROCESO destiladas al cerrar
// chats. Registro propio con aprobación humana; se promueven a las memorias
// reales del proyecto. Colapsable + árbol (regla de UI del proyecto).
//
// NO confundir con "🎓 Aprendizaje" (temas de estudio de Niko): esto es el
// SISTEMA aprendiendo a mejorar su propio proceso.

const CAT_ICON = {
  regla: '⛔', convencion: '📏', metodologia: '🧭', procedimiento: '📋', herramienta: '🔧', nota: '📝',
};
const PROJ_LABEL = { console: '🖥️ Consola', tolkien: '🌳 Tolkien', otros: '📦 Otros' };
const STATUS_GROUPS = [
  { key: 'propuesta', label: '🟡 Nuevas (por decidir)', open: true },
  { key: 'aprobada', label: '🔖 Guardadas para después', open: true },
  { key: 'promovida', label: '✅ Adoptadas', open: false },
  { key: 'descartada', label: '🗑️ Descartadas', open: false },
];

// Destinos de promoción, con nombres HUMANOS (sin jerga) para la UI.
const TARGET_LABEL = {
  memoria: { short: '📓 Recordatorio', full: 'un recordatorio del proyecto (la próxima sesión lo lee en su memoria)' },
  'claude-md': { short: '📕 Regla permanente', full: 'una regla permanente del CLAUDE.md (rige toda sesión; solo la sección gestionada, no toca tus reglas escritas a mano)' },
  contexto: { short: '🎫 Guía tickets/PRs', full: 'la guía de trabajo de tickets/PRs (se inyecta en esos chats y se espeja a Tolkien)' },
  playbook: { short: '📘 Procedimiento', full: 'un procedimiento invocable (Playbook de Pad)' },
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
    let isAdmin = false;
    whoami?.then?.((me) => { isAdmin = !!me?.admin; });

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot sec-dot--idle" title="Mejora Continua"></span>
        <span class="sec-title">Mejora Continua</span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Refrescar">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="bv2-sum" data-ref="sum"><span class="bf-sub">sin cargar</span></div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm btn--block" data-ref="open">${icon('grid', { size: 13 })}<span>Abrir tablero</span></button>
        </div>
      </div>`;
    const refs = {
      sum: el.querySelector('[data-ref="sum"]'),
      refresh: el.querySelector('[data-ref="refresh"]'),
      open: el.querySelector('[data-ref="open"]'),
    };

    const renderSummary = (data) => {
      if (!data) { refs.sum.innerHTML = '<span class="bf-sub">sin cargar · tocá ↻</span>'; return; }
      if (data.error) { refs.sum.innerHTML = `<span class="bf-err">${esc(data.error)}</span>`; return; }
      const c = data.counts || {};
      refs.sum.innerHTML = `
        <div class="bv2-sum-main">${c.propuesta ?? 0} propuesta(s)</div>
        <div class="bv2-sum-chips">
          <span class="bb-chip bb-chip--info" title="Aprobadas">✅ ${c.aprobada ?? 0}</span>
          <span class="bb-chip" title="Promovidas a memoria">📥 ${c.promovida ?? 0}</span>
          <span class="bb-chip bb-chip--muted" title="Total registrado">Σ ${c.total ?? 0}</span>
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
      const m = dialog.openModal({ title: '🔄 Mejora Continua', width: 'min(880px, 96vw)', onClose: () => { if (pollTimer) clearTimeout(pollTimer); } });
      const body = m.body;
      body.innerHTML = '<div class="bf-sub" style="padding:1rem">Cargando lecciones…</div>';

      let targets = ['memoria', 'claude-md'];
      try { const t = await getJSON('/api/retro/targets'); if (Array.isArray(t.targets) && t.targets.length) targets = t.targets; } catch { /* usa el default */ }

      // Fase 6: badge de efectividad de una lección promovida.
      const effHtml = (l) => {
        const e = l.effectiveness;
        if (!e) return '';
        if (e.state === 'efectiva') return '<span class="bb-chip" title="Sin reincidencias desde la promoción">🟢 efectiva</span>';
        if (e.state === 'reincide') return `<span class="bb-chip bb-chip--warn" title="Volvió a pasar ${e.hits} vez/veces pese a estar promovida — conviene escalar el destino">🔴 reincide ×${e.hits}</span>`;
        return '<span class="bb-chip bb-chip--muted" title="Recién promovida, observando">⚪ observando</span>';
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
        const verb = escalate ? '⬆️ Escalar' : '👍 Adoptar';
        let h = `<span class="mc-adopt">
          <button class="btn btn--sm" data-act="promote" data-target="${sugg}" title="${escalate ? 'Escalar' : 'Adoptar'}: mandar a ${esc(TARGET_LABEL[sugg]?.full || sugg)}">${verb} → ${TARGET_LABEL[sugg]?.short || sugg}</button>
          ${app.length > 1 ? '<button class="btn btn--sm mc-more" data-act="more" title="Elegir otro destino">▾</button>' : ''}
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
          if (l.status === 'propuesta') acts.push('<button class="btn-ghost btn--sm" data-act="save" title="Guardar para decidir el destino más tarde">🔖 Guardar</button>');
          acts.push('<button class="btn-ghost btn--sm" data-act="dismiss">👎 Descartar</button>');
        } else if (l.status === 'promovida') {
          if (reincide) acts.push(adoptBlock(l, true));
        } else if (l.status === 'descartada') {
          acts.push('<button class="btn-ghost btn--sm" data-act="reopen">↩️ Reabrir</button>');
          acts.push('<button class="btn-ghost btn--sm" data-act="delete" title="Eliminar del registro para siempre">✕ Eliminar</button>');
        }
        const chats = (l.sourceChats || []).length;
        const suggMeta = (l.destination && l.destination !== 'registro' && TARGET_LABEL[l.destination]) ? `sugerido: <b>${TARGET_LABEL[l.destination].short}</b> · ` : '';
        return `
          <details class="mc-lesson" data-id="${esc(l.id)}" ${l.status === 'propuesta' ? 'open' : ''}>
            <summary>
              <span class="mc-cat" title="${esc(l.category)}">${CAT_ICON[l.category] || '📝'}</span>
              <span class="mc-title">${esc(l.title)}</span>
              ${l.recurrence > 1 ? `<span class="bb-chip bb-chip--warn" title="Se repitió en ${l.recurrence} chats">×${l.recurrence}</span>` : ''}
              ${effHtml(l)}
              <span class="bb-chip bb-chip--muted">${PROJ_LABEL[l.project] || l.project}</span>
            </summary>
            <div class="mc-body">
              <div class="mc-md">${mdMini(l.body)}</div>
              <div class="mc-meta bf-sub">
                ${suggMeta}confianza: ${esc(l.confidence)} · ${l.id}${chats ? ` · ${chats} chat(s)` : ''}${l.status === 'promovida' && l.promotedTo ? ` · <b>adoptada como ${esc(TARGET_LABEL[l.promotedTo]?.short || l.promotedTo)}</b>` : ''}
              </div>
              <div class="mc-acts">${acts.join('')}</div>
            </div>
          </details>`;
      };

      // Fase 5: bloque de resultado de la curaduría IA (proposals con apply).
      const curationHtml = () => {
        if (curating) return '<div class="mc-cur"><b>🧹 Curando el registro con IA…</b> <span class="cwc-pacman"></span></div>';
        if (!curation) return '';
        const c = curation;
        const sec = (title, items, fn) => (items && items.length ? `<details class="mc-group" open><summary>${title} <span class="bb-chip bb-chip--muted">${items.length}</span></summary><div class="mc-group-body">${items.map(fn).join('')}</div></details>` : '');
        return `<div class="mc-cur">
          <div class="bf-sub" style="margin:.2rem 0 .5rem; display:flex; justify-content:space-between; gap:.5rem; align-items:center">
            <span><b>🧹 Orden del registro</b> — ${esc(c.resumen || 'sin resumen')}</span>
            <button class="btn-ghost btn--sm" data-act="cur-close">✕ cerrar</button>
          </div>
          ${sec('🔗 Duplicados', c.duplicados, (d, i) => `<div class="mc-cur-item">Conservar <b>${esc(d.keep)}</b>, fusionar <b>${esc(d.merge.join(', '))}</b>. <span class="bf-sub">${esc(d.why)}</span> <button class="btn btn--sm" data-act="cur-merge" data-i="${i}">Fusionar</button></div>`)}
          ${sec('⚠️ Contradicciones', c.contradicciones, (x) => `<div class="mc-cur-item"><b>${esc(x.ids.join(' ↔ '))}</b>: ${esc(x.why)} <span class="bf-sub">(revisá a mano)</span></div>`)}
          ${sec('♻️ Redundantes (ya cubiertas por una regla)', c.redundantes, (x, i) => `<div class="mc-cur-item"><b>${esc(x.id)}</b> — ${esc(x.rule)} <button class="btn-ghost btn--sm" data-act="cur-dismiss" data-i="${i}">Descartar</button></div>`)}
          ${sec('🧩 Consolidables', c.consolidables, (x, i) => `<div class="mc-cur-item">${esc(x.ids.join(' + '))} → <b>${esc(x.title)}</b> <button class="btn btn--sm" data-act="cur-consolidate" data-i="${i}">Crear consolidada</button></div>`)}
          ${sec('🕳️ Huecos', c.huecos, (x) => `<div class="mc-cur-item"><b>${esc(x.tema)}</b> — ${esc(x.why)}</div>`)}
        </div>`;
      };

      const render = (data) => {
        lastData = data;
        const groups = STATUS_GROUPS.map((g) => {
          const items = (data.lessons || []).filter((l) => l.status === g.key);
          if (!items.length) return '';
          return `
            <details class="mc-group" ${g.open && items.length ? 'open' : ''}>
              <summary>${g.label} <span class="bb-chip bb-chip--muted">${items.length}</span></summary>
              <div class="mc-group-body">${items.map(lessonCard).join('')}</div>
            </details>`;
        }).join('');
        const total = (data.lessons || []).length;
        body.innerHTML = `
          <div class="bf-sub" style="margin-bottom:.6rem; display:flex; justify-content:space-between; gap:.5rem; align-items:center">
            <span>Lecciones de proceso que la consola destila sola al cerrar chats. <b>Adoptá</b> las que sirvan (van a donde la IA sugiere) o <b>descartalas</b>. Nada se auto-aplica.</span>
            ${isAdmin && total >= 2 ? '<button class="btn-ghost btn--sm" data-act="curate" title="De vez en cuando: revisá duplicados, contradicciones y huecos del registro. Consume tokens.">🧹 Ordenar el registro</button>' : ''}
          </div>
          ${curationHtml()}
          ${total ? groups : '<div class="bf-sub" style="padding:1rem">Todavía no hay lecciones. Se destilan solas al cerrar chats con sustancia (que tocaron código o de varios turnos).</div>'}`;
      };

      const reload = async () => {
        try { render(await getJSON('/api/retro')); }
        catch (e) { body.innerHTML = `<div class="bf-err" style="padding:1rem">${esc(e.message)}</div>`; }
      };

      const pollCuration = async () => {
        try {
          const j = await getJSON('/api/retro/curation');
          if (j.status === 'done') { curation = j.result; curating = false; render(lastData); return; }
          if (j.status === 'error' || j.status === 'idle') { curating = false; render(lastData); if (j.error) await dialog.alertDialog({ title: 'Curaduría', message: j.error }); return; }
        } catch { /* reintenta */ }
        pollTimer = setTimeout(pollCuration, 3000);
      };

      const startCurate = async () => {
        const ok = await dialog.confirmDialog({ title: 'Curar con IA', message: 'Se analiza todo el registro con IA (duplicados, contradicciones, redundantes, huecos). Consume tokens. ¿Seguir?' });
        if (!ok) return;
        curating = true; curation = null; render(lastData);
        try { await postJSON('/api/retro/curate'); pollTimer = setTimeout(pollCuration, 2500); }
        catch (e) { curating = false; render(lastData); await dialog.alertDialog({ title: 'No se pudo', message: e.message }); }
      };

      body.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        ev.preventDefault();
        try {
          // --- acciones de curaduría (no cuelgan de una lección) ---
          if (act === 'curate') { await startCurate(); return; }
          if (act === 'cur-close') { curation = null; render(lastData); return; }
          if (act === 'cur-merge') {
            const d = curation?.duplicados?.[+btn.dataset.i]; if (!d) return;
            const ok = await dialog.confirmDialog({ title: 'Fusionar duplicados', message: `Conservar ${d.keep} y fusionar ${d.merge.join(', ')} (se suma su recurrencia y se borran). ¿Confirmás?` });
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
            const ok = await dialog.confirmDialog({ title: 'Consolidar', message: `Crear «${d.title}» y borrar ${d.ids.join(', ')}. ¿Confirmás?` });
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
            const ok = await dialog.confirmDialog({ title: 'Eliminar lección', message: '¿Eliminar esta lección del registro para siempre? No se puede deshacer.' });
            if (!ok) return;
            await postJSON(`/api/retro/${id}/delete`);
          } else if (act === 'promote') {
            const target = btn.dataset.target || 'memoria';
            const ok = await dialog.confirmDialog({ title: 'Adoptar lección', message: `Se va a adoptar como ${TARGET_LABEL[target]?.full || target}. ¿Confirmás?` });
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
          await dialog.alertDialog({ title: 'No se pudo', message: e.message });
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
