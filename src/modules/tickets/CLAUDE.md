<!-- cwc:ficha-modulo -->
# src/modules/tickets — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Módulo VIVO `tickets/` — Contexto adicional + Histórico del trabajo (2026-07-07)

⚠️ El tablero `bugfixes/board` que describe gran parte de este archivo está
ARCHIVADO (`_archived/`, branch `redesign/board-mobile`). El módulo VIVO del ciclo
de tickets/features/PRs es **`tickets/`** (Bugs v2 · "One Front Door"): dashboard
determinístico (snapshot Zoho/GitHub cada 60 s, sin IA) con ventanas de detalle
en MODAL — `public/js/modules/tickets/{ticket-detail,pr-detail}.js` (clases `.bv2-*`).

## Permisos del tablero

| Quién | Puede hacer | Por qué |
|---|---|---|
| Cualquier usuario autenticado | Ver el dashboard, resueltos, departamentos, detalles de tickets/PRs y metadata; tomar tickets y soltar los propios | Lee el snapshot compartido del equipo, refrescado una vez cada 60 s con las credenciales del host, y usa claims locales: no agrega costo por usuario. |
| Cada usuario autenticado | Editar sus contextos `work`/`pr` y sincronizarlos a `CLAUDE.local.md` de su propio clon de Tolkien | El scope de la request impide que un inquilino lea o escriba los archivos del host. |
| Sólo admin | Analizar contexto con IA | Consume tokens. |
| Sólo admin | Guardar, editar o borrar contexto adicional | Escribe en el Pad `console`. |
| Sólo admin | Forzar el refresco | Golpea Zoho/GitHub; los no-admin sólo leen el snapshot compartido. El arranque en frío sí puede generar el primer snapshot para cualquier autenticado. |

Gotcha de `claim`: al tomar un ticket, `assignInZohoBestEffort(id,
externalUserOf(req))` intenta asignarlo en Zoho con la cuenta OAuth del usuario que
lo toma, nunca con la del host para un usuario autenticado. Si no conectó Zoho en
⚙ Sistema → Conexiones, el claim local funciona igual y la asignación en Desk
simplemente no ocurre.

VISTA TABLA ANCHA — expandir columna a "Excel" (2026-07-14, PEND-487, pedido de
Niko): las columnas del dashboard (Nuevos · Vencidos · En progreso · Resueltos)
cortaban el listado a 12 filas (`ticketList(items, max=12)`, `dashboard.js`) con un
cartel `+N más` MUERTO — pero el backend YA manda el array COMPLETO (`d.vencidos`,
etc. en `lastData`, 0 fetch extra). Ahora cada bloque de tickets tiene una 2ª manija
además del colapsar del `<details>`: un botón ⤢ (ícono `maximize` nuevo en icons.js)
en el header + el `+N más` clickeable → `openTicketTable()` abre un MODAL ANCHO
(`min(1200px,96vw)`) con una TABLA ORDENABLE tipo Excel (`.tkt-tbl*` en style.css):
columnas #, Asunto, Carril, Estado, Prioridad, Dueño, Días, SLA (config `TABLE_COLS`,
reusa laneLabel/statusMeta/PRIO_META); header sticky, click en encabezado ordena
(num vs localeCompare), buscador filtra por #/asunto, filas → `openTicketDetail`. La
tabla respeta el filtro de carril/dueño/míos activo (recibe `applyFilter(...)`).
BOTÓN "TODOS" (mismo PEND-487): la fila 2 de la barra de filtros tiene un botón
`.bv2-allbtn` (`data-expand="all"`) "Todos · N" que abre la tabla ancha con la UNIÓN de
las 3 colas de abiertos (o los resueltos en esa vista), respetando el filtro — N es el
conteo dinámico; el label dice "Todos (filtro)" si hay filtro activo. Ahí la tabla usa
`TABLE_COLS_ALL` = TABLE_COLS + una columna "Cola" al frente (`_bucket`: 🆕 Nuevos/🔴
Vencidos/🔧 En progreso) que `openColumnTable('all')` etiqueta al concatenar (clona cada
ticket `{...t, _bucket}`, NO muta lastData). `openTicketTable` acepta `opts.cols`.
GOTCHA: el botón ⤢ vive DENTRO del `<summary>`; el listener delegado hace
`e.preventDefault()` en `[data-expand]` para que el click NO togglee el `<details>`, y
el chevron lleva clase `.bv2-chev` para que SOLO él rote al abrir (la regla vieja
`.bv2-block[open] > summary svg` también giraba el ⤢). Todo frontend, 0 backend, 0
tokens. Los PRs (dev-lane/mergeados) NO tienen tabla (otro shape) — follow-up opcional.

