<!-- cwc:ficha-modulo -->
# src/modules/forja — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente al leer archivos del módulo. Las reglas duras y convenciones globales viven en el `CLAUDE.md` raíz.

## Qué es

La Forja convierte los PRs mergeados de Tolkien en progresión personal, medallas, crónica de hitos y una arena mensual. Es determinística y no usa IA. Participar es opt-in: un usuario solo aparece cuando su `instance.json` propio declara un `identity.github` no vacío.

## Archivos

- `compute.js`: funciones puras de normalización, zona `America/Bogota`, niveles, impacto, rachas hábiles, medallas, crónica, temporada y arena.
- `players.js`: resuelve usuarios de consola + host y su identidad GitHub; atribuye ramas del bot por prefijo.
- `store.js`: snapshots atómicos privados y públicos, con rutas resueltas por operación.
- `refresher.js`: carga disco, refresca al arrancar y cada 3 minutos, deduplica trabajo en curso y conserva el último bueno.
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
- Caché de GitHub: `~/.cwc-data/comms/pr-author-cache/`, administrada por el lector canónico host-global de `comms`.

No se permite calcular rutas user-scoped al importar el módulo. `store.js` las resuelve dentro de cada llamada y escribe con `writeJsonAtomic`.

## GitHub y atribución

Toda lectura pasa por `listMergedPrsByAuthor()` de `comms/pr-read-shared.js`, que ejecuta `gh` con la autenticación del host, repo explícito `Mordor-Staffing/tolkien`, caché de 150 segundos y fallback stale al último bueno. Por ciclo se consulta una vez `app/tolkien-builder`; sus PRs se atribuyen cuando el prefijo anterior a `/` coincide, sin distinguir mayúsculas, con el login GitHub o username de consola. No se consultan ni atribuyen `app/mordor-staffing-updates`, `app/renovate` o `app/dependabot`.

## Privacidad y reglas

- El owner siempre es `principalOf(req).username || hostUser()`. Query y body nunca deciden usuario.
- `me.json` puede contener PRs, títulos, impacto y medallas: jamás se mezcla con otro dueño ni se sirve en arena.
- Arena persiste y sirve solo `playerId` opaco, nombre visible, iniciales y métricas agregadas; no expone username, login GitHub, títulos ni URLs de PR. `isMe` se agrega al servir comparando `playerId`, nunca por ranking.
- Los defaults visibles en español viven como datos junto a sus ids estables en `compute.js`; un frontend futuro traduce por id.
- Un fallo de GitHub nunca reemplaza el snapshot bueno por un vacío: se conserva, se marca `stale` y se registra el error sin credenciales.
