<!-- cwc:ficha-modulo -->
# src/modules/health — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Verificación de salud

- **🩺 ESCANEO DE SALUD UNIFICADO** (2026-07-12, pedido de Niko: "un solo botón que
  corra todo"): la pestaña Salud dejó de tener 3 botones IA sueltos (Optimización /
  Coherencia / Revisión). Ahora hay UN botón "Escaneo de Salud" que corre los TRES
  análisis + el cross-check con Pad en UNA pasada, bajo UN pool adaptativo
  compartido (`core/pool.js` · runAdaptivePool) — la paralelización que antes solo
  tenía la Revisión aplicada a TODO: las ~16 unidades de la Revisión + la query de
  Optimización + la de Coherencia entran al MISMO pool, así optim/coh corren
  DURANTE la Revisión (gratis en tiempo de reloj). ORQUESTADOR desacoplado
  `bin/cwc-health-scan-runner.js` + `health/scan-shared.js` (lock `health-scan.lock`
  heartbeat pid-aware + estado `health-scan.json` por fases; reanudable, sobrevive
  reinicio — regla de oro). REUSA la lógica de los 3 motores (prompts/parsers/
  allowlists de shared.js/optimize-shared/coherence-shared) — NO la reescribe — y
  escribe los MISMOS archivos de resultado (review/optimization/coherence.json), así
  todas las acciones de aprobar/fix siguen funcionando. Blindaje regla 6 intacto
  (cada query su allowlist read-only doble capa). Incremental por default (caché de
  fingerprint de la Revisión) · `full` ignora cachés. CROSS-CHECK con Pad
  (`crossCheckPad` en scan-shared, 0 tokens): cada hallazgo de la Revisión se cruza
  contra la colección Bugs de Pad → 🆕 nuevo (candidato a BUG) · 🔗 rastreado (ya en
  el backlog) · ⚠️ regresión (matchea un BUG fixed/wontfix → reapareció). WRITE-BACK
  con confirmación: `POST /scan-pad-bug` crea el BUG en Pad desde un hallazgo nuevo
  (`createBugFromFinding`). Endpoints: `POST /api/health/scan-all` (admin, spawn,
  reserva pid:0) · `GET /scan-all` (0 tokens, lee disco + progreso) · `POST
  /scan-pad-bug` (admin). Front: `system/health-panel.js` (Chequeos rápidos + 🩺
  Escaneo de Salud con DOS botones: "Abrir Escaneo" + "🤖 Resolver todo (N)") +
  `system/health-scan-modal.js`.
  REDISEÑO 2026-07-19 (PLAN-752, pedido de Niko: "Salud está hecha un desorden,
  simplificar a 2 botones + menos submenús"). ANTES: el modal del Escaneo tenía 6
  tabs (Resumen/Revisión/Optim/Coherencia/Dashboard/Pad) y CADA tab de motor abría
  OTRO modal (health-review/optimize/coherence/inventory) = 3 niveles de ventanas
  anidadas. AHORA: UNA vista scrolleable con secciones `<details>` colapsables (regla
  UI "colapsable + árbol"), TODO accionable INLINE — los motores (🔬 Revisión · 🧠
  Optimización · 🔗 Coherencia) se MONTAN inline dentro de su sección, lazy al abrir
  el `<details>`, con cleanup (stop del poll) al colapsar/cerrar. Para eso los 3
  sub-modales exponen ahora `mountX(host, ctx, {isAdmin, onClose})` (montable en un
  contenedor, reusa el 100% de su lógica) ADEMÁS de `openX` (wrapper standalone que
  crea el modal y llama mountX). El escaneo importa `mountHealthReview`/`mountOptimize`/
  `mountCoherence`. CAMBIOS de estructura: (a) el 📊 Dashboard del proyecto SALIÓ a su
  PROPIA pestaña de Sistema (grupo Diagnóstico → `system/dashboard-panel.js`,
  `mountDashboardPanel` — es informativo, no accionable); `inventory-modal.js` se
  ELIMINÓ (su lógica vive ahora en dashboard-panel.js). (b) BOTÓN "🤖 Resolver todo"
  (F2, `system/health-resolve-all.js` `launchResolveAll`): junta los hallazgos
  ABIERTOS de la Revisión + las propuestas PENDIENTES de Optim/Coherencia (0 tokens,
  lee los endpoints existentes) y abre UN chat supervisado (acceptEdits, cwd=console)
  con un prompt que instruye usar el ORQUESTADOR INTERNO (skills `agrupar`/`orquestar`,
  PLAN-642) — agrupar por colisión de archivos y resolver bloques en PARALELO
  supervisado. NO hay runner-orquestador nuevo en el backend: Niko pidió resolver "en
  el CHAT", así que reusa el flujo de skills probado (cero infra de orquestación en
  el server). Visible si admin + hay `openCount>0` (el `verdict en vivo` de /scan-all
  ya expone openCount/resolvedCount). CIERRA EL CICLO de CADA ítem (gap que reportó
  Niko 2026-07-19: "resolvemos pero las propuestas siguen ahí"): el prompt instruye al
  chat a cerrar cada HALLAZGO con `cwc-health-resolve.js <id>` y cada PROPUESTA con
  `cwc-health-proposal-mark.js <optimize|coherence> <id> <accept|reject>` (accept si la
  aplicó, reject si es FP/no aplica) — sin esos comandos la propuesta quedaba "pending"
  en su sección aunque estuviera resuelta. Los 3 runners standalone
  (`cwc-health-runner`/`optimize`/`coherence`) y sus `POST /review`//optimize`/
  /coherence` SIGUEN existiendo como el mecanismo subyacente (los reusan los mountX);
  el orquestador sostiene sus 4 locks durante el escaneo, así que no hay doble
  corrida. La sección de abajo describe cada motor en detalle (siguen siendo la
  verdad de cómo funciona cada uno).
- **Checks rápidos** (`GET /api/health/checks`, gratis): systemd activo +
  KillMode=process, tmux del socket cwc, runners de chat, observador instalado,
  cert/TLS, git limpio, sintaxis de todo `src/` y `bin/`, disco, datos runtime,
  **`claude-cred`** (`console:BUG-2438`, 0 tokens): vigila que la credencial
  OAuth del host conserve un accessToken o refreshToken utilizable; existe porque
  el 2026-07-31 apareció vaciada y ningún check lo detectaba hasta que ningún chat abría.
  **`sponsored-usage`** (informativo, 0 tokens): para cada usuario patrocinado
  mide el costo del día en hora de Bogotá reusando `buildSummary()` del módulo
  tokens. Avisa desde USD 10 por defecto, configurable con
  `CWC_SPONSORED_USAGE_WARN_USD`; NUNCA bloquea un runner ni impone un tope. Es
  resiliente por ítem: un usuario ilegible se reporta como indeterminado sin
  tumbar el chequeo ni impedir que se midan los demás.
  **`tmux-owner`** (`console:BUG-2350`, 0 tokens): para cada pane del socket
  `cwc`, compara el `HOME` efectivo leído de `/proc/<pane_pid>/environ` con
  `userSpace(owner)`, resolviendo el dueño durable mediante
  `ownerForSession`; además compara el `HOME` global del server tmux con el
  espacio del host para detectar la fuga latente antes de que afecte un pane.
  Existe porque un HOME global de inquilino puede hacer que una sesión del
  host herede credenciales ajenas. Devuelve `fail` ante un pane con HOME
  incorrecto, `warn` ante HOME global incorrecto o mediciones irresolubles, y
  `ok` solo cuando todo lo medible coincide. El socket ya se fija con `-L cwc`,
  pero un server tmux persistente sin sesiones responde `no current target` a
  `list-panes -a`: antes ese inventario vacío se confundía con una enumeración
  fallida; ahora se interpreta como cero panes y devuelve `ok` explícito («sin
  panes que auditar») si el HOME global está sano. Cualquier otro error de
  enumeración conserva `warn`. Su status viaja al CSS como
  `hp-dot--${status}`: los únicos valores
  permitidos son `ok|warn|fail`, o el indicador queda sin color en silencio.
  **`onboard-provisioning`** (console:BUG-2118: `ok` si no hay altas o todas
  están completas; `warn` si alguna quedó `failed` o lleva más de 10 minutos
  en `pending`), **`onboarding`** (`console:PLAN-2337`, criterios C6/C7, 0
  tokens): recorre cada usuario no-host y reusa `CAPABILITIES` +
  `requiredFor` + el `detect` real de cada capacidad requerida del wizard,
  sin duplicar el catálogo; devuelve `warn` nombrando al inquilino y sus pasos
  pendientes, `ok` si todos están completos o `ok: sin inquilinos` si no hay
  ninguno. Además compara la identidad Infisical con
  `readInfisicalAccountEmail`: si la cuenta de un inquilino coincide con la
  del host devuelve `fail`, porque es una regresión de aislamiento y no un
  onboarding válido. El status viaja al CSS mediante `hp-dot--${status}` y los
  únicos estados válidos son `ok|warn|fail`; agregar otro lo renderiza sin
  color en silencio. **`docker-hygiene`** (PLAN-2268, 0 tokens: lee solamente
  `~/.cwc-data/docker-hygiene/report.json`, nunca invoca Docker desde el
  request; `warn` desde 20 volúmenes dangling o 5 GB reclamables totales, o
  si el reporte lleva más de 24 h; `ok` con nota si todavía no existe o Docker
  figura `unavailable`. El barrido NUNCA es automático: se simula con
  `node bin/cwc-docker-hygiene-runner.js --prune` y solo un humano agrega
  `--yes`), **`vendor-drift`** (`console:PLAN-2811` / `console:BUG-2816`, 0
  tokens): detecta copias estáticas migrables en `public/vendor/` para paquetes
  declarados y exige montarlas desde `node_modules`; acepta `hljs` como única
  excepción porque highlight.js no publica bundle de navegador, pero compara
  su versión vendorizada con la instalada y avisa si difieren o no puede
  determinarla. Nunca devuelve `fail`. Espejo de contexto a Tolkien
  (`tolkien-context`) y
  **`facetas`** (`checkFacetas`, `console:PEND-2283`, 0 tokens): avisa si falta
  la foto local de facetas, si alguna unidad de `discoverUnits()` no tiene
  clase declarada o si aparece código en `src/` fuera del radar estructural
  (un subdirectorio distinto de `core`/`modules`, o un `.js` suelto distinto
  de `server.js`). Una unidad sin clase no queda abierta: recibe el trato más
  restrictivo mientras se corrige la clasificación y se regenera la foto.
  **`i18n`** (`console:BUG-2517` / `console:BUG-2518`, 0 tokens): audita claves
  usadas sin traducción y huérfanas, la carga de diccionarios y la inicialización
  de i18n en páginas standalone, archivos ignorados por git y la coherencia entre
  el índice de ayuda, sus `load:` y las llamadas a `helpBtn()`. Nunca devuelve
  `fail`: `t()` degrada intencionalmente al español, por lo que un hallazgo o una
  excepción del auditor es `warn` y no debe tumbar la pestaña Salud. La lógica se
  comparte con `bin/cwc-i18n-audit.js` mediante
  `src/modules/health/i18n-shared.js`; no se duplica (`console:CONVE-2085`). Las
  tres excepciones conocidas de ayuda (`sala`, `auxbar`, `stats`) están declaradas
  a propósito en ese módulo compartido para que el check no nazca en amarillo
  permanente. Nació de BUG-2517 —tres diccionarios (214 claves) fuera de los 16
  namespaces hardcodeados y seis páginas sin `initI18n`— y BUG-2518 —
  `public/i18n/en/sessions.json` ignorado durante unos 12 días por un patrón sin
  anclar en `.gitignore`—, dos fallas invisibles por el fallback al español.
  Y **`pad-backbone`**
  (2026-07-12, Gap #3 / TASK-296): lee las Conventions del Pad LOCAL por HTTP
  (0 tokens, NO MCP → no toca la regla 6, vía `core/pad-service-client.js`) y
  verifica (a) que el Pad local RESPONDE —si no, warn: tasks/learning/retro/
  tickets-meta degradan EN SILENCIO— y (b) que existe el espejo de la Regla
  dura #12 en las Conventions (señal concreta de divergencia CLAUDE.md↔Pad).
  OJO: el REST del Pad local devuelve `fields` como STRING JSON (no objeto como
  el MCP) — hay que `JSON.parse` antes de leer priority/status.
  Y **`pad-grafo`** (2026-09-08, F3 de PLAN-2851): verifica en la SQLite local
  las leyes de conectividad del workspace `console` —grado 0, raíz única
  `ARQUI-1258` y planes activos sin parent/implements ni tag `isla`—. Abre
  `~/.pad/pad.db` read-only, consume 0 tokens, NUNCA usa MCP y ante cualquier
  incompatibilidad o ausencia de la DB degrada best-effort a `warn`, nunca tira.
  Y **`cross-world`** (2026-07-14, F7 de PLAN-373/PEND-466): AUDIT determinístico
  (0 tokens, read-only) de los CRUCES ENTRE MUNDOS. `checkCrossWorld` en
  `health/index.js` escanea `src/`+`bin/` buscando referencias al mundo externo
  (`config.projectDir`/`CLAUDE.local.md`, regex `CROSS_WORLD_RE`) y las compara con
  `CROSS_WORLD_ALLOW` (los 16 cruces LEGÍTIMOS conocidos, grandfathered — mapeados
  en DOC-468). Cualquier archivo NUEVO que cruce al mundo externo y NO esté en el
  allowlist ⇒ warn ("pasalo por el paquete-sesión —canal canónico— o sumalo al
  allowlist con motivo"). Es la forma SEGURA de "un solo canal" (Regla 12
  endurecida): NO bloquea ni apaga los caños vivos en runtime (eso rompería comms/
  tickets/retro — se descartó a propósito); GRANDFATHEREA lo existente y GATEA por
  DETECCIÓN lo nuevo. Migrar un caño viejo al paquete es un proyecto per-caño
  aparte. El `src/modules/chat/index.js` (handoff/worldLabelFor) está en el
  allowlist como EL canal canónico del paquete-sesión.
  Y **`ancla`** (2026-07-26, Regla dura 15 / CONVE-1957 / CONVE-1958):
  `checkAncla` audita por HTTP plano (0 tokens, NO MCP) los ítems ACTIVOS de las
  colecciones de `ANCLA_COLLECTIONS` = `['planes', 'pendientes', 'bugs']`:
  el ancla completa (`## 📌 Pedido original (verbatim)` +
  `## 🎯 Criterios de aceptación`) puede vivir en el propio ítem o heredarse de
  un ancestro; solo la raíz de la constelación la declara. La herencia recorre
  exclusivamente links reales
  `link_type === 'parent'` de `GET /items/<ref>/links` — NUNCA el `parent_ref`
  del listado, que no representa topología confiable (BUG-2053)—, cachea lecturas
  y corta a 12 niveles para que un ciclo no cuelgue Salud. Una cadena ilegible o
  que alcanza el tope queda como auditoría incompleta, no como falso
  incumplimiento. GRANDFATHERING por
  fecha: `ANCLA_SINCE` (constante de módulo, `2026-07-26T15:09:20Z` = el instante
  exacto de creación de CONVE-1957, no la medianoche) acota la
  auditoría a los ítems creados DESPUÉS de la adopción de la convención; los ítems
  anteriores nacieron sin ancla y marcarlos sería ruido permanente — el check existe
  para señalar deriva NUEVA, no para reprochar historia. Falta de ancla ⇒ `warn` con
  conteos por colección, refs (máx 5) y el remedio ("corré la skill `anclar`");
  Pad caído ⇒ `warn`, nunca `fail` (mismo criterio que `pad-backbone`).
  CAMBIO 2026-07-29 (`console:PEND-2286`): `ANCLA_COLLECTIONS` decía `tasks` y
  ahora dice `pendientes`. La fusión de F7 dejó `tasks` vacía y después retirada,
  y auditar una colección vacía es perder cobertura EN SILENCIO — el check habría
  seguido en verde sin mirar nada. Medido contra el Pad vivo, el cambio lleva los
  ítems auditados de 39 a 47 y destapa 2 sin ancla (`console:PEND-1966` y
  `console:PEND-2297`), que pasan el check a `warn`. No es una regresión: es el
  auditor viendo por fin la colección donde vive el trabajo. Los 2 quedaron
  registrados en `console:PEND-2326`. Lección generalizable: **si una migración
  vacía una colección, hay que mudar también a sus AUDITORES**.
  Y **`pad-bootstrap`** (2026-07-26, BUG-2047): check hermano de `pad-index`
  porque auditan canales de naturaleza distinta — el índice y sus destinos los
  controla este repo; el bootstrap lo genera Pad server. Lee por HTTP plano el
  mismo blob consolidado de `pad_set_workspace console` (colecciones +
  conventions always-on + playbooks + dashboard + índices + roles), 0 tokens y
  NUNCA MCP. Techo `73.000 B`, derivado de la medición real al implementar:
  `72.751 B` el 2026-07-26, redondeado al millar inmediato superior (249 B de
  margen): detecta crecimiento, no declara un ideal. Si lo supera ⇒ `warn` con
  desglose obligatorio de playbooks/conventions/collections/dashboard y su
  porcentaje; Pad caído o respuesta ilegible ⇒ `warn`, nunca `fail`.
  Y **`tolkien-envs`** (2026-07-27, `console:PLAN-2072`): además de
  reconciliar el registro con worktrees huérfanos, llama a
  `verifyEnvContext(worktree)` para
  auditar el marco operativo de CADA entorno cuyo worktree exista en disco
  (`CLAUDE.local.md`, `.cwc-ticket-playbook.md`, `.env`,
  `.claude/settings.local.json` y `memory/`). `.pad.toml` se siembra, pero NO
  se audita: si se borra a mano, este check no lo detecta. Si falta contexto
  devuelve `warn`, con artefactos faltantes por entorno (máx. 3 entornos y 3
  faltantes por entorno), y pone ese hallazgo ANTES de errores y huérfanos.
  GOTCHA: NO filtrar con `isEnvAlive`; `'down'`/`'error'` describen el
  dev-server, no si una sesión sigue trabajando dentro del worktree. El caso
  que originó el check estaba `'down'` con una sesión adentro, por eso se
  verifica todo worktree existente.
