// modules/projects/memory.js — contexto (CLAUDE.md) y memorias (memory/*.md)
// de un proyecto CUALQUIERA de los registrados en index.js, leídos y
// editados EN VIVO. No son copias: son los mismos archivos que Claude Code
// lee de verdad cuando trabaja en `projectDir`, así que un cambio acá se
// aplica a la próxima sesión de Claude Code en ese proyecto (sin reiniciar
// nada: CLAUDE.md y las memorias se leen al vuelo, no viven en memoria del
// proceso Node).
//
// - "Contexto" = <projectDir>/CLAUDE.md.
// - "Memorias" = ~/.claude/projects/<projectDir codificado>/memory/*.md — el
//   índice MEMORY.md ("- [Título](archivo.md) — descripción", mismo formato
//   en todos los proyectos) + las notas individuales que enlaza. Las escribe
//   Claude Code automáticamente a partir de feedback real de las
//   conversaciones (p.ej. "respondeme siempre en inglés"); esta pantalla
//   permite auditarlas/corregirlas a mano.
//
// Todas las funciones toman `projectDir` (ruta absoluta) como primer
// argumento: NO hay estado global de "cuál proyecto" acá, así que sirve por
// igual para el proyecto trackeado (Tolkien) y para esta propia consola.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeCwd } from '../../core/claude-model.js';
import { writeFileAtomic } from '../../core/atomic-write.js';
import { userClaudeDir, hostUser } from '../../core/user-space.js';

const INDEX_FILE_NAME = 'MEMORY.md';

// Whitelist estricto para el nombre de nota que llega del cliente: sin '/' ni
// '..', nada de path traversal posible (nunca se concatena "crudo").
const NOTE_RE = /^[A-Za-z0-9_-]+\.md$/;
const MAX_SIZE = 400 * 1024; // generoso: el CLAUDE.md más grande (Tolkien) ya pesa ~22KB

function memoryDirFor(projectDir, userId) {
  return path.join(userClaudeDir(userId || hostUser()), 'projects', encodeCwd(projectDir), 'memory');
}

function safeNotePath(projectDir, file, userId) {
  if (!NOTE_RE.test(file || '')) throw Object.assign(new Error('Nombre de nota inválido.'), { badRequest: true });
  return path.join(memoryDirFor(projectDir, userId), file);
}

export function readContext(projectDir) {
  try { return fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8'); }
  catch { return ''; }
}

export function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}

// `expectedHash` es OPCIONAL (a diferencia de writeContextSection, donde es
// obligatorio): lo usa la ruta de archivo completo cuando el cliente lo abrió
// vía GET /:key/context y quiere detectar que otra sesión (Claude Code, o el
// editor por secciones) lo cambió mientras tanto. Si no lo manda, se conserva
// el comportamiento histórico (pisa sin chequear) para no romper llamadores
// programáticos existentes que ignoran el hash.
export function writeContext(projectDir, text, expectedHash) {
  const out = String(text ?? '');
  if (Buffer.byteLength(out) > MAX_SIZE) throw Object.assign(new Error('El contexto es demasiado grande (máximo 400 KB). Nada se guardó.'), { badRequest: true });
  if (expectedHash) {
    const current = readContext(projectDir);
    if (hashOf(current) !== String(expectedHash)) {
      throw Object.assign(new Error('El contexto cambió desde que lo abriste (otra sesión lo editó). Recargá y reintentá.'), { conflict: true });
    }
  }
  writeFileAtomic(path.join(projectDir, 'CLAUDE.md'), out, { mode: 0o644 }); // atómico (fix B5): CLAUDE.md real que lee Claude Code; un write cortado lo trunca
}

