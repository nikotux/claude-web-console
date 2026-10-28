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
AISLAMIENTO MULTI-TENANT (`console:PLAN-2267`, B7; absorbe
`console:TASK-2122`): el borde HTTP deriva `systemScopeFor(req).user` y toda
persistencia propia —jobs, logs, locks, actividad, feedback, curaduría y
verificación— resuelve su ruta POR OPERACIÓN con `userDataDir(owner)`. Un
runner de inquilino recibe HOME y `CWC_DATA_DIR` aislados mediante
`userRunnerEnv`; dentro del runner los helpers caen en `resolveDataDir()`. El
transcript se lee desde `userClaudeDir(owner)` o desde el `claudeDir` ya
resuelto por el llamador. No quedan constantes de módulo que congelen el HOME
del server; el host conserva las rutas históricas bajo `~/.cwc-data`.
Salud 174 / `console:PLAN-3495`: `owner-dirs.js` es el resolver inyectado
config-free; en runners valida el dueño contra `CWC_DATA_DIR` y falla cerrado.
`server-shared.js` es el puente que importa `user-space`, instala resolvers y
lo cargan `chat/index.js`, `retro/index.js`, `sweep-shared.js` y el CLI rehydrate.
`promote-targets.js` deja las literales de destinos libres de config global.
`sweep-shared`/`sweep-runner` y context-rehydrate son host-only y pueden cargar `user-space`.
STORE = Pad LOCAL (store.js, workspace 'console', colección
'mejora-continua'/MC, molde de learning/store.js: async, read-modify-
write). 1 lección = 1 item {status propuesta|aprobada|promovida|
descartada · category regla|convencion|metodologia|procedimiento|
herramienta|nota · project console|tolkien|otros (BUG-1928: feedback de
Chris SIEMPRE usa `tolkien`; NUNCA volverlo a `otros`, porque
`projectDirFor()` da `null` y `TARGETS_NEED_DIR` veda memoria/claude-md,
los dos destinos que Claude Code auto-carga) · destination
(sugerido) memoria|claude-md|contexto|convencion|contrato|invariante ·
recurrence
· confidence · fingerprint · sourceChats[] · content=Observación/
Lección}. RECURRENCIA = PRIORIDAD: una lección repetida NO se
duplica, sube su contador (dedup por fingerprint = sha1 de
categoría+título normalizado). OJO (gotcha resuelto en la verificación
E2E): el fingerprint por título es FRÁGIL — el modelo reformula el
mismo concepto distinto y crea near-duplicados; por eso el runner le
pasa al modelo las lecciones YA REGISTRADAS y le pide reusar el título
EXACTO de un concepto repetido (patrón "dedup vs seen" del loop de
Salud) → recién ahí el fingerprint coincide y mergea. NADA se
auto-aplica: el humano APRUEBA/DESCARTA y PROMUEVE. BUG-1930, defecto
hermano en el destilador de PROCESO: `retroPrompt` limita esa lista con
`RETRO_DEDUP_LIMIT=120`, pero el orden útil lo decide el CALLER
(`bin/cwc-retro-runner.js`), no `shared.js`, cuyo tope solo protege el
tamaño del prompt. El caller pone `promovida`/`aprobada` primero, el
resto después y `descartada` última; dentro de cada grupo ordena por
`recurrence` y luego `updatedAt`, ambos descendentes, recorta y loguea
cuántas quedaron afuera. Es imprescindible porque `listLessons` entrega
`propuesta` → `aprobada` → `promovida` → `descartada`: la ventana mágica
anterior de 40 se llenaba con lo menos útil. Medición real 2026-07-26:
275 lecciones, 235 `promovida` ⇒ 195 promovidas quedaban invisibles; sin
el título exacto no coincide el fingerprint, no sube `recurrence` y el
semáforo queda verde por falta de evidencia. NO confundir esta ventana
de proceso con `FEEDBACK_DEDUP_LIMIT=30` de correo/Teams. PROMOVER (admin)
enruta a un DESTINO real vía retro/promote-shared.js (ROUTER,
Fase 2/ROAD-256). `PROMOTE_TARGETS` tiene SEIS destinos vigentes:
`memoria`, `claude-md`, `contexto`, `convencion`, `contrato` e
`invariante`. `LEGACY_PROMOTE_TARGETS=['playbook','registro']` conserva
la lectura/render de los valores históricos, pero el gate de escritura
no permite elegirlos. `playbook` se deprecó porque su molde copiaba
literalmente la lección y produjo 85 drafts inejecutables en Pad. (a) memoria =
append de la lección a la nota mejora-continua.md en memory/ del
proyecto (console=ROOT · tolkien=config.projectDir) + línea en el
índice MEMORY.md, reusando projects/memory.js (whitelist + escritura
atómica + guard de hash); (b) claude-md = SECCIÓN GESTIONADA dedicada
con marcadores `<!-- cwc:mejora-continua:start/end -->` SOLO en
CLAUDE.local.md de Tolkien (NO versionado → no se filtra al repo del
equipo). Para `console`, `promoteToClaudeMd` retorna sin escribir: la
lección queda en Pad y el índice enrutador la trae al cerrar trabajo; NO
volver a inflar el CLAUDE.md raíz. En Tolkien se RENDERIZA desde el
CONJUNTO de lecciones promovidas a claude-md (idempotente, patrón
syncToTolkien de tickets/context-store.js) → NUNCA toca lo de AFUERA de
los marcadores (Reglas duras/Convenciones a mano — verificado E2E). markPromoted
(store.js) sella status promovida + promotedTo + snapshot
recurrenceAtPromotion/promotedAt (campos del schema, ya listos para el
LOOP de Fase 6). La próxima sesión auto-carga el destino.
El bloque final pasa por el guard compartido `core/pad-world-refs.js` ANTES de
cualquier lectura/escritura del archivo externo: si queda un ref foráneo, se
loguean todas sus ocurrencias con línea y la promoción tira error
`reason=foreign-refs`. Las citas legítimas de una lección no inutilizan el
destino: al renderizar se reemplaza un `MC-*` conocido por el título de esa
lección y los demás refs internos por su tipo semántico con el identificador
omitido, también dentro de fences. El comentario generado tampoco incluye refs
internos. Así el detector queda como fail-closed contra cualquier fuga que el
saneado no haya cubierto, sin importar desde qué generador se escribe
`CLAUDE.local.md`.
DESTINOS COMPLETOS del router: contexto (Fase 3, BUG-1927) =
`promoteToContext` usa `splitTopSections` y la inserta idempotente por
`lesson.id` dentro de `## 6. Feedback adoptado` de bugfix-work/pr,
creando esa sección si falta → se inyecta en chats de ticket/PR y
`saveContext` la ESPEJA a la CLAUDE.local.md de Tolkien. Es `## 6.` y NO
`## 5.` porque el contexto `pr` persistido ya reserva `## 5. Quick
reference — end-to-end flow`. BUG-1973 cerró el cruce de mundos:
`contextRouteForProject` usa SIEMPRE `lesson.project`; solo `tolkien`
escribe en ese master/espejo, mientras `console` y `otros` permanecen
únicamente en su lección canónica de Pad interno. Un project vacío o
desconocido falla cerrado con `reason=context-project-unknown`; no existe
default hacia Tolkien. Por eso una promoción `contexto` interna aporta
exactamente 0 lecciones al espejo. `console:BUG-3234` /
`console:PLAN-3235` reemplazaron el viejo trinquete de presupuesto: adoptar a
`contexto` SIEMPRE escribe en el master del usuario y el tamaño auto-cargado lo
limita el render por ventanas de `tickets/context-store.js`. Cada FULL lleva
un marcador hash y `retro-rank`, cuyo valor inicial es la recurrencia; volver a
adoptar una FULL sube el rank, y volver a adoptar una REF o ARCHIVED la restaura
completa desde Pad con el mayor rank. Después de cada adopción,
`compactContextMaster` consulta `planContextWindows`: las FULL/REF fuera de las
ventanas se sustituyen en el master por `retro-archived`, de modo que pueden
restaurarse sin que referencias permanentes consuman el presupuesto. La ruta
deriva `systemScopeFor(req)` y lo pasa a `getContext`, `saveContext`, el render
del guard y la planificación; adoptar como otro usuario ya no toca el contexto
del host. El render del contexto sanea refs internas antes del guard compartido;
el guard sigue siendo la última barrera fail-closed. Si cualquier destino falla
después de `markPromoted`, `revertPromotion` repone juntos `status`,
`promotedTo`, `promotedAt` y `recurrenceAtPromotion`, sin metadatos rancios.
`promote-shared.js` exporta
`sanitizeContextEntry(title, body)` y `promoteToContext` lo aplica ANTES
de armar la entrada: colapsa saltos de línea del título que vive en
`### …`, degrada cada línea `## ` del cuerpo libre a `### ` y cierra el
fence si la cantidad de líneas que empiezan con ``` es impar. El cuerpo
lo genera un modelo desde feedback de Chris sobre PRs, cuyas plantillas
traen `## Summary`/`## Verification`: un `## ` suelto abre otra sección
top-level, deja media lección fuera de `## 6.`, no matchea
`MIRROR_RULES` y la desvía al playbook SIN error visible; un fence impar
es peor, deja `inFence` abierto y se come todos los encabezados
posteriores. Antes el append crudo caía dentro de `## 4. Lecciones
registradas`, que no matcheaba ninguna `MIRROR_RULES`. La migración
BUG-1927 ya CORRIÓ el 2026-07-26: re-ruteó las 17 lecciones adoptadas
atrapadas ahí desde el master `~/.cwc-data/bugfix-context.md` hacia
`## 6. Feedback adoptado`. Estado real: `~/tolkien/CLAUDE.local.md`
pasó de 0 lecciones/32.932 bytes a 17/48.864, y
`~/tolkien/.cwc-ticket-playbook.md` de 17/52.009 a 0/36.102. No es
contenido nuevo: migró de lectura A DEMANDA a AUTO-CARGA y el total de
ambos archivos casi no cambió. NO borrar los backups
`~/.cwc-data/bugfix-context.md.bak-BUG1927-2026-07-26` y
`~/tolkien/CLAUDE.local.md.bak-BUG1927-2026-07-26` · convencion =
`promoteToConvention` crea una regla `active` en la colección
`conventions`, con `scope:all`, `priority:should` y trigger derivado de
la categoría. Solo reutiliza título si el contenido confirma la procedencia
de la misma lección MC; si no, crea otra convención. El cuerpo termina con la procedencia MC y el link
`implements` hacia la lección es best-effort. Solo memoria/claude-md
exigen dir de proyecto (`TARGETS_NEED_DIR`); contexto/convencion no.
`console:BUG-3241`: cada destino que escribe archivos lo hace en el espacio de
quien adopta. El host conserva las rutas históricas; para un inquilino Tolkien
resuelve `<workspace>/tolkien` y `memoria` usa además su `userId` para escribir
en su propio `~/.claude`. Mi Consola solo existe para el host, por lo que para
un inquilino los destinos de archivo sobre `console` y el destino `invariante`
no aplican.
Los dos destinos verificables de PLAN-1936 cierran el lazo
sin tokens. `contrato` agrega una fila de obligación en `CONVE-1969`,
el contrato-hogar con parent PLAN-1936, y registra su check para que
`emitTasks()` abra un PEND automático cuando se incumple y lo cierre
automáticamente cuando vuelve a cumplirse. `invariante` llama
`appendLearnedInvariant({match,text})`. BUG-1977 resuelto en el almacén:
`appendLearnedInvariant` normaliza `match` y `text` a los mismos límites
que persiste (200/400) ANTES de comparar, por lo que también deduplica
contra entradas históricas sin migrar el formato. `invariantTextFor`
mantiene el límite de 400 como defensa en profundidad porque el texto
entra en el prompt del auditor; además se queda con la **Lección** y
descarta la **Observación**: un invariante es una regla, no el caso que
la originó. La corrección ya no depende del recorte del llamador. El glob del
invariante y el ref del contrato salen de CAMPOS DECLARADOS en el cuerpo
(`**Archivos:** <glob>` / `**Contrato:** CONVE-n`) y NUNCA se infieren
de la prosa: si falta el dato, falla cerrado con un mensaje accionable
(trampa del trigger circular, PLAN-1955). La interfaz pública es
`applicableTargetsFor(lesson,scope?)` /
`targetBlockReason(target,lesson,explicitMatch?,scope?)` — el tercer parámetro
es el glob explícito de quien promueve; sin él la aplicabilidad se
calcula SOLO con lo declarado en el cuerpo (correcto para OFRECER el
destino en el tablero), pero el gate de la ruta sí lo cuenta — si no, el
`match` que forwardea `/promote` sería código muerto (bug detectado en
la verificación en vivo de PLAN-1936) /
`invariantMatchFor(lesson,explicit)` /
`contractCheckIdFor(lesson)` → `leccionNNN` (sin barras:
`markerFor` no las admite) / `contractRefFor` /
`LESSONS_CONTRACT_REF` + `LESSONS_CONTRACT_TITLE` /
`TARGETS_NEED_CONSOLE=['invariante']`. La ruta
`/api/retro/:id/promote` usa `targetBlockReason` como gate único y
forwardea `{kind,match,contract}`; la ruta forwardea además `rule`
(predicado declarativo `fileExists`/`grepPresent`/`grepAbsent` que evalúa
la capa `leccion` de `core/pad-contracts.js`); una obligación SIN regla
entra igual pero queda como verificación manual — `skipped` con motivo,
nunca «incumplida». `GET /api/retro` manda `targets` +
`targetReasons` POR LECCIÓN y el tablero los consume: ya no duplica
`NEED_DIR`. CURADURÍA IA (Fase 5): runner desacoplado
bin/cwc-retro-curate-runner.js (lógica curate-shared.js, TEXTO PURO
regla 6; el server junta lessons + hardRulesText() en el job) que
detecta seis dimensiones: duplicados (dedup SEMÁNTICO, más allá del
fingerprint), contradicciones, redundantes (ya en una Regla Dura),
consolidables, huecos y `destinos` equivocados. El prompt incluye
`promotedTo || destination` por lección y marca `playbook` como
deprecado. Propuestas NUNCA auto-aplicadas: apply reusa el CRUD
(merge=mergeLessons suma recurrencia+chats y borra · dismiss=setStatus
descartada · consolidate=upsertLesson+delete · redestinar cambia SOLO
`destination`, sin promover). HIGIENE DETERMINÍSTICA
(`hygiene-shared.js`, 0 TOKENS): lee Pad y compara strings para listar
cuatro grupos: copias redundantes del viejo molde de playbooks, destinos
deprecados (la lección se redestina), referencias rotas (el ítem del destino
vigente desapareció) y drafts huérfanos de lecciones descartadas.
`GET /hygiene` es lectura autenticada; `POST /hygiene/apply` es admin, acepta
`delete-copies`, re-escanea en backend y solo borra refs elegibles de la
colección `playbooks`. El tablero lo muestra en un bloque colapsado y
explicita que no consume tokens. LOOP QUE APRENDE (Fase 6):
computeEffectiveness (store.js, DERIVADO 0 tokens) sobre una lección promovida
= {state, hits, ageDays, hitsInternal, external} → observando | efectiva (≥7d
sin reincidir) | reincide (volvió a pasar pese a promovida → la UI re-ofrece
promover = "⬆️ Escalar" a un destino más fuerte). `hits` SUMA dos señales de
distinta naturaleza. (a) INTERNA (`hitsInternal`) = recurrencias nuevas desde
`promotedAt`, o sea re-destilaciones con el mismo fingerprint. (b) EXTERNA
(`external.rounds`, M1 de DOC-1926 / PLAN-1937) = rondas de review de Chris
sobre los PRs de `sourceRefs` POSTERIORES a `promotedAt`. La externa existe
porque la interna es ESTRUCTURALMENTE CIEGA al feedback de Chris (BUG-1930): el
destilador de chats no puede emitir la categoría `feedback-cliente`, el
fingerprint la incluye, y por lo tanto `recurrence` de una lección de Chris NO
PUEDE SUBIR NUNCA — el semáforo no podía ponerse en rojo aunque el
incumplimiento fuera evidente. Se suman a propósito y no se muestran por
separado en el badge: el tablero renderiza "🔴 reincide ×hits" y una
reincidencia observada AFUERA es evidencia tan real como una re-destilación; el
desglose queda disponible en `hitsInternal`/`external` para quien lo necesite.
Una lección SIN evidencia externa (`external:null`) se comporta EXACTAMENTE
como antes — el cambio no toca a las 233 lecciones de proceso. MEDIDOR EXTERNO
(`verify-shared.js` + `bin/cwc-retro-verify-runner.js`, 0 TOKENS): el runner
lee los PRs con `fetchPrRich` de `comms/pr-read-shared.js` (lector ÚNICO ya
cacheado 60 s — NUNCA `gh` propio) y cuenta las rondas del revisor. La identidad
del revisor NO se hardcodea: sale de
`readContacts().find(c=>c.id==='chris').github` (hoy `cswenor`); sin ese
contacto el runner falla CERRADO con un mensaje accionable. Una review
`APPROVED` NO cuenta como ronda — es lo contrario, evidencia de que la entrega
pasó; cuentan las reviews CHANGES_REQUESTED/COMMENTED/DISMISSED y TODOS los
comentarios de issue del revisor, porque medido sobre el histórico real de
Tolkien el feedback sustantivo de Chris llega casi siempre como comment, no
como review formal. RESOLUCIÓN DE `sourceRefs` (`prRefsFrom`): `PR-n` es
DIRECTO; `TKT-n` es CANDIDATO — la ingesta de julio-2026 guardó números de PR
bajo el prefijo TKT (MC-740/741/742/743/745/746) pero `TKT-n` también puede ser
un ticket de Desk (MC-744 → `TKT-617`, que no existe como PR) — y solo cuenta
si ese PR EXISTE y es NUESTRO (autor = `readSelf().github`; si el autor es el
propio revisor, como en los #353/#354 que Chris escribió para reemplazar el
#275, sus rondas ahí no miden nuestra ejecución); `DESK-n`/`FEAT-n` nunca son
PRs. Todo lo que no resuelve queda LISTADO en `external.unresolved` con el
motivo — el medidor no adivina en silencio. Estado en
`~/.cwc-data/retro-verify.json` + `retro-verify.lock` (heartbeat pid-aware: un
lock fresco cuyo proceso ya murió NO bloquea el reintento) +
`retro-verify.log`; `readVerifyState()` memoiza por mtime+size para no releer el
archivo una vez por lección en cada request. REANUDABLE de verdad (regla dura
2, verificado con `kill -9` a mitad de corrida): escribe el estado tras CADA
PR, y al relanzarse reusa las entradas cuyo `checkedAt` esté dentro de
`PR_ENTRY_TTL_MS` (30 min) — `--full` las ignora. Rutas:
`POST /api/retro/verify` (admin, dispara el runner) y
`GET /api/retro/verify` (poll: status/progress/summary/lessons/stale), ambas
LITERALES y por lo tanto ANTES de la paramétrica `/:id`. Además `GET /api/retro`
AUTO-CEBA el medidor: si el resultado está vencido (`VERIFY_TTL_MS` = 6 h) y no
hay corrida viva, spawnea el runner sin bloquear la respuesta — acotado a admin
del host sobre el workspace `console`, así un inquilino nunca dispara lecturas
del repo externo. OJO CON EL EFECTO ESPERADO: al conectar el medidor las
métricas EMPEORAN. Corrida real del 2026-07-26: de las 12 piezas de Chris, 8
cambiaron de estado y 3 de ellas (MC-740, MC-741, MC-746) pasaron de 🟢 efectiva
a 🔴 reincide — eran verdes por AUSENCIA de evidencia. Eso es la prueba de que
funciona, NO una regresión: no lo "arregles" volviéndolo a verde.
CONVENCIÓN CANÓNICA DE `sourceRefs`: `PR-n` significa un pull request de
GitHub del repo Tolkien y es el ÚNICO prefijo que deben emitir los datos nuevos
o migrados para un PR; `TKT-n` significa un ticket de Zoho Desk; `DESK-n` es
un alias explícito histórico para un ticket de Desk; `FEAT-n` identifica una
feature. `TKT`/`DESK`/`FEAT` nunca deben emitirse para un PR. Un `#n` sin tipo
es ambiguo: la ingesta debe resolver su fuente antes de persistirlo. El trato de
`TKT-n` como candidato en `prRefsFrom` se conserva SOLO como compatibilidad
defensiva con datos históricos: verifica existencia y autor, nunca confía en el
prefijo, y mantiene los fallos en `external.unresolved`.
Ruta /api/retro (auth; PROMOVER/CURAR requieren admin, tocan memorias/
CLAUDE.md/tokens): GET / {lessons,counts} · GET /activity · GET /counts devuelve
solo { counts } (existe porque la portada de Cabina descartaba 1,1 MB para leer
5 números; es literal, debe quedar antes de /:id y no dispara el auto-cebado
del verify runner) · GET /targets {destinos} · POST /curate
(admin, spawn curaduría) · GET /curation
(poll) · POST /curate/apply
{action:merge|dismiss|consolidate|redestinar} (admin) · GET /hygiene ·
POST /hygiene/apply {action:delete-copies,refs[]} (admin) ·
GET /:id · POST /:id/approve · POST /:id/dismiss · POST /:id/promote
{target?,kind?} (admin; target ∈
memoria|claude-md|contexto|convencion|contrato|invariante) · POST
/:id/delete. OJO ORDEN: /activity, /counts, /targets, /curate, /curation,
/curate/apply, /hygiene y /hygiene/apply literales ANTES de la
paramétrica /:id. Estado
file-based del job en ~/.cwc-data/retro/<id>.json (id sha1 del
sessionId; dedup: no re-gasta si ya done/fresco) + retro.log +
retro-activity.json (log local append-only).
Blindajes HTTP A24: email/Teams/verify requieren admin DEL HOST; `full` es booleano estricto y los lotes `refs`/`merge`/`ids` aceptan hasta 50 elementos.
Los ids de `/feedback/:jobId` son SHA-1 truncados a 24 hex; cualquier otro formato responde 400. El auto-cebado de verify espera 30 min tras un error.
Frontend public/js/modules/retro/retro.js: sección de sidebar IZQUIERDA
(data-module="retro", tras comms) con badge de propuestas + tablero
modal colapsable+árbol (.mc-* en style.css) que agrupa por estado.
UX SIMPLIFICADA (2026-07-12, pedido de Niko: el tablero abrumaba con
~7 botones por lección). Modelo mental de UNA decisión por lección:
grupos "🟡 Nuevas · 🔖 Guardadas para después · ✅ Adoptadas · 🗑️
Descartadas". Una lección nueva muestra solo: (a) botón PRIMARIO
"👍 Adoptar → <destino sugerido>" que aplica el `destination` que la IA
ya sugirió (adoptBlock; el destino se resalta con NOMBRE HUMANO —
TARGET_LABEL: 📓 Recordatorio · 📕 Regla permanente · 🎫 Guía tickets/PRs
· 📏 Convención · 📚 Obligación · 🛡️ Invariante; 📘 Procedimiento
(histórico) queda solo para render de datos viejos) + un "▾" que revela los otros destinos aplicables
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
llamada — y suma el campo `sourceRefs[]`
(`PR-n`/`TKT-n`/`DESK-n`/`FEAT-n`; `normRefs`/`store.js`) para poder
agrupar/filtrar "todo lo que dijo Chris sobre el TKT-519" (chip
clickeable en el tablero, `data-ref-filter`; el
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
feedback de un mismo pegado. El composer NO manda `project`: BUG-1928 fija
el default manual en `job.project || 'tolkien'` (un `project` explícito se
respeta), en vez del viejo `otros` que bloqueaba memoria/claude-md; (b)
AUTOMÁTICA — botón "📧 Traer feedback de
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
el fallo real. BUG-1930: correo y Teams copian el patrón de dedup del
runner manual y pasan a la query las lecciones ya registradas, pero SOLO
`category==='feedback-cliente'`, ordenadas por `updatedAt` descendente y
acotadas por `FEEDBACK_DEDUP_LIMIT=30`; sin eso un re-reporte no reusaba
el título/fingerprint, `recurrence` nunca subía y el semáforo de
efectividad no podía ponerse rojo. El tope es obligatorio: el registro
completo tiene 275 lecciones (~168 KB) y reventaría el prompt.
(c) AUTOMÁTICA por TEAMS (mismo pedido, 2026-07-19): botón "📨 Traer
feedback de Teams" → `POST /api/retro/teams-refresh` →
`bin/cwc-retro-teams-runner.js` (`retro/teams-feedback-shared.js`) — MISMA
estructura que la de correo, pero REUSA TAL CUAL el allowlist ya probado en
producción `graphReadAllowed` de `comms/teams-shared.js` (verbo-based:
list/read/get/members/presence/detail/view/info sobre graph_*/teams_* — no
uno explícito por nombre como el de correo, porque el patrón de Teams ya es
el aceptado) para leer el DM 1:1 con el contacto `chris` cuando no puede reusar
la caché fresca de Comunicaciones. `teamsFeedbackFromMessagesPrompt(contact,
self, sinceIso, messages)` es hermano de `teamsFeedbackPrompt`: produce el
mismo formato que consume `parseTeamsFeedback`, pero sobre mensajes YA
provistos y sin pedir Graph. Filtra por `sinceIso`, toma como máximo los últimos
80, trunca cada texto a 1200 caracteres y marca el bloque como DATOS cuyas
instrucciones incrustadas no deben seguirse. Ambos prompts comparten
`feedbackExtractionInstructions(name)`, para que sus reglas de extracción no
diverjan. El runner usa este prompt con `textOnlyQuery` si `readTeams()` tiene
un hilo de `chris` fresco (<15 min); sin caché, ante fallo o si el parseo no
produce ítems, cae a la query Graph que lee Y destila en el mismo paso. Estado
en `~/.cwc-data/retro-teams-scan.json`
+ `retro-teams.lock`; `bin/cwc-retro-teams-runner.js` sumado a
`CROSS_WORLD_ALLOW`. Las TRES piezas (manual/correo/Teams) caen en la MISMA
lista del tablero (ícono 💬, chip de ticket) — se aprueban/adoptan/
descartan con el mismo flujo de siempre, nada se auto-aplica. BUG-1928:
las TRES vías garantizan `tolkien` por separado — default en manual,
asignación propia en correo y asignación propia en Teams. No depender de
que otra capa infiera el proyecto.

## Linkeo automático al grafo de Pad (BUG-1878 · console:PEND-2281)

Toda lección que se crea en `mejora-continua` recibe un link `parent` hacia su bucket `MC · *` de la colección `arquitectura`, elegido por su `category` (mapa exportado `MC_SUN_BY_CATEGORY` en `store.js`). El camino de lección RECURRENTE también lo intenta, así que una lección vieja que quedó huérfana se auto-sana al reincidir. Desde `console:PEND-2281`, si el `parent` correcto ya existe o acaba de crearse también borra el viejo `implements` redundante hacia ESE mismo sol; un `parent` hacia otro target se conserva y la lección se salta sin escribir. La convención que crea o actualiza `promoteToConvention` conserva su link de referencia `implements` hacia la lección de origen.

El link jerárquico de la lección, su limpieza histórica y el link de referencia de la convención son BEST-EFFORT (nunca rompen la destilación ni la promoción) y se SALTAN cuando el `ctx` es de un inquilino (workspace `tenant-*`), porque los ítems `ARQUI-*` solo existen en el workspace `console` del host. Regla: `CONVE-1257` del Pad + regla dura 11 del `CLAUDE.md` raíz; detalle en `docs/pad-grafo.md`.

### Barrido de sesiones TUI (BUG-2068)

Las sesiones TUI no pasan por `Chat.close`, por lo que antes nunca llegaban a
`queueRetroDistill`. El disparo nuevo es un tick de `init()` que SOLO spawnea el
runner desacoplado `bin/cwc-retro-sweep-runner.js` (regla dura 2); el barrido
determinístico y de 0 TOKENS vive en `sweep-shared.js`, y la destilación real
sigue en `cwc-retro-runner.js`. Estado operativo en
`~/.cwc-data/retro-sweep.json`, lock pid-aware con heartbeat en
`retro-sweep.lock` y log en `retro-sweep.log`; `retro-swept.json` es el
registro DURABLE que NUNCA se poda. Solo considera transcripts con
`entrypoint:'cli'`, quietos hace 6 h, de hasta 14 días, procesa como máximo 5
por corrida y saltea archivos mayores a 8 MB. Marca en el registro durable
también los descartados por el filtro híbrido, para converger en vez de
reevaluarlos cada hora. `console:BUG-2151` quedó resuelto: el censo incluye el
`.claude/projects` del host y el de cada inquilino bajo
`~/.cwc-users/<id>/`; cada candidato lleva su `owner` hasta
`queueRetroDistill`, el job owner-scoped y `padContextForUser(owner)`. Una TUI
de inquilino se destila en su workspace `tenant-<id>`, nunca en `console`.

## 🩸 Pozo COMÚN entre usuarios (`console:PLAN-2222`, F1+F2 hechas 2026-07-28)

Las lecciones dejaron de morir en el cajón de cada usuario. Existe un TERCER workspace de Pad —**`comunidad`**, ni `console` ni un `tenant-*`— con una sola colección `mejora-continua`, donde se agregan las lecciones de **`project: tolkien`** de TODOS los usuarios. El valor no es "ver lo del otro": es que la **recurrencia se cuenta ENTRE PERSONAS**. Antes, tres personas tropezando con lo mismo producían tres lecciones con contador 1 cada una y el semáforo se quedaba verde; ahora es UNA con contador 3.

**Puente:** `pool.js` (nuevo). `shareLessonToPool(lesson, sharedCtx, {sharedBy, sharedFrom})` es idempotente por `fingerprint`: si el ítem ya está, suma el userId a `sharedBy[]` y sube `recurrence`; si el donante ya figura, es no-op. `unshareLessonFromPool(fp, sharedCtx, {sharedBy})` quita al donante y **borra el ítem solo cuando se va el último**. Los campos `sharedBy` (json) y `sharedFrom` (text) se agregaron al schema de la colección del pozo a mano — un campo fuera del schema lo RECHAZA el server de Pad con 500, mismo gotcha que `sourceRefs` en su día.

**PRIVACIDAD:** `sourceChats` NUNCA cruza al pozo. Se comparte la lección destilada, no el rastro de qué conversación privada la produjo. Un cambio futuro que lo copie "para tener trazabilidad" es una fuga, no una mejora.

**Disparo:** `upsertLesson(input, ctx, sharedCtx)` ganó un tercer parámetro. Publica sola tras crear O actualizar, siempre que el project efectivo sea `tolkien`, haya `sharedCtx`, no haya opt-out y el fingerprint no esté vetado. Es best-effort y aislada en su try/catch: **el pozo jamás puede romper una destilación** — mismo criterio que `linkLessonToSun`. El `sharedBy` y el directorio privado se derivan del `ctx.workspace` del dueño (`tenant-(.+)` → ese userId; `console` o sin ctx → host), de modo que opt-out, veto, lock y actividad usan el mismo scope que el Pad.

**Válvula de retiro (C4):** `POST /:id/unshare` (auth normal, NO admin — cada uno retira lo suyo) saca la donación propia Y marca el fingerprint en `<dataDir>/retro-unshared.json`, registro DURABLE. Sin esa marca, la próxima destilación lo republicaría en silencio. `GET`/`POST /share-optout` cortan la publicación automática por usuario, en `<dataDir>/retro-share-optout.json`. Los dos resuelven su ruta con `resolveDataDir()` POR OPERACIÓN, nunca con una constante de módulo (invariante «dato user-scoped nunca global»). OJO ORDEN: `/share-optout` es LITERAL y va ANTES de la paramétrica `/:id`.

**Verificado E2E en vivo el 2026-07-28** (host + un donante simulado, con limpieza posterior): 2 donantes ⇒ 1 ítem con `recurrence: 2` y `sharedBy: ["host","rarboleda"]` · re-donar el mismo ⇒ no-op · retirar uno ⇒ queda el otro y `recurrence` baja a 1 · retirar al último ⇒ el ítem se borra · con el veto puesto, re-destilar sube la recurrencia del registro PROPIO pero **no** republica.

**Lo que este pozo NO hace (y no debe hacer):** una lección ajena no se auto-aplica jamás. Adoptarla al registro propio y promoverla a `memoria`/`claude-md`/`contrato`/`invariante` sigue siendo un acto humano del dueño del destino — si no, el pozo sería un canal de inyección de prompt entre compañeros (ley 6 de Aduana, Regla dura 16). Esa adopción es `TASK-2228`, todavía pendiente junto con la vitrina del tablero.

**Adopción en lote (`C11`, enmienda E1 de `console:PLAN-2222`).** `POST /pool/adopt-all` trae de una vez todas las comunitarias adoptables al registro propio. **No es admin**: cada usuario adopta sobre lo suyo, así que restringirlo al anfitrión no protegería nada y dejaría a los inquilinos sin el beneficio. Nace de una medición: de 134 lecciones de Tolkien, 32 llegan al contexto de tickets y **ninguna venía de otro usuario**, porque el puente exige dos actos humanos por lección — con 20 donaciones ajenas serían 40 clicks y el pozo moriría de abandono. Tres detalles que ya mordieron y no hay que reintroducir: (a) la ruta literal `/pool/adopt-all` va **antes** de la paramétrica `/pool/:ref/adopt`, o `:ref` la captura; (b) el criterio de «adoptable» (`isPoolLessonAdoptable`) lo comparten `GET /pool` y el lote — si divergen, el botón promete un número y adopta otro; (c) el botón vive dentro del `<summary>`, así que su handler hace `stopPropagation` o el click pliega el `<details>` además de disparar la acción. La adopción es **secuencial** a propósito (Pad tiene rate-limit y `upsertLesson` toma un lock) y un fallo individual no aborta el lote: se reporta `{adopted, alreadyHad, failed, errors[]}`. **El gate sigue intacto**: las copias nacen `propuesta` y la promoción a un destino real sigue siendo un acto humano por lección — adoptar en lote baja la fricción de TRAER, nunca la de APLICAR.
