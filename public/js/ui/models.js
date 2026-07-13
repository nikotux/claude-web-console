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

// Ícono diferenciador por modelo (2026-07-06, pedido del usuario: AutoTux ya
// tenía el suyo — 🤖 — y el resto de los modelos quedaban como texto pelado
// en el chip .sess-model de Sesiones; ahora TODOS tienen uno, mismo criterio
// visual). Emoji (no ui/icons.js) a propósito: mismo lenguaje que el 🤖 de
// AutoTux, que también es un emoji suelto en el texto del chip — no un SVG
// de trazo. Tema poesía/música (nombres reales de los modelos de Anthropic:
// haiku/sonnet/opus son formas cada vez más complejas). Fuente ÚNICA: si se
// agrega un modelo nuevo, sumarlo acá — nunca hardcodear el emoji en un
// módulo de más arriba.
const MODEL_ICONS = {
  auto: '🤖',      // AutoTux (router de modelo automático)
  opusplan: '🧭',  // Opus plan (modo planificación)
  fable: '📖',
  opus: '🎼',
  sonnet: '📜',
  haiku: '🍃',
  default: '⚙️',
  unknown: '❓',
};

export function modelIcon(key) {
  return MODEL_ICONS[key] || MODEL_ICONS.unknown;
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

// Eje thinking effort (PEND-391 #3): opciones de ESFUERZO de razonamiento del
// submenú "Cambiar modelo" de Sesiones. 'auto' = seguir el tier del modelo
// (haiku→low · sonnet→medium · opus→high, effortForLevel del backend). Fuente
// ÚNICA frontend; el backend valida contra EFFORT_LEVELS de core/model-router.js.
export const EFFORT_OPTIONS = [
  ['auto', 'Auto · según modelo'],
  ['low', 'Bajo'],
  ['medium', 'Medio'],
  ['high', 'Alto'],
  ['xhigh', 'Muy alto'],
  ['max', 'Máximo'],
];
const EFFORT_LABEL = { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };
// Etiqueta corta del esfuerzo para chips/badges. pinned=false ⇒ derivado del
// tier (se muestra tenue "· auto"); pinned=true ⇒ elegido a mano.
export function effortLabel(effort, pinned) {
  if (!effort) return '';
  const l = EFFORT_LABEL[effort] || effort;
  return pinned ? l : `${l} · auto`;
}
