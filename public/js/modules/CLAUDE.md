<!-- cwc:ficha-modulo -->
# public/js/modules — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### public/js/modules/          launcher · sessions (RADAR DE TRABAJO EN SEGUNDO PLANO, PLAN-892,
2026-07-22): la tarjeta de sesión ya no sólo dice vivo/dormido; la
fila 2 suma una LÍNEA VIVA (`.sess-live`, `liveText()`) con prioridad
trabajo de fondo VIVO > resultado listo para recoger > delegando > turno
en curso, siempre con "hace cuánto". BUG-1959: `liveMeta()` parte
`bgTasks` en `bgLive` (`!ready`) y `bgReady` (`ready`): si queda algún vivo
gana `⚡ N en segundo plano`; SOLO cuando no hay vivos y sí listos muestra
`sessions.live.bgReady` con `✅ N listo(s) para recoger`.
Los chats cuyo cwd es `~/.cwc-data/tolkien-envs/<envId>/tree` se agrupan bajo
Tolkien, pero en sub-bloques colapsables por entorno: rama, contador, guía de
árbol e identidad azul fría distinguen el worktree efímero del Tolkien principal.
Para administradores, chats y sesiones tmux gestionadas de otros usuarios se
agrupan por `owner` en `.sess-owners`, separado de "Otras sesiones tmux". El
helper `isMine(owner)` resuelve la identidad contra `whoami.username` o, cuando
la sesión se autentica por token y ese username es nulo, contra `whoami.host`;
`owner:null` sigue siendo propio por retrocompatibilidad con sesiones históricas
del host. El estado abierto del grupo ajeno se persiste en `localStorage` bajo
`cwc.sessions.others.open`.
El launcher resuelve `ctx.whoami` antes de pintar sus destinos fijos: host/admin
ve “Mi Consola” (`claude-web-console`) y un inquilino no-admin ve “Mi espacio”
(`mi-espacio`), que existe dentro de SU workspace. `PLACES` conserva las dos
identidades completas (label + ícono + clase) para el launcher, Sesiones y el
navegador de archivos; el filtro por usuario vive únicamente en el launcher,
no en `PLACES`. GOTCHA: todos esos destinos son RUTAS RELATIVAS. El clamp del
backend las resuelve dentro del workspace propio del inquilino, de modo que
ofrecerle un destino inexistente ahí termina en un 400 del backend.
En tarjetas de chat (no tmux/TUI) el chevron `.sess-kids-toggle` está
SIEMPRE presente y despliega `.sess-kids`: con 0 hijos se ATENÚA
(`.sess-kids-toggle--idle`) y muestra contador `0`, pero NUNCA se
esconde — misma lección del widget de actividad ya aplicada al botón
global: un control que aparece sólo en el instante en que hay algo
corriendo es indescubrible. Con hijos (`kidsOf()` = `bgTasks` +
`delegatingList`) muestra uno por trabajo; `kidsOf`/`kidRowHtml` propagan
`ready`: los vivos llevan su PROPIO Pac-Man en estado `delegating` (el que
orbita, o sea MOVIMIENTO visible), pero un resultado listo lleva ícono
`check` y CERO Pac-Man — terminado no puede animarse como si corriera.
Todos conservan etiqueta y tiempo. Al desplegar con 0 hijos muestra una fila
tranquila `.sess-kid--empty` con "Nada corriendo en segundo plano", no un
panel vacío.
El header de "Sesiones" ganó un SEGUNDO botón (`data-ref="bg"`) con el
contador GLOBAL: hijos de todos los chats + `processCount` de
`GET /api/health/active-runners`, endpoint que hasta ahora no consumía
nadie. Ese botón abre el modal "Trabajos en segundo plano" con una
sección `<details>` por sesión + una sección de procesos del server. En
0 se ATENÚA (`.sess-bgbtn--idle`) pero NUNCA se esconde: un botón que
desaparece es indescubrible (lección del widget de actividad). GOTCHAS:
el estado abierto de hijos vive FUERA del DOM (`openKidCards`, key
`chat:<id>`) porque `updateInPlace` refresca cada 8 s, y NO se borra
cuando termina el último trabajo: si Niko lo dejó abierto, el panel sigue
abierto mostrando el mensaje vacío en vez de cerrarse solo en la cara;
hay un timer
propio de 1 s que sólo reescribe los "hace cuánto" (tictac, sin fetch);
y `.sess-main` pasó de `<button>` a `<div role="button">` con `tabIndex`
+ handler de teclado porque un `<button>` no puede contener otro
`<button>` (el chevron). El fetch de `active-runners` es BEST-EFFORT:
si falla, la lista de sesiones se pinta igual. CSS: la indentación del
árbol `.sess-kids` va por PADDING con `box-sizing:border-box`, no por
margen — en un contenedor flex el margen se suma al flex-basis y el bloque
quedaba más ancho que la tarjeta, cortando la columna de tiempo (defecto
real, visto en captura)) · tasks(sección "Pendientes": tarjeta sidebar
colapsable + tablero modal con CUATRO PESTAÑAS 📊 Panel (dashboard estilo
Pad con datos LOCALES: En curso / Necesita atención / Seguí por acá /
Planes activos con progreso % / Clasificación / Actividad reciente del
log real — todo derivado, 0 tokens; Pad solo REFERENTE de diseño) · 📋
Tareas (filtros/alta/edición con Tipo+Plan) · 🗺️ Planes (agrupan tareas,
progreso %) · 🎙️ Informes (audios como informes colapsables + botón 🧾
raw). Se alimenta manual y
desde audio vía evento bus `tasks-changed`. El módulo AUDIO NO es sección
propia: vive DENTRO de Pendientes — el botón "Audio" DEL TABLERO (admin,
tokens; el acceso "Analizar audio" del HEADER del sidebar se quitó a
pedido del usuario 2026-07-07) importa openAudioPanel de audio/audio.js
(pegar transcripción → Analizar → interpretación en árbol + tareas
propuestas + raw), y la pestaña Informes usa mountReports de audio.js) ·
retro (sección "Mejora Continua": badge de propuestas + tablero modal
colapsable de LECCIONES DE PROCESO destiladas al cerrar chats — ver el
módulo backend `retro/` arriba; adoptar → destino sugerido/guardar/descartar;
el tablero ya no calcula la aplicabilidad de destinos: la recibe del backend
en `l.targets`/`l.targetReasons`, y el menú "▾" muestra un chip con cuántos
destinos NO aplican y por qué) ·
stats · usage · system(⚙: menú REORGANIZADO en 3 GRUPOS con submenú
master-detail (2026-07-19, PLAN-695 — antes era una fila plana de tabs
.sys-tabs que ya no escalaba): ⚙️ Configuración (Conexiones · Skills ·
Idioma · Variables de entorno · Proyectos) · 🩺 Diagnóstico (Salud · Dashboard ·
Actualizaciones · UniFi · Interfono — Dashboard = pestaña propia desde PLAN-752, antes
sub-modal del Escaneo de Salud; Actualizaciones = censo de versiones de terceros,
módulo `updates`, PLAN-779) · 🛠️ Administración (Backup · Usuarios, solo admins). system.js arma
grupos→items aplanados con índice global; en DESKTOP (≥720px) rail de
grupos a la izquierda + panel a la derecha (arranca en el 1er ítem); en
MÓVIL (<720px) DRILL-DOWN (.sys-shell[data-view=index|content]): se ve el
índice, tocás un ítem → el panel ocupa todo con "‹ Sistema" (.sys-back)
para volver. isMobile()=matchMedia(max-width:719px) decide auto-select
desktop vs índice móvil. CSS .sys-* en style.css (reemplazó .sys-tabs/
.sys-tab/.sys-body).
Acceso: un no-admin ve Conexiones · Skills · Idioma · Proyectos · Interfono.
Salud · Dashboard · Actualizaciones · UniFi · Variables de entorno son admin-only.
Criterio: diagnóstico del SERVER y config de INSTANCIA requieren admin; las
preferencias y conexiones del usuario quedan disponibles para todos.
La pestaña Conexiones = mountMcpsPanel (módulo `mcps`, ver arriba). La pestaña
Idioma (2026-07-19, PLAN i18n — arquitectura Fase 1,
traducción de contenido en Fase 2 vía Orquestador Interno) es la primera pieza
de INTERNACIONALIZACIÓN de la consola: `language-panel.js` (self-service, NO
admin-gated — es preferencia PERSONAL de cuenta, no config del sistema) deja
elegir Español/English → POST /api/account/lang (`core/users.js` suma el campo
`lang` por usuario, `getUserLang`/`setUserLang`, default 'es') → recarga la
página. Núcleo en `public/js/ui/i18n.js`: `t(key, fallbackEs, vars)` es el
ÚNICO punto de entrada para strings visibles al usuario en código NUEVO — el
ESPAÑOL NO vive en un archivo aparte, vive como el propio `fallbackEs` inline
en el código (nunca se desincroniza, y en 'es' no hay NADA que cargar); solo el
INGLÉS vive en `public/i18n/en/<módulo>.json`, namespaced 1:1 con
`public/js/modules/<módulo>` (+ `core` para lo compartido de `ui/`) — clave
del reparto en Fase 2: cada módulo escribe SOLO su propio JSON + sus propios
`.js`, cero colisión entre bloques del orquestador. `applyI18n(root)` barre
`data-i18n`/`data-i18n-title` del HTML estático (demo real en
`public/index.html`: botón "Enviar" del dictado + tooltips Explorador/Vista
Raw/Seguimientos). `main.js` carga el diccionario del idioma ANTES de montar
módulos (`initI18n(whoami().lang)` + `applyI18n(document)`, hito de boot 28%
entre "vendors" 15% y "montando módulos" 35%). Clave faltante o módulo sin
diccionario todavía ⇒ cae al fallback ES, nunca rompe (mismo criterio
"degradar, no explotar" de whisper/Pad caído). Fase 2 (traducir TODO el
contenido actual, ~15 módulos/~16.700 líneas) NO está hecha — el mecanismo
está listo y probado E2E, pero casi toda la UI sigue mostrando el fallback ES
hasta que se ejecute. CONVENCIÓN para código nuevo: ver "## Convenciones" más
abajo. Backup/Usuarios/
Proyectos/Interfono/Salud — la pestaña Interfono
(interfono-panel.js) es la ventana + canal humano del INTERFONO
entre sesiones (GET/POST /api/interfono): sesiones activas,
enviar mensaje manual, reservas de archivo con semáforo 🔴🟡🟢 y
liberar (admin), mensajes recientes — todo colapsable+árbol. La
pestaña Proyectos (project-context-panel.js,
backend módulo `projects` + /api/bugfixes/context) es DISTINTA del
módulo tolkien de abajo: TODAS las entradas editables en un solo
lugar con navegación en DOS NIVELES lista→detalle (rediseño a
pedido: las 4 pills idénticas de antes confundían). Vista lista =
tarjetas .pj-card agrupadas ("Proyectos · contexto y memorias" =
Tolkien/Consola de GET /api/projects, chip de ícono en acento;
"Bugfixes · solo contexto" = BUGFIX_ENTRIES del panel, kind=work|pr
de /api/bugfixes/context, chip neutro .pj-card--bf) con nombre +
descripción + chevron. Tocar una tarjeta → detalle con "‹
Proyectos" (volver), dir del proyecto, Contexto y (solo proyectos
completos) Memorias — el detalle de un bugfix NI renderiza la
sección Memorias. Visible a todos (autenticados), edición gateada por
isAdmin en el frontend Y en el backend. La pestaña Skills (2026-07-19;
catálogo Fase 4 de PLAN-2181, 2026-07-28; módulo backend `skills` —
GET `/api/skills` + POST `/api/skills/install|uninstall`, frontend
`system/skills-panel.js`, mountSkillsPanel) combina arriba un CATÁLOGO
ACCIONABLE por usuario y debajo el CENSO READ-ONLY original (0 tokens IA,
todo determinístico). El catálogo nace colapsado con resumen
disponibles/instaladas/desactualizadas; cada tarjeta también nace plegada y
usa los tres semáforos existentes: ✅ instalada al día (verde) ·
⬆️ actualización disponible (ámbar) · ⬜ no instalada (neutro), más
⭐ para las `cwc-default`. Instalar/Actualizar copia la versión compartible
del repo al espacio global del principal; Quitar exige `confirmDialog` y
borra solo copias marcadas como propias del catálogo. Durante el POST los
controles quedan deshabilitados con Pac-Man, y éxito o error siempre dispara
un GET fresco. `user_owned` tiene mensaje propio: una skill personal con el
mismo nombre nunca se pisa ni se borra. Tras instalar/actualizar, el panel
avisa que los runners ya abiertos deben reiniciarse para cargarla.
El censo informativo inventaría las skills de Claude Code
(`.claude/skills/*/SKILL.md`) cruzadas con la colección `playbooks` del
Pad LOCAL (vía `pad-service-client.listItems('playbooks')`, workspace
`console`) — agrupadas por MUNDO: 🏠 Mi Consola (`.claude/skills` de
este repo, `CONSOLE_ROOT` resuelto por `import.meta.url`) · 🌳 Tolkien
(`config.projectDir/.claude/skills` — cruce READ-ONLY legítimo, sumado
al `CROSS_WORLD_ALLOW` del check `cross-world` de salud) · 🌐 Global
(`~/.claude/skills`, scope usuario). El cruce con Pad es por el pie
convencional "Fuente de verdad: `PLAYB-<n>` en Pad `console`" que ya
usan module-scan/codex-verify/rutear (frontmatter parseado con la MISMA
técnica minimal-regex que `skillDescription()` de chat/index.js, sin
YAML real): badge ✅ `<ref>` si el playbook existe, ⚠ "ref rota" si el
SKILL.md referencia un PLAYB-n que no está en Pad, "— sin Pad" si no
hay pie (agrupar/orquestar/pad/handoff no lo tienen — no es un problema,
solo informativo). Sección aparte "🆕 Candidatos de Pad sin SKILL.md" =
playbooks `status:active` CON `invocation_slug` que NINGÚN SKILL.md
referencia todavía (coherente con la lección de Mejora Continua MC-683:
"solo promover a skill un playbook activo con invocation_slug; los
draft o sin slug se gradúan antes" — los borradores de Mejora Continua
NO aparecen acá). UI: reusa CASI SIN CSS NUEVO el look de tarjeta
colapsable de `health-review-modal.js` (`.hr-collapsible`/
`.hr-finding`/`.hr-f-*`) — 2 modificadores nuevos
(`.hr-finding--linked`/`.hr-sev--linked` verde ·
`.hr-finding--orphan`/`.hr-sev--orphan` ámbar) para el estado de
sincronía con Pad, mismo patrón visual que un hallazgo de Salud. El CENSO
sigue siendo solo lectura a propósito: ni crea/edita SKILL.md ni modifica
playbooks. Best-effort ante Pad local caído (`padAvailable:false`): muestra
igual los SKILL.md, solo sin badges de vínculo. Registrado en Pad como
`PEND-684`.
La pestaña Salud es SOLO
salud: chequeos rápidos + revisión profunda + subsección "🧠
Optimización IA" (resumen compacto + botón → sub-ventana
optimize-modal.js: censo de motores gratis + análisis bajo botón
con propuestas aprobables, ver "Verificación de salud"), sin
bugfixes) ·
tolkien (tarjeta git INFORMATIVA, rediseño 2026-07-03: sin
Continuar/Explorar/Bugs&PRs — quedaban redundantes; muestra el
PULSO del repo — #SHA · branch (⚠ si ≠ main) · main al día/↓N ·
N cambios · último commit (asunto·autor·hace X) · último fetch ·
🌿 N PRs sin mergear — y una acción: Actualizar (⬇ ícono en el
header). SEMÁFORO + Actualizar pasaron a leer `mainBehind` (main
LOCAL vs origin/main), no HEAD..origin/main — ver el bloque del
módulo backend tolkien/ arriba para la CAUSA RAÍZ del "no hacía
nada" y el flujo nuevo (ff de main aunque estés en rama feature).
La línea 🌿 (GET /branches, gh) lista mis PRs abiertos sin mergear
y su ↓N sobre main; clic → ventana con "Poner al día" (rebase,
POST /rebase-branch) SOLO en la rama actual atrasada. .tk-update--due
resalta si mainBehind>0. /api/tolkien/status suma mainBehind+onMain.
El acceso al tablero se movió a "Bugs & Features". La tarjeta suma
un 3er acceso directo en `.tk-actions` (2026-07-12, pedido de Niko):
"GetPad local" — link `<a target="_blank">` a
`http://${location.hostname}:7777` (mismo host ZeroTier de la
consola, puerto del `pad-local.service` self-hosted, ver el gotcha
"MCP de Pad" — cutover a local arriba), color `.tk-link--pad` (verde
`--cwc-ok`, distinto del terracota "local"/azul "oficial" de Tolkien
para no confundir los tres). Es solo un ATAJO de UI para abrir la SPA
de Pad en pestaña nueva — NO cruza datos ni viola la regla dura 12
(los dos mundos siguen sin enlazarse en vivo; este botón no lee ni
escribe nada, solo navega)) ·
bugs (sección "Bugs & Features", modules/bugs/bugs.js, ANTES
`tickets`: ÚNICO acceso al ciclo del bug. INFO RÁPIDA barata (sin
tokens ni gh) cruzando /api/bugs (triage: nº bugs + frescura) y
/api/bugfixes (registro: por enviar, PRs abiertos, y ⚠ ATENCIÓN =
reabierto/doble registro/ticket sin actualizar — los casos del
519). TRES COLUMNAS (.bf-cols, pedido del usuario 2026-07-05)
como ESCANEO PREVIO antes de entrar al tablero: 🎫 Tickets · 💡
Features (conteos con el MISMO criterio que tabOfEntry de
board/labels.js sobre los tickets CONSOLIDADOS de GET
/api/bugfixes/tickets — barato: caché server lastGhRows, sin gh
vivo; Tickets suma los triage-only no cubiertos) · ⚠ Atención
(3ª columna: reemplaza a 📦 Archivados —que no se acciona desde
acá— por attentionCount(): anomalías del ciclo reabierto tras
PR / doble registro / ticket sin actualizar en Desk, los casos
del 519; resalta en ámbar .bf-col--alert cuando hay algo). Las
columnas son clickeables (admin): Tickets/Features abren el
tablero en su pestaña, Atención lo abre en Tickets
(openBugBoard({initialTab})). La leyenda inferior se REDUJO a la
frescura del triage (las líneas de resolución/por-enviar eran
redundantes con las columnas). PAC-MAN DE ACTIVIDAD por columna
(pedido del usuario 2026-07-05, .bf-col-pac esquina): un poll
liviano de /api/chat/list (~8 s, 0 tokens) enciende el Pac-Man de
la columna que se está trabajando — un chat con ticketNumber
(working o delegando un subagente) prende su columna (FEAT-n →
Features · resto → Tickets), y el triage corriendo delega sobre
Tickets; un chat working (más específico) le gana al triage. En
reposo, sin Pac-Man. Requiere que chat.info() exponga
`ticketNumber` (src/modules/chat/index.js) para saber qué chat
trabaja qué ticket sin abrir la pestaña. Botón "Abrir tablero" +
↻ triage (tokens, confirm). Al cerrar el tablero (onClose)
refresca las stats + columnas) ·
El TABLERO (bugs/board/, admin, lo abre "Bugs & Features"; vivió
en tolkien/bug-board.js hasta el refactor 2026-07-04 —
docs/plan-rediseno-movil-tickets.md §2, branch
redesign/board-mobile): ARQUITECTURA con estado FUERA del
DOM — index.js (composición: modal, listener delegado,
timers, ciclo de vida) · store.js (estado ÚNICO: datos +
expanded/archOpen/busy/paneles lazy; get/set/mutate/
subscribe + ticketToRow; reset() por apertura) · render.js
(funciones puras estado→HTML, un solo punto de re-render
con scroll preservado) · actions.js (handlers/endpoints:
escriben al store, jamás al DOM; confirms de tokens y
destructivos intactos) · polls.js (encuestas POR CLAVE
'desk:519'/'inv:232'/'tktinv:N'/'desk:bulk', dedup +
deadline, inmunes a re-renders; stopAll() al cerrar) ·
prompts.js (textos de los chats del ciclo) · labels.js
(fuente única de etiquetas: prEstado/resolutionOf/EV_LABEL/
evDot/celdas PR-Desk/rowKey 'sid:x|tkt:n|pr:n'/warningsFor)
· util.js (esc/fmt). CLAVE: el re-render es SIEMPRE seguro
⇒ el auto-refresh de GitHub YA NO se pausa con un detalle
abierto (cambio autorizado del plan, Fase 1); expansión y
paneles GitHub/Desk/investigación sobreviven porque viven
en el store, no en el DOM. R4 aplicada: OUTCOME_LABEL sin
estados muertos (plan/abandoned) y evDot completa
ticket_actualizado (ok/fail según e.ok). VISTA MÓVIL
(Fase 3, ≤640px): tabla y CARDS se renderizan SIEMPRE
del mismo estado y el CSS decide cuál se ve (rotar no
pierde nada) — .bb-mhead (búsqueda en cliente por
#/título/archivo + chips de segmento con conteo:
Acción=pendiente c/files+triage-only ·
Revisión=PR abierto · ✓=merged/completo ·
📦=archivados; re-tap = Todos; segmentOfEntry/
segmentOfGh en labels.js + query/filter en el store)
+ frescura en UNA línea + menú ⋯ (cwc-popup-menu:
Enviar pendientes TEMPORAL hasta la action bar de
Fase 5, Buscar bugfixes, GitHub, Desk, Ayuda). Card =
L1 dot+identidad+íconos PR/Desk · L2 título limpio
(cleanTitle pela el prefijo "TKT #N — ") · L3 estado
COMPLETO sin truncar · L4 semáforo si hay
investigación cargada; card-PR con borde acento +
↳ TKT anidados; mismo listener delegado que la tabla
(.bb-row/.bb-detail + data-key en ambas vistas). El
input de búsqueda es un ref ESTABLE que el render
jamás re-crea (no pisar el tipeo). VISTA DE FOCO
(Fase 4, §3.3/§3.4, SOLO en las cards ≤640px — la
tabla desktop sigue con detailHtml plano): al tap la
card se ancla al tope (scrollIntoView en index.js) y
su detalle se presenta con focusWrap = header sticky
(← bb-focus-back cierra, + identidad) · veredicto +
estado + chips PROMINENTES · secciones LARGAS en
<details> colapsados (focusSec: Resumen/archivos,
Timeline, GitHub en vivo, Zoho Desk — nacen cerradas,
se pueden usar <details> sin tocar desktop porque el
detalle-foco solo se renderiza en .bb-card-det) ·
links · ACTION BAR sticky inferior (.bb-actionbar):
primaria sólida (Trabajar en esto / Trabajar en Chat
plan / Actualizar ticket en gh / Archivar si complete
/ Restaurar si archivado) + secundaria Investigar
(a fondo o contexto según haya PR) + menú ⋯
(bb-ab-more → popup Responder ticket · Traer Desk ·
Archivar · Cancelar PR · Descartar; lo abre index.js,
resuelve b por key y ejecuta la acción directa porque
el popup vive en document.body fuera del bb-detail).
detailMobileHtml/triageMobileHtml/ghMobileHtml en
render.js; el action bar reusa los MISMOS data-act de
la tabla (closest('.bb-detail') resuelve la key igual).
ACCIÓN GLOBAL (Fase 5, §3.5): "Enviar pendientes (N)"
es un action bar STICKY inferior de la LISTA
(.bb-listbar tras el bb-box, móvil-only por CSS, en
la zona del pulgar) visible SOLO si hay pendientes Y
ninguna card en foco (expanded.size===0: con una card
abierta manda el action bar del detalle) — si no hay
nada que enviar, no existe. Salió del menú ⋯ (que
queda con Buscar bugfixes · GitHub · Desk · Ayuda). En
móvil .bb es flex column y bb-box flex:1 para anclar
la barra al fondo. El confirm de envío (una entrada
por línea, .dlg-msg pre-line + scroll del modal) entra
sin overflow en 375px.
UNA fila por ticket para TODO el ciclo — triage → trabajo → PR →
feedback → merge → ticket. Fuentes: registro de bugfixes +
triage de Desk (chips de verificación: severidad, "abierto en
Desk"/"no está en el triage", dup, 🔁 reabierto ×N, ⚠ doble
registro, 🎫 estado Desk, frescura del triage) + PRs solo-GitHub.
Detalle expandible: resumen, archivos, TIMELINE (history[]),
panel "GitHub en vivo" (pr-live: reviewDecision, checks, commits,
comentarios de Chris; ↻ fresh) y acciones: Trabajar en esto
(prompt con HISTORIAL + aviso de feedback), Actualizar ticket
(chat SIN ticket:{} a propósito — no debe re-registrar trabajo
ni devolver el fix a pendiente; redacta la nota EN INGLÉS y
escribe en Desk solo con la aprobación del usuario), Cancelar PR,
Descartar registro; filas solo-triage con "Trabajar en Chat
(plan)". El confirm de "Enviar pendientes" lista las
ADVERTENCIAS de verificación por fix (rojo si hay) y avisa el
auto-update de Desk de los PRs nuevos. Enviar = update repo
previo (callback updateRepo) + POST /pr por fix.
EXCLUSIVO de ~/tolkien) · explorer ·
mobile/auxbar (teclas Esc/Tab/flechas/^C + dictado, SOLO para
vistas de terminal: con la vista Chat activa la barra ENTERA —
botón ⌨ incluido — se oculta por CSS puro con
body:has(.terminal-pane.active.chat-pane-host) en style.css,
selector con #terminals+3 clases que le gana al display:flex
del media query móvil; la TUI es .conv-tui-host y no matchea,
ahí la barra queda) ·
usage (pie: tokens de HOY; su modal "Uso" REDISEÑADO 2026-07-10:
arriba límites del plan — /api/tokens/limits, barras % con umbrales
ok/warn/danger, "queda X% · resetea en …" y "· ≈ X tok" (token-count
NUESTRO de la ventana: session=5 h · weekly=7 d · scoped=ese modelo,
de summary.windows — Anthropic solo da %) + fila de créditos COLAPSABLE
(<details>). Abajo UNA barra de controles (Día/Semana/Mes + $/tok) que
maneja las DOS columnas: 📊 General · <período> (total del rango elegido
por modelo, con Pac-Man pac-sm en los que consumen AHORA lastMtime<2min)
y 📈 Tendencia = gráfica de barras APILADAS por modelo (Chart.js): Día=
horas de hoy · Semana=7 días · Mes=30 días. SIN "Hoy" ni Reset. Los 3
filtros van en UNA fila (2026-07-10) como SEGMENTED CONTROLS (.uh-seg
contenedor pastilla + .uh-seg-btn, activo con tinte acento): rango +
PROYECTO (Todos/Consola/Tolkien/Otros, aplica a ambas columnas; los
límites NO se filtran) + métrica anclada a la derecha; los handlers
seleccionan por data-attribute ([data-range]/[data-project]/[data-metric]).
ORDEN POR PRECIO/economía
(2026-07-10): la lista General va de más COSTOSO arriba a más ECONÓMICO
abajo (Fable→Opus→Sonnet→Haiku) con badge $X/M por modelo (PRICE_INPUT,
coincide con pin() del backend) + caption "▲ más costoso · ▼ más
económico"; la gráfica apila con el más barato en la BASE (keys en orden
de precio del backend). El caché de series usa clave `${range}:${project}`. Todo en
hora LOCAL de Medellín (backend time.js). APERTURA INSTANTÁNEA
(2026-07-10, "se queda procesando" al abrir): el parseo de transcripts
tarda ~2 s, así que hay una CACHÉ EN MEMORIA de módulo (`cache`
{summary,limits,series}) que el poll del pie (tick) mantiene caliente; al
abrir, `paint('draw')` pinta lo cacheado AL TOQUE (0 fetch, ~130 ms) y
`refresh(false)` actualiza en segundo plano SIN bloquear. UN solo botón
Actualizar (spin `.spinning` mientras carga; refresh(true) saltea el TTL).
Auto-refresh SILENCIOSO cada 15 s (AUTO_MS): updateChart() reemplaza
labels+datasets y update('none') EN EL LUGAR (sin destruir/re-animar → no
parpadea); drawChart() (crear) solo al abrir y al cambiar rango/métrica.
El toggle $/tok re-dibuja de la serie cacheada (0 fetch); cambiar rango
trae datos solo si faltan en caché (Día del summary, Semana/Mes de
/history). SUMMARY_TTL_MS subido 4 s→15 s (menos re-parseos). reexporta
fetchLimits/fmtReset/renderLimits/openClaudeConnectModal
(`renderLimits(el,data,{windows})` — el
pie plan-limits.js lo reusa sin windows: créditos colapsables ahí también,
sin token-counts). Si `/api/tokens/limits` responde `unavailable:true` +
`localUsage`, el modal grande muestra “Claude · tu consumo” y, debajo de la
nota de que faltan porcentajes, “Conectar mi cuenta de Claude”; la versión
`compact:true` del pie integra la nota corta “Sin % del plan para esta cuenta.”
y el enlace “Conectar cuenta” en el mismo renglón, con ajuste natural si el
ancho no alcanza. `usage.js` exporta
`openClaudeConnectModal` y `plan-limits.js` lo consume con el `dialog` de su
`ctx`; al conectarse pide límites frescos y repinta el pie sin recargar. El
flujo abre un `openModal` propio y refleja exclusivamente el estado persistido
por el server:
`POST /api/connections/claude/login/start`, polling rearmable cada 1,5 s de
`GET /api/connections/claude/login/status` (`starting|waiting-url|url|
waiting-code|verifying|ok|error`), `POST .../login/code` con `{code}` y
`POST .../login/cancel` al cerrar a mitad de camino. El polling se limpia al
cerrar, ocultar el documento o alcanzar un estado terminal, y se retoma al
volver a mostrar la pestaña. PLAN-2106: toda respuesta no terminal que incluya
`url` mantiene arriba el enlace seguro para abrir/copiar — también en
`waiting-code` y `verifying`—, porque el navegador del servidor no puede
abrirlo por el usuario; en `waiting-code` conviven debajo el input y su error
reintentable, sin reconstruir el campo en cada poll ni perder valor/foco.
`waiting-code` se puede retomar al reabrir porque el front no guarda estado.
Al llegar a `ok`, vuelve a pedir `/api/tokens/limits?fresh=1` y repinta Uso
sin recargar la página. El estado de conexión expuesto por el backend es
`GET /api/connections/claude/status` (`connected`, `source:
credentials|setup-token|null`). `destroyChart` corre en onClose (sin leaks
de Chart.js))

