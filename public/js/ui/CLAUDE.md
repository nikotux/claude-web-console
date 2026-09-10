<!-- cwc:ficha-modulo -->
# public/js/ui — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### places.js
`placeFor()` conserva la resolución exacta de `PLACES`; `resolvePlace()` suma
los worktrees efímeros `~/.cwc-data/tolkien-envs/<envId>/tree` como una capa
aislada de Tolkien, con `envId` e ícono propio, sin cambiar launcher ni "Abrir en".
`PLACES` incluye `mi-espacio` como “Mi espacio” (ícono `home`, descriptor
exportado `MYSPACE_PLACE`). `placeFor()` también recorta el prefijo absoluto
`/home/<host>/.cwc-users/<user>/workspace/`, para que las rutas de inquilinos
recuperen la misma identidad de lugar que las rutas relativas y las del host.
Contraparte BACKEND del mismo concepto: `src/core/worlds.js` (`worldLabelFor(cwd)`), que también reconoce esos worktrees como Tolkien. Son DOS capas deliberadas — frontend y backend no comparten módulos y `ui/places.js` es la fuente frontend por diseño —, no una copia olvidada de la otra: si cambia la ruta de los entornos hay que tocar las dos (`console:BUG-2074` nació justamente de dos copias desincronizadas del mismo helper).

### profile.js
`profile.js` es el primitivo compartido y la fuente ÚNICA del recorte de
superficie por perfil. `GET /api/whoami` entrega `profile: 'sponsored' | 'full'`:
vale `sponsored` si `sponsorshipState(username)` devuelve `sponsored` o
`awaiting-sponsor`, y `full` en cualquier otro caso —incluidos los principals
`token`—; ante un error también cae a `full`. El módulo exporta
`isSponsored(me)`, `HIDDEN_FOR_SPONSORED` (módulos `tolkien`, `tickets`,
`visado`, `retro`, `stats`), `HIDDEN_SYSTEM_PANELS_FOR_SPONSORED` (paneles
`skills`, `interfono`) y `allowModule(me, name)`. Ningún consumidor mantiene
listas propias.

El FAIL-OPEN es deliberado: identidad ausente o perfil desconocido muestra
TODO, para que un fallo de carga no deje a alguien sin consola. Es la asimetría
intencional respecto de los gates del backend, que son fail-closed. La tabla
interna es un `Map`, NO un objeto plano, a propósito: un perfil llamado
`constructor` o `toString` resolvería una propiedad heredada del prototipo del
objeto y rompería ese fail-open. Al agregar un perfil se suma una entrada a la
tabla y sus sets en ESTE archivo; no se reescribe la lógica ni se dispersan
listas entre consumidores.

El recorte usa siempre el atributo `hidden`, respaldado por el guard global
`[hidden]{display:none!important}` de `ui.css`; nunca `style.display`.
`main.js` consulta `allowModule`, Sistema consume la lista compartida de
paneles y el launcher patrocinado oculta entero «Tipo de sesión», fija el tipo
en `chat` y oculta Tolkien: quedan «Mi espacio» y «Otra carpeta». Este recorte
es de EXPERIENCIA y NO es seguridad: ocultar o no montar una superficie jamás
autoriza ni desautoriza nada. La protección real sigue en el backend mediante
`isAdmin` y ownership por usuario; todo endpoint nuevo que la necesite debe
incorporar allí su gate.

