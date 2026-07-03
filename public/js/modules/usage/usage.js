// modules/usage/usage.js — Uso de tokens.
//
// En el pie: SOLO el costo de HOY (botón). Todo el detalle (total global,
// proyectos con barra apilada por modelo, desglose exacto) vive en el modal
// "Uso" que abre ese botón. Mismos datos y endpoint de siempre
// (/api/tokens/summary); nueva presentación.
import { modelColor, modelName } from '../../ui/models.js';
import { pacman } from '../../ui/pacman.js';

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

async function fetchSummary(fresh = false) {
  const res = await fetch(`/api/tokens/summary${fresh ? '?fresh=1' : ''}`);
  if (!res.ok) throw new Error();
  return res.json();
}

// Pivot proyectos→modelos: la lista principal son los MODELOS (acotada, no
// crece con los proyectos). El detalle de cada modelo son los 3 proyectos que
// lo usaron más recientemente, mostrados de mayor a menor uso de ESE modelo.
function buildModelView(sum) {
  const byModel = new Map();
  for (const p of sum.projects) {
    for (const m of (p.models || [])) {
      const e = byModel.get(m.key) || { key: m.key, model: m.model, tokens: 0, cost: 0, lastMtime: 0, projects: [] };
      e.tokens += m.tokens;
      e.cost += m.cost;
      const last = m.lastMtime || p.lastMtime || 0;
      e.lastMtime = Math.max(e.lastMtime, last);
      e.projects.push({ label: p.label, name: p.name, tokens: m.tokens, cost: m.cost, lastMtime: last });
      byModel.set(m.key, e);
    }
  }
  const models = [...byModel.values()].sort((a, b) => b.cost - a.cost);
  for (const e of models) {
    e.projects = e.projects
      .sort((a, b) => b.lastMtime - a.lastMtime) // los 3 que lo usaron ÚLTIMO…
      .slice(0, 3)
      .sort((a, b) => b.cost - a.cost);          // …de mayor a menor uso
  }
  return models;
}

function detailFor(m) {
  const rows = m.projects.map((p) => `
    <div class="tok-detail-row" title="${p.name}">
      <span class="tok-dot" style="background:${modelColor(m.key)}"></span>
      <span class="tok-detail-name"></span>
      <span class="tok-detail-tok">${fmtTokens(p.tokens)}</span>
      <span class="tok-detail-cost">${fmtCost(p.cost)}</span>
    </div>`).join('');
  return `
    <div class="tok-detail" hidden>
      ${rows}
      <div class="tok-detail-foot">últimos ${m.projects.length} proyecto(s) que usaron este modelo · mayor a menor uso</div>
    </div>`;
}

function renderUsage(container, sum) {
  const models = buildModelView(sum);
  if (!models.length) {
    container.innerHTML = '<div class="tok-empty">sin datos</div>';
    return;
  }
  const max = models[0].cost || 1;
  container.innerHTML = `
    <div class="usage-totals">
      <div class="usage-total-row"><span>Total</span><span class="tok-big">${fmtTokens(sum.totals.tokens)}</span><span class="tok-cost">${fmtCost(sum.totals.cost)}</span></div>
      <div class="usage-total-row"><span>Hoy</span><span>${fmtTokens(sum.today.tokens)}</span><span class="tok-cost">${fmtCost(sum.today.cost)}</span></div>
    </div>
    <div class="tok-note">Tokens exactos (reportados por Anthropic en cada respuesta). El costo es el <b>equivalente a precios de API</b>: la suscripción de Claude no factura por token, así que no existe un gasto real en dólares consultable.</div>` +
    models.map((m) => {
      const w = Math.max(4, Math.round((m.cost / max) * 100));
      return `
        <div class="tok-row">
          <div class="tok-row-top">
            <span class="tok-dot" style="background:${modelColor(m.key)}"></span>
            <span class="tok-name">${modelName(m.key, m.model)}</span>
            <span class="tok-row-cost">${fmtCost(m.cost)}</span>
          </div>
          <span class="tok-bar"><span class="tok-fill" style="width:${w}%;background:${modelColor(m.key)}"></span></span>
          <div class="tok-row-sub">${fmtTokens(m.tokens)} tok · ${fmtRelative(m.lastMtime)}</div>
          ${detailFor(m)}
        </div>`;
    }).join('');

  // Nombres de proyecto con textContent (nunca HTML).
  const detailNames = container.querySelectorAll('.tok-detail-name');
  let i = 0;
  for (const m of models) for (const p of m.projects) detailNames[i++].textContent = p.label;

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
    const { dialog, icon } = ctx;
    // El botón muestra los TOKENS de hoy (el costo va al tooltip y al modal).
    el.innerHTML = `
      <button class="btn-ghost btn--sm usage-btn" title="Uso de tokens (hoy)">
        <span class="usage-lbl">hoy</span><span class="usage-val">—</span>
      </button>`;
    const btn = el.querySelector('.usage-btn');
    const valEl = el.querySelector('.usage-val');
    let lastTokens = null;

    async function tick() {
      if (document.hidden) return;
      try {
        const sum = await fetchSummary();
        const t = sum.today.tokens || 0;
        valEl.textContent = fmtTokens(t);
        btn.title = `Hoy: ${fmtTokens(t)} tokens · ${fmtCost(sum.today.cost)} equiv. API`;
        // Animación cuando el contador SUBE (tokens consumiéndose ahora).
        if (lastTokens != null && t > lastTokens) {
          valEl.classList.remove('tick');
          void valEl.offsetWidth; // reinicia la animación CSS
          valEl.classList.add('tick');
        }
        lastTokens = t;
      } catch { /* reintenta */ }
    }
    tick();
    setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

    btn.addEventListener('click', async () => {
      const m = dialog.openModal({ title: 'Uso de tokens', width: 520 });

      // Botón Actualizar en el header del modal (junto a la ×): fuerza una
      // re-lectura fresca en el backend (?fresh=1 saltea el TTL del summary).
      const reload = document.createElement('button');
      reload.className = 'btn-ghost btn--sm btn--icon usage-reload';
      reload.title = 'Actualizar (re-lee los transcripts ahora)';
      reload.innerHTML = icon('refresh', { size: 15 });
      m.card.querySelector('.dlg-head').insertBefore(reload, m.card.querySelector('.dlg-x'));

      async function load(fresh) {
        reload.disabled = true;
        m.body.innerHTML = `<div class="cwc-loading">${pacman()}calculando…</div>`;
        try {
          const sum = await fetchSummary(fresh);
          renderUsage(m.body, sum);
        } catch {
          m.body.innerHTML = '<div class="tok-empty">No se pudo calcular el uso.</div>';
        }
        reload.disabled = false;
      }
      reload.addEventListener('click', () => load(true));
      load(false);
    });
  },
};
