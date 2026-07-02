// modules/usage/usage.js — Uso de tokens.
//
// En el pie: SOLO el costo de HOY (botón). Todo el detalle (total global,
// proyectos con barra apilada por modelo, desglose exacto) vive en el modal
// "Uso" que abre ese botón. Mismos datos y endpoint de siempre
// (/api/tokens/summary); nueva presentación.
import { modelColor, modelName } from '../../ui/models.js';

const POLL_MS = 15000;

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
const fmtCost = (c) => `$${(c || 0).toFixed(2)}`;

function fmtRelative(ms) {
  if (!ms) return 'sin actividad';
  const diffS = Math.floor((Date.now() - ms) / 1000);
  if (diffS < 60) return 'hace instantes';
  const min = Math.floor(diffS / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d} d`;
  return new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' });
}

async function fetchSummary() {
  const res = await fetch('/api/tokens/summary');
  if (!res.ok) throw new Error();
  return res.json();
}

function segsFor(p) {
  const models = p.models || [];
  if (!models.length) return '';
  return models.map((m) => {
    const share = p.cost ? (m.cost / p.cost) * 100 : 100 / models.length;
    const name = modelName(m.key, m.model);
    return `<span class="tok-seg" style="width:${share}%;background:${modelColor(m.key)}" title="${name}: ${fmtTokens(m.tokens)} tok · ${fmtCost(m.cost)}"></span>`;
  }).join('');
}

function detailFor(p) {
  const rows = (p.models || []).map((m) => `
    <div class="tok-detail-row">
      <span class="tok-dot" style="background:${modelColor(m.key)}"></span>
      <span class="tok-detail-name">${modelName(m.key, m.model)}</span>
      <span class="tok-detail-tok">${fmtTokens(m.tokens)}</span>
      <span class="tok-detail-cost">${fmtCost(m.cost)}</span>
    </div>`).join('');
  const cache = (p.cacheWrite || 0) + (p.cacheRead || 0);
  return `
    <div class="tok-detail" hidden>
      ${rows}
      <div class="tok-detail-foot">entrada ${fmtTokens(p.input || 0)} · salida ${fmtTokens(p.output || 0)} · caché ${fmtTokens(cache)}</div>
      <div class="tok-detail-foot">${fmtRelative(p.lastMtime)}</div>
    </div>`;
}

function renderProjects(container, sum) {
  if (!sum.projects.length) {
    container.innerHTML = '<div class="tok-empty">sin datos</div>';
    return;
  }
  const max = sum.projects[0].cost || 1;
  container.innerHTML = `
    <div class="usage-totals">
      <div class="usage-total-row"><span>Total</span><span class="tok-big">${fmtTokens(sum.totals.tokens)}</span><span class="tok-cost">${fmtCost(sum.totals.cost)}</span></div>
      <div class="usage-total-row"><span>Hoy</span><span>${fmtTokens(sum.today.tokens)}</span><span class="tok-cost">${fmtCost(sum.today.cost)}</span></div>
    </div>` +
    sum.projects.map((p) => {
      const w = Math.max(4, Math.round((p.cost / max) * 100));
      return `
        <div class="tok-row" title="${p.name}">
          <div class="tok-row-top">
            <span class="tok-name">${p.label}</span>
            <span class="tok-row-cost">${fmtCost(p.cost)}</span>
          </div>
          <span class="tok-bar"><span class="tok-fill" style="width:${w}%">${segsFor(p)}</span></span>
          <div class="tok-row-sub">${fmtTokens(p.tokens)} tok · ${fmtRelative(p.lastMtime)}</div>
          ${detailFor(p)}
        </div>`;
    }).join('');

  for (const row of container.querySelectorAll('.tok-row')) {
    row.querySelector('.tok-row-top').addEventListener('click', () => {
      const d = row.querySelector('.tok-detail');
      if (d) d.hidden = !d.hidden;
    });
  }
}

export default {
  name: 'usage',

  mount(el, ctx) {
    const { dialog } = ctx;
    el.innerHTML = '<button class="btn-ghost btn--sm usage-btn" title="Uso y costo de tokens">hoy —</button>';
    const btn = el.querySelector('.usage-btn');

    async function tick() {
      if (document.hidden) return;
      try {
        const sum = await fetchSummary();
        btn.textContent = `hoy ${fmtCost(sum.today.cost)}`;
      } catch { /* reintenta */ }
    }
    tick();
    setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

    btn.addEventListener('click', async () => {
      const m = dialog.openModal({ title: 'Uso de tokens', width: 520 });
      m.body.innerHTML = '<div class="cwc-loading"><span class="cwc-spinner"></span>calculando…</div>';
      try {
        const sum = await fetchSummary();
        renderProjects(m.body, sum);
      } catch {
        m.body.innerHTML = '<div class="tok-empty">No se pudo calcular el uso.</div>';
      }
    });
  },
};
