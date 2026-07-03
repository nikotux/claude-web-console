// modules/tolkien/tolkien.js — tarjeta del proyecto principal (git).
//
// Estado git (chip ✓/↓N, #SHA, cambios locales) + acciones:
//   [Continuar aquí] → enfoca la pestaña del proyecto o crea sesión Claude ahí
//   [Explorar]       → Explorador posicionado en el proyecto
//   [Actualizar]     → stash → pull --ff-only → stash pop (no destructivo)
//   [Bugs & PRs]     → (admin) tablero unificado del ciclo del bug
//                      (bug-board.js: triage + fixes + PRs con GitHub en vivo).
// Chequeo automático contra el remoto cada 5 minutos.
import { openBugBoard } from './bug-board.js';

export default {
  name: 'tolkien',

  mount(el, ctx) {
    const { icon, dialog, openSession, focusSession, findSessionByCwd, openChat } = ctx;
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
          <button class="btn-ghost btn--sm" data-ref="sendpr" hidden title="Tablero unificado del ciclo del bug: triage, fixes, PRs con datos en vivo de GitHub y ticket en Desk">${icon('gitBranch', { size: 13 })}<span>Bugs & PRs</span></button>
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

    // "Actualizar repo" que usa el tablero antes de subir PRs: mismo endpoint
    // que [Actualizar], devolviendo {ok, message} para el flujo de envío.
    async function updateRepo() {
      try {
        const up = await (await fetch('/api/tolkien/update', { method: 'POST' })).json();
        if (up.status) current = up.status;
        if (up.error) return { ok: false, message: `${up.error}\n\n${fmtLog(up.log)}\nNo se subió ningún PR.` };
        if (up.popConflict) return { ok: false, message: 'Conflicto al reaplicar tus cambios locales (quedaron en el stash). Resolvelo antes de subir PRs.' };
        return { ok: true };
      } catch {
        return { ok: false, message: 'No se pudo actualizar el repo (red o servidor). No se subió ningún PR.' };
      } finally {
        loadStatus();
      }
    }

    refs.refresh.addEventListener('click', checkRemote);
    refs.update.addEventListener('click', doUpdate);
    refs.sendpr.addEventListener('click', () => openBugBoard({
      dialog, icon, openChat,
      projectRel: () => current?.rel || 'tolkien',
      updateRepo,
    }));
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