⚡ **BACKEND MIGRADO A PAD LOCAL — patrón "dos mundos" (2026-07-12, ROAD-110 Fase
3, parte del cutover a self-host, ver el gotcha "MCP de Pad" más abajo):**
`meta-store.js` (las 4 funciones de I/O: `getMeta`/`saveContexto`/
`clearContexto`/`appendHistorico` — el "Contexto adicional" + "Histórico del
trabajo" de abajo) ya NO es file-based — habla contra el Pad LOCAL (workspace
`console`, colección `contexto-de-tickets`/CDT). Esto es la pieza de **mundo
INTERNO** del patrón de dos mundos: notas PROPIAS de Consola sobre un
ticket/PR — el ticket/PR EN SÍ (Zoho Desk + GitHub) y el Pad de TOLKIEN (cloud,
`src/modules/tickets/pad-client.js`) son el **mundo EXTERNO**, sin cambios, sin
tocar. Como la clave de un ticket/PR es un string arbitrario ya existente
('123', 'pr:245') y no un `ref` de Pad, la búsqueda usa
`findItemByTitle()` de `pad-service-client.js` (list + match por título — el
volumen de tickets trabajados es bajo, no hace falta un índice). `historico[]`
y `contexto adicional` viajan como campos JSON del item. `extractSessionWork()`
(extracción determinística del transcript) NO se tocó — sigue igual, no hace
I/O de meta-store. Alcance verificado ESTRICTO: nada del gate de push, Desk,
GitHub, claims ni snapshot de `tickets/index.js` se tocó — solo los 2-3
call-sites puntuales que ya llamaban a estas 4 funciones. `ticket-meta.json`
viejo queda como respaldo histórico, ya no se lee.

DOS SECCIONES nuevas en la 2ª columna de esas ventanas (pedido de Niko), panel
FRONT compartido `public/js/modules/tickets/meta-panel.js` (mismo HTML/handlers/
inyección al prompt para ticket, feature y PR — no se duplica):
- **🎙️ Contexto adicional:** pegás la TRANSCRIPCIÓN de una charla → la IA la
  interpreta (runner desacoplado read-only, ver arriba) → se AUTO-GUARDA como
  sección persistida y se INYECTA en "Continuar en el chat". Editable/borrable.
- **📚 Histórico del trabajo:** al CERRAR el chat de un ticket/PR, `Chat.close()`
  (chat/index.js, diferido 2 s) extrae DETERMINÍSTICAMENTE (0 tokens) archivos
  tocados + resumen del cierre (`extractSessionWork` de `tickets/meta-store.js`,
  portado del board v1) y lo agrega al histórico del ítem → la PRÓXIMA sesión
  arranca con TODO el historial acumulado. PRs pasan `ticket:{number:'pr:<n>'}`
  para registrar bajo esa clave.

Backend: `tickets/meta-store.js` (store persistente, overlay `withMeta` sobre el
ticket/PR al servir) + `tickets/context-analyze-shared.js` (molde de audio) +
endpoints en `tickets/index.js`: `POST /meta/context-analyze` (spawn runner,
CONSUME TOKENS bajo confirm) · `GET /meta/context-analyze/:job` (poll, 0 tokens) ·
`POST /meta/context` (guardar/editar/borrar a mano) · `GET /meta/:key`.

