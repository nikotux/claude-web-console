// modules/usage/usage.js — Uso de tokens.
//
// En el pie: SOLO el costo de HOY (botón). Todo el detalle vive en el modal
// "Uso" que abre ese botón: arriba los LÍMITES DEL PLAN (las ventanas de
// claude.ai — /api/tokens/limits: % usado, % restante y reset), abajo el uso
// local por modelo (/api/tokens/summary) con Pac-Man masticando en los
// modelos que están consumiendo tokens AHORA (transcript tocado < 2 min).
// El modal se auto-refresca cada 10 s mientras está abierto.
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

// ===== Límites del PLAN (ventanas de claude.ai) =====
async function fetchLimits(fresh = false) {
  const res = await fetch(`/api/tokens/limits${fresh ? '?fresh=1' : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudieron leer los límites.');
  return data;
}

// "resetea en 1 h 40 min (10:00)" — relativo + hora local absoluta (con día
// si no es hoy, p.ej. las ventanas semanales).
function fmtReset(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = d - Date.now();
  if (diff <= 0) return 'reseteando…';
  const min = Math.ceil(diff / 60000);
  const rel = min < 60 ? `${min} min`
    : min < 48 * 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
    : `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
  const hhmm = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const abs = d.toDateString() === new Date().toDateString()
    ? hhmm : `${d.toLocaleDateString('es', { weekday: 'short' })} ${hhmm}`;
  return `resetea en ${rel} (${abs})`;
}

function renderLimits(el, data) {
  const rows = (data.limits || []).map((l) => {
    const pct = Math.max(0, Math.min(100, Math.round(l.percent)));
    const color = pct >= 90 ? 'var(--cwc-danger)' : pct >= 70 ? 'var(--cwc-warn)' : 'var(--cwc-ok)';
    return `
      <div class="lim-row">
        <div class="lim-top"><span class="lim-label"></span><span class="lim-pct" style="color:${color}">${pct}%</span></div>
        <span class="lim-bar"><span class="lim-fill" style="width:${pct}%;background:${color}"></span></span>
        <div class="lim-sub">queda ${100 - pct}% · ${fmtReset(l.resetsAt)}</div>
      </div>`;
  }).join('');
  el.innerHTML = `
    <div class="lim-head">Límites del plan${data.subscription ? ` · ${data.subscription}` : ''}</div>
    ${rows || '<div class="lim-err">Anthropic no reportó ventanas de límite.</div>'}`;
  // Etiquetas con textContent (traen nombres de modelo que vienen del server).
  const labels = el.querySelectorAll('.lim-label');
  (data.limits || []).forEach((l, i) => { labels[i].textContent = l.label; });
}

// Un modelo se considera "consumiendo AHORA" si su transcript se tocó hace
// menos de 2 min (mientras Claude trabaja, el jsonl se escribe seguido).
const ACTIVE_MS = 120000;
const isLive = (lastMtime) => !!lastMtime && Date.now() - lastMtime < ACTIVE_MS;

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
      // Pac-Man masticando = este modelo está consumiendo tokens AHORA
      // (mismo lenguaje que las tarjetas de Sesiones); ausente = quieto.
      const live = isLive(m.lastMtime);
      return `
        <div class="tok-row" data-key="${m.key}">
          <div class="tok-row-top">
            <span class="tok-dot" style="background:${modelColor(m.key)}"></span>
            <span class="tok-name">${modelName(m.key, m.model)}</span>
            ${live ? pacman({ cls: 'pac-sm tok-live', title: 'consumiendo tokens ahora' }) : ''}
            <span class="tok-row-cost">${fmtCost(m.cost)}</span>
          </div>
          <span class="tok-bar"><span class="tok-fill" style="width:${w}%;background:${modelColor(m.key)}"></span></span>
          <div class="tok-row-sub">${fmtTokens(m.tokens)} tok · ${live ? 'consumiendo ahora' : fmtRelative(m.lastMtime)}</div>
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
      let timer = null;
      const m = dialog.openModal({
        title: 'Uso de tokens',
        width: 520,
        onClose: () => clearInterval(timer),
      });

      // Botón Actualizar en el header del modal (junto a la ×): fuerza una
      // re-lectura fresca en el backend (?fresh=1 saltea el TTL del summary
      // local Y el de los límites remotos).
      const reload = document.createElement('button');
      reload.className = 'btn-ghost btn--sm btn--icon usage-reload';
      reload.title = 'Actualizar (re-lee transcripts y límites ahora)';
      reload.innerHTML = icon('refresh', { size: 15 });
      m.card.querySelector('.dlg-head').insertBefore(reload, m.card.querySelector('.dlg-x'));

      // Dos secciones estables: límites del PLAN arriba (claude.ai) y el uso
      // local abajo. Cada una carga/falla por su lado.
      m.body.innerHTML = `
        <div class="usage-lims"><div class="cwc-loading">${pacman()}límites del plan…</div></div>
        <div class="usage-sum"><div class="cwc-loading">${pacman()}calculando…</div></div>`;
      const limsEl = m.body.querySelector('.usage-lims');
      const sumEl = m.body.querySelector('.usage-sum');

      async function loadLimits(fresh) {
        try {
          renderLimits(limsEl, await fetchLimits(fresh));
        } catch (e) {
          limsEl.innerHTML = '<div class="lim-head">Límites del plan</div><div class="lim-err"></div>';
          limsEl.querySelector('.lim-err').textContent = e.message;
        }
      }
      async function loadSum(fresh) {
        // Preserva los detalles expandidos a través del auto-refresh.
        const open = new Set([...sumEl.querySelectorAll('.tok-row')]
          .filter((r) => r.querySelector('.tok-detail:not([hidden])'))
          .map((r) => r.dataset.key));
        try {
          renderUsage(sumEl, await fetchSummary(fresh));
          for (const key of open) {
            sumEl.querySelector(`.tok-row[data-key="${key}"] .tok-detail`)?.removeAttribute('hidden');
          }
        } catch {
          sumEl.innerHTML = '<div class="tok-empty">No se pudo calcular el uso.</div>';
        }
      }
      async function load(fresh) {
        reload.disabled = true;
        await Promise.all([loadSum(fresh), loadLimits(fresh)]);
        reload.disabled = false;
      }
      reload.addEventListener('click', () => load(true));
      load(false);
      // Refresco en vivo mientras el modal esté abierto: mantiene al día el
      // Pac-Man "consumiendo ahora" y la cuenta regresiva de los resets.
      timer = setInterval(() => { if (!document.hidden) load(false); }, 10000);
    });
  },
};
