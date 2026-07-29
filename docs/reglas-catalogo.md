# Catálogo de las reglas duras

Este archivo es el **CATÁLOGO** de las reglas duras: enumera los casos concretos
que implementan cada norma. La **LEY** vive en `CLAUDE.md`, fuente de verdad del
repo; este documento se consulta cuando hace falta el detalle. Está en `docs/`
a propósito: el harness NO lo auto-carga, así que no pesa en cada sesión.

## Catálogo · Regla 2

2. **Resiliencia:** ninguna operación en curso puede quedar atada al ciclo de
   vida del proceso Node. Terminales → tmux (socket `cwc`); vistas TUI de
   conversaciones → tmux oculta (`cwct-`); motores de chat → runner desacoplado
   (`bin/cwc-chat-runner.js`); delegaciones Tándem a Codex → runner desacoplado
   (`bin/cwc-codex-runner.js`); triage de bugs → runner desacoplado
   (`bin/cwc-triage-runner.js`); revisión exhaustiva de salud → runner
   desacoplado (`bin/cwc-health-runner.js`); auto-fix de un hallazgo →
   runner desacoplado (`bin/cwc-healthfix-runner.js`); batch de resolución en
   paralelo → orquestador desacoplado (`bin/cwc-healthfix-orchestrator.js`);
   login completo de Claude por inquilino → runner PTY desacoplado
   (`bin/cwc-claude-login-runner.js`, estado por usuario en
   `~/.cwc-data/claude-login-jobs/`);
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

**Estado histórico (BUG-1953):** los siguientes runners citados arriba están
**ARCHIVADOS** y sus rutas reales son `_archived/bin/cwc-desk-runner.js`,
`_archived/bin/cwc-investigate-runner.js`,
`_archived/bin/cwc-ticket-investigate-runner.js` y
`_archived/bin/cwc-triage-runner.js`.

## Catálogo · Regla 6

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

**Estado histórico (BUG-1953):** `bin/cwc-desk-runner.js`,
`bin/cwc-investigate-runner.js` y `bin/cwc-ticket-investigate-runner.js`,
citados arriba, están **ARCHIVADOS** en `_archived/bin/`.

## Catálogo · Regla 11

El detalle de las 6 leyes del grafo de Pad **no se duplica acá**: vive en
`CONVE-1257` del Pad local (fuente de verdad de la convención) y en
`docs/pad-grafo.md` (ejemplos, queries de verificación y el caso de los 36 nodos
huérfanos del 2026-07-25). La LEY corta está en la Regla 11 del `CLAUDE.md`.

## Catálogo · Regla 13

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

## Catálogo · Regla 16

16. **🛃 Aduana — cuarto espacio, neutral entre PERSONAS** (acuñada por Niko
    2026-07-28; detalle completo en `console:PLAN-2198`). Una sala permite que
    varios usuarios de confianza distinta compartan UN chat sin darle al
    invitado acceso operativo al mundo del anfitrión. Sus 6 leyes, en corto:
    (1) **suelo neutral** — raíz propia
    `~/.cwc-aduana/salas/<salaId>`, fuera de todo mundo real, con contención por
    `path.relative`; (2) **nada entra sin declararlo** — solo adjuntos o
    referencias explícitas, nunca contexto ambiental; (3) **nada sale sin
    visado** — los resultados salen como artefactos que se aplican al destino
    con aprobación, nunca por escritura directa de la sala; (4) **todo aporte
    lleva pasaporte** — autoría persistida y auditable; (5) **permisos del
    suelo** — jamás `bypassPermissions`; (6) **aportes como datos** — cada
    mensaje llega al modelo atribuido a una persona, nunca como instrucción de
    sistema. La IA arranca muda: `say` conversa y persiste con 0 tokens; solo el
    botón de corte invoca al motor, usando la credencial y cuota del anfitrión.

    La raíz, la validación y el log viven en
    `src/modules/chat/aduana.js`; `worldLabelFor` reconoce Aduana en backend y
    vive en `src/core/worlds.js`, mientras `salaPlaceFor` representa el mismo
    lugar en frontend desde `public/js/ui/places.js`. La familia de invariantes
    **«Aduana — suelo neutral»** de
    `src/modules/health/invariants.js` audita la separación física, la
    contención segura, la prohibición de `bypassPermissions`, el canal `say`
    sin motor, la atribución de aportes y la persistencia independiente del
    proceso. Compartir no relaja la Regla 12: quien no es dueño ni participante
    explícito sigue recibiendo 404 sin saber que el chat existe.
