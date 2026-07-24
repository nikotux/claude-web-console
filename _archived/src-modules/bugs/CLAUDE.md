<!-- cwc:ficha-modulo -->
# src/modules/bugs — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

> ⚠️ **MÓDULO ARCHIVADO.** Este código ya no está vivo: se movió a `_archived/` y no figura en `src/core/registry.js`. El módulo VIVO del ciclo ticket/feature/PR es `src/modules/tickets/`. Esta ficha se conserva como referencia histórica y NO se carga en ninguna sesión.
### bugs/                     (ANTES `tickets`, renombrado 2026-07-03) backend del hub
"Bugs & Features" del sidebar: triage de bugs BAJO DEMANDA
(consume tokens; admin). Ruta HTTP /api/bugs (GET estado, POST
/refresh). La corrida vive en un RUNNER DETACHED
(bin/cwc-triage-runner.js, patrón chat-runner): un reinicio del
server a mitad de triage NO la mata. Interfaz server<->runner en
shared.js: los archivos de runtime CONSERVAN el nombre
`tickets.json` (resultado) + `triage.lock` a propósito — describen
el DATO (tickets [Tolkien Bug] de Desk), no el módulo, y renombrar
la caché perdería el triage (que cuesta tokens regenerar).
DOS FASES EN PARALELO (optimización IA 2026-07-05; antes UNA
query() serial de 6 min donde un timeout tiraba el intento
COMPLETO): fase 1 = listado barato (LIST_PROMPT, solo MCP list,
LIST_MAX_TURNS 12 / 2 min); fase 2 = perTicketPrompt(t, lista)
por CADA ticket en paralelo con runAdaptivePool (health F2.5,
mismo uso que desk-runner; backoff ante 429/overload), 1 query
corta por ticket (TICKET_MAX_TURNS 20 / 3 min) que escribe SU
entrada INCREMENTAL a tickets.json (slots por índice, orden del
listado — el front que encuesta ve crecer la lista con
running=true). El prompt por ticket inyecta los HERMANOS (nº +
asunto) para no perder la detección de duplicados entre tickets,
Y el contexto del motor COMMS (commsContextFor de bugs/shared.js,
hallazgo de Coherencia 2026-07-06 — espejo backend de
fetchCommsContext del front): hilos indexados GitHub/Teams/
chatbot que mencionen el ticket (tkt-N/#N con boundary numérico,
tope 3 hilos), 0 tokens (buildIndex de comms/shared.js solo lee
disco), best-effort (cualquier falla ⇒ '' y el triage sigue) —
así el triage sabe si el bug YA se habló con Chris / tiene PR en
curso al decidir recommendation (duplicate/ya-trabajado).
Fallo individual ⇒ entrada fallback needs-info + error final
"Triage parcial: fallaron N de M"; fallo del LISTADO ⇒ se
conserva la caché vieja (la caché recién se pisa tras un listado
OK). El skill bug-triage va cargado en AMBAS fases (ahí viven el
department_id y las tools Desk). La doble capa read-only (regla
6) va EN CADA query de las dos fases.
CACHÉ INCREMENTAL por ticket (optimización IA 2026-07-05, mismo
patrón que health-audit-cache de salud F2): ticketFingerprint
(shared.js, sha1 status+subject+modifiedTime) del listado de
fase 1 se compara con ~/.cwc-data/triage-cache.json
({ticketNumber: {fingerprint, ticket, triagedAt}}) y un ticket
SIN cambios con triage cacheado FRESCO REUSA su resultado sin
abrir query() (0 tokens). OJO VERIFICADO 2026-07-05: el MCP de
Tolkien (summarizeTickets de apps/mcp/src/zoho-tools.ts) RECORTA
modifiedTime del listado — la señal real hoy es status+subject,
CIEGA a un comentario nuevo sin cambio de estado; por eso el hit
exige además TTL (TICKET_CACHE_TTL_MS 12 h: staleness acotada; si
el MCP algún día expone modifiedTime, entra solo al hash y ese
primer listado fuerza re-triage general). El prompt SIGUE
pidiendo modifiedTime a propósito (future-proof, hoy llega "").
Solo se cachean triages frescos OK (los fallback de error NO —
se reintentan); la caché se escribe UNA vez tras la barrera del
pool y SOLO con los abiertos del listado (los cerrados caen
solos). POST /refresh {full:true} (o `--full` a mano) la ignora
— red de seguridad si quedó sucia; borrar el archivo solo fuerza
un triage completo.
POST /refresh responde INMEDIATO (arrancar+encuestar, patrón
health/review); el front encuesta GET cada 3 s y re-dispara si la
corrida se pierde (3 intentos). Seguridad read-only de dos capas
(regla 6) EN el runner. DEDUP SIN CARRERA (hallazgo de salud
2026-07-04): spawnTriage() RESERVA el lock sincrónicamente
(writeLock con el pid del hijo, mismo tick que isRunning()) —
antes el lock recién lo escribía el hijo tras cargar imports y
dos POST casi simultáneos podían lanzar DOS triages; el runner
reconoce su reserva (readLock, pid propio ⇒ sigue y toma el
heartbeat; lock fresco AJENO ⇒ sale) y el 'error' del spawn
libera la reserva (clearLock) para no bloquear el reintento.
OJO: `bugs` (triage) ≠ `bugfixes` (motor
de PRs) — dominios distintos, nombres parecidos a propósito.
