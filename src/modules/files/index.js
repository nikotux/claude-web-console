// modules/files/index.js — módulo de archivos (árbol, visor Y gestor completo).
//
// Interfaz estándar de módulo. Rutas HTTP (todas validan contra el root del request).
// El prefijo virtual @chats resuelve exclusivamente la carpeta de adjuntos del
// dueño autenticado, fuera del workspace de los inquilinos:
//   GET  /api/files/list?path=&hidden=      -> entradas (con mtime); carpetas:
//                                               childCount: 0..200|null,
//                                               childCountCapped: boolean|null
//   GET  /api/files/read?path=              -> contenido de texto (visor)
//   GET  /api/files/download?path=          -> descarga un archivo
//   GET  /api/files/download-zip?path=      -> descarga una carpeta como .zip
//   POST /api/files/upload?path=            -> sube archivos (multipart)
//   POST /api/files/mkdir     { path, name }
//   POST /api/files/rename    { path, newName }
//   POST /api/files/trash     { path }       -> mueve a la papelera
//   GET  /api/files/trash                    -> lista la papelera
//   POST /api/files/trash/restore { id }
//   POST /api/files/trash/purge   { id? }
import express from 'express';
import multer from 'multer';
// Archiver v8 es ESM y expone clases nombradas, sin default export.
import { ZipArchive } from 'archiver';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { isAdmin, principalOf } from '../../core/auth.js';
import { config } from '../../core/config.js';
import { resolveWithinRoot } from '../../core/paths.js';
import {
  moveToTrash, listTrash, restoreFromTrash, purgeTrash, autoPurge, TRASH_DIRNAME,
} from '../../core/trash.js';
import { userDataDir, userFileRoot, hostUser } from '../../core/user-space.js';

const CHATS_PREFIX = '@chats';
const ALWAYS_HIDDEN = new Set(['node_modules', '.git', 'dist', TRASH_DIRNAME]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_ZIP_ITEMS = 1000;
const MAX_ZIP_ENTRIES = 20000;
const MAX_DIR_CHILD_COUNT = 200;
const DIR_COUNT_CONCURRENCY = 16;

// Deriva el status HTTP de una excepción NO anticipada dentro de un catch
// genérico (invariante 34): solo cae a 4xx si el error trae una marca
// explícita (.badRequest / .conflict); cualquier otra cosa (EACCES, ENOSPC,
// EMFILE, fallas de disco, etc.) es un error interno genuino y debe ser 500,
// igual que /raw, /download, /download-zip y /zip en este mismo archivo.
function statusForError(e) {
  if (e && e.badRequest) return 400;
  if (e && e.conflict) return 409;
  return 500;
}

// /raw sirve archivos subidos por cualquier usuario autenticado (ver /upload).
// Si dejáramos que Content-Type se derive de la extensión (comportamiento por
// defecto de sendFile), un .html/.svg malicioso se ejecutaría EN EL MISMO
// ORIGEN que la consola al "previsualizarlo". Por eso acá se restringe a una
// allowlist de MIME seguros para renderizar inline; todo lo demás se sirve
// como texto plano (si no es binario) o se fuerza la descarga.
const SAFE_INLINE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};
// Contenido activo: nunca se sirve con su tipo real ni "inline"; siempre
// descarga forzada, sin importar el sniffing de contenido.
const ACTIVE_CONTENT_EXT = new Set(['.html', '.htm', '.xhtml', '.xht', '.shtml', '.svg', '.svgz', '.mhtml', '.xml']);

