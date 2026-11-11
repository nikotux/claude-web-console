<!-- cwc:ficha-modulo -->
# public — ficha del proyecto

> Banco de conocimiento (tasks/learning/audio), Laboratorio, Cerebro y Seguimientos: archivado 2026-10-28, ver `_archived/ARCHIVED.md`; se retiraron slots, páginas, accesos y vendors 3D. Las descripciones siguientes se conservan como historia.

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### public/vendor/              solo la excepción hljs; NO es un depósito de copias
Las librerías frontend se montan con `express.static` desde `node_modules` en
`src/server.js`: `/vendor/xterm`, `/vendor/addon-fit`,
`/vendor/addon-web-links`, `/vendor/addon-clipboard`, `/vendor/marked`,
`/vendor/mermaid`, `/vendor/chartjs` y `/vendor/3d-force-graph`. Lo único que
queda físicamente bajo
`public/vendor/` es `hljs/`, porque el paquete npm de `highlight.js` no publica
un bundle de navegador; `public/vendor/hljs/README.md` documenta la excepción.
`index.html` carga xterm desde `/vendor/xterm/css/xterm.css` y
`/vendor/xterm/lib/xterm.js`; los addons desde `/vendor/addon-fit/lib/addon-fit.js`,
`/vendor/addon-web-links/lib/addon-web-links.js` y
`/vendor/addon-clipboard/lib/addon-clipboard.js`; highlight.js desde
`/vendor/hljs/theme.css` y `/vendor/hljs/hljs.min.js`; marked desde
`/vendor/marked/marked.umd.js`; Chart.js desde `/vendor/chartjs/chart.umd.js`;
y Mermaid, de forma lazy, desde `/vendor/mermaid/mermaid.esm.min.mjs`. El check
`vendor-drift` de Salud vigila que no reaparezcan copias estáticas y que la
excepción documentada no quede desactualizada.
Tickets & Features se archivó el 2026-10-28 (console:PLAN-3480): sin slot,
registro frontend, ayuda ni carga de diccionario; contexto work/pr en Proyectos.

