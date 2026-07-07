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
// OJO ORDEN: las rutas literales /plans y /activity se registran ANTES de la
// paramétrica /:id (que valida ^T\d+$) para que Express no las capture como id.
import express from 'express';
import {
  listTasks, createTask, updateTask, deleteTask, createFromAudio,
  listActivity, listPlans, createPlan, updatePlan, deletePlan,
} from './store.js';

const ID_RE = /^T\d+$/;
const PLAN_ID_RE = /^PLAN-\d+$/;

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

    r.post('/plans/:id', (req, res) => {
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json({ plan: updatePlan(id, req.body || {}) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Tareas (paramétricas al final) -----
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
