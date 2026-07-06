// board/polls.js — poll manager POR CLAVE, inmune al re-render (R2). Clon del
// de bugs/board: el tick escribe al store y el render pinta lo que haya.
const active = new Map();
export const isPolling = (key) => active.has(key);

export function poll(key, { tick, intervalMs = 2500, timeoutMs = 5 * 60000, onTimeout }) {
  if (active.has(key)) return active.get(key).promise;
  const ctl = { cancelled: false };
  ctl.promise = (async () => {
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        if (ctl.cancelled) return 'cancelled';
        if (await tick()) return 'done';
        if (Date.now() > deadline) { if (onTimeout) await onTimeout(); return 'timeout'; }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } finally { active.delete(key); }
  })();
  active.set(key, ctl);
  return ctl.promise;
}
export function stop(key) { const c = active.get(key); if (c) c.cancelled = true; }
export function stopAll() { for (const c of active.values()) c.cancelled = true; }
