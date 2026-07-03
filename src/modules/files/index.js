// modules/files/index.js — módulo de archivos (árbol, visor Y gestor completo).
//
// Interfaz estándar de módulo. Rutas HTTP (todas validan contra el home):
//   GET  /api/files/list?path=&hidden=      -> entradas (con mtime)
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
import archiver from 'archiver';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { resolveWithinHome } from '../../core/paths.js';
import {
  moveToTrash, listTrash, restoreFromTrash, purgeTrash, autoPurge, TRASH_DIRNAME,
} from '../../core/trash.js';

const ALWAYS_HIDDEN = new Set(['node_modules', '.git', 'dist', TRASH_DIRNAME]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

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

async function listDir(abs, showHidden) {
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    const name = d.name;
    if (ALWAYS_HIDDEN.has(name)) continue;
    if (!showHidden && name.startsWith('.')) continue;

    const symlink = d.isSymbolicLink();
    let type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
    if (symlink) {
      try {
        const st = await fs.stat(path.join(abs, name));
        type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      } catch { type = 'other'; }
    }
    let size = null;
    let mtimeMs = 0;
    try {
      const st = await fs.lstat(path.join(abs, name));
      mtimeMs = st.mtimeMs;
      if (type === 'file') size = st.size;
    } catch { /* noop */ }
    entries.push({ name, type, size, mtimeMs, symlink });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
  return entries;
}

// Subida: destino = ?path (carpeta validada); nombre saneado y único.
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = resolveWithinHome(req.query.path || '');
      if (!dir) return cb(new Error('Ruta inválida'));
      try { if (!fss.statSync(dir).isDirectory()) return cb(new Error('El destino no es una carpeta')); }
      catch { return cb(new Error('El destino no existe')); }
      cb(null, dir);
    },
    filename(req, file, cb) {
      const dir = resolveWithinHome(req.query.path || '') || config.home;
      const raw = path.basename(file.originalname).replace(/[/\\]/g, '_') || 'archivo';
      cb(null, uniqueName(dir, raw));
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GiB por archivo
});

