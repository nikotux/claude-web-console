# Contexto UI — módulo "Bugs & PRs — Tolkien" (tablero de tickets)

> **Propósito:** documento de descubrimiento para un rediseño **mobile-first** del tablero.
> Generado 2026-07-04 leyendo el código real (referencias `archivo:línea` verificadas a esa fecha).
> **Fuente principal:** `public/js/modules/tolkien/bug-board.js` (1378 líneas).
> El tablero NO tiene HTML estático: se genera 100% por JS dentro de un modal.

---

## 1. Inventario de componentes

El frontend es **vanilla JS + CSS plano** (sin framework, sin librería de tablas). No hay
"componentes" React: las unidades de render son funciones que devuelven strings HTML
(template literals) + un listener delegado sobre el `<tbody>`.

### 1.1 Archivos que participan en el render

| Archivo | Rol | Notas |
|---|---|---|
| `public/js/modules/tolkien/bug-board.js` | **EL tablero.** `openBugBoard({...})` (L84) construye modal, tabla, paneles de detalle, GitHub/Desk en vivo, investigación y todas las acciones | 1378 líneas, todo en un closure |
| `public/js/modules/bugs/bugs.js` | Sección "Bugs & Features" del sidebar. `openBoard()` (L199) es el **único** punto de entrada al tablero | `mount(el, ctx)` en L17 |
| `public/js/ui/dialog.js` | `openModal` (L19) = shell del modal; `confirmDialog` (L69) y `alertDialog` (L135) para cada confirm/alert | `promptDialog`/`textEditorDialog` NO se usan acá |
| `public/js/ui/pacman.js` | `pacman()` (L25) — loader para esperas largas (GitHub live, Desk, investigación, envío de PRs) | Único import directo de `ui/` en bug-board.js (L13) |
| `public/js/ui/icons.js` | `icon(name,{size})` (L59), llega vía ctx. Íconos usados: `gitBranch, sparkle, refresh, download, help, search, upload, clock, check, close, edit, trash, chevronDown` | |
| `public/js/main.js` | Construye `ctx` (L466) y monta módulos sobre `[data-module]` (L493-498) | |
| `public/index.html` | Punto de montaje `<section class="side-sec" data-module="bugs">` (L92) | El tablero en sí no tiene markup estático |
| `public/css/style.css` | Reglas `.bb-*` (tablero) y `.bfm-*` (tabla/filas, familia legacy reusada) | Detalle en §4 |
| `public/css/ui.css` | `.btn/.btn-ghost`, `.dlg-*`, `.cwc-pacman/.pac-sm`, guard `[hidden]` | |
| `public/css/tokens.css` | Todas las variables `--cwc-*` que consume el CSS del tablero | |

⚠️ **Hallazgos de inventario:**
- `bug-board.js` **NO usa** `popup.js`, `markdown.js`, `diff.js` ni `code.js` — no forman parte del render path.
- Pese al título "— Tolkien", el módulo `tolkien/tolkien.js` **ya no abre el tablero** (comentario L5-6: el acceso se movió a "Bugs & Features"). El archivo vive en la carpeta `tolkien/` por razones históricas.

### 1.2 Unidades de render dentro de `bug-board.js`

Helpers de módulo (fuera del closure):

| Función | Línea | Responsabilidad | Recibe | La llama |
|---|---|---|---|---|
| `esc` | 15 | HTML-escape | `s` | todos |
| `ticketOfPr` | 20 | Extrae nº de ticket del título/branch de un PR (regex `TKT #N` / `tkt-N-<sha>`) | `pr` | prCellFor, renderTable, ghDetailHtml |
| `fmtDate` / `fmtAgo` | 28 / 34 | Formateo de fechas ("02 jul 14:30" / "hace X min") | ms | timelines, frescura |
| `timelineOf` | 44 | `history[]` o timeline sintetizado (registros legacy) | `b` | chipsFor, warningsFor, detailHtml |
| `EV_LABEL` / `EV_DOT` | 52 / 65 | Mapas evento→etiqueta / evento→color de punto | — | detailHtml, historyText |
| `resolutionOf` | 73 | Fallback active/partial/complete | `b` | rowFor, renderDesk, detailHtml |
| `RES_CHIP` | 79 | Chips 🟡 parcial / 🟢 completo | — | rowFor, renderDesk, showHelp |

Dentro del closure `openBugBoard` (selección — las de render y flujo; el listado completo
de handlers está en §2):

| Función | Línea | Renderiza / hace | Padre |
|---|---|---|---|
| `openBugBoard` | 84 | Construye modal + tabla + wiring; devuelve `m` | `bugs.js openBoard` |
| `updateFreshness` | 119 | Pinta "GitHub: hace X · Desk: …" en `ghstate` | ghSync, desksync, freshTimer |
| `chipsFor` | 139 | Chips de verificación (severidad, dup, reabierto ×N, doble registro, estado Desk) | detailHtml |
| `warningsFor` | 169 | Advertencias para el confirm de "Enviar pendientes" | send handler |
| `pipelineHtml` | 182 | Barra de pipeline de 5 segmentos | rowFor, renderTable |
| `prEstado` / `estHtml` | 202 / 223 | Estado de la fila `{dot,icon,label}` + su celda | rowFor, renderDesk |
| `prCellFor` / `deskCellFor` | 232 / 254 | Columnas de ícono PR (✔/◐/—) y Desk (🎫✅/✔/✕/○/—) | rowFor, renderTable |
| `statsHtml` | 264 | "+add −del · N archivos" | rowFor |
| `attemptsHtml` | 278 | "N intentos de resolución" (solo si >1) | detailHtml |
| `similarHtml` / `feedbackHtml` | 292 / 307 | 💡 soluciones parecidas / 🗣 feedback de Chris | detailHtml |
| `detailHtml` | 317 | **EL panel de detalle**: invTopBox + chips + resumen + archivos + intentos + feedback + similares + timeline + live + desk + links + acciones | rowFor |
| `deskSectionHtml` | 356 | Stub Desk con botón "Traer estado" | detailHtml, ghDetailHtml |
| `ghDetailHtml` | 364 | Detalle de fila PR solo-GitHub | renderTable |
| `fillDesk` / `renderDesk` | 394 / 434 | Lanza runner Desk + poll / pinta resultado y **muta celdas in-place** | click handler |
| `semaforoHtml` | 487 | 🚦 chips determinísticos "¿de quién es la pelota?" | fillLive |
| `verdictHtml` / `verdictTicketHtml` | 503 / 582 | Veredicto IA de PR / de ticket sin PR | loadInvestigation / loadTicketInvestigation |
| `invTopBox` | 524 | Caja destacada de investigación (variante PR vs contexto) | detailHtml, renderTable |
| `loadInvestigation` / `runInvestigation` | 539 / 550 | Mostrar veredicto persistido / lanzar runner + poll | expand, `[data-investigate]` |
| `loadTicketInvestigation` / `runTicketInvestigation` | 598 / 611 | Ídem para ticket sin PR | expand, `[data-tktinvestigate]` |
| `fillLive` | 639 | Panel "GitHub en vivo" (review/checks/conflictos + semáforo + commits + feedback) | expand, `[data-livefresh]` |
| `ticketToRow` | 677 | Aplana el Ticket del motor → shape de fila (ver §3.8) | reload |
| `renderTable` | 709 | Construye el `<tbody>` entero: activas, grupos de PR, triage-only, solo-GitHub, Archivo | reload |
| `rowFor` / `subTktHtml` | 744 / 740 | Una fila (summary `<tr>` + detail `<tr hidden>`) / chip "↳ 🎫 TKT #N" anidado | renderTable |
| tbody click handler | 849 | Listener **delegado** para TODO el tablero (expand + data-act + data-*) | addEventListener |
| `fetchContexts` / `historyText` | 953 / 963 | Contextos work/pr para prompts / timeline → texto plano | doWorkOn, doDeskChat |
| `doWorkOn` / `doDeskChat` / `workOnTriage` | 966 / 1015 / 1047 | Abren chats (ver §2) | data-act |
| `doCancelPr` / `doArchive` / `doDiscard` | 1077 / 1101 / 1119 | POSTs de acción por fila | data-act |
| `reload` / `ghSync` | 1141 / 1158 | Fetch tickets+triage y re-render / sync GitHub | init, timers, acciones |
| `showHelp` | 1241 | Segundo modal "Cómo leer este tablero" | botón `?` |

