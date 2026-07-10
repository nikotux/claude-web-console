// modules/learning/index.js — MÓDULO DE APRENDIZAJE: temas que el dueño va
// aprendiendo/reforzando (instrucciones de Chris, cómo funciona el backend,
// GetPad, GitHub, cómo proponer un fix). Pestaña "🎓 Aprendizaje" del Banco de
// conocimiento.
//
// El CRUD es determinístico y síncrono (store.js, ~/.cwc-data/learning.json) →
// NO necesita runner. La ÚNICA parte que consume tokens es "Explicame esto": una
// corrida IA read-only que NAVEGA el código real y AUTO-GUARDA una explicación
// guiada en el tema → va DESACOPLADA a bin/cwc-learning-explain-runner.js (regla
// de oro + regla 6, ver explain-shared.js).
//
// HTTP (todo autenticado; sin admin salvo lo que gasta tokens):
//   GET  /api/learning                          -> { topics, counts }
//   GET  /api/learning/activity                 -> { events }
//   GET  /api/learning/:id                      -> { topic } (+ explainCheck derivado)
//   POST /api/learning                          -> { topic }            (crear)
//   POST /api/learning/:id                      -> { topic }            (editar)
//   POST /api/learning/:id/delete               -> { ok }
//   POST /api/learning/:id/explain {force?}      -> { status, mode }    (admin: consume tokens,
//                                                                        salvo no-op sin cambios)
//   GET  /api/learning/:id/explain              -> { status, error, mode } (lee disco, 0 tokens)
//   POST /api/learning/:id/context              -> { topic }            (agregar nota manual)
//   POST /api/learning/:id/context/:cid         -> { topic }            (editar una entrada)
//   POST /api/learning/:id/context/:cid/delete  -> { topic }            (borrar una entrada)
//   POST /api/learning/:id/context-analyze      -> { status }           (admin: consume tokens)
//   GET  /api/learning/:id/context-analyze/:job -> { status, error }    (lee disco, 0 tokens)
// OJO ORDEN: la ruta literal /activity va ANTES de la paramétrica /:id (que valida
// ^LT\d+$) para que Express no la capture como id.
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import {
  listTopics, getTopic, createTopic, updateTopic, deleteTopic, listActivity,
  listRoutes, createRoute, updateRoute, deleteRoute,
  addContexto, updateContextoEntry, deleteContextoEntry, contextoText,
} from './store.js';
import {
  validId, readExplainJob, writeExplainJob, isFreshRunning, jobResult,
  spawnLearningExplainRunner, checkStaleness,
} from './explain-shared.js';
import {
  buildContext as buildAnalyzeContext, readAnalysisJob, writeAnalysisJob,
  isFreshRunning as isAnalyzeRunning, jobResult as analyzeResult,
  spawnLearningAnalyzeRunner,
} from './analyze-shared.js';
import {
  MAX_TRANSCRIPT, contextJobId, readContextJob, writeContextJob,
  isContextFreshRunning, contextJobResult, spawnLearningContextRunner,
} from './context-shared.js';

const ID_RE = /^LT\d+$/;
const ROUTE_RE = /^LR\d+$/;