CONTEXTOS DE TRABAJO EDITABLES (migrado de v1 al chat v2, 2026-07-08). Además de
los DOS bloques por-ítem de arriba (contexto adicional + histórico), cada chat de
"Continuar en el chat" / "Trabajar esto en un chat" (ticket, feature y PR) inyecta
DOS contextos POR USUARIO editables — los mismos de la v1 (bugfixes), que estaban en
disco (`~/.cwc-data/bugfix-context.md` = 'work' · `bugfix-pr-context.md` = 'pr') y
servidos por `GET/POST /api/tickets/context?kind=work|pr` (`tickets/context-store.js`)
pero YA NO se inyectaban en ningún chat (agujero de la migración): 'work' = CÓMO se
trabaja un ticket (el **"Pensamiento Profundo"** paso-0 antes del plan —cuadro de
contra-verificación con links autoritativos, lección Desk #519—, entregas en tablas
+ "Puntos a investigar", narrativa humana, triage BUG/FR/EXTERNA, gate de push, y la
sesión publica el PR directo tras el gate: en v2 NO existe el módulo "Enviar PR" de
v1) · 'pr' = house style de la descripción del PR (Summary con 3 preguntas, causa
raíz, verificación, variantes feature/external). Se editan en ⚙ Sistema → Proyectos,
grupo "Tickets & Features · contexto de trabajo" (entradas "Tickets & Features:
Trabajo/PR" — antes "Bugfixes:", renombradas; keys internas `bugfix-work`/`bugfix-pr`
sin cambiar para no tocar el endpoint), `system/project-context-panel.js`. Wiring:
`fetchWorkflowContexts()` + `workflowContextBlocks()` en `tickets/meta-panel.js`
(fuente única, patrón `fetchContexts` de v1); `buildContext`/`buildPrContext`
(ticket-detail/pr-detail) apendean los bloques `--- CONTEXTO DE TRABAJO ---` /
`--- REDACCIÓN DEL PR ---` AL FINAL del prompt. La metodología del Pensamiento
Profundo ADEMÁS sigue en la memoria de Tolkien (`…tolkien/memory/pensamiento-profundo.md`
y hermanas), que auto-carga en TODA sesión de Tolkien (incluidas TUI) — solapamiento
deliberado (pedido de Niko 2026-07-08): la memoria cubre las TUI/chats manuales, el
contexto inyectado cubre los chats abiertos desde el botón de un ticket v2.

AISLAMIENTO POR USUARIO (PLAN-2117 B3, 2026-07-27): los cuatro endpoints
`GET/POST /context` y `GET/POST /context-sync` resuelven `systemScopeFor(req)` y
solo operan sobre ese scope. El host conserva byte por byte los masters históricos
en `~/.cwc-data/bugfix-*.md` y el espejo en `<config.projectDir>`. Un inquilino usa
`<scope.dataDir>/bugfix-*.md` y `<scope.workspace>/tolkien/CLAUDE.local.md`. Mientras
sus masters no existen, `getContext()` lee los del host como semilla sin escribirlos;
el primer guardado materializa `work` y `pr` en su dataDir y desde ahí quedan
desacoplados. El host es fuente de semilla solo de LECTURA: ninguna escritura de un
inquilino puede resolver a sus rutas. Si el clon propio todavía no existe, guardar el
master funciona y `syncToTolkien()` devuelve un skip best-effort sin crear el clon.

