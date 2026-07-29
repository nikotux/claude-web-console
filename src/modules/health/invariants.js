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
// Cada invariante: { match, text, exclude?, origen? }. `match` es un RegExp en
// memoria y, en los aprendidos persistidos, uno o varios globs separados por
// coma contra rutas relativas. `text` es la regla; `exclude` enumera rutas
// relativas exactas donde no aplica; `origen` conserva su procedencia.
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
    text: 'NO-CRUCE POR USUARIO (multi-tenant, PLAN-500/PLAN-593; Regla 12 escalada a per-user): toda list/attach/read de conversaciones y sesiones filtra por `owner`. Un NO-admin ve/adjunta SOLO lo suyo (`chat.owner === principal.username`) y un admin ve todo — es EXACTAMENTE lo que hacen `list(principal)` (filtro de visibilidad) y `ownedChat(req, id)` (guard: ajeno o inexistente ⇒ null ⇒ 404, sin revelar que existe) en chat/index.js. Ese guard NUNCA se relaja para un no-admin. El cwd se clampa con `safeCwd(cwd, owner)` = `clampToRoot(userFileRoot(owner || hostUser()), cwd)` — al workspace del inquilino, JAMÁS al home global. El viejo modelo de "confianza plena entre autenticados" (gotcha WS de CLAUDE.md) queda DEROGADO para no-admins: cualquier endpoint/handler nuevo (chat o sesión tmux) que enumere o adjunte recursos DEBE pasar por el mismo filtro por dueño; reintroducir un listado sin `owner` es una regresión de aislamiento. REGLA PUBLICADA PARA ADUANA (console:CONVE-2082): compartido NO significa ajeno. Un chat del que el principal no es dueño ni participante explícito sigue siendo AJENO: `ownedChat` devuelve null ⇒ 404 sin revelar existencia, y `list()` sigue vaciando `pendingPerms`/`pendingInterfono`; el aislamiento del 2026-07-27 —las preguntas de un inquilino no pueden aparecerle al host— queda INTACTO. La ÚNICA excepción colaborativa para un no-dueño es figurar explícitamente en `chat.participants[]`, consultado por `isParticipant()` y materializado por `participantChat()`; NUNCA nace de confianza ambiental entre usuarios autenticados. `participantChat()` habilita SOLO participar: mirar, hablar, cortar y adjuntar. Cerrar, archivar, mudar de mundo, cambiar modelo/modo/effort, invitar o revocar siguen siendo acciones de DUEÑO y exigen `ownedChat`, porque el anfitrión paga los turnos de la sala.',
  },
  {
    // Familia Aduana · suelo neutral (PLAN-2214).
    match: /src\/modules\/chat\/aduana\.js$|src\/modules\/chat\/index\.js$|src\/core\/worlds\.js$/,
    text: 'ADUANA — SUELO NEUTRAL (PLAN-2214): LEY 1, el `cwd` de una sala vive SIEMPRE bajo `~/.cwc-aduana/salas/<salaId>` y NUNCA en un mundo real — ni el repo de la consola, ni `config.projectDir`, ni un worktree de Tolkien, ni el workspace de un inquilino—; esa separación impide que un invitado alcance el mundo del anfitrión a través del agente. La ruta se resuelve con contención VERIFICADA mediante `path.relative`, NUNCA con `startsWith` de strings (falso positivo con carpetas hermanas de nombre parecido; lección de `console:BUG-2142`), y el `salaId` pasa por whitelist ANTES de tocar disco. LEY 5: una sala NUNCA corre en `bypassPermissions`; los permisos son los del suelo neutral, no los del invitado. El canal humano `say()` difunde y persiste, pero JAMÁS llama a `sendUser()` ni a `link.send()` ni empuja mensajes al SDK: cuesta 0 tokens; SOLO `cut()`/`_dispatchCut()` hablan con el motor. Si `say()` alcanzara el SDK, la conversación humana dejaría de ser gratis y gastaría la cuota del anfitrión. LEY 6: los aportes son DATOS, no instrucciones; `buildSalaPrompt()` entrega cada aporte al modelo etiquetado con su autor dentro del bloque de conversación, NUNCA como instrucción de sistema ni fundido en una sola voz. REGLA DURA 2: la memoria humana sobrevive al proceso en `sala.jsonl`, log append-only en la raíz de la sala; el transcript del SDK solo conoce sus propios turnos y NADA de la sala puede depender de la vida del proceso Node.',
  },
  {
    // Familia B · dato user-scoped NUNCA global (PLAN-500/PLAN-592/PLAN-593 SP1).
    match: /src\/core\/data-dir\.js$|src\/modules\/(chat|tasks|learning|retro|tickets|tokens)\//,
    text: 'DATO USER-SCOPED NUNCA GLOBAL (multi-tenant, PLAN-500/PLAN-592): toda lectura/escritura de estado propio de un usuario resuelve su directorio con `resolveDataDir()` (core/data-dir.js), que honra `CWC_DATA_DIR` — el server inyecta `CWC_DATA_DIR = userDataDir(owner)` en el env del runner del inquilino (userRunnerEnv). PROHIBIDO hardcodear `path.join(os.homedir(), ".cwc-data")` (o `config.home + "/.cwc-data"`) para estado user-scoped: eso lo colaría al root del host y cruzaría datos entre inquilinos. Un módulo nuevo que persista datos de usuario (chat/tasks/learning/retro/tickets/tokens) debe derivar su base de resolveDataDir(), no del home del proceso. El módulo `tokens` resuelve las rutas de consumo (transcripts de Claude, sesiones de Codex, histórico de uso, credenciales de límites) con los helpers de `src/core/user-space.js` (`userClaudeDir`/`userDataDir`/`userCodexAuthPath`) contra el `principalOf(req)` de la request; PROHIBIDO volver a `os.homedir()` ahí (BUG-1874). Por `console:BUG-2185`, en el proceso del SERVER está PROHIBIDO derivar una ruta de estado user-scoped de una CONSTANTE DE MÓDULO calculada al importar (`const X = path.join(resolveDataDir(), …)`, `os.homedir()` o `config.home`): esas constantes congelan el espacio del HOST y no admiten dueño. El server resuelve la ruta POR OPERACIÓN a partir del dueño del dato, con `userDataDir(owner)`/`userClaudeDir(owner)` del `principalOf(req)` o del `owner` del chat. Un módulo COMPARTIDO entre server y runner — casos vivos: `chat/attachments.js`, `chat/shared.js`, `core/model-router.js`, `retro/shared.js` — NO importa `core/user-space.js`: hacerlo arrastraría `core/config.js` y su `CWC_TOKEN` a un runner de inquilino con env limpio o a un CLI de `bin/`. El patrón correcto es RECIBIR la ruta ya resuelta o un RESOLVER inyectado por el server: `setChatDataDirResolver()` en `chat/attachments.js`, el parámetro `dataDir` de `readWindowPressure()` en `core/model-router.js` y el parámetro `claudeDir` de `readTranscript()` en `retro/shared.js`. Un registro GLOBAL a propósito (`chats.json`, `session-packages.json`, el bus del interfono) es aceptable, pero cada ítem lleva su campo `owner` y TODA lectura que llegue a la UI filtra por el dueño del principal: NUNCA se muestran a un usuario ítems de otro. Un `owner` ausente o `null` significa el HOST por retrocompatibilidad con registros viejos.',
  },
  {
    // Familia C · Pad per-usuario, sin credencial compartida (PLAN-500/PLAN-593 SP1).
    match: /src\/core\/pad-service-client\.js$|src\/core\/pad-context\.js$|src\/core\/user-space\.js$/,
    text: 'PAD PER-USUARIO, SIN CREDENCIAL COMPARTIDA (multi-tenant, PLAN-500; ver DOC-633): una operación de Pad EN NOMBRE de un inquilino usa SU token (`readUserPadToken(userId, url)`) y SU workspace (`userPadWorkspace(userId)` = `tenant-<userId>`) — derivados por `padContextForUser`/`reqPadContext` (core/pad-context.js) como `{url, token, workspace}`. NUNCA se escribe data de un inquilino con la credencial ÚNICA del host (token de ~/.pad) ni en el workspace `console`. FAIL-CLOSED: si el token propio aún no está provisionado (readUserPadToken ⇒ null), el ctx viaja con `token:null` y la operación falla limpio (403/sin token) SIN caer al host ni contaminar `console`; el host (principal admin sin ctx de inquilino) sí conserva su `console`+~/.pad por retrocompat. Reintroducir un default al token/workspace del host para un inquilino es una regresión de aislamiento. Hay UNA excepción nominal de destino: el pozo común de Mejora Continua vive en el workspace compartido `comunidad` (`console:PLAN-2222`), pero conserva el principio duro de credencial propia: cada usuario escribe allí con SU token mediante `sharedPadContextForUser`, JAMÁS con el token del host en nombre de otro. Un fallback al token del host para escribir en el pozo es la misma regresión de aislamiento.',
  },
  {
    // Familia C · pozo común de Pad (PLAN-2222).
    match: /src\/modules\/retro\/(pool|store)\.js$|src\/core\/pad-context\.js$/,
    text: 'POZO COMÚN DE LECCIONES (console:PLAN-2222): `sourceChats` NUNCA cruza al workspace `comunidad`; se comparte la lección destilada, no el rastro de la conversación privada que la produjo, y copiarlo “para trazabilidad” es una fuga, no una mejora. El pozo es ACCESORIO: publicar corre SIEMPRE en su propio try/catch, con el mismo criterio que `linkLessonToSun`, porque una falla del pozo no puede romper una destilación ni convertir un alta de usuario válida en error. Adoptar NO es publicar: una lección ajena llama a `upsertLesson` con `sharedCtx = null` A PROPÓSITO; republicarla al adoptar sería re-donarla, inflaría sola la recurrencia y destruiría la única señal que justifica el pozo. Además, una lección ajena NUNCA se auto-promueve a `memoria`, `claude-md`, `contrato` ni `invariante`: volver un aporte ajeno una instrucción ejecutable exige SIEMPRE un acto humano del dueño del destino (ley 6 de Aduana, Regla dura 16). Cruzar `sourceChats`, hacer bloqueante la publicación, republicar una adopción o auto-aplicar un aporte ajeno es una regresión.',
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
    // discoverUnits agrupa el frontend por JS; main.js ancla este guard global
    // a esa unidad aunque los CSS no formen parte de su lista de archivos.
    match: /public\/css\/(ui|style)\.css$|public\/js\/main\.js$/,
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

// El modelo que propone invariantes escribe listas separadas por coma y agrega
// comentarios entre paréntesis. Antes ambos producían un patrón inerte que no
// fallaba al compilar pero tampoco matcheaba archivos (console:BUG-2253).
export function compileMatch(spec) {
  const parts = String(spec || '').replace(/\([^)]*\)/g, ' ').split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('El patrón de archivos no es válido.');
  return new RegExp(parts.map(globToRegExp).join('|'));
}

