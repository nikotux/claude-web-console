# Claude Web Console — guía de modificación para la IA

Consola web personal (Node + Express + ws + node-pty + xterm.js) para trabajar
con Claude Code desde el navegador vía ZeroTier. Corre bajo systemd de usuario
(`claude-web-console.service`). Este archivo es la FUENTE DE VERDAD sobre qué
se puede, qué se debe y qué NO se debe modificar. Leelo entero antes de tocar
código.

## Reglas duras (NUNCA violarlas)

1. **Bind EXCLUSIVO a la IP ZeroTier.** Jamás `0.0.0.0` ni `127.0.0.1` como
   listen del server. La detección vive en `src/core/zerotier.js`.
2. **Resiliencia:** ninguna operación en curso puede quedar atada al ciclo de
   vida del proceso Node. Terminales → tmux (socket `cwc`); vistas TUI de conversaciones
   → tmux oculta (`cwct-`); **todo lo que corre en el tiempo** (motores de chat,
   delegaciones, batches, colas, worktrees) → **RUNNER DESACOPLADO** en `bin/` con
   estado en archivos (`~/.cwc-data`), REANUDABLE (heartbeat/lock + progreso
   incremental) — NUNCA un `setTimeout` o promesa colgada del proceso del server.
   REGLA DE ORO (pedido explícito del usuario 2026-07-04): **TODA implementación
   nueva debe SOBREVIVIR a un reinicio de la interfaz web.** El front se re-engancha
   por polling al estado persistido, no al proceso. La unidad systemd usa
   `KillMode=process` — no lo quites: con el default (control-group) un crash
   del Node mataría el tmux y los runners.
   → Censo vivo de los runners: `~/.cwc-data/inventory.json#runners`.
   → Detalle por runner: `docs/reglas-catalogo.md`.
3. **Todo local:** sin instalaciones npm globales; dependencias solo en
   `package.json` del proyecto.
4. **No tocar archivos fuera del proyecto** salvo los runtime documentados
   abajo (`~/.cwc-*`, unidad systemd instalada, observer). El observer de
   `~/.claude/settings.json` SOLO se toca con `bin/install-observer.js` /
   `bin/uninstall-observer.js`. Excepción análoga: el INTERFONO entre sesiones
   (ver abajo) agrega SUS hooks al mismo `~/.claude/settings.json` +
   instala el comando `~/.claude/commands/btw.md`, SOLO vía
   `bin/install-interfono.js` / `bin/uninstall-interfono.js` (aditivo y
   reversible como el observer: preserva las entradas ajenas, filtra las
   propias por la marca `cwc-bus.js`). Excepción deliberada adicional: el módulo
   `projects` (pestaña "Proyectos" del menú Sistema) lee y ESCRIBE a
   propósito el `CLAUDE.md` y las memorias (`~/.claude/projects/<dir
   codificado>/memory/*.md`) de CADA proyecto de su registro — Tolkien
   (`config.projectDir`, fuera del repo) Y esta misma consola (su propio
   `CLAUDE.md` y `~/.claude/projects/-home-nmosquera-claude-web-console/`,
   fuera del repo aunque sea "sobre" el repo). No es un efecto colateral: es
   el propósito explícito de esa pestaña (editar en vivo el contexto/memoria
   REAL que lee la próxima sesión de Claude Code en cada proyecto). Nombre
   de nota siempre validado contra whitelist estricta antes de tocar disco.
5. **Seguridad de push:** el código DE LA CONSOLA solo se empuja al remote git
   `personal`; URLs que contengan `Mordor-Staffing` están bloqueadas (guard en
   backup). Excepción deliberada: el módulo `bugfixes` empuja branches DE
   TOLKIEN a su propio origin (el PR a revisión es el flujo del repo de la
   empresa) — nunca código de la consola, siempre bajo botón admin con confirm.
   Nunca versionar/pushear `.env`, `users.json`, `sessions.json`, `certs/`.
6. **Corridas headless del SDK son READ-ONLY blindadas por DOS capas:** hook
   `PreToolUse` (deniega ANTES de la evaluación de permisos; inmune a reglas `allow`
   pre-aprobadas en settings) + `canUseTool` como allowlist de lecturas. Nunca cargar
   `settingSources: ['user']` en esas corridas ni quitar ninguna de las dos capas.
   **Deny por defecto.** Las excepciones son NOMINALES y están catalogadas: ninguna
   corrida nueva puede escribir sin sumar su excepción al catálogo, con sus dos capas
   explícitas. La ÚNICA corrida que escribe CÓDIGO es el auto-fix
   (`bin/cwc-healthfix-runner.js`), con allowlist `fixToolAllowed` (Read/Grep/Glob/
   Edit/Write + Bash SOLO `node --check`) y sin reiniciar el servicio jamás.
   → Catálogo de excepciones con su allowlist exacta: `docs/reglas-catalogo.md`.
7. **La carpeta del proyecto es SIEMPRE `/home/nmosquera/claude-web-console`.**
   No moverla ni duplicarla; las sesiones de Claude Code se abren desde acá.
8. **Hoja de ruta siempre completa:** en CADA modificación se actualizan los
   archivos de contexto y estructura de este repo — la FICHA de la carpeta que
   tocaste (`<carpeta>/CLAUDE.md`, ver regla 14), ESTE archivo si cambió una
   regla / convención / el resumen del mapa, y docs/ si aplica. El conjunto
   raíz + fichas tiene que alcanzar para que una IA sin contexto previo sepa qué
   puede, qué debe y qué no debe tocar.
9. **Plan primero, después ejecutar sin frenar:** ANTES de ejecutar,
   presentar el PLAN en formato visual (tabla: cambio/archivos/efecto) para
   decidir juntos — pedido del usuario 2026-07-03; sus preferencias globales
   viven en ~/.claude/CLAUDE.md (visual primero: tablas, íconos, jerarquía).
   Tras su OK, ejecutar DE CORRIDO sin confirmaciones intermedias (ni por
   archivos sensibles). Parar SOLO ante un error crítico (posible pérdida de
   datos o cambio de alcance). Cerrar con resumen visual de lo hecho.
10. **Estándar documental:** antes de generar cualquier documento (informe,
    correo, nota, guía, minuta) o publicar en un canal externo, leer
    `docs/estandar-documental.md` y aplicarlo. Los canales externos y sus
    firmas están registrados en su sección 6; canal no registrado = preguntar
    antes de publicar.
