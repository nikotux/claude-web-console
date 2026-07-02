// core/claude-model.js — detecta el modelo EN USO de una sesión de Claude Code.
//
// Fuente confiable y no invasiva: el `message.model` de la última respuesta en
// el transcript ~/.claude/projects/<cwd-codificado>/<sesión>.jsonl. Se lee solo
// la cola del archivo (rápido) y se cachea unos segundos.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 65536;
const CACHE_TTL = 3000;
const cache = new Map(); // absCwd -> { t, v }

// Claude codifica el cwd absoluto reemplazando lo no alfanumérico por '-'.
function encodeCwd(absCwd) {
  return absCwd.replace(/[^A-Za-z0-9]/g, '-');
}

// Último modelo (claude-*) mencionado en la cola del archivo.
function tailModel(file) {
  let fd;
  try {
    fd = fss.openSync(file, 'r');
    const size = fss.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fss.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const re = /"model"\s*:\s*"(claude-[^"]+)"/g;
    let m; let last = null;
    while ((m = re.exec(text))) last = m[1];
    return last;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fss.closeSync(fd); } catch { /* noop */ } }
  }
}

// Mapea un id de modelo a { id, name, color } para el banderín.
function describe(id) {
  const low = id.toLowerCase();
  if (low.includes('opus')) return { id, name: 'Opus', color: '#b57edc' };
  if (low.includes('sonnet')) return { id, name: 'Sonnet', color: '#4e8fd1' };
  if (low.includes('haiku')) return { id, name: 'Haiku', color: '#6cb06c' };
  if (low.includes('fable')) return { id, name: 'Fable', color: '#d9925a' };
  return { id, name: id, color: '#8a8a8a' };
}

function compute(absCwd) {
  const dir = path.join(PROJECTS, encodeCwd(absCwd));
  let files;
  try { files = fss.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); }
  catch { return null; }
  if (!files.length) return null;
  // El transcript más recientemente modificado = la sesión activa.
  let best = null; let bestM = -1;
  for (const f of files) {
    try { const mt = fss.statSync(f).mtimeMs; if (mt > bestM) { bestM = mt; best = f; } } catch { /* noop */ }
  }
  if (!best) return null;
  const id = tailModel(best);
  return id ? describe(id) : null;
}

// Devuelve { id, name, color } o null. Cacheado por cwd.
export function modelForCwd(absCwd) {
  if (!absCwd) return null;
  const now = Date.now();
  const c = cache.get(absCwd);
  if (c && now - c.t < CACHE_TTL) return c.v;
  const v = compute(absCwd);
  cache.set(absCwd, { t: now, v });
  return v;
}
