#!/usr/bin/env node
// bin/cwc-triage-runner.js — corrida del triage de bugs, DESACOPLADA del server.
//
// El server la lanza detached (setsid, igual que cwc-chat-runner): si el
// server web se reinicia a mitad del triage (deploy, push/pull, crash), la
// corrida SIGUE y el resultado igual llega a la caché — el bug que motivó
// esto era exactamente "no se pudo correr el triage" por reinicios en vuelo.
// Regla 2 de CLAUDE.md: nada en curso atado al ciclo de vida del Node.
//
// Interfaz (ver shared.js): tickets.json = resultado; triage.lock = heartbeat
// {pid, ts} mientras corre (el server responde `running` según su frescura).
// Único argumento opcional: --full (ignora la caché incremental por ticket).
// Log en ~/.cwc-data/triage.log (lo redirige el spawn).
//
// CACHÉ INCREMENTAL por ticket (optimización IA 2026-07-05, patrón
// health-audit-cache de salud F2): el fingerprint del listado de fase 1
// (ticketFingerprint de shared.js — status+subject; el MCP de Tolkien recorta
// modifiedTime del payload, verificado en zoho-tools.ts) se compara contra
// ~/.cwc-data/triage-cache.json y los tickets SIN cambios con triage cacheado
// FRESCO (< TICKET_CACHE_TTL_MS, 12 h — la señal no ve comentarios nuevos:
// staleness acotada) reusan el triage anterior sin abrir query() (0 tokens) —
// solo se re-triagea lo que cambió, es nuevo o venció. La caché se escribe UNA
// vez tras la barrera del pool y SOLO con tickets abiertos (los cerrados caen
// solos); los fallidos no se cachean (se reintentan). --full la ignora (red
// de seguridad).
//
// DOS FASES EN PARALELO (optimización IA 2026-07-05, patrón desk-runner):
// (1) una query BARATA que solo LISTA los tickets [Tolkien Bug] abiertos;
// (2) el triage de CADA ticket en paralelo vía runAdaptivePool (health F2.5)
// — una query corta por ticket que escribe SU entrada INCREMENTAL en
// tickets.json. Antes era UNA conversación serial de 6 min: un timeout a
// mitad de camino tiraba el intento completo; ahora pierde solo el ticket
// en vuelo. Regla de oro del paralelismo: paralelo lo que LEE (esto es
// read-only), serial lo que ESCRIBE (la caché la escribe solo este proceso,
// single-thread).
//
// SEGURIDAD: misma corrida READ-ONLY blindada por DOS capas (regla 6):
// hook PreToolUse (deniega ANTES de la evaluación de permisos) + canUseTool
// como allowlist de lecturas — EN CADA query de las dos fases.
// settingSources 'headless' (sin user).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import { runAdaptivePool } from '../src/modules/health/pool.js';
import {
  LIST_PROMPT, perTicketPrompt, toolAllowed, parseTicketList, parseTicketTriage,
  normalizeTicket, readCache, writeCache, writeLock, clearLock, readLock,
  readTicketCache, writeTicketCache, ticketFingerprint, TICKET_CACHE_TTL_MS,
  LIST_TIMEOUT_MS, TICKET_TIMEOUT_MS, LIST_MAX_TURNS, TICKET_MAX_TURNS,
  HEARTBEAT_MS, LOCK_FRESH_MS,
} from '../src/modules/bugs/shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const FULL = process.argv.includes('--full');

// Dedup entre procesos: si OTRO runner ya late, este sobra. OJO: el server
// (spawnTriage) RESERVA el lock con NUESTRO pid en el mismo tick del spawn
// (cierra la carrera de doble POST — antes el lock recién se escribía acá,
// después de cargar los imports, y dos hijos podían pasar ambos el check).
// Un lock fresco con nuestro propio pid es esa reserva, no otra corrida:
// seguimos y tomamos el heartbeat. Corridas lanzadas a mano (sin reserva)
// conservan el chequeo de siempre contra un lock ajeno.
const lock = readLock();
if (lock && lock.pid !== process.pid && Date.now() - lock.ts < LOCK_FRESH_MS) {
  log('ya hay un triage corriendo (lock fresco ajeno): salgo.');
  process.exit(0);
}

