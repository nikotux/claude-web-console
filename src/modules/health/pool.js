// modules/health/pool.js — pool de concurrencia ADAPTATIVA (F2.5).
//
// Ejecuta `worker(item, ctl)` sobre `items` con concurrencia DINÁMICA: rampa
// hacia arriba mientras haya holgura de CPU/RAM, y baja + pausa lanzamientos
// cuando el worker señala back-off con `ctl.backoff()` (p.ej. al ver 429/
// overload). Resuelve cuando terminaron TODOS (BARRERA). Es genérico: no sabe
// de haiku ni de findings. Las funciones de recursos y reloj son inyectables
// para poder testearlo determinísticamente.
import os from 'node:os';

export function runAdaptivePool(items, worker, opts = {}) {
  const {
    min = 2, start = 4, backoffMs = 15000, rampLoad = 0.75, rampFree = 0.15,
    cores = os.cpus().length || 1,
    loadFn = () => os.loadavg()[0],
    freeRatioFn = () => os.freemem() / (os.totalmem() || 1),
    now = () => Date.now(),
    tickMs = 1000,
  } = opts;

  const queue = items.slice();
  const hardMax = Math.max(min, items.length); // tope duro = nº de items
  let active = 0;
  let target = Math.min(Math.max(min, start), hardMax);
  let pauseUntil = 0;
  let finished = 0;

  // El worker recibe esto: pedir back-off baja la concurrencia y pausa nuevos.
  const ctl = {
    backoff() {
      target = Math.max(min, Math.floor(target / 2));
      pauseUntil = now() + backoffMs;
    },
    get target() { return target; },
    get active() { return active; },
  };

  return new Promise((resolve) => {
    const ramp = () => {
      if (now() < pauseUntil || target >= hardMax) return;
      if (loadFn() < cores * rampLoad && freeRatioFn() > rampFree) target += 1;
    };
    const pump = () => {
      if (finished === items.length) { resolve(); return; }
      ramp();
      while (now() >= pauseUntil && active < target && queue.length) {
        const item = queue.shift();
        active += 1;
        Promise.resolve()
          .then(() => worker(item, ctl))
          .catch(() => { /* el worker maneja sus errores; no tumba el pool */ })
          .finally(() => { active -= 1; finished += 1; pump(); });
      }
    };
    pump();
    // Re-pump periódico: durante back-off/rampa no dependemos solo de las
    // finalizaciones para reanudar los lanzamientos.
    const tick = setInterval(() => {
      if (finished === items.length) { clearInterval(tick); return; }
      pump();
    }, tickMs);
    tick.unref?.();
  });
}