11. **Pad LOCAL como columna vertebral operativa de CUALQUIER trabajo en este
    repo** (pedido explícito de Niko 2026-07-12, cierre del programa de
    autohosteo — ver el gotcha "MCP de Pad" más abajo para el detalle técnico
    completo del cutover). Esto NO es solo "documentar" — es una práctica
    activa que se sigue en TODA sesión que trabaje sobre Mi Consola:
    - **Al arrancar** cualquier trabajo no trivial (bug, feature, tarea,
      refactor), cargar contexto con `pad_set_workspace workspace=console`.
    - **Todo hallazgo/bug real** que se descubra trabajando en la consola
      se registra como item `BUG` en la colección Bugs de Pad.
    - **Trabajo de cierta entidad** (una migración, un módulo nuevo, una
      fase de un proyecto) se modela como `TASK`/`ROAD` en Pad.
    - **Decisiones de arquitectura** (qué opción se eligió y por qué) se
      registran con `pad_item action=decide` — rationale incluido.
    - **Ley 1 · Nada flota:** todo ítem nace con al menos UNA arista hacia su sol (root real).
    - **Ley 2 · `parent` es JERARQUÍA (única) · `implements` es REFERENCIA (muchas).**
    - **Ley 3 · Subniveles:** tantos como tenga el objeto real; no se aplana para simplificar.
    - **Ley 4 · Grupos:** con nodo-grupo REAL, nunca hub sintético en colecciones de data viva.
    - **Ley 5 · Una sola raíz por constelación.**
    - **Ley 6 · Idempotencia:** verificar con `listLinks` antes de crear un link.
    → Detalle, ejemplos y queries: CONVE-1257 del Pad y docs/pad-grafo.md.
12. **Anti-colisión entre mundos — resolución interna PRIMERO, puente por
    plan** (pedido explícito de Niko 2026-07-12). Los dos mundos NUNCA
    colisionan ni se enlazan EN VIVO: 🏠 **INTERNO** = Mi Consola + Pad
    **LOCAL** (workspace `console`, español OK, dueño Niko) · 🌳 **EXTERNO** =
    Tolkien (inglés obligatorio): su **trabajo** se trackea en el Pad **LOCAL**
    (workspace `tolkien`, vía el MCP `pad-console` que la sesión de Tolkien
    ya tiene), mientras que el Pad **CLOUD** (`mcp.getpad.dev`, workspace
    `tolkien`, dueño Chris) es fuente **READ-ONLY de lo que es de Chris** —
    tickets, bugs, su planificación — y **NUNCA** recibe escrituras nuestras de
    maquinaria interna. Los dos Pad siguen sin tocarse: **el cloud se LEE, el
    local se ESCRIBE**.
    TODO trabajo se resuelve PRIMERO y por COMPLETO en el mundo interno. El
    **ÚLTIMO paso** de esa resolución interna es la creación de un **PLAN
    NUEVO** (artefacto entregable) destinado a inyectarse en el mundo
    externo — NUNCA una escritura directa cruzando servidores, NUNCA un sync
    bidireccional, NUNCA un enlace MCP vivo entre los dos Pad. Recién con ese
    **plan-puente** cerrado, la sesión del mundo externo (Tolkien) lo ejecuta.
    Orden ESTRICTO e irreversible: **interno → (plan-puente) → externo** —
    nunca al revés, nunca simultáneo. PROHIBIDO: que un flujo de Consola
    escriba directo al Pad `tolkien`; que una tarea del mundo interno dependa
    EN RUNTIME del externo; que se ejecute en Tolkien algo que no pasó antes
    por la resolución COMPLETA en el interno. Esto formaliza y ENDURECE la
    tabla "dos mundos" de `ROAD-57` y convive con `R1` (gate de push) y `R7`
    (desvío del plan → volver a Chris). Consecuencia de diseño: cualquier
    integración futura tipo "ticket ↔ task" entre los dos Pad NO es un enlace
    vivo — es este handoff secuencial; el único cruce permitido es el
    plan-puente, generado a mano/por sesión, nunca por sincronización
    automática de código. El cliente `src/modules/tickets/pad-client.js` (lee
    el Pad CLOUD de Tolkien) y `src/core/pad-service-client.js` (habla con el
    Pad LOCAL de Consola) son y SIGUEN siendo dos conexiones separadas por
    diseño: ningún código puede unirlas en una operación que escriba a ambos.
    Consecuencia operativa: todo ref de Pad citado en un artefacto que cruza
    mundos va **calificado con su workspace** (`console:BUG-2045`,
    `tolkien:CONVE-3`) — los dos workspaces comparten los siete prefijos y cada
    uno lleva su propio contador, así que un ref pelado puede resolver en
    silencio al ítem del mundo equivocado. Detalle: `CONVE-2056`.
13. **🌗 Limbo — tercer espacio neutral entre mundos** (acuñado por Niko
    2026-07-15; detalle completo en `CONVE-554` del Pad `console`). Para
    proyectos que MAPEAN datos de AMBOS mundos + fuentes futuras (p.ej. el
    dashboard "Seguimientos" de trabajo humano-accionable de Niko, `PLAN-553`)
    existe un TERCER espacio NEUTRAL, "Limbo": no pertenece a ningún mundo
    pero sirve a ambos a la vez.
    - **Ley 1 · Entrada read-only desde ambos mundos:** Limbo lee/importa, jamás muta la fuente.
    - **Ley 2 · Sin escritura de vuelta automática:** no escribe por su cuenta ni sincroniza los Pad.
    - **Ley 3 · Salida SOLO por sesión con instrucciones de viaje:** todo write sale en un paquete-sesión y se ejecuta en el destino con aprobación.
    Existe además la **SESIÓN-LIMBO**: una sesión gobernada con herramientas de ambos mundos.
    → Detalle completo: CONVE-554 del Pad y docs/reglas-catalogo.md.
14. **El Mapa es un ÍNDICE; el detalle vive en la ficha de cada carpeta**
    (2026-07-24, PLAN-1862). Este archivo había llegado a 572k chars — 3,8× el
    límite de 150k de Claude Code — y se cargaba ENTERO en cada sesión, la
    necesitara o no; el 75% era el mapa de módulos. Ahora cada carpeta con
    entidad propia tiene su `CLAUDE.md` (`src/modules/<n>/`, `src/core/`, `bin/`,
    `public/`, `public/js/ui/`, `public/js/modules/`) y Claude Code la carga
    SOLA cuando lee un archivo de ahí — NO al arrancar. Consecuencias:
    (a) al modificar un módulo, el detalle se actualiza en SU ficha, no acá;
    (b) acá solo va el resumen de 2-4 líneas del mapa, que se corrige si deja de
    ser cierto; (c) crear un módulo nuevo incluye crear su ficha;
    (d) PROHIBIDO volver a pegar el detalle de un módulo en este archivo — es
    exactamente lo que lo rompió. Las **Reglas duras**, las **Convenciones** y el
    **Proceso de cambio** se quedan SIEMPRE acá: `hardRulesText()`
    (health/shared.js) y `conventionsText()` (health/coherence-shared.js) las
    recortan POR NOMBRE DE SECCIÓN para inyectarlas en Salud y Coherencia, y
    moverlas las rompería en silencio.