writeLock(process.pid);
const heartbeat = setInterval(() => writeLock(process.pid), HEARTBEAT_MS);
heartbeat.unref?.();

function finish(code) {
  clearInterval(heartbeat);
  clearLock();
  process.exit(code);
}

const denyMsg = 'Triage read-only: herramienta no permitida.';
const denyHook = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: denyMsg,
  },
};

// UNA query blindada (la usan las dos fases). Devuelve el texto acumulado.
async function runQuery(prompt, { maxTurns, timeoutMs, label }) {
  const q = query({
    prompt,
    options: {
      cwd: config.projectDir,
      // Modelo PINEADO (optimización 2026-07-04): sin esta clave corría con el
      // default de la cuenta (opus/fable, el gasto más caro de la flota).
      // Sonnet es el estándar probado del proyecto para tareas de juicio
      // (mismo criterio que auditModelFor de health/shared.js).
      model: 'sonnet',
      // Fuente única (core/sdk-settings.js): 'project'+'local', sin 'user'.
      settingSources: settingSourcesFor('headless'),
      skills: ['bug-triage'],
      permissionMode: 'default',
      maxTurns,
      // Capa 1: PreToolUse deniega mutaciones ANTES de los permisos.
      hooks: {
        PreToolUse: [{ hooks: [async (input) => (toolAllowed(input.tool_name) ? {} : denyHook)] }],
      },
      // Capa 2: allowlist para todo lo que llegue a pedir permiso.
      canUseTool: async (name, input) => (toolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMsg }),
    },
  });

  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} tardó demasiado (timeout).`)), timeoutMs); });

  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') {
        break;
      }
    }
  })();

  try {
    await Promise.race([pump, timeout]);
  } finally {
    clearTimeout(timer);
    // close() SIN await: si el subproceso tarda en morir no nos cuelga.
    try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  return text;
}

async function run() {
  // FASE 1: listado barato (sin análisis). Si falla, se conserva la caché
  // vieja (camino de error de siempre) — recién se pisa tras un listado OK.
  log('fase 1: listando tickets [Tolkien Bug] abiertos…');
  const listText = await runQuery(LIST_PROMPT, {
    maxTurns: LIST_MAX_TURNS, timeoutMs: LIST_TIMEOUT_MS, label: 'El listado de tickets',
  });
  const list = parseTicketList(listText);
  if (!list) {
    // Snippet al log para diagnosticar QUÉ respondió (sin esto el "no se pudo
    // interpretar" era ciego y había que ir a buscar el transcript).
    log('listado ilegible; la respuesta empezaba:', String(listText || '(vacía)').slice(0, 300).replace(/\s+/g, ' '));
    throw new Error('No se pudo interpretar el listado de tickets.');
  }
  log(`fase 1 OK: ${list.length} ticket(s) abiertos.`);
  if (!list.length) {
    writeTicketCache({}); // sin abiertos: la caché por ticket se vacía sola
    return { tickets: [], failures: 0, total: 0, reused: 0 };
  }

  // Caché INCREMENTAL por ticket: fingerprint (status+modifiedTime de la
  // fase 1) vs triage-cache.json. --full la saltea entera (red de seguridad).
  const tcache = FULL ? {} : readTicketCache();
  const newCache = {};
  let reused = 0;
  if (FULL) log('modo --full: ignoro la caché incremental por ticket.');

  // FASE 2: triage de cada ticket EN PARALELO (pool adaptativo de health
  // F2.5, mismo uso que desk-runner). Cada worker escribe su resultado
  // INCREMENTAL a tickets.json en orden de listado (slots por índice): el
  // front, que ya encuesta GET cada 3 s, ve crecer la lista con running=true.
  // Un fallo/timeout individual produce una entrada fallback y NO tira el
  // batch. Lo único compartido es results/failures — seguro (single-thread).
  const results = new Array(list.length).fill(null);
  let failures = 0;
  await runAdaptivePool(list.map((t, i) => ({ t, i })), async ({ t, i }, ctl) => {
    // HIT de caché: mismo fingerprint (status+subject del listado — el MCP
    // recorta modifiedTime, ver shared.js) Y triage cacheado FRESCO
    // (< TICKET_CACHE_TTL_MS: la señal no ve comentarios nuevos, el TTL acota
    // la staleness) ⇒ se reusa el resultado SIN abrir query() (0 tokens).
    const fp = ticketFingerprint(t);
    const hit = tcache[t.ticketNumber];
    const fresco = !!hit && Date.now() - (hit.triagedAt || 0) < TICKET_CACHE_TTL_MS;
    if (hit && fresco && hit.fingerprint === fp && hit.ticket) {
      reused += 1;
      newCache[t.ticketNumber] = hit;
      results[i] = hit.ticket;
      writeCache({ updatedAt: Date.now(), tickets: results.filter(Boolean), error: null });
      log(`ticket #${t.ticketNumber}: sin cambios desde el último triage — reusado de la caché (0 tokens).`);
      return;
    }
    log(`fase 2: triageando ticket #${t.ticketNumber}…`);
    let entry = null;
    try {
      const text = await runQuery(perTicketPrompt(t, list), {
        maxTurns: TICKET_MAX_TURNS, timeoutMs: TICKET_TIMEOUT_MS, label: `El triage del ticket #${t.ticketNumber}`,
      });
      entry = parseTicketTriage(text);
      if (!entry) throw new Error('respuesta ilegible (sin bloque json).');
      // El número/URL de la fase 1 son la verdad; el modelo no los pisa.
      entry.ticketNumber = t.ticketNumber;
      if (!entry.webUrl && t.webUrl) entry.webUrl = t.webUrl;
      // Triage fresco OK ⇒ entra a la caché por ticket (los fallbacks de
      // error NO se cachean para que se reintenten).
      newCache[t.ticketNumber] = { fingerprint: fp, ticket: entry, triagedAt: Date.now() };
      log(`ticket #${t.ticketNumber}: ${entry.severity} · ${entry.recommendation}`);
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 200);
      // Rate-limit/overload del API ⇒ pedirle al pool que baje la concurrencia.
      if (/429|overload|rate.?limit/i.test(msg)) ctl.backoff();
      failures += 1;
      entry = normalizeTicket({
        ticketNumber: t.ticketNumber,
        whatBroke: t.subject,
        webUrl: t.webUrl,
        severity: 'medium',
        recommendation: 'needs-info',
        context: `El triage individual de este ticket falló (${msg}). Reintentá el triage o revisalo a mano en Desk.`,
      });
      log(`ticket #${t.ticketNumber} FALLÓ: ${msg}`);
    }
    results[i] = entry;
    writeCache({ updatedAt: Date.now(), tickets: results.filter(Boolean), error: null });
  });

  // La caché por ticket se escribe UNA vez tras la barrera del pool (regla de
  // oro: paralelo lo que lee, serial lo que escribe) y SOLO con los abiertos
  // de ESTE listado: los tickets cerrados caen solos de la caché.
  writeTicketCache(newCache);

  return { tickets: results.filter(Boolean), failures, total: list.length, reused };
}

log(`triage arrancando (pid ${process.pid}, proyecto ${config.projectDir})`);
run()
  .then(({ tickets, failures, total, reused }) => {
    // `error` informa el parcial: los tickets que sí salieron quedan servidos.
    const error = failures ? `Triage parcial: fallaron ${failures} de ${total} ticket(s).` : null;
    writeCache({ updatedAt: Date.now(), tickets, error });
    log(`triage ${failures ? 'PARCIAL' : 'OK'}: ${tickets.length} ticket(s)${reused ? `, ${reused} reusado(s) de caché` : ''}${failures ? `, ${failures} fallidos` : ''}.`);
    finish(0);
  })
  .catch((err) => {
    // Conservamos los tickets viejos; marcamos el error del último intento.
    const prev = readCache();
    writeCache({ updatedAt: prev.updatedAt, tickets: prev.tickets || [], error: String(err?.message || err).slice(0, 300) });
    log('triage FALLÓ:', err?.message || err);
    finish(1);
  });
