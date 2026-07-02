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

    // ===== Enviar PR: ventana de gestión de PRs de bugfixes =====
    // Muestra el historial (qué tenía cada PR, cuándo se envió, si Chris lo
    // mergeó a main) + acciones: enviar pendientes (actualiza el repo antes),
    // re-buscar bugfixes en chats viejos y refrescar el estado desde GitHub.
    // Todo acotado a ~/tolkien (el backend además rechaza otros cwd).
    const fmtDate = (ms) => {
      if (!ms) return '—';
      const d = new Date(ms);
      return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' +
        d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function prEstado(b) {
      if (b.status !== 'subido') return { dot: 'warn', label: 'pendiente' };
      if (b.prState === 'merged') return { dot: 'ok', label: `mergeado por ${b.mergedBy || '?'}` };
      if (b.prState === 'closed') return { dot: 'fail', label: 'cerrado sin merge' };
      return { dot: 'warn', label: 'PR abierto (sin mergear)' };
    }

    function openPrModal() {
      const m = dialog.openModal({ title: 'PRs de bugfixes — Tolkien', width: 680 });
      const wrap = document.createElement('div');
      wrap.className = 'bfm';
      wrap.innerHTML = `
        <div class="bfm-actions">
          <button class="btn btn--sm" data-ref="send" disabled>${icon('gitBranch', { size: 13 })}<span>Enviar pendientes</span></button>
          <button class="btn-ghost btn--sm" data-ref="scan" title="Re-busca en los chats de tickets cambios que no quedaron registrados">${icon('sparkle', { size: 13 })}<span>Buscar bugfixes</span></button>
          <button class="btn-ghost btn--sm" data-ref="ghsync" title="Trae de GitHub el estado actual: PRs del registro + PRs tuyos no registrados">${icon('refresh', { size: 13 })}<span>Actualizar</span></button>
          <span class="bfm-ghstate" data-ref="ghstate"></span>
        </div>
        <div class="bfm-box">
          <table class="bfm-table">
            <thead><tr><th></th><th>TKT</th><th>Título</th><th>Enviado</th><th>Estado</th><th>Merge</th></tr></thead>
            <tbody data-ref="tbody"><tr><td colspan="6"><span class="cwc-spinner"></span></td></tr></tbody>
          </table>
        </div>`;
      m.body.appendChild(wrap);
      const mr = {};
      for (const r of wrap.querySelectorAll('[data-ref]')) mr[r.dataset.ref] = r;
      let entries = []; // nuestro registro
      let ghRows = [];  // PRs míos en GitHub que NO están en el registro

      // Fila expandible: la fila de detalle vive a continuación (colspan 6).
      function detailHtml(b) {
        return `
          <p class="hp-bf-summary">${esc(b.summary || '(sin resumen)')}</p>
          ${b.files?.length ? `<p class="hp-bf-files">${b.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
          : '<p class="hp-bf-files hp-bf-files--none">Sin archivos editados (quedó en plan).</p>'}
          <p class="bfm-links">
            ${b.ticketUrl ? `<a href="${esc(b.ticketUrl)}" target="_blank" rel="noopener">Ticket #${esc(b.ticketNumber)} ↗</a>` : ''}
            ${b.prUrl ? `<a href="${esc(b.prUrl)}" target="_blank" rel="noopener">Ver PR ${b.prNumber ? `#${esc(b.prNumber)}` : ''} ↗</a>` : ''}
            ${b.branch ? `<code>${esc(b.branch)}</code>` : ''}
          </p>`;
      }

      function renderTable() {
        const pendientes = entries.filter((b) => b.status === 'pendiente' && b.files?.length);
        mr.send.disabled = !pendientes.length;
        mr.send.querySelector('span').textContent = pendientes.length ? `Enviar pendientes (${pendientes.length})` : 'Enviar pendientes';
        if (!entries.length && !ghRows.length) {
          mr.tbody.innerHTML = '<tr><td colspan="6" class="hp-empty">Sin fixes registrados ni PRs tuyos en GitHub.</td></tr>';
          return;
        }
        // Arriba lo accionable: pendientes con archivos, después pendientes en
        // plan, después enviados; al final los PRs que están SOLO en GitHub.
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
              <td class="bfm-date">${b.sentAt ? fmtDate(b.sentAt) : '—'}</td>
              <td class="bfm-state">${esc(est.label)}</td>
              <td class="bfm-date">${b.mergedAt ? `${esc(b.mergedBy || '?')} · ${fmtDate(b.mergedAt)}` : '—'}</td>
            </tr>
            <tr class="bfm-detail" hidden><td colspan="6">${detailHtml(b)}</td></tr>`);
        }
        for (const pr of ghRows) {
          const dot = pr.state === 'merged' ? 'ok' : pr.state === 'closed' ? 'fail' : 'warn';
          rows.push(`
            <tr class="bfm-row bfm-row--gh">
              <td><span class="hp-dot hp-dot--${dot}"></span></td>
              <td class="bfm-tkt" title="PR tuyo en GitHub sin registro de bugfix">GitHub</td>
              <td class="bfm-title"><a href="${esc(pr.url)}" target="_blank" rel="noopener">#${esc(pr.number)} ${esc(pr.title)}</a></td>
              <td class="bfm-date">${pr.createdAt ? fmtDate(pr.createdAt) : '—'}</td>
              <td class="bfm-state">${pr.state === 'merged' ? 'mergeado' : pr.state === 'closed' ? 'cerrado' : 'abierto'}</td>
              <td class="bfm-date">${pr.mergedAt ? `${esc(pr.mergedBy || '?')} · ${fmtDate(pr.mergedAt)}` : '—'}</td>
            </tr>`);
        }
        mr.tbody.innerHTML = rows.join('');
      }

      // Click en una fila del registro: despliega/pliega su detalle.
      mr.tbody.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // los links navegan, no despliegan
        const row = e.target.closest('.bfm-row');
        if (!row || row.classList.contains('bfm-row--gh')) return;
        const det = row.nextElementSibling;
        if (det?.classList.contains('bfm-detail')) det.hidden = !det.hidden;
      });

      async function reload() {
        try {
          const { bugfixes } = await (await fetch('/api/bugfixes')).json();
          entries = bugfixes || [];
          renderTable();
        } catch { mr.tbody.innerHTML = '<tr><td colspan="6" class="hp-empty">No se pudo leer el registro.</td></tr>'; }
      }

      // Sincronización con GitHub (al ABRIR el modal y con [Actualizar]):
      // refresca el estado de los PRs del registro y trae los PRs míos que no
      // están registrados. `silent` = apertura automática, sin alerts.
      async function ghSync(silent) {
        mr.ghsync.disabled = true;
        mr.ghstate.innerHTML = '<span class="cwc-spinner"></span> consultando GitHub…';
        try {
          const res = await fetch('/api/bugfixes/refresh-prs', { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Falló la consulta a GitHub.');
          entries = data.bugfixes || entries;
          ghRows = data.github || [];
          renderTable();
          mr.ghstate.textContent = `GitHub · ${fmtDate(Date.now())}`;
          if (data.errors?.length && !silent) {
            await dialog.alertDialog({ title: 'Actualizar desde GitHub', message: `Algunos PRs no se pudieron consultar:\n${data.errors.join('\n')}` });
          }
        } catch (err) {
          mr.ghstate.textContent = 'GitHub no disponible';
          if (!silent) await dialog.alertDialog({ title: 'Actualizar desde GitHub', message: err.message });
        } finally {
          mr.ghsync.disabled = false;
        }
      }

      // Enviar pendientes: actualizar el repo primero; si falla, no subir nada.
      mr.send.addEventListener('click', async () => {
        const pendientes = entries.filter((b) => b.status === 'pendiente' && b.files?.length);
        if (!pendientes.length) return;
        const ok = await dialog.confirmDialog({
          title: 'Enviar PR a Tolkien',
          message: `1. Se actualiza el repo (stash → pull → stash pop).\n2. Se sube UN PR por cada fix pendiente (${pendientes.length}):\n${pendientes.map((b) => `   • TKT #${b.ticketNumber} (${b.files.length} archivo/s)`).join('\n')}\n\nSolo se toca ~/tolkien; tu árbol no cambia de branch.`,
          confirmLabel: `Actualizar y subir ${pendientes.length} PR(s)`,
        });
        if (!ok) return;
        mr.send.disabled = true;
        mr.send.innerHTML = '<span class="cwc-spinner"></span><span>Subiendo…</span>';
        try {
          const up = await (await fetch('/api/tolkien/update', { method: 'POST' })).json();
          if (up.status) current = up.status;
          if (up.error || up.popConflict) {
            return await dialog.alertDialog({
              title: 'Enviar PR — actualización falló',
              message: up.error
                ? `${up.error}\n\n${fmtLog(up.log)}\nNo se subió ningún PR.`
                : 'Conflicto al reaplicar tus cambios locales (quedaron en el stash). Resolvelo antes de subir PRs.',
            });
          }
          const results = [];
          for (const b of pendientes) {
            try {
              const res = await fetch('/api/bugfixes/pr', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: b.sessionId }),
              });
              const data = await res.json().catch(() => ({}));
              results.push(res.ok ? `✓ TKT #${b.ticketNumber}: ${data.prUrl || data.branch}` : `✗ TKT #${b.ticketNumber}: ${data.error || 'falló'}`);
            } catch { results.push(`✗ TKT #${b.ticketNumber}: error de red`); }
          }
          await dialog.alertDialog({ title: 'Enviar PR — resultado', message: results.join('\n') });
        } finally {
          mr.send.innerHTML = `${icon('gitBranch', { size: 13 })}<span>Enviar pendientes</span>`;
          await reload();
          ghSync(true); // reflejar en el cuadro el estado real de lo recién subido
          loadStatus();
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

      // Al abrir: primero el cuadro con nuestro registro (instantáneo) y
      // enseguida la consulta a GitHub que lo completa.
      reload().then(() => ghSync(true));
    }

    refs.refresh.addEventListener('click', checkRemote);
    refs.update.addEventListener('click', doUpdate);
    refs.sendpr.addEventListener('click', openPrModal);
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
