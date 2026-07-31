// modules/system/dashboard-panel.js — pestaña "Dashboard del proyecto" del menú
// Sistema (grupo Diagnóstico). Antes vivía como sub-modal (inventory-modal.js)
// abierto desde una tab del Escaneo de Salud; el rediseño 2026-07-19 (PLAN-752,
// pedido de Niko) lo saca a su PROPIA pestaña porque es INFORMATIVO (censo +
// recursos), no accionable — así Salud queda solo con lo accionable (escanear/
// resolver). Mismo contenido, ahora montado en el panel en vez de un modal.
//
// TODO gratis (0 tokens, sin LLM): reusa GET /api/health/scan, que reusa
// generateInventory() (core/inventory.js) + systemSnapshot() (modules/stats,
// misma fuente que el gauge del pie). Sin capa IA: solo "Re-escanear ahora".
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';
import { heat, fmtBytes, fmtUptime } from '../stats/stats.js';

const API = '/api/health';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');
const engineName = (f) => String(f || '').split('/').pop().replace(/^cwc-|\.js$/g, '') || f;

export function mountDashboardPanel(el, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'hp-opt';
  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.help.dashboard.title', 'Dashboard')}</span>
      ${helpBtn('sys-dashboard')}
    </div>`;
  el.appendChild(wrap);

  let alive = true;
  let scanning = false;
  // El panel vive dentro del modal de Sistema; se desmonta al cambiar de ítem o
  // cerrar el modal. Un MutationObserver detecta la desconexión para frenar polls.
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  // ===== Recursos del servidor (núcleos/CPU/RAM/disco/load/uptime) =====
  function resourcesHtml(res) {
    if (!res) return `<p class="hp-empty">${t('system.inventory.serverReadError', 'No se pudo leer el estado del servidor.')}</p>`;
    const { cpu = {}, mem = {}, disk = {}, load = [] } = res;
    const bar = (pct) => `<span class="gauge-bar"><span class="gauge-fill ${heat(pct || 0)}" style="width:${Math.round(pct || 0)}%"></span></span>`;
    return `<div class="hp-inv-res">
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">${t('system.inventory.cores', 'Núcleos')}</span>
        <span class="hp-inv-tile-val">${cpu.cores ?? '—'}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">${t('system.inventory.cpu', 'CPU')}</span>
        ${bar(cpu.pct)}
        <span class="hp-inv-tile-val">${Math.round(cpu.pct || 0)}%</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">${t('system.inventory.ram', 'RAM')}</span>
        ${bar(mem.pct)}
        <span class="hp-inv-tile-val">${Math.round(mem.pct || 0)}%</span>
        <span class="hp-inv-tile-sub">${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">${t('system.inventory.disk', 'Disco')}</span>
        ${bar(disk.pct)}
        <span class="hp-inv-tile-val">${Math.round(disk.pct || 0)}%</span>
        <span class="hp-inv-tile-sub">${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">${t('system.inventory.loadAvg', 'Load avg')}</span>
        <span class="hp-inv-tile-val">${load.length ? load.map((n) => n.toFixed(1)).join(' · ') : '—'}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">${t('system.inventory.uptime', 'Uptime')}</span>
        <span class="hp-inv-tile-val">${fmtUptime(res.uptime)}</span>
        <span class="hp-inv-tile-sub">${esc(res.hostname || '')}</span>
      </div>
    </div>`;
  }

  // ===== Backend: nombre + registro + archivos + endpoints reales =====
  function backendHtml(modules, count) {
    const rows = (modules || []).map((mo) => `
      <tr title="${esc(mo.purpose || '')}">
        <td><span class="hp-dot ${mo.registered ? 'hp-dot--ok' : 'hp-dot--warn'}"></span> <b>${esc(mo.name)}</b></td>
        <td>${mo.registered ? `registry.js:${mo.registryLine ?? '?'}` : `⚠️ ${t('system.inventory.notRegistered', 'no registrado')}`}</td>
        <td>${mo.fileCount} ${t('system.inventory.filesCount', 'archivo(s)')}</td>
        <td class="hp-inv-eps">${(mo.endpoints || []).length ? esc(mo.endpoints.join(' · ')) : '—'}</td>
      </tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🧩 ${t('system.inventory.backendModules', 'Módulos backend')} · ${count}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>${t('system.inventory.moduleHeader', 'Módulo')}</th><th>${t('system.inventory.registryHeader', 'Registro')}</th><th>${t('system.inventory.filesHeader', 'Archivos')}</th><th>${t('system.inventory.endpointsHeader', 'Endpoints')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">${t('system.inventory.noModules', 'Sin módulos.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  // ===== Frontend: nombre + directorio + si está montado =====
  function frontendHtml(frontend, count) {
    const rows = (frontend || []).map((f) => `
      <tr title="${esc(f.dir)}">
        <td><span class="hp-dot ${f.mounted ? 'hp-dot--ok' : 'hp-dot--idle'}"></span> <b>${esc(f.name)}</b></td>
        <td>${esc(f.dir)}</td>
        <td>${f.mounted ? t('system.inventory.mountedDataModule', 'montado ([data-module])') : t('system.inventory.manualMount', 'mount manual (main.js)')}</td>
        <td>${f.fileCount} ${t('system.inventory.filesCount', 'archivo(s)')}</td>
      </tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🖥 ${t('system.inventory.frontendModules', 'Módulos frontend')} · ${count}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>${t('system.inventory.moduleHeader', 'Módulo')}</th><th>${t('system.inventory.directoryHeader', 'Directorio')}</th><th>${t('system.inventory.mountHeader', 'Montaje')}</th><th>${t('system.inventory.filesHeader', 'Archivos')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">${t('system.inventory.noModules', 'Sin módulos.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  // ===== Runners (bin/) =====
  function runnersHtml(runners, count) {
    const rows = (runners || []).map((r) => `
      <tr><td><b>${esc(r.file)}</b></td><td>${esc(r.purpose || '—')}</td></tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🏃 ${t('system.inventory.runnersTitle', 'Runners (bin/)')} · ${count}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>${t('system.inventory.fileHeader', 'Archivo')}</th><th>${t('system.inventory.purposeHeader', 'Propósito')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="2">${t('system.inventory.noRunners', 'Sin runners.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  // ===== Motores IA: solo un vistazo =====
  function enginesHtml(engines, count) {
    const rows = (engines || []).map((e) => `
      <tr title="${esc(e.purpose || '')}">
        <td><b>${esc(engineName(e.file))}</b></td>
        <td>${e.models?.length ? esc(e.models.join('/')) : (e.modelDynamic ? t('system.inventory.dynamicModel', 'dinámico') : t('system.inventory.defaultModel', 'default'))}</td>
      </tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🤖 ${t('system.inventory.aiEngines', 'Motores IA')} · ${count}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>${t('system.inventory.engineHeader', 'Motor')}</th><th>${t('system.inventory.modelHeader', 'Modelo')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="2">${t('system.inventory.noEngines', 'Sin motores.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  // ===== Pad local · backbone (workspace console) =====
  function padHtml(pad) {
    if (!pad) return '';
    if (!pad.ok) {
      return `<details class="hp-opt-group">
        <summary>🗂️ ${t('system.inventory.padBackboneTitle', 'Pad local · backbone')} <span class="hp-opt-snippet">${t('system.inventory.noResponseSnippet', '(no responde)')}</span></summary>
        <p class="hp-empty">${t('system.inventory.padNoResponseBeforeDetail', 'Pad local no responde')} (${esc(pad.error || t('system.inventory.noDetail', 'sin detalle'))}) — ${t('system.inventory.padNoResponseAfterDetail', 'tasks/learning/retro/tickets-meta degradan a best-effort. ¿pad-local.service arriba?')}</p>
      </details>`;
    }
    const cols = (pad.collections || []).filter((c) => c.total > 0);
    const rows = cols.map((c) => `
      <tr><td>${esc(c.icon || '')} <b>${esc(c.name)}</b></td><td>${c.active}</td><td>${c.total}</td></tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🗂️ ${t('system.inventory.padBackboneWorkspaceTitle', 'Pad local · backbone (workspace console)')} · ${pad.totals?.active ?? 0} ${t('system.inventory.liveItems', 'ítems vivos')}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>${t('system.inventory.collectionHeader', 'Colección')}</th><th>${t('system.inventory.liveHeader', 'Vivos')}</th><th>${t('system.inventory.totalHeader', 'Total')}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3">${t('system.inventory.noCollections', 'Sin colecciones.')}</td></tr>`}</tbody>
      </table>
    </details>`;
  }

  function render(d) {
    const unreg = d.unregistered || [];
    const warn = unreg.length ? `<p class="hp-inv-warn">⚠️ ${t('system.inventory.unregisteredWarning', 'Sin registrar en registry.js')}: ${esc(unreg.join(', '))}</p>` : '';
    wrap.innerHTML = `
      <div class="hp-verdict hp-verdict--${unreg.length ? 'atencion' : 'ok'}">
        <b>${d.counts.modules} ${t('system.inventory.backendCount', 'backend')} · ${d.counts.frontend} ${t('system.inventory.frontendCount', 'frontend')} · ${d.counts.runners} ${t('system.inventory.runnersCount', 'runners')} · ${d.counts.aiEngines} ${t('system.inventory.aiEnginesCount', 'motor(es) IA')}</b>
        <span class="hp-when">${scanning ? t('system.inventory.scanning', 'escaneando…') : fmtDate(d.generatedAt)}</span>
      </div>
      ${warn}
      ${resourcesHtml(d.resources)}
      ${padHtml(d.pad)}
      ${backendHtml(d.modules, d.counts.modules)}
      ${frontendHtml(d.frontend, d.counts.frontend)}
      ${runnersHtml(d.runners, d.counts.runners)}
      ${enginesHtml(d.aiEngines, d.counts.aiEngines)}
      <button class="btn btn--block" data-act="invReload" ${scanning ? 'disabled' : ''}>${icon('refresh', { size: 14 })}<span>${scanning ? t('system.inventory.rescanning', 'Re-escaneando…') : t('system.inventory.rescanNow', 'Re-escanear ahora')}</span></button>`;
    wrap.querySelector('[data-act="invReload"]')?.addEventListener('click', () => load(true));
  }

  let lastData = null;
  async function load(force) {
    scanning = !!force;
    if (force && lastData) render(lastData);
    try {
      const d = await (await fetch(`${API}/scan${force ? '?force=1' : ''}`)).json();
      if (!alive) return;
      scanning = false;
      lastData = d;
      render(d);
    } catch {
      if (!alive) return;
      scanning = false;
      if (lastData) render(lastData);
      else wrap.innerHTML = `<p class="hp-empty">${t('system.inventory.scanReadError', 'No se pudo leer el censo.')}</p>`;
    }
  }

  wrap.innerHTML = `<p class="hp-running">${pacman()} ${t('system.inventory.loading', 'cargando…')}</p>`;
  load();
}
