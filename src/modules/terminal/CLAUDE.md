<!-- cwc:ficha-modulo -->
# src/modules/terminal — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### terminal/                 sesiones tmux (PREFIX cwc-) + bare/TUI (BARE_PREFIX cwct-) + rehidratación

## Gotchas de esta carpeta

- Los rechazos 400 de `POST /sessions` se registran con el `owner` y solo los
  valores mínimos necesarios para diagnosticar. El frontend muestra el campo
  `error` tal cual al usuario: ese texto es UI y debe escribirse pensando en
  quien lo lee.
- Los tres rechazos 400 de `POST /sessions` son TEXTO DE UI: deben nombrar el
  valor concreto rechazado y una salida accionable. En particular, el rechazo
  de modelo lista los `VALID_MODELS`, porque el launcher llegó a mandar el alias
  de chat `tandem` y “Modelo inválido.” no explicaba qué hacer
  (`console:PLAN-2115`).
- Un `attach` se valida en TRES pasos: forma (socket + nombre), ownership y
  EXISTENCIA con `tmuxSessionExists`. El guard aplica candado estricto: un
  principal sin `oversight` solo puede adjuntarse a una sesión `cwc-`/`cwct-`
  del socket propio cuyo `Session.owner` coincida; socket externo, sesión ajena
  u owner desconocido fallan cerrado con `404 "Sesión inexistente."` para no
  revelar existencia. `admin` no concede acceso al contenido; `oversight` sí.
  Una tmux autorizada todavía puede morir entre el listado y el click; el
  chequeo de existencia evita devolver 200 y abrir una pestaña fantasma.
- La rama `attach` resuelve su `cwd` con `safeCwd(cwd, owner)`, igual que la rama
  de creación normal: sin eso la `Session` nacía con `config.home`
  (`/home/nmosquera`, el HOME del HOST) aunque el dueño fuera un inquilino, y el
  pty envoltorio se spawneaba fuera de su workspace (`console:BUG-2119`). Si el
  destino pedido no existe se cae al root del dueño en vez de fallar: el cwd real
  de los panes lo define la tmux a la que se adjunta, no este pty envoltorio.
- El guard `canUseTmuxSession` y su lookup por prefijo viven en
  `terminal/sessions.js` y son la fuente única compartida con `tmux/index.js`.
  No dupliques el criterio: dos copias pueden divergir y reabrir el aislamiento.
- Todos los gates que revelan o controlan contenido usan esa misma capacidad:
  `sessionManager.list(principal)` filtra el listado, `ownedSession` protege el
  ownership HTTP y el handshake del WebSocket de terminal exige dueño u
  `oversight`. Ser admin no saltea ninguno de esos controles.
- En `Session` (terminal/sessions.js) la propiedad de adjuntado es
  `attachSpec`, NO `attach` (colisiona con el método `attach(ws)`).
- BUG-2104 · BUG-2105: el PTY de un inquilino usa un env owner-scoped
  (`userRunnerEnv`) con HOME, `CWC_DATA_DIR` y credencial Claude propios; una
  sesión que corre `claude` falla cerrado si no hay credencial. El spawn además
  garantiza `hasCompletedOnboarding: true` en su `.claude.json`, porque sin esa
  clave el CLI interactivo queda en onboarding aunque tenga credencial válida.
  El server tmux es compartido y de vida larga: conserva el entorno del primer
  cliente que lo levantó, y los panes nuevos heredan ese entorno del server, no
  el del cliente que ejecuta `new-session`. Por eso tanto el host como los
  inquilinos deben pasar explícitamente con `-e` la allowlist crítica y las
  variables runtime `CWC_*`/`TOLKIEN_*` presentes en su propio env
  (`console:BUG-2350`). Solo los inquilinos neutralizan además con `-e CLAVE=`
  los secretos y `CWC_*` encontrados en el entorno global de tmux. El entorno
  (`-e`, incluidos los secretos) ya NO viaja por argv: el `new-session -d`
  completo se escribe en un archivo de comandos tmux `0600` dentro de
  `userDataDir(owner)/terminal-spawn/` (`0700`), se ejecuta sincrónicamente con
  `start-server ; source-file` y se borra en `finally`; el PTY solo ejecuta
  `attach-session -t =<name>`. Si la sesión ya existe no se escribe el archivo,
  equivalente a que `-A` ignoraba los `-e`; para cambiar su entorno hay que
  matarla y recrearla. Residual: el environ del cliente tmux sigue siendo
  legible por procesos del mismo uid; no hay aislamiento de SO.
  El PTY inyecta además `CWC_CONSOLE_ROOT` para resolver CLIs de `bin/` desde
  skills compartidas; llega al pane por el filtro existente de claves
  `CWC_`/`TOLKIEN_`, sin agregarla a `TMUX_ENV_KEYS`.
- IMPORTANTE: el HOME owner-scoped es una MITIGACIÓN, no aislamiento real. El
  inquilino sigue ejecutando como el mismo usuario de SO: desde su shell puede
  navegar a `/home/nmosquera` o adjuntarse con `tmux -S` a sesiones ajenas. El
  aislamiento verdadero exigiría un usuario de SO o un contenedor, alternativas
  que el diseño multi-tenant descartó a propósito; BUG-2105 no cierra ese riesgo.
- El `owner` de una sesión `cwc-*` se PERSISTE en `session-owners.json` (raíz del
  repo, helpers en `core/session-names.js`): `create()` lo guarda tras el spawn
  OK y `rehydrate()` lo restaura tras un reinicio de Node. Sin eso la tmux
  sobrevive pero su dueño no-admin deja de verla, porque `list(principal)`
  filtra por `owner`. FAIL-CLOSED: sin entrada en el mapa, `owner=null` ⇒ solo
  quien tiene `oversight` la ve; nunca se adivina un dueño.
- Recientes es un registro global exclusivo del host: solo host/oversight lo
  leen y un inquilino nunca escribe rutas allí (hallazgos de Salud #110/#144, `console:PLAN-3490`).
- La falta de credencial Claude responde `409` con `publicMessage`; cualquier
  error no reconocido conserva el `500` genérico (hallazgo #111, `console:PLAN-3490`).
- Si no se persiste el owner, crear una sesión de inquilino se aborta y su tmux
  se mata; para el host solo se registra el error (hallazgo #112, `console:PLAN-3490`).
- El WS acepta `input.data` solo string y dimensiones enteras `1..1000`; la
  defensa se repite en `Session.resize()` (hallazgo #113, `console:PLAN-3490`).
- `POST /sessions` acepta `title` string de hasta 120 caracteres y `attach`
  objeto con `socket` y `session` string (hallazgo #114, `console:PLAN-3490`).
