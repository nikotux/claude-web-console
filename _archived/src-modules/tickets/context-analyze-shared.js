// modules/tickets/context-analyze-shared.js — interpretación IA de una
// TRANSCRIPCIÓN (charla con el cliente/equipo, notas de reunión) para producir
// el "Contexto adicional" de un ticket/PR. Molde exacto de audio/shared.js.
//
// REGLA DE ORO: consume tokens y puede tardar ⇒ RUNNER DESACOPLADO
// (bin/cwc-ticket-context-runner.js, detached+unref: un reinicio de la web a
// mitad NO lo mata). El endpoint POST solo escribe el job PENDIENTE acá y lo
// spawnea; el runner persiste el resultado en el MISMO archivo Y auto-guarda el
// contexto en meta-store.js. El front encuesta el GET (solo lee disco, 0 tokens).
//
// REGLA 6 (blindaje read-only): la corrida NO usa NINGUNA herramienta — solo
// interpreta el texto que viaja entero en el prompt. El runner deniega TODO en
// las dos capas (PreToolUse + canUseTool). NUNCA lee ni escribe archivos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo (cwd del SDK)

const RUNNER = path.join(ROOT, 'bin', 'cwc-ticket-context-runner.js');

export const CONTEXT_TIMEOUT_MS = 4 * 60 * 1000;
export const CONTEXT_STALE_MS = CONTEXT_TIMEOUT_MS + 30 * 1000;
export const MAX_TRANSCRIPT = 120 * 1000; // ~120k chars: tope defensivo

// dataDir llega resuelto por operación desde el server (o por argumento en el
// runner): este módulo es compartido y no puede importar core/user-space.js,
// porque arrastraría core/config.js y CWC_TOKEN al entorno limpio del inquilino.
function contextDir(dataDir) {
  return path.join(dataDir, 'ticket-context');
}

function logFile(dataDir) {
  return path.join(dataDir, 'ticket-context.log');
}

function ensureDir(dataDir) {
  fs.mkdirSync(contextDir(dataDir), { recursive: true, mode: 0o700 });
}

function jobPath(dataDir, id) {
  return path.join(contextDir(dataDir), `${id}.json`);
}

// Identidad DETERMINÍSTICA por (clave del ítem + transcripción): el MISMO texto
// sobre el MISMO ticket reusa el job (lock implícito por identidad, no re-gasta).
export function contextJobId(key, transcript) {
  return crypto.createHash('sha1').update(`${key}\n${transcript}`).digest('hex').slice(0, 24);
}