// Sanea el nombre para uso dentro del header Content-Disposition (evita que
// comillas o CR/LF rompan/inyecten en el header).
function safeAttachmentName(name) {
  const n = String(name || '').replace(/["\r\n]/g, '_');
  return n || 'file';
}

// Dueño de archivos resuelto una sola vez por request. Solo el token maestro
// representa explícitamente al host sin username; cualquier principal degradado
// falla cerrado en el middleware del módulo.
const REQUEST_OWNER = Symbol('filesOwner');
function resolveReqOwner(req) {
  const principal = principalOf(req);
  if (principal?.username) return principal.username;
  if (principal?.type === 'token') return hostUser();
  return null;
}

function reqOwner(req) {
  return req[REQUEST_OWNER] || null;
}

function reqFileRoot(req) {
  return userFileRoot(reqOwner(req));
}

// Resuelve una ruta visible del Explorador contra el root que le corresponde.
// @chats nunca abre el data-dir completo: expone únicamente chat-attachments
// del dueño autenticado. La validación lexical sigue delegada al helper común.
export function resolveFilePath(owner, rel = '') {
  const clean = String(rel).replace(/^[/\\]+/, '');
  const virtual = clean === CHATS_PREFIX || clean.startsWith(`${CHATS_PREFIX}/`);
  if (!virtual) {
    const root = userFileRoot(owner);
    return { root, abs: resolveWithinRoot(root, clean), virtual: false };
  }
  const root = path.join(userDataDir(owner), 'chat-attachments');
  const rest = clean === CHATS_PREFIX ? '' : clean.slice(CHATS_PREFIX.length + 1);
  return { root, abs: resolveWithinRoot(root, rest), virtual: true };
}

function resolveReqPath(req, rel = '') {
  return resolveFilePath(reqOwner(req), rel);
}

function clientRel({ root, abs, virtual }) {
  const rel = path.relative(root, abs);
  if (!virtual) return rel;
  return rel ? `${CHATS_PREFIX}/${rel.split(path.sep).join('/')}` : CHATS_PREFIX;
}

// La resolución contra root valida la ruta SOLO como string (no resuelve
// symlinks): un symlink dentro del root que apunte AFUERA pasaba la validación
// y statSync (que SÍ sigue symlinks) servía el contenido externo (hallazgo de
// salud 2026-07-04). Este helper cierra el escape: fs.realpathSync resuelve
// TODOS los symlinks (incluso en directorios intermedios) y se exige que la
// ruta REAL siga cayendo dentro del root REAL antes de servir/descargar/archivar.
// Devuelve el stat (siguiendo el symlink, ya validado) o null si escapa;
// propaga el throw (ENOENT) si la ruta no existe — mismo contrato que statSync.
// Cache del realpath por root (evita un realpathSync por request para el mismo root).
const rootRealCache = new Map();
const ROOT_REAL_CACHE_MAX = 200; // defensivo: acotado por cantidad real de usuarios, pero con tope explícito
function rootReal(root) {
  let r = rootRealCache.get(root);
  if (!r) {
    r = fss.realpathSync(root);
    if (rootRealCache.size >= ROOT_REAL_CACHE_MAX) {
      const oldest = rootRealCache.keys().next().value;
      if (oldest !== undefined) rootRealCache.delete(oldest);
    }
    rootRealCache.set(root, r);
  }
  return r;
}
// Igual que antes pero contra el ROOT del usuario (no el home global): resuelve
// TODOS los symlinks y exige que la ruta REAL caiga dentro del root REAL. Cierra
// el escape por symlink hacia AFUERA del espacio del usuario. root default =
// config.home (retrocompat para cualquier llamada interna sin req).
function statSafeSync(abs, root = config.home) {
  const real = fss.realpathSync(abs); // ENOENT si no existe
  const relFromRoot = path.relative(rootReal(root), real);
  if (relFromRoot === '..' || relFromRoot.startsWith('..' + path.sep) || path.isAbsolute(relFromRoot)) return null;
  return fss.statSync(abs);
}

// Nombre de archivo/carpeta seguro (sin separadores ni traversal).
function safeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length > 255 || n.includes('/') || n.includes('\\') || n === '.' || n === '..') return null;
  return n;
}

