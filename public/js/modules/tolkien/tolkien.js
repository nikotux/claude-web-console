// modules/tolkien/tolkien.js — tarjeta de VERSIÓN del proyecto principal (git).
//
// Propósito (acotado a pedido del usuario): responder UNA sola pregunta —
// "¿mi copia local coincide con main?" — y mostrar el identificador de la
// versión actual (SHA corto) para cruzarlo contra GitHub. NADA de PRs ni de
// "commits adelante": eso vive en la sección Tickets. Info mostrada:
//   #SHA · branch · al día / ↓N por traer          ← ¿estoy en la última main?
//   (gris) N sin commitear · último fetch           ← nota, NO afecta el estado
//   (gris) último commit (autor · hace X)           ← pulso: ¿Chris mergeó algo?
// Semáforo: 🟢 al día con main (behind=0) · 🟡 hay N versiones nuevas por traer.
// Los archivos sin commitear (dirty) son SOLO nota gris y NO cambian el color.
// Acciones (header): 🔄 fetch · ⬇ pull (stash→pull→pop, no destructivo) · 💽 data.
// El auto-fetch cada 5 min (y en visibilitychange) mantiene fresco el "detrás".

export default {
  name: 'tolkien',

  mount(el, ctx) {
    const { icon, dialog } = ctx;
    let current = null;
    let busy = false;
    let dataBusy = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="Estado del repo"></span>
        <span class="sec-title">Tolkien</span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="fetch" title="Buscar cambios en GitHub (fetch)">${icon('refresh', { size: 14 })}</button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="update" title="Descargar cambios (pull: stash → pull → pop)">${icon('download', { size: 14 })}</button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refreshData" title="Vista fresca: borrar data local + recargar de Zoho">${icon('disk', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="tk-info" data-ref="info">cargando…</div>
        <div class="tk-actions">
          <a class="btn-ghost btn--sm tk-link tk-link--local" href="/api/tolkien/local-enter" target="_blank" rel="noopener" title="Entrar al Tolkien local ya logueado (la consola inyecta la sesión dev-login · ZeroTier)">${icon('externalLink', { size: 13 })}<span>Tolkien local</span></a>
          <a class="btn-ghost btn--sm tk-link tk-link--oficial" href="https://app.tolkien.mordorstaffing.com" target="_blank" rel="noopener" title="Abrir la app oficial de Tolkien (producción)">${icon('externalLink', { size: 13 })}<span>Tolkien oficial</span></a>
        </div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    // Clic en el SHA → copiar al portapapeles (para cruzar la versión con GitHub).
    // Delegado en el contenedor: sobrevive a los re-render de refs.info.
    refs.info.addEventListener('click', (e) => {
      const v = e.target.closest && e.target.closest('.tk-version');
      if (!v) return;
      const sha = v.dataset.sha || v.textContent.replace(/^#/, '');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(sha).then(() => {
          v.classList.add('is-copied');
          setTimeout(() => v.classList.remove('is-copied'), 1200);
        }).catch(() => {});
      }
    });

    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
      refs.fetch.disabled = busy || dataBusy;
      refs.update.disabled = busy || dataBusy;
      if (refs.refreshData) {
        refs.refreshData.disabled = busy || dataBusy;
        refs.refreshData.classList.toggle('is-busy', dataBusy);
        refs.refreshData.title = dataBusy ? 'Recargando data local…' : 'Vista fresca: borrar data local + recargar de Zoho';
      }
      // Semáforo (visible colapsado): amarillo si hay commits por traer o
      // cambios sin commitear; verde si está al día y limpio; tenue sin datos.
      if (refs.dot) {
        // Semáforo = SOLO sync vs main. dirty (sin commitear) NO influye: es
        // ruido local (untracked que viven siempre en el árbol) y falseaba el
        // amarillo. 🟢 al día con main · 🟡 hay versiones nuevas por traer.
        const dstate = !st ? 'idle' : (st.behind > 0 ? 'warn' : 'ok');
        refs.dot.className = `sec-dot sec-dot--${dstate}`;
        refs.dot.title = !st ? 'Sin datos'
          : (st.behind > 0 ? `${st.behind} versión(es) nueva(s) en main por traer` : 'Al día con main');
      }
      // El pull resalta cuando hay commits nuevos para traer.
      refs.update.classList.toggle('tk-update--due', !!st && st.behind > 0);
      refs.update.title = st && st.behind > 0
        ? `Descargar: ${st.behind} commit(s) nuevos para traer`
        : 'Descargar cambios (pull: stash → pull → pop)';

      if (!st) { refs.info.innerHTML = busy ? '<span class="cwc-spinner"></span>' : '…'; return; }

      // Línea 1: #SHA (versión actual, clic-para-copiar) + branch (⚠ si ≠ main)
      // + estado de sync vs main (✓ al día | ↓N por traer).
      const version = st.head
        ? `<span class="tk-version" data-sha="${esc(st.head)}" role="button" tabindex="0" title="Versión actual (SHA ${esc(st.head)}) — clic para copiar y cruzar con GitHub">#${esc(st.head)}</span>`
        : '';
      const branch = `<span class="tk-branch${st.branch && st.branch !== 'main' ? ' tk-branch--warn' : ''}" title="branch actual${st.branch && st.branch !== 'main' ? ' — no es main' : ''}">${icon('gitBranch', { size: 12 })}${esc(st.branch || 'main')}</span>`;
      const sync = st.behind > 0
        ? `<span class="tk-sync tk-sync--due" title="${st.behind} commit(s) nuevos en GitHub para traer">↓${st.behind} por traer</span>`
        : `<span class="tk-sync tk-sync--ok" title="Sin cambios nuevos en GitHub">${icon('check', { size: 12 })}al día</span>`;

      // Línea 2: sin-commitear (ícono+nº, solo si dirty) + frescura del fetch.
      const dirty = st.dirty
        ? `<span class="tk-dirty" title="${st.dirtyCount} archivo(s) sin commitear en el árbol de trabajo — nota local, NO afecta si estás al día con main">${icon('edit', { size: 12 })}${st.dirtyCount}</span>`
        : '';
      const fetched = st.lastFetch
        ? `<span class="tk-fresh" title="Último chequeo del remoto">${icon('clock', { size: 12 })}${fmtAgo(st.lastFetch)}</span>`
        : '';
      const line2 = (dirty || fetched) ? `<div class="tk-line tk-line--dim">${dirty}${fetched}</div>` : '';

      // Línea 3: pulso — último commit (hora + autor corto; asunto en tooltip).
      const commit = st.subject
        ? `<div class="tk-line tk-line--dim tk-commit" title="${esc(st.subject)}">${icon('gitCommit', { size: 12 })}${fmtAgo(st.date)} · ${esc(shortAuthor(st.author))}</div>`
        : '';

      const dataNote = dataBusy
        ? `<div class="tk-line tk-line--dim"><span class="cwc-spinner"></span> actualizando data local…</div>`
        : '';
      refs.info.innerHTML = `<div class="tk-line tk-line1">${version}${branch}${sync}</div>${line2}${commit}${dataNote}`;
    }

    async function loadStatus() {
      try { current = await (await fetch('/api/tolkien/status')).json(); render(); }
      catch { /* noop */ }
    }

    async function checkRemote() {
      if (busy) return;
      busy = true; render();
      try {
        const res = await fetch('/api/tolkien/fetch', { method: 'POST' });
        const data = await res.json();
        if (data.status) current = data.status;
        if (!res.ok || data.error) {
          await dialog.alertDialog({
            title: 'No se pudo buscar cambios',
            message: data.error || 'No se pudo comprobar el estado remoto (respuesta inválida del servidor).',
          });
        }
      } catch {
        await dialog.alertDialog({ title: 'Tolkien', message: 'No se pudo buscar cambios (error de red o del servidor).' });
      } finally { busy = false; render(); }
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
        const res = await fetch('/api/tolkien/update', { method: 'POST' });
        const data = await res.json();
        if (data.status) current = data.status;
        if (!res.ok || data.error) {
          await dialog.alertDialog({
            title: 'No se pudo actualizar',
            message: `${data.error || 'No se pudo actualizar (respuesta inválida del servidor).'}\n\n${fmtLog(data.log)}`,
          });
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

    async function doRefreshData() {
      if (dataBusy || busy) return;
      const ok = await dialog.confirmDialog({
        title: 'Vista fresca (borrar + recargar)',
        message: 'Deja tu DB LOCAL como un snapshot LIMPIO y actual de Zoho:\n\n1) BORRA las tablas operativas (empleados, clientes, billing, invoices, PTO, teams…).\n2) Reimporta de cero (clients → employees → links).\n\n⚠️ Se pierden TODAS las ediciones locales de esos datos (es la idea: sin merge, sin conflictos). Se preservan login y config. No toca prod ni tu código.',
        confirmLabel: 'Borrar y recargar',
      });
      if (!ok) return;
      dataBusy = true; render();
      try {
        // Arranca el job en background (vuelve al instante, sin request larga).
        const startRes = await fetch('/api/tolkien/refresh-data', { method: 'POST' });
        if (!startRes.ok) {
          const d = await startRes.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${startRes.status}`);
        }
        // Polling del estado hasta que termina (o timeout de guarda a 5 min).
        const deadline = Date.now() + 5 * 60 * 1000;
        let status = null;
        // Pequeño respiro antes del primer poll para que el job arranque.
        await new Promise((r) => setTimeout(r, 800));
        while (Date.now() < deadline) {
          const st = await fetch('/api/tolkien/refresh-data/status');
          status = await st.json();
          if (!status.running) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (status && status.running) {
          throw new Error('El refresh sigue corriendo tras 5 min — revisá el server.');
        }
        if (status && status.error) {
          await dialog.alertDialog({ title: 'No se pudo actualizar la data', message: status.error });
        } else {
          const data = (status && status.result) || {};
          const REAL_IMPORTERS = ['clients', 'employees', 'employee-client-links'];
          const summary = (data.steps || [])
            .map((s) => {
              if (s.failed) return `✗ ${s.importer}: ${s.error || 'falló'}`;
              if (!REAL_IMPORTERS.includes(s.importer)) return `✓ ${s.importer}: listo`;
              return `✓ ${s.importer}: +${s.creates} nuevos · ${s.updates} act. · ${s.softDeletes} baja`;
            })
            .join('\n');
          await dialog.alertDialog({
            title: data.ok ? '✅ Data local actualizada' : '⚠️ Actualización con errores',
            message: `${summary || 'Sin detalle.'}\n\n(${Math.round((data.durationMs || 0) / 1000)}s)`,
          });
        }
      } catch (err) {
        await dialog.alertDialog({ title: 'Tolkien', message: err?.message || 'No se pudo actualizar la data (error de red o del servidor).' });
      } finally {
        dataBusy = false; render();
      }
    }

    refs.update.addEventListener('click', doUpdate);
    refs.fetch.addEventListener('click', checkRemote); // Buscar cambios (fetch)
    refs.refreshData.addEventListener('click', doRefreshData); // Actualizar data local (importers)

    (async () => {
      await loadStatus();
      checkRemote();
    })();

    const CHECK_MS = 5 * 60 * 1000;
    setInterval(() => { if (!document.hidden) checkRemote(); }, CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });
  },
};
