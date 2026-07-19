// modules/system/health-panel.js — pestaña "Salud" del menú Sistema.
//
// Rediseño 2026-07-12 (pedido de Niko): los 3 botones IA sueltos (Optimización /
// Coherencia / Revisión) + el Dashboard se UNIFICARON en UN solo "🩺 Escaneo de
// Salud" que corre TODO en una pasada (orquestador desacoplado bajo un pool
// compartido + cross-check con Pad). Acá quedan solo DOS secciones:
//   1. Chequeos rápidos (GET /api/health/checks, 0 tokens, en vivo).
//   2. 🩺 Escaneo de Salud: veredicto/progreso compacto (GET /api/health/scan-all,
//      0 tokens) + botón que abre la sub-ventana unificada (health-scan-modal.js)
//      con las tabs (Revisión/Optimización/Coherencia/Dashboard/Pad), el Pac-Man
//      persistente y el lanzador.
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';
import { openHealthScan } from './health-scan-modal.js';
import { launchResolveAll } from './health-resolve-all.js';

const API = '/api/health';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('es', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
};
function verdictLabel(v) {
  return {
    ok: t('system.health.verdictOk', 'Todo en orden'),
    atencion: t('system.health.verdictAttention', 'Requiere atención'),
    critico: t('system.health.verdictCritical', 'CRÍTICO'),
  }[v];
}

export function mountHealthPanel(el, ctx) {
  const { isAdmin } = ctx;

  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.health.quickChecksTitle', 'Chequeos rápidos')}</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="reload" title="${t('system.health.refreshChecksTitle', 'Refrescar chequeos')}">${icon('refresh', { size: 13 })}</button>
    </div>
    <div class="hp-checks" data-ref="checks"><span class="cwc-spinner"></span></div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">🩺 ${t('system.health.healthScanTitle', 'Escaneo de Salud')}</span>
    </div>
    <div class="hp-review" data-ref="scan">${t('system.health.loading', 'cargando…')}</div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;
  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  // ===== Chequeos rápidos =====
  async function loadChecks() {
    refs.reload.disabled = true;
    try {
      const data = await (await fetch(`${API}/checks`)).json();
      if (!alive) return;
      refs.checks.innerHTML = data.checks.map((c) => `
        <div class="hp-row" title="${esc(c.id)}">
          <span class="hp-dot hp-dot--${c.status}"></span>
          <span class="hp-label">${esc(c.label)}</span>
          <span class="hp-detail">${esc(c.detail)}</span>
        </div>`).join('') + `
        <div class="hp-sum">${data.ok} ${t('system.health.okSuffix', 'ok')}${data.warn ? ` · ${data.warn} ${t('system.health.warningsSuffix', 'aviso(s)')}` : ''}${data.fail ? ` · ${data.fail} ${t('system.health.failuresSuffix', 'FALLA(s)')}` : ''}</div>`;
    } catch {
      if (alive) refs.checks.innerHTML = `<div class="hp-empty">${t('system.health.checksError', 'No se pudieron correr los chequeos.')}</div>`;
    } finally {
      refs.reload.disabled = false;
    }
  }

  // ===== Escaneo de Salud (resumen compacto + botón → sub-ventana unificada) =====
  function renderScan(d) {
    const parts = [];
    const verdict = d?.verdict;
    if (d && (verdict || d.running)) {
      const shown = verdict || 'atencion';
      const p = d.progress || {};
      const rev = p.review ? t('system.health.reviewProgress', 'Revisión {done}/{total}', { done: p.review.done ?? 0, total: p.review.total ?? '?' }) : '';
      const opt = p.optimize ? t('system.health.optimizeProgress', 'Optim {status}', { status: p.optimize.status || '—' }) : '';
      const coh = p.coherence ? t('system.health.coherenceProgress', 'Coherencia {status}', { status: p.coherence.status || '—' }) : '';
      const pad = d.pad ? ` · ${t('system.health.padLabel', 'Pad')}: ${d.pad.nuevo?.length || 0}🆕 ${d.pad.regresion?.length || 0}⚠️` : '';
      parts.push(`
        <div class="hp-verdict hp-verdict--${esc(shown)}">
          <b>${d.running ? t('system.health.scanning', 'Escaneando…') : (verdictLabel(shown) || t('system.health.noVerdict', 'Sin veredicto'))}</b>
          <span class="hp-when">${d.finishedAt ? fmtDate(d.finishedAt) : (d.startedAt ? fmtDate(d.startedAt) : '')}</span>
        </div>`);
      if (d.running) parts.push(`<p class="hp-running">${pacman({ state: 'delegating' })} ${esc([rev, opt, coh].filter(Boolean).join(' · '))}${esc(pad)}</p>`);
      else if (d.pad) parts.push(`<p class="hp-when" style="padding:.2rem .1rem">🐛 ${t('system.health.padLabel', 'Pad')}: ${d.pad.nuevo?.length || 0} ${t('system.health.padNew', 'nuevo(s)')} · ${d.pad.rastreado?.length || 0} ${t('system.health.padTracked', 'rastreado(s)')} · ${d.pad.regresion?.length || 0} ${t('system.health.padRegression', 'regresión(es)')}</p>`);
    } else {
      parts.push(`<p class="hp-empty">${t('system.health.notRun', 'Todavía no se corrió un Escaneo de Salud. Corre Revisión + Optimización + Coherencia + verificación de Pad en una sola pasada.')}</p>`);
    }
    // DOS botones (rediseño 2026-07-19, PLAN-752): Escanear (abre el escaneo
    // unificado, con el detalle accionable inline) + Resolver todo (Orquestador
    // Interno: agrupa los hallazgos abiertos y los resuelve en un chat
    // supervisado). "Resolver todo" solo para admin y si hay algo abierto.
    const openCount = d?.openCount;
    parts.push(`<button class="btn btn--block" data-ref="open">${icon('gear', { size: 14 })}<span>${d?.running ? t('system.health.viewRunningScan', 'Ver escaneo en curso') : t('system.health.openScan', 'Abrir Escaneo de Salud →')}</span></button>`);
    if (isAdmin && !d?.running && openCount) {
      parts.push(`<button class="btn btn--block" data-ref="resolveall">🤖 <span>${t('system.health.resolveAllN', 'Resolver todo ({n}) con el Orquestador', { n: openCount })}</span></button>`);
    }
    refs.scan.innerHTML = parts.join('');
    refs.scan.querySelector('[data-ref="open"]')?.addEventListener('click', () => {
      openHealthScan(ctx, { isAdmin });
      setTimeout(loadScan, 600);
    });
    refs.scan.querySelector('[data-ref="resolveall"]')?.addEventListener('click', () => {
      launchResolveAll(ctx, { isAdmin });
    });
  }

  async function loadScan() {
    try {
      const d = await (await fetch(`${API}/scan-all`)).json();
      if (!alive) return;
      renderScan(d);
      if (d.running) setTimeout(loadScan, 5000); // mantener el resumen fresco mientras corre
    } catch {
      if (alive) refs.scan.innerHTML = `<p class="hp-empty">${t('system.health.scanReadError', 'No se pudo leer el estado del escaneo.')}</p>`;
    }
  }

  refs.reload.addEventListener('click', loadChecks);
  loadChecks();
  loadScan();
}
