// modules/tasks/index.js — Tareas pendientes PRIVADAS de este proyecto +
// PLANES + LOG de actividad (dashboard estilo Pad, datos 100% locales).
//
// Tablero simplificado estilo "Bugs & Features" pero más liviano y personal:
// una tarjeta = una tarea; los PLANES la agrupan con progreso %. Se alimenta
// MANUAL y desde el módulo `audio`.
//
// FUENTE DE VERDAD: Pad LOCAL (colecciones `pendientes`/`planes`, ver store.js
// para el detalle completo de la migración 2026-07-12, ROAD-110/TASK-123). El
// LOG de actividad sigue local (~/.cwc-data/tasks-activity.json). El CRUD ahora
// es ASYNC (llamadas HTTP al Pad local) — no necesita runner desacoplado: no
// hay corrida en background atada al proceso, cada request espera su propia
// respuesta de Pad y responde. Si Pad local está caído, las rutas responden
// 500 con un mensaje claro (nunca cuelgan ni tiran una excepción sin control).
//
// HTTP (todo autenticado; sin admin: es un bloc privado del dueño):
//   GET  /api/tasks                  -> { tasks, counts, plans }
//   GET  /api/tasks/counts           -> { counts }         (liviano, sin blocks[]; lo usa el poll de 20s)
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
// OJO ORDEN: las rutas literales /plans, /counts, /activity, /analyze y
// /analysis se registran ANTES de la paramétrica /:id (que valida ^PEND-\d+$) para que Express
// no las capture como id.
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import { reqPadContext } from '../../core/pad-context.js';
import {
  listTasks, listCounts, createTask, updateTask, deleteTask, createFromAudio,
  listActivity, listPlans, createPlan, updatePlan, deletePlan,
  addComment, deleteComment, timelineFor, linksFor,
} from './store.js';
import {
  normScope, buildContext, readAnalysisJob, writeAnalysisJob,
  isFreshRunning, jobResult, spawnTasksAnalyzeRunner,
} from './analyze-shared.js';

// Refs REALES de Pad (ver store.js): las tareas son ítems de la colección
// `pendientes` (prefix PEND, ej. "PEND-42") — YA NO "T<n>". Los comentarios
// tienen id UUID real de Pad (ej. "ce1e8917-fe53-477e-acb0-376f09420f4f") — YA
// NO el formato viejo "C<timestamp>-<contador>". CRÍTICO: sin este cambio TODAS
// las rutas de tarea/comentario responden 400 con datos reales (verificado
// contra el server real durante la migración 2026-07-12).
const ID_RE = /^PEND-\d+$/;
const PLAN_ID_RE = /^PLAN-\d+$/;
const CID_RE = /^[0-9a-fA-F-]{8,64}$/;

