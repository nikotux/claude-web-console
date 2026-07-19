// modules/system/health-scan-modal.js — sub-ventana del ESCANEO DE SALUD UNIFICADO.
//
// Rediseño 2026-07-19 (PLAN-752, pedido de Niko): de 6 tabs que abrían 4
// sub-modales (ventana sobre ventana) → UNA vista scrolleable con secciones
// <details> colapsables, TODO accionable INLINE (regla UI "colapsable + árbol").
// Los motores (Revisión / Optimización / Coherencia) se MONTAN inline dentro de
// su sección (mountHealthReview/mountOptimize/mountCoherence) — lazy al abrir el
// <details>, con cleanup al colapsar/cerrar. El Dashboard del proyecto salió a su
// PROPIA pestaña de Sistema (dashboard-panel.js): no va acá.
//
// Header: veredicto en vivo + [Escaneo incremental][Completo] + [Resolver todo]
// (F2, Orquestador Interno). El Pac-Man persistente + la sección 🐛 Pad
// (nuevo/rastreado/regresión + crear BUG) siguen igual.
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';
import { mountHealthReview } from './health-review-modal.js';
import { mountOptimize } from './optimize-modal.js';
import { mountCoherence } from './coherence-modal.js';
import { launchResolveAll } from './health-resolve-all.js';

const API = '/api/health';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('es', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
};
function verdictLabel(verdict) {
  return {
    ok: t('system.healthScan.verdictOk', 'Todo en orden'),
    atencion: t('system.healthScan.verdictAttention', 'Requiere atención'),
    critico: t('system.healthScan.verdictCritical', 'CRÍTICO'),
  }[verdict];
}

function statusLabel(status) {
  return {
    pending: `⏳ ${t('system.healthScan.statusPending', 'pendiente')}`,
    running: `⟳ ${t('system.healthScan.statusRunning', 'corriendo')}`,
    done: `✓ ${t('system.healthScan.statusDone', 'listo')}`,
    error: `✕ ${t('system.healthScan.statusError', 'error')}`,
  }[status];
}

