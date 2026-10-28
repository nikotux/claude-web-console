// ui/i18n.js — núcleo de internacionalización (PLAN i18n, 2026-07-19).
//
// `t(key, fallbackEs, vars)` es el ÚNICO punto de entrada para strings
// visibles al usuario en código NUEVO. El español NO vive en un archivo
// aparte: vive como el propio `fallbackEs` inline en el código — así nunca
// puede desincronizarse ("el key existe pero el ES quedó viejo") y en 'es'
// (idioma por defecto) NO hace falta cargar ningún diccionario. Solo el
// inglés vive en `public/i18n/en/<módulo>.json`, namespaced 1:1 con
// `public/js/modules/<módulo>` (+ `core` para lo compartido de `ui/`).
//
// Si falta una clave en el diccionario activo, `t()` cae al fallback en
// español — nunca rompe el render (mismo criterio "degradar, no explotar"
// del resto del proyecto: whisper ausente, Pad caído, etc.).
//
// Cambiar de idioma recarga la página (ver `setLang`) — no hay reactividad
// en vivo: es una preferencia que se toca rara vez, y evitarla ahorra tener
// que instrumentar cada uno de los ~15 módulos con un listener de re-render.

// Esta lista decide qué diccionarios se descargan. Agregar un JSON nuevo en
// public/i18n/en/ sin sumar acá su namespace lo deja muerto; el auditor
// `node bin/cwc-i18n-audit.js` detecta ese olvido en la sección `## carga`.
// El auditor trata cada namespace como UN archivo: partir un diccionario en
// varios JSON hace que Salud reporte faltantes y huérfanas falsas.
const MODULES = [
  'core', 'launcher', 'sessions', 'chat', 'terminal',
  'retro', 'stats', 'system', 'tolkien', 'usage', 'mobile', 'unifi',
  'files', 'rawview', 'onboard', 'news', 'projects', 'visado',
  'cabina',
  'forja',
];
const FETCH_TIMEOUT_MS = 10000;

let LANG = 'es';
let DICT = {};
let ready = Promise.resolve();

function interpolate(str, vars) {
  if (str == null) return str;
  if (!vars) return str;
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function getLang() {
  return LANG;
}

// Carga el diccionario del idioma (no-op para 'es': el fallback ES cubre
// todo). Tolerante a módulos sin diccionario todavía (404 → se saltea, no
// rompe nada).
export function initI18n(lang) {
  LANG = lang === 'en' ? 'en' : 'es';
  DICT = {};
  if (LANG !== 'en') { ready = Promise.resolve(); return ready; }
  ready = Promise.all(MODULES.map(async (m) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(`/i18n/en/${m}.json`, { cache: 'no-store', signal: ac.signal });
      if (!r.ok) return;
      Object.assign(DICT, await r.json());
    } catch { /* módulo sin diccionario todavía: fallback ES cubre */ }
    finally { clearTimeout(timer); }
  }));
  return ready;
}

export function t(key, fallbackEs, vars) {
  if (LANG === 'en' && key in DICT) return interpolate(DICT[key], vars);
  return interpolate(fallbackEs, vars);
}

// Barre el HTML estático (index.html) tras cargar el diccionario:
// data-i18n="key" → textContent · data-i18n-title="key" → atributo title
// (los botones de solo-ícono usan title como tooltip accesible).
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'), el.textContent);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'), el.title);
  });
}

// Guarda la preferencia en el perfil del usuario y recarga — la recarga es
// la forma más simple y robusta de aplicar el cambio a TODA la app sin
// instrumentar cada módulo con reactividad (ver cabecera del archivo).
export async function setLang(lang) {
  const r = await fetch('/api/account/lang', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || t('core.i18n.saveLangError', 'No se pudo guardar el idioma.'));
  window.location.reload();
}
