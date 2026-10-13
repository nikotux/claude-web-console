<!-- cwc:ficha-modulo -->
# bin — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### bin/cwc-pad-mold.js    auditor y migrador serial del molde declarativo de
workspaces Pad de inquilinos. Sin flags o con `--audit` abre
`~/.pad/pad.db` read-only y lista todos los `tenant-*` activos con versión
registrada, colecciones presentes/faltantes y divergencias de prefijo y schema,
sin escribir; el schema se compara byte a byte contra el molde.
`--apply <workspace-slug>` completa/corrige uno y `--apply-all` hace lo mismo;
obtiene el token propio con `readUserPadToken`, escribe únicamente por
`core/pad-service-client.js`, respeta rate-limit y continúa ante `sin-token`.
Un prefijo divergente se corrige solo si la colección no tiene ítems no
archivados: con datos se reporta para decisión humana porque cambiarlo
alteraría los refs visibles. Un schema divergente se reconcilia únicamente
cuando el molde conserva todo el string actual y agrega fields al final; otra
divergencia queda para decisión humana. Al verificar las diez colecciones, sus
prefijos y schemas registra la versión en `~/.cwc-data/pad-mold-state.json`.
Blindaje doble: solo acepta el patrón
`tenant-*` y además excluye explícitamente `console`, `tolkien` y `comunidad`;
nunca puede escribir en esos tres workspaces.
### bin/cwc-pad-facets.js    clasificador one-shot de los cuatro campos de facetas
de CONVE-2279 en `arquitectura`. Sin flags hace dry-run completo; solo escribe
con `--apply`, admite filtros y JSON, y fija el workspace a `console`. Deriva
`plano` y `audiencia` de señales del código o de la topología, mientras
`perfil` NO se deriva: las decisiones viven en `MANUAL_FACETS`, con default
`general` para módulos no declarados y herencia hacia archivos, endpoints y
runners. Expande el schema mediante cirugía sobre su string JSON crudo,
conservando byte a byte el prefijo por el contrato de `DOC-633`.
### bin/cwc-facets-snapshot.js    generador determinístico de la foto local de
facetas que consume Salud. Lee `~/.pad/pad.db` en modo solo lectura/query-only
y escribe `src/modules/health/facets-snapshot.json`, JSON de datos versionado
en el repo; no consulta la red. Es idempotente: compara el contenido útil sin
`generatedAt` y no reescribe si nada cambió, para no ensuciar git solo por la
fecha. Sin flags actualiza la foto; `--check` no escribe y sale con código 1 si
difiere, `--json` emite el resumen estructurado y `--help` muestra el uso. NO
es un runner: no corre en el tiempo, no tiene lock ni estado; es un CLI
one-shot que se ejecuta a mano, en particular después de
`cwc-pad-facets.js --apply`.
### bin/cwc-pad-arch-gen.js    generador del árbol `arquitectura` desde el inventario
determinístico: crea/adopta/actualiza raíz, subsistemas, módulos, archivos,
endpoints y runners, reconcilia sus links `parent` y puede retirar sobrantes
con `--prune`; `--dry-run`/`-n` no escribe. Al actualizar o adoptar mezcla
`kind`/`status`/`uid` sobre los fields frescos para conservar las facetas:
el PATCH de Pad reemplaza `fields` completo y un literal las borraría.
### bin/cwc-pad-graph-fix.js    reparación one-shot e idempotente del grafo de Pad en el
workspace `console`: reparenta PLAN-507/PLAN-272 desde nodos ARQUI retirados
a sus sucesores y borra exclusivamente links `implements` cuyo target coincide
con el `parent_ref` del mismo ítem. Sin flags hace DRY-RUN completo (cero
escrituras); `--apply` revalida cada link antes de borrarlo/crearlo, opera
secuencialmente y respeta el rate-limit. Nunca toca el workspace `tolkien` ni
borra ítems. `--apply --only-reparents` ejecuta únicamente el Trabajo A para
PLAN-507/PLAN-272 y omite por completo el relevamiento de links y las
escrituras del Trabajo B; sirve para verificar el recálculo de `parent_ref`
antes del lote.
ADVERTENCIA: no volver a ejecutar el Trabajo B. La premisa resultó falsa:
`parent_ref` es un campo derivado del link disponible y no demuestra que haya
una arista `parent` separada; borrar el `implements` coincidente puede dejar al
ítem sin ninguna arista.
### bin/cwc-pad-links-restore.js    restauración one-shot, reanudable e idempotente de los
531 links `implements` borrados por el Trabajo B de
`cwc-pad-graph-fix.js`. Compara por ID el backup fijo
`~/.cwc-backups/pad-backup-2026-07-26_21-28-47.db` con la DB viva, abre ambas
solo lectura y escribe únicamente por la API REST de Pad. Sin flags hace
dry-run; `--apply` exige exactamente 531 faltantes, todos `implements`,
revalida cada arista con `listLinks` antes de recrearla y aborta al primer
error. El workspace está fijado a `console`: nunca opera sobre `tolkien`.
Existe porque `parent_ref` es derivado de la arista disponible, sin importar
su tipo, y por lo tanto no implica la existencia de un link `parent` propio.
### bin/cwc-pad-wikilinks-fix.js    reparación one-shot de wiki-links rotos en el
Pad LOCAL del workspace `console`: transforma `[[console:BUG-1]]` y
`[[tolkien:BUG-1]]` en la sintaxis de alias
`[[BUG-1|console:BUG-1]]` / `[[BUG-1|tolkien:BUG-1]]`. El alias conserva el
mundo explícito como texto visible —convención `CONVE-2056` para evitar
colisiones entre refs— y a la vez permite que Pad resuelva el target como ref;
por eso no se quita el prefijo. Es idempotente porque la forma nueva ya no
matchea el patrón viejo. Sin flags hace dry-run completo; `--apply` relee cada
ítem por REST y actualiza solo `content` con concurrencia optimista. El
reemplazo ignora bloques cercados (backticks o tildes) y código inline para
alinearse con el parser de Pad, que no interpreta wiki-links dentro de código,
y evitar corromper ejemplos pedagógicos que enseñan la sintaxis. El
workspace está fijado por código a `console`: nunca opera sobre `tolkien` ni
`tenant-*`.
### bin/cwc-pad-prosa-links.js    materializador one-shot e idempotente de refs
escritas en la prosa de los items de Pad: convierte `PLAN-1` en
`[[PLAN-1]]` y `console:PLAN-1` en el alias
`[[PLAN-1|console:PLAN-1]]`, conservando la calificación visible de
`CONVE-2056`. A diferencia de `cwc-pad-wikilinks-fix.js`, no repara markup ya
existente: descubre por REST todos los items vivos y los prefijos reales de las
colecciones del workspace. Solo materializa targets vivos del mismo mundo;
salta auto-referencias, refs inexistentes y refs calificadas de otro mundo, y
no toca wiki-links previos, bloques cercados, código inline, URLs ni enlaces
Markdown. Sin flags hace dry-run; solo escribe con `--apply`, acepta
`--workspace` (default `console`) y `--limit N` limita la cantidad de items con
cambios. Antes de cada PATCH relee el item, parsea el `fields` serializado y lo
reenvía completo junto con el contenido nuevo; opera en serie, pausa entre
escrituras y reintenta el rate-limit.
### bin/cwc-pad-fix-decisions.js    reparación idempotente del `decision_log` de
Pad cuando el bug del server `console:BUG-3042` concatena el rationale dentro
de `decision` con markup crudo de la tool-call. Recorre las colecciones por la
API REST, separa ambos textos sin alterar las demás claves de cada entrada y
envía el objeto `fields` completo para preservar todos los campos. Es dry-run
por default; solo escribe con `--apply` y acepta `--workspace <slug>` (default
`console`). Existe mientras `console:BUG-3042` siga vivo; no intenta corregir
decisiones guardadas en el ítem equivocado, que requieren resolución manual.
### bin/cwc-pad-mc-regroup.js    migración one-shot, serial e idempotente de
`console:PLAN-3052` (C4): lee del journal del workflow el mapeo de 547 lecciones
de `mejora-continua` a 15 grupos temáticos ya existentes en `arquitectura` y
resuelve cada grupo por título exacto entre los ítems vivos con `kind=grupo`.
Nunca crea grupos y aborta si falta uno o el título es ambiguo. Sin flags hace
dry-run; solo escribe con `--apply`, acepta `--journal` y `--limit`, y opera
siempre en `console`. Para reparentar ejecuta los dos PATCH requeridos
(`clear_parent: true` y luego `parent`), en serie, con pausa y backoff ante 429;
relee las aristas después de cada lección y aborta inmediatamente si la segunda
fase deja una lección huérfana o si no puede verificar el parent final.
### bin/cwc-pad-mc-parent.js    migración one-shot, serial e idempotente de la
jerarquía de `mejora-continua` en el Pad LOCAL. Deriva el bucket `MC · *`
exclusivamente desde `fields.category` usando el mapa exportado
`MC_SUN_BY_CATEGORY` de `retro/store.js`: no usa un mapa manual. Sin flags
hace DRY-RUN completo; solo escribe con `--apply` explícito y admite
`--ref MC-n`, `--limit N` y `--json`. El dry-run abre `~/.pad/pad.db`
read-only/query-only y relee las aristas vivas con un SELECT por ítem justo
antes de decidir; `--apply` hace esa relectura fresca con `listLinks` y la
caché compartida deshabilitada. Crea el link `parent` con `setParent` si falta
y borra únicamente el `implements` redundante hacia ese mismo sol. Si ya
existe un `parent` hacia otro target, conserva el dato y salta el ítem sin
escribir. Opera siempre en el workspace `console`, en serie y con reintento
ante 429; nunca toca `tolkien` ni `tenant-*`.
### bin/cwc-pad-schema-expand.js    expansor APPEND-ONLY del `schema` de una
colección de Pad (`console:PEND-2286`). Nació para el paso EXPAND del
expand/contract (`console:CONVE-2278`, principio 3): antes de mover ítems a una
colección destino hay que declarar ahí los campos que el origen traía, o
`pad_item move` los descarta en silencio. Exige `--workspace` y `--collection`
(sin default: escribir en el workspace equivocado es el riesgo principal) y uno
o más `--field '<json>'`. Dry-run por defecto; `--apply` para escribir,
`--backup-db` para el respaldo WAL-aware previo a la primera escritura.
Es idempotente: una `key` que ya existe se reporta `ya-declarado` y se omite.
Construye el schema nuevo por CIRUGÍA DE STRING —`actual.slice(0,-2) + ',' +
sufijo + ']}'`— y NUNCA re-serializando el JSON (`DOC-633`: el schema es un
string crudo). Antes de escribir se autoverifica: prefijo viejo intacto, el
schema creció, la cuenta de `fields` cuadra, y cada field viejo sigue byte a
byte en su mismo índice. Después de escribir RELEE la DB con una conexión nueva
y falla si el resultado no coincide byte a byte — esa verificación es su razón
de ser, porque el PATCH del server devuelve éxito sin garantizar el contenido.
A diferencia de `cwc-pad-mold.js`, este SÍ puede operar sobre `console`: aquel
protege `console` por diseño (`EXCLUDED_WORKSPACES`) y romper esa protección
para un one-off habría sido peor que tener una herramienta aparte.
### bin/cwc-pad-move-items.js    movedor GENÉRICO de ítems entre colecciones
del Pad LOCAL, con el workspace `console` fijado por código: rechaza un
`CWC_PAD_WORKSPACE` distinto y nunca toca `tolkien` ni `tenant-*`. Exige
`--from` y `--to`; acepta `--ref` repetible —sin refs toma todos los ítems vivos
de `--from`—, `--limit`, `--set clave=valor`, `--map-status viejo=nuevo`,
`--preserve campoOrigen=campoDestino`, `--backup-db`, `--apply` y `--json`.
Sin `--apply` es dry-run total. Es idempotente: un ítem que ya está en destino
se cuenta como `ya-en-destino` y no vuelve a moverse; uno que está en una
tercera colección se salta como `fuera-de-alcance`. Opera en serie, reintenta
ante 429 con el mismo `withRateRetry` que los CLIs vecinos y lee el estado
previo de `~/.pad/pad.db` en modo read-only/query-only.
La semántica REAL de `move` se midió en la primera ejecución de la historia del
Pad (2026-07-29, `console:PEND-2284`; hasta ese día
`item_collection_moves` tenía 0 filas): conserva el UUID del ítem,
`item_number`, `slug`, `content`, `created_at`, sus comentarios, sus versiones
y TODAS las aristas de `item_links` en ambas direcciones —los hijos siguen
colgando solos y no hay que reparentar nada—, pero el ref cambia de prefijo y el
server aplica el schema del destino con pérdida silenciosa. Un campo que no
existe en el schema destino se descarta sin avisar y un valor de `select` fuera
de las `options` del destino se reemplaza por el `default` del destino. Por eso
el CLI reporta `campo-descartado` y `valor-fuera-de-enum` en el dry-run, y por
eso existen `--preserve` y `--map-status`.
Segunda ejecución en volumen (2026-07-29, `console:PEND-2286`): 245 ítems de
`tasks` a `pendientes` en tandas de 50, ~8,5 s por tanda. Verificado contra el
backup previo, ítem por ítem: 245/245 conservaron número de ref, `slug`,
`created_at` y contenido byte a byte; los 1029 valores de campo sobrevivieron;
las 2464 aristas del workspace quedaron idénticas antes y después. Apareció un
TERCER modo de falla que F6 no había visto: el server rechaza el `update` de
status posterior al move si el ítem tiene un "hijo" no terminal, y **cuenta los
`implements` como hijos** (`console:BUG-2325`) — 6 ítems `done` quedaron en el
default `pendiente` con el CLI reportando el error pero el move ya aplicado. Se
corrigieron con `force=true`. Moraleja operativa: **el resumen del CLI no es
evidencia suficiente; toda migración en lote se verifica comparando la DB contra
el backup previo.**
`--backup-db` usa `backup()` de `node:sqlite`, un backup online y WAL-aware, y
NO `copyFileSync`: `~/.pad/pad.db` corre en `journal_mode=wal` y una copia plana
del archivo principal deja afuera las páginas del WAL. Si el backup falla, la
corrida ABORTA con exit 1 antes de mover nada. Este CLI es el camino que reusa
la fase F8 (`console:PEND-2285`) para mover las colecciones de conocimiento.
### bin/cwc-whatsapp-daemon.js  puente WhatsApp ↔ Comunicaciones (Baileys, servicio systemd
whatsapp-bridge.service, sesión emparejada, estado persistido
~/.cwc-data/comms/whatsapp*, PLAN-447 — ver el detalle completo en
el módulo `comms/` arriba). Corre 24/7 como proceso largo:
watchlist de chats + discovery de nuevos, recepción de mensajes +
adjuntos (downloadMediaMessage → whatsapp-media/), TRANSCRIPCIÓN de
voz (whisper.cpp vía whatsapp-transcribe.js), envío por el OUTBOX
file-based (texto + adjuntos), heartbeat en daemon.json. Modos
puntuales: --find / --groupmeta / --listgroups. NUNCA con nohup
(se cae); systemd es la única forma resiliente.
### bin/cwc-whatsapp-work.js    TRAE un hilo de WhatsApp a la carpeta de trabajo de UN chat de la
consola (PEND-479, el reemplazo del dashboard eliminado): dado un
hilo (jid o substring de su label) y un chatId, copia a
~/.cwc-data/chat-attachments/<chatId>/ los audios + sus .txt de
transcripción + PDFs + imágenes del hilo + un <hilo>-historial.txt
con la conversación y las transcripciones inline. Determinístico, 0
tokens: reusa materializeIntoChat() de chat/attachments.js. Es el
disparador del flujo de SEGUIMIENTO "trabajar un hilo en un chat"
(el asistente lo corre con el chatId actual cuando el usuario pide
"traeme el hilo de X"). Uso: cwc-whatsapp-work.js <jid|label> <chatId>
### bin/cwc-attach.js           COPIA un archivo de disco (de CUALQUIER fuente externa) al
ESCRITORIO DE TRABAJO de una conversación de chat —
~/.cwc-data/chat-attachments/<chatId>/, la carpeta que abre "Abrir
carpeta de este chat" (PLAN-447, pedido de Niko 2026-07-14). El
asistente lo invoca al TRAER un archivo trabajable a la conversación
(adjunto de WhatsApp ya descargado por el daemon en
comms/whatsapp-media/<jid>/, adjunto de Outlook guardado a disco por
graph_*, un informe, una factura). Así TODOS los archivos de trabajo
quedan en un solo lugar, listos para manipular, y VIAJAN con el
paquete-sesión al cambiar de mundo (chat-attachments NO está anidado
por mundo; el handoff conserva el mismo chatId). Determinístico, 0
tokens: reusa materializeIntoChat() de chat/attachments.js (filtro
isWorkableFile = rechaza ocultos/vacíos/temporales .tmp/.part/
.crdownload/lock/… ; nombre saneado/único; confinamiento anti-traversal
a la carpeta). Uso: cwc-attach.js <chatId> <rutaAbs> ["nombre legible"];
exit 0 copiado · 3 filtrado por no-trabajable · 1/2 error. El modelo
aprende su carpeta + la regla por el system prompt (ver
core/tool-policy.js sessionFolderRule). Cómo LO SABE: la inyección de
carpeta va en el system prompt de TODO chat nuevo/reabierto — un runner
YA VIVO de antes del deploy NO la tiene hasta "Reabrir para cambios" o
un chat nuevo (mismo gotcha del bootstrap de Pad).
### bin/cwc-setup.js            INSTALADOR guiado de una instancia INDEPENDIENTE (PLAN-476/PEND-381,
C2 del Programa Satélite). Para que un compañero levante SU propia
consola sin heredar identidad de nadie: (1) preflight de requisitos
(Node>=20/git/openssl críticos · tmux/Claude Code/ZeroTier/node_modules
warn) · (2) genera .env con token maestro (crypto.randomBytes) + puerto/
home/proyecto · (3) fija la IDENTIDAD de la instancia (nombre/email/
GitHub/firma) en instance.json vía saveInstance del módulo env-vars ·
(4) instala/arranca el servicio systemd reescribiendo WorkingDirectory
del template a la ruta REAL del repo (portable, no asume ~/claude-web-
console) + enable-linger · (5) ofrece los hooks opcionales (observer/
interfono/pelota, spawnea sus install-*.js) · (6) crea el 1er admin
(spawnea cwc-adduser ANTES de arrancar el servicio, así lo toma al
iniciar). NO importa core/config.js a propósito (haría exit sin .env).
`--check` = SOLO preflight sin prompts (CI/verificación), exit 1 si
falta algo crítico. Interactivo con readline.
### bin/cwc-adduser.js          crea un usuario de la consola desde la CLI (reusa createUser de
core/users.js, mismo users.json/scrypt/600). NO importa config.js (corre
sin .env). Uso: cwc-adduser.js <usuario> [--admin] — pide contraseña
OCULTA (readline con _writeToOutput muteado); `--password-stdin` la lee
de stdin (automación). El PRIMER usuario se fuerza admin. OJO: el server
vivo NO relee users.json en caliente (reiniciar para que lo tome); en
instalación nueva se crea antes de arrancar el servicio.
### bin/cwc-infisical-login-runner.js  LOGIN GUIADO de Infisical para la pestaña Conexiones:
runner PTY (node-pty, `infisical login --domain <base>` exige TTY),
estado en `~/.cwc-data/infisical-login/infisical.json`, token por
archivo 0600 efímero que se borra apenas se escribe al pty. En el flujo host
declara éxito tras re-verificar `infisical login status`. Acepta
`--user <userId>` para onboarding: si es un inquilino, prepara su espacio y
corre el PTY con HOME aislado por `userRunnerEnv` y cwd=`userSpace(user)`, de
modo que la sesión queda en SU `.infisical/` y el éxito se detecta por su
`infisical-config.json`; el job y el buzón `.token`
permanecen siempre en `~/.cwc-data/infisical-login/` del HOST porque el server
los escribe y consulta. Sin `--user` conserva exactamente el comportamiento
histórico del host (mismo cwd/env/jobs).
### bin/cwc-onboard-runner.js  CANJE GUIADO de credenciales Claude por usuario durante onboarding:
runner PTY de `claude setup-token` con HOME/workspace aislados mediante
`userRunnerEnv`; publica estado + `pid` en
`~/.cwc-data/onboard-jobs/<user>.json` y vuelca salida sin ANSI en
`<user>.log` mode 600. TODA escritura al log y todo `note` pasan por redacción
obligatoria de `sk-ant-*`: el secreto solo se guarda en
`userOauthTokenPath(user)`. Vigila `<user>.code` durante toda la corrida:
acepta múltiples intentos y, si un canje no produce token en 20 s, vuelve a
`awaiting-code` con un `note` diagnóstico para reintentar desde el wizard:
filtra URLs y ruido de UI y busca la última línea que parezca un error real;
si no la hay, devuelve un mensaje accionable fijo. El volcado completo queda
solo en `<user>.log`.
GOTCHA: escribe el código al PTY y manda Enter en una llamada SEPARADA 300 ms
después, porque Ink trata un `\r` pegado a texto largo como parte del pegado y
nunca envía; verificado en el log del PTY (35 chars se enviaban, 92 no). Era la
causa raíz de los canjes que morían en `exchanging`.
SIGTERM/SIGINT dejan `error:cancelado` y matan el PTY; timeout duro: 10 min.
### bin/cwc-sponsor-token-runner.js  CANJE GUIADO del token PROPIO de patrocinio:
runner PTY desacoplado de `claude setup-token`, con estado en
`~/.cwc-data/sponsor-token-jobs/<user>.json` + `<user>.code` + `<user>.log`,
todos mode 600; el log sin ANSI pasa siempre por redacción obligatoria de
`sk-ant-*` y el secreto se escribe SOLO en `userOauthTokenPath(user)`, nunca en
estado/log. Corre con HOME DESCARTABLE
`~/.cwc-data/sponsor-token-jobs/<user>.home` mode 0700 y lo borra al terminar,
fallar, cancelar o vencer el timeout: para el HOST el HOME real es `~` y
`claude setup-token` podría tocar `~/.claude/.credentials.json`, la credencial
VIVA de toda la consola; el scratch impide rozarla sin alterar el token, que
depende de la cuenta autorizada en el navegador y no del HOME. Publica
`starting` → `awaiting-code` (`url` y `note` a los 20 s) → `exchanging` →
`done|error`; timeout duro de 10 min y limpieza en SIGTERM/SIGINT. El parseo
del PTY (`cols:1000`, Enter diferido 300 ms, `stripAnsi`, `outputNote()`) está
DUPLICADO a propósito con `cwc-onboard-runner.js`: cualquier cambio debe
actualizar ambos.
### bin/cwc-tolkien-setup-runner.js  PREPARACIÓN DESACOPLADA del clon Tolkien de
un inquilino: configura en SU `.npmrc` el store compartido
`/home/nmosquera/.cwc-shared/pnpm-store` sin pisar otras claves, corre
`pnpm install --frozen-lockfile` con HOME aislado por `userRunnerEnv` y termina
con `pnpm typecheck`. El host saltea la configuración del store y conserva el
suyo. Estado atómico, reanudable por pasos (`store`/`install`/`typecheck`) en
`~/.cwc-data/tolkien-setup/<user>.json`; log completo redactado en
`<user>.log`; ambos mode 600 y siempre en el HOME del HOST.
GOTCHAS: resuelve pnpm a ruta absoluta porque el env limpio puede no encontrarlo
(`CWC_TOLKIEN_PNPM_BIN` permite fijarla); solo reintenta una vez sin
`--frozen-lockfile` si la salida demuestra que el lockfile no coincide. El
install tiene timeout duro de 20 min, configurable con
`CWC_TOLKIEN_INSTALL_TIMEOUT_MS`. SIGTERM/SIGINT matan el grupo de pnpm y dejan
estado `error` persistido. Uso:
`node bin/cwc-tolkien-setup-runner.js --user <username>`.
### bin/cwc-tolkien.js  runner CLI DESACOPLADO que opera la app web de Tolkien con
Chromium headless y la sesión real guardada en
`<dataDir>/tolkien/session.json`, con `<dataDir>` resuelto por `resolveDataDir()`
(honra `CWC_DATA_DIR`), de modo que un inquilino nunca lea la sesión del host —
Familia B, `console:BUG-2472`. `login`, `whoami`, `census` y `reconcile`
son SOLO LECTURA; `close` y `reassign` son los únicos subcomandos que escriben. `census` abre la
vista `/tickets?view=active&focus=mine`, visita los detalles y genera
`census.json` con los tickets asignados al usuario y todos sus campos de cierre,
con parcial reanudable en `census.partial.jsonl`. `reconcile` cruza el censo
contra Zoho Desk por el MCP hosted de Tolkien —token `TOLKIEN_MCP_TOKEN` del
`.env`, JSON-RPC con handshake y `mcp-session-id`— y escribe `reconcile.json`
con cuatro pilas, `closable`, `realOpen`, `reassigned` y `unpaired`. Antes de
clasificar resuelve `viewerEmail` del censo contra el directorio de agentes de
Zoho y compara `assigneeId`: un ticket abierto que ya no está asignado al usuario
cae en `reassigned`; si falta el email, el directorio está vacío o no hay agente
coincidente, falla cerrado y pide repetir `census`. El directorio vacío ahora es
fatal: sin él no se puede verificar ni resolver ningún assignee. El cierre tiene precedencia:
un ticket resuelto en Zoho sigue en `closable` aunque esté asignado a otra persona.
`desk_list_agents` tiene un tope verificado de 100: pedir 500 devolvió vacío y
causó un bug real. `deskListAgents()` usa páginas de 100, prueba `from`, `offset`
y `page`, acumula hasta 20 páginas sin descartar las ya válidas ante un fallo y
conserva el mismo `Map` cacheado por cliente.
La clasificación es CONSERVADORA: sin par exacto, con par ambiguo, cerrado sin fecha de cierre o
cerrado como cancelado/duplicado cae en `unpaired` y queda para revisión humana,
nunca en `closable`. `close` cierra en masa la pila `closable` completando los
formularios reales de la pestaña `?tab=estado`: primero `setWorkContextAction`
con `mode=working` si falta el resultado esperado y después `closeTicketAction`
con `verificationKind=objective_check` y evidencia derivada del dato real del
ticket de Zoho; saltea los que están en espera estructurada, lee el parámetro
`?error=` de la URL resultante porque Tolkien rechaza redirigiendo en vez de
lanzar excepción, y re-verifica releyendo el ticket porque la ausencia de error
no prueba que el paso funcionó. `--dry-run` es el default y escribir exige
`--apply`; hay un tope de 50 por lote salvo `--confirm-large`, re-verificación
contra Zoho inmediatamente antes de cada escritura, reanudabilidad por
observación del estado real de la página y log JSONL con el estado antes y
después de cada escritura en `<dataDir>/tolkien/ops/`. El directorio queda
0700 y los archivos 0600. `reassign` consume EXCLUSIVAMENTE la pila
`reassigned` y resuelve el dueño en dos saltos: `zoho.assigneeId` al agente del
directorio y su email a una opción del `select[name="assignedToUserId"]` del DOM
vivo. La comparación es email exacto con trim/case-fold; jamás por nombre. Salta
cerrado con `sin_asignado_en_zoho`, `agente_zoho_desconocido`,
`agente_sin_email`, `sin_usuario_en_tolkien`, `usuario_ambiguo_en_tolkien` o
`ya_es_del_usuario`. Si el 100 % de los candidatos resulta
`agente_zoho_desconocido`, el CLI aborta antes del resumen o de cualquier
escritura: ese patrón señala un fallo de infraestructura al cargar el directorio,
no datos reales de los tickets. Una proporción menor se informa con una
advertencia de directorio posiblemente incompleto. Antes de cada submit relee el dueño actual de Zoho, localiza
el formulario vivo por ese select y lee `?error=`. La re-verificación NO usa el
valor del select: tras el submit Tolkien lo devuelve al placeholder vacío y eso
produjo falsos negativos en la corrida real del 2026-08-02. En cambio extrae el
nombre desde `Taken by <Nombre> ·` del bloque visible de ownership y lo compara
normalizado —sin acentos, mayúsculas ni diferencias de espaciado— con el
destinatario; un UUID esperado que sí permanezca visible también confirma la
operación. La navegación de cada detalle usa 60 s y un único reintento ante
timeout, con 2 s de espera. Antes de escribir, si el bloque ya muestra al
destinatario, registra `skipped`/`ya_reasignado` sin submit y lo cuenta aparte
como «N ya estaban reasignados»: así el mismo `reconcile.json` se puede re-correr
de forma idempotente después de un lote parcial. Falta de error sin cambio
confirmado cuenta como `reassign_unverified`, con detalle explícito si el dueño
sigue siendo el anterior.
También es dry-run por default, exige `--apply`, comparte el tope 50 y deja su
propio `ops/reassign-<ts>-<pid>.jsonl` con antes/después y espejo SQLite
best-effort. Desde `console:PLAN-2521` el estado de trabajo vive además en una base local SQLite `<dataDir>/tolkien/state.db`, con `dbFile` resuelto por invocación dentro de `tolkienPaths()` como el resto de las rutas. El motor es `node:sqlite` nativo (Node 24), sin dependencias nuevas. Los JSON NO se reemplazan ni se borran: siguen escribiéndose igual y son el artefacto de salida de cada corrida —`close --reconcile <ruta>` y `reassign --reconcile <ruta>` los siguen consumiendo—, mientras que la base acumula lo que el JSON no puede, que es el HISTORIAL entre corridas y la escritura concurrente. El espejo a la base es BEST-EFFORT por diseño: `withStore()` atrapa cualquier fallo, lo avisa por stderr y devuelve null, de modo que una base rota jamás tumba una corrida cuyo JSON ya se escribió. El subcomando nuevo `db` consulta y migra: `--stats` (default), `--migrate` (importa census.json, reconcile.json y ops/*.jsonl una sola vez, idempotente por la clave `meta.json_import_done`, y NUNCA borra ni mueve los JSON), `--force`, `--runs <n>` y `--bucket <closable|realOpen|reassigned|unpaired>`. No usa el SDK: consume 0 tokens y la regla 6 no
aplica.
Desde `console:PLAN-2532` el `census` corre en PARALELO por defecto: N workers (`bin/cwc-tolkien-worker.js`), cada uno con su Chromium, coordinados por la tabla `scan_queue` de la base. `--workers <n>` (1..12) fija la cantidad y `--workers 1` cae al camino secuencial de siempre, intacto; sin el flag se calcula con `max(1, min(6, cores/2, MemAvailable/1200 MB))` — la memoria se lee de `/proc/meminfo`, NO de `os.freemem()`, que en Linux devuelve MemFree e ignora el page cache reclamable (subestimaría por 10×). El tope duro de 6 no es técnico sino de CORTESÍA: del otro lado está la app de producción de Chris. El supervisor mantiene población —en cada tick, si hay trabajo RECLAMABLE (`pending + retryable`, nunca `running`, que ya tiene dueño vivo) y faltan workers, arranca los que falten, con presupuesto `max(8, workers × 3)`—; si no queda ningún worker vivo pero hay tickets en `running` de workers muertos, ESPERA el rescate por heartbeat en vez de rendirse: ese es exactamente el caso «murieron 3 de 8» y rendirse ahí perdía tickets (medido). En el camino paralelo la base deja de ser best-effort: es el transporte entre procesos, y si no abre, la corrida falla ofreciendo `--workers 1`. Un ticket que ningún worker llegó a leer NO desaparece: entra al `census.json` como registro de error con el motivo tomado de la cola, más una línea `ATENCIÓN: N tickets quedaron sin leer` — el `filter(Boolean)` ingenuo habría entregado 68 tickets con cara de 71. Medición real (71 tickets): 363 s secuencial → 260 s con 4 workers, apenas 1,40× — el cuello de botella es el servidor de Tolkien, no esta máquina (86 % de CPU local ociosa durante toda la corrida); no gastes otra iteración subiendo workers.
### bin/cwc-tolkien-store.js  MÓDULO (no CLI, sin shebang ni main) del store local
SQLite del runner de Tolkien, `console:PLAN-2521`. Motor `node:sqlite` nativo: cero
dependencias, decisión tomada tras verificar Node v24.18.0 en la máquina. Siete tablas —
`meta`, `runs`, `tickets` (último estado por `ticketWorkflowId`, con `raw_json` sin pérdida
para que un campo nuevo de Tolkien sobreviva aunque no tenga columna), `ticket_observations`
(una fila por ticket×corrida, el historial que el JSON no guarda), `reconcile` (pila y motivo
por ticket y corrida), `ops` (log de cada escritura con antes/después/quién/cuándo/resultado) y
`schema_snapshot` (para que el canario de `console:PLAN-2523` compare estructura entre corridas;
`recordSchemaSnapshot` devuelve `changed` comparando el fingerprint contra el snapshot anterior
del mismo `source`). CONCURRENCIA, que es su razón de ser porque el escaneo paralelo escribe
desde varios workers: `journal_mode=WAL` (N lectores + 1 escritor sin bloqueo mutuo),
`busy_timeout=15000`, transacciones `BEGIN IMMEDIATE` cortas —toma el lock al abrir, así el
conflicto aparece antes de hacer trabajo y no a mitad— y `withWrite()`, que reintenta ante
SQLITE_BUSY/LOCKED con backoff exponencial más jitter, esperando con `Atomics.wait` en vez de
quemar CPU. Un error que NO es de lock se relanza sin reintentar. Cada lote va en UNA
transacción, no una por fila. `migrateFromJson()` es idempotente y TOLERANTE: un archivo
ilegible o una línea corrupta se cuenta en `errors[]` y no aborta el resto. La ruta de la base
la recibe SIEMPRE por parámetro; el módulo no resuelve rutas por su cuenta ni tiene constantes
de ruta a nivel de módulo (`console:BUG-2185`, `console:BUG-2472`). Directorio 0700, archivo y
sidecars `-wal`/`-shm` 0600. Verificado con 8 procesos hijo REALES escribiendo en paralelo:
400 ops, 200 tickets, 400 ids únicos, `integrity_check=ok`. Su test es
`bin/cwc-test-tolkien-store.js`.
Octava tabla: `scan_queue` (una fila por ticket × corrida: `listed_json`, `status` pending/running/done/failed, `attempts`, worker, `heartbeat_at`, `error`), la cola del escaneo paralelo. Su primitiva central es `claimScanTarget()`, que hace el rescate de vencidos, la elección del candidato y su marcado como `running` dentro de la MISMA transacción `BEGIN IMMEDIATE`: leer afuera y escribir adentro es exactamente cómo dos workers se llevan el mismo ticket. Acompañan `enqueueScanTargets` (idempotente), `heartbeatScanTarget`, `finishScanTarget`, `reclaimStaleScanTargets`, `scanQueueCounts` (incluye `retryable` = fallidos con intentos por debajo del tope), `scanQueueRows` y `runTickets`. Sumados `latestRun`/`latestRunUid`/`getRun`: existen para que un consumidor tome «la corrida más reciente» sin escribir el SELECT a mano — toda consulta a `scan_queue`, `ticket_observations`, `reconcile` y `ops` filtra por `run_uid`, porque sin ese filtro los conteos se suman entre corridas (se llegó a leer `realOpen: 67` cuando eran 63). `busy_timeout` se fija ANTES de `journal_mode = WAL`: con varios procesos abriendo la base al mismo tiempo, el cambio de journal puede encontrar el lock tomado y sin timeout previo falla en el acto. `store_schema_version` sigue en `'1'` a propósito (la tabla nueva es aditiva y `cwc-test-tolkien-store.js` la verifica, ahora esperando 8 tablas).
### bin/cwc-test-tolkien-store.js  test funcional determinista y AISLADO de
`cwc-tolkien-store.js` (patrón `cwc-test-chat-trash.js`). No usa el SDK, 0 tokens, y trabaja
siempre sobre un `mkdtemp` que borra en `finally`: JAMÁS toca `~/.cwc-data`. Siete grupos
T1..T7 — esquema y WAL · upsert sin duplicar con `first_seen_run` preservado · pilas del
reconcile · ops con round-trip de JSON · fingerprint de snapshots · migración idempotente que
deja los JSON en disco · y T7, CONCURRENCIA REAL con 8 procesos hijo de verdad (no simulada),
que es el grupo que habilita el escaneo paralelo. Uso:
`node bin/cwc-test-tolkien-store.js`; termina con `N pass / M fail` + exit code.
### bin/cwc-test-tolkien-reconcile.js  test funcional determinista y AISLADO de
la clasificación del cruce Tolkien ↔ Zoho. Importa las funciones puras exportadas por
`cwc-tolkien.js`, usa tickets falsos y un `getAgents` mockeado: no abre Chromium, no usa red,
SDK ni `~/.cwc-data`, y consume 0 tokens. Cubre `realOpen`, `reassigned` conocido y sin
asignado, la precedencia de `closable`, los dos descartes cerrados que siguen en `unpaired`,
el snapshot aditivo con `assigneeId` y la comparación de ids por string. Uso:
`node bin/cwc-test-tolkien-reconcile.js`; termina con `N pass / M fail` + exit code.
### bin/cwc-test-tolkien-reassign.js  test funcional determinista y AISLADO de
la resolución y verificación del destinatario de `reassign`. Importa las funciones puras
`resolveReassignTarget()`, `extractReassignAssigneeName()`,
`verifyReassignState()` y `reassignSubmissionDecision()` de `cwc-tolkien.js`, usa un `Map` de agentes y opciones
de select sintéticas: sin SDK, red, Chromium ni `~/.cwc-data`, 0 tokens. Cubre
email único, el caso Hincapié con dos nombres parecidos, email duplicado, usuario
ausente, asignado nulo/desconocido/sin email, destinatario igual al viewer,
normalización de mayúsculas/espacios y label sin paréntesis; además cubre la
extracción del ownership real, verificación por nombre con select vacío, señal
alternativa por UUID, dueño sin cambio, nombres sin acentos e idempotencia. Uso:
`node bin/cwc-test-tolkien-reassign.js`; termina con `N pass / M fail` + exit code.
### bin/cwc-tolkien-schema.js  observador CLI VERSIONADO y estrictamente
SOLO LECTURA de la superficie real de formularios de Tolkien
(`console:PLAN-2520`). `scan --auto` toma las tres muestras obligatorias de
`<dataDir>/tolkien/reconcile.json`, sondea por GET primero las colas activas
`focus=overdue` y `focus=unowned`, después las ocho `view=active&actor=*`
reales (excepto `all`), `view=attention` y su foco `in_progress`, y por último
resolved/waiting/in_progress/all, tomando hasta 100 filas por cola, con tope de
250 candidatos únicos y corte al cubrir las cuatro ramas del gate de cierre; recorre
por default `overview,estado,chat,work,dev,reporte`. También
acepta `--tickets <uuid|WORK-n|URL,...>`, `--tabs`, `--session` y `--out`.
Extrae del DOM los server actions, constraints, labels y opciones, fusiona
formularios por firma y une variantes por ticket; después colapsa como global
(`tab: "*"`) un mismo actionId + conjunto de campos visto en varias pestañas,
normaliza `observedOn` al workKey conocido y detecta vocabularios de opciones
distintos para un mismo nombre de campo en `notes`. El esquema registra
`probeSources: [{filter, found, newUnique}]`; `show [--out]` imprime ese aporte
por cola, las estadísticas, el gate observado por ticket, los huecos y esas
notas. Si `available` no aparece, su gap separa una `unverifiedHint` tomada del
código local y marcada explícitamente como no observada en el DOM. Escribe atómicamente
`<dataDir>/tolkien/schema.json` y, durante cada corrida limpia, reinicia y
agrega una línea por ticket×tab a
`<dataDir>/tolkien/schema-partial.jsonl`. Nunca hace submit ni click, y sólo
navega a URLs GET: no puede mutar tickets. La lógica de sesión/navegación está
copiada de `cwc-tolkien.js` porque B7 lo editaba en paralelo; queda la deuda de
unificar ambos en un helper compartido (`console:PLAN-2520`). El gate
`available` se pudo observar mediante una escritura MANUAL, puntual y
autorizada sobre WORK-307, ejecutada FUERA del runner
(`console:PLAN-2520`); el runner sigue siendo sólo lectura.
### bin/cwc-tolkien-canary.js  CANARIO DE ESTRUCTURA que corre ANTES de cualquier
escritura a Tolkien (`console:PLAN-2533`). No usa el SDK: 0 tokens, la regla 6 no aplica; y es SOLO LECTURA sobre Tolkien porque toda su observación la delega a `cwc-tolkien-schema.js scan`, invocado como CLI hijo —nunca importado— para no duplicar el observador. Existe porque la divergencia YA OCURRIÓ y está medida: el campo `nextActorKind` declara 10 opciones en el código clonado y la instancia viva sirve 11 (suma `scheduled_time`); confiar en el código habría mandado un vocabulario viejo y fallado sin decir por qué. Su núcleo es el contrato de dependencia, una constante del módulo extraída LEYENDO `cwc-tolkien.js` (no lo importa, para no acoplarse a un archivo que otra sesión edita): `submitDesiredOutcome()` localiza su formulario con `select[name="mode"]` y manda `textarea[name="desiredOutcome"]` + `mode='working'` + `nextActorKind`; `submitClose()` lo localiza con `select[name="verificationKind"]` y manda `verificationKind='objective_check'` + `textarea[name="evidenceSummary"]`; `inspectTicketState()` reconoce un ticket cerrado por la AUSENCIA de `verificationKind`. Esa lista es la que decide qué frena y qué solo avisa, y la pregunta que traza la línea es objetiva: ¿el motor toca ese elemento? BLOQUEA (exit 20) que desaparezca un formulario o un campo del contrato, que un campo cambie de tag/type, que se retire una opción que el motor manda literal, o que aparezca un campo REQUIRED nuevo que el motor no llena —el submit fallaría en silencio—. AVISA sin frenar (exit 10) una opción nueva, un campo nuevo no obligatorio o un formulario inédito fuera del contrato. Exit 0 si todo coincide, 1 ante fallo operativo (sesión vencida ⇒ `reason:'session-expired'`) y 2 por uso incorrecto; `show` hereda el código del veredicto guardado, así que la skill puede releer el último reporte sin re-escanear. El contrato de `work-context` es gate-aware: solo aplica con gate `missing_outcome`, porque el motor únicamente submitea ese formulario cuando el ticket no tiene `desiredOutcome` y el `textarea` solo se renderiza en ese estado —con gate `available` el mismo campo es `input hidden`, y como `schema.json` fusiona las variantes de todos los tickets muestreados, compararlo contra la unión daba un bloqueo FALSO—. La muestra por defecto son 3 tickets × la pestaña `estado`: los DOS primeros de `reconcile.closable` más el ticket cerrado del baseline; cuesta ~6 s de Chromium contra los minutos de un `scan --auto`. Un ticket que vuelve con CERO formularios NO es un cambio de estructura sino una observación fallida (`console:BUG-2555`, carrera de hidratación del observador): se reintenta la muestra completa una vez y si persiste el elemento queda `unverified`, nunca bloqueado; `--require work-context,close-form` es la palanca para escalar esa falta de cobertura a bloqueo justo antes de un cierre en masa, y el orquestador la dejó como OBLIGACIÓN para la skill `tkt` antes de todo `--apply` (`console:PLAN-2534`). AISLAMIENTO, que no es cosmético: el hijo se lanza con `CWC_DATA_DIR` apuntando a un scratch propio bajo `<dataDir>/tolkien/canary/scratch-<pid>` con COPIAS de `session.json`, `census.json` y `reconcile.json`, porque `scan` reinicia `<dataDir>/tolkien/schema-partial.jsonl` en cada corrida y esa ruta la resuelve `tolkienPaths()`, NO `--out` — sin el scratch el canario le borraría el rastro de reanudación a un escaneo completo en curso. El scratch va bajo `~/.cwc-data` y no en `/tmp` porque `writeFileAtomic` renombra desde un temporal vecino y cruzar sistemas de archivos daría EXDEV; se borra en un `finally` y, como ese `finally` no corre ante SIGKILL y adentro hay una copia de la cookie de sesión, al arrancar barre los `scratch-<pid>` cuyo proceso ya murió. Escribe únicamente en su propio subdirectorio `canary/`: `last-check.json` (atómico, 0600) e `history.jsonl`, y espeja el snapshot en `state.db` con `source:'canary'` de forma best-effort. Lo que se fingerprintea NO es el escaneo entero sino la proyección canónica del contrato, para que el `changed` de `recordSchemaSnapshot` signifique «cambió la estructura que nos importa» y no «corrió el canario de nuevo». Verificado contra Tolkien vivo en cuatro escenarios (ok/0, info/10 por opción nueva, block/20 por opción que el motor manda y no existe, block/20 por cobertura perdida con `--require`). Su test es `bin/cwc-test-tolkien-canary.js`.
### bin/cwc-test-tolkien-canary.js  test funcional determinista y AISLADO de
`cwc-tolkien-canary.js` (patrón `cwc-test-tolkien-store.js`). No usa el SDK, ni red, ni Chromium, ni `~/.cwc-data`: 17 casos T1..T17 sobre las funciones puras exportadas (`evaluateContract`, `pickSample`, `verdictExitCode`) con esquemas sintéticos que replican la forma real, más T17, que arma un `canaryDir` en un `mkdtemp` y comprueba que el barrido de scratch huérfanos borre el del PID muerto, conserve el del PID vivo y no toque una entrada que no matchea el patrón. Cubre los tres veredictos, los cinco tipos de hallazgo bloqueante, la escalada por `--require`, la observación fallida y la selección de muestra. Uso: `node bin/cwc-test-tolkien-canary.js`; termina con `N pass / M fail` + exit code.
### bin/cwc-tolkien-worker.js  UN worker del censo PARALELO de Tolkien
(`console:PLAN-2532`). Toma tickets de la tabla `scan_queue` de `state.db`, los lee con su PROPIO Chromium y persiste en la base; no escribe ningún JSON — el orquestador (`cwc-tolkien.js census`) es el único dueño de `census.json` y `census.partial.jsonl`, porque varios procesos apendando al mismo `.jsonl` es justo la carrera que la base ya resuelve bien. Argumentos: `--run <runUid>` (obligatorio), `--worker-id <id>`, `--max-attempts <n>` (default 3). Reclama de a un ticket con `claimScanTarget`, scrapea con `scrapeWithRetry` importado del CLI, hace `upsertTickets` y cierra la fila como `done` o `failed`. Latea cada 15 s sobre el ticket vigente: un scrape legítimo puede tardar más de un minuto y sin ese latido el orquestador lo daría por muerto. Códigos de salida con significado: 0 cola drenada o cierre por señal · 1 error fatal · 2 sesión de Tolkien inválida, que el orquestador trata como fatal y mata al resto (si la cookie venció, ningún worker va a poder) · 3 no se pudo abrir la base. Ante SIGTERM/SIGINT o error devuelve su ticket a `pending` antes de morir, así nada queda trabado esperando el vencimiento del heartbeat. No escribe en `ops`: esa tabla es el audit de las ESCRITURAS a Tolkien (el subcomando `close`) y meterle 71 filas de lectura por corrida ensuciaría el único registro que responde «¿qué tocamos y cuándo?».
### bin/cwc-test-tolkien-workers.js  test funcional determinista y AISLADO de la cola
paralela (patrón `cwc-test-tolkien-store.js`): `mkdtemp` borrado en `finally`, sin Chromium, sin SDK, 0 tokens, JAMÁS toca `~/.cwc-data`. Cinco grupos: T1 enqueue idempotente · T2 concurrencia real con 8 procesos hijo de verdad reclamando 200 targets (cada uno exactamente una vez, `integrity_check ok`) · T3 rescate de un claim vencido · T4 tope de reintentos (no gira para siempre) · T5 aislamiento por corrida, que es la regla heredada: dos `run_uid` en la misma base y los conteos de cada uno no suman los del otro. Uso: `node bin/cwc-test-tolkien-workers.js` → `21 pass / 0 fail` + exit code.
### bin/cwc-tolkien-login-runner.js  VERIFICACIÓN DESACOPLADA de la conexión
Tolkien por usuario para ⚙ Sistema → Conexiones: recibe la cookie de sesión
exclusivamente por stdin —nunca argv ni archivo intermedio—, consulta el
endpoint de sesión de Auth.js y sólo persiste después de confirmar una sesión
válida. El job administrativo y su log quedan host-owned en
`~/.cwc-data/tolkien-login-jobs/<user>.{json,log}`; el dato real va al
`userDataDir(user)`: cookie únicamente dentro de `tolkien/session.json` y
metadata sin secreto en `connections/tolkien.json`. Una verificación fallida
deja intacta la conexión anterior; si falla la metadata tras escribir el nuevo
storageState, restaura la sesión previa. Timeout duro: 120 s. No usa el SDK:
consume 0 tokens y la regla 6 no aplica.
### bin/cwc-tolkien-stack-runner.js  EJECUTOR DESACOPLADO del stack N2
Postgres+Redis propio de un usuario (console:PLAN-2264 B4). Recibe
`--user <username> --action up|down`; lee exclusivamente la identidad ya
persistida por `tolkien/stack.js` en
`~/.cwc-data/tolkien-stacks/<user>.json`, aplica los guards de proyecto/puertos
y pasa las cinco variables de aislamiento al proceso externo. Primera subida:
`scripts/onboard.sh --yes` del clon del usuario; siguientes:
`docker compose up -d postgres redis`. Bajada: `docker compose down` (sin `-v`,
conserva Postgres) SOLO después de reconciliar otra vez los claims bajo lock.
Un claim vivo o `unknown` cancela el down; no existe TTL/reaper. Estado y log
son host-owned, atómicos/0600; el comando de un inquilino usa
`userRunnerEnv`, HOME/workspace propios y nunca el entorno completo del host.
### bin/cwc-claude-login-runner.js  LOGIN COMPLETO de Claude por usuario —también
el HOST— para ⚙ Sistema → Conexiones (`console:PLAN-2446`): runner PTY de
`claude auth login --claudeai` con HOME aislado mediante `userRunnerEnv` y
cwd=`userFileRoot(user)`. NO usar `userWorkspace(user)` acá: para un inquilino
da el mismo path, pero para el host apunta a `~/workspace`, que no existe, y el
`pty.spawn` fallaría con ENOENT. Antes del spawn borra
explícitamente `CLAUDE_CODE_OAUTH_TOKEN`: si el CLI ve el setup-token se
considera ya autenticado y no ofrece el login de cuenta. Publica
estado/URL en `~/.cwc-data/claude-login-jobs/<user>.json`, recibe el código
por `<user>.code` mode 600 sin loguearlo y deja el volcado redactado en
`<user>.log`. El CLI escribe por sí mismo
`userClaudeDir(user)/.credentials.json`; el runner declara `ok` solo si ese
JSON contiene `claudeAiOauth.accessToken` y luego ejecuta best-effort
`claude auth status --json` con salida redactada. Red de seguridad de
`console:BUG-2438`: justo antes del spawn copia la credencial previa a
`<user>.credentials.bak` mode 600 y, ante fallo de spawn, credencial nueva
inválida, cancelación/SIGTERM, excepción procesando el PTY o timeout, la
restaura y borra el backup; tras éxito también lo borra. Así un login
interrumpido no puede dejar `.credentials.json` vacía: el peor caso es quedar
como antes. Timeout duro: 10 min.
### bin/cwc-claude-token-refresh.js  CLI de diagnóstico/renovación del OAuth de Claude por
usuario. Usa `core/claude-oauth.js`; sin argumento opera sobre el host y con
`<userId>` sobre ese inquilino. Imprime únicamente owner/estado/refreshed/
vencimiento/suscripción, nunca el token ni otra credencial. Si no hay
credenciales o el refresh token venció, explica el motivo probable y sale 1.
Uso: `node bin/cwc-claude-token-refresh.js [userId]`.
### bin/cwc-codex-login-runner.js  LOGIN GUIADO de Codex por usuario para onboarding y ⚙ Sistema
→ Conexiones: runner PTY de `codex login --device-auth` (el login normal
abre callback en localhost:1455, inservible desde un navegador contra un
server remoto), con HOME aislado del dueño mediante `userRunnerEnv`.
Publica URL/código/estado en
`~/.cwc-data/codex-login-jobs/<user>.json`; ese job vive en el HOME del
HOST — no en el HOME aislado — porque lo spawnea y consulta el server.
Declara éxito SOLO si la credencial CAMBIA respecto al baseline tomado antes
del spawn (`codexCredState` de `core/user-space.js`, por `lastRefresh` o
`mtimeMs`), NUNCA por la mera existencia de `.codex/auth.json`: una credencial
vencida en disco hacía que el runner se auto-declarara `done` en su primer tick
y matara el login antes de la autorización. La cancelación se detecta leyendo
el estado `cancelled` del job y corta el PTY. Timeout duro: 15 min.
El cwd se resuelve con `userFileRoot(USER)`, NUNCA con `userWorkspace(USER)`
(mismo gotcha que `cwc-claude-login-runner.js`): para un inquilino dan el mismo
path, pero para el HOST `userWorkspace` apunta a `~/workspace`, que
`ensureUserSpace` no crea porque el host usa su HOME real. El PTY moría en el
`chdir` con exitCode 1 antes de imprimir la URL, y el job quedaba con el
mensaje genérico «terminó sin renovar la credencial», que ESCONDÍA la causa
(`console:BUG-2747`). Por eso ahora, cuando el CLI muere sin haber emitido
nunca la URL, el error incluye las últimas tres líneas reales de la salida del
PTY y el código de salida; esa rama corre solo con `currentUrl === null`, o sea
antes de que exista el código de un solo uso, así que no puede filtrarlo.
### bin/cwc-gh-login-runner.js  LOGIN GUIADO de GitHub por usuario durante
onboarding: corre `gh auth login --hostname github.com --git-protocol https
--web` SIN PTY, con stdin ignorado y stdout/stderr por pipe, usando
`userRunnerEnv(user)` y HOME/workspace aislados. Es deliberado y
contraintuitivo: con TTY, `gh` entra en modo interactivo, pregunta `Authenticate
Git with your GitHub credentials?` antes del device code y NO lee la respuesta
del PTY (probado con `y`, Enter diferido, varias secuencias y
`--insecure-storage`), por lo que el login queda colgado para siempre en
`starting`. Sin TTY emite directamente el código y la URL por stderr y espera la
aprobación; por eso el runner lee stdout Y stderr, ya que leer solo stdout vuelve
invisible el código. Publica la URL fija `https://github.com/login/device`, el
código de un solo uso, estado y `pid` en
`~/.cwc-data/gh-login-jobs/<user>.json`; toda escritura es atómica y mode 600.
El log `<user>.log` también es mode 600 y TODA salida pasa por redacción de
`gh[pousr]_*` y `github_pat_*`. El éxito se confirma con `gh auth status` en el
mismo HOME y después corre obligatoriamente `gh auth setup-git` para dejar
operativo el push HTTPS. `GH_BROWSER=true` evita intentar abrir un navegador en
el server: el usuario aprueba desde el wizard. Timeout duro: 15 min.
Igual que los runners de login de Claude y Codex, el cwd sale de
`userFileRoot(USER)` y NUNCA de `userWorkspace(USER)`: para el host esa ruta
(`~/workspace`) no existe y tanto el spawn de `gh` como el `spawnSync` de
`gh auth status` fallan en el `chdir` sin decir por qué (`console:BUG-2747`).
### bin/cwc-pad-login-runner.js  LOGIN GUIADO del Pad LOCAL por usuario para ⚙
Sistema → Conexiones (`console:PLAN-2446`), modelado sobre
`cwc-claude-login-runner.js`: abre un PTY con `~/.local/bin/pad auth login`,
HOME aislado mediante `userRunnerEnv` y cwd=`userFileRoot(user)`, y publica
solo estado + la primera URL capturada con una regex HTTP(S) genérica en
`~/.cwc-data/pad-login-jobs/<user>.json`. Antes del spawn resguarda la
credencial actual: `~/.pad/credentials.json` para el host o
`userPadDir(user)/credentials.json` para un inquilino; ante fallo, cancelación,
señal o timeout restaura ese backup (o el estado previo sin credencial) y al
terminar siempre elimina la copia temporal. El flujo browser-based tiene una
degradación HONESTA: no está verificado que el CLI imprima la URL si el server
no tiene navegador; si en 90 s no apareció ninguna, mata el PTY y publica un
error explícito que explica que puede requerir un navegador local, en vez de
dejar el panel colgado. El éxito se decide exclusivamente por exit 0 de
`pad auth whoami`; su salida se ignora y nunca se loguea. Timeout global: 10
min.
### bin/_env-boot.js           bootstrap explícito del `.env` del REPO para runners cuyo
`cwd` está fuera del repo. Resuelve el fallo de `core/config.js` en procesos de
INQUILINO spawneados con `userRunnerEnv`: `dotenv/config` buscaría el `.env`
contra el workspace y abortaría por falta de `CWC_TOKEN`. También expone
`scrubEnvSecrets()`, que no corre al importar y permite retirar del entorno los
secretos del host después de que config los capturó. REGLA: debe ser el PRIMER
import de cualquier runner que use `userRunnerEnv` y cuya cadena de imports
arrastre `core/config.js`.
### bin/cwc-chat-runner.js      motor de UNA conversación (proceso propio, socket Unix).
En salas de Aduana registra además el MCP in-process `sala` (PLAN-3368): sus
cuatro tools coordinan madre e hijas y delegan toda autoridad al server mediante
eventos `sala-op`; el server responde al runner con `sala-op-result` por reqId.
GOTCHA multi-tenant: `_env-boot.js` debe ser su PRIMER import. Sin él, el chat
de un inquilino muere al arrancar con
`[config] Falta la variable obligatoria CWC_TOKEN en el .env`; el host no lo
detecta porque su runner hereda el env completo del server.
MCPs in-process: `codex` se carga en modo Tándem, `unifi` en la consola, `pad`
en Aduana y `microsoft` sólo si el dueño tiene Microsoft conectado y el chat NO
es una sala de Aduana.
RADAR TÁNDEM (BUG-1959): `bgWork` distingue trabajo VIVO de resultado Codex
LISTO para recoger. `sweepCodexBg()` cruza cada entrada `kind==='Codex'` con
`readCodexJob(id)` del store `~/.cwc-data/codex-jobs/`; si el job está
`done|error`, NO borra la entrada: la reclasifica con `ready:true`,
`readyAt` y `outcome`. GOTCHA crítico: `bgWork` es memoria DEL RUNNER y
`bgDone(id)` solo ocurre al recoger ESE id con `collect_codex`; si el agente
nunca recogía el id concreto, la entrada quedaba viva aunque el proceso ya
hubiera terminado y sobrevivía incluso a `systemctl restart` del server porque
`KillMode=process` preserva el runner (regla dura 2). Por eso `bgHolds()` usa
`bgLiveCount()` y un resultado listo ya no retiene despierto el motor;
`warnBgKilled()` excluye los `ready` para no decir que siguen corriendo.
El sweep Codex corre junto a `sweepBgFromTranscript()` en AMBOS puntos:
intervalo de 20 s y chequeo de auto-siesta.
`console:BUG-2185` (2026-07-28): `reconcileSessionArgs()` corre justo antes de `startEngine()` y corrige
`--session-id`↔`--resume` mirando el transcript en el `os.homedir()` de ESTE proceso — que en multi-tenant
es el del DUEÑO, no el del server. El runner es la autoridad de esa decisión porque es el único que corre
con el HOME correcto. Por eso `RESUME`/`SESSION_ID` son `let`. Además `pump()` es ahora un bucle que
reintenta UNA vez con el modo opuesto si el CLI rechaza el id al arrancar (`already in use` /
`No conversation found`) y `sawInit` sigue en false, reponiendo el mensaje del usuario si hiciera falta: un chat no puede volver a quedar muerto para siempre por esta clase de error.
### bin/cwc-indice-runner.js    destilador IA DESACOPLADO del Índice navegable de
una conversación. Corre una sola query de TEXTO PURO: la transcripción ya
condensada viaja en el prompt y `textOnlyQuery` aplica la doble capa read-only
de la Regla 6 (`settingSources: []` + hook `PreToolUse` que deniega +
`canUseTool` que deniega), por lo que dispone de CERO herramientas. Es
INCREMENTAL: el estado en `<userDataDir>/chat-indices/<chatId>.json` conserva
`upToEvent` y la corrida siguiente destila únicamente el tramo contiguo nuevo,
fusionando sus momentos con los anteriores. El lock vive separado, reserva con
`O_EXCL`, valida que el PID siga vivo y exige heartbeat fresco; un token de
propiedad evita que dos servers solapados refresquen o liberen el lock ajeno.
El server lo encola desde `case 'result'` de `chat/index.js`, después de unas
10 respuestas del agente, y nunca espera la query dentro de la latencia del
turno. Snapshot, estado, lock, prompt, parseo y spawn compartidos viven en
`src/modules/chat/indice-shared.js`. En multi-tenant resuelve el data-dir del
DUEÑO y falla cerrado si el inquilino no tiene credencial Claude propia: jamás
cae a la credencial del server.
### bin/cwc-test-chat-trash.js  test funcional determinista y AISLADO de
`src/modules/chat/trash.js`. No usa SDK ni consume tokens; apunta
`CWC_HOME`/`HOME`/`CWC_DATA_DIR` a un `mkdtemp` que borra en `finally`, por lo
que no toca la papelera real. Imprime 35 aserciones agrupadas T1..T6: copia del
transcript · reparación perezosa · idempotencia · purga a los 30 días ·
restaurar · purga manual y multiusuario. Uso:
`node bin/cwc-test-chat-trash.js`; termina con `N pass / M fail` + exit code.
### bin/cwc-codex-runner.js     ejecutor DESACOPLADO de UNA delegación Tándem a Codex
(`--job <id>`). Es config-free: no importa `core/config.js` y resuelve el
directorio multi-tenant desde `CWC_DATA_DIR`/HOME. Al pasar a `running`
persiste `pid` y actualiza el heartbeat cada 15 s. Los estados terminales son
`done|error|killed|orphaned` y todos entran en la poda de 24 h. Los handlers
de `SIGTERM`/`SIGINT` escriben `killed` antes de salir; `SIGKILL` y un crash
del host no son interceptables. El cierre real está en el reaper puro de
`codex-shared.js`: cada lectura convierte atómicamente un `running` cuyo pid
murió o cuyo heartbeat superó 3 intervalos (45 s) en `orphaned`, con motivo
y `finishedAt`, nunca en un falso `done`.
Al recibir `thread.started` de Codex, el runner persiste inmediatamente el
`threadId` en el job mediante el callback `onThread` de `runCodex()`; antes
quedaba guardado recién al terminar. Es imprescindible para que un rollout
VIVO se pueda ligar a su delegación mientras todavía está corriendo.
Cuando el job trae `files` declarados y NO es `fullAccess`, el runner ejecuta
Codex dentro de un git worktree aislado, sembrado con el estado sucio del árbol
real. Al terminar aplica de vuelta SOLO los archivos declarados mediante
`git apply`, con reintento `-3` precedido siempre por `--check`. Un conflicto NO
se pisa: el job termina `done` con `isError:true`, el reporte nombra el conflicto
y el worktree se CONSERVA porque es la única copia del trabajo. Si el worktree
no se pudo crear o sembrar, degrada al camino histórico y lo explicita en el
reporte. Sin `files`, el comportamiento es idéntico al histórico.
### bin/cwc-pageout.c + bin/cwc-pageout-build.sh    helper nativo de la CAPA 5
de swap. `cwc-pageout <pid> [--cold]` selecciona únicamente mapeos privados
anónimos y `[heap]` del proceso, valida antes que el PID pertenezca al UID
actual y aplica `process_madvise` en tandas de hasta 1024 rangos con
`MADV_PAGEOUT` (o `MADV_COLD`). El build script lo compila con gcc y solo
IMPRIME el `sudo setcap cap_sys_nice+ep` que debe ejecutarse una vez: sin
`CAP_SYS_NICE`, el kernel responde `EPERM` al aconsejar otro proceso.
### bin/cwc-pageout-runner.js    barrido DESACOPLADO, persistente y reanudable de
sesiones dormidas. Enumera procesos del UID actual y considera únicamente
`cwc-chat-runner.js`, binarios `claude-agent-sdk` y
`cwc-codex-runner.js`; excluye siempre `src/server.js`. Compara los ticks de
CPU entre barridos, exige el umbral de inactividad, RSS mínimo y cooldown, y
recién entonces invoca `bin/cwc-pageout`. Arranca deliberadamente en DRY-RUN:
solo actúa con `CWC_PAGEOUT_DRY_RUN=0`. Variables:
`CWC_PAGEOUT_INTERVAL_MS` (60000), `CWC_PAGEOUT_IDLE_MS` (300000),
`CWC_PAGEOUT_MIN_RSS_MB` (100) y `CWC_PAGEOUT_DRY_RUN` (distinto de `0` =
dry-run). Estado incremental en `<dataDir>/pageout.json` y lock con heartbeat
en `<dataDir>/pageout.lock`, donde `<dataDir>` sale de `resolveDataDir()`
(por defecto `~/.cwc-data`). SIGTERM/SIGINT conservan el estado y liberan el
lock; cada barrido emite una sola línea resumen a stdout. Su disparador es un
service systemd externo no versionado: `core/inventory.js` lo incluye en
`KNOWN_EXTERNAL_TRIGGERS` para que el censo no lo marque huérfano.
### bin/cwc-test-codex-worktree.js  test funcional determinista y AISLADO del
mecanismo de worktree de las delegaciones Codex (patrón
`cwc-test-tolkien-store.js`). Sin SDK, sin red y con 0 tokens, trabaja entero
sobre un `mkdtemp` con un repo git de juguete que borra en `finally`: JAMÁS toca
`~/.cwc-data` ni el repo real. Ocho grupos T1..T8: creación y limpieza del
worktree · siembra de trackeados sucios · siembra de untracked · la base queda
fijada por el commit de sembrado (`git diff HEAD` vacío) · SOLO vuelve lo
declarado, el caso central del bug · archivo nuevo declarado · conflicto
detectado y NO pisado, sin dejar marcadores · parche vacío. Además verifica
empíricamente que el worktree nace SIN `node_modules`. Uso:
`node bin/cwc-test-codex-worktree.js` → `24 pass / 0 fail` + exit code.
### bin/cwc-triage-runner.js    corrida del triage de bugs (proceso propio; interfaz por archivos).
DOS FASES EN PARALELO (optimización IA 2026-07-05): (1) query
barata que solo LISTA los [Tolkien Bug] abiertos; (2) triage de
CADA ticket en paralelo vía runAdaptivePool (health/pool.js, mismo
patrón que desk-runner), 1 query corta por ticket con escritura
INCREMENTAL a tickets.json — un timeout pierde solo ese ticket,
nunca el batch. Doble capa read-only (regla 6) en CADA query.
CACHÉ INCREMENTAL por ticket (triage-cache.json, fingerprint
status+subject del listado + TTL 12 h): sin cambios y fresco ⇒
reusa el triage anterior sin query() (0 tokens); --full la ignora
### bin/cwc-health-scan-runner.js  ORQUESTADOR del ESCANEO DE SALUD UNIFICADO (2026-07-12):
corre Revisión + Optimización + Coherencia bajo UN pool
adaptativo compartido + cross-check con Pad, en una pasada.
REUSA la lógica de los 3 motores (no la reescribe) y escribe
los mismos review/optimization/coherence.json + el overlay
health-scan.json. Lógica en src/modules/health/scan-shared.js.
Ver "Verificación de salud" (Escaneo unificado). Regla de oro +
regla 6 (cada query su allowlist read-only doble capa)
### bin/cwc-docker-hygiene-runner.js  runner config-free y desacoplado para
higiene de Docker (PLAN-2268). `--report` es el modo default, NO destructivo:
releva `docker system df`, volúmenes/imágenes dangling y proyectos Compose con
contenedores, y escribe atómicamente
`~/.cwc-data/docker-hygiene/report.json` mode 600 para el check rápido de
Salud. `--prune` SIN `--yes` solo lista lo que haría. El barrido real exige
`--prune --yes`, vuelve a leer proyectos/candidatos inmediatamente antes y
NUNCA borra un volumen cuyo nombre contenga un proyecto Compose activo; no
toca contenedores. Docker ausente/daemon inaccesible termina limpio y deja
`status: unavailable`. No automatizar el modo confirmado: lo aprueba un humano.
### bin/cwc-mirror-runner.js  ESPEJO DESACOPLADO y reanudable de Rivendell hacia
el alias SSH `mordoria-mirror` (`console:PEND-2595`, `console:PLAN-2587`). Un
ciclo one-shot recorre exactamente dos targets: `home` espeja el HOME completo,
sin una sola exclusión, con rsync
`-a -H -s --mkpath --delete --partial --compress --human-readable --stats`, y
`pad-db` corre después para sobrescribir aditivamente `.pad/pad.db` con un
snapshot consistente, sin `--delete`. Cada target
usa `-H` porque `-a` no preserva enlaces duros: sin él, los worktrees de git y
los stores de pnpm de `.cwc-users` se multiplican en destino; el primer espejo
completo midió 10 GB de exceso. `-H` tiene el costo de memoria de construir un
mapa de inodos para árboles grandes. Cada target
usa siempre `--timeout=300`: si no fluyen datos durante cinco minutos, rsync
falla y el timer puede reintentar, porque un espejo colgado se ve igual que uno
que sigue trabajando. `--bwlimit=<N>` (KiB/s) es una palanca opcional para un
enlace congestionado; sin el flag no hay límite. `--whole-file` también es
opcional y sirve solo para una puesta al día inicial con muchos archivos chicos:
dejarlo permanente rompería el ahorro del algoritmo delta en los ciclos
incrementales. Cada target
persiste `pending/running/ok/error`, métricas y progreso incremental en
`~/.cwc-data/mirror-state.json`, con lock pid/host + heartbeat en
`mirror.lock` y log rotado a 5 MB en `mirror.log`. La red de seguridad es
OBLIGATORIA para ambos targets: usa `--backup` con attic remoto diario en
`/srv/cwc-mirror-attic/<fecha>/<target>` y poda únicamente fechas de más de 14
días, sin sudo. El attic vive fuera del HOME destino porque, si
estuviera adentro, el `--delete` del target `home` lo trataría como sobrante y
lo metería dentro de sí mismo. La ruta remota va sin comillas y protegida con
`-s`: quotearla a mano la vuelve relativa al home y rompe el `mkdir`, algo que
el dry-run no detecta porque `-n` no crea directorios. Usa `--mkpath` porque
rsync no crea directorios padre intermedios en destino. `--dry-run` agrega `-n`,
no toma lock, no persiste log/estado y no poda; su única escritura es preparar
el staging local de `pad-db` bajo `/var/tmp/cwc-mirror-staging/pad/` para probar
que el snapshot es viable. El staging vive fuera del HOME origen para que el
espejo no lo copie dentro de sí mismo en cada ciclo. `--target=<name>` acota el ciclo,
`--status` solo lee y `--help` documenta el CLI. Antes de ejecutar `home`, un
guard consulta por SSH si `claude-web-console.service` está activo en el
destino, exportando `XDG_RUNTIME_DIR=/run/user/$(id -u)` para que
`systemctl --user` funcione en la sesión remota. Si responde `active`, registra
el ciclo completo como `skipped`, no ejecuta ningún target y sale con exit 3;
la unidad declara ese código como éxito. `--force` saltea deliberadamente el
guard y permite sincronizar igual, con el riesgo correspondiente. Si la
consulta falla por SSH, el runner continúa con la sincronización: se prefiere
no bloquear el espejo por un fallo transitorio y, si el destino no es
alcanzable, rsync ya registra su propio error. Este guard existe porque `home`
usa `--delete`: aplicarlo sobre mordoria mientras es una máquina de trabajo
borra o revierte en silencio el trabajo nuevo hecho allí cada 15 minutos. Es el
modo de falla más caro posible porque produce pérdida de datos sin dejar un
error que explique por qué el trabajo «se revirtió solo». Lo agenda la unidad de usuario
`systemd/cwc-mirror.timer` cada 15 minutos; no depende del server web. El exit 2
por lock tomado y el exit 3 por destino en uso están declarados
`SuccessExitStatus=2 3` en la unidad porque ambos son comportamientos normales
y dejarlos como fallo taparía los errores reales. La unidad es un disparador
externo al grafo JS y `core/inventory.js` registra el runner en
`KNOWN_EXTERNAL_TRIGGERS`, para que el censo no lo marque huérfano. El target
`home` incluye deliberadamente TODO: `.ssh`,
`.config`, `node_modules`, cachés y cualquier otro dato del usuario. En
particular, `~/.ssh/authorized_keys` de Rivendell contiene la clave del espejo
para que esa autorización sobreviva al `--delete` en el destino; sin ella, el
espejo se rompería a sí mismo permanentemente. También incluye
`~/.config/systemd/user/`, por lo que las unidades del destino quedan pisadas
por las del origen y conservan la IP de Rivendell; la adaptación al host se
hace durante el failover, no en disco. Agregar exclusiones exige aprobación
explícita del dueño. El target `pad-db` NO confía en la copia plana de la base viva: prepara un
snapshot online y WAL-aware con `backup()` de `node:sqlite` (o `VACUUM INTO`
como fallback), y antes de rsync exige `PRAGMA integrity_check=ok` y más de cero
ítems. Una copia plana de un SQLite en WAL puede mezclar instantes y producir un
respaldo silenciosamente corrupto; por eso el runner falla a propósito y no
sincroniza si el snapshot no supera ambas verificaciones. Como `pad-db` corre
después de `home`, reemplaza la posible copia inconsistente de `pad.db` sin
borrar `attachments/`, `credentials.json` ni ningún otro contenido que ya
trajo el HOME completo.
### bin/cwc-health-runner.js    revisión exhaustiva de salud (barrido módulo x módulo; interfaz por archivos)
### bin/cwc-healthfix-runner.js resolución AUTÓNOMA de UN hallazgo de salud (ESCRIBE código:
allowlist fixToolAllowed, node --check, sin reinicio — excepción
regla 6). Prompt COMPARTIDO con el orquestador de batch: fixPrompt()
de health/shared.js (fusión Optimización IA 2026-07-06 — antes tenía
una copia inline divergente que pedía "FIXFAIL falso positivo" y el
FP quedaba 'failed', re-auditándose con sonnet en CADA revisión).
Falso positivo (FIXNONE/"falso positivo") ⇒ markFindingDismissed()
de shared.js (punto ÚNICO de "marcar descartado"; también delega ahí
el markDismissed del orquestador): fixStatus:'dismissed' en
review.json + registro durable health-dismissed.json → dismissedFor
lo inyecta al auditor y el bucle escaneo→mismo FP→escaneo se corta
también resolviendo hallazgos SUELTOS, no solo por batch
### bin/cwc-health-resolve.js   marca UN hallazgo como RESUELTO (fixStatus:'resolved' en review.json
+ recordSolved). Lo corre el PROPIO chat "En chat" al terminar (le
paso el id en el prompt) para que el tablero refleje el cierre.
Determinístico, 0 tokens, NO toca código. Reusa markFindingResolved
de health/shared.js (mismo helper que el endpoint POST /finding-resolve
del botón manual "Marcar resuelto")
### bin/cwc-health-proposal-mark.js  GEMELO de cwc-health-resolve.js para el OTRO tipo de ítem del
escaneo: las PROPUESTAS de Optimización/Coherencia (no los hallazgos).
Marca UNA propuesta accepted (aplicada) o rejected (falso positivo/no
aplica) en optimization.json/coherence.json, reusando readOpt/writeOpt ·
readCoh/writeCoh de las shared (misma persistencia que el endpoint POST
/optimize-proposal · /coherence-proposal). Lo corre el chat de "Resolver
todo" (Orquestador) tras decidir cada propuesta — sin esto la propuesta
quedaba "pending" en su sección aunque ya se hubiera resuelto (gap que
reportó Niko 2026-07-19). Determinístico, 0 tokens, NO toca código NI
crea tarea en Pad (a diferencia del endpoint, que sí hace el pad-writeback;
acá solo cierra el estado del tablero). Uso:
node bin/cwc-health-proposal-mark.js <optimize|coherence> <id> <accept|reject>
### bin/cwc-bugfix-link.js      vincula un PR YA existente de GitHub a un registro del tablero
Bugs & Features (pata de PREVENCIÓN del bug 2026-07-05 "el
tablero no se entera del trabajo en los chats"): lo corre el
PROPIO chat en el MISMO turno de un push hecho por fuera del
módulo "Enviar PR" (excepción autorizada). Determinístico, 0
tokens (patrón cwc-health-resolve): un gh pr view de LECTURA +
escritura de bugfixes.json vía linkPrToRegistry de
bugfixes/link-shared.js (la MISMA lógica del endpoint POST
/link-pr y de la reconciliación de refresh-prs). NO importa
core/config.js (haría exit fuera del repo): carga el .env por
ruta explícita. Uso: cwc-bugfix-link.js <TKT-n|FEAT-n|sessionId> <nroPR>
### bin/cwc-desk-runner.js      consulta EN VIVO del estado de un ticket en Zoho Desk (READ-ONLY
doble capa, allowlist desk_* de lectura; interfaz por archivos:
desk.lock heartbeat + desk-live/<ticket>.json resultado). Lógica
compartida con el módulo en bugfixes/desk-shared.js
### bin/cwc-desk.js             CLI de Zoho Desk con la identidad OAuth del USUARIO (PLAN-781). Es el
PUENTE para las SESIONES: un chat usa tools MCP y no puede llamar al
HTTP interno del server, pero sí correr un comando. Subcomandos: get ·
assign · comment (nota interna por defecto; --public para el cliente) ·
attach · update · create. Carga el .env de la consola por ruta explícita
ANTES de importar core/config.js, así funciona invocado por ruta ABSOLUTA
desde otro cwd (las sesiones-Limbo corren con cwd de Tolkien).
### bin/cwc-sharepoint.js       CLI de SharePoint con la identidad OAuth del USUARIO (PLAN-923). Es el
PUENTE para las SESIONES, igual que cwc-desk.js: un chat no puede
pegarle al HTTP interno del server pero sí correr un comando, y carga
el .env por ruta explícita ANTES de importar core/config.js para
funcionar con cwd de cualquier mundo. Subcomandos: ls · get (con
--chat=<id> materializa el archivo en la carpeta del chat vía
materializeIntoChat) · put · mkdir. La ESCRITURA (put/mkdir) EXIGE
--yes: sin el flag imprime qué iba a hacer y sale con exit 2 sin tocar
nada — deliberado, porque el scope Sites.ReadWrite.All es TENANT-WIDE
(no existe un scope "solo esta carpeta" para flujos delegados;
Sites.Selected es app-only) y el gate del CLI es el único acotamiento real.
### bin/cwc-projects-analyze-runner.js análisis IA (guardián) de UN cambio de sección de contexto
(CLAUDE.md) del módulo projects, DESACOPLADO del server (haiku, 1
turno, CERO herramientas — doble capa regla 6 deniega TODO).
Interfaz por archivos PER-USUARIO:
`<userDataDir>/projects-analyze/<id>.json`
(job con before/after que escribe el POST; el runner persiste el
veredicto en el MISMO archivo; para el host la ruta sigue siendo
`~/.cwc-data/projects-analyze/<id>.json`). Recibe `<id> <owner>`; sin
owner asume host solo para compatibilidad con jobs viejos. El host conserva
`process.env`; un inquilino arranca con `userRunnerEnv` y SU token OAuth,
después de `_env-boot.js` + redacción de secretos. Sin credencial propia el
server NO lo spawnea (fail-closed, nunca consume la cuenta Claude del host).
Lógica compartida en src/modules/projects/analyze-shared.js
### bin/cwc-commitmsg-runner.js generación IA del mensaje de commit del botón "Commit (sin push)"
del panel Backup, DESACOPLADA del server (sonnet, 1 turno, CERO
herramientas — doble capa regla 6 deniega TODO; el diff viaja en
el prompt, capturado por el server EN NODE). Interfaz por
archivos: ~/.cwc-data/commitmsg/<id>.json (job con files/diff que
escribe el POST; el runner persiste el mensaje en el MISMO
archivo). Lógica compartida en src/modules/backup/commitmsg-shared.js
### bin/cwc-news-runner.js     redacción y publicación DESACOPLADA de 🆕 Novedades
tras un push exitoso o el botón admin "✍️ Redactar ahora" (sonnet, hasta 30
turnos). Corrida read-only blindada en DOS capas con la allowlist exacta
Read/Grep/Glob/ToolSearch; sin Bash/Edit/Write/WebFetch, MCP ni settingSources.
Publica en `~/.cwc-data/news.json`, persiste el job en
`~/.cwc-data/news/<jobId>.json` y registra la corrida en
`~/.cwc-data/news.log`. Lógica compartida en src/modules/news/news-shared.js
### bin/cwc-audio-runner.js     análisis IA de UNA transcripción de audio (módulo `audio`),
DESACOPLADO del server (regla de oro; sonnet, 1 turno, CERO
herramientas — doble capa regla 6 deniega TODO; el texto viaja
entero en el prompt). Interpreta quién dijo qué y por qué, arma un
plan y propone tareas. Interfaz por archivos:
~/.cwc-data/audio/<id>.json (job con la transcripción que escribe el
POST; el runner persiste el resultado en el MISMO archivo). Lógica
compartida en src/modules/audio/shared.js
### bin/cwc-retro-runner.js     MEJORA CONTINUA (ROAD-256): destila LECCIONES DE PROCESO de UNA
sesión de chat al cerrarla (módulo `retro`), DESACOPLADO (regla de
oro; sonnet, 1 turno, CERO herramientas — doble capa regla 6 deniega
TODO; la transcripción condensada viaja en el prompt). Tras destilar
hace el UPSERT determinístico en Pad local (dedup por fingerprint =
recurrencia; le pasa las lecciones ya registradas al modelo para que
reuse el título exacto de un concepto repetido = patrón "dedup vs
seen"). Interfaz por archivos: ~/.cwc-data/retro/<id>.json (id sha1
del sessionId; lo encola el server en Chat.close). Lógica compartida
en src/modules/retro/shared.js (+ store en src/modules/retro/store.js,
router de promoción en src/modules/retro/promote-shared.js)
### bin/cwc-retro-curate-runner.js CURADURÍA IA del registro de MEJORA CONTINUA (ROAD-256,
Fase 5), DESACOPLADO (regla de oro; sonnet, 1 turno, TEXTO PURO — doble
capa regla 6 deniega TODO; el server junta lessons+reglas duras en el
job). Detecta duplicados/contradicciones/redundantes/consolidables/
huecos. Un solo job en ~/.cwc-data/retro-curation.json (+
retro-curate.log). Lógica en src/modules/retro/curate-shared.js
### bin/cwc-retro-feedback-runner.js "💬 Feedback de Chris" — ingesta MANUAL (pegar correo/
Teams/llamada) para Mejora Continua, DESACOPLADO (regla de oro; sonnet, 1
turno, TEXTO PURO, doble capa regla 6 deniega TODO). Interpreta el texto
pegado en una o varias lecciones categoría 'feedback-cliente' + destino
'contexto'. Job en ~/.cwc-data/retro-feedback-<id>.json (id determinístico
por texto+ticket) + retro-feedback.log. Lógica en
src/modules/retro/feedback-shared.js
### bin/cwc-retro-email-runner.js "💬 Feedback de Chris" — ESCANEO AUTOMÁTICO de correo
(Microsoft Graph) para Mejora Continua, DESACOPLADO (regla de oro; sonnet,
READ-ONLY doble capa regla 6 con allowlist EXPLÍCITA POR NOMBRE —
emailReadAllowed— que permite SOLO graph_read_email/graph_read_email_body,
nunca send/reply/draft). Escanea el correo del contacto 'chris' (reusa
comms/shared.js) vía el MISMO MCP de Graph de Tolkien que ya usa Teams
(scope Mail.Read ya concedido, sin consentimiento nuevo); cwd=Tolkien
(CROSS_WORLD_ALLOW). Estado en ~/.cwc-data/retro-email-scan.json +
retro-email.lock (heartbeat pid-aware, dedup patrón triage/Teams). Lógica
en src/modules/retro/email-shared.js. BUG-1928: persiste SIEMPRE
`project:'tolkien'`; NO “corregir” a `'otros'`: `projectDirFor('otros')`
devuelve `null` y `TARGETS_NEED_DIR=['memoria','claude-md']` deja vedados
justo los dos destinos que Claude Code auto-carga. BUG-1930: antes de la
query trae `listLessons`, filtra `category==='feedback-cliente'`, ordena por
`updatedAt` descendente y pasa solo `FEEDBACK_DEDUP_LIMIT=30` títulos ya
registrados para que un re-reporte reuse el fingerprint, suba `recurrence` y
pueda encender en rojo el semáforo de efectividad. Patrón copiado de
`cwc-retro-feedback-runner.js`; el tope evita volcar al prompt las 275
lecciones generales (~168 KB).
### bin/cwc-retro-teams-runner.js "💬 Feedback de Chris" — ESCANEO AUTOMÁTICO de Microsoft
Teams (DM con 'chris') para Mejora Continua, DESACOPLADO (regla de oro;
sonnet, READ-ONLY doble capa regla 6 con `graphReadAllowed` REUSADO tal
cual de comms/teams-shared.js — el mismo allowlist ya probado del escaneo
de Teams de Comunicaciones, no uno nuevo). Antes de disparar Graph, consulta
`readTeams()`: si el hilo de `chris` tiene menos de `FRESH_TEAMS_MS` (15 min),
lo interpreta con `textOnlyQuery` (cero herramientas) y
`teamsFeedbackFromMessagesPrompt`. Si no hay caché, falla la corrida o el
parseo no produce ítems, cae a `fetchTeams` por Graph; la optimización nunca
devuelve menos que el camino anterior. Es la generalización de
`freshBotThread` de `chatbot-shared.js`. Estado en
~/.cwc-data/retro-teams-scan.json + retro-teams.lock (heartbeat pid-aware,
mismo dedup que el runner de correo). Lógica en
src/modules/retro/teams-feedback-shared.js. Comparte los blindajes
BUG-1928/BUG-1930 del runner de correo: `project:'tolkien'` (NUNCA
`'otros'`, que deja `projectDirFor()` en `null` y veda memoria/claude-md) +
`listLessons` acotado a las 30 `feedback-cliente` más recientes, patrón de
`cwc-retro-feedback-runner.js`; sin títulos previos el fingerprint no se
reusa, `recurrence` no sube ni el semáforo puede detectar reincidencia, y
sin el filtro/tope entrarían las 275 lecciones (~168 KB) al prompt.
### bin/cwc-retro-verify-runner.js MEDIDOR REAL de efectividad de Mejora Continua
(M1 de DOC-1926 / PLAN-1937), DESACOPLADO (regla de oro/regla 2). Es el ÚNICO
runner de la familia `retro` que NO usa el SDK: **0 TOKENS**, solo lee PRs con
`fetchPrRich` de `comms/pr-read-shared.js` (lector ÚNICO ya cacheado 60 s —
nunca un `gh` propio), así que la regla 6 no aplica. Cuenta, por cada lección
`feedback-cliente` `promovida` con `sourceRefs`, las RONDAS de review de Chris
sobre esos PRs POSTERIORES a `promotedAt`; ese conteo alimenta
`computeEffectiveness` (retro/store.js) como `external.rounds` y es la ÚNICA
señal capaz de poner en rojo una lección de Chris, porque su contador interno
`recurrence` no puede subir nunca (BUG-1930). NO persiste NADA en Pad (el
resultado es derivado) y hace 0 escrituras a GitHub. El revisor NO se hardcodea:
sale de `readContacts()` (contacto `chris` → `cswenor`) y sin él falla CERRADO.
Estado en `~/.cwc-data/retro-verify.json` + `retro-verify.lock` (heartbeat
pid-aware, reserva del lock con el pid REAL del hijo en el mismo tick del spawn,
patrón email/Teams) + `retro-verify.log`. REANUDABLE: escribe el estado tras CADA
PR y al relanzarse reusa los PRs chequeados hace menos de 30 min (`--full` los
ignora) — verificado con `kill -9` a mitad de corrida (quedó `running` con 3/8
PRs persistidos y el relanzamiento completó los 5 que faltaban). Lógica en
`src/modules/retro/verify-shared.js`. Lo disparan `POST /api/retro/verify`
(admin) y el auto-cebado por vencimiento de `GET /api/retro`.
### bin/cwc-retro-sweep-runner.js BARRIDO de sesiones TUI para Mejora Continua
(BUG-2068), determinístico y **0 TOKENS**: no usa el SDK, por lo que la regla 6
no aplica. Corre DESACOPLADO por la regla dura 2; estado/lock/log en
`~/.cwc-data/retro-sweep.json`, `retro-sweep.lock` y `retro-sweep.log`, más
`retro-swept.json` como registro DURABLE que NUNCA se poda. Flags:
`--dry-run`, `--json`, `--quiet-ms=N`, `--max-age-days=N`, `--max=N`. Lo
dispara el tick de `init()` del módulo `retro`; la destilación real la sigue
haciendo `cwc-retro-runner.js`, porque este runner solo descubre transcripts
quietos y los encola mediante `queueRetroDistill`. Lógica compartida en
`src/modules/retro/sweep-shared.js`.
### bin/cwc-tasks-analyze-runner.js ANÁLISIS GENERAL IA del tablero de Pendientes (botón "🧠
Análisis general" de las pestañas Tareas/Planes), DESACOPLADO del
server (regla de oro; sonnet, 1 turno, CERO herramientas — doble capa
regla 6 deniega TODO; los datos se juntan EN NODE y viajan en el
prompt). Arg `scope` = tasks|plans: junta TODAS las tareas (o planes)
+ los informes de audio y devuelve {resumen, duplicados, unificables,
completar}. Interfaz por archivos: ~/.cwc-data/tasks-analysis-<scope>.json
(status running/done/error, dedup por corrida fresca, sin lock aparte).
Lógica compartida en src/modules/tasks/analyze-shared.js
### bin/cwc-learning-explain-runner.js "🎓 Explicame esto" del MÓDULO DE APRENDIZAJE
(learning), DESACOPLADO (regla de oro). A DIFERENCIA de los runners de
texto puro, éste SÍ LEE el código: NAVEGA read-only (Read/Grep/Glob,
allowlist explainToolAllowed, doble capa regla 6) el repo del `scope` del
tema (la consola o Tolkien vía config.projectDir), sonnet, maxTurns 24,
timeout 6 min, settingSources: []. Al terminar AUTO-GUARDA la explicación
guiada en el tema (store.saveExplanation). Interfaz por archivos:
~/.cwc-data/learning-explain-<id>.json (job con snapshot del tema que
escribe el POST). REGENERACIÓN INTELIGENTE (2026-07-10): el job puede traer
`mode` ('full'|'adapt') + `topic.previousExplanation`/`topic.reason` — en
'adapt' el prompt le pasa la explicación anterior para que la actualice en
vez de arrancar de cero (la DECISIÓN full/adapt/noop la toma el endpoint del
server ANTES de spawnear, ver explain-shared.js checkStaleness). Al terminar
también parsea el bloque ```files``` de la respuesta (parseFiles) y
snapshotea esos archivos (fileSnapshot) para la próxima huella de código.
Lógica en src/modules/learning/explain-shared.js
### bin/cwc-learning-context-runner.js "🎙️ Contexto adicional" de un TEMA de aprendizaje
(2026-07-10, pedido de Niko), DESACOPLADO (regla de oro). Interpreta una
TRANSCRIPCIÓN (charla con Chris, un chat, notas de reunión) — a diferencia
del runner de explicación, éste es de TEXTO PURO: CERO herramientas, doble
capa regla 6 deniega TODO (mismo patrón que
tickets/context-analyze-shared.js pero de alcance PROPIO, sin acoplar los
dos módulos). Al terminar AGREGA el resultado interpretado como una
entrada 'ia' de la LISTA `contextoEntradas` del tema
(store.addContexto{source:'ia'} — NO sobrescribe las demás), que se
inyecta en el próximo "Regenerar". Interfaz por archivos:
~/.cwc-data/learning-context-<jobId>.json (id determinístico por
tema+transcripción: un reintento con el mismo texto reusa el mismo job) +
learning-context.log. Lógica en src/modules/learning/context-shared.js
### bin/cwc-learning-analyze-runner.js "🧠 Analizar aprendizaje" del MÓDULO DE APRENDIZAJE,
DESACOPLADO (regla de oro; sonnet, 1 turno, CERO herramientas — doble capa
regla 6 deniega TODO; los temas se juntan EN NODE y viajan en el prompt).
Organiza TODOS los temas: duplicados/unificables/completar/agrupar-en-rutas/
aprenderPrimero/sugerirNuevos. Interfaz por archivos:
~/.cwc-data/learning-analysis.json (status running/done/error, dedup por
corrida fresca). Lógica en src/modules/learning/analyze-shared.js.
OJO: los 3 runners de aprendizaje (explain/context/analyze) capturan el
`session_id` del msg SDK `system/init` y lo registran vía
`src/modules/learning/session-log.js` (registerLearningSession →
~/.cwc-data/learning-session-ids.json) para que el módulo tokens atribuya
su consumo al bucket 'aprendizaje' aparte de 'consola' (ver módulo tokens)
### bin/cwc-investigate-runner.js investigación a fondo de UN PR (¿la pelota es tuya o de Chris,
y qué hacer?). Junta datos con gh EN NODE y el modelo los interpreta
SIN herramientas (read-only MÁXIMO, regla 6). Interfaz por archivos:
investigate.lock + investigations/<pr>.json. Lógica en
bugfixes/investigate-shared.js
### bin/cwc-ticket-investigate-runner.js investigación de CONTEXTO de UN ticket SIN PR (¿por qué
NO se resolvió?). LEE el código de Tolkien read-only (Read/Grep/Glob,
misma allowlist que el auditor de Salud — regla 6), cwd Tolkien, sonnet,
maxTurns 16. Interfaz por archivos: ticket-investigate.lock +
ticket-investigations/<n>.json (resultado) + <n>.req.json (enunciado que
escribe el server). Lógica en bugfixes/ticket-investigate-shared.js
### bin/cwc-optimize-runner.js  OPTIMIZACIÓN IA de los motores de la consola (botón "🧠
Optimización IA" de la pestaña Salud). Junta el CENSO
determinístico de motores IA (aiEnginesCensus de core/inventory.js:
qué modelo/turnos/timeouts/blindaje usa cada corrida del SDK, 0
tokens) + el CONSUMO REAL (buildSummary del módulo tokens, export
deliberado) y UNA corrida de sonnet (READ-ONLY doble capa regla 6,
misma allowlist que el auditor de salud: Read/Grep/Glob/TodoWrite,
settingSources: [], cwd = la consola) que VERIFICA leyendo el
código y devuelve {resumen, propuestas[] (modelo/turnos/timeout/
flujo/fusion/paralelismo/prompt, con riesgo y pasos), flujoNuevo}.
Interfaz por archivos: optimize.lock (heartbeat con fase) +
optimization.json (resultado persistido). Las propuestas NUNCA se
auto-aplican: quedan pending y Aprobar = chat supervisado
(acceptEdits) / flujo nuevo = chat en modo plan; Descartar las
marca rejected. Lógica compartida en health/optimize-shared.js
(su plomería lock/heartbeat + store persistido + parseo de
propuestas son FÁBRICAS de health/proposal-runner-shared.js —
makeLock/makeResultStore/makeProposalParser + allowlist
readOnlyToolAllowed — compartidas con coherence-shared.js;
fusión 2026-07-06 propuesta por la propia Optimización IA:
estaban duplicadas línea por línea y ya habían divergido.
Ambos módulos re-exportan los nombres históricos
(writeOptLock/parseCoherence/…): runners y server no cambian)
### bin/cwc-coherence-runner.js MÓDULO DE COHERENCIA (subsección "🔗 Coherencia" de la pestaña
Salud). Gemelo del optimizador pero mira las ARISTAS del sistema,
no los nodos: ¿los motores/módulos se usan ENTRE SÍ o reinventan/
duplican/se ignoran? (disparador: motores del ciclo de tickets que
NO usaban `comms`). Junta el CENSO determinístico de coherencia
(core/inventory.js → coherenceCensus: grafo quién-usa-a-quién por
imports resueltos + consumo de servicios transversales comms/bus/
inventory/tokens/paths/sdk-settings + señales gh/runners/motores) +
los HALLAZGOS de cableado determinísticos (evaluateCoherence de
health/coherence-shared.js: comms infrautilizado · gh fuera de las
fuentes canónicas (lector pr-read-shared / gateway gateway-shared;
exenciones verificadas en GH_EXEMPT) ·
runner sin regla de oro · motor sin doble capa · servicio huérfano ·
COMPLETITUD del inventario: módulo sin registrar/frontend sin montar
· runner/motor SDK huérfano; cada hallazgo con `pasos` + botón
"Resolver en chat" supervisado. "Está corriendo" NO — eso es runtime,
queda en Chequeos rápidos)
y UNA corrida de sonnet READ-ONLY doble capa (regla 6, misma
allowlist Read/Grep/Glob/TodoWrite, settingSources: []) que VERIFICA
leyendo el código y PROPONE el cableado concreto. Interfaz por
archivos: coherence.lock (heartbeat con fase) + coherence.json
(resultado + hallazgos persistidos). Propuestas NUNCA auto-aplicadas
(Aprobar = chat acceptEdits · Explorar flujo = plan · Descartar =
rejected), patrón invariant-proposals. Lógica compartida en
health/coherence-shared.js (plomería lock/store/parseo =
fábricas de health/proposal-runner-shared.js, ver optimize)
### bin/cwc-bus.js              CLI del INTERFONO entre sesiones (lógica en src/core/bus.js). PUERTA
ÚNICA de los hooks de Claude Code + el comando /btw. Subcomandos:
send (lo usa /btw; valida ANTES de escribir que el destino resuelto por
`resolveTarget` exista en `buildDirectory`, salvo broadcast `all`; un handle
fantasma falla con exit 1 y lista cada nombre+handle disponible; `--force`
permite escribir a un handle de una sesión todavía no arrancada, con aviso;
el éxito muestra SIEMPRE el nombre y handle realmente resueltos, no el texto
crudo ingresado) · hook-inject (SessionStart/UserPromptSubmit:
imprime mensajes/lápidas pendientes → Claude los inyecta) ·
hook-guard (PreToolUse Edit|Write|MultiEdit: frena si otra sesión
VIVA reclama el archivo, exit 2) · hook-claim (PostToolUse: reserva
el archivo editado) · hook-release (SessionEnd: suelta claims
propios) · list (debug). Identidad propia por $TMUX_PANE (TUI) o
session_id del stdin (chat). Fail-open salvo hook-guard. Nudge SEGURO
opcional por send-keys SOLO a TUI con claude idle (observador
waiting+model+ts fresco); si trabaja o es shell, el mensaje espera en
la bandeja
### bin/cwc-bus-bridge.js       PUENTE DESACOPLADO del Interfono entre máquinas.
El bus file-based de `src/core/bus.js` es deliberadamente por-máquina; este
runner es lo único que lo cruza. `send <máquina>:<handle> <texto>` encola
atómicamente en `~/.cwc-data/bus-outbox/`, y el ciclo one-shot (default o
`--once`) entrega por SSH usando los peers de `bus-peers.json`; sin peers sale
0 porque es una configuración válida. La CLI real de `cwc-bus.js` no acepta el
texto por stdin ni permite conservar `fromName`/`hops`, por eso el transporte
manda un sobre base64 a `--inject-stdin`: el destino resuelve el handle con
`resolveTarget`/`buildDirectory` e invoca `sendMessage()` del MISMO bus, no uno
paralelo. El anti-bucle por prefijo `[via <máquina>]` + `MAX_HOPS` NO es
opcional: sin ambos guards, dos puentes enfrentados se reenviarían el mismo
mensaje para siempre. Cada fallo queda pendiente con contador; al agotar cinco
intentos se mueve a `bus-outbox/failed/` y se loguea como ERROR CRÍTICO a
propósito, porque perder un mensaje sin que nadie lo sepa es peor que un error
visible. Estado/lock con heartbeat/log rotado viven en `~/.cwc-data`; lo agenda
`systemd/cwc-bus-bridge.timer` cada minuto y el exit 2 por lock tomado cuenta
como éxito normal en la unidad.
### bin/install-interfono.js + bin/uninstall-interfono.js  instalan/quitan los hooks del interfono
en ~/.claude/settings.json + el comando ~/.claude/commands/btw.md
(aditivo/reversible, patrón install-observer: preservan entradas
ajenas incluidas las del observador; filtran las propias por marca
`cwc-bus.js`). OJO: los hooks se capturan al INICIAR claude — las
sesiones ya abiertas no toman el interfono hasta reiniciar claude
adentro (mismo gotcha que el observador)
### bin/install-pelota.js + bin/uninstall-pelota.js  instalan/quitan el hook "🎾 La pelota"
en ~/.claude/settings.json (UserPromptSubmit con echo puro, marca
`cwc-pelota`; aditivo/reversible/idempotente, patrón
install-observer). Hace DETERMINÍSTICO el cierre "🎾 Pelota: ..."
de las preferencias globales del usuario (~/.claude/CLAUDE.md):
inyecta el recordatorio fresco en CADA turno (~40 tokens) porque
el CLAUDE.md solo se carga al iniciar y en hilos largos el modelo
lo omitía (pedido del usuario 2026-07-05). Mismo gotcha de captura
al INICIAR claude que observador/interfono
### bin/cwc-comms-runner.js     escaneo de comunicaciones: junta con `gh` (0 tokens, cwd Tolkien)
las reviews/comentarios de los contactos con login de GitHub y
arma los hilos (github.json). Reanudable (lock/heartbeat +
caché incremental por PR). Lógica en src/modules/comms/shared.js
### bin/cwc-comms-chatbot-runner.js motor del CHATBOT del módulo comms (botón "🤖 Chatbot"
del tablero), DESACOPLADO (regla de oro). Deriva la sección Chatbot de
lo que YA escaneamos del bot de Teams "Tolkien" (TheEye) en DOS fases:
(1) LEE los mensajes CRUDOS del bot vía Graph (read-only regla 6 =
graphReadAllowed, reusa teamsBotPrompt/parseTeamsResponse; fallback a
teams.json); (2) INTERPRETA con IA (`haiku`, `effort:'low'`, 1 turno, CERO
herramientas, doble capa deniega TODO) quién es la persona REAL detrás de cada mensaje
relayado y lo atribuye a un contacto conocido; (3) MERGE no destructivo
con chatbot.json (append+dedup, preserva el seed). CONSUME TOKENS ⇒ bajo
botón. Interfaz por archivos: chatbot.lock (heartbeat con fase) +
chatbot.json (resultado). La fase 1 sigue en sonnet porque usa Graph; la fase 2
tiene criterio cerrado y comparte el perfil de
`extractTitle`/`classifyRelative`/`judgeAnswer` de `chat/index.js`. GOTCHA: el
comentario de cabecera del propio runner todavía dice “sonnet” para la fase 2 y
está desactualizado; esta pasada documental no toca `.js`. Lógica en
src/modules/comms/chatbot-shared.js
### bin/cwc-comms-teams-runner.js escaneo de TEAMS (mensajes directos) del módulo comms:
por cada contacto lee sus DMs con las tools graph_* de LECTURA
del MCP tolkien-mordor (cwd=projectDir, settingSources headless,
doble capa read-only regla 6 = graphReadAllowed). CONSUME TOKENS
(sonnet) ⇒ bajo botón. Lógica en src/modules/comms/teams-shared.js
(teamsBotPrompt/parseTeamsResponse los REUSA cwc-comms-chatbot-runner.js).
ATRIBUCIÓN (fix 2026-07-05): cada hilo es entre YO (self.json:
Nicolás/nmosquera@/gh nmosqueramordor) y el contacto. Teams exige
el 1:1 {yo, contacto} — RECHAZA (found:false) un DM que no me
incluya y guarda participants+chatId. GitHub filtra a PRs míos o
donde participé (self.github). El tablero muestra los participantes
por hilo y marca ⚠️ si no soy parte.
INTEGRACIÓN con bugs/bugfixes (2026-07-05, pedido del usuario): regla
de diseño — todo flujo del ciclo de TKT/feature/bug que necesita algo
DE CHRIS consulta (o a futuro registra) en ESTE motor, en vez de
reinventar su propio scraping. Hecho hoy: bugs/board/prompts.js
(fetchCommsContext, 0 tokens, GET /api/comms/index ya cacheado)
inyecta en "Trabajar en esto" (workPrompt/featurePrompt/triagePrompt)
el hilo de GitHub del PR (gh:<prNumber>:chris) y el DM de Teams
(teams:chris) si existen — el chat arranca sabiendo qué se habló
último con Chris sin abrir el tablero de Comunicaciones a mano.
PENDIENTE (fuera de alcance, no implementado): auto-registrar en el
motor cuando un chat de trabajo le pide algo a Chris, y unificar el
scraping de GitHub hoy DUPLICADO entre bugfixes/desk-shared.js
(feedback por PR, caché propia) y comms/shared.js (gh-cache.json
propia) — ambos leen `gh` por separado sin compartir fuente.
GATEWAY DE ENVÍO (2026-07-05, pedido del usuario: "toda
comunicación usa el motor"): comms dejó de ser solo visor
read-only — ahora EJECUTA y registra TODO envío externo.
gateway-shared.js (sendComm): valida contacto/identidad,
aplica la FIRMA centralizada (SIGNATURE, antes hardcodeada
en 2 lugares), EJECUTA (github inline con gh, 0 tokens ·
desk/teams desacoplado al send-runner con allowlist de
escritura gobernada), REGISTRA en outbox.json (ledger
append-only de auditoría) + en el hilo del contacto, y
DEVUELVE el resultado. dryRun no envía. Endpoints: POST
/send · GET /send/:jobId · GET /outbox. CLI: cwc-comms
send (ejecuta) · record (registra un envío ya aprobado en
un chat, sin re-enviar). MIGRADO: bugfixes ya NO hace gh
pr comment/close/add-reviewer ni escribe Desk por su
cuenta — pushPr/updatePr/cancelPr y deskUpdateAuto
(ticket_auto_update) llaman al gateway; deskChat registra
con cwc-comms record tras publicar con tu OK.
COMPOSER EN EL TABLERO + REGISTRO VISIBLE (2026-07-06, pedido del
usuario "cuando envío algo no me queda registro"): hasta hoy NO
había forma de enviar desde la UI del tablero — el envío por
Teams solo salía por CLI (cwc-comms send) o desde un chat que
llamaba al MCP teams_send POR FUERA del gateway (por eso no dejaba
rastro: buildIndex arma los hilos de github/teams/chatbot/manual,
NUNCA lee outbox.json). Ahora el tablero (comms/board/) tiene un
COMPOSER por contacto (render.js `.cm-composer` bajo el header;
el texto vive en store.composer[contactId] y se escribe en cada
tecla SIN re-render —listener 'input' en index.js— para sobrevivir
a un re-render por scan) que ENVÍA un DM de Teams real vía
A.sendMessage → POST /api/comms/send {channel:'teams', action:'dm',
contactId, payload:{text}} con confirm duro (publica con tu
identidad + firma). Encuesta el job (GET /send/:jobId) y al
terminar hace reload() para traer el registro. CLAVE del fix: el
composer SIEMPRE pasa contactId ⇒ el send-runner corre appendManual
(registro al hilo, línea condicional a job.contactId) ⇒ el envío
queda visible en el hilo del contacto (antes, sin contactId,
quedaba solo en outbox invisible). Para la vía CHAT (un chat que
envía por su cuenta), buildChatPrompt de board/actions.js ahora
instruye: si con tu OK enviás, registralo con `cwc-comms record
teams dm <contacto> -- "<texto>"` (NO re-envía, solo deja el rastro).
El registro nativo en Teams ya existe: el DM sale con TU cuenta al
chat 1:1 real, así que aparece en tu Teams solo — el gap era solo el
tablero. (La idea original de "que el bot Tolkien/TheEye confirme"
NO es viable: no hay NINGÚN enganche programático con OpenClaw/TheEye
en este repo — verificado.)
BOTÓN "🤖 CHATBOT" — chatbot DERIVADO por IA (2026-07-07, pedido del
usuario): hasta hoy la fuente `chatbot` (Chris relayado por el bot
Tolkien/TheEye) era 100% seed/manual — no había forma de traer
actualizaciones (el usuario recibió novedades de los tkts 252/251/250
por ese canal y la consola nunca las ingirió). Ahora el tablero tiene
un 3er botón "🤖 Chatbot" (junto a GitHub/Teams) que DERIVA la sección
de lo que YA escaneamos del bot, en un RUNNER DESACOPLADO
(`bin/cwc-comms-chatbot-runner.js`, lógica en `comms/chatbot-shared.js`;
regla de oro + regla 6). DOS FASES: (1) LEER — por cada contacto
kind:'bot' con chatId lee sus mensajes CRUDOS de Teams vía Graph
(read-only doble capa = graphReadAllowed, reusa teamsBotPrompt/
parseTeamsResponse de teams-shared; fallback a teams.json ya escaneado
si Graph falla); (2) INTERPRETAR — corrida SDK (`haiku`, effort `low`, 1 turno,
CERO herramientas, doble capa deniega TODO) que DEDUCE por el CONTENIDO
quién es la persona REAL detrás de cada mensaje del bot ("Chris
reviewed…" → contacto chris) y lo atribuye a un contacto conocido
(chatbotInterpretPrompt/parseChatbotInterpretation); realContactId
inválido/"unknown" cae al contacto del bot (botFallbackId) para no
perder nada. FASE 3 MERGE — agrupa por contacto real y FUSIONA con
chatbot.json existente (mergeChatbotThreads: append + dedup por
ts+texto, NUNCA pisa el seed histórico). Extensible: NO solo Chris —
cualquier persona relayada que sea contacto conocido se atribuye sola.
CONSUME TOKENS (Graph read + interpretación) ⇒ bajo botón con confirm,
como Teams. Backend: POST /api/comms/chatbot-refresh (admin, dedup por
lock `chatbot.lock` heartbeat con fase, spawnChatbotScan patrón
spawnTeamsScan) responde YA; `chatbotRunning` viaja en GET / y /index;
el front (board/actions.js scanChatbot) encuesta como el scan de Teams.
Frontend: botón en la toolbar (board/index.js, case 'scanchatbot'),
`chatbotRunning` en el store, sección 🤖 Chatbot (render.js) con
"actualizando…" + invitación al botón cuando está vacía. Estado
file-based: ~/.cwc-data/comms/chatbot.json (resultado fusionado) +
chatbot.lock (heartbeat) + chatbot.log.
CONTENIDO COMPLETO (2026-07-07, pedido del usuario: "los mensajes largos
se cortan y no se muestra la totalidad"): en Comunicaciones el mensaje se
muestra ENTERO. Los prompts de Teams (teamsPrompt/teamsBotPrompt, ×3)
pedían `"text":"<~300 chars>"` — el modelo recortaba en el ORIGEN (los
mensajes topaban en ~318 chars); ahora piden el texto COMPLETO ("no lo
resumas ni recortes"). Caps de ingesta subidos 1200→8000 (parseTeamsResponse
+ parseChatbotInterpretation) y el display (render.js msgHtml) ya NO
recorta (el `.cm-msg-b` con white-space:pre-wrap envuelve todo, sin clamp
CSS — no hace falta "expandir"). mergeChatbotThreads hace UPGRADE: si un
re-scan trae el MISMO mensaje con MÁS texto (des-clippeado), reemplaza la
versión recortada (clave por ts+arranque, dedup tolerante al des-clippeo).
Beneficio colateral: el scan de Teams (mismo prompt) también trae mensajes
completos. Data vieja clippeada: se sana con un re-scan.
CHATEAR DIRECTO + ENVÍO A BOTS (2026-07-06, pedido del usuario
"poder chatear/responder rápido"): (1) botón "Responder" en cada
hilo (render.js data-act='reply') que hace scroll+focus al composer
del contacto (respuesta veloz sin scrollear). (2) ENVÍO A BOTS: el
send-runner (teamsDmPrompt de bin/cwc-comms-send-runner.js) para un
contacto kind:'bot' con chatId conocido ENVÍA DIRECTO a ese chatId
con teams_send_message (el "ubicar chat 1:1" fallaría igual que el
scan — graph_list_chats no surface bots); personas siguen con la
vía 1:1. Verificado dryRun: Tolkien→vía-bot-directa, Chris→vía-
persona. La firma "— Nicolás (dev team)" se sigue aplicando a TODO
envío Teams (ensureSignature del gateway) — inocua para un bot,
revisable si molesta.
TOLKIEN COMO CONTACTO (2026-07-06): "Tolkien" (Mordor's AI
assistant, bot de Teams) se agregó a DEFAULT_CONTACTS (shared.js)
y al contacts.json vivo — id 'tolkien', kind:'bot', sin github/
email. Al usuario le llegan mensajes de ese bot y debe procesarlos
igual. El tablero lo marca con badge "🤖 bot".
SCAN DE BOTS (teams-shared.js teamsBotPrompt + runner elige por
contact.kind==='bot'): VERIFICADO 2026-07-06 que graph_list_chats
del MCP NO surface los chats con apps/bots (solo devuelve 1:1 entre
PERSONAS — el modelo reportó "revisé 8 chats 1:1, ninguno es la app
Tolkien"). Por eso el prompt de bot tiene DOS vías: (1) VÍA DIRECTA
preferida — si el contacto tiene un `chatId` guardado, lo lee
directo con graph_read_chat_messages (saltea el "buscar" que falla);
(2) fallback de búsqueda si no hay chatId. El chatId del bot Tolkien
se tomó del seed chatbot.json (formato 19:<miGUID>_<appGUID>@unq.
gbl.spaces) y se guardó en el contacto. parseTeamsResponse RELAJA la
validación de miembros para kind:'bot' (solo exige que YO esté — el
bot no matchea por email/nombre de persona). CON la vía directa el
scan trajo los 15 mensajes reales del bot. Un contacto-bot nuevo sin
chatId conocido caería a la vía búsqueda (que hoy falla por el MCP) —
para esos, guardar el chatId a mano en contacts.json es el camino.
LECTURA CENTRALIZADA Fase C (2026-07-05): comms/pr-read-shared.js
(fetchPrRich) es el LECTOR ÚNICO de un PR de GitHub — SUPERSET de
campos (unión de prLive+investigate+comms) + caché de archivo por
PR con TTL 60 s en ~/.cwc-data/comms/pr-cache/. Los tres consumidores
(bugfixes/prLive, bin/cwc-investigate-runner.js, bin/cwc-comms-runner.js)
la usan: la triple lectura de red del feedback de Chris quedó unificada
(cada uno sigue parseando SOLO sus campos; se comparte el fetch+caché).
liveCache in-process de prLive eliminado. Quedan fuera los `gh pr view
--json state` de un campo (verificación de estado en cancel/refresh),
que no son la lectura de feedback.
### bin/cwc-comms-send-runner.js EJECUTOR desacoplado de envíos Desk/Teams del GATEWAY de
comms (2026-07-05): publica notas de Desk (desk_add_comment/
update) y DMs de Teams (teams_send) vía MCP con ESCRITURA
GOBERNADA (doble capa regla 6, ahora permitiendo SOLO los
verbos de envío del canal — deskWriteAllowed/teamsWriteAllowed).
Job en ~/.cwc-data/comms/send/<id>.json. Lógica en
src/modules/comms/gateway-shared.js
### bin/cwc-comms-analyze-runner.js análisis IA de UN hilo de comunicaciones (resumen +
clasificación: estado/pelota, tema, proyecto sugerido, próximo
paso, clima), DESACOPLADO (regla de oro; haiku, 1 turno, CERO
herramientas — doble capa regla 6, solo resume el texto ya
indexado). Job en ~/.cwc-data/comms/analyze/<id>.json (id
determinístico por hilo+contenido). Lógica en
src/modules/comms/analyze-shared.js
### bin/cwc-comms.js            CLI TRANSVERSAL del motor de Comunicaciones (patrón cwc-bus.js):
cualquier sesión registra/consulta una comunicación con un
contacto sin depender del server. Subcomandos: log/query/list/
contacts/contact-add/scan. Estado file-based en ~/.cwc-data/comms/
### bin/cwc-observe.js + (un)install-observer.js  observador de estado de Claude Code
### bin/cwc-inventory.js        regenera el INVENTARIO del proyecto (core/inventory.js) a mano (--force)
### bin/cwc-i18n-audit.js       wrapper delgado, determinístico y read-only de la
auditoría de i18n + ayuda (0 tokens). La lógica vive en
`src/modules/health/i18n-shared.js`, compartida con el chequeo rápido `i18n` de
Salud: cruza `t('clave', ...)` y `data-i18n*` con los JSON ingleses, contrasta
diccionarios y `MODULES` (incluido `git check-ignore`), detecta páginas sin
`initI18n`, y cruza `HELP_INDEX` con `helpBtn()` y sus loaders. Sin flags emite
tablas con estados; `--json` imprime el objeto compartido y `--soft` conserva
exit 0. Sale 1 ante cualquier problema. Nunca escribe.
### bin/cwc-unifi-scan.js       CLI del escaneo ESTRUCTURAL del UDM Pro a Pad (colección
`infraestructura-de-red`, PLAN-774). Wrapper delgado de `scanToPad()` de
`src/modules/unifi/inventory-shared.js`. NO usa el SDK (0 tokens, la
regla 6 no aplica) y es SOLO-LECTURA sobre el router: jamás escribe al
UDM Pro; lo único que escribe es Pad. `--dry-run`/`-n` reporta los
contadores sin ninguna escritura. Re-ejecutable e idempotente: upsert
por campo `uid`; una entidad ausente del escaneo se marca
`status='retirado'` + `lastSeen`, NUNCA se archiva (verificado
2026-07-28, console:PLAN-2138), y si reaparece vuelve a `presente` sin
duplicarse. Imprime `Creados/Actualizados/Retirados/Errores` y sale 1 si
el escaneo falla.
### bin/cwc-tolkien-refresh-runner.js  refresh de la DB LOCAL de Tolkien (TRUNCATE + reimport de
importers Zoho), DESACOPLADO (regla de oro/regla 2: operación larga que
DEBE sobrevivir a un reinicio de la web). NO usa el SDK (0 tokens:
comandos locales psql/infisical/pnpm — regla 6 no aplica). Interfaz por
archivos: ~/.cwc-data/tolkien-refresh.json (job que reserva el POST
/refresh-data; el runner persiste el resultado) + tolkien-refresh.log.
Lógica en src/modules/tolkien/refresh-shared.js. Si termina bien, encadena el
runner de fuentes completo sin duplicarlo si ya estaba activo.
### bin/cwc-tolkien-postpull-runner.js  mantenimiento DESACOPLADO del Tolkien local
después de que Actualizar mueve el SHA de main: serializa con refresh/plantilla
mediante `~/.cwc-data/tolkien-build.lock`, instala con lockfile y recompila
`packages/*`; solo si el build queda sano ejecuta `systemctl --user restart
tolkien-console`. NO usa el SDK (0 tokens). Estado atómico en
`~/.cwc-data/tolkien-postpull.json`, log append en `tolkien-postpull.log`; el
server solo reserva/spawnea y `GET /postpull-status` solo lee el archivo.
### bin/cwc-tolkien-sources-runner.js + bin/cwc-tolkien-glue.mts  refresh COMPLETO de
fuentes del workboard (identity/Desk/equipo dev/Pad/GitHub), desacoplado y con
estado en `~/.cwc-data/tolkien-sources.json` + log vecino. El `.mts` es el
puente ejecutado con el `tsx` de Tolkien: guarda DB local estricta antes de
importar Prisma/runners, exige Redis y URLs DB de producción unset, asegura el
equipo y corre Desk catálogo→fuentes en un solo proceso/cliente Zoho.
### bin/cwc-tolkien-template-build.js  build DESACOPLADO de la DB plantilla dormida tolkien_template
(migrate deploy + importers Zoho, luego la sella IS_TEMPLATE/no-conexiones;
al terminar re-clona los entornos vivos). Lógica en
src/modules/tolkien/template-shared.js. Regla de oro.
### bin/cwc-tolkien-env-runner.js  provisión DESACOPLADA de UN entorno Tolkien de sesión (worktree +
createdb TEMPLATE + systemd-run next dev). Recibe el id del entorno.
Lógica en src/modules/tolkien/env-shared.js. Regla de oro/regla 2.
### bin/cwc-updates-runner.js   ORQUESTADOR del BOTÓN ÚNICO de actualización (módulo `updates`,
2026-07-21), DESACOPLADO (regla de oro/regla 2). ÚNICO runner que REINICIA
el servicio y SOBREVIVE a ese reinicio (detached + KillMode=process, como
los chat-runners). NO usa el SDK (0 tokens: npm/claude/apt/systemctl
locales — regla 6 no aplica). Fases planning→draining→applying→verifying→
restarting→resuming con estado por heartbeat en ~/.cwc-data/updates-job.json
(reanudable). npm SOLO a `wanted` (estable); majors listados sin aplicar;
apt incluido; si node --check falla tras aplicar ⇒ ABORTA sin reiniciar.
Drena por interfono (core/bus.js) avisando a las sesiones antes de reiniciar
y mandando "continuar" después. Lógica en updates/orchestrate-shared.js
### bin/cwc-updates-analyze-runner.js  ANÁLISIS DE RIESGO IA de los saltos MAYORES
(módulo `updates` Fase B, 2026-07-21), DESACOPLADO (regla de oro). Por cada
major: baja el changelog con Node/`gh` (determinístico) + corrida IA
READ-ONLY doble capa (regla 6: Read/Grep/Glob, settingSources [], sonnet,
pool max 3) que lee cómo el proyecto usa el paquete → veredicto seguro/
riesgoso/rompe + confianza. Solo majors NO-beta. Estado en
~/.cwc-data/updates-risk.json (heartbeat, reanudable). Lógica en
updates/analyze-shared.js
### bin/cwc-ticket-context-runner.js  CONTEXTO ADICIONAL de un ticket/PR (módulo VIVO
`tickets/`, 2026-07-07): interpreta con IA una TRANSCRIPCIÓN de
una charla (con el cliente/equipo) y destila el contexto que le
sirve a quien vaya a trabajar el ítem. DESACOPLADO (regla de oro) +
READ-ONLY doble capa (regla 6: sonnet, 1 turno, CERO herramientas —
el texto viaja entero en el prompt). Interfaz por archivos:
~/.cwc-data/ticket-context/<id>.json (id determinístico por
key+transcripción). Al terminar AUTO-GUARDA el resultado en el
meta-store del ítem (decisión de Niko: auto-guardar al interpretar).
Lógica en src/modules/tickets/context-analyze-shared.js
### bin/cwc-forbidden-override.js  CAMINO DE OVERRIDE CONSCIENTE del gate de acciones
prohibidas por lección (M5, PLAN-1934). Determinístico, 0 tokens, config-free (no
importa core/config.js: corre desde cualquier cwd y sin .env). `--list` muestra las
reglas activas (seed de src/core/forbidden-actions.js + las del registro en disco) y
los últimos overrides; `<reglaId> "<motivo>"` registra un override de UN SOLO USO con
TTL en minutos (default 10, máx 60) en <dataDir>/forbidden-overrides.json, que el hook
`lessonsPreToolUseHook` CONSUME al dejar pasar la tool call. Exige un motivo de ≥20
caracteres: el registro de POR QUÉ se salteó la lección es el punto del mecanismo.
Exit 0 ok · 1 error de uso · 2 regla desconocida.
### bin/cwc-retro-context-rehydrate.js  migración one-shot por usuario que restaura
en los masters `work`/`pr` el texto completo de las lecciones de Mejora Continua
que el mecanismo anterior dejó como referencias `> ↩` en la sección §6. Lee cada
lección exclusivamente desde el Pad propio de su dueño y nunca escribe en Pad;
un usuario sin token se reporta y no frena a los demás. Es dry-run por defecto y
solo escribe con `--apply`; antes de cada master modificado crea junto a él un
backup 0600 `.bak-rehydrate-<YYYYMMDD-HHMMSS>`, y `saveContext` vuelve a
sincronizar el espejo de Tolkien de ese mismo scope. Nació de `console:BUG-3234`
y `console:PLAN-3235`; es una herramienta de migración, no un runner permanente.
### bin/cwc-tenant-mirror-reset.js  migración one-shot de `console:BUG-3241` que
limpia los `CLAUDE.local.md` de inquilinos heredados por el fan-out viejo. Es
dry-run por defecto y acepta `--apply` y `--user <id>`; compara byte a byte la
parte ajena al bloque `cwc:tickets-context` contra la del host y preserva sin
tocar cualquier archivo con contenido propio. Antes de limpiar crea al lado un
backup 0644 `.bak-mirror-reset-<YYYYMMDD-HHMMSS>` con el mismo dueño, deja la
cabecera personal del inquilino y regenera su bloque gestionado y playbook desde
el master de ese usuario (o la semilla del host). Nunca modifica el archivo del
host ni escribe en Pad; es una herramienta de migración, no un runner permanente.
