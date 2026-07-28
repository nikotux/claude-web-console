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
const LEARNED_MATCH_MAX = 200;
const LEARNED_TEXT_MAX = 400;

// Seeds hand-authored (RegExp ricas). Los aprendidos se suman aparte.
export const SEED_INVARIANTS = [
  {
    match: /src\/modules\/chat\/runner-link\.js$|src\/core\/user-space\.js$|bin\/cwc-chat-runner\.js$/,
    text: 'BLINDAJE ANTICONSUMO MULTI-TENANT (PLAN-592): el runner de un INQUILINO NUNCA hereda el entorno del server — spawnRunner arma el env por allowlist con userRunnerEnv (env LIMPIO, jamás `...process.env`) + HOME=~/.cwc-users/<owner> + el OAuth token del dueño; sin creds propias NO arranca (fail-closed, nunca cae al ~/.claude del server). El runner además hace un self-check al arrancar: si es inquilino (owner != host) y su HOME/creds no están aislados, ABORTA (exit 3) antes de query(). Ningún dato user-scoped de .cwc-data del inquilino se resuelve al root del server: resolveDataDir() (core/data-dir.js) honra CWC_DATA_DIR. Debilitar cualquiera de estas capas quemaría los tokens del admin.',
  },
  {
    match: /src\/modules\/terminal\/sessions\.js$/,
    text: 'BLINDAJE ANTICONSUMO MULTI-TENANT DEL PTY (BUG-2104 · BUG-2105): el PTY de una sesión cuyo owner es un INQUILINO se spawnea con `userRunnerEnv(owner)` + HOME aislado + `CWC_DATA_DIR` aislado + `CLAUDE_CODE_OAUTH_TOKEN` propio, NUNCA con `...process.env`; si la sesión corre `claude` y falta la credencial propia, falla cerrado antes del spawn. Cada `new-session` inyecta las variables críticas con `-e` porque el server tmux es compartido y fue arrancado por el host; además, las variables de su entorno global que sean secretos o empiecen con `CWC_` se neutralizan con `-e CLAVE=` en las sesiones de inquilino, antes de superponer la allowlist owner-scoped. Con `-A`, una sesión ya creada conserva el env viejo y hay que matarla y recrearla para aplicar el aislamiento nuevo. El host (`owner === null` o `owner === hostUser()`) conserva el entorno completo por retrocompatibilidad.',
  },
  {
    // Familia A · NO-CRUCE / ownership por usuario×mundo (PLAN-500/PLAN-593 SP1).
    match: /src\/modules\/chat\/index\.js$|src\/modules\/terminal\/sessions\.js$/,
    text: 'NO-CRUCE POR USUARIO (multi-tenant, PLAN-500/PLAN-593; Regla 12 escalada a per-user): toda list/attach/read de conversaciones y sesiones filtra por `owner`. Un NO-admin ve/adjunta SOLO lo suyo (`chat.owner === principal.username`) y un admin ve todo — es EXACTAMENTE lo que hacen `list(principal)` (filtro de visibilidad) y `ownedChat(req, id)` (guard: ajeno o inexistente ⇒ null ⇒ 404, sin revelar que existe) en chat/index.js. Ese guard NUNCA se relaja para un no-admin. El cwd se clampa con `safeCwd(cwd, owner)` = `clampToRoot(userFileRoot(owner || hostUser()), cwd)` — al workspace del inquilino, JAMÁS al home global. El viejo modelo de "confianza plena entre autenticados" (gotcha WS de CLAUDE.md) queda DEROGADO para no-admins: cualquier endpoint/handler nuevo (chat o sesión tmux) que enumere o adjunte recursos DEBE pasar por el mismo filtro por dueño; reintroducir un listado sin `owner` es una regresión de aislamiento.',
  },
  {
    // Familia B · dato user-scoped NUNCA global (PLAN-500/PLAN-592/PLAN-593 SP1).
    match: /src\/core\/data-dir\.js$|src\/modules\/(chat|tasks|learning|retro|tickets|tokens)\//,
    text: 'DATO USER-SCOPED NUNCA GLOBAL (multi-tenant, PLAN-500/PLAN-592): toda lectura/escritura de estado propio de un usuario resuelve su directorio con `resolveDataDir()` (core/data-dir.js), que honra `CWC_DATA_DIR` — el server inyecta `CWC_DATA_DIR = userDataDir(owner)` en el env del runner del inquilino (userRunnerEnv). PROHIBIDO hardcodear `path.join(os.homedir(), ".cwc-data")` (o `config.home + "/.cwc-data"`) para estado user-scoped: eso lo colaría al root del host y cruzaría datos entre inquilinos. Un módulo nuevo que persista datos de usuario (chat/tasks/learning/retro/tickets/tokens) debe derivar su base de resolveDataDir(), no del home del proceso. El módulo `tokens` resuelve las rutas de consumo (transcripts de Claude, sesiones de Codex, histórico de uso, credenciales de límites) con los helpers de `src/core/user-space.js` (`userClaudeDir`/`userDataDir`/`userCodexAuthPath`) contra el `principalOf(req)` de la request; PROHIBIDO volver a `os.homedir()` ahí (BUG-1874).',
  },
  {
    // Familia C · Pad per-usuario, sin credencial compartida (PLAN-500/PLAN-593 SP1).
    match: /src\/core\/pad-service-client\.js$|src\/core\/pad-context\.js$|src\/core\/user-space\.js$/,
    text: 'PAD PER-USUARIO, SIN CREDENCIAL COMPARTIDA (multi-tenant, PLAN-500; ver DOC-633): una operación de Pad EN NOMBRE de un inquilino usa SU token (`readUserPadToken(userId, url)`) y SU workspace (`userPadWorkspace(userId)` = `tenant-<userId>`) — derivados por `padContextForUser`/`reqPadContext` (core/pad-context.js) como `{url, token, workspace}`. NUNCA se escribe data de un inquilino con la credencial ÚNICA del host (token de ~/.pad) ni en el workspace `console`. FAIL-CLOSED: si el token propio aún no está provisionado (readUserPadToken ⇒ null), el ctx viaja con `token:null` y la operación falla limpio (403/sin token) SIN caer al host ni contaminar `console`; el host (principal admin sin ctx de inquilino) sí conserva su `console`+~/.pad por retrocompat. Reintroducir un default al token/workspace del host para un inquilino es una regresión de aislamiento.',
  },
  {
    match: /src\/core\/system-scope\.js$|src\/modules\/(skills|mcps|env-vars|interfono|projects)\/[^/]+\.js$/,
    text: 'SUPERFICIE DE SISTEMA POR USUARIO (PLAN-2117): toda pestaña de ⚙ Sistema resuelve sus rutas con `systemScopeFor(req)` de `core/system-scope.js`, NUNCA con `os.homedir()`, `config.home` ni una constante de módulo calculada al importar: en el proceso del server esas tres dan SIEMPRE el HOME del host y le filtran al inquilino las skills, los MCPs, el llavero y la config del host. El destino de una escritura a Pad sale de `scope.padWorkspace` (`console` para el host, `tenant-<id>` para cualquier otro) y del token de ESE usuario, jamás de una constante. El host conserva su comportamiento porque `userSpace(host) === config.home`. Un módulo nuevo de Sistema que derive rutas del proceso en vez del principal es una regresión de aislamiento.',
  },
  {
    match: /src\/modules\/chat\/(index|shared)\.js$/,
    text: 'SIMETRÍA de estado en chat/index.js: todo `case` del switch de eventos que muta estado persistente de la conversación (mode, model, etc.) debe llamar a onUpdate()/persist() IGUAL que sus gemelos. Ej histórico: `case "mode"` debía llamar onUpdate() como `case "model"` — si un camino guarda y su gemelo no, es un bug.',
  },
  {
    match: /src\/core\/paths\.js$|src\/modules\/(files|projects|backup)\//,
    text: 'VALIDACIÓN DE RUTAS: toda ruta que venga del cliente pasa por resolveWithinHome/clampToHome (core/paths.js) ANTES de tocar disco. NUNCA validar con startsWith crudo ni concatenar rutas sin clamping (riesgo de path traversal).',
  },
  {
    match: /src\/modules\/chat\/attachments\.js$|bin\/cwc-chat-runner\.js$/,
    text: 'ADJUNTOS DEL CHAT (chat/attachments.js): todo nombre de archivo del cliente se reduce a un BASENAME validado (safeAttachName) y se confina a la carpeta del chat — attachPath verifica que path.dirname sea EXACTO; NUNCA se resuelve una ruta cruda del cliente. El límite de tamaño se aplica ANTES de leer el archivo a memoria (multer.fileSize al subir + fs.statSync antes del readFileSync en buildUserContent). SIN adjuntos el content del SDK sigue siendo un STRING (retrocompat); con adjuntos, un array de bloques image/document/text. Imágenes SOLO jpeg/png/gif/webp (IMAGE_MIME); los binarios NO van como bloque (la API no tiene bloque nativo) — se referencian por ruta absoluta para que el modelo los lea con Read/Bash.',
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
  // BUG-1977: la dedup debe comparar exactamente la representación que queda
  // en disco. Así también reconoce las entradas históricas, sin migrar formato.
  const persisted = {
    match: m.slice(0, LEARNED_MATCH_MAX),
    text: t.slice(0, LEARNED_TEXT_MAX),
  };
  if (arr.some((e) => e?.match === persisted.match && e?.text === persisted.text)) return;
  arr.push({ ...persisted, addedAt: Date.now() });
  fss.writeFileSync(LEARNED_FILE, JSON.stringify(arr, null, 2));
}