15. **🧭 Ancla del pedido original — nada se entrega sin contraste** (pedido
    explícito de Niko 2026-07-26; convención `CONVE-1957`, contrato verificable
    `CONVE-1958`, origen `PLAN-1956`). Adaptarse durante la resolución es sano,
    pero desde adentro es indistinguible de la DERIVA: se termina resolviendo un
    problema vecino al pedido. Por eso TODO trabajo no trivial —proyecto,
    ticket, PR, bug, refactor— cumple tres cosas:
    (a) **ANCLA al arrancar** — el ítem-raíz de Pad guarda el `## 📌 Pedido
    original (verbatim)` (literal, sin parafrasear), sus `## 🎯 Criterios de
    aceptación` observables (`C1`, `C2`, …) y su `## 🚫 Fuera de alcance`. El
    bloque verbatim **NUNCA se reescribe**: adaptarse se registra como
    **enmienda aprobada** en `## 📝 Enmiendas`, jamás editando el objetivo (si
    el objetivo se edita para que coincida con lo hecho, el contraste no puede
    fallar nunca y deja de servir). Skill: `anclar`.
    (b) **CONTRASTE en fases** — checkpoints `CP-0` (plan armado, antes del GO),
    `CP-N` (cada fase/bloque cerrado) y `CP-Ω` (antes de entregar, obligatorio).
    Veredicto 🟢 alineado · 🟡 deriva recuperable ⇒ corregir y **re-contrastar**
    (iterar hasta converger es lo esperado) · 🔴 cambio de alcance ⇒ **PARAR** y
    pedir enmienda a quien pidió. Tope: 3 🟡 seguidas ⇒ escalar a Niko. Skill:
    `contrastar`.
    (c) **La verificación final incluye el contraste** — un cambio con todos los
    chequeos técnicos en verde y el contraste en 🟡 NO está terminado. Es la
    obligación 11 de `CONVE-1945`, y el check `ancla` de Salud la audita sin
    tokens. Vale en AMBOS mundos: en el externo (Tolkien) el ancla se escribe en
    SU Pad desde una sesión de ESE mundo, nunca desde acá (Regla 12).

16. **🛃 Aduana — cuarto espacio, neutral entre PERSONAS** (acuñada por Niko 2026-07-28; detalle completo en `console:PLAN-2198`). Limbo (Regla 13) es neutral entre MUNDOS: un solo dueño, dos fuentes de datos. **Aduana** es neutral entre **PERSONAS**: varios usuarios de confianza distinta trabajando en la MISMA conversación. El riesgo que gestiona no es la colisión de datos — es la **inyección** (de código y de prompt) y la **escalada de privilegios**: sin suelo neutral, invitar a alguien a un chat propio le daría acceso operativo al mundo del anfitrión a través del agente. Sus SEIS leyes:
    - **Ley 1 · Suelo neutral:** la sala corre en raíz propia (`~/.cwc-aduana/salas/<salaId>`), NUNCA en el `cwd` de un mundo real. La contención se verifica con `path.relative`, jamás con `startsWith` de strings.
    - **Ley 2 · Nada entra sin declararlo:** el contexto entra por adjunto o referencia explícita de quien lo trae; no hay acceso ambiental a los mundos.
    - **Ley 3 · Nada sale sin visado:** lo producido sale como artefacto que el dueño del mundo destino aplica con aprobación — la sala nunca escribe directo en un mundo.

    **Ley 3 bis · El visado también cubre OPERACIONES, no solo artefactos.** La Ley 3 enunciaba el visado para lo PRODUCIDO (un artefacto que el dueño aplica). `console:PLAN-2493` lo extiende a lo que se PIDE HACER: un participante emite una petición estructurada de operación, el dueño ve la orden exacta y decide, y la ejecución corre con la autoridad del aprobador fuera de la sala. La condición que lo hace seguro es que el catálogo de operaciones pedibles sea un **enum cerrado en código** y que los parámetros se elijan de listas generadas por el servidor: una petición que pudiera decir «ejecutá esto» convertiría el visado en el mejor vector de escalada del sistema.

    **Ley 3 ter · El entorno de preview es artefacto de la sala** (2026-10-09, `console:PLAN-3236`). Una sala puede tener un entorno Tolkien efímero (worktree + DB clonada + dev-server) ligado por `salaId`. Ese worktree es un ARTEFACTO de la sala: su IA puede escribirlo (runner con `--extra-dir` confinado a `~/.cwc-data/tolkien-envs/` y Codex con `workdir:'entorno'`) SIN mover el cwd de la sala —moverlo revocaría a los invitados—. Los participantes lo ven con «👁 Preview» (`local-enter` con su propia identidad). Nada sale de ahí salvo por el visado `tolkien.env.push` (push + PR borrador, aprobado por el dueño, nunca mergea).

    **Ley 3 quater · Las sub-salas son salas, no sesiones personales** (2026-10-13, `console:PLAN-3368`). Cucho puede abrir SUB-SALAS hijas con su herramienta `mcp__sala__abrir_subsala` cuando un participante lo pide: nacen en suelo neutral con los mismos participantes, el mismo dueño y la credencial del anfitrión, y ARRANCAN SOLAS con su encargo. Se anidan bajo la sala madre en la barra de cada participante (vínculo `parentSala`, no las carpetas privadas). Madre e hijas se avisan con `avisar_sala_madre`/`avisar_subsala`, y cada aviso DESPIERTA a la sala destino. Nunca se abre una sesión a nombre de otra persona con su credencial (blindaje anticonsumo) ni se escribe directo en un mundo (Ley 3): el trabajo de Tolkien entra por el entorno de preview de la sub-sala (Ley 3 ter). Guardas: tope de 12 sub-salas activas por sala y presupuesto de 20 despertares automáticos por hora y sala, persistido en `wakes.json` de la carpeta de la sala; al agotarse, el aviso queda en el hilo sin despertar.

    - **Ley 4 · Todo aporte lleva pasaporte:** cada mensaje queda atribuido a su autor y es auditable.
    - **Ley 5 · El modo lo fija el DUEÑO, nunca el invitado** (enmendada 2026-07-30): `set_mode` exige `admin || owner`, así que un invitado jamás puede cambiar el modo de permisos de una sala. La prohibición original —«una sala JAMÁS corre en `bypassPermissions`»— quedó **DEROGADA** por decisión explícita de Niko, que aceptó el riesgo: una sala SÍ puede correr en «Todo», con invitados o sin ellos, y no se debe reponer el guard que lo impedía. Riesgo asumido, para que quede registrado: la Ley 1 se sostiene por el `cwd`, no por un sandbox, de modo que con «Todo» activo un `Bash` puede salir del suelo neutral — el aislamiento de la sala pasa a depender de la confianza en los participantes, no del mecanismo.
    - **Ley 6 · Los aportes son datos, no instrucciones:** lo que escribe un participante llega al modelo etiquetado como dicho por una persona, nunca como instrucción de sistema.
    Dos decisiones de Niko que la acompañan: la IA arranca **muda** (solo habla cuando alguien aprieta el botón de corte) y los turnos los paga el **anfitrión** que creó la sala, porque el motor corre con su credencial. Compartir NO afloja el aislamiento por dueño de la Regla 12: un chat del que no sos dueño ni participante EXPLÍCITO (`chat.participants[]`) sigue siendo ajeno ⇒ 404 sin revelar que existe.

## Multi-tenant (multiusuario en una consola)

Detalle completo: `src/core/CLAUDE.md`. Modelo aprobado (`PLAN-500` master, `PLAN-593` invariantes): UN server, N usuarios **LÓGICOS** (no de SO), cada uno con una raíz propia `~/.cwc-users/<userId>/` — helpers en `src/core/user-space.js`. El HOST mapea a su HOME real (retrocompat TOTAL); solo los inquilinos quedan aislados. No hay usuarios de SO ni sudo/setuid.