### 1.3 Contrato de apertura (`ctx` → `openBugBoard`)

`ctx` de main.js (L466) provee: `icon, dialog, bus, whoami, openSession, openChat, openChatView, syncConversation, openExplorer, focusSession, findSessionByCwd, isMobile, hideSidebarOnMobile`.

`bugs.js` destructura `{icon, dialog, openChat}` (L18) + usa `ctx.whoami` (L227, gate admin del botón "Abrir tablero") y pasa a `openBugBoard`:

| Prop | Tipo | Uso en el tablero |
|---|---|---|
| `dialog` | `{openModal, confirmDialog, alertDialog, …}` | Shell del modal + todos los confirm/alert |
| `icon` | `fn(name,{size})` | Todos los íconos |
| `openChat` | `fn({cwd, model, mode, resume, prompt, title, ticket})` (main.js:352) | Abre pestañas de chat del Agent SDK (doWorkOn/doDeskChat/workOnTriage) |
| `projectRel` | `() => string` (bugs.js:202) | cwd relativo del repo Tolkien ('tolkien') |
| `updateRepo` | `async () => {ok, message}` (bugs.js:203-214) | `POST /api/tolkien/update` antes de enviar PRs |
| `onClose` | `() => reloadStats()` (bugs.js:216) | Refresca stats del sidebar al cerrar |

**Modal:** `dialog.openModal({title:'Bugs & PRs — Tolkien', width:'90vw', onClose})` (L85) + `m.card.classList.add('dlg-card--tickets')` (L86) + `m.card.style.maxWidth=''` (L89, limpia el inline para que gane el media query). El `m.close` se **overridea** (L1372-1373) para limpiar `ghTimer`, `freshTimer` y el listener de `visibilitychange` antes del close original. El modal de ayuda es un `openModal` independiente (L1242, width 460).

### 1.4 Árbol de componentes (jerarquía de render)

```
bugs.js mount(el, ctx)                          [sidebar "Bugs & Features", index.html:92]
└─ openBoard() → openBugBoard({dialog,icon,openChat,projectRel,updateRepo,onClose})
   └─ dialog.openModal(90vw) → m.card.dlg-card--tickets        [dialog.js:19]
      └─ wrap.bb                                               [bug-board.js:90-107]
         ├─ .bb-actions (toolbar)                              [L93]
         │   ├─ btn "Enviar pendientes"  (mr.send, PRIMARY)    [L94]
         │   ├─ btn "Buscar bugfixes"    (mr.scan)             [L95]
         │   ├─ btn "GitHub"             (mr.ghsync)           [L96]
         │   ├─ btn "🎫 Desk"            (mr.desksync)         [L97]
         │   ├─ btn "?"  → showHelp() → 2º modal               [L98, 1241]
         │   ├─ span frescura GitHub/Desk (mr.ghstate)         [L99]
         │   └─ span frescura triage      (mr.triage)          [L100]
         └─ .bb-box > table.bfm-table.bb-table                 [L103]
            ├─ thead: ⬤ · TKT · Título · Pipeline · Cambios · PR · Desk · Estado
            └─ tbody (mr.tbody) ← renderTable()                [L105, 709]
               ├─ FILAS ACTIVAS  rowFor(b,false)               [L744]
               │   ├─ <tr.bfm-row>  dot│tkt│título│pipeline│stats│prCell│deskCell│estado+chip
               │   │     (PR abierto ⇒ bfm-row--pr protagonista + subTktHtml "↳ 🎫 TKT #N")
               │   └─ <tr.bfm-detail hidden> colspan=8 → detailHtml(b)   [L766, 317]
               │        ├─ invTopBox → loadInvestigation / loadTicketInvestigation
               │        │              → verdictHtml / verdictTicketHtml
               │        ├─ .bb-chips  chipsFor(b)
               │        ├─ resumen + archivos (hp-bf-*)
               │        ├─ attemptsHtml · feedbackHtml · similarHtml
               │        ├─ timeline (.bb-tl · EV_LABEL/EV_DOT)
               │        ├─ .bb-live [data-live] → fillLive (GitHub en vivo + semáforo)
               │        ├─ deskSectionHtml → fillDesk → renderDesk
               │        └─ .bfm-links: ticket↗ PR↗ branch +
               │             work │ deskchat │ cancelpr │ archive/unarchive │ del
               ├─ FILAS SOLO-TRIAGE (soloTriage)               [L785-807]
               │   └─ detalle: invTopBox(contexto) + resumen + "Trabajar en Chat (plan)"
               ├─ FILAS SOLO-GITHUB (ghRows)                   [L811-835]
               │   └─ detalle: ghDetailHtml → invTopBox + .bb-live + desk + "Actualizar ticket"
               └─ 📦 ARCHIVO (colapsable) [data-arch-toggle]   [L837-844]
                   └─ rowFor(b,true) por archivado (.bb-arch-row, hidden)
```

### 1.5 Estado en closure (no hay store: variables + DOM)

