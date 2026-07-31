<!-- cwc:ficha-modulo -->
# src/modules/tmux — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Observa y controla sesiones existentes de los sockets tmux del usuario del sistema: lista sesiones, publica un feed de panes, guarda títulos humanos, inyecta cambios de modelo y mata sesiones. No crea ni adjunta terminales; esas operaciones pertenecen al módulo `terminal`.

No es admin-gated con `isAdmin`. Aplica autorización por principal: un admin ve y opera todo; un no-admin solo puede acceder a una sesión `cwc-`/`cwct-` del socket de la consola cuyo `Session.owner` coincida con su username. La excepción documentada es `/raw-feed`: como alimenta un monitor personal y no una superficie de administración, aplica dueño estricto sin bypass de admin.

## Endpoints

| Método | Ruta | Contrato actual |
|---|---|---|
| GET | `/api/tmux/sessions` | Enumera sesiones, estado/modelo, título custom y `owner` (username o `null`); filtra la salida por dueño y poda títulos huérfanos solo con enumeración confiable. |
| GET | `/api/tmux/raw-feed` | Monitor personal: devuelve hasta 20 terminales `cwc-` del dueño estricto, sin bypass de admin; una sesión histórica sin dueño se considera del host. Excluye TUI ocultas `cwct-`. Sin flag captura 30 líneas/4.000 caracteres para el poll de 3 s; `?full=1` captura 600 líneas/40.000 caracteres una sola vez al descubrir la terminal. |
| POST | `/api/tmux/title` | Guarda o borra el título de `{ socket, session, title }`; recorta a 60 caracteres. |
| POST | `/api/tmux/set-model` | Valida `{ socket, session, model }` e inyecta `/model <modelo>` + Enter en tmux. |
| POST | `/api/tmux/kill` | Mata la sesión validada por `{ socket, session }`. |

## Archivos

- `index.js`: enumera sockets/sesiones/panes, calcula estado y ownership, registra el proveedor de nombres y expone los cinco endpoints.

Delega ejecución y validación de tmux en `core/tmux.js`; modelos y estado observado en `core/claude-model.js` y `core/claude-state.js`; títulos en `core/session-names.js`; ownership vivo en `modules/terminal/sessions.js`.

## Estado

El módulo **no escribe en `~/.cwc-data/`**.

Escribe indirectamente `titles.json` en la raíz del repo mediante `core/session-names.js`, en forma `{ "titles": { "<socket>/<session>": "<título>" } }` y con escritura atómica. No hay TTL: `GET /sessions` poda claves huérfanas, pero solo cuando pudo enumerar sockets y consultar el socket correspondiente de forma confiable. Un título vacío lo elimina explícitamente.

## Lo que más duele

- El guard de un no-admin es fail-closed: exige el socket `config.tmuxSocket`, prefijo conocido y una sesión viva en `sessionManager` con owner coincidente. Sesiones ajenas o sin dueño conocido responden como inexistentes (`404`) para no revelar su existencia.
- `ownsSession` es solo un wrapper de `canUseTmuxSession`, cuya implementación y lookup por prefijo viven en `terminal/sessions.js` como fuente única compartida con la rama `attach`; este movimiento no cambió el comportamiento estricto de `tmux`.
- El `owner` del censo sale del mismo lookup de `sessionManager` que usa el guard `ownsSession`; vale `null` cuando la sesión no se reconoce. La barra de Sesiones lo usa para agrupar las sesiones ajenas en una sección aparte.
- `GET /sessions` primero construye el universo completo para podar correctamente y recién después filtra la respuesta. Filtrar antes haría que una consulta de un inquilino borre títulos válidos de otros usuarios.
- No se poda nada si falla la enumeración de sockets; si falla solo `list-sessions` de un socket, se preservan las claves de ese socket. Un fallo transitorio de tmux no equivale a “sesión muerta”.
- Los fallos de `list-sessions` se loguean con throttle por (call-site, socket): el primero sale de inmediato, luego como máximo uno cada 30 minutos, y un éxito borra ese estado para que una recaída vuelva a avisar. Existe porque el poll de ~3 s llegó a producir 379.471 de 467.601 líneas del journal (81%) y volvió inútil el log (`console:BUG-2438`). El throttle afecta SOLO al log: deben quedar intactos `unverifiedSockets.add()`, el `continue` del proveedor de nombres y la omisión de la poda de títulos de sockets no verificados.
- El estado se busca primero por pane (`stateForPane`) y solo cae a cwd (`stateForCwd`) si no hay observación exacta. Invertirlo vuelve a mezclar dos sesiones de Claude que trabajan en la misma carpeta.
- `raw-feed` solo incluye sesiones `owned`, excluye `cwct-` porque esas TUI ya aparecen por transcript y marca `isClaude` según el observador para evitar duplicados en frontend. Es la única ruta del módulo sin bypass de admin: compara contra `s.owner` y, por retrocompatibilidad, reserva al host las sesiones anteriores al multi-tenant cuyo owner es `null`.
- `/set-model` conserva texto + Enter en una única invocación tmux y `/kill` usa `throwOnError`; de otro modo una sesión que muere durante la operación podría recibir texto parcial o producir un falso `ok: true`.
- `saveTitles()` no lanza: hay que comprobar su boolean. `/title` devuelve `500` si el guardado no fue durable; no respondas éxito solo porque el objeto en memoria cambió.
