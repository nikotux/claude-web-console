// modules/system/health-panel.js — pestaña "Salud" del menú Sistema.
//
// Arriba: chequeos rápidos en vivo (GET /api/health/checks, gratis).
// Al medio: última revisión profunda con Claude (caché) + botón para correrla
// (POST /api/health/review — admin, consume tokens, con confirm previo).
// Abajo: Optimización IA de los motores — MISMO patrón que la revisión:
// resumen compacto (GET /api/health/optimization, 0 tokens) + botón que abre
// la sub-ventana (optimize-modal.js) con el censo, el análisis y las
// propuestas aprobables.
// SOLO salud: la gestión de bugfixes/PRs vive en el modal "Enviar PR" de la
// sección Tolkien (se quitó de acá por redundante).
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';
import { openHealthReview } from './health-review-modal.js';
import { openOptimize } from './optimize-modal.js';

const API = '/api/health';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' +
    d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};

const VERDICT_LABEL = { ok: 'Todo en orden', atencion: 'Requiere atención', critico: 'CRÍTICO' };

export function mountHealthPanel(el, ctx) {
  const { dialog, isAdmin } = ctx;

  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">Chequeos rápidos</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="reload" title="Refrescar chequeos">${icon('refresh', { size: 13 })}</button>
    </div>
    <div class="hp-checks" data-ref="checks"><span class="cwc-spinner"></span></div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">Revisión profunda con Claude</span>
    </div>
    <div class="hp-review" data-ref="review">cargando…</div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">🧠 Optimización IA</span>
    </div>
    <div class="hp-review" data-ref="opt">cargando…</div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;
  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  // ===== chequeos rápidos =====
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

  // ===== revisión exhaustiva (resumen compacto + botón que abre el modal) =====
  // El detalle vive en la sub-ventana full-screen (health-review-modal.js):
  // barra de progreso, módulos y hallazgos accionables. Acá solo el último
  // veredicto cacheado y el acceso.
  function renderReview(d) {
    const parts = [];
    if (d.verdict) {
      parts.push(`
        <div class="hp-verdict hp-verdict--${esc(d.verdict)}">
          <b>${VERDICT_LABEL[d.verdict] || 'Sin veredicto'}</b>
          <span class="hp-when">${d.findings?.length || 0} hallazgo(s)${d.updatedAt ? ` · ${fmtDate(d.updatedAt)}` : ''}</span>
        </div>`);
    } else {
      parts.push('<p class="hp-empty">Todavía no se corrió ninguna revisión exhaustiva.</p>');
    }
    if (d.running) {
      parts.push(`<p class="hp-running">${pacman()} Revisión en curso · ${d.done || 0}/${d.total || '?'} módulos…</p>`);
    }
    parts.push(`<button class="btn btn--block" data-ref="open">${icon('gear', { size: 14 })}<span>${d.running ? 'Ver revisión en curso' : 'Revisión exhaustiva →'}</span></button>`);
    refs.review.innerHTML = parts.join('');
    refs.review.querySelector('[data-ref="open"]')?.addEventListener('click', () => {
      openHealthReview(ctx, { isAdmin });
      // al cerrar el modal, refrescar el resumen
      setTimeout(loadReview, 500);
    });
  }

  async function loadReview() {
    try {
      const d = await (await fetch(`${API}/review`)).json();
      if (!alive) return;
      renderReview(d);
      if (d.running) setTimeout(loadReview, 5000); // mantener el resumen fresco
    } catch {
      if (alive) refs.review.innerHTML = '<p class="hp-empty">No se pudo leer la revisión.</p>';
    }
  }

  // ===== Optimización IA (resumen compacto + botón que abre el modal) =====
  // Mismo patrón que la revisión: acá solo el veredicto persistido (0 tokens);
  // el censo, el análisis y las propuestas viven en optimize-modal.js.
  function renderOpt(d) {
    const parts = [];
    if (d.updatedAt && d.resumen) {
      const pend = (d.propuestas || []).filter((p) => p.status === 'pending').length;
      parts.push(`
        <div class="hp-verdict hp-verdict--${pend ? 'atencion' : 'ok'}">
          <b>${pend ? `${pend} propuesta(s) pendiente(s)` : 'Sin propuestas pendientes'}</b>
          <span class="hp-when">${d.enginesCount ? `${d.enginesCount} motores · ` : ''}${fmtDate(d.updatedAt)}</span>
        </div>`);
    } else {
      parts.push('<p class="hp-empty">Todavía no se corrió ningún análisis de optimización.</p>');
    }
    if (d.running) {
      parts.push(`<p class="hp-running">${pacman()} Analizando · ${esc(d.progress?.phase || '…')}</p>`);
    }
    parts.push(`<button class="btn btn--block" data-ref="openopt">${icon('gear', { size: 14 })}<span>${d.running ? 'Ver análisis en curso' : 'Optimización IA →'}</span></button>`);
    refs.opt.innerHTML = parts.join('');
    refs.opt.querySelector('[data-ref="openopt"]')?.addEventListener('click', () => {
      openOptimize(ctx, { isAdmin });
      // al cerrar el modal, refrescar el resumen
      setTimeout(loadOpt, 500);
    });
  }

  async function loadOpt() {
    try {
      const d = await (await fetch(`${API}/optimization`)).json();
      if (!alive) return;
      renderOpt(d);
      if (d.running) setTimeout(loadOpt, 5000); // mantener el resumen fresco
    } catch {
      if (alive) refs.opt.innerHTML = '<p class="hp-empty">No se pudo leer la optimización.</p>';
    }
  }

  refs.reload.addEventListener('click', loadChecks);
  loadChecks();
  loadReview();
  loadOpt();
}
