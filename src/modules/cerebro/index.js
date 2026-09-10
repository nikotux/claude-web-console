/*
 * Backend de la vista Cerebro (console:PLAN-2843): expone el grafo del Pad
 * local y refleja en vivo su actividad para que el frontend dibuje la red.
 *
 * GET /api/cerebro/graph devuelve {ok:true, graph:{nodes,edges}} o, si el Pad
 * no está disponible, {ok:false,error} con HTTP 200. GET /api/cerebro/stream
 * abre un SSE con `hello` {ts}, `status` {padOk} y `pulse`
 * {kind,action,ref,title,collection,actor,ts}; los comentarios `: ping` son
 * heartbeats de transporte. Ambos endpoints exigen `oversight`, porque exponen
 * actividad y títulos del Pad del host y nunca deben quedar visibles para un
 * inquilino. POST /api/cerebro/diag recibe diagnóstico acotado de cualquier
 * sesión autenticada y GET /api/cerebro/diag lo expone solo con `oversight`.
 *
 * El módulo no tiene estado DURABLE a propósito: solo conserva en RAM los
 * últimos diagnósticos y el estado efímero del espejo en vivo. Los timers viven
 * mientras haya un cliente SSE conectado y mueren con el último. Tras un
 * reinicio del server, el buffer se pierde, el `EventSource` del navegador
 * reconecta solo (`retry: 3000`) y la vista se re-pinta desde `/graph`.
 */
import express from 'express';
import { principalOf } from '../../core/auth.js';
import { getActivity, getCompleteGraph, getGraph, padTelemetry } from '../../core/pad-service-client.js';

const WORKSPACE = 'console';
const POLL_MS = 2000;
const HEARTBEAT_MS = 25000;
const ACTIVITY_LIMIT = 30;
const MAX_CLIENTS = 12;
const SEEN_CAP = 500;
const MAX_PULSES_PER_SEC = 40;
const DIAG_REPORT_LIMIT = 20;
const DIAG_ERROR_LIMIT = 10;
const DIAG_STRING_LIMIT = 500;
const DIAG_MAX_DIMENSION = 100000;
const DIAG_MAX_LINE = 10000000;
const COMPLETE_GRAPH_CACHE_MS = 20_000;

const clients = new Set();
let pollTimer = null;
let hbTimer = null;
let polling = false;
let seeded = false;
let padOk = null;
const seen = new Set();
const seenOrder = [];
// Instrumentación temporal para el blanco remoto que no se reproduce en el
// entorno de verificación. Nunca persiste ni conserva contenido sin acotar.
const diagnosticReports = [];
let pulseWindowStarted = Date.now();
let pulseCount = 0;
let completeGraphCache = null;
let completeGraphInFlight = null;

async function getCachedCompleteGraph() {
  if (completeGraphCache && completeGraphCache.expiresAt > Date.now()) {
    return completeGraphCache.result;
  }
  if (completeGraphInFlight) return completeGraphInFlight;
  completeGraphInFlight = getCompleteGraph()
    .then((result) => {
      if (result.ok) {
        completeGraphCache = { result, expiresAt: Date.now() + COMPLETE_GRAPH_CACHE_MS };
      }
      return result;
    })
    .finally(() => { completeGraphInFlight = null; });
  return completeGraphInFlight;
}

function hasOversight(req) {
  const p = principalOf(req);
  return !!(p && p.oversight);
}

function clippedString(value) {
  return typeof value === 'string' ? value.slice(0, DIAG_STRING_LIMIT) : '';
}

function boundedNumber(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(0, value));
}

function sanitizeCanvas(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.exists !== true) {
    return { exists: false };
  }
  return {
    exists: true,
    width: boundedNumber(value.width, DIAG_MAX_DIMENSION),
    height: boundedNumber(value.height, DIAG_MAX_DIMENSION),
  };
}

function sanitizeErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, DIAG_ERROR_LIMIT).map((error) => ({
    message: clippedString(error?.message),
    file: clippedString(error?.file),
    line: boundedNumber(error?.line, DIAG_MAX_LINE),
  }));
}

