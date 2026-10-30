<!-- cwc:ficha-modulo -->
# src/modules/forja — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente al leer archivos del módulo. Las reglas duras y convenciones globales viven en el `CLAUDE.md` raíz.

## Qué es

La Forja convierte los PRs mergeados de Tolkien en progresión personal, medallas, crónica de hitos y una arena mensual. Es determinística y no usa IA. Participar es opt-in: un usuario solo aparece cuando su `instance.json` propio declara un `identity.github` válido. El formato aceptado es `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`; las configs legacy inválidas se ignoran y vuelven a mostrar el CTA de corrección, sin tumbar el refresher. Si dos o más usuarios reclaman el mismo login sin distinguir mayúsculas, ninguno participa y el ciclo deja un warning con los usuarios en conflicto. Cabina no tiene La Forja; los patrocinados (`sponsored` o `awaiting-sponsor`) no participan.

## Archivos

- `compute.js`: funciones puras de normalización, zona `America/Bogota`, niveles, impacto, rachas hábiles, medallas, crónica, temporada y arena.
- `players.js`: resuelve usuarios de consola + host y su identidad GitHub; atribuye ramas del bot por prefijo.
- `store.js`: snapshots atómicos privados y públicos, con rutas resueltas por operación.
- `refresher.js`: carga disco, serializa en una sola cola los ciclos de arranque, periódicos y manuales, y conserva historial incremental.
- `index.js`: endpoints HTTP y reglas de ownership.

## Frontend

La superficie vive en `public/js/modules/forja/`: `forja.js` orquesta polling cada 60 s (pausado con la pestaña oculta), validación de opt-in y modal; `ficha.js`, `salon.js` y `arena.js` renderizan las tres vistas solo con nodos DOM para datos del servidor; `view.js` concentra traducciones por id y formatos; `help.js` documenta la superficie. Se monta al final del flujo principal del sidebar, inmediatamente debajo de Laboratorio, mediante `[data-module="forja"]`. Nace plegada y persiste el estado en `cwc.forja.open`, igual que Laboratorio. Plegada muestra martillo/yunque o candado+invitación si falta ficha; el movimiento queda anulado por `prefers-reduced-motion`. Desplegada conserva la ficha/CTA y abre un modal ancho con «Mi salón» privado y «Arena» pública. La cabecera de ese modal muestra el login actual: su acción «Cambiar usuario de GitHub» reabre la configuración en modo corrección, re-forja la ficha y recarga el estado del sidebar; enviar el mismo login ignorando mayúsculas solo cierra el diálogo.

Los estilos están prefijados `.fj-` en `public/css/style.css`; la paleta semántica `--forja-*` vive en `tokens.css`, el emblema aprobado es `public/img/forja/yunque.svg`, la escena amplia es `forja.svg` y los assets compactos son `yunque-mini.svg`/`candado.svg`. Las ilustraciones `public/img/forja/*.svg` son una excepción explícita a los tokens: son assets de arte cargados con `<img>` y no pueden leer variables CSS, igual que `public/img/mordor-*.png`; los colores de UI siguen saliendo únicamente de `--forja-*`. Todo texto fijo usa `t('forja.…', fallbackEs)`, con inglés en `public/i18n/en/forja.json`; nivel y medalla se traducen por sus ids estables. El opt-in valida formato en cliente, consulta `POST /api/forja/validate-login`, relee `GET /api/projects/me/identity`, preserva los cuatro campos y cambia solo `identity.github` por el `canonicalLogin`, antes de pedir `POST /api/forja/refresh`.

El login se cambia desde el modal, no editando `instance.json` a mano. `loadInstance` mantiene una caché en memoria en `src/core/instance-config.js`: una edición directa en disco no se refleja sin reiniciar, mientras que `POST /api/projects/me/identity` pasa por `saveInstance`, actualiza esa caché y permite re-forjar de inmediato.

