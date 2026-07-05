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
   (`bin/cwc-desk-runner.js`); investigación a fondo de un PR → runner
   desacoplado (`bin/cwc-investigate-runner.js`); investigación de CONTEXTO de un
   ticket SIN PR (lee el código de Tolkien read-only para explicar por qué NO se
   resolvió) → runner desacoplado (`bin/cwc-ticket-investigate-runner.js`);
   optimización IA de los motores (censo + análisis con propuestas) → runner
   desacoplado (`bin/cwc-optimize-runner.js`); INTERFONO entre sesiones
   (mensajería + claims anti-conflicto: `bin/cwc-bus.js` invocado por los hooks
   de Claude Code, estado 100% en archivos en `~/.cwc-data/session-bus/` —
   NADA en el proceso del server, sobrevive reinicios por construcción; el
   módulo backend `interfono` solo LEE ese disco). La unidad systemd usa
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
  `health-solved.json` registro de bugs, `health-audit-cache.json` caché
  incremental de salud, `health-invariant-proposals.json` invariantes propuestos
  pendientes, `optimization.json` resultado de la Optimización IA +
  `optimize.lock` heartbeat de su runner, `session-bus/` del INTERFONO entre
  sesiones — `messages/<id>.json` bandeja de mensajes · `claims/<hash>.json`
  reservas de archivo (1 por archivo, clave = hash de la ruta) ·
  `tombstones/<id>.json` avisos de claim robado; lo escriben los hooks vía
  `bin/cwc-bus.js`, el módulo `interfono` solo lo lee), `~/.cwc-backups/`, `~/.cwc-trash/`, `~/.cwc-state/`
  (observador — OJO: `claude-state.js` PODA todo .json de `~/.cwc-state` sin
  `ts` fresco; nunca guardar ahí nada ajeno al observador)

## Mapa del proyecto

