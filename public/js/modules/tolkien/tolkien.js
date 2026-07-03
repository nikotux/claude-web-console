// modules/tolkien/tolkien.js — tarjeta INFORMATIVA del proyecto principal (git).
//
// Rediseño (pedido del usuario): la tarjeta muestra el PULSO del repo en vez de
// botones redundantes. Continuar/Explorar salieron (alcanzables desde el
// lanzador y el Explorador del pie) y "Bugs & PRs" se mudó a la sección
// "Bugs & Features". Queda UNA acción: Actualizar (⬇, ícono en el header) =
// stash → pull --ff-only → stash pop (no destructivo). Info mostrada:
//   #SHA · branch · al día / N detrás/adelante · N cambios sin commitear
//   último commit (asunto · autor · hace X)  ← el pulso: ¿Chris mergeó algo?
//   último fetch (frescura del "N detrás")
// El auto-fetch cada 5 min (y en visibilitychange) mantiene fresco el "detrás".

export default {
  name: 'tolkien',

  mount(el, ctx) {
    const { icon, dialog } = ctx;
    let current = null;
    let busy = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-title">Tolkien</span>
        <span class="tk-chip" data-ref="chip"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="update" title="Actualizar desde GitHub (stash → pull → pop)">${icon('download', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="tk-info" data-ref="info">cargando…</div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const upToDate = (st) => !!st && st.behind === 0;

    function fmtAgo(iso) {
      const ms = iso ? (typeof iso === 'number' ? iso : Date.parse(iso)) : 0;
      if (!ms) return '';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return 'recién';
      if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
      if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
      return `hace ${Math.floor(s / 86400)} d`;
    }

    function stateText(st) {
      let s;
      if (st.behind > 0) s = `${st.behind} detrás`;
      else if (st.ahead > 0) s = `${st.ahead} adelante`;
      else s = 'al día';
      if (st.dirty) s += ` · ${st.dirtyCount} cambio${st.dirtyCount === 1 ? '' : 's'}`;
      return s;
    }

    function render() {
      const st = current;
      const cls = upToDate(st) ? 'ok' : 'behind';
      refs.chip.className = `tk-chip ${cls}`;
      refs.chip.innerHTML = st ? (upToDate(st) ? icon('check', { size: 12 }) : `↓${st.behind}`) : '';
      refs.update.disabled = busy;
      // Resaltar la acción cuando hay algo para traer.
      refs.update.classList.toggle('tk-update--due', !!st && st.behind > 0);
      refs.update.title = st && st.behind > 0
        ? `Actualizar: ${st.behind} commit(s) para traer`
        : 'Actualizar desde GitHub (stash → pull → pop)';

      if (!st) { refs.info.innerHTML = busy ? '<span class="cwc-spinner"></span>' : '…'; return; }
      const branch = st.branch && st.branch !== 'main'
        ? `<span class="tk-branch tk-branch--warn" title="No estás en main">⎇ ${esc(st.branch)}</span>`
        : `<span class="tk-branch">⎇ ${esc(st.branch || 'main')}</span>`;
      const commit = st.subject
        ? `<div class="tk-commit" title="${esc(st.subject)}">último: ${esc(st.subject)}</div>
           <div class="tk-commit-sub">${esc(st.author || '?')} · ${fmtAgo(st.date)}</div>`
        : '';
      const fetched = st.lastFetch ? `<div class="tk-fetch">remoto chequeado ${fmtAgo(st.lastFetch)}</div>` : '';
      refs.info.innerHTML = `
        <div class="tk-line1">
          <span class="tk-head">#${esc(st.head)}</span>
          ${branch}
          <span class="tk-state ${cls}">${esc(stateText(st))}</span>
        </div>
        ${commit}
        ${fetched}`;
    }

    async function loadStatus() {
      try { current = await (await fetch('/api/tolkien/status')).json(); render(); }
      catch { /* noop */ }
    }

    async function checkRemote() {
      if (busy) return;
      busy = true; render();
      try {
        const data = await (await fetch('/api/tolkien/fetch', { method: 'POST' })).json();
        if (data.status) current = data.status;
      } catch { /* noop */ } finally { busy = false; render(); }
    }

    const fmtLog = (log) => Array.isArray(log)
      ? log.map((s) => `• ${s.step}: ${(s.out || '').split('\n')[0] || '(ok)'}`).join('\n')
      : '';

    async function doUpdate() {
      if (busy) return;
      const ok = await dialog.confirmDialog({
        title: 'Actualizar Tolkien',
        message: 'Se trae lo último de GitHub (stash → pull → stash pop).\nTus cambios locales quedan a salvo si algo falla.',
        confirmLabel: 'Actualizar',
      });
      if (!ok) return;
      busy = true; render();
      try {
        const data = await (await fetch('/api/tolkien/update', { method: 'POST' })).json();
        if (data.status) current = data.status;
        if (data.error) {
          await dialog.alertDialog({ title: 'No se pudo actualizar', message: `${data.error}\n\n${fmtLog(data.log)}` });
        } else if (data.popConflict) {
          await dialog.alertDialog({
            title: 'Actualizado, con conflicto',
            message: `Hubo conflicto al reaplicar tus cambios: quedaron en el stash (git stash list).\n\n${fmtLog(data.log)}`,
          });
        }
      } catch {
        await dialog.alertDialog({ title: 'Tolkien', message: 'No se pudo actualizar (error de red o del servidor).' });
      } finally {
        busy = false; render();
      }
    }

    refs.update.addEventListener('click', doUpdate);

    (async () => {
      await loadStatus();
      checkRemote();
    })();

    const CHECK_MS = 5 * 60 * 1000;
    setInterval(() => { if (!document.hidden) checkRemote(); }, CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });
  },
};
