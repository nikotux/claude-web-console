// modules/projects/index.js — contexto (CLAUDE.md) y memorias editables de
// los proyectos con los que trabaja Claude Code desde acá: el proyecto
// trackeado (Tolkien) Y esta propia consola. Alimenta la pestaña "Proyectos"
// del menú Sistema.
//
// PROJECTS es la única lista de proyectos soportados — agregar uno nuevo es
// sumar una entrada acá (clave estable, no expone rutas crudas del cliente).
//
// HTTP (patrón admin-gating igual al contexto editable de bugfixes: GET
// abierto a cualquier autenticado, POST admin):
//   GET  /api/projects                                -> [{key, name, dir}]
//   GET  /api/projects/:key/context                   -> { content } (CLAUDE.md real)
//   POST /api/projects/:key/context {content}         -> guarda (admin)
//   GET  /api/projects/:key/memory                     -> { indexExists, index, files[] }
//   GET  /api/projects/:key/memory/index               -> { content } (MEMORY.md crudo)
//   POST /api/projects/:key/memory/index {content}      -> guarda el índice (admin)
//   GET  /api/projects/:key/memory/note/:file           -> { file, content }
//   POST /api/projects/:key/memory/note/:file {content} -> guarda la nota (admin)
//
// Nota (regla 4 de CLAUDE.md): esto SÍ toca archivos fuera del propio módulo
// (CLAUDE.md y las memorias de Tolkien Y de esta consola) — es el propósito
// explícito de esta pantalla, no un efecto colateral. Ver excepción
// documentada en CLAUDE.md.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import {
  readContext, writeContext, listMemory, readNote, writeNote, readIndex, writeIndex,
} from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(__dirname, '..', '..', '..'); // raíz de este mismo repo

const displayName = (n) => (n ? n[0].toUpperCase() + n.slice(1) : 'Tolkien');

const PROJECTS = {
  tolkien: { name: displayName(config.projectName), dir: config.projectDir },
  console: { name: 'Consola (este proyecto)', dir: CONSOLE_DIR },
};

function project(req, res) {
  const p = PROJECTS[req.params.key];
  if (!p) { res.status(404).json({ error: `Proyecto desconocido: ${req.params.key}` }); return null; }
  return p;
}

export default {
  name: 'projects',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      res.json(Object.entries(PROJECTS).map(([key, p]) => ({ key, name: p.name, dir: p.dir })));
    });

    // ===== Contexto (CLAUDE.md) =====
    r.get('/:key/context', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json({ content: readContext(p.dir) }); }
      catch { res.status(500).json({ error: 'No se pudo leer el contexto.' }); }
    });

    r.post('/:key/context', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        writeContext(p.dir, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo guardar el contexto.' });
      }
    });

    // ===== Memorias (MEMORY.md + notas individuales) =====
    r.get('/:key/memory', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json(listMemory(p.dir)); }
      catch { res.status(500).json({ error: 'No se pudo leer la memoria.' }); }
    });

    r.get('/:key/memory/index', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json({ content: readIndex(p.dir) }); }
      catch { res.status(500).json({ error: 'No se pudo leer el índice.' }); }
    });

    r.post('/:key/memory/index', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        writeIndex(p.dir, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'No se pudo guardar el índice.' });
      }
    });

    r.get('/:key/memory/note/:file', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json({ file: req.params.file, content: readNote(p.dir, req.params.file) }); }
      catch (e) { res.status(400).json({ error: e.message || 'No se pudo leer la nota.' }); }
    });

    r.post('/:key/memory/note/:file', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        writeNote(p.dir, req.params.file, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message || 'No se pudo guardar la nota.' });
      }
    });

    router.use('/projects', r);
  },
};
