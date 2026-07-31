<!-- cwc:ficha-modulo -->
# src/modules/mcps — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### mcps/                     CENSO + ESTADO EN VIVO de los servidores MCP de Claude Code (pestaña
"Conexiones" del grupo ⚙️ Configuración del menú Sistema). Hermano de
`skills` pero ACCIONABLE: muestra semáforo de conexión y permite
(re)conectar DESDE LA VENTANA. RESILIENCIA POR ITEM (2026-07-22,
BUG-910 reportado por Niko): con el MCP de Tolkien caído (Infisical sin
login), el menú se bloqueaba ENTERO y no se podía ni aplicar el arreglo.
Causa raíz: `buildCensus()` recorría mundos con `for … await` (SERIAL),
`claude mcp list` health-chequeaba TODOS los servers de un mundo en un
solo comando con timeout de 30 s, la caché era solo memoria (restart =
panel vacío) y el front reemplazaba todo por spinner esperando el fetch
entero. Rediseño: el censo se DESCUBRE desde config
(`<scope.home>/.claude.json` local+user + `.mcp.json` de los proyectos
propios): instantáneo, 0 subprocess; la salud
se chequea POR ITEM con `claude mcp get <name>` (un solo server, ~3 s),
en pool acotado (`core/pool.js`, max 4) y timeout propio de 15 s.
Estado persistido POR ITEM en `<scope.dataDir>/mcps-census.json` (atómico;
para el host conserva exactamente `~/.cwc-data/mcps-census.json`)
con `checkedAt`/`stale`; el GET responde YA con el último dato conocido
y dispara chequeos en segundo plano (fire-and-forget: idempotentes y
re-disparados en el próximo poll, por eso NO necesitan runner
desacoplado). `POST /mcps/check {world,name}` re-verifica UNO. Estado
propio `timeout` (⏱️ "no respondió en 15s") distinto de `error`.
El front pinta primero y actualiza EN EL LUGAR por `data-key`
(`applyStates`), con poll de 2 s SOLO mientras haya items en `checking`;
un re-render completo destruiría el colapsado que abrió el usuario.
Medido: censo 26 ms (antes hasta 60 s) y, con un server colgado a
propósito, su tarjeta quedó aislada mientras las otras 7 seguían
operables. `claude mcp list` SALIÓ del camino crítico del panel (sigue
usándose SOLO dentro de `bin/cwc-mcp-login-runner.js` para verificar una
reconexión). El conflicto de scopes ya no se lee de su salida: se detecta
comparando config (mismo nombre en >1 scope con endpoints distintos) y se
muestra con detalle real + comandos `claude mcp remove … -s <scope>`
copiables; la consola NUNCA decide cuál borrar.
EL LLAVERO (`keyring-shared.js` + `infisical-shared.js`, 2026-07-22;
aislamiento multiusuario 2026-07-27, `PLAN-2117`):
el panel mostraba las PUERTAS (MCP) pero nunca el LLAVERO. Infisical no
es MCP ni cuenta: es la llave de la que cuelga `tolkien-mordor` (scope
local, arranca con `infisical run …`). Y no era la excepción: hay una
llave detrás de casi todo. `GET /mcps/keyring` (autenticados, 0 tokens IA,
caché CLAVEADA POR USUARIO + `?fresh=1` + snapshot
`<scope.dataDir>/keyring.json` con degradación `stale`) devuelve para el host
las 11 tarjetas históricas en 3 familias: 🧠 Motores
(Claude OAuth vía `expiresAt` · Codex CLI vía `last_refresh`, vencimiento
ESTIMADO a 10 días) · 🔑 Llaves (Infisical · `gh auth status` · Pad local
token+HTTP · Pad cloud `mcpOAuth.expiresAt`) · 🔌 Servicios (WhatsApp por
heartbeat · systemd · ZeroTier por interfaz `zt*`, no `zerotier-cli` que
pide root). Un inquilino recibe solo sus seis sondas de credenciales; WhatsApp,
systemd y ZeroTier son estado de la instalación y no entran en su llavero.
Cada item lleva `dependents` (qué se rompe si cae; los de
Infisical se DERIVAN de los MCP cuyo `command === 'infisical'`, no
hardcodeados) y `action`. En particular, `reconnectActionFor()` entrega para
`claude-oauth` `kind:'claude-login'` y `command:null`: ese kind significa que
la consola debe abrir el login OAuth guiado y lo consume el dispatcher
`reconnect-keyring` de `public/js/modules/system/mcps-panel.js`. La misma capa
declara `codex-cli` como `kind:'codex-login'`, `github-cli` como
`kind:'github-login'` y `pad-local` como `kind:'pad-login'`, todos con
`command:null`: sus acciones reales viven en los runners/endpoints guiados, no
en un comando para copiar. WhatsApp y cada rama `service-*` usan
`kind:'service-restart'` + `serviceId`; conservan `command` únicamente como
texto copiable/informativo, jamás como fuente de ejecución. Los demás caminos
incluyen `infisical-login` y comandos copiables. NO reemplazar Claude por
`claude setup-token`: ese comando emite un token de larga duración pero no
repara `~/.claude/.credentials.json`; la credencial de cuenta la reconstruye
`claude auth login --claudeai`, que es lo que ejecuta el runner guiado.
HONESTIDAD DE ACCIONES (`console:PLAN-2446` F6): `pad-cloud` sigue siendo
`kind:'manual'` y sin comando porque no tiene CLI propio; su OAuth lo refresca
Claude Code cuando usa el MCP y la consola no tiene un botón real que ofrecer.
ZeroTier conserva `action:null`: deliberadamente no se inventó un wizard para
una operación que el producto no puede completar. Verificación en vivo de la
entrega: el llavero devolvió los 10 `kind` guiados esperados.
SEGURIDAD: allowlist explícita de campos, jamás un spread:
`<scope.home>/.infisical/infisical-config.json` contiene
`vaultBackendPassphrase` y
NUNCA sale; de `infisical run --projectId … --silent -- true` se mira
SOLO exit code y stderr (nunca stdout: hoy corre `true`, pero si cambia
el comando ese canal traería secretos); de `gh auth status` se filtra la
línea `Token:`.
GOTCHA DE DISEÑO DE ALARMAS — `autoRefresh`: Claude OAuth dura ~1 h y Pad
cloud lo refresca Claude Code; con umbral preventivo genérico de 2 días
salían SIEMPRE en 🟡 "Vence pronto", y una alarma permanentemente
encendida entrena a ignorar el panel entero. Por eso
`expiryLight(expiresAt, {autoRefresh})`: una credencial auto-renovable va
🟢 mientras no venza, 🟡 "Renovando…" dentro de una gracia de 30 min
(`AUTO_GRACE_MS`) y 🔴 solo si pasada esa gracia sigue vencida (= dejó de
refrescarse, la señal REAL). Codex e Infisical NO son auto-renovables:
ahí el aviso preventivo de 2 días (`EXPIRY_WARN_MS`) es el valor. Regla
general: antes de poner un umbral de vencimiento, preguntar si esa
credencial se renueva sola.
REINICIO GUIADO DE SERVICIOS (`console:PLAN-2446` F5): endpoints admin-only
`POST /api/mcps/service/restart {id}` y
`GET /api/mcps/service/:id/status`. La frontera de seguridad es una allowlist
CERRADA `RESTARTABLE_UNITS`: `whatsapp`→`whatsapp-bridge`,
`service-pad-local`→`pad-local`, `service-tolkien-console`→`tolkien-console` y
`service-claude-web-console`→`claude-web-console`. El nombre de la unidad JAMÁS
sale del request: se exige `Object.hasOwn(RESTARTABLE_UNITS,id)`, se resuelve
contra el mapa y `execFile` recibe los argumentos como array. NO “flexibilizar”
esto interpolando input del cliente, ni siquiera detrás de una regex: sería
ejecución arbitraria de comandos. El caso `service-claude-web-console` es
especial porque reinicia al proceso que atiende el request: responde PRIMERO
`{ok:true,unit,self:true}` y recién 500 ms después dispara `execFile`, igual
que `updates/index.js`; `self:true` permite que el front trate la caída de red
como reinicio esperado. Evidencia en vivo: los ids hostiles
`../../etc/passwd` y `sshd` devolvieron `{error:"servicio inválido"}`; un
reinicio real de `tolkien-console` cambió MainPID 1583782→1888835 y su status
devolvió `{active:true,raw:"active"}`.
LOGIN GUIADO DE INFISICAL (`bin/cwc-infisical-login-runner.js`):
`infisical login` sin `--domain` arranca con menú de FLECHAS (imposible
de guiar desde la web); con `--domain <base>` (sacado de la config del
usuario, sin sufijo `/api`) lo saltea e imprime `open this address in
your browser: …/login?callback_port=N` y luego espera `Paste your browser
token here:`. Como el navegador corre en la máquina de Niko y el callback
apunta al localhost del server, el camino real es pegar el token. Runner
PTY (node-pty: `claude mcp login` y este exigen TTY) con estado en
`<scope.dataDir>/infisical-login/<id>.json`, id fijo `infisical` (una sola
sesión por usuario) y timeout de inactividad de 10 min. El token pegado
es SECRETO: llega por archivo 0600 que el runner BORRA apenas lo escribe
al pty, nunca entra al JSON del job ni a logs, y el buffer del pty (que
lo ecoa) jamás se vuelca a estado; solo se expone la URL. Igual que el
runner de MCP, NUNCA declara éxito por exit code: re-verifica con
`infisical login status` antes de escribir `done`. Endpoints del dueño
`POST /mcps/infisical/login` · `/login-token` ·
`GET /mcps/infisical/login/:id`. En la UI, una tarjeta MCP stdio con
`command === 'infisical'` que NO esté conectada ofrece directo
`🔑 Reconectar Infisical`: el botón que arregla la causa real, en la
tarjeta que falló.
ACCIONES MCP (del dueño; Regla 4: NUNCA editan `.claude.json` a mano — van
por la vía CLI oficial `claude mcp`, ejecutada con HOME/cwd del usuario, igual que
onboarding usa `claude setup-token`): `POST /mcps/logout {world,name}`
(`claude mcp logout`, limpia SU OAuth) · reciclar runners sigue siendo
acción global/admin y lo hace el FRONT vía `/api/admin/restart-runners`
(existente y oculto para no-admins). Enable/disable de servers
`.mcp.json` se DESCARTÓ (editaría `~/.claude.json` a mano). Reconexión
OAuth guiada (`login-shared.js` + `bin/cwc-mcp-login-runner.js`):
`claude mcp login <name>` EXIGE TTY → runner PTY, captura URL de
authorize, espera la URL de redirect pegada y re-verifica antes de dar
éxito. Estado en `<scope.dataDir>/mcp-login/<world>-<name>.json`; endpoints
`POST /mcps/login` · `POST /mcps/login-code {id,value}` ·
`GET /mcps/login/:id`. Los mundos se resuelven por scope: host conserva la
Consola real y `~/tolkien`; un inquilino usa
`<scope.workspace>/mi-espacio` y `<scope.workspace>/tolkien`. Ningún camino
usa la config global del proyecto ni HOME del host. Store, llavero, promesa en vuelo y
Set de checks viven en un mapa en memoria por `scope.user`: no hay caché
global capaz de cruzar datos entre usuarios.
