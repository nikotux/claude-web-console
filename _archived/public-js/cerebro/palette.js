// Las variables CSS pueden contener var() y color-mix(): getPropertyValue()
// devolvería ese texto sin resolver y el renderer 3D no podría usarlo. Una única
// sonda real en el DOM obliga al navegador a entregar el color computado.

const NEUTRAL_FALLBACK = 'rgb(136, 136, 136)';
const DARK_BG_FALLBACK = '#0b0e14';

export const COLLECTION_TOKENS = {
  planes: '--cwc-accent',
  pendientes: '--cwc-model-sonnet',
  bugs: '--cwc-danger',
  conventions: '--cwc-warn',
  playbooks: '--cwc-peer-2',
  docs: '--cwc-peer-1',
  arquitectura: '--cwc-model-opus',
  'mejora-continua': '--cwc-ok',
  'contexto-de-tickets': '--cwc-peer-4',
  'temas-de-aprendizaje': '--cwc-model-haiku',
  'rutas-de-aprendizaje': '--cwc-peer-3',
  'infraestructura-de-red': '--cwc-model-codex',
  'auditoria-red': '--cwc-peer-5',
};

export const FALLBACK_TOKENS = [
  '--cwc-peer-6',
  '--cwc-cat-doc',
  '--cwc-info',
  '--cwc-model-fable',
  '--cwc-cat-archive',
];

// Los tipos de arista tienen una semántica global, independiente de la
// colección de sus extremos. Todos los colores vienen de tokens compartidos:
// parent queda como estructura neutra y las relaciones laterales usan tonos
// existentes y distinguibles de la paleta de la consola.
export const LINK_TYPE_TOKENS = {
  parent: '--cwc-border-strong',
  implements: '--cwc-accent-cool',
  blocks: '--cwc-danger-strong',
  supersedes: '--cwc-warn',
  split_from: '--cwc-peer-2',
  wiki: '--cwc-peer-3',
};

export const COLLECTION_LABEL = {
  planes: 'Planes',
  pendientes: 'Pendientes',
  bugs: 'Bugs',
  conventions: 'Convenciones',
  playbooks: 'Playbooks',
  docs: 'Documentos',
  arquitectura: 'Arquitectura',
  'mejora-continua': 'Mejora Continua',
  'contexto-de-tickets': 'Contexto de tickets',
  'temas-de-aprendizaje': 'Temas de aprendizaje',
  'rutas-de-aprendizaje': 'Rutas de aprendizaje',
  'infraestructura-de-red': 'Infraestructura de red',
  'auditoria-red': 'Auditoría de red',
};

// Chrome computa color-mix() como color(srgb ...) (CSS Color 4), pero THREE.js
// solo acepta hex/rgb/rgba/hsl/hsla. Por ejemplo, --cer-bg se midió como
// color(srgb 0.0194118 0.0247059 0.0352941), así que hay que normalizarlo.
function normalizeColor(value, fallback = NEUTRAL_FALLBACK) {
  if (typeof value !== 'string' || !value.trim()) return fallback;

  const srgb = value.trim().match(
    /^color\(\s*srgb\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:\s*\/\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?))?\s*\)$/i,
  );
  if (srgb) {
    const components = srgb.slice(1, 4).map((component) => (
      Math.min(255, Math.max(0, Math.round(Number(component) * 255)))
    ));
    const [red, green, blue] = components;
    return srgb[4] === undefined
      ? `rgb(${red}, ${green}, ${blue})`
      : `rgba(${red}, ${green}, ${blue}, ${srgb[4]})`;
  }

  if (/^(?:#[\da-f]{3,8}|rgba?\(.+\)|hsla?\(.+\))$/i.test(value.trim())) return value;
  return fallback;
}

function relativeLuminance(value) {
  const trimmed = String(value || '').trim();
  let components = null;
  const rgb = trimmed.match(/^rgba?\((.+)\)$/i);

  if (rgb) {
    components = rgb[1].split('/')[0].replace(/,/g, ' ').trim().split(/\s+/).slice(0, 3)
      .map((component) => (
        component.endsWith('%') ? Number(component.slice(0, -1)) * 2.55 : Number(component)
      ));
  } else {
    const hex = trimmed.match(/^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i);
    if (hex) {
      const full = hex[1].length <= 4
        ? hex[1].slice(0, 3).split('').map((digit) => digit + digit)
        : hex[1].slice(0, 6).match(/.{2}/g);
      components = full.map((component) => Number.parseInt(component, 16));
    }
  }

  if (!components || components.length !== 3 || components.some((component) => !Number.isFinite(component))) {
    return null;
  }

  const linear = components.map((component) => {
    const channel = Math.min(255, Math.max(0, component)) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function stableHash(value) {
  let hash = 0;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

export function createPalette() {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);

  const cache = new Map();

  function resolveToken(token, fallback = NEUTRAL_FALLBACK) {
    const cacheKey = `${token}\u0000${fallback}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    // Si el token no resuelve, sin fallback la sonda hereda el color de TEXTO:
    // el fondo termina blanco sin que el navegador lance ningún error.
    probe.style.color = `var(${token}, ${fallback})`;
    const color = normalizeColor(getComputedStyle(probe).color, fallback);
    cache.set(cacheKey, color);
    return color;
  }

  function tokenFor(slug) {
    if (String(slug).startsWith('--')) return String(slug);
    if (COLLECTION_TOKENS[slug]) return COLLECTION_TOKENS[slug];
    return FALLBACK_TOKENS[stableHash(slug) % FALLBACK_TOKENS.length];
  }

  function colorFor(slug) {
    return resolveToken(tokenFor(slug));
  }

  function colorForLinkType(type) {
    return resolveToken(LINK_TYPE_TOKENS[type] || '--cwc-text-dim');
  }

  function bg() {
    const color = resolveToken('--cer-bg', DARK_BG_FALLBACK);
    // Esta vista es oscura por diseño: un fondo claro no es una preferencia
    // legítima, sino la señal de que la sonda heredó el color de TEXTO y pintó
    // el fondo de blanco, sin lanzar ningún error.
    if (relativeLuminance(color) > 0.5) {
      console.warn('[cerebro] Se descartó un fondo claro resuelto desde --cer-bg.', color);
      return DARK_BG_FALLBACK;
    }
    return color;
  }

  function all(slugs) {
    return new Map([...new Set(slugs || [])].map((slug) => [slug, colorFor(slug)]));
  }

  return { colorFor, colorForLinkType, bg, all };
}
