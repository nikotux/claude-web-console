// modules/usage/usage.js — Uso de tokens.
//
// En el pie: SOLO el costo de HOY (botón). Todo el detalle vive en el modal
// "Uso" que abre ese botón:
//   • Arriba: LÍMITES DEL PLAN (ventanas de claude.ai — /api/tokens/limits: %
//     usado, % restante, reset y el token-count nuestro de esa ventana) +
//     créditos de uso extra (fila COLAPSABLE).
//   • Abajo: UNA barra de controles (Día·Semana·Mes + $·tok) que maneja las DOS
//     columnas — izquierda "General" (total del período seleccionado, por modelo)
//     y derecha "Tendencia" (gráfica de barras apiladas por modelo):
//       Día   → hoy por HORA · Semana → últimos 7 días · Mes → últimos 30 días.
// Fechas/horas en hora LOCAL de Medellín (America/Bogota, ver backend time.js).
// El histórico (semana/mes) es PERSISTENTE (/api/tokens/history) y sobrevive a la
// poda de transcripts del CLI. El modal se auto-refresca cada 10 s.
import { modelColor, modelName } from '../../ui/models.js';
import { pacman } from '../../ui/pacman.js';
import { flowBarHtml, ensureFlowDirector } from '../../ui/token-flow.js';
import { readCache, writeCache } from '../../ui/cache-store.js';
import { t } from '../../ui/i18n.js';

const POLL_MS = 15000;
const AUTO_MS = 15000; // auto-refresh del modal (silencioso)

