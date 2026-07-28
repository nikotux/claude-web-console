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
  no-admin solo puede adjuntarse a una sesión `cwc-`/`cwct-` del socket propio
  cuyo `Session.owner` coincida; socket externo, sesión ajena u owner
  desconocido fallan cerrado con `404 "Sesión inexistente."` para no revelar
  existencia. El admin conserva acceso total. Una tmux autorizada todavía puede
  morir entre el listado y el click; el chequeo de existencia evita devolver
  200 y abrir una pestaña fantasma.
- El guard `canUseTmuxSession` y su lookup por prefijo viven en
  `terminal/sessions.js` y son la fuente única compartida con `tmux/index.js`.
  No dupliques el criterio: dos copias pueden divergir y reabrir el aislamiento.
- En `Session` (terminal/sessions.js) la propiedad de adjuntado es
  `attachSpec`, NO `attach` (colisiona con el método `attach(ws)`).
- BUG-2104 · BUG-2105: el PTY de un inquilino usa un env owner-scoped
  (`userRunnerEnv`) con HOME, `CWC_DATA_DIR` y credencial Claude propios; una
  sesión que corre `claude` falla cerrado si no hay credencial. El spawn además
  garantiza `hasCompletedOnboarding: true` en su `.claude.json`, porque sin esa
  clave el CLI interactivo queda en onboarding aunque tenga credencial válida.
  Como el server tmux es compartido con el host, cada `new-session` debe recibir
  las variables críticas y el OAuth opcional mediante `-e`, y neutralizar con `-e CLAVE=` las
  variables de su entorno global que sean secretos o empiecen con `CWC_`. Con
  `-A`, una sesión ya creada conserva su env viejo durante la rehidratación: hay
  que matarla y recrearla para que tome el aislamiento nuevo.
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
  el admin la ve; nunca se adivina un dueño.
