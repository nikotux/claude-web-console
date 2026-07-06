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

// ===== AutoTux — router de modelo automático (2026-07-06) =====
// Fuente ÚNICA de las opciones del menú "Cambiar modelo" de un CHAT (no de
// una sesión TUI/tmux — esa sigue con su propia lista sin 'auto' en
// sessions.js/launcher.js: el CLI real no conoce ese alias, ver
// core/model-router.js del backend). `auto` va PRIMERO (predeterminado de
// toda conversación nueva); `opusplan` segundo, renombrado sin la palabra
// "Auto" para no confundirlo con nuestro router (antes decía "Auto (Opus
// plan / Sonnet)").
export const CHAT_MODEL_OPTIONS = [
  ['auto', 'AutoTux'],
  ['opusplan', 'Opus plan'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['default', 'Default de la cuenta'],
];

// Los 4 niveles que AutoTux gestiona de verdad (haiku→sonnet→opus→fable,
// core/model-router.js MODEL_LEVELS). Fuera de esta lista (opusplan/default)
// el router no tiene margen para moverse aunque modelChoice sea 'auto'.
export const ROUTER_MANAGED_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