export default {
  name: 'learning',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      try { res.json(listTopics()); }
      catch { res.status(500).json({ error: 'No se pudieron leer los temas.' }); }
    });

    r.get('/activity', (req, res) => {
      try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
        res.json({ events: listActivity(limit) });
      } catch { res.status(500).json({ error: 'No se pudo leer la actividad.' }); }
    });

    r.post('/', (req, res) => {
      try {
        const b = req.body || {};
        if (!String(b.title || '').trim()) return res.status(400).json({ error: 'El tema necesita un título.' });
        res.json({ topic: createTopic(b) });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Rutas de aprendizaje (literales ANTES que la paramétrica /:id) -----
    r.get('/routes', (req, res) => {
      try { res.json({ routes: listRoutes() }); }
      catch { res.status(500).json({ error: 'No se pudieron leer las rutas.' }); }
    });

    r.post('/routes', (req, res) => {
      try {
        const b = req.body || {};
        if (!String(b.title || '').trim()) return res.status(400).json({ error: 'La ruta necesita un título.' });
        res.json({ route: createRoute(b) });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/routes/:id/delete', (req, res) => {
      const id = String(req.params.id);
      if (!ROUTE_RE.test(id)) return res.status(400).json({ error: 'Id de ruta inválido.' });
      try { deleteRoute(id); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/routes/:id', (req, res) => {
      const id = String(req.params.id);
      if (!ROUTE_RE.test(id)) return res.status(400).json({ error: 'Id de ruta inválido.' });
      try { res.json({ route: updateRoute(id, req.body || {}) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Análisis IA del aprendizaje (organiza/agrupa/sugiere). Lee disco, 0 tokens.
    r.get('/analysis', (req, res) => {
      try {
        const job = readAnalysisJob();
        res.json({ ...analyzeResult(job), updatedAt: job?.updatedAt || 0 });
      } catch { res.status(500).json({ error: 'No se pudo leer el análisis.' }); }
    });

    r.post('/analyze', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador (consume tokens).' });
      try {
        const existing = readAnalysisJob();
        if (existing && isAnalyzeRunning(existing)) return res.json(analyzeResult(existing));
        const built = buildAnalyzeContext();
        if (!built) return res.status(400).json({ error: 'No hay temas para analizar.' });
        writeAnalysisJob({ status: 'running', result: null, error: null, startedAt: Date.now(), updatedAt: Date.now() });
        spawnLearningAnalyzeRunner();
        res.json({ status: 'running', result: null, error: null });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // ----- Explicación guiada IA (paramétricas al final) -----
    // "Regenerar" es INTELIGENTE (pedido del usuario): antes de gastar tokens
    // evalúa la huella de texto (notes/question/contextoAdicional) y de código
    // (archivos citados la última vez) con checkStaleness(). Sin cambios ⇒
    // no-op (0 tokens, ni siquiera se spawnea el runner). Con cambios y ya
    // había explicación ⇒ modo 'adapt' (se le pasa la anterior para
    // actualizar, no arrancar de cero). Sin explicación previa ⇒ 'full'.
    // {force:true} en el body ignora todo esto y fuerza 'full' ("Forzar
    // regeneración completa"). Admin porque consume tokens (salvo el no-op).
    r.post('/:id/explain', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador (consume tokens).' });
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      try {
        const existing = readExplainJob(id);
        if (existing && isFreshRunning(existing)) return res.json({ id, ...jobResult(existing) });
        const topic = getTopic(id);
        if (!topic) return res.status(404).json({ error: 'Tema inexistente.' });
        const force = !!req.body?.force;
        const check = checkStaleness(topic);
        if (!force && !check.stale) {
          return res.json({ id, status: 'noop', error: null, reason: 'Sin cambios: notas, contexto y código analizado siguen igual. No hizo falta regenerar.' });
        }
        const mode = (!force && topic.explanation) ? 'adapt' : 'full';
        writeExplainJob(id, {
          id, status: 'running', error: null, mode,
          topic: {
            title: topic.title, area: topic.area, scope: topic.scope,
            notes: topic.notes, question: topic.question, contextoAdicional: contextoText(topic),
            previousExplanation: mode === 'adapt' ? topic.explanation : '',
            reason: check.reason,
          },
          startedAt: Date.now(), updatedAt: Date.now(),
        });
        spawnLearningExplainRunner(id);
        res.json({ id, status: 'running', mode, error: null });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.get('/:id/explain', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      try {
        const job = readExplainJob(id);
        res.json({ id, ...jobResult(job), mode: job?.mode || null, updatedAt: job?.updatedAt || 0 });
      } catch { res.status(500).json({ error: 'No se pudo leer el estado.' }); }
    });

    // ----- Contexto adicional: LISTA de entradas (charlas IA + notas manuales) -----
    // Todo 0 tokens (edición determinística). AGREGAR una nota manual:
    r.post('/:id/context', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      try {
        const topic = addContexto(id, { text: String(req.body?.text ?? ''), source: 'manual' });
        res.json({ topic });
      } catch (e) { res.status(e.notFound ? 404 : e.badInput ? 400 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // Borrar UNA entrada (literal /delete ANTES de la edición paramétrica).
    r.post('/:id/context/:cid/delete', (req, res) => {
      const id = String(req.params.id); const cid = String(req.params.cid);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      try { res.json({ topic: deleteContextoEntry(id, cid) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // Editar UNA entrada.
    r.post('/:id/context/:cid', (req, res) => {
      const id = String(req.params.id); const cid = String(req.params.cid);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      try { res.json({ topic: updateContextoEntry(id, cid, String(req.body?.text ?? '')) }); }
      catch (e) { res.status(e.notFound ? 404 : e.badInput ? 400 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    // Interpretar una transcripción con IA (consume tokens): dispara el runner
    // desacoplado, dedup por job determinístico (mismo tema+texto = mismo job).
    r.post('/:id/context-analyze', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador (consume tokens).' });
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      const transcript = String(req.body?.transcript ?? '').slice(0, MAX_TRANSCRIPT);
      if (transcript.trim().length < 20) return res.status(400).json({ error: 'Pegá una transcripción (mín. 20 caracteres).' });
      try {
        const topic = getTopic(id);
        if (!topic) return res.status(404).json({ error: 'Tema inexistente.' });
        const jobId = contextJobId(id, transcript);
        const existing = readContextJob(jobId);
        if (existing && (existing.status === 'done' || isContextFreshRunning(existing))) {
          return res.json({ id: jobId, status: existing.status });
        }
        const now = Date.now();
        writeContextJob(jobId, {
          id: jobId, topicId: id, itemTitle: topic.title, itemDesc: topic.notes,
          transcript, status: 'running', result: null, rendered: null, error: null,
          startedAt: now, updatedAt: now,
        });
        spawnLearningContextRunner(jobId);
        res.json({ id: jobId, status: 'running' });
      } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.get('/:id/context-analyze/:jobId', (req, res) => {
      const jobId = String(req.params.jobId).replace(/[^a-f0-9]/gi, '');
      try {
        const job = readContextJob(jobId);
        res.json({ id: jobId, ...contextJobResult(job), updatedAt: job?.updatedAt || 0 });
      } catch { res.status(500).json({ error: 'No se pudo leer el estado.' }); }
    });

    r.post('/:id/delete', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      try { deleteTopic(id); res.json({ ok: true }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.post('/:id', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      try { res.json({ topic: updateTopic(id, req.body || {}) }); }
      catch (e) { res.status(e.notFound ? 404 : 500).json({ error: String(e?.message || e).slice(0, 300) }); }
    });

    r.get('/:id', (req, res) => {
      const id = String(req.params.id);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id de tema inválido.' });
      const topic = getTopic(id);
      if (!topic) return res.status(404).json({ error: 'Tema inexistente.' });
      // explainCheck es DERIVADO (no se persiste): le dice al front si conviene
      // regenerar antes de que el usuario toque el botón.
      res.json({ topic: { ...topic, explainCheck: checkStaleness(topic) } });
    });

    router.use('/learning', r);
  },
};