## Endpoints

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/api/forja/me` | Snapshot privado del principal sin `prs`; el historial completo queda solo en `me.json` para el refresher. Sin `identity.github`: `{configured:false,hint:'identity.github'}`. |
| GET | `/api/forja/arena` | Temporada, brechas, MVP, misión propia y campos públicos de cada jugador; cada jugador lleva un `playerId` opaco estable y `isMe` se determina comparando ese identificador. |
| POST | `/api/forja/validate-login` | Body `{login}` owner-scoped, rate-limit 8/min. Valida formato y existencia por el lector canónico; responde `{ok,exists,canonicalLogin,name}` y 503 si GitHub entrega datos stale. |
| POST | `/api/forja/refresh` | Refresca únicamente al dueño derivado del principal; ignora repeticiones dentro de 60 segundos. |

## Persistencia

- Dueño: `userDataDir(owner)/forja/me.json`.
- Perfil GitHub validado: `userDataDir(owner)/forja/github-profile.json` con login canónico, nombre público y fecha; solo sirve como fallback de `displayName` cuando `identity.name` está vacío.
- Arena pública: `userDataDir(hostUser())/forja/arena.json`.
- Historial acumulado del bot: `userDataDir(hostUser())/forja/bot-prs.json`.
- Caché de GitHub: `~/.cwc-data/comms/pr-author-cache/`, administrada por el lector canónico host-global de `comms`.

No se permite calcular rutas user-scoped al importar el módulo. `store.js` las resuelve dentro de cada llamada y escribe con `writeJsonAtomic`.

Los archivos `forja/festejos.json` que puedan existir de versiones anteriores quedan intactos en disco por preservación de datos, pero La Forja ya no los lee ni los escribe.

## GitHub y atribución

Toda lectura pasa por `comms/pr-read-shared.js`: `listMergedPrsByAuthor()` ejecuta `gh` con la autenticación del host, repo explícito `Mordor-Staffing/tolkien`, caché de 150 segundos y fallback stale al último bueno; `getLatestMergedActivity()` sondea el PR mergeado con actividad más reciente; `githubUserExists()` valida/perfila. La primera lectura de una identidad pide hasta 1000 PRs; las incrementales piden los 50 más recientes y se unen por número. El primer ciclo tras arrancar y todo refresh manual hacen la consulta completa de autores. Los errores de red/5xx conservan el último snapshot bueno marcado stale. Los P perfiles sin `identity.name` suman P validaciones iniciales y luego quedan persistidos/cacheados. Las lecturas directas+bot corren en un pool de hasta 3. No se consultan ni atribuyen bots excluidos.

Cada snapshot personal conserva tres relojes distintos: `generatedAt` es cuándo se computó; `fetchedAt`, la última lectura directa fresca; y `dataAsOf`, la última vez que tanto la lectura directa como la del bot fueron exitosas y no stale. `dataAsOf` no avanza ante ningún fallo o fallback stale. `lastAttemptAt` avanza en cada intento del jugador, incluso fallido, y el refresh manual aplica su límite contra el más reciente entre `fetchedAt` y `lastAttemptAt`. La arena publica el `dataAsOf` más antiguo de todos los jugadores como watermark conjunto.

## Privacidad y reglas

- El owner siempre es `principalOf(req).username || hostUser()`. Query y body nunca deciden usuario.
- `me.json` puede contener PRs, títulos, impacto y medallas: jamás se mezcla con otro dueño ni se sirve en arena.
- Arena persiste y sirve solo `playerId` opaco, nombre visible, iniciales y métricas agregadas; no expone username, login GitHub, títulos ni URLs de PR. `isMe` se agrega al servir comparando `playerId`, nunca por ranking.
- Que la arena muestre los nombres visibles de colegas es intencional; son parte del contrato público de la competencia, a diferencia del username y login GitHub.
- Los defaults visibles en español viven como datos junto a sus ids estables en `compute.js`; un frontend futuro traduce por id.
- Un fallo de GitHub nunca reemplaza el snapshot bueno por un vacío: se conserva, se marca `stale` y se registra el error sin credenciales.

## Rendimiento

`compute.js` reutiliza un `Intl.DateTimeFormat` por zona horaria porque construirlo por cada fecha bloquea el event loop, y conserva en un memo acotado las claves de día y mes por zona + `mergedAt`. El refresher evita las lecturas por autor cuando `getLatestMergedActivity()` confirma que no cambió la actividad mergeada; el primer ciclo, los refresh manuales, los cambios de login y cualquier fallo del sondeo consultan completo. Al omitir `prs`, los tres snapshots reales medidos bajaron de 33.344–52.165 bytes a 4.537–4.552 bytes por respuesta de `/me`. Los presupuestos del benchmark son 20 ms para 3×85 PRs, 50 ms para 3×300 y 150 ms para 10×300. Corré `node scripts/forja-bench.mjs` y exigí los tres escenarios en `OK` antes de cerrar cualquier cambio en `compute.js`.