### public/js/ui/               icons.js (único set de íconos) · dialog.js (CERO diálogos nativos:
openModal/confirmDialog/promptDialog/alertDialog/textEditorDialog +
confirmSheet — confirmación ADAPTATIVA 2026-07-07: en desktop delega en
confirmDialog (ventana centrada), en móvil (matchMedia max-width:768px)
muestra un "menú de deslizamiento" = bottom sheet .dlg-sheet que sube
desde abajo, con grip + swipe-down para cancelar + botones full-width
táctiles 44px; devuelve Promise<boolean> igual que confirmDialog. Lo usa
el botón "Detener" del chat (chat-tab.js: confirma antes de enviar
{type:'interrupt'} — Parar/Cancelar). Estilos .dlg-sheet* en ui.css) ·
markdown.js (renderer sanitizado por ALLOWLIST + TRES mejoras posteriores:
`enhanceChartBlocks(root)` convierte bloques `chart` con JSON en Chart.js
(`doughnut|pie|bar|hbar|line`, hasta 6 por mensaje; `hbar` normaliza a
`bar` + `indexAxis:'y'`; bar/line admiten hasta 4 series). El JSON del
modelo NUNCA llega a `new Chart()`: `parseChartSpec()` valida y normaliza
campo por campo con allowlist estricta, topes (`CHART_MAX_CHARS=8000`, 24
labels de 40 chars) y `chartConfig()` reconstruye la config desde cero;
JSON/type inválido degrada a fuente visible + `.md-chart-error` sin romper
el mensaje. `chartTheme()` toma CERO hex: lee con `getComputedStyle` la
paleta `CHART_PALETTE` de tokens.css y la cicla con módulo. `liveCharts`
destruye al siguiente barrido las instancias cuyo canvas ya no está
conectado, porque Chart.js retiene canvas/listener de resize. Cada figure
incluye tabla `.md-chart-data` sr-only con `clip-path` — NUNCA
`display:none`, que también la ocultaría del lector — y la fuente queda
plegada en `.md-chart-src` ("Ver datos del gráfico").
`enhanceInlineBars(root)` convierte SOLO una celda `td`/`th` cuyo texto
completo matchea `{bar:NN}` en micro-barra + porcentaje, creando nodos DOM
después del sanitizado. Mermaid ya NO es miniatura: `fitMermaidSvg(canvasEl)`
encaja el SVG proporcionalmente como `object-fit:contain` desde su `viewBox`
(fallback defensivo a `getBBox()`), limpia `width`/`height` y los
`maxWidth`/`minWidth` inline de Mermaid sin borrar el `background`, y calcula
`fitScale=min(anchoDisponible/w,altoMax/h,MERMAID_MAX_SCALE)`; el tope inline
1.5 evita que un diagrama mínimo se vuelva un cartel (bajado desde 2.2 el
2026-07-29 a pedido de Niko: los diagramas reales ya escalaban 1.23-1.50, así
que solo cambia los chicos). El tope fijo del modal desapareció con la llegada
del visor `ui/zoom-viewer.js` (`console:PLAN-2519`): el zoom del modal lo
gobierna el visor, hasta 8×, mientras `MERMAID_MAX_SCALE=1.5` sigue rigiendo
SOLO el encaje inline del chat. El piso de legibilidad
`MERMAID_MIN_SCALE=0.85` se aplica como
`max(fitScale,min(MERMAID_MIN_SCALE,altoMax/h))`: ese `min` interno es
DELIBERADO para que un diagrama muy alto pueda bajar de 0.85 y siempre entre.
Ese alto se lee de `max-height` en el CSS del canvas (padding descontado;
fallback `innerHeight*0.70`), no se duplica en JS. El fit corre al insertar,
en el siguiente `requestAnimationFrame` y mediante un `ResizeObserver` por
canvas; `mermaidObservers`, como `liveCharts`, desconecta targets muertos al
siguiente barrido. Si sobra ancho, el holder recibe `.md-mermaid--pan`, scroll
horizontal y una pista para deslizar o usar "Ampliar") · diff.js · popup.js
(dismissablePopup) ·
zoom-viewer.js (visor modal GENÉRICO con zoom y paneo: recibe un NODO, no un
SVG, para que el lightbox de imágenes del chat pueda reutilizarlo tal cual.
El JS fija `transform-origin:'0 0'` sobre `.zv-stage` y es FUNCIONAL, no
cosmético: toda la matemática del zoom hacia el puntero supone el origen en
la esquina; con el origen central por defecto el punto focal deriva en cada
paso. Por la misma razón el CSS NO debe declarar `transform` ni `transition`
sobre `.zv-stage`: una transición pelea con el pinch y hace que el zoom se
sienta con lag. `touch-action:none` en `.zv-viewport` tampoco es opcional:
sin eso el navegador retiene el gesto y el visor no recibe nada en celular;
el pinch NATIVO no sirve como alternativa porque la app bloquea adrede el
scroll del documento con `body{position:fixed}` para corregir el hueco negro
del teclado móvil, y el gesto nunca llega. `clampPan()` tiene DOS conductas
por eje a propósito: centra el eje donde el contenido entra completo y limita
el que desborda. Consecuencia medible al probar: el punto bajo el cursor queda
clavado SOLO en el eje que DESBORDA; se mueve en el eje centrado y es correcto,
no un bug (verificado: drift de 0.002 px con desborde en ambos ejes, ~19 px
cuando el eje está centrado). El visor NUNCA intercepta `Escape`: el cierre
pertenece a dialog.js y capturarlo dejaría el modal sin salida. Todos los
listeners viven en nodos del propio modal — ninguno en `window`/`document` —,
así mueren con él; en `onClose` solo se desconecta a mano el `ResizeObserver`) ·
code.js (resaltado hljs COMPARTIDO para detalles de tool calls y
diffs: SOLO con lenguaje confiable — extensión conocida o bash
explícito, nada de autodetección sobre logs — y con topes de
tamaño; hljs escapa el input así que su .value es innerHTML
seguro; en diffs se resalta LÍNEA a LÍNEA para markup balanceado
y el tinte +/− lo sigue poniendo diff.js. VISTA EDITOR: .ct-cmd/
.ct-out/.cwc-diff-line van con white-space:pre + tab-size:4 +
scroll horizontal — NUNCA wrap, la indentación se conserva como
en VS Code; .cwc-diff-line lleva min-width:max-content para que
el tinte +/− cubra todo el ancho scrolleable) ·
help.js + help-index.js (sistema unificado: botón "?" estándar,
modal multi-columna por tema y hub "Guía de la consola"). Un tema
exporta default una función que devuelve `{title, icon?, intro?,
sections:[{title, icon?, wide?, blocks:[]}]}` según el contrato
detallado en help.js. El índice conserva metadatos y carga cada tema
bajo demanda con `import()` dinámico. GOTCHA: toda superficie nueva
debe sumar su entrada a help-index.js; un `helpBtn()` con un id ausente
abre "Todavía no hay ayuda para esta sección") ·

