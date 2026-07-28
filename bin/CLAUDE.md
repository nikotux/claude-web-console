<!-- cwc:ficha-modulo -->
# bin — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
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
### bin/cwc-claude-login-runner.js  LOGIN COMPLETO de Claude por INQUILINO para
⚙ Sistema → Conexiones: runner PTY de `claude auth login --claudeai` con
HOME/workspace aislados mediante `userRunnerEnv`. Antes del spawn borra
explícitamente `CLAUDE_CODE_OAUTH_TOKEN`: si el CLI ve el setup-token se
considera ya autenticado y no ofrece el login de cuenta. Publica
estado/URL en `~/.cwc-data/claude-login-jobs/<user>.json`, recibe el código
por `<user>.code` mode 600 sin loguearlo y deja el volcado redactado en
`<user>.log`. El CLI escribe por sí mismo
`<userSpace>/.claude/.credentials.json`; el runner declara `ok` solo si ese
JSON contiene `claudeAiOauth.accessToken` y luego ejecuta best-effort
`claude auth status --json` con salida redactada. FAIL-CLOSED: rechaza al
usuario HOST antes de crear el job, porque su credencial real solo se
administra con su propio CLI. Timeout duro: 10 min.
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
Declara éxito por la aparición real de `.codex/auth.json` (`hasCodexCreds`),
NUNCA por el texto del CLI; la cancelación se detecta leyendo el estado
`cancelled` del job y corta el PTY. Timeout duro: 15 min.
### bin/_env-boot.js           bootstrap explícito del `.env` del REPO para runners cuyo
`cwd` está fuera del repo. Resuelve el fallo de `core/config.js` en procesos de
INQUILINO spawneados con `userRunnerEnv`: `dotenv/config` buscaría el `.env`
contra el workspace y abortaría por falta de `CWC_TOKEN`. También expone
`scrubEnvSecrets()`, que no corre al importar y permite retirar del entorno los
secretos del host después de que config los capturó. REGLA: debe ser el PRIMER
import de cualquier runner que use `userRunnerEnv` y cuya cadena de imports
arrastre `core/config.js`.
### bin/cwc-chat-runner.js      motor de UNA conversación (proceso propio, socket Unix).
GOTCHA multi-tenant: `_env-boot.js` debe ser su PRIMER import. Sin él, el chat
de un inquilino muere al arrancar con
`[config] Falta la variable obligatoria CWC_TOKEN en el .env`; el host no lo
detecta porque su runner hereda el env completo del server.
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
del panel Backup, DESACOPLADA del server (haiku, 1 turno, CERO
herramientas — doble capa regla 6 deniega TODO; el diff viaja en
el prompt, capturado por el server EN NODE). Interfaz por
archivos: ~/.cwc-data/commitmsg/<id>.json (job con files/diff que
escribe el POST; el runner persiste el mensaje en el MISMO
archivo). Lógica compartida en src/modules/backup/commitmsg-shared.js
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
de Teams de Comunicaciones, no uno nuevo). Una sola query lee el DM 1:1 con
el contacto Y destila el feedback en el mismo paso. Estado en
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
teams.json); (2) INTERPRETA con IA (sonnet, 1 turno, CERO herramientas,
doble capa deniega TODO) quién es la persona REAL detrás de cada mensaje
relayado y lo atribuye a un contacto conocido; (3) MERGE no destructivo
con chatbot.json (append+dedup, preserva el seed). CONSUME TOKENS ⇒ bajo
botón. Interfaz por archivos: chatbot.lock (heartbeat con fase) +
chatbot.json (resultado). Lógica en src/modules/comms/chatbot-shared.js
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
si Graph falla); (2) INTERPRETAR — corrida SDK (sonnet, 1 turno, CERO
herramientas, doble capa deniega TODO) que DEDUCE por el CONTENIDO
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
Lógica en src/modules/tolkien/refresh-shared.js
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
