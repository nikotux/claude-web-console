<!-- cwc:ficha-modulo -->
# src/modules/stats — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Telemetría de recursos del host y del proceso servidor, más una vista operativa por usuario para el despliegue multi-tenant. `systemSnapshot()` es la fuente única de CPU, memoria, disco, load, uptime y hostname y también la importa directamente el módulo `health`.

El módulo no es admin-gated completo: las estadísticas generales son accesibles a cualquier usuario autenticado; solo el desglose `/users` verifica `isAdmin(req)`.

## Endpoints

| Método | Ruta | Contrato actual |
|---|---|---|
| GET | `/api/stats` | Devuelve `{ cpu, mem, disk, load, uptime, hostname, server: { uptime, pid } }`. |
| GET | `/api/stats/users` | **Admin-only (`isAdmin`)**. Devuelve `{ users: [{ userId, liveSessions, runners, rssMB, diskBytes }] }`. |

## Archivos

- `index.js`: calcula snapshots del sistema, exporta `systemSnapshot()` y `perUserSnapshot()`, atribuye chats/runners a usuarios y registra los dos endpoints.

Consume `manager` desde `modules/chat`, helpers de espacios desde `core/user-space.js`, `config.home` y el gate `isAdmin` de `core/auth.js`.

## Estado

Este módulo **no escribe en `~/.cwc-data/` ni en otro archivo** y no tiene política de poda.

Lee `~/.cwc-data/chats/<chatId>.spawnlock` para obtener el PID del runner y medir su RSS desde `/proc/<pid>/status`. Mantiene únicamente `prevCpu` en memoria de proceso (`{ idle, total }`) para calcular el delta de CPU; se pierde al reiniciar.

## Lo que más duele

- El porcentaje de CPU es un delta desde la llamada anterior y vale 0 en la primera. `prevCpu` es global al módulo: `/api/stats` y cualquier importador de `systemSnapshot()` —hoy `health`— consumen el mismo contador.
- Cambiar el shape de `systemSnapshot()` rompe tanto este endpoint como Salud. Memoria intenta `/proc/meminfo` y cae a `os.*`; disco usa `statfs(config.home)` y, si falla, conserva el shape con `unavailable: true`.
- `/api/stats/users` debe conservar su gate `isAdmin`. La atribución usa el `owner` de chats vivos; un chat TUI cuenta como sesión pero no como runner.
- El RSS es best-effort y depende del PID guardado en el `spawnlock`: archivo ausente, proceso muerto o `/proc` ilegible aportan 0, no deben tirar todo el snapshot.
- El disco por usuario solo se calcula para inquilinos; para el host es `null` porque recorrer todo su home sería demasiado costoso. El walk comparte un budget aproximado de 200.000 archivos entre `.cwc-data` y `.claude` del inquilino y omite errores.
- Mantener las lecturas por PID y el recorrido de disco asíncronos: convertirlos a filesystem síncrono dentro del handler bloquearía también los WebSockets de los demás usuarios.
