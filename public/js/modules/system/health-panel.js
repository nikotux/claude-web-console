// modules/system/health-panel.js — pestaña "Salud" del menú Sistema.
//
// Arriba: chequeos rápidos en vivo (GET /api/health/checks, gratis).
// Abajo: última revisión profunda con Claude (caché) + botón para correrla
// (POST /api/health/review — admin, consume tokens, con confirm previo).
// SOLO salud: la gestión de bugfixes/PRs vive en el modal "Enviar PR" de la
// sección Tolkien (se quitó de acá por redundante).
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';

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
    <div class="hp-review" data-ref="review">cargando…</div>`;

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

  // ===== revisión IA =====
  function renderReview(data) {
    const parts = [];
    if (data.updatedAt) {
      parts.push(`
        <div class="hp-verdict hp-verdict--${esc(data.verdict || 'atencion')}">
          <b>${VERDICT_LABEL[data.verdict] || 'Sin veredicto'}</b>
          <span class="hp-when">${fmtDate(data.updatedAt)}</span>
        </div>
        ${data.summary ? `<p class="hp-summary">${esc(data.summary)}</p>` : ''}`);
      if (data.findings?.length) {
        parts.push(`<div class="hp-findings">${data.findings.map((f) => `
          <details class="hp-finding">
            <summary><span class="hp-dot hp-dot--${f.severity === 'low' ? 'ok' : f.severity === 'critical' || f.severity === 'high' ? 'fail' : 'warn'}"></span>
              <b>${esc(f.area)}</b> <span class="hp-sev">${esc(f.severity)}</span></summary>
            <p>${esc(f.detail)}${f.file ? ` <code>${esc(f.file)}</code>` : ''}</p>
          </details>`).join('')}</div>`);
      }
    } else {
      parts.push('<p class="hp-empty">Todavía no se corrió ninguna revisión.</p>');
    }
    if (data.error) parts.push(`<p class="hp-error">Último intento falló: ${esc(data.error)}</p>`);
    if (data.running) {
      parts.push(`<p class="hp-running">${pacman()} Claude está revisando el proyecto… (puede tardar unos minutos)</p>`);
    } else if (isAdmin) {
      parts.push(`<button class="btn btn--block" data-ref="run">${icon('gear', { size: 14 })}<span>Revisar ahora con Claude</span></button>`);
    }
    refs.review.innerHTML = parts.join('');
    refs.review.querySelector('[data-ref="run"]')?.addEventListener('click', runReview);
  }

  async function loadReview() {
    try {
      const data = await (await fetch(`${API}/review`)).json();
      if (!alive) return;
      renderReview(data);
      if (data.running) setTimeout(pollReview, 5000);
    } catch {
      if (alive) refs.review.innerHTML = '<p class="hp-empty">No se pudo leer la última revisión.</p>';
    }
  }

  async function pollReview() {
    if (!alive) return;
    try {
      const data = await (await fetch(`${API}/review`)).json();
      renderReview(data);
      if (data.running) setTimeout(pollReview, 5000);
    } catch { /* reintenta el próximo open */ }
  }

  async function runReview() {
    const ok = await dialog.confirmDialog({
      title: 'Revisión profunda con Claude',
      message: 'Claude Code va a leer la guía del proyecto y auditar el código (solo lectura). Tarda unos minutos y CONSUME TOKENS de tu suscripción.',
      confirmLabel: 'Revisar',
    });
    if (!ok) return;
    renderReview({ ...(await (await fetch(`${API}/review`)).json().catch(() => ({}))), running: true });
    try {
      const res = await fetch(`${API}/review`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!alive) return;
      if (!res.ok) { renderReview({ ...data, error: data.error || 'Falló la revisión.', running: false }); return; }
      renderReview({ ...data, running: false });
    } catch (e) {
      if (alive) renderReview({ error: e.message, running: false });
    }
  }

  refs.reload.addEventListener('click', loadChecks);
  loadChecks();
  loadReview();
}
