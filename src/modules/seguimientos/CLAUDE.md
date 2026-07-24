<!-- cwc:ficha-modulo -->
# src/modules/seguimientos — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### seguimientos/             Dashboard "Seguimientos" (PLAN-553), primer habitante de LIMBO
(Regla dura 13): mapea el trabajo HUMANO-accionable de Niko, es
decir tickets que requieren SU intervención; nunca backend/dev. Se
alimenta del mundo externo (Zoho Desk) por la ADUANA read-only →
snapshot interno en disco; el dashboard lee SIEMPRE del snapshot,
nunca en vivo. Ruta /api/seguimientos. Frontend standalone en
public/seguimientos.html + public/js/seguimientos/seguimientos.js:
página aparte, sin main.js, con CSS INLINE en un <style> del propio
HTML — no en style.css. Archivos: store.js (snapshot) · refresher.js
(aduana Desk) · desk-source.js · classify-shared.js +
bin/cwc-seguimientos-runner.js (clasificador IA desacoplado, Haiku)
· history-store.js (historia diaria para las métricas) ·
calendar-source.js (calendario Outlook). Regla de resolución: el
dashboard NO resuelve nada solo — lanza una SESIÓN-LIMBO
(`limbo: true`) con el contexto ya masticado (0 tokens para armarlo,
sale del snapshot) y esa sesión reporta de vuelta. Endpoints que
abren sesión: /resolve · /resolve-bulk · /scan-updates · /standup.
La sesión lee las 4 fuentes (Desk/correo/Teams por MCP + WhatsApp
por Read del índice) pero SOLO escribe al ticket y con aprobación
explícita (limboFooter()).
CALENDARIO — sync con Microsoft/Outlook (2026-07-21): el cuadrante
📅 tiene DOS capas de datos independientes, no confundirlas. (a)
VENCIMIENTOS de tickets: salen del `dueDate` del snapshot de Zoho;
hoy vacío porque NINGÚN ticket tiene deadline cargado en Zoho (no es
bug del código: el dato no existe en el origen). (b) REUNIONES reales
del calendario de Outlook, vía calendar-source.js. calendar-source.js
es la fuente única: `fetchCalendar(username, {from,to,fresh})` pide
GET /me/calendarView a Microsoft Graph con el token que ya administra
core/connections-store.js (`getAccessToken(username,'microsoft')`,
refresco automático; OAuth en ⚙ Sistema → Conexiones, scope
Calendars.ReadWrite). Devuelve {connected, byDay:{'YYYY-MM-DD':
[eventos]}, count}; caché en memoria 120 s por rango. BEST-EFFORT:
sin conexión devuelve {connected:false} y el dashboard invita a
conectar; si Graph falla devuelve {connected:true, error}; el
calendario nunca puede romper el dashboard.
GOTCHA CENTRAL: el server corre en BERLÍN y el calendario se mira en
MEDELLÍN. La petición manda Prefer:
outlook.timezone="America/Bogota", así que Graph devuelve el
`dateTime` YA convertido a hora de Niko — por eso día y hora se
derivan por SLICE DE STRING (`slice(0,10)` / `slice(11,13)`), NUNCA
con `new Date()`: parsear ese string crearía un Date en la zona del
server y correría al día equivocado los eventos cerca de medianoche.
Mismo cuidado en el front: helper `dkey(date)` de seguimientos.js es
la fuente única del formateo local (reemplazó las copias sueltas del
mismo padStart). Otro gotcha: Graph reporta el `end` de un evento de
día completo como el día SIGUIENTE exclusivo → se le resta un día
antes de expandir el rango, si no un feriado de un día aparece en dos.
Endpoint GET /api/seguimientos/calendar?from=&to=&fresh=1
(autenticados, 0 tokens de IA — es HTTP determinístico, la regla 6 no
aplica): valida el formato de fecha y rechaza rangos >120 días; sin
parámetros usa el mes actual ±7 días (la grilla del mini-mes muestra
colas del mes vecino). Resuelve el usuario con el mismo userOf(req)
de connections/index.js (`principalOf(req)?.username || hostUser()`),
porque los tokens OAuth son PER-USUARIO. Front: el fetch es
fire-and-forget al final de `load()` y al navegar de mes — el
dashboard pinta sin esperar a Graph. Las reuniones se distinguen de
los tickets por COLOR (tickets `--cwc-accent` terracota · reuniones
`--cwc-accent-cool` frío) en el punto del mini-mes, el badge de la
tira semanal, los chips del calendario ampliado y el timeline por
horas del popup del día (extiende su rango 6-21 h si hay una reunión
fuera de esa franja, y manda los eventos de día completo a la banda
"Todo el día").
ESCRITURAS A DESK A NOMBRE DE NIKO (PLAN-781): el limboFooter() ya NO
manda a la sesión a usar las tools desk_* del MCP (ésas publican con el
token de OTRO agente): ahora le indica el CLI bin/cwc-desk.js, que
escribe con la identidad del usuario. Verificado en vivo: un comentario
creado por esa vía figura autorado por Nicolas Mosquera.