CIERRE I18N/AYUDA (2026-07-31): `i18n.js` carga únicamente los diccionarios
enumerados en `MODULES`; agregar `public/i18n/en/<namespace>.json` sin sumar
ese namespace a la lista deja el archivo muerto. `node bin/cwc-i18n-audit.js`
audita esa correspondencia, la cobertura de traducciones y la costura entre
el índice de ayuda, los `helpBtn` y sus loaders. Hay tres excepciones
deliberadas sin `helpBtn`: `sala` se abre sólo desde la Guía de la consola
porque la Sala de Aduana no tiene header propio; `auxbar` también se abre
desde la Guía porque la barra móvil no tiene header donde montar el botón; y
`stats` se abre desde la Guía porque es una fila compacta de gauges en el
footer derecho, sin header propio.

perm-center.js (CENTRO GLOBAL DE PERMISOS: pila de popups
flotantes — .cwc-permcenter/.pc-card en ui.css, z-index 190
bajo modales (200) — con los permisos PENDIENTES de todas las
conversaciones, visible desde cualquier pantalla. DOBLE
alimentación con dedupe chatId+permId: ⚡ eventos window
'cwc:perm-request'/'cwc:perm-closed' de las ChatTab abiertas
(instantáneo aunque el pane esté oculto; el replay de history
también los emite y es correcto: pendiente ⇒ popup, su closed
posterior lo retira) + 🔄 syncFromList(chats) con el poll de 8 s
de main.js (catch-up de chats SIN pestaña + limpieza de
resueltos en otro lado, con GRACIA anti-parpadeo de 12 s para
items recién llegados por WS que el poll en vuelo aún no trae).
Tarjeta = título del chat (tap → abre/enfoca la conversación,
openChatView si no hay pestaña) + ⏳ cuenta regresiva (espejo
local PERM_TIMEOUT_MS de PERMISSION_TIMEOUT_MS del server para
el evento instantáneo; el expiresAt exacto llega con el poll) +
chip de íconos con detalle expandible (REUSA .chat-perm-row/
.cp-chip/.ct-body de style.css y toolTypeIcon/
isDestructiveCommand exportados de chat-tab.js; destructivos
nacen expandidos) + ✕ Denegar / ✓ Permitir (POST
/api/chat/permission, sin WS; 409 "ya no está pendiente" ⇒ la
tarjeta se retira sola). SUPRESIÓN: el popup del chat ACTIVO no
se muestra (su tarjeta inline ya está a la vista) — setActive
llama permCenter.refresh(). Móvil ≤768px: la pila va ARRIBA
(top:52px, bajo el header) — abajo taparía el composer con el
teclado abierto. Solo chats SDK: NO cubre TUIs tmux (decidido
2026-07-04) ni toca las corridas headless de la regla 6) ·
interfono-center.js (CENTRO GLOBAL DE INTERFONO, gemelo del de
permisos, 2026-07-06: popups con los mensajes de OTRAS sesiones que
un chat aún no tomó — pendingInterfono[] de /api/chat/list, poll 8 s.
Una tarjeta por CHAT (agrupa sus mensajes) con ▶ Retomar (inyecta y
despierta el chat) y ✕ Descartar (marca entregado sin actuar), POST
/api/chat/interfono {id,action}. Suprime la del chat ACTIVO (el
watcher lo inyecta solo y aparece como burbuja). Ancla abajo-IZQUIERDA
—.cwc-intercom/.ic-card en ui.css, borde --cwc-accent-cool— para no
pisarse con el de permisos (abajo-derecha); móvil arriba-izquierda.
REDISEÑO 2026-07-10 (ver bloque completo en el módulo interfono/):
este centro modal quedó SOLO para mensajes `level:'active'` (colisión
real de archivos) y SOLO en ventanas relevantes (isChatRelevant =
tabs.has(id), F1) — lo pasivo se movió al badge de la tarjeta de
Sesiones (F2). Consume además el evento window `cwc:interfono` (push
dirigido server-side, F3) para adelantar el aviso sin esperar el poll.
Ver la ENTREGA AL CHAT del módulo interfono/) ·
pacman.js (loader Pac-Man COMPARTIDO, CSS en ui.css .cwc-pacman:
USARLO en toda espera > ~5 s — revisión profunda de Salud, triage
de Bugs, subir PR, push/backup, cálculo de Uso; el spinner queda
para cargas breves. El del header del chat es el mismo componente
con cls 'chat-alive' y estado vivo/dormido) ·
activity-widget.js (ACTIVIDAD EN SEGUNDO PLANO, ROAD-76 del Pad
`console`, 2026-07-11, pedido de Niko: "poder ver cuántos agentes/
runners consumen tokens en paralelo") y
`modules/system/activity-modal.js`: BORRADOS el 2026-07-22 (PLAN-892).
Historia útil: habían nacido como widget compacto en el pie de la barra
derecha, con contador de subagentes + procesos y modal árbol alimentado
por `/api/chat/list` + `GET /api/health/active-runners`; el primer
intento de ocultarlo/desconectarlo demostró la lección de UX que Niko
pidió conservar — un indicador que desaparece cuando está vacío es
indescubrible. La función vigente ya NO vive en `ui/`: la cumple
`public/js/modules/sessions.js` con el radar de la tarjeta de Sesiones y
el modal "Trabajos en segundo plano"; el botón nuevo se atenúa en 0, pero
nunca se esconde. `collectActiveRunners()` de health/shared.js sigue como
fuente de procesos server-side y ahora lo consume Sesiones) ·
token-flow.js (visualización "Manguera de tokens" del caudal de tokens:
DIRECTOR DOM con un solo rAF que anima todas las celdas .cwc-flow-cell
del documento leyendo el store compartido; suavizado por data-flow-key,
robusto al re-render. El store ref-counted pollea GET /api/tokens/flow
cada ~400 ms y el backend devuelve claude/codex globales + bySession/byCwd
con acumuladores. Helper flowBarHtml({engine,session?,cwd?,total?,compact?,dot?})
genera una celda autocontenida con punto de identidad
Claude=--cwc-accent / Codex=--cwc-accent-cool, barra de 3px con la misma
técnica de gradiente fijo revelado que límites del plan y número t/s. Las
barras GLOBALES viven a la derecha de los headers "Claude"/"Codex" de
los límites del plan en renderLimits; se extienden a todo el ancho
disponible, sin punto (el texto ya identifica), y se limpiaron los textos
"✦ Claude · Max" / "🤖 Codex CLI · ChatGPT Plus" a solo "Claude"/"Codex".
Se eliminaron el widget de la barra derecha, el botón 💧, el modal
dedicado y la sección de caudal del modal Uso. Las tarjetas de Sesiones
quedan revertidas a título + modelo; las 2 barras de caudal POR SESIÓN
viven en el header del chat activo (.chat-flow), A LA IZQUIERDA,
inmediatamente después del título y la insignia de mundo: Claude por
sessionId → bySession y Codex por cwd → byCwd, con tps + acumulado. Su
margin-right:auto (style.css, regla `.chat-flow`) es lo que ancla
Pac-Man/badge de modelo/select de modo/ayuda a la derecha; el título dejó
de ser flex:1 y pasó a flex:0 1 auto + min-width:0 para seguir truncando
con ellipsis. Reubicación pedida por Niko el 2026-07-22. El sessionId
viaja ahora en _historyPayload junto a cwd/world para poblar esa barra
al abrir/reconectar. GOTCHA BUG-920 (Pad `console`): la clave de `byCwd`
sale del `cwd` del `session_meta` (primera línea del rollout de Codex) y
ESA LÍNEA NO TIENE TAMAÑO ACOTADO. Codex 0.142.4 le metió
`base_instructions.text` completo (~22 KB medidos el 2026-07-22) y el
lector fijo de 4 KB la truncaba: JSON.parse fallaba, cwd quedaba null,
addTotal() descartaba el evento y byCwd quedaba VACÍO → la barra de
Codex por sesión marcaba 0 para siempre, aunque el caudal GLOBAL de Codex
sí contaba (no usa esa clave). Por eso `readCodexCwd`
(src/modules/tokens/flow.js) lee la primera línea COMPLETA en chunks de
64 KB hasta el `\n` con tope duro de 1 MB (incluye EOF sin newline), y la
caché `fileCwd` guarda SOLO resultados definitivos: un fallo de I/O,
truncamiento por tope o parseo roto NO se cachea, para que el próximo
scan reintente. Lección general: leer un campo del encabezado de un
archivo de un tercero con buffer de tamaño FIJO es frágil — leer hasta el
delimitador, con tope.
PESO DEL CACHE READ EN EL CAUDAL (2026-07-19, pedido de Niko: "la barra
de Claude siempre está en 0 o full, nunca intermedia"). CAUSA RAÍZ (mismo
villano que la barra de Sesión 5h): flow.js (extractClaudeEvent) sumaba el
cache_read a peso COMPLETO. En cada paso del agente Claude RE-LEE todo el
contexto cacheado (100-200k tokens), así que el caudal era ~95% relecturas
→ medido 29-38k tps crudos vs MAX_TPS 8000 → barra CLAVADA en 100%. FIX:
el cache read pesa CACHE_READ_WEIGHT=0.1 (alineado con pin/pout del costo;
input+output+cache_creation quedan a peso 1 = input procesado por primera
vez). Codex igual (extractCodexEvent): su `input_tokens` YA INCLUYE
`cached_input_tokens` (verificado: input 21808 ⊇ cached 20864, total=
input+output) → se descuenta el cache del input y se re-suma ×0.1; si no,
`total_tokens` contaría el cache a peso completo y Codex se saturaría igual.
Con el peso, el caudal ponderado GLOBAL pica ~7k en actividad alta →
MAX_TPS se recalibró 8000→10000 (token-flow.js) para dar cabeza a picos
multi-chat sin clavarse; la curva sqrt de pressureFromTps deja un caudal
típico de 1 chat (~1-3k) en la zona media visible (32-55%). Verificado
E2E: caudal crudo 29-38k→100% siempre ANTES; DESPUÉS backend ponderado
0/3.5k/7.2k con variación real → barra pintó fill 26% con 680 tps
(intermedio, ya no clavada). El `tokens60` acumulado queda ponderado
también (coherente con el resto de la app que cuenta cache read ×0.1).)