export function openHealthScan(ctx, { isAdmin }) {
  const { dialog } = ctx;
  const m = dialog.openModal({ title: `🩺 ${t('system.healthScan.modalTitle', 'Escaneo de Salud')}`, width: 920 });
  m.card.classList.add('dlg-card--health');
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  let alive = true; let pollTimer = null; let last = null;
  const mounted = []; // instancias { stop } de las secciones de motor montadas
  const origClose = m.close;
  m.close = () => { alive = false; clearTimeout(pollTimer); mounted.forEach((i) => { try { i?.stop?.(); } catch { /* noop */ } }); origClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });

  const wrap = document.createElement('div');
  wrap.className = 'hs-wrap';
  m.body.appendChild(wrap);
  // DOS zonas: `top` se re-renderiza con el poll del escaneo (veredicto +
  // resumen + Pad, que dependen del estado); `engines` se construye UNA vez con
  // las secciones de motor montadas inline (persisten entre re-renders del top).
  const top = document.createElement('div');
  const engines = document.createElement('div');
  wrap.appendChild(top);
  wrap.appendChild(engines);

  async function launch(full) {
    if (!isAdmin) { await dialog.alertDialog({ title: t('system.healthScan.shortTitle', 'Escaneo'), message: t('system.healthScan.adminOnly', 'Solo un administrador puede lanzar el escaneo (consume tokens).') }); return; }
    const ok = await dialog.confirmDialog({
      title: t('system.healthScan.modalTitle', 'Escaneo de Salud'),
      message: t('system.healthScan.launchMessage', 'Corre Revisión{mode} + Optimización + Coherencia + verificación de Pad en una sola pasada.\n\nConsume tokens. ¿Arrancar?', { mode: full ? t('system.healthScan.fullModeSuffix', ' COMPLETA (ignora caché)') : t('system.healthScan.incrementalModeSuffix', ' (incremental)') }),
      confirmText: t('system.healthScan.start', 'Arrancar'),
    });
    if (!ok) return;
    try {
      const r = await fetch(`${API}/scan-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); await dialog.alertDialog({ title: t('system.healthScan.shortTitle', 'Escaneo'), message: e.error || t('system.healthScan.launchFailed', 'No se pudo lanzar.') }); return; }
      poll();
    } catch (e) { await dialog.alertDialog({ title: t('system.healthScan.shortTitle', 'Escaneo'), message: String(e.message || e) }); }
  }

  async function createBug(finding, btn) {
    const ok = await dialog.confirmDialog({
      title: t('system.healthScan.createBugTitle', 'Crear BUG en Pad'),
      message: t('system.healthScan.createBugMessage', 'Crear un BUG en Pad (workspace console) desde este hallazgo?\n\n{detail}', { detail: finding.area || finding.detail || '' }),
      confirmText: t('system.healthScan.create', 'Crear'),
    });
    if (!ok) return;
    btn.disabled = true; btn.textContent = t('system.healthScan.ellipsis', '…');
    try {
      const r = await fetch(`${API}/scan-pad-bug`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ finding }) });
      const j = await r.json();
      if (r.ok) { btn.textContent = `✓ ${j.ref || t('system.healthScan.created', 'creado')}`; btn.classList.add('hs-created'); }
      else { btn.disabled = false; btn.textContent = t('system.healthScan.createBug', 'Crear BUG'); await dialog.alertDialog({ title: t('system.healthScan.padTitle', 'Pad'), message: j.error || t('system.healthScan.genericError', 'Error') }); }
    } catch (e) { btn.disabled = false; btn.textContent = t('system.healthScan.createBug', 'Crear BUG'); await dialog.alertDialog({ title: t('system.healthScan.padTitle', 'Pad'), message: String(e.message || e) }); }
  }

  // ===== Header (veredicto + botones) =====
  function headerHtml(d) {
    const running = d?.running;
    const verdict = d?.verdict;
    const p = d?.progress || {};
    let progress = '';
    if (running) {
      const rev = p.review ? t('system.healthScan.reviewProgress', 'Revisión {done}/{total}', { done: p.review.done ?? 0, total: p.review.total ?? '?' }) : t('system.healthScan.reviewPending', 'Revisión …');
      const opt = `${t('system.healthScan.optimShort', 'Optim')} ${statusLabel(p.optimize?.status) || '⏳'}`;
      const coh = `${t('system.healthScan.coherenceLabel', 'Coherencia')} ${statusLabel(p.coherence?.status) || '⏳'}`;
      const phase = d.phase ? ` · ${t('system.healthScan.phaseLabel', 'fase:')} ${esc(d.phase)}` : '';
      progress = `<p class="hp-running">${pacman({ state: 'delegating' })} ${esc([rev, opt, coh].join(' · '))}${phase}</p>`;
    }
    const badge = running
      ? `<span class="hp-verdict hp-verdict--atencion" style="display:inline-block"><b>${t('system.healthScan.scanning', 'Escaneando…')}</b></span>`
      : (verdict ? `<span class="hp-verdict hp-verdict--${esc(verdict)}" style="display:inline-block"><b>${verdictLabel(verdict) || t('system.healthScan.noVerdict', 'Sin veredicto')}</b><span class="hp-when">${d.finishedAt ? fmtDate(d.finishedAt) : ''}</span></span>` : `<span class="hp-when">${t('system.healthScan.noPreviousScan', 'Sin escaneo previo')}</span>`);
    const open = d?.openCount;
    // "Resolver todo" (F2): visible para admin cuando NO corre un escaneo y hay
    // hallazgos abiertos. Deshabilitado si no hay nada que resolver.
    const resolveBtn = isAdmin && !running
      ? `<button class="btn btn--sm" data-act="resolveall" ${open ? '' : 'disabled'} title="${esc(t('system.healthScan.resolveAllTitle', 'Resolver todos los hallazgos abiertos con el Orquestador (en paralelo, supervisado)'))}">🤖 <span>${open ? t('system.healthScan.resolveAllN', 'Resolver todo ({n})', { n: open }) : t('system.healthScan.resolveAllNone', 'Nada que resolver')}</span></button>`
      : '';
    const launchBtns = running
      ? `<span class="hp-when">${t('system.healthScan.inProgress', 'en curso…')}</span>`
      : `<button class="btn btn--sm" data-act="run">${icon('gear', { size: 13 })}<span>${t('system.healthScan.incrementalScan', 'Escaneo incremental')}</span></button>
         <button class="btn-ghost btn--sm" data-act="runfull">${t('system.healthScan.fullScan', 'Completo')}</button>`;
    return `<div class="hs-head">${badge}<span class="hs-head-actions">${resolveBtn}${launchBtns}</span></div>${progress}`;
  }

  // ===== Resumen (tabla de progreso, depende del estado) =====
  function summaryHtml(d) {
    if (!d || (!d.verdict && !d.running)) return `<p class="hp-empty">${t('system.healthScan.notRun', 'Todavía no se corrió un Escaneo de Salud. Usá el botón de arriba — corre los 4 análisis en una pasada.')}</p>`;
    const p = d.progress || {};
    const pad = d.pad;
    return `<details class="hs-engine" ${isMobile ? '' : 'open'}>
      <summary>📊 ${t('system.healthScan.tabSummary', 'Resumen')}</summary>
      <div class="hs-summary">
        <table class="hs-grid"><tbody>
          <tr><td>🔬 ${t('system.healthScan.reviewLabel', 'Revisión')}</td><td>${p.review ? `${p.review.done ?? 0}/${p.review.total ?? '?'} ${t('system.healthScan.units', 'unidades')}${p.review.reused ? ` (${t('system.healthScan.cachedCount', '{count} cacheadas', { count: p.review.reused })})` : ''}` : '—'}</td></tr>
          <tr><td>🧠 ${t('system.healthScan.optimizationLabel', 'Optimización')}</td><td>${statusLabel(p.optimize?.status) || '—'}${p.optimize?.count != null ? ` · ${t('system.healthScan.proposalsCount', '{count} propuesta(s)', { count: p.optimize.count })}` : ''}</td></tr>
          <tr><td>🔗 ${t('system.healthScan.coherenceLabel', 'Coherencia')}</td><td>${statusLabel(p.coherence?.status) || '—'}${p.coherence?.count != null ? ` · ${t('system.healthScan.proposalsCount', '{count} propuesta(s)', { count: p.coherence.count })}` : ''}</td></tr>
          <tr><td>🐛 ${t('system.healthScan.padLabel', 'Pad')}</td><td>${pad ? `${t('system.healthScan.padStats', '{newCount} nuevo(s) · {trackedCount} rastreado(s) · {regressionCount} regresión(es) · {openCount} BUG abiertos', { newCount: pad.nuevo?.length || 0, trackedCount: pad.rastreado?.length || 0, regressionCount: pad.regresion?.length || 0, openCount: pad.openCount ?? '?' })}` : '—'}</td></tr>
        </tbody></table>
        ${d.error ? `<p class="hp-empty">⚠️ ${esc(d.error)}</p>` : ''}
        <p class="hp-when">${esc(t('system.healthScan.modeDetailInline', 'Modo: {mode} · abrí cada sección para accionar los hallazgos.', { mode: d.mode || 'incremental' }))}</p>
      </div>
    </details>`;
  }

  // ===== Pad (cross-check, depende del estado) =====
  function findingRow(f, kind) {
    const sev = f.severity || 'medium';
    const match = f.match ? `<span class="hs-match" title="${esc(t('system.healthScan.matchesTitle', 'matchea {ref} ({score}%)', { ref: f.match.ref, score: f.match.score }))}">${esc(f.match.ref)}</span>` : '';
    const create = kind === 'nuevo' ? `<button class="btn-ghost btn--sm" data-newbug>${t('system.healthScan.createBug', 'Crear BUG')}</button>` : '';
    return `<div class="hs-frow hs-frow--${kind}" data-fkey="${esc(JSON.stringify(f)).replace(/"/g, '&quot;')}">
      <span class="hs-sev hs-sev--${esc(sev)}">${esc(sev)}</span>
      <span class="hs-fmod">${esc(f.module || '?')}</span>
      <span class="hs-fdet">${esc(f.area || f.detail || '')}</span>
      ${match}${create}
    </div>`;
  }

  function padHtml(pad) {
    const inner = () => {
      if (!pad) return `<p class="hp-empty">${t('system.healthScan.noPadYet', 'El cross-check con Pad corre al final del escaneo — todavía no hay datos.')}</p>`;
      if (pad.available === false) return `<p class="hp-empty">${esc(t('system.healthScan.padUnavailable', 'Pad local no respondió ({error}). El escaneo sigue igual; reintentá cuando esté arriba.', { error: pad.error || '' }))}</p>`;
      const sec = (title, arr, kind, hint) => `
        <details class="hs-padsec" ${kind === 'nuevo' || kind === 'regresion' ? 'open' : ''}>
          <summary>${title} <b>${arr.length}</b></summary>
          <p class="hp-when">${hint}</p>
          ${arr.length ? arr.map((f) => findingRow(f, kind)).join('') : '<p class="hp-when" style="padding:.2rem">—</p>'}
        </details>`;
      return `<div class="hs-pad">
        <p class="hp-when">${t('system.healthScan.padCrossCheckSummary', 'Cross-check de los hallazgos de la Revisión contra la colección Bugs de Pad (workspace console). {count} BUG abiertos hoy.', { count: pad.openCount ?? '?' })}</p>
        ${sec(`🆕 ${t('system.healthScan.newBugsTitle', 'Nuevos (no rastreados)')}`, pad.nuevo || [], 'nuevo', t('system.healthScan.newBugsHint', 'No matchean ningún BUG. Podés crearlos en Pad con confirmación.'))}
        ${sec(`⚠️ ${t('system.healthScan.regressionsTitle', 'Regresiones')}`, pad.regresion || [], 'regresion', t('system.healthScan.regressionsHint', 'Matchean un BUG fixed/wontfix → reaparecieron. Revisar.'))}
        ${sec(`🔗 ${t('system.healthScan.trackedTitle', 'Ya rastreados')}`, pad.rastreado || [], 'rastreado', t('system.healthScan.trackedHint', 'Ya están en el backlog de Pad — no hace falta re-crearlos.'))}
      </div>`;
    };
    return `<details class="hs-engine">
      <summary>🐛 ${t('system.healthScan.tabPad', 'Pad')}</summary>
      ${inner()}
    </details>`;
  }

  // Re-render de la zona `top` (header + resumen + pad). NO toca `engines`.
  function renderTop() {
    const d = last;
    top.innerHTML = `${headerHtml(d)}${summaryHtml(d)}${padHtml(d?.pad)}`;
    top.querySelector('[data-act="run"]')?.addEventListener('click', () => launch(false));
    top.querySelector('[data-act="runfull"]')?.addEventListener('click', () => launch(true));
    top.querySelector('[data-act="resolveall"]')?.addEventListener('click', () => resolveAll());
    for (const b of top.querySelectorAll('[data-newbug]')) {
      b.addEventListener('click', () => {
        try { const f = JSON.parse(b.closest('[data-fkey]').dataset.fkey.replace(/&quot;/g, '"')); createBug(f, b); } catch { /* noop */ }
      });
    }
  }

  // ===== Secciones de motor: montadas inline, lazy al abrir =====
  function engineSection(label, mountFn) {
    const det = document.createElement('details');
    det.className = 'hs-engine';
    det.innerHTML = `<summary>${label}</summary><div class="hs-engine-body"></div>`;
    const body = det.querySelector('.hs-engine-body');
    let inst = null;
    det.addEventListener('toggle', () => {
      if (det.open && !inst) {
        inst = mountFn(body, ctx, { isAdmin, onClose: () => m.close() });
        mounted.push(inst);
      } else if (!det.open && inst) {
        try { inst.stop?.(); } catch { /* noop */ }
        const i = mounted.indexOf(inst); if (i >= 0) mounted.splice(i, 1);
        inst = null; body.innerHTML = '';
      }
    });
    return det;
  }

  function buildEngines() {
    engines.innerHTML = '';
    engines.appendChild(engineSection(`🔬 ${t('system.healthScan.tabReview', 'Revisión')}`, mountHealthReview));
    engines.appendChild(engineSection(`🧠 ${t('system.healthScan.tabOptimization', 'Optimización')}`, mountOptimize));
    engines.appendChild(engineSection(`🔗 ${t('system.healthScan.tabCoherence', 'Coherencia')}`, mountCoherence));
  }

  // "Resolver todo" (F2): delega en el lanzador del Orquestador Interno.
  async function resolveAll() {
    await launchResolveAll(ctx, { isAdmin, onClose: () => m.close() });
  }

  async function poll() {
    try {
      const d = await (await fetch(`${API}/scan-all`)).json();
      if (!alive) return;
      last = d; renderTop();
      if (d.running) pollTimer = setTimeout(poll, 3000);
    } catch {
      if (alive) { top.innerHTML = `<p class="hp-empty">${t('system.healthScan.readError', 'No se pudo leer el estado del escaneo.')}</p>`; }
    }
  }

  buildEngines();
  renderTop();
  poll();
}
