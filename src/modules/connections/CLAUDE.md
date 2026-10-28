<!-- cwc:ficha-modulo -->
# src/modules/connections — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### connections/              CUENTAS CONECTADAS por usuario (PLAN-781): cada usuario conecta SUS
cuentas de terceros y la consola actúa con SU identidad. Ruta
/api/connections. Se ve en ⚙ Sistema → Conexiones, DENTRO del grupo
🏠 Mi Consola (frontend en system/mcps-panel.js, junto a los MCP).
TRES NIVELES de credencial: (a) APP de instancia (client_id/secret) que carga
UNA vez el admin → ~/.cwc-data/connections/_app.json; (b) APP POR USUARIO →
userDataDir(<user>)/connections/_app.json, que pisa ENTERA la de instancia para
ese proveedor cuando está completa; (c) CREDENCIAL por-usuario →
userDataDir(<user>)/connections/<provider>.json (perms 600, escritura atómica).
NUNCA se comparte un token ni una API key entre usuarios. Proveedores:
microsoft (`kind: 'oauth'`, device code flow, scopes offline_access User.Read
Calendars.ReadWrite), zoho (`kind: 'oauth'`, grant code de Self Client) y
freshservice (`kind: 'apikey'`, API key por agente con Basic auth `apiKey:X`).
`core/connections-store.js` expone `getAccessToken(username, provider)`, que
refresca y re-persiste solo y es la puerta ÚNICA al token OAuth, y
`getApiCredential(username, provider)`, puerta ÚNICA a `{ domain, apiKey }`
para credenciales estáticas. Los endpoints de estado nunca exponen la API key.
El scope Microsoft ahora cubre también SharePoint (Sites.ReadWrite.All,
delegado ⇒ la consola solo ve lo que el usuario ve). Para que una conexión
existente ADQUIERA un scope nuevo sigue haciendo falta reconectarla; su refresh
normal, en cambio, conserva los scopes con los que fue autorizada y no pide la
lista ampliada.
Endpoints: GET / (estado; hace auto-reparación de identidad si falta) ·
GET|POST /app (admin) · GET /app/mine · POST /app/mine ·
POST /app/mine/reset (los tres autenticados, per-usuario y NO admin-only) ·
POST /:p/connect · /:p/code · /:p/cancel ·
/:p/disconnect · GET /:p/status (flujo OAuth) · Freshservice suma
POST /freshservice/connect (verifica antes de persistir) ·
POST /freshservice/disconnect · GET /freshservice/status; los tres son
AUTENTICADOS, por-usuario y NO admin-only. Codex suma endpoints AUTENTICADOS,
por-usuario y NO admin-only: POST /codex/start · GET /codex/status ·
POST /codex/cancel; lanzan `bin/cwc-codex-login-runner.js`, que corre
`codex login --device-auth`. Device-auth es obligatorio en el server
remoto porque el login normal abre un callback en localhost:1455, que el
navegador remoto no puede devolverle al server. El estado de la credencial
se decide con `codexCredState` de `core/user-space.js`: presencia + vencimiento
a 10 días desde `last_refresh`, NO la mera existencia de `auth.json`.
GitHub replica ese contrato por-usuario con POST /github/start · GET
/github/status · POST /github/cancel y lanza desacoplado
`bin/cwc-gh-login-runner.js`. `ghJobPath`/`readGhJob`/
`ghLoginRunnerAlive` DUPLICAN A PROPÓSITO los helpers cortos de
`onboard/index.js`: Conexiones y onboarding deben seguir desacoplados para que
un refactor de uno no cambie el otro; solamente `hasGithubAuth` se comparte
desde `onboard/capabilities.js`. Pad local suma POST /pad/login/start · GET
/pad/login/status · POST /pad/login/cancel y lanza
`bin/cwc-pad-login-runner.js`; no recibe un código de vuelta porque su login
browser-based sólo expone URL y verificación automática.
Tolkien suma cinco endpoints por-usuario: POST /tolkien/login/start · GET
/tolkien/login/status · POST /tolkien/login/cancel · GET /tolkien/status ·
POST /tolkien/disconnect. NO entra en `PROVIDERS` ni en
`core/connections-store.js` porque su cookie requiere un storage dedicado (a
diferencia de la credencial estática soportada para Freshservice): usa la cookie httpOnly de
sesión de next-auth v5 `__Secure-tolkien.session`. Como el token es un JWE
cifrado y NO se puede decodificar, el email y el vencimiento salen de
`GET https://app.tolkien.mordorstaffing.com/api/auth/session` de Auth.js. La
cookie viaja al runner por stdin —nunca argv ni archivo intermedio— y sólo se
persiste dentro del storageState privado
`userDataDir(<user>)/tolkien/session.json`, el mismo que consume
`bin/cwc-tolkien.js`; `connections/tolkien.json` guarda metadata sin secreto.
Claude suma endpoints AUTENTICADOS y estrictamente por-usuario:
POST /claude/login/start · GET /claude/login/status ·
POST /claude/login/code · POST /claude/login/cancel · GET /claude/status.
Lanzan desacoplado `bin/cwc-claude-login-runner.js`, cuyo estado vive en
`~/.cwc-data/claude-login-jobs/<user>.json`; status solo expone
status/url/error y `/claude/status` solo informa si la fuente es
`credentials`, `setup-token` o null, nunca el token.
`POST /claude/login/start` también acepta al HOST (`console:PLAN-2446`): es
seguro porque el runner resguarda su `.credentials.json` antes de lanzar el
login y la restaura ante cualquier salida fallida o cancelada. Ninguna ruta
de credenciales de desarrollo —Claude, Codex, GitHub, Infisical, Pad o
Tolkien— acepta un usuario por query/body/header ni permite que un admin opere
el job ajeno.
Los jobs de login son estado efímero en dirs globales porque los cinco runners vivos esperan esas rutas: se aíslan como `<user>.json`, con username validado y directorio 0700.
La config OAuth rechaza campos mal formados con 400; cada grant code se reclama una sola vez.
Freshservice distingue credenciales inválidas (400) de fallos de red o upstream (502).
OPERACIÓN ADMINISTRATIVA SOBRE PROVEEDORES EXTERNOS: `targetUserOf(req)` hace
que el estado general, las rutas OAuth de Microsoft/Zoho y las rutas de
Freshservice acepten `user` (`query` en GET, `body` en POST). Sin el parámetro
operan sobre el principal igual que antes. Apuntar a OTRO usuario exige
`isAdmin(req)` y un destino presente en `listUsers()`; un destino inexistente
responde 404. Esta capacidad queda deliberadamente fuera de las credenciales
de desarrollo enumeradas arriba: ser admin no habilita tomar control de sus
jobs ni sesiones personales.
GOTCHAS DUROS (todos verificados en vivo, cuestan caro re-descubrirlos):
(1) ZOHO NO usa el scope `offline_access` — el refresh token se obtiene
pasando `access_type=offline` en el intercambio; sin eso Zoho devuelve
solo access token y se QUEMA el grant code (es de un solo uso y vive
~3 min). (2) La API de Desk exige el header `orgId` en TODA llamada; se
descubre con getOrg() al conectar y se PERSISTE. (3) `GET /agents/me` NO
EXISTE en Desk (404); la identidad se resuelve listando agentes y
matcheando por email — igual que seguimientos/desk-source.js — y de paso
se guarda el agentId. (4) MICROSOFT: el device code exige "Allow public
client flows" = Yes en la app de Entra, y si el tenant deshabilita el
consentimiento de usuario hace falta aprobación del admin (una vez).
(5) BUG-929 / regla dura 2: el device flow persiste `deviceCode`+`interval`
en el job y `GET /:provider/status` lo REANUDA perezosamente tras reinicios
cuando el registro en memoria `activePolls` no tiene un poller vivo.
(6) ORDEN DE RUTAS ESPECÍFICAS: `/codex/*`, `/github/*`, `/pad/login/*` y
`/tolkien/*`
DEBEN registrarse ANTES de `'/:provider/...'`; si no, por ejemplo
`/codex/status` matchea
`'/:provider/status'` con `provider='codex'` y devuelve 400
`"Proveedor desconocido"`.
(7) ORDEN DE RUTAS CLAUDE: `/claude/login/*` y `/claude/status` también
DEBEN registrarse ANTES de `'/:provider/...'` por el mismo motivo.
(8) CREDENCIAL VENCIDA ≠ AUSENTE: `hasCodexCreds` sólo mira si el archivo
está. `/codex/start` y `/codex/status` usan `codexCredState`, porque con el
access token vencido (10 días desde `last_refresh`) el archivo sigue ahí y el
chequeo por presencia devolvía `already/connected:true` sin relanzar el login
(bug real de un inquilino, ago-2026). El Llavero
(`modules/mcps/keyring-shared.js`) ya usaba el criterio de vencimiento: ahora
comparten la constante `CODEX_TOKEN_TTL_MS`.
(9) ZOHO SELF CLIENT ES PERSONAL: el grant code sólo lo puede generar quien es
dueño de la app en el API Console, así que la app de instancia NO sirve para un
inquilino (Zoho responde `invalid_code`). Por eso existe el override por
usuario, que es TODO O NADA por proveedor: mezclar el clientId de un usuario
con el secret de instancia daría `invalid_client`. La conexión guarda
`appClientId` porque el refresh token sólo vale para el client_id que lo emitió.
(10) MICROSOFT REFRESCA CON EL CONSENTIMIENTO GUARDADO: al conectar se persiste
`scopes` en la conexión y `getAccessToken()` pasa ESA lista a
`refreshAccessToken`; una conexión vieja con scopes viejos refresca con los
suyos y una nueva nace con el `MS_SCOPES` ampliado. Esto evita que ampliar la
constante rompa todas las conexiones existentes con `AADSTS65001`; reconectar
sigue siendo necesario para OBTENER el permiso nuevo, no para conservar los ya
concedidos. Salvedad legacy: si el registro no tiene `scopes` o la lista está
vacía, `connections-microsoft.js` todavía cae a `MS_SCOPES`; no describas ese
fallback como si los scopes persistidos fueran obligatorios en datos antiguos.
