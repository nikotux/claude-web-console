// core/recents.js — carpetas recientes donde se crearon sesiones.
//
// Alimenta la sección "Recientes" del lanzador. Persistencia mínima en
// recents.json (raíz del proyecto, gitignored; entra en los backups).
// Se registra en cada POST /api/terminal/sessions con carpeta (no attach).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', '..', 'recents.json');
const MAX = 8;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).recents || []; }
  catch { return []; }
}
function save(recents) {
  try { fs.writeFileSync(FILE, JSON.stringify({ recents }, null, 2)); }
  catch { /* noop: los recientes no son críticos */ }
}

// Registra una carpeta (ruta RELATIVA al home). El home ('') no se registra:
// ya es atajo fijo del lanzador.
export function recordRecent(relCwd) {
  const rel = String(relCwd || '').replace(/^\/+|\/+$/g, '');
  if (!rel) return;
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

export function listRecents() {
  return load();
}
