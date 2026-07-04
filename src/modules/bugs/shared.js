// modules/bugs/shared.js — lo COMPARTIDO entre el módulo server y el
// runner desacoplado del triage (bin/cwc-triage-runner.js): prompt, allowlist
// de seguridad, parser del resultado, caché y lock de "corriendo".
//
// El triage corría DENTRO del proceso Node y cada reinicio del server (deploy,
// push/pull, otra sesión trabajando en la consola) lo mataba a mitad de
// corrida — el bug de "no se pudo correr el triage". Ahora corre en un proceso
// detached (regla 2: nada en curso atado al ciclo de vida del Node) y ESTOS
// dos archivos son su interfaz:
//   - CACHE_FILE (tickets.json): el resultado (tickets o error del último intento).
//   - LOCK_FILE  (triage.lock):  heartbeat {pid, ts} del runner vivo; "corriendo"
//     = lock con ts fresco (LOCK_FRESH_MS). Un runner muerto a lo bestia deja
//     lock viejo => se considera no-corriendo y se puede relanzar.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.join(os.homedir(), '.cwc-data');
// El módulo se llama `bugs`, pero el archivo de caché conserva el nombre
// `tickets.json` a propósito: describe el DATO (tickets [Tolkien Bug] de Zoho
// Desk), no el módulo, y renombrarlo perdería la caché actual del triage
// (que cuesta tokens regenerar).
export const CACHE_FILE = path.join(DATA_DIR, 'tickets.json');
export const LOCK_FILE = path.join(DATA_DIR, 'triage.lock');
export const LOG_FILE = path.join(DATA_DIR, 'triage.log');

export const RUN_TIMEOUT_MS = 4 * 60 * 1000; // corte duro del triage
export const MAX_TURNS = 60;                  // cota de coste
export const HEARTBEAT_MS = 3000;             // latido del runner al lock
export const LOCK_FRESH_MS = 12000;           // lock más viejo que esto = runner muerto

const SEVERITY = new Set(['critical', 'high', 'medium', 'low']);
const RECOMMENDATION = new Set(['fix', 'needs-info', 'duplicate', 'wont-fix']);

// Allowlist de herramientas: SOLO lecturas (dos capas: hook PreToolUse +
// canUseTool — ver regla 6 de CLAUDE.md).
export function toolAllowed(name) {
  // TodoWrite es la lista de tareas INTERNA del modelo (Agent SDK): solo toca
  // estado conversacional, nunca disco ni sistemas externos — es seguro en
  // una corrida read-only y ayuda al modelo a organizarse.
  if (['Read', 'Grep', 'Glob', 'Skill', 'TodoWrite'].includes(name)) return true;
  // Herramientas MCP de lectura (desk_list/get/search, pad_search, graph_list…).
  // Regex ANCLADA al final: get_and_delete NO pasa (hallazgo de la revisión de salud).
  if (/^mcp__[a-z0-9_-]+__[a-z0-9_]*(list|get|search|read|find)[a-z0-9_]*$/i.test(name) && !/(delete|update|create|write|set|add|remove|send)/i.test(name)) return true;
  return false; // todo lo demás (mutaciones, Bash, Write/Edit) -> denegado
}

export const PROMPT = [
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
export function parseTickets(text) {
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

export function readCache() {
  try { return JSON.parse(fss.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { updatedAt: null, tickets: [], error: null }; }
}

export function writeCache(data) {
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

// ===== Lock de "triage corriendo" (heartbeat del runner) =====
export function writeLock(pid) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(LOCK_FILE, JSON.stringify({ pid, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}

export function clearLock() {
  try { fss.unlinkSync(LOCK_FILE); } catch { /* noop */ }
}

// Lee el lock crudo ({pid, ts}) o null si no existe/está roto. Lo usa el
// runner para distinguir la RESERVA que escribió el server con SU pid
// (spawnTriage) de un triage ajeno de verdad corriendo.
export function readLock() {
  try { return JSON.parse(fss.readFileSync(LOCK_FILE, 'utf8')); }
  catch { return null; }
}

// ¿Hay un triage corriendo AHORA? Lock presente y con latido fresco.
export function isRunning() {
  const lock = readLock();
  return !!lock && Date.now() - lock.ts < LOCK_FRESH_MS;
}
