// modules/stats/plan-limits.js — Límites del plan (Max) en el pie, ENCIMA de
// los gauges CPU/RAM/Disco.
//
// Muestra las ventanas de uso de claude.ai (sesión 5 h · semana todos los
// modelos · semana por modelo) con las MISMAS barras del modal "Uso": reusa
// fetchLimits()/renderLimits() de usage.js (fuente única, no duplica criterio
// de color/formato).
//
// 0 TOKENS: GET /api/tokens/limits solo consulta el medidor OAuth de uso, no
// dispara ninguna corrida del SDK. Poll 5 s SIN `fresh` → el caché de 60 s del
// server hace que solo ~1 de cada 12 lecturas golpee a Anthropic; el resto es
// instantáneo. Pausa con la pestaña en segundo plano (patrón de stats.js).
import { fetchLimits, openClaudeConnectModal, renderLimits } from '../usage/usage.js';
import { readCache, writeCache } from '../../ui/cache-store.js';
import { t } from '../../ui/i18n.js';

const POLL_MS = 5000;

function canRender(data) {
  return !data?.unavailable || !!data.localUsage || !!(data.codex && Array.isArray(data.codex.limits));
}

export default {
  name: 'plan-limits',

  async mount(el, ctx) {
    el.hidden = true;
    const { dialog } = ctx;

    // classList.add (no className=): el wrapper puede traer clases de layout
    // (p.ej. only-expanded) que NO hay que pisar.
    el.classList.add('plan-lims');
    let firstOk = false;
    let requestVersion = 0;
    let freshInFlight = false;
    let freshPromise = null;

    function paint(data) {
      if (!canRender(data)) {
        el.hidden = true;
        el.innerHTML = '';
        firstOk = true;
        return;
      }
      el.hidden = false;
      renderLimits(el, data, {
        credits: false,
        compact: true,
        onConnect: () => openClaudeConnectModal(dialog, refreshFresh),
      });
      firstOk = true;
    }

    function refreshFresh() {
      if (freshPromise) return freshPromise;
      freshInFlight = true;
      const version = ++requestVersion;
      freshPromise = fetchLimits(true)
        .then((data) => {
          if (version === requestVersion) {
            writeCache('plan-limits', data);
            paint(data);
          }
          return data;
        })
        .finally(() => {
          freshInFlight = false;
          freshPromise = null;
        });
      return freshPromise;
    }

    // Cache-then-network: pinta las últimas barras conocidas al instante.
    const cachedLim = readCache('plan-limits');
    if (cachedLim) {
      try {
        paint(cachedLim.data);
      } catch { /* noop */ }
    }
    async function tick() {
      if (document.hidden || freshInFlight) return;
      const version = ++requestVersion;
      try {
        const data = await fetchLimits(); // sin fresh: reusa el caché de 60 s
        if (version === requestVersion) {
          writeCache('plan-limits', data);
          paint(data);
        }
      } catch {
        // Sin datos aún (token vencido / sin red): mostramos una nota discreta
        // solo si nunca llegó a pintar; si ya había datos, dejamos los viejos.
        if (version === requestVersion && !firstOk) {
          el.hidden = false;
          el.innerHTML = `<div class="lim-head">${t('stats.limits.title', 'Límites del plan')}</div><div class="lim-err">${t('stats.limits.noData', 'sin datos')}</div>`;
        }
      }
    }
    tick();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    setInterval(tick, POLL_MS);
  },
};
