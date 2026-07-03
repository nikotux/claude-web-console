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
   (`bin/cwc-chat-runner.js`). La unidad systemd usa `KillMode=process` — no lo
   quites: con el default (control-group) un crash del Node mataría el tmux y
   los runners.
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
   corridas ni quitar ninguna de las dos capas.
7. **La carpeta del proyecto es SIEMPRE `/home/nmosquera/claude-web-console`.**
   No moverla ni duplicarla; las sesiones de Claude Code se abren desde acá.
8. **Hoja de ruta siempre completa:** en CADA modificación se actualizan los
   archivos de contexto y estructura de este repo (este CLAUDE.md — mapa,
   convenciones, gotchas — y docs/ si aplica). El proyecto puede crecer mucho;
   este archivo tiene que alcanzar para que una IA sin contexto previo sepa
   qué puede, qué debe y qué no debe tocar.
9. **Ejecutar sin frenar:** el usuario ya delegó; no pedirle confirmaciones
   intermedias (ni por archivos sensibles). Parar SOLO ante un error crítico
   (posible pérdida de datos o cambio de alcance).

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
  files/ stats/ tokens/ tmux/ admin/ tickets/ health/
  tolkien/                  SOLO git del proyecto trackeado: status/fetch/update con
                            stash→pull --ff-only→pop (nunca descarta trabajo). El contexto y
                            las memorias editables NO viven acá — ver módulo `projects/`.
  projects/                 contexto (CLAUDE.md) y memorias EDITABLES de los proyectos
                            registrados en PROJECTS (index.js): `tolkien` (config.projectDir)
                            Y `console` (esta misma consola, su propia raíz de repo) — agregar
                            uno nuevo es sumar una entrada al objeto, todas las funciones de
                            memory.js toman `projectDir` como parámetro (nada hardcodeado).
                            GET /api/projects = lista {key,name,dir}; GET/POST /:key/context =
                            <projectDir>/CLAUDE.md real; GET /:key/memory = índice MEMORY.md +
                            notas resueltas contra disco (orden del índice, huérfanas al
                            final); GET/POST /:key/memory/index = MEMORY.md crudo; GET/POST
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
                            remote `personal` (guardas: solo ese remote, URL sin Mordor-Staffing,
                            solo archivos ya trackeados). Cada push exitoso ADEMÁS: (1) agrega
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
                            archivos con marcas de conflicto entra en crash-loop). OJO: el
                            push NUNCA sube untracked (guard anti-secretos) — código nuevo
                            requiere `git add` manual o no viaja al backup off-site.
  bugfixes/                 registro de fixes de tickets (store.js: ~/.cwc-data/bugfixes.json,
                            extracción del transcript, scan retroactivo) + subida de PR a
                            Tolkien (worktree temporal desde origin/main — NO toca el árbol
                            real — commit de los archivos del fix, push, gh pr create con
                            reviewer cswenor). Notas del PR SIEMPRE formales: Problema /
                            Qué se hizo / ¿Mejor solución? (parseadas del cierre del chat).
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
                            2s: el transcript se flushea tarde). UI en ⚙ Sistema → Salud y
                            modal "Enviar PR" de la sección Tolkien (cuadro registro+GitHub).
public/index.html + js/main.js  app principal: módulos frontend { name, mount(el, ctx) }
                            montados por [data-module]; ctx={icon,dialog,bus,whoami,...}
                            (patrón completo en docs/frontend-modules.md)
public/js/modules/          launcher · sessions · stats · usage · system(⚙: Backup/Usuarios/
                            Proyectos/Salud — la pestaña Proyectos (project-context-panel.js,
                            backend módulo `projects` + /api/bugfixes/context) es DISTINTA del
                            módulo tolkien de abajo: selector arriba con TODAS las entradas
                            editables en un solo lugar — Tolkien / Consola (de GET
                            /api/projects: contexto CLAUDE.md + memorias) y, agregados como
                            entradas BUGFIX_ENTRIES del propio panel, "Bugfixes: Trabajo" /
                            "Bugfixes: PR" (kind=work|pr de /api/bugfixes/context — SOLO
                            contexto, sin memorias; sección Memorias se oculta con `hidden`
                            para esas dos). Visible a todos (autenticados), edición gateada por
                            isAdmin en el frontend Y en el backend; la pestaña Salud incluye
                            Bugfixes→PR) ·
                            tolkien (botón Enviar PR admin → MODAL de gestión: cuadro con
                            historial de PRs + estado de merge desde GitHub + columna
                            Cambios (aporte en +/−/archivos: numstat local vs origin/main
                            para pendientes, tamaño del PR para subidos), enviar pendientes
                            con update previo, re-scan, y "Trabajar en esto" (chat
                            'PR en progreso · TKT #n' en tolkien para refinar a mano;
                            recordBugfix MERGEA por ticket los pendientes — no duplica) y
                            "Cancelar PR" en el detalle de un fix subido no mergeado
                            (confirm rojo → /cancel-pr → vuelve a pendiente);
                            EXCLUSIVO de ~/tolkien) ·
                            tickets · explorer · mobile/auxbar
public/js/ui/               icons.js (único set de íconos) · dialog.js (CERO diálogos nativos) ·
                            markdown.js (sanitizado ALLOWLIST) · diff.js · popup.js (dismissablePopup) ·
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
- Transcripts jsonl de Claude: el mismo `message.id` aparece en varias líneas —
  dedup por id+firma de contenido (ver `loadTranscriptEvents` y módulo tokens).
- Hooks del observador se capturan al INICIAR claude: sesiones ya abiertas no
  reportan hasta reiniciar claude dentro de ellas.
- El Agent SDK hereda la suscripción del CLI (`~/.claude/.credentials.json`);
  no necesita API key y sus transcripts caen en `~/.claude/projects/`.
- Traspaso Chat↔TUI: regla dura "nunca ambos a la vez"; el cierre del lado
  saliente se ESPERA verificado antes de abrir el otro.
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
  (mtime+size) nunca se saltea porque es exacto por construcción.
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
- **Revisión profunda** (`POST /api/health/review`, admin, CONSUME TOKENS):
  corrida headless read-only del SDK que lee esta guía + el código y devuelve
  veredicto con hallazgos. Caché en `~/.cwc-data/health.json`. Solo bajo
  demanda desde la pestaña Salud.
