<!-- cwc:ficha-modulo -->
# src/modules/tasks — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### tasks/                    PENDIENTES: tablero PRIVADO de tareas de este proyecto (nada sale al
exterior, no se pushea). Versión simplificada de "Bugs & Features":
1 tarjeta = 1 tarea {id T<n>, title, description, status
(pendiente/en-progreso/hecha), priority (alta/media/baja), tags[],
source (manual|audio), sourceRef (jobId de audio), createdAt/
updatedAt/doneAt}.
BACKEND MIGRADO A PAD LOCAL (2026-07-12, ROAD-110 Fase 1, piloto del
cutover a self-host — ver el gotcha "MCP de Pad" más abajo): `store.js`
ya NO es file-based — sus 13 funciones de I/O son `async` y hablan contra
el Pad LOCAL (`src/core/pad-service-client.js`, workspace `console`,
colecciones `pendientes`/PEND y `planes`/PLAN, SEPARADAS a propósito de la
bitácora técnica del programa de modularización). `id` T<n> → `ref`
PEND-<n>; `planId` → relación `parent` hacia un PLAN; `blocks[]` →
relación `link_type=blocks`; `comments[]` → comentarios nativos del item.
El LOG de actividad (`listActivity`/`tasks-activity.json`) NO se tocó —
sigue exactamente igual (decisión de alcance, ya atómico). `tasks.json`
viejo queda como respaldo histórico, ya no se lee. Migración 1-vía ya
ejecutada: 61 tareas + 14 planes reales, 0 discrepancias. También migrado
`tasks/analyze-shared.js` (2º consumidor de store.js, análisis IA general).
FASE 2 ✅ (2026-07-06): (A) PLANES que agrupan tareas con
progreso % (id PLAN-<n>, secuencia planSeq; status active/proposed/
done/cancelled; taskCount/doneCount/pct DERIVADOS al leer, NUNCA
persistidos; borrar un plan DESASIGNA sus tareas, no las borra). La
tarea gana `planId` (validado contra planes existentes) y `type`
(task/idea/nota/feature). (B) LOG de actividad REAL persistido en
~/.cwc-data/tasks-activity.json (append-only, poda a 300 eventos):
cada create/update/status/complete/delete de tarea Y plan registra un
evento {id,ts,kind,entity,refId,title,detail} — el panel "Actividad
reciente" lee ESTO (antes se derivaba de timestamps, sin historial).
Ruta /api/tasks (todo AUTENTICADO, sin admin — bloc privado del dueño):
GET / {tasks,counts,plans} · GET /counts {counts} (liviano, SIN el
fan-out de blocks[] por ítem — lo usa el poll de 20s del sidebar,
loadCounts() de tasks.js) · GET /activity {events} · GET /plans
{plans} · POST / (crear tarea) · POST /from-audio {jobId,tasks[]} ·
POST /plans (crear) · POST /plans/:id (editar) · POST /plans/:id/delete
· POST /:id (editar tarea) · POST /:id/delete · POST /analyze +
GET /analysis (análisis general IA, ver arriba) · comentarios/timeline
(ver "CAMPOS estilo Pad" abajo). OJO ORDEN: las rutas
literales /plans, /counts y /activity se registran ANTES de la
paramétrica /:id
(valida ^T\d+$) para que Express no las capture como id; /plans valida
^PLAN-\d+$. RATE LIMIT DE PAD LOCAL (bug real 2026-07-12): `blocks[]` no
viene decorado en list/get — listPlans()/listTasks() piden un
listLinks() POR ÍTEM; sin tope, un Promise.all disparaba 60-100
requests SIMULTÁNEOS contra Pad local en CADA poll de 20s (tenga o no
el tablero abierto), agotando su rate limiter POR USUARIO — "too many
requests" hasta en el uso manual de Pad (web/MCP) mientras tanto.
Arreglado con `mapPooled()` (store.js, sobre `core/pool.js
runAdaptivePool`, mismo patrón `pool()` de tickets/sources.js):
concurrencia FIJA baja (LINKS_CONCURRENCY=4) + back-off si Pad devuelve
429; y GET /counts evita el fan-out ENTERO cuando solo hacen falta los
conteos por estado. CAMPOS estilo Pad (2026-07-07, pedido del usuario, "nutrir
el detalle basándonos en GetPad pero simple"): la TAREA suma
owner/estimate/dueDate/comments[]/blocks[]; el PLAN suma
owner/phase/targetDate/comments[]/blocks[]. Todo se normaliza en
store.js (dueDate/targetDate = YYYY-MM-DD validado; blocks = ids
EXISTENTES T<n>|PLAN-<n>, sin el propio, tope 30 — pueden CRUZAR
tarea↔plan como en Pad); `blockedBy` NO se persiste, se deriva en el
front (quién te tiene en su blocks). COMENTARIOS append+borrar
(sin editar): POST /:id/comment {text} + POST /:id/comment/:cid/delete
(id ^C\d+-\d+$) y sus gemelos /plans/:id/comment[...]; addComment deja
además un evento 'comment' en el log. TIMELINE por ítem: GET
/:id/timeline · GET /plans/:id/timeline = merge de los comments del
ítem + los eventos del log con refId===id (excluye 'comment' para no
duplicar), desc. Las rutas /:id/timeline, /:id/comment[...] van al final
(tras las literales); sus gemelas /plans/:id/... ANTES de /plans/:id.
Se alimenta MANUAL y desde el módulo `audio`. Frontend
tasks.js: sección colapsable del sidebar
(semáforo + conteos) + TABLERO modal (openModal) con CUATRO PESTAÑAS
(.tk-tabs/.tk-tab, espejo visual de .bb-tabs del board de Bugs;
openBoard(initialTab), default 'panel' — OJO: el handler del botón
envuelve la llamada `() => openBoard()` para NO pasar el PointerEvent
como initialTab): (1) 📊 PANEL = DASHBOARD estilo Pad alimentado 100%
con datos LOCALES (0 tokens, todo DERIVADO en el front) — Pad es solo el
REFERENTE de diseño, NUNCA la fuente (pedido del usuario 2026-07-06).
Secciones colapsables (.dash-sec, regla de UI árbol). ORDEN (pedido del
usuario 2026-07-06): 🗂️ Clasificación PRIMERO y abierta (resumen de todo:
conteos Tareas/Planes/Informes/Sesiones + pills por tipo + top tags) · 🔥
En curso (tareas en-progreso + chats de trabajo de /api/chat/list con
status==='working'||delegating) · ⚠️ Necesita atención (en-progreso
estancadas >3d sin update + alta prioridad sin arrancar) · ⏭️ Seguí por
acá (top 3 por prioridad+antigüedad) · 📊 Planes activos (barra de
progreso % por plan active/proposed) · 🕑 Actividad reciente (LOG REAL de
/api/tasks/activity + análisis de audio). Un ítem con [data-goto] salta a
Tareas, [data-goto-plan] a Planes.
(2) 📋 TAREAS = CUADRITOS EN COLUMNAS estilo Bugs v2 (.task-grid,
columns:3 240px masonry; 1 col en móvil ≤640) + filtros Activas/Todas/
Hechas. Cada cuadrito (.task-cardv2) nace CONTRAÍDO (tipo+id+prioridad+
estado+título+chip de plan) y al CLIC abre el DETALLE en VENTANA NUEVA
(modal openTaskDetail: chips, descripción, tags, fechas + acciones
avanzar/editar/eliminar; role=button + Enter/Espacio) — pedido del usuario
2026-07-06 (antes eran filas .task-item expandibles inline). alta/edición
por taskForm con Tipo+Plan. (3) 🗺️ PLANES = planCard colapsable con barra
de progreso, subtareas del plan y editar/eliminar (planForm); "Nuevo plan"
arriba. (4) 🎙️ INFORMES = mountReports() del módulo audio (ver abajo).
Escucha el evento `tasks-changed` del bus (lo dispara audio al crear
tareas) para refrescar. FASE 2 ✅ (Planes + log real + tipos) + rediseño
de Tareas a cuadritos+modal y Panel con Clasificación primero (2026-07-06).
ANÁLISIS GENERAL IA (2026-07-07, pedido del usuario): botón "🧠 Análisis
general" (admin, consume tokens) en las pestañas 📋 Tareas y 🗺️ Planes.
Corre el motor `tasks/analyze-shared.js` + runner desacoplado
`bin/cwc-tasks-analyze-runner.js` (regla de oro; regla 6: sonnet, 1 turno,
CERO herramientas — los datos se juntan EN NODE y viajan en el prompt,
nunca lee/escribe disco). scope='tasks'|'plans': junta TODAS las tareas (o
planes) + los INFORMES de audio (summary/tareas propuestas/plan) y devuelve
{resumen, duplicados[{keep,remove[]}], unificables[{ids[],title,description}],
completar[{id,description,tags[]}]}. Estado persistido por alcance en
~/.cwc-data/tasks-analysis-<scope>.json (patrón audio: status running/done/
error + dedup por corrida fresca, NO hay lock aparte); POST
/api/tasks/analyze {scope} (admin) arranca+responde YA · GET
/api/tasks/analysis?scope=... solo lee disco (0 tokens); el front encuesta.
Las propuestas NUNCA se auto-aplican: el modal (tasks.js openAnalysis,
colapsable/árbol) las muestra por sección y cada una tiene Aprobar/Descartar;
APLICAR reusa el CRUD determinístico existente (dup→delete los remove ·
unif→update el 1º con título/detalle fusionado + delete el resto ·
completar→update description/tags) — endpoints /api/tasks/:id vs
/api/tasks/plans/:id según scope. Al cerrar, si aplicó algo, recarga el
tablero. FASE 3 pendiente (anotada): más tipos de Collection tipo Pad
(Docs/Feedback/Roadmap) si hacen falta.
6 COLUMNAS en la pestaña Tareas (2026-07-07, pedido del usuario: antes 3
con min 240px): .task-grid pasó a `columns: 6` FIJAS (sin min-width ⇒
NUNCA scroll horizontal, los cuadritos se angostan) + breakpoints
5/4/3/2/1 (1100/900/700/520/380px).
DETALLE ENRIQUECIDO estilo Pad (2026-07-07): tareas Y planes abren el
MISMO modal `openDetail(kind, item)` (openTaskDetail/openPlanDetail son
wrappers) — antes el detalle de tarea era plano y el plan ni tenía modal
(era un <details> inline; ahora la tarjeta de plan trae botón "Abrir").
Secciones colapsables (regla UI árbol): 🍞 BREADCRUMB navegable
(Pendientes / Planes / [PLAN si la tarea tiene] / ID; los links cierran el
modal y saltan de pestaña o abren el plan) · ⚙️ PROPIEDADES en grilla
(tarea: estado·prioridad·tipo·owner·estimación·fecha · plan: estado·fase·
fecha·owner·progreso) · 📝 DESCRIPCIÓN en MARKDOWN (renderMarkdown de
ui/markdown.js, el mismo sanitizado del chat) · 🔗 RELACIONES (tarea:
"Parte del plan" · plan: "Hijos X/Y" = sus tareas · ambos: "Bloquea a"
editable con picker de búsqueda [＋] y quitar [✕], "Bloqueado por"
derivado read-only; los chips son navegables → abren ese ítem) · 🕑
TIMELINE + COMENTARIOS (GET /:id/timeline: eventos del log + comentarios;
composer con Ctrl+Enter, borrar por comentario). Patrón de refresco:
`mutate(fn)` aplica el cambio, marca dirty, hace boardApi.reload (recarga
las arrays tasks/plans del board) y re-renderiza el modal con el ítem
fresco (o cierra si se borró); el listener del modal está delegado UNA vez
(no por render). taskForm suma owner/estimación/fecha objetivo; planForm
suma owner/fase/fecha objetivo. Estilos .tk-detail/.tk-crumb/.tk-sec/
.tk-props/.tk-md/.tk-rel*/.tk-tl* en style.css.