CONVENCIÓN DE AYUDA: cada módulo frontend lleva su propio `help.js` (o
`help/<panel>.js` en `system`) y exporta default una función que devuelve el
tema; su `helpBtn('<id>')` va como último control del header. El censo actual
tiene 28 temas: 26 ids usan `helpBtn`, `auxbar` usa un botón estático
`data-help="auxbar"` porque su chrome vive en index.html, y `stats` no tiene
botón propio porque su widget son tres gauges sin header; se llega desde el
hub "Guía de la consola".

### public/js/modules/chat/chat-tab.js  vista chat · public/js/modules/terminal/terminal.js  vista terminal

## Gotchas de esta carpeta

- Cambio de pestaña y scroll del chat: los paneles se ocultan con
  `display:none` (`.terminal-pane` sin `.active`), y con `display:none` el
  `scrollTop` de `.chat-msgs` se pierde (scrollHeight=0) — el replay de
  `history` o los eventos que llegan con la pestaña oculta dejaban la vista
  arriba de todo al volver a un chat. Fix: `ChatTab.focus()` re-ancla con
  `_scroll()`; `setActive()` (main.js) lo llama justo DESPUÉS de togglear
  `.active`, con el layout ya medible. No sacar ese `_scroll()` ni invertir
  el orden toggle→focus.

