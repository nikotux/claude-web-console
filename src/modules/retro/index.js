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
//   GET  /api/retro/hygiene         -> hallazgos determinísticos (0 tokens)
//   POST /api/retro/hygiene/apply   -> { deleted, skipped } (ADMIN)
//   POST /api/retro/verify          -> { status }    (ADMIN; dispara medidor 0 tokens)
//   GET  /api/retro/verify          -> { status, progress, summary, lessons, ... }
//   GET  /api/retro/:id             -> { lesson }
//   POST /api/retro/:id/approve     -> { lesson }   (status 'aprobada')
//   POST /api/retro/:id/dismiss     -> { lesson }   (status 'descartada')
//   POST /api/retro/:id/promote {target?,kind?,match?,contract?,rule?} -> { lesson }   (ADMIN; target ∈ memoria|claude-md|contexto|convencion|contrato|invariante)
//   POST /api/retro/:id/delete      -> { ok }
//
// "Feedback de Chris" (2026-07-19, categoría 'feedback-cliente' de la MISMA
// colección — ver store.js): retroalimentación puntual de un cliente/revisor
// sobre un ticket/PR, NO una lección de proceso. Dos vías de ingesta, ambas
// ADMIN (consumen tokens, runner desacoplado):
//   POST /api/retro/feedback {text, ticketRef?}      -> { id, status }  (pegado manual)
//   GET  /api/retro/feedback/:jobId                  -> { status, result, error }
//   POST /api/retro/email-refresh                    -> { status }     (escaneo Graph del contacto 'chris')
//   GET  /api/retro/email-scan                       -> { items, scannedAt, running, ... }
//   POST /api/retro/teams-refresh                     -> { status }     (escaneo del DM de Teams con 'chris')
//   GET  /api/retro/teams-scan                        -> { items, scannedAt, running, ... }
// OJO ORDEN: las literales /activity, /targets, /hygiene, /verify, /feedback,
// /email-*, /teams-* van ANTES de la paramétrica /:id.
import express from 'express';
import { isAdmin, principalOf } from '../../core/auth.js';
import { reqPadContext } from '../../core/pad-context.js';
import { deleteItem as padDeleteItem } from '../../core/pad-service-client.js';
import { hardRulesText } from '../health/shared.js';
import {
  listLessons, getLesson, setStatus, deleteLesson, listActivity, markPromoted,
  mergeLessons, upsertLesson, setDestination,
} from './store.js';
import { PROMOTE_TARGETS, promote, applicableTargetsFor, targetBlockReason } from './promote-shared.js';
import {
  readCurationJob, writeCurationJob, isFreshRunning as isCurateRunning,
  jobResult as curationResult, spawnRetroCurateRunner,
} from './curate-shared.js';
import {
  feedbackJobId, readFeedbackJob, writeFeedbackJob, isFeedbackFreshRunning,
  feedbackJobResult, spawnRetroFeedbackRunner,
} from './feedback-shared.js';
import { readEmailScan, isEmailScanRunning, spawnRetroEmailRunner } from './email-shared.js';
import { readTeamsFeedbackScan, isTeamsFeedbackScanRunning, spawnRetroTeamsRunner } from './teams-feedback-shared.js';
import { readVerifyState, isVerifyRunning, isVerifyStale, spawnRetroVerifyRunner } from './verify-shared.js';
import {
  SWEEP_EVERY_MS, SWEEP_BOOT_DELAY_MS, isSweepRunning, spawnRetroSweepRunner,
} from './sweep-shared.js';
import { scanHygiene } from './hygiene-shared.js';

function sendErr(res, e) {
  if (e?.badRequest) return res.status(400).json({ error: e.message });
  if (e?.notFound) return res.status(404).json({ error: e.message });
  if (e?.conflict) return res.status(409).json({ error: e.message });
  return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
}