| Variable | Línea | Propósito |
|---|---|---|
| `entries` | 112 | Filas actuales (tickets del motor aplanados por `ticketToRow`) |
| `ghRows` | 124 | PRs solo-GitHub (de `refresh-prs`) |
| `triage` | 125 | `{updatedAt, tickets[], running}` — caché del triage |
| `lastGhAt` / `lastDeskAt` | 113/114 | Timestamps de frescura GitHub / Desk |
| `deskBusy` | 115 | Contador >0 ⇒ hay consulta Desk poleando (pausa auto-refresh) |
| `GH_AUTO_MS` | 1367 | `45000` — intervalo del auto-refresh GitHub |
| `ghTimer` / `freshTimer` | 1368/1369 | `setInterval` 45 s (sync) / 20 s (solo repintar "hace X") |
| `canAutoRefresh` | 1366 | `!document.hidden && !hasOpenDetail() && deskBusy===0` |

El tracking de "fila expandida" es **por DOM**, no por variable: `hasOpenDetail()` (L118)
consulta `.bfm-detail:not([hidden])`; las cargas one-shot usan `box.dataset.loaded`.
Los polls (Desk, investigaciones) son loops de `setTimeout` 2500 ms con guardas
`box.isConnected` + deadline — resilientes a cambio de pestaña porque los runners son
server-side desacoplados.

---

## 2. Inventario de acciones y flujos

### 2.1 Acciones del header (`.bb-actions`)

| Acción | Estilo | Endpoint | ¿Destructiva? | ¿Confirm? | Muta | ¿Tokens? |
|---|---|---|---|---|---|---|
| **Enviar pendientes** (L94, handler L1178) | `.btn` **PRIMARY** (único sólido), nace `disabled` | `updateRepo()` → `POST /api/tolkien/update`, luego `POST /api/bugfixes/pr {id}` por fix (L1201) | Escribe en GitHub (branch+PR) | ✅ `confirmDialog` (L1186), `danger:true` si hay advertencias; lista nuevo-PR vs "ACTUALIZA PR #n", `warningsFor`, y avisa el auto-update de Desk | botón→pacman "Subiendo…"; `reload()` + `ghSync(true)` | Indirecto: el 1º PR dispara `deskUpdateAuto` (headless) |
| **Buscar bugfixes** (L95, L1221) | `.btn-ghost` | `POST /api/bugfixes/scan` | No | ❌ | `reload()` + alert con conteo | No (escaneo de transcripts en disco) |
| **GitHub** (L96, L1237 → `ghSync(false)` L1158) | `.btn-ghost` | `POST /api/bugfixes/refresh-prs` | No | ❌ | `ghRows`, `reload()`, `lastGhAt`, frescura | No (solo `gh` reads) |
| **🎫 Desk** (L97, L1315) | `.btn-ghost` | `POST /api/bugfixes/desk-refresh {tickets}` + poll `GET /desk-live/:n` | No | ✅ confirm "CONSUME TOKENS (una corrida de lectura por ticket)" (L1318) | pacman "Desk x/y…"; `deskBusy++` (pausa auto-refresh); `lastDeskAt`, `reload()` | **Sí** (runner Desk por ticket activo) |
| **?** ayuda (L98 → `showHelp` L1241) | `.btn-ghost.btn--icon` | ninguno (modal cliente) | No | ❌ | Abre 2º modal | No |
| **✕ cerrar** (override L1372) | × del modal | ninguno | No | ❌ | Limpia intervals+listener; `onClose` → `reloadStats()` del sidebar | No |

### 2.2 Acciones por fila / detalle (listener delegado L849-951)

**Tap sobre una fila** (L925-950): togglea `hidden` del `.bfm-detail` hermano. En la
primera apertura carga lazy el panel GitHub en vivo (`fillLive` → `GET /pr-live/:n`) y la
caja de investigación persistida. **No existen long-press, swipe ni menús contextuales**
— la interacción es solo tap/click.

| Acción | data-attr / línea | Endpoint o efecto | ¿Confirm / destructiva? | Muta | ¿Tokens? |
|---|---|---|---|---|---|
| **Trabajar en esto** (PRIMARY del detalle, L343) | `data-act="work"` → `doWorkOn` L966 | Sin endpoint de acción: lee investigación (`getInv`/`getTktInv`) + contextos (`GET /context×2`) y hace `m.close()` + **`openChat({cwd, mode:'default', prompt, title, ticket})`** (L1004) | ❌ | Cierra tablero, abre chat SDK | El chat consumirá tokens al usarse |
| **Responder ticket (chat)** (L345, solo con `ticketNumber`) | `data-act="deskchat"` → `doDeskChat` L1015 | `m.close()` + `openChat({mode:'default', prompt, title})` — **sin `ticket:{}` a propósito** (L1013, no re-registra trabajo) | ❌ | Cierra tablero, abre chat | Chat |
| **Trabajar en Chat (plan)** (L804, filas triage) | `data-act="triagework"` → `workOnTriage` L1047 | `m.close()` + `openChat({mode:'plan', …})` | ❌ | Cierra tablero, abre chat en modo plan | Chat |
| **Actualizar ticket (chat)** (L376, filas solo-GitHub con ticket) | `data-act="ghdeskchat"` | `m.close()` + `doDeskChat({...})` | ❌ | Ídem | Chat |
| **Cancelar PR** (L347, si `subido` y no merged) | `data-act="cancelpr"` → `doCancelPr` L1077 | `POST /api/bugfixes/cancel-pr {id}` | ✅ `confirmDialog danger:true` (cierra PR en GitHub, borra branch remoto, fix→pendiente) | `reload()` + `ghSync(true)` | No |
| **Archivar / Restaurar** (L349-350) | `data-act="archive"/"unarchive"` → `doArchive` L1101 | `POST /api/bugfixes/archive {id, archived}` por sessionId | ❌ (solo organiza) | `reload()` | No |
| **Descartar registro** (L351) | `data-act="del"` → `doDiscard` L1119 | `POST /api/bugfixes/delete {id}` por id | ✅ `confirmDialog danger:true` (borra SOLO el registro local) | `reload()` | No |
| **🔍 Investigar a fondo** (L546, PR abierto) | `data-investigate` → `runInvestigation` L550 | `POST /investigate {pr,ticket,fresh:true}` + poll `GET /investigation/:pr` | ❌ | Caja→pacman; re-render del veredicto | **Sí** (runner IA) |
| **🔍 Investigar contexto** (L607, ticket sin PR) | `data-tktinvestigate` → `runTicketInvestigation` L611 | `POST /ticket-investigate {ticket,problem,fresh:true}` + poll `GET /ticket-investigation/:n` | ❌ | Ídem | **Sí** (runner IA lee Tolkien read-only) |
| **🎫 Traer estado de Desk** (L358, por fila) | `data-deskload` → `fillDesk` L394 | `POST /desk-refresh {tickets:[t]}` + poll `GET /desk-live/:n` | ❌ (tooltip avisa tokens) | `deskBusy++`; `renderDesk` muta entries y **celdas visibles in-place** (L458-466), sin re-render total | **Sí** (si caché >60 s) |
| **↻ Desk fresh** (L427/439) | `data-deskfresh` | Ídem con `fresh:true` (saltea caché 60 s) | ❌ | Ídem | **Sí** |
| **↻ GitHub live** (L658) | `data-livefresh` → `fillLive(box,n,true)` | `GET /pr-live/:n?fresh=1` | ❌ | Re-render del panel live | No |
| **📦 Archivo toggle** (L840) | `data-arch-toggle` (L887-897) | Cliente: togglea `.open` + `hidden` de `.bb-arch-row` | ❌ | Muestra/oculta archivadas | No |

