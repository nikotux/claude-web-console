# La Consola — guía para la IA y para desarrolladores

Consola web personal (Node + Express + ws + node-pty + xterm.js) para trabajar
con Claude Code desde el navegador a través de una red privada (ZeroTier). Corre
como servicio systemd de usuario. Este archivo es la FUENTE DE VERDAD sobre qué
se puede, qué se debe y qué NO se debe modificar. Leelo entero antes de tocar
código.

> Cada instalación es INDEPENDIENTE: su propia red, su propia carpeta de datos
> (`~/.cwc-data`), sus propias credenciales de Claude Code y su propia identidad.
> Los datos de identidad/cliente (email, GitHub, integraciones externas) NO viven
> en el código: se configuran por instancia (ver "Config de instancia" abajo).

## Reglas duras (NUNCA violarlas)

1. **Bind EXCLUSIVO a la IP de la red privada.** Jamás `0.0.0.0` ni `127.0.0.1`
   como listen del server. La detección de la interfaz vive en
   `src/core/zerotier.js`.
2. **Resiliencia:** ninguna operación en curso puede quedar atada al ciclo de
   vida del proceso Node. Las terminales van a tmux (socket `cwc`); los motores
   de chat a un runner desacoplado (`bin/cwc-chat-runner.js`); todo trabajo que
   corra en el tiempo (batches, análisis IA, colas) va en un RUNNER DESACOPLADO
   con estado en archivos (`~/.cwc-data`), REANUDABLE (heartbeat/lock + progreso
   incremental) — NUNCA en un `setTimeout`/promesa colgada del proceso del
   server. La unidad systemd usa `KillMode=process`: no lo quites, con el default
   un crash del Node mataría el tmux y los runners.
   **REGLA DE ORO:** toda implementación nueva debe SOBREVIVIR a un reinicio de
   la interfaz web. El front se re-engancha por polling al estado persistido, no
   al proceso.
3. **Todo local:** sin instalaciones npm globales; dependencias solo en el
   `package.json` del proyecto.
4. **No tocar archivos fuera del proyecto** salvo los de runtime documentados
   (`~/.cwc-*`, la unidad systemd instalada, los hooks de Claude Code). Los hooks
   en `~/.claude/settings.json` SOLO se tocan con los instaladores dedicados
   (`bin/install-observer.js`, `bin/install-interfono.js`, `bin/install-pelota.js`
   y sus `uninstall-*`), que son aditivos y reversibles (preservan las entradas
   ajenas, filtran las propias por marca). Excepción deliberada: el módulo
   `projects` lee y ESCRIBE a propósito el `CLAUDE.md` y las memorias de los
   proyectos que gestiona (ese es su propósito explícito, no un efecto colateral).
5. **Seguridad de push:** el código de la consola solo se empuja al remote git
   que designes. Nunca versionar/pushear `.env`, `users.json`, `sessions.json`,
   `certs/`. El módulo `backup` incluye guardas de push configurables.
6. **Las corridas headless del SDK (análisis IA read-only) están blindadas por
   DOS capas:** un hook `PreToolUse` (deniega ANTES de la evaluación de permisos)
   + `canUseTool` como allowlist de lecturas. Nunca cargar `settingSources:
   ['user']` en esas corridas ni quitar ninguna de las dos capas. Las excepciones
   quirúrgicas (un runner que SÍ escribe, o que usa una tool externa concreta)
   mantienen las dos capas pero como allowlist acotada de SOLO lo que necesitan;
   todo lo demás sigue denegado.
7. **La carpeta del proyecto no se mueve ni se duplica.** Las sesiones de Claude
   Code se abren desde ahí.
8. **Hoja de ruta siempre completa:** en CADA modificación se actualizan los
   archivos de contexto y estructura (este CLAUDE.md — mapa, convenciones,
   gotchas — y `docs/` si aplica). Este archivo tiene que alcanzar para que una
   IA sin contexto previo sepa qué puede, qué debe y qué no debe tocar.
9. **Plan primero, después ejecutar sin frenar:** ANTES de ejecutar un cambio no
   trivial, presentar el PLAN en formato visual (tabla: cambio/archivos/efecto).
   Tras el OK, ejecutar de corrido; parar solo ante un error crítico (posible
   pérdida de datos o cambio de alcance). Cerrar con un resumen de lo hecho.