**Blindaje anticonsumo (FAIL-CLOSED).** El runner de un INQUILINO se spawnea con env LIMPIO por allowlist (`userRunnerEnv`, JAMÁS `...process.env`) + `HOME` propio + el `CLAUDE_CODE_OAUTH_TOKEN` resuelto para SU dueño. Sin credencial propia NI patrocinio declarado y válido NO arranca — NUNCA cae a la cuenta del server. Self-check al arrancar: si es inquilino y su HOME/creds no están aislados, ABORTA antes de `query()`.

El tier **PATROCINADO** (`tier: 'sponsored'` + `sponsor` explícitos en `users.json`) es la ÚNICA excepción nominal: conserva TODO el aislamiento del inquilino y solo cambia la procedencia del token, prestado por un sponsor con credencial propia, no necesariamente admin. Sin sponsor queda `awaiting-sponsor`: existe, pero no consume tokens hasta ser adoptado. La credencial propia siempre gana y la resolución vive exclusivamente en `src/core/sponsorship.js`. Riesgo aceptado por Nico (2026-08-29): con Bash puede leer el token en `/proc/self/environ`; se confía en el patrocinado y no se recortan Bash ni `bypassPermissions`.

**No-cruce por usuario × mundo.** La vieja "confianza plena entre autenticados" del WS queda DEROGADA para todos salvo quien tenga `oversight`, capacidad de ver contenido ajeno cuyo default es `true` solo para el host y el principal por token. `oversight` y `admin` se resuelven en vivo por request con `oversightFor()` / `adminFor()`: cada principal sin esa capacidad ve/adjunta SOLO lo suyo (`list(principal)`, `ownedChat`), y el cwd se clampa con `safeCwd(cwd, owner)` a `userFileRoot(owner)`, JAMÁS al home global. Todo estado user-scoped resuelve su dir con `resolveDataDir()` — PROHIBIDO hardcodear `~/.cwc-data` del host. Una operación de Pad de un inquilino usa SU token y SU workspace (`tenant-<id>`), nunca la credencial del host ni el workspace `console`.

Pad tiene un tercer destino: `comunidad`, pozo común de Mejora Continua (`console:PLAN-2222`), donde se agregan las lecciones de Tolkien de todos los usuarios y la recurrencia se cuenta ENTRE PERSONAS. Cada uno escribe con su token; nada ajeno se auto-aplica.

Las 4 familias están blindadas como invariantes en `src/modules/health/invariants.js` (Blindaje anticonsumo, incluida la excepción nominal de patrocinio · Ownership por usuario · Dato user-scoped nunca global · Pad per-usuario): el auditor de Salud las inyecta a las unidades que matchean y las verifica sí o sí, así un refactor futuro no puede reintroducir el fallback a la cuenta del server. El PTY de `terminal/sessions.js` ya es owner-scoped y fail-closed (BUG-2104).

## NO MODIFICAR (generado o estado de runtime)

**En el repo:** `node_modules/`, `package-lock.json` (solo vía npm) · `certs/` (self-signed autogenerado) · `users.json`, `sessions.json` (auth, perms 600), `recents.json`, `titles.json`, `session-owners.json` (dueño de cada sesión tmux, para la rehidratación multi-tenant) · `.env` (config del usuario — solo el usuario).

**Fuera del repo:** `~/.cwc-data/` (estado de runtime de TODOS los módulos: chats, cachés, jobs de runners, snapshots, locks y logs) · `~/.cwc-backups/` · `~/.cwc-trash/` · `~/.cwc-state/` (observador — OJO: `claude-state.js` PODA todo `.json` de ahí sin `ts` fresco; nunca guardes ahí nada ajeno al observador).

Qué archivo de `~/.cwc-data/` escribe cada módulo, con su formato y su política de poda, está en la ficha de ESE módulo. Dos que conviene tener a mano por ser transversales:
- `chat-session-ids.json` — registro DURABLE append-only de TODOS los sessionIds que alguna vez fueron chat. NUNCA se poda (a diferencia de `chats.json`, que sí). Lo lee `tokens` para no atribuir un chat viejo a "motores headless".
- `usage-history.json` — histórico persistente de consumo por día (hora local de Medellín) × proyecto × modelo; sobrevive a la poda de transcripts del CLI y alimenta las gráficas de Tendencia. Reemplazó al viejo `tokens-reset.json` (si quedó alguno, es inerte).

El detalle histórico completo — archivo por archivo, con formato y política de poda — quedó en `docs/runtime-datos.md`.

## Módulo VIVO `tickets/`

Detalle completo: `src/modules/tickets/CLAUDE.md`.

⚠️ El tablero `bugfixes/board` está ARCHIVADO. El módulo VIVO del ciclo ticket/feature/PR es **`tickets/`** (Bugs v2, "One Front Door"): dashboard determinístico (snapshot Zoho/GitHub cada 60 s, sin IA) con las ventanas de detalle en modal. Su meta-store por ítem — "Contexto adicional" + "Histórico del trabajo" — vive en el **Pad LOCAL** (colección `contexto-de-tickets`), ya no en archivo. Los dos contextos de trabajo editables ('work' = cómo se trabaja un ticket, incluido el gate de push; 'pr' = house style de la descripción del PR) se editan en ⚙ Sistema → Proyectos y se ESPEJAN a `~/tolkien/CLAUDE.local.md`, para que TODA sesión de Tolkien los tenga aunque no venga del botón del tablero.

## Índice enrutador de Pad (auto)
<!-- cwc:pad-index:start -->
> Traé como MÁXIMO 3 entradas por tarea. Si el trigger no se cumplió, NO traigas la entrada. Ante duda, NO.

### Si aplica un contrato explícito
- 🔒 | se crea `public/js/modules/<n>/` | Contrato · Módulo FRONTEND nuevo — 10 obligaciones verificables | pad_item get CONVE-1943 (~2 KB) | manual
- 🔒 | se crea `src/modules/<n>/` | Contrato · Módulo BACKEND nuevo — 9 obligaciones verificables | pad_item get CONVE-1944 (~3 KB) | manual
- 🔒 | se va a cerrar/reportar un cambio en Mi Consola | Contrato · Cerrar CUALQUIER cambio — 10 obligaciones verificables | pad_item get CONVE-1945 (~4 KB) | manual
- 🔒 | se arranca o se cierra CUALQUIER trabajo no trivial (proyecto, ticket, PR, bug, refactor) | Contrato · Anclar y contrastar cualquier trabajo — 8 obligaciones verificables | pad_item get CONVE-1958 (~3 KB) | manual
- 🔒 | vas a crear o modificar una skill | Contrato · Catálogo instalable de skills — clasificación, defaults y aislamiento | pad_item get console:PLAN-2181 (~3 KB) | manual
- 🔒 | se va a citar un ref de Pad en un artefacto que cruza mundos (plan-puente, CLAUDE.local.md de Tolkien, comunicación a Chris) | Convención · Citado de refs con MUNDO explícito (`console:BUG-1`, nunca `BUG-1`) | pad_item get CONVE-2056 (~3 KB) | manual

