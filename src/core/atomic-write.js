// core/atomic-write.js — escritura ATÓMICA a disco (tmp + rename), fuente ÚNICA.
// El patrón vivía duplicado en claims-store.js y meta-store.js; los stores
// grandes (snapshots del dashboard, contextos .md) usaban writeFileSync directo
// y podían quedar a medias si el proceso moría a mitad de escritura (reinicio /
// crash), dejando un JSON corrupto que rompe el arranque. rename(2) es atómico
// en el mismo filesystem: o está el archivo viejo entero, o el nuevo entero,
// nunca uno a medias. Uso: writeJsonAtomic(file, obj) / writeFileAtomic(file, str).
import fs from 'node:fs';
import path from 'node:path';

// Escribe `data` (string o Buffer) a `file` de forma atómica. Crea el directorio
// si falta. `mode` aplica al archivo final (default 0o600 = privado del usuario).
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // tmp único por pid para no pisar el tmp de otra escritura concurrente del
  // mismo archivo (dos writers → cada uno su tmp → el último rename gana, sin
  // corromper; nunca un tmp compartido a medias).
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

// Igual, serializando a JSON. `space` opcional para JSON legible (default compacto).
export function writeJsonAtomic(file, obj, { mode = 0o600, space = 0 } = {}) {
  writeFileAtomic(file, JSON.stringify(obj, null, space), { mode });
}
