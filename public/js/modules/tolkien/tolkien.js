// modules/tolkien/tolkien.js — tarjeta de VERSIÓN del proyecto principal (git).
//
// Propósito: mantener tu MAIN LOCAL siempre sincronizado con el main de GitHub
// (base fresca para pushear encima de lo último de Chris) y mostrar qué ramas
// tuyas (PRs) siguen sin mergear. Info mostrada:
//   #SHA · branch · main al día / ↓N main           ← ¿mi main local está fresco?
//   (gris) N sin commitear · último fetch            ← nota, NO afecta el estado
//   (gris) último commit (autor · hace X)            ← pulso: ¿Chris mergeó algo?
//   (gris) 🌿 N PRs sin mergear (clic → ventana)     ← ramas que propuse, ↓N sobre main
// Semáforo: 🟢 main local == GitHub (mainBehind=0) · 🟡 hay N commits por traer.
// OJO: el semáforo lee `mainBehind` (main LOCAL vs origin/main), NO HEAD vs
// origin/main — así no se falsea estando parado en una rama feature. Los
// archivos sin commitear (dirty) son SOLO nota gris y NO cambian el color.
// Acciones (header): 🔄 fetch · ⬇ Actualizar (ff main, aunque estés en feature;
// stash→pull→pop si estás en main) · 💽 data. La línea 🌿 abre la ventana de PRs
// con "Poner al día" (rebase de la rama actual sobre main). El auto-fetch cada
// 5 min mantiene fresco el "detrás" (la consulta gh de /branches NO va ahí).
import { readCache, writeCache } from '../../ui/cache-store.js';

