// modules/publish/index.js — "Publicar a la consola" (PLAN-488).
//
// Endpoint admin que PUBLICA el repo interno al repo limpio (la-consola) vía el
// runner desacoplado bin/cwc-publish-runner.js. El server NO hace git: solo
// reserva el estado, lanza el runner y sirve el estado persistido (0 tokens).
//
// HTTP:
//   POST /api/publish   -> lanza la publicación (admin). Responde inmediato.
//   GET  /api/publish   -> estado de la última/actual publicación (admin).
import express from 'express';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAdmin } from '../../core/auth.js';
import { readState, writeState, isRunning } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(__dirname, '..', '..', '..', 'bin', 'cwc-publish-runner.js');

function spawnRunner() {
  const child = spawn(process.execPath, [RUNNER], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', (err) => { try { console.error('[publish] no se pudo lanzar el runner:', String(err?.message || err)); } catch { /* noop */ } });
  child.unref();
}

export default {
  name: 'publish',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const state = readState();
      res.json({ state, running: isRunning(state) });
    });

    r.post('/', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const state = readState();
      if (isRunning(state)) {
        return res.status(409).json({ error: 'Ya hay una publicación en curso.', state, running: true });
      }
      // Reserva sincrónica del estado ANTES de spawnear (dedup anti-carrera).
      writeState({ status: 'running', phase: 'iniciando', startedAt: Date.now(), result: null, error: null });
      spawnRunner();
      res.json({ ok: true, running: true, state: readState() });
    });

    router.use('/publish', r);
  },
};
