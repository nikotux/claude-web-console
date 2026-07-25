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
   vida del proceso Node. Terminales → tmux (socket `cwc`); vistas TUI de
   conversaciones → tmux oculta (`cwct-`); motores de chat → runner desacoplado
   (`bin/cwc-chat-runner.js`); delegaciones Tándem a Codex → runner desacoplado
   (`bin/cwc-codex-runner.js`); triage de bugs → runner desacoplado
   (`bin/cwc-triage-runner.js`); revisión exhaustiva de salud → runner
   desacoplado (`bin/cwc-health-runner.js`); auto-fix de un hallazgo →
   runner desacoplado (`bin/cwc-healthfix-runner.js`); batch de resolución en
   paralelo → orquestador desacoplado (`bin/cwc-healthfix-orchestrator.js`);
   consulta EN VIVO de un ticket en Zoho Desk → runner desacoplado
   (`bin/cwc-desk-runner.js`); ANÁLISIS GENERAL IA del tablero de Pendientes
   (duplicados/unificables/completar info, por tareas o planes) → runner
   desacoplado (`bin/cwc-tasks-analyze-runner.js`); investigación a fondo de un
   PR → runner desacoplado (`bin/cwc-investigate-runner.js`); investigación de CONTEXTO de un
   ticket SIN PR (lee el código de Tolkien read-only para explicar por qué NO se
   resolvió) → runner desacoplado (`bin/cwc-ticket-investigate-runner.js`);
   optimización IA de los motores (censo + análisis con propuestas) → runner
   desacoplado (`bin/cwc-optimize-runner.js`); INTERFONO entre sesiones
   (mensajería + claims anti-conflicto: `bin/cwc-bus.js` invocado por los hooks
   de Claude Code, estado 100% en archivos en `~/.cwc-data/session-bus/` —
   NADA en el proceso del server, sobrevive reinicios por construcción; el
   módulo backend `interfono` LEE ese disco para el panel y además ofrece el
   canal HUMANO de escritura acotada — POST /send (mensaje manual) y
   /claim-release (liberar un claim), ambos vía `bus.sendMessage`/`bus.releaseFile`
   de `core/bus.js`, nunca estado en el proceso; la mensajería/claims
   AUTOMÁTICOS los generan los hooks vía `bin/cwc-bus.js`, no este módulo). La unidad systemd usa
   `KillMode=process` — no lo quites: con el default (control-group) un crash
   del Node mataría el tmux y los runners.
   REGLA DE ORO (pedido explícito del usuario 2026-07-04): **TODA
   implementación nueva debe SOBREVIVIR a un reinicio de la interfaz web**
   (deploys/`systemctl restart` pasan seguido). Si algo corre en el tiempo
   (resolución, orquestador de fixes en paralelo, batches, worktrees, colas)
   va en un RUNNER DESACOPLADO con estado en archivos (`~/.cwc-data`),
   REANUDABLE (heartbeat/lock + progreso incremental, como health/triage) —
   NUNCA en un `setTimeout`/promesa colgada del proceso del server. El front
   se re-engancha por polling al estado persistido, no al proceso.
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
6. **Corridas headless del SDK (tickets, salud) son READ-ONLY blindadas por
   DOS capas:** hook `PreToolUse` (deniega ANTES de la evaluación de permisos;
   inmune a reglas `allow` pre-aprobadas en settings) + `canUseTool` como
   allowlist de lecturas. Nunca cargar `settingSources: ['user']` en esas
   corridas ni quitar ninguna de las dos capas. EXCEPCIÓN QUIRÚRGICA
   deliberada (pedido del usuario 2026-07-03): `deskUpdateAuto` de
   `bugfixes/index.js` — tras el PRIMER envío exitoso de un PR, una corrida
   headless actualiza el ticket en Zoho Desk (On Hold + nota corta en
   inglés). Mantiene las DOS capas pero como allowlist de SOLO las tools
   `desk_*` del MCP (regex `^mcp__..__desk_`); Bash/Edit/Write/git y todo lo
   demás siguen denegados. Las ITERACIONES del PR (feedback) JAMÁS tocan
   Desk automáticamente: van por el chat "Actualizar ticket" del tablero,
   donde el usuario aprueba la escritura en la tarjeta de permiso.
   SUB-EXCEPCIÓN de LECTURA (pedido del usuario 2026-07-03; DESACOPLADA a
   runner 2026-07-04): la consulta EN VIVO del estado + comentarios ACTUALES de
   un ticket (para ver si la actualización ya quedó) corre en un RUNNER
   DESACOPLADO — `bin/cwc-desk-runner.js`, lógica compartida en
   `bugfixes/desk-shared.js`. Antes corría INLINE dentro del request HTTP
   (`deskLive` de `bugfixes/index.js`): al cambiar de pestaña en el navegador
   (sobre todo móvil) el fetch en background se abortaba y la corrida —que
   consume tokens— se perdía a mitad; un reinicio del server la mataba igual
   (bug reportado por el usuario). Ahora: POST /api/bugfixes/desk-refresh
   {tickets:[...]} lanza el runner detached (dedup por lock `desk.lock`) y
   responde INMEDIATO; el resultado se PERSISTE en
   `~/.cwc-data/desk-live/<ticket>.json`; GET /api/bugfixes/desk-live/:n SOLO
   LEE ese disco (no consume tokens) + informa si la corrida sigue viva; el
   front encuesta (patrón triage/health). Es MÁS blindada que la de escritura:
   allowlist `deskReadAllowed` de tools `desk_*` que (a) NO contienen verbo de
   escritura (add/update/reply/…) Y (b) SÍ uno de lectura (get/list/search/
   view/…) — deny por defecto, en las DOS capas; la allowlist DEBE quedar
   idéntica en el runner (seguridad). Consume tokens: el front la dispara BAJO
   BOTÓN ("Traer estado de Desk" por fila · "🎫 Desk" bulk), nunca al expandir;
   sin fresh reusa el resultado < 60 s (no relanza), ?fresh fuerza. El tablero
   PAUSA su auto-refresh de GitHub mientras hay un panel de detalle abierto o
   una consulta Desk encuestándose (`canAutoRefresh`): el re-render total
   destruiría el panel — ESA era la raíz del bug del cambio de pestaña.
   INVESTIGACIÓN a fondo de un PR (pedido del usuario 2026-07-04, DESACOPLADA):
   `bin/cwc-investigate-runner.js` (lógica en `bugfixes/investigate-shared.js`)
   responde "¿la pelota la tenés vos o Chris, y qué hacer?". Es la corrida IA
   MÁS blindada de todas: junta los datos con `gh` EN NODE (determinístico) y la
   corrida del modelo es PURA LECTURA DE TEXTO — NO usa NINGUNA herramienta ni
   MCP (`investigateToolAllowed` devuelve siempre false; las DOS capas deniegan
   TODO). POST /investigate {pr,ticket} lanza el runner (dedup lock
   `investigate.lock`), responde YA; resultado en
   `~/.cwc-data/investigations/<pr>.json`; GET /investigation/:pr solo lee disco.
   El semáforo (¿de quién es la pelota?) se calcula GRATIS en el front desde
   prLive; la lectura profunda (veredicto {accion, bloqueante, severidad, pasos,
   titular}) es el botón que consume tokens. Sus `pasos` se inyectan en
   "Trabajar en esto".
   INVESTIGACIÓN de CONTEXTO de un ticket SIN PR (pedido del usuario 2026-07-04,
   DESACOPLADA): `bin/cwc-ticket-investigate-runner.js` (lógica en
   `bugfixes/ticket-investigate-shared.js`) responde "¿POR QUÉ este ticket sigue
   sin resolverse?". A DIFERENCIA de la de PR (que NO usa herramientas), ésta SÍ
   necesita LEER el código: un ticket sin PR no tiene diff. Corre read-only con la
   MISMA allowlist que el auditor de Salud — `ticketInvToolAllowed` = SOLO
   Read/Grep/Glob/TodoWrite; Bash/Edit/Write/git/MCP DENEGADO en las DOS capas —
   `cwd = Tolkien` (config.projectDir), sonnet, maxTurns 16, timeout 5 min,
   `settingSources: []` (sin user/project: cero MCP ni permisos pre-aprobados).
   NUNCA escribe. POST /ticket-investigate {ticket,problem} escribe el enunciado a
   `~/.cwc-data/ticket-investigations/<n>.req.json` (así sobrevive al reinicio),
   lanza el runner (dedup lock `ticket-investigate.lock`) y responde YA; resultado
   en `~/.cwc-data/ticket-investigations/<n>.json`; GET /ticket-investigation/:n
   solo lee disco (0 tokens). Veredicto {porQueNoResuelto, causaRaiz, archivos,
   complejidad, pasos, riesgo, confianza, titular, necesitaMasInfo}; sus `pasos` se
   inyectan en "Trabajar en esto"/"Trabajar en Chat (plan)".
   EXCEPCIÓN de ESCRITURA sobre CÓDIGO (pedido del usuario 2026-07-03):
   `bin/cwc-healthfix-runner.js` resuelve AUTÓNOMAMENTE un hallazgo de la
   revisión — edita el código de la consola sin supervisión. Es la única
   corrida que escribe código. Blindada por las DOS capas con `fixToolAllowed`
   (health/shared.js): allow Read/Grep/Glob/Edit/Write/MultiEdit + Bash SOLO
   si el comando matchea `node --check`/`node -c` (verificación de sintaxis);
   git, rm, systemctl, npm, curl, kill y todo lo demás DENEGADO. NUNCA
   reinicia el servicio (un fix malo queda en el working tree, revertible con
   git; el usuario reinicia al revisar). Admin-only, uno a la vez (lock
   `healthfix.lock`), bloqueado si hay una revisión corriendo. Éxito ⇒ marca
   el hallazgo resolved en review.json + lo registra en health-solved.json.
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
      refactor), cargar contexto con `pad_set_workspace workspace=console` o
      `pad_meta action=bootstrap workspace=console` (server MCP `pad` = el
      LOCAL, `pad-cloud-backup` es solo respaldo pasivo, NUNCA operativo) —
      trae de un solo golpe conventions/roles/playbooks/dashboard/actividad
      reciente. Consultar `pad_project action=dashboard`/`next` antes de
      arrancar algo grande, para ver qué ya está en curso y no duplicar.
    - **Todo hallazgo/bug real** que se descubra trabajando en la consola
      (no solo los del programa de modularización, CUALQUIERA futuro) se
      registra como item `BUG` en la colección Bugs de Pad — no solo como
      comentario suelto en el chat que se pierde al cerrar la sesión.
    - **Trabajo de cierta entidad** (una migración, un módulo nuevo, una
      fase de un proyecto) se modela como `TASK`/`ROAD` en Pad, no solo en
      la cabeza de la sesión — así la PRÓXIMA sesión (sin memoria de ésta)
      puede retomar con `pad_project next`/`dashboard` en vez de releer
      transcripts.
    - **Decisiones de arquitectura** (qué opción se eligió y por qué) se
      registran con `pad_item action=decide` — rationale incluido — para que
      quede auditable sin tener que reconstruir la conversación.
    - **Los Playbooks activos son PROCEDIMIENTOS INVOCABLES, no solo texto
      de referencia:** `module-scan` (escanear+consolidar un módulo, el loop
      del programa de modularización), `codex-verify` (revisión
      independiente con Codex) y `rutear` (ruteo Claude/Tándem/Codex de un
      plan, CONVE-558) se re-usan tal cual para CUALQUIER trabajo futuro que
      calce con su propósito — no reinventar el procedimiento a mano cada vez
      que aplica. Los tres (2026-07-19), junto con `agrupar`/`orquestar`/`pad`
      del Orquestador Interno, viven ADEMÁS como **skills de Claude Code**
      (`.claude/skills/<nombre>/SKILL.md` en este repo) — el mismo
      procedimiento pero auto-descubrible por descripción/gatillo sin tener
      que invocar `pad_playbook run` a mano. Pad sigue siendo la FUENTE DE
      VERDAD (`PLAYB-<n>`): un cambio al procedimiento se edita ahí primero y
      se resincroniza a mano al `SKILL.md` (cada archivo lo referencia en su
      pie). Candidatos a sumar: playbooks activos con `invocation_slug` que
      aún no tengan su `SKILL.md` — ver la lista completa con
      `pad_playbook action=list workspace=console`.
    - **Las Conventions de Pad son la MISMA fuente de reglas duras que este
      CLAUDE.md** (los 7 gotchas top del programa quedaron ahí, sincronizados
      en espíritu — no textualmente idénticos palabra por palabra). Si una
      convención de Pad y este archivo alguna vez divergen, este CLAUDE.md
      manda (es la fuente de verdad del repo, regla del encabezado); avisar
      y corregir la de Pad para que vuelvan a coincidir.
    - **Alcance explícito, NO expandir sin OK:** esto es SOLO sobre cómo
      TRACKEAMOS el trabajo (tracker activo en vez de pasivo). Migrar los
      MÓDULOS PROPIOS de Consola (`tasks`/`learning`, hoy file-based en
      `~/.cwc-data`) para que su funcionalidad real dependa de Pad es un
      proyecto APARTE, de mayor riesgo (reescribir módulos que hoy
      funcionan) — documentado como pendiente futuro en
      `docs/evaluacion-rol-pad.md`, NO iniciado, requiere su propio OK
      explícito cuando se decida abordarlo.
    - **Todo ítem de Pad nace ENLAZADO y en su NIVEL correcto** (endurecido
      2026-07-25 tras auditoría estructural del grafo). Seis leyes; fuente de
      verdad en Pad `CONVE-1257`, detalle largo con ejemplos y queries en
      `docs/pad-grafo.md`:
      1. **Nada flota:** todo ítem nace con al menos UNA arista hacia su "sol"
         (root real — un PLAN es sol de sus tareas, una RUTA de sus temas, una
         RED/el UDM Pro de la infra, `ARQUI-1258 «🖥️ Mi Consola»` de toda la
         arquitectura del código).
      2. **`parent` es JERARQUÍA (única) · `implements` es REFERENCIA (muchas).**
         `parent` expresa "es parte de" y forma el ÁRBOL que dibuja el visor de
         grafo; `implements` expresa "se relaciona con / realiza" y cruza
         constelaciones. Usar `implements` para lo que es jerarquía deja al ítem
         CON arista pero dibujado flotando al costado, porque no anida — fue
         exactamente el bug de 36 nodos del 2026-07-25 (incluidos los 7 buckets
         `MC · *`, sol de 240 lecciones).
      3. **Subniveles: tantos como tenga el objeto real.** `Mi Consola → sección
         → módulo → archivo → endpoint` son 4 niveles legítimos; NO se aplana
         para "simplificar". Un nodo conceptual grueso puede convivir con el
         nodo fino que lo realiza: el fino cuelga del módulo y marca el lineaje
         con `supersedes` hacia el grueso.
      4. **Grupos con nodo-grupo REAL, nunca hub sintético.** Hermanos de la
         misma naturaleza se agrupan bajo un nodo que existe de verdad en el
         árbol (las 16 secciones de `arquitectura`, los 7 buckets `MC · *`).
         PROHIBIDO crear ítems-hub SINTÉTICOS en colecciones que son data viva
         de módulos (`pendientes`/`planes`, `temas-de-aprendizaje`/
         `rutas-de-aprendizaje`, `mejora-continua`, `contexto-de-tickets`):
         aparecen como tarjetas fantasma y los módulos las parsean como dato
         real. Ahí se usa SOLO el root real que ya existe (el PLAN/RUTA) o
         cross-links.
      5. **Una sola raíz por constelación.** `arquitectura` tiene exactamente
         una (`ARQUI-1258`); si aparecen más raíces es síntoma de la ley 2 o de
         un ítem creado sin sol.
      6. **Idempotencia:** verificar con `listLinks` que el link no exista antes
         de crearlo — los escaneos y reprocesos re-corren.
      **Islas legítimas:** un PLAN de trabajo humano no-código (rediseño de
      oficina, un expediente, el onboarding de una persona) puede ser un sol
      autónomo desconectado del árbol de arquitectura; eso NO es defecto —
      forzarle un `implements` a un módulo sería un link falso. **Verificación
      (0 tokens):** query read-only sobre `~/.pad/pad.db` — ítems con grado 0
      debe dar 0, y `arquitectura` debe tener 1 raíz. Ver `PLAN-1255`,
      `CONVE-1257` y `BUG-1878` (causa de código que regeneraba huérfanos).
