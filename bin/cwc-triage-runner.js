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
// Sin argumentos. Log en ~/.cwc-data/triage.log (lo redirige el spawn).
//
// SEGURIDAD: misma corrida READ-ONLY blindada por DOS capas (regla 6):
// hook PreToolUse (deniega ANTES de la evaluación de permisos) + canUseTool
// como allowlist de lecturas. settingSources 'headless' (sin user).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import {
  PROMPT, toolAllowed, parseTickets, readCache, writeCache,
  writeLock, clearLock, readLock, RUN_TIMEOUT_MS, MAX_TURNS, HEARTBEAT_MS,
  LOCK_FRESH_MS,
} from '../src/modules/bugs/shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

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

async function run() {
  const q = query({
    prompt: PROMPT,
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
      maxTurns: MAX_TURNS,
      // Capa 1: PreToolUse deniega mutaciones ANTES de los permisos.
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => (toolAllowed(input.tool_name)
            ? {}
            : {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Triage read-only: herramienta no permitida.',
              },
            })],
        }],
      },
      // Capa 2: allowlist para todo lo que llegue a pedir permiso.
      canUseTool: async (name, input) => (toolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Triage read-only: herramienta no permitida.' }),
    },
  });

  let text = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('El triage tardó demasiado (timeout).')), RUN_TIMEOUT_MS); });

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

  const tickets = parseTickets(text);
  if (!tickets) throw new Error('No se pudo interpretar el resultado del triage.');
  return tickets;
}

log(`triage arrancando (pid ${process.pid}, proyecto ${config.projectDir})`);
run()
  .then((tickets) => {
    writeCache({ updatedAt: Date.now(), tickets, error: null });
    log(`triage OK: ${tickets.length} ticket(s).`);
    finish(0);
  })
  .catch((err) => {
    // Conservamos los tickets viejos; marcamos el error del último intento.
    const prev = readCache();
    writeCache({ updatedAt: prev.updatedAt, tickets: prev.tickets || [], error: String(err?.message || err).slice(0, 300) });
    log('triage FALLÓ:', err?.message || err);
    finish(1);
  });