### Si hace falta el mapa entre subsistemas
- 📎 | vas a cruzar módulos o subsistemas y no sabés dónde vive algo | Mapa completo: 1 raíz, 18 secciones, 66 módulos | pad_item get ARQUI-1258 + sus hijos (~23 KB el árbol completo) | mapa

### Si hace falta descubrir el catálogo vivo
- 📎 | Si hay que descubrir superficie backend sin conocer el módulo | Catálogo de módulos, registro, endpoints y archivos | ~/.cwc-data/inventory.json#modules (~17 KB) | mapa
- 📎 | Si la tarea involucra procesos desacoplados o CLIs | Catálogo de runners y sus archivos | ~/.cwc-data/inventory.json#runners (~6 KB) | mapa
- 📎 | Si hay que descubrir mounts o superficie frontend | Catálogo agregado del frontend | ~/.cwc-data/inventory.json#frontend (~4 KB) | mapa

### Si el path cae en una autoridad transversal
> Las fichas por carpeta se auto-cargan por path; NO hay entrada por módulo a propósito.
- 📎 | vas a CREAR un archivo en una carpeta sin abrir ninguno de los que ya están | La ficha de esa carpeta no se auto-cargó: leela a mano | <carpeta>/CLAUDE.md (7 fichas transversales, 6-40 KB c/u) | manual
- 📎 | vas a tocar un runner de `bin/` o una corrida headless del SDK | Catálogo de las reglas duras: runners, excepciones READ-ONLY y sus allowlists exactas | docs/reglas-catalogo.md (~13 KB) | manual

### Si vas a cerrar trabajo
- 📎 | vas a cerrar una tarea o reportar un cambio | Lecciones de proceso ya destiladas (275 lecciones) | pad_search en la colección `mejora-continua` (~168 KB, NO traer entero) | historia
<!-- cwc:pad-index:end -->

## Mapa del proyecto

> **Cómo leer este mapa (Regla 14).** Acá va SOLO el resumen de cada carpeta. El
> detalle completo vive en el `CLAUDE.md` de esa MISMA carpeta y Claude Code lo
> carga SOLO cuando lee un archivo de ahí — no al arrancar la sesión. Si vas a
> tocar un módulo, su ficha entra en contexto sola apenas abras cualquiera de sus
> archivos; si necesitás el detalle SIN abrir código, leela a mano
> (`Read src/modules/<n>/CLAUDE.md`). Ficha de un módulo backend =
> `src/modules/<n>/CLAUDE.md` siempre — no se repite la ruta en cada fila.

### Estructura

```
src/server.js               bootstrap: ZeroTier wait → HTTPS bind → auth → módulos
src/core/                   config · auth · users · wss · registry · tls · zerotier · tmux ·
                            pool · paths · sdk-settings · tool-policy · claude-model ·
                            claude-state · bus · session-names · inventory · user-space …
                            → ficha: src/core/CLAUDE.md
src/modules/<n>/index.js    módulo backend { name, init(ctx), registerHttp(router, ctx),
                            registerWs(wss, ctx) } → se registra agregándolo al array de
                            src/core/registry.js
bin/                        runners desacoplados + CLIs (regla 2) → ficha: bin/CLAUDE.md
public/                     app, CSS, páginas standalone → ficha: public/CLAUDE.md
public/js/ui/               primitivos compartidos (icons, dialog, markdown, pacman…)
                            → ficha: public/js/ui/CLAUDE.md
public/js/modules/          módulos frontend { name, mount(el, ctx) } montados por
                            [data-module] → ficha: public/js/modules/CLAUDE.md
systemd/claude-web-console.service  unidad (copia instalada en ~/.config/systemd/user/)
docs/                       estandar-documental.md · frontend-modules.md · INSTALL.md · …
```

### Módulos backend

