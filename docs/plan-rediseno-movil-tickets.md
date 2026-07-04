# Plan de rediseño mobile-first + refactor estructural — tablero "Bugs & PRs"

> **Documento ancla** para las sesiones de Claude Code del rediseño.
> Complementa (no reemplaza) `docs/contexto-tickets-ui.md`, que es la radiografía del estado actual.
> Generado 2026-07-04. Decisiones validadas con Niko ese mismo día.

---

## 0. Decisiones de alcance (validadas)

| Pregunta | Decisión | Consecuencia |
|---|---|---|
| Caso de uso móvil dominante | **Trabajo activo** (enviar PRs, lanzar investigaciones, no solo lectura) | Acciones prominentes; action bar inferior sticky; confirms de tokens rediseñados para móvil pero nunca eliminados |
| Volumen típico | **>30 tickets activos** | Búsqueda + filtros segmentados con conteo son obligatorios |
| Alcance | **Refactor estructural completo** | Se autoriza: partir `bug-board.js`, sacar estado del DOM, re-anclar polls a claves, unificar lógica de estado motor/frontend, migrar `.bfm-*`→`.bb-*`, eliminar código muerto |
| Desktop | La tabla actual se conserva en ≥641px | El rediseño de layout es móvil; el refactor estructural beneficia a ambos |
| Gestualidad | **Sin gestos que disparen acciones** (ni gratis ni con tokens) | Todo por tap explícito. Regla 7 de CLAUDE.md intacta |
| Datos | Sin cambios de shapes en backend salvo necesidad demostrada | El rediseño consume `GET /tickets` tal como está |

---

## 1. Principios de diseño (heredados del proyecto)

1. **Delicado, minimalista, elegante** — una acción prominente por vista.
2. **Nada con tokens es accidental** — confirm explícito antes de todo runner IA (Desk, triage, investigaciones). El auto-refresh barato (GitHub) puede ser pasivo.
3. **Destructivo = fricción** — Cancelar PR y Descartar registro muestran su naturaleza completa antes de aprobar y viven detrás de un menú.
4. **Bloques largos nacen colapsados**, sub-elementos en árbol.
5. **Detalles de implementación en tooltips/secundario**, no en la superficie.
6. Tokens de `tokens.css` obligatorios, cero hex nuevo. Íconos nuevos van a `ui/icons.js`.

---

## 2. Arquitectura objetivo del refactor

### 2.1 Problema estructural que se resuelve

El monolito actual (1.378 líneas, un closure) mezcla fetching + polling + render + handlers + prompts, y **el estado UI vive en el DOM** (`[hidden]`, `dataset.loaded`, polls anclados a nodos con guardas `box.isConnected`). Consecuencia directa: el auto-refresh se PAUSA cuando hay un detalle abierto porque un re-render lo destruiría. El refactor invierte esto: estado fuera del DOM → el re-render es barato y seguro → el auto-refresh nunca se pausa.

### 2.2 Módulos propuestos

```
public/js/modules/bugs/board/
├── index.js      openBugBoard(): composición, wiring del modal, timers, ciclo de vida
├── store.js      Estado único: datos (entries, ghRows, triage, frescura) +
│                 estado UI (expandedKey, filter, query, archOpen, busy flags).
│                 API mínima: get(), set(patch), subscribe(fn). Sin librerías.
├── render.js     Funciones puras estado→HTML: renderHeader, renderList,
│                 renderCard, renderDetail, renderDeskSection, renderLive…
│                 Un solo punto de re-render con preservación de scroll.
├── actions.js    Handlers y endpoints: send, scan, ghSync, deskRefresh,
│                 work, deskchat, cancelPr, archive, discard, investigate…
├── polls.js      Poll manager POR CLAVE (p.ej. 'desk:519', 'inv:232'),
│                 no por nodo. start(key, fetchFn, onData), stop(key), stopAll().
│                 Los datos del poll entran al store; el render los pinta.
├── prompts.js    Textos de "Trabajar en esto" / "Responder ticket" (hoy ~40
│                 líneas inline en el JS de UI) + fetchContexts/historyText.
└── labels.js     Fuente ÚNICA de etiquetas: rowState(t), EV_LABEL, EV_DOT
                  (completado), RES_CHIP, celdas PR/Desk. Sin estados muertos.
```

### 2.3 Reglas del refactor

