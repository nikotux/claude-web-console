# Contexto UI — tablero "Bugs & PRs" (`bugs/board/`)

> **Estado:** post-rediseño móvil (branch `redesign/board-mobile`, Fases 0-6,
> 2026-07-04). Radiografía del tablero YA refactorizado. El plan que guió el
> trabajo vive en `docs/plan-rediseno-movil-tickets.md`; las reglas duras en
> `CLAUDE.md` (entrada del módulo `bugs/board/`). Referencias `archivo:símbolo`
> verificadas contra el código real.
>
> El backend (`src/modules/bugfixes/`, `src/modules/bugs/`) **no cambió** en el
> rediseño: el tablero consume `GET /api/bugfixes/tickets` + `GET /api/bugs`
> tal como estaban. Las secciones de datos/endpoints (§4, §5) siguen vigentes.

---

## 1. Arquitectura del frontend (post-refactor)

El monolito de 1.378 líneas (`tolkien/bug-board.js`, un closure que mezclaba
fetching + polling + render + handlers + prompts, con el **estado UI en el
DOM**) se partió en 8 módulos bajo `public/js/modules/bugs/board/`. La inversión
clave: **el estado vive en un store, no en el DOM** → re-renderizar es seguro →
el auto-refresh de GitHub ya no se pausa con un detalle abierto.

| Módulo | Responsabilidad | Símbolos clave |
|---|---|---|
| `index.js` | Composición: modal, markup, listener delegado, timers, ciclo de vida | `openBugBoard()` |
| `store.js` | **Estado ÚNICO** (datos + estado UI) + puente motor→fila | `get/set/mutate/subscribe/reset`, `ticketToRow` |
| `render.js` | Funciones PURAS estado→HTML; único punto de re-render con scroll preservado | `render`, `renderHeader`, `renderTable`, `detailHtml`, `detailMobileHtml`, `helpHtml` |
| `actions.js` | Handlers/endpoints; escriben al store, jamás al DOM | `reload`, `ghSync`, `sendPending`, `deskLoad`, `runInvestigation`, `workOn`, `cancelPr`… |
| `polls.js` | Encuestas POR CLAVE, inmunes a re-renders | `poll(key,…)`, `stop`, `stopAll`, `isPolling` |
| `prompts.js` | Textos de los chats del ciclo + contextos inyectados | `workPrompt`, `deskChatPrompt`, `triagePrompt`, `fetchContexts` |
| `labels.js` | Fuente ÚNICA de etiquetas/estados derivados | `prEstado`, `resolutionOf`, `EV_LABEL`, `evDot`, `prCellFor`, `deskCellFor`, `segmentOfEntry`, `rowKey`, `cleanTitle` |
| `util.js` | Helpers base sin deps | `esc`, `fmtDate`, `fmtAgo` |

**Punto de entrada:** `bugs/bugs.js` (sección "Bugs & Features" del sidebar)
importa `openBugBoard` de `./board/index.js`. El modal usa `ui/dialog.js`
(`openModal` + `.dlg-card--tickets`), los popups `ui/popup.js`
(`dismissablePopup`), los íconos `ui/icons.js`, el loader `ui/pacman.js`.

### 1.1 El store (`store.js`) — fin del estado en el DOM

`get()` devuelve el estado; `set(patch)` / `mutate(fn)` lo modifican y **emiten a
los suscriptores** (el `render` de `index.js`); `reset()` limpia por apertura
(el módulo es singleton). Campos:

| Grupo | Campos |
|---|---|
| Datos | `entries` (tickets del motor aplanados), `ghRows` (PRs solo-GitHub), `triage`, `loadError` |
| Frescura | `lastGhAt`, `lastDeskAt`, `ghError` |
| Estado UI | `expanded` (Set de `rowKey` abiertas), `archOpen`, `busy` (`send`/`scan`/`ghsync`/`desksync`/`act:<key>`), `deskSyncProgress` |
| Vista móvil | `query` (búsqueda), `filter` (segmento activo) |
| Paneles lazy | `live[pr]`, `inv[pr]`, `tktInv[ticket]`, `desk[ticket]` — cada slot `{loading}`/`{running}`/`{data}`/`{error}`; sobreviven al re-render |

