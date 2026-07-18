// modules/projects/index.js — contexto (CLAUDE.md) y memorias editables de
// los proyectos con los que trabaja Claude Code desde acá: el proyecto
// trackeado (Tolkien) Y esta propia consola. Alimenta la pestaña "Proyectos"
// del menú Sistema.
//
// Los proyectos visibles se resuelven por request según el principal:
// host/admin ve los repos reales; cada inquilino ve su workspace y, si existe,
// su clon aislado de Tolkien.
//
// HTTP: GET abierto a cualquier autenticado según proyectos visibles; POST
// permitido a admin o self-edit del espacio propio del inquilino:
//   GET  /api/projects                                -> [{key, name, dir}]
//   GET  /api/projects/:key/context                   -> { content } (CLAUDE.md real)
//   POST /api/projects/:key/context {content}         -> guarda
//   GET  /api/projects/:key/memory                     -> { indexExists, index, files[] }
//   GET  /api/projects/:key/memory/index               -> { content } (MEMORY.md crudo)
//   POST /api/projects/:key/memory/index {content}      -> guarda el índice
//   GET  /api/projects/:key/memory/note/:file           -> { file, content }
//   POST /api/projects/:key/memory/note/:file {content} -> guarda la nota
//
// Nota (regla 4 de CLAUDE.md): esto SÍ toca archivos fuera del propio módulo
// (CLAUDE.md y las memorias de Tolkien Y de esta consola) — es el propósito
// explícito de esta pantalla, no un efecto colateral. Ver excepción
// documentada en CLAUDE.md.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { isAdmin, principalOf } from '../../core/auth.js';
import { userWorkspace, hostUser } from '../../core/user-space.js';
import {
  readContext, writeContext, listMemory, readNote, writeNote, readIndex, writeIndex,
  listContextSections, readContextSection, writeContextSection, hashOf,
} from './memory.js';
import {
  analyzeJobId, readAnalyzeJob, writeAnalyzeJob, spawnAnalyzeRunner, jobResult, isFreshRunning,
} from './analyze-shared.js';
import { mountPersonalization } from './personalization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(__dirname, '..', '..', '..'); // raíz de este mismo repo

const displayName = (n) => (n ? n[0].toUpperCase() + n.slice(1) : 'Tolkien');

// Resuelve el set de proyectos visible para un principal (role-aware).
// admin/host -> repos reales (Mi Consola + Tolkien). inquilino -> "Mi espacio"
// (su workspace) + su clon de Tolkien SOLO si existe (aislamiento: nunca el
// Tolkien del host). Cada entrada lleva `userId` (dueño, para scopear memorias)
// y `own` (true = espacio propio del inquilino -> self-edit permitido).
function projectsFor(principal) {
  const username = principal?.username || null;
  const admin = !!principal?.admin;
  if (admin || !username) {
    // host/admin (incl. principal por token): comportamiento actual intacto.
    const host = hostUser();
    return {
      tolkien: { name: displayName(config.projectName), dir: config.projectDir, userId: host, own: false },
      console: { name: 'Mi Consola', dir: CONSOLE_DIR, userId: host, own: false },
    };
  }
  const out = {
    'mi-espacio': { name: 'Mi espacio', dir: userWorkspace(username), userId: username, own: true },
  };
  const tolkienClone = path.join(userWorkspace(username), 'tolkien');
  try { if (fs.existsSync(tolkienClone)) out.tolkien = { name: displayName(config.projectName), dir: tolkienClone, userId: username, own: true }; }
  catch { /* sin clon: se omite (aislamiento) */ }
  return out;
}

function project(req, res) {
  const set = projectsFor(principalOf(req));
  const key = req.params.key;
  const p = Object.prototype.hasOwnProperty.call(set, key) ? set[key] : null;
  if (!p) { res.status(404).json({ error: `Proyecto desconocido: ${key}` }); return null; }
  return { key, ...p };
}

// Escritura permitida si es admin (repos compartidos console/tolkien del host)
// o si el proyecto es el espacio PROPIO del inquilino (self-edit; userId saneado).
function canWrite(req, p) {
  if (isAdmin(req)) return true;
  const pr = principalOf(req);
  return !!(p.own && pr && pr.username && pr.username === p.userId);
}