## Gotchas de esta carpeta

- `models.js` es la fuente ÚNICA de las listas de modelos:
  `CHAT_MODEL_OPTIONS` incluye los alias exclusivos del chat (`auto`, `tandem`)
  y toda superficie que lance el CLI real (launcher, submenú de Sesiones) debe
  usar `TUI_MODEL_OPTIONS` / `CHAT_ONLY_MODELS`, nunca filtrar por su cuenta.
  El filtro duplicado fue la causa del 400 de `console:PLAN-2115`.

- `renderMarkdown()` (public/js/ui/markdown.js) DEVUELVE UN NODO DOM ya
  sanitizado, NO un string. Interpolarlo en un template de innerHTML
  (`` `<div>${renderMarkdown(x)}</div>` ``) imprime literalmente
  `[object HTMLDivElement]` (bug real 2026-07-10 en learning.js — notas/
  explicación; el mismo patrón roto sigue en tasks/tasks.js). Dos usos
  correctos: (a) appendChild del nodo (como chat-tab.js), o (b) si NECESITÁS
  string para innerHTML, tomá `renderMarkdown(x).innerHTML` (learning.js usa
  el helper `mdHtml` para eso — sigue siendo seguro porque el nodo ya pasó
  por sanitize()).

- El ORDEN de `renderMarkdown()` es parte del contrato de seguridad:
  `sanitize → enhanceInlineBars → enhanceCodeBlocks → enhanceChartBlocks →
  enhanceMermaidBlocks`. `enhanceInlineBars` va DESPUÉS de `sanitize()` y
  usa `createElement`, por eso `SPAN` NO necesita entrar al ALLOWLIST. Si se
  mueve antes del sanitizado o se reescribe con `innerHTML`, se abre un
  agujero: no cambiar ese orden sin revisar de nuevo todo el límite de
  confianza.