| Módulo | Qué es | Lo que más duele |
|---|---|---|
| `chat/` | conversaciones del SDK; el motor real es `bin/cwc-chat-runner.js` | En **Tándem**, Codex corre desacoplado y admite delegaciones en paralelo sobre archivos disjuntos. `🎾 Pelota: MÍA` hace que el chat siga solo, sin tope. Un runner vivo no toma cambios hasta "Reabrir para cambios". Una sala 🛃 Aduana usa el canal `say` (0 tokens): la IA solo habla cuando alguien aprieta el botón de corte. Cucho abre sub-salas que arrancan solas y se despiertan entre sí con presupuesto (Ley 3 quater). |
| `folders/` | carpetas manuales con las que cada usuario organiza su barra de Sesiones | Es estado privado por usuario: la ruta se resuelve por operación, nunca en una constante de módulo. Borrar una carpeta jamás borra un chat. |
| `terminal/` | sesiones tmux (`cwc-`) + TUI ocultas (`cwct-`) + rehidratación | La propiedad de adjuntado es `attachSpec`, NO `attach` (colisiona con el método). La rama `attach` es owner-scoped con candado estricto y comparte el guard con `tmux` desde `terminal/sessions.js`. |
| `tokens/` | uso local (parsea transcripts jsonl) + límites del plan + Codex CLI | El COSTO es equivalente a precios de API, no gasto real. Todo en hora local de Medellín (`tokens/time.js`). El cache read pesa ×0.1: nunca compares tokens crudos. |
| `tasks/` | Pendientes: tablero privado (PEND / PLAN) | Backend en **Pad LOCAL** (colecciones `pendientes`/`planes`), no file-based. Ojo con el rate limit al pedir links por ítem. |
| `learning/` | 🎓 Aprendizaje: temas de estudio de Niko | Backend en **Pad LOCAL** (`temas-de-aprendizaje`/`rutas-de-aprendizaje`). "Explicame esto" navega el código read-only. |
| `retro/` | Mejora Continua: destila lecciones de proceso al cerrar chats | Lecciones en Pad (`mejora-continua`), consultadas por tarea desde el índice enrutador; el pozo `comunidad` suma recurrencia entre personas sin auto-aplicar aportes ajenos. Incluye "💬 Feedback de Chris". |
| `audio/` | interpreta una transcripción → resumen + tareas propuestas | Nada se auto-aplica: el usuario aprueba cada tarea. |
| `tickets/` | módulo **VIVO** del ciclo ticket/feature/PR (Bugs v2) | Su detalle todavía vive en la sección "Módulo VIVO `tickets/`" de este archivo. Meta-store en Pad LOCAL (`contexto-de-tickets`). |
| `seguimientos/` | dashboard del trabajo humano-accionable (primer habitante de **Limbo**) | Lee siempre del snapshot en disco, nunca de Zoho en vivo. Escribe SOLO al ticket y con aprobación. |
| `interfono/` | panel + canal humano del bus entre sesiones | **Solo LEE** el bus; la mensajería automática la escriben los hooks vía `bin/cwc-bus.js`. |
| `cerebro/` | observabilidad 3D read-only del grafo del Pad LOCAL (`console`) en tiempo real | Expone títulos y actividad del host: exige `oversight` resuelto en vivo, nunca `admin`; `getGraph()`/`getActivity()` no emiten telemetría: el observador no se observa a sí mismo. |
| `news/` | 🆕 Novedades: changelog alegre para los usuarios, que se monta solo en cada push | El redactor es la ÚNICA corrida read-only que LEE código para escribir texto de usuario (Read/Grep/Glob). Publica sin revisión previa: lo que redacte lo ven todos los usuarios. |
| `health/` | chequeos rápidos + revisión IA + auto-fix | Su detalle vive en la sección "Verificación de salud" de este archivo. El auto-fix es la ÚNICA corrida que escribe código sin supervisión. |
| `tolkien/` | git del repo trackeado + entornos efímeros por sesión | "Actualizar" adelanta tu `main` LOCAL aunque estés en una rama feature. Los entornos son worktrees + DB clonada + dev-server systemd. |
| `visado/` | canal de petición-con-visado desde una sala 🛃 Aduana | El catálogo es un enum CERRADO en código: el invitado ELIGE de listas del servidor, nunca escribe. El `gate` de cada op es la referencia importada del endpoint real, no una copia. |
| `projects/` | edita el CLAUDE.md y las memorias REALES de cada proyecto | Excepción deliberada a la regla 4: lo que guardás acá cambia el comportamiento de la próxima sesión. Edición por SECCIONES con guard de hash. |
| `backup/` | tar.gz + commit + push del código | Solo al remote `personal`; URLs con `Mordor-Staffing` bloqueadas. Nunca versionar `.env`, `users.json`, `certs/`. |
| `comms/` | **librerías compartidas** (NO es un módulo registrado) | El dashboard se eliminó en 2026-07-14. Quedan `pr-read-shared` (lector único de PRs), `gateway-shared` (envíos) y el puente de WhatsApp. |
| `updates/` | censo de versiones de terceros + dos caminos de actualización | El botón principal abre una **sesión** con Bash total (no puede ser Tándem: su hook bloquea Bash de escritura); el runner determinístico queda como "Modo automático". Un major NO entra por veredicto IA favorable: solo si Niko lo tilda. `node --check` NO detecta imports rotos: exige prueba de runtime. |
| `mcps/` | censo + estado en vivo de los MCP + el Llavero | Resiliencia POR ÍTEM: un MCP caído no puede bloquear el panel entero. |
| `connections/` | cuentas OAuth por usuario (Microsoft, Zoho) | Zoho NO usa `offline_access`: el refresh token sale de `access_type=offline`, y el grant code se quema en un solo uso. Freshservice usa API key (no OAuth); `getApiCredential` es su puerta única. |
| `onboard/` | alta self-service de usuarios por token de invitación (SP7 multi-tenant) | Su `publicRouter` se monta ANTES del gate de auth: lo único que lo protege es la validación del token + un rate-limit por IP en memoria. Todo endpoint que agregues ahí queda expuesto sin login. |
| `env-vars/` | capa de config de instancia (identidad + cliente) | Nunca guarda secretos: esos viven en `.env` y `~/.claude`. |
| `unifi/` | puente SOLO-LECTURA al UDM Pro | Jamás escribe al router. |
| `skills/` | censo de skills + catálogo instalable por usuario (`catalog`/`host-only`) | `user_owned`: una skill propia homónima nunca se pisa ni se borra. Las sesiones abiertas no ven instalaciones nuevas: los runners cargan sus skills al nacer. |
| `files/` | explorador y gestor de archivos con papelera recuperable | `resolveWithinRoot()` solo confina la ruta como string: hay que confirmar con `realpathSync()` que la ruta REAL siga dentro del root, o un symlink escapa. |
| `stats/` | telemetría del host, servidor y usuarios | El porcentaje de CPU es un delta global compartido: la primera llamada da 0 y `/api/stats` y `health` consumen el mismo `prevCpu`. |
| `tmux/` | observación y control de sesiones tmux existentes | El guard de no-admin es fail-closed: exige socket, prefijo, sesión viva y owner coincidente; lo ajeno o desconocido responde `404`. |
| `admin/` | administración de cuentas y mantenimiento de runners | `r.use(requireAdmin)` debe quedar antes de registrar las rutas: moverlo o montar una ruta fuera de `r` abre la jerarquía de permisos. |
| `sponsorship/` | adopción self-service de perfiles patrocinados | No es admin-gated: cada sponsor decide a quién presta su propia credencial; liberar vuelve a `awaiting-sponsor`, no a `none`. |
| _archivados_ | `bugfixes/` y `bugs/` (el tablero v1 y el triage) | Su código vive en `_archived/src-modules/`; los reemplazó `tickets/`. Sus fichas históricas quedaron junto a ese código. |

## Convenciones (esto es lo que SE DEBE hacer)

- **CENSO VIVO — consultá el inventario ANTES de crear/modificar módulos:**
  `~/.cwc-data/inventory.md` (generado por `core/inventory.js`; `inventory.json`
  es la vista máquina) es el mapa SIEMPRE FRESCO del proyecto: módulos backend
  con su `registry.js:línea` y endpoints, runners de `bin/`, módulos frontend, y
  el VOCABULARIO real (tokens `--cwc-*`, env vars, `VALID_MODELS`,
  `PERMISSION_MODES`). Leelo (Read) para ubicarte y NO reinventar (dónde
  registrar, qué token usar, qué existe). Este CLAUDE.md son las REGLAS/receta;
  el inventario es "qué existe AHORA" — se regenera solo al abrir un chat de la
  consola (o a mano con `node bin/cwc-inventory.js`). Es la Fase 3 del "sistema
  nervioso".
- **Skills compartibles = clasificación explícita:** toda skill agregada a
  `.claude/skills/` declara `cwc-share: catalog|host-only` y `cwc-default:
  true|false`; sin clasificar es `host-only` (fail-closed). Una `catalog` no
  cablea el workspace Pad `console`, rutas del HOME del dueño ni asume que el
  usuario es Niko: la ejecutará otro usuario en su propio espacio.
- **Colores/espaciado:** solo variables de `tokens.css` (o `color-mix` sobre
  ellas). Acento único terracota `--cwc-accent`. Para sombras/velos existen
  `--cwc-shadow-sm/md/lg`, `--cwc-shadow-ink` y `--cwc-scrim`; blanco puro es
  `--cwc-white`; las categorías del Explorador son `--cwc-cat-*`/`--cwc-folder*`.
  En JS (p.ej. el theme de xterm) los tokens se leen con `getComputedStyle`,
  no se duplican los hex.
- **Vendors frontend siempre desde `node_modules`:** las librerías de terceros
  se sirven con `express.static` (patrón vivo: xterm, marked, mermaid y chartjs
  en `src/server.js`), NUNCA copiándolas a `public/vendor/`. Una copia estática
  convierte cada `npm install` en un no-op silencioso para el usuario y el censo
  de Actualizaciones responde "0 pendientes" ocultándolo: en BUG-2816 cuatro
  librerías quedaron drifteadas durante un mes y medio. La única excepción
  admitida es que el paquete npm no publique un bundle de navegador —hoy solo
  `highlight.js`—; debe explicarse en un `README.md` dentro de su carpeta de
  `public/vendor/` y quedar vigilada por el check `vendor-drift` de Salud.
- **Botones/diálogos/popups:** `.btn`/`.btn-ghost` + modificadores; modales con
  `ui/dialog.js` (`openModal/confirmDialog/promptDialog/alertDialog/`
  `textEditorDialog`); menús flotantes con `ui/popup.js`. Nunca
  `alert()/confirm()/prompt()` nativos.