| # | Regla | Motivo |
|---|---|---|
| R1 | `store.js` es la única fuente de verdad; el DOM nunca guarda estado | Resuelve deuda 6; habilita auto-refresh sin pausa |
| R2 | Polls por clave, resilientes a re-render; deadline y dedup se conservan | Resuelve restricción 8 sin perder robustez actual |
| R3 | El frontend consume `state`/`resolution` del motor (`engineState` ya viaja en `/tickets`); `labels.js` solo MAPEA estado→etiqueta, no re-deriva | Resuelve deuda 2 (doble verdad motor/front) |
| R4 | Eliminar `OUTCOME_LABEL['plan'/'abandoned']` (motor nunca los emite) y completar `EV_DOT['ticket_actualizado']` | Deudas 7 y 8, costo cero |
| R5 | Migración `.bfm-*` → `.bb-*` completa; muere la regla escapada `.bfm-table:not(.bb-table)` | Deuda 3. Verificar que la tabla legacy que compartía `.bfm-*` no se rompa (auditar usos antes de tocar) |
| R6 | El orden de filas se decide en UN solo lugar (mantener el rank del cliente: pendiente+files→0 · pendiente→1 · resto→2 · complete→3, luego recencia; documentarlo en `render.js`) | Deuda 9 |
| R7 | Sin `nth-child` para responsive; las variantes móvil/desktop se resuelven por clases explícitas | Deuda 4 (fragilidad al orden de columnas) |
| R8 | No tocar `ui/dialog.js` salvo lo mínimo (los gotchas de `.dlg-overlay grid-template-columns` y `max-height 88vh/88dvh` documentados NO se modifican) | Restricción 2 |
| R9 | Respetar el guard global `[hidden]{display:none!important}` | Restricción 3 |
| R10 | Mover el tablero de `modules/tolkien/` a `modules/bugs/board/` (ya se abre solo desde bugs) | Deuda 11 |

---

## 3. Especificación UI móvil (≤640px)

### 3.1 Header

```
┌─────────────────────────────────────────┐
│ Bugs & PRs                        ⋯   ✕ │  ← título + menú overflow + cerrar
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 Buscar por #, título, archivo…   │ │  ← filtra en cliente sobre entries
│ └─────────────────────────────────────┘ │
│ (Acción 4) (Revisión 6) (✓ 12) (📦 15)  │  ← chips segmento con conteo, scroll-x
│ GitHub 2m · Desk sin consultar · triage 14h │  ← frescura en UNA línea
└─────────────────────────────────────────┘
```

- **Segmentos** (mapean al rank existente): `Acción` = pendiente c/files + triage-only con recomendación · `Revisión` = PR abierto · `✓` = merged/complete · `📦` = archivo. "Todos" implícito al deseleccionar.
- **Búsqueda**: filtra por nº de ticket, título y archivos tocados. Sin backend, sobre el store.
- **Menú ⋯ del header**: Buscar bugfixes · Sync GitHub · Consultar Desk (bulk, confirm tokens) · Ayuda. Todas episódicas → no merecen superficie permanente en móvil.
- **Frescura**: se consolida en una línea `fs-sm` (hoy son dos spans dispersos). "Desk sin consultar hace Nd" cuando aplique (pregunta 12 del contexto: recordatorio pasivo, sin auto-consulta).

### 3.2 Card de ticket (reemplaza `<tr>` en móvil)

```
┌─────────────────────────────────────┐
│ ⬤ #519 · PR #232            ◐ 🎫✔ │  L1: dot estado + identidad + iconos PR/Desk
│ Unificar popup de confirmación      │  L2: título limpio (sin prefijo "TKT #N —")
│ 🕐 En revisión · esperando a Chris  │  L3: ESTADO completo, nunca truncado
│ 🚦 La pelota la tiene Chris · 2 d   │  L4 (condicional): semáforo si hay investigación
└─────────────────────────────────────┘
```

- Alto mínimo 72px (L4 lo estira a ~88px). **Toda la card es tap target.**
- Fila-PR protagonista con sub-tickets: la card lleva borde-inicio acentuado (`inset 3px` actual) y chips `↳ 🎫 #519` bajo el título — el patrón árbol ya existente, trasladado.
- Pipeline: NO va en la card (ruido). Vive en la vista de foco como primera línea del bloque de estado. Con esto Pipeline y Cambios recuperan accesibilidad en móvil (hoy amputados por `nth-child`).
- Tipografía: título `--cwc-fs-md`; estado `fs-md`; metadata `fs-sm`. La base de lectura sube de 12.5 a ≥13.6px. Densidad se compensa con los filtros.

### 3.3 Vista de foco (detalle)

