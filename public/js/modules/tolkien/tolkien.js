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
        <button class="btn-ghost btn--sm btn--icon" data-ref="fetch" title="Buscar cambios en GitHub (fetch)">${icon('refresh', { size: 14 })}</button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="update" title="Descargar cambios (pull: stash → pull → pop)">${icon('download', { size: 14 })}</button>
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

    // Autor corto: "Christopher Swenor" -> "C. Swenor" (reconocible sin ocupar
    // toda la línea). Una sola palabra se muestra tal cual, con tope.
    function shortAuthor(a) {
      const p = String(a || '').trim().split(/\s+/);
      const s = p.length >= 2 ? `${p[0][0]}. ${p[p.length - 1]}` : (p[0] || '?');
      return s.slice(0, 16);
    }

    // 3 líneas icónicas (VS Code/GitHub Desktop): branch+sync · dirty+fetch ·
    // pulso del último commit (corto; asunto completo en el tooltip).
    function render() {
      const st = current;
      refs.fetch.disabled = busy;
      refs.update.disabled = busy;
      // El pull resalta cuando hay commits nuevos para traer.
      refs.update.classList.toggle('tk-update--due', !!st && st.behind > 0);
      refs.update.title = st && st.behind > 0
        ? `Descargar: ${st.behind} commit(s) nuevos para traer`
        : 'Descargar cambios (pull: stash → pull → pop)';

      if (!st) { refs.info.innerHTML = busy ? '<span class="cwc-spinner"></span>' : '…'; return; }

      // Línea 1: branch (⚠ si ≠ main) + estado de sync (✓ al día | ↓N por traer).
      const branch = `<span class="tk-branch${st.branch && st.branch !== 'main' ? ' tk-branch--warn' : ''}" title="branch actual${st.branch && st.branch !== 'main' ? ' — no es main' : ''}">${icon('gitBranch', { size: 12 })}${esc(st.branch || 'main')}</span>`;
      const sync = st.behind > 0
        ? `<span class="tk-sync tk-sync--due" title="${st.behind} commit(s) nuevos en GitHub para traer">↓${st.behind} por traer</span>`
        : `<span class="tk-sync tk-sync--ok" title="Sin cambios nuevos en GitHub">${icon('check', { size: 12 })}al día</span>`;

      // Línea 2: sin-commitear (ícono+nº, solo si dirty) + frescura del fetch.
      const dirty = st.dirty
        ? `<span class="tk-dirty" title="${st.dirtyCount} archivo(s) sin commitear en el árbol de trabajo">${icon('edit', { size: 12 })}${st.dirtyCount}</span>`
        : '';
      const fetched = st.lastFetch
        ? `<span class="tk-fresh" title="Último chequeo del remoto">${icon('clock', { size: 12 })}${fmtAgo(st.lastFetch)}</span>`
        : '';
      const line2 = (dirty || fetched) ? `<div class="tk-line tk-line--dim">${dirty}${fetched}</div>` : '';

      // Línea 3: pulso — último commit (hora + autor corto; asunto en tooltip).
      const commit = st.subject
        ? `<div class="tk-line tk-line--dim tk-commit" title="${esc(st.subject)}">${icon('gitCommit', { size: 12 })}${fmtAgo(st.date)} · ${esc(shortAuthor(st.author))}</div>`
        : '';

      refs.info.innerHTML = `<div class="tk-line tk-line1">${branch}${sync}</div>${line2}${commit}`;
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
    refs.fetch.addEventListener('click', checkRemote); // Buscar cambios (fetch)

    (async () => {
      await loadStatus();
      checkRemote();
    })();

    const CHECK_MS = 5 * 60 * 1000;
    setInterval(() => { if (!document.hidden) checkRemote(); }, CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });
  },
};