- **Íconos:** `icon(name)` de `ui/icons.js` (SVG de trazo, currentColor);
  agregar íconos nuevos AHÍ, no SVG inline.
- **Ayuda contextual obligatoria en superficie nueva:** todo panel/tablero/
  página nueva nace con su tema en `public/js/modules/<n>/help.js` (contrato
  en `ui/help.js`), su entrada en `ui/help-index.js` y su botón
  `helpBtn('<id>')` como último control del header. Anatomía mínima: qué es ·
  primeros pasos · leyenda de íconos reales · botones y acciones (marcando
  los que consumen tokens) · ojo con esto. Los strings van por `t()` con el
  español inline, como el resto del frontend.
- **"Mi Consola" = nombre CANÓNICO de este proyecto (pedido del usuario
  2026-07-05):** en toda la UI el proyecto se llama "Mi Consola" (nunca
  "claude-web-console" ni "Consola (este proyecto)") con el ícono `console`
  de icons.js (monitor con >_ , espejo del emoji 🖥️ de docs/chats; Tolkien
  sigue con `gitBranch`/🌳). Fuente ÚNICA frontend: `ui/places.js`
  (PLACES/placeFor — mapa rel↔{label, ico, cls}); backend: PROJECTS de
  `src/modules/projects/index.js`. Lo consumen: launcher (atajo fijo
  "Mi Consola" en "Abrir en" con tinte acento `.ln-dest--console` + recientes
  y navegador heredan nombre/ícono), tarjetas de Sesiones (mini-ícono
  `.sess-place` de lugar: acento si es la consola, tenue si es Tolkien; el
  displayName de tmux también usa el label) y la pestaña Proyectos de ⚙
  Sistema. Un lugar nuevo con identidad = una entrada más en PLACES.
- **`[hidden]`:** existe un guard global `[hidden]{display:none!important}` en
  ui.css. Cualquier regla `display` de autor sobre un elemento ocultable debe
  respetarlo (esa fue la causa raíz del bug del menú contextual pegado).
- **Superficie por perfil:** fuente ÚNICA `public/js/ui/profile.js`; ocultar con
  `hidden`, nunca `style.display`. Es recorte de EXPERIENCIA y NO es seguridad:
  ocultar/no montar no autoriza; el gate real sigue en el backend
  (`isAdmin`/ownership).
- **UI con mucho texto = COLAPSABLE + ÁRBOL (pedido del usuario 2026-07-04):**
  todo módulo/menú/panel NUEVO que muestre bloques largos de texto nace
  COLAPSADO: header compacto SIEMPRE visible (qué es + estado en una línea) y
  el cuerpo plegable a demanda (`<details>` nativo o el patrón `.hr-collapsible`
  de salud) — vista general primero, detalle a demanda; en móvil todo plegado,
  y en desktop el default también es nacer plegado — el menú ⚙ Sistema es el
  precedente: TODOS sus paneles nacen cerrados (pedido de Niko 2026-07-31,
  `console:PLAN-2461`); abrir algo por defecto tiene que justificarse caso por
  caso. Y si el contenido tiene
  SUB-ELEMENTOS, se agrupan TIPO ÁRBOL: grupo padre colapsable → hijos
  anidados con indentación/guía vertical (ejemplos vivos: hallazgos de
  health-review-modal, fila-PR del tablero con TKT anidados, sub-ventana de
  Optimización IA con censo agrupado bin//src y propuestas agrupadas por
  motor — clases `.hp-opt-group`/`.hp-opt-card` en style.css como referencia).
  Nunca un chorizo de tarjetas planas con todo el texto expandido.
- **Módulo nuevo backend:** `src/modules/<n>/index.js` con la interfaz estándar
  y sumarlo al array de `registry.js`. Frontend: objeto `{name, mount}` +
  `[data-module="<n>"]` en index.html + registrarlo en main.js. (Mirá el
  inventario `~/.cwc-data/inventory.md` para el estado actual: módulos ya
  registrados, `registry.js:línea`, endpoints existentes.)
- **Strings visibles al usuario en frontend NUEVO ⇒ siempre por `t()` (PLAN
  i18n, 2026-07-19):** `import { t } from '../../ui/i18n.js'` y envolver TODO
  texto que el usuario vaya a leer — `t('modulo.contexto.algo', 'Texto en
  español')`. El español va SIEMPRE como segundo argumento (`fallbackEs`)
  INLINE en el código — nunca en un archivo aparte: es lo que se ve mientras
  Fase 2 no tradujo ese módulo, y evita que el ES del código y el de un
  diccionario se desincronicen. La traducción al inglés (opcional, si el
  módulo ya la tiene) vive en `public/i18n/en/<módulo>.json` — mismo
  namespace que `public/js/modules/<módulo>` (`core` para lo compartido de
  `ui/`) — clave `<módulo>.<contexto>.<algo>`, independiente del texto (para
  que editar el español no rompa la traducción). HTML estático (index.html):
  `data-i18n="key"` (barre `textContent`) / `data-i18n-title="key"` (barre
  `title`), aplicado por `applyI18n(root)` al bootear. Clave faltante o
  módulo sin diccionario ⇒ cae al fallback ES sola, nunca rompe el render.
  Ver el bloque del módulo `system` (pestaña "🌐 Idioma") en el mapa de abajo
  para el detalle completo del mecanismo.
- **Admin-gating:** endpoints sensibles con `isAdmin(req)` de `core/auth.js`
  (patrón en backup/index.js).
- **tmux:** siempre a través de helpers con validación (`core/tmux.js`,
  `tmuxArgs` de sessions.js). Ids de sesión NUNCA texto arbitrario del cliente.
- **Comentarios y commits en español**, estilo del repo (mensajes descriptivos,
  un tema por commit).
- **Ruteo de ejecución Tándem (SIEMPRE que planees+ejecutes):** todo plan de
  ejecución se desglosa en tareas atómicas y CADA una sale con su ruteo
  {ejecutor Claude|Tándem|Codex · modelo · esfuerzo} calculado por la NATURALEZA
  de la tarea — diseño/prompt/contrato → Claude (opus/sonnet, high);
  escribir código → Tándem (sonnet razona/verifica + Codex ejecuta en high);
  cableado trivial → Claude (haiku, low); verificación E2E → Claude
  (sonnet/opus, high). Se persiste en la colección Tasks del Pad `console`
  (campos `model`/`effort`/`executor`), cada TASK colgada de su PLAN padre; al
  presentar el plan se muestra el ahorro (tareas a Codex vs Claude). Objetivo:
  sacar la generación de código de la ventana de Claude. Detalle: `CONVE-558` +
  playbook `rutear` (`PLAYB-559`). Aplica en AMBOS mundos; al externo (Tolkien)
  se inyecta por plan-puente (`PLAN-560`), nunca escritura directa en vivo
  (Regla 12 / Limbo).

## Gotchas conocidos (te van a morder si los ignorás)

- En chat interactivo `canUseTool` NO es una capa de seguridad confiable:
  `permissionMode:'bypassPermissions'` (modo "Todo", default del launcher) y las
  allow-rules del `settings.json` del usuario la shadowean antes de consultar el
  callback. Para gatear tools SIEMPRE usar hook `PreToolUse`; el SDK lo avisa con
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Por eso el bloqueo de Tándem vivió meses
  inerte.
