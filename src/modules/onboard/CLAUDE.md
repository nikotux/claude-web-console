<!-- cwc:ficha-modulo -->
# src/modules/onboard — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

### onboard/                   onboarding self-service por token de invitación
(SP7 del multi-tenant; referencias de plan `PLAN-500`/`PLAN-593`). Este
módulo es la puerta de alta de inquilinos: un admin ya autenticado emite una
invitación, el usuario nuevo entra por `/onboard`, se auto-registra con ese
token y después configura su propia credencial Claude con `claude setup-token`
corriendo en SU HOME aislado. La implementación vive en
`src/modules/onboard/index.js`; la persistencia/estado de invitaciones está en
`src/core/onboard-tokens.js`; el paso PTY de credenciales está delegado a
`bin/cwc-onboard-runner.js`.

### ⚠️ Lo más importante — superficie PÚBLICA
`publicRouter` en `src/modules/onboard/index.js` se monta desde
`src/server.js` como `/api/onboard/public` ANTES del gate general de auth. ESTO
NO USA LOGIN: el gate real es el token de invitación, más un rate-limit simple
por IP. Cualquier endpoint nuevo agregado a `publicRouter` queda expuesto sin
autenticación de sesión; por lo tanto, la validación del token y el rate-limit
son la única barrera server-side.

Rate-limit público: `rateLimit` usa un `Map` en memoria (`rlMap`) por IP
(`req.ip || req.socket.remoteAddress || 'unknown'`), ventana de 60 s
(`RL_WINDOW_MS = 60 * 1000`) y máximo 30 requests por ventana (`RL_MAX = 30`).
Si se supera devuelve 429 con "Demasiados intentos, esperá un minuto.". El GC
del `Map` es oportunista: solo cuando `rlMap.size > 5000`, itera y borra
entradas cuyo `resetAt` ya pasó. NO es persistente, no comparte estado entre
procesos y se resetea al reiniciar el server.

Endpoints públicos reales:
`POST /api/onboard/public/validate` llama `validateInvite(req.body?.token)` y
devuelve `{valid, admin, reason}`. No exige usuario; rechaza tokens ausentes,
inexistentes, consumidos, revocados o expirados según
`core/onboard-tokens.js:validateInvite`. En error interno responde 500.

`POST /api/onboard/public/register` recibe `{token, username, password}`.
Primero valida el token con `validateInvite(token, { forUsername: username })`;
si el token está locked a otro usuario, queda inválido para este intento. Luego
valida el username con `isValidUsername` (letras, números, `.`, `_`, `-`, máx.
32). Después reserva el token con `lockInvite(token, username)` ANTES de llamar
`createUser(username, password, !!v.admin)`: ese lock evita que dos requests
concurrentes del mismo token puedan crear dos usuarios distintos. El bit admin
del usuario sale SOLO del token. Tras crear el usuario, hace
`ensureUserSpace(username)` best-effort y dispara sin await
`provisionUserPad(username, { name: username })` y
`provisionUserWorkspace(username)`. La respuesta OK es `{ok:true, username}`.

`POST /api/onboard/public/creds-start` recibe `{token}`. Valida con
`validateInvite(token)` y exige `status === 'locked'` con `lockedTo`, o responde
409 "Registrate primero.". Usa `~/.cwc-data/onboard-jobs/<user>.json` para
deduplicar: si hay un job fresco (`starting`, `awaiting-code` o `exchanging`) de
menos de 10 min, responde `{ok:true, already:true}`. Si no, escribe
sincrónicamente un estado `starting` mode 600 ANTES de spawnear
`bin/cwc-onboard-runner.js --user <user> --token <token>` detached.

`GET /api/onboard/public/creds-status?token=...` usa `peekInvite(token)`, no
`validateInvite`. Eso es deliberado: `peekInvite` es leniente y puede resolver
metadata aunque la invitación ya esté consumida/expirada, para que el wizard
pueda mostrar `done`. Lee el job de `lockedTo` o reporta `idle`, marca `stale`
si `starting`/`exchanging` tiene más de 30 s, y calcula `hasToken` con
`readUserOauthToken(lockedTo)`. NO expone secretos: devuelve estado, URL OAuth,
done/error/stale y booleano `hasToken`.

`POST /api/onboard/public/creds-code` recibe `{token, code}`. Valida token,
exige token locked a un usuario, trimmea el código y acepta solo valores no
vacíos de hasta 4000 chars. Escribe `~/.cwc-data/onboard-jobs/<user>.code` mode
600 para que el runner PTY lo lea e inyecte por stdin.

### Superficie ADMIN
La superficie admin vive en el `apiRouter` post-auth por
`registerHttp(router)`, bajo `/api/onboard`, y además cada handler chequea
`isAdmin(req)` explícitamente. `POST /api/onboard/admin/invite` genera una
invitación con `generateInvite({ admin, createdBy, ttlMs })`; `admin` debe ser
boolean si viene en el body, `ttlHours` positivo define TTL y si falta usa
`DEFAULT_TTL_H = 24`. La respuesta incluye el token CRUDO una sola vez:
`{id, token, admin, expiresAt}`.

`GET /api/onboard/admin/invites` lista metadata con `listInvites()`: nunca
expone token ni `tokenHash`. `POST /api/onboard/admin/invite/:id/revoke` llama
`revokeInvite(id)` y devuelve `{ok}`; no revoca invitaciones ya consumidas.