### 2.3 Acciones del sidebar (`bugs.js`)

| Acción | Endpoint | ¿Confirm? | ¿Tokens? |
|---|---|---|---|
| **↻ triage** (L29, handler L224 → `refresh` L158) | `POST /api/bugs/refresh` + poll `GET /api/bugs` cada 3 s (hasta 3 reintentos) | ✅ "CONSUME TOKENS reales, 1-3 min, read-only" (L160) | **Sí** (runner triage) |
| **Abrir tablero** (L34, admin-only vía `whoami` L227) | Cliente: `openBugBoard({...})` (L200) | ❌ | No |
| Montaje (IIFE L229-232) | `GET /api/tolkien/status` + `GET /api/bugs` + `GET /api/bugfixes` | — | No |

El sidebar es stats read-only (bugs, pendientes, PRs abiertos, completos/parciales, ⚠ atención)
calculadas en cliente (L73-123). **Sin poll propio**: refresca solo tras triage y al cerrar el tablero.

### 2.4 Endpoints backend

`src/modules/bugfixes/index.js` (router L955, montado en `/api/bugfixes`):

| Método + Path | Línea | Admin | Qué hace | ¿Runner desacoplado? |
|---|---|---|---|---|
| `GET /` | 615 | ❌ | `{bugfixes, inFlight}` con `resolution` derivada (retrocompat) | — |
| `GET /tickets` | 624 | ❌ | **Fuente principal del tablero**: `buildTickets` + `findSimilarSolutions` | — |
| `POST /scan` | 635 | ✅ | Registra chats de ticket viejos sin registro | — |
| `POST /pr` | 641 | ✅ | Worktree temporal + commit + push + `gh pr create/edit` | Responde tras el PR; dispara `deskUpdateAuto` **headless** async (L677) |
| `POST /refresh-prs` | 692 | ✅ | Estado real de PRs (`gh`) + PRs solo-GitHub → `lastGhRows` | — (síncrono, pool adaptativo) |
| `GET/POST /context` | 791/797 | GET ❌ / POST ✅ | Contextos work\|pr editables | — |
| `POST /cancel-pr` | 809 | ✅ | Cierra PR + borra branch remoto, registro→pendiente | — |
| `GET /pr-live/:n` | 841 | ✅ | PR en vivo vía gh (caché 60 s, `?fresh`); persiste feedback de Chris | — |
| `POST /investigate` | 856 | ✅ | Lanza investigación de PR | ✅ `cwc-investigate-runner.js` detached |
| `GET /investigation/:n` | 867 | ✅ | Lee disco (0 tokens) + `running` | — |
| `POST /ticket-investigate` | 878 | ✅ | Lanza investigación de contexto | ✅ `cwc-ticket-investigate-runner.js` detached |
| `GET /ticket-investigation/:n` | 889 | ✅ | Lee disco + `running` | — |
| `POST /desk-refresh` | 903 | ✅ | Lanza consulta Desk (dedup lock, TTL 60 s salvo `fresh`) | ✅ `cwc-desk-runner.js` detached |
| `GET /desk-live/:n` | 923 | ✅ | Lee disco + `running/progress` | — |
| `POST /archive` | 932 | ✅ | Flag `archived` + evento | — |
| `POST /delete` | 946 | ✅ | Borra solo el registro local | — |

`src/modules/bugs/index.js` (montado en `/api/bugs`):

| Método + Path | Línea | Admin | Qué hace | ¿Runner? |
|---|---|---|---|---|
| `GET /` | 83 | ❌ | Caché de triage (`updatedAt, tickets, error`) + `running` | — |
| `POST /refresh` | 93 | ✅ | Lanza triage (dedup lock sincrónico, `spawnTriage` L45) | ✅ `cwc-triage-runner.js` detached |

### 2.5 Auto-comportamientos (sin interacción del usuario)

| Comportamiento | Definición | Guarda |
|---|---|---|
| Auto-refresh GitHub cada **45 s** | `GH_AUTO_MS`, `ghTimer` (L1367-1368) → `ghSync(true)` | `canAutoRefresh()` (L1366): pestaña visible + sin panel de detalle abierto + `deskBusy===0` — un re-render total destruiría el panel abierto |
| Re-sync al volver a la pestaña | `visibilitychange` → `onVis` (L1370-1371) | misma guarda |
| Repintado "hace X" cada 20 s | `freshTimer` (L1369) — solo texto, sin fetch | — |
| Al abrir | `reload().then(() => ghSync(true))` (L1376) | — |
| Al cerrar | override de `m.close` limpia timers + listener (L1372-1373) | — |

### 2.6 Acción primaria

| Criterio | Acción | Evidencia |
|---|---|---|
| **Según el diseño actual** | "Enviar pendientes" | Único `.btn` sólido del header (L94); el resto es `.btn-ghost`. Pero nace `disabled` y solo se habilita con pendientes |
| **Según frecuencia esperada** | **Tap sobre la fila → detalle → "Trabajar en esto"** | El ciclo diario es leer estado (auto-refresh 45 s hace el trabajo pasivo), expandir y actuar. "Trabajar en esto" / "Trabajar en Chat (plan)" son los `.btn` primarios del detalle (L343, 804); "Archivar" se promociona a primario solo cuando `resolution==='complete'` (L350) |

**Tensión de diseño:** la acción visualmente protagonista (Enviar) es episódica; la acción
más frecuente (expandir fila) es la de **menor affordance y menor touch target** (~27 px, ver §4.3).

---

## 3. Modelo de datos y estados

### 3.1 Entidad TICKET consolidada (`buildTickets`, `engine.js:134-221`)

Agrupa el log plano (`~/.cwc-data/bugfixes.json`) por nº de ticket (clave `#<n>`; sin
ticket ⇒ `sid:<sessionId>`, cada fix es su propio grupo — L139). Derivación
determinística, 0 tokens.

| Campo | Tipo | Fuente |
|---|---|---|
| `number` / `url` | string\|null | store local (`ticketNumber`/`ticketUrl`) |
| `source` | `'desk'`\|`'manual'` | derivado de si hay ticketNumber |
| `title` | string | store; prefiere el attempt con código+resumen |
| `severity` / `area` / `tags[]` | string\|null / string[] | **sidecar** `tickets-meta.json` |
| `attempts[]` | Attempt[] | log plano vía `attemptOf` (L68-87), orden por `at` |
| `external.github[]` | PR[] | PRs de attempts (dedup por número) + huérfanos de `ghRows` (`orphan:true`) |
| `external.desk` | object | acumulado del log: `answered, updating, error, replied, resolved, closed, checkedAt, statusText` (L171-179) |
| `external.feedback[]` | Feedback[] | **sidecar** `feedback[n].items` |
| `history[]` | Event[] | concatenado + ordenado por `t` |
| `archived` | bool | true solo si TODOS los attempts archivados |
| `createdAt` / `updatedAt` | ms | min/max de attempts |
| `state` | enum | **derivado** `deriveState` (§3.3) |
| `resolution` | enum | **derivado** `deriveResolution` (§3.4) |
| `similar[]` | Solution[] | agregado en el endpoint (`index.js:627`), no en el motor |
| `schemaVersion` | `2` | `ENGINE_SCHEMA` |

