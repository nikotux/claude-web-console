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

// Reset de estadísticas: toma una foto del consumo actual como línea de base
// (el costo "vuelve a cero" y cuenta desde ahí). clear=true deshace el reset.
async function postReset(clear = false) {
  const res = await fetch('/api/tokens/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(clear ? { clear: true } : {}),
  });
  if (!res.ok) throw new Error();
  return res.json();
}

// ISO → "7 jul, 17:14" (fecha corta local para el aviso "desde el reset").
function fmtResetDate(iso) {
  try {
    return new Date(iso).toLocaleString('es-AR',
      { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// ===== Límites del PLAN (ventanas de claude.ai) =====
// Exportadas: el bloque del pie (modules/stats/plan-limits.js) las reusa para
// pintar las MISMAS barras de límite con idéntico criterio de color/formato
// (fuente única — no duplicar). NO consumen tokens: solo consultan el medidor
// OAuth de uso (GET /api/tokens/limits, con caché de 60 s en el server).
export async function fetchLimits(fresh = false) {
  const res = await fetch(`/api/tokens/limits${fresh ? '?fresh=1' : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudieron leer los límites.');
  return data;
}

// "resetea en 1 h 40 min (10:00)" — relativo + hora local absoluta (con día
// si no es hoy, p.ej. las ventanas semanales).
export function fmtReset(iso) {
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

// "hace 3 min" a partir del updatedAt del snapshot (para el aviso de dato viejo).
function fmtAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!(s >= 0)) return '';
  if (s < 60) return 'hace instantes';
  const min = Math.floor(s / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

// Formatea una cantidad de crédito ya en dólares (el backend divide por
// 10^decimal_places): $X.XX / $X.Xk. `cur` es la moneda que reporta Claude.
function fmtCred(n, cur = 'USD') {
  if (n == null) return '—';
  const sym = cur === 'USD' ? '$' : `${cur} `;
  if (n >= 1000) return `${sym}${(n / 1000).toFixed(1)}k`;
  return `${sym}${Number(n).toFixed(2)}`;
}

export function renderLimits(el, data) {
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

  // Créditos de uso EXTRA (extra_usage, dato que reporta Claude). Se muestra
  // SIEMPRE (pedido del usuario 2026-07-07: dejarlo fijo para seguimiento —
  // sus créditos se activan más tarde y la fila cambia sola a barra/contador
  // cuando enabled pase a true). Tres estados:
  //   • habilitado + límite mensual → barra % + "usó $X de $Y"
  //   • habilitado sin límite (pago por uso) → contador "$X consumidos"
  //   • deshabilitado → fila tenue "sin créditos activos" (sin barra)
  // Default a un bloque deshabilitado si el payload no trae `credits` (snapshot
  // viejo / respuesta parcial): la fila queda SIEMPRE presente para seguimiento.
  const c = data.credits || { enabled: false, usedCredits: null, monthlyLimit: null, percent: null };
  let creditsHtml = '';
  if (c) {
    if (!c.enabled) {
      creditsHtml = `
        <div class="lim-row lim-credits lim-credits--off">
          <div class="lim-top">
            <span class="lim-label">💳 Créditos de uso</span>
            <span class="lim-pct">—</span>
          </div>
          <div class="lim-sub">sin créditos activos</div>
        </div>`;
    } else {
      const hasLimit = c.monthlyLimit != null;
      const pct = c.percent != null
        ? Math.max(0, Math.min(100, Math.round(c.percent)))
        : (hasLimit && c.monthlyLimit > 0 && c.usedCredits != null
          ? Math.max(0, Math.min(100, Math.round((c.usedCredits / c.monthlyLimit) * 100)))
          : null);
      const color = pct == null ? 'var(--cwc-ok)'
        : pct >= 90 ? 'var(--cwc-danger)' : pct >= 70 ? 'var(--cwc-warn)' : 'var(--cwc-ok)';
      const cur = c.currency || 'USD';
      const sub = hasLimit
        ? `usó ${fmtCred(c.usedCredits, cur)} de ${fmtCred(c.monthlyLimit, cur)}${pct != null ? ` · queda ${100 - pct}%` : ''}`
        : `${fmtCred(c.usedCredits, cur)} consumidos · pago por uso`;
      creditsHtml = `
        <div class="lim-row lim-credits">
          <div class="lim-top">
            <span class="lim-label">💳 Créditos de uso</span>
            <span class="lim-pct" style="color:${color}">${pct != null ? `${pct}%` : fmtCred(c.usedCredits, cur)}</span>
          </div>
          ${pct != null ? `<span class="lim-bar"><span class="lim-fill" style="width:${pct}%;background:${color}"></span></span>` : ''}
          <div class="lim-sub">${sub}</div>
        </div>`;
    }
  }

  // Aviso de dato viejo: el server devolvió el último snapshot bueno porque la
  // consulta a Anthropic falló (429 / sin red / recién reiniciado).
  const staleHtml = data.stale
    ? `<div class="lim-stale">⚠ datos guardados${data.updatedAt ? ` · ${fmtAgo(data.updatedAt)}` : ''}</div>`
    : '';

  el.innerHTML = `
    <div class="lim-head">Límites del plan${data.subscription ? ` · ${data.subscription}` : ''}</div>
    ${staleHtml}
    ${rows || '<div class="lim-err">Anthropic no reportó ventanas de límite.</div>'}
    ${creditsHtml}`;
  // Etiquetas de las ventanas con textContent (traen nombres de modelo del server).
  const labels = el.querySelectorAll('.lim-row:not(.lim-credits) .lim-label');
  (data.limits || []).forEach((l, i) => { if (labels[i]) labels[i].textContent = l.label; });
}

// Un modelo se considera "consumiendo AHORA" si su transcript se tocó hace
// menos de 2 min (mientras Claude trabaja, el jsonl se escribe seguido).
const ACTIVE_MS = 120000;
const isLive = (lastMtime) => !!lastMtime && Date.now() - lastMtime < ACTIVE_MS;

// Emoji por motor (ancla visual del detalle). El label lo manda el server;
// acá solo le anteponemos el ícono según la key semántica.
const ENGINE_ICON = {
  chat: '💬',
  healthfix: '🔧',
  tolkien: '🌳',
  cli: '⌨️',
  headless: '⚙️',
};

// Pivot motores→modelos: la lista principal son los MODELOS (acotada). El
// detalle de cada modelo son los MOTORES que lo usaron (chat, auto-fix de
// salud, tolkien, cli, headless), de mayor a menor uso de ESE modelo — ya no
// carpetas/proyectos crudos.
function buildModelView(sum) {
  const byModel = new Map();
  for (const src of (sum.engines || [])) {
    for (const m of (src.models || [])) {
      const e = byModel.get(m.key) || { key: m.key, model: m.model, tokens: 0, cost: 0, lastMtime: 0, engines: [] };
      e.tokens += m.tokens;
      e.cost += m.cost;
      const last = m.lastMtime || src.lastMtime || 0;
      e.lastMtime = Math.max(e.lastMtime, last);
      e.engines.push({ key: src.key, label: src.label, tokens: m.tokens, cost: m.cost, lastMtime: last });
      byModel.set(m.key, e);
    }
  }
  const models = [...byModel.values()].sort((a, b) => b.cost - a.cost);
  for (const e of models) {
    e.engines = e.engines.sort((a, b) => b.cost - a.cost); // mayor a menor uso
  }
  return models;
}

function detailFor(m) {
  const rows = m.engines.map((eng) => `
    <div class="tok-detail-row" title="${eng.label}">
      <span class="tok-eng-ico">${ENGINE_ICON[eng.key] || '⚙️'}</span>
      <span class="tok-detail-name"></span>
      <span class="tok-detail-tok">${fmtTokens(eng.tokens)}</span>
      <span class="tok-detail-cost">${fmtCost(eng.cost)}</span>
    </div>`).join('');
  return `
    <div class="tok-detail" hidden>
      ${rows}
      <div class="tok-detail-foot">${m.engines.length} motor(es) que usaron este modelo · mayor a menor uso</div>
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
      <div class="usage-total-row"><span>Total${sum.resetAt ? ' · desde reset' : ''}</span><span class="tok-big">${fmtTokens(sum.totals.tokens)}</span><span class="tok-cost">${fmtCost(sum.totals.cost)}</span></div>
      <div class="usage-total-row"><span>Hoy</span><span>${fmtTokens(sum.today.tokens)}</span><span class="tok-cost">${fmtCost(sum.today.cost)}</span></div>
      ${sum.resetAt ? `<div class="usage-reset-note">contando desde ${fmtResetDate(sum.resetAt)} · <button class="usage-reset-undo" type="button">ver total histórico</button></div>` : ''}
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
            ${live ? pacman({ state: 'working', size: 'sm', cls: 'tok-live', title: 'consumiendo tokens ahora' }) : ''}
            <span class="tok-row-cost">${fmtCost(m.cost)}</span>
          </div>
          <span class="tok-bar"><span class="tok-fill" style="width:${w}%;background:${modelColor(m.key)}"></span></span>
          <div class="tok-row-sub">${fmtTokens(m.tokens)} tok · ${live ? 'consumiendo ahora' : fmtRelative(m.lastMtime)}</div>
          ${detailFor(m)}
        </div>`;
    }).join('');

  // Nombres de motor con textContent (nunca HTML — vienen del server).
  const detailNames = container.querySelectorAll('.tok-detail-name');
  let i = 0;
  for (const m of models) for (const eng of m.engines) detailNames[i++].textContent = eng.label;

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

      // Botón Reset: pone el costo/tokens en cero desde ahora (guarda una foto
      // como línea de base; el histórico no se borra, se puede volver con "ver
      // total histórico"). Texto explícito (no hay ícono de "reset").
      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn-ghost btn--sm usage-reset-btn';
      resetBtn.textContent = '↺ Reset';
      resetBtn.title = 'Poner el costo en cero desde ahora (el histórico no se borra)';
      m.card.querySelector('.dlg-head').insertBefore(resetBtn, reload);

      // Dos secciones estables: límites del PLAN arriba (claude.ai) y el uso
      // local abajo. Cada una carga/falla por su lado.
      m.body.innerHTML = `
        <div class="usage-lims"><div class="cwc-loading">${pacman()}límites del plan…</div></div>
        <div class="usage-sum"><div class="cwc-loading">${pacman()}calculando…</div></div>`;
      const limsEl = m.body.querySelector('.usage-lims');
      const sumEl = m.body.querySelector('.usage-sum');

      let limsOk = false;
      async function loadLimits(fresh) {
        try {
          renderLimits(limsEl, await fetchLimits(fresh));
          limsOk = true;
        } catch (e) {
          // Con la persistencia del server esto casi no pasa (devuelve el
          // último snapshot marcado `stale`). Si igual falla y ya había un
          // render bueno, lo DEJAMOS (no borramos el dato); solo pintamos el
          // error cuando nunca hubo nada que mostrar.
          if (!limsOk) {
            limsEl.innerHTML = '<div class="lim-head">Límites del plan</div><div class="lim-err"></div>';
            limsEl.querySelector('.lim-err').textContent = e.message;
          }
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
          // "ver total histórico" = deshacer el reset (borra la línea de base).
          sumEl.querySelector('.usage-reset-undo')?.addEventListener('click', async () => {
            try { await postReset(true); await load(true); } catch { /* noop */ }
          });
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
      resetBtn.addEventListener('click', async () => {
        const ok = await dialog.confirmDialog({
          title: '↺ Reset de estadísticas',
          message: 'Pone el costo en dólares y los tokens en CERO desde ahora. '
            + 'El histórico real no se borra: podés volver a verlo con "ver total histórico". '
            + '¿Resetear ahora?',
          confirmLabel: 'Resetear',
          cancelLabel: 'Cancelar',
        });
        if (!ok) return;
        resetBtn.disabled = true;
        try { await postReset(false); await load(true); } catch { /* noop */ }
        resetBtn.disabled = false;
      });
      load(false);
      // Refresco en vivo mientras el modal esté abierto: mantiene al día el
      // Pac-Man "consumiendo ahora" y la cuenta regresiva de los resets.
      timer = setInterval(() => { if (!document.hidden) load(false); }, 10000);
    });
  },
};
