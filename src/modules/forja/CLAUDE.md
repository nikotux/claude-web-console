<!-- cwc:ficha-modulo -->
# src/modules/forja — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente al leer archivos del módulo. Las reglas duras y convenciones globales viven en el `CLAUDE.md` raíz.

## Qué es

La Forja convierte los PRs mergeados de Tolkien en progresión personal, medallas, crónica de hitos y una arena mensual. Es determinística y no usa IA. Participar es opt-in: un usuario solo aparece cuando su `instance.json` propio declara un `identity.github` no vacío. Esa identidad es autodeclarada: si dos o más usuarios reclaman el mismo login sin distinguir mayúsculas, ninguno participa y el ciclo deja un warning con los usuarios en conflicto. Cabina no tiene La Forja; los patrocinados (`sponsored` o `awaiting-sponsor`) no participan.

## Archivos

- `compute.js`: funciones puras de normalización, zona `America/Bogota`, niveles, impacto, rachas hábiles, medallas, crónica, temporada y arena.
- `players.js`: resuelve usuarios de consola + host y su identidad GitHub; atribuye ramas del bot por prefijo.
- `store.js`: snapshots atómicos privados y públicos, con rutas resueltas por operación.
- `refresher.js`: carga disco, serializa en una sola cola los ciclos de arranque, periódicos y manuales, y conserva historial incremental.
- `index.js`: endpoints HTTP y reglas de ownership.

## Endpoints

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/api/forja/me` | Snapshot privado del principal. Sin `identity.github`: `{configured:false,hint:'identity.github'}`. |
| GET | `/api/forja/arena` | Temporada, brechas, MVP, misión propia y campos públicos de cada jugador; cada jugador lleva un `playerId` opaco estable y `isMe` se determina comparando ese identificador. |
| POST | `/api/forja/refresh` | Refresca únicamente al dueño derivado del principal; ignora repeticiones dentro de 60 segundos. |

## Persistencia

- Dueño: `userDataDir(owner)/forja/me.json`.
- Arena pública: `userDataDir(hostUser())/forja/arena.json`.
- Historial acumulado del bot: `userDataDir(hostUser())/forja/bot-prs.json`.
- Caché de GitHub: `~/.cwc-data/comms/pr-author-cache/`, administrada por el lector canónico host-global de `comms`.

No se permite calcular rutas user-scoped al importar el módulo. `store.js` las resuelve dentro de cada llamada y escribe con `writeJsonAtomic`.

## GitHub y atribución

Toda lectura pasa por `listMergedPrsByAuthor()` de `comms/pr-read-shared.js`, que ejecuta `gh` con la autenticación del host, repo explícito `Mordor-Staffing/tolkien`, caché de 150 segundos y fallback stale al último bueno. La primera lectura de una identidad pide hasta 1000 PRs; las incrementales piden los 50 más recientes y se unen por número con el historial persistido, de modo que una respuesta vacía nunca borra anillos. Un cambio de login descarta el historial personal anterior y vuelve a hacer una lectura completa. Por ciclo se consulta una vez `app/tolkien-builder`; su historial también se acumula y sus PRs se atribuyen cuando el prefijo anterior a `/` coincide, sin distinguir mayúsculas, con el login GitHub o username de consola. Las lecturas de `gh`, incluida la del bot, corren en un pool de hasta 3 solicitudes concurrentes. No se consultan ni atribuyen `app/mordor-staffing-updates`, `app/renovate` o `app/dependabot`.

Cada snapshot personal conserva tres relojes distintos: `generatedAt` es cuándo se computó; `fetchedAt`, la última lectura directa fresca; y `dataAsOf`, la última vez que tanto la lectura directa como la del bot fueron exitosas y no stale. `dataAsOf` no avanza ante ningún fallo o fallback stale. `lastAttemptAt` avanza en cada intento del jugador, incluso fallido, y el refresh manual aplica su límite contra el más reciente entre `fetchedAt` y `lastAttemptAt`. La arena publica el `dataAsOf` más antiguo de todos los jugadores como watermark conjunto.

## Privacidad y reglas

- El owner siempre es `principalOf(req).username || hostUser()`. Query y body nunca deciden usuario.
- `me.json` puede contener PRs, títulos, impacto y medallas: jamás se mezcla con otro dueño ni se sirve en arena.
- Arena persiste y sirve solo `playerId` opaco, nombre visible, iniciales y métricas agregadas; no expone username, login GitHub, títulos ni URLs de PR. `isMe` se agrega al servir comparando `playerId`, nunca por ranking.
- Que la arena muestre los nombres visibles de colegas es intencional; son parte del contrato público de la competencia, a diferencia del username y login GitHub.
- Los defaults visibles en español viven como datos junto a sus ids estables en `compute.js`; un frontend futuro traduce por id.
- Un fallo de GitHub nunca reemplaza el snapshot bueno por un vacío: se conserva, se marca `stale` y se registra el error sin credenciales.
