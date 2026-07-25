<!-- cwc:ficha-modulo -->
# src/modules/retro — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### retro/                    MEJORA CONTINUA (ROAD-256, etiqueta UI "Mejora Continua"): meta-
aprendizaje de PROCESO. Al CERRAR CUALQUIER chat (Chat.close,
diferido 2s, GLOBAL — no solo ticket/tema), si supera un FILTRO
HÍBRIDO determinístico (shared.js queueRetroDistill: lee el
transcript jsonl con 0 tokens y exige tocó código ∨ ≥3 turnos de
usuario ∨ fue ticket/tema — los chats triviales NO gastan tokens),
encola una destilación de LECCIONES DE PROCESO (metodología/flujo/
instrucciones para trabajar mejor — NO bugs de código, NO resumen
de qué se hizo). Ejemplos: "leer la doc oficial ANTES de integrar
una herramienta nueva", "testear el cambio antes de cerrarlo".
CONSUME TOKENS ⇒ RUNNER DESACOPLADO (bin/cwc-retro-runner.js, regla
de oro) + TEXTO PURO read-only doble capa (regla 6: sonnet, maxTurns
1, settingSources [], PreToolUse deny + canUseTool deny — CERO
herramientas; la transcripción condensada viaja en el prompt). El
runner, tras destilar, hace el UPSERT determinístico en Pad local
(NO es tool del modelo — HTTP desde Node, como audio escribe su job).
STORE = Pad LOCAL (store.js, workspace 'console', colección
'mejora-continua'/MC, molde de learning/store.js: async, read-modify-
write). 1 lección = 1 item {status propuesta|aprobada|promovida|
descartada · category regla|convencion|metodologia|procedimiento|
herramienta|nota · project console|tolkien|otros · destination
(sugerido) memoria|claude-md|contexto|playbook|registro · recurrence
· confidence · fingerprint · sourceChats[] · content=Observación/
Lección}. RECURRENCIA = PRIORIDAD: una lección repetida NO se
duplica, sube su contador (dedup por fingerprint = sha1 de
categoría+título normalizado). OJO (gotcha resuelto en la verificación
E2E): el fingerprint por título es FRÁGIL — el modelo reformula el
mismo concepto distinto y crea near-duplicados; por eso el runner le
pasa al modelo las lecciones YA REGISTRADAS y le pide reusar el título
EXACTO de un concepto repetido (patrón "dedup vs seen" del loop de
Salud) → recién ahí el fingerprint coincide y mergea. NADA se
auto-aplica: el humano APRUEBA/DESCARTA y PROMUEVE. PROMOVER (admin)
enruta a un DESTINO real vía retro/promote-shared.js (ROUTER,
Fase 2/ROAD-256). Destinos cableados (PROMOTE_TARGETS): (a) memoria =
append de la lección a la nota mejora-continua.md en memory/ del
proyecto (console=ROOT · tolkien=config.projectDir) + línea en el
índice MEMORY.md, reusando projects/memory.js (whitelist + escritura
atómica + guard de hash); (b) claude-md = SECCIÓN GESTIONADA dedicada
con marcadores `<!-- cwc:mejora-continua:start/end -->` en el CLAUDE.md
del proyecto (console) o en CLAUDE.local.md (tolkien, NO versionado →
no se filtra al repo del equipo). Se RENDERIZA desde el CONJUNTO de
lecciones promovidas a claude-md (idempotente, patrón syncToTolkien de
tickets/context-store.js) → NUNCA toca lo de AFUERA de los marcadores
(Reglas duras/Convenciones a mano — verificado E2E). markPromoted
(store.js) sella status promovida + promotedTo + snapshot
recurrenceAtPromotion/promotedAt (campos del schema, ya listos para el
LOOP de Fase 6). La próxima sesión auto-carga el destino. DESTINOS
COMPLETOS del router (PROMOTE_TARGETS): contexto (Fase 3) = apéndala al
bugfix-work/pr (getContext/saveContext de tickets/context-store.js) →
se inyecta en chats de ticket/PR y se ESPEJA a la CLAUDE.local.md de
Tolkien (idempotente por id) · playbook (Fase 4) = crea un item DRAFT
en la colección `playbooks` de Pad (pad-service-client.createItem). Solo
memoria/claude-md exigen dir de proyecto (TARGETS_NEED_DIR); contexto/
playbook no. CURADURÍA IA (Fase 5): runner desacoplado
bin/cwc-retro-curate-runner.js (lógica curate-shared.js, TEXTO PURO
regla 6; el server junta lessons + hardRulesText() en el job) que
detecta duplicados (dedup SEMÁNTICO, más allá del fingerprint),
contradicciones, redundantes (ya en una Regla Dura), consolidables y
huecos. Propuestas NUNCA auto-aplicadas: apply reusa el CRUD
(merge=mergeLessons suma recurrencia+chats y borra · dismiss=setStatus
descartada · consolidate=upsertLesson+delete). LOOP QUE APRENDE (Fase
6): computeEffectiveness (store.js, DERIVADO 0 tokens) sobre una
lección promovida = {state, hits, ageDays} donde hits = recurrencias
NUEVAS desde promotedAt → observando | efectiva (≥7d sin reincidir) |
reincide (volvió a pasar pese a promovida → la UI re-ofrece promover =
"⬆️ Escalar" a un destino más fuerte).
Ruta /api/retro (auth; PROMOVER/CURAR requieren admin, tocan memorias/
CLAUDE.md/tokens): GET / {lessons,counts} · GET /activity · GET /targets
{destinos} · POST /curate (admin, spawn curaduría) · GET /curation
(poll) · POST /curate/apply {action:merge|dismiss|consolidate} (admin) ·
GET /:id · POST /:id/approve · POST /:id/dismiss · POST /:id/promote
{target?,kind?} (admin; target ∈ memoria|claude-md|contexto|playbook) ·
POST /:id/delete. OJO ORDEN: /activity, /targets, /curate, /curation,
/curate/apply literales ANTES de la paramétrica /:id. Estado
file-based del job en ~/.cwc-data/retro/<id>.json (id sha1 del
sessionId; dedup: no re-gasta si ya done/fresco) + retro.log +
retro-activity.json (log local append-only). Frontend
public/js/modules/retro/retro.js: sección de sidebar IZQUIERDA
(data-module="retro", tras comms) con badge de propuestas + tablero
modal colapsable+árbol (.mc-* en style.css) que agrupa por estado.
UX SIMPLIFICADA (2026-07-12, pedido de Niko: el tablero abrumaba con
~7 botones por lección). Modelo mental de UNA decisión por lección:
grupos "🟡 Nuevas · 🔖 Guardadas para después · ✅ Adoptadas · 🗑️
Descartadas". Una lección nueva muestra solo: (a) botón PRIMARIO
"👍 Adoptar → <destino sugerido>" que aplica el `destination` que la IA
ya sugirió (adoptBlock; el destino se resalta con NOMBRE HUMANO —
TARGET_LABEL: 📓 Recordatorio · 📕 Regla permanente · 🎫 Guía tickets/PRs
· 📘 Procedimiento) + un "▾" que revela los otros destinos aplicables
(data-act=more togglea .mc-dests[hidden]; applicableTargets filtra:
memoria/claude-md solo si el proyecto tiene dir); (b) "🔖 Guardar" (=
estado 'aprobada' reetiquetado "guardar para después", POST /:id/approve);
(c) "👎 Descartar". "Adoptar" ES la aprobación (el viejo botón "Aprobar"
suelto se eliminó por confuso). Adoptadas: badge de efectividad (Fase 6)
+ "⬆️ Escalar" solo si reincide. Descartadas: "↩️ Reabrir" (POST
/:id/reopen → 'propuesta') + "✕ Eliminar" (permanente, solo acá).
Eliminar ya NO aparece en las demás. La CURADURÍA es mantenimiento
APARTE: botón "🧹 Ordenar el registro" arriba (no por-lección). NO
confundir con learning/ (🎓 Temas de aprendizaje = estudio de Niko):
retro = el SISTEMA aprende a mejorar su propio proceso.
"💬 FEEDBACK DE CHRIS" (2026-07-19, pedido de Niko): categoría NUEVA
`feedback-cliente` de la MISMA colección Pad (`mejora-continua`) — NO un
módulo aparte — para reusar tal cual el dedup por recurrencia y el destino
`contexto` (al adoptar una, se apendea a bugfix-work.md → se inyecta SOLA
en TODO chat de ticket/PR futuro, sin depender de que "se parezca" a otro
por archivos/tags como hace la Biblioteca de Soluciones de bugfixes). A
diferencia de una lección de proceso, ésta es retroalimentación PUNTUAL de
un cliente/revisor sobre un bug/PR — llegada por correo, Teams o una
llamada — y suma el campo `sourceRefs[]` (TKT-n/PR-n/FEAT-n normalizados,
`normRefs`/`store.js`) para poder agrupar/filtrar "todo lo que dijo Chris
sobre el TKT-519" (chip clickeable en el tablero, `data-ref-filter`; el
schema de la colección en Pad se actualizó a mano vía `pad_collection
update` para sumar la opción `feedback-cliente` al campo `category` y el
campo `sourceRefs` — un `category` no listado ahí lo RECHAZA el server de
Pad con 500, aunque el `oneOf()` de `store.js` ya lo validara del lado
Node). DOS vías de ingesta, ambas DESACOPLADAS (regla de oro) y TEXTO PURO
read-only (regla 6 — CERO herramientas vía `core/text-only-query.js`,
igual que la destilación de proceso): (a) MANUAL — composer "💬 Feedback de
Chris" del tablero: pegás el texto (+ ticket opcional) →
`POST /api/retro/feedback` → `bin/cwc-retro-feedback-runner.js`
(`retro/feedback-shared.js`) interpreta y puede extraer VARIAS piezas de
feedback de un mismo pegado; (b) AUTOMÁTICA — botón "📧 Traer feedback de
correo" (admin, confirm, consume tokens): `POST /api/retro/email-refresh` →
`bin/cwc-retro-email-runner.js` (`retro/email-shared.js`) escanea el correo
del contacto `chris` (reusa `comms/shared.js` readContacts/readSelf — el
email ya vive ahí, no se duplica el contacto) vía el MISMO MCP de Graph que
ya usa Teams (`graph_read_email`/`graph_read_email_body` — el scope
Mail.Read/Mail.Send YA está concedido en la app de Entra de Tolkien,
verificado 2026-07-19: NO hizo falta ningún consentimiento nuevo).
Allowlist EXPLÍCITA POR NOMBRE (`emailReadAllowed`, no por verbo como
`graphReadAllowed` de Teams — la mailbox es más sensible): SOLO
`graph_read_email`/`graph_read_email_body` pasan; `graph_send_email`/
`graph_reply_email`/`graph_create_draft`/adjuntos quedan denegados en las
DOS capas aunque el MCP los tenga. `bin/cwc-retro-email-runner.js` está en
`CROSS_WORLD_ALLOW` (health/index.js, check `cross-world`): cruza a
`config.projectDir` de Tolkien de donde cuelga el MCP, igual que el
escaneo de Teams — no enlaza los Pad. Estado en
`~/.cwc-data/retro-feedback-<id>.json` (job manual) y
`retro-email-scan.json` + `retro-email.lock` (heartbeat pid-aware, patrón
triage/Teams — dedup: `spawnRetroEmailRunner` reserva el lock con el pid
REAL del hijo en el mismo tick del spawn). GOTCHA verificado en la
construcción: si Pad rechaza TODOS los ítems al persistir (p.ej. un campo
no en el schema), el job NO puede quedar 'done' con "0 nuevas" en
silencio — TODOS los runners de esta familia revisan
`created+merged===0` con `items.length>0` y lanzan error para que se vea
el fallo real.
(c) AUTOMÁTICA por TEAMS (mismo pedido, 2026-07-19): botón "📨 Traer
feedback de Teams" → `POST /api/retro/teams-refresh` →
`bin/cwc-retro-teams-runner.js` (`retro/teams-feedback-shared.js`) — MISMA
estructura que la de correo, pero REUSA TAL CUAL el allowlist ya probado en
producción `graphReadAllowed` de `comms/teams-shared.js` (verbo-based:
list/read/get/members/presence/detail/view/info sobre graph_*/teams_* — no
uno explícito por nombre como el de correo, porque el patrón de Teams ya es
el aceptado) para leer el DM 1:1 con el contacto `chris`. Una sola query
lee Y destila en el mismo paso (a diferencia del escaneo de Teams de
Comunicaciones, que solo lee). Estado en `~/.cwc-data/retro-teams-scan.json`
+ `retro-teams.lock`; `bin/cwc-retro-teams-runner.js` sumado a
`CROSS_WORLD_ALLOW`. Las TRES piezas (manual/correo/Teams) caen en la MISMA
lista del tablero (ícono 💬, chip de ticket) — se aprueban/adoptan/
descartan con el mismo flujo de siempre, nada se auto-aplica.

## Linkeo automático al grafo de Pad (BUG-1878)

Toda lección que se crea en `mejora-continua` recibe un link `implements` hacia su bucket `MC · *` de la colección `arquitectura`, elegido por su `category` (mapa `MC_SUN_BY_CATEGORY` en `store.js`). El camino de lección RECURRENTE también lo intenta, así que una lección vieja que quedó huérfana se auto-sana al reincidir. El playbook que crea `promoteToPlaybook` recibe `implements` hacia la lección de origen.

Los tres links son BEST-EFFORT (nunca rompen la destilación ni la promoción) y se SALTAN cuando el `ctx` es de un inquilino (workspace `tenant-*`), porque los ítems `ARQUI-*` solo existen en el workspace `console` del host. Regla: `CONVE-1257` del Pad + regla dura 11 del `CLAUDE.md` raíz; detalle en `docs/pad-grafo.md`.