export default {
  name: 'tolkien',

  mount(el, ctx) {
    const { icon, dialog } = ctx;
    let current = null;
    let busy = false;
    let dataBusy = false;
    // Mis PRs abiertos sin mergear (de gh). null = todavía no consultado.
    let branchesData = null;
    let branchesBusy = false;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="Estado del repo"></span>
        <span class="sec-title">Tolkien</span>
        <span class="tk-ver-head" data-ref="ver" role="button" tabindex="0" title="Versión actual — clic para copiar"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="fetch" title="Buscar cambios en GitHub (fetch)">${icon('refresh', { size: 14 })}</button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="update" title="Descargar cambios (pull: stash → pull → pop)">${icon('download', { size: 14 })}</button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refreshData" title="Vista fresca: borrar data local + recargar de Zoho">${icon('disk', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="tk-info" data-ref="info">cargando…</div>
        <div class="tk-actions">
          <a class="btn-ghost btn--sm tk-link tk-link--local" href="/api/tolkien/local-enter" target="_blank" rel="noopener" title="Entrar al Tolkien local ya logueado (la consola inyecta la sesión dev-login · ZeroTier)">${icon('externalLink', { size: 13 })}<span>Tolkien local</span></a>
          <a class="btn-ghost btn--sm tk-link tk-link--oficial" href="https://app.tolkien.mordorstaffing.com" target="_blank" rel="noopener" title="Abrir la app oficial de Tolkien (producción)">${icon('externalLink', { size: 13 })}<span>Tolkien oficial</span></a>
          <a class="btn-ghost btn--sm tk-link tk-link--pad" href="http://${location.hostname}:7777" target="_blank" rel="noopener" title="Abrir el Pad local self-hosted (workspace console) en una pestaña nueva">${icon('externalLink', { size: 13 })}<span>GetPad local</span></a>
        </div>
      </div>`;

    const refs = {};
    for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

    function copySha(v) {
      const sha = v.dataset.sha || v.textContent.replace(/^#/, '');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(sha).then(() => {
          v.classList.add('is-copied');
          setTimeout(() => v.classList.remove('is-copied'), 1200);
        }).catch(() => {});
      }
    }

    // Clic en el SHA → copiar al portapapeles (para cruzar la versión con GitHub).
    // Delegado en el contenedor: sobrevive a los re-render de refs.info.
    refs.info.addEventListener('click', (e) => {
      // Clic en el contador de ramas → abre la ventana de PRs sin mergear.
      const br = e.target.closest && e.target.closest('.tk-branches');
      if (br && branchesData?.ok && (branchesData.branches || []).length) {
        openBranchesDialog();
        return;
      }
      // Clic en el SHA → copiar al portapapeles.
      const v = e.target.closest && e.target.closest('.tk-version');
      if (!v) return;
      copySha(v);
    });
    refs.ver?.addEventListener('click', () => {
      if (refs.ver.dataset.sha) copySha(refs.ver);
    });
    refs.ver?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!refs.ver.dataset.sha) return;
      e.preventDefault();
      copySha(refs.ver);
    });
    // Teclado: Enter/Espacio sobre el contador de ramas.
    refs.info.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const br = e.target.closest && e.target.closest('.tk-branches');
      if (br && branchesData?.ok && (branchesData.branches || []).length) {
        e.preventDefault();
        openBranchesDialog();
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
      // mainBehind = commits de origin/main que tu main LOCAL todavía no tiene.
      // Es la pregunta REAL ("¿mi base está fresca?"), independiente de en qué
      // rama estés parado. Fallback a behind para runners viejos sin el campo.
      const mb = st ? (st.mainBehind ?? st.behind ?? 0) : 0;
      if (refs.dot) {
        // Semáforo = SOLO frescura de main local vs GitHub. dirty (sin commitear)
        // NO influye: es ruido local. 🟢 main al día · 🟡 hay commits por traer.
        const dstate = !st ? 'idle' : (mb > 0 ? 'warn' : 'ok');
        refs.dot.className = `sec-dot sec-dot--${dstate}`;
        refs.dot.title = !st ? 'Sin datos'
          : (mb > 0 ? `Tu main local está ${mb} commit(s) atrás de GitHub` : 'Tu main local está al día con GitHub');
      }
      // El pull resalta cuando hay commits de main nuevos para traer.
      refs.update.classList.toggle('tk-update--due', !!st && mb > 0);
      refs.update.title = st && mb > 0
        ? `Actualizar: traer ${mb} commit(s) nuevos de main (deja tu main local = GitHub)`
        : 'Actualizar: dejar tu main local = GitHub (stash → pull → pop si estás en main)';

      if (!st) {
        if (refs.ver) {
          refs.ver.textContent = '';
          refs.ver.dataset.sha = '';
        }
        refs.info.innerHTML = busy ? '<span class="cwc-spinner"></span>' : '…';
        return;
      }

      if (refs.ver) {
        if (st.head) {
          refs.ver.textContent = '#' + st.head;
          refs.ver.dataset.sha = st.head;
          refs.ver.style.display = '';
        } else {
          refs.ver.textContent = '';
          refs.ver.dataset.sha = '';
        }
      }

      // Línea 1: branch (solo ⚠ si ≠ main) + estado de sync vs main
      // (✓ al día | ↓N por traer).
      const branch = (st.branch && st.branch !== 'main')
        ? `<span class="tk-branch tk-branch--warn" title="branch actual — no es main">${icon('gitBranch', { size: 12 })}${esc(st.branch)}</span>`
        : '';
      const sync = mb > 0
        ? `<span class="tk-sync tk-sync--due" title="Tu main local está ${mb} commit(s) atrás de GitHub">↓${mb} main</span>`
        : `<span class="tk-sync tk-sync--ok" title="Tu main local está al día con GitHub">${icon('check', { size: 12 })}main al día</span>`;

      // Línea 4: mis PRs abiertos sin mergear (ramas que propuse y Chris aún no
      // mergeó). Ícono de ramas; 🟡 si alguno quedó atrás de main (necesita
      // rebase), 🟢 si están al día o no hay ninguno. Clic → ventana con detalle
      // y el botón "poner al día" de la rama actual.
      let branchLine = '';
      if (branchesData) {
        if (branchesData.ok) {
          const brs = branchesData.branches || [];
          const anyBehind = brs.some((b) => (b.behindMain || 0) > 0);
          if (brs.length === 0) {
            branchLine = `<span class="tk-branches tk-branches--ok" title="No tenés PRs abiertos esperando merge — Chris mergeó todo lo que propusiste">${icon('gitBranch', { size: 12 })}0 PRs sin mergear</span>`;
          } else {
            const lbl = `${brs.length} PR${brs.length > 1 ? 's' : ''} sin mergear`;
            const titleList = brs.map((b) => `#${b.number} ${b.branch}${b.behindMain > 0 ? ` (↓${b.behindMain} sobre main)` : ''}`).join(' · ');
            branchLine = `<span class="tk-branches ${anyBehind ? 'tk-branches--due' : 'tk-branches--ok'}" role="button" tabindex="0" title="${esc(titleList)} — clic para ver y poner al día">${icon('gitBranch', { size: 12 })}${lbl}${anyBehind ? ' ⚠' : ''}</span>`;
          }
        } else if (branchesData.error) {
          branchLine = `<span class="tk-branches" title="No se pudo consultar tus PRs con gh: ${esc(branchesData.error)}">${icon('gitBranch', { size: 12 })}PRs n/d</span>`;
        }
      }

      const dataNote = dataBusy
        ? `<div class="tk-line tk-line--dim"><span class="cwc-spinner"></span> actualizando data local…</div>`
        : '';
      refs.info.innerHTML = `<div class="tk-line tk-line1 tk-line--split">${branch}${sync}<span class="tk-spacer"></span>${branchLine}</div>${dataNote}`;
    }

    async function loadStatus() {
      // Cache-then-network: pinta el último estado del repo al instante.
      const cached = readCache('tolkien-status');
      if (cached) { current = cached.data; render(); }
      try {
        current = await (await fetch('/api/tolkien/status')).json();
        writeCache('tolkien-status', current);
        render();
      } catch { /* noop */ }
    }

    // Consulta mis PRs abiertos (gh). Cuesta una llamada de red a GitHub, así
    // que NO va en el auto-refresh de 5 min: solo al montar, tras Actualizar y
    // al abrir la ventana de ramas.
    async function loadBranches() {
      if (branchesBusy) return;
      branchesBusy = true;
      try {
        branchesData = await (await fetch('/api/tolkien/branches')).json();
      } catch {
        branchesData = { ok: false, branches: [], error: 'error de red' };
      } finally {
        branchesBusy = false; render();
      }
    }

    async function doRebase(branch) {
      const ok = await dialog.confirmDialog({
        title: 'Poner esta rama al día sobre main',
        message: `Se rebasa "${branch}" sobre el último main de GitHub para seguir trabajando en paralelo.\n\n• Si hay conflicto se ABORTA y tu rama queda EXACTAMENTE como está (nada se pierde).\n• Tras el rebase, el PR va a necesitar force-push cuando lo re-envíes.`,
        confirmLabel: 'Rebasar',
      });
      if (!ok) return false;
      try {
        const res = await fetch('/api/tolkien/rebase-branch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ branch }),
        });
        const data = await res.json();
        if (data.status) current = data.status;
        if (!res.ok || data.error) {
          await dialog.alertDialog({
            title: data.conflict ? 'Conflicto al rebasar' : 'No se pudo rebasar',
            message: `${data.error || 'Error inesperado.'}\n\n${fmtLog(data.log)}`,
          });
          return false;
        }
        await dialog.alertDialog({
          title: data.noop ? 'Nada que hacer' : '✅ Rama al día',
          message: `${data.message || 'Listo.'}\n\n${fmtLog(data.log)}`,
        });
        return true;
      } catch {
        await dialog.alertDialog({ title: 'Tolkien', message: 'No se pudo rebasar (error de red o del servidor).' });
        return false;
      } finally {
        render();
      }
    }

    function openBranchesDialog() {
      const brs = (branchesData?.branches) || [];
      const m = dialog.openModal({ title: '🌿 PRs abiertos sin mergear', width: 460 });
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <p class="dlg-msg" style="margin-bottom:.6rem">Ramas que propusiste y Chris todavía no mergeó. <b>Poner al día</b> aparece solo en la <b>rama actual</b> cuando quedó atrás de main (por seguridad solo se rebasea la rama en la que estás parado).</p>
        <div class="tk-brlist">${brs.map((b) => {
          const behind = b.behindMain;
          const state = behind == null ? '<span class="tk-br-state">?</span>'
            : behind > 0 ? `<span class="tk-br-state tk-br-state--due">↓${behind} sobre main</span>`
              : `<span class="tk-br-state tk-br-state--ok">al día</span>`;
          const cur = b.isCurrent ? '<span class="tk-br-cur" title="Estás parado acá">● actual</span>' : '';
          const num = b.url
            ? `<a href="${esc(b.url)}" target="_blank" rel="noopener" class="tk-br-num">#${b.number}</a>`
            : `<span class="tk-br-num">#${b.number}</span>`;
          const btn = (b.isCurrent && behind > 0)
            ? `<button class="btn btn--sm tk-br-rebase" data-branch="${esc(b.branch)}">Poner al día</button>` : '';
          return `<div class="tk-br-row">
            <div class="tk-br-main">${num} ${cur}<div class="tk-br-title" title="${esc(b.title)}">${esc(b.title)}</div><div class="tk-br-branch">${esc(b.branch)}</div></div>
            <div class="tk-br-side">${state}${btn}</div>
          </div>`;
        }).join('') || '<p class="dlg-msg">No hay PRs abiertos. 🎉</p>'}</div>`;
      m.body.appendChild(wrap);
      wrap.addEventListener('click', async (e) => {
        const btn = e.target.closest && e.target.closest('.tk-br-rebase');
        if (!btn) return;
        const branch = btn.dataset.branch;
        btn.disabled = true;
        const done = await doRebase(branch);
        if (done) { m.close(); await loadStatus(); await loadBranches(); }
        else btn.disabled = false;
      });
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
        } else if (data.warn) {
          // Caso raro: estás en una rama feature y tu main local no pudo
          // adelantar solo (divergió o tiene commits propios). Tu rama quedó
          // intacta; solo avisamos.
          await dialog.alertDialog({ title: 'Actualizado (con aviso)', message: `${data.warn}\n\n${fmtLog(data.log)}` });
        }
      } catch {
        await dialog.alertDialog({ title: 'Tolkien', message: 'No se pudo actualizar (error de red o del servidor).' });
      } finally {
        busy = false; render();
        // Chris pudo haber mergeado un PR mientras tanto: refrescamos la lista.
        loadBranches();
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
      loadBranches(); // consulta mis PRs abiertos (gh, red) — sin bloquear
    })();

    const CHECK_MS = 5 * 60 * 1000;
    setInterval(() => { if (!document.hidden) checkRemote(); }, CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });
  },
};
