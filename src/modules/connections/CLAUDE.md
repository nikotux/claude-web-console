<!-- cwc:ficha-modulo -->
# src/modules/connections — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### connections/              CUENTAS CONECTADAS por usuario (PLAN-781): cada usuario conecta SUS
cuentas de terceros y la consola actúa con SU identidad. Ruta
/api/connections. Se ve en ⚙ Sistema → Conexiones, DENTRO del grupo
🏠 Mi Consola (frontend en system/mcps-panel.js, junto a los MCP).
DOS NIVELES de credencial (así funciona OAuth): (a) APP de instancia
(client_id/secret) que carga UNA vez el admin → ~/.cwc-data/connections/
_app.json; (b) TOKEN por-usuario → userDataDir(<user>)/connections/
<provider>.json (perms 600, escritura atómica). NUNCA se comparte un
token entre usuarios. Proveedores: microsoft (device code flow, scopes
offline_access User.Read Calendars.ReadWrite) y zoho (grant code de
Self Client). core/connections-store.js expone getAccessToken(username,
provider) que refresca y re-persiste solo — es la puerta ÚNICA al token.
El scope Microsoft ahora cubre también SharePoint (Sites.ReadWrite.All,
delegado ⇒ la consola solo ve lo que el usuario ve); agregar un scope
nuevo SIEMPRE obliga a reconectar la cuenta.
Endpoints: GET / (estado; hace auto-reparación de identidad si falta) ·
GET|POST /app (admin) · POST /:p/connect · /:p/code · /:p/cancel ·
/:p/disconnect · GET /:p/status. Codex suma endpoints AUTENTICADOS,
por-usuario y NO admin-only: POST /codex/start · GET /codex/status ·
POST /codex/cancel; lanzan `bin/cwc-codex-login-runner.js`, que corre
`codex login --device-auth`. Device-auth es obligatorio en el server
remoto porque el login normal abre un callback en localhost:1455, que el
navegador remoto no puede devolverle al server.
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
(6) ORDEN DE RUTAS CODEX: `/codex/start|status|cancel` DEBEN registrarse
ANTES de `'/:provider/...'`; si no, `/codex/status` matchea
`'/:provider/status'` con `provider='codex'` y devuelve 400
`"Proveedor desconocido"`.
