// modules/retro/index.js — MÓDULO MEJORA CONTINUA (ROAD-256). Registro de
// LECCIONES DE PROCESO destiladas al cerrar chats (runner desacoplado
// bin/cwc-retro-runner.js, ver shared.js). Este módulo LEE el store (Pad local,
// colección 'mejora-continua') + acciona: aprobar/descartar/eliminar
// (autenticado) y PROMOVER a un destino real (admin: escribe memorias/CLAUDE.md).
// El enrutamiento de la promoción vive en promote-shared.js (Fase 2+).
//
// HTTP (todo autenticado; PROMOVER requiere admin porque toca memorias/CLAUDE.md):
//   GET  /api/retro                 -> { lessons, counts }
//   GET  /api/retro/activity        -> { events }
//   GET  /api/retro/targets         -> { targets }   (destinos de promoción cableados)
//   GET  /api/retro/:id             -> { lesson }
//   POST /api/retro/:id/approve     -> { lesson }   (status 'aprobada')
//   POST /api/retro/:id/dismiss     -> { lesson }   (status 'descartada')
//   POST /api/retro/:id/promote {target?} -> { lesson }   (ADMIN; target ∈ memoria|claude-md)
//   POST /api/retro/:id/delete      -> { ok }
// OJO ORDEN: las literales /activity y /targets van ANTES de la paramétrica /:id.
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import { hardRulesText } from '../health/shared.js';
import {
  listLessons, getLesson, setStatus, deleteLesson, listActivity, markPromoted,
  mergeLessons, upsertLesson,
} from './store.js';
import { PROMOTE_TARGETS, TARGETS_NEED_DIR, promote, projectDirFor } from './promote-shared.js';
import {
  readCurationJob, writeCurationJob, isFreshRunning as isCurateRunning,
  jobResult as curationResult, spawnRetroCurateRunner,
} from './curate-shared.js';

function sendErr(res, e) {
  if (e?.badRequest) return res.status(400).json({ error: e.message });
  if (e?.notFound) return res.status(404).json({ error: e.message });
  if (e?.conflict) return res.status(409).json({ error: e.message });
  return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
}

