// ui/places.js — LUGARES CONOCIDOS: fuente única frontend del nombre + ícono
// de los proyectos "con identidad" de esta máquina (pedido del usuario
// 2026-07-05: diferenciar de un vistazo MI CONSOLA de Tolkien en launcher,
// Proyectos y tarjetas de Sesiones).
//
// La clave es la ruta RELATIVA al home ('claude-web-console', 'tolkien').
// placeFor() normaliza: acepta rel o absoluta (/home/<user>/...) y con o sin
// barra final. Devuelve {rel, label, ico, cls} o null si la carpeta no es un
// lugar conocido (ahí el caller usa su fallback genérico: basename + 'folder').
// cls es el modificador CSS opcional del diferenciador visual (style.css).
export const PLACES = [
  { rel: 'claude-web-console', label: 'Mi Consola', ico: 'console', cls: 'is-console' },
  { rel: 'tolkien', label: 'Tolkien', ico: 'gitBranch', cls: '' },
];

// 🌗 LIMBO — no es un lugar por cwd (una sesión-Limbo corre en cwd Tolkien),
// es un ESTADO de la sesión (chat.limbo): alto riesgo, herramientas de ambos
// mundos. sessions.js la agrupa aparte usando este descriptor.
export const LIMBO_PLACE = { rel: '__limbo', label: '🌗 Limbo (alto riesgo)', ico: 'relay', cls: 'is-limbo' };

export function placeFor(p) {
  const rel = String(p || '').replace(/^\/home\/[^/]+\/?/, '').replace(/\/+$/, '');
  return PLACES.find((x) => x.rel === rel) || null;
}

// Los entornos aislados viven bajo ENVS_DIR de
// src/modules/tolkien/env-store.js (`~/.cwc-data/tolkien-envs`), y
// worktreePathFor(id) resuelve cada árbol como `<ENVS_DIR>/<id>/tree`.
const TOLKIEN_ENV_RE = /^\.cwc-data\/tolkien-envs\/([A-Za-z0-9._-]+)\/tree$/;

export function envPlaceFor(p) {
  const rel = String(p || '').replace(/^\/home\/[^/]+\/?/, '').replace(/\/+$/, '');
  const m = rel.match(TOLKIEN_ENV_RE);
  return m
    ? { rel: 'tolkien', envId: m[1], label: 'Tolkien', ico: 'isolated', cls: 'is-env', isolated: true }
    : null;
}

// Resolución ampliada para superficies que deben reconocer también la capa
// aislada; placeFor() conserva a propósito su contrato de lugares exactos.
export function resolvePlace(p) {
  return placeFor(p) || envPlaceFor(p);
}