- `MARK` pertenece al ALLOWLIST de `markdown.js`, pero su atributo `class`
  queda restringido por regex a `key|ok|warn|bad`, siguiendo el mismo patrón
  cerrado de `code class="language-*"`. No admite ningún otro atributo ni
  clase; el orden del pipeline de `renderMarkdown()` no cambió.

- Mermaid: el `holder` `.md-mermaid` contiene DOS `<svg>` — el ícono del botón
  `.md-mermaid-zoom-btn` (insertado ANTES del canvas con `insertBefore`) y el
  diagrama, dentro de `.md-mermaid-canvas`. Por eso NUNCA se busca el diagrama
  con un selector que arranque en el holder: `querySelector` devuelve el
  PRIMERO en orden de documento, que es el ícono. Mordió DOS veces: en CSS
  `.md-mermaid svg` estiraba la lupa a ~70px, y en JS `openMermaidZoom()` hacía
  `holder.querySelector('svg')` y el modal "Ampliar" mostraba una lupa gigante
  en vez del diagrama (`console:BUG-2502`, 2026-07-31). Selector correcto
  SIEMPRE acotado al canvas: `.md-mermaid-canvas > svg` en CSS,
  `.md-mermaid-canvas svg` en JS. El blindaje
  `.md-mermaid .cwc-icon { width:auto; height:auto; max-width:none; flex:none; }`
  evita además que una regla futura del canvas deforme el badge. Si algún día
  se suma un tercer control con ícono al holder, la regla no cambia: el
  diagrama se pide por su canvas, nunca por el holder.

