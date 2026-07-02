// modules/tickets/index.js — triage de bugs de Tolkien (skill bug-triage).
//
// Corre el skill `bug-triage` del proyecto Tolkien vía el Agent SDK, BAJO
// DEMANDA (nunca polling: consume tokens reales), y cachea el resultado. El
// skill lee los tickets [Tolkien Bug] de Zoho Desk (MCP tolkien-mordor, que
// además corre con MORDOR_MCP_READONLY=true), los clasifica y arma una tabla.
//
// SEGURIDAD: la corrida es READ-ONLY BLINDADA por DOS capas con la misma
// allowlist (solo lecturas: Read/Grep/Glob/Skill + herramientas MCP
// *list/get/search*):
//   1. hook PreToolUse: corre ANTES de la evaluación de permisos, así que su
//      deny gana incluso sobre reglas `allow` pre-aprobadas en los settings
//      del proyecto (hallazgo de la revisión de salud: settings.local.json de
//      Tolkien pre-aprueba tools mutantes como graph_drive_write_binary).
//   2. canUseTool: allowlist para todo lo que llegue a pedir permiso.
// Cualquier mutación (crear TASK en Pad, desk_update_ticket, Write/Edit/Bash)
// se DENIEGA. Un run headless nunca puede tocar Desk ni Pad.
//
// HTTP:
//   GET  /api/tickets           -> { updatedAt, tickets, error, running }
//   POST /api/tickets/refresh   -> corre el triage y devuelve la caché nueva
import express from 'express';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import { settingSourcesFor } from '../../core/sdk-settings.js';

// OJO: NO usar ~/.cwc-state — claude-state.js poda cualquier .json de ahí cuyo
// `ts` sea viejo (y este archivo no tiene `ts`), así que lo borraba al instante.
// La caché vive en un directorio propio de datos de la consola.
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
const CACHE_FILE = path.join(DATA_DIR, 'tickets.json');
const RUN_TIMEOUT_MS = 4 * 60 * 1000; // corte duro del triage
const MAX_TURNS = 60;                  // cota de coste

const SEVERITY = new Set(['critical', 'high', 'medium', 'low']);
const RECOMMENDATION = new Set(['fix', 'needs-info', 'duplicate', 'wont-fix']);

// Allowlist de herramientas: SOLO lecturas.
function toolAllowed(name) {
  if (['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite'].includes(name)) return true;
  // Herramientas MCP de lectura (desk_list/get/search, pad_search, graph_list…).
  // Regex ANCLADA al final: get_and_delete NO pasa (hallazgo de la revisión de salud).
  if (/^mcp__[a-z0-9_-]+__[a-z0-9_]*(list|get|search|read|find)[a-z0-9_]*$/i.test(name) && !/(delete|update|create|write|set|add|remove|send)/i.test(name)) return true;
  return false; // todo lo demás (mutaciones, Bash, Write/Edit) -> denegado
}

const PROMPT = [
  'Ejecutá el skill bug-triage para revisar los tickets de bug ABIERTOS de Tolkien',
  '([Tolkien Bug] en Zoho Desk). Es una corrida NO interactiva y de SOLO LECTURA:',
  'PARÁ en el paso 3 (la tabla de triage). NO crees TASKs en Pad, NO actualices',
  'ningún ticket de Desk, no modifiques nada.',
  '',
  'Cuando termines, respondé ÚNICAMENTE con un bloque de código ```json que',
  'contenga un array de objetos, uno por ticket abierto, con exactamente estas',
  'claves:',
  '  - ticketNumber (string o número, el # del ticket de Desk)',
  '  - whatBroke     (string, una línea: qué se rompió, en criollo)',
  '  - route         (string, la ruta/página del contexto capturado; "" si no hay)',
  '  - severity      (uno de: critical | high | medium | low)',
  '  - recommendation(uno de: fix | needs-info | duplicate | wont-fix)',
  '  - duplicate     (string: link/ref del duplicado si aplica; "" si no)',
  '  - webUrl        (string: el webUrl del ticket de Desk; "" si no lo tenés)',
  '  - reporter      (string: email de quien reportó; "" si no está)',
  '  - context       (string, 3-8 líneas: el CONTEXTO del bug — qué estaba',
  '    haciendo el usuario según el breadcrumb/estado del formulario, el error',
  '    JS si hay, tu hipótesis de la causa y archivos/componentes sospechosos',
  '    del repo. Texto plano, sin markdown.)',
  '',
  'Si no hay tickets abiertos, respondé con ```json\n[]\n```. No agregues texto',
  'fuera del bloque json.',
].join('\n');