12. **Anti-colisión entre mundos — resolución interna PRIMERO, puente por
    plan** (pedido explícito de Niko 2026-07-12). Los dos mundos NUNCA
    colisionan ni se enlazan EN VIVO: 🏠 **INTERNO** = Mi Consola + Pad
    **LOCAL** (workspace `console`, español OK, dueño Niko) · 🌳 **EXTERNO** =
    Tolkien + Pad **CLOUD** (workspace `tolkien`, inglés obligatorio, dueño
    Chris). TODO trabajo se resuelve PRIMERO y por COMPLETO en el mundo
    interno. El **ÚLTIMO paso** de esa resolución interna es la creación de un
    **PLAN NUEVO** (artefacto entregable) destinado a inyectarse en el mundo
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
13. **🌗 Limbo — tercer espacio neutral entre mundos** (acuñado por Niko
    2026-07-15; detalle completo en `CONVE-554` del Pad `console`). Para
    proyectos que MAPEAN datos de AMBOS mundos + fuentes futuras (p.ej. el
    dashboard "Seguimientos" de trabajo humano-accionable de Niko, `PLAN-553`)
    existe un TERCER espacio NEUTRAL, "Limbo": no pertenece a ningún mundo
    pero sirve a ambos a la vez. NO afloja la Regla 12 — la REFUERZA: un mundo
    nunca toca al otro; ambos PROYECTAN sombras read-only hacia Limbo, y Limbo
    nunca alcanza de vuelta salvo encarnado en una sesión. Sus 3 leyes: (1)
    **entrada read-only desde ambos mundos** — Limbo lee/importa, jamás muta la
    fuente; (2) **sin escritura de vuelta automática** — Limbo nunca escribe a
    un mundo por su cuenta, ni sincroniza los dos Pad, ni dispara acciones
    externas; (3) **salida SOLO por sesión con instrucciones de viaje** — toda
    escritura/actualización a un mundo sale encarnada en un paquete-sesión que
    lleva su manifiesto de handoff/plan-puente, ejecutado en el destino CON
    aprobación. Limbo se HOSPEDA físicamente en la infra de Consola
    (`~/.cwc-data/…`) pero su data NO es "de la consola" en propiedad — es
    sombra agregada de ambos mundos; la consola es anfitrión, no dueño. El
    dashboard es la VENTANA a Limbo, no Limbo mismo. Formaliza y nombra el
    patrón ya disperso (`tickets/desk-mcp-client.js` + `pad-client.js`
    proyectando read-only; handoff de paquetes-sesión llevando travel
    instructions). EVOLUCIÓN — **SESIÓN-LIMBO** (2026-07-16, PLAN-553): además
    del staging de datos, existe la SESIÓN-LIMBO: una sesión GOBERNADA con
    herramientas de AMBOS mundos. Reglas: (1) LEE las fuentes de ambos mundos
    (Desk/correo/Teams del externo vía MCP Tolkien; WhatsApp del interno vía
    Read del archivo indexado `~/.cwc-data/comms/whatsapp.json`); (2) ESCRIBE
    SOLO al sistema de tickets (Desk: create/update/comment) y SIEMPRE con
    aprobación del humano; (3) NUNCA sincroniza los dos Pad ni escribe fuera del
    ticket; (4) efímera, propósito = triangular las fuentes → actualizar el
    ticket (columna vertebral). La lanzan los botones "Actualizaciones" y
    "Trabajar seleccionados" del dashboard Seguimientos (cwd = Tolkien, que ya
    trae Desk+correo+Teams+write). Reconcilia con la Regla 12: leer multi-fuente
    es la Ley 1 (read-only); escribir solo a tickets con OK es un write acotado
    a UN destino con aprobación (Ley 3), sin sync de Pads → no es un puente
    bidireccional vivo. Detalle en `CONVE-554`.
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