**Attempt** (`attemptOf`): `{sessionId, chatId, cwd, at, files[], stats, summary, branch, pr:{number,url,state,mergedBy,mergedAt}|null, outcome}`.
`outcome` = `'merged'` | `'pr-sent'` | `'coded'` | `'empty'` (L70-74).
⚠️ El frontend etiqueta también `'plan'`/`'abandoned'` (`OUTCOME_LABEL`, bug-board.js:274-277) que **el motor nunca produce** — código muerto/aspiracional.

**Registro plano** (`store.js:177-196`, clave natural `sessionId`):
`{sessionId, chatId, cwd, ticketNumber, ticketUrl, title, summary, files[], status('pendiente'|'subido'), branch, prUrl, prNumber, prState, mergedBy, mergedAt, sentAt, deskStatus, deskStatusText, deskCheckedAt, deskClosed, deskReplied, deskResolved, createdAt, updatedAt, history[], archived}`.
Máquina: `pendiente → subido`; un `subido` con PR abierto **vuelve a `pendiente`** ante trabajo nuevo conservando `prNumber/branch` (el push ACTUALIZA el mismo PR, `store.js:168-195`).

**Sidecar** (`tickets-meta.json`): `{schema:2, tickets:{n:{severity,area,tags,meta}}, solutions:[...], feedback:{n:{prNumber,items[],fetchedAt}}}`.
- `Solution` (`deriveSolution` L251-275, solo merged/complete): `{id:'sol-<n>', ticketNumber, title, rootCause, fix, lesson, files[], area, tags[], prNumber, feedback[], at}` — parseada de los marcadores `Problema:/Qué hice:/Mejor solución:` del cierre del chat; upsert idempotente 1 por ticket.
- `findSimilarSolutions` (L302-318): score +2 archivo compartido, +1 tag, +1 misma área; excluye el propio ticket; top 3.
- `Feedback` (`saveFeedback` L110-126): items `{author, at, kind, body}` desde los reviews/comentarios de `pr-live` (gh), escritura solo si cambió.

### 3.2 Orígenes de datos por fila (resumen)

| Origen | Qué aporta | Vía |
|---|---|---|
| 📋 Store local `bugfixes.json` | attempts, files, status, PR asociado, history | `GET /api/bugfixes/tickets` |
| 🐙 GitHub (`gh` CLI) | estado real de PRs, PRs huérfanos, reviews/checks/commits | `POST /refresh-prs`, `GET /pr-live/:n` (caché 60 s) |
| 🎫 Zoho Desk (runner headless) | status, closed/replied/resolved, comentarios | `desk-live/<n>.json` (bajo botón, tokens) |
| 🤖 Triage (runner headless) | tickets [Tolkien Bug]: `{ticketNumber, whatBroke, route, severity, recommendation, duplicate, webUrl, reporter, context}` (`bugs/shared.js:87-98`) | `GET /api/bugs` (caché `tickets.json`) |
| 🧠 Investigaciones (runners) | veredictos IA de PR / de ticket sin PR | `investigations/<pr>.json`, `ticket-investigations/<n>.json` |
| 📦 Sidecar `tickets-meta.json` | severidad/área/tags curadas, biblioteca de soluciones, feedback persistido | dentro de `/tickets` |

Shapes persistidos por los runners (para el detalle):
- `desk-live/<n>.json`: `{found, status, subject, closed, replied, resolved(=closed||replied), comments:[{author,at,visibility,excerpt}], fetchedAt}`.
- `investigations/<pr>.json`: `{semaforo:{ball('chris'|'yours'|'clear'), chrisRespondio, reviewDecision, checks{ok,failing,total}, conflictos, ultimaActividad, comentariosChris[]}, lectura:{accion, bloqueante, severidad('blocker'|'cambio'|'nit'|'nota'|'aprobacion'), queQuiereChris, pasos[], archivos[], recomendacion, confianza, titular}, fetchedAt, ticketNumber}`.
- `ticket-investigations/<n>.json`: `{lectura:{porQueNoResuelto, causaRaiz, archivos[], complejidad, pasos[], riesgo, confianza, titular, necesitaMasInfo}, fetchedAt, ticket}`.
- `pr-live` (memoria, 60 s, NO persiste): `{state, title, url, mergeable, reviewDecision, checks[], commits[], feedback[], additions, deletions, changedFiles, fetchedAt}`.

### 3.3 `deriveState` — pipeline del motor (`engine.js:35-52`)

`PIPELINE = ['triaged','working','pr-open','pr-merged','desk-answered','resolved']`

```js
if (resolved && anyMerged) return 'resolved'        // desk resuelto/cerrado + PR merged
if (answered && anyMerged) return 'desk-answered'   // desk respondido + PR merged
if (anyMerged)             return 'pr-merged'
if (anyOpen)               return 'pr-open'
if (hasCode || outcome coded/pr-sent) return 'working'
return 'triaged'
```

⚠️ `resolved`/`desk-answered` **exigen** `anyMerged`: un ticket resuelto en Desk sin PR
mergeado se queda en un estado inferior. El frontend expone esto como `engineState`
(bug-board.js:700) pero **no lo usa para las etiquetas** — recalcula desde los campos
aplanados (§3.5). Duplicación de lógica motor/front a tener en cuenta en el rediseño.

### 3.4 `deriveResolution` (`engine.js:56-63`) + espejo frontend

| Valor | Condición | Chip en la fila (`RES_CHIP`, bug-board.js:79) |
|---|---|---|
| `complete` | `desk.resolved` (= closed ‖ requester replied, `desk-shared.js:85`) | 🟢 "completo · se puede cerrar" |
| `partial` | algún PR merged sin confirmación de Desk | 🟡 "parcial · falta confirmar ticket" |
| `active` | ninguna | (sin chip) |

Espejo cliente `resolutionOf` (bug-board.js:73-78) con la misma lógica como fallback.

### 3.5 Etiquetas de estado de la fila — **todas definidas en el frontend**

`prEstado(b)` (bug-board.js:202-219), celda "Estado" (última columna), render `estHtml` → `bfm-est--<dot>`:

