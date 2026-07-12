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
import { pacman } from '../../ui/pacman.js';
import { openHealthScan } from './health-scan-modal.js';

const API = '/api/health';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('es', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
};
const VERDICT_LABEL = { ok: 'Todo en orden', atencion: 'Requiere atención', critico: 'CRÍTICO' };

export function mountHealthPanel(el, ctx) {
  const { isAdmin } = ctx;

  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">Chequeos rápidos</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="reload" title="Refrescar chequeos">${icon('refresh', { size: 13 })}</button>
    </div>
    <div class="hp-checks" data-ref="checks"><span class="cwc-spinner"></span></div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">🩺 Escaneo de Salud</span>
    </div>
    <div class="hp-review" data-ref="scan">cargando…</div>`;

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
        <div class="hp-sum">${data.ok} ok${data.warn ? ` · ${data.warn} aviso(s)` : ''}${data.fail ? ` · ${data.fail} FALLA(s)` : ''}</div>`;
    } catch {
      if (alive) refs.checks.innerHTML = '<div class="hp-empty">No se pudieron correr los chequeos.</div>';
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
      const rev = p.review ? `Revisión ${p.review.done ?? 0}/${p.review.total ?? '?'}` : '';
      const opt = p.optimize ? `Optim ${p.optimize.status || '—'}` : '';
      const coh = p.coherence ? `Coherencia ${p.coherence.status || '—'}` : '';
      const pad = d.pad ? ` · Pad: ${d.pad.nuevo?.length || 0}🆕 ${d.pad.regresion?.length || 0}⚠️` : '';
      parts.push(`
        <div class="hp-verdict hp-verdict--${esc(shown)}">
          <b>${d.running ? 'Escaneando…' : (VERDICT_LABEL[shown] || 'Sin veredicto')}</b>
          <span class="hp-when">${d.finishedAt ? fmtDate(d.finishedAt) : (d.startedAt ? fmtDate(d.startedAt) : '')}</span>
        </div>`);
      if (d.running) parts.push(`<p class="hp-running">${pacman({ state: 'delegating' })} ${esc([rev, opt, coh].filter(Boolean).join(' · '))}${esc(pad)}</p>`);
      else if (d.pad) parts.push(`<p class="hp-when" style="padding:.2rem .1rem">🐛 Pad: ${d.pad.nuevo?.length || 0} nuevo(s) · ${d.pad.rastreado?.length || 0} rastreado(s) · ${d.pad.regresion?.length || 0} regresión(es)</p>`);
    } else {
      parts.push('<p class="hp-empty">Todavía no se corrió un Escaneo de Salud. Corre Revisión + Optimización + Coherencia + verificación de Pad en una sola pasada.</p>');
    }
    parts.push(`<button class="btn btn--block" data-ref="open">${icon('gear', { size: 14 })}<span>${d?.running ? 'Ver escaneo en curso' : 'Abrir Escaneo de Salud →'}</span></button>`);
    refs.scan.innerHTML = parts.join('');
    refs.scan.querySelector('[data-ref="open"]')?.addEventListener('click', () => {
      openHealthScan(ctx, { isAdmin });
      setTimeout(loadScan, 600);
    });
  }

  async function loadScan() {
    try {
      const d = await (await fetch(`${API}/scan-all`)).json();
      if (!alive) return;
      renderScan(d);
      if (d.running) setTimeout(loadScan, 5000); // mantener el resumen fresco mientras corre
    } catch {
      if (alive) refs.scan.innerHTML = '<p class="hp-empty">No se pudo leer el estado del escaneo.</p>';
    }
  }

  refs.reload.addEventListener('click', loadChecks);
  loadChecks();
  loadScan();
}