export default {
  name: 'retro',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', async (req, res) => {
      try { res.json(await listLessons()); }
      catch (e) { sendErr(res, e); }
    });

    r.get('/activity', (req, res) => {
      try { res.json({ events: listActivity(Number(req.query.limit) || 40) }); }
      catch (e) { sendErr(res, e); }
    });

    r.get('/targets', (req, res) => {
      try { res.json({ targets: PROMOTE_TARGETS }); }
      catch (e) { sendErr(res, e); }
    });

    // ===== Curaduría IA (Fase 5): consume tokens, runner desacoplado =====
    r.post('/curate', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'La curaduría consume tokens (requiere administrador).' });
      try {
        if (isCurateRunning(readCurationJob())) return res.json({ status: 'running' });
        // Reserva SINCRÓNICA del lock (mismo tick que el check) para cerrar la
        // ventana TOCTOU: el `await listLessons()` (HTTP a Pad) de por medio
        // dejaba pasar a un 2º request que también veía "no corriendo" y
        // spawneaba una 2ª curaduría. Escribimos el job 'running' YA; recién
        // después traemos las lecciones y completamos el `context`.
        writeCurationJob({ status: 'running', startedAt: Date.now(), context: null, result: null, error: null });
        try {
          const { lessons } = await listLessons();
          const active = lessons.filter((l) => l.status !== 'descartada')
            .map((l) => ({ id: l.id, title: l.title, category: l.category, project: l.project, status: l.status, recurrence: l.recurrence, body: l.body }));
          if (active.length < 2) {
            writeCurationJob({ status: 'idle', startedAt: 0, context: null, result: null, error: null }); // liberar el lock reservado
            return res.status(400).json({ error: 'Hacen falta al menos 2 lecciones vigentes para curar.' });
          }
          writeCurationJob({ status: 'running', startedAt: Date.now(), context: { lessons: active, rules: hardRulesText() }, result: null, error: null });
          spawnRetroCurateRunner();
          res.json({ status: 'running' });
        } catch (inner) {
          // liberar el lock reservado para no bloquear el reintento
          try { writeCurationJob({ status: 'error', startedAt: Date.now(), context: null, result: null, error: String(inner?.message || inner).slice(0, 200) }); } catch { /* noop */ }
          throw inner;
        }
      } catch (e) { sendErr(res, e); }
    });

    r.get('/curation', (req, res) => {
      try { res.json(curationResult(readCurationJob())); }
      catch (e) { sendErr(res, e); }
    });

    r.post('/curate/apply', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const b = req.body || {};
        const action = String(b.action || '');
        if (action === 'merge') {
          return res.json({ lesson: await mergeLessons(String(b.keep || ''), Array.isArray(b.merge) ? b.merge : []) });
        }
        if (action === 'dismiss') {
          return res.json({ lesson: await setStatus(String(b.id || ''), 'descartada') });
        }
        if (action === 'consolidate') {
          const created = await upsertLesson({ title: b.title, category: b.category, lesson: b.lesson, observation: 'Consolidada por la curaduría IA', project: b.project || 'console', destination: 'registro' });
          for (const mid of (Array.isArray(b.ids) ? b.ids : [])) {
            if (mid === created.lesson.id) continue; // si el dedup reusó una fuente, NO borres la consolidada (bug de pérdida de datos)
            try { await deleteLesson(mid); } catch { /* noop */ }
          }
          return res.json({ lesson: created.lesson });
        }
        return res.status(400).json({ error: 'Acción de curaduría inválida.' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/:id', async (req, res) => {
      try { res.json({ lesson: await getLesson(req.params.id) }); }
      catch (e) { sendErr(res, e); }
    });

    r.post('/:id/approve', async (req, res) => {
      try { res.json({ lesson: await setStatus(req.params.id, 'aprobada') }); }
      catch (e) { sendErr(res, e); }
    });

    r.post('/:id/dismiss', async (req, res) => {
      try { res.json({ lesson: await setStatus(req.params.id, 'descartada') }); }
      catch (e) { sendErr(res, e); }
    });

    // Volver una lección (guardada/descartada) al estado 'propuesta'.
    r.post('/:id/reopen', async (req, res) => {
      try { res.json({ lesson: await setStatus(req.params.id, 'propuesta') }); }
      catch (e) { sendErr(res, e); }
    });

    r.post('/:id/promote', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Promover requiere administrador.' });
      try {
        const l = await getLesson(req.params.id);
        const asked = String(req.body?.target || '').trim();
        // target explícito si es válido; si no, el destino sugerido si está
        // cableado; si no, memoria (el más inocuo).
        const target = PROMOTE_TARGETS.includes(asked)
          ? asked
          : (PROMOTE_TARGETS.includes(l.destination) ? l.destination : 'memoria');
        // Solo memoria/claude-md escriben al filesystem del proyecto → exigen dir.
        if (TARGETS_NEED_DIR.includes(target) && !projectDirFor(l.project)) {
          return res.status(400).json({ error: `El proyecto "${l.project}" no admite promoción a ${target} (solo console/tolkien). Reasigná el proyecto o probá otro destino.` });
        }
        // Marcar primero (snapshot Fase 6) → así claude-md la incluye al render.
        // Si escribir el destino falla DESPUÉS de marcar, revertimos el status
        // para no dejarla 'promovida' sin haberla escrito (y que se pueda reintentar).
        const marked = await markPromoted(l.id, target);
        try {
          await promote(marked.project, target, marked, { kind: String(req.body?.kind || 'work') });
        } catch (err) {
          try { await setStatus(l.id, l.status); } catch { /* best-effort */ }
          throw err;
        }
        res.json({ lesson: marked });
      } catch (e) { sendErr(res, e); }
    });

    r.post('/:id/delete', async (req, res) => {
      try { res.json(await deleteLesson(req.params.id)); }
      catch (e) { sendErr(res, e); }
    });

    router.use('/retro', r);
  },
};
