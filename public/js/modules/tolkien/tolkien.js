// modules/tolkien/tolkien.js — tarjeta del proyecto principal (git).
//
// Estado git (chip ✓/↓N, #SHA, cambios locales) + acciones:
//   [Continuar aquí] → enfoca la pestaña del proyecto o crea sesión Claude ahí
//   [Explorar]       → Explorador posicionado en el proyecto
//   [Actualizar]     → stash → pull --ff-only → stash pop (no destructivo)
//   [Enviar PR]      → (admin) actualiza el repo y sube un PR por cada fix
//                      PENDIENTE con archivos del registro de bugfixes.
//                      EXCLUSIVO de ~/tolkien: no toca nada fuera de esa
//                      carpeta (guard también en el backend).
// Chequeo automático contra el remoto cada 5 minutos.
export default {
  name: 'tolkien',

  mount(el, ctx) {
    const { icon, dialog, openSession, focusSession, findSessionByCwd } = ctx;
    let current = null;
    let busy = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-title">Tolkien</span>
        <span class="tk-chip" data-ref="chip"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Chequear remoto (fetch)">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="tk-state-line" data-ref="state">cargando…</div>
        <div class="tk-actions">
          <button class="btn-ghost btn--sm" data-ref="continue">${icon('sparkle', { size: 13 })}<span>Continuar aquí</span></button>
          <a class="btn-ghost btn--sm" data-ref="explore" href="/archivos?path=tolkien">${icon('folder', { size: 13 })}<span>Explorar</span></a>
          <button class="btn-ghost btn--sm" data-ref="update">${icon('download', { size: 13 })}<span>Actualizar</span></button>
          <button class="btn-ghost btn--sm" data-ref="sendpr" hidden title="Actualiza el repo y sube los fixes pendientes del registro como PRs">${icon('gitBranch', { size: 13 })}<span>Enviar PR</span></button>
        </div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    const upToDate = (st) => !!st && st.behind === 0;
    function stateText(st) {
      if (!st) return '…';
      let s;
      if (st.behind > 0) s = `${st.behind} detrás`;
      else if (st.ahead > 0) s = `${st.ahead} adelante`;
      else s = 'al día';
      if (st.dirty) s += ` · ${st.dirtyCount} cambios`;
      return s;
    }

    function render() {
      const st = current;
      const cls = upToDate(st) ? 'ok' : 'behind';
      refs.chip.className = `tk-chip ${cls}`;
      refs.chip.innerHTML = st ? (upToDate(st) ? icon('check', { size: 12 }) : `↓${st.behind}`) : '';
      refs.state.innerHTML = st
        ? `<span class="tk-head">#${st.head}</span> · <span class="tk-state ${cls}">${stateText(st)}</span>`
        : busy ? '<span class="cwc-spinner"></span>' : '…';
      refs.update.disabled = busy;
      refs.refresh.disabled = busy;
      refs.sendpr.disabled = busy;
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

    // ===== Enviar PR: actualizar el repo + subir los fixes pendientes =====
    // Orquesta endpoints existentes: /api/tolkien/update y /api/bugfixes/pr
    // (uno por fix). Todo acotado a ~/tolkien; el backend además rechaza
    // registros de cualquier otro cwd.
    async function doSendPrs() {
      if (busy) return;
      let pendientes = [];
      try {
        const { bugfixes } = await (await fetch('/api/bugfixes')).json();
        pendientes = (bugfixes || []).filter((b) => b.status === 'pendiente' && b.files?.length);
      } catch {
        return dialog.alertDialog({ title: 'Enviar PR', message: 'No se pudo leer el registro de bugfixes.' });
      }
      if (!pendientes.length) {
        return dialog.alertDialog({
          title: 'Enviar PR',
          message: 'No hay fixes pendientes con archivos editados.\n(El registro vive en ⚙ Sistema → Salud → Bugfixes; "Buscar no registrados" rescata chats viejos.)',
        });
      }
      const ok = await dialog.confirmDialog({
        title: 'Enviar PR a Tolkien',
        message: `1. Se actualiza el repo (stash → pull → stash pop).\n2. Se sube UN PR por cada fix pendiente con archivos (${pendientes.length}):\n${pendientes.map((b) => `   • TKT #${b.ticketNumber} (${b.files.length} archivo/s)`).join('\n')}\n\nSolo se toca ~/tolkien; tu árbol de trabajo no cambia de branch.`,
        confirmLabel: `Actualizar y subir ${pendientes.length} PR(s)`,
      });
      if (!ok) return;
      busy = true; render();
      try {
        // Paso 1: actualizar. Si falla o el stash pop conflictúa, NO seguimos:
        // los archivos del fix se copian del árbol y deben estar íntegros.
        const up = await (await fetch('/api/tolkien/update', { method: 'POST' })).json();
        if (up.status) current = up.status;
        if (up.error) {
          return await dialog.alertDialog({ title: 'Enviar PR — actualización falló', message: `${up.error}\n\n${fmtLog(up.log)}\nNo se subió ningún PR.` });
        }
        if (up.popConflict) {
          return await dialog.alertDialog({
            title: 'Enviar PR — conflicto al actualizar',
            message: 'Tus cambios locales quedaron en el stash (conflicto al reaplicarlos). Resolvelo antes de subir PRs: los archivos del fix se copian del árbol de trabajo.',
          });
        }
        // Paso 2: un PR por fix, secuencial (cada uno re-fetchea origin/main).
        const results = [];
        for (const b of pendientes) {
          try {
            const res = await fetch('/api/bugfixes/pr', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: b.sessionId }),
            });
            const data = await res.json().catch(() => ({}));
            results.push(res.ok
              ? `✓ TKT #${b.ticketNumber}: ${data.prUrl || data.branch}`
              : `✗ TKT #${b.ticketNumber}: ${data.error || 'falló'}`);
          } catch {
            results.push(`✗ TKT #${b.ticketNumber}: error de red`);
          }
        }
        await dialog.alertDialog({ title: 'Enviar PR — resultado', message: results.join('\n') });
      } finally {
        busy = false; render();
        loadStatus();
      }
    }

    refs.refresh.addEventListener('click', checkRemote);
    refs.update.addEventListener('click', doUpdate);
    refs.sendpr.addEventListener('click', doSendPrs);
    // El botón existe solo para admins (el backend igual lo exige).
    ctx.whoami?.then?.((me) => { if (me?.admin) refs.sendpr.hidden = false; });
    refs.continue.addEventListener('click', () => {
      const rel = current?.rel || 'tolkien';
      const existing = findSessionByCwd(rel);
      if (existing) focusSession(existing);
      else openSession({ cwd: rel, runClaude: true });
    });

    (async () => {
      await loadStatus();
      const rel = current?.rel || 'tolkien';
      refs.explore.href = `/archivos?path=${encodeURIComponent(rel)}`;
      checkRemote();
    })();

    const CHECK_MS = 5 * 60 * 1000;
    setInterval(() => { if (!document.hidden) checkRemote(); }, CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });
  },
};