// Carga los aprendidos y compila su `match` (glob) a RegExp; un patrón malo se
// descarta sin romper el auditor (try/catch por entrada).
function loadLearned() {
  let arr;
  try { arr = JSON.parse(fss.readFileSync(LEARNED_FILE, 'utf8')); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((e) => {
    try {
      return {
        match: compileMatch(e.match),
        text: String(e.text),
        exclude: Array.isArray(e.exclude) ? e.exclude : [],
        origen: e.origen ? String(e.origen) : '',
        learned: true,
      };
    }
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
  return allInvariants().filter((inv) => {
    const ex = inv.exclude || [];
    return files.some((f) => !ex.includes(f) && inv.match.test(f));
  }).map((inv) => inv.text);
}

let _repoFiles = null;

// Lista los archivos reales auditables para impedir que se aprueben patrones
// compilables pero inertes. Si el disco no se puede leer, falla abierto.
function repoFiles() {
  if (_repoFiles) return _repoFiles;
  try {
    const root = path.resolve(__dirname, '..', '..', '..');
    const files = [];
    const walk = (dir) => {
      for (const entry of fss.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name.startsWith('.'))) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join('/'));
      }
    };
    for (const base of ['src', 'bin', 'public']) walk(path.join(root, base));
    _repoFiles = files;
  } catch {
    _repoFiles = [];
  }
  return _repoFiles;
}

