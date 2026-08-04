<!-- cwc:ficha-modulo -->
# src/core — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### src/core/                   config(.env + config.instance) · instance-config(capa de config
de INSTANCIA: identidad+cliente en el `instance.json` del `dataDir` recibido,
con ~/.cwc-data/instance.json como default retrocompatible del host;
autogenerado; caché POR ARCHIVO para no cruzar principales; DEFAULTS genéricos
vacíos (los valores reales viven en instance.json), deepMerge por union de
claves — ver módulo env-vars) ·
auth · users · wss · registry · tls ·
zerotier · tmux(validación) · trash · recents ·
pool(runAdaptivePool — pool de concurrencia ADAPTATIVA transversal;
MOVIDO acá desde health/pool.js en la coherencia 2026-07-12 porque lo
consumen salud/tokens/comms/tickets; health/pool.js queda re-exportando
para sus consumidores históricos. Opción `max` = techo duro de
concurrencia (default = nº items) para consumidores con límite externo,
p.ej. tickets/sources.js pasa max=ENRICH_CONCURRENCY por el rate-limit de
Zoho) ·
text-only-query(textOnlyQuery — helper ÚNICO de las corridas del SDK de
TEXTO PURO/interpretación sin herramientas: encapsula settingSources:[]
vía settingSourcesFor('none') + las DOS capas de deny de la regla 6
[PreToolUse+canUseTool, INCONDICIONALES] + carrera de timeout + pump.
Lo usan retro-runner y ticket-context-runner; NO usarlo si el runner
necesita herramientas — ese arma su query con su allowlist explícita) ·
claude-oauth(ÚNICO escritor de `.claude/.credentials.json`: refresca el
access token OAuth con el refreshToken contra
`console.anthropic.com/v1/oauth/token` y el client_id público del CLI. El
refresh token ROTA, por eso escribe atómicamente con modo 0600 y re-lee justo
antes para no pisar un refresh del propio CLI. Guard de concurrencia por owner;
nunca loguea credenciales y ante cualquier fallo devuelve `null` en vez de
lanzar. Exports: `refreshClaudeOauth(owner)`,
`getValidClaudeAccessToken(owner)`) ·
paths(resolveWithinHome/clampToHome — TODA validación de
rutas del cliente pasa por acá; nunca startsWith crudo) ·
arch-uid(fuente ÚNICA del mapeo entre el `uid` de un nodo de
`arquitectura` y la ruta del repo que representa: `mod:<n>` →
`src/modules/<n>`, `fe:<n>` → `public/js/modules/<n>`, `run:<n>` →
`bin/<n>.js` y `file:<ruta>` → la ruta tal cual; cualquier otro prefijo
devuelve `null`. `uidTarget()` valida primero este dato venido del Pad y
rechaza `..`, rutas absolutas o cualquier escape de la raíz. Es un módulo puro
que importa solo `node:path`, sin `config.js`, porque lo usan tanto los CLIs
`bin/cwc-pad-facets.js` y `bin/cwc-facets-snapshot.js` como
`modules/health/facets.js` dentro de runners con entorno limpio; existe para
que el mapeo no viva duplicado en tres lados (`console:CONVE-2085`).
`uidFamily()` deriva `backend`/`frontend`/`runner` del prefijo: `familia` NO
es un cuarto eje de `CONVE-2279`, sino metadata para impedir que un invariante
de backend se inyecte en una unidad frontend) ·
pad-world-refs(frontera compartida entre los mundos: detector de refs
foráneos para Tolkien + reemplazo controlado; listas cerradas de
prefijos, con `TASK-*` interno distinto de `TTASK-*` externo) ·
closed-envelope(sobre cerrado + ledger de intentos de IA: el enum del
prompt se genera con `catalogEnum()` desde el MISMO array que valida la
respuesta; outcomes/errorClass son cerrados y guardan CLASE, nunca el
mensaje crudo. `ai-attempts.jsonl` se ubica por `resolveDataDir()` para
aislamiento multi-tenant correcto y `recordAttempt` persiste sólo una
whitelist explícita de campos. La tabla de precios DUPLICA a propósito
las privadas `pin()`/`pout()` de tokens/index.js porque core no importa
módulos; unificar haciendo que tokens consuma esta fuente es contrato
FORWARD) ·
sdk-settings(settingSourcesFor: fuente ÚNICA de settingSources,
'chat'=user+project+local / 'headless'=project+local sin user /
'none'=[] para texto puro — ver text-only-query) ·
connections-store(app config de instancia + tokens per-usuario +
getAccessToken con refresh) · connections-microsoft(device code
flow) · connections-zoho(grant code Self Client + getOrg +
identidad por listado de agentes) · connections-tolkien(cookie de sesión
Auth.js + storageState y metadata sin secreto; módulo puro compartido que
recibe `dataDir` resuelto y NO importa user-space/config) ·
zoho-desk-client(ESCRITURA a
Desk con la identidad del USUARIO: getTicket/assignTicket/
updateTicket/addComment/uploadAttachment/createTicket; resuelve el
token por username y manda orgId siempre) ·
connections-store GOTCHA: MS_SCOPES incluye Sites.ReadWrite.All; un
cambio de scopes obliga a reconectar porque el refresh token viejo no
cubre el consentimiento nuevo → AADSTS65001 ·
microsoft-sharepoint-client(cliente Graph de SharePoint con identidad
del USUARIO, hermano de microsoft-calendar-client: resuelve el token por
username con getAccessToken. parseSharePointUrl acepta la URL LARGA
pegada del navegador y saca sitio + carpeta del query param `id`;
resolveSite (caché 5 min) · listFolder (pagina @odata.nextLink) ·
downloadFile · uploadFile (simple ≤4 MB, upload session en chunks de
5 MB arriba de eso) · createFolder. GOTCHAS: en Graph la raíz del drive
del sitio YA ES la biblioteca "Shared Documents" ⇒ el path del item es
`/General/NUEVA OFICINA` SIN la biblioteca; carpeta raíz =
`/drive/root/children` pero con path = `/drive/root:{path}:/children`
— nunca `root::/children`; el path se codifica POR SEGMENTO (espacios
→ %20, barras intactas). Un 401/403 se traduce a un mensaje accionable
que pide reconectar Microsoft porque el token viejo no tiene el scope) ·
tool-policy(NÚCLEO de gobernanza de permisos del chat interactivo —
NO es motor, es plomería in-process como sdk-settings/paths: el
estado del modo lo persiste el server (Chat.permissionMode→chats.json)
y lo aplica el runner; acá viven las REGLAS como fuente única.
PERMISSION_MODES (default/acceptEdits/bypassPermissions/plan,
re-exportado por chat/shared.js), normalizeMode, autoApprovesAll y
chatQueryOptions() que arma las opciones de query() del chat con
allowDangerouslySkipPermissions SIEMPRE (contrato del SDK; inerte
salvo en 'Todo'). VERIFICADO 2026-07-06 (SDK 0.3.198): el bypass ya
"shadowea" canUseTool sin el flag, así que el flag NO era la causa de
"elegí Todo y sigue preguntando" — la causa real es DRIFT (el modo no
llega/aplica en el runner) + la tarjeta ya emitida que no se
auto-resolvía; se arregla en el runner (set_mode robusto que emite el
modo REAL en éxito Y fallo + approveAllPending) y en la UI (chat-tab
reconcilia el select con el modo real y avisa si no tomó). Las
allow-rules del settings.json del usuario también shadowean canUseTool:
en 'default' algunas acciones no piden permiso — es la allowlist del
usuario, no un bug. BOOTSTRAP DE PAD (2026-07-12, Gap #1 / TASK-295 de
ROAD-63): chatQueryOptions inyecta CONSOLE_PAD_BOOTSTRAP como
systemPrompt {type:'preset', preset:'claude_code', append} SOLO si el
cwd está dentro del repo de la consola (isConsoleCwd, calculado desde
import.meta.url) — le recuerda al chat cargar `pad_set_workspace console`
+ `pad_project dashboard/next` antes de trabajo no trivial y modelar el
trabajo como TASK/PLAN (bug→BUG), en vez de depender de que el modelo
recuerde CLAUDE.md. Usa preset+append (PRESERVA el prompt nativo de
Claude Code; un string pelado lo REEMPLAZARÍA — catastrófico). Chats de
Tolkien (mundo externo) NO lo reciben (regla dura 12: no un hook global
que alcanzaría a otro workspace). Un runner vivo no lo toma hasta
"Reabrir para cambios"/chat nuevo. Llevarlo a sesiones TUI = Frente B
diferido. La regla 6 (blindaje read-only headless) NO pasa
por acá: esos runners arman sus propias allowlists.
VISUALIZACIÓN INLINE: `VIZ_INSTRUCTION` se agrega al system prompt de
TODO chat (cualquier usuario y ambos mundos) porque el renderer
`public/js/ui/markdown.js` es universal. Avisa los tres formatos que el
navegador entiende: bloque `chart` con JSON, bloque `mermaid` y `{bar:NN}`
solo dentro de una celda de tabla Markdown. Esto NO viola la Regla 12:
describe una capacidad del renderer de la consola y no toca recursos del
mundo externo, el mismo criterio por el que `sessionFolderRule` ya se inyecta
en chats de Tolkien. El propio texto PROHÍBE usar esa sintaxis en artefactos
que salen de la consola —descripciones de PR, comentarios de tickets de Zoho,
ítems del Pad de Tolkien, correos y mensajes de Teams— porque ahí quedaría
como JSON o texto crudo. Es el ÚNICO camino por el que una sesión de Tolkien
se entera de las capacidades de render de la consola: la skill `graficar` no
viaja con ella. Por eso resume ahí la paleta semántica de Mermaid para
`flowchart`/`graph` (`:::key`, `:::ok`, `:::warn`, `:::bad`, `:::info`,
`:::cool`, `:::deep`, `:::muted`). También exige escribir la clase PEGADA
(`:::ok`, nunca `::: ok`) porque un espacio rompe el parseo del diagrama entero;
la regla es reactiva, surgida de un caso real del 2026-07-30 en el chat de un
inquilino. Advierte además que `:::` no existe en `mindmap` ni en
`sequenceDiagram`. La guía larga, con paleta y ejemplos copiables, vive en la
skill `graficar` (`cwc-share: catalog`, `cwc-default: true`), instalada a todo
usuario nuevo por `installDefaults()` de
`src/modules/skills/catalog.js`. Como siempre, un runner YA VIVO no incorpora
esta instrucción hasta "Reabrir para cambios" o una conversación nueva.
AUTONOMÍA EJECUTABLE (2026-07-25): `AUTONOMY_INSTRUCTION` se agrega al
system prompt de TODO chat, no sólo Tándem, porque la convención de la
pelota es global. `declaresBallMine(text)` mira únicamente las últimas 3
líneas no vacías y exige el emoji 🎾 + «pelota…mía»; `autonomyStopHook`
traduce esa declaración a un `Stop` bloqueado para que el SDK continúe el
turno. `mergeHookSets` compone hooks por nombre de evento y conserva juntos
`PreToolUse`/`Stop`; `mergePreToolUseHooks` queda como alias
retrocompatible. La continuación no tiene tope por decisión explícita de
Niko del 2026-07-25: la única salida es declarar `TUYA`, `nadie` u `OTRO`.
REGLA DE CARPETA DE TRABAJO DEL PAQUETE-SESIÓN (PLAN-447, pedido de Niko
2026-07-14): chatQueryOptions ADEMÁS inyecta sessionFolderRule(chatId)
—también preset+append, COMPUESTO con el bootstrap de Pad en un solo
append— pero a DIFERENCIA del bootstrap de Pad va en TODO chat (cualquier
mundo, no solo Consola): le dice al modelo cuál es la carpeta propia de
ESA sesión (chatAttachDir(chatId) = ~/.cwc-data/chat-attachments/<id>/,
la que abre "Abrir carpeta de este chat") y la DISCIPLINA: copiar ahí
TODO archivo trabajable que traiga de una fuente externa (WhatsApp/
Outlook/etc.) con `node <repo>/bin/cwc-attach.js <chatId> <rutaAbs>`,
nunca los temporales. NO cruza mundos (regla 12): habla solo de la
carpeta de runtime propia de la consola, indexada por chatId — no de
recursos de otro mundo, por eso es seguro inyectarla también en chats
de Tolkien. El runner pasa `chatId: ID` a chatQueryOptions; sin chatId
la regla se omite (compone sin romper). Mismo gotcha del bootstrap: un
runner vivo no la toma hasta reabrir/chat nuevo.
LECCIONES PROHIBITIVAS (M5, PLAN-1934): `lessonsPreToolUseHook({chatId,
onDeny, onOverride})` es el gate DURO. A diferencia de
tandemPreToolUseHook (sólo ese modelo), va en TODO chat y en los dos
mundos: "nunca ejecutes X" no depende del modo. El runner lo empuja a
hookSets SIEMPRE (bin/cwc-chat-runner.js). Normaliza el comando con el
shellOutsideQuotes que ya existía y delega el veredicto a
core/forbidden-actions.js; si hay un override consciente vigente lo
CONSUME (un solo uso) y deja pasar. Mismo gotcha de siempre: un runner ya
vivo no toma reglas nuevas de código hasta "Reabrir para cambios" — el
registro en disco, en cambio, se relee por mtime en caliente) ·
`tolkienEnvPreToolUseHook({onNeed})` es el hook POR-SPAWN (no global) de los
chats cuyo cwd es el Tolkien BASE: deniega el primer Edit/Write/MultiEdit/
NotebookEdit —o `delegate_to_codex`— y le avisa al server que hace falta un
entorno aislado. `console:BUG-2092`: emitía `onNeed` UNA sola vez por spawn
(latch). Si la mudanza al worktree fallaba, ese runner no volvía a pedirla nunca
y TODA escritura quedaba denegada para siempre — deadlock silencioso. Ahora es un
THROTTLE de 15 s: vuelve a pedir el entorno mientras la sesión siga afuera, y el
server descarta el pedido redundante (`_provisioningEnv` en curso, o la sesión ya
adentro). El deny y el set de tools no cambiaron.
forbidden-actions(REGISTRO de ACCIONES PROHIBIDAS por lección — M5 de
PLAN-1934/DOC-1926, el ÚNICO gate DURO de la casa. Reglas del tipo "nunca
ejecutes X" con SEED en código (siempre compila) + registro opcional en
<dataDir>/forbidden-actions.json (caché por mtime, FALLA ABIERTO: un JSON
corrupto no puede tapar los chats). evaluateForbiddenAction({toolName,
toolInput, command}) recibe el comando YA normalizado por tool-policy —
no duplica el parser de shell. forbiddenDenyMessage arma el deny citando
la lección + qué hacer en su lugar + cómo pedir el override.
OVERRIDE CONSCIENTE: grantForbiddenOverride/consumeForbiddenOverride sobre
el ledger <dataDir>/forbidden-overrides.json — motivo de ≥20 chars, TTL en
minutos, UN SOLO USO, queda registrado; lo emite la CLI
bin/cwc-forbidden-override.js. Paths por resolveDataDir() = multi-tenant
correcto. LÍMITE HONESTO: sólo entran lecciones traducibles a "no ejecutes
X"; "escribí PRs más chicos" NO es de este registro y no se fuerza) ·
claude-model(VALID_MODELS/encodeCwd/resolveModelArg — REPOINT DE TIER 2026-07-24: el alias interno 'opus' resuelve a `claude-opus-5` SOLO al entregarse a `claude --model`/`q.setModel()`; el alias NO cambia, así keyOf/pin-pout/color/router siguen intactos. Call-sites: bin/cwc-chat-runner.js (spawn + set_model; `currentModel` guarda el ALIAS sin resolver porque alimenta el eco `model` que adopta el server) y terminal/sessions.js (TUI). Un modelo nuevo del mismo tier = una entrada más en MODEL_ARG_OVERRIDES) · claude-state(observador —
estado por PANE de tmux primero: cwc-observe.js captura
$TMUX_PANE (2026-07-05, fix del Pac-Man que no masticaba al
reactivarse una sesión por interfono: el mapeo era SOLO por cwd
y la statusline de una hermana ociosa del mismo cwd lo pisaba);
stateForPane = identidad exacta (tmux/index.js mapea sesión→panes
con list-panes), stateForCwd queda como FALLBACK para estados sin
pane; las tmux abiertas toman el pane en su próximo tick de
statusline, sin reiniciar claude) ·
session-names(nombres ÚNICOS de tarjetas: registro de
registerNameProvider — chat aporta títulos de conversaciones
abiertas, tmux los display names de sus sesiones — +
uniqueName("tolkien"→"tolkien 1") consultado al CREAR chat
(manager.create; rehydrate NO uniquifica) y terminal (si el
basename choca, persiste el único como customTitle en
titles.json, cuyos helpers loadTitles/saveTitles/titleKey ahora
viven acá, compartidos por los módulos tmux y terminal; también
loadOwners/saveOwners/setSessionOwner/ownerForSession sobre
session-owners.json, registro durable id→owner de las sesiones
tmux que terminal/sessions.js consume al rehidratar para no perder
el dueño tras un reinicio, fail-closed si falta la entrada) ·
inventory(INVENTARIO determinístico del proyecto — FASE 1 del
"sistema nervioso": el CLAUDE.md son las REGLAS/receta; el
inventario es el CENSO VIVO "qué existe AHORA". Sin LLM: parsea el
repo con regex e inline. Cataloga módulos backend (archivos ·
registry.js:línea · endpoints), runners de bin/, frontend
{name,mount} y el VOCABULARIO (tokens --cwc-*, env vars,
VALID_MODELS, PERMISSION_MODES) + un FINGERPRINT de contenido por
unidad. Salida: ~/.cwc-data/inventory.json + inventory.md.
generateInventory({force}) es ON-DEMAND: solo re-parsea si cambió
algún mtime/fingerprint. Lo dispara `bin/cwc-inventory.js`. Las
fases siguientes lo CONSUMEN: F2 salud incremental (audita solo
unidades cuyo fingerprint cambió), F3 contexto de chats nuevos,
F4 invariantes, F5 loop que aprende. Para Coherencia, `CANON_SERVICES`
incorpora los CUATRO transversales del aislamiento multi-tenant:
`user-space`, `data-dir`, `system-scope` y `pad-context`; el censo expone
además la señal `persists` por módulo (LEAD por regex), con exenciones
hand-authored en `USER_STATE_PERSISTENCE.exclude` para los módulos cuyo estado
es global A PROPÓSITO: interfono, health, backup, comms y tolkien. Esa señal
alimenta la regla `aislamiento` de `health/coherence-shared.js`, que marca un
módulo backend que persiste estado sin consumir ninguno de los cuatro
(`console:PLAN-2252`). NADIE lo importa aún —
standalone en F1, cero riesgo al server) ·
worlds(FUENTE ÚNICA de worldLabelFor(cwd): etiqueta humana "Mi Consola" /
"Tolkien" / basename, o null si cwd está vacío. `console:BUG-2074`: reemplaza
las copias de bus.js y chat/index.js, que divergieron cuando solo chat aprendió
los worktrees de PLAN-1815 aunque bus todavía afirmaba que era la "misma lógica";
el interfono terminó reportando `world:"tree"` para una sesión Tolkien y la
ocultó de quien la buscaba por ese mundo. Conserva la variante AMPLIA de bus:
config.projectDir y TODAS sus subcarpetas son "Mi Consola". ENVS_DIR se deriva
de config.home
(~/.cwc-data/tolkien-envs), NO se importa de modules/tolkien/env-store.js:
core no depende de modules; si el store cambia esa ruta hay que sincronizarla
acá, precio explícito de no invertir la dependencia) ·
bus(INTERFONO entre sesiones: BUS DE ARCHIVOS determinístico, 0
tokens, en ~/.cwc-data/session-bus/. Dos capacidades: (1)
MENSAJERÍA — sendMessage/pendingFor/markDelivered: una sesión deja
un mensaje para otra (o broadcast 'all'); la destinataria lo recibe
inyectado por su hook en el próximo turno. (2) CLAIMS anti-conflicto
— claimFile/getClaim/releaseFile/releaseAll + evaluateClaim (árbol
zombi: HOT<5min→bloquea · observador ended/working · tmux has-session
· gris<30min soft · TTL vencido→robable) + tombstone (lápida al
zombi robado). IDENTIDAD por "handle": TUI=`tmux:<sesión>`,
chat=`claude:<sessionId>` — una TUI escucha en ambos. buildDirectory
reconstruye el mapa nombre↔handle SIN estado del server (tmux del
socket cwc + chats.json + titles.json). resolveTarget mapea el
`/btw <nombre>` a un handle. Lo consumen bin/cwc-bus.js (hooks/CLI) y
el módulo `interfono` (panel, solo lee). gc() oportunista en cada
invocación)

## Multi-tenant (multiusuario en una consola)

Modelo aprobado por Niko (`PLAN-500`, master; `PLAN-593`/SP1 fija principios e
invariantes; retro completa en `DOC-502`/`DOC-609`). En construcción por
sub-planes (SP1…SP10). Esta sección es la FUENTE DE VERDAD del modelo — una IA
sin contexto previo debe entender acá qué se puede/debe/no-debe tocar (Regla 8).

**Modelo — UN server, N usuarios LÓGICOS (no de SO).** La consola que ya corre
(puerto + ZeroTier listos) MULTIPLEXA varios usuarios; no se instalan consolas
separadas (el enfoque de instancia-separada de `PLAN-476` FALLÓ: ~6h de
reparación remota — login/puerto/MCPs rotos, la sesión abría "como la compu de
Nico" heredando `~/.claude` y rutas del host). Cada usuario tiene una RAÍZ
propia `~/.cwc-users/<userId>/` con su `.claude/`, `.cwc-data/`, `.pad/` y
`workspace/` — helpers en `src/core/user-space.js` (`userSpace`/`userDataDir`/
`userClaudeDir`/`userFileRoot`/`userCodexDir`/`userCodexAuthPath`/`hasCodexCreds`/
`userInfisicalDir`/`userInfisicalConfigPath`/`hasInfisicalCreds`/`userPadDir`/`readUserOauthToken`/
`ensureCliOnboarded`/`userTolkienMcpTokenPath`/`readUserTolkienMcpToken`/`hasTolkienMcpToken`/
`readUserPadToken`/`userPadWorkspace`/`userRunnerEnv`/`ensureUserSpace`). El
HOST (el admin que corre el server) mapea a su HOME real (`hostUser()` →
`config.home`, retrocompat TOTAL); SOLO los inquilinos obtienen root aislado.
`ensureCliOnboarded` mergea `hasCompletedOnboarding: true` en el `.claude.json`
del inquilino para que su CLI no muestre login si ya tiene OAuth; jamás toca al host.
No hay usuarios de SO ni sudo/setuid: el aislamiento se logra apuntando cada
runner a un directorio de config por-usuario (decisión 🅰, `decision-1784076518`).
`GET /api/whoami` devuelve `{type, username, admin, lang, host}`: `host` siempre
es `hostUser()`, incluso para el token maestro, cuyo `username` sigue siendo
`null`.
Los helpers de Infisical apuntan a
`<userSpace>/.infisical/infisical-config.json`, que es donde el CLI persiste su
sesión; para el host conservan `~/.infisical/` y para un inquilino quedan dentro
de su raíz aislada.
`system-scope.js` es la fuente única del menú Sistema: traduce la request o su
principal a `{user, isHost, admin, home, dataDir, claudeDir, workspace,
padWorkspace}` sin derivar rutas del proceso. Para el host (y el token maestro)
devuelve exactamente las rutas históricas y el workspace Pad `console`.

**Blindaje anticonsumo (regla dura, FAIL-CLOSED, `decision-1784080554`).** Es el
riesgo #1 de seguridad/costo y HOY el default estaba roto (el runner heredaba
`process.env` → toda sesión usaba el `~/.claude` de Nico). El runner de un
INQUILINO se spawnea con un env LIMPIO por allowlist (`userRunnerEnv`, JAMÁS
`...process.env`) + `HOME=~/.cwc-users/<owner>` + `CLAUDE_CODE_OAUTH_TOKEN` del
dueño (de `claude setup-token`, NUNCA copiar `credentials.json` — está roto,
`PEND-380`). Sin credencial propia del dueño NO arranca — NUNCA cae a la cuenta
del server. Self-check al arrancar: si es inquilino (owner ≠ host) y su
HOME/creds no están aislados, ABORTA (exit 3) antes de `query()`. Tope 20
sesiones concurrentes por usuario (host acaparamiento: ~0.5-0.8 GB/sesión).

**Regla de NO-CRUCE por usuario×mundo (Regla 12 escalada a per-user,
`decision-1784204001`).** La "confianza plena entre autenticados" del WS (viejo
gotcha) queda DEROGADA para no-admins: cada usuario ve/adjunta SOLO lo suyo
(chats/sesiones/datos/Pad/espacios), el admin ve todo. En `chat/index.js` esto
lo aplican `list(principal)` (filtro de visibilidad: `owner === username` salvo
admin) y `ownedChat(req, id)` (guard: ajeno o inexistente ⇒ null ⇒ 404, sin
revelar que existe); el cwd se clampa con `safeCwd(cwd, owner)` =
`clampToRoot(userFileRoot(owner || hostUser()), cwd)`, JAMÁS al home global.
GOTCHA: `clampToRoot` solo garantiza confinamiento, no existencia. Un destino
relativo ajeno se resuelve DENTRO del root del inquilino y puede producir una
ruta inexistente; todo consumidor de `safeCwd` debe validar además que el
resultado exista y sea un directorio antes de arrancar una sesión o runner.
Además, los dos mundos POR usuario (🏠 "Mi espacio" — "Mi Consola" renombrada
para no-admins; el admin conserva "Mi Consola" real, el repo · 🌳 su clon de
Tolkien) tampoco se cruzan entre sí.

**Datos por usuario.** `~/.cwc-data` se parte por usuario: el server inyecta
`CWC_DATA_DIR=userDataDir(owner)` en el env del runner del inquilino y todo
estado user-scoped resuelve su dir con `resolveDataDir()` (`src/core/data-dir.js`,
honra `CWC_DATA_DIR`). PROHIBIDO hardcodear `path.join(os.homedir(), '.cwc-data')`
para estado de usuario — se colaría al root del host y cruzaría inquilinos.

`console:PLAN-2186` (2026-07-28) — CONVENCIÓN: un módulo COMPARTIDO entre el server y un runner NO importa
`core/user-space.js`. Hacerlo le arrastra `core/config.js` y su exigencia de `CWC_TOKEN` a un runner de inquilino
con env limpio o a un CLI de `bin/`. En su lugar RECIBE la ruta ya resuelta, o un resolver inyectado por el
server, que es el único que sabe de quién es cada dato: el parámetro `dataDir` de `readWindowPressure()`
en `core/model-router.js` (antes leía el `plan-limits.json` del host, así que el AutoTux de un inquilino
conservaba ventana mirando el consumo de Niko), `setChatDataDirResolver()` en `chat/attachments.js` y el
parámetro `claudeDir` de `readTranscript()` en `retro/shared.js`. El complemento es el invariante «DATO
USER-SCOPED NUNCA GLOBAL» de `health/invariants.js`, que ahora prohíbe explícitamente derivar una ruta
user-scoped de una CONSTANTE DE MÓDULO calculada al importar — el patrón exacto por el que se colaron
los seis casos.

**Pad por usuario (`decision-1784076526`, `DOC-633`).** Pad LOCAL multi-cuenta
(modelo Postgres-like: UN motor, datos aislados por cuenta/workspace — NO un Pad
por usuario). Una operación de Pad en nombre de un inquilino usa SU token
(`readUserPadToken`) y SU workspace (`userPadWorkspace` = `tenant-<userId>`),
derivados por `padContextForUser`/`reqPadContext` (`src/core/pad-context.js`).
NUNCA se escribe data de un inquilino con la credencial ÚNICA del host (token de
`~/.pad`) ni en el workspace `console`. Sin token propio provisionado (aún), el
ctx viaja con `token:null` y la op falla limpio (403) SIN contaminar `console`
(hay lazy-provisioning en background). Desde `console:BUG-2287`,
`pad-service-client.resolveCtx` distingue ausencia de ctx de ctx presente: sin
ctx conserva `console`+`~/.pad` por retrocompat; con ctx, `ctx.token` es la ÚNICA
credencial válida y `null` falla cerrado, sin pedir prestado el token del host.
`moveItem(ref, targetCollectionSlug, opts)` llama a
`POST /api/v1/workspaces/{ws}/items/{ref}/move` con body
`{ target_collection }`: el move cambia el prefijo del ref, conserva su número
y aplica el schema del destino, descartando en silencio los campos que ese
schema no declara.

**Molde declarativo de Pad (`pad-mold.js`, v5).** Un workspace nuevo ya no
recibe una fotocopia del schema EN VIVO de `console`: `MOLD` congela en el repo
las nueve colecciones canónicas, en orden (`pendientes`, `planes`,
`temas-de-aprendizaje`, `rutas-de-aprendizaje`, `mejora-continua`,
`contexto-de-tickets`, `bugs`, `arquitectura`, `docs`). La v4 sumó al schema de
`arquitectura` los cuatro campos de facetas de CONVE-2279. La **v5**
(2026-07-29, `console:PEND-2286`) resolvió la tensión que la v4 dejaba abierta:
`tasks` SALIÓ del molde porque sus 245 ítems se fusionaron en `pendientes`, hoy
la colección canónica y única de trabajo (`console:CONVE-2278`). En el mismo
movimiento el schema de `pendientes` ganó cuatro campos —`phase`, `model`,
`effort`, `executor`— que NO son una ampliación sino una corrección: los ítems
del tablero ya los guardaban sin que el schema los declarara. Se declararon
**sin `default`** a propósito: con default, cada PEND nuevo nacería con un
`model=sonnet` inventado.
⚠️ RETIRAR UNA ENTRADA DEL MOLDE NO ES UNA ORDEN DE BORRADO RETROACTIVO. Un
workspace `tenant-*` provisionado con v4 conserva su colección `tasks` intacta;
verificado leyendo `bin/cwc-pad-mold.js`, cuyas tres funciones de comparación
(`missingCollections`, `prefixDivergences`, `schemaDivergences`) iteran `MOLD` y
nunca `present` — una colección viva en el tenant y ausente del molde le es
literalmente invisible, y no existe ningún camino de borrado en ese CLI. Lo que
sí ve el auditor tras la v5 es `schema-divergente=pendientes` (append-only, por
lo tanto migrable con `--apply`) y la versión desactualizada.
Cambiar el molde exige subir `MOLD_VERSION`; así dos altas hechas en días distintos
parten del mismo contrato y tienen un camino explícito de migración. Cada entrada declara
`prefix`: es parte del contrato porque forma el ref visible de todos sus ítems
(`PEND-387`) y no puede quedar librado a la derivación de Pad. GOTCHA CRÍTICO
(`DOC-633`): `schema` es un **string JSON crudo**, no un objeto; cada literal del
molde debe permanecer byte por byte idéntico a la DB fuente y viajar hasta el
POST sin `JSON.parse` ni re-serialización del JSON interno. Al completar todas
las colecciones, `provisionUserPad` registra
`{ "<workspace>": { "version", "ts" } }` en
`~/.cwc-data/pad-mold-state.json`, estado administrativo en el HOME del HOST,
con escritura atómica y mode 600. El CLI de auditoría/migración vive en
`bin/cwc-pad-mold.js`.

**Pozo COMÚN de Mejora Continua (`console:PLAN-2222`, F1 hecha 2026-07-28).**
Existe un TERCER destino de Pad además de `console` y los `tenant-*`: el
workspace **`comunidad`** (`SHARED_WORKSPACE` en **`pad-provision.js`**, override
por `CWC_PAD_SHARED_WORKSPACE`), neutral, con una sola colección
`mejora-continua`. Es donde las lecciones de `project: tolkien` de TODOS los
usuarios se agregan y suman recurrencia ENTRE PERSONAS — la señal que hoy se
cuenta por individuo. **`ensureSharedWorkspace()`** lo crea idempotente con el
token admin; **`inviteUserToSharedWorkspace(userId)`** suma al usuario como
`editor`. Los dos corren best-effort al final de
**`provisionUserPad`**, cada uno en su try/catch: **el pozo jamás puede convertir
un alta válida en error** — es accesorio, no parte del alta. El ctx se deriva con
**`sharedPadContextForUser(userId)`** /
**`reqSharedPadContext(req)`** (**`pad-context.js`**), que a diferencia de
**`padContextForUser`** SIEMPRE devuelve workspace explícito (también para el
host, que si no caería al default `console`) y conserva el fail-closed: un
inquilino sin token propio viaja con `token:null` y la op falla limpio — NUNCA se
cae al token del host, porque una donación escrita con la credencial de Niko
falsearía la autoría. GOTCHA 1: La API de Pad **no expone revocación de
invitaciones pendientes**: `POST /api/v1/workspaces/<slug>/members/invite` crea,
pero ningún método/ruta las borra (`DELETE` sobre esa ruta responde `Member not
found`; sirve para miembros reales, no para pendientes). Por eso
**`inviteUserToSharedWorkspace`** consulta `members` E `invitations` ANTES de
invitar: una invitación de más no se puede deshacer por API. GOTCHA 2: El
`template:'blank'` de Pad NO crea un workspace vacío: `comunidad` nació además
con `conventions` y `playbooks` (esta última con 1 ítem del template). Son ruido
inerte —ningún módulo de la consola las lee— y no se pueden borrar porque Pad
prohíbe eliminar colecciones seeded.

**File-spaces.** `userFileRoot(userId)` confina al inquilino a su `workspace/`
(el explorador se clampa a esa raíz); el host conserva su home completo. El
paquete-sesión (`PLAN-373`) gana `owner` (userId): el paquete sabe de quién es →
el runner arranca con SUS creds/MCPs/cwd.

**Onboarding self-service por TOKEN (`decision-1784088119`, `DOC-526`).** El
admin NO transporta credenciales: emite un token de onboarding (Bearer ACOTADO,
solo el flujo de instalación; no expira por desconexión, progreso persistido
server-side) que el usuario ingresa en el login → wizard de tarjetas donde
conecta su cuenta de Claude (`setup-token`), sus MCPs y sus espacios. El wizard
NUNCA renderiza una terminal (xterm) al usuario final (`decision-1784092575`,
SP10): los procesos reales corren en el BACKEND como runners desacoplados
(regla de oro) y el front consume estado por poll; el input (link/código) se
escribe directo al stdin del hijo. Tras cada paso sensible, una verificación con
`textOnlyQuery` (`src/core/text-only-query.js`, regla 6) interpreta el resultado
y propone una acción si hay error (nunca auto-ejecuta). `cwc-adduser` CLI queda
como bootstrap del 1er súper-admin.

**Invariantes de código anti-regresión (`src/modules/health/invariants.js`,
SEED hand-authored — `PLAN-592`/B-A + `PLAN-593`/SP1).** Un refactor futuro NO
puede reintroducir el fallback a la cuenta del server ni datos globales sin
scope de usuario: el auditor de Salud inyecta estos textos a las unidades que
matchean y los verifica sí o sí. Las 4 familias:

| Familia | Match (archivos) | Qué blinda |
|---|---|---|
| **Blindaje anticonsumo** (B-A) | `chat/runner-link.js` · `core/user-space.js` · `bin/cwc-chat-runner.js` | env limpio (`userRunnerEnv`, jamás `...process.env`), HOME/OAuth del dueño, fail-closed, self-check owner==whoami, `resolveDataDir()` honra `CWC_DATA_DIR` |
| **A · Ownership por usuario** | `chat/index.js` · `terminal/sessions.js` | list/attach/read filtran por `owner` (`list(principal)`/`ownedChat`); `safeCwd` clampa a `userFileRoot(owner)`; confianza-plena-WS derogada para no-admins |
| **B · Dato user-scoped nunca global** | `core/data-dir.js` · `modules/(chat\|tasks\|learning\|retro\|tickets)/` | todo estado de usuario resuelve su dir con `resolveDataDir()`; prohibido hardcodear `~/.cwc-data` del host |
| **C · Pad per-usuario** | `core/pad-service-client.js` · `core/pad-context.js` · `core/user-space.js` | op de Pad de un inquilino usa `readUserPadToken`+`userPadWorkspace` (`tenant-<id>`); nunca la credencial del host ni `console`; fail-closed |

`provisionUserPad` saltea al host con `{ok:true, skipped:'host'}`, simétrico a
`provisionUserWorkspace`, para no crear un `tenant-<host>` fantasma.

OJO: `terminal/sessions.js` aún NO es owner-scoped — su entrada en la familia A
es un contrato FORWARD (cuando gane multi-tenant, el mismo filtro por dueño debe
aplicar). Un archivo puede matchear varias familias (p.ej. `user-space.js` cae en
B-A y C) y recibe todos los textos — es correcto.

## 🔒 Acciones prohibidas por lección (M5 · gate DURO)

`core/forbidden-actions.js` + `lessonsPreToolUseHook()` de `tool-policy.js` son el
único mecanismo de la consola que **impide** en vez de sugerir. Todo el resto de
Mejora Continua termina en texto que el modelo puede ignorar; un hook `PreToolUse`
no se puede ignorar (inmune a `bypassPermissions` y a las allow-rules del
`settings.json`).

| Regla (seed) | Qué deniega | Origen |
|---|---|---|
| `git-descarta-cambios-ajenos` | `git checkout -- …` · `git restore …` (salvo `--staged`) | gotcha del `CLAUDE.md` raíz: descartó ediciones sin commitear de una sesión paralela |
| `pkill-server-mata-el-shell` | `pkill`/`killall` con patrón `src/server.js` | gotcha del `CLAUDE.md` raíz: el patrón mata al propio shell |
| `reboot-de-la-maquina` | `reboot`/`shutdown`/`poweroff`/`halt`/`init 0\|6`/`systemctl reboot` | memoria de Niko: jamás reiniciar la máquina física (el servicio sí) |

**Sumar una regla sin tocar código:** `<dataDir>/forbidden-actions.json` con
`{"rules":[{"id":"…","lesson":"MC-123","title":"…","pattern":"<regex>","why":"…","hint":"…"}]}`.
Se relee por mtime; un JSON inválido se ignora (falla abierto) pero el seed sigue vivo.

**Override consciente:** `node bin/cwc-forbidden-override.js <reglaId> "<motivo ≥20 chars>"`
— vale una sola tool call, vence en minutos y queda en `<dataDir>/forbidden-overrides.json`.
`--list` muestra reglas activas y overrides recientes. El deny le explica al modelo que
lo pida al usuario antes de usarlo: el gate no es ciego, pero tampoco se saltea solo.

**Límite honesto:** sólo lecciones traducibles a *"nunca ejecutes X"*. Una lección de
estilo o de criterio NO entra acá — forzarla degradaría el mecanismo.

## Gotchas de esta carpeta

- `core/worlds.js` referencia config.projectDir y por eso matchea
  `CROSS_WORLD_RE` del check de salud `cross-world`; está deliberadamente en
  `CROSS_WORLD_ALLOW` de `modules/health/index.js`. Cualquier helper nuevo de
  mundos que haga lo mismo necesitará la misma excepción.
- **MCP de Pad (getpad.dev) disponible en Consola** (2026-07-10, pedido del
  usuario "integremos la mcp de pad en consola"): igual que Tolkien
  (`~/.claude.json → projects["/home/nmosquera/tolkien"].mcpServers.pad`), el
  proyecto Consola tiene su PROPIA entrada en scope LOCAL —
  `~/.claude.json → projects["/home/nmosquera/claude-web-console"].mcpServers`.
  CERO cambios de código: `settingSourcesFor('chat')` de `core/sdk-settings.js` YA
  incluye `'local'`, que es la fuente que el SDK usa para resolver `mcpServers` — no
  hace falta pasar `mcpServers` a mano en `chatQueryOptions()`. Deliberadamente en
  scope LOCAL (no en un `.mcp.json` versionado): es personal/OAuth de Nico. Alcance:
  SOLO chats interactivos (`settingSources: ['user','project','local']`) — ningún
  runner headless lo carga (todos usan `settingSources: []` o, los 3 de Teams/comms,
  `cwd=Tolkien`, nunca cwd=Consola). MISMO gotcha de siempre: un chat YA VIVO no
  relee `~/.claude.json` — hace falta "Reabrir para cambios" (menú ⋯ de Sesiones) o
  una conversación nueva para que `ToolSearch` empiece a encontrar las tools nuevas.

  **CUTOVER A SELF-HOSTED LOCAL (2026-07-11/12, ver ROAD-74 en Pad workspace
  `console` para el detalle completo de las 4 fases).** El pedido de self-host fue
  denegado, ESCALADO y RE-APROBADO por un superior de Niko con la condición de
  binario local (sin Docker) + impacto de recursos medido antes de aprobar. Hoy:
  - **`pad`** (nombre CANÓNICO, PRIMARIO) = Pad **LOCAL self-hosted** — transporte
    **stdio** (`claude mcp add --scope local pad -- ~/.local/bin/pad mcp serve
    --url http://10.213.222.192:7777`), NO HTTP (el binario local NO expone HTTP
    MCP, solo el CLI habla JSON-RPC por stdio; el server web en el puerto 7777 es
    la SPA, no un endpoint MCP). Instalado en `~/.local/bin/pad` (v0.9.2, checksum
    verificado), servido por systemd de usuario `~/.config/systemd/user/pad-local.service`
    (`ExecStart=%h/.local/bin/pad server start --host 10.213.222.192 --port 7777`,
    `CPUQuota=200%` = techo de 2 núcleos con holgura, `MemoryMax=4G`/`MemoryHigh=3G`
    = techo sobredimensionado para crecer — pedido explícito de Niko, uso real
    medido ~50MB RAM/0% CPU idle). Bind por la IP ZeroTier (no solo loopback) para
    que sea accesible igual que la propia Consola. El default de URL vive en
    `src/core/pad-url.js` como fuente única: el 2026-08-03 la IP ZeroTier de esta
    máquina cambió de `.62` a `.192`, y `.62` quedó asignada a otro nodo. La
    resolución es dinámica: `CWC_PAD_URL` explícita → IP ZeroTier detectada con
    `findZeroTierIp()` → fallback. Tanto `readSessionToken` (host) como
    `readUserPadToken` (inquilinos) toleran un `credentials.json` indexado por una
    URL vieja cuando hay una sola credencial guardada. Auth del CLI vía flujo
    browser-based (`pad auth login`, Niko aprueba él mismo en su navegador — nunca
    se tocó su password). Workspace `console` migrado 1-vía desde el cloud
    (104/104 items: Docs/Bugs/Tasks/Conventions/Playbooks/Roadmap Items/Roles,
    verificado conteo por conteo, jerarquía Tasks↔Roadmap re-vinculada con los refs
    nuevos) — el cloud NUNCA se escribió durante la migración.
  - **`pad-cloud-backup`** = el `pad` cloud original (`https://mcp.getpad.dev`,
    HTTP), renombrado y conservado SOLO como respaldo pasivo durante la ventana de
    pruebas + integración (pedido explícito de Niko: "el funcionamiento debe estar
    100% local" una vez cortado, la nube nunca se usa operativamente después de
    eso). Puede pedir reautenticación tras el rename (el OAuth de Claude Code se
    cachea por `serverName+serverUrl`) — inocuo mientras no se use; se re-autoriza
    solo al primer uso real si algún día hace falta un rollback.
  - **Alcance del cutover — SOLO el workspace `console`.** El workspace `tolkien`
    (usado por `src/modules/tickets/pad-client.js` para el dashboard de PRs, ver
    abajo) se dejó DELIBERADAMENTE fuera (decisión explícita de Niko 2026-07-12):
    el Pad local NO tiene ese workspace y migrarlo es un proyecto aparte (impacto en
    equipo — Chris/otros podrían usar ese workspace en la nube). `pad-client.js`
    sigue leyendo Tolkien desde el cloud, sin cambios.

- **Programa "Modularización Consola" trackeado en Pad** (workspace `console`,
  2026-07-11): el escaneo módulo-por-módulo (B0→B5: coherencia, tickets, health,
  comms, learning, chat, tasks, tokens + 10 hojas) vive en Pad como ROAD-10 (programa)
  + TASKs por pasada + BUGs `codex:pending` (backlog de lo diferido a re-verificar con
  Codex cuando su cuota vuelva) + Convenciones (reglas duras) + Playbooks (codex-verify,
  module-scan) + Roles. Hallazgo transversal del programa: el bug MÁS recurrente fue la
  **escritura NO atómica de estado durable** — se aplicó `writeJsonAtomic`/`writeFileAtomic`
  de `core/atomic-write.js` (tmp por-PID) en meta-store, comms, learning, chat, tasks,
  tokens, projects/memory (CLAUDE.md/memorias) y core (session-names/recents/trash).
  DOS huecos de seguridad reales cerrados: `fixToolAllowed` (allowlist del auto-fix
  dejaba pasar `node --check a.js⏎<cualquier-cmd>`) y `teamsWriteAllowed` (el `^send`
  autorizaba cualquier `graph_send_*`). Decisión de rol de Pad en `docs/evaluacion-rol-pad.md`
  (Opción 1 cloud, ejecutada primero) — **ACTUALIZADO 2026-07-12: el self-host de
  ROAD-74 se re-aprobó y se ejecutó (Fases 1-2 completas, ver bullet de arriba); este
  workspace `console` con TODO su historial (ROAD-10 incluido) vive ahora físicamente
  en el Pad LOCAL, migrado 1-vía desde el cloud.**

- **Pad: `parent` es un LINK, no un campo** (medido en vivo 2026-07-26,
  `console:BUG-2053`; refs calificadas por workspace según
  `console:CONVE-2056`). Mandar `parent=X` en `pad_item update` sobre un ítem que
  YA tiene padre responde 200 pero deja dos verdades incompatibles: crea el link
  `parent` al target nuevo, degrada el link viejo a `implements` en vez de
  borrarlo, y `GET /items/<ref>` conserva el `parent_ref` viejo mientras
  `GET /items/<ref>/links` muestra el `parent` nuevo. En la medición de
  `PLAN-507`, al actualizar a `ARQUI-1425`, `parent_ref` siguió en `ARQUI-1271`,
  apareció `parent → ARQUI-1425` y el anterior quedó como
  `implements → ARQUI-1271`; sin padre previo el update sí funciona limpio. Por
  eso reparentar SIEMPRE es read-modify-write de aristas: tomar del ítem el
  `parent_link_id`, quitar el viejo con `deleteLink` y recién fijar el nuevo con
  `setParent`; NUNCA usar `updateItem`/`pad_item update` con `parent=`.
  Corolario peligroso: `parent_ref` es DERIVADO del link disponible sin importar
  su tipo — si la única arista es `implements`, Pad igualmente reporta su target
  como `parent_ref`. La regla falsa de que un `implements` coincidente era un
  duplicado redundante de otro `parent` (`console:BUG-2046`, punto retirado)
  llevó a borrar 531 links y dejó 506 ítems sin aristas; el backup permitió
  restaurarlos al 100%, pero la ejecución correcta no salvaba una premisa falsa.
  Regla de `console:MC-2055`: antes de CUALQUIER borrado masivo basado en que dos
  campos coinciden, demostrar primero que representan dos cosas distintas:
  listar las aristas reales, separarlas por tipo y contarlas antes de borrar.
  Además, el listado de colección y el detalle individual derivan `parent_ref`
  de links DISTINTOS. Evidencia: `console:TASK-478` tenía simultáneamente
  `implements → console:PEND-382`, `implements → console:PEND-387` y
  `parent → console:PLAN-476`; en el mismo instante,
  `GET /items/TASK-478` devolvía `parent_ref=PLAN-476` (el link `parent`
  correcto), mientras `GET /collections/tasks/items` devolvía
  `parent_ref=PEND-387` (uno de los `implements`). En una muestra de 25 ítems de
  `tasks`, 3 discrepaban (12%): `console:TASK-618` (listado
  `console:TASK-569`, individual `console:PLAN-655`), `console:TASK-1877` y
  `console:TASK-1876` (listado `console:ARQUI-*`, individual
  `console:PLAN-500`). Esto cierra el mecanismo de `console:BUG-2053`: la regla
  leía el `parent_ref` del listado y borraba el `implements` cuyo target
  coincidía; cuando el listado había derivado el campo de ese mismo
  `implements`, no detectaba duplicación sino mera existencia.
  Regla operativa: para topología —contar hijos, construir jerarquías, detectar
  huérfanos o tomar cualquier decisión sobre el grafo— NUNCA usar el
  `parent_ref` del listado de colección. Leer las aristas reales con
  `GET /items/<ref>/links` o usar el detalle individual. El listado sirve para
  inventario (refs, títulos y `fields`), no para estructura.
  El guard de `bulk-update` rechaza cerrar un ítem con `open_children` usando la
  topología verdadera: frenó el cierre de `console:PLAN-476` al señalar como
  hijo `todo` a `console:TASK-478`, aunque el conteo basado en el listado lo
  daba por terminado. Es una baranda que ve más que esos conteos: NUNCA pasar
  `force` sin revisar primero qué está señalando.

- **Medición del bootstrap de Pad** (`pad-service-client.js`, BUG-2047):
  `getBootstrap()` hace un GET read-only directo a
  `/api/v1/workspaces/<workspace>/agent/bootstrap`, sin caché, y conserva en
  `bytes` el tamaño de la respuesta HTTP real. El bypass de caché es deliberado:
  el check `pad-bootstrap` de Salud vigila crecimiento del blob generado por el
  server y un hit sin bytes o una reserialización podrían esconderlo. Pad caído
  sigue devolviendo `{ok:false, error}`; nunca propaga una excepción al caller.

## Verificador de contratos (pad-contracts.js) — perfiles

El verificador determinístico admite dos perfiles de checks.
`console` es el perfil histórico: conserva sus checks frontend/backend, su orden
y su flujo de lectura de Pad sin cambios de comportamiento.
`tolkien` agrega tres reglas mecánicas sobre un diff del repo externo:
`migrationOrder` y `schemaSinMigracion` (módulo `prisma`), y
`handlerSinProductor` (módulo `worker`).

**Cobertura real de los contratos (BUG-2048, medida 2026-07-26).** “Obligación
verificable” no significa que `pad-contracts.js` la ejecute: de las 41
obligaciones declaradas por los seis contratos, 13 están mecanizadas (32%).
Lo demás es prosa para la sesión y NO debe leerse como un gate automático.

| Contrato | Obligaciones declaradas | Mecanizadas | Consumidor real |
|---|---:|---:|---|
| `CONVE-1943` módulo FRONTEND | 10 | 5 | `CONSOLE_CHECKS.frontend` |
| `CONVE-1944` módulo BACKEND | 9 | 4 | `CONSOLE_CHECKS.backend` |
| `CONVE-1945` cerrar cambio | 11 | 0 | ninguno |
| `CONVE-1958` anclar/contrastar | 8 | 2 | check `ancla` de Salud |
| `CONVE-1964` verificador Tolkien | 3 | 3 | `TOLKIEN_CHECKS` |
| `CONVE-1969` lecciones adoptadas | 1 | 1 | capa `leccion` |

En particular, `CONVE-1945` y `CONVE-1958` dicen “Consumido por: el emisor de
tareas de `pad-index.js`”, pero ese consumidor no existe. Hasta que los ítems de
Pad se corrijan, esta tabla es la fuente honesta: `pad-index.js` enruta/trae los
contratos y `pad-contracts.js` emite solo las obligaciones enumeradas arriba.

Además de esas dos capas estáticas existe una tercera capa `leccion`, data-driven:
el destino `contrato` de Mejora Continua alimenta
`<dataDir>/lesson-contracts.json`, resuelto siempre con `resolveDataDir` y nunca
con `~/.cwc-data` hardcodeado. Cada entrada puede declarar una regla
`fileExists`, `grepPresent` o `grepAbsent`; si no declara regla queda
`skipped` con un motivo concreto y jamás se informa como incumplida. El
`module` del check es su ref `MC-n`, sin barras porque el marcador
`cwc-contract` no las admite en ese segmento. Los contratos citados por estas
lecciones se agregan al fetch de `collect()`, pero NO al perfil: el índice
enrutador del CLAUDE.md raíz no crece. El dialecto de glob se reimplementa
localmente a propósito, porque `core/` no importa desde `src/modules/`.

Las reglas viven aisladas en `tolkien-checks.js` y no mutan el repo analizado.
Ese módulo sólo lee `~/tolkien` y ejecuta `git` mediante `execFileSync`.
La allowlist admite exclusivamente subcomandos read-only:
`diff`, `grep`, `log`, `show`, `ls-tree`, `rev-parse`, `merge-base` y `cat-file`.
Cualquier otro subcomando falla explícitamente por la Regla dura 12.
El repo Tolkien y su workspace de Pad siguen siendo mundos externos read-only.
`emitTasks` reutiliza el motor idempotente, pero para Tolkien escribe SIEMPRE
las tareas en el workspace interno `console`.
Un perfil Tolkien con otro workspace es un error de configuración y tira.
`TOLKIEN_PROFILE.dest` es `null`, para que `pad-index.apply()` tampoco pueda
escribir un índice Markdown en el mundo externo.
El `module` de cada check Tolkien es un slug estable por dominio, no por archivo:
el marcador `cwc-contract` idempotente no admite barras en ese segmento.
Todo check que no aplica devuelve `ok: null`; nunca se informa como incumplido.
Además, su `detail` debe empezar con `skipped:` y explicar el motivo concreto.
Se descartaron por medición: `catchVacio` (0 recall), `stringDeDisplay`
(único disparo falso), `autorizacionDuplicada` (la duplicación es semántica,
no textual) y `datoSensibleGenerico` (0 disparos con términos estrictos y
10/21 falsos positivos potenciales al incluir términos de identidad).
Gotcha: `migrationOrder` compara con las migraciones existentes en `base`.
Para el gate vivo debe ser `origin/main`; al analizar un PR histórico hay que
pasar su `baseRefOid`, o el tip actual puede producir fallas espurias.
