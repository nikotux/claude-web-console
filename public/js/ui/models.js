// ui/models.js — identidad visual de los modelos de IA (fuente ÚNICA).
//
// Los colores viven en tokens.css (--cwc-model-<key>); el backend envía solo
// la key semántica (opus|sonnet|haiku|fable|unknown). Este helper resuelve
// color y nombre en todo el frontend — nunca hex hardcodeados.

export function modelColor(key) {
  return `var(--cwc-model-${key || 'unknown'})`;
}

export function modelName(key, fallbackId = '') {
  if (!key || key === 'unknown') return fallbackId || '?';
  return key[0].toUpperCase() + key.slice(1);
}
