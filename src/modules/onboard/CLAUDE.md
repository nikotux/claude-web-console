<!-- cwc:ficha-modulo -->
# src/modules/onboard — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

### onboard/                   onboarding self-service por token de invitación
(SP7 del multi-tenant; referencias de plan `PLAN-500`/`PLAN-593`). Este
módulo es la puerta de alta de inquilinos: un admin ya autenticado emite una
invitación, el usuario nuevo entra por `/onboard`, se auto-registra con ese
token y después configura su propia credencial Claude con `claude setup-token`
corriendo en SU HOME aislado. Después ofrece, como pasos opcionales, conectar la
cuenta Claude completa para medir el consumo real del plan, Codex e Infisical,
y cierra el wizard consumiendo la invitación. Si vuelve con el mismo token
consumido, puede completar los pasos pendientes sin volver a registrar. La
implementación vive en
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
(`RL_WINDOW_MS = 60 * 1000`) y dos topes con contadores separados: las acciones
tienen máximo 30 requests por ventana (`RL_MAX = 30`) y los endpoints
`*-status`, que el wizard pollea, admiten 240 (`RL_STATUS_MAX = 240`).
`creds-status` solo ya genera 40 requests/min; con un único tope de 30/min el
wizard se auto-bloqueaba en su paso más largo. La separación evita además que
el polling consuma el presupuesto de las acciones. Si se supera el tope del
bucket correspondiente devuelve 429 con "Demasiados intentos, esperá un
minuto.". El GC del `Map` es oportunista: solo cuando `rlMap.size > 5000`, itera
y borra entradas cuyo `resetAt` ya pasó. NO es persistente, no comparte estado
entre procesos y se resetea al reiniciar el server.

Endpoints públicos reales:
`POST /api/onboard/public/validate` llama `validateInvite(req.body?.token)` y
devuelve `{valid, admin, reason, status, lockedTo, hasToken,
hasClaudeAccount, hasCodex, hasInfisical, hasTolkienMcp, pending, resume}`.
`valid` conserva EXACTAMENTE la semántica
estricta de `validateInvite`: una invitación consumida sigue devolviendo
`valid:false` con razón `ya usado`. Solo en ese caso el endpoint cae a
`peekInvite(token)` para recuperar `status` y `lockedTo`; si ese usuario existe
y la invitación no está revocada, `resume:true` habilita exclusivamente la
reentrada al checklist. Los cinco `has*` son booleanos, nunca secretos, y
`pending` filtra en orden `['claude','account','codex','infisical']` los que
falten.
Cuando no hay `lockedTo`, `pending:[]` y `resume:false`. Esta separación es el
blindaje central: `/register` NO usa `resume` ni `peekInvite`, sigue exigiendo
`validateInvite`, por lo que un token consumido jamás puede crear otro usuario.
En error interno responde 500.

`POST /api/onboard/public/register` recibe `{token, username, password, lang?}`;
`lang` acepta `es` o `en` y se persiste best-effort con `setUserLang`.
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

`POST /api/onboard/public/creds-start` recibe `{token}`. Resuelve el usuario con
`stepUser`: acepta la invitación locked del alta en curso o una consumida cuyo
usuario todavía existe; si no hay usuario responde 409 "Registrate primero.".
Usa el `pid` persistido en
`~/.cwc-data/onboard-jobs/<user>.json` y `/proc/<pid>/cmdline` para deduplicar
contra el runner REAL, no contra la mera antigüedad del archivo: preserva
indefinidamente un `awaiting-code` vivo y protege `starting`/`exchanging` solo
durante su primer minuto. Un job huérfano no bloquea el reintento; si hay un
runner vivo fuera de esa protección, le manda SIGTERM antes de relanzar.
Después escribe sincrónicamente un estado `starting` mode 600 ANTES de spawnear
`bin/cwc-onboard-runner.js --user <user> --token <token>` detached.

`GET /api/onboard/public/creds-status?token=...` usa `peekInvite(token)`, no
`validateInvite`. Eso es deliberado: `peekInvite` es leniente y puede resolver
metadata aunque la invitación ya esté consumida/expirada, para que el wizard
pueda mostrar `done`. Lee el job de `lockedTo` o reporta `idle`, marca `stale`
si `starting`/`exchanging` tiene más de 30 s, y calcula `hasToken` con
`readUserOauthToken(lockedTo)`. NO expone secretos: devuelve estado, URL OAuth,
`note` diagnóstico, done/error/stale y booleano `hasToken`; el `pid` queda
exclusivamente del lado servidor.

`POST /api/onboard/public/creds-code` recibe `{token, code}`. Valida token,
exige token locked a un usuario, trimmea el código y acepta solo valores no
vacíos de hasta 4000 chars. Escribe `~/.cwc-data/onboard-jobs/<user>.code` mode
600 para que el runner PTY lo lea e inyecte por stdin.