`rowKey(b)` (labels.js) da la clave estable de cada fila: `sid:<sessionId>` ·
`tkt:<n>` (triage) · `pr:<n>` (solo-GitHub). Reemplaza el tracking por
`[hidden]`/`dataset.loaded` del DOM.

### 1.2 Polls por clave (`polls.js`) — resilientes al re-render

Antes cada panel encuestaba con un `setTimeout` anclado a su nodo (guarda
`box.isConnected`): un re-render mataba el loop aunque el runner server-side
siguiera vivo. Ahora `poll(key,{tick,timeoutMs,onTimeout})` identifica la
encuesta por clave (`desk:519`, `inv:232`, `tktinv:519`, `desk:bulk`), con dedup
y deadline; el `tick` escribe al store y el render pinta. `stopAll()` al cerrar
el tablero corta los loops del cliente (los runners server-side siguen; el
resultado queda persistido y se relee al reabrir).

---

## 2. Vistas: tabla (desktop) vs cards (móvil)

Tabla y cards se renderizan **SIEMPRE ambas** del mismo estado; el CSS decide
cuál se ve según el breakpoint (`@media max-width:640px`). Rotar el teléfono no
pierde nada. El **mismo listener delegado** (`onListClick`) sirve a las dos:
ambas usan `.bb-row`/`.bb-detail` + `data-key`, así `closest()` resuelve igual.

### 2.1 Desktop (>640px) — la tabla original, intacta

`table.bb-table` con 8 columnas (⬤ · TKT · Título · Pipeline · Cambios · PR ·
Desk · Estado), `th` sticky, filas `.bb-row` + detalle `.bb-detail[hidden]`
expandible con `detailHtml` plano (invTopBox + chips + resumen + archivos +
timeline + GitHub en vivo + Desk + `.bb-links` de acciones). Toolbar `.bb-actions`
(Enviar pendientes · Buscar bugfixes · GitHub · 🎫 Desk · ? · frescura). Es la
paridad total con el pre-refactor (verificada).

### 2.2 Móvil (≤640px) — cards + búsqueda + segmentos (§3.1-§3.2 del plan)

- **Header** (`.bb-mhead`): búsqueda en cliente (nº ticket/título/archivos —
  input como ref ESTABLE que el render nunca re-crea) + chips de segmento con
  conteo (`Acción`/`Revisión`/`✓`/`📦`; re-tap = Todos; `segmentOfEntry`/
  `segmentOfGh`) + frescura en UNA línea + menú **⋯** (`cwc-popup-menu`: Buscar
  bugfixes · GitHub · Desk · Ayuda).
- **Card** (reemplaza `<tr>`): L1 dot + identidad (`#TKT · PR #N`) + íconos
  PR/Desk · L2 título limpio (`cleanTitle` pela `"TKT #N — "`) · L3 estado
  COMPLETO sin truncar · L4 semáforo si hay investigación cargada. Card-PR
  protagonista con borde acento + `↳ TKT` anidados. Min-alto 72px, toda la card
  es tap target.

### 2.3 Móvil — vista de FOCO del detalle (§3.3-§3.4 del plan)

Al tap la card se ancla al tope (`scrollIntoView`) y su detalle se presenta con
`focusWrap` (SOLO en `.bb-card-det`, por eso puede usar `<details>` sin tocar
desktop): header sticky (← cierra + identidad) · veredicto + estado + chips
prominentes · secciones LARGAS en `<details>` colapsados (`focusSec`: Resumen/
archivos, Timeline, GitHub en vivo, Zoho Desk) · links · **action bar sticky
inferior** (`.bb-actionbar`): primaria sólida contextual (Trabajar en esto /
Chat plan / Actualizar ticket / Archivar si complete / Restaurar) + secundaria
Investigar + menú **⋯** (Responder ticket · Traer Desk · Archivar · Cancelar PR ·
Descartar). El action bar reusa los MISMOS `data-act` de la tabla; el ⋯ lo abre
`index.js` (popup en `document.body`, resuelve `b` por key y ejecuta directo).

### 2.4 Móvil — acción global "Enviar pendientes" (§3.5 del plan)

