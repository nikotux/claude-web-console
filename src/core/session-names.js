// core/session-names.js — nombres ÚNICOS para las tarjetas de "Sesiones".
//
// Problema que resuelve: crear dos sesiones en ~/tolkien mostraba dos
// tarjetas "tolkien" idénticas. Acá vive el uniquificador ("tolkien" →
// "tolkien 1" → "tolkien 2") y un registro de PROVEEDORES de nombres: cada
// módulo que muestra tarjetas aporta una función que devuelve los display
// names vivos (el módulo chat aporta los títulos de sus conversaciones; el
// módulo tmux, los de todas las sesiones tmux). Así el chequeo de colisión
// es CRUZADO entre tipos sin acoplar los módulos entre sí — ambos solo
// dependen de este core.
//
// También viven acá los helpers de títulos custom de tmux (titles.json),
// antes privados del módulo tmux: el módulo terminal ahora también los
// necesita (al crear una sesión con nombre repetido, persiste el título
// único como customTitle — el display name de una tarjeta tmux es
// customTitle || basename(cwd), así que un título solo-en-RAM no alcanza).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TITLES_FILE = path.join(__dirname, '..', '..', 'titles.json');

// ===== Títulos humanos custom de sesiones tmux (titles.json) =====
export function loadTitles() {
  try { return JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')).titles || {}; }
  catch { return {}; }
}
export function saveTitles(titles) {
  try { fs.writeFileSync(TITLES_FILE, JSON.stringify({ titles }, null, 2)); }
  catch { /* noop */ }
}
export const titleKey = (socketName, name) => `${socketName}/${name}`;

// ===== Registro de nombres en uso + uniquificador =====
const providers = new Set(); // funciones () => iterable de display names

export function registerNameProvider(fn) {
  providers.add(fn);
}

// Todos los display names actualmente en uso (case-insensitive), consultando
// a los proveedores EN EL MOMENTO (nada cacheado: una tarjeta puede haberse
// cerrado/renombrado hace un segundo). Un proveedor roto no tumba el resto.
export function takenNames() {
  const taken = new Set();
  for (const fn of providers) {
    try {
      for (const n of fn() || []) {
        const clean = String(n || '').trim().toLowerCase();
        if (clean) taken.add(clean);
      }
    } catch { /* proveedor roto: se ignora */ }
  }
  return taken;
}

// "tolkien" → "tolkien" si está libre; si no "tolkien 1", "tolkien 2", …
export function uniqueName(base) {
  const clean = String(base || '').trim() || 'sesión';
  const taken = takenNames();
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 1; ; i += 1) {
    const candidate = `${clean} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