// Agrega un invariante APROBADO al JSON de aprendidos (repo). Valida el regex
// ANTES de persistir; lanza si el match es inválido o falta texto. Es la única
// escritura "código-adyacente" del flujo, admin-gated y con aprobación humana.
export function appendLearnedInvariant({ match, text, exclude, origen }) {
  const m = String(match || '').trim();
  const t = String(text || '').trim();
  if (!m || !t) throw new Error('Faltan match o texto del invariante.');
  // El match es un GLOB (`src/modules/**/*.js`), no un regex — se valida
  // compilando su conversión, así `**` no revienta al aprobar.
  let re;
  try { re = compileMatch(m); } catch { throw new Error('El patrón de archivos no es válido.'); }
  const files = repoFiles();
  if (files.length && !files.some((f) => re.test(f))) {
    throw new Error('El patrón no coincide con ningún archivo del repo.');
  }
  let arr = [];
  try { arr = JSON.parse(fss.readFileSync(LEARNED_FILE, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
  // BUG-1977: la dedup debe comparar exactamente la representación que queda
  // en disco. Así también reconoce las entradas históricas, sin migrar formato.
  const persisted = {
    match: m.slice(0, LEARNED_MATCH_MAX),
    text: t.slice(0, LEARNED_TEXT_MAX),
  };
  if (arr.some((e) => e?.match === persisted.match && e?.text === persisted.text)) return;
  arr.push({
    ...persisted,
    ...(Array.isArray(exclude) && exclude.length ? { exclude } : {}),
    ...(typeof origen === 'string' && origen.trim() ? { origen: origen.trim().slice(0, 200) } : {}),
    addedAt: Date.now(),
  });
  fss.writeFileSync(LEARNED_FILE, JSON.stringify(arr, null, 2));
}
