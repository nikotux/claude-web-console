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
import { fetchLimits, renderLimits } from '../usage/usage.js';

const POLL_MS = 5000;

export default {
  name: 'plan-limits',

  mount(el) {
    // classList.add (no className=): el wrapper puede traer clases de layout
    // (p.ej. only-expanded) que NO hay que pisar.
    el.classList.add('plan-lims');
    let firstOk = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const data = await fetchLimits(); // sin fresh: reusa el caché de 60 s
        renderLimits(el, data);
        firstOk = true;
      } catch {
        // Sin datos aún (token vencido / sin red): mostramos una nota discreta
        // solo si nunca llegó a pintar; si ya había datos, dejamos los viejos.
        if (!firstOk) el.innerHTML = '<div class="lim-head">Límites del plan</div><div class="lim-err">sin datos</div>';
      }
    }
    tick();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    setInterval(tick, POLL_MS);
  },
};