## Multi-tenant (multiusuario en una consola)

Detalle completo: `src/core/CLAUDE.md`. Modelo aprobado (`PLAN-500` master, `PLAN-593` invariantes): UN server, N usuarios **LÓGICOS** (no de SO), cada uno con una raíz propia `~/.cwc-users/<userId>/` — helpers en `src/core/user-space.js`. El HOST mapea a su HOME real (retrocompat TOTAL); solo los inquilinos quedan aislados. No hay usuarios de SO ni sudo/setuid.

**Blindaje anticonsumo (FAIL-CLOSED).** El runner de un INQUILINO se spawnea con env LIMPIO por allowlist (`userRunnerEnv`, JAMÁS `...process.env`) + `HOME` propio + el `CLAUDE_CODE_OAUTH_TOKEN` de SU dueño. Sin credencial propia NO arranca — NUNCA cae a la cuenta del server. Self-check al arrancar: si es inquilino y su HOME/creds no están aislados, ABORTA antes de `query()`.

**No-cruce por usuario × mundo.** La vieja "confianza plena entre autenticados" del WS queda DEROGADA para no-admins: cada usuario ve/adjunta SOLO lo suyo (`list(principal)`, `ownedChat`), y el cwd se clampa con `safeCwd(cwd, owner)` a `userFileRoot(owner)`, JAMÁS al home global. Todo estado user-scoped resuelve su dir con `resolveDataDir()` — PROHIBIDO hardcodear `~/.cwc-data` del host. Una operación de Pad de un inquilino usa SU token y SU workspace (`tenant-<id>`), nunca la credencial del host ni el workspace `console`.