### Flujo completo
El admin autenticado y admin emite el token desde
`index.js:registerHttp` -> `generateInvite`. El store persiste en
`~/.cwc-data/onboard-tokens.json`, guarda solo `sha256(token)` y conserva el
token crudo únicamente en la respuesta de creación. El usuario nuevo entra al
wizard público y el front puede llamar `validateInvite` para saber si el token
sirve y si creará admin.

En el registro, `validateInvite(..., { forUsername })` comprueba existencia,
estado y expiración; `lockInvite(token, username)` ata la invitación a ese
username y la deja en `status:'locked'` SIN consumirla. El lock existe para
cerrar la carrera del auto-registro: el token ya no puede ser usado por otro
username mientras todavía falta el paso largo de credenciales. Con el token
lockeado, `createUser` crea el usuario local con password y rol admin si el
token lo marcaba. Después `ensureUserSpace` crea idempotentemente
`~/.cwc-users/<user>/`, `.cwc-data`, `workspace`, `workspace/mi-espacio`,
`.claude` y `.pad` (el host mapea a su HOME real por retrocompat).

El provisioning posterior NO bloquea el registro. `provisionUserPad` registra o
reloguea la cuenta Pad del inquilino, crea su workspace `tenant-<user>` y clona
las colecciones esperadas desde `console`; devuelve `{ok:false,error}` ante
problemas y el módulo solo loguea. `provisionUserWorkspace` clona el repo local
de trabajo en el workspace del inquilino, default shallow
`--depth 1 --single-branch --branch main`, saltea al host y no re-clona si el
destino ya tiene `.git`; también resuelve siempre y el módulo solo loguea.

Para credenciales Claude, `creds-start` spawnea el runner PTY. El runner llama
`ensureUserSpace(USER)`, arma `userRunnerEnv(USER)` con HOME/CWC_DATA_DIR del
inquilino, borra `CLAUDE_CODE_OAUTH_TOKEN` para forzar login fresco y corre
`claude setup-token` en `userWorkspace(USER)`. Cuando detecta la URL OAuth
actualiza el job a `awaiting-code`; cuando `creds-code` deja el archivo `.code`,
lo escribe al PTY y pasa a `exchanging`. Si `setup-token` emite un token
`sk-ant-*`, lo guarda en `userOauthTokenPath(USER)` mode 600
(`~/.cwc-users/<user>/.claude/oauth-token` para inquilinos), consume la
invitación con `consumeInvite(INVITE)` y deja el job `done`. El server solo usa
`readUserOauthToken` en `creds-status` para publicar `hasToken`; el secreto no
viaja al cliente.

### Gotchas reales
TTL default duplicado deliberadamente: `index.js` usa `DEFAULT_TTL_H = 24` para
la API admin y `core/onboard-tokens.js` tiene `DEFAULT_TTL_MS = 24 h` si alguien
llama `generateInvite` sin TTL. Si cambiás el default, revisá ambos puntos.

El store de invitaciones no cachea en memoria: `validateInvite`, `peekInvite`,
`lockInvite`, `revokeInvite` y `listInvites` leen el JSON desde disco en cada
llamada, y las escrituras pasan por `writeJsonAtomic`. Eso permite ver cambios
de disco en caliente, pero NO hay lock inter-proceso; el cierre de carrera de
`lockInvite` es fuerte para el proceso Node actual por operaciones síncronas,
no para dos servidores escribiendo el mismo archivo a la vez.

Si `createUser` falla DESPUÉS de `lockInvite`, la invitación queda locked a ese
username. Es intencionalmente reintentable con el MISMO username
(`lockInvite` es idempotente para el mismo `lockedTo`), pero no se puede cambiar
de username salvo revocar/expirar/generar otra invitación. Si `createUser`
alcanza a crear el usuario y luego falla `ensureUserSpace` o el provisioning, no
hay rollback: el registro ya respondió desde el estado local posible y los pasos
de Pad/workspace son best-effort.

`creds-start` deduplica por archivo de job fresco, no por proceso real. Si el
server reinicia, el job persiste; si el hijo murió sin poder actualizar estado,
`creds-status` puede marcar `stale`. El runner tiene timeout de 10 min y solo
consume la invitación al guardar el OAuth token correctamente. Una invitación
consumida ya no sirve para `creds-start`/`creds-code`, pero `creds-status` sigue
consultable por `peekInvite` para mostrar finalización.

`readUserOauthToken` devuelve null ante ausencia o error y nunca lanza. Eso es
parte del blindaje: el UI puede mostrar `hasToken:false`, pero los runners de
chat son quienes deben fallar cerrado si un inquilino intenta arrancar sin
credencial propia.

### Relación con reglas duras
Este módulo es una pieza de la regla anti-consumo del multi-tenant: un
inquilino NO debe consumir la credencial del host. Por eso el onboarding crea
space privado, corre `claude setup-token` con HOME del usuario y guarda el OAuth
en `userOauthTokenPath(user)`. Si no existe token propio, el resto del sistema
debe negarse a arrancar el runner del inquilino en vez de heredar credenciales
globales.

También sostiene el no-cruce por usuario: username saneado, `ensureUserSpace`,
`userWorkspace`, Pad `tenant-<user>`, job files por usuario y OAuth token por
usuario. Cualquier cambio acá tiene que preservar que los secretos, workspace,
Pad y estado de onboarding de un usuario no puedan leerse ni reutilizarse desde
otro.
