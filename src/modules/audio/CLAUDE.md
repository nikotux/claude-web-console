<!-- cwc:ficha-modulo -->
# src/modules/audio — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### audio/                    EXTRACCIÓN DE AUDIO: cargás una TRANSCRIPCIÓN (ya pasada a texto,
NO hay speech-to-text acá) y la IA interpreta quién dijo qué y por
qué, clasifica cada tramo (accion/plan/decision/problema/pregunta/
info), resume, arma un PLAN y PROPONE tareas → módulo `tasks` con la
aprobación del usuario. CONSUME TOKENS ⇒ RUNNER DESACOPLADO
(bin/cwc-audio-runner.js, regla de oro) + READ-ONLY blindado (regla 6:
sonnet, 1 turno, CERO herramientas — las dos capas PreToolUse+
canUseTool deniegan TODO; el texto viaja entero en el prompt, nunca
lee/escribe disco). REGLA DURA 8 / AISLAMIENTO (console:BUG-2270,
primer hallazgo de la regla `aislamiento` de Coherencia): los jobs
viven en el directorio de datos DEL DUEÑO (`userDataDir(owner)`),
resuelto POR OPERACIÓN en index.js. Los GET quedan aislados de forma
ESTRUCTURAL — cada usuario lista/lee su directorio, no hay un filtro en
memoria que pueda olvidarse. index.js pasa `dataDir` como parámetro a
shared.js porque shared es compartido con el runner y NO puede importar
user-space (arrastraría config/CWC_TOKEN al env limpio). El runner recibe
la misma ruta por `--data-dir` y, si falta, cae a `resolveDataDir()`.
shared.js: jobs en <dataDir-del-dueño>/audio/<id>.json (id DETERMINÍSTICO
por contenido: reintento reusa el MISMO job, no gasta de nuevo; poda >30
días) + prompt + parseo + spawn detached, patrón
projects/analyze-shared+commitmsg-shared. TÍTULO GENERADO POR IA
(pedido del usuario 2026-07-06): el prompt pide un `title` corto
(parseAudio lo extrae) y el runner lo aplica al job si titleAuto (el
usuario ya NO escribe el título a mano — se quitó el input del panel);
el `id` del job pasó a depender SOLO de la transcripción (audioJobId
ignora el título, que ya no es identidad). EDITABLE después: POST
/:id/title fija titleAuto=false; en el front se edita INLINE (✏️ →
input → Enter/blur guarda, Esc cancela; .au-titlebar). Ruta /api/audio:
GET / (historial liviano) · GET /:id (transcript+result) · POST /analyze
(ADMIN, arranca el runner, responde YA) · POST /:id/title (ADMIN, editar
título) · POST /:id/delete (admin). El
front encuesta GET /:id (0 tokens). Frontend audio.js: NO es sección
de sidebar propia (pedido del usuario) — exporta openAudioPanel(ctx) y
lo abre el módulo `tasks` (Pendientes) con un botón admin. El panel
modal: pegar transcripción → Analizar con confirm de tokens →
resultado en ÁRBOL colapsable (resumen · tareas propuestas con "Crear
tarea"/"Crear todas" · segmentos · plan · hablantes · historial de
análisis previos). YA-CREADAS (2026-07-07, pedido del usuario):
renderResult es ASÍNCRONA y antes de pintar consulta GET /api/tasks →
filtra las tareas de ESTE informe (source=audio + sourceRef=jobId) y
marca por TÍTULO exacto las propuestas ya creadas: chip "✓ Ya creada"
en vez del botón "＋ Crear tarea" (.au-task--done/.au-task-already) y, si
TODAS están, "Crear todas" nace deshabilitado. PASAR A PLAN (mismo pedido):
botón "🗺️ Pasar a plan" en el head del bloque de tareas propuestas →
crea un PLAN (título del audio, detalle=summary) y todas las propuestas
como tareas ASIGNADAS a ese plan (POST /plans + /from-audio con planId por
ítem; createTask valida el planId). renderResult toma un 5º arg `dialog`
(confirm del "Pasar a plan"); los 3 call sites (analyze/openExisting/
mountReports) lo pasan. renderResult ahora incluye un bloque 🧾 RAW
colapsado (.au-raw): el CRUDO del procesamiento = transcripción
original + JSON interpretado (el "producto" es el render lindo, el raw
es lo crudo; pedido del usuario 2026-07-06). Además audio.js exporta
mountReports(container, ctx) — la PESTAÑA 🎙️ Informes del tablero de
Pendientes: cada audio procesado como un INFORME colapsable (.au-report,
regla de UI árbol) que al expandir hace GET /:id y renderiza el
resultado con el botón raw. wrapBusReload envuelve el bus para refrescar
la lista de informes tras un análisis nuevo. OJO: `audio` (interpretar
reuniones) ≠ `--cwc-cat-audio` (categoría de archivo)