```
src/server.js               bootstrap: ZeroTier wait → HTTPS bind → auth → módulos
src/core/                   config(.env) · auth · users · wss · registry · tls ·
                            zerotier · tmux(validación) · trash · recents ·
                            paths(resolveWithinHome/clampToHome — TODA validación de
                            rutas del cliente pasa por acá; nunca startsWith crudo) ·
                            sdk-settings(settingSourcesFor: fuente ÚNICA de settingSources,
                            'chat'=user+project / 'headless'=project+local sin user) ·
                            claude-model(VALID_MODELS/encodeCwd) · claude-state(observador) ·
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
                            runner-link.js (spawn/connect) — el motor real es bin/cwc-chat-runner.js
                            README.md documenta la config que hereda el chat (Fase 8:
                            settingSources user+project, comandos slash, observador). Modelo
                            EN VIVO (POST /api/chat/model, WS set_model): con motor corriendo
                            usa q.setModel() del SDK (mismo mecanismo que setMode/
                            setPermissionMode, sin perder contexto); dormido, solo actualiza
                            chat.model para el próximo spawnRunner. Antes solo existía para
                            sesiones tmux (`/model` tipeado a la TUI) — ahora el menú ⋯ de una
                            conversación en Sesiones también tiene "Cambiar modelo".
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
  files/ stats/ tmux/ admin/ health/
  interfono/                INTERFONO entre sesiones: panel + canal HUMANO. Solo LEE el bus
                            (core/bus.js) — 0 tokens. GET /api/interfono (directory + messages +
                            claims con verdict de evaluateClaim + ts) · POST /send {to,text}
                            (mensaje manual desde la web a una sesión o 'all') · POST
                            /claim-release {file} (admin, libera un claim zombi a mano). La
                            mensajería/claims AUTOMÁTICOS NO pasan por acá: los generan los hooks
                            de Claude Code (bin/cwc-bus.js). Frontend: pestaña "Interfono" del
                            menú ⚙ Sistema (system/interfono-panel.js)
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
                            asunto) para no perder la detección de duplicados entre tickets.
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
                            por mtime+size) + límites del PLAN (GET /api/tokens/limits:
                            % usado y reset de las ventanas de claude.ai — sesión 5 h /
                            semanales, incluida la del modelo activo — vía el endpoint
                            OAuth de uso de Anthropic con el accessToken de
                            ~/.claude/.credentials.json, la misma credencial que hereda el
                            SDK; el archivo SOLO se lee, el token nunca viaja al cliente,
                            caché 60 s y ?fresh=1 la saltea; si el token venció el error
                            dice cómo arreglarlo — jamás refrescarlo desde acá)
  tolkien/                  SOLO git del proyecto trackeado: status/fetch/update con
                            stash→pull --ff-only→pop (nunca descarta trabajo). El contexto y
                            las memorias editables NO viven acá — ver módulo `projects/`.
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
                            summary}; la UI lo muestra en un modal de CONFIRMACIÓN FORZADA
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
                            cierre). YA NO se editan con botón "Contexto" propio en el
                            EXPANDIR de Bugs ni en el modal Enviar PR (se sacaron de ahí): se
                            editan desde ⚙ Sistema → Proyectos, como "Bugfixes: Trabajo" /
                            "Bugfixes: PR" (sub-proyectos SIN memorias, junto a Tolkien/Consola
                            — ver project-context-panel.js). Editor genérico: textEditorDialog (ui/dialog.js).
                            Cancelar PR (POST /cancel-pr, admin): cierra el PR en GitHub +
                            borra el branch remoto y el registro vuelve LIMPIO a 'pendiente'
                            (sin campos de PR) para rehacer el fix de cero; un PR MERGEADO
                            nunca se cancela (se verifica el estado real con gh antes).
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
                            re-render). Sección colapsable "📦 Archivo · resueltos" al fondo
                            (filas .bb-arch-row ocultables por la cabecera data-arch-toggle);
                            botón Archivar (primario cuando completo) / Restaurar por fila. El
                            "?" ("Cómo leer este tablero") explica pipeline, resolución,
                            chips, puntos, Archivo y GitHub/Desk en vivo.
public/index.html + js/main.js  app principal: módulos frontend { name, mount(el, ctx) }
                            montados por [data-module]; ctx={icon,dialog,bus,whoami,...}
                            (patrón completo en docs/frontend-modules.md)
public/js/modules/          launcher · sessions · stats · usage · system(⚙: Backup/Usuarios/
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
                            PULSO del repo — #SHA · branch (⚠ si ≠ main) · al día/N detrás ·
                            N cambios · último commit (asunto·autor·hace X) · último fetch —
                            y UNA acción: Actualizar (⬇ ícono en el header) = stash→pull→pop,
                            resaltada .tk-update--due si behind>0. /api/tolkien/status suma
                            author+lastFetch. El acceso al tablero se movió a "Bugs & Features") ·
                            bugs (sección "Bugs & Features", modules/bugs/bugs.js, ANTES
                            `tickets`: ÚNICO acceso al ciclo del bug. INFO RÁPIDA barata (sin
                            tokens ni gh) cruzando /api/bugs (triage: nº bugs + frescura) y
                            /api/bugfixes (registro: por enviar, PRs abiertos, y ⚠ ATENCIÓN =
                            reabierto/doble registro/ticket sin actualizar — los casos del
                            519). Botón "Abrir tablero" + ↻ triage (tokens, confirm). Al
                            cerrar el tablero (onClose) refresca las stats) ·
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
                            usage (pie: tokens de HOY; su modal "Uso": arriba límites del
                            plan — /api/tokens/limits, barras % con umbrales ok/warn/danger
                            y "queda X% · resetea en …" — y abajo el consumo por modelo con
                            Pac-Man pac-sm masticando en los que consumen AHORA (lastMtime
                            < 2 min); auto-refresh cada 10 s mientras el modal está abierto,
                            preservando detalles expandidos, con clearInterval en onClose)
public/js/ui/               icons.js (único set de íconos) · dialog.js (CERO diálogos nativos) ·
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
                            pacman.js (loader Pac-Man COMPARTIDO, CSS en ui.css .cwc-pacman:
                            USARLO en toda espera > ~5 s — revisión profunda de Salud, triage
                            de Bugs, subir PR, push/backup, cálculo de Uso; el spinner queda
                            para cargas breves. El del header del chat es el mismo componente
                            con cls 'chat-alive' y estado vivo/dormido)
public/js/modules/chat/chat-tab.js  vista chat · public/js/modules/terminal/terminal.js  vista terminal
public/css/tokens.css       TODAS las variables (--cwc-*); CERO hex fuera de acá
public/css/ui.css           .btn/.btn-ghost, .dlg-*, .cwc-popup-menu, guard [hidden]
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
                            allowlist fixToolAllowed, node --check, sin reinicio — excepción regla 6)
bin/cwc-health-resolve.js   marca UN hallazgo como RESUELTO (fixStatus:'resolved' en review.json
                            + recordSolved). Lo corre el PROPIO chat "En chat" al terminar (le
                            paso el id en el prompt) para que el tablero refleje el cierre.
                            Determinístico, 0 tokens, NO toca código. Reusa markFindingResolved
                            de health/shared.js (mismo helper que el endpoint POST /finding-resolve
                            del botón manual "Marcar resuelto")
bin/cwc-desk-runner.js      consulta EN VIVO del estado de un ticket en Zoho Desk (READ-ONLY
                            doble capa, allowlist desk_* de lectura; interfaz por archivos:
                            desk.lock heartbeat + desk-live/<ticket>.json resultado). Lógica
                            compartida con el módulo en bugfixes/desk-shared.js
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
bin/cwc-observe.js + (un)install-observer.js  observador de estado de Claude Code
bin/cwc-inventory.js        regenera el INVENTARIO del proyecto (core/inventory.js) a mano (--force)
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
  no necesita API key y sus transcripts caen en `~/.claude/projects/`.
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
  `[data-module="launcher"]`) vive DENTRO de `.sb-head`, en la MISMA fila que
  el ☰ (flex:1 llena el espacio junto al botón — antes esa fila quedaba medio
  vacía y "Nueva sesión" gastaba una fila propia; pedido del usuario en
  móvil, aplica igual en desktop expandido). En el rail colapsado de desktop
  el launcher se oculta (only-expanded) y queda la columna ☰ + "+"
  (only-collapsed) de siempre.
- `#rail-tabs` (chips de pestañas ABIERTAS) se oculta con `display:none` SOLO
  en el media query móvil de style.css: en el rail COLAPSADO de escritorio
  sigue siendo la única forma de cambiar de pestaña (la lista "Sesiones" se
  oculta ahí); en móvil el panel nunca colapsa (`applySidebarState` lo
  fuerza) así que es redundante con las tarjetas de Sesiones, que ya
  cambian de pestaña vía `focusSession`/`openChatView` sin depender de este
  chip. Si se vuelve a tocar, verificar que el rail colapsado de desktop no
  se rompió (ahí `#rail-tabs` es indispensable).