// Nombre único en `dir` (agrega " (n)" antes de la extensión si ya existe).
function uniqueName(dir, name) {
  if (!fss.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  let cand;
  do { cand = `${base} (${i})${ext}`; i += 1; } while (fss.existsSync(path.join(dir, cand)));
  return cand;
}

// Nombre único dentro de un set en memoria (mismo esquema que uniqueName,
// pero contra nombres ya usados en la selección en vez del filesystem).
function uniqueZipName(usedNames, name) {
  if (!usedNames.has(name)) return name;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  let cand;
  do { cand = `${base} (${i})${ext}`; i += 1; } while (usedNames.has(cand));
  return cand;
}

// Cuenta hijos directos sin materializar el directorio completo. Se lee una
// entrada adicional para distinguir "exactamente 200" de "más de 200".
// Un error queda confinado a esa carpeta; null significa conteo desconocido.
async function countDirChildren(abs) {
  let dir;
  try {
    dir = await fs.opendir(abs);
    let childCount = 0;
    while (await dir.read()) {
      if (childCount === MAX_DIR_CHILD_COUNT) {
        return { childCount, childCountCapped: true };
      }
      childCount += 1;
    }
    return { childCount, childCountCapped: false };
  } catch {
    return { childCount: null, childCountCapped: null };
  } finally {
    try { await dir?.close(); } catch { /* noop */ }
  }
}

async function listDir(abs, showHidden) {
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    const name = d.name;
    if (ALWAYS_HIDDEN.has(name)) continue;
    if (!showHidden && name.startsWith('.')) continue;

    const symlink = d.isSymbolicLink();
    let type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
    let size = null;
    let mtimeMs = 0;
    if (symlink) {
      // Symlink: resolver el target y usar SU stat tanto para el type como
      // para size/mtimeMs, para que ambos sean consistentes entre sí.
      try {
        const st = await fs.stat(path.join(abs, name));
        type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        mtimeMs = st.mtimeMs;
        if (type === 'file') size = st.size;
      } catch {
        // Target roto/inaccesible: al menos reportar el mtime del propio enlace.
        type = 'other';
        try {
          const lst = await fs.lstat(path.join(abs, name));
          mtimeMs = lst.mtimeMs;
        } catch { /* noop */ }
      }
    } else {
      try {
        const st = await fs.lstat(path.join(abs, name));
        mtimeMs = st.mtimeMs;
        if (type === 'file') size = st.size;
      } catch { /* noop */ }
    }
    const entry = { name, type, size, mtimeMs, symlink };
    if (type === 'dir') {
      Object.assign(entry, { childCount: null, childCountCapped: null });
    }
    entries.push(entry);
  }
  const dirsToCount = entries.filter((entry) => entry.type === 'dir' && !entry.symlink);
  let nextDir = 0;
  async function countNextDir() {
    while (nextDir < dirsToCount.length) {
      const entry = dirsToCount[nextDir];
      nextDir += 1;
      Object.assign(entry, await countDirChildren(path.join(abs, entry.name)));
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(DIR_COUNT_CONCURRENCY, dirsToCount.length) },
    () => countNextDir(),
  ));
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
  return entries;
}

// Subida: destino = ?path (carpeta validada); nombre saneado y único.
// Error de VALIDACIÓN (destino inválido, etc.): marcado para que /upload lo
// mapee a 400 vía statusForError, distinguiéndolo de una falla interna de disco
// (ENOSPC/EACCES/EMFILE) que debe caer a 500 (invariantes 34/38/39/41).
const badReq = (m) => Object.assign(new Error(m), { badRequest: true });

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const { root, abs: dir } = resolveReqPath(req, req.query.path || '');
      if (!dir) return cb(badReq('Ruta inválida'));
      // Igual que mkdir/rename/trash: statSafeSync valida que la carpeta REAL
      // (symlinks resueltos) siga dentro del root — statSync crudo seguía un
      // symlink hacia afuera y multer ESCRIBÍA fuera del root (hallazgo de
      // salud 2026-07-05, mismo vector ya cerrado en /list, /raw, /download).
      let st;
      try { st = statSafeSync(dir, root); }
      catch { return cb(badReq('El destino no existe')); }
      if (!st) return cb(badReq('Ruta inválida'));
      if (!st.isDirectory()) return cb(badReq('El destino no es una carpeta'));
      cb(null, dir);
    },
    filename(req, file, cb) {
      const { abs: dir } = resolveReqPath(req, req.query.path || '');
      if (!dir) return cb(badReq('Ruta inválida'));
      const raw = path.basename(file.originalname).replace(/[/\\]/g, '_') || 'archivo';
      cb(null, uniqueName(dir, raw));
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GiB por archivo
});