## Config de instancia (identidad + cliente)

Lo que es propio de CADA instalación NO vive en el código. Se separa en capas:

| Capa | Dónde vive | Qué contiene | ¿Se comparte? |
|------|-----------|--------------|---------------|
| **Código** | git | la app | sí (este repo) |
| **Config de instancia** | `~/.cwc-data/instance.json` | identidad (nombre/email/GitHub/firma) + datos de cliente (nombre del MCP, IDs de departamento, reviewer de referencia) | no |
| **Identidad de usuarios** | `users.json` (perms 600) | logins de la consola | no |
| **Secretos** | `.env` + `~/.claude` | token maestro, credenciales de Claude Code, tokens de MCP | JAMÁS |

- `src/core/instance-config.js` es el almacén: autogenera `instance.json` al
  primer arranque (con placeholders vacíos) y compone `config.instance`
  (instance.json > defaults). Una instalación ya configurada nunca ve los
  defaults: su `instance.json` manda.
- Se edita desde **⚙ Sistema → Variables de entorno** (panel admin, módulo
  `env-vars`) o con el wizard `bin/cwc-setup.js`. NUNCA expone secretos.
- Los call-sites leen `config.instance.*` (ej. `tickets/derive.js`,
  `comms/shared.js`). Agregar un dato configurable nuevo = sumarlo a los defaults
  de `instance-config.js` + leerlo por `config.instance` en el call-site.

## Mapa del proyecto

```
src/server.js               bootstrap: espera de la red → bind HTTPS → auth → módulos
src/core/                   config(.env + config.instance) · instance-config(capa de
                            config de instancia) · auth · users · wss · registry ·
                            tls(cert self-signed auto) · zerotier(detección de la interfaz) ·
                            tmux(validación) · trash · recents · pool(concurrencia adaptativa) ·
                            paths(validación de rutas del cliente) · sdk-settings(fuente única
                            de settingSources) · tool-policy(gobernanza de permisos del chat) ·
                            atomic-write(escritura atómica tmp+rename) · inventory(censo
                            determinístico del repo) · bus(interfono entre sesiones, file-based)
src/modules/<n>/index.js    módulo backend { name, init(ctx), registerHttp(router, ctx),
                            registerWs(wss, ctx) } — registrarlo en src/core/registry.js
  terminal/                 sesiones tmux + rehidratación
  chat/                     conversaciones con el SDK de Claude (motor = bin/cwc-chat-runner.js):
                            adjuntos, modelos, modos de permisos, router de modelo, imágenes
  files/ stats/ tmux/ admin/ health/ tokens/
  projects/                 contexto (CLAUDE.md) + memorias editables de los proyectos
                            registrados (incluida esta consola). Lee/escribe esos archivos a
                            propósito (excepción de la regla 4).
  tolkien/                  panel del proyecto principal trackeado: estado git / fetch / update.
                            El nombre y la ruta del proyecto se configuran con CWC_PROJECT_DIR /
                            CWC_PROJECT_NAME.
  tickets/ bugs/ bugfixes/  ciclo de tickets/PRs. Se integra con servicios externos (Zoho Desk,
                            GitHub) configurados por instancia — inerte si no los configurás.
  comms/                    comunicaciones con contactos (GitHub / Teams / etc.). File-based.
  tasks/ learning/ retro/   tableros privados (pendientes, aprendizaje, mejora continua).
  audio/ interfono/ env-vars/
  backup/                   backup tar.gz + push del código al remote designado (con guardas).
public/index.html + js/main.js  app principal: módulos frontend { name, mount(el, ctx) }
public/js/ui/               icons.js (set único) · dialog.js (nada de alert/confirm nativos) ·
                            markdown.js (sanitizado) · pacman.js (loader) · perm-center.js
public/css/tokens.css       TODAS las variables (--cwc-*); CERO hex fuera de acá
bin/cwc-*-runner.js         runners desacoplados (motor de chat, análisis IA, etc.)
bin/cwc-setup.js            instalador guiado · bin/cwc-adduser.js  alta de usuarios CLI
bin/install-*.js            instaladores aditivos/reversibles de los hooks de Claude Code
systemd/                    unidad del servicio (se instala con cwc-setup.js)
docs/                       INSTALL.md (guía de instalación) · frontend-modules.md
```

