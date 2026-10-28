// core/recents.js — carpetas recientes donde se crearon sesiones.
//
// Alimenta la sección "Recientes" del lanzador del host. recents.json es un
// registro GLOBAL: los inquilinos nunca escriben ni leen sus rutas acá.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWithinHome } from './paths.js';
import { writeJsonAtomic } from './atomic-write.js';
import { hostUser } from './user-space.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', '..', 'recents.json');
const MAX = 10; // el lanzador muestra 3 y el resto vive en el modal "Ver más"

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).recents || []; }
  catch { return []; }
}
function save(recents) {
  try { writeJsonAtomic(FILE, { recents }, { space: 2 }); } // atómico (fix B5): estado durable
  catch { /* noop: los recientes no son críticos */ }
}

// Registra una carpeta (ruta RELATIVA al home). El home ('') no se registra:
// ya es atajo fijo del lanzador.
export function recordRecent(relCwd, owner = null) {
  // recents.json es un registro GLOBAL del host; un inquilino nunca escribe acá.
  if (owner && owner !== hostUser()) return;
  const rel = String(relCwd || '').replace(/^\/+|\/+$/g, '');
  if (!rel) return;
  // INVARIANTE 1: nunca persistir una ruta sin validar que cae dentro del home.
  if (!resolveWithinHome(rel)) return;
  const recents = load();
  const existing = recents.find((r) => r.cwd === rel);
  if (existing) {
    existing.lastUsed = Date.now();
    existing.count = (existing.count || 0) + 1;
  } else {
    recents.push({ cwd: rel, lastUsed: Date.now(), count: 1 });
  }
  recents.sort((a, b) => b.lastUsed - a.lastUsed);
  save(recents.slice(0, MAX));
}

export function listRecents(principal) {
  if (principal && (principal.oversight || principal.username === hostUser())) return load();
  return [];
}