Las 4 familias están blindadas como invariantes en `src/modules/health/invariants.js` (Blindaje anticonsumo · Ownership por usuario · Dato user-scoped nunca global · Pad per-usuario): el auditor de Salud las inyecta a las unidades que matchean y las verifica sí o sí, así un refactor futuro no puede reintroducir el fallback a la cuenta del server. OJO: `terminal/sessions.js` todavía NO es owner-scoped — su entrada es un contrato FORWARD.

## NO MODIFICAR (generado o estado de runtime)

**En el repo:** `node_modules/`, `package-lock.json` (solo vía npm) · `certs/` (self-signed autogenerado) · `users.json`, `sessions.json` (auth, perms 600), `recents.json`, `titles.json` · `.env` (config del usuario — solo el usuario).

**Fuera del repo:** `~/.cwc-data/` (estado de runtime de TODOS los módulos: chats, cachés, jobs de runners, snapshots, locks y logs) · `~/.cwc-backups/` · `~/.cwc-trash/` · `~/.cwc-state/` (observador — OJO: `claude-state.js` PODA todo `.json` de ahí sin `ts` fresco; nunca guardes ahí nada ajeno al observador).

Qué archivo de `~/.cwc-data/` escribe cada módulo, con su formato y su política de poda, está en la ficha de ESE módulo. Dos que conviene tener a mano por ser transversales:
- `chat-session-ids.json` — registro DURABLE append-only de TODOS los sessionIds que alguna vez fueron chat. NUNCA se poda (a diferencia de `chats.json`, que sí). Lo lee `tokens` para no atribuir un chat viejo a "motores headless".
- `usage-history.json` — histórico persistente de consumo por día (hora local de Medellín) × proyecto × modelo; sobrevive a la poda de transcripts del CLI y alimenta las gráficas de Tendencia. Reemplazó al viejo `tokens-reset.json` (si quedó alguno, es inerte).

El detalle histórico completo — archivo por archivo, con formato y política de poda — quedó en `docs/runtime-datos.md`.

## Módulo VIVO `tickets/`

Detalle completo: `src/modules/tickets/CLAUDE.md`.

⚠️ El tablero `bugfixes/board` está ARCHIVADO. El módulo VIVO del ciclo ticket/feature/PR es **`tickets/`** (Bugs v2, "One Front Door"): dashboard determinístico (snapshot Zoho/GitHub cada 60 s, sin IA) con las ventanas de detalle en modal. Su meta-store por ítem — "Contexto adicional" + "Histórico del trabajo" — vive en el **Pad LOCAL** (colección `contexto-de-tickets`), ya no en archivo. Los dos contextos de trabajo editables ('work' = cómo se trabaja un ticket, incluido el gate de push; 'pr' = house style de la descripción del PR) se editan en ⚙ Sistema → Proyectos y se ESPEJAN a `~/tolkien/CLAUDE.local.md`, para que TODA sesión de Tolkien los tenga aunque no venga del botón del tablero.

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
| `chat/` | conversaciones del SDK; el motor real es `bin/cwc-chat-runner.js` | En **Tándem**, Codex corre desacoplado y admite delegaciones en paralelo sobre archivos disjuntos. `🎾 Pelota: MÍA` hace que el chat siga solo, sin tope. Un runner vivo no toma cambios hasta "Reabrir para cambios". |
| `terminal/` | sesiones tmux (`cwc-`) + TUI ocultas (`cwct-`) + rehidratación | La propiedad de adjuntado es `attachSpec`, NO `attach` (colisiona con el método). Aún NO es owner-scoped (contrato forward del multi-tenant). |
| `tokens/` | uso local (parsea transcripts jsonl) + límites del plan + Codex CLI | El COSTO es equivalente a precios de API, no gasto real. Todo en hora local de Medellín (`tokens/time.js`). El cache read pesa ×0.1: nunca compares tokens crudos. |
| `tasks/` | Pendientes: tablero privado (PEND / PLAN) | Backend en **Pad LOCAL** (colecciones `pendientes`/`planes`), no file-based. Ojo con el rate limit al pedir links por ítem. |
| `learning/` | 🎓 Aprendizaje: temas de estudio de Niko | Backend en **Pad LOCAL** (`temas-de-aprendizaje`/`rutas-de-aprendizaje`). "Explicame esto" navega el código read-only. |
| `retro/` | Mejora Continua: destila lecciones de proceso al cerrar chats | **Escribe la sección gestionada de ESTE archivo** entre sus marcadores de inicio/fin. Lecciones en Pad (`mejora-continua`). Incluye "💬 Feedback de Chris". |
| `audio/` | interpreta una transcripción → resumen + tareas propuestas | Nada se auto-aplica: el usuario aprueba cada tarea. |
| `tickets/` | módulo **VIVO** del ciclo ticket/feature/PR (Bugs v2) | Su detalle todavía vive en la sección "Módulo VIVO `tickets/`" de este archivo. Meta-store en Pad LOCAL (`contexto-de-tickets`). |
| `seguimientos/` | dashboard del trabajo humano-accionable (primer habitante de **Limbo**) | Lee siempre del snapshot en disco, nunca de Zoho en vivo. Escribe SOLO al ticket y con aprobación. |
| `interfono/` | panel + canal humano del bus entre sesiones | **Solo LEE** el bus; la mensajería automática la escriben los hooks vía `bin/cwc-bus.js`. |
| `health/` | chequeos rápidos + revisión IA + auto-fix | Su detalle vive en la sección "Verificación de salud" de este archivo. El auto-fix es la ÚNICA corrida que escribe código sin supervisión. |
| `tolkien/` | git del repo trackeado + entornos efímeros por sesión | "Actualizar" adelanta tu `main` LOCAL aunque estés en una rama feature. Los entornos son worktrees + DB clonada + dev-server systemd. |
| `projects/` | edita el CLAUDE.md y las memorias REALES de cada proyecto | Excepción deliberada a la regla 4: lo que guardás acá cambia el comportamiento de la próxima sesión. Edición por SECCIONES con guard de hash. |
| `backup/` | tar.gz + commit + push del código | Solo al remote `personal`; URLs con `Mordor-Staffing` bloqueadas. Nunca versionar `.env`, `users.json`, `certs/`. |
| `comms/` | **librerías compartidas** (NO es un módulo registrado) | El dashboard se eliminó en 2026-07-14. Quedan `pr-read-shared` (lector único de PRs), `gateway-shared` (envíos) y el puente de WhatsApp. |
| `updates/` | censo de versiones de terceros + actualización orquestada | Un major NUNCA entra sin veredicto IA favorable. `node --check` NO detecta imports rotos: exige prueba de runtime. |
| `mcps/` | censo + estado en vivo de los MCP + el Llavero | Resiliencia POR ÍTEM: un MCP caído no puede bloquear el panel entero. |
| `connections/` | cuentas OAuth por usuario (Microsoft, Zoho) | Zoho NO usa `offline_access`: el refresh token sale de `access_type=offline`, y el grant code se quema en un solo uso. |
| `onboard/` | alta self-service de usuarios por token de invitación (SP7 multi-tenant) | Su `publicRouter` se monta ANTES del gate de auth: lo único que lo protege es la validación del token + un rate-limit por IP en memoria. Todo endpoint que agregues ahí queda expuesto sin login. |
| `env-vars/` | capa de config de instancia (identidad + cliente) | Nunca guarda secretos: esos viven en `.env` y `~/.claude`. |
| `unifi/` | puente SOLO-LECTURA al UDM Pro | Jamás escribe al router. |
| `skills/` | censo read-only de skills, cruzado con los playbooks de Pad | Solo lectura a propósito. |
| `files/` `stats/` `tmux/` `admin/` | explorador, métricas del server, sesiones tmux, tareas de admin | Sin ficha propia: nunca tuvieron detalle en el mapa. |
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
- **Colores/espaciado:** solo variables de `tokens.css` (o `color-mix` sobre
  ellas). Acento único terracota `--cwc-accent`. Para sombras/velos existen
  `--cwc-shadow-sm/md/lg`, `--cwc-shadow-ink` y `--cwc-scrim`; blanco puro es
  `--cwc-white`; las categorías del Explorador son `--cwc-cat-*`/`--cwc-folder*`.
  En JS (p.ej. el theme de xterm) los tokens se leen con `getComputedStyle`,
  no se duplican los hex.