- Burbujas del chat en móvil: los topes de desktop (`.chat-assistant`
  max-width 90%, `.chat-user` 75%) regalaban ~35px a la derecha en un
  teléfono (reportado por el usuario). El media query móvil (max-width:768px,
  junto a las reglas de .chat-assistant en style.css) los sube a 100%/88% y
  achica el padding lateral de `.chat-msgs`. TODO el layout del chat es
  %/rem — si se agrega un ancho, que sea relativo, nunca px fijos.

- LAZY-CONNECT de conversaciones en el arranque (2026-07-19, PEND-747, pedido
  de Niko: "el arranque se demora según cuántos chats tengo"). CAUSA RAÍZ: al
  restaurar, `addTab` abría un WebSocket por CADA chat y cada `attach` bajaba
  su historial completo (`_historyPayload`, hasta HISTORY_MAX=600 eventos) — con
  N chats abiertos eran N conexiones + N historiales descargados/renderizados en
  paralelo EN EL CAMINO CRÍTICO del splash (O(n)), aunque el usuario solo mire
  UNO. FIX: una conversación (vista Chat) conecta su WS —y recién ahí el server
  le manda el historial— al MOSTRARSE por primera vez, no al arranque. Piezas:
  (1) `ChatTab.connect()` es IDEMPOTENTE (`_wsWanted` + `_open()`; la reconexión
  automática reusa `_open()` directo) — reactivar una pestaña no reabre socket;
  (2) `buildConversationInner` NO conecta la vista Chat (sí las TUI/PTY, que no
  eran el problema — atacan tmux, no descargan historial); (3) `setActive`
  conecta la conversación activa al mostrarla, y `applyConversationMode` (toggle
  de modo) también si quedó visible; (4) `addTab` gana la opción `activate`
  (default true) — el boot loop agrega TODAS las pestañas con `activate:false` y
  activa UNA sola (la del `?focus=` o la última) → solo ESA conecta al arranque.
  Resultado O(1): medido con 49 chats reales, el boot abre 1 WS (antes 49) en
  ~880 ms, el chat activo carga su historial completo, y enfocar otra pestaña
  conecta +1 WS bajo demanda (verificado E2E con Playwright). Los caminos de
  abrir/retomar a mano (openChat/openChatView/click en tarjeta) siguen activando
  —y por ende conectando— enseguida, sin cambio de UX. COMPLEMENTO server-side:
  `rehydrate()` acota `chat.history` a HISTORY_MAX en las DOS ramas que antes lo
  dejaban sin cap (TUI reconectada · chat dormido), igual que la 3ª (runner
  vivo) — así el payload del hito 85 queda acotado aunque el transcript en disco
  sea gigante.