// ===== Análisis con IA de un cambio de contexto (guardián del CLAUDE.md) =====
// Compara la sección ANTERIOR vs la NUEVA con una corrida corta del SDK
// (haiku, 1 turno, CERO herramientas). DESACOPLADO (regla de oro 2026-07-04):
// la corrida NO vive en el handler Express — el POST persiste el job en
// ~/.cwc-data/projects-analyze/<id>.json y spawnea
// bin/cwc-projects-analyze-runner.js detached; el front encuesta el GET (solo
// lee disco, 0 tokens). Un reinicio del server (deploy) a mitad del análisis
// ya no lo pierde: el runner sobrevive y el resultado queda persistido.
// Prompt/parseo/persistencia compartidos con el runner en ./analyze-shared.js.

export default {
  name: 'projects',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      try {
        const set = projectsFor(principalOf(req));
        res.json(Object.entries(set).map(([key, p]) => ({ key, name: p.name, dir: p.dir })));
      } catch {
        res.status(500).json({ error: 'No se pudo listar los proyectos.' });
      }
    });

    mountPersonalization(r);

    // ===== Contexto (CLAUDE.md) =====
    r.get('/:key/context', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { const content = readContext(p.dir); res.json({ content, hash: hashOf(content) }); }
      catch { res.status(500).json({ error: 'No se pudo leer el contexto.' }); }
    });

    // `hash` es OPCIONAL en el body: si el cliente lo manda (el que abrió el
    // archivo vía el GET de arriba), se rechaza con 409 si CLAUDE.md cambió
    // en el medio (misma protección que el guardado por secciones, invariante
    // #2 — ver comentario en memory.js:writeContext). Sin hash, guarda como
    // siempre (compatibilidad con llamadores programáticos existentes).
    r.post('/:key/context', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!canWrite(req, p)) return res.status(403).json({ error: 'No autorizado para editar este proyecto.' });
      try {
        writeContext(p.dir, String(req.body?.content ?? ''), req.body?.hash);
        res.json({ ok: true });
      } catch (e) {
        res.status(e.conflict ? 409 : (e.badRequest ? 400 : 500)).json({ error: e.message || 'No se pudo guardar el contexto.' });
      }
    });

    // ===== Contexto por SECCIONES (la UI edita fragmentos, nunca el archivo
    // entero — integridad: un descuido arruina UNA sección como mucho) =====
    r.get('/:key/context/sections', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json(listContextSections(p.dir)); }
      catch { res.status(500).json({ error: 'No se pudo leer el contexto.' }); }
    });

    r.get('/:key/context/section/:i', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json(readContextSection(p.dir, req.params.i)); }
      catch (e) { res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo leer la sección.' }); }
    });

    r.post('/:key/context/section/:i', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!canWrite(req, p)) return res.status(403).json({ error: 'No autorizado para editar este proyecto.' });
      try {
        writeContextSection(p.dir, req.params.i, req.body?.hash, String(req.body?.content ?? ''));
        res.json({ ok: true });
      } catch (e) {
        res.status(e.conflict ? 409 : (e.badRequest ? 400 : 500)).json({ error: e.message || 'No se pudo guardar la sección.' });
      }
    });

    // Analiza con IA el cambio propuesto sobre una sección ANTES de guardar
    // (admin: consume tokens). Valida el hash primero: si la sección ya
    // cambió, 409 sin gastar tokens. NO escribe la sección. Responde INMEDIATO
    // (patrón triage/health/desk-live): persiste el job + spawnea el runner
    // detached y devuelve {id, status:'running'}; el front encuesta el GET de
    // abajo. Id determinístico por (proyecto, sección, hash, contenido): un
    // reintento del POST (doble click, re-engancharse tras un deploy) reusa el
    // MISMO job en vez de spawnear otro runner y gastar tokens de nuevo.
    r.post('/:key/context/section/:i/analyze', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!canWrite(req, p)) return res.status(403).json({ error: 'No autorizado para editar este proyecto.' });
      try {
        const sec = readContextSection(p.dir, req.params.i);
        if (sec.hash !== String(req.body?.hash || '')) {
          return res.status(409).json({ error: 'El contexto cambió desde que abriste esta sección. Recargá y reintentá.' });
        }
        const after = String(req.body?.content ?? '');
        const id = analyzeJobId(req.params.key, req.params.i, sec.hash, after);
        const job = readAnalyzeJob(id);
        if (job && (isFreshRunning(job) || job.status === 'done')) {
          return res.json({ ok: true, id, ...jobResult(job) });
        }
        writeAnalyzeJob(id, {
          status: 'running', key: req.params.key, section: String(req.params.i),
          before: sec.text, after, startedAt: Date.now(), updatedAt: Date.now(),
        });
        spawnAnalyzeRunner(id);
        res.json({ ok: true, id, status: 'running', analysis: null, error: null });
      } catch (e) {
        res.status(e.badRequest ? 400 : (e.conflict ? 409 : 500)).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    // Estado/resultado del análisis: SOLO lee el disco (0 tokens). Sobrevive a
    // un reinicio del server porque el job y el runner viven fuera del proceso;
    // si el runner murió sin escribir (kill/OOM), jobResult lo reporta como
    // error pasado el corte de staleness — el front nunca queda colgado.
    r.get('/:key/context/section/:i/analyze/:id', (req, res) => {
      try {
        const p = project(req, res); if (!p) return;
        if (!/^[0-9a-f]{24}$/.test(String(req.params.id))) {
          return res.status(400).json({ error: 'Id de análisis inválido.' });
        }
        const job = readAnalyzeJob(req.params.id);
        if (!job) return res.status(404).json({ error: 'Análisis inexistente (¿expiró?).' });
        res.json({ ok: true, id: req.params.id, ...jobResult(job) });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    // ===== Memorias (MEMORY.md + notas individuales) =====
    r.get('/:key/memory', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { res.json(listMemory(p.dir, p.userId)); }
      catch { res.status(500).json({ error: 'No se pudo leer la memoria.' }); }
    });

    r.get('/:key/memory/index', (req, res) => {
      const p = project(req, res); if (!p) return;
      try { const content = readIndex(p.dir, p.userId); res.json({ content, hash: hashOf(content) }); }
      catch { res.status(500).json({ error: 'No se pudo leer el índice.' }); }
    });

    // `hash` OPCIONAL en el body (mismo patrón que POST /:key/context): si el
    // cliente lo manda (lo leyó del GET de arriba o de listMemory), se rechaza
    // con 409 si MEMORY.md cambió en el medio — misma protección contra
    // ediciones concurrentes de sesiones de Claude Code (ver memory.js:writeIndex).
    r.post('/:key/memory/index', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!canWrite(req, p)) return res.status(403).json({ error: 'No autorizado para editar este proyecto.' });
      try {
        writeIndex(p.dir, String(req.body?.content ?? ''), req.body?.hash, p.userId);
        res.json({ ok: true });
      } catch (e) {
        res.status(e.conflict ? 409 : (e.badRequest ? 400 : 500)).json({ error: e.message || 'No se pudo guardar el índice.' });
      }
    });

    r.get('/:key/memory/note/:file', (req, res) => {
      const p = project(req, res); if (!p) return;
      try {
        const content = readNote(p.dir, req.params.file, p.userId);
        res.json({ file: req.params.file, content, hash: hashOf(content) });
      } catch (e) { res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'No se pudo leer la nota.' }); }
    });

    // `hash` OPCIONAL en el body, mismo patrón que el índice de arriba: detecta
    // si la nota cambió entre que se abrió (GET de arriba) y se guardó (ver
    // memory.js:writeNote).
    r.post('/:key/memory/note/:file', (req, res) => {
      const p = project(req, res); if (!p) return;
      if (!canWrite(req, p)) return res.status(403).json({ error: 'No autorizado para editar este proyecto.' });
      try {
        writeNote(p.dir, req.params.file, String(req.body?.content ?? ''), req.body?.hash, p.userId);
        res.json({ ok: true });
      } catch (e) {
        res.status(e.conflict ? 409 : (e.badRequest ? 400 : 500)).json({ error: e.message || 'No se pudo guardar la nota.' });
      }
    });

    router.use('/projects', r);
  },
};