function sanitizeDiagnostic(value) {
  const report = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Whitelist cerrada: ninguna clave adicional enviada por el navegador llega
  // al buffer ni vuelve a salir por el endpoint de lectura.
  return {
    ua: clippedString(report.ua),
    url: clippedString(report.url),
    dpr: boundedNumber(report.dpr, 100),
    viewport: clippedString(report.viewport),
    webgl: clippedString(report.webgl),
    importMapSupport: report.importMapSupport === true,
    moduleRan: report.moduleRan === true,
    cssVarCerBg: clippedString(report.cssVarCerBg),
    cssVarCwcBg: clippedString(report.cssVarCwcBg),
    resolvedBg: clippedString(report.resolvedBg),
    supportsColorMix: report.supportsColorMix === true,
    bodyBg: clippedString(report.bodyBg),
    canvas: sanitizeCanvas(report.canvas),
    hudText: clippedString(report.hudText),
    errors: sanitizeErrors(report.errors),
  };
}

function pulseAllowed() {
  const now = Date.now();
  if (now - pulseWindowStarted >= 1000) {
    pulseWindowStarted = now;
    pulseCount = 0;
  }
  if (pulseCount >= MAX_PULSES_PER_SEC) return false;
  pulseCount += 1;
  return true;
}

function sendEvent(client, event, data) {
  try {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    clients.delete(client);
    return false;
  }
}

