// modules/tasks/index.js — Tareas pendientes PRIVADAS de este proyecto +
// PLANES + LOG de actividad (dashboard estilo Pad, datos 100% locales).
//
// Tablero simplificado estilo "Bugs & Features" pero más liviano y personal:
// una tarjeta = una tarea; los PLANES la agrupan con progreso %. Se alimenta
// MANUAL y desde el módulo `audio`.
//
// El CRUD es determinístico y síncrono (store.js, ~/.cwc-data/tasks.json +
// tasks-activity.json) → NO necesita runner desacoplado: no hay corrida en el
// tiempo atada al proceso. Sobrevive reinicios por su estado en disco.
//
// HTTP (todo autenticado; sin admin: es un bloc privado del dueño):
//   GET  /api/tasks                  -> { tasks, counts, plans }
//   GET  /api/tasks/activity         -> { events }        (log real, panel)
//   GET  /api/tasks/plans            -> { plans }          (con progreso)
//   POST /api/tasks                  -> { task }           (crear)
//   POST /api/tasks/from-audio       -> { created }        (alta en lote)
//   POST /api/tasks/plans            -> { plan }           (crear plan)
//   POST /api/tasks/plans/:id        -> { plan }           (editar plan)
//   POST /api/tasks/plans/:id/delete -> { ok }
//   POST /api/tasks/:id              -> { task }           (editar tarea)
//   POST /api/tasks/:id/delete       -> { ok }
//   POST /api/tasks/analyze          -> { scope, status }  (admin: consume tokens)
//   GET  /api/tasks/analysis         -> { scope, status, result, ... } (lee disco)
// OJO ORDEN: las rutas literales /plans, /activity, /analyze y /analysis se
// registran ANTES de la paramétrica /:id (que valida ^T\d+$) para que Express no
// las capture como id.
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import {
  listTasks, createTask, updateTask, deleteTask, createFromAudio,
  listActivity, listPlans, createPlan, updatePlan, deletePlan,
  addComment, deleteComment, timelineFor,
} from './store.js';
import {
  normScope, buildContext, readAnalysisJob, writeAnalysisJob,
  isFreshRunning, jobResult, spawnTasksAnalyzeRunner,
} from './analyze-shared.js';

const ID_RE = /^T\d+$/;
const PLAN_ID_RE = /^PLAN-\d+$/;
const CID_RE = /^C[0-9]+-[0-9]+$/;

export default {
  name: 'tasks',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      try { res.json(listTasks()); }
      catch { res.status(500).json({ error: 'No se pudieron leer las tareas.' }); }
    });

    r.get('/activity', (req, res) => {
      try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
        res.json({ events: listActivity(limit) });
      } catch { res.status(500).json({ error: 'No se pudo leer la actividad.' }); }
    });

    r.get('/plans', (req, res) => {
      try { res.json({ plans: listPlans() }); }
      catch { res.status(500).json({ error: 'No se pudieron leer los planes.' }); }
    });

    // ANÁLISIS GENERAL IA (dup/unificar/completar). Lee disco, 0 tokens.
    r.get('/analysis', (req, res) => {
      try {
        const scope = normScope(req.query.scope);
        const job = readAnalysisJob(scope);
        res.json({ scope, ...jobResult(job), updatedAt: job?.updatedAt || 0 });
      } catch { res.status(500).json({ error: 'No se pudo leer el análisis.' }); }
    });

    // Lanza el análisis: persiste el job + spawnea el runner detached, responde
    // YA. Admin porque consume tokens. Dedup por alcance (no relanza si hay una
    // corrida fresca).
    r.post('/analyze', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador (consume tokens).' });
      try {
        const scope = normScope(req.body?.scope);
        const existing = readAnalysisJob(scope);
        if (existing && isFreshRunning(existing)) {
          return res.json({ scope, ...jobResult(existing) });
        }
        const built = buildContext(scope);
        if (!built) return res.status(400).json({ error: scope === 'plans' ? 'No hay planes para analizar.' : 'No hay tareas para analizar.' });
        writeAnalysisJob(scope, {
          scope, status: 'running', result: null, error: null,
          startedAt: Date.now(), updatedAt: Date.now(),
        });
        spawnTasksAnalyzeRunner(scope);
        res.json({ scope, status: 'running', result: null, error: null });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/', (req, res) => {
      try {
        const b = req.body || {};
        if (!String(b.title || '').trim()) return res.status(400).json({ error: 'La tarea necesita un título.' });
        res.json({ task: createTask(b) });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/from-audio', (req, res) => {
      try {
        const jobId = String(req.body?.jobId || '').slice(0, 64) || null;
        const created = createFromAudio(jobId, req.body?.tasks);
        res.json({ created });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Planes (rutas literales ANTES que la paramétrica /:id) -----
    r.post('/plans', (req, res) => {
      try {
        const b = req.body || {};
        if (!String(b.title || '').trim()) return res.status(400).json({ error: 'El plan necesita un título.' });
        res.json({ plan: createPlan(b) });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/plans/:id/delete', (req, res) => {
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { deletePlan(id); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.get('/plans/:id/timeline', (req, res) => {
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json(timelineFor('plan', id)); }
      catch { res.status(500).json({ error: 'No se pudo leer el timeline.' }); }
    });

    r.post('/plans/:id/comment/:cid/delete', (req, res) => {
      const id = String(req.params.id); const cid = String(req.params.cid);
      if (!PLAN_ID_RE.test(id) || !CID_RE.test(cid)) return res.status(400).json({ error: 'Id inválido.' });
      try { deleteComment('plan', id, cid); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/plans/:id/comment', (req, res) => {
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json({ comment: addComment('plan', id, req.body?.text) }); }
      catch (e) { res.status(e.notFound ? 404 : e.bad ? 400 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/plans/:id', (req, res) => {
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json({ plan: updatePlan(id, req.body || {}) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Tareas (paramétricas al final) -----
    r.get('/:id/timeline', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { res.json(timelineFor('task', id)); }
      catch { res.status(500).json({ error: 'No se pudo leer el timeline.' }); }
    });

    r.post('/:id/comment/:cid/delete', (req, res) => {
      const id = String(req.params.id); const cid = String(req.params.cid);
      if (!ID_RE.test(id) || !CID_RE.test(cid)) return res.status(400).json({ error: 'Id inválido.' });
      try { deleteComment('task', id, cid); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/:id/comment', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { res.json({ comment: addComment('task', id, req.body?.text) }); }
      catch (e) { res.status(e.notFound ? 404 : e.bad ? 400 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/:id/delete', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { deleteTask(id); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/:id', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { res.json({ task: updateTask(id, req.body || {}) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    router.use('/tasks', r);
  },
};