- **Botones/diálogos/popups:** `.btn`/`.btn-ghost` + modificadores; modales con
  `ui/dialog.js` (`openModal/confirmDialog/promptDialog/alertDialog/`
  `textEditorDialog`); menús flotantes con `ui/popup.js`. Nunca
  `alert()/confirm()/prompt()` nativos.
- **Íconos:** `icon(name)` de `ui/icons.js` (SVG de trazo, currentColor);
  agregar íconos nuevos AHÍ, no SVG inline.
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
- **UI con mucho texto = COLAPSABLE + ÁRBOL (pedido del usuario 2026-07-04):**
  todo módulo/menú/panel NUEVO que muestre bloques largos de texto nace
  COLAPSADO: header compacto SIEMPRE visible (qué es + estado en una línea) y
  el cuerpo plegable a demanda (`<details>` nativo o el patrón `.hr-collapsible`
  de salud) — vista general primero, detalle a demanda; en móvil todo plegado,
  en desktop puede nacer abierto lo esencial. Y si el contenido tiene
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
- Modelo de confianza WS: entre usuarios AUTENTICADOS hay confianza plena
  (cualquiera puede adjuntarse a la sesión/chat de otro; no hay ownership por
  usuario). Supuesto ACEPTADO mientras todos los usuarios sean del dueño;
  revisarlo antes de dar acceso a usuarios de menor confianza.
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
   La IP ZeroTier sale de `journalctl` o `ip -o addr show | grep zt`.
5. Chequear la salud: `GET /api/health/checks` debe quedar todo `ok` (la
   pestaña Salud del menú ⚙ Sistema muestra lo mismo).
6. Commit (en español). Si el cambio es de arquitectura, actualizar este
   CLAUDE.md.

## Verificación de salud

Detalle completo: `src/modules/health/CLAUDE.md` (se carga solo al tocar el módulo).

- **Chequeos rápidos** (`GET /api/health/checks`, 0 tokens): systemd + `KillMode=process`, tmux del socket `cwc`, runners de chat, observador, TLS, git, sintaxis de todo `src/` y `bin/`, disco, datos de runtime, espejo de contexto a Tolkien, backbone de Pad y cruces entre mundos (`cross-world`).
- **Escaneo de Salud unificado** (UN botón, CONSUME TOKENS): corre Revisión + Optimización + Coherencia bajo un pool adaptativo compartido, en el orquestador desacoplado `bin/cwc-health-scan-runner.js`. Incremental por fingerprint de contenido; el modo `full` ignora las cachés. Cruza cada hallazgo contra los BUGs de Pad (🆕 nuevo · 🔗 rastreado · ⚠️ regresión).
- **Auto-fix** (`bin/cwc-healthfix-runner.js`): la ÚNICA corrida que escribe código sin supervisión — excepción documentada de la regla 6. Allowlist `fixToolAllowed` (Read/Grep/Glob/Edit/Write + Bash SOLO `node --check`); NUNCA reinicia el servicio. Los hallazgos CRÍTICOS (server/bind, auth, config, TLS, registry, blindaje read-only headless, runners) NO se auto-resuelven: el gate los rechaza en el BACKEND, no solo en la UI.
- Nada se auto-aplica: propuestas de Optimización/Coherencia e invariantes aprendidos requieren aprobación humana explícita.

<!-- cwc:mejora-continua:start -->
## Mejora Continua (auto)
<!-- Gestionado por el módulo Mejora Continua de Mi Consola (ROAD-256). NO editar a mano DENTRO de los marcadores: se regenera al promover. Lo de AFUERA (Reglas duras, Convenciones, etc.) queda intacto. -->

### Tras delegar un cambio de código a Codex, verificar sintaxis y alcance del diff por cuenta propia
_procedimiento · confianza media · recurrencia x7_