Al tap: la card expande a vista de foco — **mismo flujo de render, sin navegación real**:
scroll programático que ancla la card al tope, header sticky `← #519 · PR #232`,
el resto de la lista queda debajo (no se oculta: contexto de retorno).

```
┌─────────────────────────────────────────┐
│ ←  #519 · PR #232              [sticky] │
├─────────────────────────────────────────┤
│ 🚦 VEREDICTO (invTopBox)                │
│ Titular de la investigación…            │
│ ▸ Ver análisis completo                 │
│                                         │
│ [pipeline ▰▰▰▱▱]  ⬤ En revisión        │
│ [severidad alta] [reabierto ×2]         │
│                                         │
│ ▸ Resumen y archivos (4)     [colapsado]│
│ ▸ Timeline (8 eventos)       [colapsado]│
│ ▸ GitHub en vivo             [colapsado]│
│ ▸ Zoho Desk · sin consultar  [colapsado]│
│                                         │
│ 🔗 ticket ↗ · PR ↗ · branch             │
├─────────────────────────────────────────┤
│ ┃ Trabajar en esto ┃  [🔍 Investigar] ⋯ │  ← action bar sticky inferior
└─────────────────────────────────────────┘
```

- **Secciones colapsadas por defecto** (principio 4). "GitHub en vivo" carga lazy al expandirse (comportamiento actual, ahora vía polls.js).
- Botón ← y back del navegador cierran el foco (pushState liviano opcional; si complica, solo ←).
- El auto-refresh GitHub **ya no se pausa**: actualiza store → re-render preserva expandedKey y scroll.

### 3.4 Jerarquía de acciones del detalle

| Nivel | Acciones | Notas |
|---|---|---|
| **Primaria** (sólido, action bar) | Trabajar en esto / Trabajar en Chat (plan) — o **Archivar** si `resolution==='complete'` | Lógica de promoción actual, conservada |
| **Secundaria** (ghost, action bar) | 🔍 Investigar (a fondo / contexto según el caso) | Trabajo activo: lanzar runners es flujo diario. Confirm de tokens intacto |
| **Menú ⋯** | Responder ticket (chat) · Traer estado de Desk · Cancelar PR · Descartar registro | Destructivas con `confirmDialog danger:true` y descripción completa del efecto |

### 3.5 Acción global: Enviar pendientes

- **Action bar sticky inferior de la LISTA**, visible solo cuando `pendientes > 0`: `⇧ Enviar pendientes (N)`.
- Resuelve la tensión documentada (primario visual que nace disabled): si no hay nada que enviar, no existe; si hay, es imposible no verlo y está en la zona del pulgar.
- El confirm conserva la lista nuevo-PR vs "ACTUALIZA PR #n", `warningsFor` y el aviso del auto-update de Desk, reformateado para 375px (una entrada por línea, scroll interno).

### 3.6 Touch targets y tipografía (transversal)

| Elemento | Objetivo |
|---|---|
| Card (tap expandir) | ≥72px alto, ancho completo |
| Botones action bar | ≥48px |
| Chips de filtro | ≥40px alto con padding táctil (hit area 44 aunque el visual sea menor) |
| Íconos ↻ (live/desk fresh) | 44×44 hit area |
| Override `.btn--sm{min-height:38px}` bajo `pointer:coarse` | **Eliminar** — es lo que pisa el bump de 44px en todo el tablero |
| Emoji funcionales (🎫✅/⏳/◐…) | Migrar a SVG en `icons.js` (consistencia entre plataformas; deuda 10) |

---

## 4. Plan de fases con checkpoints

> Cadencia: cada fase termina en un checkpoint que Niko valida ANTES de continuar.
> Claude Code trabaja en plan mode al inicio de cada fase. Nunca avanzar sin confirmación.

### Fase 0 — Safety net
- Branch `redesign/board-mobile` desde main fresco (verificar frescura primero, regla del PR style guide).
- Capturas de pantalla del estado actual (desktop + 375px) como baseline de regresión.
- **Checkpoint 0**: branch creado, baseline documentado.

### Fase 1 — Refactor estructural SIN cambio visual
- Partir `bug-board.js` en los módulos de §2.2. Mover a `modules/bugs/board/`.
- Store + render puro + polls por clave. Reglas R1-R4, R6, R10.
- **Criterio duro: paridad visual y funcional total con el estado actual.** Mismo HTML resultante (o equivalente), mismos flujos, mismos confirms.
- **Checkpoint 1**: diff de comportamiento = cero. Probar: expandir detalle + auto-refresh (ya no debe pausarse), poll de Desk sobreviviendo a un re-render, enviar un PR de prueba NO (solo dry-run visual de confirm).