- Pac-Man (`.cwc-pacman`, ui.css + ui/pacman.js) — loader COMPARTIDO en CSS
  puro, triple rol: (a) indicador de PROCESO LARGO (> ~5 s: revisión profunda,
  triage de Bugs, subir PR, push/backup, Uso) siempre con `.is-working`; (b)
  ícono "vivo/dormido" del header del chat (mismo componente con cls
  `chat-alive`, SOLO móvil — style.css lo oculta en desktop — y su
  `.is-working` lo togglea `_setWorking(on)` de chat-tab.js); (c) estado de
  las tarjetas de Sesiones del sidebar (cls `pac-sm sess-pac st-*`, render y
  updateInPlace de sessions.js con `pacStatus`/`pacClass`): amarillo
  masticando = trabajando (`.is-working`), verde boca cerrada = esperando
  input (`.sess-pac.st-waiting` recolorea el borde a `--cwc-ok` en
  style.css), verde/amarillo tenue = idle/stale, gris = shell (default
  dormido). `pac-sm` (ui.css) es la variante 0.75× (30×12, borde 6px) y el
  ojo de `.sess-pac` cala `--cwc-bg-elevated` (fondo de la tarjeta, no
  panel). Anatomía:
  `.pac-man` es una caja 0×0 con `border-width` parejo + `border-radius:50%`
  (el truco clásico: el BORDE es el círculo) y el borde derecho anima entre
  sólido (boca cerrada) y `transparent` (boca abierta) — `@keyframes
  pac-chomp`; `.pac-track` con 3 `.pac-dot` viajan con `translateX` de
  derecha a izquierda y se desvanecen al llegar a la boca
  (`@keyframes pac-dot-travel`). Ojo = `::before` (el (0,0) de un pseudo
  absoluto en una caja 0×0 con borde es el CENTRO del círculo); la boca
  cerrada NO lleva marca (hubo una línea `::after` y se quitó a pedido).
  Dormido = gris quieto; trabajando = dorado (`--cwc-warn`) masticando.
  OJO 1: el kill-switch global de `prefers-reduced-motion` (ui.css)
  congelaba el Pac-Man en teléfonos con "reducir movimiento" del sistema —
  hay una EXCEPCIÓN deliberada (mismo bloque de ui.css, mayor especificidad
  + !important: es indicador de estado funcional, no decoración); no
  borrarla. OJO 2: `.is-working .pac-man` pone los 4 bordes en warn como
  base (fallback estático = boca cerrada dorada, nunca hueco gris
  congelado). OJO 3: el recorrido de `.pac-dot` es `translateX(var(--pac-travel,
  -24px))` y TIENE que coincidir con el ancho de `.pac-track` (ancho total −
  círculo) para que la bolita llegue EXACTO a la boca — el default -24px es
  del tamaño normal (40−16); cada variante define el suyo (`pac-sm`:
  `--pac-travel: -18px`, 30−12). La barra TUI (`.conv-tui-bar`) NO tiene el
  vivo/dormido (su estado viene del observador de hooks, no del stream del
  SDK — plomería distinta, no conectada todavía).
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
  cert/TLS, git limpio, sintaxis de todo `src/` y `bin/`, disco, datos runtime.
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
  (se lo exige el prompt y lo re-verifica el chat que aplica).
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