- Mermaid: NUNCA forzar `width:100%` sobre un SVG con `viewBox`: deforma el
  encuadre en vez de hacer un fit proporcional. Caso medido: un mindmap
  natural de 127×476 terminó en 1076×4037 px (×8.5) dentro de un canvas de
  665 px; el usuario veía apenas el 16% del diagrama.

- Mermaid: el `max-height` de `.md-mermaid-canvas` en CSS es la FUENTE DE
  VERDAD y `fitMermaidSvg()` lo lee con `getComputedStyle`; no duplicar ese
  número en JS. El valor JS de 70% y el móvil CSS de 62vh se desincronizaron
  en silencio y dejaron un flowchart TD de 591 px dentro de una caja de 523.

- Mermaid — PALETA SEMÁNTICA (2026-07-30, `console:PLAN-2353`): los colores NO se
  escriben en el diagrama. `public/index.html` resuelve los tokens de `tokens.css` a
  HEX en runtime (Mermaid pasa cada color por khroma, que NO entiende `color-mix()`
  ni `var()`), arma ocho roles — `key ok warn bad info cool deep muted` — y los
  publica en `window.__cwcMermaidPalette`. `withMermaidPrelude(src)` de markdown.js
  lee esa paleta y ANEXA los `classDef` faltantes al source antes de renderizar, así
  `A:::ok` funciona sin que el autor escriba un solo hex. Dos límites que ya
  costaron una iteración: el preludio se aplica SOLO a `flowchart`/`graph` (un
  `classDef` dentro de un `mindmap` rompe la sintaxis), y el `<details>` "Ver código
  Mermaid" muestra el source ORIGINAL, sin el preludio — es lo que el usuario
  escribió, no lo que se renderizó.

- Mermaid — `:::clase` NO EXISTE en `mindmap` ni en `sequenceDiagram`: Mermaid dibuja
  el texto literal dentro del nodo (verificado: `Permisos:::warn` aparecía así en
  pantalla). En mindmap el color entra por CSS: Mermaid marca cada rama con
  `section-0`, `section-1`, … y `section-root`, y el `themeCSS` de index.html las
  pinta con la escala. Por eso las ramas se colorean solas y el autor no escribe
  nada. La escala del mindmap va ROTADA en 1 porque la raíz ya usa el acento.

- Mermaid — con `look: 'neo'` el borde de cada nodo es un GRADIENTE SVG
  (`stroke: url(#…-gradient)`) derivado de `primaryBorderColor`, no el color plano.
  Consecuencia medida: poner el acento en `primaryBorderColor` teñía de terracota
  TODOS los nodos y clusters, incluidos los neutros, y el color dejaba de significar
  algo. `primaryBorderColor` se queda en `--cwc-border-strong` y el acento se reserva
  para `:::key`, que gana porque las clases pisan el `stroke` con `!important`.

- Mermaid — la píldora de las etiquetas de arista va en `.edgeLabel p:not(:empty)`,
  NUNCA en `.edgeLabel .label span` / `foreignObject div`. Esos contenedores existen
  también para las aristas SIN etiqueta y quedaban dibujados como una pastilla gris
  suelta en la esquina superior izquierda del diagrama (medido: `background:
  rgb(24,28,41)` y borde de 1px en un `.edgeLabel` con `textContent` vacío).

- Mermaid: `suppressErrorRendering: true` en la config de `index.html` NO es
  cosmético. Sin ese flag, cuando el parseo falla Mermaid 11.16 dibuja su
  "bomba" de error (`Syntax error in text`) en el div temporal `div#d<id>` que
  cuelga de `document.body` y tira la excepción ANTES de ejecutar su propio
  limpiador — el div queda huérfano al final de la página, uno por cada
  diagrama fallido (los ids son únicos, así que el `removeExistingElements` del
  render siguiente tampoco lo barre) y su alto sin acotar infla el scroll del
  documento, igual que el bug de la tabla `sr-only` de los gráficos. El aviso
  real al usuario lo pone `enhanceMermaidBlocks()` con `.md-mermaid-error`; su
  `.catch()` además borra `d<id>`/`i<id>` como red de seguridad por si una
  versión futura cambia el comportamiento del flag.

- Mermaid: `:::clase` debe ir PEGADA; un `::: ok` con espacio rompe el diagrama
  entero con `Expecting 'AMP', 'COLON'`. Por eso `enhanceMermaidBlocks()`
  reintenta UNA vez con `repairMermaid()` tras un fallo de parseo, y ese
  reintento es deliberadamente el ÚNICO lugar donde se toca el source: en el
  primer intento solo corre `normalizeMermaid()`, que limpia el `:::`
  inútil de mindmap/sequenceDiagram. Si falla definitivamente, el `<details>`
  se abre y el aviso muestra la primera línea del error de Mermaid; antes decía
  "código fuente abajo" con el código plegado y sin motivo, y diagnosticar un
  caso real exigió reparsear los transcripts a mano. Caso medido en un chat de
  otro usuario: 66 diagramas históricos parseados, 64 OK, 1 falló por este
  espacio y 1 estaba truncado.

