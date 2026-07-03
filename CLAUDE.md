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
   (`bin/cwc-triage-runner.js`). La unidad systemd usa `KillMode=process` — no
   lo quites: con el default (control-group) un crash del Node mataría el tmux
   y los runners.
3. **Todo local:** sin instalaciones npm globales; dependencias solo en
   `package.json` del proyecto.
4. **No tocar archivos fuera del proyecto** salvo los runtime documentados
   abajo (`~/.cwc-*`, unidad systemd instalada, observer). El observer de
   `~/.claude/settings.json` SOLO se toca con `bin/install-observer.js` /
   `bin/uninstall-observer.js`. Excepción deliberada adicional: el módulo
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
   SUB-EXCEPCIÓN de LECTURA (pedido del usuario 2026-07-03): `deskLive` de
   `bugfixes/index.js` (endpoint GET /api/bugfixes/desk-live/:n) trae el
   estado + comentarios ACTUALES del ticket para ver si la actualización ya
   quedó. Es MÁS blindada que la de escritura: allowlist de tools `desk_*`
   que (a) NO contienen verbo de escritura (add/update/reply/…) Y (b) SÍ uno
   de lectura (get/list/search/view/…) — deny por defecto, en las DOS capas.
   Consume tokens: el front la dispara BAJO BOTÓN ("Traer estado de Desk"),
   nunca al expandir; caché 60 s, ?fresh=1 la saltea.
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
- Fuera del repo: `~/.cwc-data/` (chats.json, sockets/logs de runners, caché
  tickets/salud), `~/.cwc-backups/`, `~/.cwc-trash/`, `~/.cwc-state/`
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
                            viven acá, compartidos por los módulos tmux y terminal)
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
                            POST /refresh responde INMEDIATO (arrancar+encuestar, patrón
                            health/review); el front encuesta GET cada 3 s y re-dispara si la
                            corrida se pierde (3 intentos). Seguridad read-only de dos capas
                            (regla 6) EN el runner. OJO: `bugs` (triage) ≠ `bugfixes` (motor
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
  bugfixes/                 registro de fixes de tickets (store.js: ~/.cwc-data/bugfixes.json,
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
                            PR-LIVE (GET /pr-live/:n, admin): datos EN VIVO de un PR vía gh
                            (reviews, reviewDecision, comentarios, checks, commits,
                            mergeable) con caché en memoria de 60 s (?fresh=1 la saltea);
                            NADA se persiste — es el panel "GitHub en vivo" del tablero.
                            DESK-LIVE (GET /desk-live/:n, admin, CONSUME TOKENS): estado +
                            comentarios ACTUALES del ticket en Zoho Desk vía corrida headless
                            READ-ONLY (sub-excepción de la regla 6: allowlist desk_* SOLO
                            lectura); parsea un bloque JSON de la respuesta del modelo, caché
                            60 s. Además del panel, CLASIFICA la resolución: pide al modelo
                            `closed` (status cerrado/resuelto, con red de seguridad regex) y
                            `requesterReplied` (el cliente respondió tras la última nota del
                            equipo). persistDeskSnapshot() vuelca en TODOS los registros del
                            ticket: deskStatusText/deskClosed/deskReplied/deskResolved +
                            deskCheckedAt, y emite ticket_cerrado|ticket_respondido al
                            historial la 1ª vez. RESOLUCIÓN (resolutionOf, derivado, expuesto
                            en GET /api/bugfixes como b.resolution): 'complete' si deskResolved
                            · 'partial' si prState==='merged' (PR mergeado pero ticket SIN
                            confirmar — merge ≠ resuelto: puede ser fix parcial o total, sin
                            verificar) · 'active'. ARCHIVO (POST /archive {id,archived}): flag
                            b.archived + evento archivado|restaurado; solo organiza el tablero,
                            no toca código ni PRs.
                            UI ÚNICA: el TABLERO "Bugs & PRs" (tolkien/bug-board.js): filas de
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
                            Proyectos/Salud — la pestaña Proyectos (project-context-panel.js,
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
                            salud: chequeos rápidos + revisión profunda, sin bugfixes) ·
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
                            El TABLERO (tolkien/bug-board.js, admin, lo abren "Bugs & Features"
                            y —histórico— el botón de Tolkien):
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
bin/cwc-triage-runner.js    corrida del triage de bugs (proceso propio; interfaz por archivos)
bin/cwc-health-runner.js    revisión exhaustiva de salud (barrido módulo x módulo; interfaz por archivos)
bin/cwc-observe.js + (un)install-observer.js  observador de estado de Claude Code
systemd/claude-web-console.service  unidad (copia instalada: ~/.config/systemd/user/)
docs/                       frontend-modules.md · brief-original.txt · contexto-ui.md (histórico)
```

## Convenciones (esto es lo que SE DEBE hacer)

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
- **`[hidden]`:** existe un guard global `[hidden]{display:none!important}` en
  ui.css. Cualquier regla `display` de autor sobre un elemento ocultable debe
  respetarlo (esa fue la causa raíz del bug del menú contextual pegado).
- **Módulo nuevo backend:** `src/modules/<n>/index.js` con la interfaz estándar
  y sumarlo al array de `registry.js`. Frontend: objeto `{name, mount}` +
  `[data-module="<n>"]` en index.html + registrarlo en main.js.
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
  /summary (que expone models[].lastMtime por proyecto — granularidad de
  archivo: un jsonl multi-modelo "refresca" a todos sus modelos); el
  desplegable de cada modelo son los 3 proyectos que lo usaron más
  recientemente, ordenados de mayor a menor uso de ese modelo.
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
- **Revisión EXHAUSTIVA** (`POST /api/health/review`, admin, CONSUME TOKENS):
  barrido MÓDULO POR MÓDULO. La corrida vive en un RUNNER DETACHED
  (bin/cwc-health-runner.js, patrón triage — un reinicio del server a mitad
  NO la mata). discoverUnits() (health/shared.js) arma ~16 unidades: core +
  cada src/modules/* (+ su runner de bin/) + frontend-core + frontend-modules;
  cada una se audita con HAIKU read-only (doble capa, regla 6) buscando bugs
  Y violaciones de reglas → findings {area,severity,kind,detail,file,
  suggestedFix}; al final SONNET sintetiza el veredicto (solo procesa los
  hallazgos, no re-lee código). Interfaz por archivos: health-review.json
  (progreso incremental: units[].status, done/total, findings[]) +
  health-review.lock (heartbeat => running). POST responde INMEDIATO
  (arrancar+encuestar); el front encuesta GET /review. UI = SUB-VENTANA
  full-screen (health-review-modal.js, .dlg-card--health): barra de progreso
  + grilla de módulos con estado en vivo + hallazgos por severidad (color).
  RESOLUCIÓN AUTÓNOMA (pedido del usuario 2026-07-03): cada hallazgo tiene UN
  botón "Resolver" y hay un "Resolver todo (autónomo)" junto a "Volver a
  analizar" (resolveInChat / resolveAll). Abren un chat en la raíz de la
  consola (cwd 'claude-web-console') en modo `acceptEdits` con el contexto del
  hallazgo/hallazgos: edita solo, pero el prompt le exige FRENAR y pedir
  confirmación en acciones de ALTO RIESGO (bash destructivo/git push/reiniciar
  servicios) — ahí aparece la tarjeta de permiso (alerta) del chat. La
  revisión (headless) sigue read-only regla 6; lo que edita es el chat
  supervisado que ve el usuario. COLAPSABLES (móvil, isMobile por matchMedia):
  cada hallazgo es una tarjeta con header (severidad·tipo·área·módulo) siempre
  visible + cuerpo plegable (.hr-collapsed togglea .hr-f-body); módulos y
  resumen en <details.hr-collapsible> — todo colapsado en móvil, abierto en
  desktop. Vista general por defecto, detalle a demanda.
- **GOTCHA de profundidad (verificado 2026-07-03):** haiku-por-módulo
  encuentra bugs reales valiosos (fd leaks, race conditions en flags `busy`,
  stash pop sin verificar merge, límites de tamaño faltantes en endpoints)
  PERO se queda corto en archivos MUY grandes: en una corrida de prueba NO
  detectó una asimetría sutil conocida (chat/index.js `case 'mode'` no llama
  `onUpdate()` mientras su gemelo `case 'model'` sí → el modo de permisos no
  persiste), porque chat/index.js (~900 líneas) excede lo que haiku procesa
  con UNIT_MAX_TURNS. Si se quiere cazar bugs sutiles en módulos grandes:
  subir esos a sonnet, subir UNIT_MAX_TURNS, o partir el archivo. La
  herramienta es un RASTRILLO amplio, no una garantía de cobertura total.
