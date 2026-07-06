// modules/system/health-panel.js — pestaña "Salud" del menú Sistema.
//
// Arriba: chequeos rápidos en vivo (GET /api/health/checks, gratis).
// "📊 Dashboard del proyecto" (2026-07-06): resumen compacto (GET
// /api/health/scan, 0 tokens) + botón que abre la sub-ventana
// (inventory-modal.js) con el detalle REAL — recursos del servidor (núcleos/
// CPU/RAM/disco), módulos backend (con sus endpoints y línea de registro),
// módulos frontend (montaje), runners y motores IA. Antes era un chip
// colapsable inline que solo mostraba conteos ("11 módulos") sin decir
// cuáles ni exponer CPU/RAM (pedido del usuario: más amigable y más detalle).
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
import { openCoherence } from './coherence-modal.js';
import { openInventory } from './inventory-modal.js';

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
      <span class="hp-title">📊 Dashboard del proyecto</span>
      <button class="btn-ghost btn--sm btn--icon" data-ref="scanReload" title="Re-escanear ahora">${icon('refresh', { size: 13 })}</button>
    </div>
    <div data-ref="scan">cargando…</div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">Revisión profunda con Claude</span>
    </div>
    <div class="hp-review" data-ref="review">cargando…</div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">🧠 Optimización IA</span>
    </div>
    <div class="hp-review" data-ref="opt">cargando…</div>

    <div class="hp-head hp-head--review">
      <span class="hp-title">🔗 Coherencia</span>
    </div>
    <div class="hp-review" data-ref="coh">cargando…</div>`;

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

  // ===== Dashboard del proyecto (resumen compacto → sub-ventana con detalle) =====
  // GET /api/health/scan (0 tokens, sin LLM) — cuenta y da un adelanto de
  // recursos del servidor; el detalle REAL (endpoints por módulo backend,
  // montaje por módulo frontend, núcleos/CPU/RAM/disco) vive en la sub-ventana
  // (inventory-modal.js, mismo patrón que Optimización IA/Coherencia: acá solo
  // el veredicto + botón).
  let scanning = false;

  function renderScan(d, err) {
    if (err) { refs.scan.innerHTML = '<p class="hp-empty">No se pudo leer el censo.</p>'; return; }
    if (!d) {
      refs.scan.innerHTML = scanning
        ? '<p class="hp-empty"><span class="cwc-spinner"></span> Escaneando…</p>'
        : '<p class="hp-empty">Todavía no se corrió el censo.</p>';
      return;
    }
    const warn = d.unregistered.length
      ? `<span class="hp-opt-risk hp-opt-risk--medio">⚠️ ${d.unregistered.length} sin registrar</span>` : '';
    const res = d.resources
      ? `${d.resources.cpu.cores} núcleo(s) · CPU ${Math.round(d.resources.cpu.pct)}% · RAM ${Math.round(d.resources.mem.pct)}% · `
      : '';
    refs.scan.innerHTML = `
      <div class="hp-verdict hp-verdict--${d.unregistered.length ? 'atencion' : 'ok'}">
        <b>${d.counts.modules} backend · ${d.counts.frontend} frontend · ${d.counts.runners} runners · ${d.counts.aiEngines} motor(es) IA</b>
        ${warn}
        <span class="hp-when">${res}${fmtDate(d.generatedAt)}</span>
      </div>
      <button class="btn btn--block" data-ref="openinv">${icon('search', { size: 14 })}<span>Ver dashboard completo →</span></button>`;
    refs.scan.querySelector('[data-ref="openinv"]')?.addEventListener('click', () => {
      openInventory(ctx);
    });
  }

  let lastScan = null;
  async function loadScan(force) {
    scanning = true;
    renderScan(lastScan);
    try {
      const d = await (await fetch(`${API}/scan${force ? '?force=1' : ''}`)).json();
      if (!alive) return;
      lastScan = d;
      scanning = false;
      renderScan(d);
    } catch {
      if (!alive) return;
      scanning = false;
      renderScan(lastScan, true);
    }
  }

  // ===== revisión exhaustiva (resumen compacto + botón que abre el modal) =====
  // El detalle vive en la sub-ventana full-screen (health-review-modal.js):
  // barra de progreso, módulos y hallazgos accionables. Acá solo el último
  // veredicto cacheado y el acceso.
  function renderReview(d) {
    const parts = [];
    if (d.verdict) {
      // Veredicto EN VIVO (backend enrichReview): baja de crítico→atención→ok a
      // medida que se resuelven hallazgos. Fallback al de la síntesis por si un
      // review viejo aún no trae liveVerdict.
      const shown = d.liveVerdict || d.verdict;
      const open = d.openCount ?? (d.findings?.length || 0);
      const resolved = d.resolvedCount || 0;
      parts.push(`
        <div class="hp-verdict hp-verdict--${esc(shown)}">
          <b>${VERDICT_LABEL[shown] || 'Sin veredicto'}</b>
          <span class="hp-when">${open} sin resolver${resolved ? ` · ${resolved} resuelto(s)` : ''}${d.updatedAt ? ` · ${fmtDate(d.updatedAt)}` : ''}</span>
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

  // ===== Coherencia (resumen compacto + botón que abre el modal) =====
  // Mismo patrón que Optimización IA: acá solo el veredicto (hallazgos
  // determinísticos + propuestas pendientes); el grafo, los hallazgos y las
  // propuestas viven en coherence-modal.js.
  function renderCoh(d) {
    const parts = [];
    const detFindings = d.findingsCount ?? (d.findings?.length || 0);
    if (d.updatedAt && d.resumen) {
      const pend = (d.propuestas || []).filter((p) => p.status === 'pending').length;
      parts.push(`
        <div class="hp-verdict hp-verdict--${pend ? 'atencion' : 'ok'}">
          <b>${pend ? `${pend} propuesta(s) pendiente(s)` : 'Sin propuestas pendientes'}</b>
          <span class="hp-when">${detFindings ? `${detFindings} hallazgo(s) · ` : ''}${fmtDate(d.updatedAt)}</span>
        </div>`);
    } else {
      parts.push('<p class="hp-empty">Todavía no se corrió ningún análisis de coherencia (hay hallazgos determinísticos gratis adentro).</p>');
    }
    if (d.running) {
      parts.push(`<p class="hp-running">${pacman()} Analizando · ${esc(d.progress?.phase || '…')}</p>`);
    }
    parts.push(`<button class="btn btn--block" data-ref="opencoh">${icon('gear', { size: 14 })}<span>${d.running ? 'Ver análisis en curso' : 'Coherencia →'}</span></button>`);
    refs.coh.innerHTML = parts.join('');
    refs.coh.querySelector('[data-ref="opencoh"]')?.addEventListener('click', () => {
      openCoherence(ctx, { isAdmin });
      setTimeout(loadCoh, 500);
    });
  }

  async function loadCoh() {
    try {
      const d = await (await fetch(`${API}/coherence`)).json();
      if (!alive) return;
      renderCoh(d);
      if (d.running) setTimeout(loadCoh, 5000); // mantener el resumen fresco
    } catch {
      if (alive) refs.coh.innerHTML = '<p class="hp-empty">No se pudo leer la coherencia.</p>';
    }
  }

  refs.reload.addEventListener('click', loadChecks);
  refs.scanReload.addEventListener('click', () => loadScan(true));
  loadChecks();
  loadScan();
  loadReview();
  loadOpt();
  loadCoh();
}
