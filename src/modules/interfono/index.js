// modules/interfono/index.js — panel "Interfono" (comunicación entre sesiones).
//
// Superficie HTTP del bus de sesiones (src/core/bus.js). Solo LEE el estado en
// disco (~/.cwc-data/session-bus/, 0 tokens) y ofrece un canal MANUAL para que
// el usuario mande un mensaje a cualquier sesión desde la web, más la
// liberación admin de un claim zombi que se haya escapado.
//
// La mensajería/claims automáticos entre sesiones NO pasan por acá: los generan
// los hooks de Claude Code (bin/cwc-bus.js). Este módulo es la VENTANA + el
// canal humano.
//
// HTTP:
//   GET  /api/interfono              -> { directory, messages, claims+verdict, tombstones }
//   POST /api/interfono/send {to,text} -> mensaje manual desde la consola
//   POST /api/interfono/claim-release {file} (admin) -> libera un claim a mano
import express from 'express';
import { isAdmin, principalOf } from '../../core/auth.js';
import * as bus from '../../core/bus.js';
import { readDeliveries } from '../../core/interfono-log.js';

export default {
  name: 'interfono',

  registerHttp(router) {
    const r = express.Router();

    // Estado completo para el panel (semáforo por claim vía evaluateClaim).
    r.get('/', (req, res) => {
      try {
        const directory = bus.buildDirectory();
        const claims = bus.allClaims().map((c) => ({ ...c, verdict: bus.evaluateClaim(c) }));
        // R6 ("nada se pierde en silencio"): lápidas de claims robados aún no
        // entregadas al handle afectado — solo LECTURA (tombstonesFor no
        // marca delivered; eso lo hace únicamente el hook-inject real de una
        // sesión al recibirlas).
        const tombstones = bus.tombstonesFor(directory.map((e) => e.handle));
        res.json({
          directory,
          messages: bus.allMessages(directory),
          claims,
          tombstones,
          ts: Date.now(),
        });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo leer el estado del Interfono.', detail: String(e?.message || e) });
      }
    });

    // BITÁCORA de entrega (rediseño 2026-07-10, Fase 2.4): materializa R6
    // ("nada se pierde en silencio"). Solo LEE ~/.cwc-data/session-bus/
    // delivery-log.jsonl (0 tokens). Por qué ruta llegó cada mensaje al humano.
    r.get('/deliveries', (req, res) => {
      try {
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
        res.json({ deliveries: readDeliveries(limit), ts: Date.now() });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo leer la bitácora.', detail: String(e?.message || e) });
      }
    });

    // Mensaje manual desde la consola web hacia una sesión (o "all").
    r.post('/send', express.json(), (req, res) => {
      try {
        const { to, text, packageRef } = req.body || {};
        if (!to || !text || !String(text).trim()) {
          return res.status(400).json({ error: 'Faltan destino o mensaje.' });
        }
        const target = bus.resolveTarget(to);
        if (target.error) return res.status(404).json({ error: target.error });
        const who = principalOf(req);
        const from = who?.username ? `consola (${who.username})` : 'consola web';
        const msg = bus.sendMessage({
          from: 'web:console', fromName: from,
          to: target.handle, toName: target.name, text: String(text),
          // PLAN-469 · 4a: pasar un paquete-sesión junto al mensaje (opcional).
          packageRef: /^PKG-\d+$/i.test(String(packageRef || '')) ? String(packageRef).toUpperCase() : null,
        });
        res.json({ ok: true, id: msg.id, toName: target.name });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo enviar el mensaje.', detail: String(e?.message || e) });
      }
    });

    // Liberar un claim a mano (red de seguridad humana para zombis). Admin.
    r.post('/claim-release', express.json(), (req, res) => {
      try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
        const { file, handle } = req.body || {};
        const claim = file ? bus.getClaim(file) : null;
        if (!claim) return res.status(404).json({ error: 'No hay un claim para ese archivo.' });
        const target = handle || claim.handle;
        const ok = bus.releaseFile(claim.file, [target]);
        res.json({ ok, file: claim.file });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo liberar el claim.', detail: String(e?.message || e) });
      }
    });

    router.use('/interfono', r);
  },
};
