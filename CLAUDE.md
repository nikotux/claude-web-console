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
   `bin/uninstall-observer.js`.
5. **Seguridad de push:** el código solo se empuja al remote git `personal`;
   URLs que contengan `Mordor-Staffing` están bloqueadas (guard en backup).
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
                            claude-model(VALID_MODELS/encodeCwd) · claude-state(observador)
src/modules/<nombre>/index.js  módulo backend: { name, init(ctx), registerHttp(router, ctx), registerWs(wss, ctx) }
                            → se registra agregándolo al array de src/core/registry.js
  terminal/                 sesiones tmux (PREFIX cwc-) + bare/TUI (BARE_PREFIX cwct-) + rehidratación
  chat/                     conversaciones SDK: index.js (server) · shared.js (común) ·
                            runner-link.js (spawn/connect) — el motor real es bin/cwc-chat-runner.js
  files/ stats/ tokens/ tmux/ admin/ tolkien/ backup/ tickets/ health/
public/index.html + js/main.js  app principal: módulos frontend { name, mount(el, ctx) }
                            montados por [data-module]; ctx={icon,dialog,bus,whoami,...}
                            (patrón completo en docs/frontend-modules.md)
public/js/modules/          launcher · sessions · stats · usage · system(⚙: Backup/Usuarios/Salud) ·
                            tolkien · tickets · explorer · mobile/auxbar
public/js/ui/               icons.js (único set de íconos) · dialog.js (CERO diálogos nativos) ·
                            markdown.js (sanitizado ALLOWLIST) · diff.js · popup.js (dismissablePopup)
public/js/chat-tab.js       vista chat · public/js/terminal-tab.js  vista terminal
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
  `ui/dialog.js` (`openModal/confirmDialog/promptDialog/alertDialog`); menús
  flotantes con `ui/popup.js`. Nunca `alert()/confirm()/prompt()` nativos.
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
- Modelo de confianza WS: entre usuarios AUTENTICADOS hay confianza plena
  (cualquiera puede adjuntarse a la sesión/chat de otro; no hay ownership por
  usuario). Supuesto ACEPTADO mientras todos los usuarios sean del dueño;
  revisarlo antes de dar acceso a usuarios de menor confianza.

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
