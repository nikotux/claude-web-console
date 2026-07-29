<!-- cwc:ficha-modulo -->
# src/modules/learning — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### learning/                 MÓDULO DE APRENDIZAJE (pestaña "🎓 Aprendizaje" del BANCO DE
CONOCIMIENTO — así se renombró la sección `tasks` en la UI, 2026-07-09,
pedido de Niko; `data-module` sigue siendo `tasks`). Registro PRIVADO de
los TEMAS que el dueño va aprendiendo/reforzando (instrucciones de Chris,
cómo funciona el backend, GetPad, GitHub, cómo proponer un fix). 1 tarjeta
= 1 tema {id LT<n>, title, area, scope (console|tolkien), status
(por-aprender|reforzando|dominado), priority, tags[], notes (markdown),
question, contextoEntradas[] ({id CX<n>, at, source ia|manual, text}),
explanation (material de estudio IA), explainModel, explainedAt,
explainFingerprint, explainFiles[], explainVersions[]}.
BACKEND MIGRADO A PAD LOCAL (2026-07-12, ROAD-110 Fase 2, parte del
cutover a self-host — ver el gotcha "MCP de Pad" más abajo): `store.js`
ya NO es file-based — sus 13 funciones de I/O son `async` y hablan contra
el Pad LOCAL (`src/core/pad-service-client.js`, workspace `console`,
colecciones `temas-de-aprendizaje`/TDA y `rutas-de-aprendizaje`/RDA). Un
tema = 1 item TDA; `routeId` → relación `parent` hacia una RDA;
`contextoEntradas`/`explanation`(+model/at/fingerprint/files/versions,
empaquetado en UN campo JSON) → custom fields tipo `json` del item. El LOG
de actividad (`listActivity`/`learning-activity.json`) es local y privado
por dueño; las funciones puras `normScope`/`contextoText` siguen exactamente
igual. `learning.json` viejo queda como respaldo histórico,
ya no se lee. 6 consumidores migrados: `learning/index.js`,
`explain-shared.js`, `analyze-shared.js`, `tasks/analyze-shared.js`
(análisis cruzado), `chat/index.js` (write-back de "Profundizar en chat" +
2 regex de validación de `learningId`), y los runners
context/explain/analyze. La ÚNICA parte que consume tokens es "🎓
Explicame esto": corrida
IA que NAVEGA el CÓDIGO REAL (Read/Grep/Glob) del repo elegido por `scope`
(la consola o Tolkien vía config.projectDir) y AUTO-GUARDA una explicación
guiada en el tema (store.saveExplanation) como material editable/
regenerable. DESACOPLADA a `bin/cwc-learning-explain-runner.js` (lógica en
explain-shared.js; regla de oro) + READ-ONLY doble capa (regla 6: sonnet,
maxTurns 24, timeout 6 min, settingSources: [], allowlist
explainToolAllowed = Read/Grep/Glob/TodoWrite, Bash/Edit/Write/git/MCP
DENEGADO en las DOS capas; NUNCA escribe). Ruta /api/learning (auth; admin
SOLO en /:id/explain y /:id/context-analyze que gastan tokens): GET / · GET
/activity · GET /:id (+ `explainCheck` DERIVADO, ver abajo) · POST / · POST
/:id · POST /:id/delete · POST /:id/explain {force?} (spawn runner o noop,
dedup lock por job) · GET /:id/explain (poll, 0 tokens) · POST /:id/context
(agregar nota manual, 0 tokens) · POST /:id/context/:cid (editar entrada) ·
POST /:id/context/:cid/delete (borrar entrada — literal ANTES de la
paramétrica /:cid) · POST /:id/context-analyze (spawn runner) · GET
/:id/context-analyze/:jobId (poll, 0 tokens). Job en
~/.cwc-data/learning-explain-<id>.json + learning-explain.log.
AISLAMIENTO MULTI-TENANT (`console:PLAN-2267`, B7): el borde HTTP deriva
`systemScopeFor(req).user`; jobs, logs, análisis, contexto, explicaciones,
registro de session ids y actividad resuelven la ruta POR OPERACIÓN con
`userDataDir(owner)`. Los runners de inquilino reciben `CWC_DATA_DIR` y HOME
aislados mediante `userRunnerEnv`; dentro del runner los helpers caen en
`resolveDataDir()`. No hay constantes de módulo que congelen el HOME del server.
Para el host, `userDataDir(hostUser())` sigue apuntando a `~/.cwc-data`, sin
migrar ni renombrar ningún archivo.
REGENERACIÓN INTELIGENTE + CONTEXTO ADICIONAL + VENTANA POR SECCIONES
(2026-07-10, pedido de Niko: "no quiero un documento — quiero secciones
organizadas, y que Regenerar no arranque de cero si no hace falta"). TRES
piezas nuevas:
(a) 🎙️ CONTEXTO ADICIONAL — LISTA de entradas (2026-07-10, pedido de Niko:
"que sea dinámico — que yo pueda sumar notas a mano además de las de la
IA"): `contextoEntradas[]` es una lista donde cada entrada {id CX<n>, at,
source 'ia'|'manual', text} es una tarjeta propia que NO se sobrescribe
(antes era un único string `contextoAdicional` que se pisaba — MIGRADO al
vuelo por normalizeTopic() en store.load: el string viejo se convierte en 1
entrada CX0 'manual'). DOS orígenes: "🎙️ Interpretar una charla" pegás una
transcripción y una corrida IA de TEXTO PURO (CERO herramientas, doble capa
regla 6 deniega TODO — `context-shared.js` +
`bin/cwc-learning-context-runner.js`, mismo patrón que
`tickets/context-analyze-shared.js` pero de alcance PROPIO, sin acoplar los
dos módulos) la interpreta y AGREGA una entrada 'ia'
(store.addContexto{source:'ia'}); "➕ Agregar nota" suma una entrada
'manual' a mano. Cada entrada se edita/borra individual
(addContexto/updateContextoEntry/deleteContextoEntry; cap 30, nuevas
primero). Job en ~/.cwc-data/learning-context-<jobId>.json (id
determinístico por tema+texto) + learning-context.log. En el frontend se
pintan como tarjetas con badge de origen (✍️ manual · 🎙️ IA) + fecha. Las
📝 Notas del tema pasaron a EDITARSE INLINE (textarea directo en el detalle,
sin abrir el form completo — botón ✏️). TODAS las entradas + las notas se
concatenan (store.contextoText) para la huella y el prompt de "Regenerar".
(b) 🔄 REGENERAR = UN SOLO BOTÓN inteligente (ya NO hay botones separados
de "explicación" vs "guía paso a paso": el prompt de explainPrompt() pide
TODAS las secciones de una sola pasada, incluida "Paso a paso" y "Errores
comunes" — catálogo completo: En una línea · Cómo funciona por dentro ·
Piezas clave · Cómo se conecta · Paso a paso · Errores comunes · Para tu
caso · Para reforzar). Antes de gastar tokens, el POST /:id/explain calcula
una HUELLA con `checkStaleness()` (explain-shared.js): huella de TEXTO
(sha1 de notes+question+contextoAdicional, `textFingerprint`) + huella de
CÓDIGO (mtime/size de los archivos que la IA reportó citar la última vez,
en un bloque ```files``` aparte del ```markdown```, parseados por
`parseFiles`/snapshoteados por `fileSnapshot`/comparados por
`codeFingerprint`). Sin cambios en ninguna de las dos ⇒ responde
`{status:'noop'}` SIN SIQUIERA SPAWNEAR EL RUNNER (0 tokens); con cambios y
ya había explicación ⇒ modo `'adapt'` (se le pasa la explicación ANTERIOR
completa en el prompt para que la actualice/amplíe en vez de arrancar de
cero, marcando qué cambió); sin explicación previa ⇒ `'full'`. El botón
fantasma "Forzar regeneración completa" (visible solo si ya hay
explicación) manda `{force:true}` e ignora la huella. `GET /:id` expone
`explainCheck` DERIVADO (nunca persistido) para que el detalle avise ANTES
de tocar el botón si conviene regenerar. Historial: antes de sobreescribir,
`saveExplanation()` empuja la versión vieja a `explainVersions[]` (cap 5) —
"releer lo que ya tenía" sin perderlo, visible en el detalle como
<details> "🕑 Versiones anteriores".
(c) VENTANA POR SECCIONES, no un documento: el frontend
(`learning.js` `splitSections`/`sectionIcon`) parte el markdown por cada
`## título` y pinta CADA sección como una fila-acordeón propia con ícono
(⚡🔧🧩🔗🧭⚠️🎯📌) — "En una línea" nace abierta (resumen), el resto
colapsado (UI colapsable + árbol, regla del proyecto). Investigado el
patrón contra NN/g e IxDF (progressive disclosure > un chorizo de texto
para contenido de estudio).
"💬 Profundizar en chat": botón en la fila de acciones del detalle
(visible si `ctx.openChat` está disponible — `tasks.js` se lo reenvía en
`learningCtx`, antes NO lo hacía) que arma un prompt con
notes+contextoEntradas+explanation y abre un chat en modo `plan` (cwd
'claude-web-console' o el `projectRel` de Tolkien según `scope`, mismo
patrón que `ticket-detail.js`) para repasar o directamente aplicar el tema
a código real. Sirve tanto para "profundizar" como para "trabajar esto" —
un solo botón, a pedido explícito de Niko.
WRITE-BACK AUTOMÁTICO del chat al tema (2026-07-10, pedido de Niko: "que al
cerrar el chat el historial vuelva solo y aumente el contexto"): el botón
pasa `learningId: t.id` a openChat → viaja por POST /api/chat/create (main.js
openChat lo reenvía) → el `Chat` lo guarda (`this.learningId`, validado
^LT\d+$; persist/rehydrate para sobrevivir reinicios). Al CERRAR el chat,
`Chat.close()` — MISMO patrón diferido 2s/best-effort que el histórico de
tickets, con flag propio `_learningDone` — extrae un resumen DETERMINÍSTICO
(0 tokens, `extractSessionWork` de tickets/meta-store, reusado) y lo AGREGA
como entrada `source:'chat'` del tema vía `appendChatContext` de
learning/store.js (importada en chat/index.js como appendLearningChatContext).
Así la próxima "Regenerar" toma solo lo trabajado en el chat. Verificado E2E
(turno haiku real por WS → cierre → entrada 💬 aparece en el tema).
VENTANA DEL TEMA EN 3 PIEZAS + 2 COLUMNAS ASIMÉTRICAS (2026-07-10, pedido de
Niko: la ventana era chica y a 1 columna). Modal ancho `min(1080px, 94vw)`.
Estructura (`learning.js` render): (1) PIEZA SUPERIOR ancho completo = info
básica (id/título/chips/foco) + 📝 Notas (editable inline) + 🎙️ Contexto
adicional, ambas COLAPSABLES; (2+3) grid `.lt-detail-cols` de DOS columnas
ASIMÉTRICAS (desktop ≥860px: `minmax(0,1.7fr) minmax(0,1fr)`,
`align-items:start`; móvil se apilan): IZQUIERDA ANCHA `.lt-col-main` = "📖
Guía" = TODA la explicación renderizada DE CORRIDO en un documento formateado
(`.lt-guia-doc`, un solo `mdHtml(t.explanation)`) para leerla entera, + el
botón Regenerar + versiones; DERECHA ANGOSTA `.lt-col-side` = "🧩 Secciones" =
las MISMAS partes en un acordeón (`splitSections`) — NO son independientes,
son las piezas que componen la Guía de la izquierda. Ambas salen del MISMO
`t.explanation` (0 tokens extra; izquierda = leer de corrido, derecha =
navegar/enfocar). Acciones ancho completo abajo. La entrada de contexto
`source:'chat'` se pinta con badge 💬 (`.lt-cx-chat`), junto a 🎙️ IA y ✍️
manual.
APRENDIZAJE ASISTIDO (2026-07-10, pedido de Niko): (A) RUTAS de aprendizaje
{id LR<n>, title, description, status (activa|propuesta|completada|archivada)}
que AGRUPAN temas con PROGRESO % (temas dominados/total, DERIVADO al leer,
nunca persistido — igual que los PLANES de tasks); el tema gana `routeId`
(validado contra rutas existentes; borrar una ruta DESASIGNA sus temas). CRUD
síncrono en el mismo store.json (routes[]+routeSeq): GET /routes · POST /routes
· POST /routes/:id · POST /routes/:id/delete (literales ANTES de /:id). (B)
"🧠 Analizar aprendizaje" (admin, consume tokens): runner DESACOPLADO
`bin/cwc-learning-analyze-runner.js` (lógica en analyze-shared.js; texto puro,
0 herramientas — doble capa regla 6 deniega TODO, los temas viajan en el
prompt) que devuelve {resumen, duplicados, unificables, completar, agrupar (en
rutas), aprenderPrimero (orden sugerido), sugerirNuevos (gaps)}. POST /analyze
(spawn) · GET /analysis (poll, 0 tokens); estado en ~/.cwc-data/learning-analysis.json
(dedup por corrida fresca). Propuestas NUNCA auto-aplicadas: modal con
Aprobar/Descartar por ítem; aplicar reusa el CRUD (dup→delete · unif→update+delete
· comp→update notes/tags · agrupar→crea ruta si nueva + asigna routeId ·
sugerirNuevos→POST /). Frontend `public/js/modules/learning/learning.js`: NO es
sección de sidebar propia (patrón mountReports de audio) — exporta
mountLearning(container, ctx) y lo monta tasks.js como 5ª pestaña. Sección
colapsable "🗺️ Rutas" (barra de progreso, filtra la grilla por ruta) + grilla
de cuadritos (.lt-*) → detalle modal colapsable+árbol con la explicación en
markdown (renderMarkdown) + selector de ruta en el form. PUENTE Pendientes →
Banco: el botón "Reorganizar todo con IA" del tablero de Pendientes (análisis
HOLÍSTICO scope 'global', tasks/analyze-shared.js) ahora recibe los temas ya
existentes y devuelve además `crearTemas` — TEMAS DE APRENDIZAJE nuevos
derivados de lo que se está trabajando en las tareas/planes/informes; el modal
de reorganizar los muestra en "🎓 Temas de aprendizaje sugeridos" y "Crear tema"
hace POST /api/learning (kind 'createtema' en applyProposal).
