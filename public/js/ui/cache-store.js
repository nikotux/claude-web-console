// ui/cache-store.js — Capa 2: cache-then-network para datos de widgets.
// Persiste en localStorage la última respuesta conocida de un GET idempotente
// para que los widgets pinten AL INSTANTE lo último visto (sin esperar la red)
// y refresquen por detrás. Se invalida por BUILD_ID: una respuesta guardada por
// un deploy anterior (con forma potencialmente distinta) se ignora.
// NUNCA usar con endpoints de secretos ni de permisos volátiles (pendingPerms,
// /api/tokens/flow, etc.).
const NS = 'cwc.cache.';
const BUILD = (typeof window !== 'undefined' && window.__CWC_BUILD__) || 'dev';
const FETCH_TIMEOUT_MS = 10000;

// Devuelve { v, t, data } o null (inexistente / de otra versión / corrupto).
export function readCache(key) {
  try {
    const raw = localStorage.getItem(NS + key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.v !== BUILD) return null; // otra versión de la app: shape distinto
    return o;
  } catch { return null; }
}

export function writeCache(key, data) {
  try {
    localStorage.setItem(NS + key, JSON.stringify({ v: BUILD, t: Date.now(), data }));
  } catch { /* cuota/serialización: best-effort, nunca rompe el flujo */ }
}

// Conveniencia cache-then-network para endpoints de URL simple: pinta lo
// cacheado al instante (si hay y no expiró el ttl) y luego lo fresco.
// onData(data, { fromCache }) se llama 1 o 2 veces. Devuelve la promesa del
// fetch (resuelve con los datos frescos; rechaza si falló la red).
export function cachedGet(url, { key, ttl = 0, onData } = {}) {
  const k = key || url;
  const hit = readCache(k);
  if (hit && (!ttl || Date.now() - hit.t < ttl)) {
    try { onData?.(hit.data, { fromCache: true }); } catch { /* noop */ }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ac.signal })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => { writeCache(k, data); try { onData?.(data, { fromCache: false }); } catch { /* noop */ } return data; })
    .finally(() => clearTimeout(timer));
}