ESPEJO A TOLKIEN — BLINDAJE (2026-07-10, pedido de Niko: "que CUALQUIER sesión que
vaya a hacer el push de un PR tenga SIEMPRE estas instrucciones que yo puedo editar,
blindados a futuro"). Problema: la inyección al prompt del tablero
(`workflowContextBlocks`) SOLO cubre los chats abiertos desde el botón de un ticket;
una sesión abierta de otra forma (launcher / TUI / reanudada) sobre `~/tolkien` NUNCA
veía estos contextos (caso real: la sesión del PR #266 corría solo con lo nativo de
Tolkien). El ÚNICO mecanismo que llega a TODA sesión de un repo es el auto-carga nativo
de Claude Code (`CLAUDE.md` + `CLAUDE.local.md` + memorias); la inyección one-shot del
tablero es estructuralmente incapaz de garantizar. SOLUCIÓN (enfoque ESPEJO, no
referencia — el texto viaja FÍSICO, no un "andá a leer allá" que dependa de que el
modelo obedezca): al guardar un contexto, `saveContext` (`tickets/context-store.js`)
además de escribir el master del usuario ESPEJA el subset work+pr a una SECCIÓN
GESTIONADA del `CLAUDE.local.md` de su propio clon — archivo LOCAL, ya excluido del repo
(`.git/info/exclude`, NUNCA se comitea), que Claude Code auto-carga en CADA sesión de
Tolkien (chat/TUI/launcher/reanudada). `syncToTolkien()` reemplaza SOLO lo que está entre
los marcadores `<!-- cwc:tickets-context:start/end -->` (todo lo que Niko escribió a mano
en CLAUDE.local.md — la 🛡 regla dura de PRs — queda intacto FUERA de los marcadores).
El master (fuente de verdad, con TODO) vive en la consola; a Tolkien baja solo el subset
necesario para trabajar tickets/features/PR. La sección lleva NOTA-en-el-documento
("gestionado por Mi Consola, no editar a mano, local no versionado") para que un
future-Niko no la confunda con un objeto raro. VERIFICADOR: `verifySync()` compara el
bloque presente en CLAUDE.local.md vs el render del master → `ok|stale|missing|
unavailable`; expuesto por `GET /api/tickets/context-sync` (0 tokens, solo lee disco) +
`POST` (re-sincronizar a mano). El panel de Proyectos (`system/project-context-panel.js`,
bloque `.pj-sync`) muestra el badge + botón "Re-sincronizar" + la NOTA-en-la-consola de
dónde aterriza, ARRIBA de los contextos editables; y un check rápido de Salud
(`checkTolkienContextSync` en `health/index.js`, id `tolkien-context`) entra en el
semáforo global. La inyección del tablero se CONSERVA como redundancia inofensiva
(cinturón + tirantes).

## Gotchas de esta carpeta

- **Enrich de Desk con RETRY — antes se perdían tickets en silencio** (BUG-2188,
  2026-07-28, hallazgo de Nico: "el dashboard no muestra nuevos bugs pero el
  triage del TUI sí"). `sources.js:loadFresh()` pide `desk_get_ticket` uno por
  uno para cada ticket listado (pool concurrencia 5, `ENRICH_CONCURRENCY`);
  medido en vivo que ~16% de esas llamadas (20/128 en la corrida real) fallaban
  con `timeout MCP: desk_get_ticket` (20s, `CALL_TIMEOUT_MS` de
  `desk-mcp-client.js`) bajo el volumen agregado de los 2 departamentos, y el
  `pool()` las descartaba SIN reintento ni aviso — un ticket real (p.ej. recién
  creado, sin nada raro) simplemente desaparecía de los 3 buckets esa vuelta.
  Además el regex de "hay que bajar la velocidad" (`RATE_LIMIT_RE`) no
  reconocía `timeout` como señal de sobrecarga, así que el backoff adaptativo
  nunca se disparaba para la causa dominante de pérdida. Fix: `pool()` ahora
  acepta `{retries}` y reintenta cada ítem antes de rendirse (`ENRICH_RETRIES=2`
  en el enrich de tickets); el regex pasó a `OVERLOAD_RE` e incluye `timeout`;
  `loadFresh()`/`cacheInfo()` exponen `failedCount`/`failedNumbers` (antes
  invisibles) y loguean los números que siguen fallando tras los reintentos.
  Verificado en vivo: la misma corrida que antes perdía #767/#770 ahora los
  recupera y logueó 0 fallos residuales (antes 20). Costo: el refresh forzado
  pasó de ~2min a ~2m48s bajo el mismo volumen — aceptado, corre en background
  cada 60s, nunca bloquea al usuario.

- **SEGUNDA vía a Pad: cliente MCP del BACKEND** (`src/modules/tickets/pad-client.js`,
  documentado 2026-07-11): distinta del MCP del chat de arriba. Es un cliente
  `@modelcontextprotocol/sdk` (`Client` + `StreamableHTTPClientTransport`) que habla
  con `mcp.getpad.dev` DIRECTO desde el proceso del server, SIN chat ni
  `settingSources`. Lee el OAuth FRESCO de `~/.claude/.credentials.json → mcpOAuth`
  en cada conexión. LIMITACIÓN conocida (comentada en el archivo): el accessToken
  dura ~1h y lo refresca Claude Code, NO la consola → si vence y Claude Code no
  corre, `getPadItemsForPr` falla best-effort (conserva el último snapshot). Está
  hardcodeado a `PAD_WORKSPACE='tolkien'` (línea 91) — solo lee el workspace de
  Tolkien. `refresher.js` lo orquesta (timer 60s, snapshot+merge acumulativo+
  persistencia atómica) = plantilla reusable para reportes automáticos. Prueba que
  el server SÍ puede ser cliente MCP de Pad.
  **DECISIÓN 2026-07-12 (cutover a Pad local self-hosted, ver bullet de arriba):**
  este cliente se deja EXPLÍCITAMENTE sin tocar — sigue en HTTP contra el cloud,
  workspace `tolkien`. El Pad local self-hosted no tiene ese workspace (solo migró
  `console`) y además solo habla MCP por stdio (no HTTP) — adaptarlo sería una
  reescritura de transporte + un proyecto de migración de datos de Tolkien aparte
  (con impacto en equipo, Chris/otros pueden usar ese workspace en la nube). Niko
  eligió explícitamente NO expandir el alcance: `docs/plan-migracion-pad-selfhost.md`
  documenta el detalle completo de esta decisión de alcance.

## Espejo a Tolkien — regla vs. referencia (PEND-1864)

El espejo de `tickets/context-store.js` ya NO baja los contextos `work` y `pr`
completos a `~/tolkien/CLAUDE.local.md`: ese archivo auto-carga en toda sesión de
Tolkien y el bloque completo pesaba ~60k. Ahora el bloque gestionado conserva los
mismos marcadores, pero solo incluye secciones de REGLA que la sesión necesita desde
el primer turno, más un puntero explícito a `.cwc-ticket-playbook.md`. BUG-1927:
`MIRROR_RULES` incluye ahora `/^##\s*6\./` tanto en `work` como en `pr`, para que
`## 6. Feedback adoptado` viaje a la auto-carga incluso cuando la promoción fue
`kind:'pr'`; la regla `/^##\s*5\./` de `pr` queda INTACTA porque corresponde a
`## 5. Quick reference — end-to-end flow`. El re-ruteo BUG-1927 ya corrió el
2026-07-26: `CLAUDE.local.md` pasó de 0 lecciones/32.932 bytes a 17/48.864,
y `.cwc-ticket-playbook.md` de 17/52.009 a 0/36.102. El neto de ambos casi
no cambia: las 17 migraron de lectura a demanda a auto-carga, no se duplicaron.

PODA PLAN-1938 (2026-07-26, mismo día, DESPUÉS de BUG-1927). Ese re-ruteo era
correcto pero dejó `~/tolkien/CLAUDE.local.md` en 48.864 bytes, auto-cargados en
CADA sesión de Tolkien. La causa no eran las `MIRROR_RULES` —su clasificación por
sección ya era correcta— sino el CONTENIDO de `## 6. Feedback adoptado`: 15.931 B
de los cuales 12 de las 17 lecciones eran del MUNDO INTERNO (Mi Consola, Zoho
Desk, correo/Teams/WhatsApp) y no tenían nada que ver con trabajar un ticket de
Tolkien. Se retiraron del maestro `~/.cwc-data/bugfix-context.md` las 12
(MC-293, MC-322, MC-368, MC-413, MC-493, MC-639, MC-773, MC-792, MC-822, MC-827,
MC-829, MC-897) y quedaron las 5 de alcance Tolkien (MC-806, MC-1337, MC-1844,
MC-1841, MC-1909). Resultado medido: espejo 37.421 → 27.974 B · `CLAUDE.local.md`
48.864 → 39.417 B · maestro `work` 47.256 → 37.811 B. Se corrigieron además los
punteros muertos que apuntaban a la propia fuente de verdad del corpus
(`pr-workflow-context.md` → `bugfix-pr-context.md` en el maestro work;
`bugfixer-context.md` → `bugfix-context.md` ×2 en el maestro pr): `grep` da 0 en
los dos maestros y en `CLAUDE.local.md`.

DOS COSAS QUE NO SE PUEDEN DESHACER SIN ROMPER ALGO. (1) Las 12 lecciones
retiradas NO se borraron: siguen canónicas en el Pad local (colección
`mejora-continua`) y se traen por tarea desde el índice enrutador. Sus ids
quedaron LITERALES en un bloque de registro dentro de `## 6.` — es a propósito:
`retro/promote-shared.js` hace `cur.includes(lesson.id)` para no re-apendear una
lección ya adoptada, así que borrar los ids las haría volver solas. Ese bloque de
registro es markdown de cita (`> `) sin ningún `## ` ni fence, justamente para no
romper el splitter. (2) `MIRROR_BUDGET = 30000` (context-store.js) NO cambia
comportamiento: `syncToTolkien()` loguea un warning si el bloque supera el
presupuesto, y `verifySync()` expone `mirrorBytes`/`mirrorBudget`/
`mirrorOverBudget` para que el engorde silencioso sea imposible. El check de
Salud `tolkien-context` solo lee `.status`, así que esos campos son aditivos y no
lo afectan. Quien más empuja el peso hacia arriba es `## 6.`, que
`retro/promote-shared.js` apendea SIN TOPE: cuando ese warning aparezca, la
acción es podar el maestro, no subir el presupuesto.

El procedimiento largo (fases, checklists y lecciones registradas) se genera junto
al espejo, en `.cwc-ticket-playbook.md` del clon propio, archivo local no versionado
y excluido por `.git/info/exclude`. La fuente de verdad son los masters por usuario
editables desde ⚙ Sistema → Proyectos; el playbook se regenera al guardar o
re-sincronizar.

Fail-safe obligatorio: si los títulos cambian y ninguna sección matchea las reglas
esperadas, ese contexto se espeja completo como antes y se loguea un aviso. Nunca se
pierde cobertura por un rename de encabezados.

GUARD DE REFS BUG-1984 (2026-07-26). Los dos generadores que cruzan hacia
`CLAUDE.local.md` (`tickets/context-store.js` para `cwc:tickets-context` y
`retro/promote-shared.js` para `cwc:mejora-continua`) sanitizan con el mismo
criterio al renderizar: un `MC-*` conocido se reemplaza por el título humano de
la lección y cualquier otra ref interna por su tipo semántico sin identificador,
también dentro de fences. El maestro `~/.cwc-data/bugfix-context.md` NO se
modifica: sus refs son correctas en el mundo interno y la frontera es el render
del espejo. La sanitización de tickets cubre también el fail-safe que espeja el
contexto completo cuando cambian los encabezados, y `syncToTolkien()` devuelve
`sanitizedRefs` para auditar cuántas ocurrencias neutralizó.

Después de sanitizar y antes de cualquier escritura, `syncToTolkien()` conserva
el detector como barrera fail-closed: si todavía queda una ref del Pad `console`,
loguea con `console.error` cada ocurrencia con su línea y devuelve
`{ ok:false, reason:'foreign-refs', foreignRefs, sanitizedRefs }`. El detector
compartido `core/pad-world-refs.js` (`findForeignRefsForTolkien()`, re-exportado
por compatibilidad desde context-store) usa listas cerradas de prefijos reales:
`CONVE PLAN TASK BUG ARQUI DOC PLAYB ROAD PEND MC FEAT FB TDA RDA CDT IDR AR`
para `console`, y `TCONVE TPLAN TTASK TBUG TARQUI TDOC TPLAYB` para `tolkien`.
Esto evita falsos positivos como `UTF-8`/`SHA-256` y resuelve el caso límite:
`TASK-123` es foráneo aunque empiece con T; `TTASK-123` sí pertenece a Tolkien.
El guard corre antes de `ensureGitExclude()` y `writePlaybook()`, por lo que un
bloque contaminado no produce ninguna escritura en el mundo externo.

Gotcha crítico: `splitTopSections` corta solo encabezados top-level `## ` y
mantiene `inFence`; los contextos tienen snippets de bash y plantillas markdown
con líneas como `## Summary` / `## Verification` dentro de bloques ```, que NO
fragmentan secciones mientras el splitter está dentro del fence.

## Linkeo automático al grafo de Pad (BUG-1878)

Todo ítem que `meta-store.js` crea en `contexto-de-tickets` recibe un link `implements` hacia `ARQUI-1274` («Ciclo de tickets»), el sol de esa colección. Es BEST-EFFORT (nunca rompe el guardado del contexto ni el cierre de un chat) y se salta para inquilinos (workspace `tenant-*`), porque los `ARQUI-*` solo existen en el workspace `console`. Regla: `CONVE-1257` del Pad + regla dura 11 del `CLAUDE.md` raíz.