export default {
  name: 'retro',

  // BUG-2068: las sesiones TUI no pasan por Chat.close, así que nunca destilaban.
  // El tick solo SPAWNEA el runner desacoplado (regla 2): todo el trabajo y el
  // estado viven fuera del proceso del server, y el barrido es idempotente
  // (registro durable), así que un reinicio no pierde ni duplica nada.
  init() {
    const kick = () => {
      try { if (!isSweepRunning()) spawnRetroSweepRunner(); }
      catch (err) { console.error('[retro] no pude lanzar el barrido de TUI:', err?.message); }
    };
    setTimeout(kick, SWEEP_BOOT_DELAY_MS).unref();
    setInterval(kick, SWEEP_EVERY_MS).unref();
  },

  registerHttp(router) {
    const r = express.Router();

    r.get('/', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        // La aplicabilidad la calcula el BACKEND: el tablero la duplicaba con un
        // NEED_DIR propio y quedaba ciego a cualquier destino con reglas nuevas.
        const { lessons, counts } = await listLessons(ctx);
        res.json({
          counts,
          lessons: lessons.map((l) => ({
            ...l,
            targets: applicableTargetsFor(l),
            targetReasons: Object.fromEntries(
              PROMOTE_TARGETS.map((target) => [target, targetBlockReason(target, l)]).filter(([, reason]) => reason),
            ),
          })),
        });
        // Auto-cebado del medidor: sin esto el semáforo externo solo se
        // actualizaría a mano. Si el resultado está vencido y no hay corrida
        // viva, relanzamos el runner SIN bloquear la respuesta — el tablero
        // recoge el resultado en el próximo poll (el front se re-engancha al
        // estado persistido, regla 2). Acotado al admin del host sobre el
        // workspace 'console': un inquilino NO dispara lecturas del repo externo.
        try {
          const own = !ctx || !ctx.workspace || ctx.workspace === 'console';
          if (isAdmin(req) && own
            && lessons.some((l) => l.category === 'feedback-cliente' && l.status === 'promovida')
            && !isVerifyRunning() && isVerifyStale(readVerifyState())) {
            spawnRetroVerifyRunner();
          }
        } catch { /* best-effort: nunca rompe el listado */ }
      }
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

    // ===== Feedback de Chris: ingesta MANUAL (pegar correo/Teams/llamada) =====
    r.post('/feedback', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Registrar feedback consume tokens (requiere administrador).' });
      try {
        const b = req.body || {};
        const text = String(b.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Falta el texto a interpretar.' });
        const ticketRef = String(b.ticketRef || '').trim().slice(0, 24) || null;
        const id = feedbackJobId(text, ticketRef);
        const existing = readFeedbackJob(id);
        if (existing && (existing.status === 'done' || isFeedbackFreshRunning(existing))) {
          return res.json({ id, ...feedbackJobResult(existing) });
        }
        const owner = principalOf(req)?.username || null;
        writeFeedbackJob(id, {
          id, status: 'running', startedAt: Date.now(), owner,
          text: text.slice(0, 20000), ticketRef, project: String(b.project || '').trim() || null,
          result: null, error: null,
        });
        spawnRetroFeedbackRunner(id);
        res.json({ id, status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/feedback/:jobId', (req, res) => {
      try { res.json({ id: req.params.jobId, ...feedbackJobResult(readFeedbackJob(req.params.jobId)) }); }
      catch (e) { sendErr(res, e); }
    });

    // ===== Feedback de Chris: ingesta AUTOMÁTICA de correo (Graph) =====
    r.post('/email-refresh', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'El escaneo de correo consume tokens (requiere administrador).' });
      try {
        if (isEmailScanRunning()) return res.json({ status: 'running' });
        spawnRetroEmailRunner();
        res.json({ status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/email-scan', (req, res) => {
      try { res.json({ ...readEmailScan(), running: isEmailScanRunning() }); }
      catch (e) { sendErr(res, e); }
    });

    // ===== Feedback de Chris: ingesta AUTOMÁTICA de Teams (Graph) =====
    r.post('/teams-refresh', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'El escaneo de Teams consume tokens (requiere administrador).' });
      try {
        if (isTeamsFeedbackScanRunning()) return res.json({ status: 'running' });
        spawnRetroTeamsRunner();
        res.json({ status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/teams-scan', (req, res) => {
      try { res.json({ ...readTeamsFeedbackScan(), running: isTeamsFeedbackScanRunning() }); }
      catch (e) { sendErr(res, e); }
    });

    // ===== Curaduría IA (Fase 5): consume tokens, runner desacoplado =====
    r.post('/curate', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'La curaduría consume tokens (requiere administrador).' });
      try {
        const ctx = reqPadContext(req);
        if (isCurateRunning(readCurationJob())) return res.json({ status: 'running' });
        // Reserva SINCRÓNICA del lock (mismo tick que el check) para cerrar la
        // ventana TOCTOU: el `await listLessons()` (HTTP a Pad) de por medio
        // dejaba pasar a un 2º request que también veía "no corriendo" y
        // spawneaba una 2ª curaduría. Escribimos el job 'running' YA; recién
        // después traemos las lecciones y completamos el `context`.
        writeCurationJob({ status: 'running', startedAt: Date.now(), context: null, result: null, error: null });
        try {
          const { lessons } = await listLessons(ctx);
          const active = lessons.filter((l) => l.status !== 'descartada')
            .map((l) => ({
              id: l.id,
              title: l.title,
              category: l.category,
              project: l.project,
              status: l.status,
              recurrence: l.recurrence,
              destination: l.destination,
              promotedTo: l.promotedTo,
              body: l.body,
            }));
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
        const ctx = reqPadContext(req);
        const b = req.body || {};
        const action = String(b.action || '');
        if (action === 'merge') {
          return res.json({ lesson: await mergeLessons(String(b.keep || ''), Array.isArray(b.merge) ? b.merge : [], ctx) });
        }
        if (action === 'dismiss') {
          return res.json({ lesson: await setStatus(String(b.id || ''), 'descartada', ctx) });
        }
        if (action === 'redestinar') {
          const destination = String(b.destination || '');
          if (!PROMOTE_TARGETS.includes(destination)) return res.status(400).json({ error: 'Destino inválido.' });
          return res.json({ lesson: await setDestination(String(b.id || ''), destination, ctx) });
        }
        if (action === 'consolidate') {
          const created = await upsertLesson({ title: b.title, category: b.category, lesson: b.lesson, observation: 'Consolidada por la curaduría IA', project: b.project || 'console', destination: 'registro' }, ctx);
          for (const mid of (Array.isArray(b.ids) ? b.ids : [])) {
            if (mid === created.lesson.id) continue; // si el dedup reusó una fuente, NO borres la consolidada (bug de pérdida de datos)
            try { await deleteLesson(mid, ctx); } catch { /* noop */ }
          }
          return res.json({ lesson: created.lesson });
        }
        return res.status(400).json({ error: 'Acción de curaduría inválida.' });
      } catch (e) { sendErr(res, e); }
    });

    // ===== Medidor REAL de efectividad (M1 de DOC-1926 / PLAN-1937) =====
    // Cuenta las rondas de review de Chris sobre los PRs de `sourceRefs`
    // POSTERIORES a la adopción. 0 TOKENS (lee los PRs con el lector único ya
    // cacheado), runner DESACOPLADO por regla 2. Admin porque dispara un
    // proceso y lecturas de red contra el repo trackeado.
    r.post('/verify', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Verificar la efectividad requiere administrador.' });
      try {
        if (isVerifyRunning()) return res.json({ status: 'running' });
        spawnRetroVerifyRunner({ full: !!req.body?.full });
        res.json({ status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/verify', (req, res) => {
      try {
        const st = readVerifyState();
        res.json({
          running: isVerifyRunning(),
          status: st.status || 'idle',
          scannedAt: st.scannedAt || 0,
          progress: st.progress || { done: 0, total: 0 },
          summary: st.summary || null,
          lessons: st.lessons || {},
          stale: isVerifyStale(st),
          error: st.error || null,
        });
      } catch (e) { sendErr(res, e); }
    });

    // ===== Higiene determinística del registro (0 tokens) =====
    r.get('/hygiene', async (req, res) => {
      try { res.json(await scanHygiene(reqPadContext(req))); }
      catch (e) { sendErr(res, e); }
    });

    r.post('/hygiene/apply', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Aplicar la higiene requiere administrador.' });
      try {
        const b = req.body || {};
        if (b.action !== 'delete-copies') return res.status(400).json({ error: 'Acción de higiene inválida.' });
        const ctx = reqPadContext(req);
        // Re-verificación obligatoria: la lista del cliente nunca decide qué se
        // borra. Solo refs encontradas AHORA dentro de `playbooks` son elegibles.
        const scan = await scanHygiene(ctx);
        const eligible = new Set([
          ...scan.copiasRedundantes.filter((item) => item.mcExists).map((item) => item.ref),
          ...scan.huerfanosDescartados.map((item) => item.ref),
        ]);
        const refs = [...new Set(Array.isArray(b.refs) ? b.refs.map((ref) => String(ref || '').trim()).filter(Boolean) : [])];
        const deleted = [];
        const skipped = [];
        for (const ref of refs) {
          if (!eligible.has(ref)) {
            skipped.push({ ref, reason: 'El escaneo actual no lo marca como copia borrable de playbooks.' });
            continue;
          }
          const result = await padDeleteItem(ref, { ctx });
          if (result.ok) deleted.push(ref);
          else skipped.push({ ref, reason: result.error || 'Pad rechazó el borrado.' });
        }
        res.json({ deleted, skipped });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/:id', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        res.json({ lesson: await getLesson(req.params.id, ctx) });
      }
      catch (e) { sendErr(res, e); }
    });

    r.post('/:id/approve', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        res.json({ lesson: await setStatus(req.params.id, 'aprobada', ctx) });
      }
      catch (e) { sendErr(res, e); }
    });

    r.post('/:id/dismiss', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        res.json({ lesson: await setStatus(req.params.id, 'descartada', ctx) });
      }
      catch (e) { sendErr(res, e); }
    });

    // Volver una lección (guardada/descartada) al estado 'propuesta'.
    r.post('/:id/reopen', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        res.json({ lesson: await setStatus(req.params.id, 'propuesta', ctx) });
      }
      catch (e) { sendErr(res, e); }
    });

    r.post('/:id/promote', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Promover requiere administrador.' });
      try {
        const ctx = reqPadContext(req);
        const l = await getLesson(req.params.id, ctx);
        const asked = String(req.body?.target || '').trim();
        if (asked && !PROMOTE_TARGETS.includes(asked)) {
          return res.status(400).json({ error: `El destino "${asked}" no está disponible.` });
        }
        // target explícito si es válido; si no, el destino sugerido si está
        // cableado; si no, memoria (el más inocuo).
        const target = asked
          ? asked
          : (PROMOTE_TARGETS.includes(l.destination) ? l.destination : 'memoria');
        // Gate ÚNICO de aplicabilidad (promote-shared): el backend rechaza lo que
        // el tablero no debería haber ofrecido, con el motivo exacto.
        // El glob explícito del body cuenta para el gate: sin esto una promoción
        // legítima con `match` a mano se rechazaba antes de llegar al destino.
        const blocked = targetBlockReason(target, l, req.body?.match);
        if (blocked) return res.status(400).json({ error: `No se puede adoptar como ${target}: ${blocked}` });
        // Marcar primero (snapshot Fase 6) → así claude-md la incluye al render.
        // Si escribir el destino falla DESPUÉS de marcar, revertimos el status
        // para no dejarla 'promovida' sin haberla escrito (y que se pueda reintentar).
        const marked = await markPromoted(l.id, target, ctx);
        try {
          await promote(marked.project, target, marked, {
            kind: String(req.body?.kind || 'work'),
            match: req.body?.match,
            contract: req.body?.contract,
            // `rule` es el predicado declarativo (fileExists|grepPresent|grepAbsent)
            // que hace que la obligación se verifique SOLA en cada corrida del
            // emisor. Sin regla la fila entra igual, pero como verificación
            // manual (skipped con motivo, nunca "incumplida").
            rule: req.body?.rule,
          }, ctx);
        } catch (err) {
          try { await setStatus(l.id, l.status, ctx); } catch { /* best-effort */ }
          throw err;
        }
        res.json({ lesson: marked });
      } catch (e) { sendErr(res, e); }
    });

    r.post('/:id/delete', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        res.json(await deleteLesson(req.params.id, ctx));
      }
      catch (e) { sendErr(res, e); }
    });

    router.use('/retro', r);
  },
};