### Fase 2 — Migración CSS y correcciones transversales
- `.bfm-*` → `.bb-*` (R5, auditando usos externos primero). Eliminar `nth-child` responsive (R7). Eliminar override `.btn--sm` en coarse. Íconos emoji → `icons.js`.
- **Checkpoint 2**: desktop idéntico; auditoría de touch targets ≥44 en elementos que ya existen.

### Fase 3 — Vista móvil: cards + búsqueda + filtros
- Render condicional por breakpoint: cards ≤640px (§3.2), tabla intacta en desktop. Header móvil (§3.1) con búsqueda y segmentos.
- **Checkpoint 3**: validación en 375px con datos reales (>30 tickets). Medir: ¿se encuentra un ticket específico en <5 segundos?

### Fase 4 — Vista de foco + action bar del detalle
- §3.3 y §3.4. Secciones colapsadas, lazy load vía polls.js, action bar sticky.
- **Checkpoint 4**: flujo completo en móvil: abrir foco → expandir GitHub en vivo → lanzar investigación (confirm) → volver → auto-refresh sin pérdida de estado.

### Fase 5 — Acciones globales móviles
- Enviar pendientes sticky (§3.5), menú ⋯ del header, confirms reformateados, línea de frescura consolidada.
- **Checkpoint 5**: envío real de un PR de prueba desde el celular, ciclo completo.

### Fase 6 — Aceptación y cierre
- Pruebas de regresión desktop (baseline F0) + móvil. Actualizar `docs/contexto-tickets-ui.md` con el estado nuevo.
- PR con `## Summary` según el style guide: problema, qué se hizo, por qué fue la mejor solución con alternativas descartadas (bottom sheet descartado por densidad del detalle y ambigüedad del swipe; tabla móvil descartada por 8 columnas + nowrap; gestos descartados por regla de tokens).

---

## 5. Prompt de arranque (Fase 0+1, plan mode)

```
Lee ANTES de proponer nada:
1. docs/contexto-tickets-ui.md  (radiografía del estado actual)
2. docs/plan-rediseno-movil-tickets.md  (este plan — decisiones ya validadas)
3. CLAUDE.md del proyecto (reglas duras: tokens bajo confirm, git safety net)

Estamos en Fase 0 + Fase 1 del plan: refactor estructural SIN ningún cambio
visual ni funcional. El objetivo de esta sesión NO es el rediseño móvil
todavía — es preparar la arquitectura que lo hace posible.

Fase 0: crea el branch redesign/board-mobile desde main verificado fresco.

Fase 1: parte public/js/modules/tolkien/bug-board.js en los módulos
definidos en §2.2 del plan, aplicando las reglas R1-R4, R6 y R10 de §2.3.
Restricciones inviolables: R8 (no tocar los gotchas de dialog.js) y
R9 (guard [hidden]).

Criterio de aceptación de la fase: paridad total. Un usuario no debe poder
distinguir el antes y el después. El único cambio de comportamiento
permitido es el descrito en R1/R2: el auto-refresh de GitHub deja de
pausarse cuando hay un detalle abierto, porque el estado ya no vive en
el DOM.

Presenta primero el plan de particionado (qué línea va a qué módulo,
en qué orden migras, cómo pruebas paridad en cada paso) y ESPERA mi
aprobación antes de tocar código.
```

---

## 6. Alternativas descartadas (para el Summary del PR)

| Alternativa | Por qué se descartó |
|---|---|
| **Bottom sheet para el detalle** | El panel es demasiado denso (investigación + timeline + live + desk + 8 acciones). NN/g y la práctica de la industria reservan sheets para contenido breve y descartable; el gesto de cierre por swipe es ambiguo y cerraría el detalle accidentalmente durante el scroll interno |
| **Tabla responsive (mantener tabla en móvil)** | 8 columnas con `white-space:nowrap` fuerzan scroll horizontal; la ocultación por `nth-child` ya demostró ser destructiva. No hay caso de uso real de comparación columnar entre tickets |
| **Gestos (swipe para archivar, pull-to-refresh)** | Regla del proyecto: nada con tokens puede ser accidental; y para consistencia, ninguna acción se dispara por gesto. Todo tap explícito |
| **Solo capa visual sin refactor** | El estado en el DOM impone la pausa del auto-refresh y polls frágiles; cualquier rediseño serio del render lo rompería. El refactor es prerequisito, no lujo |
| **Vista de detalle con navegación real (ruta propia)** | Innecesario: la vista de foco logra la misma percepción sin plomería de routing en una app que no tiene router |