**Observación:** Después de delegar los 4 cambios de CSS/JS a Codex, el agente corrió `node --check` sobre el JS, contó el balance de llaves del CSS y confirmó que el diff tocara solo los 2 archivos planeados, ignorando 20 archivos ajenos que Codex reportó en el árbol.

**Lección:** Cuando se delega implementación de código a una herramienta externa (Codex u otro agente), no cerrar la tarea solo con el reporte de éxito de esa herramienta: correr una verificación propia mínima (chequeo de sintaxis, balance de estructuras, diff acotado a los archivos del plan) antes de reportarle al usuario que quedó listo.

### Al tocar un módulo, verificar que tenga entrada en el mapa de CLAUDE.md y agregarla si falta
_procedimiento · confianza media · recurrencia x2_

**Observación:** El módulo seguimientos no figuraba en el mapa de módulos de CLAUDE.md; la sesión lo detectó como hueco previo y lo agregó junto con el cambio del calendario.

**Lección:** Antes de cerrar trabajo sobre un módulo, chequear que tenga entrada en el mapa de módulos de CLAUDE.md; si no existe, agregarla como parte del mismo cambio en vez de dejarla pendiente.

### Verificar los scopes de una conexión OAuth existente antes de reusarla para un nuevo dominio de API
_procedimiento · confianza media · recurrencia x1_

**Observación:** El plan para que la consola escriba en Zoho People vía un MCP propio asumía poder reusar la conexión OAuth de ⚙ Sistema → Conexiones, pero al inspeccionar el código (src/core/connections-zoho.js) se encontró que esa conexión solo tenía scopes de Desk.*, sin nada de People — el hallazgo llegó recién al revisar el código de la conexión, no antes de proponer el plan.

**Lección:** Antes de diseñar una integración que reutiliza una conexión OAuth ya existente, verificar explícitamente qué scopes tiene otorgados hoy (no asumir que cubre el nuevo dominio); si faltan, incluir la re-autorización como paso explícito y temprano del plan, no como detalle de implementación.

### Ante Write bloqueado por Modo Tándem, no reintentar: mostrar el plan inline
_procedimiento · confianza baja · recurrencia x1_

**Observación:** El intento de persistir el plan de reproducción en un archivo fue bloqueado por el hook de Modo Tándem ('Sigo sin poder escribir el archivo de plan'); la sesión resolvió mostrando el contenido completo en el chat sin insistir con el Write.

**Lección:** Cuando el hook de Modo Tándem bloquee un Write pensado para persistir un plan, no reintentar el mismo Write: presentar el contenido completo en el chat de inmediato y, si hace falta persistencia real, usar Pad en su lugar.

### Verificar el alcance real de una propuesta de auditoría automatizada antes de ejecutar su plan literal
_metodologia · confianza media · recurrencia x1_

**Observación:** Opt#2 citaba '8 runners' migrables y Coh#2 citaba '6 ghCallers, todos falsos positivos', pero al investigar antes de delegar se descubrió que solo 6 runners eran migrables de verdad (uno capturaba session_id y se hubiera roto) y que de los 6 ghCallers solo 1 era un falso positivo real vigente (los otros 5 ya estaban exentos).

**Lección:** Antes de ejecutar el plan literal de un hallazgo o propuesta generado por un auditor/censo automatizado, re-derivar el alcance real (qué ítems aplican y cuáles no) leyendo el código actual, en vez de asumir que los números y la lista citados siguen vigentes.

### Registrar falsos positivos confirmados en el mecanismo de exclusión del auditor, no solo descartarlos en el chat
_procedimiento · confianza alta · recurrencia x1_

**Observación:** Al confirmar que keyring-shared.js y luego updates/shared.js eran falsos positivos del censo de coherencia, se los agregó al `exclude`/lista de exención de inventory.js con motivo documentado, en vez de dejar la conclusión solo anotada en la respuesta.

**Lección:** Cuando se verifica que un hallazgo de un motor de diagnóstico automatizado (censo, auditor de salud) es falso positivo, codificar la exclusión con motivo en el propio motor, para que corridas futuras no vuelvan a gastar turnos re-verificando lo mismo.

### Correr smoke test de imports antes de reiniciar el server, no solo node --check
_procedimiento · confianza alta · recurrencia x1_

**Observación:** Antes de reiniciar el server con sesiones paralelas (UniFi/Arquitectura) con código a medias, se validó sintaxis con node --check en todo src/ y bin/, pero como esa herramienta no detecta imports o variables rotas, se agregó un smoke test cargando el registry backend completo en un proceso aparte antes de confiar en el reinicio.

**Lección:** Al validar código ajeno de sesiones paralelas antes de reiniciar el server, complementar siempre node --check con un smoke test real de imports (cargar el módulo/registry principal en un proceso aparte) para descartar un crash-loop que la sintaxis sola no revela.

### Verificar que el entregable de una delegación a Codex sea código de repo, no un documento
_metodologia · confianza alta · recurrencia x1_

**Observación:** El caso Princeton mostró 89 delegaciones a Codex para producir un expediente y sus traducciones, que vivían en la carpeta del chat (fuera del repo escribible por el sandbox); resultó en 18 bloqueos 'read-only file system' que Claude tuvo que resolver a mano, gastando su propia ventana en vez de ahorrarla.

**Lección:** Antes de delegar una tarea a Codex, chequear si el entregable final es código dentro del repo (sí delegar) o un documento/traducción/informe que vive fuera del repo (resolverlo directo con Claude según el ruteo Tándem, o decirle explícitamente a Codex que escriba en el repo para moverlo después).

### La herramienta de adjuntar no sobrescribe: verificar nombre de copia antes de dar el entregable por final
_procedimiento · confianza media · recurrencia x1_

**Observación:** Al regenerar el PDF con emojis reales y adjuntarlo con el mismo nombre, la herramienta no reemplazó el archivo viejo sino que creó una copia con sufijo '(1)', dejando dos PDFs en la carpeta y el bueno con nombre confuso; además el archivo viejo no se pudo borrar porque el guardián de Modo Tándem bloquea 'rm'.

**Lección:** Tras re-adjuntar un archivo regenerado con el mismo nombre, verificar si la herramienta creó una copia en vez de sobrescribir, y si es así, aclarar explícitamente al usuario cuál de los archivos es el vigente (y que el viejo debe borrarlo él mismo si el guardián de Tándem impide hacerlo por Bash).

### Registrar que el guardián de Modo Tándem bloquea comandos de sistema (apt, rm) también fuera del repo
_nota · confianza media · recurrencia x1_

**Observación:** El hook de Modo Tándem impidió tanto 'apt-get install' (incluso con override de sandbox) como 'rm' de un archivo en la carpeta del chat, pese a no tocar el repo de código — quedó claro que el guardián cubre cualquier escritura al sistema, no solo al árbol de git.

