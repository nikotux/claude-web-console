// modules/bugs/index.js — triage de bugs de Tolkien (skill bug-triage).
// Módulo `bugs` (antes `tickets`): backend del hub "Bugs & Features" del
// sidebar. Los archivos de runtime conservan el nombre `tickets.json`/
// `triage.lock` a propósito: describen el DATO (tickets [Tolkien Bug] de
// Zoho Desk), no el módulo. Ruta HTTP: /api/bugs.
//
// Corre el skill `bug-triage` del proyecto Tolkien vía el Agent SDK, BAJO
// DEMANDA (nunca polling: consume tokens reales), y cachea el resultado. El
// skill lee los tickets [Tolkien Bug] de Zoho Desk (MCP tolkien-mordor, que
// además corre con MORDOR_MCP_READONLY=true), los clasifica y arma una tabla.
//
// La corrida vive en un RUNNER DETACHED (bin/cwc-triage-runner.js, patrón
// cwc-chat-runner): un reinicio del server a mitad de triage YA NO lo mata —
// ese era el bug de "no se pudo correr el triage" (el server se reinicia
// seguido por deploys/push/pull). La interfaz server<->runner son dos
// archivos (ver shared.js): tickets.json (resultado) y triage.lock
// (heartbeat => `running`). La SEGURIDAD read-only de dos capas (regla 6)
// vive en el runner.
//
// HTTP:
//   GET  /api/bugs           -> { updatedAt, tickets, error, running }
//   POST /api/bugs/refresh   -> lanza el runner y responde INMEDIATO
//        (arrancar + encuestar, mismo patrón que health/review: antes el POST
//        esperaba el triage entero —1 a 3 min— y cualquier corte de red móvil
//        o reinicio tiraba error aunque la corrida siguiera). El front
//        encuesta GET hasta que `running` baja y reintenta si la corrida se
//        perdió.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAdmin } from '../../core/auth.js';
import { DATA_DIR, LOG_FILE, readCache, isRunning } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-triage-runner.js');

// Lanza el runner detached (sesión POSIX propia + unref: sobrevive al server;
// la unidad systemd ya usa KillMode=process). Dedup: acá por lock fresco, y
// el propio runner re-chequea al arrancar (carrera de doble POST).
function spawnTriage() {
  if (isRunning()) return false;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUNNER], {
    detached: true, stdio: ['ignore', log, log], env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  return true;
}

export default {
  name: 'bugs',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      res.json({ ...readCache(), running: isRunning() });
    });

    // Corre el triage (LENTO, consume tokens). El front confirma antes.
    // Admin-gated como health/review: consume tokens reales (hallazgo de salud).
    r.post('/refresh', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      try {
        spawnTriage();
        res.json({ ...readCache(), running: true, started: true });
      } catch (err) {
        res.status(500).json({ error: `No se pudo lanzar el triage: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    router.use('/bugs', r);
  },
};
