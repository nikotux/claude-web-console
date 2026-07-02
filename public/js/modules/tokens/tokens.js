// modules/tokens/tokens.js — uso/costo de tokens.
//   - Pie fijo (#tokens-mini): total global de tokens y costo + costo de hoy.
//   - Sección acordeón (#tokens-list): desglose por proyecto.
// Un único fetch a /api/tokens/summary alimenta ambos; poll cada 15s.
import { modelColor, modelName } from '../../ui/models.js';

const POLL_MS = 15000;

let footerEl = null;
let listEl = null;

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

// Identidad de modelo compartida (colores en tokens.css, key del backend).

function renderFooter(sum) {
  if (!footerEl) return;
  footerEl.innerHTML = `
    <div class="tok-total">
      <span class="tok-big">${fmtTokens(sum.totals.tokens)}</span>
      <span class="tok-cost">${fmtCost(sum.totals.cost)}</span>
    </div>
    <div class="tok-today">hoy: ${fmtTokens(sum.today.tokens)} · ${fmtCost(sum.today.cost)}</div>`;
}

// Barra apilada: un segmento de color por modelo (proporcional a su costo
// dentro del proyecto), así se ve el consumo de CADA modelo de un vistazo.
function segsFor(p) {
  const models = p.models || [];
  if (!models.length) return '';
  return models
    .map((m) => {
      const share = p.cost ? (m.cost / p.cost) * 100 : 100 / models.length;
      const name = modelName(m.key, m.model);
      return `<span class="tok-seg" style="width:${share}%;background:${modelColor(m.key)}" title="${name}: ${fmtTokens(m.tokens)} tok · ${fmtCost(m.cost)}"></span>`;
    })
    .join('');
}

function detailFor(p) {
  const rows = (p.models || [])
    .map((m) => `
      <div class="tok-detail-row">
        <span class="tok-dot" style="background:${modelColor(m.key)}"></span>
        <span class="tok-detail-name">${modelName(m.key, m.model)}</span>
        <span class="tok-detail-tok">${fmtTokens(m.tokens)}</span>
        <span class="tok-detail-cost">${fmtCost(m.cost)}</span>
      </div>`)
    .join('');
  const cache = (p.cacheWrite || 0) + (p.cacheRead || 0);
  return `
    <div class="tok-detail" hidden>
      ${rows}
      <div class="tok-detail-foot">
        entrada ${fmtTokens(p.input || 0)} · salida ${fmtTokens(p.output || 0)} · caché ${fmtTokens(cache)}
      </div>
      <div class="tok-detail-foot">${fmtRelative(p.lastMtime)}</div>
    </div>`;
}

function renderList(sum) {
  if (!listEl) return;
  if (!sum.projects.length) {
    listEl.innerHTML = '<div class="tok-empty">sin datos</div>';
    return;
  }
  const max = sum.projects[0].cost || 1;
  listEl.innerHTML = sum.projects
    .map((p) => {
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
    })
    .join('');

  for (const row of listEl.querySelectorAll('.tok-row')) {
    row.querySelector('.tok-row-top').addEventListener('click', () => {
      const d = row.querySelector('.tok-detail');
      if (d) d.hidden = !d.hidden;
    });
  }
}

async function refresh() {
  if (document.hidden) return; // sin polling con la pestaña en segundo plano
  try {
    const res = await fetch('/api/tokens/summary');
    if (!res.ok) return;
    const sum = await res.json();
    renderFooter(sum);
    renderList(sum);
  } catch { /* reintenta */ }
}

export function initTokens({ footer, list, refreshBtn }) {
  footerEl = footer;
  listEl = list;
  if (refreshBtn) refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
  refresh();
  return setInterval(refresh, POLL_MS);
}

export { refresh as refreshTokens };