**Lección:** Dar por hecho desde el inicio que instalaciones de paquetes o borrados de archivo requieren que el usuario los ejecute manualmente (proveer el comando exacto), en vez de intentar rutas de override que el guardián va a rechazar de todas formas.

### Antes de reiniciar el server, verificar flujos de autenticación en curso en memoria
_procedimiento · confianza media · recurrencia x1_

**Observación:** Una sesión paralela reinició el servicio justo mientras el usuario completaba el device code de Microsoft; el estado del intento vive solo en memoria, así que la aprobación del usuario se perdió sin ningún aviso y quedó registrado como BUG-929.

**Lección:** Antes de reiniciar el servicio (propio o coordinado con sesiones paralelas), chequear si hay flujos OAuth/device-code u otro estado efímero en memoria pendiente de cualquier sesión; si el usuario está a mitad de un flujo así, avisarle o esperar en vez de reiniciar a ciegas.

### Leer metadata de un formato de terceros hasta el delimitador, no con buffer de tamaño fijo
_procedimiento · confianza alta · recurrencia x1_

**Observación:** readCodexCwd() leía solo los primeros 4096 bytes de la primera línea del rollout de Codex para sacar el cwd; una versión nueva de Codex (0.142.4) alargó esa línea a 22KB con base_instructions completo, el JSON truncado falló al parsear, y todo el caudal por sesión de Codex quedó vacío (con el null cacheado para siempre).

**Lección:** Al parsear metadata de un formato externo o de terceros que puede cambiar de tamaño sin aviso, leer en chunks hasta el delimitador real (con un tope de seguridad) en vez de asumir que cabe en un buffer fijo; y no cachear un resultado null cuando la causa fue una falla transitoria de lectura/parseo.

### Verificar si una notificación de fin de tarea de fondo llega al proceso en vivo o solo queda en el transcript
_procedimiento · confianza alta · recurrencia x1_

**Observación:** Se asumió que el evento de cierre de un trabajo de fondo llegaría al stream del runner; en la prueba real se vio que el SDK lo escribe en el transcript pero lo encola hasta el próximo turno, dejando el trabajo 'vivo' y reteniendo el motor despierto sin necesidad.

**Lección:** Al diseñar un cierre automático basado en un evento asíncrono del SDK, no asumir que ese evento llega al proceso mientras está ocioso: verificar explícitamente si hace falta sondear el transcript/disco en su lugar antes de confiar en que 'la notificación despierta la lógica'.

### Mantener siempre visible un control atado a estado transitorio, aunque esté en cero
_convencion · confianza alta · recurrencia x1_

**Observación:** El chevron de trabajos de fondo se implementó para aparecer solo cuando había algo corriendo; con 0 sesiones activas en ese momento, el usuario no veía ningún cambio y creyó que el deploy había fallado — el mismo error de diseño ('control indescubrible') que ya se había corregido antes en el widget de actividad.

**Lección:** Todo indicador/control cuya existencia depende de un estado transitorio (tareas en curso, notificaciones, etc.) debe estar siempre visible, atenuado/deshabilitado en el estado vacío — nunca condicionado a que haya datos. Aplicar esta regla de entrada a cada componente nuevo del mismo patrón, no solo al primero.

### Verificar código en disco antes de confiar en el status de una tarea en Pad
_procedimiento · confianza alta · recurrencia x1_

**Observación:** La sesión encontró tareas de SP7 marcadas 'todo' en Pad que ya estaban completamente implementadas en disco (y otras 'doing' también listas) — el tracking de Pad iba con lag respecto al código real, para bien y para mal.

**Lección:** Antes de dar una tarea por pendiente o por hecha basándose solo en su status de Pad, leer los archivos reales involucrados y correr una verificación mínima (node --check, grep de la lógica clave) para confirmar el estado real, y recién ahí ajustar el status en Pad con una nota de auditoría.

### node --check no detecta imports nombrados rotos; sumar smoke test de imports
_procedimiento · confianza alta · recurrencia x1_

**Observación:** Tras verificar cada módulo nuevo con `node --check` (según manda el CLAUDE.md del repo), la sesión notó que ese chequeo solo valida sintaxis y no ejecuta el módulo, por lo que un named import roto pasaría desapercibido; corrió un smoke test de imports aparte antes de cerrar.

**Lección:** Cuando el CLAUDE.md exige `node --check` por archivo tocado, completarlo SIEMPRE con un smoke test que importe/ejecute los módulos nuevos o modificados (require/import real), porque `node --check` solo detecta errores de sintaxis, no de resolución de imports.

### Documentar como 'contrato forward' un invariante que el código aún no cumple, en vez de omitirlo
_metodologia · confianza media · recurrencia x1_

**Observación:** El invariante de ownership matchea terminal/sessions.js aunque ese archivo todavía no filtra por owner; en vez de excluirlo o fingir cumplimiento, se documentó explícitamente en el código y en CLAUDE.md como contrato pendiente ('forward').

**Lección:** Al escribir un invariante/contrato de seguridad sobre un módulo que todavía no lo cumple, no omitirlo ni asumir que ya cumple: declararlo explícitamente como pendiente ('contrato forward') en el propio artefacto y en la documentación, para que quede trazable el gap real.

### Usar costo equivalente (no tokens crudos) en toda métrica derivada de uso
_convencion · confianza alta · recurrencia x1_

**Observación:** Al calcular el ratio de ritmo histórico de la barra de Sesión se usó primero tokens crudos y dio 2.7×, pero no cuadraba con el 25% real que reporta Anthropic; la causa era que el 95% de los tokens crudos eran cache reads (10× más baratos). Se corrigió a costo equivalente, el mismo criterio que ya usa el resto de la app, y el ratio bajó a 2.1×, coherente con el dato oficial.

**Lección:** En el módulo tokens, toda métrica nueva derivada de consumo debe construirse con costo equivalente (que ya pesa cache reads a ~10%), nunca con tokens crudos — y validarse contra el % oficial del proveedor antes de darla por cerrada.

### Al sumar categoría nueva a un store en Pad, actualizar también el schema de la colección
_procedimiento · confianza alta · recurrencia x1_

**Observación:** La ingesta de feedback-cliente falló con 500 porque el schema de la colección Pad 'mejora-continua' no tenía habilitada la categoría nueva, aunque el código del módulo ya la aceptaba y guardaba sin avisar del desfase.

**Lección:** Cuando se agrega un valor de enum/categoría nuevo a un módulo respaldado por una colección de Pad, incluir en el mismo cambio la actualización del schema de esa colección en Pad, no solo el enum en el código local — verificar ambos lados antes de dar la ingesta por lista.

### Avisar que pestañas ya abiertas no toman cambios de JS de browser hasta recargar
_convencion · confianza alta · recurrencia x1_

**Observación:** Al cerrar el fix de lazy-connect, se aclaró explícitamente que las conversaciones ya abiertas en una pestaña del navegador seguían con el código viejo hasta recargar la página.

