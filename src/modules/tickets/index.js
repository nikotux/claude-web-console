// modules/tickets/index.js — "Tickets & Features" (oficial desde 2026-07-07,
// reemplazó a "Bugs & Features" v1, archivado en _archived/). Dashboard estilo
// One Front Door. Ruta: /api/tickets.
//
// Lectura DETERMINÍSTICA de Zoho/GitHub (sin sub-agente de IA — ver plan en
// ~/pool of documents/2026-07-06_plan-backend-deterministico-lectura-desk_v01.md).
// El servidor sirve SIEMPRE de un SNAPSHOT pre-computado en background cada 60s
// (refresher.js): el dashboard y el detalle de cada ticket abren instantáneo,
// sin golpear Zoho en cada apertura.
import express from 'express';
import { isAdmin, principalOf } from '../../core/auth.js';
import { getTicketState, listDepartments } from './desk-mcp-client.js';
import { getPrDetail, readResolved, refreshResolved, findResolvedTicket, resolvedInfo } from './sources.js';
import { buildResolved } from './views.js';
import { enrich } from './derive.js';
import { getSnapshot, refreshNow, startRefresher } from './refresher.js';
import { getContext, saveContext, DEFAULT_CONTEXTS, verifySync, syncToTolkien } from './context-store.js';
import { getActiveClaim, withClaim, claim as claimTicket, release as releaseTicket } from './claims-store.js';
import { getMeta, saveContexto, clearContexto } from './meta-store.js';
import {
  contextJobId, readJob, writeJob, spawnRunner, jobResult, isFreshRunning, MAX_TRANSCRIPT,
} from './context-analyze-shared.js';

// Actor de la request para los claims: usuario logueado, o "token-maestro" si
// entró por el token admin. Cuando existan agentes con identidad propia, pasarán
// la suya por acá sin cambiar el resto.
function actorOf(req) {
  const p = principalOf(req);
  if (!p) return null;
  const username = p.username || (p.type === 'token' ? 'token-maestro' : null);
  return { username, admin: !!p.admin, type: p.type, label: username };
}