`.bb-listbar` sticky al fondo de la lista (zona del pulgar), visible SOLO si hay
pendientes Y ninguna card en foco (`expanded.size===0`). Si no hay nada que
enviar, no existe. En móvil `.bb` es flex column y `.bb-box` flex:1 para
anclarla. El confirm de envío entra sin overflow en 375px (una entrada por
línea, `.dlg-msg` pre-line + scroll del modal); conserva la lista nuevo-PR/
ACTUALIZA, `warningsFor` y el aviso del auto-update de Desk.

---

## 3. CSS y touch targets

- **Familia única `.bb-*`** — la legacy `.bfm-*` se migró completa (Fase 2, R5)
  y el CSS muerto (tabla vieja que la compartía) se eliminó, junto con la regla
  escapada `.bfm-table:not(.bb-table)`.
- **Columnas responsive por CLASE** (`.bb-col-pipe`/`.bb-col-stats`), no por
  `nth-child` (R7): agregar/reordenar columnas ya no rompe el media query.
- **Touch ≥44px**: se eliminó el override `.btn--sm{min-height:38px}` bajo
  `pointer:coarse` que pisaba el bump de 44px en toda la app táctil. Action bars
  del detalle/lista a 48-50px.
- **Íconos de estado en SVG** (`ui/icons.js`): las celdas PR/Desk usan
  `halfCircle` (◐) + `ticketDone`/`ticketCheck`/`ticketX`/`ticketDot` + `check`/
  `clock`, no emoji (render consistente entre plataformas; color por
  `.bb-icell--*` con `currentColor`).
- Colores solo por tokens `--cwc-*`/`color-mix`; cero hex nuevo.

**Gotchas de `ui/dialog.js` NO tocados (R8):** `.dlg-overlay
grid-template-columns:minmax(0,1fr)` y `.dlg-card max-height:88vh/88dvh`. Guard
global `[hidden]{display:none!important}` respetado (R9) — el listbar y las filas
de archivo se retiran con el atributo `hidden`, no con `display` de autor.

---

## 4. Acciones y endpoints (backend sin cambios)

### 4.1 Acciones (todas escriben al store; confirms de tokens/destructivos intactos)

| Acción | Dónde | Endpoint / efecto | ¿Confirm? | ¿Tokens? |
|---|---|---|---|---|
| Enviar pendientes | toolbar (desktop) · listbar (móvil) | `updateRepo()` + `POST /pr` por fix | ✅ (danger si warnings) | Indirecto (deskUpdateAuto del 1er PR) |
| Buscar bugfixes | toolbar · ⋯ | `POST /scan` | ❌ | No |
| GitHub | toolbar · ⋯ · auto 45 s | `POST /refresh-prs` | ❌ | No |
| 🎫 Desk (bulk) | toolbar · ⋯ | `POST /desk-refresh` + poll `desk:bulk` | ✅ | **Sí** |
| Trabajar en esto | detalle / action bar | `openChat` (cierra tablero) | ❌ | Chat |
| Responder ticket (chat) | detalle / ⋯ | `openChat` SIN `ticket:{}` | ❌ | Chat |
| Investigar a fondo / contexto | detalle / action bar | `POST /investigate`·`/ticket-investigate` + poll | ❌ | **Sí** |
| Traer estado de Desk | sección Desk / ⋯ | `POST /desk-refresh` + poll `desk:<n>` | ❌ (tooltip avisa) | **Sí** |
| Cancelar PR | detalle / ⋯ | `POST /cancel-pr` | ✅ danger | No |
| Archivar / Restaurar | detalle / action bar / ⋯ | `POST /archive` | ❌ | No |
| Descartar registro | detalle / ⋯ | `POST /delete` | ✅ danger | No |

Auto-refresh GitHub cada 45 s + `visibilitychange` (barato, solo gh); **ya NO se
pausa** con un detalle abierto (el re-render preserva expansión/paneles/scroll
desde el store). `freshTimer` repinta "hace X" cada 20 s.

### 4.2 Endpoints (`src/modules/bugfixes/index.js` → `/api/bugfixes`, sin cambios)

