// modules/audio/index.js — Extracción de audio: cargás una transcripción (ya
// pasada a texto) y la IA interpreta quién dijo qué y por qué, la clasifica
// (acción/plan/decisión…), arma un PLAN y PROPONE tareas para el módulo `tasks`.
//
// DESACOPLADO (regla de oro): el POST /analyze persiste el job en
// <dataDir-del-dueño>/audio/<id>.json y spawnea bin/cwc-audio-runner.js
// detached; el front encuesta el GET (0 tokens, solo lee disco). Un reinicio a
// mitad NO pierde la corrida ni los tokens. Prompt/parseo/persistencia en
// ./shared.js.
//
// READ-ONLY blindado (regla 6): el runner deniega TODA herramienta — el modelo
// solo interpreta el texto que va entero en el prompt. Nunca lee/escribe disco.
//
// HTTP:
//   GET  /api/audio             -> [ {id,title,status,createdAt,proposedCount,...} ]  (historial)
//   GET  /api/audio/:id         -> { id, title, transcript, status, result, error }
//   POST /api/audio/analyze     -> { id, status:'running' }  (admin: consume tokens)
//   POST /api/audio/:id/delete  -> { ok }
import express from 'express';
import { isAdmin, principalOf } from '../../core/auth.js';
import { userDataDir, userRunnerEnv, hostUser } from '../../core/user-space.js';
import {
  audioJobId, readAudioJob, writeAudioJob, deleteAudioJob, listAudioJobs,
  spawnAudioRunner, jobResult, isFreshRunning, MAX_TRANSCRIPT,
} from './shared.js';

const ID_RE = /^[0-9a-f]{24}$/;
const ownerOf = (req) => principalOf(req)?.username || hostUser();

export default {
  name: 'audio',

  registerHttp(router) {
    const r = express.Router();

    // El aislamiento de ambos GET es ESTRUCTURAL: cada principal lee solo su
    // directorio; no hay filtro en memoria que un handler nuevo pueda olvidar.
    r.get('/', (req, res) => {
      try {
        const dataDir = userDataDir(ownerOf(req));
        res.json({ jobs: listAudioJobs(dataDir) });
      }
      catch { res.status(500).json({ error: 'No se pudo leer el historial de audio.' }); }
    });

    // Un análisis completo (incluye la transcripción original y el resultado).
    r.get('/:id', (req, res) => {
      try {
        const dataDir = userDataDir(ownerOf(req));
        const id = String(req.params.id);
        if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });
        const job = readAudioJob(dataDir, id);
        if (!job) return res.status(404).json({ error: 'Análisis inexistente (¿expiró?).' });
        res.json({ id, title: job.title || '', transcript: job.transcript || '', ...jobResult(job) });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    // Lanza el análisis: persiste el job + spawnea el runner detached, responde
    // YA. Admin porque consume tokens. Id determinístico por contenido: un
    // reintento reusa el MISMO job (no relanza ni gasta de nuevo).
    r.post('/analyze', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador (consume tokens).' });
      const transcript = String(req.body?.transcript ?? '');
      const title = String(req.body?.title ?? '').slice(0, 200).trim();
      if (transcript.trim().length < 10) {
        return res.status(400).json({ error: 'Pegá la transcripción (texto del audio) primero.' });
      }
      if (transcript.length > MAX_TRANSCRIPT) {
        return res.status(413).json({ error: `La transcripción excede el máximo (${MAX_TRANSCRIPT} caracteres).` });
      }
      try {
        const owner = ownerOf(req);
        const dataDir = userDataDir(owner);
        // El id depende SOLO de la transcripción (el título ya no es manual: lo
        // genera la IA y se puede editar después, así que no puede ser parte de
        // la identidad del job).
        const id = audioJobId(transcript);
        const existing = readAudioJob(dataDir, id);
        if (existing && (isFreshRunning(existing) || existing.status === 'done')) {
          return res.json({ id, title: existing.title || title, ...jobResult(existing) });
        }
        // titleAuto = el runner rellenará el título con el que genere la IA. Si el
        // usuario mandó uno explícito (uso programático) o ya había editado el
        // título del job anterior (titleAuto:false), se preserva.
        const keepTitle = title || existing?.title || '';
        const keepAuto = title ? false : (existing ? existing.titleAuto : true);
        writeAudioJob(dataDir, id, {
          id, title: keepTitle, titleAuto: keepAuto, transcript, status: 'running',
          result: null, error: null, startedAt: Date.now(), updatedAt: Date.now(),
        });
        try {
          const runnerEnv = owner === hostUser() ? undefined : userRunnerEnv(owner);
          spawnAudioRunner(dataDir, id, runnerEnv);
        } catch (spawnErr) {
          // Fallo SÍNCRONO antes del spawn (mkdir/open del log): el job quedaría
          // 'running' colgado hasta volverse stale. Lo marcamos 'error' ya.
          const msg = String(spawnErr?.message || spawnErr).slice(0, 300);
          writeAudioJob(dataDir, id, { id, title: keepTitle, titleAuto: keepAuto, transcript, status: 'error', result: null, error: msg, startedAt: Date.now(), updatedAt: Date.now() });
          return res.status(500).json({ error: msg });
        }
        res.json({ id, title: keepTitle, status: 'running', result: null, error: null });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    r.post('/:id/delete', (req, res) => {
      try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
        const dataDir = userDataDir(ownerOf(req));
        const id = String(req.params.id);
        if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });
        deleteAudioJob(dataDir, id);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    // Editar el título de un análisis ya creado (el que generó la IA, o uno
    // propio). Marca titleAuto=false para que un re-análisis no lo pise.
    r.post('/:id/title', (req, res) => {
      try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
        const dataDir = userDataDir(ownerOf(req));
        const id = String(req.params.id);
        if (!ID_RE.test(id)) return res.status(400).json({ error: 'Id inválido.' });
        const title = String(req.body?.title ?? '').slice(0, 200).trim();
        if (!title) return res.status(400).json({ error: 'El título no puede estar vacío.' });
        const job = readAudioJob(dataDir, id);
        if (!job) return res.status(404).json({ error: 'Análisis inexistente (¿expiró?).' });
        writeAudioJob(dataDir, id, { ...job, title, titleAuto: false, updatedAt: Date.now() });
        res.json({ ok: true, title });
      } catch (e) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
      }
    });

    router.use('/audio', r);
  },
};