| Condición | dot | icon | Etiqueta |
|---|---|---|---|
| `prState==='merged'` | ok | check | `mergeado por <mergedBy\|?>` |
| `prState==='closed'` | fail | close | `cerrado sin merge` |
| `prNumber` + `status≠'subido'` + files>0 | warn | upload | `PR #<n> · tenés cambios sin subir` |
| `prNumber` (resto) | info | clock | `PR #<n> en revisión · esperando a Chris` |
| sin PR + files>0 | warn | upload | `listo · falta enviar el PR` |
| sin PR + sin files | idle | — | `en plan (sin archivos)` |

Otras etiquetas: filas triage-only → `sin trabajo aún` (L795); filas solo-GitHub →
`mergeado[ por X]` / `cerrado` / `abierto` (L832); sub-tickets bajo fila-PR → `resuelto` /
`respondido` (L740). Dominio de `prState`: `'open'|'closed'|'merged'|null` (seteado desde
gh en `index.js:735,772`). El texto de `prEstado` se reusa verbatim en el prompt de
"Trabajar en esto" (L987).

### 3.6 Eventos de `history[]` (todos, confirmados contra código)

Emisores en backend; etiquetas/colores en `EV_LABEL`/`EV_DOT` (bug-board.js:52-69).
Tope 50 eventos (`HISTORY_MAX_EVENTS`, store.js:92). Registros legacy sin `history[]`
reciben timeline sintetizado (`timelineOf`, bug-board.js:44-51).

| Tipo | Emitido en | Datos |
|---|---|---|
| `creado` | store.js:199 | sessionId |
| `trabajo_nuevo` | store.js:201 | pr, sessionId (reapertura) |
| `pr_creado` / `pr_actualizado` | index.js:665 | pr, branch/commit, files |
| `pr_mergeado` | index.js:738 | pr, by (detectado en refresh-prs) |
| `pr_cancelado` | index.js:820 | pr |
| `ticket_actualizado` | index.js:428 | mode('auto'), ok, detail |
| `ticket_cerrado` / `ticket_respondido` | desk-shared.js:126 | status (elige por `data.closed`) |
| `archivado` / `restaurado` | index.js:940 | — |

⚠️ `EV_DOT` no tiene entrada para `ticket_actualizado` → cae al fallback `'warn'` (bug-board.js:323).

### 3.7 Indicadores de frescura

| Indicador | Fuente del timestamp | Cadencia de actualización | "Sin datos" |
|---|---|---|---|
| `GitHub: hace X` (`.bb-fresh`, `updateFreshness` L119-123) | `lastGhAt` = `Date.now()` tras cada `ghSync` exitoso (L1167) | fetch cada 45 s (auto) + visibilitychange; el TEXTO se repinta cada 20 s (`freshTimer`) | `GitHub: —` |
| `Desk: hace Y / sin consultar` | `lastDeskAt` solo tras el bulk "🎫 Desk" (L1354) | **Nunca automático** (tokens); decidido 100% en cliente: null ⇒ "sin consultar" | `Desk: sin consultar` |
| `triage: hace X` (`mr.triage`, L713-715) | `triage.updatedAt` de `GET /api/bugs` (escrito por el runner, `cwc-triage-runner.js:117`) | Al abrir/reload del tablero; chip `viejo` si >24 h | `triage: sin datos` |
| Sidebar bugs.js (L100-102) | mismo `cache.updatedAt` | mount + tras triage (poll 3 s mientras corre) + al cerrar tablero | `Sin triage · corré el ↻` |

Umbrales `fmtAgo` (L34-41): <60 s "recién" · <1 h "hace N min" · <24 h "hace N h" · resto "hace N d".
Cachés backend de 60 s: `pr-live` (`LIVE_TTL_MS`), Desk (`DESK_TTL_MS`), investigaciones (`INV_TTL_MS`/`TKTINV_TTL_MS`).

### 3.8 Columnas de ícono PR / Desk y aplanado de fila

**PR** (`prCellFor` L232-243, cruza entries+ghRows por ticket): ✔ ok "implementado en PR
mergeado" · ◐ warn "en PR abierto" · — "sin PR".

**Desk** (`deskCellFor` L254-262, orden de prioridad): sin ticket → `—` · `updating` → ⏳ ·
`deskResolved` → 🎫✅ · `deskAnswered()` → 🎫✔ · `error` → 🎫✕ · `deskCheckedAt` → 🎫○
"consultado sin respuesta" · resto → `—` "sin consultar".
`deskAnswered(b)` (L249-253): `deskStatus==='ok' ‖ deskReplied ‖ deskResolved` o eventos
`ticket_actualizado`(ok)/`ticket_respondido` en history.

**`ticketToRow(t)`** (L677-706) aplana el Ticket del motor al shape que esperan los
helpers: elige `best` PR (merged > open > primero), `status = merged?'subido':'pendiente'`,
aplana `external.desk` a `deskStatus/deskReplied/…`, une files de todos los attempts,
conserva `resolution, engineState, history, attempts, allSessionIds, similar, feedback`.
El frontend **re-ordena** (rank: pendiente+files→0 · pendiente sin files→1 · resto→2 ·
complete→3; luego recencia, L770-773) y agrupa PRs abiertos como fila-protagonista con
sub-tickets anidados (L727-753) — o sea, **el orden del motor (`engine.js:218`) se pisa en el cliente**.

---

## 4. Estado actual del layout

### 4.1 Sistema de layout por zona

**Hallazgo central: el tablero es una `<table>` HTML real** (`table.bfm-table.bb-table`,
bug-board.js:103) con layout nativo de tabla — no hay grid/flex para las columnas.
`.bb-table` **no tiene regla base propia**: hereda todo de `.bfm-table` (style.css:961-1002).
El wrapper `div.bb` no tiene CSS (passthrough).

| Zona | Sistema | Regla clave |
|---|---|---|
| Overlay/modal | grid (`place-items:center`, `grid-template-columns:minmax(0,1fr)` — **no quitar**, gotcha documentado) | `.dlg-overlay` ui.css:55 |
| Card del tablero | flex column; `width:90vw; max-width:1000px; height:82vh` | `.dlg-card--tickets` style.css:943 |
| Toolbar | `flex; gap:.4rem; flex-wrap:wrap` | `.bb-actions` style.css:1012 |
| Región de scroll | `overflow:auto` (ambos ejes); `max-height:70vh/74dvh` | `.bb-box` style.css:1015 |
| Tabla | table layout nativo; `width:100%; font-size:var(--cwc-fs-sm)`; `th` sticky (`position:sticky; top:0; z-index:1`) | `.bfm-table` style.css:961-967 |
| Fila | `<tr>` clickeable entero (`cursor:pointer`, hover `--cwc-bg-hover`); fila-PR con `box-shadow:inset 3px 0 0 var(--cwc-info)` | style.css:968-969, 995 |
| Detalle expandible | `<tr hidden>` + `colspan=8`; `background:var(--cwc-bg-panel)` — colapsa gracias al guard global `[hidden]{display:none!important}` (ui.css:10) | `.bfm-detail td` style.css:993 |
| Botonera del detalle | `flex; gap:.8rem; flex-wrap:wrap` | `.bfm-links` style.css:1000 |
| Sección Archivo | header `<tr>` clickeable, chevron rota 180° con `.open` | `.bb-arch-header` style.css:1091-1098 |