El paso `account`, ubicado después de `creds` y antes de `codex`, es opcional.
Existe porque la credencial de `claude setup-token` permite correr modelos pero
no trae scopes de cuenta: se comprobó que
`GET api.anthropic.com/api/oauth/profile` responde `403 OAuth token does not
meet scope requirement any_of(user:profile, user:office)` y que el medidor de
uso responde 429. El login completo agrega `user:profile`; con esa credencial
el medidor respondió 200 y puede mostrar los porcentajes reales de la sesión de
5 horas y de la semana.

Sus tres endpoints públicos son:

- `POST /api/onboard/public/claude-account-start`, body `{token}`.
- `GET /api/onboard/public/claude-account-status?token=...`.
- `POST /api/onboard/public/claude-account-code`, body `{token, code}`.

Los tres resuelven el usuario exclusivamente mediante `stepUser(token)`: nunca
aceptan un `user` por body o query. Reutilizan
`bin/cwc-claude-login-runner.js` y
`~/.cwc-data/claude-login-jobs/<user>.{json,code,log}`, los mismos que
`connections`, para que un flujo iniciado en onboarding pueda retomarse desde
⚙ Sistema → Uso y viceversa. El runner ejecuta
`claude auth login --claudeai` con HOME aislado y sin
`CLAUDE_CODE_OAUTH_TOKEN`, publica la URL, recibe el código por el buzón `.code`
y deja `<userSpace>/.claude/.credentials.json`.

`claude-account-status` expone únicamente `{status, url?, error?}`: nunca pid,
rutas ni logs. `claude-account-code` exige un runner vivo en `waiting-code` y
aplica la misma validación que `connections`: string, `trim()`, no vacío, hasta
512 caracteres y sin `\r`/`\n` internos después del trim. Al terminar en
`-status`, el polling usa el bucket amplio del rate-limit público.

`POST /api/onboard/public/codex-start` recibe `{token}` y usa el mismo
`stepUser`, incluida la reentrada segura con token consumido. El paso usa
`bin/cwc-codex-login-runner.js` con
device-auth (el callback localhost del login normal no sirve en el server);
deduplica y persiste el job en
`~/.cwc-data/codex-login-jobs/<user>.json`. `GET
/api/onboard/public/codex-status?token=...` usa `peekInvite`, lee ese job y
devuelve URL, código y estado sin exponer credenciales.

`POST /api/onboard/public/infisical-start` recibe `{token}`, resuelve el usuario
con `stepUser`, deduplica un job fresco y escribe sincrónicamente `starting`
mode 600 antes de lanzar detached
`bin/cwc-infisical-login-runner.js --id <user> --user <user> --domain
https://app.infisical.com`. Los jobs viven siempre en el HOME del host:
`~/.cwc-data/infisical-login/<user>.json`.

`GET /api/onboard/public/infisical-status?token=...` usa `peekInvite` y devuelve
únicamente `{status, url, error, stale, hasInfisical}`; el último booleano sale
de `hasInfisicalCreds(user)`. El endpoint termina en `-status`, así entra
automáticamente al bucket amplio de polling. Nunca devuelve el token pegado ni
otros campos del job.

`POST /api/onboard/public/infisical-token` recibe `{token, value}`, habilita
locked o reentrada consumida con `stepUser`, y acepta solo un valor trimmeado no
vacío de hasta 4000 caracteres. Lo deposita mode 600 en
`~/.cwc-data/infisical-login/<user>.token`; el runner lo escribe al PTY y borra
el archivo inmediatamente. El valor no entra al JSON del job, logs ni
respuestas HTTP.

`POST /api/onboard/public/finish` recibe `{token}`, valida que siga locked a un
usuario y llama `consumeInvite(token)`. Es el cierre explícito del wizard; si el
consumo devuelve false responde `{ok:true, already:true}` para tolerar
reintentos, y en el caso normal responde `{ok:true}`.

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
Después de un clon exitoso, `tolkien-mcp-shared.js` registra idempotentemente el
MCP HTTP `tolkien-mordor`; `/public/finish` lo reintenta best-effort.

Para credenciales Claude, `creds-start` spawnea el runner PTY. El runner llama
`ensureUserSpace(USER)`, arma `userRunnerEnv(USER)` con HOME/CWC_DATA_DIR del
inquilino, borra `CLAUDE_CODE_OAUTH_TOKEN` para forzar login fresco y corre
`claude setup-token` en `userWorkspace(USER)`. Cuando detecta la URL OAuth
actualiza el job a `awaiting-code`; cuando `creds-code` deja el archivo `.code`,
lo escribe al PTY y pasa a `exchanging`, sin dejar de vigilar nuevos códigos.
Si en 20 s no aparece el token, vuelve a `awaiting-code` con un `note` formado
por las últimas tres líneas útiles del PTY para que el usuario pueda corregir y
reintentar dentro del mismo proceso. Cada estado lleva el `pid` del runner;
SIGTERM/SIGINT dejan `error:cancelado`, matan ordenadamente el PTY y salen. Toda
la salida limpia de ANSI, los cambios de estado y el exit code se anexan en
`~/.cwc-data/onboard-jobs/<user>.log` mode 600; TODA escritura pasa por la
redacción obligatoria de cualquier `sk-ant-*`, por lo que el token jamás puede
quedar en el log ni en el `note`. Si `setup-token` emite un token `sk-ant-*`, lo
guarda en `userOauthTokenPath(USER)` mode 600
(`~/.cwc-users/<user>/.claude/oauth-token` para inquilinos) y deja el job
`done`, sin consumir la invitación. El server solo usa `readUserOauthToken` en
`creds-status` para publicar `hasToken`; el secreto no viaja al cliente.

