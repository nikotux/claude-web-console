<!-- cwc:ficha-modulo -->
# src/modules/admin — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Administración de cuentas y mantenimiento puntual de los motores de chat. Todo el router está protegido por `requireAdmin`, que delega el gate en `isAdmin(req)`: **todos sus endpoints son admin-only**.

No mantiene un modelo propio: el CRUD delega en `core/users.js` y el reciclado busca los procesos `bin/cwc-chat-runner.js` vivos para enviarles `SIGTERM`, sin reiniciar el servidor.

## Endpoints

| Método | Ruta | Contrato actual |
|---|---|---|
| GET | `/api/admin/users` | Lista cuentas como `{ username, admin, oversight, … }`; nunca devuelve hashes. |
| GET | `/api/admin/users/:username/identity` | Lee la identidad persistida en el `userDataDir` de esa cuenta. |
| POST | `/api/admin/users/:username/identity` | Sanea y persiste `name`/`email`/`github`/`signature` en el `userDataDir` de esa cuenta. |
| POST | `/api/admin/users` | Crea una cuenta desde `{ username, password, admin? }`; `admin`, si viene, debe ser boolean, y el username del host está reservado (`409`). |
| PUT | `/api/admin/users/:username` | Cambia `password`, `admin` y/o `oversight`; los flags deben ser booleanos, exige al menos un cambio válido y rechaza tanto la autoedición como el username del host (`409`). |
| POST | `/api/admin/users/:username/sponsor` | Revoca el sponsor o deja la cuenta en espera; rechaza al host y la autoedición (`409`). |
| DELETE | `/api/admin/users/:username` | Elimina una cuenta, invalida sus sesiones web y ejecuta la baja recuperable de sus recursos; rechaza la autoeliminación. |
| POST | `/api/admin/restart-runners` | Envía `SIGTERM` a cada `cwc-chat-runner.js` vivo y devuelve PIDs terminados y fallos individuales. |

Las dos rutas de identidad sanean `:username` con `sanitizeUserId` y además
exigen una coincidencia exacta en `listUsers()`; un id inválido o una cuenta
inexistente devuelve `404`. Para el body comparten `pickIdentity` con
`projects/personalization.js`, en vez de mantener otra allowlist.

El alta por `POST /api/admin/users` llama `provisionNewUser(username)` después
de crear la cuenta. Comparte así la misma preparación de espacio, Pad,
workspace, Tolkien MCP y skills que el wizard, sin duplicar la secuencia. El
provisioning es best-effort: un fallo no cambia el alta ni su status HTTP.

La baja por `DELETE /api/admin/users/:username` conserva este orden contractual:

1. Borra **primero** el workspace Pad exacto `tenant-<usuario>` con el token del
   inquilino. Va antes que el espacio local porque ese token vive dentro de
   `.cwc-users/<usuario>/.pad/credentials.json`; después ya no estaría disponible.
   El DELETE del Pad es soft y restaurable.
2. Quita al usuario del pozo común `comunidad` con el token admin del host. Es
   el único recurso Pad compartido que toca un inquilino: si la membresía
   sobrevive, una cuenta eliminada conserva escritura sobre las lecciones de
   todos. Antes del DELETE aplica G5 (email exactamente
   `<usuario>@console.local`, case-sensitive), G6 (nunca quitar un `owner`) y G7
   (si hay más de un match exacto, no quitar ninguno). La API de Pad no permite
   revocar invitaciones pendientes, solo miembros reales; si el usuario nunca
   aceptó, su invitación queda sin posibilidad de borrado por API.
3. Detecta sesiones tmux vivas registradas a nombre del usuario. Como no existe
   un helper owner-scoped para enumerarlas y matarlas, no inventa uno: las deja
   vivas y agrega sus nombres a `warnings`.
4. Mueve **todo** `~/.cwc-users/<usuario>` a la papelera recuperable por 30 días.
   El trade-off aceptado es que durante ese plazo las credenciales siguen
   legibles y el token Pad sigue válido; el workspace Pad ya fue eliminado.
5. Borra los archivos `<usuario>.*` de los siete directorios de jobs del HOME
   host (`onboard-jobs`, `claude-login-jobs`, `codex-login-jobs`, `codex-jobs`,
   `gh-login-jobs`, `infisical-login`, `tolkien-setup`) y el estado durable de
   `onboard-provisioning`.
6. Revoca las invitaciones no consumidas ni revocadas cuyo `lockedTo` sea el
   usuario.