**Lección:** Todo cierre de un cambio en JS servido al browser (main.js, chat-tab.js, etc.) debe incluir la aclaración de que las pestañas/sesiones de navegador ya abiertas no toman el cambio hasta un reload, para que el usuario no crea que el fix falló al no verlo reflejado en su sesión actual.

### Scripts de verificación E2E que usan node_modules van en el repo, no en /tmp
_procedimiento · confianza alta · recurrencia x1_

**Observación:** El script de Playwright para contar WebSockets se escribió primero en /tmp y falló porque no resolvía node_modules; hubo que moverlo al repo para que corriera.

**Lección:** Al escribir un script temporal de verificación (Playwright, Node) que depende de las dependencias del proyecto, crearlo directamente dentro del repo (o una subcarpeta tipo /tmp-scripts del propio proyecto) desde el arranque, no en /tmp, para evitar el paso extra de reubicarlo tras el fallo de resolución de módulos.

### Piezas de infraestructura críticas requieren gate humano fijo, sin importar el score de riesgo de la IA
_convencion · confianza alta · recurrencia x1_

**Observación:** El auto-apply de actualizaciones dejó pasar 'express' y 'archiver' por veredicto IA 🟢 seguro/alta, mientras 'cookie' (que rompió todo el sistema) quedó marcado 🟡 riesgoso pero se aplicó igual porque el usuario lo había tildado; el umbral de auto-aprobación resultó insuficiente para la pieza más crítica del stack.

**Lección:** En cualquier automatización que aplique cambios reales sobre infraestructura, mantener una lista fija de 'nunca automático' para las piezas más críticas (motor/framework central, autenticación), que exija confirmación humana explícita sin importar la confianza que reporte un veredicto de IA.

### Verificar salud del sistema en la ventana crítica real, no tras un arreglo ajeno concurrente
_procedimiento · confianza alta · recurrencia x1_

**Observación:** El agente reportó 'sobrevivió, todo sano' tras el incidente de cookie, pero sus chequeos corrieron después de que otra sesión ya había parcheado el import roto — nunca verificó el momento en que el sistema realmente estuvo caído, y tuvo que corregir su propio reporte como engañoso.

**Lección:** Al verificar un incidente o una actualización riesgosa, cruzar los timestamps de los propios chequeos contra el log del servicio para confirmar que caen dentro de la ventana de riesgo real, y chequear si otra sesión/actor ya intervino antes de reportar 'sano' — para no confundir una corrección ajena con la propia verificación.

### Verificar actualizaciones de dependencias con prueba de runtime real, no solo sintaxis
_metodologia · confianza alta · recurrencia x1_

**Observación:** El update de `cookie` 1→2 pasó `node --check` sin problema pero rompió en runtime (export renombrado), causando un crash-loop de ~12 minutos que las verificaciones existentes (sintaxis + `systemctl is-active`) no detectaron.

**Lección:** Antes de dar por buena una actualización de dependencia, verificar con una prueba de runtime real (levantar el proceso y pegarle una petición HTTP real, no solo comprobar que el servicio figura 'active') además del chequeo de sintaxis, porque imports rotos y cambios de API solo fallan al ejecutar, no al parsear.

### Al cambiar un componente compartido (p.ej. Tándem), resincronizar en el mismo cambio los playbooks/skills que lo describen
_procedimiento · confianza media · recurrencia x1_

**Observación:** El orquestador y sus 3 SKILL.md seguían describiendo el Tándem del 15-jul (sonnet/medium) mientras el código real ya corría opus/high pinned como default desde el 21-jul; se acumularon 6 desfases hasta que el usuario pidió una verificación explícita.

**Lección:** Cuando se modifica el comportamiento de un componente central (modelo por defecto, ruteo, permisos), incluir como parte del mismo cambio la actualización de los playbooks/skills que lo documentan, en vez de dejar que una sesión futura lo descubra por casualidad al comparar contra el código.

### Derivar estado de UI del proceso vivo (auto-reporte), no de una copia persistida
_metodologia · confianza alta · recurrencia x1_

**Observación:** El badge de Tándem mintió durante horas porque dependía de un flag persistido (spawnedTandem) que no se actualizaba al cambiar el modelChoice en caliente; el fix real fue hacer que el runner reporte su propio flag real en vez de confiar en la memoria guardada.

**Lección:** Cuando se muestre en UI el estado de un proceso/config que puede cambiar en caliente, diseñar ese estado para que se derive del auto-reporte del proceso vivo, no de un valor persistido que puede desincronizarse silenciosamente.

### Evitar networkidle de Playwright en apps con polling; usar domcontentloaded + timeout corto
_procedimiento · confianza alta · recurrencia x1_

**Observación:** Al capturar screenshots del login y el splash con Playwright, la espera por `networkidle` colgó porque la app hace polling continuo; hubo que rehacer las capturas con `domcontentloaded` y timeouts cortos, una por una.

**Lección:** Para este proyecto (o cualquier app que haga long-polling/websocket), no usar `waitUntil: networkidle` en capturas Playwright; usar `domcontentloaded` con timeout corto desde el primer intento.

### Verificar que cada subsistema tenga su propio mecanismo de cierre al unificar una acción 'resolver todo'
_procedimiento · confianza alta · recurrencia x1_

**Observación:** El botón 'Resolver todo' del rediseño de Salud se armó pensando solo en los hallazgos de Revisión (que ya tenían un CLI de resolución); las propuestas de Optimización/Coherencia no tenían equivalente y quedaron sin cerrar su ciclo pending→aceptada/rechazada hasta que el usuario lo notó al abrir esas pestañas.

**Lección:** Antes de dar por completa una función que agrupa varios tipos de ítems con ciclos de vida propios (hallazgos, propuestas, etc.), listar explícitamente el mecanismo de cierre de CADA tipo — no solo el más visible o el primero implementado — y verificar que todos queden simétricos antes de cerrar la tarea.

### No duplicar el cómputo de un estado derivado (veredicto/resumen) entre endpoints gemelos
_metodologia · confianza alta · recurrencia x1_

**Observación:** El badge de Salud quedó clavado en CRÍTICO pese a que los 26 hallazgos estaban resueltos: existía una lógica 'liveVerdict' que recalculaba el veredicto real ya usada en /review, pero /scan-all nunca la adoptó y seguía sirviendo el verdict congelado de la corrida IA original.

**Lección:** Cuando dos rutas/endpoints exponen el mismo dato derivado de un estado mutable (ej. un veredicto agregado), extraer el cómputo a una única función compartida que ambas llamen, en vez de mantener copias que puedan desincronizarse en silencio. Al agregar una lógica de recálculo 'en vivo' a un endpoint, revisar si hay un endpoint hermano exponiendo el mismo tipo de dato y aplicarle la misma corrección.
<!-- cwc:mejora-continua:end -->
