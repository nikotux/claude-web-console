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
   (`bin/cwc-chat-runner.js`); triage de bugs → runner desacoplado
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
   archivos de contexto y estructura de este repo (este CLAUDE.md — mapa,
   convenciones, gotchas — y docs/ si aplica). El proyecto puede crecer mucho;
   este archivo tiene que alcanzar para que una IA sin contexto previo sepa
   qué puede, qué debe y qué no debe tocar.
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
      del programa de modularización) y `codex-verify` (revisión
      independiente con Codex) se re-usan tal cual para CUALQUIER trabajo
      futuro que calce con su propósito — no reinventar el procedimiento a
      mano cada vez que aplica.
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

## NO MODIFICAR (generado o estado de runtime)

- `node_modules/`, `package-lock.json` (solo vía npm)
- `certs/` (cert self-signed autogenerado; se regenera si cambia la IP)
- `users.json`, `sessions.json` (auth; perms 600), `recents.json`, `titles.json`
- `.env` (config del usuario: token maestro, puerto, etc. — solo el usuario)
- Fuera del repo: `~/.cwc-data/` (chats.json, `chat-session-ids.json` —
  registro DURABLE append-only de TODOS los sessionIds que alguna vez fueron
  chat: lo escribe el módulo chat en persist()/rehydrate() y NUNCA se poda (a
  diferencia de chats.json, que persist() filtra a los vivos y el reaper poda
  a las 24 h); lo lee tokens/buildSummary (unión con chats.json + bugfixes.json)
  para que un chat cerrado/olvidado no se atribuya como "Motores headless" en
  el panel de Uso (fable/opus fantasma, hallazgo de la Optimización IA
  2026-07-05; backfill histórico one-time hecho desde los logs de
  ~/.cwc-data/chats/*.log) —, sockets/logs de runners, caché
  tickets/salud — incluida `triage-cache.json`, caché INCREMENTAL por ticket
  del triage (fingerprint status+subject + TTL 12 h; borrarla solo fuerza
  un triage completo) —, `desk-live/<ticket>.json` resultado de la consulta a Zoho Desk
  + `desk.lock` heartbeat del runner desk, `investigations/<pr>.json` veredicto de
  la investigación a fondo + `investigate.lock` heartbeat,
  `ticket-investigations/<n>.json` veredicto de la investigación de contexto de un
  ticket sin PR + `<n>.req.json` enunciado + `ticket-investigate.lock` heartbeat,
  `inventory.json`+`inventory.md` generados por core/inventory.js,
  `plan-limits.json` último snapshot BUENO de límites/créditos del plan (lo
  escribe el módulo tokens en cada respuesta OK de /api/tokens/limits; se sirve
  como fallback `stale` ante 429/corte de red/reinicio),
  `usage-history.json` HISTÓRICO PERSISTENTE de consumo por día(LOCAL Medellín)×
  PROYECTO×modelo (days[fecha][consola|tolkien|otros][modelKey]={tokens,cost}; lo
  escribe el módulo tokens vía history-store.js: buildSummary calcula el desglose y
  lo snapshotea cada ~5 min — independiente de la poda de transcripts del CLI;
  retención 400 días diaria + rollup mensual `months`; alimenta GET
  /history?range=week|month&project — Semana=7 d, Mes=30 d — = gráficas de Tendencia
  del modal Uso; el rango Día sale del summary, no de acá; días en formato viejo flat
  se normalizan a {otros} al leer).
  REEMPLAZÓ al viejo `tokens-reset.json`/POST /reset (2026-07-10): con historial
  persistente NO hace falta "poner en cero"; si quedó un tokens-reset.json huérfano
  de antes es inerte (ya no se lee),
  `health-solved.json` registro de bugs, `health-audit-cache.json` caché
  incremental de salud, `health-invariant-proposals.json` invariantes propuestos
  pendientes, `comms/` (motor de Comunicaciones: contacts.json · projects.json · github.json escaneo gh · manual.json registros · overrides.json · gh-cache.json · self.json identidad del dueño · chatbot.json chatbot derivado por IA · comms.lock heartbeat · teams.lock · chatbot.lock heartbeat · analyze/ análisis IA de hilos), `optimization.json` resultado de la Optimización IA +
  `optimize.lock` heartbeat de su runner, `coherence.json` resultado del Módulo
  de Coherencia (propuestas + hallazgos determinísticos persistidos) +
  `coherence.lock` heartbeat de su runner, `projects-analyze/<id>.json` jobs del
  análisis IA de secciones de contexto (módulo projects; poda >24 h en cada
  escritura) + `projects-analyze.log` de su runner, `commitmsg/<id>.json` jobs
  de la generación IA del mensaje de commit (módulo backup; misma poda >24 h) +
  `commitmsg.log` de su runner, `tolkien-refresh.json` job del refresh DESACOPLADO
  de la DB LOCAL de Tolkien (lo reserva POST /api/tolkien/refresh-data, lo completa
  `bin/cwc-tolkien-refresh-runner.js`; staleness 12 min) + `tolkien-refresh.log`,
  `tasks.json` registro PRIVADO de las tareas
  pendientes + PLANES (módulo tasks; CRUD síncrono determinístico, escritura
  atómica tmp+rename — NO hay runner) + `tasks-activity.json` LOG de actividad
  append-only (create/update/status/complete/delete de tareas y planes; poda a
  300 eventos) + `tasks-analysis-<scope>.json` resultado del ANÁLISIS GENERAL IA
  del tablero (scope tasks|plans; lo escribe `bin/cwc-tasks-analyze-runner.js`) +
  `tasks-analyze.log` de ese runner, `learning.json` registro PRIVADO de los TEMAS
  del MÓDULO DE APRENDIZAJE (módulo learning; CRUD síncrono tmp+rename, sin runner)
  + `learning-activity.json` su LOG append-only (poda 300) +
  `learning-explain-<id>.json` job de "🎓 Explicame esto" (lo escribe el POST, lo
  completa `bin/cwc-learning-explain-runner.js`) + `learning-explain.log` de ese
  runner + `learning-context-<jobId>.json` job de "🎙️ Contexto adicional" (id
  determinístico por tema+transcripción) + `learning-context.log` de
  `bin/cwc-learning-context-runner.js` + `learning-analysis.json` resultado de
  "🧠 Analizar aprendizaje" (`bin/cwc-learning-analyze-runner.js`) +
  `learning-analyze.log` — OJO: `learning.json` guarda AMBOS temas (LT<n>,
  ahora con contextoAdicional/explainFingerprint/explainFiles/explainVersions)
  y RUTAS de aprendizaje (LR<n>, routes[]+routeSeq),
  `learning-session-ids.json` registro DURABLE append-only de los sessionIds de
  las corridas del MÓDULO DE APRENDIZAJE (lo escriben los 3 runners de aprendizaje
  vía `learning/session-log.js` capturando el `session_id` del msg SDK
  `system/init`; lo lee el módulo tokens): esas corridas usan cwd = la consola,
  así que `projectOf` las vería como 'consola' — este registro permite atribuir su
  consumo al bucket 'aprendizaje' APARTE, para auditar tokens de ESTUDIO vs
  DESARROLLO (no es retroactivo: transcripts de aprendizaje previos a 2026-07-10
  quedan contados en 'consola'),
  `audio/<id>.json` jobs del análisis IA de
  transcripciones (módulo audio; id determinístico por contenido, poda >30 días)
  + `audio.log` de su runner, `retro/<id>.json` jobs de la destilación de MEJORA
  CONTINUA (ROAD-256, módulo `retro`; id sha1 del sessionId, lo encola Chat.close,
  poda >30 días) + `retro.log` de su runner + `retro-activity.json` log local
  append-only del registro de lecciones + `retro-curation.json` job de la
  curaduría IA (Fase 5) + `retro-curate.log` (las lecciones EN SÍ viven en Pad
  local, colección `mejora-continua`, no en archivo), `session-bus/` del INTERFONO entre
  sesiones — `messages/<id>.json` bandeja de mensajes · `claims/<hash>.json`
  reservas de archivo (1 por archivo, clave = hash de la ruta) ·
  `tombstones/<id>.json` avisos de claim robado; lo escriben los hooks vía
  `bin/cwc-bus.js`, el módulo `interfono` solo lo lee), `ticket-meta.json`
  (metadata NUESTRA por ticket/PR del módulo VIVO `tickets/`: "Contexto adicional"
  + "Histórico del trabajo" — clave `ticketNumber` o `pr:<n>`; lo escribe
  `tickets/meta-store.js`, escritura atómica tmp+rename; NADA lo poda),
  `ticket-context/<id>.json` jobs del runner de contexto adicional
  (`bin/cwc-ticket-context-runner.js`; poda >30 días) + `ticket-context.log`,
  `~/.cwc-backups/`, `~/.cwc-trash/`, `~/.cwc-state/`
  (observador — OJO: `claude-state.js` PODA todo .json de `~/.cwc-state` sin
  `ts` fresco; nunca guardar ahí nada ajeno al observador)

## Módulo VIVO `tickets/` — Contexto adicional + Histórico del trabajo (2026-07-07)

⚠️ El tablero `bugfixes/board` que describe gran parte de este archivo está
ARCHIVADO (`_archived/`, branch `redesign/board-mobile`). El módulo VIVO del ciclo
de tickets/features/PRs es **`tickets/`** (Bugs v2 · "One Front Door"): dashboard
determinístico (snapshot Zoho/GitHub cada 60 s, sin IA) con ventanas de detalle
en MODAL — `public/js/modules/tickets/{ticket-detail,pr-detail}.js` (clases `.bv2-*`).

⚡ **BACKEND MIGRADO A PAD LOCAL — patrón "dos mundos" (2026-07-12, ROAD-110 Fase
3, parte del cutover a self-host, ver el gotcha "MCP de Pad" más abajo):**
`meta-store.js` (las 4 funciones de I/O: `getMeta`/`saveContexto`/
`clearContexto`/`appendHistorico` — el "Contexto adicional" + "Histórico del
trabajo" de abajo) ya NO es file-based — habla contra el Pad LOCAL (workspace
`console`, colección `contexto-de-tickets`/CDT). Esto es la pieza de **mundo
INTERNO** del patrón de dos mundos: notas PROPIAS de Consola sobre un
ticket/PR — el ticket/PR EN SÍ (Zoho Desk + GitHub) y el Pad de TOLKIEN (cloud,
`src/modules/tickets/pad-client.js`) son el **mundo EXTERNO**, sin cambios, sin
tocar. Como la clave de un ticket/PR es un string arbitrario ya existente
('123', 'pr:245') y no un `ref` de Pad, la búsqueda usa
`findItemByTitle()` de `pad-service-client.js` (list + match por título — el
volumen de tickets trabajados es bajo, no hace falta un índice). `historico[]`
y `contexto adicional` viajan como campos JSON del item. `extractSessionWork()`
(extracción determinística del transcript) NO se tocó — sigue igual, no hace
I/O de meta-store. Alcance verificado ESTRICTO: nada del gate de push, Desk,
GitHub, claims ni snapshot de `tickets/index.js` se tocó — solo los 2-3
call-sites puntuales que ya llamaban a estas 4 funciones. `ticket-meta.json`
viejo queda como respaldo histórico, ya no se lee.

DOS SECCIONES nuevas en la 2ª columna de esas ventanas (pedido de Niko), panel
FRONT compartido `public/js/modules/tickets/meta-panel.js` (mismo HTML/handlers/
inyección al prompt para ticket, feature y PR — no se duplica):
- **🎙️ Contexto adicional:** pegás la TRANSCRIPCIÓN de una charla → la IA la
  interpreta (runner desacoplado read-only, ver arriba) → se AUTO-GUARDA como
  sección persistida y se INYECTA en "Continuar en el chat". Editable/borrable.
- **📚 Histórico del trabajo:** al CERRAR el chat de un ticket/PR, `Chat.close()`
  (chat/index.js, diferido 2 s) extrae DETERMINÍSTICAMENTE (0 tokens) archivos
  tocados + resumen del cierre (`extractSessionWork` de `tickets/meta-store.js`,
  portado del board v1) y lo agrega al histórico del ítem → la PRÓXIMA sesión
  arranca con TODO el historial acumulado. PRs pasan `ticket:{number:'pr:<n>'}`
  para registrar bajo esa clave.

Backend: `tickets/meta-store.js` (store persistente, overlay `withMeta` sobre el
ticket/PR al servir) + `tickets/context-analyze-shared.js` (molde de audio) +
endpoints en `tickets/index.js`: `POST /meta/context-analyze` (spawn runner,
CONSUME TOKENS bajo confirm) · `GET /meta/context-analyze/:job` (poll, 0 tokens) ·
`POST /meta/context` (guardar/editar/borrar a mano) · `GET /meta/:key`.

CONTEXTOS DE TRABAJO EDITABLES (migrado de v1 al chat v2, 2026-07-08). Además de
los DOS bloques por-ítem de arriba (contexto adicional + histórico), cada chat de
"Continuar en el chat" / "Trabajar esto en un chat" (ticket, feature y PR) inyecta
DOS contextos GLOBALES editables — los mismos de la v1 (bugfixes), que estaban en
disco (`~/.cwc-data/bugfix-context.md` = 'work' · `bugfix-pr-context.md` = 'pr') y
servidos por `GET/POST /api/tickets/context?kind=work|pr` (`tickets/context-store.js`)
pero YA NO se inyectaban en ningún chat (agujero de la migración): 'work' = CÓMO se
trabaja un ticket (el **"Pensamiento Profundo"** paso-0 antes del plan —cuadro de
contra-verificación con links autoritativos, lección Desk #519—, entregas en tablas
+ "Puntos a investigar", narrativa humana, triage BUG/FR/EXTERNA, gate de push, y la
sesión publica el PR directo tras el gate: en v2 NO existe el módulo "Enviar PR" de
v1) · 'pr' = house style de la descripción del PR (Summary con 3 preguntas, causa
raíz, verificación, variantes feature/external). Se editan en ⚙ Sistema → Proyectos,
grupo "Tickets & Features · contexto de trabajo" (entradas "Tickets & Features:
Trabajo/PR" — antes "Bugfixes:", renombradas; keys internas `bugfix-work`/`bugfix-pr`
sin cambiar para no tocar el endpoint), `system/project-context-panel.js`. Wiring:
`fetchWorkflowContexts()` + `workflowContextBlocks()` en `tickets/meta-panel.js`
(fuente única, patrón `fetchContexts` de v1); `buildContext`/`buildPrContext`
(ticket-detail/pr-detail) apendean los bloques `--- CONTEXTO DE TRABAJO ---` /
`--- REDACCIÓN DEL PR ---` AL FINAL del prompt. La metodología del Pensamiento
Profundo ADEMÁS sigue en la memoria de Tolkien (`…tolkien/memory/pensamiento-profundo.md`
y hermanas), que auto-carga en TODA sesión de Tolkien (incluidas TUI) — solapamiento
deliberado (pedido de Niko 2026-07-08): la memoria cubre las TUI/chats manuales, el
contexto inyectado cubre los chats abiertos desde el botón de un ticket v2.
ESPEJO A TOLKIEN — BLINDAJE (2026-07-10, pedido de Niko: "que CUALQUIER sesión que
vaya a hacer el push de un PR tenga SIEMPRE estas instrucciones que yo puedo editar,
blindados a futuro"). Problema: la inyección al prompt del tablero
(`workflowContextBlocks`) SOLO cubre los chats abiertos desde el botón de un ticket;
una sesión abierta de otra forma (launcher / TUI / reanudada) sobre `~/tolkien` NUNCA
veía estos contextos (caso real: la sesión del PR #266 corría solo con lo nativo de
Tolkien). El ÚNICO mecanismo que llega a TODA sesión de un repo es el auto-carga nativo
de Claude Code (`CLAUDE.md` + `CLAUDE.local.md` + memorias); la inyección one-shot del
tablero es estructuralmente incapaz de garantizar. SOLUCIÓN (enfoque ESPEJO, no
referencia — el texto viaja FÍSICO, no un "andá a leer allá" que dependa de que el
modelo obedezca): al guardar un contexto, `saveContext` (`tickets/context-store.js`)
además de escribir el master en `~/.cwc-data/bugfix-*.md` ESPEJA el subset work+pr a una
SECCIÓN GESTIONADA de `~/tolkien/CLAUDE.local.md` — archivo LOCAL, ya excluido del repo
(`.git/info/exclude`, NUNCA se comitea), que Claude Code auto-carga en CADA sesión de
Tolkien (chat/TUI/launcher/reanudada). `syncToTolkien()` reemplaza SOLO lo que está entre
los marcadores `<!-- cwc:tickets-context:start/end -->` (todo lo que Niko escribió a mano
en CLAUDE.local.md — la 🛡 regla dura de PRs — queda intacto FUERA de los marcadores).
El master (fuente de verdad, con TODO) vive en la consola; a Tolkien baja solo el subset
necesario para trabajar tickets/features/PR. La sección lleva NOTA-en-el-documento
("gestionado por Mi Consola, no editar a mano, local no versionado") para que un
future-Niko no la confunda con un objeto raro. VERIFICADOR: `verifySync()` compara el
bloque presente en CLAUDE.local.md vs el render del master → `ok|stale|missing|
unavailable`; expuesto por `GET /api/tickets/context-sync` (0 tokens, solo lee disco) +
`POST` (re-sincronizar a mano). El panel de Proyectos (`system/project-context-panel.js`,
bloque `.pj-sync`) muestra el badge + botón "Re-sincronizar" + la NOTA-en-la-consola de
dónde aterriza, ARRIBA de los contextos editables; y un check rápido de Salud
(`checkTolkienContextSync` en `health/index.js`, id `tolkien-context`) entra en el
semáforo global. La inyección del tablero se CONSERVA como redundancia inofensiva
(cinturón + tirantes).

## Mapa del proyecto

```
src/server.js               bootstrap: ZeroTier wait → HTTPS bind → auth → módulos
src/core/                   config(.env) · auth · users · wss · registry · tls ·
                            zerotier · tmux(validación) · trash · recents ·
                            pool(runAdaptivePool — pool de concurrencia ADAPTATIVA transversal;
                            MOVIDO acá desde health/pool.js en la coherencia 2026-07-12 porque lo
                            consumen salud/tokens/comms/tickets; health/pool.js queda re-exportando
                            para sus consumidores históricos. Opción `max` = techo duro de
                            concurrencia (default = nº items) para consumidores con límite externo,
                            p.ej. tickets/sources.js pasa max=ENRICH_CONCURRENCY por el rate-limit de
                            Zoho) ·
                            text-only-query(textOnlyQuery — helper ÚNICO de las corridas del SDK de
                            TEXTO PURO/interpretación sin herramientas: encapsula settingSources:[]
                            vía settingSourcesFor('none') + las DOS capas de deny de la regla 6
                            [PreToolUse+canUseTool, INCONDICIONALES] + carrera de timeout + pump.
                            Lo usan retro-runner y ticket-context-runner; NO usarlo si el runner
                            necesita herramientas — ese arma su query con su allowlist explícita) ·
                            paths(resolveWithinHome/clampToHome — TODA validación de
                            rutas del cliente pasa por acá; nunca startsWith crudo) ·
                            sdk-settings(settingSourcesFor: fuente ÚNICA de settingSources,
                            'chat'=user+project+local / 'headless'=project+local sin user /
                            'none'=[] para texto puro — ver text-only-query) ·
                            tool-policy(NÚCLEO de gobernanza de permisos del chat interactivo —
                            NO es motor, es plomería in-process como sdk-settings/paths: el
                            estado del modo lo persiste el server (Chat.permissionMode→chats.json)
                            y lo aplica el runner; acá viven las REGLAS como fuente única.
                            PERMISSION_MODES (default/acceptEdits/bypassPermissions/plan,
                            re-exportado por chat/shared.js), normalizeMode, autoApprovesAll y
                            chatQueryOptions() que arma las opciones de query() del chat con
                            allowDangerouslySkipPermissions SIEMPRE (contrato del SDK; inerte
                            salvo en 'Todo'). VERIFICADO 2026-07-06 (SDK 0.3.198): el bypass ya
                            "shadowea" canUseTool sin el flag, así que el flag NO era la causa de
                            "elegí Todo y sigue preguntando" — la causa real es DRIFT (el modo no
                            llega/aplica en el runner) + la tarjeta ya emitida que no se
                            auto-resolvía; se arregla en el runner (set_mode robusto que emite el
                            modo REAL en éxito Y fallo + approveAllPending) y en la UI (chat-tab
                            reconcilia el select con el modo real y avisa si no tomó). Las
                            allow-rules del settings.json del usuario también shadowean canUseTool:
                            en 'default' algunas acciones no piden permiso — es la allowlist del
                            usuario, no un bug. BOOTSTRAP DE PAD (2026-07-12, Gap #1 / TASK-295 de
                            ROAD-63): chatQueryOptions inyecta CONSOLE_PAD_BOOTSTRAP como
                            systemPrompt {type:'preset', preset:'claude_code', append} SOLO si el
                            cwd está dentro del repo de la consola (isConsoleCwd, calculado desde
                            import.meta.url) — le recuerda al chat cargar `pad_set_workspace console`
                            + `pad_project dashboard/next` antes de trabajo no trivial y modelar el
                            trabajo como TASK/PLAN (bug→BUG), en vez de depender de que el modelo
                            recuerde CLAUDE.md. Usa preset+append (PRESERVA el prompt nativo de
                            Claude Code; un string pelado lo REEMPLAZARÍA — catastrófico). Chats de
                            Tolkien (mundo externo) NO lo reciben (regla dura 12: no un hook global
                            que alcanzaría a otro workspace). Un runner vivo no lo toma hasta
                            "Reabrir para cambios"/chat nuevo. Llevarlo a sesiones TUI = Frente B
                            diferido. La regla 6 (blindaje read-only headless) NO pasa
                            por acá: esos runners arman sus propias allowlists) ·
                            claude-model(VALID_MODELS/encodeCwd) · claude-state(observador —
                            estado por PANE de tmux primero: cwc-observe.js captura
                            $TMUX_PANE (2026-07-05, fix del Pac-Man que no masticaba al
                            reactivarse una sesión por interfono: el mapeo era SOLO por cwd
                            y la statusline de una hermana ociosa del mismo cwd lo pisaba);
                            stateForPane = identidad exacta (tmux/index.js mapea sesión→panes
                            con list-panes), stateForCwd queda como FALLBACK para estados sin
                            pane; las tmux abiertas toman el pane en su próximo tick de
                            statusline, sin reiniciar claude) ·
                            session-names(nombres ÚNICOS de tarjetas: registro de
                            registerNameProvider — chat aporta títulos de conversaciones
                            abiertas, tmux los display names de sus sesiones — +
                            uniqueName("tolkien"→"tolkien 1") consultado al CREAR chat
                            (manager.create; rehydrate NO uniquifica) y terminal (si el
                            basename choca, persiste el único como customTitle en
                            titles.json, cuyos helpers loadTitles/saveTitles/titleKey ahora
                            viven acá, compartidos por los módulos tmux y terminal) ·
                            inventory(INVENTARIO determinístico del proyecto — FASE 1 del
                            "sistema nervioso": el CLAUDE.md son las REGLAS/receta; el
                            inventario es el CENSO VIVO "qué existe AHORA". Sin LLM: parsea el
                            repo con regex e inline. Cataloga módulos backend (archivos ·
                            registry.js:línea · endpoints), runners de bin/, frontend
                            {name,mount} y el VOCABULARIO (tokens --cwc-*, env vars,
                            VALID_MODELS, PERMISSION_MODES) + un FINGERPRINT de contenido por
                            unidad. Salida: ~/.cwc-data/inventory.json + inventory.md.
                            generateInventory({force}) es ON-DEMAND: solo re-parsea si cambió
                            algún mtime/fingerprint. Lo dispara `bin/cwc-inventory.js`. Las
                            fases siguientes lo CONSUMEN: F2 salud incremental (audita solo
                            unidades cuyo fingerprint cambió), F3 contexto de chats nuevos,
                            F4 invariantes, F5 loop que aprende. NADIE lo importa aún —
                            standalone en F1, cero riesgo al server) ·
                            bus(INTERFONO entre sesiones: BUS DE ARCHIVOS determinístico, 0
                            tokens, en ~/.cwc-data/session-bus/. Dos capacidades: (1)
                            MENSAJERÍA — sendMessage/pendingFor/markDelivered: una sesión deja
                            un mensaje para otra (o broadcast 'all'); la destinataria lo recibe
                            inyectado por su hook en el próximo turno. (2) CLAIMS anti-conflicto
                            — claimFile/getClaim/releaseFile/releaseAll + evaluateClaim (árbol
                            zombi: HOT<5min→bloquea · observador ended/working · tmux has-session
                            · gris<30min soft · TTL vencido→robable) + tombstone (lápida al
                            zombi robado). IDENTIDAD por "handle": TUI=`tmux:<sesión>`,
                            chat=`claude:<sessionId>` — una TUI escucha en ambos. buildDirectory
                            reconstruye el mapa nombre↔handle SIN estado del server (tmux del
                            socket cwc + chats.json + titles.json). resolveTarget mapea el
                            `/btw <nombre>` a un handle. Lo consumen bin/cwc-bus.js (hooks/CLI) y
                            el módulo `interfono` (panel, solo lee). gc() oportunista en cada
                            invocación)
src/modules/<nombre>/index.js  módulo backend: { name, init(ctx), registerHttp(router, ctx), registerWs(wss, ctx) }
                            → se registra agregándolo al array de src/core/registry.js
  terminal/                 sesiones tmux (PREFIX cwc-) + bare/TUI (BARE_PREFIX cwct-) + rehidratación
  chat/                     conversaciones SDK: index.js (server) · shared.js (común) ·
                            runner-link.js (spawn/connect) · attachments.js (adjuntos) —
                            el motor real es bin/cwc-chat-runner.js.
                            ADJUNTOS DE ARCHIVOS (2026-07-10, pedido de Niko: "adjuntar imágenes/
                            archivos como en claude.ai, que el modelo los interprete sin
                            describirlos"): UN solo botón 📎 en el composer (chat-tab.js) + pegar
                            (Ctrl+V) + arrastrar-y-soltar — la consola DETECTA el tipo sola, sin
                            botones por tipo. Cada archivo se sube al toque a POST
                            /api/chat/attachment?id=<chatId> (multer, escritura a disco con
                            límite de tamaño DURANTE el streaming — nunca buffea a memoria) a la
                            carpeta PROPIA del chat ~/.cwc-data/chat-attachments/<chatId>/ (estado
                            de runtime, regla 4). Al enviar el mensaje viajan solo las REFERENCIAS
                            {name,type,mime} por el WS/HTTP (no el base64); el RUNNER lee cada
                            archivo del disco y arma el content del SDK según su tipo
                            (chat/attachments.js buildUserContent): imagen (jpeg/png/gif/webp) →
                            bloque `image` base64 (visión nativa) · PDF → bloque `document`
                            base64 · TEXTO (txt/md/csv/código/json/yaml/…) → contenido INLINE en
                            un bloque `text` (el modelo lo lee directo, sin describir) · BINARIO
                            (docx/xlsx/zip/…) → nota con la ruta absoluta (la API no tiene bloque
                            nativo; el modelo lo abre con Read/Bash si lo necesita). SIN adjuntos,
                            el content sigue siendo un STRING (retrocompat TOTAL). Límites propios:
                            4 imágenes · 8 adjuntos por mensaje · 10 MB imagen · 32 MB PDF · 20 MB
                            otros. SEGURIDAD (invariante en health/invariants.js): todo nombre se
                            reduce a un BASENAME validado (safeAttachName) y se confina a la
                            carpeta del chat (attachPath exige que path.dirname sea EXACTO) — el
                            traversal ../../.env da 404; el límite de tamaño se aplica ANTES de
                            leer a memoria. GET /api/chat/attachment?id=&name= sirve el archivo
                            (imágenes/PDF inline, resto descarga forzada, nosniff) para las
                            miniaturas de la burbuja. VISTA: la burbuja del usuario muestra
                            miniatura (imagen, click → lightbox) o chip (PDF/archivo). El
                            transcript del SDK persiste imágenes/PDF solo, así que al reabrir el
                            chat loadTranscriptEvents deriva CHIPS de tipo de los bloques image/
                            document (sin miniatura — no hay nombre en disco en el replay; la
                            imagen real sigue en la carpeta). MENÚ ⋯ de la tarjeta de Sesiones:
                            "Abrir carpeta del chat" (sessions.js) → GET /api/chat/folder?id=
                            asegura la carpeta y devuelve la ruta relativa al home; abre el
                            Explorador existente (deep-link ?path=) en esa carpeta — reuso total,
                            cero UI nueva (idea de Niko: ya tenemos explorador, no un menú de
                            artefactos aparte).
                            IMÁGENES QUE DEVUELVE EL ASISTENTE (2026-07-11, pedido de Niko: "que las
                            imágenes que vos leés/generás se vean en el chat, con el mismo flujo de
                            los adjuntos"): la dirección INVERSA de los adjuntos (asistente→humano).
                            Problema: cuando el modelo usa `Read` sobre una imagen (un PNG del repo,
                            un screenshot de Playwright), el SDK la devuelve como bloque `image`
                            base64 dentro del tool_result — el runner solo extraía el TEXTO
                            (resultText) así que el chip quedaba "sin salida" y Niko NO veía la
                            imagen (sí la veía el modelo). SOLUCIÓN (mismo flujo que los adjuntos,
                            dirección invertida): el RUNNER (bin/cwc-chat-runner.js `saveToolImages`)
                            detecta los bloques `image` base64 de CADA tool_result, los MATERIALIZA
                            en la MISMA carpeta de adjuntos del chat (chatAttachDir(ID), reusa
                            safeAttachName/IMAGE_MIME de chat/attachments.js) con nombre
                            `asst-<toolUseId>-<n>.<ext>`, y emite en el evento tool_result solo la
                            REFERENCIA `images:[{name,type,mime}]` — el base64 NUNCA viaja por el WS
                            (pesado); el front pide la miniatura a GET /api/chat/attachment como con
                            cualquier adjunto. Topes propios: 4 imágenes por tool_result · 12 MB por
                            imagen · solo png/jpeg/gif/webp; best-effort (si no puede escribir, el
                            turno sigue sin miniatura). El FRONT (chat-tab.js `_toolResult`): si el
                            evento trae `images`, inserta una tira de miniaturas clickeables
                            (→ lightbox) DESPUÉS del `.chat-toolgroup` del chip, REUSANDO `_attsEl`
                            (el mismo método de los adjuntos del usuario — usa this.id + el endpoint)
                            con la clase `.chat-toolimgs` + guard por data-tool-id (un replay de
                            hello.events al reconectar no duplica la tira). Estilo `.chat-toolimgs`
                            en style.css (hereda .chat-att-img). SEGURIDAD: el nombre lo genera el
                            runner y pasa por safeAttachName/attachPath (misma validación anti-
                            traversal de los adjuntos); el endpoint sirve inline con nosniff.
                            ALCANCE — FASE 1 = EN VIVO + reconexión al runner vivo (el evento
                            tool_result con `images` va en el history, así que hello.events lo
                            re-emite mientras el runner viva). Un chat DORMIDO reabierto desde el
                            transcript del SDK (loadTranscriptEvents) NO re-deriva las miniaturas —
                            las imágenes siguen en la carpeta del chat (accesibles por "Abrir carpeta
                            del chat"), pero re-pintarlas en el replay del transcript es FASE 2
                            pendiente. Verificado E2E: un chat haiku que hace Read de un PNG lo
                            materializa en su carpeta + emite el tool_result con images; el endpoint
                            sirve la imagen y `_attsEl` arma la miniatura correcta.
                            README.md documenta la config que hereda el chat (Fase 8:
                            settingSources user+project, comandos slash, observador). Modelo
                            EN VIVO (POST /api/chat/model, WS set_model): con motor corriendo
                            usa q.setModel() del SDK (mismo mecanismo que setMode/
                            setPermissionMode, sin perder contexto); dormido, solo actualiza
                            chat.model para el próximo spawnRunner. Antes solo existía para
                            sesiones tmux (`/model` tipeado a la TUI) — ahora el menú ⋯ de una
                            conversación en Sesiones también tiene "Cambiar modelo".
                            REABRIR PARA CAMBIOS (menú ⋯ de una conversación en Sesiones,
                            2026-07-06, pedido del usuario): mata el runner desacoplado vivo
                            y levanta uno FRESCO sobre la MISMA sesión (`--resume`: conserva
                            contexto, NO cierra la conversación) para que un chat vivo tome
                            cambios de CÓDIGO nuevos tras un deploy — un runner spawneado
                            antes del deploy importó el código viejo (PERMISSION_MODES,
                            bypassPermissions, allowlists) y no los toma hasta dormirse/
                            reabrirse. Método `Chat.reopen()` (index.js): motor dormido ⇒
                            `_ensureEngine()` directo; motor vivo ⇒ sleep + ESPERAR el
                            descarte REAL del link viejo (`while (this.link)` con deadline
                            SWITCH_CLOSE_MS) antes de re-spawnear — OJO: el runner emite el
                            evento `closed` y RECIÉN ~2s después cierra el socket, así que
                            `_waitEngineDown` resuelve con `this.link` aún seteado; spawnear
                            ahí haría early-return de `_ensureEngine` Y el runner nuevo se
                            suicidaría ("ya hay un runner vivo"). Tras el respawn fija
                            `_setStatus('waiting')` (el runner arranca en waiting pero no
                            emite status si no cambia → quedaría un working/delegating stale).
                            Emite evento `reopened` (nota en chat-tab.js). Endpoint POST
                            /api/chat/reopen {id} (molde de /mode). SOLO conversaciones Chat
                            (el ítem se oculta con `isTui` en sessions.js; una TUI se reinicia
                            desde la terminal). Confirm en el front SOLO si status==='working'
                            (cortaría el turno en curso).
                            MODOS DE PERMISOS (PERMISSION_MODES en shared.js, único punto de
                            validación server+runner): default/acceptEdits/bypassPermissions/
                            plan. En la UI (chat-tab.js MODES) son etiquetas de UNA palabra
                            con color por riesgo en el select del header (data-risk, ver
                            .chat-mode en style.css): Preguntar=verde · Ediciones=amarillo ·
                            Todo=ROJO (bypassPermissions: acepta ABSOLUTAMENTE todo sin
                            canUseTool; confirm rojo obligatorio en _modeChanged antes de
                            activarlo — deliberado, pedido del usuario; NO afecta las
                            corridas headless, regla 6) · Plan=gris. _applyMode es la única
                            puerta modo→UI. OJO: un runner ya vivo de antes del deploy no
                            conoce bypassPermissions (Set importado al spawn) e ignora ese
                            set_mode hasta dormirse/reabrirse.
                            DEFAULT "Todo" DEL LANZADOR (pedido del usuario 2026-07-06): TODO
                            chat/sesión NUEVO abierto desde el lanzador arranca en
                            bypassPermissions — launcher.js pasa mode:'bypassPermissions' al
                            crear/retomar chat (antes 'default') y la sesión TUI lanza
                            `claude --dangerously-skip-permissions` (terminal/sessions.js). El
                            confirm rojo de _modeChanged NO salta (solo aplica al elegirlo a
                            mano), pero el chip del header nace ROJO "Todo" así queda visible.
                            NO afecta: las corridas headless (regla 6), los chats de bugfixes
                            "Trabajar en esto" (pasan modo explícito default/plan por el gate
                            de push) ni el fallback del server /create (sigue 'default' como
                            red anti-footgun para llamadas programáticas).
                            CHIPS DE EJECUCIÓN (tool calls): SOLO dos íconos, sin texto —
                            consola (= herramienta ejecutada) + tipo (TOOL_TYPE_ICONS en
                            chat-tab.js: Bash=play · Edit/Write=edit · Read=eye ·
                            Grep/Glob=search · Web=download · Todo=list · Task=sparkle ·
                            resto=gear). Nombre+resumen quedan en el tooltip; el detalle al
                            tocar. La LEYENDA vive en el modal del "?" del header
                            (_modeHelp, "Ayuda del chat": sección Modos + sección Íconos de
                            acciones). Los chips de PERMISO (chat-permchip
                            "Permitido/Denegado") conservan su palabra a propósito:
                            registran una decisión, no una ejecución.
                            SOLICITUD de permiso (chat-perm, _permCard): compacta como los
                            chips — [chip consola+tipo+chevron, SIN texto] + [✕ Denegar]
                            [✓ Permitir] (lo único que sobresale; cp-deny con margin-left:
                            auto). El nombre de función era flex:none y con tools MCP
                            largos empujaba los botones fuera de pantalla en móvil (bug
                            reportado por el usuario). Tocar el chip expande el detalle:
                            cp-detail-tool = nombre COMPLETO de la función (word-break) +
                            comando/diff íntegro. Destructivos siguen naciendo EXPANDIDOS
                            (isDestructiveCommand).
                            PREGUNTA CON OPCIONES — AskUserQuestion (2026-07-06, pedido del
                            usuario: el popup salía como un permitir/denegar genérico sin
                            mostrar las opciones): el tool AskUserQuestion NO es un permiso
                            permitir/denegar — es una PREGUNTA que espera que el usuario ELIJA
                            una opción. Cae por el MISMO canal canUseTool/permission_request
                            que cualquier tool, pero se renderiza distinto. Backend
                            (shared.js): toolSummary = texto de la 1ª pregunta · toolDetail =
                            {askQuestions:[{question,header,multiSelect,options:[{label,
                            description}]}]} normalizado (viaja en `detail`, así lo reenvía
                            también pendingPerms()→perm-center). Front: _permCard detecta
                            tool==='AskUserQuestion' y llama _askQuestionCard, que usa el
                            builder COMPARTIDO buildAskQuestionBody (exportado de chat-tab.js,
                            reusado por perm-center.js — sin duplicar el render): pinta
                            header-chip + pregunta + opciones seleccionables (single = radio,
                            multiSelect = toggle) + "Otra respuesta…" (texto libre = la opción
                            "Other" que el SDK ofrece siempre) + Enviar (habilitado cuando
                            TODAS las preguntas tienen respuesta; muestra N/total) / Cancelar
                            (deny). CONTRATO SDK (verificado en node_modules/@anthropic-ai/
                            claude-agent-sdk/sdk-tools.d.ts): se responde devolviendo
                            {behavior:'allow', updatedInput:{...input, answers:{"<texto
                            pregunta>":"<label>"}}} — clave = TEXTO de la pregunta, valor =
                            label elegido; multiSelect = labels SEPARADOS POR COMA. El campo
                            `answers` viaja end-to-end: chat-tab _send({...,answers}) → WS/HTTP
                            → chat.answerPermission(id,allow,answers) (saneado por
                            sanitizeAnswers de index.js: solo pares string→string, tope 4) →
                            runner {t:'perm',id,allow,answers} → materializa updatedInput.
                            answers. runner-link.send() reenvía el objeto entero, sin cambios.
                            Estilos .askq-* en style.css (borde --cwc-accent-cool para separar
                            "elegir respuesta" del amarillo de "riesgo" de un permiso normal).
                            Al responder, permission_closed colapsa la card a chip de registro
                            (Permitido/Denegado) igual que cualquier permiso.
                            CENTRO GLOBAL DE PERMISOS (pedido del usuario 2026-07-04: con
                            varios chats abiertos los permisos expiraban sin verse — solo
                            chats SDK, tmux quedó explícitamente AFUERA): las solicitudes
                            pendientes de TODAS las conversaciones se popupean desde
                            CUALQUIER pantalla (ui/perm-center.js, detalle en la sección de
                            public/js/ui/ abajo). Server: los pendientes se DERIVAN del
                            history (permission_request sin su permission_closed, SOLO con
                            motor vivo — pendingPerms() en Chat, cero estado duplicado;
                            sobrevive reinicios porque la reconexión a un runner vivo
                            reconstruye el history con hello.events) y viajan en info()/GET
                            /api/chat/list como pendingPerms[] {id,tool,summary,detail,ts,
                            expiresAt}. _engineDown emite permission_closed SINTÉTICOS
                            (reason 'engine_down') por los no respondidos — sin eso una vida
                            futura del motor los "resucitaría" y la tarjeta inline quedaría
                            clickeable para siempre. POST /api/chat/permission
                            {id,permId,allow} responde un permiso SIN WS adjunto (valida
                            permId ^p\d+$ y que siga pendiente — 409 si ya se respondió; usa
                            el MISMO answerPermission del camino WS). El runner sella `ts`
                            en cada permission_request; el server lo sella igual si falta
                            (runners vivos de antes del deploy). ChatTab re-emite los
                            permission_* como eventos window 'cwc:perm-request'/'cwc:
                            perm-closed' (exporta toolTypeIcon/isDestructiveCommand para el
                            popup). OJO: pollTabStatus (main.js) consulta /api/chat/list
                            aunque NO haya pestañas abiertas — el centro debe avisar de
                            chats lanzados desde otro dispositivo; no "optimizar" ese early
                            return de vuelta.
                            AUTO-TÍTULO con IA: en cada mensaje del usuario, sendUser dispara
                            _autoTitle → extractTitle (query() del SDK con HAIKU, maxTurns 1,
                            READ-ONLY doble capa regla 6 con TODA herramienta denegada) que
                            resume en ≤20 chars qué se está haciendo y renombra chat.title EN
                            PARALELO (jamás bloquea el turno; si falla queda el título viejo).
                            Guardas: throttle 20 s/chat + 1 en vuelo, mensajes <15 chars o
                            /comandos no re-titulan, chats con ticket (bugfixes) NO se tocan
                            (título curado "PR en progreso · TKT #n"). La UI lo levanta por
                            el poll de 8 s de main.js (pollTabStatus sincroniza header+chip
                            y dispara sessions-changed para las tarjetas). El renombre manual
                            sigue existiendo pero el próximo mensaje puede pisarlo (a
                            pedido: nombres siempre actualizados).
                            AutoTux v2 (2026-07-10, REDISEÑO tras revisión externa +
                            simulacros con datos reales — pedido del usuario "bajar el
                            consumo"): SUPERSEDE la lógica de DECISIÓN de las Fases 1-3 de
                            abajo (que quedan como historia). Núcleo reescrito en
                            core/model-router.js; docs/autotux-analisis-externo.md tiene el
                            diagnóstico completo. Problema medido en model-router-log.jsonl
                            (62 decisiones): v1 colapsaba en un flip-flop Sonnet↔Opus (49
                            subidas / 13 bajadas / 0 a haiku — "routing collapse"). CAMBIOS v2
                            ("shape seguro", ~12-18% de ahorro validado por simulacro
                            /tmp/autotux-sim*.js SIN riesgo de calidad): (a) FABLE PROHIBIDO —
                            fuera de MODEL_LEVELS (ahora ['haiku','sonnet','opus']) + guard
                            FORBIDDEN_AUTO en setModel (auto:true a fable ⇒ rechazado+log
                            'guard'; manual sigue OK). clampLevel() mapea fable→opus (chat que
                            vuelve de fable manual a 'auto') y opusplan/default→-1 (inerte) —
                            fix del bug de v1 (indexOf('fable') daba -1 con la escala nueva).
                            (b) Movimientos SIEMPRE ±1 (nunca saltos directos al techo: code
                            fence / mensaje largo ≥1200 ahora suben UN escalón, no a Opus). (c)
                            COOLDOWN de 2 turnos tras cada cambio (anti-rebote, estilo BGP
                            route-flap dampening): congela señales no-fuertes; la corrección
                            del usuario (strong_up) lo ROMPE. (d) NIVEL BASE (pegajoso,
                            persistido vía _routerDownStreak + _routerCooldown) separado del
                            OVERRIDE DE TURNO: un ack de CIERRE (perfecto/gracias/listo/
                            genial/buenísimo/excelente — CLOSING_ACK_RE) corre ESE turno en
                            Haiku sin tocar el base (turnOverride→0; _overrideRestore guarda el
                            base; _endTurnRouter lo restaura al pasar a 'waiting'). NUNCA en
                            go-aheads (dale/ok/sí — GOAHEAD_RE): cuentan como 'down' para el
                            base pero NO override, porque suelen DISPARAR trabajo y correr una
                            implementación en Haiku es frágil (hallazgo del simulacro TKT+PR).
                            (e) Escalada por EVIDENCIA de insuficiencia, no volumen
                            (insufficiencyEscalation, al cerrar el turno): ≥2 errores de tool
                            (tool_result con ok:false, contados en _turnToolErrors) o ≥10 tools
                            con ≥1 error ⇒ sube 1 escalón para el PRÓXIMO turno. La CORRECCIÓN
                            del usuario ("no funciona"/"está mal"/"sigue fallando" —
                            USER_CORRECTION_RE) es una etiqueta de calidad GRATIS: sube en el
                            acto (strong_up). Esto cumple "detectar que el modelo no alcanzó y
                            subir". EL AUTO-REDO AUTOMÁTICO DEL TURNO SE DESCARTÓ: en los
                            simulacros disparó 0 veces (o ya estás en Opus, o la corrección
                            escala un turno antes y gratis) — riesgo de auto-gasto sin
                            beneficio. (f) BAJADA POR INACTIVIDAD (idleDecayMove: idle ≥60 min
                            y base>sonnet ⇒ decae 1 escalón al reanudar). (g) CLASIFICADOR
                            RELATIVO (classifyRelative, reemplaza classifyComplexity): para
                            mensajes ambiguos pregunta a Haiku "dado que estás en X, ¿sobrado/
                            suficiente/insuficiente?" (deadband en 'suficiente', mucho más
                            estable que la clasificación absoluta de v1 que alimentaba el
                            yo-yo) → down/same/up; en SEGUNDO PLANO (fire-and-forget, gobierna
                            el próximo turno) + throttle (_routerClassifyThrottle: no
                            reclasifica por 2 turnos). LOGGING: logDecision suma fuentes
                            override/insufficiency/correction/idle/guard/classifier; logTurn
                            (nuevo, model-router-turns.jsonl) registra CADA turno con su nivel
                            para medir distribución + tasa de rebote (v1 solo logueaba
                            cambios). Test determinista del núcleo: bin/cwc-test-model-router.js
                            (42 asserts, sin SDK). Verificado en caliente: un chat 'auto' con
                            "perfecto" corre en Haiku y restaura a Sonnet (override→restore).
                            El requisito de un dueño de "Fable prohibido en el router" es AHORA
                            regla dura del núcleo. — Lo de abajo (Fases 1-3) es la historia del
                            diseño v1 que este bloque reemplaza en su LÓGICA (el andamiaje —
                            modelChoice, badge 🤖, setModel(auto), activación implícita — sigue
                            vigente):
                            ROUTER DE MODELO AUTOMÁTICO (2026-07-06, Fase 1, pedido del
                            usuario): decide solo si el turno necesita más o menos modelo,
                            escalando haiku→sonnet→opus→fable con MEMORIA de hilo (sube
                            fácil, baja con inercia) en vez de un modelo fijo por chat.
                            NÚCLEO puro en core/model-router.js (NO es un motor — mismo
                            estatus que core/tool-policy.js: plomería in-process consultada
                            EN VIVO, sin runner ni endpoints propios). sendUser llama a
                            _applyModelRouter(text) ANTES de mandar el turno:
                            decideModelForTurn() aplica una heurística 0-costo sobre el
                            TEXTO (mensaje trivial "dale"/"gracias" → baja; trae ``` código →
                            sube; muy largo ⇒ sube; ambiguo ⇒ no opina, no toca nada) con
                            HISTÉRESIS de dos umbrales: subir es inmediato (mismo turno),
                            bajar exige 3 turnos simples SEGUIDOS y de a UN escalón por vez
                            (nunca de un salto). El NIVEL nunca se duplica en un estado
                            propio: se deriva de `this.model` en cada turno; lo único que
                            persiste el Chat es el contador chico de histéresis
                            (`_routerDownStreak`, en persist()/rehydrate() junto al resto).
                            El cambio de modelo en sí reusa el setModel() de siempre (mismo
                            q.setModel() del SDK que ya usaba el selector manual) — CERO
                            plomería de cambio de modelo nueva. TECHO deliberado en `opus`:
                            la heurística de Fase 1 NUNCA sugiere `fable` sola (con solo 16
                            cambios manuales de /model en el historial real de esta consola
                            no había señal confiable para distinguir Opus de Fable — ver
                            core/model-router.js para el razonamiento completo); subir a
                            fable sigue siendo SOLO manual por ahora. ACTIVACIÓN IMPLÍCITA
                            sin UI nueva: el router SOLO gestiona un chat si su modelo
                            ACTUAL es exactamente haiku/sonnet/opus/fable — elegir
                            `opusplan`/`default` desde el selector (o no elegir nada) lo deja
                            INERTE a propósito, sin necesitar un toggle dedicado. Alcance:
                            SOLO el chat interactivo (los motores headless — triage/salud/
                            desk/auto-título — siguen con su asignación fija de siempre,
                            deliberadamente afuera). Fundamentos completos (research de
                            RouteLLM/FrugalGPT, análisis de costo real de transcripts propios
                            — clasificar con Haiku en cada turno es ~0,005% del costo —, y
                            minería de los cambios manuales de /model del propio usuario) en
                            la cabecera de core/model-router.js.
                            FASE 2 (mismo día, sumada al núcleo): clasificador Haiku para
                            turnos AMBIGUOS (decideModelForTurn devuelve `ambiguous:true` si
                            la heurística no opina) + escalado REACTIVO si un turno "no dio
                            abasto". OJO DE LATENCIA verificado EN CALIENTE: el solo arranque
                            de query() tarda ~2-3s antes de que Haiku conteste una palabra (en
                            la práctica, 4-8s totales) — MUY por encima de lo que un turno
                            puede esperar en línea. Por eso classifyComplexity()
                            (modules/chat/index.js, patrón defensivo idéntico a extractTitle:
                            1 turno, READ-ONLY doble capa, timeout+interrupt 20s) corre
                            SIEMPRE en SEGUNDO PLANO (fire-and-forget, guarda
                            `_routerClassifying` contra solapes) — nunca gobierna el turno
                            actual, sí el PRÓXIMO (o el actual si el motor todavía no arrancó
                            a responder). Mismo techo en `opus` que la heurística (nunca
                            sugiere fable). Escalado reactivo: `_turnToolCount` (efímero, NO
                            persiste) cuenta CUALQUIER tool_use del turno en curso
                            (_onRunnerEvent); al volver a 'waiting' (_setStatus),
                            _applyReactiveEscalation() sube un escalón si el turno usó ≥6 de
                            golpe (REACTIVE_TOOL_THRESHOLD en core/model-router.js) — señal
                            barata de "esto pesó más de lo esperado", 0 tokens extra, mismo
                            techo en opus.
                            FASE 3 (mismo día): VISIBILIDAD — badge "🤖 <modelo>" en el header
                            del chat (chat-tab.js `_applyModel`, único punto de entrada del
                            modelo a la UI — igual patrón que `_applyMode`), coloreado con
                            ui/models.js (modelColor/modelName — el alias haiku/sonnet/opus/
                            fable ES la key que esas funciones esperan). Oculto si el chat corre
                            opusplan/default/sin elegir (mismo criterio de "inerte" del
                            backend, replicado en `ROUTER_MANAGED_MODELS` del front — NO se
                            importa nada del server). `Chat.attach()` manda `model` en el
                            payload `history` para que nazca poblado; `Chat.setModel(model,
                            {auto})` (nuevo 2º parámetro, default false) tagea el evento
                            `{type:'model', model, auto}` — `auto:true` SOLO cuando lo decide
                            el router (`_pendingModelAuto` lo consume el eco 'model' del
                            runner vivo; el camino "motor dormido" lo taguea directo). Un
                            cambio con `auto:true` dispara una notita inline en el chat ("🤖 El
                            router cambió el modelo a X sin que hagas nada") — un cambio MANUAL
                            (selector de Sesiones, `POST /api/chat/model`) sigue sin nota,
                            como siempre. APRENDIZAJE — cada cambio que hace el router (los 3
                            orígenes: heuristic/classifier/reactive) se registra con
                            `logDecision()` (núcleo, `~/.cwc-data/model-router-log.jsonl`,
                            append-only con poda cruda a la mitad pasado ~2MB) — SOLO
                            observación para calibrar después con datos reales, patrón
                            "invariantes propuestos" de Salud: nada de esta fase decide ni se
                            relee sola; no hay UI de revisión todavía (pendiente de Fase 4 si
                            hace falta).
                            NOMBRE PROPIO + FORZADO REAL — "AutoTux" (2026-07-06, pedido del
                            usuario, Frente A de 2 — el Frente B, extender esto a sesiones TUI/
                            tmux, queda pendiente a propósito, ver más abajo): el router deja de
                            activarse implícitamente por elegir un alias crudo y pasa a ser una
                            ELECCIÓN EXPLÍCITA con nombre propio, separada del modelo real. Chat
                            suma `modelChoice` (QUÉ ELIGIÓ la persona: 'auto'=AutoTux | opusplan |
                            fable | opus | sonnet | haiku | default | null) — DISTINTO de `model`
                            (lo que corre DE VERDAD contra el SDK/CLI real, nunca 'auto': ese
                            sentinel es propio de la consola, VALID_MODELS de core/claude-model.js
                            son los únicos alias que el CLI real reconoce). `setModelChoice(choice)`
                            (chat/index.js) es la ÚNICA puerta: con 'auto' arranca desde el nivel
                            actual (o 'sonnet' si no hay uno gestionado) y AutoTux queda al mando
                            — `modelChoice` quedá en 'auto' PARA SIEMPRE, el badge nunca deja de
                            decir "AutoTux" aunque el nivel real suba/baje por debajo; con
                            cualquier otro valor FUERZA ese único modelo (setModel(choice) sin
                            auto) y apaga el router (_applyModelRouter/_applyReactiveEscalation
                            chequean `this.modelChoice !== 'auto'` primero, antes que nada).
                            `POST /api/chat/create` sin `model` en el body ahora defaultea a
                            'auto' (antes null): AutoTux es el predeterminado de TODA conversación
                            de Chat nueva. `POST /api/chat/model` acepta 'auto' además de
                            VALID_MODELS y delega a setModelChoice (antes llamaba a setModel
                            directo). Persistencia: `modelChoice` viaja en persist()/rehydrate()
                            igual que `_routerDownStreak`, EXPLÍCITO porque `model` solo no
                            alcanza para distinguir "elegí Sonnet a mano" de "AutoTux está en
                            Sonnet ahora". MIGRACIÓN: chats de ANTES de este cambio que ya tenían
                            un alias crudo elegido (activación implícita vieja) quedan con
                            modelChoice=ese mismo valor (forzados, router apagado) — hay que
                            elegir "AutoTux" a mano una vez para que vuelvan a tener router.
                            FUENTE ÚNICA del menú: `CHAT_MODEL_OPTIONS`/`ROUTER_MANAGED_MODELS`
                            en public/js/ui/models.js (AutoTux primero, "Opus plan" segundo —
                            renombrado, sin la palabra "Auto" para no confundirlo con el badge
                            🤖 — después Fable/Opus/Sonnet/Haiku/Default), consumida por
                            sessions.js (picker de chat, marca la opción ACTIVA contra
                            `modelChoice` con ✓, patrón `.sess-menu-item--active`) y
                            launcher.js (default de "Chat" nuevo). El picker de sesión TUI
                            (`pickModel` en sessions.js) y el tipo "Claude (TUI)"/"Terminal" del
                            lanzador usan `TUI_MODEL_OPTIONS`/`TUI_MODELS` — SIN 'auto' a
                            propósito: el CLI real de esas sesiones (`claude --model X` /
                            `/model X` tecleado) no conoce ese alias y rompería. El header del
                            chat (chat-tab.js `_renderModelBadge`) pinta `🤖 AutoTux: <nivel>`
                            con AutoTux, o el nombre plano (sin 🤖) con un modelo forzado; las
                            tarjetas de Sesiones usan el mismo criterio (`chatModelLabel()`).
                            FRENTE B (pendiente, mayor alcance/riesgo — toca `~/.claude/
                            settings.json`, GLOBAL a toda sesión de Claude Code de la máquina,
                            no solo las de este proyecto): llevar AutoTux también a sesiones TUI/
                            tmux. Requiere un hook `UserPromptSubmit` propio (heurística 0-costo
                            SOLO — un clasificador Haiku ahí bloquearía al usuario tipeando en la
                            terminal varios segundos) + estado por pane en `~/.cwc-data/autotux/`
                            + aplicar el cambio real (`tmux send-keys "/model X"`) recién cuando
                            la sesión queda OCIOSA (nunca a mitad de turno — mismo patrón ya
                            probado del "nudge" del interfono) + escalado reactivo vía hook
                            `PostToolUse` + un instalador PROPIO aditivo/reversible
                            (`bin/install-autotux.js`/`uninstall-autotux.js`, como exige la regla
                            dura del proyecto para tocar configuración fuera del repo). No
                            iniciado — queda documentado acá para cuando se retome.
                            DIAGRAMAS ```mermaid``` (2026-07-11, pedido del usuario "poder generar
                            diagramas desde el chat"): un bloque ```` ```mermaid ```` en la respuesta
                            del modelo se renderiza como SVG inline (flowchart/secuencia/ER/gantt/
                            arquitectura/etc.), no como texto. SOLO frontend, cero cambios de backend
                            — el render es 100% client-side en public/js/ui/markdown.js
                            (enhanceMermaidBlocks, se llama tras enhanceCodeBlocks en renderMarkdown).
                            VENDOR: `mermaid` (dependencia en package.json, patrón chart.js/marked/
                            hljs) — a diferencia de esos tres, Mermaid v10+ SOLO distribuye ESM (sin
                            bundle IIFE), así que se vendorea `dist/mermaid.esm.min.mjs` +
                            `dist/chunks/mermaid.esm.min/*.mjs` (sin .map, ~3.6 MB) a
                            public/vendor/mermaid/ y se carga con un `<script type="module">` propio
                            en index.html (el único vendor de este proyecto cargado como módulo) que
                            hace `import()` + `mermaid.initialize()` con el tema tomado de
                            `getComputedStyle` sobre los tokens `--cwc-*` (nunca hex duplicado) y
                            cuelga la instancia lista en `window.mermaid` + la promesa en
                            `window.mermaidReady` (markdown.js espera esta promesa antes de
                            renderizar — el script type=module se difiere, puede terminar después de
                            que llegue el primer mensaje). SEGURIDAD: el ALLOWLIST de sanitize() de
                            markdown.js NO se tocó (sigue sin permitir SVG/IMG crudos del modelo);
                            el SVG que se inserta lo genera el PROPIO PARSER de Mermaid
                            (`securityLevel:'strict'`) a partir de texto plano ya sanitizado, nunca
                            HTML libre del modelo — mismo criterio que ya se acepta para Chart.js en
                            el modal Uso. Degradación: sintaxis inválida, bloque de más de
                            MERMAID_MAX_LINES (400) líneas, o vendor sin cargar ⇒ cae al bloque de
                            código plano de siempre (nunca rompe el resto del mensaje). El código
                            fuente del diagrama queda SIEMPRE disponible pero COLAPSADO bajo un
                            `<details>` "Ver código Mermaid" debajo del SVG (convención "UI
                            colapsable" del proyecto). chat-tab.js escucha el evento
                            `cwc:mermaid-rendered` (bubbling, disparado al terminar el render async)
                            sobre `.chat-msgs` y re-llama `_scroll()` — mismo criterio "pinea abajo"
                            que ya usa el resto del chat, porque el diagrama aparece DESPUÉS de que
                            el mensaje ya está en el DOM y puede crecer la burbuja. Alcance: SOLO el
                            chat (`chat-tab.js` vía `_assistantFinal`) — Aprendizaje y Tareas siguen
                            usando `renderMarkdown(...).innerHTML` de forma SÍNCRONA (ver gotcha de
                            `renderMarkdown` más abajo), así que un diagrama ahí degrada al bloque de
                            código (el render de Mermaid es async y el `.innerHTML` ya se leyó antes
                            de que termine) — limitación conocida, no un bug nuevo.
                            ZOOM (click → modal, `openMermaidZoom` de markdown.js): el diagrama es
                            clickeable (`.md-mermaid--zoomable`) y abre una copia grande en el modal
                            genérico (ui/dialog.js). GOTCHA/FIX 2026-07-11: Mermaid deja un
                            `style="max-width:NNNpx"` INLINE en el SVG (tamaño chico para caber en la
                            burbuja); `svg.cloneNode(true)` conserva ese atributo y un style INLINE le
                            gana en especificidad a `.md-mermaid-zoom-body svg{max-width:none}` de
                            style.css → el diagrama quedaba diminuto arriba a la izquierda con el modal
                            casi vacío. Se pisa el estilo inline del clon por JS DESPUÉS de clonar
                            (`clone.style.maxWidth='none'` + width 100%/height auto — un set por JS
                            también es inline pero se aplica después, así gana al de mermaid). NO
                            depender solo del CSS externo para anular estilos inline que trae el vendor.
                            PREVIEW + AFFORDANCE "AMPLIAR" (2026-07-11, pedido de Niko: "el diagrama se
                            ve diminuto"). CAUSA RAÍZ real (verificada en vivo con Playwright sobre una
                            sesión con diagramas reales): un flowchart complejo tiene un viewBox grande
                            (ej. 1948×1342) y se ESCALA para caber al ancho de la burbuja (~570px) →
                            factor ~0.29 → el texto interno queda a ~5px, ilegible. NO es un bug de
                            código ni se arregla con "generá el SVG más grande" (un SVG es VECTORIAL,
                            no tiene resolución: a cualquier tamaño nominal, comprimido a 570px se ve
                            igual de chico) — es intrínseco a meter un diagrama ancho en una burbuja
                            angosta. El zoom (arriba) YA daba la versión legible, pero la ÚNICA pista
                            para ampliarlo era `cursor:zoom-in` — INVISIBLE en touch/móvil (no hay
                            hover ni cursor). SOLUCIÓN (enfoque "miniatura de adjunto", NO rasterizar a
                            PNG — se evaluó y descartó: perdía nitidez vectorial y sumaba plomería):
                            (a) el SVG va en un CANVAS interno `.md-mermaid-canvas` con `overflow:auto`
                            + `max-height` (340px desktop / 240px móvil) → un diagrama grande se muestra
                            como PREVIEW acotado (como la miniatura de una imagen adjunta) en vez de un
                            muro que ocupa media pantalla; (b) un BADGE `.md-mermaid-zoom-btn`
                            ("🔍 Ampliar", ícono `search` de icons.js) SIEMPRE visible pinneado a la
                            esquina sup-derecha (hijo directo del holder `position:relative`, FUERA del
                            canvas para no scrollear con él) — hace obvia la ampliación en móvil. El
                            badge hace `stopPropagation` (abre el zoom UNA vez; sin él, el click
                            burbujea al holder y se abrirían dos modales). Toda la caja sigue siendo
                            clickeable (holder). REGLA GENERAL derivada: un diagrama/imagen que se
                            comprime para caber NUNCA es legible inline — la respuesta es preview
                            acotado + affordance de ampliar SIEMPRE visible (no solo hover), nunca
                            "hacerlo más grande". Alternativas de diagrama-como-código (D2/Graphviz/
                            PlantUML/nomnoml) se investigaron y NO aportan: mismo problema de display,
                            mismo costo de tokens, y todas las buenas necesitan build/servidor (chocan
                            con "todo local, render client-side") — Mermaid sigue siendo la elección; el
                            ahorro real de tokens es usar ÁRBOL HTML/CSS o TABLAS para jerarquías/
                            comparaciones y reservar Mermaid para flujos con ciclos.
  files/ stats/ tmux/ admin/ health/
  learning/                 MÓDULO DE APRENDIZAJE (pestaña "🎓 Aprendizaje" del BANCO DE
                            CONOCIMIENTO — así se renombró la sección `tasks` en la UI, 2026-07-09,
                            pedido de Niko; `data-module` sigue siendo `tasks`). Registro PRIVADO de
                            los TEMAS que el dueño va aprendiendo/reforzando (instrucciones de Chris,
                            cómo funciona el backend, GetPad, GitHub, cómo proponer un fix). 1 tarjeta
                            = 1 tema {id LT<n>, title, area, scope (console|tolkien), status
                            (por-aprender|reforzando|dominado), priority, tags[], notes (markdown),
                            question, contextoEntradas[] ({id CX<n>, at, source ia|manual, text}),
                            explanation (material de estudio IA), explainModel, explainedAt,
                            explainFingerprint, explainFiles[], explainVersions[]}.
                            BACKEND MIGRADO A PAD LOCAL (2026-07-12, ROAD-110 Fase 2, parte del
                            cutover a self-host — ver el gotcha "MCP de Pad" más abajo): `store.js`
                            ya NO es file-based — sus 13 funciones de I/O son `async` y hablan contra
                            el Pad LOCAL (`src/core/pad-service-client.js`, workspace `console`,
                            colecciones `temas-de-aprendizaje`/TDA y `rutas-de-aprendizaje`/RDA). Un
                            tema = 1 item TDA; `routeId` → relación `parent` hacia una RDA;
                            `contextoEntradas`/`explanation`(+model/at/fingerprint/files/versions,
                            empaquetado en UN campo JSON) → custom fields tipo `json` del item. El LOG
                            de actividad (`listActivity`/`learning-activity.json`) y las funciones
                            puras `normScope`/`contextoText` NO se tocaron — siguen exactamente igual
                            (decisión de alcance). `learning.json` viejo queda como respaldo histórico,
                            ya no se lee. 6 consumidores migrados: `learning/index.js`,
                            `explain-shared.js`, `analyze-shared.js`, `tasks/analyze-shared.js`
                            (análisis cruzado), `chat/index.js` (write-back de "Profundizar en chat" +
                            2 regex de validación de `learningId`), y los runners
                            context/explain/analyze. La ÚNICA parte que consume tokens es "🎓
                            Explicame esto": corrida
                            IA que NAVEGA el CÓDIGO REAL (Read/Grep/Glob) del repo elegido por `scope`
                            (la consola o Tolkien vía config.projectDir) y AUTO-GUARDA una explicación
                            guiada en el tema (store.saveExplanation) como material editable/
                            regenerable. DESACOPLADA a `bin/cwc-learning-explain-runner.js` (lógica en
                            explain-shared.js; regla de oro) + READ-ONLY doble capa (regla 6: sonnet,
                            maxTurns 24, timeout 6 min, settingSources: [], allowlist
                            explainToolAllowed = Read/Grep/Glob/TodoWrite, Bash/Edit/Write/git/MCP
                            DENEGADO en las DOS capas; NUNCA escribe). Ruta /api/learning (auth; admin
                            SOLO en /:id/explain y /:id/context-analyze que gastan tokens): GET / · GET
                            /activity · GET /:id (+ `explainCheck` DERIVADO, ver abajo) · POST / · POST
                            /:id · POST /:id/delete · POST /:id/explain {force?} (spawn runner o noop,
                            dedup lock por job) · GET /:id/explain (poll, 0 tokens) · POST /:id/context
                            (agregar nota manual, 0 tokens) · POST /:id/context/:cid (editar entrada) ·
                            POST /:id/context/:cid/delete (borrar entrada — literal ANTES de la
                            paramétrica /:cid) · POST /:id/context-analyze (spawn runner) · GET
                            /:id/context-analyze/:jobId (poll, 0 tokens). Job en
                            ~/.cwc-data/learning-explain-<id>.json + learning-explain.log.
                            REGENERACIÓN INTELIGENTE + CONTEXTO ADICIONAL + VENTANA POR SECCIONES
                            (2026-07-10, pedido de Niko: "no quiero un documento — quiero secciones
                            organizadas, y que Regenerar no arranque de cero si no hace falta"). TRES
                            piezas nuevas:
                            (a) 🎙️ CONTEXTO ADICIONAL — LISTA de entradas (2026-07-10, pedido de Niko:
                            "que sea dinámico — que yo pueda sumar notas a mano además de las de la
                            IA"): `contextoEntradas[]` es una lista donde cada entrada {id CX<n>, at,
                            source 'ia'|'manual', text} es una tarjeta propia que NO se sobrescribe
                            (antes era un único string `contextoAdicional` que se pisaba — MIGRADO al
                            vuelo por normalizeTopic() en store.load: el string viejo se convierte en 1
                            entrada CX0 'manual'). DOS orígenes: "🎙️ Interpretar una charla" pegás una
                            transcripción y una corrida IA de TEXTO PURO (CERO herramientas, doble capa
                            regla 6 deniega TODO — `context-shared.js` +
                            `bin/cwc-learning-context-runner.js`, mismo patrón que
                            `tickets/context-analyze-shared.js` pero de alcance PROPIO, sin acoplar los
                            dos módulos) la interpreta y AGREGA una entrada 'ia'
                            (store.addContexto{source:'ia'}); "➕ Agregar nota" suma una entrada
                            'manual' a mano. Cada entrada se edita/borra individual
                            (addContexto/updateContextoEntry/deleteContextoEntry; cap 30, nuevas
                            primero). Job en ~/.cwc-data/learning-context-<jobId>.json (id
                            determinístico por tema+texto) + learning-context.log. En el frontend se
                            pintan como tarjetas con badge de origen (✍️ manual · 🎙️ IA) + fecha. Las
                            📝 Notas del tema pasaron a EDITARSE INLINE (textarea directo en el detalle,
                            sin abrir el form completo — botón ✏️). TODAS las entradas + las notas se
                            concatenan (store.contextoText) para la huella y el prompt de "Regenerar".
                            (b) 🔄 REGENERAR = UN SOLO BOTÓN inteligente (ya NO hay botones separados
                            de "explicación" vs "guía paso a paso": el prompt de explainPrompt() pide
                            TODAS las secciones de una sola pasada, incluida "Paso a paso" y "Errores
                            comunes" — catálogo completo: En una línea · Cómo funciona por dentro ·
                            Piezas clave · Cómo se conecta · Paso a paso · Errores comunes · Para tu
                            caso · Para reforzar). Antes de gastar tokens, el POST /:id/explain calcula
                            una HUELLA con `checkStaleness()` (explain-shared.js): huella de TEXTO
                            (sha1 de notes+question+contextoAdicional, `textFingerprint`) + huella de
                            CÓDIGO (mtime/size de los archivos que la IA reportó citar la última vez,
                            en un bloque ```files``` aparte del ```markdown```, parseados por
                            `parseFiles`/snapshoteados por `fileSnapshot`/comparados por
                            `codeFingerprint`). Sin cambios en ninguna de las dos ⇒ responde
                            `{status:'noop'}` SIN SIQUIERA SPAWNEAR EL RUNNER (0 tokens); con cambios y
                            ya había explicación ⇒ modo `'adapt'` (se le pasa la explicación ANTERIOR
                            completa en el prompt para que la actualice/amplíe en vez de arrancar de
                            cero, marcando qué cambió); sin explicación previa ⇒ `'full'`. El botón
                            fantasma "Forzar regeneración completa" (visible solo si ya hay
                            explicación) manda `{force:true}` e ignora la huella. `GET /:id` expone
                            `explainCheck` DERIVADO (nunca persistido) para que el detalle avise ANTES
                            de tocar el botón si conviene regenerar. Historial: antes de sobreescribir,
                            `saveExplanation()` empuja la versión vieja a `explainVersions[]` (cap 5) —
                            "releer lo que ya tenía" sin perderlo, visible en el detalle como
                            <details> "🕑 Versiones anteriores".
                            (c) VENTANA POR SECCIONES, no un documento: el frontend
                            (`learning.js` `splitSections`/`sectionIcon`) parte el markdown por cada
                            `## título` y pinta CADA sección como una fila-acordeón propia con ícono
                            (⚡🔧🧩🔗🧭⚠️🎯📌) — "En una línea" nace abierta (resumen), el resto
                            colapsado (UI colapsable + árbol, regla del proyecto). Investigado el
                            patrón contra NN/g e IxDF (progressive disclosure > un chorizo de texto
                            para contenido de estudio).
                            "💬 Profundizar en chat": botón en la fila de acciones del detalle
                            (visible si `ctx.openChat` está disponible — `tasks.js` se lo reenvía en
                            `learningCtx`, antes NO lo hacía) que arma un prompt con
                            notes+contextoEntradas+explanation y abre un chat en modo `plan` (cwd
                            'claude-web-console' o el `projectRel` de Tolkien según `scope`, mismo
                            patrón que `ticket-detail.js`) para repasar o directamente aplicar el tema
                            a código real. Sirve tanto para "profundizar" como para "trabajar esto" —
                            un solo botón, a pedido explícito de Niko.
                            WRITE-BACK AUTOMÁTICO del chat al tema (2026-07-10, pedido de Niko: "que al
                            cerrar el chat el historial vuelva solo y aumente el contexto"): el botón
                            pasa `learningId: t.id` a openChat → viaja por POST /api/chat/create (main.js
                            openChat lo reenvía) → el `Chat` lo guarda (`this.learningId`, validado
                            ^LT\d+$; persist/rehydrate para sobrevivir reinicios). Al CERRAR el chat,
                            `Chat.close()` — MISMO patrón diferido 2s/best-effort que el histórico de
                            tickets, con flag propio `_learningDone` — extrae un resumen DETERMINÍSTICO
                            (0 tokens, `extractSessionWork` de tickets/meta-store, reusado) y lo AGREGA
                            como entrada `source:'chat'` del tema vía `appendChatContext` de
                            learning/store.js (importada en chat/index.js como appendLearningChatContext).
                            Así la próxima "Regenerar" toma solo lo trabajado en el chat. Verificado E2E
                            (turno haiku real por WS → cierre → entrada 💬 aparece en el tema).
                            VENTANA DEL TEMA EN 3 PIEZAS + 2 COLUMNAS ASIMÉTRICAS (2026-07-10, pedido de
                            Niko: la ventana era chica y a 1 columna). Modal ancho `min(1080px, 94vw)`.
                            Estructura (`learning.js` render): (1) PIEZA SUPERIOR ancho completo = info
                            básica (id/título/chips/foco) + 📝 Notas (editable inline) + 🎙️ Contexto
                            adicional, ambas COLAPSABLES; (2+3) grid `.lt-detail-cols` de DOS columnas
                            ASIMÉTRICAS (desktop ≥860px: `minmax(0,1.7fr) minmax(0,1fr)`,
                            `align-items:start`; móvil se apilan): IZQUIERDA ANCHA `.lt-col-main` = "📖
                            Guía" = TODA la explicación renderizada DE CORRIDO en un documento formateado
                            (`.lt-guia-doc`, un solo `mdHtml(t.explanation)`) para leerla entera, + el
                            botón Regenerar + versiones; DERECHA ANGOSTA `.lt-col-side` = "🧩 Secciones" =
                            las MISMAS partes en un acordeón (`splitSections`) — NO son independientes,
                            son las piezas que componen la Guía de la izquierda. Ambas salen del MISMO
                            `t.explanation` (0 tokens extra; izquierda = leer de corrido, derecha =
                            navegar/enfocar). Acciones ancho completo abajo. La entrada de contexto
                            `source:'chat'` se pinta con badge 💬 (`.lt-cx-chat`), junto a 🎙️ IA y ✍️
                            manual.
                            APRENDIZAJE ASISTIDO (2026-07-10, pedido de Niko): (A) RUTAS de aprendizaje
                            {id LR<n>, title, description, status (activa|propuesta|completada|archivada)}
                            que AGRUPAN temas con PROGRESO % (temas dominados/total, DERIVADO al leer,
                            nunca persistido — igual que los PLANES de tasks); el tema gana `routeId`
                            (validado contra rutas existentes; borrar una ruta DESASIGNA sus temas). CRUD
                            síncrono en el mismo store.json (routes[]+routeSeq): GET /routes · POST /routes
                            · POST /routes/:id · POST /routes/:id/delete (literales ANTES de /:id). (B)
                            "🧠 Analizar aprendizaje" (admin, consume tokens): runner DESACOPLADO
                            `bin/cwc-learning-analyze-runner.js` (lógica en analyze-shared.js; texto puro,
                            0 herramientas — doble capa regla 6 deniega TODO, los temas viajan en el
                            prompt) que devuelve {resumen, duplicados, unificables, completar, agrupar (en
                            rutas), aprenderPrimero (orden sugerido), sugerirNuevos (gaps)}. POST /analyze
                            (spawn) · GET /analysis (poll, 0 tokens); estado en ~/.cwc-data/learning-analysis.json
                            (dedup por corrida fresca). Propuestas NUNCA auto-aplicadas: modal con
                            Aprobar/Descartar por ítem; aplicar reusa el CRUD (dup→delete · unif→update+delete
                            · comp→update notes/tags · agrupar→crea ruta si nueva + asigna routeId ·
                            sugerirNuevos→POST /). Frontend `public/js/modules/learning/learning.js`: NO es
                            sección de sidebar propia (patrón mountReports de audio) — exporta
                            mountLearning(container, ctx) y lo monta tasks.js como 5ª pestaña. Sección
                            colapsable "🗺️ Rutas" (barra de progreso, filtra la grilla por ruta) + grilla
                            de cuadritos (.lt-*) → detalle modal colapsable+árbol con la explicación en
                            markdown (renderMarkdown) + selector de ruta en el form. PUENTE Pendientes →
                            Banco: el botón "Reorganizar todo con IA" del tablero de Pendientes (análisis
                            HOLÍSTICO scope 'global', tasks/analyze-shared.js) ahora recibe los temas ya
                            existentes y devuelve además `crearTemas` — TEMAS DE APRENDIZAJE nuevos
                            derivados de lo que se está trabajando en las tareas/planes/informes; el modal
                            de reorganizar los muestra en "🎓 Temas de aprendizaje sugeridos" y "Crear tema"
                            hace POST /api/learning (kind 'createtema' en applyProposal).
  tasks/                    PENDIENTES: tablero PRIVADO de tareas de este proyecto (nada sale al
                            exterior, no se pushea). Versión simplificada de "Bugs & Features":
                            1 tarjeta = 1 tarea {id T<n>, title, description, status
                            (pendiente/en-progreso/hecha), priority (alta/media/baja), tags[],
                            source (manual|audio), sourceRef (jobId de audio), createdAt/
                            updatedAt/doneAt}.
                            BACKEND MIGRADO A PAD LOCAL (2026-07-12, ROAD-110 Fase 1, piloto del
                            cutover a self-host — ver el gotcha "MCP de Pad" más abajo): `store.js`
                            ya NO es file-based — sus 13 funciones de I/O son `async` y hablan contra
                            el Pad LOCAL (`src/core/pad-service-client.js`, workspace `console`,
                            colecciones `pendientes`/PEND y `planes`/PLAN, SEPARADAS a propósito de la
                            bitácora técnica del programa de modularización). `id` T<n> → `ref`
                            PEND-<n>; `planId` → relación `parent` hacia un PLAN; `blocks[]` →
                            relación `link_type=blocks`; `comments[]` → comentarios nativos del item.
                            El LOG de actividad (`listActivity`/`tasks-activity.json`) NO se tocó —
                            sigue exactamente igual (decisión de alcance, ya atómico). `tasks.json`
                            viejo queda como respaldo histórico, ya no se lee. Migración 1-vía ya
                            ejecutada: 61 tareas + 14 planes reales, 0 discrepancias. También migrado
                            `tasks/analyze-shared.js` (2º consumidor de store.js, análisis IA general).
                            FASE 2 ✅ (2026-07-06): (A) PLANES que agrupan tareas con
                            progreso % (id PLAN-<n>, secuencia planSeq; status active/proposed/
                            done/cancelled; taskCount/doneCount/pct DERIVADOS al leer, NUNCA
                            persistidos; borrar un plan DESASIGNA sus tareas, no las borra). La
                            tarea gana `planId` (validado contra planes existentes) y `type`
                            (task/idea/nota/feature). (B) LOG de actividad REAL persistido en
                            ~/.cwc-data/tasks-activity.json (append-only, poda a 300 eventos):
                            cada create/update/status/complete/delete de tarea Y plan registra un
                            evento {id,ts,kind,entity,refId,title,detail} — el panel "Actividad
                            reciente" lee ESTO (antes se derivaba de timestamps, sin historial).
                            Ruta /api/tasks (todo AUTENTICADO, sin admin — bloc privado del dueño):
                            GET / {tasks,counts,plans} · GET /activity {events} · GET /plans
                            {plans} · POST / (crear tarea) · POST /from-audio {jobId,tasks[]} ·
                            POST /plans (crear) · POST /plans/:id (editar) · POST /plans/:id/delete
                            · POST /:id (editar tarea) · POST /:id/delete · POST /analyze +
                            GET /analysis (análisis general IA, ver arriba) · comentarios/timeline
                            (ver "CAMPOS estilo Pad" abajo). OJO ORDEN: las rutas
                            literales /plans y /activity se registran ANTES de la paramétrica /:id
                            (valida ^T\d+$) para que Express no las capture como id; /plans valida
                            ^PLAN-\d+$. CAMPOS estilo Pad (2026-07-07, pedido del usuario, "nutrir
                            el detalle basándonos en GetPad pero simple"): la TAREA suma
                            owner/estimate/dueDate/comments[]/blocks[]; el PLAN suma
                            owner/phase/targetDate/comments[]/blocks[]. Todo se normaliza en
                            store.js (dueDate/targetDate = YYYY-MM-DD validado; blocks = ids
                            EXISTENTES T<n>|PLAN-<n>, sin el propio, tope 30 — pueden CRUZAR
                            tarea↔plan como en Pad); `blockedBy` NO se persiste, se deriva en el
                            front (quién te tiene en su blocks). COMENTARIOS append+borrar
                            (sin editar): POST /:id/comment {text} + POST /:id/comment/:cid/delete
                            (id ^C\d+-\d+$) y sus gemelos /plans/:id/comment[...]; addComment deja
                            además un evento 'comment' en el log. TIMELINE por ítem: GET
                            /:id/timeline · GET /plans/:id/timeline = merge de los comments del
                            ítem + los eventos del log con refId===id (excluye 'comment' para no
                            duplicar), desc. Las rutas /:id/timeline, /:id/comment[...] van al final
                            (tras las literales); sus gemelas /plans/:id/... ANTES de /plans/:id.
                            Se alimenta MANUAL y desde el módulo `audio`. Frontend
                            tasks.js: sección colapsable del sidebar
                            (semáforo + conteos) + TABLERO modal (openModal) con CUATRO PESTAÑAS
                            (.tk-tabs/.tk-tab, espejo visual de .bb-tabs del board de Bugs;
                            openBoard(initialTab), default 'panel' — OJO: el handler del botón
                            envuelve la llamada `() => openBoard()` para NO pasar el PointerEvent
                            como initialTab): (1) 📊 PANEL = DASHBOARD estilo Pad alimentado 100%
                            con datos LOCALES (0 tokens, todo DERIVADO en el front) — Pad es solo el
                            REFERENTE de diseño, NUNCA la fuente (pedido del usuario 2026-07-06).
                            Secciones colapsables (.dash-sec, regla de UI árbol). ORDEN (pedido del
                            usuario 2026-07-06): 🗂️ Clasificación PRIMERO y abierta (resumen de todo:
                            conteos Tareas/Planes/Informes/Sesiones + pills por tipo + top tags) · 🔥
                            En curso (tareas en-progreso + chats de trabajo de /api/chat/list con
                            status==='working'||delegating) · ⚠️ Necesita atención (en-progreso
                            estancadas >3d sin update + alta prioridad sin arrancar) · ⏭️ Seguí por
                            acá (top 3 por prioridad+antigüedad) · 📊 Planes activos (barra de
                            progreso % por plan active/proposed) · 🕑 Actividad reciente (LOG REAL de
                            /api/tasks/activity + análisis de audio). Un ítem con [data-goto] salta a
                            Tareas, [data-goto-plan] a Planes.
                            (2) 📋 TAREAS = CUADRITOS EN COLUMNAS estilo Bugs v2 (.task-grid,
                            columns:3 240px masonry; 1 col en móvil ≤640) + filtros Activas/Todas/
                            Hechas. Cada cuadrito (.task-cardv2) nace CONTRAÍDO (tipo+id+prioridad+
                            estado+título+chip de plan) y al CLIC abre el DETALLE en VENTANA NUEVA
                            (modal openTaskDetail: chips, descripción, tags, fechas + acciones
                            avanzar/editar/eliminar; role=button + Enter/Espacio) — pedido del usuario
                            2026-07-06 (antes eran filas .task-item expandibles inline). alta/edición
                            por taskForm con Tipo+Plan. (3) 🗺️ PLANES = planCard colapsable con barra
                            de progreso, subtareas del plan y editar/eliminar (planForm); "Nuevo plan"
                            arriba. (4) 🎙️ INFORMES = mountReports() del módulo audio (ver abajo).
                            Escucha el evento `tasks-changed` del bus (lo dispara audio al crear
                            tareas) para refrescar. FASE 2 ✅ (Planes + log real + tipos) + rediseño
                            de Tareas a cuadritos+modal y Panel con Clasificación primero (2026-07-06).
                            ANÁLISIS GENERAL IA (2026-07-07, pedido del usuario): botón "🧠 Análisis
                            general" (admin, consume tokens) en las pestañas 📋 Tareas y 🗺️ Planes.
                            Corre el motor `tasks/analyze-shared.js` + runner desacoplado
                            `bin/cwc-tasks-analyze-runner.js` (regla de oro; regla 6: sonnet, 1 turno,
                            CERO herramientas — los datos se juntan EN NODE y viajan en el prompt,
                            nunca lee/escribe disco). scope='tasks'|'plans': junta TODAS las tareas (o
                            planes) + los INFORMES de audio (summary/tareas propuestas/plan) y devuelve
                            {resumen, duplicados[{keep,remove[]}], unificables[{ids[],title,description}],
                            completar[{id,description,tags[]}]}. Estado persistido por alcance en
                            ~/.cwc-data/tasks-analysis-<scope>.json (patrón audio: status running/done/
                            error + dedup por corrida fresca, NO hay lock aparte); POST
                            /api/tasks/analyze {scope} (admin) arranca+responde YA · GET
                            /api/tasks/analysis?scope=... solo lee disco (0 tokens); el front encuesta.
                            Las propuestas NUNCA se auto-aplican: el modal (tasks.js openAnalysis,
                            colapsable/árbol) las muestra por sección y cada una tiene Aprobar/Descartar;
                            APLICAR reusa el CRUD determinístico existente (dup→delete los remove ·
                            unif→update el 1º con título/detalle fusionado + delete el resto ·
                            completar→update description/tags) — endpoints /api/tasks/:id vs
                            /api/tasks/plans/:id según scope. Al cerrar, si aplicó algo, recarga el
                            tablero. FASE 3 pendiente (anotada): más tipos de Collection tipo Pad
                            (Docs/Feedback/Roadmap) si hacen falta.
                            6 COLUMNAS en la pestaña Tareas (2026-07-07, pedido del usuario: antes 3
                            con min 240px): .task-grid pasó a `columns: 6` FIJAS (sin min-width ⇒
                            NUNCA scroll horizontal, los cuadritos se angostan) + breakpoints
                            5/4/3/2/1 (1100/900/700/520/380px).
                            DETALLE ENRIQUECIDO estilo Pad (2026-07-07): tareas Y planes abren el
                            MISMO modal `openDetail(kind, item)` (openTaskDetail/openPlanDetail son
                            wrappers) — antes el detalle de tarea era plano y el plan ni tenía modal
                            (era un <details> inline; ahora la tarjeta de plan trae botón "Abrir").
                            Secciones colapsables (regla UI árbol): 🍞 BREADCRUMB navegable
                            (Pendientes / Planes / [PLAN si la tarea tiene] / ID; los links cierran el
                            modal y saltan de pestaña o abren el plan) · ⚙️ PROPIEDADES en grilla
                            (tarea: estado·prioridad·tipo·owner·estimación·fecha · plan: estado·fase·
                            fecha·owner·progreso) · 📝 DESCRIPCIÓN en MARKDOWN (renderMarkdown de
                            ui/markdown.js, el mismo sanitizado del chat) · 🔗 RELACIONES (tarea:
                            "Parte del plan" · plan: "Hijos X/Y" = sus tareas · ambos: "Bloquea a"
                            editable con picker de búsqueda [＋] y quitar [✕], "Bloqueado por"
                            derivado read-only; los chips son navegables → abren ese ítem) · 🕑
                            TIMELINE + COMENTARIOS (GET /:id/timeline: eventos del log + comentarios;
                            composer con Ctrl+Enter, borrar por comentario). Patrón de refresco:
                            `mutate(fn)` aplica el cambio, marca dirty, hace boardApi.reload (recarga
                            las arrays tasks/plans del board) y re-renderiza el modal con el ítem
                            fresco (o cierra si se borró); el listener del modal está delegado UNA vez
                            (no por render). taskForm suma owner/estimación/fecha objetivo; planForm
                            suma owner/fase/fecha objetivo. Estilos .tk-detail/.tk-crumb/.tk-sec/
                            .tk-props/.tk-md/.tk-rel*/.tk-tl* en style.css.
  audio/                    EXTRACCIÓN DE AUDIO: cargás una TRANSCRIPCIÓN (ya pasada a texto,
                            NO hay speech-to-text acá) y la IA interpreta quién dijo qué y por
                            qué, clasifica cada tramo (accion/plan/decision/problema/pregunta/
                            info), resume, arma un PLAN y PROPONE tareas → módulo `tasks` con la
                            aprobación del usuario. CONSUME TOKENS ⇒ RUNNER DESACOPLADO
                            (bin/cwc-audio-runner.js, regla de oro) + READ-ONLY blindado (regla 6:
                            sonnet, 1 turno, CERO herramientas — las dos capas PreToolUse+
                            canUseTool deniegan TODO; el texto viaja entero en el prompt, nunca
                            lee/escribe disco). shared.js: jobs en ~/.cwc-data/audio/<id>.json (id
                            DETERMINÍSTICO por contenido: reintento reusa el MISMO job, no gasta
                            de nuevo; poda >30 días) + prompt + parseo + spawn detached, patrón
                            projects/analyze-shared+commitmsg-shared. TÍTULO GENERADO POR IA
                            (pedido del usuario 2026-07-06): el prompt pide un `title` corto
                            (parseAudio lo extrae) y el runner lo aplica al job si titleAuto (el
                            usuario ya NO escribe el título a mano — se quitó el input del panel);
                            el `id` del job pasó a depender SOLO de la transcripción (audioJobId
                            ignora el título, que ya no es identidad). EDITABLE después: POST
                            /:id/title fija titleAuto=false; en el front se edita INLINE (✏️ →
                            input → Enter/blur guarda, Esc cancela; .au-titlebar). Ruta /api/audio:
                            GET / (historial liviano) · GET /:id (transcript+result) · POST /analyze
                            (ADMIN, arranca el runner, responde YA) · POST /:id/title (ADMIN, editar
                            título) · POST /:id/delete (admin). El
                            front encuesta GET /:id (0 tokens). Frontend audio.js: NO es sección
                            de sidebar propia (pedido del usuario) — exporta openAudioPanel(ctx) y
                            lo abre el módulo `tasks` (Pendientes) con un botón admin. El panel
                            modal: pegar transcripción → Analizar con confirm de tokens →
                            resultado en ÁRBOL colapsable (resumen · tareas propuestas con "Crear
                            tarea"/"Crear todas" · segmentos · plan · hablantes · historial de
                            análisis previos). YA-CREADAS (2026-07-07, pedido del usuario):
                            renderResult es ASÍNCRONA y antes de pintar consulta GET /api/tasks →
                            filtra las tareas de ESTE informe (source=audio + sourceRef=jobId) y
                            marca por TÍTULO exacto las propuestas ya creadas: chip "✓ Ya creada"
                            en vez del botón "＋ Crear tarea" (.au-task--done/.au-task-already) y, si
                            TODAS están, "Crear todas" nace deshabilitado. PASAR A PLAN (mismo pedido):
                            botón "🗺️ Pasar a plan" en el head del bloque de tareas propuestas →
                            crea un PLAN (título del audio, detalle=summary) y todas las propuestas
                            como tareas ASIGNADAS a ese plan (POST /plans + /from-audio con planId por
                            ítem; createTask valida el planId). renderResult toma un 5º arg `dialog`
                            (confirm del "Pasar a plan"); los 3 call sites (analyze/openExisting/
                            mountReports) lo pasan. renderResult ahora incluye un bloque 🧾 RAW
                            colapsado (.au-raw): el CRUDO del procesamiento = transcripción
                            original + JSON interpretado (el "producto" es el render lindo, el raw
                            es lo crudo; pedido del usuario 2026-07-06). Además audio.js exporta
                            mountReports(container, ctx) — la PESTAÑA 🎙️ Informes del tablero de
                            Pendientes: cada audio procesado como un INFORME colapsable (.au-report,
                            regla de UI árbol) que al expandir hace GET /:id y renderiza el
                            resultado con el botón raw. wrapBusReload envuelve el bus para refrescar
                            la lista de informes tras un análisis nuevo. OJO: `audio` (interpretar
                            reuniones) ≠ `--cwc-cat-audio` (categoría de archivo)
  retro/                    MEJORA CONTINUA (ROAD-256, etiqueta UI "Mejora Continua"): meta-
                            aprendizaje de PROCESO. Al CERRAR CUALQUIER chat (Chat.close,
                            diferido 2s, GLOBAL — no solo ticket/tema), si supera un FILTRO
                            HÍBRIDO determinístico (shared.js queueRetroDistill: lee el
                            transcript jsonl con 0 tokens y exige tocó código ∨ ≥3 turnos de
                            usuario ∨ fue ticket/tema — los chats triviales NO gastan tokens),
                            encola una destilación de LECCIONES DE PROCESO (metodología/flujo/
                            instrucciones para trabajar mejor — NO bugs de código, NO resumen
                            de qué se hizo). Ejemplos: "leer la doc oficial ANTES de integrar
                            una herramienta nueva", "testear el cambio antes de cerrarlo".
                            CONSUME TOKENS ⇒ RUNNER DESACOPLADO (bin/cwc-retro-runner.js, regla
                            de oro) + TEXTO PURO read-only doble capa (regla 6: sonnet, maxTurns
                            1, settingSources [], PreToolUse deny + canUseTool deny — CERO
                            herramientas; la transcripción condensada viaja en el prompt). El
                            runner, tras destilar, hace el UPSERT determinístico en Pad local
                            (NO es tool del modelo — HTTP desde Node, como audio escribe su job).
                            STORE = Pad LOCAL (store.js, workspace 'console', colección
                            'mejora-continua'/MC, molde de learning/store.js: async, read-modify-
                            write). 1 lección = 1 item {status propuesta|aprobada|promovida|
                            descartada · category regla|convencion|metodologia|procedimiento|
                            herramienta|nota · project console|tolkien|otros · destination
                            (sugerido) memoria|claude-md|contexto|playbook|registro · recurrence
                            · confidence · fingerprint · sourceChats[] · content=Observación/
                            Lección}. RECURRENCIA = PRIORIDAD: una lección repetida NO se
                            duplica, sube su contador (dedup por fingerprint = sha1 de
                            categoría+título normalizado). OJO (gotcha resuelto en la verificación
                            E2E): el fingerprint por título es FRÁGIL — el modelo reformula el
                            mismo concepto distinto y crea near-duplicados; por eso el runner le
                            pasa al modelo las lecciones YA REGISTRADAS y le pide reusar el título
                            EXACTO de un concepto repetido (patrón "dedup vs seen" del loop de
                            Salud) → recién ahí el fingerprint coincide y mergea. NADA se
                            auto-aplica: el humano APRUEBA/DESCARTA y PROMUEVE. PROMOVER (admin)
                            enruta a un DESTINO real vía retro/promote-shared.js (ROUTER,
                            Fase 2/ROAD-256). Destinos cableados (PROMOTE_TARGETS): (a) memoria =
                            append de la lección a la nota mejora-continua.md en memory/ del
                            proyecto (console=ROOT · tolkien=config.projectDir) + línea en el
                            índice MEMORY.md, reusando projects/memory.js (whitelist + escritura
                            atómica + guard de hash); (b) claude-md = SECCIÓN GESTIONADA dedicada
                            con marcadores `<!-- cwc:mejora-continua:start/end -->` en el CLAUDE.md
                            del proyecto (console) o en CLAUDE.local.md (tolkien, NO versionado →
                            no se filtra al repo del equipo). Se RENDERIZA desde el CONJUNTO de
                            lecciones promovidas a claude-md (idempotente, patrón syncToTolkien de
                            tickets/context-store.js) → NUNCA toca lo de AFUERA de los marcadores
                            (Reglas duras/Convenciones a mano — verificado E2E). markPromoted
                            (store.js) sella status promovida + promotedTo + snapshot
                            recurrenceAtPromotion/promotedAt (campos del schema, ya listos para el
                            LOOP de Fase 6). La próxima sesión auto-carga el destino. DESTINOS
                            COMPLETOS del router (PROMOTE_TARGETS): contexto (Fase 3) = apéndala al
                            bugfix-work/pr (getContext/saveContext de tickets/context-store.js) →
                            se inyecta en chats de ticket/PR y se ESPEJA a la CLAUDE.local.md de
                            Tolkien (idempotente por id) · playbook (Fase 4) = crea un item DRAFT
                            en la colección `playbooks` de Pad (pad-service-client.createItem). Solo
                            memoria/claude-md exigen dir de proyecto (TARGETS_NEED_DIR); contexto/
                            playbook no. CURADURÍA IA (Fase 5): runner desacoplado
                            bin/cwc-retro-curate-runner.js (lógica curate-shared.js, TEXTO PURO
                            regla 6; el server junta lessons + hardRulesText() en el job) que
                            detecta duplicados (dedup SEMÁNTICO, más allá del fingerprint),
                            contradicciones, redundantes (ya en una Regla Dura), consolidables y
                            huecos. Propuestas NUNCA auto-aplicadas: apply reusa el CRUD
                            (merge=mergeLessons suma recurrencia+chats y borra · dismiss=setStatus
                            descartada · consolidate=upsertLesson+delete). LOOP QUE APRENDE (Fase
                            6): computeEffectiveness (store.js, DERIVADO 0 tokens) sobre una
                            lección promovida = {state, hits, ageDays} donde hits = recurrencias
                            NUEVAS desde promotedAt → observando | efectiva (≥7d sin reincidir) |
                            reincide (volvió a pasar pese a promovida → la UI re-ofrece promover =
                            "⬆️ Escalar" a un destino más fuerte).
                            Ruta /api/retro (auth; PROMOVER/CURAR requieren admin, tocan memorias/
                            CLAUDE.md/tokens): GET / {lessons,counts} · GET /activity · GET /targets
                            {destinos} · POST /curate (admin, spawn curaduría) · GET /curation
                            (poll) · POST /curate/apply {action:merge|dismiss|consolidate} (admin) ·
                            GET /:id · POST /:id/approve · POST /:id/dismiss · POST /:id/promote
                            {target?,kind?} (admin; target ∈ memoria|claude-md|contexto|playbook) ·
                            POST /:id/delete. OJO ORDEN: /activity, /targets, /curate, /curation,
                            /curate/apply literales ANTES de la paramétrica /:id. Estado
                            file-based del job en ~/.cwc-data/retro/<id>.json (id sha1 del
                            sessionId; dedup: no re-gasta si ya done/fresco) + retro.log +
                            retro-activity.json (log local append-only). Frontend
                            public/js/modules/retro/retro.js: sección de sidebar IZQUIERDA
                            (data-module="retro", tras comms) con badge de propuestas + tablero
                            modal colapsable+árbol (.mc-* en style.css) que agrupa por estado.
                            UX SIMPLIFICADA (2026-07-12, pedido de Niko: el tablero abrumaba con
                            ~7 botones por lección). Modelo mental de UNA decisión por lección:
                            grupos "🟡 Nuevas · 🔖 Guardadas para después · ✅ Adoptadas · 🗑️
                            Descartadas". Una lección nueva muestra solo: (a) botón PRIMARIO
                            "👍 Adoptar → <destino sugerido>" que aplica el `destination` que la IA
                            ya sugirió (adoptBlock; el destino se resalta con NOMBRE HUMANO —
                            TARGET_LABEL: 📓 Recordatorio · 📕 Regla permanente · 🎫 Guía tickets/PRs
                            · 📘 Procedimiento) + un "▾" que revela los otros destinos aplicables
                            (data-act=more togglea .mc-dests[hidden]; applicableTargets filtra:
                            memoria/claude-md solo si el proyecto tiene dir); (b) "🔖 Guardar" (=
                            estado 'aprobada' reetiquetado "guardar para después", POST /:id/approve);
                            (c) "👎 Descartar". "Adoptar" ES la aprobación (el viejo botón "Aprobar"
                            suelto se eliminó por confuso). Adoptadas: badge de efectividad (Fase 6)
                            + "⬆️ Escalar" solo si reincide. Descartadas: "↩️ Reabrir" (POST
                            /:id/reopen → 'propuesta') + "✕ Eliminar" (permanente, solo acá).
                            Eliminar ya NO aparece en las demás. La CURADURÍA es mantenimiento
                            APARTE: botón "🧹 Ordenar el registro" arriba (no por-lección). NO
                            confundir con learning/ (🎓 Temas de aprendizaje = estudio de Niko):
                            retro = el SISTEMA aprende a mejorar su propio proceso
  interfono/                INTERFONO entre sesiones: panel + canal HUMANO. Solo LEE el bus
                            (core/bus.js) — 0 tokens. GET /api/interfono (directory + messages +
                            claims con verdict de evaluateClaim + ts) · POST /send {to,text}
                            (mensaje manual desde la web a una sesión o 'all') · POST
                            /claim-release {file} (admin, libera un claim zombi a mano). La
                            mensajería/claims AUTOMÁTICOS NO pasan por acá: los generan los hooks
                            de Claude Code (bin/cwc-bus.js). Frontend: pestaña "Interfono" del
                            menú ⚙ Sistema (system/interfono-panel.js).
                            ENTREGA AL CHAT (2026-07-06, pedido del usuario: el chat visual es
                            la superficie PRINCIPAL de trabajo, la TUI es backup): una TUI recibe
                            el mensaje por un nudge send-keys que la despierta en vivo, pero un
                            chat del SDK solo lo "ve" al tomar un turno (el hook-inject de
                            bin/cwc-bus.js corre en UserPromptSubmit — settingSources: ['user']).
                            Esa brecha la cierra el MÓDULO chat (no éste): un watcher server-side
                            (~12 s, ChatManager._deliverInterfono) AUTO-ENTREGA el mensaje a los
                            chats ABIERTOS (algún cliente WS) y OCIOSOS (alive+waiting) inyectando
                            un turno sintético con el texto (Chat.deliverInterfono → marca
                            entregado en el bus ANTES de disparar el turno para que el hook-inject
                            del mismo UserPromptSubmit no lo duplique — paridad con el nudge idle
                            de la TUI). Los chats dormidos/ocupados/sin pestaña NO se despiertan
                            solos (0 tokens fantasma): quedan para el POPUP GLOBAL
                            (public/js/ui/interfono-center.js) alimentado por pendingInterfono[]
                            de /api/chat/list (poll 8 s) con botones ▶ Retomar (POST
                            /api/chat/interfono {action:'deliver'} — inyecta y DESPIERTA a
                            demanda) y ✕ Descartar ({action:'dismiss'} — marca entregado sin
                            actuar). El chat consume el bus SOLO leyendo (pendingFor/markDelivered)
                            REDISEÑO DE LA CAPA DE NOTIFICACIÓN (2026-07-10, pedido del usuario:
                            "que el interfono funcione por backend, sin preguntarme retomar/
                            descartar, y que solo se entere la ventana realmente afectada" — el
                            popup modal aparecía en TODAS las ventanas del navegador y era ruido
                            con varias sesiones abiertas). Se hizo tras análisis externo
                            (docs/interfono-analisis-externo.md → docs/plan-rediseno-interfono-v01.md,
                            adaptado). CUATRO fases:
                            (F0 · IDENTIDAD + BITÁCORA) `src/core/interfono-log.js` (nuevo): bitácora
                            append-only JSONL en ~/.cwc-data/session-bus/delivery-log.jsonl (poda a
                            la mitad ~2 MB, patrón model-router-log; fail-open total) que registra
                            CÓMO llegó cada mensaje al humano (ROUTES: auto-deliver/tui-nudge/
                            hook-inject/badge/popup-shown/popup-resume/popup-dismiss/expired) —
                            materializa "nada se pierde en silencio". `logDelivery` se llama en
                            deliverInterfono/consumeInterfono (chat) y tryNudge/hook-inject
                            (bin/cwc-bus.js). ADEMÁS arregla el `from: null` de los mensajes de un
                            chat: el runner ahora hereda CWC_SELF_HANDLE=claude:<sessionId>
                            (runner-link.spawnRunner recibe `selfHandle`; chat/index _startEngine lo
                            pasa cuando ya hay sessionId — resume/reopen; selfIdentity de cwc-bus.js
                            lo lee PRIMERO). El primerísimo arranque de un chat nuevo aún no tiene
                            sessionId y cae al fallback (from null), sin regresión.
                            (F1 · SCOPING CLIENTE) el popup global (interfono-center.js) recibe de
                            main.js un 2º predicado `isChatRelevant = (id) => tabs.has(id)`: una
                            ventana SOLO crea tarjeta para chats que ESA ventana tiene abiertos —
                            mata el ruido cross-ventana (antes syncFromList creaba tarjeta en TODA
                            ventana desde /api/chat/list y solo la ocultaba en render()).
                            (F2 · POPUP → SEÑAL PASIVA) se retiró el modal "Retomar/Descartar" como
                            superficie por defecto: ahora un chat con mensajes sin tomar muestra un
                            BADGE pasivo (contador + ícono relay, `.sess-interfono`) en su tarjeta de
                            "Sesiones" (sessions.js syncInterfonoBadge, alimentado por el
                            pendingInterfono[] de /api/chat/list que se mantiene a propósito); al
                            tocarlo, un popup con preview + "Entregar" (confirm por consumo de tokens
                            antes de despertar un chat dormido) / "Archivar". El panel Sistema →
                            Interfono suma la vista "Bitácora de entrega" (GET
                            /api/interfono/deliveries?limit=N, solo lee el JSONL, 0 tokens). El centro
                            de popups (interfono-center) queda SOLO para mensajes `active` (ver F4).
                            (F3 · PUSH DIRIGIDO SERVER-SIDE) en vez de construir windowId+rooms desde
                            cero, se REUSA el primitivo que ya existe: Chat._broadcast sobre
                            this.clients llega SOLO a las ventanas que tienen ESE chat abierto.
                            Chat.signalInterfono() empuja {type:'interfono', pending} por ahí; el
                            watcher lo llama para chats ABIERTOS-pero-ocupados (los ociosos siguen
                            con auto-entrega; los dormidos/sin-pestaña con el badge del poll).
                            chat-tab.js re-emite el evento como window `cwc:interfono` (patrón de
                            perm-center) y el centro lo consume para adelantar/retirar el aviso
                            `active` al instante (el poll de 8 s queda de red de seguridad). NO se
                            retiró pendingInterfono de /api/chat/list (desvío deliberado del plan
                            §3.5): el badge pasivo de Sesiones lo necesita como ESTADO — un badge
                            global en una lista NO es ruido, a diferencia del popup.
                            (F4 · NIVELES passive/active) `bus.levelForKind(kind)` es la FUENTE ÚNICA
                            (sin IA, R1): kind 'heads-up' (colisión real — otra sesión editó un
                            archivo que reservabas, releelo) ⇒ `active`; todo lo demás (notes,
                            broadcasts) ⇒ `passive`. sendMessage sella `level` (default por kind;
                            mensajes viejos sin level ⇒ passive en los lectores). pendingInterfono
                            expone `level`; el centro de popups SOLO surfacea `active` (scoped +
                            relevante); el badge de Sesiones toma acento de alerta (--cwc-warn,
                            `.sess-interfono--active`) si algún pendiente es active. La bitácora
                            registra `level`. R3 intacta: evaluateClaim y sus umbrales NO se tocaron.
  comms/                    COMUNICACIONES: motor TRANSVERSAL file-based (patrón Interfono)
                            que recopila/indexa/contextualiza las comunicaciones con cada
                            CONTACTO (eje primario = usuario; Chris `cswenor` es el seed —
                            escala a muchos usuarios sumando entradas, cero código). Estado
                            100% en ~/.cwc-data/comms/ (0 tokens, sobrevive reinicios). Ruta
                            /api/comms. index.js SOLO lee/escribe disco + lanza el runner;
                            shared.js: contactos/proyectos/manual/overrides + buildIndex()
                            (merge determinístico github.json+manual.json → hilos con
                            newFromContact/awaitingReply derivados) + lock/heartbeat. Fuentes:
                            GitHub vía gh (runner, reviews/comentarios sobre Tolkien, 0
                            tokens) + Teams (DMs vía MCP graph_* read-only, bajo botón, tokens)
                            + chatbot (chatbot.json, source:'chatbot': comunicaciones de Chris
                            RELAYADAS por el bot Tolkien/TheEye en Teams — "Chris disfrazado de
                            Tolkien"; el bot es código nuestro en ~/tolkien apps/api/src/lib/teams,
                            pero la fuente COMPLETA del chat es Graph MCP, no la DB de Tolkien que
                            solo guarda el lado entrante; escáner de Graph = fase futura, hoy
                            seedeado/registrado a mano) + manual (CLI/web). Un hilo = 1 PR ×
                            contacto o 1 nota
                            manual. El tablero (public/js/modules/comms/board/, gemelo de
                            bugs/board: store/render/actions/polls) tiene pestañas primarias
                            = CONTACTOS, agrupa por proyecto→hilo→mensajes (los hilos
                            source:'chatbot' van en su propia sección "🤖 Chatbot" SIEMPRE
                            visible en la vista del contacto, aparte de los grupos de proyecto),
                            y "Hablar de
                            esto" abre un chat asistido con el hilo inyectado (patrón
                            doWorkOn). Escaneo bajo botón (gh, sin tokens); NO usa MCP/Desk
                            todavía (fase futura). OJO: `comms` (comunicaciones con personas)
                            ≠ `interfono` (mensajería entre sesiones de Claude).
  bugs/                     (ANTES `tickets`, renombrado 2026-07-03) backend del hub
                            "Bugs & Features" del sidebar: triage de bugs BAJO DEMANDA
                            (consume tokens; admin). Ruta HTTP /api/bugs (GET estado, POST
                            /refresh). La corrida vive en un RUNNER DETACHED
                            (bin/cwc-triage-runner.js, patrón chat-runner): un reinicio del
                            server a mitad de triage NO la mata. Interfaz server<->runner en
                            shared.js: los archivos de runtime CONSERVAN el nombre
                            `tickets.json` (resultado) + `triage.lock` a propósito — describen
                            el DATO (tickets [Tolkien Bug] de Desk), no el módulo, y renombrar
                            la caché perdería el triage (que cuesta tokens regenerar).
                            DOS FASES EN PARALELO (optimización IA 2026-07-05; antes UNA
                            query() serial de 6 min donde un timeout tiraba el intento
                            COMPLETO): fase 1 = listado barato (LIST_PROMPT, solo MCP list,
                            LIST_MAX_TURNS 12 / 2 min); fase 2 = perTicketPrompt(t, lista)
                            por CADA ticket en paralelo con runAdaptivePool (health F2.5,
                            mismo uso que desk-runner; backoff ante 429/overload), 1 query
                            corta por ticket (TICKET_MAX_TURNS 20 / 3 min) que escribe SU
                            entrada INCREMENTAL a tickets.json (slots por índice, orden del
                            listado — el front que encuesta ve crecer la lista con
                            running=true). El prompt por ticket inyecta los HERMANOS (nº +
                            asunto) para no perder la detección de duplicados entre tickets,
                            Y el contexto del motor COMMS (commsContextFor de bugs/shared.js,
                            hallazgo de Coherencia 2026-07-06 — espejo backend de
                            fetchCommsContext del front): hilos indexados GitHub/Teams/
                            chatbot que mencionen el ticket (tkt-N/#N con boundary numérico,
                            tope 3 hilos), 0 tokens (buildIndex de comms/shared.js solo lee
                            disco), best-effort (cualquier falla ⇒ '' y el triage sigue) —
                            así el triage sabe si el bug YA se habló con Chris / tiene PR en
                            curso al decidir recommendation (duplicate/ya-trabajado).
                            Fallo individual ⇒ entrada fallback needs-info + error final
                            "Triage parcial: fallaron N de M"; fallo del LISTADO ⇒ se
                            conserva la caché vieja (la caché recién se pisa tras un listado
                            OK). El skill bug-triage va cargado en AMBAS fases (ahí viven el
                            department_id y las tools Desk). La doble capa read-only (regla
                            6) va EN CADA query de las dos fases.
                            CACHÉ INCREMENTAL por ticket (optimización IA 2026-07-05, mismo
                            patrón que health-audit-cache de salud F2): ticketFingerprint
                            (shared.js, sha1 status+subject+modifiedTime) del listado de
                            fase 1 se compara con ~/.cwc-data/triage-cache.json
                            ({ticketNumber: {fingerprint, ticket, triagedAt}}) y un ticket
                            SIN cambios con triage cacheado FRESCO REUSA su resultado sin
                            abrir query() (0 tokens). OJO VERIFICADO 2026-07-05: el MCP de
                            Tolkien (summarizeTickets de apps/mcp/src/zoho-tools.ts) RECORTA
                            modifiedTime del listado — la señal real hoy es status+subject,
                            CIEGA a un comentario nuevo sin cambio de estado; por eso el hit
                            exige además TTL (TICKET_CACHE_TTL_MS 12 h: staleness acotada; si
                            el MCP algún día expone modifiedTime, entra solo al hash y ese
                            primer listado fuerza re-triage general). El prompt SIGUE
                            pidiendo modifiedTime a propósito (future-proof, hoy llega "").
                            Solo se cachean triages frescos OK (los fallback de error NO —
                            se reintentan); la caché se escribe UNA vez tras la barrera del
                            pool y SOLO con los abiertos del listado (los cerrados caen
                            solos). POST /refresh {full:true} (o `--full` a mano) la ignora
                            — red de seguridad si quedó sucia; borrar el archivo solo fuerza
                            un triage completo.
                            POST /refresh responde INMEDIATO (arrancar+encuestar, patrón
                            health/review); el front encuesta GET cada 3 s y re-dispara si la
                            corrida se pierde (3 intentos). Seguridad read-only de dos capas
                            (regla 6) EN el runner. DEDUP SIN CARRERA (hallazgo de salud
                            2026-07-04): spawnTriage() RESERVA el lock sincrónicamente
                            (writeLock con el pid del hijo, mismo tick que isRunning()) —
                            antes el lock recién lo escribía el hijo tras cargar imports y
                            dos POST casi simultáneos podían lanzar DOS triages; el runner
                            reconoce su reserva (readLock, pid propio ⇒ sigue y toma el
                            heartbeat; lock fresco AJENO ⇒ sale) y el 'error' del spawn
                            libera la reserva (clearLock) para no bloquear el reintento.
                            OJO: `bugs` (triage) ≠ `bugfixes` (motor
                            de PRs) — dominios distintos, nombres parecidos a propósito.
  tokens/                   uso local (GET /summary: transcripts jsonl deduplicados, caché
                            por mtime+size; buildSummary parsea los .jsonl de cada dir en
                            PARALELO con runAdaptivePool — adopción Coherencia 2026-07-06:
                            LECTURA en pool con casillero por índice, ACUMULACIÓN serial en
                            orden fijo porque los costos son floats y el orden de suma debe
                            ser determinístico) + límites del PLAN (GET /api/tokens/limits:
                            % usado y reset de las ventanas de claude.ai — sesión 5 h /
                            semanales, incluida la del modelo activo — + los CRÉDITOS de uso
                            extra (`credits` derivado de `extra_usage`: enabled/usedCredits/
                            monthlyLimit/percent/currency; el front muestra SIEMPRE la fila que
                            Claude reporte — con barra % si hay tope, contador si es pago por
                            uso, o fila tenue "sin créditos activos" si enabled=false. OJO
                            REPRESENTACIÓN (bug 2026-07-07): `used_credits`/`monthly_limit`
                            vienen en la UNIDAD MÍNIMA (centavos) con `decimal_places` diciendo
                            cuántos decimales → el backend divide por 10^decimal_places para
                            pasarlos a dólares ($100 llegaba como 10000; se usa el campo, no un
                            /100 hardcodeado). `utilization` YA viene en % (0-100)),
                            vía el endpoint OAuth de uso de Anthropic con
                            el accessToken de ~/.claude/.credentials.json, la misma credencial
                            que hereda el SDK; el archivo SOLO se lee, el token nunca viaja al
                            cliente, caché 120 s (subido de 60 s: el medidor OAuth tira 429 si
                            se lo consulta seguido) y ?fresh=1 la saltea; si el token venció el
                            error dice cómo arreglarlo — jamás refrescarlo desde acá.
                            PERSISTENCIA + FALLBACK (2026-07-07, pedido del usuario: el dato
                            venía SOLO de memoria y un 429/corte de red/reinicio lo perdía):
                            cada respuesta BUENA se guarda en ~/.cwc-data/plan-limits.json
                            (writePersistedLimits, atómica tmp+rename, best-effort); ante
                            CUALQUIER error de fetch se sirve el último snapshot bueno — de la
                            caché en memoria o, si el server se reinició, del disco
                            (readPersistedLimits) — con 200 y `stale:true`+`staleReason` en vez
                            de tirar el error; recién sin NINGÚN dato previo se devuelve el
                            error real con su status (400 creds / 502 Anthropic / 500). El
                            front (usage.js renderLimits, fuente única del modal Uso Y del pie
                            plan-limits.js) pinta el aviso "⚠ datos guardados · hace X" cuando
                            `stale`, y loadLimits del modal ya NO borra el último render bueno
                            si un refresco posterior falla — paridad con el pie).
                            HISTÓRICO PERSISTENTE + rediseño del modal (2026-07-10, pedido del
                            usuario): REEMPLAZÓ al viejo RESET (POST /reset, tokens-reset.json,
                            applyReset — TODO eliminado). El costo NO se persiste, se recalcula
                            siempre desde los transcripts; lo que SÍ se persiste es el desglose
                            DIARIO por modelo, para que las gráficas de TENDENCIA sobrevivan a la
                            poda de transcripts del CLI. HORA LOCAL: todo el consumo se calcula en
                            America/Bogota (Medellín, UTC-5 FIJO sin DST) — helpers en
                            src/modules/tokens/time.js (offset fijo, sin librería de zonas: corre
                            el reloj -5 h y lee con getters UTC; FUENTE ÚNICA que comparten el
                            parser y el histórico). parseFile bucketea por HORA local (clave
                            'YYYY-MM-DDTHH\tmodel', cacheable = tiempo absoluto) para poder derivar
                            las horas de HOY y la ventana de 5 h sin re-parsear; el día sale de
                            slice(0,10). buildSummary GANA (mismo loop): `daily` ({YYYY-MM-DD local:
                            {opus:{tokens,cost}...}}, se snapshotea a ~/.cwc-data/usage-history.json
                            vía history-store.js/mergeDaily — UPSERT de días vivos + CONGELA los
                            podados, throttle 5 min, atómica, retención 400 d + rollup mensual);
                            `hourlyToday` (serie {keys,points,totals} de hoy por hora, gráfica Día);
                            y `windows` {h5, d7, d7ByKey} = TOKEN-COUNTS de las ventanas de límite
                            (Anthropic NO expone tokens por ventana, solo %: se calculan de NUESTROS
                            transcripts — h5=últimas 5 h · d7=últimos 7 días · d7ByKey por modelo
                            para las ventanas scoped tipo "Semana·Fable"). publicSummary quita solo
                            `daily` (hourlyToday+windows SÍ viajan, son chicos). cachedSummary()
                            centraliza TTL+dedup+snapshot (la usan /summary y /history?range=day).
                            GET /history?range&project: day=HOY por hora (de hourlyToday — hoy
                            siempre en disco) · week=últimos 7 días · month=últimos 30 días
                            (readSeries del histórico); devuelve {range, keys[orden por PRECIO
                            haiku<sonnet<opus<fable — base=más barato], points, totals, project}.
                            FILTRO POR PROYECTO (pedido del usuario 2026-07-10): projectOf(dir)
                            clasifica cada transcript en consola (incluye healthfix-wt-)|tolkien|
                            otros; `daily` y `hourlyToday` quedan ANIDADOS por proyecto (hourlyToday
                            = {all,consola,tolkien,otros,aprendizaje}, cada uno una serie);
                            ?project=all|consola|tolkien|otros|aprendizaje filtra. BUCKET
                            'aprendizaje' (pedido del usuario 2026-07-10, auditar ESTUDIO vs
                            DESARROLLO): las corridas del MÓDULO DE APRENDIZAJE (explain/context/
                            analyze) usan cwd = la consola/Tolkien, así que projectOf las vería como
                            'consola'/'tolkien' — se separan por SESSIONID: buildSummary lee
                            `learningIds` de ~/.cwc-data/learning-session-ids.json (lo escriben los 3
                            runners de aprendizaje capturando el session_id del msg SDK system/init,
                            ver learning/session-log.js) y calcula un `fproj` que MANDA sobre
                            projectOf (learningId ⇒ 'aprendizaje', sin importar el cwd). El engine
                            'learning' (ENGINE_LABELS, clasificado igual por learningId, PRIMERO en
                            classifyEngine) lo desglosa además en el detalle por MOTOR (antes caía en
                            'headless'). "Todos" (PROJECT_KEYS incluye 'aprendizaje') sigue siendo el
                            total real de la cuenta. NO es retroactivo (transcripts previos quedan en
                            'consola'; el histórico ya congelado no se re-separa). Los `windows`
                            (token-counts de límites) NO se filtran (los límites del plan son de la
                            cuenta entera). MODEL_ORDER pasó
                            a orden por PRECIO (haiku,sonnet,opus,fable) → fija el apilado de la
                            gráfica (base=más económico).
                            buildSeries (history-store, compartido) arma esa forma para las 3
                            vistas. TODO en hora local, date-math sin DST (86400000 ms/día). Los
                            límites (fetchPlanLimits) suman `modelKey` (keyOf del display_name de la
                            ventana scoped) para mapear su token-count.
                            MODAL rediseñado (usage.js): arriba límites del plan — cada uno con "·
                            ≈ X tok" (windows) y la fila de créditos COLAPSABLE (<details>, contraída
                            por defecto en el modal Y en el pie plan-limits.js). Abajo UNA barra de
                            controles (Día/Semana/Mes + $/tok) que maneja las DOS columnas: izquierda
                            "📊 General · <período>" (total del rango elegido, por modelo, con Pac-Man
                            "consumiendo ahora") y derecha "📈 Tendencia" (gráfica de barras APILADAS:
                            Día=horas de hoy · Semana=7 días · Mes=30 días). SIN "Hoy" (redundante) y
                            SIN Reset. Gráfica con Chart.js (dependencia npm local chart.js 4.5.1, UMD
                            en public/vendor/chartjs/chart.umd.js — patrón marked/hljs, en index.html
                            → window.Chart; se sirve desde public/vendor/, sin ruta express). Colores
                            = tokens --cwc-model-* con getComputedStyle; paleta en banda de PISO CVD
                            (validado skill dataviz) → codificación SECUNDARIA: leyenda con NOMBRES +
                            gap 2px entre segmentos + tooltip que nombra el modelo. Series todo-en-cero
                            se filtran. El toggle $/tok re-dibuja con la serie cacheada (0 fetch); el
                            cambio de rango sí trae datos (Día del summary, Semana/Mes de /history).
                            Timer 10 s: refresca límites+resumen (Pac-Man+token-counts) y la gráfica
                            solo en Día (cambia por hora); en Semana/Mes re-pinta solo la izquierda.
                            chartInst se destruye al re-crear y en onClose (sin leaks))
  tolkien/                  SOLO git del proyecto trackeado: status/fetch/update. El contexto y
                            las memorias editables NO viven acá — ver módulo `projects/`.
                            REFRESH DE DB LOCAL DESACOPLADO (2026-07-12, resolución de un hallazgo
                            CRÍTICO de la Revisión de Salud): el botón "Vista fresca" (TRUNCATE +
                            reimport de importers Zoho, ~20s a varios min) ANTES corría en background
                            DENTRO del proceso del server, trackeado en una variable module-level
                            (`dataJob`) — un reinicio de la web a mitad lo mataba sin rastro (viola la
                            regla de oro/regla 2). AHORA la lógica vive en `tolkien/refresh-shared.js`
                            + el RUNNER DESACOPLADO `bin/cwc-tolkien-refresh-runner.js`: POST
                            /refresh-data (admin) reserva el job 'running' en disco
                            (~/.cwc-data/tolkien-refresh.json, atómico) y spawnea el runner detached;
                            GET /refresh-data/status SOLO lee ese disco (staleness 12 min). NO usa el
                            SDK (0 tokens: comandos locales psql/infisical/pnpm — la regla 6 no
                            aplica). `runCmd` (exec local) se movió a refresh-shared y RECHAZA ante
                            terminación anormal (timeout/kill/spawn-fail sin código numérico), igual
                            que `git()` — el `gh` de /branches lo importa de ahí.
                            ACTUALIZAR = MAIN LOCAL SIEMPRE FRESCO (2026-07-10, pedido de Niko:
                            "el botón no hacía nada"). CAUSA RAÍZ: el viejo /update hacía `pull
                            --ff-only` sobre la RAMA ACTUAL — parado en una rama feature decía
                            "Already up to date" y tu main local quedaba viejo, pero el semáforo
                            comparaba HEAD vs origin/main (mezclando "lo de Chris" con "lo tuyo")
                            así que el contador nunca bajaba. AHORA POST /update: (1) fetch
                            --prune SIEMPRE; (2) si estás en `main` → stash→pull --ff-only→pop de
                            siempre (flujo cuidadoso, nunca descarta trabajo); (3) si estás en una
                            RAMA FEATURE → `git fetch origin main:main` adelanta tu main LOCAL a
                            origin/main SIN checkout ni tocar tu rama/working tree (git rechaza el
                            ff si main divergió → devuelve `warn`, no fuerza). status() suma
                            `mainBehind` (commits de origin/main que tu main local no tiene — la
                            pregunta REAL "¿mi base está fresca para pushear?", independiente de en
                            qué rama estés) + `onMain`; el semáforo del front pasó a leer mainBehind
                            (no HEAD..origin/main). GET /branches (nuevo, gh): mis PRs ABIERTOS
                            base main (`gh pr list --author @me --state open`) + por cada uno cuántos
                            commits de main le faltan a su rama (`origin/<rama>..origin/main`) — la
                            "verdad" de qué propuse y Chris aún no mergeó (detecta squash-merges);
                            best-effort (sin gh/auth → lista vacía, el panel no muestra el indicador).
                            POST /rebase-branch (admin, nuevo): rebasa la rama ACTUAL sobre
                            origin/main para seguir en paralelo sobre lo último de Chris —
                            conflicto ⇒ `git rebase --abort` ⇒ rama EXACTAMENTE como estaba (dirty
                            ⇒ stash antes/pop después); tras rebase OK avisa `needsForcePush`.
                            Solo rebasa la rama en la que estás parado (no hace checkout de otra =
                            seguro). Front (tolkien.js): línea 🌿 "N PRs sin mergear" (ícono ramas,
                            🟡 si alguno quedó atrás de main, 🟢 si están al día/ninguno) clic →
                            ventana openBranchesDialog con la lista (#N + título + ↓N sobre main) y
                            el botón "Poner al día" SOLO en la rama actual atrasada; Actualizar
                            re-consulta /branches (si Chris mergeó un PR, sale de la lista solo).
                            La consulta gh NO va en el auto-refresh de 5 min (red): solo al montar,
                            tras Actualizar y al abrir la ventana.
  projects/                 contexto (CLAUDE.md) y memorias EDITABLES de los proyectos
                            registrados en PROJECTS (index.js): `tolkien` (config.projectDir)
                            Y `console` (esta misma consola, su propia raíz de repo) — agregar
                            uno nuevo es sumar una entrada al objeto, todas las funciones de
                            memory.js toman `projectDir` como parámetro (nada hardcodeado).
                            GET /api/projects = lista {key,name,dir}; GET/POST /:key/context =
                            <projectDir>/CLAUDE.md real (POST entero: existe para uso
                            programático, la UI NO lo usa); INTEGRIDAD — la UI edita el
                            contexto POR SECCIONES (riesgo señalado por el usuario: cargar el
                            .md entero en un textarea permitía borrarlo completo de un
                            descuido): GET /:key/context/sections = índice {i,title,level,
                            lines,size,hash} cortado por encabezados # a ### (splitContextSections;
                            INVARIANTE: sections.join('\n') === archivo byte a byte, verificado);
                            GET/POST /:key/context/section/:i = UN fragmento — el POST exige el
                            `hash` (sha256/16) del texto ABIERTO y si el archivo cambió en el
                            medio (otra sesión de Claude editándolo) responde 409 sin pisar
                            nada. GUARDIÁN con IA (POST /:key/context/section/:i/analyze,
                            admin, valida hash ANTES de gastar tokens): corrida corta del SDK
                            (haiku, 1 turno, CERO herramientas — las dos capas de la regla 6
                            acá deniegan TODO) que compara sección vieja vs nueva y devuelve
                            {removed, added, modified, risk ok|atencion|critico, riskWhy,
                            summary}. DESACOPLADA a runner (regla de oro, 2026-07-05: antes
                            corría INLINE en el handler y un deploy a mitad la perdía con los
                            tokens gastados): el POST persiste el job en
                            ~/.cwc-data/projects-analyze/<id>.json (id DETERMINÍSTICO por
                            proyecto+sección+hash+contenido: un reintento reusa el MISMO job,
                            sin runner duplicado — lock implícito por identidad), spawnea
                            bin/cwc-projects-analyze-runner.js detached y responde YA
                            {id,status:'running'}; GET /:key/context/section/:i/analyze/:id
                            SOLO lee disco (0 tokens; staleness ⇒ error, nunca cuelga) y el
                            front encuesta cada 2 s tolerando fetch fallidos (deploy en el
                            medio). Lógica compartida en projects/analyze-shared.js (prompt +
                            parseo + jobs con poda >24 h). La UI lo muestra en un modal de CONFIRMACIÓN FORZADA
                            (reviewChange en project-context-panel.js) — solo "Confirmar y
                            guardar" escribe, "Seguir editando" vuelve al editor sin tocar
                            nada, y si la IA falla cae a un diff local (renderDiff) con la
                            misma confirmación forzada: nunca se guarda a ciegas, nunca se
                            bloquea el trabajo. Guardar sin cambios NO dispara análisis.
                            GET /:key/memory = índice MEMORY.md + notas resueltas contra
                            disco (orden del índice, huérfanas al final); GET/POST
                            /:key/memory/index = MEMORY.md crudo; GET/POST
                            /:key/memory/note/:file = una nota (whitelist estricta
                            `^[A-Za-z0-9_-]+\.md$`, sin path traversal; `:key` validado contra
                            PROJECTS, 404 si no existe). GET abierto a autenticados, POST
                            admin (mismo patrón que el contexto de bugfixes). La carpeta de
                            memorias se ubica con encodeCwd(projectDir) (core/claude-model.js)
                            — MISMA codificación que usa Claude Code para
                            ~/.claude/projects/. NO son copias: son los archivos reales que
                            lee la próxima sesión de Claude Code en ESE proyecto — guardar acá
                            cambia comportamiento real (excepción deliberada a la regla 4, ver
                            ahí). Ojo recursivo: editar el proyecto `console` significa editar
                            el CLAUDE.md/memorias que gobiernan las sesiones de Claude Code en
                            ESTE MISMO repo.
  backup/                   tar.gz completo (server-side, con secretos) + push del CÓDIGO al
                            remote `personal` (guardas: solo ese remote, URL sin Mordor-Staffing).
                            COMMIT SIN PUSH (2026-07-05, pedido del usuario): botón "Commit
                            (sin push)" del panel — commit LOCAL descriptivo de los cambios
                            pendientes sin tocar el remote (el push sigue commiteando con su
                            mensaje genérico "cwc backup <fecha>"; este botón deja historia
                            con mensajes en español). POST /api/backup/commit {message,
                            includeUntracked[]}: guardas repoSecretGuards (repo + secretos,
                            SIN exigir remote — extraídas de securityGuards) + selectUntracked
                            (las 3 capas anti-secretos del push, helper ahora COMPARTIDO por
                            push y commit) + sanitizeCommitMessage (sin chars de control,
                            tope 2000); add -u + untracked seleccionados; NO changelog, NO
                            restart, reversible con git reset --soft. Mensaje IA: POST
                            /commit-message captura diff+archivos EN NODE, escribe el job en
                            ~/.cwc-data/commitmsg/<id>.json (id determinístico por estado del
                            árbol ⇒ doble click = mismo job) y spawnea
                            bin/cwc-commitmsg-runner.js DETACHED (regla de oro; haiku, 1
                            turno, CERO herramientas — regla 6 con TODO denegado, patrón
                            projects/analyze-shared); GET /commit-message/:id solo lee disco
                            y el diálogo encuesta cada 1.5 s — si la IA falla, el mensaje se
                            escribe a mano (nunca bloquea). GET /git-info ahora expone
                            `dirty[]` (name-status contra HEAD, incluye stageados) además de
                            dirtyCount. Lógica compartida en backup/commitmsg-shared.js.
                            Untracked: NUNCA viajan solos — el diálogo de Push los lista con
                            checkbox por archivo (body {includeUntracked:[...]}) y el backend
                            valida la selección en 3 capas: solo lo que git lista como
                            untracked no-ignorado (un .env ignorado NI aparece), re-chequeo
                            contra SECRET_PATHS/SECRET_DIRS (403 si un secreto se coló) y
                            selección humana explícita archivo por archivo. Cada push exitoso
                            ADEMÁS: (1) agrega
                            una entrada EN INGLÉS a la sección "## Changelog" de README.md
                            (marcadores <!-- cwc:changelog:start/end -->, función
                            updateReadmeChangelog — commits locales sin pushear + archivos
                            recién stageados; si no hay nada nuevo, no toca el README) y
                            (2) reafirma la descripción del repo en GitHub (inglés, resume
                            consola+módulos) vía `gh repo edit` (best-effort: si falta gh/auth
                            no rompe el push, ver campo `description` de la respuesta).
                            PULL desde GitHub (POST /pull, admin): restauración del código —
                            mismas guardas, fetch + stash→merge --ff-only→pop (patrón
                            tolkien/update: NUNCA descarta trabajo ni fuerza nada; divergencia
                            = 409 con el stash repuesto). "Nada que traer" se detecta con
                            merge-base --is-ancestor (comparar HEAD==remote NO alcanza: local
                            adelante reiniciaría al pedo). Si package(-lock).json cambió corre
                            npm install ANTES del restart; reinicia SOLO con árbol sano (pop
                            conflictuado o npm roto → avisa y NO reinicia: un server sobre
                            archivos con marcas de conflicto entra en crash-loop).
  bugfixes/                 MOTOR de tickets (engine.js — la columna vertebral): el log
                            físico sigue en store.js (~/.cwc-data/bugfixes.json, cada registro
                            = un ATTEMPT/chat que trabajó un ticket, clave sessionId — NO se
                            tocó, retrocompat total). El motor DERIVA determinísticamente
                            (como core/inventory.js, sin LLM) los TICKETS consolidados:
                            buildTickets() agrupa los attempts por número de ticket → 1 ticket
                            = 1 entidad {number,title,attempts[],external:{github[],desk},
                            state DERIVADO (deriveState: pipeline triaged→working→pr-open→
                            pr-merged→desk-answered→resolved), resolution, tags[], meta{},
                            history[] unificado, schemaVersion}. IMPOSIBLE duplicar (dedo
                            resbalado = attempt outcome 'empty'). Sidecar tickets-meta.json =
                            dimensiones curadas (tags/area) + BIBLIOTECA DE SOLUCIONES +
                            FEEDBACK de Chris persistido. BASE DE CONOCIMIENTO (2026-07-04,
                            determinística, 0 tokens): (a) FEEDBACK — prLive ya trae los
                            reviews/comentarios de Chris de gh pero se perdían a los 60 s / al
                            reiniciar; ahora saveFeedback() los PERSISTE por ticket en el sidecar
                            (sc.feedback[n]), mapeando PR→ticket por registro/branch/título;
                            buildTickets los adjunta en external.feedback y el tablero los muestra
                            (feedbackHtml). (b) SOLUCIONES — la biblioteca se LLENA SOLA: al
                            derivar un ticket con PR mergeado (o resuelto), deriveSolution()
                            destila {rootCause, fix, lesson, files, tags, prNumber, feedback de
                            Chris} del cierre del chat (marcadores Problema:/Qué hice:/Mejor
                            solución:) y upsertSolutionInto() hace UPSERT idempotente (1 por
                            ticket, escribe solo si cambió, una vez por build). findSimilarSolutions
                            matchea por archivos/tags/área y EXCLUYE el propio ticket. (c) REUSO —
                            el prompt de "Trabajar en esto" (doWorkOn) inyecta el feedback de Chris
                            guardado + las soluciones pasadas parecidas (similarHtml las muestra en
                            el detalle). CAPA IA OPCIONAL futura (Fase 4, no hecha): destilar la
                            "lección" con haiku. recordSolution() sigue exportada para esa capa.
                            GET /api/bugfixes/tickets = tickets consolidados (+ similar[]); el
                            tablero (bugs/board/store.js) lo consume vía ticketToRow (puente
                            motor→helpers): 1 fila por ticket, los intentos en el detalle
                            (attemptsHtml). GET /api/bugfixes (viejo, array plano) queda para
                            retrocompat. ESTADO EN VIVO (fase 2): GitHub se auto-refresca cada
                            45 s mientras el tablero está abierto + al volver a la pestaña
                            (barato, solo gh — los merges de Chris aparecen solos; intervalo
                            se limpia al cerrar). Desk NUNCA solo (cuesta tokens): botón "🎫
                            Desk" consulta desk-live de los tickets ACTIVOS (con confirm),
                            persiste deskReplied/deskResolved y el motor los refleja. Indicador
                            de frescura "GitHub: hace X · Desk: hace Y/sin consultar" (.bb-fresh).
                            La columna Desk del tablero distingue 🎫✅ resuelto · 🎫✔ respondido
                            · 🎫✕ error · 🎫○ consultado sin respuesta · — sin consultar.
                            registro de fixes de tickets (store.js: ~/.cwc-data/bugfixes.json,
                            extracción del transcript, scan retroactivo) + subida de PR a
                            Tolkien (worktree temporal desde origin/main — NO toca el árbol
                            real — commit de los archivos del fix, push, gh pr create con
                            reviewer cswenor). Notas del PR SIEMPRE formales: Problema /
                            Qué se hizo / ¿Mejor solución? (parseadas del cierre del chat).
                            TICKET REABIERTO con PR ya montado = ACTUALIZAR, no duplicar:
                            recordBugfix mergea el trabajo nuevo también en una entrada
                            'subido' cuyo prState != 'merged' (vuelve a 'pendiente'
                            CONSERVANDO branch/prNumber — la UI la muestra como "PR #N
                            abierto · cambios sin subir"); pushPr verifica el estado REAL
                            del PR con gh EN EL MOMENTO del envío: abierto → updatePr
                            (worktree desde el branch DEL PR, commit ENCIMA, push
                            fast-forward sin --force, gh pr edit --body + comentario
                            avisando al reviewer — best-effort) → el MISMO PR se
                            actualiza; mergeado/cerrado → camino de PR nuevo de siempre.
                            Solo un merge cierra el ciclo del ticket.
                            DOS CONTEXTOS editables (GET/POST /context?kind=work|pr), ambos
                            inyectados en cada "Trabajar en Chat": 'work' (bugfix-context.md —
                            verificación previa del ticket/PRs de Chris, proceso, NO enviar PR
                            desde el chat) y 'pr' (bugfix-pr-context.md — cómo se REDACTAN las
                            notas del PR: formato Problema:/Qué hice:/Mejor solución: del
                            cierre).
                            🚦 GATE DE PUSH (pedido del usuario 2026-07-05): el contexto
                            'work' abre con una regla dura — el trabajo se ejecuta DE
                            CORRIDO, pero ANTES de CUALQUIER push (git push / gh pr
                            create|edit / actualizar PR / "Enviar PR") el chat FRENA,
                            muestra el PLAN DE PUSH (branch destino + PR nuevo/actualiza
                            #N + archivos con diff stat + texto exacto de las notas) y
                            espera el OK explícito del usuario; recién ahí pushea de
                            corrido y verifica contra GitHub. workPrompt/featurePrompt
                            (board/prompts.js) lo recuerdan en el arranque del chat, y el
                            confirm de "Enviar pendientes" (sendPending de
                            board/actions.js) muestra el mismo plan por fix: destino →
                            branch (misma fórmula que pushPr) + lista de archivos (tope
                            5). deskChatPrompt ya tenía su gate propio (nota → OK →
                            publicar) y no se tocó. YA NO se editan con botón "Contexto" propio en el
                            EXPANDIR de Bugs ni en el modal Enviar PR (se sacaron de ahí): se
                            editan desde ⚙ Sistema → Proyectos, como "Bugfixes: Trabajo" /
                            "Bugfixes: PR" (sub-proyectos SIN memorias, junto a Tolkien/Consola
                            — ver project-context-panel.js). Editor genérico: textEditorDialog (ui/dialog.js).
                            Cancelar PR (POST /cancel-pr, admin): cierra el PR en GitHub +
                            borra el branch remoto y el registro vuelve LIMPIO a 'pendiente'
                            (sin campos de PR) para rehacer el fix de cero; un PR MERGEADO
                            nunca se cancela (se verifica el estado real con gh antes).
                            VINCULACIÓN + RECONCILIACIÓN de PRs externos (bug 2026-07-05,
                            caso FEAT-2/PR #249; patrón Desk #519/PR #232): un PR creado por
                            FUERA del módulo "Enviar PR" (gh pr create desde un chat o un
                            worktree externo) dejaba el registro huérfano PARA SIEMPRE
                            ("falta enviar el PR" con el PR ya abierto) — extractFromTranscript
                            solo mira tools Edit/Write (ignora Bash/gh) y prNumber solo lo
                            escribían pushPr o refresh-prs FASE 2 (que solo refresca PRs YA
                            registrados). TRES vías nuevas, UNA lógica (link-shared.js:
                            applyPrLink mutación pura idempotente + linkPrToRegistry con gh
                            pr view; NO importa core/config.js a propósito — exige CWC_TOKEN
                            y haría exit fuera del repo): (1) RECONCILIACIÓN automática en
                            refresh-prs — si un PR de gh pr list referencia (ticketOfPr:
                            tkt-N / FEAT-n / #N) un registro SIN prNumber y el match es
                            INEQUÍVOCO (exactamente UN candidato no archivado), lo ADOPTA
                            (prNumber/prState/branch/status 'subido' + evento pr_vinculado
                            {mode:'auto'}; cerrados sin merge y ambiguos NO se adoptan;
                            respuesta expone linked[]); (2) POST /link-pr {id, prNumber}
                            (admin) + botón "🔗 Vincular PR…" en el detalle (desktop) y menú
                            ⋯ del action bar (móvil) para lo que el regex no ve (p.ej.
                            "FEAT-1/2": solo captura FEAT-1); (3) PREVENCIÓN — el propio
                            chat corre bin/cwc-bugfix-link.js en el MISMO turno del push
                            (mode:'chat'); lo exigen el contexto 'work' (condición (e) de la
                            excepción), DEFAULT_CONTEXTS.work y los gates de workPrompt/
                            featurePrompt. ticketOfPr (motor) ahora entiende FEAT-n y
                            devuelve la clave completa ('FEAT-2', no el dígito), con orden
                            deliberado tkt-N → FEAT-n → #N (un título "Feature FEAT-2
                            (#245)" da FEAT-2, no 245); FUENTE ÚNICA de esa convención
                            (cableado Coherencia 2026-07-06, ANTES espejo duplicado a mano
                            en el front): refresh-prs adjunta `ticketNumber: ticketOfPr(pr)`
                            YA calculado a cada fila de `github`/lastGhRows y ticketOfPr de
                            labels.js CONSUME ese campo si está presente (aunque sea null) —
                            su regex quedó SOLO como fallback legacy para filas cacheadas
                            sin el campo, NO mantenerla en paridad con el motor; buildTickets
                            también prefiere el campo. isFeatId (front) sigue local y gatea
                            Desk en filas solo-GitHub de features (chip 💡,
                            sin sección Zoho ni "Actualizar ticket"). Evento pr_vinculado en
                            EV_LABEL/evDot. Un PR vinculado pasa a mantenerse solo (FASE 2
                            de refresh-prs lo refresca como cualquier subido).
                            El chat registra al CERRAR una conversación con ticket (diferido
                            2s: el transcript se flushea tarde).
                            HISTORIAL por fix (history[] en cada registro, addEvent de
                            store.js, retrocompatible): creado · trabajo_nuevo (reapertura
                            tras PR) · pr_creado · pr_actualizado (2º+ commit, sha) ·
                            pr_mergeado (transición detectada en refresh-prs) · pr_cancelado ·
                            ticket_actualizado (Desk, auto|chat, ok|error). Es el timeline
                            del tablero.
                            DESK AUTO (deskUpdateAuto, ver EXCEPCIÓN en regla 6): tras el
                            PRIMER envío exitoso (esPrimerEnvio = !updated && !sentAt) corre
                            asíncrona una corrida SDK (sonnet, allowlist SOLO desk_* del MCP,
                            timeout 4 min) que pone el ticket On Hold + nota corta EN INGLÉS;
                            deskStatus updating→ok|error + evento al historial. Las
                            ITERACIONES no tocan Desk: el resultado del envío lo avisa y el
                            tablero ofrece "Actualizar ticket (chat)".
                            IDENTIDAD AL PUBLICAR (regla general, pedido del usuario
                            2026-07-04): si el camino de escritura puede publicar con la
                            identidad REAL de Nico (token/cuenta propia) → usarla, SIN
                            firma; si publica como otra identidad → firma obligatoria.
                            FIRMA EN DESK (caso actual): el token OAuth de Zoho que usan
                            las tools desk_* es de OTRO agente (Chris) — la API publica
                            toda nota como si la escribiera él y no permite falsear el
                            autor. Por eso TODO prompt de la consola que redacta
                            escrituras a Desk (deskUpdateAuto acá y deskChatPrompt en
                            bugs/board/prompts.js — ghdeskchat reusa deskChat) exige cerrar la
                            nota con la firma exacta "— Nicolás (dev team)" en su propia
                            línea. Teams sale como bot "Tolkien" (misma regla si se
                            automatiza). Si se agrega otro camino de escritura externa,
                            aplicar la regla general (identidad real si se puede; si no,
                            la firma). Si algún día llega un token de Zoho PROPIO de Nico,
                            quitar la firma de esos prompts.
                            FEATURES (💡 FEAT-n, 2026-07-04): item de trabajo de TOLKIEN
                            SIN ticket de Desk. Alta manual admin: botón "💡 Nuevo feature"
                            del tablero (desktop + menú ⋯ móvil) → POST /api/bugfixes/feature
                            {title, description} → createFeature() de engine.js (id sintético
                            FEAT-n, secuencia featureSeq en el sidecar; kind:'feature' +
                            spec = enunciado ORIGINAL permanente que el resumen del chat no
                            pisa). El id viaja en ticketNumber (el motor ya agrupa por
                            [\w-]+): TODO el ciclo se reusa — recordBugfix mergea por
                            ticketNumber, "Trabajar en esto" abre chat (featurePrompt de
                            prompts.js, modo plan si aún sin archivos, diseño primero),
                            pushPr usa branch feature/feat-n-<sid> (no bugfix/tkt-). Desk
                            queda FUERA en todas las capas (deriveState: merge ⇒ resolved;
                            deriveResolution/resolutionOf: merge ⇒ complete; deskUpdateAuto
                            y el gate del POST /pr excluyen kind feature; la UI oculta
                            botones/section/chips/investigación-contexto de Desk y el
                            pipeline muestra "se completa con el merge"). REGLA de
                            clasificación (memoria feature-clasificacion.md): el tablero es
                            SOLO Tolkien — features de la consola u otros proyectos NO se
                            cargan acá. Intake automático desde la página Tolkien
                            ([Tolkien Feature] en Desk → triage) = fase FUTURA, no hecha.
                            PR-LIVE (GET /pr-live/:n, admin): datos EN VIVO de un PR vía gh
                            (reviews, reviewDecision, comentarios, checks, commits,
                            mergeable) con caché en memoria de 60 s (?fresh=1 la saltea);
                            NADA se persiste — es el panel "GitHub en vivo" del tablero.
                            DESK-LIVE (admin, CONSUME TOKENS, DESACOPLADO a runner 2026-07-04):
                            estado + comentarios ACTUALES del ticket en Zoho Desk vía corrida
                            headless READ-ONLY (sub-excepción regla 6: allowlist desk_* SOLO
                            lectura). Antes corría INLINE en el GET (se perdía al cambiar de
                            pestaña / reiniciar server); ahora vive en bin/cwc-desk-runner.js
                            (lógica en desk-shared.js): POST /desk-refresh {tickets:[...]}
                            lanza el runner detached (dedup lock desk.lock) y responde YA;
                            resultado persistido en ~/.cwc-data/desk-live/<ticket>.json; GET
                            /desk-live/:n SOLO lee ese disco (0 tokens) + `running`/`progress`
                            de la corrida; el front encuesta (fillDesk POST→poll, resiliente al
                            cambio de pestaña). parseDeskResponse (desk-shared) parsea un bloque
                            JSON de la respuesta; sin fresh reusa < 60 s (no relanza). CLASIFICA
                            la resolución: pide al modelo `closed` (status cerrado/resuelto, con
                            red de seguridad regex) y `requesterReplied` (el cliente respondió
                            tras la última nota del equipo). persistDeskSnapshot() (desk-shared,
                            lo llama el runner) vuelca en TODOS los registros del ticket:
                            deskStatusText/deskClosed/deskReplied/deskResolved +
                            deskCheckedAt, y emite ticket_cerrado|ticket_respondido al
                            historial la 1ª vez. RESOLUCIÓN (resolutionOf, derivado, expuesto
                            en GET /api/bugfixes como b.resolution): 'complete' si deskResolved
                            · 'partial' si prState==='merged' (PR mergeado pero ticket SIN
                            confirmar — merge ≠ resuelto: puede ser fix parcial o total, sin
                            verificar) · 'active'. ARCHIVO (POST /archive {id,archived}): flag
                            b.archived + evento archivado|restaurado; solo organiza el tablero,
                            no toca código ni PRs.
                            INVESTIGAR A FONDO (Fase 1, 2026-07-04): al expandir un PR abierto,
                            fillLive muestra un SEMÁFORO determinístico (semaforoHtml, 0 tokens,
                            desde prLive: review/checks/conflictos + si Chris escribió tras tu
                            último commit) + el botón "🔍 Investigar a fondo" (runInvestigation →
                            POST /investigate → runner cwc-investigate-runner.js → GET
                            /investigation/:pr, encuesta resiliente). El veredicto IA
                            (verdictHtml: severidad/titular/pasos/archivos) se persiste y sus
                            `pasos` se inyectan en "Trabajar en esto" (doWorkOn). Ver regla 6.
                            INVESTIGAR CONTEXTO (ticket SIN PR, 2026-07-04): la MISMA caja
                            destacada al inicio del detalle (invTopBox decide por b.prNumber) muestra,
                            para toda fila-ticket sin PR (incluidas las de triage), el botón "🔍
                            Investigar contexto" (runTicketInvestigation → POST /ticket-investigate →
                            runner cwc-ticket-investigate-runner.js → GET /ticket-investigation/:n,
                            encuesta resiliente). A DIFERENCIA de la de PR, ésta LEE el código de
                            Tolkien read-only (no hay diff sin PR) y responde POR QUÉ no se resolvió +
                            causa raíz. Veredicto (verdictTicketHtml: porQueNoResuelto/causaRaiz/
                            pasos/archivos/complejidad/riesgo) persistido; sus `pasos` se inyectan en
                            doWorkOn (ticket sin PR) y en workOnTriage. Ver regla 6.
                            FILA-PR (Fase 2, 2026-07-04): cuando un PR está ABIERTO el PR es el
                            protagonista de la fila (🔀 #N + título) y el/los TKT que resuelve van
                            ANIDADOS debajo (↳ 🎫 TKT #N, bb-row--pr — familia .bfm-* migrada a .bb-* en Fase 2). renderTable agrupa por
                            número de PR abierto (openPrGroups) y saltea los secundarios (no
                            duplican fila); data-sid queda en el TKT primario → expandir/in-place
                            intactos. Mergeado/cerrado/sin-PR siguen como fila-TKT.
                            UI ÚNICA: el TABLERO "Bugs & PRs" (bugs/board/): filas de
                            registro local + tickets del triage + PRs SOLO-GitHub, estas
                            últimas EXPANDIBLES (badge #N del ticket detectado del título/branch
                            con ticketOfPr, panel GitHub en vivo con commits, "Actualizar
                            ticket (chat)" si tienen ticket). La 5ª barra del pipeline es
                            "ticket confirmado" (verde SOLO si deskResolved); chip de
                            resolución en la fila (🟡 parcial · 🟢 completo). DOS columnas
                            de ícono compacto (prCellFor/deskCellFor, datos ya presentes, CERO
                            tokens): "PR" (✔ implementado en PR mergeado · ◐ en PR abierto · —
                            sin PR; cruce por ticketNumber sobre entries+ghRows) y "Desk"
                            (🎫✔ respondido = deskStatus 'ok' o evento ticket_actualizado/
                            ticket_respondido en history · ⏳ publicando · 🎫✕ error · —). En
                            móvil (≤640) se ocultan Pipeline+Cambios y quedan PR/Desk (info de
                            un vistazo). "Responder ticket (chat)" (data-act deskchat) aparece
                            en TODA fila con ticketNumber (antes solo con PR): el prompt se
                            adapta (con PR = nota de novedades · sin PR = responder/pedir info),
                            siempre con aprobación del usuario en Desk (regla 6). Cada fila con
                            ticket trae "Traer estado de Desk" (desk-live, bajo botón; muestra
                            veredicto parcial/completo y actualiza b.resolution en memoria sin
                            re-render). Botón Archivar (primario cuando completo) /
                            Restaurar por fila. El "?" ("Cómo leer este tablero") explica
                            pipeline, resolución, chips, puntos, Archivo y GitHub/Desk en vivo.
                            SUBVISTAS / PESTAÑAS (pedido del usuario 2026-07-05): el tablero
                            se organiza en TRES pestañas primarias (barra .bb-tabs, visible
                            en desktop Y móvil, `state.tab` en store.js — R1, fuera del DOM):
                            🎫 Tickets (bugs con ticket + tickets del triage sin trabajar +
                            PRs solo-GitHub) · 💡 Features (FEAT-n) · 📦 Archivados (todo lo
                            archivado, tickets y features). tabOfEntry (labels.js) deriva la
                            pestaña de cada fila (archived manda sobre kind); renderTable
                            filtra tanto la tabla desktop como las cards móviles por
                            state.tab. Antes TODO apilaba en una sola lista con la sección
                            colapsable "📦 Archivo · resueltos" al fondo (data-arch-toggle /
                            .bb-arch-row / archOpen — ahora en desuso, reemplazados por la
                            pestaña Archivados). Los conteos de cada pestaña salen del estado
                            (0 tokens). Los SEGMENTOS móviles (Acción/Revisión/✓) quedan como
                            filtro SECUNDARIO dentro de Tickets/Features (ya NO tienen 📦 —
                            es pestaña); se ocultan en Archivados. Cambiar de pestaña es un
                            store.set({tab}) y el re-render es seguro (no toca `expanded`).
public/index.html + js/main.js  app principal: módulos frontend { name, mount(el, ctx) }
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
                            divisor. Los gauges se movieron del pie IZQUIERDO al DERECHO
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
public/js/modules/          launcher · sessions · tasks(sección "Pendientes": tarjeta sidebar
                            colapsable + tablero modal con CUATRO PESTAÑAS 📊 Panel (dashboard estilo
                            Pad con datos LOCALES: En curso / Necesita atención / Seguí por acá /
                            Planes activos con progreso % / Clasificación / Actividad reciente del
                            log real — todo derivado, 0 tokens; Pad solo REFERENTE de diseño) · 📋
                            Tareas (filtros/alta/edición con Tipo+Plan) · 🗺️ Planes (agrupan tareas,
                            progreso %) · 🎙️ Informes (audios como informes colapsables + botón 🧾
                            raw). Se alimenta manual y
                            desde audio vía evento bus `tasks-changed`. El módulo AUDIO NO es sección
                            propia: vive DENTRO de Pendientes — el botón "Audio" DEL TABLERO (admin,
                            tokens; el acceso "Analizar audio" del HEADER del sidebar se quitó a
                            pedido del usuario 2026-07-07) importa openAudioPanel de audio/audio.js
                            (pegar transcripción → Analizar → interpretación en árbol + tareas
                            propuestas + raw), y la pestaña Informes usa mountReports de audio.js) ·
                            retro (sección "Mejora Continua": badge de propuestas + tablero modal
                            colapsable de LECCIONES DE PROCESO destiladas al cerrar chats — ver el
                            módulo backend `retro/` arriba; adoptar → destino sugerido/guardar/descartar) ·
                            stats · usage · system(⚙: Backup/Usuarios/
                            Proyectos/Interfono/Salud — la pestaña Interfono
                            (interfono-panel.js) es la ventana + canal humano del INTERFONO
                            entre sesiones (GET/POST /api/interfono): sesiones activas,
                            enviar mensaje manual, reservas de archivo con semáforo 🔴🟡🟢 y
                            liberar (admin), mensajes recientes — todo colapsable+árbol. La
                            pestaña Proyectos (project-context-panel.js,
                            backend módulo `projects` + /api/bugfixes/context) es DISTINTA del
                            módulo tolkien de abajo: TODAS las entradas editables en un solo
                            lugar con navegación en DOS NIVELES lista→detalle (rediseño a
                            pedido: las 4 pills idénticas de antes confundían). Vista lista =
                            tarjetas .pj-card agrupadas ("Proyectos · contexto y memorias" =
                            Tolkien/Consola de GET /api/projects, chip de ícono en acento;
                            "Bugfixes · solo contexto" = BUGFIX_ENTRIES del panel, kind=work|pr
                            de /api/bugfixes/context, chip neutro .pj-card--bf) con nombre +
                            descripción + chevron. Tocar una tarjeta → detalle con "‹
                            Proyectos" (volver), dir del proyecto, Contexto y (solo proyectos
                            completos) Memorias — el detalle de un bugfix NI renderiza la
                            sección Memorias. Visible a todos (autenticados), edición gateada por
                            isAdmin en el frontend Y en el backend; la pestaña Salud es SOLO
                            salud: chequeos rápidos + revisión profunda + subsección "🧠
                            Optimización IA" (resumen compacto + botón → sub-ventana
                            optimize-modal.js: censo de motores gratis + análisis bajo botón
                            con propuestas aprobables, ver "Verificación de salud"), sin
                            bugfixes) ·
                            tolkien (tarjeta git INFORMATIVA, rediseño 2026-07-03: sin
                            Continuar/Explorar/Bugs&PRs — quedaban redundantes; muestra el
                            PULSO del repo — #SHA · branch (⚠ si ≠ main) · main al día/↓N ·
                            N cambios · último commit (asunto·autor·hace X) · último fetch ·
                            🌿 N PRs sin mergear — y una acción: Actualizar (⬇ ícono en el
                            header). SEMÁFORO + Actualizar pasaron a leer `mainBehind` (main
                            LOCAL vs origin/main), no HEAD..origin/main — ver el bloque del
                            módulo backend tolkien/ arriba para la CAUSA RAÍZ del "no hacía
                            nada" y el flujo nuevo (ff de main aunque estés en rama feature).
                            La línea 🌿 (GET /branches, gh) lista mis PRs abiertos sin mergear
                            y su ↓N sobre main; clic → ventana con "Poner al día" (rebase,
                            POST /rebase-branch) SOLO en la rama actual atrasada. .tk-update--due
                            resalta si mainBehind>0. /api/tolkien/status suma mainBehind+onMain.
                            El acceso al tablero se movió a "Bugs & Features". La tarjeta suma
                            un 3er acceso directo en `.tk-actions` (2026-07-12, pedido de Niko):
                            "GetPad local" — link `<a target="_blank">` a
                            `http://${location.hostname}:7777` (mismo host ZeroTier de la
                            consola, puerto del `pad-local.service` self-hosted, ver el gotcha
                            "MCP de Pad" — cutover a local arriba), color `.tk-link--pad` (verde
                            `--cwc-ok`, distinto del terracota "local"/azul "oficial" de Tolkien
                            para no confundir los tres). Es solo un ATAJO de UI para abrir la SPA
                            de Pad en pestaña nueva — NO cruza datos ni viola la regla dura 12
                            (los dos mundos siguen sin enlazarse en vivo; este botón no lee ni
                            escribe nada, solo navega)) ·
                            bugs (sección "Bugs & Features", modules/bugs/bugs.js, ANTES
                            `tickets`: ÚNICO acceso al ciclo del bug. INFO RÁPIDA barata (sin
                            tokens ni gh) cruzando /api/bugs (triage: nº bugs + frescura) y
                            /api/bugfixes (registro: por enviar, PRs abiertos, y ⚠ ATENCIÓN =
                            reabierto/doble registro/ticket sin actualizar — los casos del
                            519). TRES COLUMNAS (.bf-cols, pedido del usuario 2026-07-05)
                            como ESCANEO PREVIO antes de entrar al tablero: 🎫 Tickets · 💡
                            Features (conteos con el MISMO criterio que tabOfEntry de
                            board/labels.js sobre los tickets CONSOLIDADOS de GET
                            /api/bugfixes/tickets — barato: caché server lastGhRows, sin gh
                            vivo; Tickets suma los triage-only no cubiertos) · ⚠ Atención
                            (3ª columna: reemplaza a 📦 Archivados —que no se acciona desde
                            acá— por attentionCount(): anomalías del ciclo reabierto tras
                            PR / doble registro / ticket sin actualizar en Desk, los casos
                            del 519; resalta en ámbar .bf-col--alert cuando hay algo). Las
                            columnas son clickeables (admin): Tickets/Features abren el
                            tablero en su pestaña, Atención lo abre en Tickets
                            (openBugBoard({initialTab})). La leyenda inferior se REDUJO a la
                            frescura del triage (las líneas de resolución/por-enviar eran
                            redundantes con las columnas). PAC-MAN DE ACTIVIDAD por columna
                            (pedido del usuario 2026-07-05, .bf-col-pac esquina): un poll
                            liviano de /api/chat/list (~8 s, 0 tokens) enciende el Pac-Man de
                            la columna que se está trabajando — un chat con ticketNumber
                            (working o delegando un subagente) prende su columna (FEAT-n →
                            Features · resto → Tickets), y el triage corriendo delega sobre
                            Tickets; un chat working (más específico) le gana al triage. En
                            reposo, sin Pac-Man. Requiere que chat.info() exponga
                            `ticketNumber` (src/modules/chat/index.js) para saber qué chat
                            trabaja qué ticket sin abrir la pestaña. Botón "Abrir tablero" +
                            ↻ triage (tokens, confirm). Al cerrar el tablero (onClose)
                            refresca las stats + columnas) ·
                            El TABLERO (bugs/board/, admin, lo abre "Bugs & Features"; vivió
                            en tolkien/bug-board.js hasta el refactor 2026-07-04 —
                            docs/plan-rediseno-movil-tickets.md §2, branch
                            redesign/board-mobile): ARQUITECTURA con estado FUERA del
                            DOM — index.js (composición: modal, listener delegado,
                            timers, ciclo de vida) · store.js (estado ÚNICO: datos +
                            expanded/archOpen/busy/paneles lazy; get/set/mutate/
                            subscribe + ticketToRow; reset() por apertura) · render.js
                            (funciones puras estado→HTML, un solo punto de re-render
                            con scroll preservado) · actions.js (handlers/endpoints:
                            escriben al store, jamás al DOM; confirms de tokens y
                            destructivos intactos) · polls.js (encuestas POR CLAVE
                            'desk:519'/'inv:232'/'tktinv:N'/'desk:bulk', dedup +
                            deadline, inmunes a re-renders; stopAll() al cerrar) ·
                            prompts.js (textos de los chats del ciclo) · labels.js
                            (fuente única de etiquetas: prEstado/resolutionOf/EV_LABEL/
                            evDot/celdas PR-Desk/rowKey 'sid:x|tkt:n|pr:n'/warningsFor)
                            · util.js (esc/fmt). CLAVE: el re-render es SIEMPRE seguro
                            ⇒ el auto-refresh de GitHub YA NO se pausa con un detalle
                            abierto (cambio autorizado del plan, Fase 1); expansión y
                            paneles GitHub/Desk/investigación sobreviven porque viven
                            en el store, no en el DOM. R4 aplicada: OUTCOME_LABEL sin
                            estados muertos (plan/abandoned) y evDot completa
                            ticket_actualizado (ok/fail según e.ok). VISTA MÓVIL
                            (Fase 3, ≤640px): tabla y CARDS se renderizan SIEMPRE
                            del mismo estado y el CSS decide cuál se ve (rotar no
                            pierde nada) — .bb-mhead (búsqueda en cliente por
                            #/título/archivo + chips de segmento con conteo:
                            Acción=pendiente c/files+triage-only ·
                            Revisión=PR abierto · ✓=merged/completo ·
                            📦=archivados; re-tap = Todos; segmentOfEntry/
                            segmentOfGh en labels.js + query/filter en el store)
                            + frescura en UNA línea + menú ⋯ (cwc-popup-menu:
                            Enviar pendientes TEMPORAL hasta la action bar de
                            Fase 5, Buscar bugfixes, GitHub, Desk, Ayuda). Card =
                            L1 dot+identidad+íconos PR/Desk · L2 título limpio
                            (cleanTitle pela el prefijo "TKT #N — ") · L3 estado
                            COMPLETO sin truncar · L4 semáforo si hay
                            investigación cargada; card-PR con borde acento +
                            ↳ TKT anidados; mismo listener delegado que la tabla
                            (.bb-row/.bb-detail + data-key en ambas vistas). El
                            input de búsqueda es un ref ESTABLE que el render
                            jamás re-crea (no pisar el tipeo). VISTA DE FOCO
                            (Fase 4, §3.3/§3.4, SOLO en las cards ≤640px — la
                            tabla desktop sigue con detailHtml plano): al tap la
                            card se ancla al tope (scrollIntoView en index.js) y
                            su detalle se presenta con focusWrap = header sticky
                            (← bb-focus-back cierra, + identidad) · veredicto +
                            estado + chips PROMINENTES · secciones LARGAS en
                            <details> colapsados (focusSec: Resumen/archivos,
                            Timeline, GitHub en vivo, Zoho Desk — nacen cerradas,
                            se pueden usar <details> sin tocar desktop porque el
                            detalle-foco solo se renderiza en .bb-card-det) ·
                            links · ACTION BAR sticky inferior (.bb-actionbar):
                            primaria sólida (Trabajar en esto / Trabajar en Chat
                            plan / Actualizar ticket en gh / Archivar si complete
                            / Restaurar si archivado) + secundaria Investigar
                            (a fondo o contexto según haya PR) + menú ⋯
                            (bb-ab-more → popup Responder ticket · Traer Desk ·
                            Archivar · Cancelar PR · Descartar; lo abre index.js,
                            resuelve b por key y ejecuta la acción directa porque
                            el popup vive en document.body fuera del bb-detail).
                            detailMobileHtml/triageMobileHtml/ghMobileHtml en
                            render.js; el action bar reusa los MISMOS data-act de
                            la tabla (closest('.bb-detail') resuelve la key igual).
                            ACCIÓN GLOBAL (Fase 5, §3.5): "Enviar pendientes (N)"
                            es un action bar STICKY inferior de la LISTA
                            (.bb-listbar tras el bb-box, móvil-only por CSS, en
                            la zona del pulgar) visible SOLO si hay pendientes Y
                            ninguna card en foco (expanded.size===0: con una card
                            abierta manda el action bar del detalle) — si no hay
                            nada que enviar, no existe. Salió del menú ⋯ (que
                            queda con Buscar bugfixes · GitHub · Desk · Ayuda). En
                            móvil .bb es flex column y bb-box flex:1 para anclar
                            la barra al fondo. El confirm de envío (una entrada
                            por línea, .dlg-msg pre-line + scroll del modal) entra
                            sin overflow en 375px.
                            UNA fila por ticket para TODO el ciclo — triage → trabajo → PR →
                            feedback → merge → ticket. Fuentes: registro de bugfixes +
                            triage de Desk (chips de verificación: severidad, "abierto en
                            Desk"/"no está en el triage", dup, 🔁 reabierto ×N, ⚠ doble
                            registro, 🎫 estado Desk, frescura del triage) + PRs solo-GitHub.
                            Detalle expandible: resumen, archivos, TIMELINE (history[]),
                            panel "GitHub en vivo" (pr-live: reviewDecision, checks, commits,
                            comentarios de Chris; ↻ fresh) y acciones: Trabajar en esto
                            (prompt con HISTORIAL + aviso de feedback), Actualizar ticket
                            (chat SIN ticket:{} a propósito — no debe re-registrar trabajo
                            ni devolver el fix a pendiente; redacta la nota EN INGLÉS y
                            escribe en Desk solo con la aprobación del usuario), Cancelar PR,
                            Descartar registro; filas solo-triage con "Trabajar en Chat
                            (plan)". El confirm de "Enviar pendientes" lista las
                            ADVERTENCIAS de verificación por fix (rojo si hay) y avisa el
                            auto-update de Desk de los PRs nuevos. Enviar = update repo
                            previo (callback updateRepo) + POST /pr por fix.
                            EXCLUSIVO de ~/tolkien) · explorer ·
                            mobile/auxbar (teclas Esc/Tab/flechas/^C + dictado, SOLO para
                            vistas de terminal: con la vista Chat activa la barra ENTERA —
                            botón ⌨ incluido — se oculta por CSS puro con
                            body:has(.terminal-pane.active.chat-pane-host) en style.css,
                            selector con #terminals+3 clases que le gana al display:flex
                            del media query móvil; la TUI es .conv-tui-host y no matchea,
                            ahí la barra queda) ·
                            usage (pie: tokens de HOY; su modal "Uso" REDISEÑADO 2026-07-10:
                            arriba límites del plan — /api/tokens/limits, barras % con umbrales
                            ok/warn/danger, "queda X% · resetea en …" y "· ≈ X tok" (token-count
                            NUESTRO de la ventana: session=5 h · weekly=7 d · scoped=ese modelo,
                            de summary.windows — Anthropic solo da %) + fila de créditos COLAPSABLE
                            (<details>). Abajo UNA barra de controles (Día/Semana/Mes + $/tok) que
                            maneja las DOS columnas: 📊 General · <período> (total del rango elegido
                            por modelo, con Pac-Man pac-sm en los que consumen AHORA lastMtime<2min)
                            y 📈 Tendencia = gráfica de barras APILADAS por modelo (Chart.js): Día=
                            horas de hoy · Semana=7 días · Mes=30 días. SIN "Hoy" ni Reset. Los 3
                            filtros van en UNA fila (2026-07-10) como SEGMENTED CONTROLS (.uh-seg
                            contenedor pastilla + .uh-seg-btn, activo con tinte acento): rango +
                            PROYECTO (Todos/Consola/Tolkien/Otros, aplica a ambas columnas; los
                            límites NO se filtran) + métrica anclada a la derecha; los handlers
                            seleccionan por data-attribute ([data-range]/[data-project]/[data-metric]).
                            ORDEN POR PRECIO/economía
                            (2026-07-10): la lista General va de más COSTOSO arriba a más ECONÓMICO
                            abajo (Fable→Opus→Sonnet→Haiku) con badge $X/M por modelo (PRICE_INPUT,
                            coincide con pin() del backend) + caption "▲ más costoso · ▼ más
                            económico"; la gráfica apila con el más barato en la BASE (keys en orden
                            de precio del backend). El caché de series usa clave `${range}:${project}`. Todo en
                            hora LOCAL de Medellín (backend time.js). APERTURA INSTANTÁNEA
                            (2026-07-10, "se queda procesando" al abrir): el parseo de transcripts
                            tarda ~2 s, así que hay una CACHÉ EN MEMORIA de módulo (`cache`
                            {summary,limits,series}) que el poll del pie (tick) mantiene caliente; al
                            abrir, `paint('draw')` pinta lo cacheado AL TOQUE (0 fetch, ~130 ms) y
                            `refresh(false)` actualiza en segundo plano SIN bloquear. UN solo botón
                            Actualizar (spin `.spinning` mientras carga; refresh(true) saltea el TTL).
                            Auto-refresh SILENCIOSO cada 15 s (AUTO_MS): updateChart() reemplaza
                            labels+datasets y update('none') EN EL LUGAR (sin destruir/re-animar → no
                            parpadea); drawChart() (crear) solo al abrir y al cambiar rango/métrica.
                            El toggle $/tok re-dibuja de la serie cacheada (0 fetch); cambiar rango
                            trae datos solo si faltan en caché (Día del summary, Semana/Mes de
                            /history). SUMMARY_TTL_MS subido 4 s→15 s (menos re-parseos). reexporta
                            fetchLimits/fmtReset/renderLimits (renderLimits(el,data,{windows}) — el
                            pie plan-limits.js lo reusa sin windows: créditos colapsables ahí también,
                            sin token-counts); destroyChart en onClose (sin leaks de Chart.js))
public/js/ui/               icons.js (único set de íconos) · dialog.js (CERO diálogos nativos:
                            openModal/confirmDialog/promptDialog/alertDialog/textEditorDialog +
                            confirmSheet — confirmación ADAPTATIVA 2026-07-07: en desktop delega en
                            confirmDialog (ventana centrada), en móvil (matchMedia max-width:768px)
                            muestra un "menú de deslizamiento" = bottom sheet .dlg-sheet que sube
                            desde abajo, con grip + swipe-down para cancelar + botones full-width
                            táctiles 44px; devuelve Promise<boolean> igual que confirmDialog. Lo usa
                            el botón "Detener" del chat (chat-tab.js: confirma antes de enviar
                            {type:'interrupt'} — Parar/Cancelar). Estilos .dlg-sheet* en ui.css) ·
                            markdown.js (sanitizado ALLOWLIST) · diff.js · popup.js (dismissablePopup) ·
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
                            runners consumen tokens en paralelo"). Widget COMPACTO en el pie de la
                            barra DERECHA (#activity-widget en index.html, ENTRE .tk-persist de
                            Tolkien y el data-module="stats" de los gauges). SIEMPRE VISIBLE
                            (pedido de Niko 2026-07-11 "actualicé y no lo veo": un widget que se
                            esconde cuando está vacío es indescubrible): en reposo se atenúa
                            (.cwc-activity--idle: opacity+borde punteado, 0/0, semáforo gris) y al
                            arrancar algo se enciende. OJO: NO existe la clase .hidden en el CSS
                            (solo el guard [hidden] de atributo) — no togglearla. Como el espacio es chico:
                            ÍCONOS+NÚMEROS — dos columnas ✦ N subagentes (chats con delegating) · ⚙️
                            N procesos/runners — + un SEMÁFORO (punto coloreado con modelColor del
                            MODELO DOMINANTE corriendo ahora, ui/models.js). Clickeable → abre
                            modules/system/activity-modal.js (openModal): TABLA DINÁMICA agrupada
                            tipo árbol (<details> "Subagentes" / "Procesos en segundo plano") con
                            tipo·qué·sesión-que-lo-llamó·tiempo-corriendo·modelo; el subagente
                            linkea a su chat de origen (openChat, patrón perm-center). DINÁMICO en
                            dos planos: el widget refresca la lista en cada poll de 8 s (si el modal
                            está abierto, refreshActivityModal) + un timer propio de 1 s hace tictac
                            el "tiempo corriendo". NO encuesta solo: main.js lo alimenta en
                            pollTabStatus con initActivityWidget({openChat}).update(processes, chats)
                            — processes del endpoint nuevo GET /api/health/active-runners (0 tokens,
                            solo lee locks/jobs), agents derivados de /api/chat/list (delegating +
                            delegatingCount + delegatingSince, YA en info()). El endpoint devuelve
                            {processes, processCount, dominantModel}; su detección vive en
                            collectActiveRunners() de health/shared.js: un REGISTRO declarativo de
                            los ~17 runners (familias lock {pid,ts,phase} / job {status:'running',
                            startedAt} — sub-tipos job/jobglob/jobdir) que ESCANEA los archivos de
                            ~/.cwc-data directamente (misma lógica de frescura que cada isXRunning,
                            centralizada — NO importa los 17 módulos: evita acoplamiento/circular).
                            Modelo por runner = mapa estático (documentado, para el semáforo);
                            startedAt = birthtime del lock/job ≈ spawn. Agregar un runner nuevo = una
                            fila más en RUNNER_REGISTRY; si su lock nunca existe, no se lista)
public/js/modules/chat/chat-tab.js  vista chat · public/js/modules/terminal/terminal.js  vista terminal
public/css/tokens.css       TODAS las variables (--cwc-*); CERO hex fuera de acá
public/css/ui.css           .btn/.btn-ghost, .dlg-*, .cwc-popup-menu, guard [hidden].
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
public/css/fm.css           estilos del gestor de archivos (compactado 2026-07-07 junto al resto)
public/archivos.html + js/filemanager/fm.js   Gestor de archivos (página aparte, iframe en el Explorador)
bin/cwc-chat-runner.js      motor de UNA conversación (proceso propio, socket Unix)
bin/cwc-triage-runner.js    corrida del triage de bugs (proceso propio; interfaz por archivos).
                            DOS FASES EN PARALELO (optimización IA 2026-07-05): (1) query
                            barata que solo LISTA los [Tolkien Bug] abiertos; (2) triage de
                            CADA ticket en paralelo vía runAdaptivePool (health/pool.js, mismo
                            patrón que desk-runner), 1 query corta por ticket con escritura
                            INCREMENTAL a tickets.json — un timeout pierde solo ese ticket,
                            nunca el batch. Doble capa read-only (regla 6) en CADA query.
                            CACHÉ INCREMENTAL por ticket (triage-cache.json, fingerprint
                            status+subject del listado + TTL 12 h): sin cambios y fresco ⇒
                            reusa el triage anterior sin query() (0 tokens); --full la ignora
bin/cwc-health-runner.js    revisión exhaustiva de salud (barrido módulo x módulo; interfaz por archivos)
bin/cwc-healthfix-runner.js resolución AUTÓNOMA de UN hallazgo de salud (ESCRIBE código:
                            allowlist fixToolAllowed, node --check, sin reinicio — excepción
                            regla 6). Prompt COMPARTIDO con el orquestador de batch: fixPrompt()
                            de health/shared.js (fusión Optimización IA 2026-07-06 — antes tenía
                            una copia inline divergente que pedía "FIXFAIL falso positivo" y el
                            FP quedaba 'failed', re-auditándose con sonnet en CADA revisión).
                            Falso positivo (FIXNONE/"falso positivo") ⇒ markFindingDismissed()
                            de shared.js (punto ÚNICO de "marcar descartado"; también delega ahí
                            el markDismissed del orquestador): fixStatus:'dismissed' en
                            review.json + registro durable health-dismissed.json → dismissedFor
                            lo inyecta al auditor y el bucle escaneo→mismo FP→escaneo se corta
                            también resolviendo hallazgos SUELTOS, no solo por batch
bin/cwc-health-resolve.js   marca UN hallazgo como RESUELTO (fixStatus:'resolved' en review.json
                            + recordSolved). Lo corre el PROPIO chat "En chat" al terminar (le
                            paso el id en el prompt) para que el tablero refleje el cierre.
                            Determinístico, 0 tokens, NO toca código. Reusa markFindingResolved
                            de health/shared.js (mismo helper que el endpoint POST /finding-resolve
                            del botón manual "Marcar resuelto")
bin/cwc-bugfix-link.js      vincula un PR YA existente de GitHub a un registro del tablero
                            Bugs & Features (pata de PREVENCIÓN del bug 2026-07-05 "el
                            tablero no se entera del trabajo en los chats"): lo corre el
                            PROPIO chat en el MISMO turno de un push hecho por fuera del
                            módulo "Enviar PR" (excepción autorizada). Determinístico, 0
                            tokens (patrón cwc-health-resolve): un gh pr view de LECTURA +
                            escritura de bugfixes.json vía linkPrToRegistry de
                            bugfixes/link-shared.js (la MISMA lógica del endpoint POST
                            /link-pr y de la reconciliación de refresh-prs). NO importa
                            core/config.js (haría exit fuera del repo): carga el .env por
                            ruta explícita. Uso: cwc-bugfix-link.js <TKT-n|FEAT-n|sessionId> <nroPR>
bin/cwc-desk-runner.js      consulta EN VIVO del estado de un ticket en Zoho Desk (READ-ONLY
                            doble capa, allowlist desk_* de lectura; interfaz por archivos:
                            desk.lock heartbeat + desk-live/<ticket>.json resultado). Lógica
                            compartida con el módulo en bugfixes/desk-shared.js
bin/cwc-projects-analyze-runner.js análisis IA (guardián) de UN cambio de sección de contexto
                            (CLAUDE.md) del módulo projects, DESACOPLADO del server (haiku, 1
                            turno, CERO herramientas — doble capa regla 6 deniega TODO).
                            Interfaz por archivos: ~/.cwc-data/projects-analyze/<id>.json
                            (job con before/after que escribe el POST; el runner persiste el
                            veredicto en el MISMO archivo). Lógica compartida en
                            src/modules/projects/analyze-shared.js
bin/cwc-commitmsg-runner.js generación IA del mensaje de commit del botón "Commit (sin push)"
                            del panel Backup, DESACOPLADA del server (haiku, 1 turno, CERO
                            herramientas — doble capa regla 6 deniega TODO; el diff viaja en
                            el prompt, capturado por el server EN NODE). Interfaz por
                            archivos: ~/.cwc-data/commitmsg/<id>.json (job con files/diff que
                            escribe el POST; el runner persiste el mensaje en el MISMO
                            archivo). Lógica compartida en src/modules/backup/commitmsg-shared.js
bin/cwc-audio-runner.js     análisis IA de UNA transcripción de audio (módulo `audio`),
                            DESACOPLADO del server (regla de oro; sonnet, 1 turno, CERO
                            herramientas — doble capa regla 6 deniega TODO; el texto viaja
                            entero en el prompt). Interpreta quién dijo qué y por qué, arma un
                            plan y propone tareas. Interfaz por archivos:
                            ~/.cwc-data/audio/<id>.json (job con la transcripción que escribe el
                            POST; el runner persiste el resultado en el MISMO archivo). Lógica
                            compartida en src/modules/audio/shared.js
bin/cwc-retro-runner.js     MEJORA CONTINUA (ROAD-256): destila LECCIONES DE PROCESO de UNA
                            sesión de chat al cerrarla (módulo `retro`), DESACOPLADO (regla de
                            oro; sonnet, 1 turno, CERO herramientas — doble capa regla 6 deniega
                            TODO; la transcripción condensada viaja en el prompt). Tras destilar
                            hace el UPSERT determinístico en Pad local (dedup por fingerprint =
                            recurrencia; le pasa las lecciones ya registradas al modelo para que
                            reuse el título exacto de un concepto repetido = patrón "dedup vs
                            seen"). Interfaz por archivos: ~/.cwc-data/retro/<id>.json (id sha1
                            del sessionId; lo encola el server en Chat.close). Lógica compartida
                            en src/modules/retro/shared.js (+ store en src/modules/retro/store.js,
                            router de promoción en src/modules/retro/promote-shared.js)
bin/cwc-retro-curate-runner.js CURADURÍA IA del registro de MEJORA CONTINUA (ROAD-256,
                            Fase 5), DESACOPLADO (regla de oro; sonnet, 1 turno, TEXTO PURO — doble
                            capa regla 6 deniega TODO; el server junta lessons+reglas duras en el
                            job). Detecta duplicados/contradicciones/redundantes/consolidables/
                            huecos. Un solo job en ~/.cwc-data/retro-curation.json (+
                            retro-curate.log). Lógica en src/modules/retro/curate-shared.js
bin/cwc-tasks-analyze-runner.js ANÁLISIS GENERAL IA del tablero de Pendientes (botón "🧠
                            Análisis general" de las pestañas Tareas/Planes), DESACOPLADO del
                            server (regla de oro; sonnet, 1 turno, CERO herramientas — doble capa
                            regla 6 deniega TODO; los datos se juntan EN NODE y viajan en el
                            prompt). Arg `scope` = tasks|plans: junta TODAS las tareas (o planes)
                            + los informes de audio y devuelve {resumen, duplicados, unificables,
                            completar}. Interfaz por archivos: ~/.cwc-data/tasks-analysis-<scope>.json
                            (status running/done/error, dedup por corrida fresca, sin lock aparte).
                            Lógica compartida en src/modules/tasks/analyze-shared.js
bin/cwc-learning-explain-runner.js "🎓 Explicame esto" del MÓDULO DE APRENDIZAJE
                            (learning), DESACOPLADO (regla de oro). A DIFERENCIA de los runners de
                            texto puro, éste SÍ LEE el código: NAVEGA read-only (Read/Grep/Glob,
                            allowlist explainToolAllowed, doble capa regla 6) el repo del `scope` del
                            tema (la consola o Tolkien vía config.projectDir), sonnet, maxTurns 24,
                            timeout 6 min, settingSources: []. Al terminar AUTO-GUARDA la explicación
                            guiada en el tema (store.saveExplanation). Interfaz por archivos:
                            ~/.cwc-data/learning-explain-<id>.json (job con snapshot del tema que
                            escribe el POST). REGENERACIÓN INTELIGENTE (2026-07-10): el job puede traer
                            `mode` ('full'|'adapt') + `topic.previousExplanation`/`topic.reason` — en
                            'adapt' el prompt le pasa la explicación anterior para que la actualice en
                            vez de arrancar de cero (la DECISIÓN full/adapt/noop la toma el endpoint del
                            server ANTES de spawnear, ver explain-shared.js checkStaleness). Al terminar
                            también parsea el bloque ```files``` de la respuesta (parseFiles) y
                            snapshotea esos archivos (fileSnapshot) para la próxima huella de código.
                            Lógica en src/modules/learning/explain-shared.js
bin/cwc-learning-context-runner.js "🎙️ Contexto adicional" de un TEMA de aprendizaje
                            (2026-07-10, pedido de Niko), DESACOPLADO (regla de oro). Interpreta una
                            TRANSCRIPCIÓN (charla con Chris, un chat, notas de reunión) — a diferencia
                            del runner de explicación, éste es de TEXTO PURO: CERO herramientas, doble
                            capa regla 6 deniega TODO (mismo patrón que
                            tickets/context-analyze-shared.js pero de alcance PROPIO, sin acoplar los
                            dos módulos). Al terminar AGREGA el resultado interpretado como una
                            entrada 'ia' de la LISTA `contextoEntradas` del tema
                            (store.addContexto{source:'ia'} — NO sobrescribe las demás), que se
                            inyecta en el próximo "Regenerar". Interfaz por archivos:
                            ~/.cwc-data/learning-context-<jobId>.json (id determinístico por
                            tema+transcripción: un reintento con el mismo texto reusa el mismo job) +
                            learning-context.log. Lógica en src/modules/learning/context-shared.js
bin/cwc-learning-analyze-runner.js "🧠 Analizar aprendizaje" del MÓDULO DE APRENDIZAJE,
                            DESACOPLADO (regla de oro; sonnet, 1 turno, CERO herramientas — doble capa
                            regla 6 deniega TODO; los temas se juntan EN NODE y viajan en el prompt).
                            Organiza TODOS los temas: duplicados/unificables/completar/agrupar-en-rutas/
                            aprenderPrimero/sugerirNuevos. Interfaz por archivos:
                            ~/.cwc-data/learning-analysis.json (status running/done/error, dedup por
                            corrida fresca). Lógica en src/modules/learning/analyze-shared.js.
                            OJO: los 3 runners de aprendizaje (explain/context/analyze) capturan el
                            `session_id` del msg SDK `system/init` y lo registran vía
                            `src/modules/learning/session-log.js` (registerLearningSession →
                            ~/.cwc-data/learning-session-ids.json) para que el módulo tokens atribuya
                            su consumo al bucket 'aprendizaje' aparte de 'consola' (ver módulo tokens)
bin/cwc-investigate-runner.js investigación a fondo de UN PR (¿la pelota es tuya o de Chris,
                            y qué hacer?). Junta datos con gh EN NODE y el modelo los interpreta
                            SIN herramientas (read-only MÁXIMO, regla 6). Interfaz por archivos:
                            investigate.lock + investigations/<pr>.json. Lógica en
                            bugfixes/investigate-shared.js
bin/cwc-ticket-investigate-runner.js investigación de CONTEXTO de UN ticket SIN PR (¿por qué
                            NO se resolvió?). LEE el código de Tolkien read-only (Read/Grep/Glob,
                            misma allowlist que el auditor de Salud — regla 6), cwd Tolkien, sonnet,
                            maxTurns 16. Interfaz por archivos: ticket-investigate.lock +
                            ticket-investigations/<n>.json (resultado) + <n>.req.json (enunciado que
                            escribe el server). Lógica en bugfixes/ticket-investigate-shared.js
bin/cwc-optimize-runner.js  OPTIMIZACIÓN IA de los motores de la consola (botón "🧠
                            Optimización IA" de la pestaña Salud). Junta el CENSO
                            determinístico de motores IA (aiEnginesCensus de core/inventory.js:
                            qué modelo/turnos/timeouts/blindaje usa cada corrida del SDK, 0
                            tokens) + el CONSUMO REAL (buildSummary del módulo tokens, export
                            deliberado) y UNA corrida de sonnet (READ-ONLY doble capa regla 6,
                            misma allowlist que el auditor de salud: Read/Grep/Glob/TodoWrite,
                            settingSources: [], cwd = la consola) que VERIFICA leyendo el
                            código y devuelve {resumen, propuestas[] (modelo/turnos/timeout/
                            flujo/fusion/paralelismo/prompt, con riesgo y pasos), flujoNuevo}.
                            Interfaz por archivos: optimize.lock (heartbeat con fase) +
                            optimization.json (resultado persistido). Las propuestas NUNCA se
                            auto-aplican: quedan pending y Aprobar = chat supervisado
                            (acceptEdits) / flujo nuevo = chat en modo plan; Descartar las
                            marca rejected. Lógica compartida en health/optimize-shared.js
                            (su plomería lock/heartbeat + store persistido + parseo de
                            propuestas son FÁBRICAS de health/proposal-runner-shared.js —
                            makeLock/makeResultStore/makeProposalParser + allowlist
                            readOnlyToolAllowed — compartidas con coherence-shared.js;
                            fusión 2026-07-06 propuesta por la propia Optimización IA:
                            estaban duplicadas línea por línea y ya habían divergido.
                            Ambos módulos re-exportan los nombres históricos
                            (writeOptLock/parseCoherence/…): runners y server no cambian)
bin/cwc-coherence-runner.js MÓDULO DE COHERENCIA (subsección "🔗 Coherencia" de la pestaña
                            Salud). Gemelo del optimizador pero mira las ARISTAS del sistema,
                            no los nodos: ¿los motores/módulos se usan ENTRE SÍ o reinventan/
                            duplican/se ignoran? (disparador: motores del ciclo de tickets que
                            NO usaban `comms`). Junta el CENSO determinístico de coherencia
                            (core/inventory.js → coherenceCensus: grafo quién-usa-a-quién por
                            imports resueltos + consumo de servicios transversales comms/bus/
                            inventory/tokens/paths/sdk-settings + señales gh/runners/motores) +
                            los HALLAZGOS de cableado determinísticos (evaluateCoherence de
                            health/coherence-shared.js: comms infrautilizado · gh fuera de las
                            fuentes canónicas (lector pr-read-shared / gateway gateway-shared;
                            exenciones verificadas en GH_EXEMPT) ·
                            runner sin regla de oro · motor sin doble capa · servicio huérfano ·
                            COMPLETITUD del inventario: módulo sin registrar/frontend sin montar
                            · runner/motor SDK huérfano; cada hallazgo con `pasos` + botón
                            "Resolver en chat" supervisado. "Está corriendo" NO — eso es runtime,
                            queda en Chequeos rápidos)
                            y UNA corrida de sonnet READ-ONLY doble capa (regla 6, misma
                            allowlist Read/Grep/Glob/TodoWrite, settingSources: []) que VERIFICA
                            leyendo el código y PROPONE el cableado concreto. Interfaz por
                            archivos: coherence.lock (heartbeat con fase) + coherence.json
                            (resultado + hallazgos persistidos). Propuestas NUNCA auto-aplicadas
                            (Aprobar = chat acceptEdits · Explorar flujo = plan · Descartar =
                            rejected), patrón invariant-proposals. Lógica compartida en
                            health/coherence-shared.js (plomería lock/store/parseo =
                            fábricas de health/proposal-runner-shared.js, ver optimize)
bin/cwc-bus.js              CLI del INTERFONO entre sesiones (lógica en src/core/bus.js). PUERTA
                            ÚNICA de los hooks de Claude Code + el comando /btw. Subcomandos:
                            send (lo usa /btw) · hook-inject (SessionStart/UserPromptSubmit:
                            imprime mensajes/lápidas pendientes → Claude los inyecta) ·
                            hook-guard (PreToolUse Edit|Write|MultiEdit: frena si otra sesión
                            VIVA reclama el archivo, exit 2) · hook-claim (PostToolUse: reserva
                            el archivo editado) · hook-release (SessionEnd: suelta claims
                            propios) · list (debug). Identidad propia por $TMUX_PANE (TUI) o
                            session_id del stdin (chat). Fail-open salvo hook-guard. Nudge SEGURO
                            opcional por send-keys SOLO a TUI con claude idle (observador
                            waiting+model+ts fresco); si trabaja o es shell, el mensaje espera en
                            la bandeja
bin/install-interfono.js + bin/uninstall-interfono.js  instalan/quitan los hooks del interfono
                            en ~/.claude/settings.json + el comando ~/.claude/commands/btw.md
                            (aditivo/reversible, patrón install-observer: preservan entradas
                            ajenas incluidas las del observador; filtran las propias por marca
                            `cwc-bus.js`). OJO: los hooks se capturan al INICIAR claude — las
                            sesiones ya abiertas no toman el interfono hasta reiniciar claude
                            adentro (mismo gotcha que el observador)
bin/install-pelota.js + bin/uninstall-pelota.js  instalan/quitan el hook "🎾 La pelota"
                            en ~/.claude/settings.json (UserPromptSubmit con echo puro, marca
                            `cwc-pelota`; aditivo/reversible/idempotente, patrón
                            install-observer). Hace DETERMINÍSTICO el cierre "🎾 Pelota: ..."
                            de las preferencias globales del usuario (~/.claude/CLAUDE.md):
                            inyecta el recordatorio fresco en CADA turno (~40 tokens) porque
                            el CLAUDE.md solo se carga al iniciar y en hilos largos el modelo
                            lo omitía (pedido del usuario 2026-07-05). Mismo gotcha de captura
                            al INICIAR claude que observador/interfono
bin/cwc-comms-runner.js     escaneo de comunicaciones: junta con `gh` (0 tokens, cwd Tolkien)
                            las reviews/comentarios de los contactos con login de GitHub y
                            arma los hilos (github.json). Reanudable (lock/heartbeat +
                            caché incremental por PR). Lógica en src/modules/comms/shared.js
bin/cwc-comms-chatbot-runner.js motor del CHATBOT del módulo comms (botón "🤖 Chatbot"
                            del tablero), DESACOPLADO (regla de oro). Deriva la sección Chatbot de
                            lo que YA escaneamos del bot de Teams "Tolkien" (TheEye) en DOS fases:
                            (1) LEE los mensajes CRUDOS del bot vía Graph (read-only regla 6 =
                            graphReadAllowed, reusa teamsBotPrompt/parseTeamsResponse; fallback a
                            teams.json); (2) INTERPRETA con IA (sonnet, 1 turno, CERO herramientas,
                            doble capa deniega TODO) quién es la persona REAL detrás de cada mensaje
                            relayado y lo atribuye a un contacto conocido; (3) MERGE no destructivo
                            con chatbot.json (append+dedup, preserva el seed). CONSUME TOKENS ⇒ bajo
                            botón. Interfaz por archivos: chatbot.lock (heartbeat con fase) +
                            chatbot.json (resultado). Lógica en src/modules/comms/chatbot-shared.js
bin/cwc-comms-teams-runner.js escaneo de TEAMS (mensajes directos) del módulo comms:
                            por cada contacto lee sus DMs con las tools graph_* de LECTURA
                            del MCP tolkien-mordor (cwd=projectDir, settingSources headless,
                            doble capa read-only regla 6 = graphReadAllowed). CONSUME TOKENS
                            (sonnet) ⇒ bajo botón. Lógica en src/modules/comms/teams-shared.js
                            (teamsBotPrompt/parseTeamsResponse los REUSA cwc-comms-chatbot-runner.js).
                            ATRIBUCIÓN (fix 2026-07-05): cada hilo es entre YO (self.json:
                            Nicolás/nmosquera@/gh nmosqueramordor) y el contacto. Teams exige
                            el 1:1 {yo, contacto} — RECHAZA (found:false) un DM que no me
                            incluya y guarda participants+chatId. GitHub filtra a PRs míos o
                            donde participé (self.github). El tablero muestra los participantes
                            por hilo y marca ⚠️ si no soy parte.
                            INTEGRACIÓN con bugs/bugfixes (2026-07-05, pedido del usuario): regla
                            de diseño — todo flujo del ciclo de TKT/feature/bug que necesita algo
                            DE CHRIS consulta (o a futuro registra) en ESTE motor, en vez de
                            reinventar su propio scraping. Hecho hoy: bugs/board/prompts.js
                            (fetchCommsContext, 0 tokens, GET /api/comms/index ya cacheado)
                            inyecta en "Trabajar en esto" (workPrompt/featurePrompt/triagePrompt)
                            el hilo de GitHub del PR (gh:<prNumber>:chris) y el DM de Teams
                            (teams:chris) si existen — el chat arranca sabiendo qué se habló
                            último con Chris sin abrir el tablero de Comunicaciones a mano.
                            PENDIENTE (fuera de alcance, no implementado): auto-registrar en el
                            motor cuando un chat de trabajo le pide algo a Chris, y unificar el
                            scraping de GitHub hoy DUPLICADO entre bugfixes/desk-shared.js
                            (feedback por PR, caché propia) y comms/shared.js (gh-cache.json
                            propia) — ambos leen `gh` por separado sin compartir fuente.
                            GATEWAY DE ENVÍO (2026-07-05, pedido del usuario: "toda
                            comunicación usa el motor"): comms dejó de ser solo visor
                            read-only — ahora EJECUTA y registra TODO envío externo.
                            gateway-shared.js (sendComm): valida contacto/identidad,
                            aplica la FIRMA centralizada (SIGNATURE, antes hardcodeada
                            en 2 lugares), EJECUTA (github inline con gh, 0 tokens ·
                            desk/teams desacoplado al send-runner con allowlist de
                            escritura gobernada), REGISTRA en outbox.json (ledger
                            append-only de auditoría) + en el hilo del contacto, y
                            DEVUELVE el resultado. dryRun no envía. Endpoints: POST
                            /send · GET /send/:jobId · GET /outbox. CLI: cwc-comms
                            send (ejecuta) · record (registra un envío ya aprobado en
                            un chat, sin re-enviar). MIGRADO: bugfixes ya NO hace gh
                            pr comment/close/add-reviewer ni escribe Desk por su
                            cuenta — pushPr/updatePr/cancelPr y deskUpdateAuto
                            (ticket_auto_update) llaman al gateway; deskChat registra
                            con cwc-comms record tras publicar con tu OK.
                            COMPOSER EN EL TABLERO + REGISTRO VISIBLE (2026-07-06, pedido del
                            usuario "cuando envío algo no me queda registro"): hasta hoy NO
                            había forma de enviar desde la UI del tablero — el envío por
                            Teams solo salía por CLI (cwc-comms send) o desde un chat que
                            llamaba al MCP teams_send POR FUERA del gateway (por eso no dejaba
                            rastro: buildIndex arma los hilos de github/teams/chatbot/manual,
                            NUNCA lee outbox.json). Ahora el tablero (comms/board/) tiene un
                            COMPOSER por contacto (render.js `.cm-composer` bajo el header;
                            el texto vive en store.composer[contactId] y se escribe en cada
                            tecla SIN re-render —listener 'input' en index.js— para sobrevivir
                            a un re-render por scan) que ENVÍA un DM de Teams real vía
                            A.sendMessage → POST /api/comms/send {channel:'teams', action:'dm',
                            contactId, payload:{text}} con confirm duro (publica con tu
                            identidad + firma). Encuesta el job (GET /send/:jobId) y al
                            terminar hace reload() para traer el registro. CLAVE del fix: el
                            composer SIEMPRE pasa contactId ⇒ el send-runner corre appendManual
                            (registro al hilo, línea condicional a job.contactId) ⇒ el envío
                            queda visible en el hilo del contacto (antes, sin contactId,
                            quedaba solo en outbox invisible). Para la vía CHAT (un chat que
                            envía por su cuenta), buildChatPrompt de board/actions.js ahora
                            instruye: si con tu OK enviás, registralo con `cwc-comms record
                            teams dm <contacto> -- "<texto>"` (NO re-envía, solo deja el rastro).
                            El registro nativo en Teams ya existe: el DM sale con TU cuenta al
                            chat 1:1 real, así que aparece en tu Teams solo — el gap era solo el
                            tablero. (La idea original de "que el bot Tolkien/TheEye confirme"
                            NO es viable: no hay NINGÚN enganche programático con OpenClaw/TheEye
                            en este repo — verificado.)
                            BOTÓN "🤖 CHATBOT" — chatbot DERIVADO por IA (2026-07-07, pedido del
                            usuario): hasta hoy la fuente `chatbot` (Chris relayado por el bot
                            Tolkien/TheEye) era 100% seed/manual — no había forma de traer
                            actualizaciones (el usuario recibió novedades de los tkts 252/251/250
                            por ese canal y la consola nunca las ingirió). Ahora el tablero tiene
                            un 3er botón "🤖 Chatbot" (junto a GitHub/Teams) que DERIVA la sección
                            de lo que YA escaneamos del bot, en un RUNNER DESACOPLADO
                            (`bin/cwc-comms-chatbot-runner.js`, lógica en `comms/chatbot-shared.js`;
                            regla de oro + regla 6). DOS FASES: (1) LEER — por cada contacto
                            kind:'bot' con chatId lee sus mensajes CRUDOS de Teams vía Graph
                            (read-only doble capa = graphReadAllowed, reusa teamsBotPrompt/
                            parseTeamsResponse de teams-shared; fallback a teams.json ya escaneado
                            si Graph falla); (2) INTERPRETAR — corrida SDK (sonnet, 1 turno, CERO
                            herramientas, doble capa deniega TODO) que DEDUCE por el CONTENIDO
                            quién es la persona REAL detrás de cada mensaje del bot ("Chris
                            reviewed…" → contacto chris) y lo atribuye a un contacto conocido
                            (chatbotInterpretPrompt/parseChatbotInterpretation); realContactId
                            inválido/"unknown" cae al contacto del bot (botFallbackId) para no
                            perder nada. FASE 3 MERGE — agrupa por contacto real y FUSIONA con
                            chatbot.json existente (mergeChatbotThreads: append + dedup por
                            ts+texto, NUNCA pisa el seed histórico). Extensible: NO solo Chris —
                            cualquier persona relayada que sea contacto conocido se atribuye sola.
                            CONSUME TOKENS (Graph read + interpretación) ⇒ bajo botón con confirm,
                            como Teams. Backend: POST /api/comms/chatbot-refresh (admin, dedup por
                            lock `chatbot.lock` heartbeat con fase, spawnChatbotScan patrón
                            spawnTeamsScan) responde YA; `chatbotRunning` viaja en GET / y /index;
                            el front (board/actions.js scanChatbot) encuesta como el scan de Teams.
                            Frontend: botón en la toolbar (board/index.js, case 'scanchatbot'),
                            `chatbotRunning` en el store, sección 🤖 Chatbot (render.js) con
                            "actualizando…" + invitación al botón cuando está vacía. Estado
                            file-based: ~/.cwc-data/comms/chatbot.json (resultado fusionado) +
                            chatbot.lock (heartbeat) + chatbot.log.
                            CONTENIDO COMPLETO (2026-07-07, pedido del usuario: "los mensajes largos
                            se cortan y no se muestra la totalidad"): en Comunicaciones el mensaje se
                            muestra ENTERO. Los prompts de Teams (teamsPrompt/teamsBotPrompt, ×3)
                            pedían `"text":"<~300 chars>"` — el modelo recortaba en el ORIGEN (los
                            mensajes topaban en ~318 chars); ahora piden el texto COMPLETO ("no lo
                            resumas ni recortes"). Caps de ingesta subidos 1200→8000 (parseTeamsResponse
                            + parseChatbotInterpretation) y el display (render.js msgHtml) ya NO
                            recorta (el `.cm-msg-b` con white-space:pre-wrap envuelve todo, sin clamp
                            CSS — no hace falta "expandir"). mergeChatbotThreads hace UPGRADE: si un
                            re-scan trae el MISMO mensaje con MÁS texto (des-clippeado), reemplaza la
                            versión recortada (clave por ts+arranque, dedup tolerante al des-clippeo).
                            Beneficio colateral: el scan de Teams (mismo prompt) también trae mensajes
                            completos. Data vieja clippeada: se sana con un re-scan.
                            CHATEAR DIRECTO + ENVÍO A BOTS (2026-07-06, pedido del usuario
                            "poder chatear/responder rápido"): (1) botón "Responder" en cada
                            hilo (render.js data-act='reply') que hace scroll+focus al composer
                            del contacto (respuesta veloz sin scrollear). (2) ENVÍO A BOTS: el
                            send-runner (teamsDmPrompt de bin/cwc-comms-send-runner.js) para un
                            contacto kind:'bot' con chatId conocido ENVÍA DIRECTO a ese chatId
                            con teams_send_message (el "ubicar chat 1:1" fallaría igual que el
                            scan — graph_list_chats no surface bots); personas siguen con la
                            vía 1:1. Verificado dryRun: Tolkien→vía-bot-directa, Chris→vía-
                            persona. La firma "— Nicolás (dev team)" se sigue aplicando a TODO
                            envío Teams (ensureSignature del gateway) — inocua para un bot,
                            revisable si molesta.
                            TOLKIEN COMO CONTACTO (2026-07-06): "Tolkien" (Mordor's AI
                            assistant, bot de Teams) se agregó a DEFAULT_CONTACTS (shared.js)
                            y al contacts.json vivo — id 'tolkien', kind:'bot', sin github/
                            email. Al usuario le llegan mensajes de ese bot y debe procesarlos
                            igual. El tablero lo marca con badge "🤖 bot".
                            SCAN DE BOTS (teams-shared.js teamsBotPrompt + runner elige por
                            contact.kind==='bot'): VERIFICADO 2026-07-06 que graph_list_chats
                            del MCP NO surface los chats con apps/bots (solo devuelve 1:1 entre
                            PERSONAS — el modelo reportó "revisé 8 chats 1:1, ninguno es la app
                            Tolkien"). Por eso el prompt de bot tiene DOS vías: (1) VÍA DIRECTA
                            preferida — si el contacto tiene un `chatId` guardado, lo lee
                            directo con graph_read_chat_messages (saltea el "buscar" que falla);
                            (2) fallback de búsqueda si no hay chatId. El chatId del bot Tolkien
                            se tomó del seed chatbot.json (formato 19:<miGUID>_<appGUID>@unq.
                            gbl.spaces) y se guardó en el contacto. parseTeamsResponse RELAJA la
                            validación de miembros para kind:'bot' (solo exige que YO esté — el
                            bot no matchea por email/nombre de persona). CON la vía directa el
                            scan trajo los 15 mensajes reales del bot. Un contacto-bot nuevo sin
                            chatId conocido caería a la vía búsqueda (que hoy falla por el MCP) —
                            para esos, guardar el chatId a mano en contacts.json es el camino.
                            LECTURA CENTRALIZADA Fase C (2026-07-05): comms/pr-read-shared.js
                            (fetchPrRich) es el LECTOR ÚNICO de un PR de GitHub — SUPERSET de
                            campos (unión de prLive+investigate+comms) + caché de archivo por
                            PR con TTL 60 s en ~/.cwc-data/comms/pr-cache/. Los tres consumidores
                            (bugfixes/prLive, bin/cwc-investigate-runner.js, bin/cwc-comms-runner.js)
                            la usan: la triple lectura de red del feedback de Chris quedó unificada
                            (cada uno sigue parseando SOLO sus campos; se comparte el fetch+caché).
                            liveCache in-process de prLive eliminado. Quedan fuera los `gh pr view
                            --json state` de un campo (verificación de estado en cancel/refresh),
                            que no son la lectura de feedback.
bin/cwc-comms-send-runner.js EJECUTOR desacoplado de envíos Desk/Teams del GATEWAY de
                            comms (2026-07-05): publica notas de Desk (desk_add_comment/
                            update) y DMs de Teams (teams_send) vía MCP con ESCRITURA
                            GOBERNADA (doble capa regla 6, ahora permitiendo SOLO los
                            verbos de envío del canal — deskWriteAllowed/teamsWriteAllowed).
                            Job en ~/.cwc-data/comms/send/<id>.json. Lógica en
                            src/modules/comms/gateway-shared.js
bin/cwc-comms-analyze-runner.js análisis IA de UN hilo de comunicaciones (resumen +
                            clasificación: estado/pelota, tema, proyecto sugerido, próximo
                            paso, clima), DESACOPLADO (regla de oro; haiku, 1 turno, CERO
                            herramientas — doble capa regla 6, solo resume el texto ya
                            indexado). Job en ~/.cwc-data/comms/analyze/<id>.json (id
                            determinístico por hilo+contenido). Lógica en
                            src/modules/comms/analyze-shared.js
bin/cwc-comms.js            CLI TRANSVERSAL del motor de Comunicaciones (patrón cwc-bus.js):
                            cualquier sesión registra/consulta una comunicación con un
                            contacto sin depender del server. Subcomandos: log/query/list/
                            contacts/contact-add/scan. Estado file-based en ~/.cwc-data/comms/
bin/cwc-observe.js + (un)install-observer.js  observador de estado de Claude Code
bin/cwc-inventory.js        regenera el INVENTARIO del proyecto (core/inventory.js) a mano (--force)
bin/cwc-tolkien-refresh-runner.js  refresh de la DB LOCAL de Tolkien (TRUNCATE + reimport de
                            importers Zoho), DESACOPLADO (regla de oro/regla 2: operación larga que
                            DEBE sobrevivir a un reinicio de la web). NO usa el SDK (0 tokens:
                            comandos locales psql/infisical/pnpm — regla 6 no aplica). Interfaz por
                            archivos: ~/.cwc-data/tolkien-refresh.json (job que reserva el POST
                            /refresh-data; el runner persiste el resultado) + tolkien-refresh.log.
                            Lógica en src/modules/tolkien/refresh-shared.js
bin/cwc-ticket-context-runner.js  CONTEXTO ADICIONAL de un ticket/PR (módulo VIVO
                            `tickets/`, 2026-07-07): interpreta con IA una TRANSCRIPCIÓN de
                            una charla (con el cliente/equipo) y destila el contexto que le
                            sirve a quien vaya a trabajar el ítem. DESACOPLADO (regla de oro) +
                            READ-ONLY doble capa (regla 6: sonnet, 1 turno, CERO herramientas —
                            el texto viaja entero en el prompt). Interfaz por archivos:
                            ~/.cwc-data/ticket-context/<id>.json (id determinístico por
                            key+transcripción). Al terminar AUTO-GUARDA el resultado en el
                            meta-store del ítem (decisión de Niko: auto-guardar al interpretar).
                            Lógica en src/modules/tickets/context-analyze-shared.js
systemd/claude-web-console.service  unidad (copia instalada: ~/.config/systemd/user/)
docs/                       frontend-modules.md · brief-original.txt · contexto-ui.md (histórico)
```

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
- **Admin-gating:** endpoints sensibles con `isAdmin(req)` de `core/auth.js`
  (patrón en backup/index.js).
- **tmux:** siempre a través de helpers con validación (`core/tmux.js`,
  `tmuxArgs` de sessions.js). Ids de sesión NUNCA texto arbitrario del cliente.
- **Comentarios y commits en español**, estilo del repo (mensajes descriptivos,
  un tema por commit).

## Gotchas conocidos (te van a morder si los ignorás)

- `renderMarkdown()` (public/js/ui/markdown.js) DEVUELVE UN NODO DOM ya
  sanitizado, NO un string. Interpolarlo en un template de innerHTML
  (`` `<div>${renderMarkdown(x)}</div>` ``) imprime literalmente
  `[object HTMLDivElement]` (bug real 2026-07-10 en learning.js — notas/
  explicación; el mismo patrón roto sigue en tasks/tasks.js). Dos usos
  correctos: (a) appendChild del nodo (como chat-tab.js), o (b) si NECESITÁS
  string para innerHTML, tomá `renderMarkdown(x).innerHTML` (learning.js usa
  el helper `mdHtml` para eso — sigue siendo seguro porque el nodo ya pasó
  por sanitize()).
- En `Session` (terminal/sessions.js) la propiedad de adjuntado es
  `attachSpec`, NO `attach` (colisiona con el método `attach(ws)`).
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
- **MCP de Pad (getpad.dev) disponible en Consola** (2026-07-10, pedido del
  usuario "integremos la mcp de pad en consola"): igual que Tolkien
  (`~/.claude.json → projects["/home/nmosquera/tolkien"].mcpServers.pad`), el
  proyecto Consola tiene su PROPIA entrada en scope LOCAL —
  `~/.claude.json → projects["/home/nmosquera/claude-web-console"].mcpServers`.
  CERO cambios de código: `settingSourcesFor('chat')` de `core/sdk-settings.js` YA
  incluye `'local'`, que es la fuente que el SDK usa para resolver `mcpServers` — no
  hace falta pasar `mcpServers` a mano en `chatQueryOptions()`. Deliberadamente en
  scope LOCAL (no en un `.mcp.json` versionado): es personal/OAuth de Nico. Alcance:
  SOLO chats interactivos (`settingSources: ['user','project','local']`) — ningún
  runner headless lo carga (todos usan `settingSources: []` o, los 3 de Teams/comms,
  `cwd=Tolkien`, nunca cwd=Consola). MISMO gotcha de siempre: un chat YA VIVO no
  relee `~/.claude.json` — hace falta "Reabrir para cambios" (menú ⋯ de Sesiones) o
  una conversación nueva para que `ToolSearch` empiece a encontrar las tools nuevas.

  **CUTOVER A SELF-HOSTED LOCAL (2026-07-11/12, ver ROAD-74 en Pad workspace
  `console` para el detalle completo de las 4 fases).** El pedido de self-host fue
  denegado, ESCALADO y RE-APROBADO por un superior de Niko con la condición de
  binario local (sin Docker) + impacto de recursos medido antes de aprobar. Hoy:
  - **`pad`** (nombre CANÓNICO, PRIMARIO) = Pad **LOCAL self-hosted** — transporte
    **stdio** (`claude mcp add --scope local pad -- ~/.local/bin/pad mcp serve
    --url http://10.213.222.62:7777`), NO HTTP (el binario local NO expone HTTP
    MCP, solo el CLI habla JSON-RPC por stdio; el server web en el puerto 7777 es
    la SPA, no un endpoint MCP). Instalado en `~/.local/bin/pad` (v0.9.2, checksum
    verificado), servido por systemd de usuario `~/.config/systemd/user/pad-local.service`
    (`ExecStart=%h/.local/bin/pad server start --host 10.213.222.62 --port 7777`,
    `CPUQuota=200%` = techo de 2 núcleos con holgura, `MemoryMax=4G`/`MemoryHigh=3G`
    = techo sobredimensionado para crecer — pedido explícito de Niko, uso real
    medido ~50MB RAM/0% CPU idle). Bind por la IP ZeroTier (no solo loopback) para
    que sea accesible igual que la propia Consola. Auth del CLI vía flujo
    browser-based (`pad auth login`, Niko aprueba él mismo en su navegador — nunca
    se tocó su password). Workspace `console` migrado 1-vía desde el cloud
    (104/104 items: Docs/Bugs/Tasks/Conventions/Playbooks/Roadmap Items/Roles,
    verificado conteo por conteo, jerarquía Tasks↔Roadmap re-vinculada con los refs
    nuevos) — el cloud NUNCA se escribió durante la migración.
  - **`pad-cloud-backup`** = el `pad` cloud original (`https://mcp.getpad.dev`,
    HTTP), renombrado y conservado SOLO como respaldo pasivo durante la ventana de
    pruebas + integración (pedido explícito de Niko: "el funcionamiento debe estar
    100% local" una vez cortado, la nube nunca se usa operativamente después de
    eso). Puede pedir reautenticación tras el rename (el OAuth de Claude Code se
    cachea por `serverName+serverUrl`) — inocuo mientras no se use; se re-autoriza
    solo al primer uso real si algún día hace falta un rollback.
  - **Alcance del cutover — SOLO el workspace `console`.** El workspace `tolkien`
    (usado por `src/modules/tickets/pad-client.js` para el dashboard de PRs, ver
    abajo) se dejó DELIBERADAMENTE fuera (decisión explícita de Niko 2026-07-12):
    el Pad local NO tiene ese workspace y migrarlo es un proyecto aparte (impacto en
    equipo — Chris/otros podrían usar ese workspace en la nube). `pad-client.js`
    sigue leyendo Tolkien desde el cloud, sin cambios.
- **SEGUNDA vía a Pad: cliente MCP del BACKEND** (`src/modules/tickets/pad-client.js`,
  documentado 2026-07-11): distinta del MCP del chat de arriba. Es un cliente
  `@modelcontextprotocol/sdk` (`Client` + `StreamableHTTPClientTransport`) que habla
  con `mcp.getpad.dev` DIRECTO desde el proceso del server, SIN chat ni
  `settingSources`. Lee el OAuth FRESCO de `~/.claude/.credentials.json → mcpOAuth`
  en cada conexión. LIMITACIÓN conocida (comentada en el archivo): el accessToken
  dura ~1h y lo refresca Claude Code, NO la consola → si vence y Claude Code no
  corre, `getPadItemsForPr` falla best-effort (conserva el último snapshot). Está
  hardcodeado a `PAD_WORKSPACE='tolkien'` (línea 91) — solo lee el workspace de
  Tolkien. `refresher.js` lo orquesta (timer 60s, snapshot+merge acumulativo+
  persistencia atómica) = plantilla reusable para reportes automáticos. Prueba que
  el server SÍ puede ser cliente MCP de Pad.
  **DECISIÓN 2026-07-12 (cutover a Pad local self-hosted, ver bullet de arriba):**
  este cliente se deja EXPLÍCITAMENTE sin tocar — sigue en HTTP contra el cloud,
  workspace `tolkien`. El Pad local self-hosted no tiene ese workspace (solo migró
  `console`) y además solo habla MCP por stdio (no HTTP) — adaptarlo sería una
  reescritura de transporte + un proyecto de migración de datos de Tolkien aparte
  (con impacto en equipo, Chris/otros pueden usar ese workspace en la nube). Niko
  eligió explícitamente NO expandir el alcance: `docs/plan-migracion-pad-selfhost.md`
  documenta el detalle completo de esta decisión de alcance.
- **Programa "Modularización Consola" trackeado en Pad** (workspace `console`,
  2026-07-11): el escaneo módulo-por-módulo (B0→B5: coherencia, tickets, health,
  comms, learning, chat, tasks, tokens + 10 hojas) vive en Pad como ROAD-10 (programa)
  + TASKs por pasada + BUGs `codex:pending` (backlog de lo diferido a re-verificar con
  Codex cuando su cuota vuelva) + Convenciones (reglas duras) + Playbooks (codex-verify,
  module-scan) + Roles. Hallazgo transversal del programa: el bug MÁS recurrente fue la
  **escritura NO atómica de estado durable** — se aplicó `writeJsonAtomic`/`writeFileAtomic`
  de `core/atomic-write.js` (tmp por-PID) en meta-store, comms, learning, chat, tasks,
  tokens, projects/memory (CLAUDE.md/memorias) y core (session-names/recents/trash).
  DOS huecos de seguridad reales cerrados: `fixToolAllowed` (allowlist del auto-fix
  dejaba pasar `node --check a.js⏎<cualquier-cmd>`) y `teamsWriteAllowed` (el `^send`
  autorizaba cualquier `graph_send_*`). Decisión de rol de Pad en `docs/evaluacion-rol-pad.md`
  (Opción 1 cloud, ejecutada primero) — **ACTUALIZADO 2026-07-12: el self-host de
  ROAD-74 se re-aprobó y se ejecutó (Fases 1-2 completas, ver bullet de arriba); este
  workspace `console` con TODO su historial (ROAD-10 incluido) vive ahora físicamente
  en el Pad LOCAL, migrado 1-vía desde el cloud.**
- Tools MCP DIFERIDAS y allowlists headless (visto 2026-07-05): el SDK puede
  diferir los schemas de las tools MCP y el modelo necesita la META-tool
  `ToolSearch` para cargarlos antes de invocarlas — solo devuelve schemas, NO
  ejecuta nada (la ejecución real sigue pasando por las dos capas de la regla
  6). Una allowlist que deniega `ToolSearch` puede dejar al modelo CIEGO de
  todo el MCP (el triage moría con "herramienta no permitida" en el listado).
  `toolAllowed` de bugs/shared.js ya lo permite; si otro runner con MCP
  (desk-runner, p.ej.) empieza a fallar igual, revisar su allowlist.
- Traspaso Chat↔TUI: regla dura "nunca ambos a la vez"; el cierre del lado
  saliente se ESPERA verificado antes de abrir el otro. El header del chat
  YA NO tiene botón TUI ni contador de costo (se quitaron a pedido): pasar
  a TUI vive SOLO en el menú ⋯ de la tarjeta en Sesiones (onToggleMode
  queda en ChatTab por compatibilidad, sin botón). En su lugar hay un "?"
  (icono `help` de icons.js) junto al selector de modos que abre el modal
  "Modos de permisos" (_modeHelp: explica Preguntar / Aceptar ediciones /
  Solo plan). El costo por turno dentro del hilo (chat-turn-cost) queda.
- Tras un reboot, repetir `systemctl --user import-environment SSH_AUTH_SOCK`
  para que el git de Tolkien funcione desde el server.
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
- Cambio de pestaña y scroll del chat: los paneles se ocultan con
  `display:none` (`.terminal-pane` sin `.active`), y con `display:none` el
  `scrollTop` de `.chat-msgs` se pierde (scrollHeight=0) — el replay de
  `history` o los eventos que llegan con la pestaña oculta dejaban la vista
  arriba de todo al volver a un chat. Fix: `ChatTab.focus()` re-ancla con
  `_scroll()`; `setActive()` (main.js) lo llama justo DESPUÉS de togglear
  `.active`, con el layout ya medible. No sacar ese `_scroll()` ni invertir
  el orden toggle→focus.
- Burbujas del chat en móvil: los topes de desktop (`.chat-assistant`
  max-width 90%, `.chat-user` 75%) regalaban ~35px a la derecha en un
  teléfono (reportado por el usuario). El media query móvil (max-width:768px,
  junto a las reglas de .chat-assistant en style.css) los sube a 100%/88% y
  achica el padding lateral de `.chat-msgs`. TODO el layout del chat es
  %/rem — si se agrega un ancho, que sea relativo, nunca px fijos.
- Modelo de confianza WS: entre usuarios AUTENTICADOS hay confianza plena
  (cualquiera puede adjuntarse a la sesión/chat de otro; no hay ownership por
  usuario). Supuesto ACEPTADO mientras todos los usuarios sean del dueño;
  revisarlo antes de dar acceso a usuarios de menor confianza.
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
- Módulo tokens: los TOKENS son exactos (campos `usage` que la API de
  Anthropic reporta en cada mensaje del transcript, dedup por message.id);
  el COSTO es un EQUIVALENTE a precios de API, no un gasto real — la
  suscripción del CLI no factura por token y la Admin Usage & Cost API de
  Anthropic exige organización + admin key (verificado: "unavailable for
  individual accounts"), así que NO hay endpoint de gasto consultable con
  estas credenciales. Precios en pin()/pout() de src/modules/tokens/index.js
  (fable 10/50 · opus 5/25 · sonnet 3/15 · haiku 1/5; cache w5m ×1.25,
  w1h ×2, read ×0.1 — verificados 2026-07). GET /api/tokens/summary?fresh=1
  saltea el TTL de 4s (botón ↻ del modal Uso); el caché por archivo
  (mtime+size) nunca se saltea porque es exacto por construcción. El modal
  Uso agrupa POR MODELO (lista acotada; agrupar por proyecto crecía sin
  tope): el pivot vive en buildModelView() de usage.js sobre el mismo
  /summary. El desplegable de cada modelo son los MOTORES que lo usaron
  (2026-07-04, antes eran "carpetas"/proyectos crudos): /summary expone
  `engines[]` (mismo shape que projects[]: label + models[]) atribuido por
  classifyEngine() de tokens/index.js — heurística determinística 0 tokens
  sobre datos ya en disco: sessionId ∈ unión de ~/.cwc-data/chats.json (vivos)
  + chat-session-ids.json (registro durable append-only de todo-lo-que-fue-chat,
  lo escribe el módulo chat) + bugfixes.json (chats de tickets) ⇒ 💬 chat ·
  dir healthfix-wt-* ⇒ 🔧 auto-fix de salud · dir tolkien ⇒ 🌳 tolkien ·
  entrypoint 'cli' ⇒ ⌨️ CLI · resto SDK ⇒ ⚙️ headless (triage/salud/desk/
  auto-título — NO separables entre sí sin instrumentar cada runner, quedan
  agrupados). projects[] SIGUE en el payload (retrocompat). ANIMACIÓN
  "consumiendo ahora" (Pac-Man por modelo): models[].lastMtime es el
  timestamp del ÚLTIMO MENSAJE de ESE modelo (parseFile guarda modelTs por
  modelo), NO el mtime del archivo — antes un jsonl multi-modelo "refrescaba"
  a TODOS sus modelos y el Haiku de auto-título (o un fable/sonnet viejo del
  mismo chat) titilaba en falso mientras solo Sonnet/Opus trabajaba; ahora
  solo se prende el modelo que de verdad emitió el último mensaje. isLive()
  de usage.js sigue usando el umbral de 2 min.
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
  del <head> bajados (script inline) · 35 módulos montados · 60 sesiones
  listadas · 80 esperando historial del chat activo · 100 al destapar; la
  transición CSS de width interpola entre hitos. Si se agrega una fase al
  boot, asignarle su hito acá y en bootMsg(texto, pct). Antes de destapar, si el tab ACTIVO es un chat, el
  boot espera `tab.ready` (promesa del ChatTab resuelta al terminar de
  procesar el PRIMER evento `history` del attach — señal real de "historial
  renderizado", no un timer) con tope de 8 s: sin eso el chat aparecía
  vacío unos segundos tras caer el splash. No agrega velocidad real: es
  percepción; la espera del HTML inicial solo la mejora cache/compresión
  (pendiente).
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

- **Checks rápidos** (`GET /api/health/checks`, gratis): systemd activo +
  KillMode=process, tmux del socket cwc, runners de chat, observador instalado,
  cert/TLS, git limpio, sintaxis de todo `src/` y `bin/`, disco, datos runtime,
  espejo de contexto a Tolkien (`tolkien-context`) y **`pad-backbone`**
  (2026-07-12, Gap #3 / TASK-296): lee las Conventions del Pad LOCAL por HTTP
  (0 tokens, NO MCP → no toca la regla 6, vía `core/pad-service-client.js`) y
  verifica (a) que el Pad local RESPONDE —si no, warn: tasks/learning/retro/
  tickets-meta degradan EN SILENCIO— y (b) que existe el espejo de la Regla
  dura #12 en las Conventions (señal concreta de divergencia CLAUDE.md↔Pad).
  OJO: el REST del Pad local devuelve `fields` como STRING JSON (no objeto como
  el MCP) — hay que `JSON.parse` antes de leer priority/status.
- **Dashboard del proyecto** (subsección "📊 Dashboard del proyecto" de la
  pestaña Salud, 2026-07-06, pedido del usuario: antes "🔍 Censo del
  proyecto" solo mostraba conteos —"11 módulos"— sin decir CUÁLES, y sin
  ningún dato de CPU/RAM/núcleos). Mismo patrón resumen-compacto+botón que
  Optimización IA/Coherencia: la pestaña muestra solo el veredicto (conteos +
  adelanto de núcleos/CPU/RAM) + botón "Ver dashboard completo →"; el detalle
  entero vive en la SUB-VENTANA `system/inventory-modal.js`
  (`.dlg-card--health`). TODO gratis (0 tokens, sin LLM, sin capa IA — por eso
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
  Pad, cada uno según su naturaleza. El write-back inverso (propuesta aprobada →
  BUG/TASK en Pad) queda como follow-up NO hecho (más invasivo, decisión propia).
- **Revisión EXHAUSTIVA** (`POST /api/health/review`, admin, CONSUME TOKENS):
  barrido MÓDULO POR MÓDULO. La corrida vive en un RUNNER DETACHED
  (bin/cwc-health-runner.js, patrón triage — un reinicio del server a mitad
  NO la mata). discoverUnits() (health/shared.js) arma ~16 unidades: core +
  cada src/modules/* (+ su runner de bin/) + frontend-core + frontend-modules;
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
  health/invariants.js lista aserciones {match, text} (seed de los gotchas
  conocidos: simetría mode/model en chat, validación de rutas, settingSources
  headless sin user, bind ZeroTier, guard [hidden], integridad de secciones en
  projects…); unitPrompt inyecta SOLO los invariantes que matchean los archivos
  de la unidad y le pide verificar CADA uno citando el código — así caza bugs
  sutiles que el barrido genérico pierde. El foco acota el pedido de CLAUDE.md a
  las reglas duras, que van INYECTADAS pre-masticadas en el prompt (optimización
  IA 2026-07-05: hardRulesText() de health/shared.js recorta la sección
  "## Reglas duras" UNA vez en Node y la mete en unitPrompt, mismo patrón que
  invBlock — el auditor ya NO hace un Read de CLAUDE.md entero por unidad; si la
  extracción falla, fallback a la instrucción vieja de consultar el archivo).
  OJO: unitFingerprint ahora hashea TAMBIÉN los invariantes aplicables Y las
  reglas duras inyectadas → editar un invariante o una regla dura fuerza
  re-auditar las unidades que toca.
  LOOP QUE APRENDE (Fase 5 del sistema nervioso, cierre): al resolver un bug de
  una clase que conviene blindar, el auto-fix runner emite una línea
  "PROPOSED-INVARIANT <texto> | <match>" (o NO-INVARIANT); addProposal la guarda
  PENDIENTE en ~/.cwc-data/health-invariant-proposals.json (NUNCA se auto-aplica
  — decisión del usuario). El modal de salud muestra "🧠 Invariantes propuestos"
  con Aprobar/Descartar (GET /invariant-proposals · POST /invariant-proposals/:id
  {approve|reject}, admin). Aprobar → appendLearnedInvariant valida el regex y lo
  suma a src/modules/health/invariants-learned.json (JSON de DATOS en el repo,
  NO código; se commitea y revisa); invariants.js mergea SEED_INVARIANTS +
  loadLearned(). Así el bug resuelto no puede regresar sin que salte. Al final
  SONNET sintetiza el veredicto (solo procesa los hallazgos, no re-lee código). Interfaz por archivos: health-review.json
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

<!-- cwc:mejora-continua:start -->
## Mejora Continua (auto)
<!-- Gestionado por el módulo Mejora Continua de Mi Consola (ROAD-256). NO editar a mano DENTRO de los marcadores: se regenera al promover. Lo de AFUERA (Reglas duras, Convenciones, etc.) queda intacto. -->

### Reconocer eco del propio broadcast en el interfono antes de responder
_procedimiento · confianza media · recurrencia x1_

**Observación:** La sesión recibió por interfono un mensaje que resultó ser el eco de su propio broadcast anterior (mandado a "all" porque el remitente original tenía from: null y no se podía resolver 1:1); tuvo que investigar con varios Bash antes de darse cuenta de que no requería acción.

**Lección:** Al usar cwc-bus para el interfono: si el remitente no es resoluble por nombre (from: null), responder por broadcast a "all" es correcto; pero antes de reaccionar a un mensaje entrante, comparar su contenido/timestamp contra el último broadcast propio para detectar que es el eco de tu propio mensaje y así evitar investigación redundante o una respuesta innecesaria.

### Diseñar acciones por ítem con un botón principal por defecto, no un botón por opción
_convencion · confianza alta · recurrencia x1_

**Observación:** El tablero de Mejora Continua mostraba 7 botones por lección (aprobar + 4 destinos + descartar + cerrar) y el usuario reportó explícitamente no entender qué botón usar, pidiendo simplificación.

**Lección:** Cuando un ítem tiene múltiples acciones o destinos posibles, exponer un único botón de acción primaria con la opción sugerida por defecto (más un menú ▾ para las alternativas), en vez de un botón por cada opción posible — validar esto en el diseño ANTES de construir la UI completa, no después de que el usuario se confunda.
<!-- cwc:mejora-continua:end -->