Antes de tocar recursos aplica cuatro guards fail-closed: G1 sanea el username;
G2 prohíbe explícitamente dar de baja al **host**, porque su `userSpace()` es el
HOME real; G3 verifica contención con `path.relative` bajo el `USERS_ROOT`
compartido; G4 exige borrar solo un slug que empiece con `tenant-`. Este último
evita iterar los workspaces visibles con el token y borrar `comunidad`, el pozo
común de todos los usuarios. G5–G7 se aplican después de listar la membresía,
pero antes de quitar a alguien del pozo compartido.

La respuesta exitosa ahora es `{ ok: true, cleanup }`. Un cleanup completo tiene
la forma `{ ok: true, user, trash: { status, id? }, pad: { status, slug?, error? },
shared: { status, workspace?, reason?, error? }, jobs: { removed: [...] },
invites: { revoked }, warnings: [...] }`. Cada paso es best-effort y acumula
avisos sin abortar los posteriores. Si un guard rechazó la baja segura después
de quitar la cuenta de `users.json`, el endpoint mantiene HTTP exitoso y
devuelve `cleanup: { ok: false, error }`.

## Archivos

- `index.js`: define el gate administrativo y los handlers HTTP, conecta la baja profunda, importa `pickIdentity` de `../projects/personalization.js` y detecta runners vivos con `pgrep`.
- `../../core/user-deprovision.js`: orquesta la baja best-effort, sus guards y el reporte estructurado.

Las validaciones y persistencia de cuentas viven en `core/users.js`; la identidad, `isAdmin` y la revocación de sesiones viven en `core/auth.js`.

## Estado

Este módulo no mantiene un store propio. El CRUD y la baja escriben
indirectamente mediante los helpers de core y onboard.

El CRUD escribe indirectamente `users.json` en la raíz del repo, mediante `core/users.js`. Su forma es `{ "users": [{ "username", "hash", "admin", "oversight", "lang"? }] }`; los hashes son `scrypt$salt$derivedKey`, el archivo se fuerza a modo `0600` y no tiene poda automática. La baja también mueve el espacio del inquilino a `~/.cwc-trash/`, borra jobs administrativos bajo `~/.cwc-data/`, elimina su workspace Pad y revoca invitaciones asociadas. El endpoint de runners no persiste estado.

## Lo que más duele

- Las dos rutas de identidad DEBEN quedar después de `r.use(requireAdmin)`, igual que el resto: mover el gate o montar una ruta fuera de `r` abriría la única jerarquía real de permisos del módulo.
- Cambiar una contraseña revoca todas las sesiones vivas de esa cuenta. Una democión (`admin: false`) también las revoca como defensa en profundidad, aunque ya es efectiva desde el request siguiente por el lookup vivo; eliminar la cuenta hace lo mismo.
- `principalOf()` resuelve tanto `oversight` como `admin` en vivo con
  `oversightFor()` / `adminFor()` en cada request: apagar el primero o degradar
  el segundo vale desde el request siguiente. La revocación conservada al
  degradar no es el mecanismo que hace efectiva la democión.
- La autoedición (incluido sponsor) y la autoeliminación devuelven `409`. No quitar esas guardas: evitan que el admin conectado se deje sin acceso desde este router.
- POST y PUT tampoco permiten administrar una cuenta cuyo username coincida con
  `hostUser()`: `userSpace()`/`userFileRoot()` resuelven por string y esa cuenta
  obtendría el HOME REAL aunque su fila dijera `admin:false`, saltándose todo el
  confinamiento multi-tenant. `createUser()` NO normaliza el username: no hace
  trim ni lowercase, valida por regex y persiste el valor original; por eso el
  POST compara `String(username || '').trim()` defensivamente antes de llamarlo
  (el PUT compara el parámetro de ruta ya validado con `hostUser()`).
- Las reglas de username, la contraseña mínima de 10 caracteres y el hash no están acá sino en `core/users.js`; no dupliques validaciones con criterios distintos.
- `restart-runners` reconoce hijos por el texto `cwc-chat-runner.js` en su línea de comando. Cambiar el nombre o la forma de lanzamiento sin actualizar este patrón vuelve el reciclado inefectivo.
- `pgrep` tiene timeout de 5 s; exit 1 significa “no hay runners”, pero timeout/señal son errores. Los fallos al señalar un PID se acumulan sin abortar los demás; este endpoint nunca debe matar `src/server.js` ni reemplazar un reinicio real del servicio.
