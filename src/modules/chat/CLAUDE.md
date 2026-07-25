<!-- cwc:ficha-modulo -->
# src/modules/chat — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### chat/                     conversaciones SDK: index.js (server) · shared.js (común) ·
runner-link.js (spawn/connect) · attachments.js (adjuntos) —
el motor real es bin/cwc-chat-runner.js.
ROBUSTEZ DE SESIÓN NUEVA Y PRIMER TURNO (2026-07-15, PLAN-494 del Pad
`console`, 4 bugs — ideas de Niko): (BUG-496) un chat NACE con un
sessionId propio — `create()` genera `randomUUID()` y el constructor
hace `this.sessionId = resume || randomUUID()` en vez de esperar al
primer `system/init`. Así es persistible desde el segundo cero →
`persist()` (su filtro `c.sessionId` ahora siempre pasa) lo snapshotea →
`rehydrate()` lo revive → `_cleanupOrphans()` ya no mata su runner en un
reinicio del server (ANTES la sesión nueva sin mensaje moría y salía
"Conversación inexistente"/fantasma). El SDK v0.3.198 acepta la opción
`sessionId` de query() → `--session-id <uuid>` (CREA con nuestro id);
EXCLUYE `resume` (prohibido combinarlos sin forkSession). `_startEngine`
elige entre `--session-id` (primer arranque) y `--resume` (ya hay
historial) con `transcriptExists(cwd, sessionId)` (ground-truth de disco,
NO una banderita). Plomería: `chatQueryOptions` acepta `sessionId`
(tool-policy.js, spread exclusivo con resume) · `spawnRunner` (runner-link.js)
arg `--session-id` · el runner lo parsea (`SESSION_ID`) y lo pasa. Efecto
colateral bueno: el handle de Interfono `claude:<sessionId>` se conoce
desde create() (adiós `from: null` del primer arranque).
(BUG-497) AutoTux ya NO hace hot-swap de modelo en el PRIMER turno: el
`set_model` EN VIVO sobre un motor recién nacido (query aún no
inicializada) chocaba con el arranque del primer prompt y el turno quedaba
colgado (se veía el cambio de agente pero no ejecutaba). Semáforo
`_started` (persistido, set en sendUser al 1er dispatch; en rehydrate =
`s.started ?? transcriptExists`): `sendUser` calcula `firstTurn=!_started`
y `_applyModelRouter(text, idle, firstTurn)` retorna temprano si firstTurn.
El turno 1 corre en la BASE — que ahora es **Sonnet · effort high** (pedido
de Niko: entorno de trabajo, arrancar sólido y ajustar desde el turno 2):
el constructor y `setModelChoice('auto')` fijan effort 'high' para el
baseline 'auto' (salvo `_effortPinned`). AutoTux sube/baja normal desde el
turno 2 (cuando el set_model en vivo ya funciona). `_started` se persiste
(campo `started`) y restaura.
(BUG-495) los banderines de modelo (🤖) y mundo (🏠/🌳) del header ya no se
pierden al REABRIR el motor: FUENTE ÚNICA `_historyPayload(extra={})` (los
12 campos: model/modelChoice/effort/effortPinned/cwd/world/packageRef/…)
usada por `attach()` y por los 3 reenvíos de `history` tras respawn
(reopen · _toChat · moveToWorld) — antes esos 3 mandaban un payload PELADO
y el front repintaba el header con campos vacíos, escondiendo los badges.
(BUG-498) el borrador del composer ya no se pierde: se respalda en
`localStorage` por id (`cwc:chat-draft:<id>`, chat-tab.js) — guardar al
tipear, restaurar al construir la ChatTab (sobrevive al rebuild total del
pane de main.js), limpiar al enviar OK; y el handler `history` re-habilita
el input si un `closed` previo lo dejó `disabled`. Los 4 verificados E2E
(WS + Playwright + reinicio real). BUG-504 RESUELTO (2026-07-22): reopen
dentro de ~10s del último spawn fallaba con "Ya se está lanzando"
(spawn-lock). El guard `spawnLockAlive` de runner-link.js cubre solo
fork+exec+bind; una vez que reopen()/quiesce() VERIFICARON el descarte
real del link (socket cerrado = autoridad de "vivo"), ese lock es basura.
`releaseSpawnLock(id, pid)` (runner-link.js) lo VENCE poniéndole `ts:0` —
match EXACTO por pid, así solo se libera el lock del spawn PROPIO ya muerto
y un lock ajeno (otro proceso server solapado en un restart) sigue
bloqueando: la ventana TOCTOU cross-proceso NO se ensancha. OJO: el archivo
`.spawnlock` NO se borra a propósito — `src/modules/stats/index.js`
(pidForChat) lee de ahí el pid del runner para el RSS por usuario del
multi-tenant. `Chat._startEngine` guarda `this._spawnPid` (efímero, NO
persiste) y reopen() (ambas ramas) + quiesce() liberan tras verificar
`!this.link`.
ADJUNTOS DE ARCHIVOS (2026-07-10, pedido de Niko: "adjuntar imágenes/
archivos como en claude.ai, que el modelo los interprete sin
describirlos"): UN solo botón 📎 en el composer (chat-tab.js) + pegar
(Ctrl+V) + arrastrar-y-soltar — la consola DETECTA el tipo sola, sin
botones por tipo. Cada archivo se sube al toque a POST
/api/chat/attachment?id=<chatId> (multer, escritura a disco con
límite de tamaño DURANTE el streaming — nunca buffea a memoria) a la
carpeta PROPIA del chat ~/.cwc-data/chat-attachments/<chatId>/ (estado
de runtime, regla 4). Al enviar el mensaje viajan solo las REFERENCIAS
{name,type,mime} por el WS/HTTP (no el base64); el RUNNER lee cada
archivo del disco y arma el content del SDK según su tipo
(chat/attachments.js buildUserContent): imagen (jpeg/png/gif/webp) →
bloque `image` base64 (visión nativa) · PDF → bloque `document`
base64 · TEXTO (txt/md/csv/código/json/yaml/…) → contenido INLINE en
un bloque `text` (el modelo lo lee directo, sin describir) · BINARIO
(docx/xlsx/zip/…) → nota con la ruta absoluta (la API no tiene bloque
nativo; el modelo lo abre con Read/Bash si lo necesita). SIN adjuntos,
el content sigue siendo un STRING (retrocompat TOTAL). Límites propios:
4 imágenes · 8 adjuntos por mensaje · 10 MB imagen · 32 MB PDF · 20 MB
otros. SEGURIDAD (invariante en health/invariants.js): todo nombre se
reduce a un BASENAME validado (safeAttachName) y se confina a la
carpeta del chat (attachPath exige que path.dirname sea EXACTO) — el
traversal ../../.env da 404; el límite de tamaño se aplica ANTES de
leer a memoria. GET /api/chat/attachment?id=&name= sirve el archivo
(imágenes/PDF inline, resto descarga forzada, nosniff) para las
miniaturas de la burbuja. VISTA: la burbuja del usuario muestra
miniatura (imagen, click → lightbox) o chip (PDF/archivo). El
transcript del SDK persiste imágenes/PDF solo, así que al reabrir el
chat loadTranscriptEvents deriva CHIPS de tipo de los bloques image/
document (sin miniatura — no hay nombre en disco en el replay; la
imagen real sigue en la carpeta). MENÚ ⋯ de la tarjeta de Sesiones:
"Abrir carpeta del chat" (sessions.js) → GET /api/chat/folder?id=
asegura la carpeta y devuelve la ruta relativa al home; abre el
Explorador existente (deep-link ?path=) en esa carpeta — reuso total,
cero UI nueva (idea de Niko: ya tenemos explorador, no un menú de
artefactos aparte).
IMÁGENES QUE DEVUELVE EL ASISTENTE (2026-07-11, pedido de Niko: "que las
imágenes que vos leés/generás se vean en el chat, con el mismo flujo de
los adjuntos"): la dirección INVERSA de los adjuntos (asistente→humano).
Problema: cuando el modelo usa `Read` sobre una imagen (un PNG del repo,
un screenshot de Playwright), el SDK la devuelve como bloque `image`
base64 dentro del tool_result — el runner solo extraía el TEXTO
(resultText) así que el chip quedaba "sin salida" y Niko NO veía la
imagen (sí la veía el modelo). SOLUCIÓN (mismo flujo que los adjuntos,
dirección invertida): el RUNNER (bin/cwc-chat-runner.js `saveToolImages`)
detecta los bloques `image` base64 de CADA tool_result, los MATERIALIZA
en la MISMA carpeta de adjuntos del chat (chatAttachDir(ID), reusa
safeAttachName/IMAGE_MIME de chat/attachments.js) con nombre
`asst-<toolUseId>-<n>.<ext>`, y emite en el evento tool_result solo la
REFERENCIA `images:[{name,type,mime}]` — el base64 NUNCA viaja por el WS
(pesado); el front pide la miniatura a GET /api/chat/attachment como con
cualquier adjunto. Topes propios: 4 imágenes por tool_result · 12 MB por
imagen · solo png/jpeg/gif/webp; best-effort (si no puede escribir, el
turno sigue sin miniatura). El FRONT (chat-tab.js `_toolResult`): si el
evento trae `images`, inserta una tira de miniaturas clickeables
(→ lightbox) DESPUÉS del `.chat-toolgroup` del chip, REUSANDO `_attsEl`
(el mismo método de los adjuntos del usuario — usa this.id + el endpoint)
con la clase `.chat-toolimgs` + guard por data-tool-id (un replay de
hello.events al reconectar no duplica la tira). Estilo `.chat-toolimgs`
en style.css (hereda .chat-att-img). SEGURIDAD: el nombre lo genera el
runner y pasa por safeAttachName/attachPath (misma validación anti-
traversal de los adjuntos); el endpoint sirve inline con nosniff.
ALCANCE — FASE 1 = EN VIVO + reconexión al runner vivo (el evento
tool_result con `images` va en el history, así que hello.events lo
re-emite mientras el runner viva). Un chat DORMIDO reabierto desde el
transcript del SDK (loadTranscriptEvents) NO re-deriva las miniaturas —
las imágenes siguen en la carpeta del chat (accesibles por "Abrir carpeta
del chat"), pero re-pintarlas en el replay del transcript es FASE 2
pendiente. Verificado E2E: un chat haiku que hace Read de un PNG lo
materializa en su carpeta + emite el tool_result con images; el endpoint
sirve la imagen y `_attsEl` arma la miniatura correcta.
README.md documenta la config que hereda el chat (Fase 8:
settingSources user+project, comandos slash, observador). Modelo
EN VIVO (POST /api/chat/model, WS set_model): con motor corriendo
usa q.setModel() del SDK (mismo mecanismo que setMode/
setPermissionMode, sin perder contexto); dormido, solo actualiza
chat.model para el próximo spawnRunner. Antes solo existía para
sesiones tmux (`/model` tipeado a la TUI) — ahora el menú ⋯ de una
conversación en Sesiones también tiene "Cambiar modelo".
REABRIR PARA CAMBIOS (menú ⋯ de una conversación en Sesiones,
2026-07-06, pedido del usuario): mata el runner desacoplado vivo
y levanta uno FRESCO sobre la MISMA sesión (`--resume`: conserva
contexto, NO cierra la conversación) para que un chat vivo tome
cambios de CÓDIGO nuevos tras un deploy — un runner spawneado
antes del deploy importó el código viejo (PERMISSION_MODES,
bypassPermissions, allowlists) y no los toma hasta dormirse/
reabrirse. Método `Chat.reopen()` (index.js): motor dormido ⇒
`_ensureEngine()` directo; motor vivo ⇒ sleep + ESPERAR el
descarte REAL del link viejo (`while (this.link)` con deadline
SWITCH_CLOSE_MS) antes de re-spawnear — OJO: el runner emite el
evento `closed` y RECIÉN ~2s después cierra el socket, así que
`_waitEngineDown` resuelve con `this.link` aún seteado; spawnear
ahí haría early-return de `_ensureEngine` Y el runner nuevo se
suicidaría ("ya hay un runner vivo"). Tras el respawn fija
`_setStatus('waiting')` (el runner arranca en waiting pero no
emite status si no cambia → quedaría un working/delegating stale).
Emite evento `reopened` (nota en chat-tab.js). Endpoint POST
/api/chat/reopen {id} (molde de /mode). SOLO conversaciones Chat
(el ítem se oculta con `isTui` en sessions.js; una TUI se reinicia
desde la terminal). Confirm en el front SOLO si status==='working'
(cortaría el turno en curso).
MOVER A OTRO MUNDO — handoff de sesión cross-cwd (2026-07-14, F1 de
PLAN-373/PEND-386 del Pad `console`, "Sesiones Portables"): mudar una
conversación de un `cwd`/MUNDO a otro (🏠 Consola ↔ 🌳 Tolkien)
conservando TODO el contexto, sin copiar/pegar ni reconstruir. Caso
disparador: WhatsApp lee en Consola → crear tracking en Tolkien (hoy
la herramienta de un mundo NO puede hablar con la del otro — Regla 12 —,
así que la sesión se MUDA con su contexto en vez de enlazarse en vivo).
MECANISMO = MOVE TRANSPARENTE EN EL LUGAR (rediseño 2026-07-14 por
feedback de Niko: la 1ª versión forkeaba + creaba tarjeta nueva +
archivaba el origen, y se SENTÍA "fotocopia + sobra en Archivados" — la
operación esperada es que la MISMA conversación se MUEVA, sin rastro).
Ahora `ChatManager.handoff(id, destCwd)` (index.js) muta la conversación
EN EL LUGAR: la MISMA `sessionId`, el MISMO chat id (misma tarjeta), la
MISMA carpeta de adjuntos. Pasos: quiesce (`Chat.quiesce()` — sleep +
_waitEngineDown + esperar el descarte REAL del link, mismo cuidado que
reopen: el transcript debe estar COMPLETO antes de moverlo) →
`moveTranscript()` (MUEVE el `.jsonl` + subagentes al projectKey del
destino — `~/.claude/projects/<encodeCwd(cwd)>/`, el SDK indexa por
projectKey = sanitized cwd, sdk.d.ts:4370 — con copia→verifica→borra
origen: tras el move la sesión vive SOLO en el destino) → escribir
manifiesto (F2) + `_pendingHandoffNote` → flipear `chat.cwd = dest` +
`chat.resume = sessionId` + recargar history → `_ensureEngine()` levanta
un runner FRESCO bajo el cwd destino (toma SU set de MCP/settings — en
Tolkien gana Pad-tolkien) → broadcast `history` + `moved` a los clientes
abiertos. NO forkea (la sid se conserva), NO crea tarjeta nueva, NO
archiva nada. La tarjeta salta del grupo del mundo origen al del destino
(F4 agrupa por mundo). Existe en UN mundo a la vez por construcción ⇒
Regla 12 (no enlaza mundos, mueve secuencialmente). Endpoint POST
/api/chat/handoff {id, cwd} devuelve el MISMO chat con el cwd nuevo; 0
tokens (el move es de disco). UI: menú ⋯ de Sesiones "Mover a otro
mundo" (solo Chat, no TUI) → chooser de mundos conocidos (ui/places.js
PLACES, menos el de origen) + confirm; el front solo hace
syncConversation+refresh (misma tarjeta, se re-agrupa sola). El "mundo"
se infiere del cwd (no hay campo `world` explícito).
F3 · ARCHIVAR-NO-BORRAR (2026-07-14, PEND-462; INDEPENDIENTE del move —
ya NO es efecto del handoff): acción MANUAL para aparcar un chat terminado
y revivirlo ante feedback días después. `Chat.archive()` (aparca revivible: duerme
el motor, conserva sessionId, NO dispara los write-backs de "terminé"
de close()) + `Chat.revive()` (lazy, 0 tokens). Persisten (`archived`
en chats.json), el reaper NO las poda, `info()` expone `archived`.
Endpoints POST /api/chat/archive · /revive. UI (sessions.js): sección
colapsable "Archivados" + menú ⋯ "Archivar"/"Revivir" (tocar una
archivada la revive y abre). Sirve para volver a un trabajo tras
feedback días después sin reconstruir contexto.
F4 · DASHBOARD POR MUNDO (2026-07-14, PEND-463): sessions.js `render()`
agrupa los chats por MUNDO (ui/places.js `placeFor(cwd)`: Mi Consola /
Tolkien / Otros) con header por grupo (solo si hay chats en >1 mundo).
F2 v1 · MANIFIESTO PORTABLE (2026-07-14, PEND-461, "clon de Pad" primer
eslabón): al mudar, `writeHandoffManifest()` escribe
`_handoff.md` en la carpeta del chat destino (chat-attachments/<destId>/)
con de-dónde-vino, a-qué-mundo-llegó y las "formas de trabajo nombradas"
(memory/*.md) del mundo destino que F0-E halló dispersas + los MCP del
mundo destino (de ~/.claude.json) + una TAREA opcional que dejás para
ese mundo (F2d: textarea en el modal de "Mover a otro mundo" → campo
`task` del POST) — así la sesión mudada "sabe qué instrucciones tomar". Self-contained (viaja con el chat),
NO enlace vivo (Regla 12). AUTO-INYECCIÓN (2026-07-14): tras un handoff,
el destino guarda `_pendingHandoffNote` (efímero, no persiste) y sendUser
lo inyecta UNA vez SOLO en el texto que va al MODELO (no en el que se
muestra al usuario ni en el que ven router/auto-título) — la sesión mudada
LEE el manifiesto en su primer turno sin que ensucie la burbuja. Verificado
E2E (WS): el manifiesto aparece en el transcript del destino.
F2(b) · REF ESTABLE + REGISTRO tipo-Pad (2026-07-14): cada paquete-sesión
tiene un `packageRef` ESTABLE (`PKG-<n>`) asignado en create() que
SOBREVIVE a los moves (el mundo cambia, el ref NO) — persiste en
chats.json + rehidrata. `src/modules/chat/packages.js` es el "clon de Pad"
self-contained: registro DURABLE `~/.cwc-data/session-packages.json`
(ítem por paquete: ref/chatId/sessionId/cwd/world/title/status), upsert
change-detecting en los eventos de ciclo de vida (create/move/archive/
revive/close) vía `Chat._syncPackage()` — NO en el hot path. `info()`
expone `packageRef`. NO es el Pad vivo: es un JSON local. F5 (seam):
`GET /api/chat/packages?q=` busca por ref/título/mundo (0 tokens).
El registro es un ÍTEM ESTRUCTURADO: además de ref/mundo/status/título
lleva `tags[]` y un TIMELINE (`history[]`: un evento por transición de
ciclo de vida — created/moved/archived/revived/closed, con mundo+ts, cap
30, apendeado por `_syncPackage(status, event)`). F5 (referencia
cross-mundo, PEND-464 HECHA): botón "🔗 Referenciar paquete"
(externalLink) en el composer del chat (chat-tab.js `_openPackagePicker`/
`_insertPackageRef`) → picker que busca en `GET /packages` sin importar
el mundo → al elegir, inserta en el composer una referencia con snippet
("📦 Referencia al paquete PKG-N «título» (mundo X): <snippet>"). Backend
`GET /api/chat/package/:ref` = registro + snippet leído del transcript (0
tokens); el chat conoce su propio `packageRef` (via el evento history del
attach) para excluirse del picker. Lista con DOM+textContent (sin
innerHTML de datos). Profundidad futura OPCIONAL: comentarios/links entre
paquetes + traer el CONTEXTO completo (getSessionMessages) en vez de solo
snippet. Ver DOC-468 (mapa entre mundos) y PLAN-373 en el Pad `console`.
ANTI-CONFUSIÓN DE MUNDOS (2026-07-14, pedido de Niko: "Consola tiene un
GitHub, Tolkien también — que nunca se confundan, a prueba de idiotas al
escalar"). El sistema YA scope-ea por cwd (una sesión en Tolkien solo ve
los MCP/creds de Tolkien — F0-D); el riesgo es HUMANO (creer que estás en
el otro mundo). 3 piezas: (1) INSIGNIA de mundo SIEMPRE visible en el
header del chat (chat-tab.js `_applyWorld` + `.chat-world` con color de
identidad de ui/places.js: 🏠 Mi Consola acento · 🌳 Tolkien verde ·
otro neutro; el backend manda `world`+`cwd` en el evento `history` del
attach y en `moved`). (2) IDENTIDAD NOMBRADA en el manifiesto del paquete:
`worldGitRepo(cwd)` (lee `.git/config`, sin subprocess) → sección "🪪
Identidad de ESTE mundo" que nombra el REPO GitHub concreto del mundo
destino ("GitHub de Tolkien = git@…/tolkien.git — NO es el de otro mundo").
(3) REGLA DURA anti-confusión en el manifiesto: el modelo debe nombrar
SIEMPRE los recursos de nombre compartido con su mundo ("el GitHub de
Tolkien"), NUNCA pelado ("tu GitHub"). Para multiusuario real hace falta el
modelo de ownership (C3/PEND-382, prerrequisito).
MODOS DE PERMISOS (PERMISSION_MODES en shared.js, único punto de
validación server+runner): default/acceptEdits/bypassPermissions/
plan. En la UI (chat-tab.js MODES) son etiquetas de UNA palabra
con color por riesgo en el select del header (data-risk, ver
.chat-mode en style.css): Preguntar=verde · Ediciones=amarillo ·
Todo=ROJO (bypassPermissions: acepta ABSOLUTAMENTE todo sin
canUseTool; confirm rojo obligatorio en _modeChanged antes de
activarlo — deliberado, pedido del usuario; NO afecta las
corridas headless, regla 6) · Plan=gris. _applyMode es la única
puerta modo→UI. OJO: un runner ya vivo de antes del deploy no
conoce bypassPermissions (Set importado al spawn) e ignora ese
set_mode hasta dormirse/reabrirse.
DEFAULT "Todo" DEL LANZADOR (pedido del usuario 2026-07-06): TODO
chat/sesión NUEVO abierto desde el lanzador arranca en
bypassPermissions — launcher.js pasa mode:'bypassPermissions' al
crear/retomar chat (antes 'default') y la sesión TUI lanza
`claude --dangerously-skip-permissions` (terminal/sessions.js). El
confirm rojo de _modeChanged NO salta (solo aplica al elegirlo a
mano), pero el chip del header nace ROJO "Todo" así queda visible.
NO afecta: las corridas headless (regla 6), los chats de bugfixes
"Trabajar en esto" (pasan modo explícito default/plan por el gate
de push) ni el fallback del server /create (sigue 'default' como
red anti-footgun para llamadas programáticas).
DEFAULT «TÁNDEM» DE TODO CHAT NUEVO (pedido de Niko 2026-07-21, tras validar el
protocolo en uso real: mejor distribución de carga que AutoTux manteniendo un
mínimo de Opus en el medio y Codex en su versión más potente): el fallback del
sistema en POST /api/chat/create pasó de 'auto' a 'tandem' (incluida la rama
defensiva de modelChoice inválido), y el LANZADOR dejó de recordar el último
modelo usado en localStorage ('cwc:lastModel' eliminado) — arranca SIEMPRE en
Tándem salvo que se elija otro en ese mismo modal. Precedencia (sin cambios en el
mecanismo): `model` explícito del body > preferencia per-user
`defaultModelChoice` (⚙ Sistema → Proyectos, acepta 'tandem') > fallback del
sistema, ahora 'tandem'. AutoTux NO se eliminó: sigue disponible como elección
explícita en el picker y como preferencia per-user. Los chats YA existentes
conservan su modelChoice persistido (no hay migración). Verificado en caliente:
create sin `model` ⇒ {modelChoice:'tandem', model:'opus', effort:'high',
tandemCodex:{gpt-5.5, high}}.
Tándem exige una credencial Codex DEL DUEÑO en `$HOME/.codex/auth.json`, donde
el HOME lo resuelve el runner por-usuario. Si falta, el default de creación
degrada a AutoTux (BUG-1875), y una delegación explícita falla con un mensaje
accionable. AHORA cada usuario puede conectar su propio Codex tanto en el
wizard de onboarding como en ⚙ Sistema → Conexiones: la degradación a AutoTux
es el fallback seguro, no un callejón sin salida.
CHIPS DE EJECUCIÓN (tool calls): SOLO dos íconos, sin texto —
consola (= herramienta ejecutada) + tipo (TOOL_TYPE_ICONS en
chat-tab.js: Bash=play · Edit/Write=edit · Read=eye ·
Grep/Glob=search · Web=download · Todo=list · Task=sparkle ·
resto=gear). Nombre+resumen quedan en el tooltip; el detalle al
tocar. La LEYENDA vive en el modal del "?" del header
(_modeHelp, "Ayuda del chat": sección Modos + sección Íconos de
acciones). Los chips de PERMISO (chat-permchip
"Permitido/Denegado") conservan su palabra a propósito:
registran una decisión, no una ejecución.
SOLICITUD de permiso (chat-perm, _permCard): compacta como los
chips — [chip consola+tipo+chevron, SIN texto] + [✕ Denegar]
[✓ Permitir] (lo único que sobresale; cp-deny con margin-left:
auto). El nombre de función era flex:none y con tools MCP
largos empujaba los botones fuera de pantalla en móvil (bug
reportado por el usuario). Tocar el chip expande el detalle:
cp-detail-tool = nombre COMPLETO de la función (word-break) +
comando/diff íntegro. Destructivos siguen naciendo EXPANDIDOS
(isDestructiveCommand).
PREGUNTA CON OPCIONES — AskUserQuestion (2026-07-06, pedido del
usuario: el popup salía como un permitir/denegar genérico sin
mostrar las opciones): el tool AskUserQuestion NO es un permiso
permitir/denegar — es una PREGUNTA que espera que el usuario ELIJA
una opción. Cae por el MISMO canal canUseTool/permission_request
que cualquier tool, pero se renderiza distinto. Backend
(shared.js): toolSummary = texto de la 1ª pregunta · toolDetail =
{askQuestions:[{question,header,multiSelect,options:[{label,
description}]}]} normalizado (viaja en `detail`, así lo reenvía
también pendingPerms()→perm-center). Front: _permCard detecta
tool==='AskUserQuestion' y llama _askQuestionCard, que usa el
builder COMPARTIDO buildAskQuestionBody (exportado de chat-tab.js,
reusado por perm-center.js — sin duplicar el render): pinta
header-chip + pregunta + opciones seleccionables (single = radio,
multiSelect = toggle) + "Otra respuesta…" (texto libre = la opción
"Other" que el SDK ofrece siempre) + Enviar (habilitado cuando
TODAS las preguntas tienen respuesta; muestra N/total) / Cancelar
(deny). CONTRATO SDK (verificado en node_modules/@anthropic-ai/
claude-agent-sdk/sdk-tools.d.ts): se responde devolviendo
{behavior:'allow', updatedInput:{...input, answers:{"<texto
pregunta>":"<label>"}}} — clave = TEXTO de la pregunta, valor =
label elegido; multiSelect = labels SEPARADOS POR COMA. El campo
`answers` viaja end-to-end: chat-tab _send({...,answers}) → WS/HTTP
→ chat.answerPermission(id,allow,answers) (saneado por
sanitizeAnswers de index.js: solo pares string→string, tope 4) →
runner {t:'perm',id,allow,answers} → materializa updatedInput.
answers. runner-link.send() reenvía el objeto entero, sin cambios.
Estilos .askq-* en style.css (borde --cwc-accent-cool para separar
"elegir respuesta" del amarillo de "riesgo" de un permiso normal).
Al responder, permission_closed colapsa la card a chip de registro
(Permitido/Denegado) igual que cualquier permiso.
CENTRO GLOBAL DE PERMISOS (pedido del usuario 2026-07-04: con
varios chats abiertos los permisos expiraban sin verse — solo
chats SDK, tmux quedó explícitamente AFUERA): las solicitudes
pendientes de TODAS las conversaciones se popupean desde
CUALQUIER pantalla (ui/perm-center.js, detalle en la sección de
public/js/ui/ abajo). Server: los pendientes se DERIVAN del
history (permission_request sin su permission_closed, SOLO con
motor vivo — pendingPerms() en Chat, cero estado duplicado;
sobrevive reinicios porque la reconexión a un runner vivo
reconstruye el history con hello.events) y viajan en info()/GET
/api/chat/list como pendingPerms[] {id,tool,summary,detail,ts,
expiresAt}. _engineDown emite permission_closed SINTÉTICOS
(reason 'engine_down') por los no respondidos — sin eso una vida
futura del motor los "resucitaría" y la tarjeta inline quedaría
clickeable para siempre. POST /api/chat/permission
{id,permId,allow} responde un permiso SIN WS adjunto (valida
permId ^p\d+$ y que siga pendiente — 409 si ya se respondió; usa
el MISMO answerPermission del camino WS). El runner sella `ts`
en cada permission_request; el server lo sella igual si falta
(runners vivos de antes del deploy). ChatTab re-emite los
permission_* como eventos window 'cwc:perm-request'/'cwc:
perm-closed' (exporta toolTypeIcon/isDestructiveCommand para el
popup). OJO: pollTabStatus (main.js) consulta /api/chat/list
aunque NO haya pestañas abiertas — el centro debe avisar de
chats lanzados desde otro dispositivo; no "optimizar" ese early
return de vuelta.
AUTO-TÍTULO con IA: en cada mensaje del usuario, sendUser dispara
_autoTitle → extractTitle (query() del SDK con HAIKU, maxTurns 1,
READ-ONLY doble capa regla 6 con TODA herramienta denegada) que
resume en ≤20 chars qué se está haciendo y renombra chat.title EN
PARALELO (jamás bloquea el turno; si falla queda el título viejo).
Guardas: throttle 20 s/chat + 1 en vuelo, mensajes <15 chars o
/comandos no re-titulan, chats con ticket (bugfixes) NO se tocan
(título curado "PR en progreso · TKT #n"). La UI lo levanta por
el poll de 8 s de main.js (pollTabStatus sincroniza header+chip
y dispara sessions-changed para las tarjetas). El renombre manual
sigue existiendo pero el próximo mensaje puede pisarlo (a
pedido: nombres siempre actualizados).
AutoTux v2 (2026-07-10, REDISEÑO tras revisión externa +
simulacros con datos reales — pedido del usuario "bajar el
consumo"): SUPERSEDE la lógica de DECISIÓN de las Fases 1-3 de
abajo (que quedan como historia). Núcleo reescrito en
core/model-router.js; docs/autotux-analisis-externo.md tiene el
diagnóstico completo. Problema medido en model-router-log.jsonl
(62 decisiones): v1 colapsaba en un flip-flop Sonnet↔Opus (49
subidas / 13 bajadas / 0 a haiku — "routing collapse"). CAMBIOS v2
("shape seguro", ~12-18% de ahorro validado por simulacro
/tmp/autotux-sim*.js SIN riesgo de calidad): (a) FABLE PROHIBIDO —
fuera de MODEL_LEVELS (ahora ['haiku','sonnet','opus']) + guard
FORBIDDEN_AUTO en setModel (auto:true a fable ⇒ rechazado+log
'guard'; manual sigue OK). clampLevel() mapea fable→opus (chat que
vuelve de fable manual a 'auto') y opusplan/default→-1 (inerte) —
fix del bug de v1 (indexOf('fable') daba -1 con la escala nueva).
(b) Movimientos SIEMPRE ±1 (nunca saltos directos al techo: code
fence / mensaje largo ≥1200 ahora suben UN escalón, no a Opus). (c)
COOLDOWN de 2 turnos tras cada cambio (anti-rebote, estilo BGP
route-flap dampening): congela señales no-fuertes; la corrección
del usuario (strong_up) lo ROMPE. (d) NIVEL BASE (pegajoso,
persistido vía _routerDownStreak + _routerCooldown) separado del
OVERRIDE DE TURNO: un ack de CIERRE (perfecto/gracias/listo/
genial/buenísimo/excelente — CLOSING_ACK_RE) corre ESE turno en
Haiku sin tocar el base (turnOverride→0; _overrideRestore guarda el
base; _endTurnRouter lo restaura al pasar a 'waiting'). NUNCA en
go-aheads (dale/ok/sí — GOAHEAD_RE): cuentan como 'down' para el
base pero NO override, porque suelen DISPARAR trabajo y correr una
implementación en Haiku es frágil (hallazgo del simulacro TKT+PR).
(e) Escalada por EVIDENCIA de insuficiencia, no volumen
(insufficiencyEscalation, al cerrar el turno): ≥2 errores de tool
(tool_result con ok:false, contados en _turnToolErrors) o ≥10 tools
con ≥1 error ⇒ sube 1 escalón para el PRÓXIMO turno. La CORRECCIÓN
del usuario ("no funciona"/"está mal"/"sigue fallando" —
USER_CORRECTION_RE) es una etiqueta de calidad GRATIS: sube en el
acto (strong_up). Esto cumple "detectar que el modelo no alcanzó y
subir". EL AUTO-REDO AUTOMÁTICO DEL TURNO SE DESCARTÓ: en los
simulacros disparó 0 veces (o ya estás en Opus, o la corrección
escala un turno antes y gratis) — riesgo de auto-gasto sin
beneficio. (f) BAJADA POR INACTIVIDAD (idleDecayMove: idle ≥60 min
y base>sonnet ⇒ decae 1 escalón al reanudar). (g) CLASIFICADOR
RELATIVO (classifyRelative, reemplaza classifyComplexity): para
mensajes ambiguos pregunta a Haiku "dado que estás en X, ¿sobrado/
suficiente/insuficiente?" (deadband en 'suficiente', mucho más
estable que la clasificación absoluta de v1 que alimentaba el
yo-yo) → down/same/up; en SEGUNDO PLANO (fire-and-forget, gobierna
el próximo turno) + throttle (_routerClassifyThrottle: no
reclasifica por 2 turnos). LOGGING: logDecision suma fuentes
override/insufficiency/correction/idle/guard/classifier; logTurn
(nuevo, model-router-turns.jsonl) registra CADA turno con su nivel
para medir distribución + tasa de rebote (v1 solo logueaba
cambios). Test determinista del núcleo: bin/cwc-test-model-router.js
(42 asserts, sin SDK). Verificado en caliente: un chat 'auto' con
"perfecto" corre en Haiku y restaura a Sonnet (override→restore).
El requisito de un dueño de "Fable prohibido en el router" es AHORA
regla dura del núcleo.
AutoTux v3 — EJE THINKING EFFORT + JUEZ AutoMix + SUBMENÚ (2026-07-13,
PEND-391 "alineación 2026", pedido de Niko "ejecutar todo"): CUATRO
frentes sumados sobre v2 (el núcleo v2 sigue igual). (A) INSTRUMENTACIÓN
DE CACHÉ: el runner (bin/cwc-chat-runner.js) PROPAGA cache_creation/
cache_read del usage por turno (antes se descartaban; normCacheCreate
normaliza el objeto {ephemeral_5m/1h} a total); logTurn se MOVIÓ de
_applyModelRouter (inicio del turno, sin usage) al `case 'result'`
(_logTurnAtResult) y se ENRIQUECIÓ (model, switchedFromPrev, prevModel,
effort, cacheCreate, cacheRead, input, output, toolCalls) → mide si el
switch de modelo INVALIDA el caché de prompt (switchedFromPrev=true ⇒
cache_read≈0). REENCUADRE (#5): el objetivo del router es NO QUEMAR LA
VENTANA DE RATE-LIMIT (tokens), no ahorrar $ (es suscripción) — por eso
el caché importa: rebotar de tier puede COSTAR tokens. (B) EJE THINKING
EFFORT: `effort` (low|medium|high|xhigh|max) es opción de query() del
Agent SDK (output_config.effort) — palanca de profundidad MÁS BARATA que
saltar de tier. OJO CLAVE (verificado en sdk.d.ts 0.3.198): el SDK NO
expone q.setEffort() EN VIVO (solo setModel/setPermissionMode/
setMaxThinkingTokens) → el effort es opción de SPAWN: se fija al nacer el
runner (chatQueryOptions→runner --effort→query()); un cambio a mitad de
vida se aplica al Reabrir para cambios / dormir→despertar. Default por
tier (effortForLevel de core/model-router.js: haiku→low·sonnet→medium·
opus→high); `this.effort` persistido (persist/rehydrate) + `_effortPinned`
(la persona lo fijó a mano ⇒ AutoTux no lo re-alinea); setModel re-alinea
el effort al tier si no está pinned; setEffort()/POST /api/chat/effort +
POST /api/chat/model acepta {effort}. budget_tokens fijo está DEPRECADO
en modelos 2026 — se usa effort, no tokens. (C) SUBMENÚ modelo→esfuerzo:
el picker "Cambiar modelo" de Sesiones (sessions.js pickModelForChat)
pasó a DOS secciones (Agente + Esfuerzo) con botón Aplicar que manda
ambos en un POST; EFFORT_OPTIONS/effortLabel en ui/models.js (fuente
única). El BADGE del header del chat (chat-tab.js _renderModelBadge) pasó
a 2 LÍNEAS (modelo arriba + 🧠 esfuerzo abajo, compacto, .chat-model-pill
--two). (D) JUEZ AutoMix (F3 de la investigación, "el único algoritmo IA
que faltaba"): tras un turno SUSTANCIAL (≥2 tools o respuesta ≥400 chars),
judgeAnswer (Haiku background, read-only doble capa como classifyRelative)
evalúa si la respuesta se quedó corta; si sí, emite el evento `redo-suggest`
→ banner PASIVO de consentimiento en el chat ([Reintentar en <modelo>]/
[Ignorar], chat-tab.js _redoSuggest, POST /api/chat/redo sube 1 escalón +
reintenta el último pedido). NUNCA sube solo (el auto-redo se descartó).
_maybeJudge con throttle (1 de cada 3 turnos). MÉTRICAS DE CALIBRACIÓN
(#4): readTurnMetrics + GET /api/chat/router-metrics (0 tokens, lee el
jsonl) = distribución por modelo, tasa de rebote, y la AUDITORÍA DE CACHÉ
(buckets switched vs notSwitched). idle decay 60→30 min (decisión abierta
#3, agresivo). Test determinista bin/cwc-test-model-router.js extendido a
53 asserts (effortForLevel/effortForModel + idle 30min). — Lo de abajo
(Fases 1-3) es la historia del diseño v1 que este bloque reemplaza en su
LÓGICA (el andamiaje — modelChoice, badge 🤖, setModel(auto), activación
implícita — sigue vigente):
AutoTux v4 — RUTEO CACHÉ-AWARE + EFFORT EN LA DECISIÓN + CALIBRACIÓN
(2026-07-13, PEND-405, pedido de Niko "ruteo inteligente con todo"): CINCO
fases (F6 "AutoTux en TUI" ELIMINADA por decisión de Niko). Convierte la
instrumentación de v3 en DECISIONES. Núcleo puro en core/model-router.js,
test determinista 53→68 asserts. (F1+F2) EJE EFFORT EN LA DECISIÓN,
CACHÉ-AWARE: ante una necesidad de subir, decideUpAxis() elige entre subir
EFFORT (mismo modelo, caché intacto, más barato) o saltar de TIER — regla:
señal DURA (corrección/insuficiencia) → tier salvo caché pegajoso; señal
BLANDA (clasificador up/código/largo) → effort primero si hay margen. AUTO
nunca pasa de 'high' (xhigh/max = manual, como fable). El router lee el
cacheRead del último turno (this._lastCacheRead, de la instrumentación #2):
si es ≥ CACHE_STICKY_TOKENS (15k), saltar de tier desperdiciaría ese
prefijo → sesga a effort. _bumpEffortAuto(±1) sube/baja el effort respetando
techo AUTO/piso; decideDownAxis baja effort antes que tier si está por
encima del default del tier. Verificado E2E: chat sonnet/medium + turno
up-blando (code fence) → effort:high, modelo sigue sonnet (NO salta a Opus).
(F3) EFFORT EN VIVO REAL: como el SDK no tiene setEffort live, al cambiar el
effort con motor VIVO y OCIOSO, _maybeReopenForEffort() reabre el runner
(respawn --resume, throttle 30s) para aplicarlo YA; con motor dormido/en
turno se aplica al próximo spawn. (F4) CONSCIENCIA DE RATE-LIMIT:
readWindowPressure() lee plan-limits.json (0 tokens, snapshot del módulo
tokens) → % máx usado de las ventanas; si ≥ WINDOW_PRESSURE_CONSERVE (75%),
decideUpAxis entra en modo `conserve` (NUNCA salta de tier, solo effort —
no quemar la ventana, objetivo #5). (F5) LOOP DE CALIBRACIÓN + ALT AL #6
(clasificador ML, descartado por Niko como riesgoso/bloqueado por datos):
(a) los 3 clasificadores Haiku (título/relativo/juez) corren a effort:low
(más baratos). (b) analyzeCalibration() (determinístico, 0 tokens, patrón
core/inventory.js) mina model-router-{log,turns}.jsonl → PROPUESTAS
aprobables (tasa de rebote alta → subir cooldown; closing-ack→Haiku con
ahorro negativo de caché → revisar) + SEÑALES APRENDIDAS (keyword→dirección)
GATEADAS por suficiencia de datos (CALIB_MIN_DECISIONS=400; hoy 111 ⇒ vacío
a propósito, evita sobreajuste — el motivo real por el que el #6 se
descartó). learnedSignalBias(text) las consulta en la rama ambigua ANTES de
gastar el clasificador Haiku (vacío hoy ⇒ sin efecto). Expuesto en GET
/api/chat/router-metrics (campo `calibration`, 0 tokens).
ROUTER DE MODELO AUTOMÁTICO (2026-07-06, Fase 1, pedido del
usuario): decide solo si el turno necesita más o menos modelo,
escalando haiku→sonnet→opus→fable con MEMORIA de hilo (sube
fácil, baja con inercia) en vez de un modelo fijo por chat.
NÚCLEO puro en core/model-router.js (NO es un motor — mismo
estatus que core/tool-policy.js: plomería in-process consultada
EN VIVO, sin runner ni endpoints propios). sendUser llama a
_applyModelRouter(text) ANTES de mandar el turno:
decideModelForTurn() aplica una heurística 0-costo sobre el
TEXTO (mensaje trivial "dale"/"gracias" → baja; trae ``` código →
sube; muy largo ⇒ sube; ambiguo ⇒ no opina, no toca nada) con
HISTÉRESIS de dos umbrales: subir es inmediato (mismo turno),
bajar exige 3 turnos simples SEGUIDOS y de a UN escalón por vez
(nunca de un salto). El NIVEL nunca se duplica en un estado
propio: se deriva de `this.model` en cada turno; lo único que
persiste el Chat es el contador chico de histéresis
(`_routerDownStreak`, en persist()/rehydrate() junto al resto).
El cambio de modelo en sí reusa el setModel() de siempre (mismo
q.setModel() del SDK que ya usaba el selector manual) — CERO
plomería de cambio de modelo nueva. TECHO deliberado en `opus`:
la heurística de Fase 1 NUNCA sugiere `fable` sola (con solo 16
cambios manuales de /model en el historial real de esta consola
no había señal confiable para distinguir Opus de Fable — ver
core/model-router.js para el razonamiento completo); subir a
fable sigue siendo SOLO manual por ahora. ACTIVACIÓN IMPLÍCITA
sin UI nueva: el router SOLO gestiona un chat si su modelo
ACTUAL es exactamente haiku/sonnet/opus/fable — elegir
`opusplan`/`default` desde el selector (o no elegir nada) lo deja
INERTE a propósito, sin necesitar un toggle dedicado. Alcance:
SOLO el chat interactivo (los motores headless — triage/salud/
desk/auto-título — siguen con su asignación fija de siempre,
deliberadamente afuera). Fundamentos completos (research de
RouteLLM/FrugalGPT, análisis de costo real de transcripts propios
— clasificar con Haiku en cada turno es ~0,005% del costo —, y
minería de los cambios manuales de /model del propio usuario) en
la cabecera de core/model-router.js.
FASE 2 (mismo día, sumada al núcleo): clasificador Haiku para
turnos AMBIGUOS (decideModelForTurn devuelve `ambiguous:true` si
la heurística no opina) + escalado REACTIVO si un turno "no dio
abasto". OJO DE LATENCIA verificado EN CALIENTE: el solo arranque
de query() tarda ~2-3s antes de que Haiku conteste una palabra (en
la práctica, 4-8s totales) — MUY por encima de lo que un turno
puede esperar en línea. Por eso classifyComplexity()
(modules/chat/index.js, patrón defensivo idéntico a extractTitle:
1 turno, READ-ONLY doble capa, timeout+interrupt 20s) corre
SIEMPRE en SEGUNDO PLANO (fire-and-forget, guarda
`_routerClassifying` contra solapes) — nunca gobierna el turno
actual, sí el PRÓXIMO (o el actual si el motor todavía no arrancó
a responder). Mismo techo en `opus` que la heurística (nunca
sugiere fable). Escalado reactivo: `_turnToolCount` (efímero, NO
persiste) cuenta CUALQUIER tool_use del turno en curso
(_onRunnerEvent); al volver a 'waiting' (_setStatus),
_applyReactiveEscalation() sube un escalón si el turno usó ≥6 de
golpe (REACTIVE_TOOL_THRESHOLD en core/model-router.js) — señal
barata de "esto pesó más de lo esperado", 0 tokens extra, mismo
techo en opus.
FASE 3 (mismo día): VISIBILIDAD — badge "🤖 <modelo>" en el header
del chat (chat-tab.js `_applyModel`, único punto de entrada del
modelo a la UI — igual patrón que `_applyMode`), coloreado con
ui/models.js (modelColor/modelName — el alias haiku/sonnet/opus/
fable ES la key que esas funciones esperan). Oculto si el chat corre
opusplan/default/sin elegir (mismo criterio de "inerte" del
backend, replicado en `ROUTER_MANAGED_MODELS` del front — NO se
importa nada del server). `Chat.attach()` manda `model` en el
payload `history` para que nazca poblado; `Chat.setModel(model,
{auto})` (nuevo 2º parámetro, default false) tagea el evento
`{type:'model', model, auto}` — `auto:true` SOLO cuando lo decide
el router (`_pendingModelAuto` lo consume el eco 'model' del
runner vivo; el camino "motor dormido" lo taguea directo). Un
cambio con `auto:true` dispara una notita inline en el chat ("🤖 El
router cambió el modelo a X sin que hagas nada") — un cambio MANUAL
(selector de Sesiones, `POST /api/chat/model`) sigue sin nota,
como siempre. APRENDIZAJE — cada cambio que hace el router (los 3
orígenes: heuristic/classifier/reactive) se registra con
`logDecision()` (núcleo, `~/.cwc-data/model-router-log.jsonl`,
append-only con poda cruda a la mitad pasado ~2MB) — SOLO
observación para calibrar después con datos reales, patrón
"invariantes propuestos" de Salud: nada de esta fase decide ni se
relee sola; no hay UI de revisión todavía (pendiente de Fase 4 si
hace falta).
NOMBRE PROPIO + FORZADO REAL — "AutoTux" (2026-07-06, pedido del
usuario, Frente A de 2 — el Frente B, extender esto a sesiones TUI/
tmux, queda pendiente a propósito, ver más abajo): el router deja de
activarse implícitamente por elegir un alias crudo y pasa a ser una
ELECCIÓN EXPLÍCITA con nombre propio, separada del modelo real. Chat
suma `modelChoice` (QUÉ ELIGIÓ la persona: 'auto'=AutoTux | opusplan |
fable | opus | sonnet | haiku | default | null) — DISTINTO de `model`
(lo que corre DE VERDAD contra el SDK/CLI real, nunca 'auto': ese
sentinel es propio de la consola, VALID_MODELS de core/claude-model.js
son los únicos alias que el CLI real reconoce). `setModelChoice(choice)`
(chat/index.js) es la ÚNICA puerta: con 'auto' arranca desde el nivel
actual (o 'sonnet' si no hay uno gestionado) y AutoTux queda al mando
— `modelChoice` quedá en 'auto' PARA SIEMPRE, el badge nunca deja de
decir "AutoTux" aunque el nivel real suba/baje por debajo; con
cualquier otro valor FUERZA ese único modelo (setModel(choice) sin
auto) y apaga el router (_applyModelRouter/_applyReactiveEscalation
chequean `this.modelChoice !== 'auto'` primero, antes que nada).
`POST /api/chat/create` sin `model` en el body ahora defaultea a
'auto' (antes null): AutoTux es el predeterminado de TODA conversación
de Chat nueva. `POST /api/chat/model` acepta 'auto' además de
VALID_MODELS y delega a setModelChoice (antes llamaba a setModel
directo). Persistencia: `modelChoice` viaja en persist()/rehydrate()
igual que `_routerDownStreak`, EXPLÍCITO porque `model` solo no
alcanza para distinguir "elegí Sonnet a mano" de "AutoTux está en
Sonnet ahora". MIGRACIÓN: chats de ANTES de este cambio que ya tenían
un alias crudo elegido (activación implícita vieja) quedan con
modelChoice=ese mismo valor (forzados, router apagado) — hay que
elegir "AutoTux" a mano una vez para que vuelvan a tener router.
FUENTE ÚNICA del menú: `CHAT_MODEL_OPTIONS`/`ROUTER_MANAGED_MODELS`
en public/js/ui/models.js (AutoTux primero, "Opus plan" segundo —
renombrado, sin la palabra "Auto" para no confundirlo con el badge
🤖 — después Fable/Opus/Sonnet/Haiku/Default), consumida por
sessions.js (picker de chat, marca la opción ACTIVA contra
`modelChoice` con ✓, patrón `.sess-menu-item--active`) y
launcher.js (default de "Chat" nuevo). El picker de sesión TUI
(`pickModel` en sessions.js) y el tipo "Claude (TUI)"/"Terminal" del
lanzador usan `TUI_MODEL_OPTIONS`/`TUI_MODELS` — SIN 'auto' a
propósito: el CLI real de esas sesiones (`claude --model X` /
`/model X` tecleado) no conoce ese alias y rompería. El header del
chat (chat-tab.js `_renderModelBadge`) pinta `🤖 AutoTux: <nivel>`
con AutoTux, o el nombre plano (sin 🤖) con un modelo forzado; las
tarjetas de Sesiones usan el mismo criterio (`chatModelLabel()`).
FRENTE B (pendiente, mayor alcance/riesgo — toca `~/.claude/
settings.json`, GLOBAL a toda sesión de Claude Code de la máquina,
no solo las de este proyecto): llevar AutoTux también a sesiones TUI/
tmux. Requiere un hook `UserPromptSubmit` propio (heurística 0-costo
SOLO — un clasificador Haiku ahí bloquearía al usuario tipeando en la
terminal varios segundos) + estado por pane en `~/.cwc-data/autotux/`
+ aplicar el cambio real (`tmux send-keys "/model X"`) recién cuando
la sesión queda OCIOSA (nunca a mitad de turno — mismo patrón ya
probado del "nudge" del interfono) + escalado reactivo vía hook
`PostToolUse` + un instalador PROPIO aditivo/reversible
(`bin/install-autotux.js`/`uninstall-autotux.js`, como exige la regla
dura del proyecto para tocar configuración fuera del repo). No
iniciado — queda documentado acá para cuando se retome.
MODELO "TÁNDEM" — razona Claude, ejecuta Codex (2026-07-15, PLAN-507/
PEND-508, pedido de Niko; VERIFICADO E2E): un modelChoice NUEVO —
'tandem' — que SEPARA las dos fases del desarrollo entre proveedores:
RAZONAMIENTO/planeación/verificación → Claude Opus (effort HIGH, FIJO —
Niko 2026-07-21: subido de medium a high tras validar el protocolo en uso
real; antes era medium por decisión del 2026-07-15) ·
EJECUCIÓN de código → Codex gpt-5.6-sol (era gpt-5.5 hasta 2026-07-24, ver
MIGRACIÓN A GPT-5.6 abajo) (reasoning effort alto) vía el CLI
`codex exec`. Es HERMANO de 'auto'/AutoTux en la misma infra (centinela
de modelChoice + core/tool-policy.js) pero su ANTÍTESIS: dupla FIJA de
gama alta elegida a mano, NO ruteo dinámico. Motores fijos = decisión de
Niko (máxima calidad). ESQUIVA el límite "el contexto no cruza
proveedores": Claude no comparte memoria viva con Codex — le pasa un PLAN
como prompt (el plan ES la transferencia). PIEZAS: (a) 'tandem' en
CHAT_MODEL_OPTIONS (ui/models.js) → todos los pickers por herencia; (b)
setModelChoice('tandem') + constructor (chat/index.js): modelChoice='tandem',
model REAL='opus', effort='high' PINNED — el CLI nunca ve 'tandem' (centinela
propio, como 'auto'); (c) spawnRunner pasa `tandem:true` (runner-link.js →
arg `--tandem 1`); (d) NUEVO src/modules/chat/codex-tool.js: fábrica
createCodexToolServer({cwd}) que arma la tool IN-PROCESS `delegate_to_codex`
con createSdkMcpServer()+tool() del Agent SDK (zod schema {task}). Al
invocarla, spawnea `codex exec --json --skip-git-repo-check -m gpt-5.6-sol -c
model_reasoning_effort=high -s workspace-write` con cwd = el del chat,
parsea el stream JSONL (thread.started/item.completed{agent_message|
file_change}/turn.completed{usage}), y devuelve resumen + diff ACOTADO A LO
QUE TOCÓ ESA DELEGACIÓN + contenido de los archivos nuevos DE ESA
DELEGACIÓN como tool_result para que Claude VERIFIQUE.
WRITABLE_ROOTS a la carpeta del chat (2026-07-23, BUG-1796 /
PLAN-1799): `runCodex` agrega `-c
'sandbox_workspace_write.writable_roots=["<chatDir>"]'` cuando NO es
full_access, para que Codex pueda escribir en la carpeta del chat
(`~/.cwc-data/chat-attachments/<id>/`), que está FUERA del cwd/repo y por
eso el sandbox `workspace-write` la montaba read-only. Hallazgo de un
análisis de 442 sesiones Codex: 17 escrituras a `chat-attachments/`
rebotaban con EROFS (caso Expediente Princeton: 18 bloqueos, todos a la
carpeta del chat). `createCodexToolServer` recibe `chatDir`;
`bin/cwc-chat-runner.js` pasa `chatAttachDir(ID)`; healthfix NO pasa
chatDir (no aplica). OJO (verificado E2E): `writable_roots` hace escribible
la carpeta LISTADA y su contenido (subcarpetas incluidas), NO su padre; por
eso `createCodexToolServer` hace `fs.mkdirSync(chatDir, {recursive:true})`
defensivo: la carpeta del chat se crea LAZY (al primer adjunto) y podría no
existir; sin ese mkdir, crear la carpeta requeriría escribir en
`chat-attachments` (no writable) y seguía fallando. `full_access`
(`danger-full-access`) ignora writable_roots. El `TANDEM_CODEX_PREAMBLE`
además recuerda: usar `python3` (no `python`), evitar heredocs frágiles,
pasar `full_access` para tocar `.git`, y preferir Claude para generación
PURA de documentos (ruteo CONVE-558).
Cómo se acota:
`snapshotTree()` toma `git diff --numstat` + `git ls-files --others`
ANTES y DESPUÉS de correr Codex; `diffSnapshots()` compara: si cambió el
numstat de un archivo trackeado, lo tocó esta delegación (detecta también
un archivo YA sucio que Codex modificó más, y un revert); untracked nuevo,
o untracked preexistente con mtime >= el arranque de la corrida, cuenta
como archivo nuevo de esta delegación. Es snapshot de GIT, no auto-reporte
de Codex, así que captura el cambio aunque lo haya hecho con apply_patch o
con sed/bash. La atribución usa DOS señales combinadas: (1) el numstat de
git, como arriba; (2) para todo lo que YA venía sucio, la comparación del
CONTENIDO real contra el snapshot previo. La segunda es imprescindible: el
numstat (agregadas:borradas) es CIEGO a un cambio que no altere esos
conteos — BUG REAL detectado en prueba E2E (2026-07-21): una delegación
reemplazó UNA línea que ya formaba parte de las 160 inserciones acumuladas
del archivo, el numstat siguió siendo idéntico, `touched` quedó vacío y la
tool cayó a la rama de FALLBACK devolviendo el árbol completo; el cambio
existía pero no se detectó. Con la señal de contenido, un archivo cuyo
contenido difiere del snapshot previo SIEMPRE se atribuye a la delegación
(a `newFiles` si es untracked, a `touched` si es trackeado). Los bucles de
numstat y de mtime se CONSERVAN: cubren los archivos que no entraron al
snapshot de contenidos (p.ej. los mayores a 1 MB). `diffSnapshots` se
exporta, igual que `delegationDiff`, para poder testear ambas señales sin
runner vivo. DENTRO de cada archivo tocado el diff también es de ESA
delegación, no acumulado: `snapshotTree(cwd, {withContents:true})` captura
además el CONTENIDO de los archivos que YA venían sucios (tracked dirty +
untracked) antes de correr Codex — topes MAX_SNAPSHOT_FILE 1 MB por archivo
y MAX_SNAPSHOT_TOTAL 8 MB — y el helper exportado `delegationDiff(cwd,
touched, before)` los diffea pre/post con `git diff --no-index` contra un
temporal en os.tmpdir(), reescribiendo las rutas del temporal a la ruta del
proyecto y borrando los temporales en un finally. La reescritura contempla
los prefijos `a/` y `b/` que git antepone a las rutas: sin eso los
encabezados salían malformados (`asrc/modules/...` en vez de
`a/src/modules/...`) porque la ruta del temporal es absoluta y su barra
inicial se comía la del prefijo. Los archivos que estaban
LIMPIOS siguen por `git diff -- <rel>`, que ahí YA es exactamente el cambio
de la delegación. Un untracked preexistente que Codex modificó sale como
diff en vez de volcado completo del contenido. Por qué hizo falta: acotar
por archivo dejaba un residuo de segundo orden — si el archivo ya venía
modificado por trabajo anterior de la MISMA sesión, `git diff` contra HEAD
arrastraba todo lo acumulado (medido: una delegación que cambió 1 línea
devolvía 9.227 chars), y con MAX_SCOPED_DIFF de 8000 el cambio real podía
volver a caer del lado truncado — el mismo modo de falla original un nivel
más abajo. Medido tras el fix: 12.645 chars contra HEAD → 973 pre/post en
el mismo archivo (13×). DEGRADACIÓN CONOCIDA: un archivo de más de 1 MB no
entra al snapshot y cae al diff contra HEAD (el comportamiento anterior,
nunca peor). `delegationDiff` se exporta a propósito para poder testearlo
sin runner vivo. Motivo MEDIDO sobre 108 delegaciones reales (2026-07-21): el
diff global escondía el cambio real en el 66% de los casos (solo 15% lo
mostraba completo) y devolvía ~30k chars por vuelta (790k tokens
acumulados), justo lo que Tándem existe para NO gastar en la ventana de
Claude; verificación medida en el propio cambio: 60.004 chars de árbol →
8.604 acotados, con el cambio real adentro. El diff acotado se recorta a
MAX_SCOPED_DIFF (8000) con puntero a leer el resto con Read sobre las rutas
listadas; los archivos sucios AJENOS a la delegación se resumen en UNA
línea ("el árbol tiene además N archivos ajenos — ignoralos"), nunca su
contenido. FALLBACK: si no se pudo atribuir ningún cambio (Codex no cambió
nada, o git no disponible), cae al comportamiento viejo (árbol completo
recortado a MAX_DIFF) etiquetado como "no se pudo acotar". LIMITACIÓN
CONOCIDA: dos delegaciones EN PARALELO sobre el mismo repo (dos chats a la
vez) pueden atribuirse cambios entre sí — el snapshot es del árbol, no por
proceso. Además, `TANDEM_CODEX_PREAMBLE` (constante exportada) antepone al
`task` las reglas fijas del protocolo (tocar solo los archivos del plan,
verificar con `node --check`, no commitear/pushear, resumir qué cambió):
antes Claude las re-escribía a mano en cada encargo (medido: 87% repetía
"node --check", 67% "no toques otros archivos"); (e)
runner (bin/cwc-chat-runner.js): si `--tandem 1`, agrega el mcpServer codex
a chatQueryOptions Y — BLOQUEO ESTRUCTURAL — askPermission auto-DENIEGA
Edit/Write/MultiEdit/NotebookEdit (TANDEM_BLOCKED) sin tarjeta, con un
message que le dice a Claude que use delegate_to_codex. Esto GARANTIZA el
split: una tool solo "disponible" podía ser ignorada (riesgo señalado por
Niko — Claude seguiría escribiendo el código él mismo → sin ahorro). Sin
herramientas de escritura, su ÚNICO camino a un archivo es Codex. Permitidas:
Read/Grep/Glob (razonar) + delegate_to_codex (ejecutar) + Bash (verificar —
fuga conocida: podría escribir con echo>/sed; instrucción lo prohíbe, se
aprieta a allowlist si se escapa); (f) chatQueryOptions (tool-policy.js)
acepta `tandem`+`mcpServers`: agrega TANDEM_INSTRUCTION al system prompt
(append preset, como el bootstrap de Pad) y el mcpServer. OJO CLAVE
(verificado): la tool NO va en `allowedTools` — un nombre ahí AUTO-APRUEBA
la tool ANTES de canUseTool (warning CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), y
queremos que la delegación saque TARJETA DE PERMISO (Niko aprueba cada una;
en modo "Todo" se auto-aprueba como cualquier tool). La tool sigue
DISPONIBLE por mcpServers + alwaysLoad:true (availability ≠ auto-approve);
(g) badge del header (chat-tab.js): "🤝 Tándem" color acento-frío (el de
Codex en Uso). Como Codex puede tardar minutos, el runner sube
CLAUDE_CODE_STREAM_CLOSE_TIMEOUT (el SDK corta tools MCP a 60 s). El
ECONOMÍA: no baja el TOTAL de tokens, baja la PRESIÓN de la ventana de
Claude (la generación de código, 60-80% del gasto, se va a la ventana de la
suscripción ChatGPT). Verificación barata (diff, no repo). PILOTO: se usa
en sesiones de chat REALES bajo control de Niko (aprobar/parar/cambiar
modelo). PRIMER botón de Salud con Tándem opt-in (2026-07-19): el
auto-fix (`bin/cwc-healthfix-runner.js --tandem`, ver "Verificación de
salud" § TÁNDEM opt-in en el auto-fix) reusa TAL CUAL
`createCodexToolServer` con una allowlist headless propia
(`fixToolAllowedTandem`) que bloquea Edit/Write/MultiEdit/NotebookEdit
— mismo split estructural que el chat, sin tarjeta de permiso (el
auto-fix YA corre sin supervisión). Generalizar a "Trabajar en esto" de
Tickets & Features sigue como PEND-512 (post-piloto), NO hecho.
Continuidad Codex entre delegaciones (codex exec resume
<thread_id>) = mejora futura (hoy cada delegación es fresca; Claude re-pasa
el contexto en el `task`). VERIFICADO E2E (WS real): chat tandem → Opus →
"delego a Codex" → tarjeta de permiso → Codex crea el archivo en el cwd →
Claude verifica con Read/Bash; Edit/Write NUNCA usadas.
MIGRACIÓN A GPT-5.6 (2026-07-24): el ejecutor Codex de Tándem deja de usar
gpt-5.5 como default y pasa a la familia GPT-5.6 sufijada: `gpt-5.6-sol`
es frontier y reemplaza a gpt-5.5; `gpt-5.6-terra` es balanceado y
reemplazo oficial de gpt-5.4; `gpt-5.6-luna` es rápido/barato y reemplazo
oficial de gpt-5.4-mini. `gpt-5.4` y `gpt-5.4-mini` quedan FUERA del
picker porque OpenAI los marcó deprecados en el catálogo del CLI (campo
`upgrade` apuntando a terra/luna); `gpt-5.5` se conserva SOLO como legacy y
`gpt-5.3-codex-spark` sigue. El default nuevo del protocolo Tándem es
`gpt-5.6-sol` con effort `high`. Aparece además el effort Codex `ultra`
("máximo razonamiento con delegación automática"), PERO SOLO para sol/terra:
luna llega a `max`, y gpt-5.5/spark cortan en `xhigh`; la escala de
esfuerzo de Claude (razonador Cloud) NO tiene `ultra`. Requisito operativo:
CLI Codex >= 0.145.0; con 0.142.4 el modelo devuelve HTTP 400 `requires a
newer version of Codex`, y el id pelado `gpt-5.6` NO existe para Codex con
cuenta ChatGPT (HTTP 400 `not supported when using Codex with a ChatGPT
account`): los ids válidos son los tres sufijados. La whitelist que estaba
DUPLICADA (codex-tool.js + inline en chat/index.js + picker front) se
unificó en `src/modules/chat/codex-models.js`, módulo PURO sin imports para
no arrastrar el Agent SDK ni zod al proceso del server — ese era el motivo
de la duplicación anterior — y `codex-tool.js` la re-exporta por
retrocompatibilidad. El front duplica el mapa a propósito en
`public/js/ui/models.js` (nunca importa del server, mismo criterio que
ROUTER_MANAGED_MODELS). La validación del effort Codex dejó de usar
`EFFORT_LEVELS` (escala de Claude, sin `ultra`) y pasó a
`normalizeCodexEffort(model, effort)`, que clampa por modelo en vez de
mandar un valor que el CLI rechaza con 400; el picker de Sesiones filtra los
efforts por modelo y también clampa al cambiar de modelo.
BUG-780 · TÁNDEM ERA INERTE — dos causas raíz (2026-07-21, reporte de
Niko: «las sesiones marcadas Tándem no usaron Codex para nada»). CAUSA A —
el flag `--tandem` es de SPAWN: `setModelChoice('tandem')`/
`configureTandem()` cambiaban estado (badge 🤝 pintado) pero NO
re-spawneaban el runner, así que el motor vivo seguía siendo chat común con
Edit/Write habilitados. Verificado con `ps`: runners de "Calendario
Microsoft" y "Testing y seguridad" corrían `--model sonnet --effort high`
SIN `--tandem`, y sus transcripts muestran 46 y 54 `Edit` + 0
`delegate_to_codex`. FIX: `_maybeReopenForTandem()` (chat/index.js),
calcado de `_maybeReopenForEffort`, reabre el runner (`reopen()`, respawn
`--resume`) solo si está vivo e OCIOSO, throttle 30 s, y solo si
`_spawnedTandem !== (modelChoice === 'tandem')`; se llama en las 3 ramas
de `setModelChoice` (entrar Y salir de Tándem requieren respawn) y en
`configureTandem`. `_spawnedTandem` se fija junto al `spawnRunner` con la
MISMA expresión que el arg `tandem:` (no pueden divergir) y se PERSISTE en
persist()/rehydrate() como `spawnedTandem`: sin eso, tras reinicio del
server (los runners sobreviven por KillMode=process) quedaba `undefined` y
el badge mentía "pendiente". CAUSA B (más grave) — el bloqueo estructural
vivía en `askPermission` del runner, o sea en `canUseTool`, que es
SHADOWEADO por `bypassPermissions` (DEFAULT del launcher, con el que corren
todos los chats) y por las allow-rules del `settings.json` del usuario
(`permissions.allow: ["Bash","Read","WebFetch"]`, llegan porque el chat
usa `settingSources: ['user',...]`). O sea: el "bloqueo estructural" era
INERTE en el modo por defecto de la consola. El SDK lo avisa al arrancar:
warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — "permissionMode
'bypassPermissions' auto-approves every tool call before the callback is
consulted. To gate every tool call, use a PreToolUse hook instead." FIX: la
capa AUTORITATIVA pasó a ser hook `PreToolUse`
(`tandemPreToolUseHook()` de core/tool-policy.js), la MISMA primera capa
que ya usan los runners headless de la regla 6, inmune a bypassPermissions
y a allow-rules. `chatQueryOptions` acepta ahora `hooks` y el runner lo pasa
cuando `--tandem 1`. El deny viejo de `askPermission` SE CONSERVA como
defensa en profundidad (2ª capa). El hook cierra además la FUGA DE BASH
documentada como conocida ("podría escribir con echo>/sed; instrucción lo
prohíbe"): `isWritingBashCommand(cmd)` (core/tool-policy.js) es heurística
CONSERVADORA que parsea la línea completa ignorando lo entre comillas
(`shellOutsideQuotes`) y deniega redirecciones de escritura `>`/`>>`/`&>`
salvo a /dev/null|stderr|stdout y sin confundir `2>&1`, `tee`, `sed -i`,
`perl -i`, `patch`, `git apply`, `dd of=`, `truncate`, `install -`,
`mv`/`cp`/`rm`/`mkdir`/`touch`/`chmod`/`ln -s`, y `python -c`/`node -e`
cuyo código inline contenga `open(`/`writeFile*`/`appendFile`. Medido:
13/13 comandos de inspección pasan sin falso positivo y 10/10 de escritura
se bloquean. NO es hermética por construcción (`python3 - <<EOF` o un
script ya en disco escapan): barrera de altura razonable, no jaula.
EXCEPCIÓN /tmp: una redirección de escritura cuyo destino sea ruta absoluta
bajo `/tmp/` (sin `..`) se PERMITE (`isScratchTarget`): un script
descartable en /tmp no es código del proyecto ni esquiva a Codex, que es lo
que el guard protege; el resto (`mv`/`cp`/`rm`/`tee`/`sed -i`/etc.) sigue
bloqueado SIEMPRE, aunque apunte a /tmp. Motivo: el guard frenaba scripts
de análisis descartables. UI:
`info()`/`_historyPayload` exponen `tandemActive` como TRI-ESTADO (corregido
2026-07-21, reporte de Niko: «el badge me sigue diciendo pendiente»): `true` =
motor vivo corriendo en Tándem · `false` = motor VIVO que NO lo aplica (la ÚNICA
alarma legítima, la de BUG-780) · `null` = NO hay motor vivo ⇒ no aplica, el
próximo spawn ya nace en Tándem. ANTES era `!!link && _spawnedTandem === true`,
que colapsaba "sin motor" y "motor desincronizado" en el mismo `false`: los 29
chats Tándem DORMIDOS mostraban "⏳ Tándem (pendiente)" siendo que estaban
perfectos (medido en caliente). PRINCIPIO derivado (pedido de Niko): el BADGE DE
MODELO habla SOLO de qué protocolo/modelo está en efecto; el ESTADO de la sesión
(dormida/turno/delegando) lo comunica el PAC-MAN — el badge nunca lo duplica.
Por eso el texto del caso desincronizado pasó de "⏳ Tándem (pendiente)" (suena a
trámite/estado) a "🤝 Tándem · inactivo" en `--cwc-warn`, con título que explica
que el motor arrancó antes del cambio e invita a "Reabrir para cambios". Del lado
front (chat-tab.js): el handler de `history` PRESERVA el `null` (antes un `!!`
lo aplastaba a `false` — ese era el último eslabón del bug), el flag nuevo
`_engineDormant` (true al recibir `closed` con `resumable`, false al llegar
`history`) hace que `_applyModelChoice` ponga el pesimista `false` SOLO con motor
vivo, y al dormirse el motor un `false` previo se degrada a `null` + repinta.
La rama del badge sigue chequeando `=== false`, así que `null` cae sola en la
rama buena. Verificado E2E: backend 29 dormidos→null / 2 vivos→true / cero
`false` espurios; Playwright confirma "🤝 Tándem" en un chat dormido (0 errores
JS); y el ciclo completo de la alarma legítima (motor vivo haiku → elegir Tándem
⇒ `false` ⇒ reopen automático) sigue funcionando. El runner
ahora REPORTA su propio flag `tandem` en el evento `init` y en su respuesta
al `hello`: este último cubre la re-adopción tras reinicio del server,
porque el `init` va con `record:false` y no se replaya. El server adopta
ese valor y corrige `_spawnedTandem`; el persistido queda solo como
optimista inicial/fallback. El gotcha de migración queda resuelto de raíz,
salvo runners spawneados ANTES de este cambio: no reportan el campo y
conservan el valor persistido actual. VERIFICACIÓN E2E hecha: corrida real
del SDK con
`permissionMode:'bypassPermissions'` + `settingSources:['user']`
(allow-rules activas) + hook → el modelo intentó `Write` y luego `Bash` con
redirección, el hook denegó AMBOS y el archivo víctima quedó intacto.
`node --check` OK en los 4 archivos; `/api/health/checks` 14/14 (único
warn: git dirty, esperado).
TÁNDEM RESILIENTE, PARALELO Y AUTÓNOMO (2026-07-25, cuatro fases,
verificado en caliente).
A · RADAR REAL DE DELEGACIÓN. `chat/index.js` ya no reconoce como
«delegando» sólo las tools `Task|Agent`: importa `TANDEM_TOOL`
(`mcp__codex__delegate_to_codex`) desde `core/tool-policy.js` y lo mete por
el mismo camino. Era un hueco especialmente visible porque Tándem es el
default de todo chat nuevo: durante los 8+ minutos de Codex la tarjeta
parecía un «trabajando» mudo, indistinguible de un cuelgue. `toolSummary`
(`chat/shared.js`) resume ahora el `task` por su PRIMERA LÍNEA, no con un
`JSON.stringify` ilegible; así `kidsOf()` (`terminal/sessions.js`) muestra
la delegación con Pac-Man, etiqueta útil y cronómetro.
B · RUNNER DESACOPLADO (regla de oro/regla 2). Antes `codex exec` vivía
DENTRO de `cwc-chat-runner.js`; el timeout operativo de 8 min podía matar
la espera aunque Codex ya hubiera aplicado bien el cambio, perdiendo su
resumen. La ejecución larga vive ahora en `bin/cwc-codex-runner.js` y su
estado durable en disco. `src/modules/chat/codex-shared.js` concentra la
lógica compartida: snapshot git antes/después, atribución del diff,
`runCodex`, `buildDelegationReport` y gestión de jobs. Es un módulo PURO:
NO puede importar el Agent SDK ni zod, porque también lo consume el runner
desacoplado/config-free; arrastrarlos volvería a acoplar la ejecución al
stack del chat y le impediría arrancar como proceso mínimo independiente.
El job persistido tiene esta forma:
`{id, chatId, cwd, task, model, effort, fullAccess, writableRoots, status,
label, startedAt, heartbeatAt, finishedAt, report, isError, error,
threadId}`, con `status` `pending|running|done|error`. `codexJobsDir()`
usa `resolveDataDir()` (multi-tenant); el id se valida contra traversal,
la escritura es atómica `.tmp`+rename y los terminados se podan a las
24 h. El runner procesa UN `--job <id>`, late cada 15 s, no reejecuta uno
terminado y ante cualquier excepción persiste `error`: nunca deja
`running` huérfano.
`CODEX_TIMEOUT_MS` (8 min) murió. `CODEX_MAX_MS` = 60 min es sólo un tope
de SEGURIDAD: desde el salto a `gpt-5.6-sol`, la mediana medida pasó de
~110 s a ~250 s y el 20 % supera 8 min (contra 3–6 % con gpt-5.5).
INVARIANTE OPERATIVO — NO ROMPER: `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` del
chat-runner (3.900.000 ms = 65 min) DEBE ser mayor que `CODEX_MAX_MS`, o
el SDK corta la tool MCP antes de que el job termine. Tocar uno exige
revisar el otro.
C · PARALELO Y RECOLECCIÓN. `delegate_to_codex({background:true})`
devuelve inmediatamente un `jobId`; permite lanzar varias delegaciones en
paralelo sólo cuando sus archivos no se pisan. Sin `background`, el default
sigue esperando como antes. La tool nueva `collect_codex({job_ids?,wait?})`
sin argumentos lista los jobs de esa conversación; con ids espera y
devuelve sus reportes. El aislamiento por `chatId` es una frontera de
seguridad: todo job inexistente o cuyo `chatId` difiera del chat que
consulta se descarta, aunque el llamador conozca su id.
El wiring de `cwc-chat-runner.js` entrega `chatId` y callbacks
`onBgStart`/`onBgEnd` a `createCodexToolServer`; ambos alimentan el radar
por el único camino `bgAdd`/`bgDone`. Al arrancar, `rehydrateCodexBg()`
recupera los jobs `pending|running` de ESE chat, conserva su `startedAt`
real y descarta un `running` con heartbeat vencido más de 90 s.
`warnBgKilled()` ya no afirma que Codex murió al dormir el motor: su
proceso sigue y el resultado se recupera con `collect_codex`; el aviso de
corte queda sólo para subagentes/workflows que sí viven dentro del SDK.
D · AUTONOMÍA EJECUTABLE. La línea `🎾 Pelota: MÍA` dejó de ser decoración:
`declaresBallMine()` mira sólo las últimas 3 líneas no vacías y exige el
emoji más «pelota…mía», evitando falsos positivos en el cuerpo.
`autonomyStopHook()` bloquea el evento `Stop` con
`AUTONOMY_CONTINUE_REASON`, así el SDK devuelve el control y el chat sigue
con el próximo paso. `AUTONOMY_INSTRUCTION` entra al system prompt de TODO
chat, no sólo Tándem. `mergeHookSets` reemplaza al merge limitado a
`PreToolUse` y compone por evento, para no tirar `Stop` en silencio; el
nombre viejo `mergePreToolUseHooks` queda como alias.
CONTRATO: `MÍA` = seguir solo; `TUYA`, `nadie` u `OTRO` = terminar el turno
de verdad. NO HAY TOPE de continuaciones por decisión explícita de Niko
del 2026-07-25: no cortar por `stop_hook_active` ni agregar un contador en
una sesión futura; la pelota es la única válvula de escape. Cada
continuación emite un evento efímero `{type:'autonomy', turn:N}` y un log;
cada mensaje humano nuevo reinicia el contador, para distinguir autonomía
de un turno pedido por el usuario.
TRABAJO EN SEGUNDO PLANO — no matarlo y poder verlo (2026-07-22,
PLAN-892, reporte de Niko: «me confío que está trabajando pero no»).
BUG RAÍZ: una sesión que lanza trabajo en BACKGROUND (tool `Workflow`
o `Agent` asíncrono) cierra el turno y queda `waiting`; a los 45 min
(`SLEEP_MS`) el reaper del server o la auto-siesta del runner duermen
el motor y el trabajo de fondo MUERE con el proceso, SIN dejar marcador
visible — el chat queda diciendo "corriendo" para siempre y el aviso
`<status>stopped</status>` llega recién al revivir el runner. Caso
trazado: chat `c324495-1` (Tolkien), Workflow lanzado 04:19, muerto
05:05 por `sleep`, avisado 11:30 → 7 h 11 min de silencio. Medido:
7 transcripts con trabajo de fondo (6 en Mi Consola, 1 en Tolkien),
14 notificaciones `stopped`. Violaba la regla de oro: nada en curso
puede quedar atado al ciclo de vida del proceso. SOLUCIÓN — UNA fuente,
DOS resultados: el RUNNER lleva un registro `bgWork` de los trabajos de
fondo vivos, y ese MISMO registro (a) impide dormir el motor y (b)
alimenta el radar visual de la tarjeta de Sesiones. ALTA: el runner mira
el `tool_result` de cada `tool_use` — hay DOS formatos reales,
verificados en vivo (`Workflow launched in background. Task ID: <id>` y
`Async agent launched successfully ... agentId: <id>`), unificados en
`bgLaunchId()`. La ETIQUETA sale, en orden: del `Summary:` del Workflow,
del `description` del input del Agent (`recentToolUse.desc` — sin esto el
label era el JSON crudo de `toolSummary`), del summary, o del kind. BAJA:
los DOS formatos cierran con el MISMO bloque
`<task-notification><task-id>…</task-id><status>…</status>`, que llega
como mensaje `user` con `content` de tipo STRING (rama que el runner
ANTES ignoraba por completo: sólo procesaba `Array.isArray(blocks)`).
GOTCHA CLAVE (verificado, costó descubrirlo): el SDK ESCRIBE esa
notificación en el transcript apenas el trabajo termina, pero sólo la
ENTREGA al stream del runner en el PRÓXIMO turno (la encola) — así que
con la sesión ociosa un trabajo ya terminado seguiría "vivo" reteniendo
el motor hasta el tope. Por eso el runner además BARRE SU PROPIO
TRANSCRIPT (`sweepBgFromTranscript()`, cada 20 s y antes de decidir la
siesta): misma señal, leída de disco, sólo la COLA del `.jsonl` (256 KB)
y todo best-effort. RETENCIÓN: la siesta AUTOMÁTICA por inactividad se
pospone mientras haya trabajo vivo (`bgHolds()`), tanto en el runner
como en el reaper (`!(c._bgTasks?.length)`, defensa en profundidad);
una acción EXPLÍCITA del usuario o un traspaso (archive / quiesce /
`_toTui` / reopen) manda `{t:'sleep', force:true}` y SÍ duerme. Tope
`BG_MAX_HOLD_MS` = 4 h desde el último lanzamiento (no runner inmortal).
Al dormir/cerrar con trabajo vivo, `warnBgKilled()` emite un evento
`error` VISIBLE en el chat con las etiquetas de lo que se cortó — el SDK
no deja ninguna marca, esa nota es la única señal. El runner reporta
`bgTasks` en su `hello` (re-adopción tras reinicio del server, mismo
patrón que el flag `tandem`) y emite `{type:'bg', tasks}` que el server
INTERCEPTA en `_onRunnerEvent` ANTES del `_push` (no entra al history).
`info()` expone `bgTasks[]` y `delegatingList[]` (para esto
`_delegatingIds` pasó de Set a Map: ahora cada subagente lleva `label` +
`since`). LIMITACIÓN CONOCIDA: un agente REANUDADO con `SendMessage` no
emite alta nueva, así que no se re-registra (peor caso = comportamiento
anterior).
SELECTOR DE MODELO REDISEÑADO — protocolo DERIVADO de la selección
(2026-07-15, PLAN-519, pedido de Niko; VERIFICADO E2E): la arquitectura
YA NO se elige como un modelo suelto — se INFIERE de 2 toggles EXCLUYENTES
[🤖 AutoTux][🤝 Tándem] + columnas Cloud/Codex, con LEYENDA dinámica. Tabla
de verdad: AutoTux (modelChoice='auto') = router entre Haiku+Sonnet+Opus
SIEMPRE contiguos + Fable OPCIONAL como techo (opt-in), esfuerzo automático,
Codex gris · Tándem con Codex (1 Cloud razonador + 1 Codex ejecutor,
configurables) · Manual EMERGE de Tándem SIN Codex (modelo Cloud forzado +
effort). Toggles excluyentes → NO hay combo AutoTux+Tándem (descartado a
propósito). CAMBIOS BACKEND: (F1) core/model-router.js — las funciones
(clampLevel/decideBase/insufficiencyEscalation/decideUpAxis) aceptan
`levels`/`ceiling` por PARÁMETRO (default = escala base de 3, comportamiento
idéntico → 0 regresión, los 68 tests viejos pasan); `levelsFor(fableCeiling)`
devuelve ['haiku','sonnet','opus'(,'fable')]. Chat: `_fableCeiling` (persist/
rehydrate/info) + `_routerLevels()` threaded en TODO el router; el guard
FORBIDDEN_AUTO se relaja SOLO con opt-in (`setFableCeiling`). Fable como techo
es CONTIGUO (un nivel más arriba) → la aritmética ±1 no se tocó; NO hay
"rebase a subconjunto no contiguo" (se descartó por diseño). (F2) Tándem
CONFIGURABLE: el razonador = this.model/this.effort (Cloud, era opus/medium
hardcodeado), el ejecutor = `this.tandemCodex {model,effort}` (era gpt-5.5/high
hardcodeado) → `configureTandem({reasonerModel,reasonerEffort,codexModel,
codexEffort})`; codex-tool.js createCodexToolServer acepta model/effort (whitelist
CODEX_MODELS/CODEX_EFFORTS); runner arg --codex-model/--codex-effort. (F5)
POST /api/chat/model acepta {model:'auto',fableCeiling} · {model:'tandem',
tandem:{...}} · {model:<cloud>,effort} (Manual). Retrocompat: modelChoice string
SE QUEDA (auto/tandem/forzado) + 2 campos nuevos; tandem viejo → defaults; sin
migración destructiva. (F3) UI: sessions.js pickModelForChat reescrito (.mp-*
en style.css) — 2 toggles + columnas + leyenda por protocolo (color por token:
AutoTux acento · Tándem acento-frío · Manual tenue) + effort por chip (select) +
checkbox Fable. Test determinista bin/cwc-test-model-router.js: 77 pass (68+9
fable). VERIFICADO E2E: 3 protocolos por endpoint (Manual sonnet/high · AutoTux+
Fable · histórico Tándem sonnet/low+gpt-5.4/medium) + picker por Playwright (leyenda
dinámica, 0 errores). El badge del header (chat-tab.js) se conserva (auto→AutoTux
· tandem→🤝 Tándem · forzado→modelo). Métricas/calibración (F6): logDecision/
logTurn siguen; con fable en la escala el `from`/`to` puede ser 'fable' (la
calibración lo tolera, es un nombre de modelo más). Ver PLAN-519 en Pad `console`.
DIAGRAMAS ```mermaid``` (2026-07-11, pedido del usuario "poder generar
diagramas desde el chat"): un bloque ```` ```mermaid ```` en la respuesta
del modelo se renderiza como SVG inline (flowchart/secuencia/ER/gantt/
arquitectura/etc.), no como texto. SOLO frontend, cero cambios de backend
— el render es 100% client-side en public/js/ui/markdown.js
(enhanceMermaidBlocks, se llama tras enhanceCodeBlocks en renderMarkdown).
VENDOR: `mermaid` (dependencia en package.json, patrón chart.js/marked/
hljs) — a diferencia de esos tres, Mermaid v10+ SOLO distribuye ESM (sin
bundle IIFE), así que se vendorea `dist/mermaid.esm.min.mjs` +
`dist/chunks/mermaid.esm.min/*.mjs` (sin .map, ~3.6 MB) a
public/vendor/mermaid/ y se carga con un `<script type="module">` propio
en index.html (el único vendor de este proyecto cargado como módulo) que
hace `import()` + `mermaid.initialize()` con el tema tomado de
`getComputedStyle` sobre los tokens `--cwc-*` (nunca hex duplicado) y
cuelga la instancia lista en `window.mermaid` + la promesa en
`window.mermaidReady` (markdown.js espera esta promesa antes de
renderizar — el script type=module se difiere, puede terminar después de
que llegue el primer mensaje). SEGURIDAD: el ALLOWLIST de sanitize() de
markdown.js NO se tocó (sigue sin permitir SVG/IMG crudos del modelo);
el SVG que se inserta lo genera el PROPIO PARSER de Mermaid
(`securityLevel:'strict'`) a partir de texto plano ya sanitizado, nunca
HTML libre del modelo — mismo criterio que ya se acepta para Chart.js en
el modal Uso. Degradación: sintaxis inválida, bloque de más de
MERMAID_MAX_LINES (400) líneas, o vendor sin cargar ⇒ cae al bloque de
código plano de siempre (nunca rompe el resto del mensaje). El código
fuente del diagrama queda SIEMPRE disponible pero COLAPSADO bajo un
`<details>` "Ver código Mermaid" debajo del SVG (convención "UI
colapsable" del proyecto). chat-tab.js escucha el evento
`cwc:mermaid-rendered` (bubbling, disparado al terminar el render async)
sobre `.chat-msgs` y re-llama `_scroll()` — mismo criterio "pinea abajo"
que ya usa el resto del chat, porque el diagrama aparece DESPUÉS de que
el mensaje ya está en el DOM y puede crecer la burbuja. Alcance: SOLO el
chat (`chat-tab.js` vía `_assistantFinal`) — Aprendizaje y Tareas siguen
usando `renderMarkdown(...).innerHTML` de forma SÍNCRONA (ver gotcha de
`renderMarkdown` más abajo), así que un diagrama ahí degrada al bloque de
código (el render de Mermaid es async y el `.innerHTML` ya se leyó antes
de que termine) — limitación conocida, no un bug nuevo.
ZOOM (click → modal, `openMermaidZoom` de markdown.js): el diagrama es
clickeable (`.md-mermaid--zoomable`) y abre una copia grande en el modal
genérico (ui/dialog.js). GOTCHA/FIX 2026-07-11: Mermaid deja un
`style="max-width:NNNpx"` INLINE en el SVG (tamaño chico para caber en la
burbuja); `svg.cloneNode(true)` conserva ese atributo y un style INLINE le
gana en especificidad a `.md-mermaid-zoom-body svg{max-width:none}` de
style.css → el diagrama quedaba diminuto arriba a la izquierda con el modal
casi vacío. Se pisa el estilo inline del clon por JS DESPUÉS de clonar
(`clone.style.maxWidth='none'` + width 100%/height auto — un set por JS
también es inline pero se aplica después, así gana al de mermaid). NO
depender solo del CSS externo para anular estilos inline que trae el vendor.
PREVIEW + AFFORDANCE "AMPLIAR" (2026-07-11, pedido de Niko: "el diagrama se
ve diminuto"). CAUSA RAÍZ real (verificada en vivo con Playwright sobre una
sesión con diagramas reales): un flowchart complejo tiene un viewBox grande
(ej. 1948×1342) y se ESCALA para caber al ancho de la burbuja (~570px) →
factor ~0.29 → el texto interno queda a ~5px, ilegible. NO es un bug de
código ni se arregla con "generá el SVG más grande" (un SVG es VECTORIAL,
no tiene resolución: a cualquier tamaño nominal, comprimido a 570px se ve
igual de chico) — es intrínseco a meter un diagrama ancho en una burbuja
angosta. El zoom (arriba) YA daba la versión legible, pero la ÚNICA pista
para ampliarlo era `cursor:zoom-in` — INVISIBLE en touch/móvil (no hay
hover ni cursor). SOLUCIÓN (enfoque "miniatura de adjunto", NO rasterizar a
PNG — se evaluó y descartó: perdía nitidez vectorial y sumaba plomería):
(a) el SVG va en un CANVAS interno `.md-mermaid-canvas` con `overflow:auto`
+ `max-height` (340px desktop / 240px móvil) → un diagrama grande se muestra
como PREVIEW acotado (como la miniatura de una imagen adjunta) en vez de un
muro que ocupa media pantalla; (b) un BADGE `.md-mermaid-zoom-btn`
("🔍 Ampliar", ícono `search` de icons.js) SIEMPRE visible pinneado a la
esquina sup-derecha (hijo directo del holder `position:relative`, FUERA del
canvas para no scrollear con él) — hace obvia la ampliación en móvil. El
badge hace `stopPropagation` (abre el zoom UNA vez; sin él, el click
burbujea al holder y se abrirían dos modales). Toda la caja sigue siendo
clickeable (holder). REGLA GENERAL derivada: un diagrama/imagen que se
comprime para caber NUNCA es legible inline — la respuesta es preview
acotado + affordance de ampliar SIEMPRE visible (no solo hover), nunca
"hacerlo más grande". Alternativas de diagrama-como-código (D2/Graphviz/
PlantUML/nomnoml) se investigaron y NO aportan: mismo problema de display,
mismo costo de tokens, y todas las buenas necesitan build/servidor (chocan
con "todo local, render client-side") — Mermaid sigue siendo la elección; el
ahorro real de tokens es usar ÁRBOL HTML/CSS o TABLAS para jerarquías/
comparaciones y reservar Mermaid para flujos con ciclos.

## Gotchas de esta carpeta

- Traspaso Chat↔TUI: regla dura "nunca ambos a la vez"; el cierre del lado
  saliente se ESPERA verificado antes de abrir el otro. El header del chat
  YA NO tiene botón TUI ni contador de costo (se quitaron a pedido): pasar
  a TUI vive SOLO en el menú ⋯ de la tarjeta en Sesiones (onToggleMode
  queda en ChatTab por compatibilidad, sin botón). En su lugar hay un "?"
  (icono `help` de icons.js) junto al selector de modos que abre el modal
  "Modos de permisos" (_modeHelp: explica Preguntar / Aceptar ediciones /
  Solo plan). El costo por turno dentro del hilo (chat-turn-cost) queda.