`GET /tickets` (fuente principal: `buildTickets` + `findSimilarSolutions`) ·
`GET /` (retrocompat) · `POST /scan` · `POST /pr` (worktree + push + `gh pr
create/edit`; dispara `deskUpdateAuto` headless) · `POST /refresh-prs` ·
`GET/POST /context` · `POST /cancel-pr` · `GET /pr-live/:n` · `POST /investigate`
+ `GET /investigation/:n` · `POST /ticket-investigate` + `GET
/ticket-investigation/:n` · `POST /desk-refresh` + `GET /desk-live/:n` · `POST
/archive` · `POST /delete`. Runners desacoplados: `cwc-desk-runner`,
`cwc-investigate-runner`, `cwc-ticket-investigate-runner` (regla 6, read-only).
`src/modules/bugs/index.js` → `/api/bugs` (`GET /`, `POST /refresh` →
`cwc-triage-runner`).

---

## 5. Modelo de datos (sin cambios; ver el motor)

La entidad TICKET consolidada la deriva `engine.js:buildTickets()` (agrupa el
log plano `~/.cwc-data/bugfixes.json` por nº de ticket; estado/resolución
derivados, 0 tokens). `store.js:ticketToRow` la aplana a la forma que esperan
`labels`/`render` (elige el "mejor" PR, une files, aplana Desk, conserva
`resolution`/`engineState`/`history`/`attempts`/`similar`/`feedback`).

- **`deriveState`** (`engine.js`): `triaged→working→pr-open→pr-merged→
  desk-answered→resolved`.
- **`deriveResolution`**: `complete` (Desk resuelto) · `partial` (PR merged sin
  confirmar) · `active`. Espejo cliente en `labels.js:resolutionOf`.
- **Eventos `history[]`**: `creado`, `trabajo_nuevo`, `pr_creado/_actualizado/
  _mergeado/_cancelado`, `ticket_actualizado/_cerrado/_respondido`, `archivado/
  restaurado`. Color por `labels.js:evDot` (R4: `ticket_actualizado` ya no cae
  al fallback — ok/fail según `e.ok`).
- Shapes persistidos por los runners (`desk-live`, `investigations`,
  `ticket-investigations`, `pr-live`): ver `engine.js` / `desk-shared.js` /
  `investigate-shared.js`.

Detalle exhaustivo del modelo, sidecar (`tickets-meta.json`: severidad/área/tags,
biblioteca de soluciones, feedback de Chris) y flujos en la entrada de
`bugfixes`/`bugs` de `CLAUDE.md`.

---

## 6. Deuda técnica del pre-refactor — estado

| # | Deuda original | Estado |
|---|---|---|
| 1 | Monolito 1.378 líneas (un closure) | ✅ partido en 8 módulos |
| 2 | Estado duplicado motor/frontend | ✅ `labels.js` mapea, no re-deriva; el store consume `resolution`/`engineState` |
| 3 | Doble familia `.bfm-*`/`.bb-*` | ✅ migrada a `.bb-*`, CSS muerto eliminado |
| 4 | Ocultación destructiva por `nth-child` | ✅ clases explícitas `.bb-col-*` |
| 5 | Touch targets < 44px | ✅ bump restaurado; action bars 48-50px |
| 6 | Estado UI en el DOM (auto-refresh pausado) | ✅ store; auto-refresh ya no se pausa |
| 7 | `OUTCOME_LABEL` con estados muertos | ✅ solo los que el motor emite |
| 8 | `EV_DOT` incompleto | ✅ `evDot` completa `ticket_actualizado` |
| 9 | Orden de filas re-decidido en cliente | ✅ en UN solo lugar (`renderTable`, R6, documentado) |
| 10 | Emoji como iconografía funcional | ✅ SVG en `ui/icons.js` |
| 11 | Título/carpeta engañosos (`tolkien/`) | ✅ movido a `bugs/board/` |

---

## 7. Restricciones respetadas (reglas del proyecto)

Sin framework (vanilla JS + template strings); modal compartido `ui/dialog.js`
(gotchas intactos, R8); guard `[hidden]` (R9); tokens obligatorios; íconos solo
de `ui/icons.js`; `openChat` de main.js para los chats del ciclo; corridas IA
solo bajo botón con confirm de tokens (regla 6, Desk nunca automático); runners
desacoplados + polling (los polls por clave sobreviven al re-render);
retrocompat de datos (consume `GET /tickets`, sin shapes nuevos en el backend);
sin gestos que disparen acciones (todo por tap explícito, regla 7).