### public/index.html + js/main.js  app principal: módulos frontend { name, mount(el, ctx) }
montados por [data-module]; ctx={icon,dialog,bus,whoami,...}
(patrón completo en docs/frontend-modules.md).
DOS BARRAS LATERALES (2026-07-07, pedido del usuario "Sesiones
ocupa mucho espacio"): #sidebar IZQUIERDA = control/módulos
(Pendientes → Visado → Mejora Continua → Laboratorio →
La Forja; Laboratorio y La Forja cierran la lista, en ese orden)
+ CABECERA con el chip del usuario conectado (`#acct-chip`, desde
2026-07-31) + pie de estado (plan-limits · usage · explorador · raw ·
seguimientos · ayuda · system). #sidebar-right DERECHA = Sesiones + "Nueva sesión"
(launcher) + #rail-tabs (pestañas abiertas) + pie
(.sidebar-footer--right) con el pulso de TOLKIEN PERSISTENTE
ARRIBA (data-module="tolkien" en .tk-persist — ya NO es una
sección colapsable: SIN chevron (.tk-persist .sec-head::before
oculto) y compacto, leyenda densa branch · ↓N por traer · dirty ·
fresh · último commit + botones fetch/update) y la leyenda
CPU/RAM/disco (data-module="stats") DEBAJO, separada por un
divisor. El widget "Actividad en Segundo Plano" (#activity-widget /
ui/activity-widget.js, ROAD-76) fue primero desconectado a pedido de
Niko (2026-07-15) y luego BORRADO el 2026-07-22 (PLAN-892) junto con
`modules/system/activity-modal.js`: su función la cumple ahora el radar
de la tarjeta de Sesiones + el modal "Trabajos en segundo plano", que sí
consume `GET /api/health/active-runners`. Se conserva la lección de
diseño: un indicador que se esconde cuando está vacío es indescubrible,
por eso el botón nuevo queda atenuado en 0 pero visible. Los gauges se
movieron del pie IZQUIERDO al DERECHO
(pedido 2026-07-07): en el rail colapsado derecho Tolkien se oculta
(only-expanded) y los gauges quedan como anillos-ícono compactos
(#sidebar-right.collapsed .gauge-ring), mismo tratamiento que tenían
en el pie izquierdo. DENSIDAD COMPACTA UNIFORME (2026-07-07, pedido
del usuario "replicar el look fino de Tolkien en todos los módulos"):
un bloque CSS scopeado a `.side-sec` (Tolkien va aparte en .tk-persist)
adelgaza header/botones/cuerpo de TODAS las secciones (Pendientes · Comunicaciones · Sesiones): .sec-head fino, botones del
header a 22px (.sec-head .btn--sm/.btn--icon), .tk-card denso, botones
de acción a 26px (.tk-actions .btn/.btn-ghost) y tarjetas de Sesiones
más finas (.sess-main min-height 30px). Los selectores usan ≥2 clases
a propósito: le ganan al bump táctil de 44px de ui.css (@media pointer:
coarse) sin desactivar esa accesibilidad global. (El chevron de
colapsar se probó compacto y LUEGO se quitó — ver "SECCIONES NO
COLAPSABLES" abajo.) CADA barra colapsa a rail
independiente (main.js: toggle-sidebar / toggle-sidebar-right, keys
cwc.sidebar.collapsed / cwc.sidebar-right.collapsed; applySidebarState
aplica ambas). "Nueva sesión" = .sb-new-btn (mismo alto 34px y
diseño que el ☰ colapsar, con tipografía acorde) al lado del toggle
derecho.
SECCIONES NO COLAPSABLES (2026-07-07): las <section class="side-sec">
YA NO se pliegan — se quitó el chevron (.sec-head::before), el
cursor/click y TODO el bloque de main.js que aplicaba/toggleaba
.sec-collapsed + las keys cwc.sec.<mod>.collapsed. Todo nace expandido
(la distribución en 2 barras da espacio). Si se vuelve a necesitar
plegado, hay que reponer ese listener + la clase.
EXCEPCIÓN LA FORJA (2026-10-28): su propio header `.fj-head-main` sí alterna
el cuerpo y persiste el estado en `cwc.forja.open`; cerrada conserva una fila
viva con estados calentando/invitación/forjando/ficha activa/festejo pendiente.
Las animaciones coordinan martillo, chispas, brasa, anillo, badge y shimmer, y
respetan `prefers-reduced-motion`. Los festejos incluyen tanto merges nuevos
como PRs que acaban de llegar a producción; estos últimos pueden agrupar varios
PRs y solo se marcan vistos mediante el endpoint de festejos.
En MÓVIL ambas barras son drawers overlay. En chat y TUI las DOS ASAS
flotantes se ocultan (pedido del usuario 2026-11-10: estorbaban sobre el
composer): el drawer izquierdo de módulos se abre desde el ☰ del header
(`cwc:open-sidebar`) y el derecho de Sesiones desde el ✨ del header
(`cwc:open-sessions`). Las asas (#sidebar-handle izq / #sidebar-right-handle
der; look compartido espejado, solo móvil) se mantienen únicamente donde no
hay header: centro vacío y terminal puro. Cada drawer tiene su scrim
(#sidebar-scrim / #sidebar-right-scrim, hermano `~` :not(.hidden)). FIX scroll
fantasma (pedido anterior): en móvil los
drawers son position:absolute; sin ancestro posicionado se ubicaban
contra el viewport y el drawer derecho cerrado (translateX(100%))
desbordaba generando scroll "al negro" — se contiene con
`#body { position: relative; overflow: hidden; overflow: clip }`
(clip = ni siquiera scroll programático lo revela) + left:0 explícito
al drawer izquierdo.
FIX hueco negro del TECLADO (móvil, reportado 2026-07-07): al enfocar
el input del chat iOS/Android DESPLAZAN la página para mostrar el campo
y aparecía una franja negra (fondo del body) entre el chat y el teclado.
Se BLOQUEA el scroll del documento en la app —
`html:has(#app){overflow:hidden}` + `body:has(#app){position:fixed;
inset:0;overflow:hidden}` (scope :has(#app) → login/otras páginas
intactas)— y `#app` sigue al VIEWPORT VISIBLE por JS: fitViewport
(main.js) setea height=visualViewport.height Y translateY(offsetTop)
(escucha 'resize' Y 'scroll' de visualViewport) reanclando el tope al
área visible; además el meta viewport lleva
`interactive-widget=resizes-content` (Chrome Android). Los modales/
popups se montan en document.body (no en #app) → el translateY de #app
no los descoloca (verificado). NO quitar el body:fixed sin reponer otra
forma de impedir el scroll de foco de iOS (overflow:hidden solo NO
alcanza en iOS).
### public/css/tokens.css       TODAS las variables (--cwc-*); CERO hex fuera de acá
### public/css/ui.css           .btn/.btn-ghost, .dlg-*, .cwc-popup-menu, guard [hidden].
DISEÑO COMPACTO UNIFICADO (2026-07-07, pedido del usuario: replicar
el look fino del sidebar en TODA la app). Los primitivos base son
COMPACTOS: .btn/.btn-ghost = min-height 30px · pad .3/.6rem ·
font-size fs-sm; .btn--sm = 24px; .btn--icon = 26px; .dlg-title = fs-md
· .dlg-body/.dlg-msg = fs-sm · .dlg-input = fs-md; .cwc-popup-item =
fs-sm. Se QUITÓ el bump táctil de 44px de los botones (máximo compacto
también en móvil, pedido explícito) — EXCEPCIÓN: .aux-key (teclado
auxiliar) y .chat-slash-* conservan tamaño táctil cómodo (herramientas
de tecleo rápido). Como TODO usa estos primitivos, la unidad se propaga
sola a modales/menús/gestor. Además un WORKFLOW de auditoría (9 agentes
read-only por superficie) detectó y se corrigieron ~26 estilos de MÓDULO
en style.css/fm.css que hardcodeaban tamaños gordos (fs-lg/md donde iba
fs-sm en filas densas, paddings/min-height grandes): chat (.chat-input/
.chat-send), salud (.hp-row/.hr-f-area), sistema (.users-*/.if-item/
.bk-row/.pj-*), uso (.tok-row-top/.lim-top/.tok-big), sesiones/lanzador
(.ln-dir/.ln-model), comms (.cm-thead), tasks/audio (.tk-tab/.au-title-*/
.task-*), CSS histórico de Tickets (.bv2-sum-main, módulo archivado), gestor (.fm-body/.fm-item/.fm-toolbar).
REGLA: al agregar UI nueva, heredar de los primitivos y usar fs-sm/fs-xs
para filas/controles densos; fs-lg/fs-xl SOLO para títulos prominentes.
### public/css/style.css       estilos de módulos y del chat. Los bloques
`.md-chart*` (Chart.js + tabla accesible) y `.md-bar*` (micro-barras inline)
pertenecen al renderer Markdown. El gráfico va SIN borde, fondo ni padding
lateral A PROPÓSITO — pedido de Niko: se lee como parte del mensaje, no como
un objeto pegado. `.md-mermaid*` contiene el desborde con scroll horizontal
y `.md-mermaid--pan` muestra la pista para deslizar. El `max-height` de
`.md-mermaid-canvas` es la FUENTE DE VERDAD del alto: el JS lo lee del CSS.
A diferencia del gráfico, el diagrama SÍ lleva LÁMINA (fondo `--cwc-bg-panel`,
borde y `--cwc-radius-lg` sobre `.md-mermaid-canvas`, decisión de Niko el
2026-07-30): un diagrama se lee como FIGURA y necesita un borde que diga dónde
empieza, mientras que el gráfico va al hilo del texto. Si se toca la lámina hay
que mover con ella el degradado de `.md-mermaid--pan::after`, que se mezcla
contra el fondo de la lámina y no contra `--cwc-bg`.
El bloque `.zv-*` pertenece al visor de diagramas ampliados
(`ui/zoom-viewer.js`); el viejo body específico del zoom de Mermaid YA NO
EXISTE. `.zv-body` debe conservar `overflow:hidden`: `.dlg-body` trae
`overflow:auto` de base y sus barras pelean con el arrastre durante el paneo.
En móvil, los botones de `.zv-bar` suben a 36px como excepción táctil
deliberada al diseño compacto global.
La tabla accesible `.md-chart-data` es sr-only pero NO está escopada a
`.chat-md` (el renderer también se usa en Aprendizaje y Pendientes) y depende
de que `.md-chart` sea `position:relative` para no escaparse del scroller del
chat; `#body` lleva `overflow:clip` como guard para que ningún desborde vuelva
a hacer scrollear el documento.
El bloque «Modo documento» se activa con `body.doc-mode` y alcanza únicamente
`.chat-assistant .chat-md`. La medida angosta se aplica a los elementos de
TEXTO, no al contenedor, para que tablas, código y figuras conserven su ancho
completo. La sangría de primera línea SIN margen entre párrafos es una decisión
explícita del usuario: no mezclar ese ritmo de libro con separación adicional.
En `@media (max-width: 768px)`, `.chat-head` pasa a DOS FILAS: ☰, título y ✨ de Sesiones arriba; insignias/controles abajo. `.chat-head-break` es un `<span>` vacío con `flex-basis:100%`, oculto en escritorio (`display:none`), que parte la línea flex en móvil; salvo los accesos de navegación de esa primera fila, todo control NUEVO del header debe ir DESPUÉS de ese break en el markup de `chat-tab.js`.
Motivo (BUG-2766, `console:BUG-2766`, reportado el 2026-08-14 por Niko, Julián y Richi; medido con Playwright): como todos los hermanos del título llevan `flex:none`, `.chat-title` era el único encogible y colapsaba a **0 px** en un viewport de 390 px.
No romper estos detalles: `.chat-title` usa `flex:1 1 0`, NO `1 1 auto` —con `auto` reclama el ancho de su texto, no entra junto al ☰ y cae a una tercera fila—; el `gap` baja a `.3rem` y `.chat-world > span` se oculta, dejando el ícono de mundo con su color y el nombre completo en `title`.
Sin esas dos compresiones, la fila de controles tampoco entra en una sola línea.

### public/css/fm.css           estilos del gestor de archivos (compactado 2026-07-07 junto al resto)
### public/archivos.html + js/filemanager/fm.js   Gestor de archivos (página aparte, iframe en el Explorador)
### public/raw.html + js/rawview/raw.js + css/raw.css   Vista Raw (PLAN-544, pedido
personal de Niko 2026-07-15): botón "🔴 Vista Raw" (ícono
`pulse`, junto a Explorador en `.footer-acct` de
index.html) que abre `/raw` en pestaña nueva —
página standalone SIN `main.js` (molde de
`archivos.html`), SOLO-LECTURA. Visualización estilo
Matrix/hacker Y2K donde la lluvia ES EL TEXTO REAL
que las sesiones están escribiendo (no glifos
decorativos — pedido explícito de Niko: "como en
Matrix, el código que cae ES el mundo"). CODIFICACIÓN
DE IDENTIDAD (v2, ver el eje completo en el comentario
de PLAN-544): TONO/hue = MUNDO (🖥️ Consola cálido ~18°
· 🌳 Tolkien verde ~140° · Otros/Codex-desconocido
frío ~190-210°) · MATIZ/shade = SESIÓN (jitter+
lightness estables por `hash(sessionId)`, así todas
las sesiones de un mundo son del mismo color pero de
sombra distinta) · TEXTURA = PROVEEDOR (el output
real de Claude=lenguaje vs Codex=código ya se ve
distinto gratis; el char REAL sale con glow más
brillante que el relleno) · BRILLO+densidad = tps.
Cada sesión ocupa una BANDA contigua de columnas
repartidas INTERCALADAS a lo ancho, con un rótulo
tenue arriba (`🖥️ consola · opus · <sid4>`); las
columnas sin dueño caen como relleno ambiente gris.
La lluvia es TEXTURA/pulso (legible a medias); lo
LEGIBLE vive en la franja del feed (abajo, líneas
color-coded por mundo que se desvanecen ~7s).
DINÁMICA v3 (feedback de Niko: la v2 "se sentía
wallpaper, desconectada de los flujos"): de lava-lamp
a MONITOR CARDÍACO — cada banda tiene su propia
ENERGÍA (0..1, decae hacia un piso según estado): en
reposo cae lenta/tenue casi congelada, trabajando
cae rápida/brillante/densa (verificado: banda
working ~5-6× el brillo de una en reposo). Motor de
lluvia por-columna con TIEMPO REAL (velocidad =
lerp(idle,fast,energía), no un step global). Piezas:
IGNICIÓN al nacer (destello) + DISOLUCIÓN al morir ·
CABEZA blanca incandescente (cursor tipeando) +
RIPPLE (columnas frescas caen) en cada fragmento
nuevo · el ESTADO manda el modo — la banda enciende
al abrir la sesión aunque aún no escriba, delegando
RESPIRA (pulso sinusoidal); el rótulo lleva glifo de
estado (▶ working · ⟳ delegando · ◦ vivo · » texto
headless · · muriendo) · ambiente gris recede fuerte.
DATOS: TRES endpoints por polling ~0.8s —
`GET /api/tokens/flow` (tps → HUD), `GET
/api/tokens/stream?since=<seq>` (fragmentos de TEXTO
REAL {source,sessionId,world,model,text,seq}, ver
`tokens/stream.js`) y `GET /api/chat/list` (estado
por sesión: se une por `sessionId` — status/alive/
delegating/cwd→world; una sesión de chat VIVA crea
banda aunque no haya escrito; las dormidas no).
LOGS DE TERMINAL POR BANDA (última adición de Niko):
bajo el rótulo de cada sesión, un panel legible
(`.raw-log`, DOM sobre el canvas) con el texto real
escribiéndose DE CORRIDO (máquina de escribir, ~90ms,
más rápida a más energía) que hace tail-scroll y al
llegar al fondo RECICLA en loop (cursor circular sobre
`sess.log`) → siempre hay texto de consola fluyendo en
cada banda. Semitransparente (opacity 0.4) para no
tapar la lluvia de fondo. SEED: para que una banda
ociosa desde que se abrió la vista no arranque vacía,
al descubrir una sesión el front pide `GET
/api/tokens/stream/seed?sid=<id>` — lee la COLA del
transcript de esa sesión (getSeed de stream.js,
extractor propio SIN tocar cursores/dedup del
streaming; solo Claude, Codex no) y siembra su log.
LAYOUT v5 (ajustes de Niko): márgenes 0 en TODO
(`* { margin:0; padding:0 }`, offsets a borde) → la
vista usa el 100% de la ventana; RESPONSIVE completo
(resize debounced 120ms → resizeCanvas recomputa
canvas+columnas+bandas+rótulos+paneles; label/log
clampean su `left` a `canvas.width` para no
desbordar en ventanas angostas). Las BANDAS se
reparten BORDE A BORDE (banda 0 pegada a la izquierda,
la última a la derecha, huecos parejos en el medio —
no centradas en su franja, así el contenido arranca
desde el borde sin margen). ODÓMETRO DE TOKENS
abajo-derecha (`#raw-counters`, UNA sola línea
compacta: sesiones + Claude + Codex, dígitos 16px):
dos contadores
PERSISTENTES (localStorage `cwc:rawcount:*`) de 12
DÍGITOS (zero-pad) Claude/Codex que TREPAN en tiempo
real integrando el tps de `/flow` por frame (+ salto
hacia arriba si la acumulación real por deltas de
`bySession/byCwd` se adelanta; monotónico). Es un
contador de CAUDAL (estimación viva "ver subir los
tokens"), no facturación exacta — para eso está el
panel Uso. Ruta `/raw` en server.js (mismo
gate que `/admin`: exige administrador porque muestra
texto en vivo de las sesiones del host, BUG-1874). Cierre con
`Esc`/✕ → `window.close()` (solo
funciona si la pestaña se abrió por click real
—`target="_blank"`—, no programáticamente:
comportamiento de navegador, no bug). Paleta propia
en `raw.css`, deliberadamente fuera de `tokens.css`
(excepción documentada: página temática "easter egg"
aislada en su propio archivo, no hex sueltos en CSS
compartido; los colores de mundo/sesión son HSL
calculados en JS). Verificado E2E (Playwright): bandas
terracota=Consola / verde=Tolkien con texto real
cayendo + rótulos + feed. Plan y ejes de diseño en Pad
`console`: PLAN-544.
AMPLIACIÓN v4 — "muestra TODO el background" (PLAN-544,
pedido de Niko 2026-07-15): además de chats/Codex, la
Vista Raw ahora cubre 3 fuentes más, cada naturaleza con su
representación (diseño "Híbrido IV"): (B) SUBAGENTES —
un hijo es una delegación Codex en background o un subagente Task del SDK.
El front los descubre en `bgTasks` y `delegatingList` de
`GET /api/chat/list`, mientras `stream.js` aporta sus fragmentos y la relación
con el padre (`codex:<jobId>` o `<sid>~sub:<agentId>`). Cada hijo conserva una
BANDA propia más ANGOSTA (peso 0.6), pegada inmediatamente a la derecha de su
padre, con su matiz derivado pero el mundo/tono e ícono heredados del padre y
rótulo `↳`. La banda vive mientras el hijo siga en la lista aunque todavía no
emita texto; esa autoridad estable evita que parpadee entre polls del stream.
El panel de log no usa un promedio: su ancho y `logCols` por sesión siguen el
ancho REAL de esa banda. Un hijo huérfano conserva su propio mundo. (C)
TERMINALES bash — nuevo endpoint
`GET /api/tmux/raw-feed` (auth, 0 tokens) devuelve las sesiones
tmux OWNED vivas + su `capture-pane` reciente; excluye las
`cwct-` (TUI ocultas de chat, ya llueven por transcript) y las
`isClaude` (con estado del observador). El front les da banda
VERDE-shell fija (mundo sintético `terminal`, hue 130) con
charset ASCII (`SHELL_GLYPHS`) y rótulo `▸ bash`. (A) PROCESOS
silenciosos/determinísticos — `RUNNER_REGISTRY` de
`health/shared.js` se extendió con los que no dejan transcript
(tolkien-refresh vía kind `jobflag` {running:true}, WhatsApp
daemon vía kind `heartbeat` con `freshMs`, + health-scan/desk/
investigate/retro) y cada entrada lleva `role` ∈ sdk|job|service.
El front consume `GET /api/health/active-runners` (ya existía) y
enruta por `role`: `sdk` se IGNORA (ya llueve por su transcript,
evita duplicar), `job` (transitorio, p.ej. refresh-Tolkien) cae
como BANDA ámbar que llueve su fase (mundo sintético `proc`, hue
45), `service` (permanente, p.ej. WhatsApp) va a una TIRA de
latidos arriba-derecha (`#raw-procs`, LED que pulsa — un servicio
24/7 no "llueve", late). Regla de diseño: el que produce texto
(subagente/terminal/job) LLUEVE su texto real; el que solo existe
(servicio) LATE. Pollers propios en raw.js: `pollProcs` (1.5s) y
`pollTerminals` (3s, throttle por el capture-pane). Verificado E2E
con Playwright (mock de las 3 fuentes). Capa de PROFUNDIDAD DE
CAMPO (desaturar/achicar lo automático para que los chats salten)
queda como pulido futuro, no implementado.
v6 — la vista dejó de ser admin-only: la ruta `/raw` de `server.js`
ya no gatea y cada usuario ve SOLO lo suyo porque TODOS los endpoints
que consume filtran por principal (`tokens` con `ownerOf` tras BUG-1874,
`chat/list` con `manager.list(principal)`, `tmux/raw-feed` con
`ownsSession`, `active-runners` fail-closed por dueño). Un endpoint nuevo
que se sume a la vista DEBE traer su propio filtro, porque en la ruta ya no
queda red. `/api/health/checks` sigue siendo admin-only y caro (~5,7 s de
CPU): el front lo pide SOLO si `/api/whoami` dice admin, diferido 10 s y
cada 5 min. El panel de log ahora se mide en LÍNEAS (`logMaxLines`, alto ÷
14,85 px), no en chars, y el texto se ENVUELVE en JS al ancho real
(`logCols`, medido con `measureText` en un canvas propio para no pisar la
fuente de la lluvia, y guardado por sesión porque cada banda puede medir
distinto). Sin ese wrap, un párrafo de transcript de 540 chars
ocupaba una sola línea, se cortaba al borde derecho y dejaba el panel casi
vacío igual. `s.raw` conserva el texto lógico y `s.display` el texto ya
envuelto y ajustado: son DOS cosas distintas a propósito, porque concatenar
sobre el ya envuelto duplicaría los cortes. Desapareció el cap de 1600 que
dejaba media pantalla negra y se rellena con líneas vacías arriba para quedar
anclado abajo como una terminal. El cursor de la máquina de escribir YA NO
es circular: al agotar el log el panel queda quieto y lleno en vez de repetir
la misma línea 19 veces; si se vuelve a tocar, ojo con `s.cursor` cuando se
poda `s.log`: hay que restarle lo podado. El seed largo (40.000 chars) y el
`capture-pane` de terminal se VUELCAN de golpe al display — el pasado no se
tipea, la máquina arranca con lo nuevo. El tick ya NO lee `scrollHeight` ni
escribe `scrollTop` (eran ~66 re-layouts sincrónicos por segundo) y
`.raw-log-code` perdió su `text-shadow`: esas dos eran las causas de la
lentitud.
v7 — una sesión que no produce texto por más de `IDLE_COLLAPSE_MS` (60 s) y
que no está `working` ni delegando SALE del reparto de columnas: las sesiones
que trabajan se reparten ese ancho y la dormida se colapsa a un chip en la
fila superior `#raw-dozing`, que se oculta entera cuando no hay ninguna
dormida. Una dormida NUNCA desaparece por estar quieta (decisión de Niko):
solo la borra cerrar el chat o matar la tmux, como siempre. Caso borde: si
TODAS están dormidas, se muestran normalmente para no dejar la vista negra
con solo chips. El colapso reutiliza las animaciones de entrada/salida que ya
tenían paneles y rótulos, sin mecanismo nuevo. Gotcha: `lastTextTs` en
`pollTerminals` marca «produjo algo nuevo», no «sigue existiendo»; pisarlo en
cada poll haría que ninguna terminal colapse jamás.
v8 — la Vista Raw es un **monitor personal**: muestra SOLO lo del usuario que
la abre, incluso si es admin. Antes no era así y el admin veía el
`capture-pane` EN VIVO de las terminales de otros usuarios (medido: dos
terminales de `rarboleda` en la vista de Niko). El corte está en **tres lugares
distintos y por razones distintas**: `/api/tmux/raw-feed` filtra por dueño
estricto en el BACKEND (es el único endpoint del módulo tmux donde el admin no
ve todo); `/api/health/active-runners` se pide con `?mine=1`; y
`/api/chat/list` se filtra en el CLIENTE con `isMine()`, porque ese endpoint lo
comparte toda la app y ahí el admin sí debe ver todo — se puede filtrar del
lado del navegador sin riesgo porque solo transporta metadatos, no el texto
en vivo. `/api/tokens/stream` **ya estaba** bien: `ownerOf()` (BUG-1874) no
tiene excepción de admin. De hecho ESA era la incoherencia que destapó el
problema — para el mismo usuario, los transcripts mostraban solo lo suyo
mientras terminales y chats mostraban todo. Para ver lo ajeno siguen estando
el panel de Sesiones, la pestaña tmux y el modal de trabajos en segundo plano,
que sí son superficie de administración.

### public/cerebro.html + js/cerebro/{cerebro,palette,pulses}.js + css/cerebro.css   Cerebro del Pad
Vista 3D standalone, contemplativa y SOLO-LECTURA del grafo del Pad LOCAL
(`console`), abierta en ventana propia por `/cerebro`; se ilumina en tiempo
real con la actividad verdadera del Pad. Inicializa su propio i18n desde
`public/i18n/en/cerebro.json` y carga `3d-force-graph` desde el mount de
`src/server.js` `/vendor/3d-force-graph` →
`node_modules/3d-force-graph/dist`, nunca desde una copia bajo
`public/vendor/`. El botón `#cerebro-link` usa el ícono `brain` y se oculta por
perfil sin `oversight`, pero ese recorte es solo experiencia: el gate real
vive en el backend. GOTCHA 1 (medido con `3d-force-graph` 1.80.0):
`controlType` NO es encadenable; va en la configuración del constructor
`ForceGraph3D({controlType:'orbit'})`. Encadenarlo arroja `TypeError` y deja la
página negra. GOTCHA 2: Chrome computa un token con `color-mix()` como
`color(srgb ...)`, que THREE.js no parsea y deja el canvas vacío; por eso
`palette.js` normaliza SIEMPRE a `rgb()`/`rgba()` antes de entregar colores y
esa función no es redundante. El bundle además espera el `process` de un
bundler: `cerebro.html` define un shim mínimo `window.process` ANTES de
cargarlo.

### public/cabina.html + js/cabina/{main,salas,nueva}.js + css/{cabina,cabina-sala,cabina-nueva}.css   Modo Cabina · Salas compartidas
`/cabina` es la piel de Mi Consola para usuarios patrocinados no técnicos
(`PLAN-3075`). `src/server.js` sirve `cabina.html` con `sendFile`, de modo que
un cambio de markup se ve sin reiniciar el servicio; es el gotcha INVERSO de
`index.html`, que se lee una sola vez al arrancar para inyectarle el `BUILD_ID`.
`js/cabina/main.js` monta las vistas desde `VIEW_MODULES`: cada módulo exporta
por default `{ name, mount(el, ctx), unmount() }`, con
`ctx={go,api,toast,fmtDate,icon}`, y `main.js` comprueba que `module.name`
coincida con la clave. Renombrarlo sin actualizar el mapa no arroja una falla
accionable: cae al placeholder «Esta sección todavía no está conectada».
`conversaciones` y `salas` son las DOS únicas vistas con ruta anidada
`#/vista/<id>`; `readRoute()` y `go()` las enumeran por nombre, así que toda
vista nueva con detalle propio debe sumarse a AMBAS condiciones.

`nueva.js` + `cabina-nueva.css` implementan el menú del botón «Nueva
conversación», pero NO son una vista de `VIEW_MODULES`: el módulo exporta
`abrirMenuNuevaConversacion(ctx)` y monta el diálogo sobre la vista que ya esté
abierta. El único punto de entrada sigue siendo `createConversation()` de
`main.js`, que hace el `import('./nueva.js')` dinámico; ya hay UN solo listener
delegado para `[data-cabina-new]`, y agregar otro sobre ese atributo dispararía
dos acciones con un clic.

Los destinos del menú se DERIVAN de la unión de `world` en las carpetas raíz y
del mundo resuelto desde `cwd` en los chats propios; `PLACES` sólo traduce
`rel` a etiqueta y fija el orden, nunca inventa opciones. El porqué es el
aislamiento por dueño: `safeCwd(cwd, owner)` clampa al espacio de archivos del
DUEÑO, y un inquilino sólo tiene su workspace, no los `tolkien` ni
`claude-web-console` del host. Ofrecer esos lugares desde la constante termina
en el 400 de `createChatForRequest`: «El destino no existe en tu espacio de
trabajo». Invariante de experiencia: el menú no debe ofrecer un lugar que no
pueda garantizar como destino existente. También excluye `__aduana` y
`__limbo`: Aduana no es un cwd nombrable por el cliente y el backend lo rechaza
a propósito; Limbo es un estado, no un destino de creación.

Si no hay ningún lugar derivable —caso del patrocinado recién creado— no se
cae a `PLACES[0]`: quedan «Sin carpeta» y «+ Nueva carpeta…», y al crear el chat
se omite `cwd` para que nazca en la raíz del usuario, que siempre existe. La
opción «A fondo» (`opus`) tampoco se muestra a un perfil `sponsored`, porque en
Cabina los turnos los paga el sponsor; el gate usa el `profile` (`'sponsored' |
'full'`) ya entregado por `GET /api/whoami` y, si esa consulta falla, cae a
`sponsored`. Es recorte de experiencia, NO seguridad: `POST /api/chat/create`
sigue aceptando `model: 'opus'` si alguien lo invoca a mano.

El JS y la hoja satélite comparten exactamente el namespace `cab-nueva-*`: no
hay clases huérfanas a ninguno de los dos lados. Es el mismo contrato que el
resto de Cabina y debe verificarse cruzando ambos archivos cuando cambie el
menú.

`salas.js` + `cabina-sala.css` son la superficie de 🛃 Aduana para la persona
no técnica; no reimplementan el backend, sino que consumen sus endpoints de
chat y `/ws/chat`. Dos detalles del protocolo fallan en silencio si se tratan
como un chat común: dentro de una sala el WS descarta a propósito
`{type:'user'}` —las personas publican con `say` y la IA solo recibe el buzón
cuando alguien manda `cut`—, y una cita usa `replyTo` / `replyToBy` /
`replyToText`, no `replyBy` / `replyText`. `chat/chat-tab.js` ya exporta
`peerToneFor()` y `stripAddressees()`, pero importarlo arrastraría sus 2851
líneas del frontend de desarrollador a Cabina; por eso ambas funciones están
replicadas deliberadamente en `salas.js`. Si cambia el algoritmo de color o
el encabezado `@para:` del chat, hay que mantener las dos copias sincronizadas.

La lista de salas ya no tiene un sistema paralelo de tarjetas: reutiliza de
`cabina-explorador.css` las bases `.cab-fs-item`, `.cab-fs-item-main`,
`.cab-fs-icon`, `.cab-fs-item-copy`, `.cab-fs-item-name`, `.cab-fs-item-meta` y
`.cab-fs-empty`. Todo ajuste de Salas queda escopado bajo su modificador
`.cab-fs-salas-grid`, igual que Conversaciones se aísla bajo
`.cab-fs-conversation-grid` y La Forja bajo `.cab-fs-files`; `cabina-sala.css`
aplica esas bases pero no las redefine fuera de ese scope. Ése es el patrón
para una eventual cuarta vista de tarjetas. Desaparecieron `.cab-sala-card`,
`.cab-sala-card-meta` y `.cab-sala-empty`, y ya no hay clases propias para el
control de apertura ni el título; en la lista sólo sobreviven
`.cab-sala-card-status`, `.cab-sala-card-unread`,
`.cab-sala-card-unread--mention`, `.cab-sala-peers` y `.cab-peer-dot`.

La grilla tampoco necesita breakpoints de columnas: usa
`repeat(auto-fill, minmax(min(100%, clamp(260px,21vw,290px)), 1fr))`, que da 4
columnas a 1600 px, 3 a 1400, 2 entre 1100 y 700 y 1 a 390. No hay que agregar
media queries para gobernar ese número. El separador ` · ` entre personas y
última actividad forma parte del TEXTO de `.cab-fs-item-meta`, no de un `gap`
de CSS: si ese contenedor termina siendo flex sin gap, de otro modo aparecen
cadenas pegadas como «3 personas + CuchoÚltima actividad: …».

GOTCHA — el `icon()` LOCAL de `js/cabina/main.js` no es el catálogo común: sólo
tiene cinco entradas (`back`, `search`, `send`, `warning`, `rest`) y cierra
con `paths[name] || '<circle cx="8" cy="8" r="5"></circle>'`. Cualquier otro
nombre produce un círculo gris sin error ni log. Así nació `console:BUG-3164`: Conexiones
mostraba todos sus íconos como circulitos, y un grep no lo encontró porque las
llamadas eran dinámicas (`ctx.icon(name)` desde un helper), no literales. Toda
vista de Cabina que necesite otro ícono debe importar `icon` de
`public/js/ui/icons.js`, el catálogo real; buscar sólo usos literales NO cubre
las llamadas dinámicas, que son precisamente las más propensas a equivocarse
de nombre. Por eso el ícono `room` de Salas viene de ese catálogo y `salas.js`
lo consume como `icon('room', { className: 'cab-fs-icon' })`.

GOTCHA — `POST /api/chat/close` NO borra: deposita en la papelera. El método
`Chat.close()` llama a `trashChat()` (`src/modules/chat/index.js:2530`) y la
entrada sobrevive 30 días (`CHAT_TRASH_TTL_DAYS`, `src/modules/chat/trash.js`),
recuperable con `/api/chat/trash/restore`. Pero Modo Cabina NO tiene pantalla
de papelera: la consola de desarrollador la expone en `sessions.js`, Cabina no.
Desde Cabina, entonces, ese borrado SE VE definitivo sin serlo, y por eso la
confirmación de `deleteChat()` dice que se recupera «pidiéndosela a quien te dio
el acceso» en vez de mandar a un botón que en esta piel no existe. Si algún día
se suma una vista de papelera a Cabina, ese texto queda mintiendo al revés y hay
que corregirlo.

El menú `⋯` de una conversación (`openChatMenu()` en `conversaciones.js`) arma
sus opciones con un ternario sobre `chat.archived`, y la rama «archivado» es
fácil de dejar vacía sin que nada falle: «Mover a una carpeta…» ya se
deshabilita sola con `disabled: chat.archived` y «Archivar conversación» se
oculta, así que una archivada se queda con renombrar y nada más. Eso fue
`console:BUG-3179` — archivar era un viaje de ida. Al tocar ese menú, revisá
SIEMPRE las dos ramas: la de activa se prueba sola al usar la consola, la de
archivada hay que ir a buscarla dentro del `<details>` de «Archivadas».

El cruce de `cab-sala-*` entre `salas.js` y `cabina-sala.css` sigue siendo una
verificación útil, pero cubre ÚNICAMENTE las clases propias; las compartidas
`cab-fs-*` viven en `cabina-explorador.css` y no entran en ese cruce. Al
comparar el CSS hay que limitar el grep a `.cab-sala-*`, porque el barrido
crudo también captura `cab-sala-pulse`, que es un `@keyframes`, no una clase.
GOTCHA: la versión anterior se escribió en dos delegaciones paralelas con un
contrato que fijaba nombres, pero no el ROL de cada clase. El JS hizo del
control acordado para «abrir» el envoltorio de TODO el contenido; el CSS lo
trató como un botón chico en `grid-column: 2`. Ambos cumplieron el contrato y
el cruce dio 55/55 exacto, pero a 1044 px la tarjeta dejó 429 px vacíos a la
izquierda y pegó los textos sin separación. Un contrato entre piezas
paralelas debe declarar si cada clase es contenedor, área de grilla o control,
y la verificación debe medir el LAYOUT —posiciones y tamaños reales—, no sólo
la presencia de clases y texto. Justamente por eso aquel cruce dio verde con
la tarjeta rota.

La hoja satélite sigue el precedente de `cabina-explorador.css`:
`cabina.html` la enlaza DESPUÉS de `cabina.css`, y por eso no debe redefinir
bases como `.cab-btn`, `.cab-panel` o `.cab-view-state`; al cargar después las
pisaría en TODAS las vistas.

La lista obtiene fecha y orden de `GET /api/chat/list`. Para habilitarlo se
agregó `lastActivity` al `info()` de `src/modules/chat/index.js`; representa la
actividad general del Chat y su marca se persiste y recupera al rehidratar tras
un reinicio, no la fecha del último mensaje humano.

GOTCHA — el Service Worker del puerto 8092 se registra al final de
`public/js/main.js`, NO desde el HTML: buscar `serviceWorker` sólo en
`index.html` o `cabina.html` da cero y lleva a una conclusión falsa.
`index.html` carga `/js/main.js` y por eso lo registra; `cabina.html` carga
`/js/cabina/main.js` y no lo hace. Sin embargo, un Service Worker controla el
ORIGEN entero: si antes se abrió la consola completa en 8092, ese worker
también intercepta `/cabina` y sus CSS en ese mismo puerto.

La invalidación depende del `BUILD_ID` que el servidor obtiene con
`git rev-parse --short HEAD`. Los cambios sin commitear no alteran ese id, por
lo que el worker no purga su caché y puede seguir sirviendo archivos viejos
aunque el disco esté correcto. Para verificar Cabina en un navegador real hay
que usar su puerto propio (`CWC_CABINA_PORT`, hoy 8093): allí `/` sirve
`cabina.html`, que no registra el worker. Playwright no hereda el problema
cuando abre un contexto nuevo, porque ese contexto empieza sin el Service
Worker previamente registrado en 8092.

### public/js/onboard/onboard.js — wizard público de alta

Secuencia de siete posiciones:
`token → register → creds → account → codex → infisical → done`. `creds`
(`claude setup-token`) es obligatorio para trabajar; `account` conecta la
cuenta Claude completa y es opcional, igual que Codex e Infisical. Su objetivo
es habilitar en el panel Uso los porcentajes reales de la sesión de 5 horas y
de la semana; si se omite, el usuario sigue trabajando y solo ve sus tokens
consumidos.

El paso `account` pollea `claude-account-status`, limpia el poll al salir y
conserva la URL recibida. Si existe URL, el enlace y el campo de código deben
seguir visibles en cualquier estado no terminal (`starting`, `waiting-url`,
`url`, `waiting-code`, `verifying`): el CLI corre en el servidor sin entorno
gráfico, no puede abrir el navegador del usuario y el runner pasa de `url` a
`waiting-code` casi de inmediato. El indicador tiene siempre siete columnas;
los índices son token 1, register 2, creds 3, account 4, Codex 5, Infisical 6 y
done 7.

Al entrar en `done`, el wizard pollea `provision-status` hasta 20 intentos cada
3 s mientras siga `pending`. El checklist muestra el estado real del Pad y del
clon del workspace; si alguno falla, el título se degrada a
“⚠️ Casi listo”.

## Gotchas de esta carpeta

- `apiCreateSession` (`js/main.js`) propaga el campo `error` que devuelve el
  backend para que el modal muestre el motivo accionable. Todo helper `fetch`
  nuevo del frontend debe hacer lo mismo: un modal que repite un texto genérico
  deja al usuario y al operador sin diagnóstico.

- `#sidebar` en móvil (`@media (max-width:768px)` de style.css): overlay con
  ancho `min(78vw, 300px)` (tope en px para que NO crezca proporcional en
  teléfonos grandes) + `#sidebar-scrim` (velo, `--cwc-scrim`, ~index.html
  entre `</aside>` y `<main>`) que lo atenúa y se cierra con un tap (handler
  en main.js). Ocultar usa `transform: translateX(-100%)`, NO `margin-left`
  con un vw hardcodeado — un % de `margin` se resuelve contra el CONTENEDOR,
  no contra el propio ancho del elemento, así que si el ancho vuelve a
  cambiar, `margin-left` quedaría desincronizado; `transform: -100%` siempre
  es exacto porque un % ahí SÍ se resuelve contra el propio elemento.

- Cabecera del sidebar: el slot del launcher (`.sidebar-top`,
  `[data-module="launcher"]`) vive DENTRO de `.sb-head` de la barra DERECHA
  (`#sidebar-right` desde 2026-07-07), en la MISMA fila que el ☰ derecho
  (flex:1 llena el espacio junto al botón). En el rail colapsado de la barra
  derecha el launcher se oculta (only-expanded) y queda la columna ☰ + "+"
  (only-collapsed). El botón usa `.sb-new-btn` (34px, mismo alto que el ☰).

- El chip del usuario conectado (`#acct-chip` = `.acct-avatar` con la inicial
  + `.acct-name`) vive en `.sb-head` de `#sidebar`, NO en el pie: se movió el
  2026-07-31 a pedido de Niko porque abajo quedaba espachurrado entre el botón
  de tokens y la fila de íconos, mientras esa cabecera tenía toda la fila vacía
  al lado del ☰. La clase `.acct-user` ya no existe; quedó solo el id
  `acct-user`, que main.js sigue usando junto con `acct-avatar` y `acct-chip`
  en el `whoami.then(...)`. Trampa concreta: el `flex:1` de la vieja
  `.acct-user` era lo ÚNICO que empujaba los íconos del pie contra el borde
  derecho; al sacarla hay que reponer ese empuje o el pie se colapsa a la
  izquierda. Hoy lo hace
  `.footer-acct > [data-module="usage"] { margin-right: auto }`. Esa misma
  regla hay que NEUTRALIZARLA en el rail colapsado con
  `#sidebar.collapsed .footer-acct > [data-module="usage"] { margin-right: 0 }`,
  porque ahí el pie es `flex-direction: column` y un margen auto GANA sobre
  `align-items: center`: medido con Playwright, descentraba el botón de tokens
  4px a la izquierda.

- `#rail-tabs` (chips de pestañas ABIERTAS) vive en la barra DERECHA
  (`#sidebar-right`, con Sesiones) desde 2026-07-07 y se oculta con
  `#sidebar-right:not(.collapsed) #rail-tabs { display: none; }` (antes el
  selector era `#sidebar` — se movió con los chips): en el rail COLAPSADO de
  escritorio (`#sidebar-right.collapsed`) sigue siendo la ÚNICA forma de
  cambiar de pestaña (la lista "Sesiones" se oculta ahí, así que la regla base
  `#sidebar-right.collapsed #rail-tabs { display:flex }` la muestra en columna);
  en desktop expandido Y en móvil (la barra nunca colapsa ahí,
  `applySidebarState` lo fuerza) es redundante con las tarjetas de Sesiones, que
  ya cambian de pestaña vía `focusSession`/`openChatView` sin depender de este
  chip. Si se vuelve a tocar, verificar que el rail colapsado de la barra
  derecha no se rompió (ahí `#rail-tabs` sigue siendo indispensable).

- Splash de arranque (`#boot-splash`, index.html): overlay con el Pac-Man
  compartido que cubre desde el primer paint hasta el fin del boot. Tres
  piezas coordinadas: (1) markup ESTÁTICO en index.html que espeja
  ui/pacman.js — no puede usar el helper porque existe antes de cargar
  cualquier módulo JS; si se cambia pacman.js, actualizar también el HTML —
  con `window.__bootHide` + timeouts (aviso 8 s, forzado 12 s) definidos
  INLINE como red de seguridad que corre aunque main.js nunca cargue;
  (2) CSS en style.css (z-index 300, sobre modales 200/popups 210; usa las
  clases .cwc-pacman de ui.css — seguro al primer paint porque los <link>
  de CSS son render-blocking); (3) main.js escribe textos de progreso
  reales en #boot-msg (bootMsg) y desmonta con __bootHide en el `finally`
  del IIFE de arranque. La barra de progreso (#boot-bar + window.__bootPct)
  salta por HITOS REALES, no por timer: 10 HTML+CSS pintados · 15 vendors
  del <head> bajados (script inline) · 28 idioma cargado (PLAN i18n,
  2026-07-19: initI18n(whoami().lang)+applyI18n(document), ANTES de montar
  módulos para que arranquen ya en el idioma correcto) · 35 módulos montados
  · 60 restaurando sesiones (antes del fetch) · 72 con el CONTEO real
  ("restaurando N sesiones…") · 85 esperando historial del chat activo · 100 al
  destapar; la
  transición CSS de width interpola entre hitos. Si se agrega una fase al
  boot, asignarle su hito acá y en bootMsg(texto, pct). Antes de destapar, si el tab ACTIVO es un chat, el
  boot espera `tab.ready` (promesa del ChatTab resuelta al terminar de
  procesar el PRIMER evento `history` del attach — señal real de "historial
  renderizado", no un timer) con tope de 8 s: sin eso el chat aparecía
  vacío unos segundos tras caer el splash. No agrega velocidad real: es
  percepción; la espera del HTML inicial solo la mejora cache/compresión
  (pendiente).

- Toda página PÚBLICA (`login.html`, `onboard.html`) solo puede depender de
  assets registrados a mano en `src/server.js` ANTES del gate de auth. La
  trampa concreta fue que `onboard.js`, aunque público, hacía
  `await import('/js/ui/i18n.js')` en su primera línea y ese módulo no era
  público: el 401 rechazaba la promesa del IIFE, el wizard no renderizaba y
  quedaba una tarjeta vacía sobre fondo negro. No se detectó antes porque en un
  navegador CON sesión el import atraviesa el gate y todo se ve bien; el bug
  solo aparece sin cookie, justo el estado del único público real del
  onboarding, un usuario nuevo. Regla: probar `/onboard` y `/login` SIEMPRE en
  un contexto limpio (ventana privada o contexto nuevo de Playwright), nunca
  en la pestaña donde ya estás logueado.

- `src/server.js` lee `public/index.html` UNA SOLA VEZ al arrancar para
  inyectarle el `BUILD_ID` (ver `src/server.js:89`): cualquier cambio de MARKUP
  en index.html NO se ve hasta reiniciar el servicio con
  `systemctl --user restart claude-web-console`, aunque el CSS y el JS sí se
  sirven frescos del disco. Verificar un cambio de index.html sin reiniciar da
  un falso negativo: el navegador recibe el HTML viejo aunque el archivo en
  disco ya esté bien.

- `.chat-live` vive inmediatamente arriba del composer y contiene tarjetas
  compactas `.live-card` para Codex y revisiones automáticas. Usa exclusivamente
  tokens de `tokens.css`, barra fría, estados verde/rojo, pulso e indeterminado;
  `prefers-reduced-motion` apaga todas sus animaciones. En móvil limita su alto
  y scrollea internamente para no expulsar el hilo ni el composer.
