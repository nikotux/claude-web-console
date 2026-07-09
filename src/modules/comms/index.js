// modules/comms/index.js — "Comunicaciones": motor transversal que recopila,
// indexa y contextualiza las comunicaciones con cada contacto (Chris es el
// primero; el eje primario es el USUARIO — a futuro escala a muchos). Ruta
// HTTP: /api/comms.
//
// Motor FILE-BASED (ver shared.js): TODO el estado vive en ~/.cwc-data/comms/.
// Este módulo server SOLO lee/escribe ese disco y lanza el runner de escaneo;
// nada queda atado al ciclo de vida del proceso Node (regla 2/regla de oro).
// El escaneo de GitHub corre en un RUNNER DETACHED (bin/cwc-comms-runner.js).
//
// HTTP:
//   GET  /api/comms                    -> status agregado (nuevos / sin responder / contactos)
//   GET  /api/comms/index              -> índice completo (hilos + contactos + proyectos)
//   POST /api/comms/refresh            -> lanza el runner de escaneo (admin)
//   POST /api/comms/contact            -> alta de contacto {name, github} (admin)
//   POST /api/comms/project            -> alta de proyecto {name} (admin)
//   POST /api/comms/log                -> registrar comunicación manual (admin)
//   POST /api/comms/thread/:id/seen    -> marcar hilo como visto (admin)
//   POST /api/comms/thread/:id/project -> reasignar proyecto de un hilo (admin)
//   POST /api/comms/thread/:id/archive -> archivar/restaurar hilo (admin)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAdmin } from '../../core/auth.js';
import * as C from './shared.js';
import * as A from './analyze-shared.js';
import * as TS from './teams-shared.js';
import * as CB from './chatbot-shared.js';
import * as GW from './gateway-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-comms-runner.js');
const TEAMS_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-comms-teams-runner.js');
const CHATBOT_RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-comms-chatbot-runner.js');

