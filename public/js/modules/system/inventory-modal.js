// modules/system/inventory-modal.js — sub-ventana "Dashboard del proyecto"
// (gemela de optimize-modal.js/coherence-modal.js: la pestaña Salud muestra
// solo el resumen compacto + botón, el detalle completo vive acá). Pedido del
// usuario 2026-07-06: antes el "🔍 Censo del proyecto" solo mostraba conteos
// ("11 módulos") sin decir CUÁLES y sin recursos del servidor (núcleos/CPU/
// RAM). Acá SÍ: recursos del servidor + módulos backend con sus endpoints y
// línea de registro + módulos frontend con su montaje + runners + motores IA.
//
// TODO gratis (0 tokens, sin LLM): reusa GET /api/health/scan, que a su vez
// reusa generateInventory() (core/inventory.js) + systemSnapshot()
// (modules/stats, misma fuente que el gauge del pie — fuente única de
// recursos del sistema). Sin capa IA: por eso no hay botón "Analizar con
// IA" como en Optimización/Coherencia, solo "Re-escanear ahora".
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';
import { heat, fmtBytes, fmtUptime } from '../stats/stats.js';

const API = '/api/health';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');
const engineName = (f) => String(f || '').split('/').pop().replace(/^cwc-|\.js$/g, '') || f;

