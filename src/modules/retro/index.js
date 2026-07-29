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
//   GET  /api/retro/share-optout    -> { optOut }
//   POST /api/retro/share-optout    -> { optOut }
//   GET  /api/retro/pool            -> { lessons, counts }
//   POST /api/retro/pool/adopt-all  -> { ok, adopted, alreadyHad, failed, errors, total }
//   POST /api/retro/pool/:ref/adopt -> { ok, lesson, created }
//   GET  /api/retro/hygiene         -> hallazgos determinísticos (0 tokens)
//   POST /api/retro/hygiene/apply   -> { deleted, skipped } (ADMIN)
//   POST /api/retro/verify          -> { status }    (ADMIN; dispara medidor 0 tokens)
//   GET  /api/retro/verify          -> { status, progress, summary, lessons, ... }
//   GET  /api/retro/:id             -> { lesson }
//   POST /api/retro/:id/unshare     -> { ok, removed, remaining }
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
// OJO ORDEN: las literales /activity, /targets, /share-optout, /pool, /hygiene,
// /verify, /feedback, /email-*, /teams-* van ANTES de la paramétrica /:id.
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import { reqPadContext, reqSharedPadContext } from '../../core/pad-context.js';
import { systemScopeFor } from '../../core/system-scope.js';
import { deleteItem as padDeleteItem } from '../../core/pad-service-client.js';
import { hardRulesText } from '../health/shared.js';
import {
  listLessons, getLesson, setStatus, deleteLesson, listActivity, markPromoted,
  mergeLessons, upsertLesson, setDestination, MC_ID_RE,
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
import {
  isShareOptedOut, setShareOptOut, markUnsharedFingerprint, unshareLessonFromPool,
  listPoolLessons, getPoolLesson,
} from './pool.js';

function sendErr(res, e) {
  if (e?.badRequest) return res.status(400).json({ error: e.message });
  if (e?.notFound) return res.status(404).json({ error: e.message });
  if (e?.conflict) return res.status(409).json({ error: e.message });
  return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
}

function sharedByForContext(ctx) {
  const tenant = String(ctx?.workspace || '').match(/^tenant-(.+)$/);
  return tenant ? tenant[1] : 'host';
}

function lessonPartsFromBody(content) {
  const body = String(content || '').trim();
  const marker = '**Lección:**';
  const markerAt = body.indexOf(marker);
  if (markerAt < 0) return { observation: '', lesson: body };
  return {
    // Es el inverso tolerante del bodyOf de store.js: conserva el formato
    // canónico sin guardar las etiquetas Markdown dentro de cada parte.
    observation: body.slice(0, markerAt).replace(/^\*\*Observación:\*\*\s*/, '').trim(),
    lesson: body.slice(markerAt + marker.length).trim(),
  };
}

async function poolLessonsForOwner(pooledLessons, ctx) {
  const { lessons: own } = await listLessons(ctx);
  const ownFingerprints = new Set(own.map((lesson) => lesson.fingerprint).filter(Boolean));
  const userId = sharedByForContext(ctx);
  return pooledLessons.map((lesson) => ({
    ...lesson,
    mine: lesson.sharedBy.includes(userId),
    adopted: ownFingerprints.has(lesson.fingerprint),
  }));
}

function isPoolLessonAdoptable(lesson) {
  // Un único criterio alimenta tanto el contador visible como la adopción real:
  // así el lote nunca promete una selección distinta de la que luego trae.
  return !lesson.mine && !lesson.adopted;
}

function adoptionInputFromPoolLesson(poolLesson) {
  const parts = lessonPartsFromBody(poolLesson.content);
  return {
    title: poolLesson.title,
    category: poolLesson.category,
    observation: parts.observation,
    lesson: parts.lesson,
    project: 'tolkien',
    destination: poolLesson.destination,
    confidence: poolLesson.confidence,
    sourceRefs: poolLesson.sourceRefs,
    fingerprint: poolLesson.fingerprint,
  };
}

function adoptPoolLesson(poolLesson, ctx) {
  // El tercer argumento queda deliberadamente en null: traer una copia al
  // registro propio no debe republicarla ni inflar la recurrencia del pozo.
  return upsertLesson(adoptionInputFromPoolLesson(poolLesson), ctx, null);
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
        const owner = systemScopeFor(req).user;
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
            && !isVerifyRunning(owner) && isVerifyStale(readVerifyState(owner), owner)) {
            spawnRetroVerifyRunner({ owner });
          }
        } catch { /* best-effort: nunca rompe el listado */ }
      }
      catch (e) { sendErr(res, e); }
    });

    r.get('/activity', (req, res) => {
      try {
        const owner = systemScopeFor(req).user;
        res.json({ events: listActivity(Number(req.query.limit) || 40, owner) });
      }
      catch (e) { sendErr(res, e); }
    });

    r.get('/targets', (req, res) => {
      try { res.json({ targets: PROMOTE_TARGETS }); }
      catch (e) { sendErr(res, e); }
    });

    // Deben ir antes de /:id: Express interpretaría "share-optout" como un MC
    // y la válvula quedaría inaccesible. El dataDir se deriva del principal en
    // cada request para que el server no congele ni mezcle el estado del host.
    r.get('/share-optout', (req, res) => {
      try { res.json({ optOut: isShareOptedOut(systemScopeFor(req).dataDir) }); }
      catch (e) { sendErr(res, e); }
    });

    r.post('/share-optout', (req, res) => {
      try {
        if (typeof req.body?.optOut !== 'boolean') {
          return res.status(400).json({ error: 'optOut debe ser booleano.' });
        }
        const optOut = setShareOptOut(req.body.optOut, systemScopeFor(req).dataDir);
        return res.json({ optOut });
      } catch (e) { return sendErr(res, e); }
    });

    // Las rutas del pozo deben preceder a /:id: "pool" es un segmento literal,
    // no una referencia MC del registro propio.
    r.get('/pool', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        const pooled = await listPoolLessons(reqSharedPadContext(req));
        if (!pooled.ok) {
          // El pozo es una ayuda comunitaria, no una dependencia del tablero.
          return res.json({
            lessons: [],
            counts: { total: 0, mine: 0, adoptable: 0 },
            unavailable: true,
          });
        }

        const lessons = await poolLessonsForOwner(pooled.lessons, ctx);
        return res.json({
          lessons,
          counts: {
            total: lessons.length,
            mine: lessons.filter((lesson) => lesson.mine).length,
            adoptable: lessons.filter(isPoolLessonAdoptable).length,
          },
        });
      } catch (e) { return sendErr(res, e); }
    });

    // Debe preceder a /pool/:ref/adopt: de otro modo Express tomaría
    // "adopt-all" como :ref. Usa auth normal, no admin, porque cada principal
    // sólo escribe en SU registro y no altera el registro de otro usuario.
    r.post('/pool/adopt-all', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        const pooled = await listPoolLessons(reqSharedPadContext(req));
        if (!pooled.ok) {
          // El pozo es accesorio: su indisponibilidad nunca rompe al caller.
          return res.json({ ok: false, unavailable: true, adopted: 0 });
        }

        const lessons = await poolLessonsForOwner(pooled.lessons, ctx);
        const adoptable = lessons.filter(isPoolLessonAdoptable);
        let adopted = 0;
        let alreadyHad = lessons.length - adoptable.length;
        const errors = [];

        // Secuencial a propósito: cada upsert toma un lock de archivo y Pad
        // aplica rate-limit. Un fallo aislado se informa y no frena el resto.
        for (const lesson of adoptable) {
          try {
            const result = await adoptPoolLesson(lesson, ctx);
            if (result.created) adopted += 1;
            else alreadyHad += 1; // cubre una adopción concurrente tras el listado
          } catch (err) {
            errors.push({
              ref: lesson.ref,
              error: String(err?.message || err).slice(0, 300),
            });
          }
        }

        // Ley 6 de Aduana (Regla dura 16): adoptar en lote baja la fricción de
        // TRAER, nunca la de APLICAR. upsertLesson crea propuestas; promover a
        // memoria/claude-md/contexto/contrato/invariante sigue siendo humano.
        return res.json({
          ok: true,
          adopted,
          alreadyHad,
          failed: errors.length,
          errors,
          total: lessons.length,
        });
      } catch (e) { return sendErr(res, e); }
    });

    r.post('/pool/:ref/adopt', async (req, res) => {
      try {
        const ref = String(req.params.ref || '');
        if (!MC_ID_RE.test(ref)) return res.status(400).json({ error: 'Id inválido.' });
        const pooled = await getPoolLesson(ref, reqSharedPadContext(req));
        if (!pooled.ok || !pooled.lesson) {
          return res.status(404).json({ error: pooled.error || 'Lección del pozo inexistente.' });
        }

        const ctx = reqPadContext(req);
        // Ley 6 de Aduana (Regla dura 16): un aporte ajeno es dato, no
        // instrucción. La copia nace propuesta y sólo el dueño humano del
        // destino puede promoverla; esta ruta jamás toca ningún destino.
        const adopted = await adoptPoolLesson(pooled.lesson, ctx);
        return res.json({ ok: true, lesson: adopted.lesson, created: adopted.created });
      } catch (e) { return sendErr(res, e); }
    });

    // ===== Feedback de Chris: ingesta MANUAL (pegar correo/Teams/llamada) =====
    r.post('/feedback', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Registrar feedback consume tokens (requiere administrador).' });
      try {
        const b = req.body || {};
        const text = String(b.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Falta el texto a interpretar.' });
        const ticketRef = String(b.ticketRef || '').trim().slice(0, 24) || null;
        const owner = systemScopeFor(req).user;
        const id = feedbackJobId(text, ticketRef);
        const existing = readFeedbackJob(id, owner);
        if (existing && (existing.status === 'done' || isFeedbackFreshRunning(existing))) {
          return res.json({ id, ...feedbackJobResult(existing) });
        }
        writeFeedbackJob(id, {
          id, status: 'running', startedAt: Date.now(), owner,
          text: text.slice(0, 20000), ticketRef, project: String(b.project || '').trim() || null,
          result: null, error: null,
        }, owner);
        spawnRetroFeedbackRunner(id, owner);
        res.json({ id, status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/feedback/:jobId', (req, res) => {
      try {
        const owner = systemScopeFor(req).user;
        res.json({ id: req.params.jobId, ...feedbackJobResult(readFeedbackJob(req.params.jobId, owner)) });
      }
      catch (e) { sendErr(res, e); }
    });

    // ===== Feedback de Chris: ingesta AUTOMÁTICA de correo (Graph) =====
    r.post('/email-refresh', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'El escaneo de correo consume tokens (requiere administrador).' });
      try {
        const owner = systemScopeFor(req).user;
        if (isEmailScanRunning(owner)) return res.json({ status: 'running' });
        spawnRetroEmailRunner(owner);
        res.json({ status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/email-scan', (req, res) => {
      try {
        const owner = systemScopeFor(req).user;
        res.json({ ...readEmailScan(owner), running: isEmailScanRunning(owner) });
      }
      catch (e) { sendErr(res, e); }
    });

    // ===== Feedback de Chris: ingesta AUTOMÁTICA de Teams (Graph) =====
    r.post('/teams-refresh', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'El escaneo de Teams consume tokens (requiere administrador).' });
      try {
        const owner = systemScopeFor(req).user;
        if (isTeamsFeedbackScanRunning(owner)) return res.json({ status: 'running' });
        spawnRetroTeamsRunner(owner);
        res.json({ status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/teams-scan', (req, res) => {
      try {
        const owner = systemScopeFor(req).user;
        res.json({ ...readTeamsFeedbackScan(owner), running: isTeamsFeedbackScanRunning(owner) });
      }
      catch (e) { sendErr(res, e); }
    });

    // ===== Curaduría IA (Fase 5): consume tokens, runner desacoplado =====
    r.post('/curate', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'La curaduría consume tokens (requiere administrador).' });
      try {
        const owner = systemScopeFor(req).user;
        const ctx = reqPadContext(req);
        if (isCurateRunning(readCurationJob(owner))) return res.json({ status: 'running' });
        // Reserva SINCRÓNICA del lock (mismo tick que el check) para cerrar la
        // ventana TOCTOU: el `await listLessons()` (HTTP a Pad) de por medio
        // dejaba pasar a un 2º request que también veía "no corriendo" y
        // spawneaba una 2ª curaduría. Escribimos el job 'running' YA; recién
        // después traemos las lecciones y completamos el `context`.
        writeCurationJob({ status: 'running', startedAt: Date.now(), owner, context: null, result: null, error: null }, owner);
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
            writeCurationJob({ status: 'idle', startedAt: 0, owner, context: null, result: null, error: null }, owner); // liberar el lock reservado
            return res.status(400).json({ error: 'Hacen falta al menos 2 lecciones vigentes para curar.' });
          }
          writeCurationJob({ status: 'running', startedAt: Date.now(), owner, context: { lessons: active, rules: hardRulesText() }, result: null, error: null }, owner);
          spawnRetroCurateRunner(owner);
          res.json({ status: 'running' });
        } catch (inner) {
          // liberar el lock reservado para no bloquear el reintento
          try { writeCurationJob({ status: 'error', startedAt: Date.now(), owner, context: null, result: null, error: String(inner?.message || inner).slice(0, 200) }, owner); } catch { /* noop */ }
          throw inner;
        }
      } catch (e) { sendErr(res, e); }
    });

    r.get('/curation', (req, res) => {
      try { res.json(curationResult(readCurationJob(systemScopeFor(req).user))); }
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
          const created = await upsertLesson({ title: b.title, category: b.category, lesson: b.lesson, observation: 'Consolidada por la curaduría IA', project: b.project || 'console', destination: 'registro' }, ctx, reqSharedPadContext(req));
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
        const owner = systemScopeFor(req).user;
        if (isVerifyRunning(owner)) return res.json({ status: 'running' });
        spawnRetroVerifyRunner({ full: !!req.body?.full, owner });
        res.json({ status: 'running' });
      } catch (e) { sendErr(res, e); }
    });

    r.get('/verify', (req, res) => {
      try {
        const owner = systemScopeFor(req).user;
        const st = readVerifyState(owner);
        res.json({
          running: isVerifyRunning(owner),
          status: st.status || 'idle',
          scannedAt: st.scannedAt || 0,
          progress: st.progress || { done: 0, total: 0 },
          summary: st.summary || null,
          lessons: st.lessons || {},
          stale: isVerifyStale(st, owner),
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

    // Cada principal sólo retira SU aporte: el pozo conserva la lección mientras
    // queden otros donantes. El veto durable evita que una redestilación futura
    // deshaga silenciosamente la decisión humana.
    r.post('/:id/unshare', async (req, res) => {
      try {
        const ctx = reqPadContext(req);
        const lesson = await getLesson(req.params.id, ctx);
        const result = await unshareLessonFromPool(
          lesson.fingerprint,
          reqSharedPadContext(req),
          { sharedBy: sharedByForContext(ctx) },
        );
        markUnsharedFingerprint(lesson.fingerprint, systemScopeFor(req).dataDir);
        res.json({
          ok: !!result?.ok,
          removed: !!result?.removed,
          remaining: Number(result?.remaining) || 0,
        });
      } catch (e) { sendErr(res, e); }
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