// Extrae el ÚLTIMO bloque ```json ...``` (o el último array JSON suelto).
function parseTickets(text) {
  if (!text) return null;
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  let raw = fences.length ? fences[fences.length - 1][1].trim() : null;
  if (!raw) {
    const m = text.match(/\[[\s\S]*\]/); // último recurso: primer array del texto
    raw = m ? m[0] : null;
  }
  if (!raw) return null;
  let arr;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr.map((t) => ({
    ticketNumber: String(t.ticketNumber ?? t.number ?? '').slice(0, 40),
    whatBroke: String(t.whatBroke ?? t.title ?? '').slice(0, 400),
    route: String(t.route ?? '').slice(0, 200),
    severity: SEVERITY.has(t.severity) ? t.severity : 'medium',
    recommendation: RECOMMENDATION.has(t.recommendation) ? t.recommendation : 'needs-info',
    duplicate: String(t.duplicate ?? '').slice(0, 200),
    webUrl: /^https?:\/\//.test(t.webUrl || '') ? String(t.webUrl).slice(0, 400) : '',
    reporter: String(t.reporter ?? '').slice(0, 120),
    context: String(t.context ?? '').slice(0, 2000),
  }));
}

function readCache() {
  try { return JSON.parse(fss.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { updatedAt: null, tickets: [], error: null }; }
}
function writeCache(data) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fss.writeFileSync(CACHE_FILE, JSON.stringify(data), { mode: 0o600 });
      return;
    } catch (err) {
      if (attempt === 1) console.error('[tickets] no se pudo escribir la caché:', CACHE_FILE, err?.message);
    }
  }
}

let inFlight = null; // Promise del triage en curso (un solo refresh a la vez)

async function runTriage() {
  const q = query({
    prompt: PROMPT,
    options: {
      cwd: config.projectDir,
      // Fuente única (core/sdk-settings.js): 'project'+'local', sin 'user'.
      settingSources: settingSourcesFor('headless'),
      skills: ['bug-triage'],
      permissionMode: 'default',
      maxTurns: MAX_TURNS,
      // Capa 1: PreToolUse deniega mutaciones ANTES de los permisos (las
      // reglas `allow` de settings no pueden saltearlo, canUseTool sí sería
      // salteable). Devolver {} deja seguir el flujo normal hacia canUseTool.
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
  let sessionId = null;
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('El triage tardó demasiado (timeout).')), RUN_TIMEOUT_MS); });

  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
      } else if (m.type === 'result') {
        sessionId = m.session_id || sessionId;
        break;
      }
    }
  })();

  try {
    await Promise.race([pump, timeout]);
  } finally {
    clearTimeout(timer);
    // close() SIN await: si el subproceso tarda en morir, un await deja
    // inFlight colgado para siempre (misma lección que el módulo health).
    try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }

  const tickets = parseTickets(text);
  if (!tickets) throw new Error('No se pudo interpretar el resultado del triage.');
  return { tickets, sessionId };
}

async function refresh() {
  if (inFlight) return inFlight; // dedup: adjuntar al que ya corre
  inFlight = (async () => {
    try {
      const { tickets } = await runTriage();
      const data = { updatedAt: Date.now(), tickets, error: null };
      writeCache(data);
      return data;
    } catch (err) {
      // Conservamos los tickets viejos; marcamos el error del último intento.
      const prev = readCache();
      const data = { updatedAt: prev.updatedAt, tickets: prev.tickets || [], error: String(err?.message || err).slice(0, 300) };
      writeCache(data);
      return data;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export default {
  name: 'tickets',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      const c = readCache();
      res.json({ ...c, running: !!inFlight });
    });

    // Corre el triage (LENTO, consume tokens). El front confirma antes.
    // Admin-gated como health/review: consume tokens reales (hallazgo de salud).
    r.post('/refresh', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const data = await refresh();
      res.json({ ...data, running: false });
    });

    router.use('/tickets', r);
  },
};