// Caché EN MEMORIA del último dato bueno. El parseo de transcripts tarda ~2 s:
// sin esto, cada apertura del modal mostraba spinner. Con la caché el modal ABRE
// INSTANTÁNEO con lo último conocido y refresca en segundo plano. La alimentan el
// poll del pie (tick) y el propio modal; `series` cachea la serie por rango.
const cache = { summary: null, limits: null, series: {} };

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n || 0));
}
const fmtCost = (c) => `$${(c || 0).toFixed(2)}`;
// Formatea un valor según la métrica activa ('cost' | 'tokens').
const fmtMetric = (v, metric) => (metric === 'cost' ? fmtCost(v) : `${fmtTokens(v)} tok`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function fmtRelative(ms) {
  if (!ms) return t('usage.rel.none', 'sin actividad');
  const diffS = Math.floor((Date.now() - ms) / 1000);
  if (diffS < 60) return t('usage.rel.moments', 'hace instantes');
  const min = Math.floor(diffS / 60);
  if (min < 60) return t('usage.rel.min', 'hace {n} min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('usage.rel.hours', 'hace {n} h', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('usage.rel.days', 'hace {n} d', { n: d });
  return new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' });
}

async function fetchSummary(fresh = false) {
  const res = await fetch(`/api/tokens/summary${fresh ? '?fresh=1' : ''}`);
  if (!res.ok) throw new Error();
  return res.json();
}

// Serie de tiempo por modelo (day|week|month × proyecto) para las gráficas.
async function fetchHistory(range, project = 'all') {
  const res = await fetch(`/api/tokens/history?range=${encodeURIComponent(range)}&project=${encodeURIComponent(project)}`);
  if (!res.ok) throw new Error();
  return res.json();
}

// Precio de INPUT por millón de tokens (equivalente a API — coincide con pin()
// del backend). Ordena por economía e identifica el modelo más barato/caro:
// haiku $1 < sonnet $3 < opus $5 < fable $10. Se muestra como badge "$X/M".
const PRICE_INPUT = { haiku: 1, sonnet: 3, opus: 5, fable: 10 };
const priceRank = (k) => PRICE_INPUT[k] ?? 0; // mayor = más costoso

// ===== Límites del PLAN (ventanas de claude.ai) =====
// Exportadas: el bloque del pie (modules/stats/plan-limits.js) las reusa para
// pintar las MISMAS barras con idéntico criterio de color/formato (fuente única).
export async function fetchLimits(fresh = false) {
  const res = await fetch(`/api/tokens/limits${fresh ? '?fresh=1' : ''}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('usage.limits.readError', 'No se pudieron leer los límites.'));
  return data;
}

// "resetea en 1 h 40 min (10:00)" — relativo + hora local absoluta.
export function fmtReset(iso, compact = false) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = d - Date.now();
  if (diff <= 0) return t('usage.reset.resetting', 'reseteando…');
  const min = Math.ceil(diff / 60000);
  const rel = min < 60 ? `${min} min`
    : min < 48 * 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
    : `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
  if (compact) return t('usage.reset.compact', 'resetea {rel}', { rel: rel.replace(/ (min|h|d)\b/g, '$1') });
  const hhmm = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const abs = d.toDateString() === new Date().toDateString()
    ? hhmm : `${d.toLocaleDateString('es', { weekday: 'short' })} ${hhmm}`;
  return t('usage.reset.full', 'resetea en {rel} ({abs})', { rel, abs });
}

// "hace 3 min" a partir del updatedAt del snapshot (para el aviso de dato viejo).
function fmtAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!(s >= 0)) return '';
  if (s < 60) return t('usage.rel.moments', 'hace instantes');
  const min = Math.floor(s / 60);
  if (min < 60) return t('usage.rel.min', 'hace {n} min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('usage.rel.hours', 'hace {n} h', { n: h });
  return t('usage.rel.days', 'hace {n} d', { n: Math.floor(h / 24) });
}

// Formatea crédito ya en dólares. `cur` = moneda que reporta Claude.
function fmtCred(n, cur = 'USD') {
  if (n == null) return '—';
  const sym = cur === 'USD' ? '$' : `${cur} `;
  if (n >= 1000) return `${sym}${(n / 1000).toFixed(1)}k`;
  return `${sym}${Number(n).toFixed(2)}`;
}

// Token-count NUESTRO de la ventana de un límite (Anthropic no lo expone: se
// calcula de los transcripts). session→últimas 5 h · weekly_all→7 días ·
// weekly_scoped→ese modelo en 7 días. Devuelve null si no hay dato.
function windowTokFor(l, windows) {
  if (!windows) return null;
  if (l.kind === 'session') return windows.h5 ?? null;
  if (l.kind === 'weekly_all') return windows.d7 ?? null;
  if (l.kind === 'weekly_scoped' && l.modelKey) return windows.d7ByKey?.[l.modelKey]?.tokens ?? 0;
  return null;
}

// ===== Punto de referencia de la ventana "Sesión (5h)" (2026-07-19) =====
// Anthropic solo reporta el % crudo de la ventana — sin decir en qué punto del
// tiempo estás ni si eso es mucho o poco PARA VOS. Estas dos piezas cierran ese
// hueco, ambas SOLO para `kind==='session'` (alcance acordado con Niko: Semana y
// Codex quedan afuera por ahora):
//   (a) marca de RITMO ESPERADO — tick en la barra: "acá deberías estar si
//       gastaras parejo hasta el reset". Matemática pura (resetsAt + duración
//       fija de 5h), cero fetch nuevo.
//   (b) ALERTA de agotamiento — si tu ritmo ACTUAL (no el promedio) proyecta
//       que llegás a 100% antes del reset. Misma matemática pura.
// La comparación contra tu HISTORIAL (windows.h5Baseline, del backend) se arma
// aparte en paceRatioText() más abajo.
const SESSION_WINDOW_MS = 5 * 3600000;
const PACE_MIN_ELAPSED_MS = 5 * 60000; // <5 min transcurridos: ruido, no proyectar

function paceInfo(l) {
  if (l.kind !== 'session' || !l.resetsAt || l.isActive === false) return null;
  const resetMs = new Date(l.resetsAt).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const now = Date.now();
  const remainingMs = Math.max(0, resetMs - now);
  const elapsedMs = Math.min(SESSION_WINDOW_MS, Math.max(0, SESSION_WINDOW_MS - remainingMs));
  const expectedPct = Math.max(0, Math.min(100, (elapsedMs / SESSION_WINDOW_MS) * 100));
  let etaExhaustMs = null;
  if (elapsedMs >= PACE_MIN_ELAPSED_MS && l.percent > 0 && remainingMs > 0) {
    const ratePerMs = l.percent / elapsedMs; // %/ms al ritmo ACTUAL
    const msTo100 = (100 - l.percent) / ratePerMs;
    if (msTo100 >= 0 && msTo100 < remainingMs) etaExhaustMs = now + msTo100;
  }
  return { expectedPct, etaExhaustMs };
}

// "1.4×" / "0.7×" tu ritmo habitual, a partir de windows.h5Cost/h5CostBaseline
// (backend, promedio de los últimos días completos escalado a un bloque de 5h).
// En COSTO equivalente, NO tokens crudos: un token de cache read pesa ~10x
// menos que uno nuevo y puede ser el grueso del conteo crudo de una sesión con
// contexto reusado — comparar tokens crudos contra el % real de Anthropic
// exagera el ritmo (verificado 2026-07-19: 95% cache reads con % de cupo bajo).
// null si el backend no mandó baseline todavía (poco historial: <3 días).
function paceRatioText(windows) {
  const h5 = windows?.h5Cost;
  const base = windows?.h5CostBaseline;
  if (h5 == null || base == null || base <= 0) return null;
  const ratio = h5 / base;
  const color = ratio >= 1.6 ? 'var(--cwc-danger)' : ratio >= 1.3 ? 'var(--cwc-warn)' : 'var(--cwc-text-dimmer)';
  return { text: t('usage.pace.ratio', '{ratio}× tu ritmo habitual', { ratio: ratio.toFixed(1) }), color };
}

// Color por UMBRAL de severidad (para el número % en texto = codificación
// SECUNDARIA además del color de la barra: el valor exacto nunca es solo color).
function sevColor(pct) {
  return pct >= 90 ? 'var(--cwc-danger)' : pct >= 70 ? 'var(--cwc-warn)' : 'var(--cwc-ok)';
}

// Fila de límite REDISEÑADA (2026-07-15, pedido de Niko): DOS líneas.
//   L1 = SOLO texto — label (ui) + meta (xs, dim, truncable) + % (mono, grande,
//        coloreado por severidad). Jerarquía por tamaño/familia/color.
//   L2 = la BARRA con GRADIENTE verde→rojo. Técnica "gradiente fijo revelado":
//        el degradé continuo (--cwc-ok→warn→danger) vive en TODO el ancho del
//        track y una máscara tapa de --pct a 100% → la PUNTA del relleno muestra
//        el color de severidad REAL de ese %, no un corte duro por umbral.
// `metaParts` = trozos ya formateados (se juntan con " · ", ignorando vacíos).
// El label se rellena por textContent afuera (trae nombres del server).
// `pace` (opcional, solo la fila "Sesión (5h)"): { expectedPct, etaText, ratioText,
// ratioColor } — agrega el tick de ritmo esperado en la barra + una 3ª línea de
// contexto (alerta de agotamiento y/o comparación contra tu historial). Ver
// paceInfo()/paceRatioText() más arriba.
function limRowHtml(pctRaw, metaParts, pace = null) {
  const pct = Math.max(0, Math.min(100, Math.round(pctRaw)));
  const metaLines = metaParts.filter(Boolean).map((t) => `<span class="lim-meta-l">${t}</span>`).join('');
  const tickHtml = pace && Number.isFinite(pace.expectedPct)
    ? `<span class="lim-bar-pace" style="left:${Math.max(0, Math.min(100, pace.expectedPct))}%" title="${t('usage.pace.tickTitle', 'Ritmo esperado si gastaras parejo hasta el reset')}"></span>`
    : '';
  const paceLineParts = [pace?.etaText, pace?.ratioText].filter(Boolean);
  const paceLineHtml = paceLineParts.length
    ? `<div class="lim-pace-line">${paceLineParts.join(' · ')}</div>` : '';
  return `
    <div class="lim-row">
      <div class="lim-line">
        <span class="lim-label"></span>
        <span class="lim-meta">${metaLines}</span>
        <span class="lim-pct" style="color:${sevColor(pct)}">${pct}%</span>
      </div>
      <span class="lim-bar lim-bar--grad" style="--pct:${pct}%">${tickHtml}<span class="lim-bar-mask"></span></span>
      ${paceLineHtml}
    </div>`;
}

// Créditos de uso EXTRA (extra_usage de Claude) — fila COLAPSABLE (<details>,
// contraída por defecto). Devuelve {html, labelText} para asignar el label por
// textContent afuera.
function claudeCreditsHtml(credits) {
  const c = credits || { enabled: false, usedCredits: null, monthlyLimit: null, percent: null };
  let bodyLine = t('usage.credits.none', 'sin créditos activos');
  let pctText = '—';
  let barHtml = '';
  let color = 'var(--cwc-text-dimmer)';
  if (c.enabled) {
    const hasLimit = c.monthlyLimit != null;
    const pct = c.percent != null
      ? Math.max(0, Math.min(100, Math.round(c.percent)))
      : (hasLimit && c.monthlyLimit > 0 && c.usedCredits != null
        ? Math.max(0, Math.min(100, Math.round((c.usedCredits / c.monthlyLimit) * 100)))
        : null);
    color = pct == null ? 'var(--cwc-ok)' : sevColor(pct);
    const cur = c.currency || 'USD';
    pctText = pct != null ? `${pct}%` : fmtCred(c.usedCredits, cur);
    bodyLine = hasLimit
      ? `${t('usage.credits.usedOf', 'usó {used} de {limit}', { used: fmtCred(c.usedCredits, cur), limit: fmtCred(c.monthlyLimit, cur) })}${pct != null ? ` · ${t('usage.remaining', 'queda {n}%', { n: 100 - pct })}` : ''}`
      : t('usage.credits.payg', '{used} consumidos · pago por uso', { used: fmtCred(c.usedCredits, cur) });
    if (pct != null) barHtml = `<span class="lim-bar lim-bar--grad" style="--pct:${pct}%"><span class="lim-bar-mask"></span></span>`;
  }
  return `
    <details class="lim-credits-det${c.enabled ? '' : ' lim-credits--off'}">
      <summary class="lim-credits-sum">
        <span class="lim-label">${t('usage.credits.label', '💳 Créditos de uso')}</span>
        <span class="lim-pct" style="color:${color}">${pctText}</span>
      </summary>
      <div class="lim-credits-body">
        ${barHtml}
        <div class="lim-sub">${bodyLine}</div>
      </div>
    </details>`;
}

// Bloque de CODEX CLI (OpenAI): sub-cabecera + sus ventanas con las MISMAS
// filas del rediseño. Devuelve '' si no hay dato (best-effort del backend).
function codexBlockHtml(codex, compact = false) {
  if (!codex || !Array.isArray(codex.limits)) return '';
  const staleHtml = codex.stale
    ? `<div class="lim-stale">${t('usage.stale', '⚠ datos guardados')}${codex.updatedAt ? ` · ${fmtAgo(codex.updatedAt)}` : ''}</div>`
    : '';
  const reachedHtml = codex.limitReached
    ? `<div class="lim-stale lim-reached">${t('usage.codex.reached', '⛔ límite alcanzado')}</div>` : '';
  const rows = codex.limits.length
    ? codex.limits.map((l) => {
      const pct = Math.max(0, Math.min(100, Math.round(l.percent)));
      return limRowHtml(l.percent, [t('usage.remaining', 'queda {n}%', { n: 100 - pct }), fmtReset(l.resetsAt, compact)]);
    }).join('')
    : `<div class="lim-err">${t('usage.codex.noWindows', 'OpenAI no reportó ventanas de límite.')}</div>`;
  // Balance de créditos (overage) si el endpoint lo trae y no es cero.
  const bal = codex.credits && codex.credits.balance;
  const credLine = bal != null && bal > 0
    ? `<div class="lim-sub lim-codex-cred">${t('usage.codex.extraCredit', '💳 crédito extra: {amount}', { amount: fmtCred(bal, codex.credits.currency) })}</div>` : '';
  return `
    <div class="lim-codex">
      <div class="lim-head lim-head--codex"><span class="lim-head-t">${t('usage.codex.head', 'Codex')}</span>${flowBarHtml({ engine: 'codex', compact: true, dot: false })}</div>
      ${staleHtml}${reachedHtml}
      ${rows}
      ${credLine}
    </div>`;
}

// renderLimits(el, data, opts): opts.windows = token-counts por ventana (solo el
// modal los pasa; el pie no). Los créditos van SIEMPRE colapsados (<details>).
export function renderLimits(el, data, opts = {}) {
  const windows = opts.windows || null;
  const compact = !!opts.compact;
  // Etiquetas que se rellenan por textContent (traen nombres del server, evita
  // inyección). Se acumulan en ORDEN DE RENDER (Claude primero, luego Codex).
  const labelTexts = [];
  const rows = (data.limits || []).map((l) => {
    const pct = Math.max(0, Math.min(100, Math.round(l.percent)));
    const wt = windowTokFor(l, windows);
    labelTexts.push(l.label);
    // Punto de referencia SOLO en la fila "Sesión (5h)" (alcance acordado): tick
    // de ritmo esperado + alerta de agotamiento (paceInfo) + comparación contra
    // tu historial (paceRatioText, viaja aparte porque no depende de isActive).
    let pace = null;
    if (l.kind === 'session') {
      const info = paceInfo(l);
      const ratio = paceRatioText(windows);
      const etaText = info?.etaExhaustMs != null
        ? `<span style="color:var(--cwc-danger)">${t('usage.pace.eta', '⏳ se agota ~{time}', { time: new Date(info.etaExhaustMs).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) })}</span>`
        : '';
      const ratioText = ratio ? `<span style="color:${ratio.color}">${ratio.text}</span>` : '';
      pace = { expectedPct: info?.expectedPct ?? null, etaText, ratioText };
    }
    return limRowHtml(l.percent, [t('usage.remaining', 'queda {n}%', { n: 100 - pct }), fmtReset(l.resetsAt, compact), wt != null ? t('usage.approxTok', '≈ {tok} tok', { tok: fmtTokens(wt) }) : ''], pace);
  }).join('');

  const creditsHtml = opts.credits === false ? '' : claudeCreditsHtml(data.credits);

  const staleHtml = data.stale
    ? `<div class="lim-stale">${t('usage.stale', '⚠ datos guardados')}${data.updatedAt ? ` · ${fmtAgo(data.updatedAt)}` : ''}</div>`
    : '';

  // Codex: sus labels van DESPUÉS de los de Claude en el DOM.
  const codexHtml = codexBlockHtml(data.codex, compact);
  if (data.codex && Array.isArray(data.codex.limits)) {
    for (const l of data.codex.limits) labelTexts.push(l.label);
  }

  el.innerHTML = `
    <div class="lim-head lim-head--claude"><span class="lim-head-t">${t('usage.claude.head', 'Claude')}</span>${flowBarHtml({ engine: 'claude', compact: true, dot: false })}</div>
    ${staleHtml}
    ${rows || `<div class="lim-err">${t('usage.claude.noWindows', 'Anthropic no reportó ventanas de límite.')}</div>`}
    ${creditsHtml}
    ${codexHtml}`;
  // Etiquetas (Claude + Codex) por textContent, en el mismo orden de render.
  const labels = el.querySelectorAll('.lim-row .lim-label');
  labelTexts.forEach((txt, i) => { if (labels[i]) labels[i].textContent = txt; });
  ensureFlowDirector();
}

// Un modelo se considera "consumiendo AHORA" si su transcript se tocó hace < 2 min.
const ACTIVE_MS = 120000;
const isLive = (lastMtime) => !!lastMtime && Date.now() - lastMtime < ACTIVE_MS;

// Set de claves de modelo que están consumiendo AHORA (para el Pac-Man de la
// columna General). Se deriva del summary (engines[].models[].lastMtime).
function liveKeysFrom(sum) {
  const set = new Set();
  for (const src of (sum?.engines || [])) {
    for (const m of (src.models || [])) {
      if (isLive(m.lastMtime || src.lastMtime || 0)) set.add(m.key);
    }
  }
  return set;
}

function rangeLabel(range) {
  return {
    day: t('usage.range.day', 'hoy'),
    week: t('usage.range.week', 'últimos 7 días'),
    month: t('usage.range.month', 'últimos 30 días'),
  }[range] || '';
}

// ===== Columna izquierda: "General" del PERÍODO seleccionado =====
// series.totals = { modelKey: {tokens, cost} }. Sigue al rango + a la métrica.
function renderLeft(container, series, metric, liveKeys, range) {
  const totals = series?.totals || {};
  // Orden por PRECIO: más COSTOSO arriba (cima) → más ECONÓMICO abajo (base),
  // consistente con el apilado de la gráfica (base = más barato). Pedido del
  // usuario 2026-07-10. Empate (no debería) desempata por consumo.
  const rows = Object.entries(totals)
    .map(([key, v]) => ({ key, tokens: v.tokens || 0, cost: v.cost || 0 }))
    .filter((m) => m.tokens > 0)
    .sort((a, b) => priceRank(b.key) - priceRank(a.key) || (metric === 'cost' ? b.cost - a.cost : b.tokens - a.tokens));
  let gTok = 0;
  let gCost = 0;
  for (const m of rows) { gTok += m.tokens; gCost += m.cost; }

  const perModel = rows.map((m) => {
    const live = liveKeys?.has(m.key);
    // Badge de precio ($X/M input): identifica el modelo más caro/barato.
    const price = PRICE_INPUT[m.key] != null
      ? `<span class="ul-model-price">$${PRICE_INPUT[m.key]}/M</span>`
      : `<span class="ul-model-price ul-model-price--none" title="${esc(t('usage.left.noRateTitle', 'Se cuenta en tokens: no hay tarifa pública verificada para este modelo, así que no suma al total en dólares.'))}">${t('usage.left.noRate', 'sin tarifa')}</span>`;
    const value = metric === 'cost' && PRICE_INPUT[m.key] == null
      ? '—'
      : fmtMetric(metric === 'cost' ? m.cost : m.tokens, metric);
    return `
      <div class="ul-model">
        <span class="tok-dot" style="background:${modelColor(m.key)}"></span>
        <span class="ul-model-name">${modelName(m.key, m.key)}</span>
        ${price}
        ${live ? pacman({ state: 'working', size: 'sm', cls: 'tok-live', title: t('usage.left.liveTitle', 'consumiendo tokens ahora') }) : ''}
        <span class="ul-model-cost">${value}</span>
      </div>`;
  }).join('') || `<div class="tok-empty">${t('usage.left.empty', 'sin consumo en el período')}</div>`;

  const codexNote = rows.some((m) => PRICE_INPUT[m.key] == null && m.tokens > 0)
    ? `<br>${t('usage.left.codexNote', 'Codex se cuenta en tokens; su consumo no suma al total en dólares.')}`
    : '';
  const bigVal = metric === 'cost' ? fmtCost(gCost) : `${fmtTokens(gTok)} <span class="ul-big-unit">${t('usage.unit.tok', 'tok')}</span>`;
  const subVal = metric === 'cost' ? `${fmtTokens(gTok)} ${t('usage.unit.tok', 'tok')}` : fmtCost(gCost);
  container.innerHTML = `
    <div class="ul-block">
      <div class="ul-head">${t('usage.left.head', '📊 General · {range}', { range: rangeLabel(range) })}</div>
      <div class="ul-big">${bigVal}</div>
      <div class="ul-cost">${subVal}</div>
      <div class="ul-models">${perModel}</div>
      ${rows.length ? `<div class="ul-order">${t('usage.left.order', '▲ más costoso · ▼ más económico ($/M)')}</div>` : ''}
    </div>
    <div class="ul-note">${t('usage.left.note', 'El costo es el <b>equivalente a precios de API</b>: la suscripción de Claude no factura por token.')}${codexNote}</div>`;
}

// ===== Columna derecha: gráfica de tendencia (Chart.js) =====
// Lee un token CSS resuelto a hex (los colores viven en tokens.css; en JS se
// leen con getComputedStyle — no se duplican los hex).
// El CSSStyleDeclaration de getComputedStyle es un objeto VIVO (refleja
// cambios de tema sin re-llamar), así que se cachea una sola vez y se reusa
// — antes se llamaba getComputedStyle ~10-15 veces por dibujo de gráfica.
let _rootStyle = null;
function cssVar(name) {
  if (!_rootStyle) _rootStyle = getComputedStyle(document.documentElement);
  return _rootStyle.getPropertyValue(name).trim();
}
const modelHex = (key) => cssVar(`--cwc-model-${key}`) || cssVar('--cwc-model-unknown') || 'CanvasText';

let chartInst = null;
function destroyChart() {
  if (chartInst) { chartInst.destroy(); chartInst = null; }
}

// Datasets apilados por modelo. Codificación SECUNDARIA (la paleta está en banda
// de piso CVD): leyenda con NOMBRES + gap 2px entre segmentos + tooltip que nombra
// el modelo. Se descartan modelos todo-en-cero (no ensucian la leyenda).
function buildDatasets(series, metric, surface) {
  return (series.keys || []).map((key) => ({
    key,
    label: modelName(key, key),
    data: (series.points || []).map((p) => (p.models[key] ? (metric === 'cost' ? p.models[key].cost : p.models[key].tokens) : 0)),
    backgroundColor: modelHex(key),
    borderColor: surface,
    borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
    borderRadius: 3,
    borderSkipped: false,
    stack: 'total',
    maxBarThickness: 34,
  })).filter((ds) => ds.data.some((v) => v > 0));
}

// Config de Chart.js separada de la instancia — la comparten la gráfica chica
// del modal (chartInst, singleton del módulo) y la copia grande del zoom (una
// instancia propia, ver mount()): así abrir el zoom nunca destruye/pisa la
// gráfica principal.
function buildChartConfig(series, metric) {
  const surface = cssVar('--cwc-bg-panel') || 'Canvas';
  const gridCol = cssVar('--cwc-divider') || 'CanvasText';
  const textCol = cssVar('--cwc-text-dim') || 'CanvasText';
  const fmtVal = metric === 'cost' ? fmtCost : fmtTokens;
  return {
    type: 'bar',
    data: { labels: (series.points || []).map((p) => p.label), datasets: buildDatasets(series, metric, surface) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: textCol, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: {
          stacked: true, beginAtZero: true,
          grid: { color: gridCol, drawTicks: false },
          border: { display: false },
          ticks: { color: textCol, font: { size: 10 }, maxTicksLimit: 5, callback: (v) => fmtVal(v) },
        },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: textCol, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtVal(ctx.parsed.y)}`,
            footer: (items) => `Total: ${fmtVal(items.reduce((s, it) => s + (it.parsed.y || 0), 0))}`,
          },
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
        },
      },
    },
  };
}

// Dibuja (crea) la gráfica desde cero. Se usa al abrir y al cambiar rango/métrica.
function drawChart(canvas, series, metric) {
  destroyChart();
  if (!window.Chart) {
    canvas.parentElement.innerHTML = `<div class="tok-empty">${t('usage.chart.libError', 'No se pudo cargar la librería de gráficas.')}</div>`;
    return;
  }
  chartInst = new window.Chart(canvas.getContext('2d'), buildChartConfig(series, metric));
}

// Actualiza la gráfica EN EL LUGAR (sin destruir/re-animar) para el auto-refresh
// silencioso: reemplaza labels+datasets y update('none'). Si no hay instancia
// (o cambió Chart), cae a dibujar de cero.
function updateChart(canvas, series, metric) {
  if (!chartInst || !window.Chart) { drawChart(canvas, series, metric); return; }
  const surface = cssVar('--cwc-bg-panel') || 'Canvas';
  chartInst.data.labels = (series.points || []).map((p) => p.label);
  chartInst.data.datasets = buildDatasets(series, metric, surface);
  chartInst.update('none'); // sin animación → no parpadea
}

export default {
  name: 'usage',

  async mount(el, ctx) {
    el.hidden = true;
    const me = await ctx.whoami;
    if (!me?.admin) return;
    el.hidden = false;

    const { dialog, icon } = ctx;
    el.innerHTML = `
      <button class="btn-ghost btn--sm usage-btn" title="${t('usage.btn.title', 'Uso de tokens (hoy)')}">
        <span class="usage-lbl">${t('usage.btn.today', 'hoy')}</span><span class="usage-val">—</span>
      </button>`;
    const btn = el.querySelector('.usage-btn');
    const valEl = el.querySelector('.usage-val');
    let lastTokens = null;
    // Cache-then-network: pinta el 'hoy' persistido al instante (antes arrancaba en '—').
    const cachedSum = readCache('usage-summary');
    if (cachedSum?.data?.today) { cache.summary = cachedSum.data; valEl.textContent = fmtTokens(cachedSum.data.today.tokens || 0); }

    async function tick() {
      if (document.hidden) return;
      try {
        const sum = await fetchSummary();
        cache.summary = sum; // mantiene la caché caliente para que el modal abra instantáneo
        writeCache('usage-summary', sum);
        const tk = sum.today.tokens || 0;
        valEl.textContent = fmtTokens(tk);
        btn.title = t('usage.btn.titleFull', 'Hoy: {tok} tokens · {cost} equiv. API', { tok: fmtTokens(tk), cost: fmtCost(sum.today.cost) });
        if (lastTokens != null && tk > lastTokens) {
          valEl.classList.remove('tick');
          void valEl.offsetWidth;
          valEl.classList.add('tick');
        }
        lastTokens = tk;
      } catch { /* reintenta */ }
    }
    tick();
    setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

    btn.addEventListener('click', async () => {
      let timer = null;
      const m = dialog.openModal({
        title: t('usage.modal.title', 'Uso de tokens'),
        width: 780,
        onClose: () => { clearInterval(timer); destroyChart(); },
      });

      const reload = document.createElement('button');
      reload.className = 'btn-ghost btn--sm btn--icon usage-reload';
      reload.title = t('usage.modal.reload', 'Actualizar (re-lee transcripts y límites ahora)');
      reload.innerHTML = icon('refresh', { size: 15 });
      m.card.querySelector('.dlg-head').insertBefore(reload, m.card.querySelector('.dlg-x'));

      m.body.innerHTML = `
        <div class="usage-lims"><div class="cwc-loading">${pacman()}${t('usage.modal.limsLoading', 'límites del plan…')}</div></div>
        <div class="usage-controls">
          <div class="uh-seg uh-seg-range" role="tablist">
            <button class="uh-seg-btn is-active" data-range="day" type="button">${t('usage.seg.day', 'Día')}</button>
            <button class="uh-seg-btn" data-range="week" type="button">${t('usage.seg.week', 'Semana')}</button>
            <button class="uh-seg-btn" data-range="month" type="button">${t('usage.seg.month', 'Mes')}</button>
          </div>
          <div class="uh-seg uh-seg-proj" role="tablist">
            <button class="uh-seg-btn is-active" data-project="all" type="button">${t('usage.proj.all', 'Todos')}</button>
            <button class="uh-seg-btn" data-project="consola" type="button">${t('usage.proj.consola', 'Consola')}</button>
            <button class="uh-seg-btn" data-project="tolkien" type="button">${t('usage.proj.tolkien', 'Tolkien')}</button>
            <button class="uh-seg-btn" data-project="aprendizaje" type="button">${t('usage.proj.aprendizaje', 'Aprendizaje')}</button>
            <button class="uh-seg-btn" data-project="otros" type="button">${t('usage.proj.otros', 'Otros')}</button>
          </div>
          <div class="uh-seg uh-seg-metric">
            <button class="uh-seg-btn is-active" data-metric="cost" type="button">$</button>
            <button class="uh-seg-btn" data-metric="tokens" type="button">${t('usage.unit.tok', 'tok')}</button>
          </div>
        </div>
        <div class="usage-cols">
          <div class="usage-col-left"><div class="cwc-loading">${pacman()}${t('usage.modal.calc', 'calculando…')}</div></div>
          <div class="usage-col-right">
            <div class="uh-title">${t('usage.trend.title', '📈 Tendencia')}</div>
            <div class="usage-chart-wrap"><canvas class="usage-chart"></canvas></div>
          </div>
        </div>`;
      const limsEl = m.body.querySelector('.usage-lims');
      const leftEl = m.body.querySelector('.usage-col-left');
      const chartWrap = m.body.querySelector('.usage-chart-wrap');
      const tabs = [...m.body.querySelectorAll('[data-range]')];
      const mbtns = [...m.body.querySelectorAll('[data-metric]')];
      const projs = [...m.body.querySelectorAll('[data-project]')];

      let range = 'day';
      let metric = 'cost';
      let project = 'all';

      function chartCanvas() {
        let c = chartWrap.querySelector('.usage-chart');
        if (!c) { chartWrap.innerHTML = '<canvas class="usage-chart"></canvas>'; c = chartWrap.querySelector('.usage-chart'); }
        return c;
      }
      // Serie del rango+proyecto actual desde la CACHÉ (null si aún no se trajo).
      function seriesFor() {
        if (range === 'day') return cache.summary?.hourlyToday?.[project] || null;
        return cache.series[`${range}:${project}`] || null;
      }
      const loaderHtml = `<div class="cwc-loading">${pacman()}${t('usage.modal.loading', 'cargando…')}</div>`;

      // Pinta TODO desde la caché (0 fetch). chartMode: 'draw' crea la gráfica,
      // 'update' la actualiza en el lugar (sin parpadeo, para el auto-refresh).
      function paint(chartMode) {
        if (cache.limits) renderLimits(limsEl, cache.limits, { windows: cache.summary?.windows });
        const liveKeys = liveKeysFrom(cache.summary);
        const s = seriesFor();
        if (!s) { leftEl.innerHTML = loaderHtml; if (!chartInst) chartWrap.innerHTML = loaderHtml; return; }
        renderLeft(leftEl, s, metric, liveKeys, range);
        if (chartMode === 'update') updateChart(chartCanvas(), s, metric);
        else drawChart(chartCanvas(), s, metric);
      }

      // Refresca la caché desde el server (silencioso) y re-pinta. `fresh` saltea
      // el TTL (botón Actualizar). El botón muestra spin mientras carga.
      let refreshing = false;
      async function refresh(fresh) {
        if (refreshing) return;
        refreshing = true;
        reload.classList.add('spinning');
        reload.disabled = true;
        try {
          const jobs = [
            fetchSummary(fresh).then((s) => { cache.summary = s; }).catch(() => {}),
            fetchLimits(fresh).then((l) => { cache.limits = l; }).catch(() => {}),
          ];
          if (range !== 'day') jobs.push(fetchHistory(range, project).then((h) => { cache.series[`${range}:${project}`] = h; }).catch(() => {}));
          await Promise.all(jobs);
          paint('update'); // en el lugar → sin parpadeo
          if (!cache.limits) { // límites nunca llegaron (raro: el server persiste stale)
            limsEl.innerHTML = `<div class="lim-head">${t('usage.limits.head', 'Límites del plan')}</div><div class="lim-err">${t('usage.limits.noData', 'sin datos')}</div>`;
          }
        } finally {
          refreshing = false;
          reload.classList.remove('spinning');
          reload.disabled = false;
        }
      }

      // Cambio de rango/proyecto: pinta al toque si está en caché; si falta
      // (semana/mes o un proyecto no traído) muestra loader y lo trae.
      async function showView() {
        if (seriesFor()) { paint('draw'); return; }
        leftEl.innerHTML = loaderHtml;
        chartWrap.innerHTML = loaderHtml;
        try {
          // Día por proyecto sale del summary (hourlyToday por proyecto); si el
          // summary aún no llegó, lo traemos.
          if (range === 'day') { if (!cache.summary) cache.summary = await fetchSummary(false); }
          else cache.series[`${range}:${project}`] = await fetchHistory(range, project);
          paint('draw');
        } catch {
          leftEl.innerHTML = `<div class="tok-empty">${t('usage.left.calcError', 'No se pudo calcular el uso.')}</div>`;
          chartWrap.innerHTML = `<div class="tok-empty">${t('usage.trend.error', 'No se pudo cargar la tendencia.')}</div>`;
        }
      }

      tabs.forEach((t) => t.addEventListener('click', () => {
        if (t.classList.contains('is-active')) return;
        tabs.forEach((x) => x.classList.toggle('is-active', x === t));
        range = t.dataset.range;
        showView();
      }));
      projs.forEach((b) => b.addEventListener('click', () => {
        if (b.classList.contains('is-active')) return;
        projs.forEach((x) => x.classList.toggle('is-active', x === b));
        project = b.dataset.project;
        showView();
      }));
      mbtns.forEach((b) => b.addEventListener('click', () => {
        if (b.classList.contains('is-active')) return;
        mbtns.forEach((x) => x.classList.toggle('is-active', x === b));
        metric = b.dataset.metric;
        paint('draw'); // re-dibuja con la serie cacheada (0 fetch)
      }));
      reload.addEventListener('click', () => refresh(true));

      // Click en la gráfica → copia grande en un modal aparte (mismo patrón
      // que el lightbox de imágenes del chat: openModal genérico + el
      // navegador hace el zoom/pan nativo, sin visor propio). Instancia de
      // Chart PROPIA (no toca chartInst) — se destruye al cerrar ese modal.
      let zoomChart = null;
      chartWrap.addEventListener('click', () => {
        const s = seriesFor();
        if (!s || !window.Chart) return;
        const zm = dialog.openModal({
          title: t('usage.trend.title', '📈 Tendencia'),
          width: 'min(96vw, 1400px)',
          onClose: () => { zoomChart?.destroy(); zoomChart = null; },
        });
        zm.body.innerHTML = '<div class="usage-chart-wrap usage-chart-wrap--zoom"><canvas class="usage-chart"></canvas></div>';
        const zCanvas = zm.body.querySelector('.usage-chart');
        zoomChart = new window.Chart(zCanvas.getContext('2d'), buildChartConfig(s, metric));
      });

      // APERTURA INSTANTÁNEA: pinta lo que haya en caché (el pie la mantiene
      // caliente) y refresca en segundo plano. Sin bloquear con spinner.
      if (cache.summary || cache.limits) paint('draw');
      refresh(false);
      // Auto-refresh silencioso (mismo intervalo que el pie).
      timer = setInterval(() => { if (!document.hidden) refresh(false); }, AUTO_MS);
    });
  },
};