- **Runners activos** (`GET /api/health/active-runners`): sin flags conserva el
  contrato histórico —un no-admin ve solo sus jobs con owner declarado
  (fail-closed) y el admin ve todos, como requiere el modal "Trabajos en segundo
  plano"—. `?mine=1` (también acepta `mine=true`) fuerza el filtro por dueño
  incluso para el admin; lo usa la Vista Raw porque es un monitor personal. En
  ese modo, un runner sin dueño declarado se considera del host por
  retrocompatibilidad.
- **Dashboard del proyecto** (PESTAÑA PROPIA "📊 Dashboard" del grupo
  Diagnóstico del menú Sistema — `system/dashboard-panel.js`,
  `mountDashboardPanel`. REDISEÑO 2026-07-19 PLAN-752: antes era una subsección
  de la pestaña Salud que abría la SUB-VENTANA `inventory-modal.js`; ahora es
  pestaña propia porque es INFORMATIVO —censo + recursos—, no accionable, y
  Salud queda solo con lo accionable. `inventory-modal.js` se ELIMINÓ; su lógica
  vive tal cual en dashboard-panel.js, montada en el panel en vez de un modal).
  Antes "🔍 Censo del proyecto" solo mostraba conteos —"11 módulos"— sin decir
  CUÁLES, y sin ningún dato de CPU/RAM/núcleos. TODO gratis (0 tokens, sin LLM, sin capa IA — por eso
  no tiene botón "Analizar con IA" como sus gemelas, solo "Re-escanear
  ahora"): reusa `GET /api/health/scan` (`generateInventory()` de
  `core/inventory.js`, caché por fingerprint) ENRIQUECIDO con lo que antes se
  recortaba antes de responder — cada módulo backend trae `registryLine` +
  `endpoints[]` + cantidad de archivos; el array `frontend[]` (antes NI se
  enviaba, solo `counts.frontend`) ahora viaja completo con `mounted`; los
  runners traen su `purpose`. RECURSOS DEL SERVIDOR (núcleos, CPU%, RAM
  usada/total, disco usado/total, load avg, uptime, hostname): el endpoint
  suma el campo `resources` llamando a `systemSnapshot()` de
  `modules/stats/index.js` — FUENTE ÚNICA compartida con `GET /api/stats`
  (el gauge del pie), en vez de reimplementar `os.cpus()/loadavg()/freemem()`
  por su cuenta (antes esos datos existían pero SOLO en el pie de página,
  invisibles desde Salud). El frontend también reusa `heat()`/`fmtBytes()`/
  `fmtUptime()` de `stats/stats.js` (recién exportados) para pintar los
  tiles con el MISMO criterio de color que el gauge del pie. BACKBONE DE PAD
  (2026-07-12, Gap #4c / TASK-300): `GET /scan` suma el campo `pad`
  (`padBackboneStats()` de health/index.js → `listCollections` del Pad LOCAL,
  1 llamada HTTP, 0 tokens, best-effort: counts `active`/`total` por colección);
  `system/inventory-modal.js` (`padHtml`) lo pinta como un `<details>`
  colapsable "🗂️ Pad local · backbone" con la tabla de colecciones (bugs/roads/
  tasks/pendientes/planes/temas…) — así se ve el estado del TRACKER junto al
  censo del CÓDIGO y los recursos, cerrando la foto "código + trabajo rastreado"
  en una pantalla. Si el Pad local no responde, el tile muestra el aviso de que
  tasks/learning/retro/tickets-meta degradan a best-effort (mismo criterio que
  el check `pad-backbone`).
- **Optimización IA** (subsección "🧠 Optimización IA" de la pestaña Salud,
  2026-07-04): analiza el flujo de TODOS los motores IA de la consola. La
  pestaña muestra SOLO el resumen compacto (veredicto en 1 línea + botón
  "Optimización IA →", mismo patrón que Revisión profunda — rediseño a pedido
  del usuario: la sección inline completa estiraba Salud); el contenido entero
  (censo, análisis, tarjetas de propuesta) vive en la SUB-VENTANA
  system/optimize-modal.js (gemela de health-review-modal, .dlg-card--health).
  DOS niveles: (a) CENSO determinístico (GET /api/health/ai-census, 0 tokens,
  autenticados) — `aiEnginesCensus()` de core/inventory.js detecta todo archivo
  que importa el SDK y llama a query() y extrae con regex modelo(s)/dinámico,
  maxTurns (resuelve consts), timeouts, allowlists, capas (PreToolUse+
  canUseTool), settingSources y permissionModes; también se publica en
  inventory.md (sección "Motores IA"). (b) ANÁLISIS (POST /api/health/optimize,
  admin, CONSUME TOKENS, confirm en el front) → runner desacoplado
  bin/cwc-optimize-runner.js (ver mapa; lock `optimize.lock` con fase, reserva
  pid:0 del server patrón spawnFix, resultado persistido en
  ~/.cwc-data/optimization.json); GET /api/health/optimization solo lee disco +
  running/progress (el front encuesta cada 4 s). Propuestas PENDIENTES con
  Aprobar/Descartar (POST /api/health/optimize-proposal {id, action}) — patrón
  invariant-proposals: NADA se auto-aplica; "Aplicar en chat" abre un chat
  supervisado (acceptEdits, cwd consola) con el contexto de la propuesta y
  reglas estrictas (leer CLAUDE.md, node --check, frenar en alto riesgo);
  "Explorar en chat (plan)" hace lo mismo con el flujo nuevo en modo plan.
  El optimizador tiene PROHIBIDO proponer nada que debilite las reglas duras
  (se lo exige el prompt y lo re-verifica el chat que aplica). Las REGLAS
  DURAS van INYECTADAS pre-masticadas en optimizePrompt() vía hardRulesText()
  de health/shared.js (2026-07-06, mismo patrón que unitPrompt): la corrida ya
  NO gasta un Read de CLAUDE.md entero para eso — si la extracción falla,
  fallback a la instrucción vieja de leer el archivo.
- **Coherencia** (subsección "🔗 Coherencia" de la pestaña Salud, gemela de
  Optimización IA): mientras la Revisión audita NODOS (cada módulo por dentro)
  y la Optimización mira la CONFIG de cada motor, Coherencia mira las ARISTAS —
  ¿los motores/módulos se APROVECHAN entre sí o reinventan/duplican/se ignoran?
  Disparador real: motores del ciclo de tickets que scrapeaban GitHub por su
  cuenta en vez de usar el motor `comms`. DOS niveles: (a) CENSO determinístico
  (GET /api/health/coherence-census, 0 tokens) — `coherenceCensus()` de
  core/inventory.js construye el GRAFO quién-usa-a-quién parseando los imports
  relativos resueltos (.js//index.js) de src/ y bin/ (antes NO existía: era la
  única pieza nueva de verdad), detecta el consumo de los servicios
  transversales canónicos (comms, bus/interfono, inventory, tokens, paths,
  sdk-settings) y marca señales (llamadas a `gh`, motores SDK, runners y si
  respetan la regla de oro — un runner que DELEGA en su `*-shared.js` cuenta
  como OK). `evaluateCoherence()` de health/coherence-shared.js aplica REGLAS de
  cableado sobre el censo → hallazgos duros: comms infrautilizado (bug/feature
  que no consulta comms) · gh FUERA de las fuentes canónicas (2026-07-06,
  antes "gh en >1 módulo" y saltaba eternamente como FP aunque la unificación
  Fase C ya estaba hecha: ahora GH_CANONICAL exime al lector único
  comms/pr-read-shared.js y al gateway comms/gateway-shared.js, y GH_EXEMPT
  —hand-authored con motivo, patrón `exclude` de los patrones canónicos—
  exime los usos verificados a mano: backup/index.js repo-edit del repo de
  la consola y bugfixes/index.js cuyos gh restantes son excepciones
  documentadas; basta UN archivo nuevo no eximido para disparar. OJO: los
  motivos en GH_EXEMPT se redactan "repo edit (gh)" y no al revés — el
  censor ghRe de core/inventory.js matchea comillas+gh+verbo y el propio
  coherence-shared.js se auto-detectaría como caller) · runner sin regla de oro ·
  motor SDK sin doble capa · servicio transversal huérfano · y COMPLETITUD del
  inventario (census.completeness, reusa parseBackendModules/Frontend/Runners +
  el grafo): módulo backend sin registrar en registry.js · módulo frontend sin
  montar NI importar en public/js (los que main.js monta a mano como
  chat/terminal/mobile NO se marcan) · runner huérfano (bin/*runner* que nadie
  spawnea por nombre) · motor SDK huérfano (llama query() pero nadie lo importa/
  referencia). "Está CORRIENDO donde debe" NO se chequea acá — eso es runtime y
  queda en los Chequeos rápidos (pedido del usuario: no sacarlo de ahí). TERCERA
  dimensión — PROPAGACIÓN DE PATRONES (census.patterns, CANONICAL_PATTERNS de
  core/inventory.js): "ya probamos un patrón bueno (pool paralelo adaptativo
  health/pool.js·runAdaptivePool · caché incremental por fingerprint · runner
  desacoplado) — ¿qué otros sitios deberían adoptarlo y lo reinventan?". El censo
  detecta proveedor/adopters/candidatos (candidato = LEAD por regex, p.ej. bucle
  for-of con await sobre I/O que no usa el pool); la regla `adopcion` lo marca
  pero la REGLA DE ORO ("paralelo lo que LEE, serial lo que ESCRIBE") la confirma
  la IA/humano (un bucle que escribe en orden o es interactivo NO se paraleliza).
  Un FP confirmado a mano se exime con el campo `exclude: [archivos]` del patrón
  (hand-authored con comentario del porqué, 2026-07-06: backup/index.js `git add`
  escribe el índice · chat/index.js y cwc-chat-runner.js son streams del SDK) —
  así el aviso no reaparece eternamente por sitios seriales POR DISEÑO.
  Cada hallazgo trae `pasos` (procedimiento) y en el modal un botón "💬 Resolver
  en chat" (chat supervisado acceptEdits, admin) — accionable SIN gastar la IA.
  El modal muestra los hallazgos SIEMPRE frescos del censo (no los persistidos en
  coherence.json, que son la foto de cuando corrió la IA). CUARTA dimensión —
  CONVENCIONES (census.conventions, CANONICAL_CONVENTIONS de core/inventory.js,
  2026-07-06): a diferencia de las 3 anteriores (grafo/cableado/patrones, todas
  sobre src/ y bin/), esta mira si los módulos FRONTEND (public/js, public/css)
  respetan la sección "## Convenciones" de este mismo archivo — TRANSVERSAL a
  cualquier módulo nuevo/cambiado, a diferencia de un invariante de Salud
  (health/invariants.js) que apunta a un archivo puntual. Disparador real: el
  módulo `comms` nació con su panel colapsable pero sin nacer COLAPSADO por
  defecto, y ni Coherencia ni la Revisión profunda lo cazaban — ninguna de las
  dos tenía esa convención de UI en su radar. Dos capas iguales a los patrones
  canónicos: (a) MECÁNICA (`violates`, 0 tokens, LEAD por regex — colores hex
  fuera de tokens.css, `alert/confirm/prompt` nativos fuera de ui/dialog.js,
  `<svg` inline fuera de ui/icons.js) verificada por `evaluateCoherence()`
  (categoría `convencion`); (b) SEMÁNTICA (`violates: null`, p.ej. "todo panel
  nuevo con mucho texto nace colapsado + agrupado en árbol") que NO es
  chequeable por regex — se resuelve inyectando `conventionsText()` de
  health/coherence-shared.js (recorta "## Convenciones" UNA vez, mismo patrón
  que `hardRulesText()` de Salud con "## Reglas duras") en el prompt del
  análisis IA, que elige unos módulos frontend y los abre a verificar. Sumar
  una convención nueva chequeable por regex = agregar una entrada a
  CANONICAL_CONVENTIONS (semilla hand-authored, como CANONICAL_PATTERNS/
  SEED_INVARIANTS — nunca autogenerada; `exclude` opcional por entrada =
  excepciones deliberadas VERIFICADAS documentadas en su propio archivo,
  p.ej. las miniaturas rellenas folderSVG/fileSVG de fm.js en
  `iconos-centralizados` — el lead mecánico las saltea, la capa IA las sigue
  viendo). (b) ANÁLISIS (POST
  /api/health/coherence, admin, CONSUME TOKENS, confirm) → runner desacoplado
  bin/cwc-coherence-runner.js (lock `coherence.lock` con fase, reserva pid:0
  patrón spawnOptimize, resultado persistido en ~/.cwc-data/coherence.json); GET
  /coherence solo lee disco + running/progress (front encuesta cada 4 s). La
  corrida es sonnet READ-ONLY doble capa (regla 6, allowlist Read/Grep/Glob/
  TodoWrite, settingSources: []) que VERIFICA los hallazgos leyendo el código y
  busca MÁS (duplicación, espejos back↔front como labels.js↔engine.js) →
  propuestas {foco, tipo cableado|dedup|fuente-unica|regla-oro|blindaje|espejo|
  convencion, actual, propuesta, riesgo, archivos, pasos}. Propuestas
  PENDIENTES con Aprobar/Descartar (POST /api/health/coherence-proposal {id,
  action}) — NADA se auto-aplica; "Aplicar en chat" abre chat supervisado
  (acceptEdits, reglas estrictas: reusar la fuente canónica, no duplicar) ·
  "Explorar flujo" en modo plan. La sub-ventana (system/coherence-modal.js)
  muestra el grafo/servicios + patrones + convenciones + los hallazgos
  determinísticos (gratis) + las propuestas IA. El auditor tiene PROHIBIDO
  proponer nada que debilite las reglas duras. Igual que el optimizador, las
  REGLAS DURAS van INYECTADAS pre-masticadas en coherencePrompt() vía
  hardRulesText() de health/shared.js (2026-07-06, junto al bloque de
  conventionsText): sin Read de CLAUDE.md entero; fallback a la instrucción
  vieja si la extracción falla.
- **Salud APROVECHA lo rastreado en Pad** (2026-07-12, Gap #4 / TASK-297 de
  ROAD-63): `padContext()` de health/shared.js lee por HTTP (best-effort, 0
  tokens, `core/pad-service-client.js`) los BUGs abiertos + los ROADs en curso
  del Pad LOCAL (workspace `console`) y se inyecta en `optimizePrompt()` y
  `coherencePrompt()` (junto a hardRulesText/conventionsText) — así los dos
  motores analizan SABIENDO qué issues ya están rastreados (no los re-reportan
  como nuevos) y alinean sus propuestas con lo que está en marcha. Los runners
  `cwc-optimize-runner.js`/`cwc-coherence-runner.js` la llaman (fase "leyendo
  contexto de Pad local…"); si el Pad no responde devuelve '' y el análisis
  sigue igual (patrón commsContextFor). CORRECCIÓN CLAVE: esto NO toca el
  blindaje read-only (regla 6) — `pad-service-client` lee por HTTP PLANO (no
  MCP), inyectar el texto en el prompt NO es una tool call. NO se inyecta en
  `unitPrompt` (la auditoría por-unidad) a propósito: unitFingerprint hashea el
  prompt → invalidaría toda la caché incremental (re-audit sonnet caro). La
  **Revisión Exhaustiva** SÍ aprovecha Pad pero SOLO en `synthesisPrompt()` (la
  SÍNTESIS final, 1 corrida, sin fingerprint por-unidad → cero invalidación de
  caché): el veredicto no trata como "nuevo" un hallazgo ya rastreado como BUG
  en Pad, lo referencia por su ref (bin/cwc-health-runner.js hace el fetch
  best-effort antes de la síntesis, TASK-298). El **Dashboard del proyecto**
  suma un tile del backbone de Pad (ver abajo, TASK-300). Así los 4 motores de
  Salud (Revisión · Optimización · Coherencia · Dashboard) quedan enganchados a
  Pad, cada uno según su naturaleza.
- **Pad WRITE-BACK de propuestas aprobadas** (2026-07-19, pedido de Niko: "que
  los motores se hablen entre sí a través de Pad"): cierra el write-back
  inverso que quedaba pendiente arriba. `health/pad-writeback-shared.js`
  (`createTaskFromProposal(p, kind)`) — al APROBAR una propuesta de
  Optimización o Coherencia (`POST /optimize-proposal` · `/coherence-proposal`,
  `action:'accept'`), el endpoint crea la TAREA en la colección `pendientes` de
  Pad (el mismo tablero de Pendientes de Niko; título/detalle/tipo armados
  desde la propuesta, `tags:[kind]`) — best-effort: si Pad no responde, la
  aprobación sigue igual, solo sin `padRef`. El ref vuelve en la respuesta del
  POST y el frontend (`optimize-modal.js`/`coherence-modal.js` `applyProposal`)
  lo inyecta como ÚLTIMO PASO del prompt del chat supervisado: "ejecutá `node
  bin/cwc-health-proposal-done.js <ref>`" — mini-runner determinístico (0
  tokens, patrón `cwc-health-resolve.js`) que hace `getItem`+`updateItem`
  (read-modify-write: `fields` se REEMPLAZA entero en un PATCH) para marcar la
  tarea `status:'hecha'`. Circuito completo: proponer → aprobar (crea la
  tarea) → trabajar en el chat → el chat cierra el ciclo marcándola hecha —
  sin depender de que alguien se acuerde de registrarla a mano (la lección de
  Mejora Continua "cruzar y registrar contra el backlog de Pad" quedó resuelta
  de raíz para este camino). CROSS-CHECK DETERMINÍSTICO en Coherencia (mismo
  pedido, complementa el `padContext()` de texto libre con un match matemático):
  `coherenceCrossCheckText(findings)` (coherence-shared.js) reusa `crossCheckPad`
  (scan-shared.js, el mismo matching por jaccard de términos del Escaneo
  Unificado) sobre los hallazgos determinísticos de `evaluateCoherence()` antes
  de armar el prompt — el runner (`cwc-coherence-runner.js`) concatena su texto
  al `padCtx`. Optimización NO lo suma (sus "propuestas" no son hallazgos con
  área/detalle citable, el cross-check no aplica igual de bien). Alcance
  deliberado: esto es LECTURA de contexto + ESCRITURA de la tarea al aprobar —
  NO es un canal vivo donde los 3 motores se leen entre sí EN LA MISMA corrida
  (eso seguiría siendo una reescritura mayor, no pedida).
- **TÁNDEM opt-in en el auto-fix de Salud** (2026-07-19, mismo pedido de Niko:
  "que usen Tándem, una parte la hace Claude y otra Codex"): hasta hoy Tándem
  (PLAN-507) era EXCLUSIVO del chat interactivo — el único motor de Salud que
  ESCRIBE código sin supervisión (`bin/cwc-healthfix-runner.js`, excepción de
  la regla 6) no lo tenía. Ahora es un TOGGLE opt-in en el modal de Revisión
  Exhaustiva ("🤝 «Automático» usa Tándem", visible solo si hay hallazgos
  auto-resolubles) — el comportamiento POR DEFECTO no cambia. Con el toggle
  activo, `POST /finding-fix` manda `tandem:true` → `spawnFix(id, tandem)`
  agrega `--tandem` al spawn del runner. El runner reusa TAL CUAL
  `createCodexToolServer` de `chat/codex-tool.js` (mismo mcpServer in-process
  `delegate_to_codex` que usa el chat Tándem) y una allowlist NUEVA
  `fixToolAllowedTandem` (health/shared.js): permite
  Read/Grep/Glob/TodoWrite/`mcp__codex__delegate_to_codex` (constante
  `TANDEM_TOOL` de `core/tool-policy.js`, para no duplicar el string) +
  Bash SOLO `node --check` (idéntico a siempre) — **DENIEGA Edit/Write/
  MultiEdit/NotebookEdit**: el único camino de Claude para tocar un archivo es
  delegar en Codex, igual que el bloqueo estructural del chat Tándem
  (`askPermission`/`TANDEM_BLOCKED` de `cwc-chat-runner.js`). Sube
  `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` (una delegación puede durar minutos, el
  SDK corta tools MCP a 60 s por defecto) — mismo ajuste que el chat. El
  `node --check` post-fix se mantiene igual sin importar quién escribió el
  diff (Claude o Codex). Riesgo: como el auto-fix YA corre sin humano mirando
  (excepción documentada de la regla 6), delegar la escritura a Codex NO sube
  el nivel de riesgo — solo cambia QUIÉN escribe el diff; sigue siendo
  revertible con git y el usuario reinicia al revisar. Alcance deliberado:
  SOLO el auto-fix de a UNO (`autoFix`) — el orquestador de batch "Resolver
  seguros" (`cwc-healthfix-orchestrator.js`) queda FUERA (más invasivo, no
  pedido); el toggle se resetea al reabrir el modal (elección puntual, no una
  config global persistida).
- **Revisión EXHAUSTIVA** (`POST /api/health/review`, admin, CONSUME TOKENS):
  barrido MÓDULO POR MÓDULO. La corrida vive en un RUNNER DETACHED
  (bin/cwc-health-runner.js, patrón triage — un reinicio del server a mitad
  NO la mata). discoverUnits() (health/shared.js) arma ~16 unidades: core +
  cada src/modules/* (+ su runner de bin/) + frontend-core + frontend-modules.
  `frontend-core` incluye ahora los `.css` de `public/css/` mediante `listCss`,
  helper hermano de `listJs`: antes NINGÚN CSS entraba en ninguna unidad, por
  lo que el SEED del guard `[hidden]` nunca se inyectaba — era un séptimo
  invariante muerto, esta vez entre los seeds.
  cada una se audita read-only (doble capa, regla 6) con el modelo que dicta
  `auditModelFor(unit)` de health/shared.js — FUENTE ÚNICA, el runner NO
  hardcodea el modelo — buscando bugs Y violaciones de reglas → findings
  {area,severity,kind,detail,file,suggestedFix}. AUDITOR = SONNET (2026-07-04):
  antes era haiku y alucinaba falsos positivos hasta en módulos chicos (race
  conditions en código síncrono, validaciones "ausentes" que ya existían) y era
  inconsistente entre corridas ("cada Completo encontraba más y más"); sonnet da
  resultados estables y con muchos menos FP. `auditModelFor` es el punto único
  para un futuro híbrido/opus (p.ej. sonnet general + opus en unidades grandes).
  unitFingerprint HASHEA el modelo → cambiarlo re-audita todo.
  INCREMENTAL (Fase 2 del sistema nervioso, 2026-07-03): cada
  unidad tiene un fingerprint de contenido (unitFingerprint, misma técnica que
  core/inventory.js); el runner cachea {fingerprint, findings crudos} por unidad
  en ~/.cwc-data/health-audit-cache.json y en la próxima corrida REUSA las
  unidades sin cambios (status 'cached', 0 tokens) — solo re-audita lo que
  cambió. Botón "Analizar cambios" (incremental, default) vs "Completo" (POST
  /review {full:true} → runner con --full, ignora la caché). El auto-fix edita
  código ⇒ cambia el fingerprint ⇒ esa unidad se re-audita fresca ⇒ el hallazgo
  resuelto desaparece solo. PARALELO ADAPTATIVO (Fase 2.5): la fase de ANÁLISIS
  (haiku por unidad, read-only) corre en PARALELO vía health/pool.js
  (runAdaptivePool, genérico/testeable): concurrencia dinámica que RAMPA según
  CPU/RAM libres (os.loadavg/freemem) con back-off ante 429/overload
  (ctl.backoff → baja target + pausa), tope duro = nº de unidades a auditar
  (mín 2, arranque 4). La SÍNTESIS (interpretación) es SERIAL tras la BARRERA
  (depende de todos los findings) y el AUTO-FIX sigue serial (lock) — regla de
  oro: paralelo lo que LEE, serial lo que ESCRIBE. ANTI-COLISIÓN: los agentes
  no editan código y mutan UN solo objeto `state` en memoria (cada uno su
  casillero) + la caché se escribe UNA vez en la barrera → nadie pisa a otro.
  INVARIANTES + FOCO (Fase 4 del sistema nervioso):
  health/invariants.js lista aserciones
  `{match, text, exclude?, origen?}` (seeds + aprendidos de los gotchas
  conocidos: simetría mode/model en chat, validación de rutas, settingSources
  headless sin user, bind ZeroTier, guard [hidden], integridad de secciones en
  projects…). El primer seed, **Blindaje anticonsumo**, contempla la excepción
  nominal del patrocinio sin convertirla en fallback: `core/sponsorship.js` es
  el punto único que valida `tier:'sponsored'`, sponsor admin no patrocinado y
  sin auto-patrocinio, prioriza siempre el token propio y solo lee el
  `oauth-token` dedicado del sponsor, nunca `.credentials.json`. El mismo seed
  sigue exigiendo env por allowlist, HOME/CWC_DATA_DIR aislados y el self-check
  exit 3 incluso con `--sponsored-by`; además matchea `sponsorship.js` para que
  el auditor vigile la excepción donde se define. Queda documentado allí el
  riesgo aceptado por Nico el 2026-08-29 de que Bash lea `/proc/self/environ`:
  no corresponde reponer restricciones a Bash ni `bypassPermissions`.
  La familia nueva **CONTENIDO AJENO SE GATEA POR OVERSIGHT, NUNCA POR ADMIN**
  matchea chat, terminal, `core/auth.js` y `core/users.js`. Exige que listar,
  abrir, adjuntarse o leer chats, adjuntos, paquetes y sesiones tmux de otro
  usuario pase por `oversight`; reserva `admin` para administración, obliga a
  resolver la capacidad en vivo con `oversightFor()` y verifica que todo mensaje
  propague el username de su emisor. Un pase de admin en un gate de contenido,
  cachear `oversight` en la sesión o descartar el autor son regresiones de la
  misma familia (`console:BUG-2831`).
  `match` admite VARIOS globs separados por coma: `compileMatch`
  compila cada uno y los une con `|`; también tolera un comentario entre
  paréntesis y lo descarta. `exclude` enumera rutas relativas EXACTAS donde la
  regla no aplica por diseño, en paridad con el campo homónimo de
  `CANONICAL_PATTERNS` de core/inventory.js. `origen` conserva de qué bug o
  lección nació la regla, pero NO se inyecta al prompt a propósito:
  `unitFingerprint` hashea los textos y sumar metadata al prompt invalidaría
  la caché sin mejorar la auditoría. unitPrompt inyecta SOLO los invariantes
  que matchean los archivos de la unidad, menos sus excludes, y le pide
  verificar CADA uno citando el código — así caza bugs sutiles que el barrido
  genérico pierde. El foco acota el pedido de CLAUDE.md a dos secciones que
  `hardRulesText()` inyecta pre-masticadas con el extractor común
  `markdownH2Section`: `## Reglas duras` Y `## Multi-tenant`. Antes el recorte
  terminaba justo en el encabezado Multi-tenant y el auditor quedaba CIEGO al
  modelo multiusuario: los tres prompts de Salud tenían CERO menciones de
  owner/tenant/user-scoped. El auditor ya NO hace un Read de CLAUDE.md entero
  por unidad; si la extracción falla, conserva el fallback a la instrucción de
  consultar el archivo.
  AVISO DE CACHÉ HISTÓRICO (`console:PLAN-2252`): `unitFingerprint` hashea los textos de
  los invariantes aplicables, las reglas duras inyectadas Y la lista de archivos
  de la unidad. La depuración de aprendidos, la inyección de Multi-tenant y la
  incorporación de CSS cambiaron esos insumos; el Escaneo inmediatamente
  posterior re-auditó TODAS las unidades con sonnet. Fue esperado.
  FACETAS PARA INVARIANTES (`console:PEND-2283`, obligación 5 de
  `console:CONVE-2279`): antes `invariantsFor(unit)` filtraba únicamente por
  regex de ruta; una unidad ubicada fuera de los paths previstos recibía CERO
  exigencias en silencio (fail-open). Ahora un invariante de
  `invariants.js` puede declarar `{match?, facets?, text, ...}` y
  `invariantsForDetailed(unit)` arma la UNIÓN de dos caminos independientes:
  primero agrega los que matchean por path, en el mismo orden histórico, y
  después los que matchean solo por faceta, deduplicados por `text`;
  `invariantsFor(unit)` sigue devolviendo únicamente sus textos. Es EXPAND,
  no reemplazo: el enganche por path permanece como fallback y su resultado
  no cambió para ninguna unidad.
  `facets.js` resuelve la clase de cada unidad —`plano`, `audiencia` y
  `perfil` de CONVE-2279, más `familia` derivada del prefijo del uid— desde
  `facets-snapshot.json`. Si no encuentra facetas conocidas falla CERRADO:
  sintetiza `plano:'usuario'` (con la familia inferida) para darle el trato
  más restrictivo, en vez de dejar la unidad sin exigencias. La foto es JSON
  de datos versionado, con el mismo criterio que `invariants-learned.json`, y
  contiene 209 entradas: 207 nodos de `arquitectura` del Pad + `unit:core` y
  `unit:frontend-core`, declaradas a mano porque esas unidades compuestas no
  tienen nodo propio. El auditor NO consulta Pad en tiempo de auditoría: corre
  dentro de runners con entorno limpio y no puede depender de red.
  `bin/cwc-facets-snapshot.js` abre `~/.pad/pad.db` en modo solo lectura y
  regenera esa foto local. GOTCHA OPERATIVO: después de reclasificar nodos con
  `bin/cwc-pad-facets.js --apply` hay que regenerarla o Salud seguirá viendo
  la clasificación vieja; `node bin/cwc-facets-snapshot.js --check` no escribe
  y sale con código 1 si quedó desactualizada.
  Se engancharon por faceta exactamente TRES invariantes aprendidos de
  aislamiento multi-tenant de `console:PLAN-2252`: estado user-scoped resuelto
  por dueño, listados filtrados por `owner` y spawn con credencial propia.
  Comparten el predicado
  `{plano:['usuario','mixto'], familia:['backend','runner']}`. El cuarto
  invariante con consciencia de dueño —el admin que no puede auto-degradarse—
  NO se engancha por faceta a propósito: describe una superficie concreta, el
  CRUD de usuarios, no una clase arquitectónica.
  CICATRIZ DE CACHÉ MEDIDA ANTES DE ACEPTAR EL CAMBIO:
  `unitFingerprint` hashea los textos aplicables y el orden «path primero,
  faceta después» es parte del contrato. En las 29 unidades, la lista obtenida
  por path quedó BYTE A BYTE idéntica; la ÚNICA que gana invariantes es `core`
  (+3), porque `src/core/*` no matcheaba `src/modules/**`. Por eso el próximo
  Escaneo de Salud re-audita `core` con sonnet y reusa la caché del resto: NO
  es un re-audit masivo.
  LOOP QUE APRENDE (Fase 5 del sistema nervioso, cierre): al resolver un bug de
  una clase que conviene blindar, el auto-fix runner emite una línea
  "PROPOSED-INVARIANT <texto> | <match>" (o NO-INVARIANT); addProposal la guarda
  PENDIENTE en ~/.cwc-data/health-invariant-proposals.json (NUNCA se auto-aplica
  — decisión del usuario). El modal de salud muestra "🧠 Invariantes propuestos"
  con Aprobar/Descartar (GET /invariant-proposals · POST /invariant-proposals/:id
  {approve|reject}, admin). Aprobar → appendLearnedInvariant valida el patrón y
  lo suma a src/modules/health/invariants-learned.json (JSON de DATOS en el
  repo, NO código; se commitea y revisa). Además RECHAZA un patrón que no
  matchee ningún archivo real del repo mediante el helper interno `repoFiles()`,
  con fail-open si el disco no se puede leer. Motivo: `console:BUG-2253` — 6
  invariantes aprendidos estuvieron ~25 días inertes porque su glob con coma o
  paréntesis compilaba como RegExp válido pero no matcheaba nada; la validación
  vieja preguntaba «¿es compilable?» y no «¿encuentra algo?». A diferencia de
  la cicatriz ya documentada del `**`, esta falla era SILENCIOSA. BUG-1977:
  antes comparaba el texto completo contra los 400 caracteres persistidos y
  una entrada larga se duplicaba; ahora normaliza `match`/`text` a 200/400
  ANTES de comparar y guardar, conservando el formato y deduplicando también
  contra entradas históricas. invariants.js mergea SEED_INVARIANTS +
  loadLearned(). Así el bug resuelto no puede regresar sin que salte.
  DEPURACIÓN 2026-07-29 (`console:PLAN-2252`): los aprendidos pasaron de 84 a
  36. Los 84 eran de una consola pre-multiusuario: 83 se aprobaron entre el 3
  y el 5 de julio de 2026 y `core/user-space.js` nació el 19 de julio; ~49
  duplicaban 12 ideas, 6 estaban muertos, 2 repetían un SEED y 1 era una regla
  de lint. Los 36 nuevos enuncian la PROPIEDAD que debe ser cierta —no la
  técnica que la implementa—, muestran cómo se ve la violación y traen
  `origen`. TRES son NUEVOS y cubren el aislamiento multi-tenant: estado
  user-scoped resuelto por dueño, listados filtrados por owner y spawn con
  credencial propia. Medición por escaneo completo: ANTES 974 inyecciones y
  235 KB de prompt; DESPUÉS 470 inyecciones y 190 KB.
  INVARIANTE DE IDENTIDAD 2026-07-29 (`console:PLAN-2337`, C6;
  `console:BUG-2338`): una credencial personal de Infisical, GitHub, Claude,
  Codex o Pad encontrada bajo `~/.cwc-users/<id>/` solo cuenta si su identidad
  pertenece a ese inquilino. Presencia de archivo/token/sesión no alcanza:
  aceptar allí la identidad del host es una regresión de aislamiento y, si la
  identidad no puede verificarse, el detector falla cerrado y reporta la
  capacidad como no cumplida. El seed se inyecta por path en
  `core/user-space.js`, `modules/onboard/**` y `modules/mcps/**`.
  Al final SONNET sintetiza el veredicto (solo procesa los hallazgos, no re-lee
  código). Interfaz por archivos: health-review.json
  (progreso incremental: units[].status, done/total, findings[]) +
  health-review.lock (heartbeat => running). POST responde INMEDIATO
  (arrancar+encuestar); el front encuesta GET /review. UI = SUB-VENTANA
  full-screen (health-review-modal.js, .dlg-card--health): barra de progreso
  + grilla de módulos con estado en vivo + hallazgos por severidad (color).
  La revisión es una FOTO FRESCA: "Volver a analizar" descarta los hallazgos y
  re-investiga (findings sin fixStatus). Cada finding se enriquece en GET
  /review con id/sig (findingId/findingSig, hash de contenido) y `recurrent`
  (coincide por firma con algo resuelto ANTES de esta revisión → volvió).
  DOS caminos de resolución por hallazgo (pedido del usuario 2026-07-03):
  (a) "En chat" (resolveInChat) → chat supervisado acceptEdits en cwd
  'claude-web-console' con el contexto; el prompt le exige FRENAR y pedir
  confirmación en ALTO RIESGO (ahí aparece la tarjeta de permiso). También el
  "Resolver todo en chat" (resolveAll) sobre los sin resolver.
  MARCADO AL CERRAR (pedido del usuario 2026-07-04): el camino "En chat" era
  fire-and-forget — resolvía pero NUNCA marcaba el hallazgo resuelto (la lista
  de "sin resolver" quedaba desactualizada, sin seguimiento en vivo). Ahora el
  prompt le pasa el `id` del hallazgo y le pide, como ÚLTIMO paso tras verificar
  el fix, ejecutar `node bin/cwc-health-resolve.js <id> "<resumen>"` (te pide OK
  al comando, como al editar). Ese RUNNER MINI (bin/cwc-health-resolve.js)
  reusa markFindingResolved() de health/shared.js — punto ÚNICO de "marcar
  resuelto" fuera del auto-fix: setea fixStatus:'resolved' en review.json +
  recordSolved en health-solved.json (determinístico, 0 tokens, no toca código
  ni reinicia). resolveAll inyecta el id de CADA hallazgo y pide marcarlos uno a
  uno. RED DE SEGURIDAD: botón "Marcar resuelto" por hallazgo (data-act
  markresolved → POST /finding-resolve {id}, admin, misma markFindingResolved)
  para dejar la lista al día a mano si el chat no llegó a correr el comando.
  (b) "Automático" (autoFix → POST /finding-fix) → RUNNER DESACOPLADO
  bin/cwc-healthfix-runner.js que edita+verifica (node --check) SIN
  supervisión (excepción de escritura de la regla 6, ver ahí).
  GATE DE POLÍTICA (Fase A del orquestador anti-colisión, 2026-07-04):
  health/policy.js clasifica DETERMINÍSTICAMENTE cada hallazgo por la superficie
  que toca (classifyFinding → risk safe|shared|critical + domain, sin LLM ni
  estado → sobrevive a reinicios). enrichReview lo expone en b.policy. Los
  CRÍTICOS (server/bind, auth, config, tls, sdk-settings, registry, paths,
  backup-push, blindaje read-only headless de health/bugfixes/bugs, runners) NO
  se auto-resuelven: el front deshabilita "Automático" (badge 🔒 crítico + nota
  "hacelo en chat") y POST /finding-fix los RECHAZA (409, guarda REAL de defensa
  en profundidad). 'shared' (registry/tokens.css/ui/shared.js/CLAUDE.md) y 'safe'
  sí. BATCH EN PARALELO (Fase B del orquestador, 2026-07-04): botón "Resolver
  seguros (N)" (N = abiertos no-críticos) → POST /finding-fix-batch {ids} (excluye
  críticos por el gate) → ORQUESTADOR DESACOPLADO bin/cwc-healthfix-orchestrator.js,
  estado en ~/.cwc-data/healthfix-batch.json + lock/heartbeat (REANUDABLE,
  sobrevive al reinicio de la web — regla de oro). Fase 1 (PARALELO, aislado):
  cada fix en su SANDBOX (git worktree que refleja el estado actual, ver
  health/worktree.js: createSandbox/extractPatch) vía el pool adaptativo F2.5 →
  produce un PATCH; colisión imposible al editar. BARRERA. Fase 2 (SERIAL,
  verdad de git): integratePatch aplica cada patch al árbol REAL uno por uno con
  git apply --check (conflicto → NO aplica, se marca) + node --check por
  aplicación (falla → revierte); NUNCA reinicia el servicio. Éxito ⇒ marca el
  finding resolved en review.json (la tarjeta se actualiza sola) + recordSolved.
  El front polea GET /batch (banner de progreso) mientras corre. la tarjeta
  polea review.json y pasa fixStatus fixing→resolved|failed sola. Éxito ⇒
  registro durable health-solved.json (GET /solved): historial + `count` de
  recurrencia. Los resueltos bajan a la sección "✅ Resueltos" y ya NO
  muestran botones; contadores "N · X resueltos · Y resolviendo · Z sin
  resolver". El poll sigue vivo mientras d.running O algún fixStatus==='fixing'.
  COLAPSABLES (móvil, isMobile por matchMedia):
  cada hallazgo es una tarjeta con header (severidad·tipo·área·módulo) siempre
  visible + cuerpo plegable (.hr-collapsed togglea .hr-f-body); módulos y
  resumen en <details.hr-collapsible> — todo colapsado en móvil, abierto en
  desktop. Vista general por defecto, detalle a demanda.
- **GOTCHA de profundidad (haiku→sonnet 2026-07-04):** cuando el auditor era
  HAIKU encontraba bugs reales valiosos (fd leaks, race conditions en flags
  `busy`, stash pop sin verificar merge, límites de tamaño faltantes) PERO (a)
  se quedaba corto en archivos MUY grandes — no detectó la asimetría
  chat/index.js `case 'mode'` sin `onUpdate()` (~900 líneas exceden lo que
  procesa con UNIT_MAX_TURNS) — y (b) alucinaba FALSOS POSITIVOS hasta en
  módulos chicos (race conditions en código síncrono, validaciones "ausentes"
  que ya existían) siendo INCONSISTENTE entre corridas ("cada Completo
  encontraba más y más"). Por eso el auditor pasó a SONNET (auditModelFor):
  estable y con muchos menos FP. Sigue siendo un RASTRILLO amplio, no una
  garantía de cobertura total; el registro de FP (health-dismissed.json) suprime
  los descartados para que no reaparezcan. Si en el futuro sonnet se queda corto
  en las unidades más grandes (frontend-modules ~5k líneas), el siguiente paso
  es opus SOLO en esas (editar auditModelFor) o partir la unidad.
- **🎯 Anillo determinista + sobre cerrado + ledger** (2026-07-26, PLAN-1963 · patrón de `DOC-1925`):
  el flujo queda ordenado en CUATRO anillos: 🟢 reglas determinísticas MEDIDAS
  (`finding-rules.js`: `loadCorpus`/`activeRules`/`classifyFinding`, cableadas
  por `scan-shared.js:crossCheckPad`) · 🔵 normalización/catálogo cerrado
  (`closed-envelope.js:defineCatalog`/`catalogEnum`/`validateField`, una sola
  fuente para prompt+validador) · 🟡 dedup heurístico contra Pad
  (`crossCheckPad`, NUNCA auto-mergea ni descarta: etiqueta `rastreado`/
  `regresion` y deja el link) · 🔴 IA sólo sobre el residuo ambiguo (review,
  síntesis, optimización y coherencia). `finding-rules.js` tiene hoy CERO reglas
  aprobadas: los 13 falsos positivos del corpus salen de UNA única ventana de
  14 minutos del 2026-07-04, así que el support aparente colapsa a UN incidente
  independiente y ninguna candidata alcanza evidencia suficiente; mejor sin
  regla que con una regla débil. Las CUATRO coerciones silenciosas históricas
  (`severity`→medium, `kind`→bug, `tipo`→otro, `riesgo`→medio) pasaron a
  RECHAZO de la unidad afectada, y un `verdict` inválido también se omite:
  cada rechazo queda en `ai-attempts.jsonl` mediante `recordAttempt`, con
  outcome/errorClass cerrados y costo estimado; `index.js:enrichReview` cubre
  una síntesis rechazada con `liveVerdict` determinístico. GOTCHA CRÍTICO:
  los literales enum de los CUATRO prompts se generan con `catalogEnum()` y
  DEBEN quedar BYTE-IDÉNTICOS porque `unitFingerprint` hashea el prompt; cambiar
  un solo espacio invalida la caché incremental y re-audita ~16 unidades con
  sonnet. `latencyMs`/`inputUnits` del ledger quedan en null hasta que los
  runners de `bin/` pasen `ctx`: contrato FORWARD fuera de este bloque.