Consultá `~/.cwc-data/inventory.md` (lo genera `core/inventory.js`, o
`node bin/cwc-inventory.js`) para el CENSO SIEMPRE FRESCO del proyecto: módulos
con su `registry.js:línea` y endpoints, runners, módulos frontend y el
vocabulario real (tokens `--cwc-*`, env vars). Este CLAUDE.md son las REGLAS; el
inventario es "qué existe AHORA".

## Convenciones (lo que SE DEBE hacer)

- **Colores/espaciado:** solo variables de `tokens.css` (o `color-mix` sobre
  ellas). En JS los tokens se leen con `getComputedStyle`, nunca se duplican hex.
- **Botones/diálogos/popups:** `.btn`/`.btn-ghost` + modificadores; modales con
  `ui/dialog.js`; menús con `ui/popup.js`. Nunca `alert()/confirm()/prompt()`.
- **Íconos:** `icon(name)` de `ui/icons.js` (SVG de trazo); agregar íconos AHÍ.
- **UI con mucho texto = COLAPSABLE + ÁRBOL:** todo panel nuevo con bloques
  largos nace colapsado (header compacto + detalle a demanda) y agrupa sus
  sub-elementos tipo árbol.
- **Módulo nuevo backend:** `src/modules/<n>/index.js` con la interfaz estándar +
  sumarlo al array de `registry.js`. Frontend: `{name, mount}` + `[data-module]`
  en index.html + registrarlo en main.js.
- **Admin-gating:** endpoints sensibles con `isAdmin(req)` de `core/auth.js`.
- **Escritura de estado durable:** SIEMPRE atómica (`core/atomic-write.js`:
  `writeJsonAtomic`/`writeFileAtomic`), nunca `writeFileSync` directo.
- **Comentarios y commits en español**, un tema por commit, mensajes descriptivos.

## Gotchas conocidos (te van a morder si los ignorás)

- `renderMarkdown()` (`ui/markdown.js`) devuelve un NODO DOM, no un string.
  Interpolarlo en un template imprime `[object HTMLDivElement]`: usá
  `appendChild(nodo)` o `renderMarkdown(x).innerHTML`.
- NO usar `pkill -f src/server.js` (el patrón mata al propio shell). Reiniciar
  con `systemctl --user restart claude-web-console`.
- NO usar `git checkout -- <archivo>` para limpiar una prueba sobre archivos que
  otras sesiones editan en vivo: puede descartar cambios ajenos sin commitear.
  Revertí deshaciendo tu propio cambio y mirá `git status` antes.
- Los hooks del observador/interfono se capturan al INICIAR claude: las sesiones
  ya abiertas no los toman hasta reiniciar claude adentro.
- El Agent SDK hereda la suscripción del CLI (`~/.claude/.credentials.json`); no
  necesita API key. Un runner lee esa credencial al ARRANCAR: si cambia/vence
  después, el runner vivo no la re-lee (reiniciá el runner).
- El certificado TLS es self-signed y atado a la IP de la red privada: se
  regenera si la IP cambia. La primera vez, aceptá el aviso del navegador.
- Modelo de confianza: entre usuarios AUTENTICADOS hay confianza plena (cualquiera
  puede adjuntarse a la sesión de otro). Válido mientras todos sean del dueño;
  revisalo antes de dar acceso a usuarios de menor confianza.

## Proceso de cambio (seguilo SIEMPRE)

1. Editar el código respetando esta guía.
2. `node --check` sobre cada archivo tocado.
3. `systemctl --user restart claude-web-console` y mirar
   `journalctl --user -u claude-web-console -n 20 --no-pager`.
4. Verificar en caliente (API con `curl -sk`, UI en el navegador de la red
   privada).
5. Chequear la salud: `GET /api/health/checks` debe quedar todo `ok` (o con solo
   avisos esperados). La pestaña Salud del menú ⚙ Sistema muestra lo mismo.
6. Commit (en español). Si el cambio es de arquitectura, actualizar este CLAUDE.md.
