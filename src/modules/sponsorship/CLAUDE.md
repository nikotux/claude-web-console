<!-- cwc:ficha-modulo -->
# src/modules/sponsorship — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Qué es

Patrocinio self-service de perfiles que un administrador dejó en
`awaiting-sponsor`. Separa las dos facultades del alta: el admin decide quién
entra a la consola; cada usuario decide a quién le presta su propia credencial
de Claude.

La ruta base es `/api/sponsorship`. Todos sus endpoints requieren autenticación
por el gate global de la API. Las ocho rutas self-service resuelven al usuario
con `principalUsername(req,res)` y **no son admin-only**: la adopción y el token
propio pertenecen al sponsor, no al administrador. Las tres rutas bajo `/admin`
son la vía administrativa explícita y sí exigen `isAdmin(req)`. El token maestro
no tiene perfil de usuario y recibe 400 en las rutas self-service.

## Endpoints

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/api/sponsorship/candidates` | Devuelve `{ candidates: [{ username }] }` sólo para perfiles en `awaiting-sponsor` cuando el principal puede patrocinar (estado `none` + token propio listo); en otro caso devuelve la lista vacía. No filtra ningún otro dato del registro. |
| GET | `/api/sponsorship/mine` | Devuelve `{ canSponsor, tokenReady, sponsored }`; cada patrocinado incluye `{ username, todayUsd, thresholdUsd }`. |
| POST | `/api/sponsorship/adopt` | El principal adopta `{ username }` únicamente si el target existe y sigue esperando sponsor, no es él mismo, el principal no es patrocinado y tiene listo su token propio; sin token responde `400`. |
| POST | `/api/sponsorship/release` | El principal suelta `{ username }` sólo cuando es su sponsor actual; cualquier otro caso responde `403` sin revelar al sponsor real. |
| POST | `/api/sponsorship/token/start` | Reserva sincrónicamente el job con `wx`, spawnea `cwc-sponsor-token-runner.js` y persiste el PID antes de responder. Si ya vive, devuelve sólo el estado público con `alreadyRunning:true`, sin PID; `child.on('error')` persiste el error de lanzamiento. El hijo corre `detached` + `unref`, por lo que sobrevive al reinicio del server. |
| GET | `/api/sponsorship/token/status` | Lee `userDataDir(user)/sponsor-token-jobs/<user>.json` y devuelve exactamente `{ status, url, note, error, ready }`; NUNCA expone el token. |
| POST | `/api/sponsorship/token/code` | Recibe `{ code }` no vacío de hasta 512 caracteres y lo escribe mode 600 en `userDataDir(user)/sponsor-token-jobs/<user>.code` sólo si el job está vivo y en `awaiting-code` o `exchanging`; en otro caso responde `409`. |
| POST | `/api/sponsorship/token/cancel` | Escribe primero el marcador `.cancel`, envía SIGTERM al job vivo del principal, borra su `.code`, deja estado `error`/`cancelado` y devuelve `{ ok:true }`. El runner respeta el marcador: no persiste el token ni estados no terminales después de cancelar. |
| POST | `/api/sponsorship/admin/assign` | Un admin asigna `{ username, sponsor? }`; si omite `sponsor`, se usa su propio username cuando el principal lo tiene (el token maestro debe indicarlo). El sponsor designado debe tener listo su token propio, estar en estado `none` y ser distinto del target. |
| POST | `/api/sponsorship/admin/release` | Un admin suelta `{ username }` y deja al perfil en `awaiting-sponsor`, manteniendo el fail-closed del tier patrocinado. |
| GET | `/api/sponsorship/admin/overview` | Un admin obtiene `{ users: [{ username, tier, sponsorshipState, sponsor, canSponsor }] }`; `canSponsor` exige estado `none` y token propio listo. |

`mine` reutiliza la lectura cacheada del módulo `tokens` mediante
`withLocalUsage()`: conserva el TTL y la deduplicación de llamadas concurrentes.
La medición es resiliente por usuario; un fallo produce `todayUsd: null` sin
tumbar a los demás. El umbral usa `CWC_SPONSORED_USAGE_WARN_USD`, igual que el
chequeo de Salud, con default USD 10.

## Regla de autoridad

**Sólo se presta lo que es propio.** Un principal con
`sponsorshipState === 'none'` puede adoptar; un perfil patrocinado no puede
armar cadenas ni prestar la credencial de su sponsor. Adoptar tampoco roba un
perfil ya patrocinado: primero su sponsor actual debe liberarlo.

`release` deja al perfil en `awaiting-sponsor`, no en `none`, porque el admin ya
decidió que esa cuenta pertenece al tier patrocinado y todavía necesita quién
la pague. Volver a `none` revoca el patrocinio por completo y sigue siendo una
facultad administrativa mediante `{ sponsor: null }`.

En las rutas `/admin`, la autoridad que EJECUTA sí debe ser admin; el SPONSOR
DESIGNADO no. Su aptitud depende de que pueda prestar una credencial propia sin
armar una cadena, no de su rol administrativo. El invariante de Salud lo fija de
forma explícita: exigir que el sponsor sea admin sería una regresión. Por eso el
panel consume y filtra por `canSponsor`, nunca por `admin`.

## Archivos y estado

- `index.js`: registra los once handlers HTTP y delega las transiciones de
  patrocinio a
  `core/users.js`.
- `setUserSponsor()` y `setAwaitingSponsor()` persisten indirectamente en
  `users.json`; este módulo nunca lo toca directo.
- Los jobs usan `userDataDir(username)/sponsor-token-jobs/`, resuelto por
  operación con la misma fórmula que el runner; para el host coincide con
  `~/.cwc-data/sponsor-token-jobs/`. El server conserva fallback de LECTURA a
  la ruta global vieja para jobs en vuelo y envía código/cancelación al
  directorio donde encontró el job. `jobAlive()` verifica además
  `/proc/<pid>/cmdline` antes de considerar vivo o matar un proceso.

## Lo que más duele

- No agregues `requireAdmin` a las cuatro rutas self-service: impediría que cada sponsor decida desde su consola. Las tres rutas `/admin` sí deben conservar su gate `isAdmin`.
- `/candidates` devuelve únicamente `username`; agregar tier, rol o sponsor filtra datos de terceros a usuarios no-admin.
- Validar `awaiting-sponsor` antes de adoptar es el guard que impide robarle un patrocinado a otra persona.
- `/adopt` y `/candidates` exigen token propio listo: fallan cerradas y mantienen simetría con `/admin/assign` (decisión registrada en PLAN-3494).
- Las cuatro rutas `/token/*` toman SIEMPRE el username de `principalUsername(req,res)`, nunca de body ni query: aceptar un username externo permitiría generar o manipular el token de otro usuario.
- El job vive en `userDataDir(username)/sponsor-token-jobs/`, nunca en una constante global de módulo; el username se valida con `sanitizeUserId` y cada ruta con `path.relative` antes de usarla.
