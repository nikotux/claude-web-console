// board/polls.js — poll manager POR CLAVE (R2), no por nodo del DOM.
//
// Antes cada panel encuestaba con un loop de setTimeout anclado a su caja
// (guarda box.isConnected): un re-render mataba el poll aunque el runner
// server-side siguiera vivo. Acá los polls se identifican por clave
// ('desk:519', 'inv:232', 'tktinv:519', 'desk:bulk') y son inmunes al
// re-render: el tick escribe al store y el render pinta lo que haya.
// deadline + dedup se conservan (mismos topes defensivos que antes).
//
// tick() es una función async que devuelve true cuando el poll terminó
// (resultado listo o error definitivo). El poll corre hasta tick()===true,
// el deadline, o stop()/stopAll() (cierre del tablero).

const active = new Map(); // key -> { cancelled, promise }

export const isPolling = (key) => active.has(key);

export function poll(key, { tick, intervalMs = 2500, timeoutMs = 5 * 60000, onTimeout }) {
  // Dedup: si la clave ya se está encuestando, reusar esa corrida.
  if (active.has(key)) return active.get(key).promise;
  const ctl = { cancelled: false };
  ctl.promise = (async () => {
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        if (ctl.cancelled) return 'cancelled';
        if (await tick()) return 'done';
        if (Date.now() > deadline) {
          if (onTimeout) await onTimeout();
          return 'timeout';
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } finally { active.delete(key); }
  })();
  active.set(key, ctl);
  return ctl.promise;
}

export function stop(key) {
  const ctl = active.get(key);
  if (ctl) ctl.cancelled = true;
}

// Al cerrar el tablero: se cancelan los loops del CLIENTE (los runners
// server-side siguen; el resultado queda persistido y se lee al reabrir).
export function stopAll() {
  for (const ctl of active.values()) ctl.cancelled = true;
}