Después del setup-token, el wizard ofrece la cuenta Claude completa, Codex e
Infisical. La primera corre `claude auth login --claudeai` mediante el mismo
runner/job compartido con `connections`; es saltable porque solo habilita los
porcentajes del plan y no condiciona la ejecución de modelos. `codex-start`
lanza `bin/cwc-codex-login-runner.js`, que usa device-auth y persiste el job en
`~/.cwc-data/codex-login-jobs/<user>.json`. `infisical-start` lanza su runner
con HOME/cwd aislados para que el CLI escriba
`~/.cwc-users/<user>/.infisical/infisical-config.json`; Infisical NO provee
`TOLKIEN_MCP_TOKEN`. El host funciona porque tiene un `tolkien-mordor` stdio de
scope local en su `~/.claude.json`, bajo `infisical run`, que pisa el `.mcp.json`.
El inquilino usa el MCP hosteado por HTTP: `tolkien-mcp-shared.js` acuña un token
per-dev con la credencial admin del host, lo guarda mode 600 en SU `.claude/` y
registra el override local en SU `.claude.json`. El flujo es idempotente: si la
entrada ya existe no acuña otro token. Un runner vivo no toma el MCP nuevo hasta
reabrirse. Al entrar al checklist final, el front llama best-effort a
`POST /public/finish`, que dispara otro intento de provisioning y consume la
invitación. Así queda `locked` durante registro, Claude, Codex e Infisical,
alineado con la decisión de `PLAN-500`.

Contrato de alta: todo usuario nuevo nace con `setup-token` obligatorio para
ejecutar Claude, más cuenta Claude completa opcional para los porcentajes de
consumo, Codex opcional e Infisical opcional. La secuencia visible es
`token → register → creds → account → codex → infisical → done`.

### Gotchas reales
TTL default duplicado deliberadamente: `index.js` usa `DEFAULT_TTL_H = 24` para
la API admin y `core/onboard-tokens.js` tiene `DEFAULT_TTL_MS = 24 h` si alguien
llama `generateInvite` sin TTL. Si cambiás el default, revisá ambos puntos.

Todo endpoint de polling nuevo que se agregue al `publicRouter` tiene que entrar
en el bucket de estado (`*-status`); de lo contrario volverá a consumir el
presupuesto de acciones y repetirá el auto-bloqueo del wizard.

El wizard es REANUDABLE por token: con una invitación `locked`, el front salta
el registro y retoma según `pending`; con una `consumed`, `/validate` sigue
devolviendo `valid:false` pero agrega `resume:true` si `lockedTo` existe como
usuario real. `stepUser` acepta ese caso solo para ejecutar pasos ya asociados
a ESE usuario y rechaza revocadas. Es seguro porque `/register` conserva su
camino estricto e independiente por `validateInvite(token, { forUsername })`:
un token consumido nunca vuelve a reservar una invitación ni a crear una
cuenta. El estado del wizard NO se persiste en el navegador: la fuente de
verdad es la invitación, las credenciales detectadas y los jobs persistidos.
El paso `account` no reemplaza `creds`: resuelve otro contrato de autorización.
No uses la existencia de `oauth-token` como señal de scopes de cuenta; la señal
es `claudeAiOauth.accessToken` dentro de
`<userSpace>/.claude/.credentials.json`.

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

`creds-start` deduplica por proceso real: un job persistido cuyo runner murió se
puede relanzar desde la UI aunque todavía parezca fresco. El runner conserva el
timeout duro de 10 min y solo guarda el OAuth token y marca `done`: no consume
la invitación. El ciclo de vida es `locked` durante TODO el wizard (registro →
Claude setup-token → cuenta Claude → Codex → Infisical → cierre) y pasa a
`consumed` recién en
`POST /public/finish`; si el usuario abandona antes, queda locked a SU username
hasta morir por TTL. Tras el consumo, los status siguen consultables por
`peekInvite` y los starts de pasos pendientes pueden reingresar por `stepUser`.

El `<user>.log` del runner es la ÚNICA forma de diagnosticar por qué falló un
canje de código en vivo: el host tiene `ptrace_scope=1`, así que no se puede
adjuntar `strace` al proceso ya lanzado. Nunca saltees su redacción centralizada
ni escribas salida del PTY por otro camino, porque podría contener el
`sk-ant-*`.

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