export default {
  name: 'tasks',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', async (req, res) => {
      const ctx = reqPadContext(req);
      try { res.json(await listTasks(ctx)); }
      catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) || 'No se pudieron leer las tareas.' }); }
    });

    // Solo los conteos por estado (sin blocks[] de cada tarea/plan) — lo único
    // que necesita el poll de 20s del sidebar (loadCounts() en tasks.js); pegar
    // contra GET / entero pagaba el fan-out completo de listLinks() en CADA
    // tick, para siempre, agotando el rate limiter de Pad local (bug real
    // 2026-07-12, ver el comentario de listCounts() en store.js).
    r.get('/counts', async (req, res) => {
      const ctx = reqPadContext(req);
      try { res.json(await listCounts(ctx)); }
      catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) || 'No se pudieron leer los conteos.' }); }
    });

    r.get('/activity', (req, res) => {
      try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
        res.json({ events: listActivity(limit) });
      } catch { res.status(500).json({ error: 'No se pudo leer la actividad.' }); }
    });

    r.get('/plans', async (req, res) => {
      const ctx = reqPadContext(req);
      try { res.json({ plans: await listPlans(ctx) }); }
      catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) || 'No se pudieron leer los planes.' }); }
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
    r.post('/analyze', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador (consume tokens).' });
      try {
        const scope = normScope(req.body?.scope);
        const existing = readAnalysisJob(scope);
        if (existing && isFreshRunning(existing)) {
          return res.json({ scope, ...jobResult(existing) });
        }
        // Reserva SINCRÓNICA del lock (mismo tick que el check) ANTES del
        // `await buildContext` — ese await abría la ventana TOCTOU para que un
        // 2º POST del mismo scope también viera "no corriendo" y spawneara un
        // 2º runner que pisa el job (BUG-9). Se libera si no hay datos o si falla.
        writeAnalysisJob(scope, {
          scope, status: 'running', result: null, error: null,
          startedAt: Date.now(), updatedAt: Date.now(),
        });
        try {
          const built = await buildContext(scope);
          if (!built) {
            writeAnalysisJob(scope, { scope, status: 'idle', result: null, error: null, startedAt: 0, updatedAt: Date.now() });
            return res.status(400).json({ error: scope === 'plans' ? 'No hay planes para analizar.' : 'No hay tareas para analizar.' });
          }
          spawnTasksAnalyzeRunner(scope);
          res.json({ scope, status: 'running', result: null, error: null });
        } catch (inner) {
          writeAnalysisJob(scope, { scope, status: 'error', result: null, error: String(inner?.message || inner).slice(0, 200), startedAt: Date.now(), updatedAt: Date.now() });
          throw inner;
        }
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/', async (req, res) => {
      const ctx = reqPadContext(req);
      try {
        const b = req.body || {};
        if (!String(b.title || '').trim()) return res.status(400).json({ error: 'La tarea necesita un título.' });
        res.json({ task: await createTask(b, ctx) });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/from-audio', async (req, res) => {
      const ctx = reqPadContext(req);
      try {
        const jobId = String(req.body?.jobId || '').slice(0, 64) || null;
        const created = await createFromAudio(jobId, req.body?.tasks, ctx);
        res.json({ created });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Planes (rutas literales ANTES que la paramétrica /:id) -----
    r.post('/plans', async (req, res) => {
      const ctx = reqPadContext(req);
      try {
        const b = req.body || {};
        if (!String(b.title || '').trim()) return res.status(400).json({ error: 'El plan necesita un título.' });
        res.json({ plan: await createPlan(b, ctx) });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/plans/:id/delete', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { await deletePlan(id, ctx); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.get('/plans/:id/timeline', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json(await timelineFor('plan', id, ctx)); }
      catch { res.status(500).json({ error: 'No se pudo leer el timeline.' }); }
    });

    r.get('/plans/:id/links', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json(await linksFor(id, ctx)); }
      catch { res.status(500).json({ error: 'No se pudieron leer los links.' }); }
    });

    r.post('/plans/:id/comment/:cid/delete', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id); const cid = String(req.params.cid);
      if (!PLAN_ID_RE.test(id) || !CID_RE.test(cid)) return res.status(400).json({ error: 'Id inválido.' });
      try { await deleteComment('plan', id, cid, ctx); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/plans/:id/comment', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json({ comment: await addComment('plan', id, req.body?.text, ctx) }); }
      catch (e) { res.status(e.notFound ? 404 : e.bad ? 400 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/plans/:id', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!PLAN_ID_RE.test(id)) return res.status(400).json({ error: 'Id de plan inválido.' });
      try { res.json({ plan: await updatePlan(id, req.body || {}, ctx) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Tareas (paramétricas al final) -----
    r.get('/:id/timeline', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { res.json(await timelineFor('task', id, ctx)); }
      catch { res.status(500).json({ error: 'No se pudo leer el timeline.' }); }
    });

    r.get('/:id/links', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { res.json(await linksFor(id, ctx)); }
      catch { res.status(500).json({ error: 'No se pudieron leer los links.' }); }
    });

    r.post('/:id/comment/:cid/delete', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id); const cid = String(req.params.cid);
      if (!ID_RE.test(id) || !CID_RE.test(cid)) return res.status(400).json({ error: 'Id inválido.' });
      try { await deleteComment('task', id, cid, ctx); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/:id/comment', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { res.json({ comment: await addComment('task', id, req.body?.text, ctx) }); }
      catch (e) { res.status(e.notFound ? 404 : e.bad ? 400 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/:id/delete', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { await deleteTask(id, ctx); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/:id', async (req, res) => {
      const ctx = reqPadContext(req);
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tarea inválido.' });
      try { res.json({ task: await updateTask(id, req.body || {}, ctx) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    router.use('/tasks', r);
  },
};
