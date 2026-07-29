<!-- cwc:ficha-modulo -->
# src/modules/tokens — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

## Scope multi-tenant (BUG-1874)

TODO el módulo es user-scoped. Cada handler deriva el dueño exclusivamente de
`principalOf(req)` (sesión de usuario; el token maestro mapea al host), lo valida
con `sanitizeUserId()` y nunca acepta un owner por query ni header. Las rutas se
arman con `userClaudeDir(owner)`, `userDataDir(owner)`, `userSpace(owner)` y
`userCodexAuthPath(owner)`; para el host estos helpers conservan exactamente sus
rutas históricas. Las funciones públicas agregan `owner` como ÚLTIMO parámetro
con `hostUser()` por default (`buildSummary`, `computeFlow`, `getStream`,
`getSeed`, `mergeDaily`, `readSeries`, `scanCodexUsage`) para mantener
retrocompatibilidad con callers como `bin/cwc-optimize-runner.js`.

Las cachés TTL, promesas concurrentes, throttles, cursores y buffers efímeros son
por owner y están acotados a 32 usuarios; solo los caches de parseo por archivo
siguen globales porque su clave es el path absoluto y ya queda aislada. Para los
límites de Claude, `fetchPlanLimits(owner)` intenta primero
`getValidClaudeAccessToken(owner)` de `core/claude-oauth.js`: si el access token
de `.claude/.credentials.json` venció, renueva SOLO ese token mediante el
refreshToken. Un 401 con credenciales dispara UN refresh y un único reintento.
Recién como ÚLTIMO recurso usa `.claude/oauth-token` vía
`readUserOauthToken(owner)` (token que deja el onboarding). Ninguna credencial
viaja al cliente ni se loguea.

CAUSA RAÍZ: un INQUILINO corre sus sesiones con `CLAUDE_CODE_OAUTH_TOKEN` (el
setup-token), así que su CLI nunca renovaba `.credentials.json`; a las ~24 h el
medidor real se apagaba solo y caía a `localUsage`. El refresh mantiene vivo ese
camino mientras el refreshToken siga vigente (~1 mes). Cuando venza, sí hay que
volver a loguear al usuario con `bin/cwc-claude-login-runner.js`.

GOTCHA (verificado 2026-07-27 comparando host e inquilino en el mismo instante):
el setup-token `sk-ant-oat01` de `.claude/oauth-token` que deja el onboarding NO
cumple los scopes del medidor: `/api/oauth/profile` responde 403
`OAuth token does not meet scope requirement any_of(user:profile, user:office)`
y `/api/oauth/usage` enmascara el mismo rechazo como 429. Por eso un usuario sin
`.credentials.json` propia recibe `{unavailable:true}`:
`reason:'setup-token'` si Anthropic rechaza el fallback, o
`reason:'sin-credencial'` si no hay ninguno. SOLO en ese estado, `/limits`
adjunta `localUsage` con `windowTokens/windowCost` (últimas 5 h),
`todayTokens/todayCost`, `totalTokens/totalCost` y `updatedAt`, derivados del
`cachedSummary(false, owner)` de los transcripts propios del usuario. Es
best-effort: si el summary falla se omite el bloque sin romper `unavailable`, y
nunca se persiste en `plan-limits.json`. El front lo muestra como
“Claude · tu consumo”: es la alternativa honesta a porcentajes inalcanzables,
calculada localmente y no reportada por Anthropic. Si tampoco hay `localUsage`,
Claude se omite en silencio (Codex puede aparecer igual). Si luego aparece una
`.credentials.json` propia, el camino 1 la toma automáticamente y los límites
reales vuelven a mostrarse sin cambios ni `localUsage`.

