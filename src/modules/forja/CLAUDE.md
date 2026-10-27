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

## Frontend

La superficie vive en `public/js/modules/forja/`: `forja.js` orquesta polling cada 60 s (pausado con la pestaña oculta), opt-in y modal; `ficha.js`, `salon.js` y `arena.js` renderizan las tres vistas solo con nodos DOM para datos del servidor; `festejo.js` administra la cola visible de celebraciones, el título intermitente y su acuse; `view.js` concentra traducciones por id y formatos; `help.js` documenta la superficie. Se monta cerca del inicio del sidebar mediante `[data-module="forja"]` y abre un modal ancho con «Mi salón» privado y «Arena» pública.

Los estilos están prefijados `.fj-` en `public/css/style.css`; la paleta semántica `--forja-*` vive en `tokens.css`, el emblema aprobado es `public/img/forja/yunque.svg` y la escena amplia es `forja.svg`. Las ilustraciones `public/img/forja/*.svg` son una excepción explícita a los tokens: son assets de arte cargados con `<img>` y no pueden leer variables CSS, igual que `public/img/mordor-*.png`; los colores de UI siguen saliendo únicamente de `--forja-*`. Todo texto fijo usa `t('forja.…', fallbackEs)`, con inglés en `public/i18n/en/forja.json`; nivel y medalla se traducen por sus ids estables. El opt-in relee `GET /api/projects/me/identity` al enviar, preserva los cuatro campos y cambia solo `identity.github` por `POST`, antes de pedir `POST /api/forja/refresh`.

## Endpoints

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/api/forja/me` | Snapshot privado del principal. Sin `identity.github`: `{configured:false,hint:'identity.github'}`. |
| GET | `/api/forja/arena` | Temporada, brechas, MVP, misión propia y campos públicos de cada jugador; cada jugador lleva un `playerId` opaco estable y `isMe` se determina comparando ese identificador. |
| GET | `/api/forja/festejos` | `{pending:[...]}` privado del principal. Nunca acepta owner por query o body. |
| POST | `/api/forja/festejos/visto` | Body `{numbers:[enteros positivos]}`; elimina solo esos números de la cola pendiente del principal. |
| POST | `/api/forja/refresh` | Refresca únicamente al dueño derivado del principal; ignora repeticiones dentro de 60 segundos. |

`GET /api/forja/me` incluye `pendingFestejos`, incluso en el estado no configurado, para que el polling existente detecte la cola sin otra consulta. El frontend solo pide el detalle cuando el contador es positivo y espera a que la pestaña esté visible. Cada festejo lleva `number`, `title`, `url`, `deskTicket`, `durationMin`, `additions`, `deletions`, `ringOfMonth`, `monthLabel`, `throne` y `mergedAt`. `throne` es estructurado (`leader`, `leader-alone`, `challenger` o `unknown`) para traducirlo sin persistir texto de UI.

## Persistencia

- Dueño: `userDataDir(owner)/forja/me.json`.
- Festejos por dueño: `userDataDir(owner)/forja/festejos.json` con `{login, initializedAt, celebrated, pending}`.
- Arena pública: `userDataDir(hostUser())/forja/arena.json`.
- Historial acumulado del bot: `userDataDir(hostUser())/forja/bot-prs.json`.
- Caché de GitHub: `~/.cwc-data/comms/pr-author-cache/`, administrada por el lector canónico host-global de `comms`.

No se permite calcular rutas user-scoped al importar el módulo. `store.js` las resuelve dentro de cada llamada y escribe con `writeJsonAtomic`.

El primer ciclo fresco, la ausencia del archivo o un cambio de login inicializan `celebrated` con todos los PR actuales y `pending` vacío: nunca festejan historia vieja. En ciclos frescos posteriores, cada número no celebrado se marca durablemente y genera un objeto pendiente. La cola conserva como máximo los diez más nuevos; los descartados por el límite siguen en `celebrated` y no reaparecen.

## GitHub y atribución

Toda lectura pasa por `listMergedPrsByAuthor()` de `comms/pr-read-shared.js`, que ejecuta `gh` con la autenticación del host, repo explícito `Mordor-Staffing/tolkien`, caché de 150 segundos y fallback stale al último bueno. La primera lectura de una identidad pide hasta 1000 PRs; las incrementales piden los 50 más recientes y se unen por número con el historial persistido, de modo que una respuesta vacía nunca borra anillos. Un cambio de login descarta el historial personal anterior y vuelve a hacer una lectura completa. Por ciclo se consulta una vez `app/tolkien-builder`; su historial también se acumula y sus PRs se atribuyen cuando el prefijo anterior a `/` coincide, sin distinguir mayúsculas, con el login GitHub o username de consola. Las lecturas de `gh`, incluida la del bot, corren en un pool de hasta 3 solicitudes concurrentes. No se consultan ni atribuyen `app/mordor-staffing-updates`, `app/renovate` o `app/dependabot`.

Cada snapshot personal conserva tres relojes distintos: `generatedAt` es cuándo se computó; `fetchedAt`, la última lectura directa fresca; y `dataAsOf`, la última vez que tanto la lectura directa como la del bot fueron exitosas y no stale. `dataAsOf` no avanza ante ningún fallo o fallback stale. `lastAttemptAt` avanza en cada intento del jugador, incluso fallido, y el refresh manual aplica su límite contra el más reciente entre `fetchedAt` y `lastAttemptAt`. La arena publica el `dataAsOf` más antiguo de todos los jugadores como watermark conjunto.

## Privacidad y reglas

- El owner siempre es `principalOf(req).username || hostUser()`. Query y body nunca deciden usuario.
- `me.json` puede contener PRs, títulos, impacto y medallas: jamás se mezcla con otro dueño ni se sirve en arena.
- `festejos.json` contiene títulos, URLs y métricas privadas. Tanto lectura como acuse derivan el owner de `principalOf(req).username || hostUser()`; un principal no puede leer ni marcar festejos ajenos.
- Arena persiste y sirve solo `playerId` opaco, nombre visible, iniciales y métricas agregadas; no expone username, login GitHub, títulos ni URLs de PR. `isMe` se agrega al servir comparando `playerId`, nunca por ranking.
- Que la arena muestre los nombres visibles de colegas es intencional; son parte del contrato público de la competencia, a diferencia del username y login GitHub.
- Los defaults visibles en español viven como datos junto a sus ids estables en `compute.js`; un frontend futuro traduce por id.
- Un fallo de GitHub nunca reemplaza el snapshot bueno por un vacío: se conserva, se marca `stale` y se registra el error sin credenciales.