function broadcast(event, data) {
  // Una ráfaga (por ejemplo, un warm-up de caché o un barrido) no puede
  // inundar el navegador. `hello`, `status` y los heartbeats no se limitan.
  if (event === 'pulse' && !pulseAllowed()) return;

  try {
    for (const client of clients) {
      try {
        client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
    if (clients.size === 0) stopLoops();
  } catch {
    // La observabilidad nunca puede propagarse como un error del Pad o del server.
  }
}

function remember(id) {
  seen.add(id);
  seenOrder.push(id);
  while (seenOrder.length > SEEN_CAP) {
    seen.delete(seenOrder.shift());
  }
}

async function pollActivity() {
  if (polling) return;
  polling = true;
  try {
    let result;
    try {
      result = await getActivity({ limit: ACTIVITY_LIMIT });
    } catch {
      result = { ok: false };
    }

    // Un poll que terminó después de la desconexión del último cliente no debe
    // reconstruir el estado que stopLoops acaba de limpiar.
    if (clients.size === 0) return;

    if (padOk !== result.ok) {
      padOk = result.ok;
      broadcast('status', { padOk });
    }
    if (!result.ok || !Array.isArray(result.data)) return;

    const fresh = [];
    // El feed llega del más nuevo al más viejo; la emisión preserva el orden
    // cronológico para que los pulsos se dibujen como realmente ocurrieron.
    for (const event of [...result.data].reverse()) {
      if (!event?.id || seen.has(event.id)) continue;
      remember(event.id);
      fresh.push(event);
    }

    // La primera vuelta solo siembra el dedup. Emitirla haría que cada apertura
    // de la vista pareciera generar una ráfaga de 30 operaciones antiguas.
    if (!seeded) {
      seeded = true;
      return;
    }

    for (const event of fresh) {
      broadcast('pulse', {
        kind: 'write',
        action: event.action,
        ref: event.item_ref || null,
        title: event.item_title || null,
        collection: event.collection_slug || null,
        actor: event.actor || null,
        ts: event.created_at || new Date().toISOString(),
      });
    }
  } finally {
    polling = false;
    if (clients.size === 0) stopLoops();
  }
}

function onPadTelemetry(event) {
  // Las escrituras ya llegan por /activity; emitirlas también acá duplicaría
  // el pulso.
  if (!event || event.op !== 'read') return;
  // console:PEND-2855: la actividad tenant-* jamás sale por el Cerebro del host.
  if (event.workspace !== WORKSPACE) return;
  // `ref: null` es legítimo: indica una lectura a nivel colección y el frontend
  // ilumina el clúster completo de esa colección.
  broadcast('pulse', {
    kind: 'read',
    action: 'read',
    ref: event.ref || null,
    title: null,
    collection: event.collection || null,
    actor: null,
    ts: event.ts || new Date().toISOString(),
  });
}

function heartbeat() {
  for (const client of clients) {
    try {
      client.write(': ping\n\n');
    } catch {
      clients.delete(client);
    }
  }
  if (clients.size === 0) stopLoops();
}

function startLoops() {
  if (pollTimer) return;
  padTelemetry.on('pad', onPadTelemetry);
  pollTimer = setInterval(() => { void pollActivity(); }, POLL_MS);
  hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
  pollTimer.unref?.();
  hbTimer.unref?.();
  void pollActivity();
}

function stopLoops() {
  if (pollTimer) clearInterval(pollTimer);
  if (hbTimer) clearInterval(hbTimer);
  pollTimer = null;
  hbTimer = null;
  padTelemetry.off('pad', onPadTelemetry);
  seen.clear();
  seenOrder.length = 0;
  seeded = false;
  padOk = null;
  pulseWindowStarted = Date.now();
  pulseCount = 0;
}

export default {
  name: 'cerebro',

  registerHttp(router, ctx) {
    const r = express.Router();

    r.post('/diag', (req, res) => {
      // Instrumentación temporal: el gate global de /api ya exige autenticación,
      // pero lo repetimos acá para mantener explícito que NO exige oversight.
      if (!principalOf(req)) {
        return res.status(401).json({ ok: false, error: 'Requiere sesión autenticada.' });
      }

      // El body ya está limitado por express.json({ limit: '256kb' }) global.
      diagnosticReports.push(sanitizeDiagnostic(req.body));
      if (diagnosticReports.length > DIAG_REPORT_LIMIT) diagnosticReports.shift();
      return res.json({ ok: true });
    });

    r.get('/diag', (req, res) => {
      if (!hasOversight(req)) {
        return res.status(403).json({ ok: false, error: 'Requiere permiso de supervisión (oversight).' });
      }
      return res.json({ ok: true, reports: diagnosticReports.slice() });
    });

    r.get('/graph', async (req, res) => {
      // Estos endpoints exponen actividad y títulos del Pad del HOST; un
      // inquilino jamás debe verlos. `oversight` se resuelve en vivo por request.
      if (!hasOversight(req)) {
        return res.status(403).json({ ok: false, error: 'Requiere permiso de supervisión (oversight).' });
      }

      // Se llama sin ctx: la vista muestra el Pad del HOST (`console`) y la
      // autorización para verlo la decide el gate `oversight`.
      const g = req.query.completed === '1'
        ? await getCachedCompleteGraph()
        : await getGraph();
      if (g.ok) return res.json({ ok: true, graph: g.data });
      // HTTP 200 es deliberado: la vista degrada con gracia, avisa y reintenta
      // en vez de explotar por un fetch rechazado (criterio C5 del ancla).
      return res.status(200).json({ ok: false, error: g.error || 'Pad local no disponible.' });
    });

    r.get('/stream', (req, res) => {
      // Mismo límite de privacidad que /graph: ni títulos ni actividad del host
      // pueden cruzarse hacia un inquilino.
      if (!hasOversight(req)) {
        return res.status(403).json({ ok: false, error: 'Requiere permiso de supervisión (oversight).' });
      }
      if (clients.size >= MAX_CLIENTS) {
        return res.status(503).json({ ok: false, error: 'Demasiadas conexiones simultáneas a la vista Cerebro.' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform es OBLIGATORIO: el middleware compression() del server bufferea
        // por defecto y un stream SSE comprimido no llega nunca. compression() respeta
        // no-transform y deja pasar el stream tal cual.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.socket?.setNoDelay?.(true);
      res.write('retry: 3000\n\n');

      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        if (clients.size === 0) stopLoops();
      });

      sendEvent(res, 'hello', { ts: new Date().toISOString() });
      if (clients.has(res) && padOk !== null) sendEvent(res, 'status', { padOk });
      if (clients.has(res)) startLoops();
    });

    router.use('/cerebro', r);
  },
};