// ===== Contexto por SECCIONES (integridad: nunca se edita el archivo entero) =====
// El CLAUDE.md se corta en fragmentos por encabezados markdown (# a ###); la
// UI edita UN fragmento por vez y el guardado lo empalma en el archivo real.
// Un descuido (select-all + borrar en el celular) arruina como mucho UNA
// sección, nunca el documento completo. El hash por sección detecta si el
// archivo cambió entre abrir y guardar (las sesiones de Claude Code editan
// CLAUDE.md en vivo) y rechaza el guardado con conflicto en vez de pisar.
export const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// Corta el texto en secciones: [preámbulo si hay contenido antes del primer
// encabezado] + una por cada línea `#`/`##`/`###` hasta el próximo encabezado.
// INVARIANTE de integridad: sections.map(s => s.text).join('\n') === texto
// original, byte a byte (split/join por '\n' es lossless).
export function splitContextSections(text) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const bounds = [];
  lines.forEach((l, i) => { if (/^#{1,3}\s/.test(l)) bounds.push(i); });
  const sections = [];
  const add = (from, to) => {
    const m = lines[from]?.match(/^(#{1,3})\s+(.*)$/);
    sections.push({
      title: m ? m[2].trim().slice(0, 120) : '(inicio del documento)',
      level: m ? m[1].length : 0,
      text: lines.slice(from, to).join('\n'),
    });
  };
  if (!bounds.length) add(0, lines.length);
  else {
    if (bounds[0] > 0) add(0, bounds[0]);
    for (let b = 0; b < bounds.length; b += 1) add(bounds[b], b + 1 < bounds.length ? bounds[b + 1] : lines.length);
  }
  return sections;
}

// Índice de secciones para la lista (sin el texto completo de cada una).
export function listSectionsOfFile(filePath) {
  const src = readTextFile(filePath);
  const sections = splitContextSections(src).map((s, i) => ({
    i,
    title: s.title,
    level: s.level,
    lines: s.text.split('\n').length,
    size: Buffer.byteLength(s.text),
    hash: hashOf(s.text),
  }));
  return { totalLines: src ? src.split('\n').length : 0, totalSize: Buffer.byteLength(src), sections };
}

export function readSectionOfFile(filePath, i) {
  const sections = splitContextSections(readTextFile(filePath));
  const idx = Number(i);
  const s = sections[idx];
  if (!Number.isInteger(idx) || !s) throw Object.assign(new Error('Sección inexistente.'), { badRequest: true });
  return { i: idx, title: s.title, text: s.text, hash: hashOf(s.text) };
}

// Empalma `content` en la sección i. `expectedHash` = hash del texto que el
// cliente ABRIÓ: si la sección ya no existe o cambió, error con .conflict
// (la ruta lo mapea a 409) — nunca se pisa una edición ajena a ciegas.
export function writeSectionOfFile(filePath, i, expectedHash, content) {
  const src = readTextFile(filePath);
  const sections = splitContextSections(src);
  const idx = Number(i);
  const s = sections[idx];
  if (!Number.isInteger(idx) || !s) {
    throw Object.assign(new Error('La sección ya no existe (el contenido cambió). Recargá la lista.'), { conflict: true });
  }
  if (hashOf(s.text) !== String(expectedHash || '')) {
    throw Object.assign(new Error('El contenido cambió desde que abriste esta sección (otra sesión lo editó). Recargá y reintentá.'), { conflict: true });
  }
  // Verificación defensiva del INVARIANTE documentado (CLAUDE.md): split/join
  // debe reconstruir el original byte a byte ANTES de mutar la sección editada.
  // Si no coincide, splitContextSections está roto y empalmar corrompería el
  // resto del archivo sin que nadie lo note: abortamos en vez de escribir.
  const roundTrip = sections.map((x) => x.text).join('\n');
  if (roundTrip !== src) {
    throw new Error('Integridad de secciones violada: splitContextSections no reconstruye el archivo original. Guardado abortado.');
  }
  s.text = String(content ?? '');
  const out = sections.map((x) => x.text).join('\n');
  if (Buffer.byteLength(out) > MAX_SIZE) throw Object.assign(new Error('El contenido quedaría demasiado grande.'), { badRequest: true });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, out, { mode: 0o644 });
}

export function listContextSections(projectDir) {
  return listSectionsOfFile(path.join(projectDir, 'CLAUDE.md'));
}

export function readContextSection(projectDir, i) {
  return readSectionOfFile(path.join(projectDir, 'CLAUDE.md'), i);
}

export function writeContextSection(projectDir, i, expectedHash, content) {
  return writeSectionOfFile(path.join(projectDir, 'CLAUDE.md'), i, expectedHash, content);
}

// Parsea "- [Título](archivo.md) — descripción" preservando el ORDEN del
// índice (Map conserva orden de inserción); una línea sin ese formato se ignora.
function parseIndex(indexText) {
  const map = new Map(); // file -> { title, description }
  const re = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—-]\s*)?(.*)$/gm;
  let m;
  while ((m = re.exec(indexText || ''))) {
    const [, title, file, description] = m;
    map.set(file.trim(), { title: title.trim(), description: (description || '').trim() });
  }
  return map;
}

function describeNote(memoryDir, file, meta, orphan) {
  let size = 0;
  let updatedAt = null;
  try {
    const st = fs.statSync(path.join(memoryDir, file));
    size = st.size;
    updatedAt = st.mtimeMs;
  } catch { /* noop */ }
  return {
    file,
    title: meta?.title || file.replace(/\.md$/, ''),
    description: meta?.description || '',
    orphan, // existe en disco pero MEMORY.md no lo referencia
    size,
    updatedAt,
  };
}

// Overview para la pestaña: el índice tal cual (para poder editarlo) + la
// lista de notas resuelta contra el disco, en el ORDEN del índice y con las
// huérfanas (en disco pero no listadas) al final.
export function listMemory(projectDir, userId) {
  const memoryDir = memoryDirFor(projectDir, userId);
  let indexText = '';
  let indexExists = false;
  try { indexText = fs.readFileSync(path.join(memoryDir, INDEX_FILE_NAME), 'utf8'); indexExists = true; }
  catch { /* todavía no hay memorias para este proyecto */ }

  const parsed = parseIndex(indexText);
  let onDisk = new Set();
  try { onDisk = new Set(fs.readdirSync(memoryDir).filter((f) => NOTE_RE.test(f) && f !== INDEX_FILE_NAME)); }
  catch { /* la carpeta de memoria todavía no existe */ }

  const files = [];
  for (const [file, meta] of parsed) {
    if (!onDisk.has(file)) continue; // el índice lo menciona pero el archivo no existe: se omite
    files.push(describeNote(memoryDir, file, meta, false));
    onDisk.delete(file);
  }
  for (const file of Array.from(onDisk).sort()) files.push(describeNote(memoryDir, file, null, true));

  return { indexExists, index: indexText, indexHash: hashOf(indexText), files };
}

export function readNote(projectDir, file, userId) {
  return fs.readFileSync(safeNotePath(projectDir, file, userId), 'utf8');
}

// Lectura tolerante para comparar contra `expectedHash`: una nota que todavía
// no existe en disco vale '' (mismo criterio que readContext), así el chequeo
// funciona igual para notas nuevas que para ediciones.
function readNoteSafe(projectDir, file, userId) {
  try { return fs.readFileSync(safeNotePath(projectDir, file, userId), 'utf8'); }
  catch { return ''; }
}

// `expectedHash` es OPCIONAL, mismo criterio que writeContext (ver comentario
// ahí): detecta que otra sesión (Claude Code escribiendo la nota "en vivo" a
// partir de feedback real, o un admin editándola en esta misma pantalla)
// cambió el archivo entre que se abrió y se guardó, y rechaza con .conflict
// en vez de pisar en silencio. Sin hash, guarda como siempre (compatibilidad
// con llamadores programáticos existentes).
export function writeNote(projectDir, file, text, expectedHash, userId) {
  const p = safeNotePath(projectDir, file, userId);
  const out = String(text ?? '');
  if (Buffer.byteLength(out) > MAX_SIZE) throw Object.assign(new Error('La nota es demasiado grande (máximo 400 KB). Nada se guardó.'), { badRequest: true });
  if (expectedHash) {
    const current = readNoteSafe(projectDir, file, userId);
    if (hashOf(current) !== String(expectedHash)) {
      throw Object.assign(new Error('La nota cambió desde que la abriste (otra sesión la editó). Recargá y reintentá.'), { conflict: true });
    }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, out, { mode: 0o644 }); // atómico (fix B5): nota de memoria FUERA de git → pérdida irrecuperable si se trunca
}

export function readIndex(projectDir, userId) {
  try { return fs.readFileSync(path.join(memoryDirFor(projectDir, userId), INDEX_FILE_NAME), 'utf8'); }
  catch { return ''; }
}

// `expectedHash` OPCIONAL, mismo patrón que writeContext/writeNote: MEMORY.md
// también lo escribe Claude Code en vivo a partir de feedback real de las
// conversaciones, así que un admin editando el índice acá puede pisarle esa
// escritura en silencio sin este chequeo.
export function writeIndex(projectDir, text, expectedHash, userId) {
  const dir = memoryDirFor(projectDir, userId);
  const out = String(text ?? '');
  if (Buffer.byteLength(out) > MAX_SIZE) throw Object.assign(new Error('El índice de memorias es demasiado grande (máximo 400 KB). Nada se guardó.'), { badRequest: true });
  if (expectedHash) {
    const current = readIndex(projectDir, userId);
    if (hashOf(current) !== String(expectedHash)) {
      throw Object.assign(new Error('El índice de memorias cambió desde que lo abriste (otra sesión lo editó). Recargá y reintentá.'), { conflict: true });
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, INDEX_FILE_NAME), out, { mode: 0o644 }); // atómico (fix B5): índice MEMORY.md fuera de git
}