export default {
  name: 'tickets',

  // Arranca el timer que pre-computa el snapshot en background.
  init() { startRefresher(); },

  registerHttp(router) {
    const r = express.Router();

    // Detalle de un ticket: del snapshot (instantáneo). Fallback a lectura viva
    // sólo si el ticket no estaba en el último snapshot (ej. cerrado viejo).
    r.get('/ticket/:id', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const actor = actorOf(req);
        const you = actor?.username || null;
        const youAdmin = !!actor?.admin;
        const snap = getSnapshot();
        const meta = await getMeta(req.params.id); // Contexto adicional + Histórico del trabajo (nuestros, Pad local)
        const cached = snap?.ticketsById?.[String(req.params.id)];
        if (cached) return res.json({ ...withClaim(cached), meta, you, youAdmin, cached: true, generatedAt: snap.generatedAt });
        // Fuente de consulta uniforme (Fix 3, 2026-07-10): si es un ticket CERRADO
        // que vive en la base de RESUELTOS, servilo de ahí (0 red) antes de golpear
        // Zoho en vivo — así abrir un cerrado viejo no se cuelga.
        const resolvedRaw = findResolvedTicket(req.params.id);
        if (resolvedRaw) {
          return res.json({ ...withClaim(enrich(resolvedRaw, Date.now())), meta, you, youAdmin, cached: true, fromResolved: true, generatedAt: resolvedInfo().at || null });
        }
        const data = await getTicketState(req.params.id);
        res.json({ ...withClaim(data), meta, you, youAdmin });
      } catch (err) {
        res.status(500).json({ found: false, error: String(err?.message || err).slice(0, 300) });
      }
    });

    // Detalle completo de un PR (body, conversaciones, checks, archivos). Del
    // snapshot (instantáneo); fallback a lectura viva si no estaba cacheado.
    r.get('/pr/:number', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        const actor = actorOf(req);
        const you = actor?.username || null;
        const youAdmin = !!actor?.admin;
        const num = String(req.params.number).replace(/[^\d]/g, '');
        const workingBy = getActiveClaim(`pr:${num}`); // claims de PR van con prefijo pr:
        const meta = await getMeta(`pr:${num}`);        // Contexto adicional + Histórico (mismo prefijo, Pad local)
        const snap = getSnapshot();
        const cached = snap?.prDetailsById?.[num];
        if (cached) return res.json({ pr: { ...cached, workingBy, meta }, you, youAdmin, error: null, cached: true, generatedAt: snap.generatedAt });
        const live = await getPrDetail(req.params.number);
        res.json({ ...live, pr: live.pr ? { ...live.pr, workingBy, meta } : live.pr, you, youAdmin });
      } catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    r.get('/departments', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try { res.json({ departments: await listDepartments() }); }
      catch (err) { res.status(500).json({ error: String(err?.message || err).slice(0, 300) }); }
    });

    // Dashboard: SIEMPRE del snapshot (instantáneo). ?force=1 dispara un refresh
    // inmediato y espera (botón "Actualizar"). Si aún no hay snapshot (arranque
    // en frío sin disco), computa uno.
    r.get('/dashboard', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        if (req.query.force === '1' || !getSnapshot()) await refreshNow();
        const s = getSnapshot();
        if (!s || !s.dashboard) return res.json({ loading: true, error: s?.error || null });
        const you = actorOf(req)?.username || null;
        // Overlay del claim (workingBy) sobre cada lista de tickets, sin mutar el
        // snapshot compartido (se clona lo justo). El campo se refleja al instante
        // en el próximo fetch, sin esperar el refresh de 60s.
        const d = s.dashboard;
        const stamp = (list) => (list || []).map((t) => withClaim(t));
        // PRs: mismo overlay, con id prefijado `pr:<number>`.
        const devLane = d.devLane
          ? { ...d.devLane, prs: (d.devLane.prs || []).map((pr) => ({ ...pr, workingBy: getActiveClaim(`pr:${pr.number}`) })) }
          : d.devLane;
        res.json({
          ...d, devLane,
          nuevos: stamp(d.nuevos),
          vencidos: stamp(d.vencidos),
          enProgreso: stamp(d.enProgreso),
          you, generatedAt: s.generatedAt, lastError: s.lastError || null,
        });
      } catch (err) {
        res.status(500).json({ error: String(err?.message || err).slice(0, 300) });
      }
    });

    // Vista RESUELTOS: SÓLO LECTURA del store persistente (rediseño Niko
    // 2026-07-10). El enriquecido lo hace el REFRESHER de fondo en el MISMO loop
    // de 60s que el dashboard activo (refreshResolved de sources.js, store en
    // ~/.cwc-data/tickets-resolved.json, con ownerName ya stampeado). Este
    // endpoint NO toca Zoho/GitHub → responde INSTANTÁNEO, sin "pensando".
    //   · ?force=1 → dispara un refresco de fondo YA (no bloquea: no lo esperamos)
    //     y devuelve lo que hay; el front auto-refresca cuando termina.
    //   · Si el store todavía no tuvo su 1ª pasada (arranque en frío) → loading:true
    //     para que el front muestre "generando…" + reintente, en vez de vaciar.
    r.get('/resolved', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        if (req.query.force === '1' || req.query.force === 'true') {
          refreshResolved({ force: true }).catch(() => {}); // dispara y NO espera (no bloquea el request)
        }
        const { tickets: rawTickets, prs: rawPrs, meta } = readResolved();
        if (!meta.ready && !rawTickets.length && !rawPrs.length) {
          return res.json({ loading: true, refreshing: !!meta.refreshing, error: meta.error || null });
        }
        const view = buildResolved(rawTickets, Date.now());
        const tickets = view.tickets.map((t) => withClaim(t));
        const prs = rawPrs.map((pr) => ({
          number: pr.number, title: String(pr.title || '').slice(0, 120), url: pr.url,
          branch: pr.headRefName || null, author: pr.author?.login || null, authorName: pr.author?.name || null,
          mergedAt: pr.mergedAt || null, merged: true, workingBy: getActiveClaim(`pr:${pr.number}`),
        }));
        res.json({
          tickets, byLane: view.byLane, prs,
          counts: { tickets: tickets.length, prs: prs.length },
          capped: !!meta.capped, listed: meta.listed || 0, refreshing: !!meta.refreshing,
          ticketsError: meta.error || null, prError: null,
          you: actorOf(req)?.username || null, generatedAt: meta.at || Date.now(),
        });
      } catch (err) {
        res.status(500).json({ error: String(err?.message || err).slice(0, 300) });
      }
    });

    // Tomar / soltar un ticket (hard lock por usuario). El actor sale de la sesión.
    r.post('/claim', (req, res) => {
      const actor = actorOf(req);
      if (!actor) return res.status(403).json({ error: 'Requiere sesión.' });
      const id = String(req.body?.id ?? '').replace(/[^\w:-]/g, ''); // permite prefijo pr:
      if (!id) return res.status(400).json({ error: 'Falta el id del ticket.' });
      // force = ROBAR (tomar algo que tiene otro). Fase 2: permitido para cualquier
      // usuario autenticado — el gate es el diálogo de confirmación del frontend.
      const force = req.body?.force === true;
      const out = claimTicket(id, actor, { force });
      if (!out.ok) return res.status(409).json({ error: 'En uso por otro usuario.', heldBy: out.heldBy });
      res.json({ ok: true, workingBy: out.claim, you: actor.username });
    });
    r.post('/release', (req, res) => {
      const actor = actorOf(req);
      if (!actor) return res.status(403).json({ error: 'Requiere sesión.' });
      const id = String(req.body?.id ?? '').replace(/[^\w:-]/g, '');
      if (!id) return res.status(400).json({ error: 'Falta el id del ticket.' });
      const out = releaseTicket(id, actor);
      if (!out.ok) return res.status(409).json({ error: 'Solo el dueño o un admin puede soltarlo.', heldBy: out.heldBy });
      res.json({ ok: true, workingBy: null, you: actor.username });
    });

    // Contextos de prompt editables (work/pr) — migrados de v1. Los usa el
    // panel de contextos (system/project-context-panel) y se inyectan en
    // "Trabajar en el chat".
    r.get('/context', (req, res) => {
      const kind = req.query.kind === 'pr' ? 'pr' : 'work';
      const context = getContext(kind);
      res.json({ kind, context, isDefault: context === DEFAULT_CONTEXTS[kind] });
    });
    r.post('/context', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const kind = req.body?.kind === 'pr' ? 'pr' : 'work';
      const text = String(req.body?.context ?? '');
      if (!text.trim()) return res.status(400).json({ error: 'El contexto no puede quedar vacío.' });
      saveContext(kind, text);
      res.json({ ok: true, kind, context: getContext(kind), sync: verifySync() });
    });

    // Verificador del ESPEJO a Tolkien: ¿el subset work+pr en ~/tolkien/
    // CLAUDE.local.md está al día con el master de la consola? El panel lo
    // muestra como badge (✅ al día / ⚠️ desactualizado / ❌ falta) y el check
    // rápido de Salud consume el MISMO estado. 0 tokens, solo lee disco.
    r.get('/context-sync', (_req, res) => {
      res.json(verifySync());
    });
    // Re-sincronizar a mano (botón "Re-sincronizar" del panel): re-renderiza el
    // subset desde el master y lo escribe en CLAUDE.local.md.
    r.post('/context-sync', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const r2 = syncToTolkien();
      if (!r2.ok) return res.status(502).json({ error: `No se pudo sincronizar con Tolkien: ${r2.reason}` });
      res.json({ ok: true, sync: verifySync() });
    });

    // ===== Contexto adicional + Histórico del trabajo (meta-store por ítem) =====
    // `key` = ticketNumber ('123') o 'pr:<n>'. Sanitizado igual que los claims.
    const keyOf = (raw) => String(raw ?? '').replace(/[^\w:-]/g, '');

    // Interpretar una TRANSCRIPCIÓN con IA → "Contexto adicional" (runner
    // desacoplado, CONSUME TOKENS). Dedup por id determinístico (mismo texto +
    // mismo ítem = mismo job, no re-gasta). Responde YA; el front encuesta el GET.
    r.post('/meta/context-analyze', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const key = keyOf(req.body?.key);
      const transcript = String(req.body?.transcript ?? '').slice(0, MAX_TRANSCRIPT);
      if (!key) return res.status(400).json({ error: 'Falta la clave del ítem.' });
      if (transcript.trim().length < 20) return res.status(400).json({ error: 'Pegá una transcripción (mín. 20 caracteres).' });
      const id = contextJobId(key, transcript);
      const existing = readJob(id);
      if (existing && (existing.status === 'done' || isFreshRunning(existing))) {
        return res.json({ id, status: existing.status }); // reusa (no relanza ni gasta)
      }
      const now = Date.now();
      writeJob(id, {
        id, key,
        itemTitle: String(req.body?.itemTitle ?? '').slice(0, 300),
        itemDesc: String(req.body?.itemDesc ?? '').slice(0, 4000),
        transcript,
        status: 'running', result: null, rendered: null, error: null,
        startedAt: now, updatedAt: now,
      });
      spawnRunner(id);
      res.json({ id, status: 'running' });
    });
    // Poll del job (solo lee disco, 0 tokens).
    r.get('/meta/context-analyze/:jobId', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const job = jobResult(String(req.params.jobId).replace(/[^a-f0-9]/gi, ''));
      if (!job) return res.status(404).json({ error: 'Job inexistente.' });
      // No devolvemos la transcripción entera de vuelta (puede ser grande).
      const { transcript, ...rest } = job;
      res.json(rest);
    });
    // Guardar/editar (texto vacío = borrar) el contexto adicional a mano.
    // Async desde la migración a Pad local (ROAD-110 Fase 3): con try/catch
    // propio (antes no hacía falta — el store file-based nunca tiraba).
    r.post('/meta/context', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const key = keyOf(req.body?.key);
      if (!key) return res.status(400).json({ error: 'Falta la clave del ítem.' });
      try {
        const text = String(req.body?.text ?? '');
        const meta = text.trim() ? await saveContexto(key, text) : await clearContexto(key);
        res.json({ ok: true, meta });
      } catch (err) {
        res.status(500).json({ error: String(err?.message || err).slice(0, 300) });
      }
    });
    // Leer la metadata de un ítem (contexto + histórico) sin el snapshot completo.
    r.get('/meta/:key', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        res.json({ meta: await getMeta(keyOf(req.params.key)) });
      } catch (err) {
        res.status(500).json({ error: String(err?.message || err).slice(0, 300) });
      }
    });

    router.use('/tickets', r);
  },
};