### tokens/                   uso local (GET /summary: transcripts jsonl deduplicados, caché
por mtime+size; buildSummary parsea los .jsonl de cada dir en
PARALELO con runAdaptivePool — adopción Coherencia 2026-07-06:
LECTURA en pool con casillero por índice, ACUMULACIÓN serial en
orden fijo porque los costos son floats y el orden de suma debe
ser determinístico) + límites del PLAN (GET /api/tokens/limits:
% usado y reset de las ventanas de claude.ai — sesión 5 h /
semanales, incluida la del modelo activo — + los CRÉDITOS de uso
extra (`credits` derivado de `extra_usage`: enabled/usedCredits/
monthlyLimit/percent/currency; el front muestra SIEMPRE la fila que
Claude reporte — con barra % si hay tope, contador si es pago por
uso, o fila tenue "sin créditos activos" si enabled=false. OJO
REPRESENTACIÓN (bug 2026-07-07): `used_credits`/`monthly_limit`
vienen en la UNIDAD MÍNIMA (centavos) con `decimal_places` diciendo
cuántos decimales → el backend divide por 10^decimal_places para
pasarlos a dólares ($100 llegaba como 10000; se usa el campo, no un
/100 hardcodeado). `utilization` YA viene en % (0-100)),
vía el endpoint OAuth de uso de Anthropic con el accessToken vigente
de `.claude/.credentials.json`; `core/claude-oauth.js` renueva el access token
vencido con el refreshToken y persiste atómicamente el par rotado; el fallback
`.claude/oauth-token` se prueba como último recurso pero, si Anthropic lo
rechaza, devuelve el marcador `unavailable` + la alternativa local `localUsage`
descripta arriba; el token nunca viaja al cliente, caché
120 s (subido de 60 s: el medidor OAuth tira 429 si se lo consulta
seguido) y ?fresh=1 la saltea.
PERSISTENCIA + FALLBACK (2026-07-07, pedido del usuario: el dato
venía SOLO de memoria y un 429/corte de red/reinicio lo perdía):
cada respuesta BUENA se guarda en ~/.cwc-data/plan-limits.json
(writePersistedLimits, atómica tmp+rename, best-effort); ante
CUALQUIER error de fetch se sirve el último snapshot bueno — de la
caché en memoria o, si el server se reinició, del disco
(readPersistedLimits) — con 200 y `stale:true`+`staleReason` en vez
de tirar el error; recién sin NINGÚN dato previo se devuelve el
error real con su status (400 creds / 502 Anthropic / 500). El
front (usage.js renderLimits, fuente única del modal Uso Y del pie
plan-limits.js) pinta el aviso "⚠ datos guardados · hace X" cuando
`stale`, y loadLimits del modal ya NO borra el último render bueno
si un refresco posterior falla — paridad con el pie).
CODEX CLI — SEGUNDA fuente de ventanas de límite (2026-07-15,
PEND-499, pedido de Niko "trackear el uso de ChatGPT Max"): GET
/api/tokens/limits suma un campo OPCIONAL `codex`
{limits[],credits,subscription,limitReached,updatedAt,stale?} con el
uso de CODEX CLI (el agente de código de OpenAI), MISMO shape que los
límites de Claude para que el front los pinte con el mismo componente.
Fuente: el endpoint INTERNO `chatgpt.com/backend-api/wham/usage` (lo
consume el propio CLI open-source `openai/codex`) con la credencial
LOCAL `~/.codex/auth.json` (tokens.access_token + header
ChatGPT-Account-Id) — MISMO patrón de blindaje que Claude: el server
hace de PROXY (el token nunca sale al cliente), caché 120 s +
persistencia propia en `~/.cwc-data/codex-limits.json`
(writePersistedCodex, atómica tmp+rename) con fallback `stale` ante
error. `getCodexBlock()` es BEST-EFFORT y NUNCA lanza: si falla
(endpoint caído, sin sesión, sin red) devuelve el último snapshot
`stale` o null — la sección de Codex simplemente no aparece y JAMÁS
afecta el status ni los límites de Claude (se engancha con
`{...result, codex: await codexP}` en las DOS ramas del handler,
éxito y fallback; si Claude cae pero Codex vive, se sirve un shell con
limits vacío + el bloque de Codex). Las ventanas: primary_window +
secondary_window del rate_limit + cada additional_rate_limits[]
(features metrados tipo GPT-5.x-Codex-Spark); reset_at viene en
SEGUNDOS unix → ISO. ⚠️ VÍA NO-OFICIAL: el endpoint es interno de
OpenAI, NO está documentado públicamente → puede cambiar de forma sin
aviso (por eso todo es best-effort). Precedente: es el MISMO perfil de
riesgo que ya aceptamos con el medidor OAuth de Claude (leer credencial
local + pegarle a un endpoint no-doc que usa el propio CLI). El CHAT de
ChatGPT Max/Plus/Pro queda DELIBERADAMENTE AFUERA (decisión de Niko
2026-07-15): NO tiene ninguna vía equivalente — ni oficial ni
semi-oficial —, solo reverse-engineering fuera de ToS. El token de
Codex dura ~10 días (mucho más margen que el de Claude). El nombre del
plan sale de CODEX_PLAN_LABELS (mapea plan_type→nombre legible;
'prolite'→"ChatGPT Plus"). REDISEÑO VISUAL DE LA FILA (mismo pedido):
renderLimits pasó de 3 a 2 líneas por límite — L1 = SOLO texto (label
ui-dim + meta xs-truncable "queda X% · resetea · ≈tok" + % en MONO
grande coloreado por severidad) · L2 = la BARRA en GRADIENTE verde→
ámbar→rojo continuo. Técnica "gradiente fijo revelado" (`.lim-bar--grad`
+ `.lim-bar-mask`): el degradé (--cwc-ok→warn 55%→danger) vive en TODO
el ancho del track y una máscara tapa de `--pct` a 100% → la PUNTA del
relleno muestra el color de severidad REAL de ese %, no un corte duro
por umbral. El número % en texto es la codificación SECUNDARIA (no solo
color → CVD-safe, validado con la skill dataviz). `limRowHtml()` es el
helper de fila COMPARTIDO (Claude + Codex + créditos, fuente única).
HISTÓRICO PERSISTENTE + rediseño del modal (2026-07-10, pedido del
usuario): REEMPLAZÓ al viejo RESET (POST /reset, tokens-reset.json,
applyReset — TODO eliminado). El costo NO se persiste, se recalcula
siempre desde los transcripts; lo que SÍ se persiste es el desglose
DIARIO por modelo, para que las gráficas de TENDENCIA sobrevivan a la
poda de transcripts del CLI. HORA LOCAL: todo el consumo se calcula en
America/Bogota (Medellín, UTC-5 FIJO sin DST) — helpers en
src/modules/tokens/time.js (offset fijo, sin librería de zonas: corre
el reloj -5 h y lee con getters UTC; FUENTE ÚNICA que comparten el
parser y el histórico). parseFile bucketea por HORA local (clave
'YYYY-MM-DDTHH\tmodel', cacheable = tiempo absoluto) para poder derivar
las horas de HOY y la ventana de 5 h sin re-parsear; el día sale de
slice(0,10). buildSummary GANA (mismo loop): `daily` ({YYYY-MM-DD local:
{opus:{tokens,cost}...}}, se snapshotea a ~/.cwc-data/usage-history.json
vía history-store.js/mergeDaily — UPSERT de días vivos + CONGELA los
podados, throttle 5 min, atómica, retención 400 d + rollup mensual);
`hourlyToday` (serie {keys,points,totals} de hoy por hora, gráfica Día);
y `windows` {h5, d7, d7ByKey} = TOKEN-COUNTS de las ventanas de límite
(Anthropic NO expone tokens por ventana, solo %: se calculan de NUESTROS
transcripts — h5=últimas 5 h · d7=últimos 7 días · d7ByKey por modelo
para las ventanas scoped tipo "Semana·Fable"). publicSummary quita solo
`daily` (hourlyToday+windows SÍ viajan, son chicos). cachedSummary()
centraliza TTL+dedup+snapshot (la usan /summary y /history?range=day).
GET /history?range&project: day=HOY por hora (de hourlyToday — hoy
siempre en disco) · week=últimos 7 días · month=últimos 30 días
(readSeries del histórico); devuelve {range, keys[orden por PRECIO
haiku<sonnet<opus<fable — base=más barato], points, totals, project}.
FILTRO POR PROYECTO (pedido del usuario 2026-07-10): projectOf(dir)
clasifica cada transcript en consola (incluye healthfix-wt-)|tolkien|
otros; `daily` y `hourlyToday` quedan ANIDADOS por proyecto (hourlyToday
= {all,consola,tolkien,otros,aprendizaje}, cada uno una serie);
?project=all|consola|tolkien|otros|aprendizaje filtra. BUCKET
'aprendizaje' (pedido del usuario 2026-07-10, auditar ESTUDIO vs
DESARROLLO): las corridas del MÓDULO DE APRENDIZAJE (explain/context/
analyze) usan cwd = la consola/Tolkien, así que projectOf las vería como
'consola'/'tolkien' — se separan por SESSIONID: buildSummary lee
`learningIds` de ~/.cwc-data/learning-session-ids.json (lo escriben los 3
runners de aprendizaje capturando el session_id del msg SDK system/init,
ver learning/session-log.js) y calcula un `fproj` que MANDA sobre
projectOf (learningId ⇒ 'aprendizaje', sin importar el cwd). El engine
'learning' (ENGINE_LABELS, clasificado igual por learningId, PRIMERO en
classifyEngine) lo desglosa además en el detalle por MOTOR (antes caía en
'headless'). "Todos" (PROJECT_KEYS incluye 'aprendizaje') sigue siendo el
total real de la cuenta. NO es retroactivo (transcripts previos quedan en
'consola'; el histórico ya congelado no se re-separa). Los `windows`
(token-counts de límites) NO se filtran (los límites del plan son de la
cuenta entera). MODEL_ORDER pasó
a orden por PRECIO (haiku,sonnet,opus,fable) → fija el apilado de la
gráfica (base=más económico).
CONSUMO DE CODEX EN LAS ESTADÍSTICAS (2026-07-22, PLAN-927, hallazgo de
Niko): hasta acá el modal Uso tenía tres mitades con fuentes distintas y
Codex solo aparecía en dos — barras de LÍMITE (/limits, endpoint
wham/usage) y MANGUERA en vivo (flow.js) — pero NO en General+Tendencia:
buildSummary() solo parseaba ~/.claude/projects, así que se veía el cupo y
el caudal de Codex pero no su consumo histórico; agravante: Tándem es el
default de todo chat nuevo desde 2026-07-21, justo el motor que más
ejecuta. Solución: src/modules/tokens/codex-usage.js escanea
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl con caché por archivo
(mtime+size) y LRU 1000 igual que parseCached, más filtro barato por
substring antes de JSON.parse porque los rollouts traen mucho ruido
(reasoning, function_call_output). De cada rollout saca
session_meta.payload.cwd → proyecto (espejo deliberado de projectOf, pero
sobre la ruta ABSOLUTA real y no el dir codificado de Claude),
turn_context.payload.model → modelo vigente, y event_msg token_count →
info.last_token_usage (delta por turno). GOTCHA heredado de flow.js:
input_tokens YA INCLUYE cached_input_tokens y total_tokens = input+output,
entonces el cache se descuenta del input y viaja aparte como cache read
(`cr`); si no, se cuenta dos veces. DECISIONES DE NIKO: Codex se cuenta
SOLO EN TOKENS, cost: 0 — no se inventa tarifa de la API de gpt-5.x, y la
fila muestra badge "sin tarifa" y `—` en modo $ (nunca $0.00, que se
leería como gratis); entra como UN MODELO MÁS en la misma barra apilada,
key `codex`. En index.js, mkeyOf(model) colapsa cualquier `gpt-*`/`codex`
en la ÚNICA serie `codex` sin pasar por keyOf (solo conoce modelos de
Claude y devolvería `unknown`), para que un cambio de versión gpt-5.5 →
5.6 no parta la barra; reemplaza a keyOf en los 3 puntos de buildSummary
que calculan clave de serie, NUNCA en el keyOf de límites del plan (ese es
de Anthropic). ENGINE_LABELS gana motor propio `codex: 'Codex · ejecución'`
y NO se agrega a projects[] (esos son dirs de Claude). Queda
DELIBERADAMENTE AFUERA de h5tok/h5cost porque son token-count y ritmo de la
ventana de límite de ANTHROPIC: contaminarlos corrompería la barra
"Sesión (5h)" y el ratio "N× tu ritmo habitual"; también se EXCLUYE de
d7ByKey/d7tok con `if (k === 'codex') continue;`, aunque `daily` sí lo
tenga para histórico y gráficas. Codex tiene ventanas propias en
getCodexBlock; la cifra en dólares del dashboard sigue siendo SOLO Claude
y es correcta. Todo el bloque Codex de buildSummary va en try/catch: fuente
auxiliar, un rollout corrupto o en escritura nunca puede romper el resumen
de Claude. history-store.js suma `codex` a MODEL_ORDER justo antes de
`unknown` (fuera del orden por precio, porque no tiene tarifa), así
Semana/Mes lo persisten solas. Color: --cwc-model-codex: #3ec9c0 (teal),
deliberadamente LEJOS de --cwc-accent-cool (#5b8fc7) — usado por Codex en
manguera y límites — porque es casi idéntico a --cwc-model-sonnet
(#4e8fd1) y en la barra apilada serían indistinguibles; prima la
legibilidad de la serie. VERIFICADO E2E (2026-07-22): 344 rollouts / 356
entries en 367 ms; self-check del formato (suma de last_token_usage ==
total_token_usage final) con delta 0 en 3 sesiones; engine `codex` con
157.6M tokens y cost 0; d7ByKey sin key `codex`; Playwright confirma fila
"Codex" con badge "sin tarifa", `—` en modo $ y su volumen en modo tok, 0
errores JS.
buildSeries (history-store, compartido) arma esa forma para las 3
vistas. TODO en hora local, date-math sin DST (86400000 ms/día). Los
límites (fetchPlanLimits) suman `modelKey` (keyOf del display_name de la
ventana scoped) para mapear su token-count.
PUNTO DE REFERENCIA de la barra "Sesión (5h)" (2026-07-19, pedido de Niko:
el % crudo de Anthropic no dice si vas rápido o lento — se veía "todo o
nada" sin contexto). Alcance ACORDADO: SOLO `kind==='session'`, ni Semana
ni Codex. Dos piezas, ambas en `usage.js` (fuente única, reusada por el pie
`plan-limits.js`):
(a) TICK de ritmo esperado + ALERTA de agotamiento (`paceInfo()`, 100%
frontend, matemática pura desde `resetsAt` + duración fija de 5h — cero
fetch nuevo): un tick vertical en la barra marca "acá deberías estar si
gastaras parejo hasta el reset"; si tu ritmo ACTUAL (no el promedio)
proyecta que llegás a 100% antes del reset, aparece "⏳ se agota ~HH:MM"
en rojo. Se omite si `isActive:false` (sesión sin arrancar, dato que YA
traía el backend pero no se usaba). Como usa matemática pura, SÍ aparece
también en el pie compacto (`plan-lims`), no solo en el modal.
(b) Comparación contra tu HISTORIAL — "1.4× tu ritmo habitual"
(`paceRatioText()`, SOLO en el modal: necesita `windows` del summary, que
el pie no pasa). Backend: `buildSummary()` (tokens/index.js) suma
`h5cost` (costo $ equivalente acumulado en la ventana rodante de 5h,
aparte de `h5tok`) y calcula `h5CostBaseline` = promedio de COSTO de los
últimos días COMPLETOS del histórico persistente (`readSeries('week',
'all')`, excluye hoy que está a medias; <3 días de historial ⇒ `null`, el
front no muestra el comparativo) escalado a un bloque de 5h.
OJO — es COSTO, NO tokens crudos (bug atrapado en la propia verificación
2026-07-19): un token de cache read pesa ~10x menos en `pin()/pout()` que
uno nuevo y puede ser el 90%+ del conteo crudo de una sesión con contexto
reusado (caso real verificado: 95% cache reads con el % de cupo de
Anthropic bajo) — comparar TOKENS crudos contra el % real de Anthropic
infla el ratio artificialmente (se midió 2.7× con tokens vs 2.1× con
costo, mismo momento). El costo YA es la métrica que el resto del módulo
usa como "equivalente a precios de API"; es la aproximación más cercana
que tenemos a cómo Anthropic pesa el cupo internamente (que no exponen).
El ratio NO pretende igualar el % de cupo — es un eje INDEPENDIENTE
("¿hoy laburé más que lo normal PARA MÍ?"), separado del tick/alerta que
sí usa el % real de Anthropic end-to-end. `windows` gana `h5Cost`/
`h5CostBaseline`/`h5BaselineDays`.
MODAL rediseñado (usage.js): arriba límites del plan — cada uno con "·
≈ X tok" (windows) y la fila de créditos COLAPSABLE (<details>, contraída
por defecto en el modal Y en el pie plan-limits.js). Abajo UNA barra de
controles (Día/Semana/Mes + $/tok) que maneja las DOS columnas: izquierda
"📊 General · <período>" (total del rango elegido, por modelo, con Pac-Man
"consumiendo ahora") y derecha "📈 Tendencia" (gráfica de barras APILADAS:
Día=horas de hoy · Semana=7 días · Mes=30 días). SIN "Hoy" (redundante) y
SIN Reset. Gráfica con Chart.js (dependencia npm local chart.js 4.5.1, UMD
en public/vendor/chartjs/chart.umd.js — patrón marked/hljs, en index.html
→ window.Chart; se sirve desde public/vendor/, sin ruta express). Colores
= tokens --cwc-model-* con getComputedStyle; paleta en banda de PISO CVD
(validado skill dataviz) → codificación SECUNDARIA: leyenda con NOMBRES +
gap 2px entre segmentos + tooltip que nombra el modelo. Series todo-en-cero
se filtran. El toggle $/tok re-dibuja con la serie cacheada (0 fetch); el
cambio de rango sí trae datos (Día del summary, Semana/Mes de /history).
Timer 10 s: refresca límites+resumen (Pac-Man+token-counts) y la gráfica
solo en Día (cambia por hora); en Semana/Mes re-pinta solo la izquierda.
chartInst se destruye al re-crear y en onClose (sin leaks))
CAUDAL EN VIVO — "Manguera de tokens" (2026-07-15, PEND-516, pedido de
Niko): GET /api/tokens/flow (autenticado, 0 tokens) devuelve el CAUDAL
reciente {claude:{tps,tokens60,lastTs}, codex:{tps,tokens60,lastTs},
updatedAt} para alimentar una visualización animada de agua (ver
ui/token-flow.js). Lógica en src/modules/tokens/flow.js: DOS métricas con
contabilidad DISTINTA. tps/tokens60 siguen siendo CAUDAL OBSERVADO: lee
SOLO los bytes recién APENDEADOS a los logs locales (cursor por byte-
offset, in-memory, sin costo de tokens ni escritura a disco) y no mete
histórico en el ledger, que es rodante de 120 s (LEDGER_MS); tps son los
tokens de los últimos 10 s dividido 10 (INSTANT_MS) y solo escanea
archivos con mtime < 5 min (RECENT_MS), así el primer poll da ceros y no
hay ráfaga falsa al arrancar; `total`, en cambio, se deriva de la suma
REAL del archivo en
disco. Claude viene de ~/.claude/projects/**/*.jsonl (message.usage
input+output+cache) y Codex de
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (event_msg type=token_count
→ last_token_usage.total_tokens, ya es delta por turno). Refactor BUG-928:
un solo Map por ARCHIVO (`files`: side/key/total/lastTs/offset/size/
seeded) reemplazó a los tres Maps viejos (`cursors`, `claudeTotals`,
`codexTotals`); `bySession`/`byCwd` se derivan sumando las entradas por
key. SEED: al descubrir un archivo CALIENTE se parsea completo (chunks de
1 MB, tope 256 MB) y el total nace con el consumo REAL de la sesión; el
seed NO entra al ledger. Como el total se reconstruye desde disco,
sobrevive a un reinicio del server SIN persistir nada (medido: siembra en
177 ms, endpoint responde en 224 ms tras reiniciar). GOTCHA DE ORDEN: el
chequeo de archivo FRÍO (mtime > RECENT_MS) va PRIMERO, antes de crear la
entrada y de sembrar. Sembrar es caro y solo se justifica para sesiones
VIVAS: en esta máquina hay ~4.000 transcripts / 811 MB en
~/.claude/projects contra apenas 4 calientes; sembrarlos todos congelaría
el endpoint. Una sesión ociosa por más de RECENT_MS no tiene total hasta
que vuelva a escribir; ahí se siembra completa y queda exacta. El dedup
del seed usa un Set LOCAL por archivo (el `message.id` de Claude se
repite en varias líneas del transcript), NO el `seenClaudeIds` global, que
tiene TTL de 120 s y sirve solo al ledger. El enfriamiento ya NO borra la
entrada (antes borraba el cursor y se perdía todo lo escrito entre polls);
la purga pasó a ser por TTL de 6 h. Un archivo truncado/rotado
(`size < offset`) dispara re-seed completo; antes reseteaba el offset a 0
y volvía a sumar todo sobre el total, contando doble. Lección BUG-928 (Pad
`console`): un acumulado derivado de "lo que vi pasar" es frágil ante
reinicios y gaps de observación; si el dato ya está en disco, derivarlo de
ahí lo hace reconstruible y exacto.
TEXTO EN VIVO — GET /api/tokens/stream (2026-07-15, PLAN-544, para la
Vista Raw): HERMANO de flow.js (src/modules/tokens/stream.js) — MISMO
mecanismo cursor+baseline por bytes apendeados, pero en vez de CONTAR
tokens EXTRAE el TEXTO REAL que las sesiones escriben (Claude: bloques
text/thinking/tool_use de message.content; Codex: deltas de
agent_message/agent_reasoning). CURSORES PROPIOS (Map aparte del de
flow.js): NO comparte estado con el contador — aísla el riesgo (flow.js
alimenta la manguera que Niko ya usa; no se toca). Cada fragmento se
etiqueta {source,sessionId,world,model,text,seq}: el `world` (console/
tolkien/otros) sale del nombre del dir del transcript en Claude (regex
sobre encodeCwd) y del session_meta.cwd en Codex (parcial: si el rollout
no lo graba, world=null → 'codex?'). Buffer rodante en memoria (400
fragmentos, texto por-fragmento capado a 2000 chars — es muestreo para
la lluvia, no volcado); `?since=<seq>` devuelve solo lo nuevo (multi-
ventana safe, sin cursor por-cliente). 0 tokens, SOLO-LECTURA, efímero.
Baseline igual que flow.js (primer poll vacío, la lluvia no vomita el
histórico). El seed puntual de una sesión lee hasta 512 KB de cola del
transcript y devuelve como máximo 40.000 caracteres, suficiente para llenar de
una el panel de log de ~64 líneas de la Vista Raw. Lo consume
public/js/rawview/raw.js (ver raw.html en el mapa).

## Gotchas de esta carpeta

- SEPARADOR DE RUTA — las dos fuentes NO usan el mismo (BUG-1910, 2026-07-26).
  `projectOf(dir)` de index.js recibe el dir CODIFICADO de Claude
  (`-home-nmosquera-tolkien`, separador GUION); `projectOfPath(absPath)` de
  codex-usage.js recibe la ruta ABSOLUTA real de Codex
  (`/home/nmosquera/tolkien`, separador BARRA). El regex de Tolkien se había
  copiado tal cual del espejo (`(^|-)tolkien(-|$)`), así que en Codex NUNCA
  matcheaba y TODO el consumo hecho en Tolkien caía en `otros` — 335 entradas
  mal atribuidas, ~50% del histórico de Codex, sin que el total ni los límites
  del plan se vieran afectados (solo el desglose POR PROYECTO). Corregido a
  `(^|[-/])tolkien([-/]|$)`, que acepta ambos separadores y así resuelve
  también worktrees (`tolkien-wt-*`), subdirectorios (`tolkien/apps/mcp`) y
  entornos efímeros (`.cwc-data/tolkien-envs/env-*/tree`), sin tragarse
  falsos positivos (`mitolkien`). Si agregás un proyecto nuevo al
  clasificador, escribí el patrón en LOS DOS archivos por separado y probalo
  contra rutas reales de CADA fuente: son espejos en intención, no en formato
  de entrada. El histórico ya congelado en usage-history.json NO se
  re-atribuye (mismo criterio que el bucket `aprendizaje`).

- Desde BUG-1874 el panel Uso está habilitado para todo usuario autenticado y
  cada request queda aislada por su `principalOf(req)`. No reintroducir un gate
  admin-only ni rutas globales: transcripts, históricos, límites, credenciales,
  caudal y Vista Raw siempre resuelven dentro del espacio de ese owner.

- Módulo tokens: los TOKENS son exactos (campos `usage` que la API de
  Anthropic reporta en cada mensaje del transcript, dedup por message.id);
  el COSTO es un EQUIVALENTE a precios de API, no un gasto real — la
  suscripción del CLI no factura por token y la Admin Usage & Cost API de
  Anthropic exige organización + admin key (verificado: "unavailable for
  individual accounts"), así que NO hay endpoint de gasto consultable con
  estas credenciales. Precios en pin()/pout() de src/modules/tokens/index.js
  (fable 10/50 · opus 5/25 · sonnet 3/15 · haiku 1/5; cache w5m ×1.25,
  w1h ×2, read ×0.1 — verificados 2026-07). GET /api/tokens/summary?fresh=1
  saltea el TTL de 4s (botón ↻ del modal Uso); el caché por archivo
  (mtime+size) nunca se saltea porque es exacto por construcción. El modal
  Uso agrupa POR MODELO (lista acotada; agrupar por proyecto crecía sin
  tope): el pivot vive en buildModelView() de usage.js sobre el mismo
  /summary. El desplegable de cada modelo son los MOTORES que lo usaron
  (2026-07-04, antes eran "carpetas"/proyectos crudos): /summary expone
  `engines[]` (mismo shape que projects[]: label + models[]) atribuido por
  classifyEngine() de tokens/index.js — heurística determinística 0 tokens
  sobre datos ya en disco: sessionId ∈ unión de ~/.cwc-data/chats.json (vivos)
  + chat-session-ids.json (registro durable append-only de todo-lo-que-fue-chat,
  lo escribe el módulo chat) + bugfixes.json (chats de tickets) ⇒ 💬 chat ·
  dir healthfix-wt-* ⇒ 🔧 auto-fix de salud · dir tolkien ⇒ 🌳 tolkien ·
  entrypoint 'cli' ⇒ ⌨️ CLI · resto SDK ⇒ ⚙️ headless (triage/salud/desk/
  auto-título — NO separables entre sí sin instrumentar cada runner, quedan
  agrupados). projects[] SIGUE en el payload (retrocompat). ANIMACIÓN
  "consumiendo ahora" (Pac-Man por modelo): models[].lastMtime es el
  timestamp del ÚLTIMO MENSAJE de ESE modelo (parseFile guarda modelTs por
  modelo), NO el mtime del archivo — antes un jsonl multi-modelo "refrescaba"
  a TODOS sus modelos y el Haiku de auto-título (o un fable/sonnet viejo del
  mismo chat) titilaba en falso mientras solo Sonnet/Opus trabajaba; ahora
  solo se prende el modelo que de verdad emitió el último mensaje. isLive()
  de usage.js sigue usando el umbral de 2 min.