- Pac-Man — MOTOR de estados (pedido del usuario 2026-07-05, reemplaza el
  loader binario working/dormido de antes): catálogo ÚNICO en
  `ui/pacman.js` (`PAC_STATES`) + CSS puro en `ui.css` (sección "Pac-Man —
  MOTOR de estados"). Regla de diseño: la ÚNICA animación estática es
  `dormant` (nada activo ni delegado); todo lo demás se reconoce por CÓMO se
  mueve, no solo por el color — `working` (dorado, mordisco+bolitas
  viajando, el de siempre) · `delegating` (violeta `--cwc-accent-cool`, boca
  entreabierta fija + bolitas ORBITANDO ida-y-vuelta + badge con el ícono
  `relay` de icons.js — esperando la vuelta de un subagente/proceso
  delegado: Task tool, pool paralelo de salud, triage, investigar PR/ticket,
  desk-live, Optimización IA, commit-message IA) · `queued` (ámbar
  atenuado, pulso de opacidad — en cola detrás de un lock/paso serial) ·
  `waiting` (verde, parpadeo lento — tu turno) · `stale`/`error` (ámbar
  dim/rojo, ESTÁTICOS a propósito: incertidumbre o falla, no confirmación de
  actividad). API: `pacman({state, size, cls, title})` arma el markup
  (el badge del interfono SIEMPRE está en el HTML, lo muestra/oculta el CSS
  según la clase — así las actualizaciones EN LUGAR de sessions.js/
  health-review-modal.js, que solo tocan `className`, no necesitan
  reinyectar HTML); `pacClass(state, {size, cls})` arma solo la lista de
  clases para esas actualizaciones. RETROCOMPAT: `pacman()` SIN argumentos
  sigue significando "trabajando" (default histórico, lo usan los loaders de
  Salud/Backup/Optimización/Uso) y `pacman({working:true/false})` (API
  vieja) sigue mapeando a working/dormant — ningún call site no migrado se
  rompe. Consumidores: header del chat (`chat-alive`, `_renderPacState` de
  chat-tab.js combina turno + contador de subagentes Task/Agent pendientes
  — ver `_delegatingCount`/`_toolCard`/`_toolResult`) · tarjetas de Sesiones
  (`pac-sm`, `dotInfo`/`chatDotInfo` de sessions.js) · badges/banners de
  Salud (health-review-modal.js: `pending`/`ready`→queued,
  `fixing`→delegating, batch paralelo→delegating) · Optimización IA,
  triage de Bugs, investigar PR/ticket, desk-live, sync Desk bulk (bugs
  board) → delegating · commit-message IA y guardián de contexto (Proyectos)
  → delegating · Uso (`tok-live`, `isLive` por modelo) → working/nada.
  BUG FIX 2026-07-05 (chat en modo TUI con Pac-Man CONGELADO): cuando un chat
  pasa a `viewMode:'tui'` el runner SDK se duerme y `Chat.status` (backend)
  queda frío — la actividad real vive en el pane tmux oculto `cwct-<id>`,
  reportada por el observador (`stateForPane`, `core/claude-state.js`), pero
  esas sesiones bare NUNCA se listaban (`terminal/sessions.js: list()`
  filtra `!s.bare`) así que la tarjeta del chat no tenía cómo verlo. Fix:
  `/api/tmux/sessions` (tmux/index.js) SÍ expone las `cwct-*` con su estado
  real (list-sessions no filtra por prefijo) — sessions.js las cruza por
  nombre (`chatDotInfo`, `bareNameOf(c.terminalId)`) para pintar el estado
  real de esa tarjeta, y las EXCLUYE de la lista general (`render()`
  filtra `s.name.startsWith('cwct-')`) para que no aparezcan además como
  tarjeta "Otras sesiones tmux" duplicada. Esto es lo que hacía que una
  reactivación por el interfono (o cualquier actividad en la TUI oculta) no
  se viera hasta volver a modo Chat.
  DELEGANDO server-side (`Chat._delegatingIds`, chat/index.js): un
  `tool_use` Task/Agent abre la espera, su `tool_result` la cierra;
  `info().delegating` lo expone en `/api/chat/list` para que la tarjeta lo
  vea SIN la pestaña abierta (antes el ícono de Task solo existía en el
  frontend del chat abierto, invisible para Sesiones). Invariante: `waiting`
  limpia siempre el contador (`_setStatus`) — un tool_result perdido
  (interrupt, crash) no deja la tarjeta pegada en "delegando" para siempre.
  Anatomía CSS (sin cambios): `.pac-man` es una caja 0×0 con `border-width`
  parejo + `border-radius:50%` (el borde es el círculo); `.pac-track` con 3
  `.pac-dot`; ojo = `::before`. OJO 1: el kill-switch global de
  `prefers-reduced-motion` (ui.css) tiene una EXCEPCIÓN deliberada para
  TODOS los estados animados (no solo `working`) — indicador funcional, no
  decoración; no borrarla. OJO 2: el recorrido de `.pac-dot` es
  `translateX(var(--pac-travel, -24px))`, DEBE coincidir con el ancho de
  `.pac-track`; cada variante de tamaño define el suyo (`pac-sm`:
  `--pac-travel: -18px`, 30−12). La barra TUI (`.conv-tui-bar`) NO tiene el
  vivo/dormido (su estado viene del observador de hooks, no del stream del
  SDK — plomería distinta).

- `.dlg-overlay` (ui/dialog.js) NECESITA `grid-template-columns: minmax(0, 1fr)`.
  Sin eso, la columna implícita del grid se auto-dimensiona al max-content del
  `.dlg-card` (su `max-width` en px, p.ej. 520 en el modal Sistema) IGNORANDO
  el ancho real del viewport: en mobile el modal terminaba más ancho que la
  pantalla y el texto (p.ej. `.hp-row` de la pestaña Salud) quedaba cortado
  fuera de vista en vez de achicarse/wrappear. Bug reportado por el usuario
  como "en el celular los menús de sistema no se redimensionan y el texto
  aparece cortado" — verificado y corregido con Playwright móvil (375px).
  Si se toca `.dlg-overlay`/`.dlg-card` de nuevo, no sacar ese
  `grid-template-columns` sin volver a probar en un viewport angosto.

- `.dlg-card` usa `max-height: 88dvh` (con `88vh` justo antes SOLO como
  fallback — no borrar ninguna de las dos líneas ni reordenarlas). Con `vh` a
  secas, en móvil (que mide `vh` con la barra de URL oculta) el modal podía
  ser más alto que la pantalla visible: el contenido no llegaba a generar
  scroll interno y el final del modal (p.ej. el botón Iniciar del lanzador)
  quedaba inalcanzable. Bug reportado como "en el celular no puedo bajar
  hasta Iniciar en Nueva sesión"; verificado con Playwright móvil (375×667).
  Relacionado: el lanzador muestra solo las 2 últimas conversaciones en
  "Retomar" y el resto (hasta 10, tope del endpoint /api/chat/history) vive
  en el modal "Ver más" para no empujar el botón Iniciar fuera de pantalla.
  Mismo patrón en "Abrir en": atajos fijos (Home/proyecto) + 3 recientes
  (si el destino elegido en el modal no está en el top 3, reemplaza al 3ro
  para que se vea activo) + "Ver más" AL LADO de "Elegir otra carpeta…"
  (fila `.ln-list-actions`, no apilados: el alto vertical del lanzador es
  escaso en móvil); tope de ubicaciones en `core/recents.js` (MAX = 10).

- Etiqueta de modelo: hay DOS funciones y no son intercambiables. `tierName(key)`
  (public/js/ui/models.js) es para estado EN VIVO (badge del chat, notita de
  AutoTux) y mapea `opus` → "Opus 5"; `modelName(key)` es la genérica y la usa
  el modal **Uso** para el consumo HISTÓRICO por modelo. Cambiar `modelName`
  para que diga "Opus 5" relabelaría gasto viejo de Opus 4.8 como si hubiera
  sido Opus 5 (costean igual, $5/$25, pero no es el mismo modelo). Regla: si
  el texto describe qué está corriendo AHORA → `tierName`; si describe consumo
  YA registrado → `modelName`.

- Un sr-only `position:absolute` DENTRO de un contenedor con scroll solo queda
  contenido si su containing block también está adentro. `table.md-chart-data`
  (la tabla accesible de cada gráfico) no lo tenía: su ancestro posicionado más
  cercano era `.terminal-pane` (`position:absolute; inset:0`, FUERA de
  `.chat-msgs`), así que el scroller no la recortaba y su posición estática —a
  ~4-5 mil px en un chat largo— inflaba el scroll del DOCUMENTO. Medido:
  `document.scrollHeight` 5160 px vs `innerHeight` 945; ocultando solo esas
  tablas bajaba a 945 exacto. Se veía como "la consola se rompió": la página
  scrolleaba, `#app` (100dvh) se iba hacia arriba y quedaba media pantalla
  negra. Fix: `.md-chart { position: relative }` + `top/left:0` en la tabla.
  Segundo detalle del mismo bug: una `<table>` IGNORA `width:1px;height:1px`
  (nunca baja de su min-content: medía 166×140), así que el truco sr-only de
  1×1 px no la achica — solo `clip-path` la esconde. Si agregás otro sr-only,
  anclalo a un padre `position:relative` que viva dentro del scroller.