export default {
  name: 'files',

  init() {
    const n = autoPurge();
    if (n > 0) console.log(`[files] Papelera: purgados ${n} ítem(s) vencido(s).`);
  },

  registerHttp(router) {
    const r = express.Router();

    r.get('/list', async (req, res) => {
      const abs = resolveWithinHome(req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      const showHidden = req.query.hidden === '1';
      try {
        const st = await fs.lstat(abs);
        if (!st.isDirectory()) return res.status(400).json({ error: 'No es un directorio.' });
        res.json({ path: path.relative(config.home, abs), entries: await listDir(abs, showHidden) });
      } catch {
        res.status(404).json({ error: 'No se pudo listar el directorio.' });
      }
    });

    r.get('/read', async (req, res) => {
      const abs = resolveWithinHome(req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      try {
        const st = await fs.lstat(abs);
        if (!st.isFile()) return res.status(400).json({ error: 'No es un archivo.' });
        const meta = { path: path.relative(config.home, abs), name: path.basename(abs), size: st.size };
        if (st.size > MAX_READ_BYTES) return res.json({ ...meta, tooLarge: true, content: '' });
        const buf = await fs.readFile(abs);
        if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return res.json({ ...meta, binary: true, content: '' });
        res.json({ ...meta, content: buf.toString('utf8') });
      } catch {
        res.status(404).json({ error: 'No se pudo leer el archivo.' });
      }
    });

    // Sirve el archivo INLINE (para previsualizar en el navegador).
    r.get('/raw', (req, res) => {
      const abs = resolveWithinHome(req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      try { if (!fss.statSync(abs).isFile()) return res.status(400).json({ error: 'No es un archivo.' }); }
      catch { return res.status(404).json({ error: 'No existe.' }); }
      res.sendFile(abs);
    });

    r.get('/download', (req, res) => {
      const abs = resolveWithinHome(req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      try { if (!fss.statSync(abs).isFile()) return res.status(400).json({ error: 'No es un archivo (usá zip para carpetas).' }); }
      catch { return res.status(404).json({ error: 'No existe.' }); }
      res.download(abs, path.basename(abs));
    });

    r.get('/download-zip', (req, res) => {
      const abs = resolveWithinHome(req.query.path || '');
      if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
      let st;
      try { st = fss.statSync(abs); } catch { return res.status(404).json({ error: 'No existe.' }); }
      if (!st.isDirectory()) return res.status(400).json({ error: 'No es una carpeta.' });
      const name = path.basename(abs) || 'home';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
      archive.pipe(res);
      archive.glob('**/*', {
        cwd: abs, dot: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', `**/${TRASH_DIRNAME}/**`],
      }, { prefix: name });
      archive.finalize();
    });

    // Zip de varios ítems (descarga de selección múltiple).
    r.post('/zip', (req, res) => {
      const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
      if (!paths.length) return res.status(400).json({ error: 'Sin selección.' });
      const items = [];
      for (const rel of paths) {
        const abs = resolveWithinHome(rel);
        if (!abs) return res.status(400).json({ error: 'Ruta inválida.' });
        try { items.push({ abs, name: path.basename(abs), isDir: fss.statSync(abs).isDirectory() }); }
        catch { /* omitimos los que no existan */ }
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="archivos.zip"');
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
      archive.pipe(res);
      const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', `**/${TRASH_DIRNAME}/**`];
      for (const it of items) {
        if (it.isDir) archive.glob('**/*', { cwd: it.abs, dot: true, ignore }, { prefix: it.name });
        else archive.file(it.abs, { name: it.name });
      }
      archive.finalize();
    });

    r.post('/upload', (req, res) => {
      upload.array('files', 100)(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ ok: true, count: req.files?.length || 0, names: (req.files || []).map((f) => f.filename) });
      });
    });

    r.post('/mkdir', (req, res) => {
      const parent = resolveWithinHome(req.body?.path || '');
      const n = safeName(req.body?.name);
      if (!parent) return res.status(400).json({ error: 'Ruta inválida.' });
      if (!n) return res.status(400).json({ error: 'Nombre inválido.' });
      try { fss.mkdirSync(path.join(parent, n)); res.json({ ok: true }); }
      catch (e) { res.status(400).json({ error: e.code === 'EEXIST' ? 'Ya existe una carpeta con ese nombre.' : 'No se pudo crear.' }); }
    });

    r.post('/rename', (req, res) => {
      const abs = resolveWithinHome(req.body?.path || '');
      const n = safeName(req.body?.newName);
      if (!abs || path.resolve(abs) === config.home) return res.status(400).json({ error: 'Ruta inválida.' });
      if (!n) return res.status(400).json({ error: 'Nombre inválido.' });
      const target = path.join(path.dirname(abs), n);
      if (fss.existsSync(target)) return res.status(400).json({ error: 'Ya existe un ítem con ese nombre.' });
      try { fss.renameSync(abs, target); res.json({ ok: true, path: path.relative(config.home, target) }); }
      catch { res.status(400).json({ error: 'No se pudo renombrar.' }); }
    });

    // --- Papelera ---
    r.post('/trash', (req, res) => {
      const rel = req.body?.path || '';
      const abs = resolveWithinHome(rel);
      if (!abs || path.resolve(abs) === config.home) return res.status(400).json({ error: 'Ruta inválida.' });
      try { res.json({ ok: true, id: moveToTrash(abs, rel) }); }
      catch { res.status(400).json({ error: 'No se pudo mover a la papelera.' }); }
    });

    r.get('/trash', (req, res) => res.json({ items: listTrash() }));

    r.post('/trash/restore', (req, res) => {
      try {
        const finalRel = restoreFromTrash(req.body?.id, resolveWithinHome);
        if (finalRel == null) return res.status(404).json({ error: 'No está en la papelera.' });
        res.json({ ok: true, path: finalRel });
      } catch {
        // mkdir/rename fallaron ANTES de tocar el índice: el ítem sigue en la
        // papelera, consistente — solo informamos que la restauración falló.
        res.status(500).json({ error: 'No se pudo restaurar (permisos o destino inaccesible). El ítem sigue en la papelera.' });
      }
    });

    r.post('/trash/purge', (req, res) => {
      purgeTrash(req.body?.id || null);
      res.json({ ok: true });
    });

    router.use('/files', r);
  },
};
