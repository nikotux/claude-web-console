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
//   POST /api/interfono/claim-release {file} -> libera un claim propio o, si
//        es host/admin, cualquiera
import express from 'express';
import * as bus from '../../core/bus.js';
import { readDeliveries } from '../../core/interfono-log.js';
import { loadOwners } from '../../core/session-names.js';
import { systemScopeFor } from '../../core/system-scope.js';
import { manager as chatManager } from '../chat/index.js';

const BROADCAST_RE = /^(all|todos|todas|broadcast)$/i;

// Handles del bus cuyo dueño es el usuario del request. No se cachean: tanto
// chat.owner como session-owners.json pueden cambiar mientras el panel está
// abierto y el endpoint se consulta cada 5 s.
//
// - claude:<sessionId> y tmux:cwct-<terminalId> salen de Chat.list(), que ya
//   aplica el owner scopeado (las cwct-* son la vista TUI de ese mismo chat).
// - tmux:cwc-<id> sale del registro durable de dueños de terminal.
// Cualquier otro handle queda fuera (fail-closed).
function ownedHandlesFor(scope) {
  const handles = new Set();
  const principal = { username: scope.user, admin: false };
  for (const chat of chatManager.list(principal)) {
    if (chat.sessionId) handles.add(`claude:${chat.sessionId}`);
    if (chat.viewMode === 'tui' && chat.terminalId) {
      handles.add(`tmux:cwct-${chat.terminalId}`);
    }
  }
  for (const [id, owner] of Object.entries(loadOwners())) {
    if (owner === scope.user) handles.add(`tmux:cwc-${id}`);
  }
  return handles;
}

function visibleToOwner(row, ownedHandles) {
  return ownedHandles.has(row?.from) || ownedHandles.has(row?.to);
}

// El frontend manda handles exactos del <select>. Conservamos además nombre y
// PKG-N para clientes existentes, pero resolvemos SOLO dentro del directorio
// propio: un error nunca enumera ni confirma sesiones ajenas.
function resolveOwnedTarget(arg, directory) {
  const q = String(arg || '').trim();
  if (!q || BROADCAST_RE.test(q)) return null;
  const byHandle = directory.find((entry) => entry.handle === q);
  if (byHandle) return { handle: byHandle.handle, name: byHandle.name, entry: byHandle };
  const upper = q.toUpperCase();
  const byPackage = directory.filter((entry) => String(entry.packageRef || '').toUpperCase() === upper);
  if (byPackage.length === 1) {
    const [entry] = byPackage;
    return { handle: entry.handle, name: entry.name, entry };
  }
  const lc = q.toLowerCase();
  const exact = directory.filter((entry) => entry.name.toLowerCase() === lc);
  const pool = exact.length ? exact : directory.filter((entry) => entry.name.toLowerCase().includes(lc));
  if (pool.length !== 1) return null;
  const [entry] = pool;
  return { handle: entry.handle, name: entry.name, entry };
}

// express.json() falla ANTES del handler cuando el body no parsea y llama a
// next(err); como el proyecto no tiene middleware de errores global, esa
// request saldría con el HTML por defecto de Express en vez de JSON y rompería
// el contrato de la API. Este wrapper captura el error del parser y responde
// JSON, igual que el resto de las rutas del módulo.
function jsonBody(options) {
  const parse = express.json(options);
  return (req, res, next) => parse(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({ error: 'El cuerpo del pedido no es JSON válido.' });
  });
}