// Abre la sub-ventana. `ctx` trae dialog (no necesita openChat: es puro censo).
export function openInventory(ctx) {
  const { dialog } = ctx;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const m = dialog.openModal({ title: '📊 Dashboard del proyecto', width: 900 });
  m.card.classList.add('dlg-card--health');
  const wrap = document.createElement('div');
  wrap.className = 'hp-opt';
  m.body.appendChild(wrap);

  let alive = true;
  let scanning = false;
  const origOnClose = m.close;
  m.close = () => { alive = false; origOnClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });

  // ===== Recursos del servidor (núcleos/CPU/RAM/disco/load/uptime) =====
  function resourcesHtml(res) {
    if (!res) return '<p class="hp-empty">No se pudo leer el estado del servidor.</p>';
    const { cpu = {}, mem = {}, disk = {}, load = [] } = res;
    const bar = (pct) => `<span class="gauge-bar"><span class="gauge-fill ${heat(pct || 0)}" style="width:${Math.round(pct || 0)}%"></span></span>`;
    return `<div class="hp-inv-res">
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">Núcleos</span>
        <span class="hp-inv-tile-val">${cpu.cores ?? '—'}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">CPU</span>
        ${bar(cpu.pct)}
        <span class="hp-inv-tile-val">${Math.round(cpu.pct || 0)}%</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">RAM</span>
        ${bar(mem.pct)}
        <span class="hp-inv-tile-val">${Math.round(mem.pct || 0)}%</span>
        <span class="hp-inv-tile-sub">${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">Disco</span>
        ${bar(disk.pct)}
        <span class="hp-inv-tile-val">${Math.round(disk.pct || 0)}%</span>
        <span class="hp-inv-tile-sub">${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">Load avg</span>
        <span class="hp-inv-tile-val">${load.length ? load.map((n) => n.toFixed(1)).join(' · ') : '—'}</span>
      </div>
      <div class="hp-inv-tile">
        <span class="hp-inv-tile-label">Uptime</span>
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
        <td>${mo.registered ? `registry.js:${mo.registryLine ?? '?'}` : '⚠️ no registrado'}</td>
        <td>${mo.fileCount} archivo(s)</td>
        <td class="hp-inv-eps">${(mo.endpoints || []).length ? esc(mo.endpoints.join(' · ')) : '—'}</td>
      </tr>`).join('');
    return `<details class="hp-opt-group" ${isMobile ? '' : 'open'}>
      <summary>🧩 Módulos backend · ${count}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>Módulo</th><th>Registro</th><th>Archivos</th><th>Endpoints</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">Sin módulos.</td></tr>'}</tbody>
      </table>
    </details>`;
  }

  // ===== Frontend: nombre + directorio + si está montado =====
  function frontendHtml(frontend, count) {
    // "mounted" = tiene [data-module] en index.html. Algunos módulos (chat,
    // terminal, mobile…) se montan A MANO desde main.js por vista/atajo en vez
    // de [data-module] — NO es un problema (documentado en CLAUDE.md), por eso
    // acá es solo informativo (punto neutro), no una advertencia como en
    // backend (ahí "no registrado" sí impide que el módulo corra).
    const rows = (frontend || []).map((f) => `
      <tr title="${esc(f.dir)}">
        <td><span class="hp-dot ${f.mounted ? 'hp-dot--ok' : 'hp-dot--idle'}"></span> <b>${esc(f.name)}</b></td>
        <td>${esc(f.dir)}</td>
        <td>${f.mounted ? 'montado ([data-module])' : 'mount manual (main.js)'}</td>
        <td>${f.fileCount} archivo(s)</td>
      </tr>`).join('');
    return `<details class="hp-opt-group" ${isMobile ? '' : 'open'}>
      <summary>🖥 Módulos frontend · ${count}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>Módulo</th><th>Directorio</th><th>Montaje</th><th>Archivos</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">Sin módulos.</td></tr>'}</tbody>
      </table>
    </details>`;
  }

  // ===== Runners (bin/) =====
  function runnersHtml(runners, count) {
    const rows = (runners || []).map((r) => `
      <tr><td><b>${esc(r.file)}</b></td><td>${esc(r.purpose || '—')}</td></tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🏃 Runners (bin/) · ${count}</summary>
      <table class="hp-opt-table">
        <thead><tr><th>Archivo</th><th>Propósito</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="2">Sin runners.</td></tr>'}</tbody>
      </table>
    </details>`;
  }

  // ===== Motores IA: solo un vistazo — el detalle de blindaje/turnos/timeouts
  // vive en "🧠 Optimización IA" (no duplicar acá) =====
  function enginesHtml(engines, count) {
    const rows = (engines || []).map((e) => `
      <tr title="${esc(e.purpose || '')}">
        <td><b>${esc(engineName(e.file))}</b></td>
        <td>${e.models?.length ? esc(e.models.join('/')) : (e.modelDynamic ? 'dinámico' : 'default')}</td>
      </tr>`).join('');
    return `<details class="hp-opt-group">
      <summary>🤖 Motores IA · ${count} <span class="hp-opt-snippet">(detalle en "Optimización IA")</span></summary>
      <table class="hp-opt-table">
        <thead><tr><th>Motor</th><th>Modelo</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="2">Sin motores.</td></tr>'}</tbody>
      </table>
    </details>`;
  }

  function render(d) {
    const unreg = d.unregistered || [];
    const warn = unreg.length ? `<p class="hp-inv-warn">⚠️ Sin registrar en registry.js: ${esc(unreg.join(', '))}</p>` : '';
    wrap.innerHTML = `
      <div class="hp-verdict hp-verdict--${unreg.length ? 'atencion' : 'ok'}">
        <b>${d.counts.modules} backend · ${d.counts.frontend} frontend · ${d.counts.runners} runners · ${d.counts.aiEngines} motor(es) IA</b>
        <span class="hp-when">${scanning ? 'escaneando…' : fmtDate(d.generatedAt)}</span>
      </div>
      ${warn}
      ${resourcesHtml(d.resources)}
      ${backendHtml(d.modules, d.counts.modules)}
      ${frontendHtml(d.frontend, d.counts.frontend)}
      ${runnersHtml(d.runners, d.counts.runners)}
      ${enginesHtml(d.aiEngines, d.counts.aiEngines)}
      <button class="btn btn--block" data-act="invReload" ${scanning ? 'disabled' : ''}>${icon('refresh', { size: 14 })}<span>${scanning ? 'Re-escaneando…' : 'Re-escanear ahora'}</span></button>`;
    wrap.querySelector('[data-act="invReload"]')?.addEventListener('click', () => load(true));
  }

  let lastData = null;
  async function load(force) {
    scanning = !!force;
    if (force && lastData) render(lastData); // mantiene la tabla visible, solo cambia el botón a "escaneando…"
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
      else wrap.innerHTML = '<p class="hp-empty">No se pudo leer el censo.</p>';
    }
  }

  wrap.innerHTML = `<p class="hp-running">${pacman()} cargando…</p>`;
  load();
}
