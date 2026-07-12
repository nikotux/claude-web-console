// modules/system/health-scan-modal.js — sub-ventana del ESCANEO DE SALUD UNIFICADO.
//
// UN solo lugar para lanzar y ver TODO: Revisión + Optimización + Coherencia +
// cross-check con Pad, corriendo en el orquestador desacoplado (un pool
// compartido). Reemplaza a los 3 modales sueltos como ENTRADA; sus detalles se
// reusan tal cual — cada tab de motor abre su modal existente para el detalle
// completo (accionar hallazgos/propuestas). El aporte nuevo es el Pac-Man
// persistente con progreso por fase + la tab 🐛 Pad (nuevo/rastreado/regresión +
// crear BUG con confirmación).
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';
import { openHealthReview } from './health-review-modal.js';
import { openOptimize } from './optimize-modal.js';
import { openCoherence } from './coherence-modal.js';
import { openInventory } from './inventory-modal.js';

const API = '/api/health';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('es', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
};
const VERDICT_LABEL = { ok: 'Todo en orden', atencion: 'Requiere atención', critico: 'CRÍTICO' };
const ST = { pending: '⏳ pendiente', running: '⟳ corriendo', done: '✓ listo', error: '✕ error' };

const TABS = [
  ['resumen', '📊 Resumen'], ['revision', '🔬 Revisión'], ['optim', '🧠 Optimización'],
  ['coher', '🔗 Coherencia'], ['dash', '📊 Dashboard'], ['pad', '🐛 Pad'],
];

