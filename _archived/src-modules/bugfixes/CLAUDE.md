<!-- cwc:ficha-modulo -->
# src/modules/bugfixes — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.

> ⚠️ **MÓDULO ARCHIVADO.** Este código ya no está vivo: se movió a `_archived/` y no figura en `src/core/registry.js`. El módulo VIVO del ciclo ticket/feature/PR es `src/modules/tickets/`. Esta ficha se conserva como referencia histórica y NO se carga en ninguna sesión.
### bugfixes/                 MOTOR de tickets (engine.js — la columna vertebral): el log
físico sigue en store.js (~/.cwc-data/bugfixes.json, cada registro
= un ATTEMPT/chat que trabajó un ticket, clave sessionId — NO se
tocó, retrocompat total). El motor DERIVA determinísticamente
(como core/inventory.js, sin LLM) los TICKETS consolidados:
buildTickets() agrupa los attempts por número de ticket → 1 ticket
= 1 entidad {number,title,attempts[],external:{github[],desk},
state DERIVADO (deriveState: pipeline triaged→working→pr-open→
pr-merged→desk-answered→resolved), resolution, tags[], meta{},
history[] unificado, schemaVersion}. IMPOSIBLE duplicar (dedo
resbalado = attempt outcome 'empty'). Sidecar tickets-meta.json =
dimensiones curadas (tags/area) + BIBLIOTECA DE SOLUCIONES +
FEEDBACK de Chris persistido. BASE DE CONOCIMIENTO (2026-07-04,
determinística, 0 tokens): (a) FEEDBACK — prLive ya trae los
reviews/comentarios de Chris de gh pero se perdían a los 60 s / al
reiniciar; ahora saveFeedback() los PERSISTE por ticket en el sidecar
(sc.feedback[n]), mapeando PR→ticket por registro/branch/título;
buildTickets los adjunta en external.feedback y el tablero los muestra
(feedbackHtml). (b) SOLUCIONES — la biblioteca se LLENA SOLA: al
derivar un ticket con PR mergeado (o resuelto), deriveSolution()
destila {rootCause, fix, lesson, files, tags, prNumber, feedback de
Chris} del cierre del chat (marcadores Problema:/Qué hice:/Mejor
solución:) y upsertSolutionInto() hace UPSERT idempotente (1 por
ticket, escribe solo si cambió, una vez por build). findSimilarSolutions
matchea por archivos/tags/área y EXCLUYE el propio ticket. (c) REUSO —
el prompt de "Trabajar en esto" (doWorkOn) inyecta el feedback de Chris
guardado + las soluciones pasadas parecidas (similarHtml las muestra en
el detalle). CAPA IA OPCIONAL futura (Fase 4, no hecha): destilar la
"lección" con haiku. recordSolution() sigue exportada para esa capa.
GET /api/bugfixes/tickets = tickets consolidados (+ similar[]); el
tablero (bugs/board/store.js) lo consume vía ticketToRow (puente
motor→helpers): 1 fila por ticket, los intentos en el detalle
(attemptsHtml). GET /api/bugfixes (viejo, array plano) queda para
retrocompat. ESTADO EN VIVO (fase 2): GitHub se auto-refresca cada
45 s mientras el tablero está abierto + al volver a la pestaña
(barato, solo gh — los merges de Chris aparecen solos; intervalo
se limpia al cerrar). Desk NUNCA solo (cuesta tokens): botón "🎫
Desk" consulta desk-live de los tickets ACTIVOS (con confirm),
persiste deskReplied/deskResolved y el motor los refleja. Indicador
de frescura "GitHub: hace X · Desk: hace Y/sin consultar" (.bb-fresh).
La columna Desk del tablero distingue 🎫✅ resuelto · 🎫✔ respondido
· 🎫✕ error · 🎫○ consultado sin respuesta · — sin consultar.
registro de fixes de tickets (store.js: ~/.cwc-data/bugfixes.json,
extracción del transcript, scan retroactivo) + subida de PR a
Tolkien (worktree temporal desde origin/main — NO toca el árbol
real — commit de los archivos del fix, push, gh pr create con
reviewer cswenor). Notas del PR SIEMPRE formales: Problema /
Qué se hizo / ¿Mejor solución? (parseadas del cierre del chat).
TICKET REABIERTO con PR ya montado = ACTUALIZAR, no duplicar:
recordBugfix mergea el trabajo nuevo también en una entrada
'subido' cuyo prState != 'merged' (vuelve a 'pendiente'
CONSERVANDO branch/prNumber — la UI la muestra como "PR #N
abierto · cambios sin subir"); pushPr verifica el estado REAL
del PR con gh EN EL MOMENTO del envío: abierto → updatePr
(worktree desde el branch DEL PR, commit ENCIMA, push
fast-forward sin --force, gh pr edit --body + comentario
avisando al reviewer — best-effort) → el MISMO PR se
actualiza; mergeado/cerrado → camino de PR nuevo de siempre.
Solo un merge cierra el ciclo del ticket.
DOS CONTEXTOS editables (GET/POST /context?kind=work|pr), ambos
inyectados en cada "Trabajar en Chat": 'work' (bugfix-context.md —
verificación previa del ticket/PRs de Chris, proceso, NO enviar PR
desde el chat) y 'pr' (bugfix-pr-context.md — cómo se REDACTAN las
notas del PR: formato Problema:/Qué hice:/Mejor solución: del
cierre).
🚦 GATE DE PUSH (pedido del usuario 2026-07-05): el contexto
'work' abre con una regla dura — el trabajo se ejecuta DE
CORRIDO, pero ANTES de CUALQUIER push (git push / gh pr
create|edit / actualizar PR / "Enviar PR") el chat FRENA,
muestra el PLAN DE PUSH (branch destino + PR nuevo/actualiza
#N + archivos con diff stat + texto exacto de las notas) y
espera el OK explícito del usuario; recién ahí pushea de
corrido y verifica contra GitHub. workPrompt/featurePrompt
(board/prompts.js) lo recuerdan en el arranque del chat, y el
confirm de "Enviar pendientes" (sendPending de
board/actions.js) muestra el mismo plan por fix: destino →
branch (misma fórmula que pushPr) + lista de archivos (tope
5). deskChatPrompt ya tenía su gate propio (nota → OK →
publicar) y no se tocó. YA NO se editan con botón "Contexto" propio en el
EXPANDIR de Bugs ni en el modal Enviar PR (se sacaron de ahí): se
editan desde ⚙ Sistema → Proyectos, como "Bugfixes: Trabajo" /
"Bugfixes: PR" (sub-proyectos SIN memorias, junto a Tolkien/Consola
— ver project-context-panel.js). Editor genérico: textEditorDialog (ui/dialog.js).
Cancelar PR (POST /cancel-pr, admin): cierra el PR en GitHub +
borra el branch remoto y el registro vuelve LIMPIO a 'pendiente'
(sin campos de PR) para rehacer el fix de cero; un PR MERGEADO
nunca se cancela (se verifica el estado real con gh antes).
VINCULACIÓN + RECONCILIACIÓN de PRs externos (bug 2026-07-05,
caso FEAT-2/PR #249; patrón Desk #519/PR #232): un PR creado por
FUERA del módulo "Enviar PR" (gh pr create desde un chat o un
worktree externo) dejaba el registro huérfano PARA SIEMPRE
("falta enviar el PR" con el PR ya abierto) — extractFromTranscript
solo mira tools Edit/Write (ignora Bash/gh) y prNumber solo lo
escribían pushPr o refresh-prs FASE 2 (que solo refresca PRs YA
registrados). TRES vías nuevas, UNA lógica (link-shared.js:
applyPrLink mutación pura idempotente + linkPrToRegistry con gh
pr view; NO importa core/config.js a propósito — exige CWC_TOKEN
y haría exit fuera del repo): (1) RECONCILIACIÓN automática en
refresh-prs — si un PR de gh pr list referencia (ticketOfPr:
tkt-N / FEAT-n / #N) un registro SIN prNumber y el match es
INEQUÍVOCO (exactamente UN candidato no archivado), lo ADOPTA
(prNumber/prState/branch/status 'subido' + evento pr_vinculado
{mode:'auto'}; cerrados sin merge y ambiguos NO se adoptan;
respuesta expone linked[]); (2) POST /link-pr {id, prNumber}
(admin) + botón "🔗 Vincular PR…" en el detalle (desktop) y menú
⋯ del action bar (móvil) para lo que el regex no ve (p.ej.
"FEAT-1/2": solo captura FEAT-1); (3) PREVENCIÓN — el propio
chat corre bin/cwc-bugfix-link.js en el MISMO turno del push
(mode:'chat'); lo exigen el contexto 'work' (condición (e) de la
excepción), DEFAULT_CONTEXTS.work y los gates de workPrompt/
featurePrompt. ticketOfPr (motor) ahora entiende FEAT-n y
devuelve la clave completa ('FEAT-2', no el dígito), con orden
deliberado tkt-N → FEAT-n → #N (un título "Feature FEAT-2
(#245)" da FEAT-2, no 245); FUENTE ÚNICA de esa convención
(cableado Coherencia 2026-07-06, ANTES espejo duplicado a mano
en el front): refresh-prs adjunta `ticketNumber: ticketOfPr(pr)`
YA calculado a cada fila de `github`/lastGhRows y ticketOfPr de
labels.js CONSUME ese campo si está presente (aunque sea null) —
su regex quedó SOLO como fallback legacy para filas cacheadas
sin el campo, NO mantenerla en paridad con el motor; buildTickets
también prefiere el campo. isFeatId (front) sigue local y gatea
Desk en filas solo-GitHub de features (chip 💡,
sin sección Zoho ni "Actualizar ticket"). Evento pr_vinculado en
EV_LABEL/evDot. Un PR vinculado pasa a mantenerse solo (FASE 2
de refresh-prs lo refresca como cualquier subido).
El chat registra al CERRAR una conversación con ticket (diferido
2s: el transcript se flushea tarde).
HISTORIAL por fix (history[] en cada registro, addEvent de
store.js, retrocompatible): creado · trabajo_nuevo (reapertura
tras PR) · pr_creado · pr_actualizado (2º+ commit, sha) ·
pr_mergeado (transición detectada en refresh-prs) · pr_cancelado ·
ticket_actualizado (Desk, auto|chat, ok|error). Es el timeline
del tablero.
DESK AUTO (deskUpdateAuto, ver EXCEPCIÓN en regla 6): tras el
PRIMER envío exitoso (esPrimerEnvio = !updated && !sentAt) corre
asíncrona una corrida SDK (sonnet, allowlist SOLO desk_* del MCP,
timeout 4 min) que pone el ticket On Hold + nota corta EN INGLÉS;
deskStatus updating→ok|error + evento al historial. Las
ITERACIONES no tocan Desk: el resultado del envío lo avisa y el
tablero ofrece "Actualizar ticket (chat)".
IDENTIDAD AL PUBLICAR (regla general, pedido del usuario
2026-07-04): si el camino de escritura puede publicar con la
identidad REAL de Nico (token/cuenta propia) → usarla, SIN
firma; si publica como otra identidad → firma obligatoria.
FIRMA EN DESK (caso actual): el token OAuth de Zoho que usan
las tools desk_* es de OTRO agente (Chris) — la API publica
toda nota como si la escribiera él y no permite falsear el
autor. Por eso TODO prompt de la consola que redacta
escrituras a Desk (deskUpdateAuto acá y deskChatPrompt en
bugs/board/prompts.js — ghdeskchat reusa deskChat) exige cerrar la
nota con la firma exacta "— Nicolás (dev team)" en su propia
línea. Teams sale como bot "Tolkien" (misma regla si se
automatiza). Si se agrega otro camino de escritura externa,
aplicar la regla general (identidad real si se puede; si no,
la firma). Si algún día llega un token de Zoho PROPIO de Nico,
quitar la firma de esos prompts.
FEATURES (💡 FEAT-n, 2026-07-04): item de trabajo de TOLKIEN
SIN ticket de Desk. Alta manual admin: botón "💡 Nuevo feature"
del tablero (desktop + menú ⋯ móvil) → POST /api/bugfixes/feature
{title, description} → createFeature() de engine.js (id sintético
FEAT-n, secuencia featureSeq en el sidecar; kind:'feature' +
spec = enunciado ORIGINAL permanente que el resumen del chat no
pisa). El id viaja en ticketNumber (el motor ya agrupa por
[\w-]+): TODO el ciclo se reusa — recordBugfix mergea por
ticketNumber, "Trabajar en esto" abre chat (featurePrompt de
prompts.js, modo plan si aún sin archivos, diseño primero),
pushPr usa branch feature/feat-n-<sid> (no bugfix/tkt-). Desk
queda FUERA en todas las capas (deriveState: merge ⇒ resolved;
deriveResolution/resolutionOf: merge ⇒ complete; deskUpdateAuto
y el gate del POST /pr excluyen kind feature; la UI oculta
botones/section/chips/investigación-contexto de Desk y el
pipeline muestra "se completa con el merge"). REGLA de
clasificación (memoria feature-clasificacion.md): el tablero es
SOLO Tolkien — features de la consola u otros proyectos NO se
cargan acá. Intake automático desde la página Tolkien
([Tolkien Feature] en Desk → triage) = fase FUTURA, no hecha.
PR-LIVE (GET /pr-live/:n, admin): datos EN VIVO de un PR vía gh
(reviews, reviewDecision, comentarios, checks, commits,
mergeable) con caché en memoria de 60 s (?fresh=1 la saltea);
NADA se persiste — es el panel "GitHub en vivo" del tablero.
DESK-LIVE (admin, CONSUME TOKENS, DESACOPLADO a runner 2026-07-04):
estado + comentarios ACTUALES del ticket en Zoho Desk vía corrida
headless READ-ONLY (sub-excepción regla 6: allowlist desk_* SOLO
lectura). Antes corría INLINE en el GET (se perdía al cambiar de
pestaña / reiniciar server); ahora vive en bin/cwc-desk-runner.js
(lógica en desk-shared.js): POST /desk-refresh {tickets:[...]}
lanza el runner detached (dedup lock desk.lock) y responde YA;
resultado persistido en ~/.cwc-data/desk-live/<ticket>.json; GET
/desk-live/:n SOLO lee ese disco (0 tokens) + `running`/`progress`
de la corrida; el front encuesta (fillDesk POST→poll, resiliente al
cambio de pestaña). parseDeskResponse (desk-shared) parsea un bloque
JSON de la respuesta; sin fresh reusa < 60 s (no relanza). CLASIFICA
la resolución: pide al modelo `closed` (status cerrado/resuelto, con
red de seguridad regex) y `requesterReplied` (el cliente respondió
tras la última nota del equipo). persistDeskSnapshot() (desk-shared,
lo llama el runner) vuelca en TODOS los registros del ticket:
deskStatusText/deskClosed/deskReplied/deskResolved +
deskCheckedAt, y emite ticket_cerrado|ticket_respondido al
historial la 1ª vez. RESOLUCIÓN (resolutionOf, derivado, expuesto
en GET /api/bugfixes como b.resolution): 'complete' si deskResolved
· 'partial' si prState==='merged' (PR mergeado pero ticket SIN
confirmar — merge ≠ resuelto: puede ser fix parcial o total, sin
verificar) · 'active'. ARCHIVO (POST /archive {id,archived}): flag
b.archived + evento archivado|restaurado; solo organiza el tablero,
no toca código ni PRs.
INVESTIGAR A FONDO (Fase 1, 2026-07-04): al expandir un PR abierto,
fillLive muestra un SEMÁFORO determinístico (semaforoHtml, 0 tokens,
desde prLive: review/checks/conflictos + si Chris escribió tras tu
último commit) + el botón "🔍 Investigar a fondo" (runInvestigation →
POST /investigate → runner cwc-investigate-runner.js → GET
/investigation/:pr, encuesta resiliente). El veredicto IA
(verdictHtml: severidad/titular/pasos/archivos) se persiste y sus
`pasos` se inyectan en "Trabajar en esto" (doWorkOn). Ver regla 6.
INVESTIGAR CONTEXTO (ticket SIN PR, 2026-07-04): la MISMA caja
destacada al inicio del detalle (invTopBox decide por b.prNumber) muestra,
para toda fila-ticket sin PR (incluidas las de triage), el botón "🔍
Investigar contexto" (runTicketInvestigation → POST /ticket-investigate →
runner cwc-ticket-investigate-runner.js → GET /ticket-investigation/:n,
encuesta resiliente). A DIFERENCIA de la de PR, ésta LEE el código de
Tolkien read-only (no hay diff sin PR) y responde POR QUÉ no se resolvió +
causa raíz. Veredicto (verdictTicketHtml: porQueNoResuelto/causaRaiz/
pasos/archivos/complejidad/riesgo) persistido; sus `pasos` se inyectan en
doWorkOn (ticket sin PR) y en workOnTriage. Ver regla 6.
FILA-PR (Fase 2, 2026-07-04): cuando un PR está ABIERTO el PR es el
protagonista de la fila (🔀 #N + título) y el/los TKT que resuelve van
ANIDADOS debajo (↳ 🎫 TKT #N, bb-row--pr — familia .bfm-* migrada a .bb-* en Fase 2). renderTable agrupa por
número de PR abierto (openPrGroups) y saltea los secundarios (no
duplican fila); data-sid queda en el TKT primario → expandir/in-place
intactos. Mergeado/cerrado/sin-PR siguen como fila-TKT.
UI ÚNICA: el TABLERO "Bugs & PRs" (bugs/board/): filas de
registro local + tickets del triage + PRs SOLO-GitHub, estas
últimas EXPANDIBLES (badge #N del ticket detectado del título/branch
con ticketOfPr, panel GitHub en vivo con commits, "Actualizar
ticket (chat)" si tienen ticket). La 5ª barra del pipeline es
"ticket confirmado" (verde SOLO si deskResolved); chip de
resolución en la fila (🟡 parcial · 🟢 completo). DOS columnas
de ícono compacto (prCellFor/deskCellFor, datos ya presentes, CERO
tokens): "PR" (✔ implementado en PR mergeado · ◐ en PR abierto · —
sin PR; cruce por ticketNumber sobre entries+ghRows) y "Desk"
(🎫✔ respondido = deskStatus 'ok' o evento ticket_actualizado/
ticket_respondido en history · ⏳ publicando · 🎫✕ error · —). En
móvil (≤640) se ocultan Pipeline+Cambios y quedan PR/Desk (info de
un vistazo). "Responder ticket (chat)" (data-act deskchat) aparece
en TODA fila con ticketNumber (antes solo con PR): el prompt se
adapta (con PR = nota de novedades · sin PR = responder/pedir info),
siempre con aprobación del usuario en Desk (regla 6). Cada fila con
ticket trae "Traer estado de Desk" (desk-live, bajo botón; muestra
veredicto parcial/completo y actualiza b.resolution en memoria sin
re-render). Botón Archivar (primario cuando completo) /
Restaurar por fila. El "?" ("Cómo leer este tablero") explica
pipeline, resolución, chips, puntos, Archivo y GitHub/Desk en vivo.
SUBVISTAS / PESTAÑAS (pedido del usuario 2026-07-05): el tablero
se organiza en TRES pestañas primarias (barra .bb-tabs, visible
en desktop Y móvil, `state.tab` en store.js — R1, fuera del DOM):
🎫 Tickets (bugs con ticket + tickets del triage sin trabajar +
PRs solo-GitHub) · 💡 Features (FEAT-n) · 📦 Archivados (todo lo
archivado, tickets y features). tabOfEntry (labels.js) deriva la
pestaña de cada fila (archived manda sobre kind); renderTable
filtra tanto la tabla desktop como las cards móviles por
state.tab. Antes TODO apilaba en una sola lista con la sección
colapsable "📦 Archivo · resueltos" al fondo (data-arch-toggle /
.bb-arch-row / archOpen — ahora en desuso, reemplazados por la
pestaña Archivados). Los conteos de cada pestaña salen del estado
(0 tokens). Los SEGMENTOS móviles (Acción/Revisión/✓) quedan como
filtro SECUNDARIO dentro de Tickets/Features (ya NO tienen 📦 —
es pestaña); se ocultan en Archivados. Cambiar de pestaña es un
store.set({tab}) y el re-render es seguro (no toca `expanded`).
AUTO-ASIGNACIÓN AL TOMAR (PLAN-781): POST /claim, además del lock local,
asigna el ticket en Zoho al usuario que lo toma (assignInZohoBestEffort).
Cubre las DOS vías porque "Continuar en el chat" ya hace auto-claim.
Reglas: solo ids numéricos (los claims `pr:<n>` no viven en Zoho); NO roba
un ticket que ya tiene otro dueño; best-effort en segundo plano (si Zoho
falla, el claim y el chat funcionan igual). OJO IDENTIDAD: usa
externalUserOf(req) = principalOf(req)?.username || hostUser(), NO
actor.username — `actorOf` etiqueta al token maestro como 'token-maestro',
que sirve de label para el lock pero NO es una persona con cuenta OAuth.