Único JS que toca estilos: `m.card.style.maxWidth = ''` (bug-board.js:89 — limpia, no setea).
**No hay estilos inline en los templates.**

### 4.2 Breakpoints existentes

| Media query | Ubicación | Efecto sobre el tablero |
|---|---|---|
| `max-width:768px` | style.css:945 | Modal **full-screen**: `.dlg-card--tickets{width:100vw; height:100dvh; border-radius:0}`, overlay sin padding |
| `max-width:640px` | style.css:1123 | **Oculta las columnas Pipeline (4) y Cambios (5)** por `nth-child` `display:none`; `.bb-triage` baja a línea propia. Quedan 6 de 8 columnas |
| `max-width:640px` | style.css:1003-1004 | `.bfm-title{max-width:110px}` (desde 240px) — aplica también al tablero |
| `pointer:coarse` | ui.css:48 | `.btn,.btn-ghost{min-height:44px}` **pero** `.btn--sm{min-height:38px}` — y el tablero usa `.btn--sm` en casi todo |

⚠️ La ocultación por `nth-child` hace la información **inaccesible** en móvil (Pipeline y
Cambios no se reubican, desaparecen).

### 4.3 Touch targets medidos (umbral 44×44 px)

Escala tipográfica (tokens.css:82-86, root 16px): `fs-xs` 11.2 · `fs-sm` 12.5 · `fs-md` 13.6 · `fs-lg` 16 px.

| Elemento | Clases | Alto calculado (normal / coarse) | Veredicto |
|---|---|---|---|
| **Fila (tap de expandir)** — la interacción MÁS frecuente | `tr.bfm-row`, td padding `.38rem` | **~27 px** (sin min-height) | ❌ peor ofensor |
| Header del Archivo | `.bb-arch-header td`, padding `.4rem` | **~28 px** | ❌ |
| Botones header (Enviar/Buscar/GitHub/Desk) | `.btn/.btn-ghost` `.btn--sm` | 30 / **38 px** | ❌ |
| Botón `?` ayuda | `.btn--sm.btn--icon` | 30/38 px, min-width 30 px | ❌ (ambos ejes) |
| Botones del detalle (Trabajar/Responder/Archivar/Cancelar/Descartar) | `.btn--sm` | 30 / **38 px** | ❌ |
| Íconos ↻ (live/desk) | `.btn--sm.btn--icon`, icon 12 | ~30×30 / 38 px | ❌ |
| Chips `.bb-chip` | fs-xs, padding .08/.4rem | ~15 px | (solo display, no tappables) |

📏 **Ningún elemento interactivo del tablero llega a 44×44.** El bump de `pointer:coarse`
(44 px) se ve pisado por el override `.btn--sm{min-height:38px}` que usa todo el tablero.

### 4.4 Tipografía

Todo por tokens, **cero font-size hardcodeado**: cuerpo de tabla `fs-sm` (12.5 px);
`th`, fechas, estado, stats, chips, timeline, `.bb-fresh` en `fs-xs` (11.2 px); prosa del
detalle (`.bb-verdict-*`, `.bb-live-head`) en `fs-sm`; celdas de ícono `.bb-icell` y
ayuda en `fs-md`; botones `fs-md` (`.btn--sm` → `fs-sm`); título del modal `fs-lg`.
Para móvil: la base de 11-12.5 px queda **por debajo** de los 14-16 px recomendados para lectura táctil.

### 4.5 Clases y tokens compartidos con el resto de la app