// Lanza el runner detached. Dedup SIN carrera: isRunning() + writeLock() en el
// MISMO tick (todo sincrónico), como bugs/index.js:spawnTriage.
function spawnScan() {
  if (C.isRunning()) return false;
  C.ensureDir();
  const log = fs.openSync(C.LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.on('error', (err) => {
    try { console.error('[comms] no se pudo lanzar el runner de escaneo:', String(err?.message || err)); C.clearLock(); }
    catch { /* nunca dejar escapar del callback */ }
  });
  C.writeLock(child.pid);
  child.unref();
  fs.closeSync(log);
  return true;
}

// Lanza el runner de Teams detached (CONSUME TOKENS). Dedup por el lock propio
// de teams-shared (heartbeat). Mismo blindaje contra fallo asíncrono del spawn.
function spawnTeamsScan() {
  if (TS.isTeamsRunning()) return false;
  C.ensureDir();
  const log = fs.openSync(TS.TEAMS_LOG, 'a');
  const child = spawn(process.execPath, [TEAMS_RUNNER], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.on('error', (err) => {
    try { console.error('[comms] no se pudo lanzar el runner de Teams:', String(err?.message || err)); TS.clearTeamsLock(); }
    catch { /* nunca dejar escapar del callback */ }
  });
  TS.writeTeamsLock({ pid: child.pid, done: 0, total: 0 });
  child.unref();
  fs.closeSync(log);
  return true;
}

// Lanza el runner del CHATBOT detached (CONSUME TOKENS: Graph read + interpretación
// IA). Deriva la sección Chatbot de lo que ya escaneamos del bot de Teams. Dedup
// por su lock propio (heartbeat). Mismo blindaje contra fallo asíncrono del spawn.
function spawnChatbotScan() {
  if (CB.isChatbotRunning()) return false;
  C.ensureDir();
  const log = fs.openSync(CB.CHATBOT_LOG, 'a');
  const child = spawn(process.execPath, [CHATBOT_RUNNER], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.on('error', (err) => {
    try { console.error('[comms] no se pudo lanzar el runner de chatbot:', String(err?.message || err)); CB.clearChatbotLock(); }
    catch { /* nunca dejar escapar del callback */ }
  });
  CB.writeChatbotLock({ pid: child.pid, phase: 'arrancando' });
  child.unref();
  fs.closeSync(log);
  return true;
}

export default {
  name: 'comms',

  init() {
    try { C.ensureSeed(); } catch { /* noop */ }
  },

  registerHttp(router) {
    const r = express.Router();
    const requireAdmin = (req, res) => {
      if (!isAdmin(req)) { res.status(403).json({ error: 'Requiere administrador.' }); return false; }
      return true;
    };
    const fail = (res, e) => res.status(500).json({ error: String(e?.message || e).slice(0, 200) });

    r.get('/', (req, res) => {
      try { res.json({ ...C.buildStatus(), running: C.isRunning(), teamsRunning: TS.isTeamsRunning(), chatbotRunning: CB.isChatbotRunning() }); }
      catch (e) { fail(res, e); }
    });

    r.get('/index', (req, res) => {
      try { res.json({ ...C.buildIndex(), running: C.isRunning(), teamsRunning: TS.isTeamsRunning(), chatbotRunning: CB.isChatbotRunning() }); }
      catch (e) { fail(res, e); }
    });

    r.post('/refresh', (req, res) => {
      if (!requireAdmin(req, res)) return;
      try { const started = spawnScan(); res.json({ running: true, started }); }
      catch (e) { fail(res, e); }
    });

    // Escaneo de TEAMS (CONSUME TOKENS: MCP graph_* read-only, regla 6).
    r.post('/teams-refresh', (req, res) => {
      if (!requireAdmin(req, res)) return;
      try { const started = spawnTeamsScan(); res.json({ teamsRunning: true, started }); }
      catch (e) { fail(res, e); }
    });

    // CHATBOT (CONSUME TOKENS: Graph read del bot + interpretación IA, regla 6).
    // Deriva la sección "🤖 Chatbot" de lo que ya escaneamos del bot de Teams:
    // lee sus mensajes relayados e interpreta quién es la persona real detrás.
    r.post('/chatbot-refresh', (req, res) => {
      if (!requireAdmin(req, res)) return;
      try { const started = spawnChatbotScan(); res.json({ chatbotRunning: true, started }); }
      catch (e) { fail(res, e); }
    });

    r.post('/contact', express.json(), (req, res) => {
      if (!requireAdmin(req, res)) return;
      const { name, github, email } = req.body || {};
      if (!name && !github) return res.status(400).json({ error: 'Falta nombre o usuario de GitHub.' });
      try { res.json({ contact: C.addContact({ name, github, email }) }); }
      catch (e) { fail(res, e); }
    });

    r.post('/project', express.json(), (req, res) => {
      if (!requireAdmin(req, res)) return;
      const { name } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Falta el nombre del proyecto.' });
      try { res.json({ project: C.addProject({ name }) }); }
      catch (e) { fail(res, e); }
    });

    r.post('/log', express.json(), (req, res) => {
      if (!requireAdmin(req, res)) return;
      const { contactId, text, direction, project, url, channel, title } = req.body || {};
      if (!contactId || !text || !String(text).trim()) return res.status(400).json({ error: 'Faltan contacto o texto.' });
      try { res.json({ entry: C.appendManual({ contactId, text, direction, project, url, channel: channel || 'web', title }) }); }
      catch (e) { fail(res, e); }
    });

    r.post('/thread/:id/seen', (req, res) => {
      if (!requireAdmin(req, res)) return;
      try { res.json({ override: C.setOverride(req.params.id, { seenTs: Date.now() }) }); }
      catch (e) { fail(res, e); }
    });

    r.post('/thread/:id/project', express.json(), (req, res) => {
      if (!requireAdmin(req, res)) return;
      const p = req.body?.project;
      try { res.json({ override: C.setOverride(req.params.id, { project: p ? String(p).slice(0, 60) : null }) }); }
      catch (e) { fail(res, e); }
    });

    r.post('/thread/:id/archive', express.json(), (req, res) => {
      if (!requireAdmin(req, res)) return;
      try { res.json({ override: C.setOverride(req.params.id, { archived: req.body?.archived !== false }) }); }
      catch (e) { fail(res, e); }
    });

    // Análisis IA del hilo (resumen + clasificación) — DESACOPLADO (regla de
    // oro): el POST escribe el job pendiente + spawnea el runner; consume tokens
    // (haiku, 1 turno, CERO herramientas — regla 6). El GET solo lee disco.
    r.post('/thread/:id/analyze', (req, res) => {
      if (!requireAdmin(req, res)) return;
      try {
        const idx = C.buildIndex();
        const t = idx.threads.find((x) => x.id === req.params.id);
        if (!t) return res.status(404).json({ error: 'Hilo no encontrado.' });
        const c = idx.contacts.find((x) => x.id === t.contactId);
        const text = A.threadText(t, c?.name || t.contactId);
        const jobId = A.analyzeJobId(t.id, A.threadHash(text));
        const existing = A.readAnalyzeJob(jobId);
        if (existing && (existing.status === 'done' || A.isFreshRunning(existing))) {
          return res.json({ id: jobId, ...A.jobResult(existing) });
        }
        A.writeAnalyzeJob(jobId, { threadId: t.id, contactName: c?.name || t.contactId, text, status: 'running', startedAt: Date.now() });
        A.spawnAnalyzeRunner(jobId);
        res.json({ id: jobId, status: 'running', analysis: null, error: null });
      } catch (e) { fail(res, e); }
    });

    // GET del análisis (0 tokens, autenticados): el front encuesta hasta 'done'.
    r.get('/thread/:id/analyze/:jobId', (req, res) => {
      try {
        const job = A.readAnalyzeJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Análisis no encontrado.' });
        res.json({ id: req.params.jobId, ...A.jobResult(job) });
      } catch (e) { fail(res, e); }
    });

    // ===== GATEWAY DE ENVÍO: comms EJECUTA la comunicación externa =====
    // POST /api/comms/send: valida + ejecuta (github inline · desk/teams runner)
    // + registra en outbox + devuelve el resultado. dryRun=true no envía nada.
    r.post('/send', express.json(), async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const { channel, action, payload, contactId, actor, dryRun } = req.body || {};
      if (!channel || !action) return res.status(400).json({ error: 'Faltan channel y action.' });
      try {
        const out = await GW.sendComm({ channel, action, payload: payload || {}, contactId: contactId || null, actor: actor || 'api', dryRun: !!dryRun });
        res.json(out);
      } catch (e) { res.status(400).json({ error: String(e?.message || e).slice(0, 200) }); }
    });

    // GET del resultado de un envío diferido (desk/teams).
    r.get('/send/:jobId', (req, res) => {
      try {
        const job = GW.readSendJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Envío no encontrado.' });
        res.json({ id: req.params.jobId, ...GW.sendJobResult(job) });
      } catch (e) { fail(res, e); }
    });

    // GET del outbox (ledger de todo lo ejecutado) — auditoría, autenticados.
    r.get('/outbox', (req, res) => {
      try { res.json({ entries: C.readOutbox().slice(-100).reverse() }); }
      catch (e) { fail(res, e); }
    });

    router.use('/comms', r);
  },
};