export default {
  name: 'interfono',

  registerHttp(router) {
    const r = express.Router();

    // Estado completo para el panel (semáforo por claim vía evaluateClaim).
    r.get('/', (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const privileged = scope.admin || scope.isHost;
        const fullDirectory = bus.buildDirectory();
        const ownedHandles = privileged ? null : ownedHandlesFor(scope);
        const directory = privileged
          ? fullDirectory
          : fullDirectory.filter((entry) => ownedHandles.has(entry.handle));
        const allClaims = bus.allClaims().map((c) => ({ ...c, verdict: bus.evaluateClaim(c) }));
        const claims = privileged
          ? allClaims
          : allClaims.filter((claim) => ownedHandles.has(claim.handle));
        const allMessages = bus.allMessages(fullDirectory);
        const messages = privileged
          ? allMessages
          : allMessages.filter((message) => visibleToOwner(message, ownedHandles));
        // R6 ("nada se pierde en silencio"): lápidas de claims robados aún no
        // entregadas al handle afectado — solo LECTURA (tombstonesFor no
        // marca delivered; eso lo hace únicamente el hook-inject real de una
        // sesión al recibirlas).
        const tombstones = bus.tombstonesFor(directory.map((e) => e.handle));
        res.json({
          directory,
          messages,
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
        const scope = systemScopeFor(req);
        const privileged = scope.admin || scope.isHost;
        const ownedHandles = privileged ? null : ownedHandlesFor(scope);
        const deliveries = privileged
          ? readDeliveries(limit)
          : readDeliveries(1000)
            .filter((delivery) => visibleToOwner(delivery, ownedHandles))
            .slice(0, limit);
        res.json({ deliveries, ts: Date.now() });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo leer la bitácora.', detail: String(e?.message || e) });
      }
    });

    // Mensaje manual desde la consola web hacia una sesión (o "all").
    r.post('/send', jsonBody(), (req, res) => {
      try {
        const { to, text, packageRef } = req.body || {};
        if (typeof to !== 'string' || typeof text !== 'string' || !to.trim() || !text.trim()) {
          return res.status(400).json({ error: 'Faltan destino o mensaje.' });
        }
        if (text.length > 4000) {
          return res.status(400).json({ error: 'El mensaje no puede superar los 4000 caracteres.' });
        }
        const scope = systemScopeFor(req);
        const privileged = scope.admin || scope.isHost;
        if (!privileged && BROADCAST_RE.test(to.trim())) {
          return res.status(403).json({ error: 'El broadcast está disponible solo para admin/host. Elegí una de tus sesiones.' });
        }
        const ownedHandles = privileged ? null : ownedHandlesFor(scope);
        const target = privileged
          ? bus.resolveTarget(to)
          : resolveOwnedTarget(
            to,
            bus.buildDirectory().filter((entry) => ownedHandles.has(entry.handle)),
          );
        if (!target || target.error) {
          const error = privileged ? target?.error : 'No encontré una sesión propia con ese destino.';
          return res.status(404).json({ error });
        }
        const from = `consola (${scope.user})`;
        const msg = bus.sendMessage({
          from: 'web:console', fromName: from,
          to: target.handle, toName: target.name, text,
          // PLAN-469 · 4a: pasar un paquete-sesión junto al mensaje (opcional).
          packageRef: /^PKG-\d+$/i.test(String(packageRef || '')) ? String(packageRef).toUpperCase() : null,
        });
        res.json({ ok: true, id: msg.id, toName: target.name });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo enviar el mensaje.', detail: String(e?.message || e) });
      }
    });

    // Liberar un claim a mano (red de seguridad humana para zombis). El panel
    // solo muestra esta acción global al admin; el backend también admite que
    // un no-admin libere un claim propio, nunca uno ajeno.
    r.post('/claim-release', jsonBody(), (req, res) => {
      try {
        const scope = systemScopeFor(req);
        const privileged = scope.admin || scope.isHost;
        const CLAIM_404 = 'No hay un claim propio para ese archivo.';
        const { file, handle } = req.body || {};
        if (typeof file !== 'string' || !file || file.length > 512) {
          return res.status(400).json({ error: 'El archivo debe ser un string de hasta 512 caracteres.' });
        }
        if (handle !== undefined && (typeof handle !== 'string' || !handle || handle.length > 512)) {
          return res.status(400).json({ error: 'El handle debe ser un string de hasta 512 caracteres.' });
        }
        const claim = bus.getClaim(file);
        // Invariante 7: un no-admin no puede distinguir "no existe" de
        // "existe pero es ajeno"; mensajes distintos filtrarían actividad de
        // sesiones ajenas.
        if (!claim) {
          const error = privileged ? 'No hay un claim para ese archivo.' : CLAIM_404;
          return res.status(404).json({ error });
        }
        if (!privileged && !ownedHandlesFor(scope).has(claim.handle)) {
          return res.status(404).json({ error: CLAIM_404 });
        }
        const target = privileged ? (handle || claim.handle) : claim.handle;
        const ok = bus.releaseFile(claim.file, [target]);
        res.json({ ok, file: claim.file });
      } catch (e) {
        res.status(500).json({ error: 'No se pudo liberar el claim.', detail: String(e?.message || e) });
      }
    });

    router.use('/interfono', r);
  },
};
