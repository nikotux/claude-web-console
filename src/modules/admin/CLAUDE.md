<!-- cwc:ficha-modulo -->
# src/modules/admin — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Administración de cuentas y mantenimiento puntual de los motores de chat. Todo el router está protegido por `requireAdmin`, que delega el gate en `isAdmin(req)`: **todos sus endpoints son admin-only**.

No mantiene un modelo propio: el CRUD delega en `core/users.js` y el reciclado busca los procesos `bin/cwc-chat-runner.js` vivos para enviarles `SIGTERM`, sin reiniciar el servidor.

## Endpoints

| Método | Ruta | Contrato actual |
|---|---|---|
| GET | `/api/admin/users` | Lista cuentas como `{ username, admin }`; nunca devuelve hashes. |
| POST | `/api/admin/users` | Crea una cuenta desde `{ username, password, admin? }`; `admin`, si viene, debe ser boolean. |
| PUT | `/api/admin/users/:username` | Cambia `password` y/o `admin`; exige al menos un cambio válido y rechaza que un admin se modifique a sí mismo. |
| DELETE | `/api/admin/users/:username` | Elimina una cuenta; rechaza la autoeliminación. |
| POST | `/api/admin/restart-runners` | Envía `SIGTERM` a cada `cwc-chat-runner.js` vivo y devuelve PIDs terminados y fallos individuales. |

El alta por `POST /api/admin/users` llama `provisionNewUser(username)` después
de crear la cuenta. Comparte así la misma preparación de espacio, Pad,
workspace, Tolkien MCP y skills que el wizard, sin duplicar la secuencia. El
provisioning es best-effort: un fallo no cambia el alta ni su status HTTP.

## Archivos

- `index.js`: define el gate administrativo, los cinco handlers HTTP y la detección de runners vivos con `pgrep`.

Las validaciones y persistencia de cuentas viven en `core/users.js`; la identidad, `isAdmin` y la revocación de sesiones viven en `core/auth.js`.

## Estado

Este módulo **no escribe en `~/.cwc-data/`**.

El CRUD escribe indirectamente `users.json` en la raíz del repo, mediante `core/users.js`. Su forma es `{ "users": [{ "username", "hash", "admin", "lang"? }] }`; los hashes son `scrypt$salt$derivedKey`, el archivo se fuerza a modo `0600` y no tiene poda automática. El endpoint de runners no persiste estado.

## Lo que más duele

- El `r.use(requireAdmin)` debe seguir antes de registrar las rutas: moverlo o montar una ruta fuera de `r` abriría la única jerarquía real de permisos del módulo.
- Cambiar una contraseña revoca todas las sesiones vivas de esa cuenta. Una democión (`admin: false`) también las revoca para que una cookie anterior no conserve privilegios; eliminar la cuenta hace lo mismo.
- La autoedición y la autoeliminación devuelven `409`. No quitar esas guardas: evitan que el admin conectado se deje sin acceso desde este router.
- Las reglas de username, la contraseña mínima de 10 caracteres y el hash no están acá sino en `core/users.js`; no dupliques validaciones con criterios distintos.
- `restart-runners` reconoce hijos por el texto `cwc-chat-runner.js` en su línea de comando. Cambiar el nombre o la forma de lanzamiento sin actualizar este patrón vuelve el reciclado inefectivo.
- `pgrep` con exit 1 significa “no hay runners” y no es un error. Los fallos al señalar un PID se acumulan sin abortar los demás; este endpoint nunca debe matar `src/server.js` ni reemplazar un reinicio real del servicio.