export function openHealthScan(ctx, { isAdmin }) {
  const { dialog } = ctx;
  const m = dialog.openModal({ title: '🩺 Escaneo de Salud', width: 920 });
  m.card.classList.add('dlg-card--health');
  let alive = true; let pollTimer = null; let activeTab = 'resumen'; let last = null;
  const origClose = m.close;
  m.close = () => { alive = false; clearTimeout(pollTimer); origClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });

  const wrap = document.createElement('div');
  wrap.className = 'hs-wrap';
  m.body.appendChild(wrap);

  async function launch(full) {
    if (!isAdmin) { await dialog.alertDialog({ title: 'Escaneo', message: 'Solo un administrador puede lanzar el escaneo (consume tokens).' }); return; }
    const ok = await dialog.confirmDialog({
      title: 'Escaneo de Salud',
      message: `Corre Revisión${full ? ' COMPLETA (ignora caché)' : ' (incremental)'} + Optimización + Coherencia + verificación de Pad en una sola pasada.\n\nConsume tokens. ¿Arrancar?`,
      confirmText: 'Arrancar',
    });
    if (!ok) return;
    try {
      const r = await fetch(`${API}/scan-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); await dialog.alertDialog({ title: 'Escaneo', message: e.error || 'No se pudo lanzar.' }); return; }
      poll();
    } catch (e) { await dialog.alertDialog({ title: 'Escaneo', message: String(e.message || e) }); }
  }

  async function createBug(finding, btn) {
    const ok = await dialog.confirmDialog({
      title: 'Crear BUG en Pad',
      message: `Crear un BUG en Pad (workspace console) desde este hallazgo?\n\n${finding.area || finding.detail || ''}`,
      confirmText: 'Crear',
    });
    if (!ok) return;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch(`${API}/scan-pad-bug`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ finding }) });
      const j = await r.json();
      if (r.ok) { btn.textContent = `✓ ${j.ref || 'creado'}`; btn.classList.add('hs-created'); }
      else { btn.disabled = false; btn.textContent = 'Crear BUG'; await dialog.alertDialog({ title: 'Pad', message: j.error || 'Error' }); }
    } catch (e) { btn.disabled = false; btn.textContent = 'Crear BUG'; await dialog.alertDialog({ title: 'Pad', message: String(e.message || e) }); }
  }

  function headerHtml(d) {
    const running = d?.running;
    const verdict = d?.verdict;
    const p = d?.progress || {};
    let progress = '';
    if (running) {
      const rev = p.review ? `Revisión ${p.review.done ?? 0}/${p.review.total ?? '?'}` : 'Revisión …';
      const opt = `Optim ${ST[p.optimize?.status] || '⏳'}`;
      const coh = `Coherencia ${ST[p.coherence?.status] || '⏳'}`;
      const phase = d.phase ? ` · fase: ${esc(d.phase)}` : '';
      progress = `<p class="hp-running">${pacman({ state: 'delegating' })} ${esc([rev, opt, coh].join(' · '))}${phase}</p>`;
    }
    const badge = running
      ? '<span class="hp-verdict hp-verdict--atencion" style="display:inline-block"><b>Escaneando…</b></span>'
      : (verdict ? `<span class="hp-verdict hp-verdict--${esc(verdict)}" style="display:inline-block"><b>${VERDICT_LABEL[verdict] || 'Sin veredicto'}</b><span class="hp-when">${d.finishedAt ? fmtDate(d.finishedAt) : ''}</span></span>` : '<span class="hp-when">Sin escaneo previo</span>');
    const launchBtns = running
      ? '<span class="hp-when">en curso…</span>'
      : `<button class="btn btn--sm" data-act="run">${icon('gear', { size: 13 })}<span>Escaneo incremental</span></button>
         <button class="btn-ghost btn--sm" data-act="runfull">Completo</button>`;
    return `<div class="hs-head">${badge}<span class="hs-head-actions">${launchBtns}</span></div>${progress}`;
  }

  function tabsHtml() {
    return `<div class="hs-tabs">${TABS.map(([k, l]) => `<button class="hs-tab ${k === activeTab ? 'hs-tab--active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>`;
  }

  function detailTab(title, summary, openLabel, act) {
    return `<div class="hs-detail">
      <p>${summary}</p>
      <button class="btn btn--block" data-act="${act}">${icon('search', { size: 14 })}<span>${openLabel}</span></button>
    </div>`;
  }

  function bodyHtml(d) {
    if (activeTab === 'resumen') {
      if (!d || (!d.verdict && !d.running)) return '<p class="hp-empty">Todavía no se corrió un Escaneo de Salud. Usá el botón de arriba — corre los 4 análisis en una pasada.</p>';
      const p = d.progress || {};
      const pad = d.pad;
      return `<div class="hs-summary">
        <table class="hs-grid"><tbody>
          <tr><td>🔬 Revisión</td><td>${p.review ? `${p.review.done ?? 0}/${p.review.total ?? '?'} unidades${p.review.reused ? ` (${p.review.reused} cacheadas)` : ''}` : '—'}</td></tr>
          <tr><td>🧠 Optimización</td><td>${ST[p.optimize?.status] || '—'}${p.optimize?.count != null ? ` · ${p.optimize.count} propuesta(s)` : ''}</td></tr>
          <tr><td>🔗 Coherencia</td><td>${ST[p.coherence?.status] || '—'}${p.coherence?.count != null ? ` · ${p.coherence.count} propuesta(s)` : ''}</td></tr>
          <tr><td>🐛 Pad</td><td>${pad ? `${pad.nuevo?.length || 0} nuevo(s) · ${pad.rastreado?.length || 0} rastreado(s) · ${pad.regresion?.length || 0} regresión(es) · ${pad.openCount ?? '?'} BUG abiertos` : '—'}</td></tr>
        </tbody></table>
        ${d.error ? `<p class="hp-empty">⚠️ ${esc(d.error)}</p>` : ''}
        <p class="hp-when">Modo: ${esc(d.mode || 'incremental')} · el detalle accionable de cada motor está en su tab.</p>
      </div>`;
    }
    if (activeTab === 'revision') return detailTab('Revisión', 'Hallazgos por módulo, veredicto y acciones (auto-fix / resolver en chat / marcar resuelto).', 'Abrir detalle de Revisión →', 'open-rev');
    if (activeTab === 'optim') return detailTab('Optimización', 'Censo de motores IA + propuestas de optimización aprobables.', 'Abrir detalle de Optimización →', 'open-opt');
    if (activeTab === 'coher') return detailTab('Coherencia', 'Grafo de dependencias, hallazgos determinísticos y propuestas de cableado.', 'Abrir detalle de Coherencia →', 'open-coh');
    if (activeTab === 'dash') return detailTab('Dashboard', 'Censo del proyecto + recursos del servidor (núcleos/CPU/RAM/disco) + backbone de Pad.', 'Abrir Dashboard →', 'open-dash');
    if (activeTab === 'pad') return padTab(d?.pad);
    return '';
  }

  function findingRow(f, kind) {
    const sev = f.severity || 'medium';
    const match = f.match ? `<span class="hs-match" title="matchea ${esc(f.match.ref)} (${f.match.score}%)">${esc(f.match.ref)}</span>` : '';
    const create = kind === 'nuevo' ? '<button class="btn-ghost btn--sm" data-newbug>Crear BUG</button>' : '';
    return `<div class="hs-frow hs-frow--${kind}" data-fkey="${esc(JSON.stringify(f)).replace(/"/g, '&quot;')}">
      <span class="hs-sev hs-sev--${esc(sev)}">${esc(sev)}</span>
      <span class="hs-fmod">${esc(f.module || '?')}</span>
      <span class="hs-fdet">${esc(f.area || f.detail || '')}</span>
      ${match}${create}
    </div>`;
  }

  function padTab(pad) {
    if (!pad) return '<p class="hp-empty">El cross-check con Pad corre al final del escaneo — todavía no hay datos.</p>';
    if (pad.available === false) return `<p class="hp-empty">Pad local no respondió (${esc(pad.error || '')}). El escaneo sigue igual; reintentá cuando esté arriba.</p>`;
    const sec = (title, arr, kind, hint) => `
      <details class="hs-padsec" ${kind === 'nuevo' || kind === 'regresion' ? 'open' : ''}>
        <summary>${title} <b>${arr.length}</b></summary>
        <p class="hp-when">${hint}</p>
        ${arr.length ? arr.map((f) => findingRow(f, kind)).join('') : '<p class="hp-when" style="padding:.2rem">—</p>'}
      </details>`;
    return `<div class="hs-pad">
      <p class="hp-when">Cross-check de los hallazgos de la Revisión contra la colección Bugs de Pad (workspace console). ${pad.openCount ?? '?'} BUG abiertos hoy.</p>
      ${sec('🆕 Nuevos (no rastreados)', pad.nuevo || [], 'nuevo', 'No matchean ningún BUG. Podés crearlos en Pad con confirmación.')}
      ${sec('⚠️ Regresiones', pad.regresion || [], 'regresion', 'Matchean un BUG fixed/wontfix → reaparecieron. Revisar.')}
      ${sec('🔗 Ya rastreados', pad.rastreado || [], 'rastreado', 'Ya están en el backlog de Pad — no hace falta re-crearlos.')}
    </div>`;
  }

  function render() {
    const d = last;
    wrap.innerHTML = `${headerHtml(d)}${tabsHtml()}<div class="hs-body">${bodyHtml(d)}</div>`;
    wrap.querySelector('[data-act="run"]')?.addEventListener('click', () => launch(false));
    wrap.querySelector('[data-act="runfull"]')?.addEventListener('click', () => launch(true));
    for (const t of wrap.querySelectorAll('[data-tab]')) t.addEventListener('click', () => { activeTab = t.dataset.tab; render(); });
    wrap.querySelector('[data-act="open-rev"]')?.addEventListener('click', () => openHealthReview(ctx, { isAdmin }));
    wrap.querySelector('[data-act="open-opt"]')?.addEventListener('click', () => openOptimize(ctx, { isAdmin }));
    wrap.querySelector('[data-act="open-coh"]')?.addEventListener('click', () => openCoherence(ctx, { isAdmin }));
    wrap.querySelector('[data-act="open-dash"]')?.addEventListener('click', () => openInventory(ctx));
    for (const b of wrap.querySelectorAll('[data-newbug]')) {
      b.addEventListener('click', () => {
        try { const f = JSON.parse(b.closest('[data-fkey]').dataset.fkey.replace(/&quot;/g, '"')); createBug(f, b); } catch { /* noop */ }
      });
    }
  }

  async function poll() {
    try {
      const d = await (await fetch(`${API}/scan-all`)).json();
      if (!alive) return;
      last = d; render();
      if (d.running) pollTimer = setTimeout(poll, 3000);
    } catch {
      if (alive) { wrap.innerHTML = '<p class="hp-empty">No se pudo leer el estado del escaneo.</p>'; }
    }
  }

  render();
  poll();
}