export default {
  name: 'files',

  init() {
    // Al iniciar solo se hace higiene de la papelera del host; cada papelera
    // de inquilino también se depura al listarse.
    try {
      const n = autoPurge(config.home);
      if (n > 0) console.log(`[files] Papelera: purgados ${n} ítem(s) vencido(s).`);
    } catch (e) {
      console.error('[files] No se pudo depurar la papelera al iniciar:', e);
    }
  },

  registerHttp(router) {
    const r = express.Router();

    r.use((req, res, next) => {
      const owner = resolveReqOwner(req);
      if (!owner) return res.status(401).json({ error: 'No autorizado.' });
      req[REQUEST_OWNER] = owner;
      next();
    });

    r.get('/list', async (req, res) => {
      const resolved = resolveReqPath(req, req.query.path || '');
      const { root, abs } = resolved;
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      const showHidden = req.query.hidden === '1';
      try {
        // statSafeSync (no lstat crudo): lstat resuelve los symlinks INTERMEDIOS
        // de la ruta, así que un symlink del root hacia afuera permitía listar
        // directorios externos (hallazgo de salud 2026-07-05). Mismo patrón que
        // /raw y /download.
        let st;
        try { st = statSafeSync(abs, root); }
        catch { return res.status(404).json({ error: 'No se pudo listar el directorio.' }); }
        if (!st) return res.status(400).json({ error: 'Ruta inválida.' });
        if (!st.isDirectory()) return res.status(400).json({ error: 'No es un directorio.' });
        res.json({ path: clientRel(resolved), entries: await listDir(abs, showHidden) });
      } catch (e) {
        res.status(statusForError(e)).json({ error: 'No se pudo listar el directorio.' });
      }
    });

    r.get('/read', async (req, res) => {
      const resolved = resolveReqPath(req, req.query.path || '');
      const { root, abs } = resolved;
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      try {
        // Igual que en /list: statSafeSync cierra el escape por symlink
        // (evil → /etc ⇒ /read?path=evil/passwd servía /etc/passwd).
        let st;
        try { st = statSafeSync(abs, root); }
        catch { return res.status(404).json({ error: 'No se pudo leer el archivo.' }); }
        if (!st) return res.status(400).json({ error: 'Ruta inválida.' });
        if (!st.isFile()) return res.status(400).json({ error: 'No es un archivo.' });
        const meta = { path: clientRel(resolved), name: path.basename(abs), size: st.size };
        if (st.size > MAX_READ_BYTES) return res.json({ ...meta, tooLarge: true, content: '' });
        const buf = await fs.readFile(abs);
        if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return res.json({ ...meta, binary: true, content: '' });
        res.json({ ...meta, content: buf.toString('utf8') });
      } catch (e) {
        res.status(statusForError(e)).json({ error: 'No se pudo leer el archivo.' });
      }
    });

    // Sirve el archivo para previsualizar en el navegador — SOLO con un
    // Content-Type de una allowlist "segura" (imágenes/PDF) o como texto
    // plano; cualquier otra cosa (HTML/SVG/binarios desconocidos) se fuerza
    // como descarga (attachment) para que el navegador no la ejecute/renderice
    // en el mismo origen que la consola. Ver nota de seguridad más arriba.
    r.get('/raw', (req, res) => {
      const { root, abs } = resolveReqPath(req, req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      try {
        let st;
        try {
          st = statSafeSync(abs, root);
        } catch { return res.status(404).json({ error: 'No existe.' }); }
        if (!st) return res.status(400).json({ error: 'Ruta inválida.' });
        if (!st.isFile()) return res.status(400).json({ error: 'No es un archivo.' });

        const ext = path.extname(abs).toLowerCase();
        const safeMime = SAFE_INLINE_MIME[ext];
        if (safeMime) {
          res.setHeader('Content-Type', safeMime);
          res.setHeader('Content-Disposition', 'inline');
        } else if (ACTIVE_CONTENT_EXT.has(ext)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${safeAttachmentName(path.basename(abs))}"`);
        } else {
          let looksText = false;
          try {
            const fd = fss.openSync(abs, 'r');
            try {
              const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size));
              fss.readSync(fd, buf, 0, buf.length, 0);
              looksText = !buf.includes(0);
            } finally { fss.closeSync(fd); }
          } catch { looksText = false; }
          if (looksText) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'inline');
          } else {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${safeAttachmentName(path.basename(abs))}"`);
          }
        }

        // dotfiles:'allow' — ver nota en chat/index.js: Express 5 rechaza por
        // defecto cualquier path que atraviese una carpeta oculta (.cwc-data,
        // .config, .claude…). El confinamiento real lo hace resolveWithinRoot.
        res.sendFile(abs, { dotfiles: 'allow' }, (err) => {
          if (err && !res.headersSent) res.status(500).json({ error: 'No se pudo servir el archivo.' });
        });
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'No se pudo servir el archivo.' });
      }
    });

    r.get('/download', (req, res) => {
      const { root, abs } = resolveReqPath(req, req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      try {
        let st;
        try { st = statSafeSync(abs, root); }
        catch { return res.status(404).json({ error: 'No existe.' }); }
        if (!st) return res.status(400).json({ error: 'Ruta inválida.' });
        if (!st.isFile()) return res.status(400).json({ error: 'No es un archivo (usá zip para carpetas).' });
        res.download(abs, path.basename(abs), { dotfiles: 'allow' }, (err) => {
          if (err && !res.headersSent) res.status(500).json({ error: 'No se pudo descargar el archivo.' });
        });
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'No se pudo descargar el archivo.' });
      }
    });

    r.get('/download-zip', (req, res) => {
      const { root, abs } = resolveReqPath(req, req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      try {
        let st;
        try { st = statSafeSync(abs, root); } catch { return res.status(404).json({ error: 'No existe.' }); }
        if (!st) return res.status(400).json({ error: 'Ruta inválida.' });
        if (!st.isDirectory()) return res.status(400).json({ error: 'No es una carpeta.' });
        const name = path.basename(abs) || 'home';
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${safeAttachmentName(name)}.zip"`);
        const archive = new ZipArchive({ zlib: { level: 6 } });
        let entryCount = 0;
        let entryLimitExceeded = false;
        archive.on('error', () => {
          try {
            if (!res.headersSent) {
              res.removeHeader('Content-Type');
              res.removeHeader('Content-Disposition');
              return res.status(500).json({ error: 'No se pudo generar el zip.' });
            }
            res.destroy();
          } catch { /* noop */ }
        });
        archive.on('entry', () => {
          entryCount += 1;
          if (entryCount > MAX_ZIP_ENTRIES && !entryLimitExceeded) {
            entryLimitExceeded = true;
            const err = new Error(`El zip excede el máximo de ${MAX_ZIP_ENTRIES} entradas.`);
            console.error('[files] Zip de carpeta abortado:', err.message);
            archive.abort();
            archive.emit('error', err);
          }
        });
        res.on('close', () => {
          if (!res.writableFinished) archive.abort();
        });
        archive.pipe(res);
        archive.glob('**/*', {
          cwd: abs, dot: true, follow: false,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', `**/${TRASH_DIRNAME}/**`],
        }, { prefix: name });
        archive.finalize();
      } catch {
        if (!res.headersSent) {
          res.removeHeader('Content-Type');
          res.removeHeader('Content-Disposition');
          res.status(500).json({ error: 'No se pudo generar el zip.' });
        }
      }
    });

    // Zip de varios ítems (descarga de selección múltiple).
    r.post('/zip', (req, res) => {
      const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
      if (!paths.length) return res.status(400).json({ error: 'Sin selección.' });
      if (paths.length > MAX_ZIP_ITEMS) return res.status(400).json({ error: `Demasiados ítems (máx. ${MAX_ZIP_ITEMS}).` });
      try {
        const items = [];
        const usedNames = new Set();
        let selectionRoot = null;
        for (const rel of paths) {
          const { root, abs } = resolveReqPath(req, rel);
          if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
          if (selectionRoot !== null && root !== selectionRoot) {
            return res.status(400).json({ error: 'No se pueden mezclar carpetas del chat con otras ubicaciones.' });
          }
          selectionRoot = root;
          try {
            const st = statSafeSync(abs, root);
            if (!st) return res.status(400).json({ error: 'Ruta inválida.' });
            const isDir = st.isDirectory();
            const name = uniqueZipName(usedNames, path.basename(abs));
            usedNames.add(name);
            items.push({ abs, name, isDir });
          } catch { /* omitimos los que no existan */ }
        }
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="archivos.zip"');
        const archive = new ZipArchive({ zlib: { level: 6 } });
        archive.on('error', () => {
          try {
            if (!res.headersSent) return res.status(500).json({ error: 'No se pudo generar el zip.' });
            res.destroy();
          } catch { /* noop */ }
        });
        res.on('close', () => {
          if (!res.writableFinished) archive.abort();
        });
        archive.pipe(res);
        const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', `**/${TRASH_DIRNAME}/**`];
        for (const it of items) {
          if (it.isDir) archive.glob('**/*', { cwd: it.abs, dot: true, follow: false, ignore }, { prefix: it.name });
          else archive.file(it.abs, { name: it.name });
        }
        archive.finalize();
      } catch {
        if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el zip.' });
      }
    });

    r.post('/upload', (req, res) => {
      upload.array('files', 100)(req, res, (err) => {
        if (err) {
          // Validación (marcada badReq) y límites de multer (LIMIT_*) → 400;
          // una falla interna de disco (ENOSPC/EACCES/EMFILE al escribir) → 500,
          // igual que mkdir/rename/trash usan statusForError.
          const expected = err instanceof multer.MulterError || err?.badRequest;
          const status = (err instanceof multer.MulterError) ? 400 : statusForError(err);
          if (!expected) console.error('[files] Error interno durante upload:', err);
          return res.status(status).json({
            error: expected ? err.message : 'No se pudieron subir los archivos.',
          });
        }
        res.json({ ok: true, count: req.files?.length || 0, names: (req.files || []).map((f) => f.filename) });
      });
    });

    r.post('/mkdir', (req, res) => {
      const { root, abs: parent } = resolveReqPath(req, req.body?.path || '');
      const n = safeName(req.body?.name);
      if (!parent) return res.status(400).json({ error: 'Ruta inválida.' });
      if (!n) return res.status(400).json({ error: 'Nombre inválido.' });
      // Igual que en /raw y /download: la resolución solo valida el string,
      // así que confirmamos que la carpeta padre REAL (symlinks resueltos)
      // sigue dentro del root antes de crear nada ahí.
      let pst;
      try { pst = statSafeSync(parent, root); } catch { return res.status(400).json({ error: 'La carpeta no existe.' }); }
      if (!pst || !pst.isDirectory()) return res.status(400).json({ error: 'Ruta inválida.' });
      try { fss.mkdirSync(path.join(parent, n)); res.json({ ok: true }); }
      catch (e) {
        if (e.code === 'EEXIST') return res.status(409).json({ error: 'Ya existe una carpeta con ese nombre.' });
        res.status(statusForError(e)).json({ error: 'No se pudo crear.' });
      }
    });

    r.post('/rename', (req, res) => {
      const resolved = resolveReqPath(req, req.body?.path || '');
      const { root, abs } = resolved;
      const n = safeName(req.body?.newName);
      if (!abs || path.resolve(abs) === root) return res.status(400).json({ error: 'Ruta inválida.' });
      if (!n) return res.status(400).json({ error: 'Nombre inválido.' });
      // Defensa contra symlink de escape: la carpeta contenedora REAL debe
      // seguir dentro del root antes de tocar la entrada de directorio.
      let pst;
      try { pst = statSafeSync(path.dirname(abs), root); } catch { return res.status(400).json({ error: 'Ruta inválida.' }); }
      if (!pst) return res.status(400).json({ error: 'Ruta inválida.' });
      const target = path.join(path.dirname(abs), n);
      if (fss.existsSync(target)) return res.status(409).json({ error: 'Ya existe un ítem con ese nombre.' });
      try {
        // TOCTOU: entre el existsSync y el rename otro request pudo crear
        // `target`. renameSync en POSIX PISA silenciosamente un archivo de
        // destino (no lanza EEXIST). Para un archivo regular usamos link+unlink:
        // linkSync falla con EEXIST de forma ATÓMICA si el destino ya existe.
        // Mismo directorio ⇒ mismo filesystem (nunca EXDEV). Para directorios/
        // symlinks (no hardlinkeables) cae a renameSync, que sobre un dir de
        // destino no vacío falla con ENOTEMPTY (no hay pérdida silenciosa).
        let st;
        try { st = fss.lstatSync(abs); } catch { return res.status(404).json({ error: 'El ítem ya no existe.' }); }
        if (st.isFile()) {
          fss.linkSync(abs, target);
          try {
            fss.unlinkSync(abs);
          } catch (unlinkErr) {
            // El link se creó pero no pudimos borrar el original: sin rollback,
            // el archivo queda DUPLICADO (target + abs apuntando al mismo inode)
            // y encima se reporta error. Deshacemos el link; si eso también
            // falla, avisamos explícito del duplicado en vez de un error genérico.
            let rolledBack = true;
            try { fss.unlinkSync(target); } catch { rolledBack = false; }
            return res.status(statusForError(unlinkErr)).json({
              error: rolledBack
                ? 'No se pudo renombrar (no se pudo quitar el original; se revirtió el cambio).'
                : 'No se pudo renombrar: el archivo pudo quedar DUPLICADO (falló también la reversión). Revisalo a mano.',
            });
          }
        } else {
          // Re-chequeo INMEDIATO antes del rename, para achicar al máximo la
          // ventana TOCTOU: a diferencia del caso archivo (linkSync+EEXIST es
          // atómico), un directorio DESTINO VACÍO no tiene equivalente atómico
          // en POSIX — rename() lo reemplaza en silencio en vez de fallar con
          // ENOTEMPTY. No cierra la ventana del todo, pero la reduce al mínimo
          // posible entre este chequeo síncrono y la syscall siguiente.
          if (fss.existsSync(target)) return res.status(409).json({ error: 'Ya existe un ítem con ese nombre.' });
          fss.renameSync(abs, target);
        }
        res.json({ ok: true, path: clientRel({ ...resolved, abs: target }) });
      } catch (e) {
        // Misma condición de carrera (destino ya existe) que /mkdir → mismo 409.
        if (e.code === 'EEXIST') return res.status(409).json({ error: 'Ya existe un ítem con ese nombre.' });
        res.status(statusForError(e)).json({ error: 'No se pudo renombrar.' });
      }
    });

    // --- Papelera ---
    r.post('/trash', (req, res) => {
      const rel = req.body?.path || '';
      const { root, abs, virtual } = resolveReqPath(req, rel);
      if (virtual) {
        return res.status(400).json({ error: 'La papelera no está disponible en la carpeta del chat.' });
      }
      if (!abs || path.resolve(abs) === root) return res.status(400).json({ error: 'Ruta inválida.' });
      // Misma defensa: la carpeta contenedora REAL debe seguir dentro del root
      // antes de mover la entrada (si no, un symlink intermedio podría hacer
      // que se mueva contenido externo hacia adentro del root).
      let pst;
      try { pst = statSafeSync(path.dirname(abs), root); }
      catch (e) {
        if (e.code === 'ENOENT') return res.status(404).json({ error: 'El ítem ya no existe.' });
        return res.status(400).json({ error: 'Ruta inválida.' });
      }
      if (!pst) return res.status(400).json({ error: 'Ruta inválida.' });
      try { res.json({ ok: true, id: moveToTrash(root, abs, rel, reqOwner(req)) }); }
      catch (e) {
        if (e.code === 'ENOENT') return res.status(404).json({ error: 'El ítem ya no existe.' });
        res.status(statusForError(e)).json({ error: 'No se pudo mover a la papelera.' });
      }
    });

    r.get('/trash', (req, res) => {
      try {
        res.json({
          items: listTrash(reqFileRoot(req), { owner: reqOwner(req), all: isAdmin(req) }),
        });
      }
      catch { res.status(500).json({ error: 'No se pudo leer la papelera.' }); }
    });

    r.post('/trash/restore', (req, res) => {
      try {
        if (resolveReqPath(req, req.body?.path || '').virtual) {
          return res.status(400).json({ error: 'La papelera no está disponible en la carpeta del chat.' });
        }
        const root = reqFileRoot(req);
        const owner = reqOwner(req);
        // Defensa contra symlink de escape: a diferencia de mkdir/rename/trash
        // (que validan la carpeta contenedora REAL antes de mutar), restoreFromTrash
        // hacía mkdirSync+renameSync directo sobre un target derivado de
        // una resolución de string (validación de string, no de symlinks). Si el
        // `originalRel` guardado pasó a apuntar dentro de un symlink hacia
        // afuera del root entre el trash y el restore, la restauración movería
        // contenido fuera del root. Igual que statSafeSync: subimos hasta el
        // ancestro existente más cercano de la carpeta destino y confirmamos
        // que su ruta REAL sigue dentro del root real antes de crear/mover nada.
        const finalRel = restoreFromTrash(root, req.body?.id, (containerDir) => {
          let cur = containerDir;
          while (!fss.existsSync(cur)) {
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
          }
          const real = fss.realpathSync(cur);
          const relFromRoot = path.relative(rootReal(root), real);
          if (relFromRoot === '..' || relFromRoot.startsWith('..' + path.sep) || path.isAbsolute(relFromRoot)) {
            const err = new Error('La carpeta destino escapa del root.');
            err.badRequest = true;
            throw err;
          }
        }, { owner, all: isAdmin(req) });
        if (finalRel == null) return res.status(404).json({ error: 'No está en la papelera.' });
        res.json({ ok: true, path: finalRel });
      } catch (e) {
        if (e && e.badRequest) return res.status(400).json({ error: 'Ruta de destino inválida.' });
        // mkdir/rename fallaron ANTES de tocar el índice: el ítem sigue en la
        // papelera, consistente — solo informamos que la restauración falló.
        res.status(500).json({ error: 'No se pudo restaurar (permisos o destino inaccesible). El ítem sigue en la papelera.' });
      }
    });

    r.post('/trash/purge', (req, res) => {
      try {
        // OJO: `id || null` coercionaba un id falsy explícito ('' , 0) a null,
        // que significa "purgar TODA la papelera". Distinguimos la AUSENCIA de
        // la clave (purgar todo, intencional) de un id presente pero inválido
        // (error del caller → 400, nunca un purge total silencioso).
        const body = req.body || {};
        const root = reqFileRoot(req);
        const access = { owner: reqOwner(req), all: isAdmin(req) };
        if ('id' in body) {
          const id = body.id;
          if (typeof id !== 'string' || !id) {
            return res.status(400).json({ error: 'id inválido.' });
          }
          purgeTrash(root, id, access);
        } else {
          purgeTrash(root, null, access); // sin id: purga todo lo autorizado
        }
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo purgar la papelera.' });
      }
    });

    router.use('/files', r);
  },
};
