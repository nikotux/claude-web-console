<!-- cwc:ficha-modulo -->
# src/core — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### src/core/                   config(.env + config.instance) · instance-config(capa de config
de INSTANCIA: identidad+cliente en ~/.cwc-data/instance.json,
autogenerado; DEFAULTS genéricos vacíos (los valores reales viven en
instance.json), deepMerge por union de claves — ver módulo env-vars) ·
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
paths(resolveWithinHome/clampToHome — TODA validación de
rutas del cliente pasa por acá; nunca startsWith crudo) ·
sdk-settings(settingSourcesFor: fuente ÚNICA de settingSources,
'chat'=user+project+local / 'headless'=project+local sin user /
'none'=[] para texto puro — ver text-only-query) ·
connections-store(app config de instancia + tokens per-usuario +
getAccessToken con refresh) · connections-microsoft(device code
flow) · connections-zoho(grant code Self Client + getOrg +
identidad por listado de agentes) · zoho-desk-client(ESCRITURA a
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
F4 invariantes, F5 loop que aprende. NADIE lo importa aún —
standalone en F1, cero riesgo al server) ·
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
`userClaudeDir`/`userFileRoot`/`userCodexDir`/`userCodexAuthPath`/`hasCodexCreds`/`userPadDir`/`readUserOauthToken`/
`readUserPadToken`/`userPadWorkspace`/`userRunnerEnv`/`ensureUserSpace`). El
HOST (el admin que corre el server) mapea a su HOME real (`hostUser()` →
`config.home`, retrocompat TOTAL); SOLO los inquilinos obtienen root aislado.
No hay usuarios de SO ni sudo/setuid: el aislamiento se logra apuntando cada
runner a un directorio de config por-usuario (decisión 🅰, `decision-1784076518`).

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
Además, los dos mundos POR usuario (🏠 "Mi espacio" — "Mi Consola" renombrada
para no-admins; el admin conserva "Mi Consola" real, el repo · 🌳 su clon de
Tolkien) tampoco se cruzan entre sí.

**Datos por usuario.** `~/.cwc-data` se parte por usuario: el server inyecta
`CWC_DATA_DIR=userDataDir(owner)` en el env del runner del inquilino y todo
estado user-scoped resuelve su dir con `resolveDataDir()` (`src/core/data-dir.js`,
honra `CWC_DATA_DIR`). PROHIBIDO hardcodear `path.join(os.homedir(), '.cwc-data')`
para estado de usuario — se colaría al root del host y cruzaría inquilinos.

**Pad por usuario (`decision-1784076526`, `DOC-633`).** Pad LOCAL multi-cuenta
(modelo Postgres-like: UN motor, datos aislados por cuenta/workspace — NO un Pad
por usuario). Una operación de Pad en nombre de un inquilino usa SU token
(`readUserPadToken`) y SU workspace (`userPadWorkspace` = `tenant-<userId>`),
derivados por `padContextForUser`/`reqPadContext` (`src/core/pad-context.js`).
NUNCA se escribe data de un inquilino con la credencial ÚNICA del host (token de
`~/.pad`) ni en el workspace `console`. Sin token propio provisionado (aún), el
ctx viaja con `token:null` y la op falla limpio (403) SIN contaminar `console`
(hay lazy-provisioning en background). El host conserva `console`+`~/.pad` por
retrocompat.

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
    --url http://10.213.222.62:7777`), NO HTTP (el binario local NO expone HTTP
    MCP, solo el CLI habla JSON-RPC por stdio; el server web en el puerto 7777 es
    la SPA, no un endpoint MCP). Instalado en `~/.local/bin/pad` (v0.9.2, checksum
    verificado), servido por systemd de usuario `~/.config/systemd/user/pad-local.service`
    (`ExecStart=%h/.local/bin/pad server start --host 10.213.222.62 --port 7777`,
    `CPUQuota=200%` = techo de 2 núcleos con holgura, `MemoryMax=4G`/`MemoryHigh=3G`
    = techo sobredimensionado para crecer — pedido explícito de Niko, uso real
    medido ~50MB RAM/0% CPU idle). Bind por la IP ZeroTier (no solo loopback) para
    que sea accesible igual que la propia Consola. Auth del CLI vía flujo
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

## Verificador de contratos (pad-contracts.js) — perfiles

El verificador determinístico admite dos perfiles de checks.
`console` es el perfil histórico: conserva sus checks frontend/backend, su orden
y su flujo de lectura de Pad sin cambios de comportamiento.
`tolkien` agrega tres reglas mecánicas sobre un diff del repo externo:
`migrationOrder` y `schemaSinMigracion` (módulo `prisma`), y
`handlerSinProductor` (módulo `worker`).
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
