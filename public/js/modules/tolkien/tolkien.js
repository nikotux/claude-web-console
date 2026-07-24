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
import { pacman } from '../../ui/pacman.js';
import { t } from '../../ui/i18n.js';

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
    let envsData = null;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-dot" data-ref="dot" title="${t('tolkien.header.repoStatus', 'Estado del repo')}"></span>
        <span class="sec-title">Tolkien</span>
        <span class="tk-ver-head" data-ref="ver" role="button" tabindex="0" title="${t('tolkien.header.versionCopy', 'Versión actual — clic para copiar')}"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="fetch" title="${t('tolkien.header.fetchTitle', 'Buscar cambios en GitHub (fetch)')}">${icon('refresh', { size: 14 })}</button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="update" title="${t('tolkien.header.updateTitle', 'Descargar cambios (pull: stash → pull → pop)')}">${icon('download', { size: 14 })}</button>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refreshData" title="${t('tolkien.header.refreshDataTitle', 'Vista fresca: borrar data local + recargar de Zoho')}">${icon('disk', { size: 14 })}</button>
      </header>
      <div class="tk-card">
        <div class="tk-info" data-ref="info">${t('tolkien.info.loading', 'cargando…')}</div>
        <div class="tk-actions">
          <a class="btn-ghost btn--sm tk-link tk-link--local" href="/api/tolkien/local-enter" target="_blank" rel="noopener" title="${t('tolkien.links.localTitle', 'Entrar al Tolkien local ya logueado (la consola inyecta la sesión dev-login · ZeroTier)')}">${icon('externalLink', { size: 13 })}<span>${t('tolkien.links.local', 'Tolkien local')}</span></a>
          <a class="btn-ghost btn--sm tk-link tk-link--oficial" href="https://app.tolkien.mordorstaffing.com" target="_blank" rel="noopener" title="${t('tolkien.links.oficialTitle', 'Abrir la app oficial de Tolkien (producción)')}">${icon('externalLink', { size: 13 })}<span>${t('tolkien.links.oficial', 'Tolkien oficial')}</span></a>
          <a class="btn-ghost btn--sm tk-link tk-link--pad" href="http://${location.hostname}:7777" target="_blank" rel="noopener" title="${t('tolkien.links.padTitle', 'Abrir el Pad local self-hosted (workspace console) en una pestaña nueva')}">${icon('externalLink', { size: 13 })}<span>${t('tolkien.links.pad', 'GetPad local')}</span></a>
        </div>
        <details class="tk-envs">
          <summary>${icon('gitBranch', { size: 12 })} <span>${t('tolkien.envs.title', 'Entornos de sesión')}</span> <span data-ref="envsCount"></span></summary>
          <div data-ref="envsList"></div>
        </details>
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
      if (s < 60) return t('tolkien.ago.justNow', 'recién');
      if (s < 3600) return t('tolkien.ago.min', 'hace {n} min', { n: Math.floor(s / 60) });
      if (s < 86400) return t('tolkien.ago.hour', 'hace {n} h', { n: Math.floor(s / 3600) });
      return t('tolkien.ago.day', 'hace {n} d', { n: Math.floor(s / 86400) });
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
        refs.refreshData.title = dataBusy ? t('tolkien.header.refreshDataBusy', 'Recargando data local…') : t('tolkien.header.refreshDataTitle', 'Vista fresca: borrar data local + recargar de Zoho');
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
        refs.dot.title = !st ? t('tolkien.dot.noData', 'Sin datos')
          : (mb > 0 ? t('tolkien.dot.behind', 'Tu main local está {mb} commit(s) atrás de GitHub', { mb }) : t('tolkien.dot.upToDate', 'Tu main local está al día con GitHub'));
      }
      // El pull resalta cuando hay commits de main nuevos para traer.
      refs.update.classList.toggle('tk-update--due', !!st && mb > 0);
      refs.update.title = st && mb > 0
        ? t('tolkien.update.dueTitle', 'Actualizar: traer {mb} commit(s) nuevos de main (deja tu main local = GitHub)', { mb })
        : t('tolkien.update.title', 'Actualizar: dejar tu main local = GitHub (stash → pull → pop si estás en main)');

      if (!st) {
        if (refs.ver) {
          refs.ver.textContent = '';
          refs.ver.dataset.sha = '';
        }
        refs.info.innerHTML = busy ? pacman({ size: 'sm' }) : '…';
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
        ? `<span class="tk-branch tk-branch--warn" title="${t('tolkien.branch.notMainTitle', 'branch actual — no es main')}">${icon('gitBranch', { size: 12 })}${esc(st.branch)}</span>`
        : '';
      const sync = mb > 0
        ? `<span class="tk-sync tk-sync--due" title="${t('tolkien.dot.behind', 'Tu main local está {mb} commit(s) atrás de GitHub', { mb })}">${t('tolkien.sync.due', '↓{mb} main', { mb })}</span>`
        : `<span class="tk-sync tk-sync--ok" title="${t('tolkien.dot.upToDate', 'Tu main local está al día con GitHub')}">${icon('check', { size: 12 })}${t('tolkien.sync.upToDate', 'main al día')}</span>`;

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
            branchLine = `<span class="tk-branches tk-branches--ok" title="${t('tolkien.branches.zeroTitle', 'No tenés PRs abiertos esperando merge — Chris mergeó todo lo que propusiste')}">${icon('gitBranch', { size: 12 })}${t('tolkien.branches.zero', '0 PRs sin mergear')}</span>`;
          } else {
            const lbl = t('tolkien.branches.unmergedLabel', '{n} PR{s} sin mergear', { n: brs.length, s: brs.length > 1 ? 's' : '' });
            const titleList = brs.map((b) => `#${b.number} ${b.branch}${b.behindMain > 0 ? t('tolkien.branches.overMain', ' (↓{n} sobre main)', { n: b.behindMain }) : ''}`).join(' · ');
            branchLine = `<span class="tk-branches ${anyBehind ? 'tk-branches--due' : 'tk-branches--ok'}" role="button" tabindex="0" title="${esc(titleList)}${t('tolkien.branches.clickHint', ' — clic para ver y poner al día')}">${icon('gitBranch', { size: 12 })}${lbl}${anyBehind ? ' ⚠' : ''}</span>`;
          }
        } else if (branchesData.error) {
          branchLine = `<span class="tk-branches" title="${t('tolkien.branches.errorTitle', 'No se pudo consultar tus PRs con gh: {error}', { error: esc(branchesData.error) })}">${icon('gitBranch', { size: 12 })}${t('tolkien.branches.na', 'PRs n/d')}</span>`;
        }
      }

      const dataNote = dataBusy
        ? `<div class="tk-line tk-line--dim">${pacman({ state: 'delegating', size: 'sm' })} ${t('tolkien.info.refreshingData', 'actualizando data local…')}</div>`
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

    async function loadEnvs() {
      try {
        envsData = await (await fetch('/api/tolkien/envs')).json();
        renderEnvs();
      } catch { /* noop */ }
    }

    function envStatusLabel(status) {
      switch (status) {
        case 'provisioning': return t('tolkien.envs.status.provisioning', 'creando');
        case 'worktree-ready': return t('tolkien.envs.status.worktreeReady', 'worktree');
        case 'db-ready': return t('tolkien.envs.status.dbReady', 'DB lista');
        case 'serving': return t('tolkien.envs.status.serving', 'sirviendo');
        case 'error': return t('tolkien.envs.status.error', 'error');
        case 'down': return t('tolkien.envs.status.down', 'apagado');
        default: return String(status || '');
      }
    }

    function envStateIcon(status) {
      if (status === 'serving') return pacman({ state: 'waiting', size: 'sm' });
      if (status === 'provisioning' || status === 'worktree-ready' || status === 'db-ready') return pacman({ state: 'delegating', size: 'sm' });
      return `<span class="tk-env-state" aria-hidden="true">${status === 'error' ? '⚠️' : '💤'}</span>`;
    }

    function hasTransitionEnvs() {
      return ((envsData && envsData.envs) || []).some((env) => !['serving', 'error', 'down'].includes(env.status));
    }

    function renderEnvs() {
      if (!refs.envsCount || !refs.envsList) return;
      if (!envsData) {
        refs.envsCount.textContent = '';
        refs.envsList.innerHTML = '';
        return;
      }
      const envs = envsData.envs || [];
      refs.envsCount.textContent = `${envs.length}/${envsData.max ?? ''}`;
      if (envs.length === 0) {
        refs.envsList.innerHTML = `<div class="tk-line tk-line--dim">${t('tolkien.envs.empty', 'Sin entornos activos')}</div>`;
        return;
      }
      refs.envsList.innerHTML = envs.map((env) => {
        const port = env.port == null ? '' : `<span class="tk-env-port">:${esc(env.port)}</span>`;
        const enter = env.status === 'serving'
          ? `<a class="btn-ghost btn--sm" href="/api/tolkien/local-enter?port=${esc(encodeURIComponent(String(env.port ?? '')))}" target="_blank" rel="noopener">${t('tolkien.envs.enter', 'entrar')}</a>`
          : '';
        const error = env.error
          ? `<div class="tk-line tk-line--dim" title="${esc(env.error)}">${esc(String(env.error).slice(0, 160))}</div>`
          : '';
        return `<div class="tk-env-row">
          <div class="tk-line tk-line--split">
            <span>${envStateIcon(env.status)} <span class="tk-branch">${esc(env.branch || '-')}</span>${port} <span class="tk-env-status">${esc(envStatusLabel(env.status))}</span></span>
            <span>${enter}<button class="btn-ghost btn--sm" data-env-teardown="${esc(env.id)}">${t('tolkien.envs.teardown', 'cerrar')}</button></span>
          </div>
          ${error}
        </div>`;
      }).join('');
    }

    async function postEnvTeardown(id, force) {
      const res = await fetch(`/api/tolkien/envs/${encodeURIComponent(id)}/teardown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    }

    async function doRebase(branch) {
      const ok = await dialog.confirmDialog({
        title: t('tolkien.rebase.confirmTitle', 'Poner esta rama al día sobre main'),
        message: t('tolkien.rebase.confirmMsg', 'Se rebasa "{branch}" sobre el último main de GitHub para seguir trabajando en paralelo.\n\n• Si hay conflicto se ABORTA y tu rama queda EXACTAMENTE como está (nada se pierde).\n• Tras el rebase, el PR va a necesitar force-push cuando lo re-envíes.', { branch }),
        confirmLabel: t('tolkien.rebase.confirmLabel', 'Rebasar'),
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
            title: data.conflict ? t('tolkien.rebase.conflictTitle', 'Conflicto al rebasar') : t('tolkien.rebase.failTitle', 'No se pudo rebasar'),
            message: `${data.error || t('tolkien.rebase.unexpectedError', 'Error inesperado.')}\n\n${fmtLog(data.log)}`,
          });
          return false;
        }
        await dialog.alertDialog({
          title: data.noop ? t('tolkien.rebase.noopTitle', 'Nada que hacer') : t('tolkien.rebase.okTitle', '✅ Rama al día'),
          message: `${data.message || t('tolkien.rebase.done', 'Listo.')}\n\n${fmtLog(data.log)}`,
        });
        return true;
      } catch {
        await dialog.alertDialog({ title: t('tolkien.common.tolkien', 'Tolkien'), message: t('tolkien.rebase.netError', 'No se pudo rebasar (error de red o del servidor).') });
        return false;
      } finally {
        render();
      }
    }

    function openBranchesDialog() {
      const brs = (branchesData?.branches) || [];
      const m = dialog.openModal({ title: t('tolkien.branchDialog.title', '🌿 PRs abiertos sin mergear'), width: 460 });
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <p class="dlg-msg" style="margin-bottom:.6rem">${t('tolkien.branchDialog.intro', 'Ramas que propusiste y Chris todavía no mergeó. <b>Poner al día</b> aparece solo en la <b>rama actual</b> cuando quedó atrás de main (por seguridad solo se rebasea la rama en la que estás parado).')}</p>
        <div class="tk-brlist">${brs.map((b) => {
          const behind = b.behindMain;
          const state = behind == null ? '<span class="tk-br-state">?</span>'
            : behind > 0 ? `<span class="tk-br-state tk-br-state--due">${t('tolkien.branchDialog.behind', '↓{behind} sobre main', { behind })}</span>`
              : `<span class="tk-br-state tk-br-state--ok">${t('tolkien.branchDialog.upToDate', 'al día')}</span>`;
          const cur = b.isCurrent ? `<span class="tk-br-cur" title="${t('tolkien.branchDialog.currentTitle', 'Estás parado acá')}">${t('tolkien.branchDialog.current', '● actual')}</span>` : '';
          const num = b.url
            ? `<a href="${esc(b.url)}" target="_blank" rel="noopener" class="tk-br-num">#${b.number}</a>`
            : `<span class="tk-br-num">#${b.number}</span>`;
          const btn = (b.isCurrent && behind > 0)
            ? `<button class="btn btn--sm tk-br-rebase" data-branch="${esc(b.branch)}">${t('tolkien.branchDialog.rebaseBtn', 'Poner al día')}</button>` : '';
          return `<div class="tk-br-row">
            <div class="tk-br-main">${num} ${cur}<div class="tk-br-title" title="${esc(b.title)}">${esc(b.title)}</div><div class="tk-br-branch">${esc(b.branch)}</div></div>
            <div class="tk-br-side">${state}${btn}</div>
          </div>`;
        }).join('') || `<p class="dlg-msg">${t('tolkien.branchDialog.empty', 'No hay PRs abiertos. 🎉')}</p>`}</div>`;
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
            title: t('tolkien.fetch.failTitle', 'No se pudo buscar cambios'),
            message: data.error || t('tolkien.fetch.failMsg', 'No se pudo comprobar el estado remoto (respuesta inválida del servidor).'),
          });
        }
      } catch {
        await dialog.alertDialog({ title: t('tolkien.common.tolkien', 'Tolkien'), message: t('tolkien.fetch.netError', 'No se pudo buscar cambios (error de red o del servidor).') });
      } finally { busy = false; render(); }
    }

    const fmtLog = (log) => Array.isArray(log)
      ? log.map((s) => `• ${s.step}: ${(s.out || '').split('\n')[0] || t('tolkien.common.ok', '(ok)')}`).join('\n')
      : '';

    function fmtUpdateEnvResult(result) {
      switch (result) {
        case 'rebased': return t('tolkien.updateAction.envResult.rebased', 'rebaseado');
        case 'skipped-dirty': return t('tolkien.updateAction.envResult.skippedDirty', 'omitido: sucio');
        case 'conflict': return t('tolkien.updateAction.envResult.conflict', 'conflicto');
        case 'status-failed': return t('tolkien.updateAction.envResult.statusFailed', 'status falló');
        case 'error': return t('tolkien.updateAction.envResult.error', 'error');
        default: return String(result || '');
      }
    }

    function fmtUpdateSummary(data) {
      const log = fmtLog(data.log);
      const envs = Array.isArray(data.envs) && data.envs.length
        ? data.envs.map((env) => t('tolkien.updateAction.envLine', '• entorno {branch}: {result}', { branch: env.branch || env.id || '?', result: fmtUpdateEnvResult(env.result) })).join('\n')
        : '';
      return [log, envs].filter(Boolean).join('\n\n');
    }

    async function doUpdate() {
      if (busy) return;
      const ok = await dialog.confirmDialog({
        title: t('tolkien.updateAction.confirmTitle', 'Actualizar Tolkien'),
        message: t('tolkien.updateAction.confirmMsg', 'Se trae lo último de GitHub (stash → pull → stash pop).\nTus cambios locales quedan a salvo si algo falla.'),
        confirmLabel: t('tolkien.updateAction.confirmLabel', 'Actualizar'),
      });
      if (!ok) return;
      busy = true; render();
      try {
        const res = await fetch('/api/tolkien/update', { method: 'POST' });
        const data = await res.json();
        if (data.status) current = data.status;
        if (!res.ok || data.error) {
          const summary = fmtUpdateSummary(data);
          await dialog.alertDialog({
            title: t('tolkien.updateAction.failTitle', 'No se pudo actualizar'),
            message: `${data.error || t('tolkien.updateAction.failMsg', 'No se pudo actualizar (respuesta inválida del servidor).')}${summary ? `\n\n${summary}` : ''}`,
          });
        } else if (data.popConflict) {
          const summary = fmtUpdateSummary(data);
          await dialog.alertDialog({
            title: t('tolkien.updateAction.conflictTitle', 'Actualizado, con conflicto'),
            message: `${t('tolkien.updateAction.conflictMsg', 'Hubo conflicto al reaplicar tus cambios: quedaron en el stash (git stash list).')}${summary ? `\n\n${summary}` : ''}`,
          });
        } else if (data.warn) {
          // Caso raro: estás en una rama feature y tu main local no pudo
          // adelantar solo (divergió o tiene commits propios). Tu rama quedó
          // intacta; solo avisamos.
          const summary = fmtUpdateSummary(data);
          await dialog.alertDialog({ title: t('tolkien.updateAction.warnTitle', 'Actualizado (con aviso)'), message: `${data.warn}${summary ? `\n\n${summary}` : ''}` });
        } else if (Array.isArray(data.envs) && data.envs.length) {
          await dialog.alertDialog({
            title: t('tolkien.updateAction.okTitle', 'Tolkien actualizado'),
            message: fmtUpdateSummary(data),
          });
        }
      } catch {
        await dialog.alertDialog({ title: t('tolkien.common.tolkien', 'Tolkien'), message: t('tolkien.updateAction.netError', 'No se pudo actualizar (error de red o del servidor).') });
      } finally {
        busy = false; render();
        await loadEnvs();
        // Chris pudo haber mergeado un PR mientras tanto: refrescamos la lista.
        loadBranches();
      }
    }

    async function doRefreshData() {
      if (dataBusy || busy) return;
      const ok = await dialog.confirmDialog({
        title: t('tolkien.refreshData.confirmTitle', 'Vista fresca (borrar + recargar)'),
        message: t('tolkien.refreshData.confirmMsg', 'Deja tu DB LOCAL como un snapshot LIMPIO y actual de Zoho:\n\n1) BORRA las tablas operativas (empleados, clientes, billing, invoices, PTO, teams…).\n2) Reimporta de cero (clients → employees → links).\n\n⚠️ Se pierden TODAS las ediciones locales de esos datos (es la idea: sin merge, sin conflictos). Se preservan login y config. No toca prod ni tu código.'),
        confirmLabel: t('tolkien.refreshData.confirmLabel', 'Borrar y recargar'),
      });
      if (!ok) return;
      dataBusy = true; render();
      try {
        // Arranca el job en background (vuelve al instante, sin request larga).
        const startRes = await fetch('/api/tolkien/refresh-data', { method: 'POST' });
        const startData = await startRes.json().catch(() => ({}));
        if (!startRes.ok) {
          throw new Error(startData.error || `HTTP ${startRes.status}`);
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
          throw new Error(t('tolkien.refreshData.stillRunning', 'El refresh sigue corriendo tras 5 min — revisá el server.'));
        }
        if (status && status.error) {
          await dialog.alertDialog({ title: t('tolkien.refreshData.failTitle', 'No se pudo actualizar la data'), message: status.error });
        } else {
          const data = (status && status.result) || {};
          const REAL_IMPORTERS = ['clients', 'employees', 'employee-client-links'];
          const summary = (data.steps || [])
            .map((s) => {
              if (s.failed) return `✗ ${s.importer}: ${s.error || t('tolkien.refreshData.stepFailed', 'falló')}`;
              if (!REAL_IMPORTERS.includes(s.importer)) return `✓ ${s.importer}: ${t('tolkien.refreshData.stepDone', 'listo')}`;
              return t('tolkien.refreshData.stepSummary', '✓ {importer}: +{creates} nuevos · {updates} act. · {softDeletes} baja', { importer: s.importer, creates: s.creates, updates: s.updates, softDeletes: s.softDeletes });
            })
            .join('\n');
          const templateNote = startData.templateBuild
            ? `${t('tolkien.refreshData.templateBuild', 'Plantilla y entornos: refresco en curso.')}\n\n`
            : '';
          await dialog.alertDialog({
            title: data.ok ? t('tolkien.refreshData.okTitle', '✅ Data local actualizada') : t('tolkien.refreshData.errTitle', '⚠️ Actualización con errores'),
            message: `${templateNote}${summary || t('tolkien.refreshData.noDetail', 'Sin detalle.')}\n\n(${Math.round((data.durationMs || 0) / 1000)}s)`,
          });
        }
      } catch (err) {
        await dialog.alertDialog({ title: t('tolkien.common.tolkien', 'Tolkien'), message: err?.message || t('tolkien.refreshData.netError', 'No se pudo actualizar la data (error de red o del servidor).') });
      } finally {
        dataBusy = false; render();
        await loadEnvs();
      }
    }

    refs.envsList.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('[data-env-teardown]');
      if (!btn || !refs.envsList.contains(btn)) return;
      const id = btn.dataset.envTeardown;
      const ok = await dialog.confirmDialog({
        title: t('tolkien.envs.teardownConfirmTitle', 'Cerrar entorno'),
        message: t('tolkien.envs.teardownConfirmMsg', 'Se detiene el dev-server, se borra la DB del entorno y se elimina el worktree. Los cambios sin commitear se pierden si forzás.'),
        confirmLabel: t('tolkien.envs.teardownConfirmLabel', 'Cerrar'),
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        let { res, data } = await postEnvTeardown(id, false);
        if (res.status === 409 && data.dirty) {
          const force = await dialog.confirmDialog({
            title: t('tolkien.envs.teardownDirtyTitle', 'Cambios sin commitear'),
            message: t('tolkien.envs.teardownDirtyMsg', 'Este entorno tiene cambios sin commitear. Si forzás el cierre, esos cambios se descartan.'),
            confirmLabel: t('tolkien.envs.teardownDirtyLabel', 'Forzar cierre'),
          });
          if (!force) {
            btn.disabled = false;
            return;
          }
          ({ res, data } = await postEnvTeardown(id, true));
        }
        if (!res.ok || data.error) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        await loadEnvs();
      } catch (err) {
        await dialog.alertDialog({ title: t('tolkien.envs.teardownFailTitle', 'No se pudo cerrar el entorno'), message: err?.message || t('tolkien.envs.teardownFailMsg', 'Error de red o del servidor.') });
        btn.disabled = false;
      }
    });

    refs.update.addEventListener('click', doUpdate);
    refs.fetch.addEventListener('click', checkRemote); // Buscar cambios (fetch)
    refs.refreshData.addEventListener('click', doRefreshData); // Actualizar data local (importers)

    (async () => {
      await loadStatus();
      loadEnvs();
      checkRemote();
      loadBranches(); // consulta mis PRs abiertos (gh, red) — sin bloquear
    })();

    const CHECK_MS = 5 * 60 * 1000;
    setInterval(() => { if (!document.hidden) checkRemote(); }, CHECK_MS);
    const ENVS_CHECK_MS = 6000;
    setInterval(() => { if (!document.hidden && hasTransitionEnvs()) loadEnvs(); }, ENVS_CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });
  },
};