export function readJob(dataDir, id) {
  try { return JSON.parse(fs.readFileSync(jobPath(dataDir, id), 'utf8')); } catch { return null; }
}
export function writeJob(dataDir, id, job) {
  ensureDir(dataDir);
  const tmp = `${jobPath(dataDir, id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
  fs.renameSync(tmp, jobPath(dataDir, id));
  pruneOld(dataDir);
}
function pruneOld(dataDir) {
  const dir = contextDir(dataDir);
  const PRUNE_MS = 30 * 24 * 3600 * 1000;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > PRUNE_MS) fs.unlinkSync(p); } catch { /* noop */ }
    }
  } catch { /* noop */ }
}
export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - (job.updatedAt || job.startedAt || 0)) < CONTEXT_STALE_MS;
}
// Estado efectivo: si quedó 'running' pero el runner murió (pasó STALE), lo
// reporta como error para que el front no encueste para siempre.
export function jobResult(dataDir, id) {
  const job = readJob(dataDir, id);
  if (!job) return null;
  if (job.status === 'running' && (Date.now() - (job.updatedAt || job.startedAt || 0)) > CONTEXT_STALE_MS) {
    return { ...job, status: 'error', error: 'La corrida se quedó sin responder (runner caído).' };
  }
  return job;
}

export function spawnRunner(dataDir, id, env) {
  ensureDir(dataDir);
  const log = logFile(dataDir);
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [RUNNER, id, '--data-dir', dataDir], {
    detached: true, stdio: ['ignore', logFd, logFd], env: env ?? process.env,
  });
  child.on('error', (err) => {
    try { fs.appendFileSync(log, `[${new Date().toISOString()}] spawn FAIL job ${id}: ${err?.message || err}\n`); }
    catch { /* noop */ }
    try {
      const job = readJob(dataDir, id);
      if (job && job.status === 'running') {
        writeJob(dataDir, id, {
          ...job,
          status: 'error',
          result: null,
          error: 'No se pudo iniciar el runner de contexto del ticket.',
          updatedAt: Date.now(),
        });
      }
    } catch { /* noop */ }
  });
  child.unref();
  fs.closeSync(logFd);
}

// Prompt: interpreta la charla y destila el contexto adicional para el ítem.
export function contextPrompt({ transcript, itemTitle, itemDesc }) {
  return [
    'Sos un analista que ayuda a un desarrollador a resolver un ticket/PR.',
    'Te paso la TRANSCRIPCIÓN de una conversación (con el cliente, con el equipo o',
    'notas de una reunión) relacionada con este ítem de trabajo, más el contexto del',
    'ítem. Interpretá quién dijo qué y por qué, y destilá el CONTEXTO ADICIONAL que le',
    'sirve a quien vaya a trabajar el ítem: qué se pidió realmente, decisiones tomadas,',
    'restricciones, datos concretos y próximos pasos acordados.',
    '',
    '== Ítem ==',
    `Título: ${itemTitle || '(sin título)'}`,
    itemDesc ? `Descripción: ${String(itemDesc).slice(0, 2000)}` : '',
    '',
    'Respondé SOLO con un bloque ```json``` con esta forma exacta:',
    '{',
    '  "resumen": "2-4 frases con el contexto clave que aporta la charla",',
    '  "puntosClave": ["dato / decisión / restricción concreta", "..."],',
    '  "acuerdos": ["próximo paso o compromiso acordado", "..."],',
    '  "relevancia": "una frase: cómo cambia esto la forma de resolver el ítem"',
    '}',
    'No inventes: si algo no está en la charla, omitilo. Sé concreto y breve.',
    '',
    '== Transcripción ==',
    String(transcript),
  ].filter((l) => l !== '').join('\n');
}

const strArr = (v, max, len) => (Array.isArray(v) ? v : [])
  .filter((x) => typeof x === 'string' && x.trim()).slice(0, max).map((x) => x.slice(0, len));
const clampStr = (v, len) => (typeof v === 'string' ? v.slice(0, len) : '');

export function parseContext(text) {
  if (!text) return null;
  let jsonStr = null;
  const fences = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length) jsonStr = fences[fences.length - 1][1];
  else { const m = String(text).match(/\{[\s\S]*\}/); if (m) jsonStr = m[0]; }
  if (!jsonStr) return null;
  let o;
  try { o = JSON.parse(jsonStr); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  return {
    resumen: clampStr(o.resumen, 2000),
    puntosClave: strArr(o.puntosClave, 30, 500),
    acuerdos: strArr(o.acuerdos, 30, 500),
    relevancia: clampStr(o.relevancia, 800),
  };
}

// Render a texto plano — se guarda como `contextoAdicional` (fuente única: el
// backend produce el texto, el front lo muestra y el chat lo recibe igual).
export function renderContextText(c) {
  if (!c) return '';
  const lines = [];
  if (c.resumen) lines.push(c.resumen);
  if (c.puntosClave?.length) { lines.push('', 'Puntos clave:'); for (const p of c.puntosClave) lines.push(`- ${p}`); }
  if (c.acuerdos?.length) { lines.push('', 'Acuerdos / próximos pasos:'); for (const a of c.acuerdos) lines.push(`- ${a}`); }
  if (c.relevancia) lines.push('', `Relevancia: ${c.relevancia}`);
  return lines.join('\n');
}
