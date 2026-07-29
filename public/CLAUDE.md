<!-- cwc:ficha-modulo -->
# public — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### public/index.html + js/main.js  app principal: módulos frontend { name, mount(el, ctx) }
montados por [data-module]; ctx={icon,dialog,bus,whoami,...}
(patrón completo en docs/frontend-modules.md).
DOS BARRAS LATERALES (2026-07-07, pedido del usuario "Sesiones
ocupa mucho espacio"): #sidebar IZQUIERDA = control/módulos
(Tickets & Features → Pendientes → Comunicaciones, en ese orden)
+ pie de estado (plan-limits · usage · cuenta · explorador ·
system). #sidebar-right DERECHA = Sesiones + "Nueva sesión"
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
adelgaza header/botones/cuerpo de TODAS las secciones (Tickets ·
Pendientes · Comunicaciones · Sesiones): .sec-head fino, botones del
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
En MÓVIL ambas barras son drawers overlay que se abren con DOS ASAS
flotantes (#sidebar-handle izq = módulos / #sidebar-right-handle der
= Sesiones; look compartido espejado, solo móvil) UBICADAS SOBRE EL
COMPOSER (bottom: calc(64px + safe-area) — pedido del usuario
2026-07-07: antes al medio del borde estorbaban) — la izquierda
también responde al ☰ header/auxbar (cwc:open-sidebar). Cada drawer
con su scrim (#sidebar-scrim / #sidebar-right-scrim, hermano `~`
:not(.hidden)). FIX scroll fantasma (mismo pedido): en móvil los
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
.task-*), tickets (.bv2-sum-main), gestor (.fm-body/.fm-item/.fm-toolbar).
REGLA: al agregar UI nueva, heredar de los primitivos y usar fs-sm/fs-xs
para filas/controles densos; fs-lg/fs-xl SOLO para títulos prominentes.
### public/css/style.css       estilos de módulos y del chat. Los bloques
`.md-chart*` (Chart.js + tabla accesible) y `.md-bar*` (micro-barras inline)
pertenecen al renderer Markdown. El gráfico va SIN borde, fondo ni padding
lateral A PROPÓSITO — pedido de Niko: se lee como parte del mensaje, no como
un objeto pegado. `.md-mermaid*` contiene el desborde con scroll horizontal
y `.md-mermaid--pan` muestra la pista para deslizar. El `max-height` de
`.md-mermaid-canvas` es la FUENTE DE VERDAD del alto: el JS lo lee del CSS.
La tabla accesible `.md-chart-data` es sr-only pero NO está escopada a
`.chat-md` (el renderer también se usa en Aprendizaje y Pendientes) y depende
de que `.md-chart` sea `position:relative` para no escaparse del scroller del
chat; `#body` lleva `overflow:clip` como guard para que ningún desborde vuelva
a hacer scrollear el documento.
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
`stream.js` separa las líneas `isSidechain:true` del
transcript en una sesión propia `<sid>~sub` (flag `sub:true`);
el front les da BANDA propia más ANGOSTA (peso 0.6 en el
reparto de `relayout`) con rótulo `↳`. Subagentes concurrentes
del mismo padre se funden en UNA banda (no se pueden separar
desde bytes apendeados). (C) TERMINALES bash — nuevo endpoint
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
fuente de la lluvia). Sin ese wrap, un párrafo de transcript de 540 chars
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
