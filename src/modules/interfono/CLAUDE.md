<!-- cwc:ficha-modulo -->
# src/modules/interfono — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### interfono/                INTERFONO entre sesiones: panel + canal HUMANO. Solo LEE el bus
(core/bus.js) — 0 tokens. GET /api/interfono (directory + messages +
claims con verdict de evaluateClaim + ts) · POST /send {to,text}
(mensaje manual desde la web a una sesión propia; host/admin también a
cualquiera o 'all') · POST /claim-release {file} (claim propio, o cualquiera
para host/admin). La
mensajería/claims AUTOMÁTICOS NO pasan por acá: los generan los hooks
de Claude Code (bin/cwc-bus.js). Frontend: pestaña "Interfono" del
menú ⚙ Sistema (system/interfono-panel.js).
SCOPE POR DUEÑO (`console:PLAN-2117`, B6): host/admin conserva la respuesta
completa y en el mismo orden/formato histórico. Para un no-admin, el conjunto
de handles propios se reconstruye SIN caché en cada request: `claude:<sessionId>`
y la TUI oculta `tmux:cwct-<terminalId>` salen de `ChatManager.list(principal)`
(`chat.owner`); las terminales `tmux:cwc-<id>` salen de `loadOwners()` sobre
`session-owners.json`. El `pane_pid` del directorio es solo diagnóstico y el
`--owner` del runner no se usa como fallback: ninguno es una identidad durable
del bus ni
persisten igual que las fuentes canónicas. Directorio, mensajes (`from` o `to`
propio), claims, lápidas y bitácora se filtran con esos handles. Send resuelve
solo dentro del directorio propio (sin broadcast); claim-release acepta el
claim propio o cualquier claim para host/admin. Handles viejos/nulos, chats ya
ausentes del registro, tmux sin owner y otros formatos sin pista canónica se
tratan como AJENOS para un no-admin (fail-closed). El panel mantiene ocultas
las acciones globales y rotula explícitamente “tus sesiones”.
INVARIANTE 7 en `POST /claim-release`: para un caller no privilegiado, “no
existe” y “existe pero es ajeno” devuelven el MISMO 404
(`No hay un claim propio para ese archivo.`), porque distinguir el texto
filtraba actividad de sesiones ajenas. Host/admin conserva el diagnóstico
informativo. `/send` exige strings y limita `text` a 4000 caracteres;
`/claim-release` limita `file` y el `handle` opcional a 512. Ambos montan el wrapper local `jsonBody()`
para traducir fallos de parseo a JSON 400. GOTCHA: hoy esa defensa modular es
INERTE en la práctica, porque `server.js` monta antes el
`express.json({ limit: '256kb' })` global (línea 122), antes de montar `/api`
(línea 228); ese parser falla primero y, sin error-handler global, Express
responde HTML. El cierre real sigue PENDIENTE: agregar en `server.js` un
manejador global de errores que preserve el contrato JSON.
MENSAJES HUÉRFANOS (`console:BUG-2074`): allMessages() de core/bus.js
agrega el campo DERIVADO `undeliverable:true` cuando el destino no figura
en el directorio vivo; NO se persiste. La medición fue 25/36 mensajes para
sesiones ya inexistentes (handles de entornos efímeros destruidos), incluido
"REENVIO — MIS 8 MENSAJES ANTERIORES NUNCA TE LLEGARON". No se implementó
caducidad ni borrado A PROPÓSITO: lo que alguien quiso comunicar no se destruye
sin decisión humana; el campo lo visibiliza y qué hacer sigue abierto.
allMessages(directory=null) acepta un directorio ya construido: el endpoint
le pasa el resultado de buildDirectory(), que ejecuta un subprocess de tmux,
para no repetirlo dos veces por request. bin/cwc-bus.js sigue llamándolo sin
argumentos; la firma es retrocompatible.
CONSCIENTE DE PAQUETES-SESIÓN (2026-07-14, PLAN-469): el interfono
aprovecha la estructura de sesiones de PLAN-373. (1a) Direccionar por
REF ESTABLE: `/btw PKG-5 <msg>` — `resolveTarget` de bus.js resuelve
`PKG-<n>` leyendo session-packages.json → sessionId → handle (inmune a
renames y a los moves entre mundos; el nombre es frágil, el ref no). (1b/
2a/3a) `buildDirectory` suma a cada entrada de chat `packageRef`, `world`
(worldLabelForCwd: 🏠 Mi Consola/🌳 Tolkien) y `archived` → el panel los
muestra (ref, mundo, "archivada"). (4a) `sendMessage`/POST /send aceptan
`packageRef` → un mensaje puede TRANSFERIR un paquete ("te paso PKG-5");
chip 📦 en el mensaje + input en el composer. VERIFICADO que la base NO
se rompe: el handle es `claude:<sessionId>` y el move conserva el mismo
sessionId → los mensajes siguen llegando tras cambiar de mundo (el fork
descartado LO HABRÍA roto). bus.js está en el allowlist de `cross-world`
(usa config.projectDir para ETIQUETAR el mundo, no cruza datos).
DIFERIDO (más invasivo): 2b marcar mensajes entre-mundos · 2c broadcast
por mundo (`all@tolkien`, exige el mundo del receptor en pendingFor) ·
3b aviso automático al mover/archivar (necesita modelo de suscriptores).
ENTREGA AL CHAT (2026-07-06, pedido del usuario: el chat visual es
la superficie PRINCIPAL de trabajo, la TUI es backup): una TUI recibe
el mensaje por un nudge send-keys que la despierta en vivo, pero un
chat del SDK solo lo "ve" al tomar un turno (el hook-inject de
bin/cwc-bus.js corre en UserPromptSubmit — settingSources: ['user']).
Esa brecha la cierra el MÓDULO chat (no éste): un watcher server-side
(~12 s, ChatManager._deliverInterfono) AUTO-ENTREGA el mensaje a los
chats ABIERTOS (algún cliente WS) y OCIOSOS (alive+waiting) inyectando
un turno sintético con el texto (Chat.deliverInterfono → marca
entregado en el bus ANTES de disparar el turno para que el hook-inject
del mismo UserPromptSubmit no lo duplique — paridad con el nudge idle
de la TUI). Los chats dormidos/ocupados/sin pestaña NO se despiertan
solos (0 tokens fantasma): quedan para el POPUP GLOBAL
(public/js/ui/interfono-center.js) alimentado por pendingInterfono[]
de /api/chat/list (poll 8 s) con botones ▶ Retomar (POST
/api/chat/interfono {action:'deliver'} — inyecta y DESPIERTA a
demanda) y ✕ Descartar ({action:'dismiss'} — marca entregado sin
actuar). El chat consume el bus SOLO leyendo (pendingFor/markDelivered)
REDISEÑO DE LA CAPA DE NOTIFICACIÓN (2026-07-10, pedido del usuario:
"que el interfono funcione por backend, sin preguntarme retomar/
descartar, y que solo se entere la ventana realmente afectada" — el
popup modal aparecía en TODAS las ventanas del navegador y era ruido
con varias sesiones abiertas). Se hizo tras análisis externo
(docs/interfono-analisis-externo.md → docs/plan-rediseno-interfono-v01.md,
adaptado). CUATRO fases:
(F0 · IDENTIDAD + BITÁCORA) `src/core/interfono-log.js` (nuevo): bitácora
append-only JSONL en ~/.cwc-data/session-bus/delivery-log.jsonl (poda a
la mitad ~2 MB, patrón model-router-log; fail-open total) que registra
CÓMO llegó cada mensaje al humano (ROUTES: auto-deliver/tui-nudge/
hook-inject/badge/popup-shown/popup-resume/popup-dismiss/expired) —
materializa "nada se pierde en silencio". `logDelivery` se llama en
deliverInterfono/consumeInterfono (chat) y tryNudge/hook-inject
(bin/cwc-bus.js). ADEMÁS arregla el `from: null` de los mensajes de un
chat: el runner ahora hereda CWC_SELF_HANDLE=claude:<sessionId>
(runner-link.spawnRunner recibe `selfHandle`; chat/index _startEngine lo
pasa cuando ya hay sessionId — resume/reopen; selfIdentity de cwc-bus.js
lo lee PRIMERO). El primerísimo arranque de un chat nuevo aún no tiene
sessionId y cae al fallback (from null), sin regresión.
(F1 · SCOPING CLIENTE) el popup global (interfono-center.js) recibe de
main.js un 2º predicado `isChatRelevant = (id) => tabs.has(id)`: una
ventana SOLO crea tarjeta para chats que ESA ventana tiene abiertos —
mata el ruido cross-ventana (antes syncFromList creaba tarjeta en TODA
ventana desde /api/chat/list y solo la ocultaba en render()).
(F2 · POPUP → SEÑAL PASIVA) se retiró el modal "Retomar/Descartar" como
superficie por defecto: ahora un chat con mensajes sin tomar muestra un
BADGE pasivo (contador + ícono relay, `.sess-interfono`) en su tarjeta de
"Sesiones" (sessions.js syncInterfonoBadge, alimentado por el
pendingInterfono[] de /api/chat/list que se mantiene a propósito); al
tocarlo, un popup con preview + "Entregar" (confirm por consumo de tokens
antes de despertar un chat dormido) / "Archivar". El panel Sistema →
Interfono suma la vista "Bitácora de entrega" (GET
/api/interfono/deliveries?limit=N, solo lee el JSONL, 0 tokens). El centro
de popups (interfono-center) queda SOLO para mensajes `active` (ver F4).
(F3 · PUSH DIRIGIDO SERVER-SIDE) en vez de construir windowId+rooms desde
cero, se REUSA el primitivo que ya existe: Chat._broadcast sobre
this.clients llega SOLO a las ventanas que tienen ESE chat abierto.
Chat.signalInterfono() empuja {type:'interfono', pending} por ahí; el
watcher lo llama para chats ABIERTOS-pero-ocupados (los ociosos siguen
con auto-entrega; los dormidos/sin-pestaña con el badge del poll).
chat-tab.js re-emite el evento como window `cwc:interfono` (patrón de
perm-center) y el centro lo consume para adelantar/retirar el aviso
`active` al instante (el poll de 8 s queda de red de seguridad). NO se
retiró pendingInterfono de /api/chat/list (desvío deliberado del plan
§3.5): el badge pasivo de Sesiones lo necesita como ESTADO — un badge
global en una lista NO es ruido, a diferencia del popup.
(F4 · NIVELES passive/active) `bus.levelForKind(kind)` es la FUENTE ÚNICA
(sin IA, R1): kind 'heads-up' (colisión real — otra sesión editó un
archivo que reservabas, releelo) ⇒ `active`; todo lo demás (notes,
broadcasts) ⇒ `passive`. sendMessage sella `level` (default por kind;
mensajes viejos sin level ⇒ passive en los lectores). pendingInterfono
expone `level`; el centro de popups SOLO surfacea `active` (scoped +
relevante); el badge de Sesiones toma acento de alerta (--cwc-warn,
`.sess-interfono--active`) si algún pendiente es active. La bitácora
registra `level`. R3 intacta: evaluateClaim y sus umbrales NO se tocaron.