| Compartido | Detalle |
|---|---|
| Botones | `.btn, .btn-ghost, .btn--sm, .btn--icon, .btn--danger, .btn--block` (ui.css:19-50) |
| Modal | `.dlg-overlay, .dlg-card, .dlg-head, .dlg-title, .dlg-body` + variante propia `.dlg-card--tickets` (style.css:943) |
| Loaders | `.cwc-spinner`, `.cwc-pacman`/**`.pac-sm`** (30×12, `--pac-travel:-18px`) vía `pacman()` |
| Estados | `.hp-dot--{ok,warn,fail,info,idle}` (8×8), `.hp-empty`, `.hp-bf-*` (detalle de fix), `.tk-sev-*` (badges de severidad) |
| Guard | `[hidden]{display:none!important}` (ui.css:10) — de él depende el colapso de `.bfm-detail` |
| Tokens | Colores todos `var(--cwc-*)` o `color-mix(...)` sobre tokens (style.css:1086-1087). **Cero hex fuera de tokens.css — sin violaciones** |
| Propios del tablero | Familia `.bb-*` (~30 clases: actions, box, pipe/seg, chip, tl, live, inv, verdict, desk, arch, help, icell, fresh, sem, fb, commit) + familia legacy `.bfm-*` (table, row, title, tkt, state, stats, detail, links, row--pr, subtkt) |

Px hardcodeados de layout (no color): `.bb-seg` 13×6 (26×8 en la ayuda), `.bfm-title`
max-width 240→110px, insets/bordes 3px, `.dlg-card--tickets` max-width 1000px.

**Overflow:** `.bb-box` es la única región de scroll (ambos ejes). Muchas celdas llevan
`white-space:nowrap` (`.bfm-tkt, .bfm-date, .bfm-state, .bfm-stats, .bb-col-pr/-desk`)
⇒ en móvil el contenido **empuja scroll horizontal** en vez de refluir. `.bfm-title` corta
con ellipsis. `.hp-bf-summary` tiene su propio `max-height:180px; overflow-y:auto`.

---

## 5. Restricciones para el rediseño

### 5.1 Dependencias y reglas que limitan

| # | Restricción | Implicancia |
|---|---|---|
| 1 | **Sin framework ni librería de tablas** — todo template strings + listener delegado | El rediseño no puede asumir virtual-dom; re-render total destruye estado del DOM (paneles abiertos) — de ahí `canAutoRefresh` y la mutación in-place de `renderDesk` |
| 2 | **Modal compartido** `ui/dialog.js` | El tablero vive dentro del stack de modales (Esc/backdrop/×); el gotcha de `.dlg-overlay grid-template-columns` y `.dlg-card max-height 88vh/88dvh` (líneas duplicadas a propósito) no se pueden tocar sin re-probar en 375px |
| 3 | **Guard `[hidden]`** (ui.css) | Cualquier `display` de autor sobre elementos ocultables debe respetarlo |
| 4 | **Tokens obligatorios** (`tokens.css`) | Cero hex nuevo; sombras/velos con `--cwc-shadow-*`/`--cwc-scrim`; el tablero hoy cumple |
| 5 | **Íconos solo de `ui/icons.js`** | Emoji actuales (🎫 ✅ 🔍 📦 💡 🗣 🚦) conviven con SVG — decisión a revisar, pero íconos nuevos van a icons.js |
| 6 | **`openChat` de main.js** | "Trabajar en esto"/"Responder ticket" cierran el tablero y abren pestañas de chat SDK; el contrato `{cwd,mode,prompt,title,ticket}` es del shell, no del módulo |
| 7 | **Reglas duras del proyecto** (CLAUDE.md) | Corridas IA solo bajo botón con confirm de tokens (Desk, triage, investigaciones); Desk NUNCA automático; el auto-refresh barato (GitHub) puede ser pasivo. El rediseño no puede convertir acciones con tokens en gestos accidentales (swipe que dispare un runner = prohibido en la práctica) |
| 8 | **Runners desacoplados + polling** | Todo lo lento es POST-inmediato + poll a disco; los polls deben sobrevivir a re-renders (hoy: guardas `box.isConnected`) — un rediseño con re-render agresivo rompe los polls anclados a nodos |
| 9 | **UI colapsable + árbol** (pedido del usuario 2026-07-04) | Bloques largos nacen colapsados, sub-elementos en árbol (la fila-PR con TKT anidados ya sigue el patrón) |
| 10 | **Retrocompat de datos** | `bugfixes.json`/`tickets.json` no se renombran; el motor deriva — el rediseño consume `GET /tickets`, no debería pedir shapes nuevos al backend salvo necesidad real |

### 5.2 Deuda técnica visible en el módulo

| ⚠️ | Deuda | Evidencia |
|---|---|---|
| 1 | **Monolito de 1378 líneas**: fetching + polling + render + handlers + prompts de chat, todo en un closure | `bug-board.js` entero; los prompts de "Trabajar en esto" (~40 líneas de texto) viven inline en el JS de UI (L966-1013) |
| 2 | **Lógica de estado duplicada motor/frontend**: `deriveState` (engine) no se usa para etiquetas; `prEstado`, `resolutionOf`, `deskAnswered` recalculan en cliente | engine.js:35-63 vs bug-board.js:73-78, 202-219, 249-262 |
| 3 | **Doble familia de clases** `.bfm-*` (legacy, compartida con una tabla anterior) + `.bb-*` (nueva) sobre el mismo DOM | style.css:961-1002 vs 1012-1130; regla escapada `.bfm-table:not(.bb-table)` (L1007) delata el acople |
| 4 | **Ocultación destructiva en móvil**: columnas Pipeline/Cambios desaparecen por `nth-child` — dependencia frágil del ORDEN de columnas (agregar una columna rompe el media query silenciosamente) | style.css:1123 |
| 5 | **Touch targets**: nada llega a 44px; `.btn--sm` pisa el bump de `pointer:coarse` | §4.3 |
| 6 | **Estado UI en el DOM**: expansión por `[hidden]`, cargas por `dataset.loaded`, frescura en spans — un re-render pierde todo (por eso el auto-refresh se PAUSA con detalle abierto en vez de preservarlo) | bug-board.js:118, 933-948, 1366 |
| 7 | **`OUTCOME_LABEL` con estados muertos** (`plan`, `abandoned`) que `attemptOf` nunca emite | bug-board.js:274-277 vs engine.js:70-74 |
| 8 | **`EV_DOT` incompleto** (`ticket_actualizado` cae a fallback warn) | bug-board.js:65-69, 323 |
| 9 | **Orden de filas re-decidido en cliente** pisando el sort del motor (dos verdades) | engine.js:218-219 vs bug-board.js:770-773 |
| 10 | **Emoji como iconografía funcional** (🎫✅/🎫✔/⏳/—) mezclados con SVG de icons.js — rendering inconsistente entre plataformas móviles | prCellFor/deskCellFor, chips |
| 11 | **Título/carpeta engañosos**: el tablero vive en `modules/tolkien/` pero se abre solo desde `modules/bugs/` | bug-board.js:1-13, tolkien.js:5-6 |

---

## Preguntas abiertas para el rediseño

Lo que el código **no puede responder** solo:

1. **¿Cuál es el caso de uso móvil dominante?** ¿Chequeo pasivo ("¿mergeó Chris?", "¿respondió el cliente?") o trabajo activo (enviar PRs, lanzar investigaciones)? Define si la vista móvil prioriza lectura (cards de estado) o acción.
2. **¿Tabla o cards en móvil?** La `<table>` con 6-8 columnas + nowrap pide scroll horizontal. ¿Se acepta convertir la fila a card apilada (patrón lista→detalle) perdiendo la comparación columnar? ¿Pipeline y Cambios (hoy ocultos en móvil) deben volver a ser visibles ahí, o se confirman como "solo desktop"?
3. **¿El detalle expandible sigue inline (acordeón en la tabla) o pasa a pantalla/sheet propia en móvil?** Un sheet resolvería el conflicto auto-refresh↔panel-abierto (hoy se pausa el refresh para no destruir el panel), pero cambia la plomería de polls anclados a nodos.
4. **Jerarquía de acciones del detalle**: hay hasta 8 acciones por ticket (work, deskchat, investigar, desk-live, cancelpr, archive, del, links). ¿Cuáles merecen botón visible en móvil y cuáles van a un menú "⋯"? ¿Hay acciones que directamente no tienen sentido en el teléfono (p.ej. Enviar pendientes)?
5. **¿"Enviar pendientes" debe seguir siendo el primario visual** si es episódico y nace disabled? ¿O el primario móvil es otro (abrir el último ticket activo, refrescar Desk)?
6. **Frecuencias reales de uso**: no hay analítica. ¿Cuántos tickets activos hay típicamente (5, 20, 100)? Cambia si hace falta búsqueda/filtros/paginación o si la lista plana alcanza.
7. **¿Se quiere gestualidad móvil** (swipe para archivar, pull-to-refresh)? Hoy no existe, y las reglas del proyecto exigen que nada con tokens sea accidental — ¿swipe solo para acciones gratis?
8. **Emoji vs SVG**: ¿estandarizar la iconografía de estado (🎫✅ etc.) en icons.js para consistencia entre plataformas, o el emoji es una decisión estética deliberada?
9. **¿El rediseño habilita refactor estructural** (partir bug-board.js, unificar estado motor/front, migrar `.bfm-*`→`.bb-*`) o debe ser solo capa de presentación sobre el código actual?
10. **Tipografía móvil**: ¿se acepta subir la base de 12.5px a ≥14px (implica filas más altas y menos densidad) — y cuánto vale la densidad actual para el usuario?
11. **¿Tablet/desktop conservan la tabla actual** (rediseño solo móvil con breakpoint) o el mobile-first redefine también el desktop?
12. **Auto-refresh de Desk**: sigue prohibido por costo de tokens — ¿el rediseño quiere algún recordatorio pasivo ("Desk sin consultar hace 2 días") más prominente que el texto actual de frescura?
