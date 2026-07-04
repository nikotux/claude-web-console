// modules/health/invariants.js — INVARIANTES verificables del proyecto.
//
// FASE 4 del "sistema nervioso": aserciones que DEBEN cumplirse siempre. El
// auditor de salud inyecta en cada unidad SOLO los invariantes que le aplican
// (por `match` contra sus rutas de archivo) y los verifica sí o sí — así caza
// bugs SUTILES que el barrido genérico se pierde (p.ej. asimetrías en archivos
// grandes). Están seedeados de los gotchas conocidos de CLAUDE.md; son la
// parte "receta/rules" del cerebro (viven en el repo, humano-autoradas). La
// Fase 5 (loop que aprende) PROPONE nuevas acá cuando el auto-fix resuelve algo.
//
// Cada invariante: { match: RegExp (contra rel path de archivo), text: string }.
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Invariantes APRENDIDOS (Fase 5): propuestos por el auto-fix y APROBADOS por
// el usuario. Viven en un JSON de datos (match como string) que el server
// puede escribir con seguridad — nunca se genera código. Se mergean con los
// seeds hand-authored de abajo.
const LEARNED_FILE = path.join(__dirname, 'invariants-learned.json');

// Seeds hand-authored (RegExp ricas). Los aprendidos se suman aparte.
export const SEED_INVARIANTS = [
  {
    match: /src\/modules\/chat\/(index|shared)\.js$/,
    text: 'SIMETRÍA de estado en chat/index.js: todo `case` del switch de eventos que muta estado persistente de la conversación (mode, model, etc.) debe llamar a onUpdate()/persist() IGUAL que sus gemelos. Ej histórico: `case "mode"` debía llamar onUpdate() como `case "model"` — si un camino guarda y su gemelo no, es un bug.',
  },
  {
    match: /src\/core\/paths\.js$|src\/modules\/(files|projects|backup)\//,
    text: 'VALIDACIÓN DE RUTAS: toda ruta que venga del cliente pasa por resolveWithinHome/clampToHome (core/paths.js) ANTES de tocar disco. NUNCA validar con startsWith crudo ni concatenar rutas sin clamping (riesgo de path traversal).',
  },
  {
    match: /src\/core\/sdk-settings\.js$|bin\/cwc-(chat|health|triage|healthfix)-runner\.js$|src\/modules\/(health|bugfixes|bugs)\/(index|shared)\.js$/,
    text: 'settingSources: la fuente ÚNICA es settingSourcesFor (core/sdk-settings.js). Las corridas HEADLESS (salud, triage, tickets) NUNCA deben cargar settingSources con "user"; y sus tools van blindadas por DOS capas (hook PreToolUse + canUseTool) — read-only salvo las excepciones documentadas en la regla 6 (desk_* y el auto-fix con fixToolAllowed).',
  },
  {
    match: /src\/server\.js$|src\/core\/zerotier\.js$/,
    text: 'BIND EXCLUSIVO: el server escucha SOLO en la IP ZeroTier (core/zerotier.js). Jamás 0.0.0.0 ni 127.0.0.1 como address de listen.',
  },
  {
    match: /public\/css\/(ui|style)\.css$/,
    text: 'GUARD [hidden]: existe `[hidden]{display:none!important}` global en ui.css. Cualquier regla `display` de autor sobre un elemento ocultable debe respetarlo (no pisarlo sin contemplar [hidden]).',
  },
  {
    match: /src\/modules\/projects\//,
    text: 'INTEGRIDAD de secciones: splitContextSections debe cumplir sections.join("\\n") === el archivo original byte a byte; y el POST de una sección exige el hash del texto abierto (409 si el archivo cambió) para no pisar ediciones concurrentes.',
  },
  {
    match: /src\/modules\/chat\/index\.js$/,
    text: 'AUTO-TÍTULO y otras corridas auxiliares del SDK dentro del chat deben ser READ-ONLY doble capa (regla 6) y NUNCA bloquear el turno del usuario (corren en paralelo; si fallan, se degradan en silencio).',
  },
];

// Convierte un patrón GLOB (lo que emite el modelo: `**`, `*`, rutas — el prompt
// pide "<patrón de archivos>") a fuente de RegExp anclada al final. `**` cruza
// directorios, `*` no; el resto de metacaracteres de regex se escapan. Los
// invariantes APRENDIDOS guardan globs (legibles, mismo formato que la
// propuesta); acá se compilan a regex para el matcheo. Antes se compilaba el
// glob crudo con `new RegExp` y un `**` tiraba "Nothing to repeat" (rompía el
// aprobar y dejaba el invariante muerto).
export function globToRegExp(glob) {
  const s = String(glob || '').trim();
  let re = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') { i += 1; if (s[i + 1] === '/') i += 1; re += '.*'; } // ** (+ / opcional) = cruza dirs
      else re += '[^/]*'; // * = dentro de un segmento
    } else if ('.+?()[]{}^$|\\/'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return `${re}$`;
}

// Carga los aprendidos y compila su `match` (glob) a RegExp; un patrón malo se
// descarta sin romper el auditor (try/catch por entrada).
function loadLearned() {
  let arr;
  try { arr = JSON.parse(fss.readFileSync(LEARNED_FILE, 'utf8')); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((e) => {
    try { return { match: new RegExp(globToRegExp(e.match)), text: String(e.text), learned: true }; }
    catch { return null; }
  }).filter(Boolean);
}

// Todos los invariantes: seeds + aprendidos (se relee el JSON cada vez — es
// chico y así toma en caliente lo recién aprobado).
export function allInvariants() {
  return [...SEED_INVARIANTS, ...loadLearned()];
}

// Invariantes que aplican a una unidad (por sus archivos). Devuelve textos.
export function invariantsFor(unit) {
  const files = unit?.files || [];
  return allInvariants().filter((inv) => files.some((f) => inv.match.test(f))).map((inv) => inv.text);
}

// Agrega un invariante APROBADO al JSON de aprendidos (repo). Valida el regex
// ANTES de persistir; lanza si el match es inválido o falta texto. Es la única
// escritura "código-adyacente" del flujo, admin-gated y con aprobación humana.
export function appendLearnedInvariant({ match, text }) {
  const m = String(match || '').trim();
  const t = String(text || '').trim();
  if (!m || !t) throw new Error('Faltan match o texto del invariante.');
  // El match es un GLOB (`src/modules/**/*.js`), no un regex — se valida
  // compilando su conversión, así `**` no revienta al aprobar.
  try { new RegExp(globToRegExp(m)); } catch { throw new Error('El patrón de archivos no es válido.'); }
  let arr = [];
  try { arr = JSON.parse(fss.readFileSync(LEARNED_FILE, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
  if (arr.some((e) => e.match === m && e.text === t)) return; // dedup
  arr.push({ match: m.slice(0, 200), text: t.slice(0, 400), addedAt: Date.now() });
  fss.writeFileSync(LEARNED_FILE, JSON.stringify(arr, null, 2));
}