- NO usar `pkill -f src/server.js` (el patrón mata al propio shell). Reiniciar
  SIEMPRE con `systemctl --user restart claude-web-console`.
- NO usar `git checkout -- <archivo>` para limpiar una PRUEBA sobre archivos
  que otras sesiones editan en vivo (CLAUDE.md, código): puede haber cambios
  sin commitear ajenos y el checkout los descarta TODOS (pasó: se perdió una
  edición de una sesión paralela y hubo que recuperarla desde los transcripts
  de ~/.claude/projects — los tool_use Edit guardan old_string/new_string).
  Revertir SIEMPRE deshaciendo el cambio propio (aplicar el inverso), y mirar
  `git status` ANTES de decidir que un archivo está limpio.
- Transcripts jsonl de Claude: el mismo `message.id` aparece en varias líneas —
  dedup por id+firma de contenido (ver `loadTranscriptEvents` y módulo tokens).
- Hooks del observador se capturan al INICIAR claude: sesiones ya abiertas no
  reportan hasta reiniciar claude dentro de ellas.
- El Agent SDK hereda la suscripción del CLI (`~/.claude/.credentials.json`);
  no necesita API key y sus transcripts caen en `~/.claude/projects/`. OJO: un
  runner lee ese archivo (y arma sus MCP) al ARRANCAR — si la credencial OAuth
  cambia/vence después, el runner vivo NO la re-lee y algún MCP (visto con `pad`)
  queda silenciosamente sin cargar. Remedio: **"🔄 Reiniciar sesiones"** (pestaña
  Backup del menú ⚙ Sistema, admin) → `POST /api/admin/restart-runners` manda
  SIGTERM a cada `bin/cwc-chat-runner.js` vivo (enumerados con `pgrep -f
  'cwc-chat-runner\.js'`, nunca toca `src/server.js` ni el servicio systemd) y
  responde `{ killed, pids }`. Al morir el runner, el server detecta el socket
  cerrado (`RunnerLink.onClose` → `Chat._engineDown`) y lo RE-LANZA con
  `--resume` en la próxima interacción: 0 historial perdido, credenciales frescas.
- Tools MCP DIFERIDAS y allowlists headless (visto 2026-07-05): el SDK puede
  diferir los schemas de las tools MCP y el modelo necesita la META-tool
  `ToolSearch` para cargarlos antes de invocarlas — solo devuelve schemas, NO
  ejecuta nada (la ejecución real sigue pasando por las dos capas de la regla
  6). Una allowlist que deniega `ToolSearch` puede dejar al modelo CIEGO de
  todo el MCP (el triage moría con "herramienta no permitida" en el listado).
  `toolAllowed` de bugs/shared.js ya lo permite; si otro runner con MCP
  (desk-runner, p.ej.) empieza a fallar igual, revisar su allowlist.
- Tras un reboot, repetir `systemctl --user import-environment SSH_AUTH_SOCK`
  para que el git de Tolkien funcione desde el server.
- `admin` acumulaba dos poderes distintos: administrar la instancia y ver todo
  su contenido. El pase por `admin` en `participantChat` era también el gate del
  WebSocket, por lo que un admin podía escribir en el chat privado de otro; peor,
  la rama `user` era la única del handler que no propagaba el emisor (mientras
  `say`/`react`/`cut` sí) y el mensaje llegaba SIN autor, como si fuera del dueño.
  Ahora el contenido ajeno se gatea con `oversight` (`console:BUG-2831`).
- `playwright-core` es devDependency del proyecto (`npm install --save-dev`,
  reutiliza el Chromium ya en `~/.cache/ms-playwright`) para la verificación
  de UI descrita en "Proceso de cambio" — no lo instales global, ya está acá.

## Proceso de cambio (seguirlo SIEMPRE)

1. Editar el código respetando esta guía.
2. `node --check` sobre cada archivo tocado.
3. `systemctl --user restart claude-web-console` y mirar
   `journalctl --user -u claude-web-console -n 20 --no-pager`.
4. Verificar en caliente: la API con `curl -sk -H "x-cwc-token: $(grep '^CWC_TOKEN=' .env | cut -d= -f2)" https://<ip-zt>:8092/api/...`;
   la UI con Chromium headless de Playwright (`~/.cache/ms-playwright`,
   `playwright-core` — login por fetch /login con token, ignoreHTTPSErrors).
   `chromium.launch()` a secas puede fallar si el build pedido por
   `playwright-core` no coincide con el descargado en el cache; en ese caso no
   saltear la verificación: pasar `executablePath` apuntando al disponible (a
   2026-08-27, `~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`).
   Ver `console:BUG-2818`.
   La IP ZeroTier sale de `journalctl` o `ip -o addr show | grep zt`.
5. Chequear la salud: `GET /api/health/checks` debe quedar todo `ok` (la
   pestaña Salud del menú ⚙ Sistema muestra lo mismo).
6. Commit (en español). Si el cambio es de arquitectura, actualizar este
   CLAUDE.md.

## Verificación de salud

Detalle completo: `src/modules/health/CLAUDE.md` (se carga solo al tocar el módulo).

- **Chequeos rápidos** (`GET /api/health/checks`, 0 tokens): systemd + `KillMode=process`, tmux del socket `cwc`, runners de chat, observador, credencial OAuth del host (`claude-cred`), TLS, git, sintaxis de todo `src/` y `bin/`, disco, datos de runtime, espejo de contexto a Tolkien, backbone de Pad, facetas (una unidad sin clase declarada o código de `src/` fuera del radar salta acá), cruces entre mundos (`cross-world`) y leyes del grafo de Pad (`pad-grafo`).
- **Escaneo de Salud unificado** (UN botón, CONSUME TOKENS): corre Revisión + Optimización + Coherencia bajo un pool adaptativo compartido, en el orquestador desacoplado `bin/cwc-health-scan-runner.js`. Incremental por fingerprint de contenido; el modo `full` ignora las cachés. Cruza cada hallazgo contra los BUGs de Pad (🆕 nuevo · 🔗 rastreado · ⚠️ regresión).
- **Auto-fix** (`bin/cwc-healthfix-runner.js`): la ÚNICA corrida que escribe código sin supervisión — excepción documentada de la regla 6. Allowlist `fixToolAllowed` (Read/Grep/Glob/Edit/Write + Bash SOLO `node --check`); NUNCA reinicia el servicio. Los hallazgos CRÍTICOS (server/bind, auth, config, TLS, registry, blindaje read-only headless, runners) NO se auto-resuelven: el gate los rechaza en el BACKEND, no solo en la UI.
- Nada se auto-aplica: propuestas de Optimización/Coherencia e invariantes aprendidos requieren aprobación humana explícita.

## Mejora Continua

Las lecciones de proceso destiladas viven en el Pad local (colección `mejora-continua`)
y se consultan **por tarea** desde el índice enrutador de arriba — ya no se copian acá.
El módulo Mejora Continua sigue funcionando igual: promovés desde la interfaz y la
lección se guarda en Pad.
