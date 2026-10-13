<!-- cwc:ficha-modulo -->
# src/modules/tolkien — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### tolkien/                  SOLO git del proyecto trackeado: status/fetch/update. El contexto y
las memorias editables NO viven acá — ver módulo `projects/`.
REFRESH DE DB LOCAL DESACOPLADO (2026-07-12, resolución de un hallazgo
CRÍTICO de la Revisión de Salud): el botón "Vista fresca" (TRUNCATE +
reimport de importers Zoho, ~20s a varios min) ANTES corría en background
DENTRO del proceso del server, trackeado en una variable module-level
(`dataJob`) — un reinicio de la web a mitad lo mataba sin rastro (viola la
regla de oro/regla 2). AHORA la lógica vive en `tolkien/refresh-shared.js`
+ el RUNNER DESACOPLADO `bin/cwc-tolkien-refresh-runner.js`: POST
/refresh-data (admin) reserva el job 'running' en disco
(~/.cwc-data/tolkien-refresh.json, atómico) y spawnea el runner detached;
GET /refresh-data/status SOLO lee ese disco (staleness 37 min, incluye el build
previo). NO usa el
SDK (0 tokens: comandos locales psql/infisical/pnpm — la regla 6 no
aplica). `runCmd` (exec local) se movió a refresh-shared y RECHAZA ante
terminación anormal (timeout/kill/spawn-fail sin código numérico), igual
que `git()` — el `gh` de /branches lo importa de ahí.
El refresh termina con un upsert de usuarios locales para `dev-login`.

PREFLIGHT ZOHO ANTES DE BORRAR (console:BUG-3373): tanto “Vista fresca” como
el build de `tolkien_template` validan OAuth después de compilar paquetes y
antes del primer TRUNCATE/DROP. Esto evita dejar la DB vacía cuando Zoho limita
la creación de access tokens (~10 por refresh token cada 10 min). El chequeo
consume como máximo 1 token extra compartido por clic: un lock atómico
`~/.cwc-data/tolkien-zoho-preflight.lock` serializa runners y la caché
`~/.cwc-data/tolkien-zoho-preflight.json` comparte los éxitos por 120 s y los
fallos por 60 s (para los runners del mismo clic). Los locks de más de 2 min se
recuperan como stale.

BUILD COMPARTIDO DE PAQUETES + POST-PULL (2026-10): `build-shared.js`
ejecuta en el clon principal, en serie, los mismos comandos de los entornos
efímeros (`pnpm install --frozen-lockfile --prefer-offline` + Turbo sobre
`packages/*`, con 4 GB de heap). Refresh y plantilla lo hacen ANTES de tocar
sus DB: si el build falla, no vacían ni reemplazan una DB sana. Los tres
caminos —refresh, plantilla y post-pull— se serializan con el mkdir atómico
`~/.cwc-data/tolkien-build.lock`, esperan hasta 20 min y recuperan locks de más
de 30 min; `pid.json` es solo diagnóstico. Por eso los staleness de refresh y
plantilla incluyen 25 min extra.

Cuando Actualizar mueve de verdad el SHA de `main` del clon principal, dispara
`bin/cwc-tolkien-postpull-runner.js`: recompila paquetes y, solo si termina
bien, reinicia `tolkien-console.service`. Estado y log viven en
`~/.cwc-data/tolkien-postpull.{json,log}`; `GET /postpull-status` (host-admin,
igual que refresh-status) solo lee el estado persistido. El request no espera
el build y el runner sobrevive reinicios de la consola. En una rama feature el
criterio de disparo es `main` antes/después del fast-forward; en main es HEAD
antes/después del pull. Un no-op o un conflicto al reaplicar stash no dispara.

## Refresh completo de fuentes (PLAN-3236 D)

- `sources-shared.js` + `bin/cwc-tolkien-sources-runner.js` persisten job/log en `~/.cwc-data/tolkien-sources.*`.
- Orden: identity-map → desk-field-options → equipo dev → desk-catalogue → desk-source → Pad → GitHub.
- `desk-field-options` corre primero en dry-run, extrae el source digest del plan y recién entonces aplica con `--confirm-source-digest`; el destino es la DB local guardada, por lo que ese dry-run automatizado es la revisión y el digest garantiza que se aplique la misma fuente.
- Desk está dividido en `desk-catalogue` (solo `runDeskSync`, timeout 15 min) y `desk-source` (solo `runDeskSourceSync`, timeout 25 min); `desk` conserva ambos como alias manual.
- `desk-source` persiste por ticket y omite snapshots vigentes en la corrida siguiente. Si vence su timeout queda `ok:false`, `partial:true` con detalle de continuación incremental; el resultado global ignora ese parcial y continúa con Pad/GitHub.
- El runner continúa tras fallos por fuente; solo el guard de refresh base aborta para no competir con TRUNCATE.
- El glue `bin/cwc-tolkien-glue.mts` valida DB localhost:5435/tolkien_* antes de importar Tolkien.
- Redis y todas las URLs DB por rol quedan unset; solo `DATABASE_URL` apunta a la DB local.
- Pad toma `PAD_API_TOKEN` únicamente de `/kamal` con `infisical secrets get`; el token nunca se loguea.
- GitHub corre sin Infisical ni credenciales Teams, por lo que no puede enviar DMs de alerta.
- POST `/sources-refresh` y GET `/sources-refresh/status` son exclusivos del host-admin.
- El timer decide cada 5 min, solo lun-vie 07:00–19:00 Bogotá y con antigüedad ≥30 min; un job `running` recién se considera stale a los 60 min para no duplicar la corrida larga.
- `CWC_TOLKIEN_SOURCES_AUTO=0` desactiva el timer; el trabajo siempre queda en el runner detached.
STACK N2 POR INQUILINO (console:PLAN-2264, bloque B4): un usuario puede
reclamar a demanda SU Postgres + Redis sin caer sobre el proyecto Compose del
usuario de SO compartido. `stack.js` persiste en el HOME DEL HOST
`~/.cwc-data/tolkien-stacks/<user>.json` (atómico, mode 600) una identidad
estable: `COMPOSE_PROJECT_NAME=tolkien-<usuario-de-consola>` + índice propio
para los cuatro puertos DB/Redis/console/API. La primera asignación reserva los
cuatro contra asignaciones persistidas y bindings reales; cada subida los
revalida y solo tolera un binding si Docker demuestra que pertenece al mismo
proyecto. GUARD DURO: un inquilino nunca puede resolver a `tolkien-nmosquera`
ni compartir proyecto/puerto con otro usuario. `POST /stack/up {sessionId}`
agrega el claim owner-scoped y dispara
`bin/cwc-tolkien-stack-runner.js`; `POST /stack/down` NO fuerza nada: reconcilia
claims y solo dispara `docker compose down` si quedaron cero; `GET
/stack/status` consulta el estado persistido. El runner inyecta SIEMPRE las
cinco variables de identidad; la primera subida invoca el `scripts/onboard.sh`
EXTERNO del clon con `--yes`, las siguientes hacen `compose up` directo.
CLAIMS SIN TTL (criterio C7): cada entrada es `{sessionId,owner,ts}` y solo se
retira ante liveness `dead` confirmado. Se reutilizan `chats.json` (un chat
dormido/archivado sigue vivo), el socket del chat-runner como señal positiva y
`tmux has-session -t =nombre` + `session-owners.json` para terminales. Archivo
ausente/corrupto, owner dudoso o error de inspección = `unknown` ⇒ CONSERVAR.
El runner vuelve a reconciliar bajo lock inmediatamente antes de `down`; ese
lock también impide aceptar un claim nuevo a mitad del apagado. Nunca hay
reaper, TTL ni timer propio para decidir la vida de este stack.
ENTORNOS TOLKIEN EFÍMEROS POR SESIÓN (PLAN-1815, 2026-07-24): resuelve
el choque de sesiones PARALELAS que editan Tolkien sobre la ÚNICA carpeta
~/tolkien. Modelo: `~/tolkien` = repo BASE (.git compartido, main fresco,
fuente de worktrees); :3010/tolkien_console = entorno base por defecto
(read-only/miradas rápidas). Cada sesión que va a MODIFICAR Tolkien
obtiene un ENTORNO propio = git worktree
(~/.cwc-data/tolkien-envs/<id>/tree, rama cwc-env/<id>) + DB clonada
tolkien_env_<id> (createdb TEMPLATE tolkien_template, segundos) +
dev-server next dev en un puerto del pool (CWC_TOLKIEN_ENV_PORTS, default
3012-3020) como unit systemd TRANSITORIA tolkien-env-<id>.service
(sobrevive reinicio de la consola, regla 2). Archivos:
Desde 2026-10 cada launch instala dependencias y compila `packages/*` a `dist/` antes de migrar/levantar Next; Turbo cachea los reinicios (`console:BUG-3243`).
src/modules/tolkien/template-shared.js (DB plantilla DORMIDA
tolkien_template: buildTemplate = migrate deploy + 3 importers Zoho,
luego `local-users.js` siembra los usuarios locales antes de sellarla,
luego IS_TEMPLATE true/ALLOW_CONNECTIONS false → clonable sin chocar con
la restricción de 0 conexiones de CREATE DATABASE ... TEMPLATE;
cloneTemplateInto/dropEnvDb/recloneLiveEnvs) +
bin/cwc-tolkien-template-build.js · src/modules/tolkien/env-store.js
(registro ~/.cwc-data/tolkien-envs/<id>.json atómico, pool de puertos,
cap CWC_TOLKIEN_MAX_ENVS default 4, naming determinista por chatId +
validación anti-traversal) · src/modules/tolkien/env-shared.js
(createWorktree SÍNCRONO [lo llama el hook, ~2s], provisionEnv
desacoplado, teardownEnv con GUARDA de dirty [no descarta cambios sin
commitear salvo force], reattachEnvs [reconcilia registro vs systemctl
--user is-active tras reinicio], reapEnvs [idle, force:false — NUNCA
descarta dirty; acepta activeChatIds: un entorno cuyo chat tiene el motor
VIVO es intocable por el corte de idle, console:BUG-2086]) +
bin/cwc-tolkien-env-runner.js. AUTO-PROVISIÓN (hook,
PLAN-1819): un chat cuyo cwd es EXACTAMENTE el Tolkien base (no un
worktree) en modo escribible instala un hook PreToolUse
(tolkienEnvPreToolUseHook de core/tool-policy.js, arg --tolkien-env-auto)
que al PRIMER Edit/Write/MultiEdit/NotebookEdit —o delegate_to_codex en
Tándem— DENIEGA una vez ('creando tu entorno') y emite
'tolkien-env-needed' al server → ChatManager.provisionTolkienEnvForChat:
worktree síncrono + DB/dev-server async (spawnEnvProvision) + REUSA
handoff({internal:true}) para MOVER el transcript al projectKey del
worktree, flipear cwd y respawnear → el write reintentado cae en el
worktree. El hook se instala SOLO por-spawn en cwd=base (NO es global:
chats de Consola o ya-en-worktree no lo ven). worldLabelFor reconoce los
worktrees bajo ENVS_DIR como 'Tolkien'. Feature flag CWC_TOLKIEN_ENV_AUTO
(default on). CONTRATO DE CONTEXTO (Pad local `console:PLAN-2072`, hijo de
PLAN-1815,
2026-07-27): un `git worktree add` materializa SOLO lo trackeado, pero el
marco operativo de Tolkien es untracked por diseño (`CLAUDE.local.md`,
`.cwc-ticket-playbook.md`, `.env`, `.claude/settings.local.json`) y Claude
Code deriva del cwd un projectKey nuevo con `memory/` vacía. Como el handoff
muda transcript+cwd pero no ese marco, la sesión conservaba el historial y
fallaba EN SILENCIO sin reglas/playbook/memorias/credenciales. `env-shared.js`
exporta `ENV_CONTEXT_LINKS`, `claudeProjectDirFor(cwd)` (reemplaza `/` y `.`
por `-`), `seedEnvContext(worktree)` y `verifyEnvContext(worktree)`. El seed
crea SYMLINKS hacia los cuatro artefactos del base + hacia `memory/` del
projectKey base, y escribe `.pad.toml` con `workspace = "tolkien"` para fijar
el Pad LOCAL frente al workspace cloud homónimo; es idempotente, nunca pisa
un archivo real, aísla fallos puntuales y devuelve
`{linked,already,skipped,conflicts,padToml}`. `createWorktree()` lo ejecuta
en sus DOS returns (también reconcilia un worktree viejo ya existente);
`verifyEnvContext` es read-only y devuelve `{ok,missing}`. `teardownEnv()`
borra el symlink `memory/`, NUNCA el projectKey ni sus transcripts. El
disparador NO cambió: sigue en el primer Edit/Write/delegación para que chats
de solo lectura no consuman el cap 4/pool 9; el contexto ya está completo
antes de la mudanza. BOTONES fan-out: ⬇️ Actualizar rebasea cada worktree vivo
sobre origin/main (dirty→skip, conflicto→abort+report); 💽 Vista fresca
refresca tolkien_console (:3010) + dispara build de tolkien_template que
al terminar RE-CLONA las DBs de los entornos vivos (recloneLiveEnvs); 🔄
fetch NO cambia (.git compartido ya beneficia a todos los worktrees).
local-enter con allowlist DINÁMICA = 3010 + puertos de entornos vivos.
`local-enter` resuelve identidad por principal: host usa env/identidad; tenant
lee instance.json crudo → Infisical propio → login-job exitoso. Falla cerrado
si falta email o coincide con el host; nunca usa defaults mergeados del host.
`local-users.js` centraliza resolución, dedupe admin y upsert local; si el primer
dev-login falla, repara la DB objetivo y reintenta una vez con cookies nuevas.
PUERTOS RESERVADOS (`console:BUG-2076`): hubo tres records con 3012 porque
allocatePort() filtraba por isEnvAlive, pero `down`/`error` describe al
DEV-SERVER, no al entorno. Ahora considera ocupado el puerto de TODO record
cuyo worktree exista en disco, sin importar status. atCap() DELIBERADAMENTE
sigue usando isEnvAlive: limita dev-servers concurrentes, no worktrees
persistidos. Además ensureFreePort(rec), en env-shared.js, revalida antes de
writeLaunchScript tanto en provisionEnv como en recloneLiveEnvs: si otro
record con worktree vivo reclama el puerto guardado, asigna otro, lo persiste
con patchEnv y lo loguea; si el pool se agotó devuelve null, marca ese entorno
en error y el barrido continúa. Nunca se levanta sobre un puerto ajeno.
UI: panel colapsable de entornos en la tarjeta Tolkien
(public/js/modules/tolkien/tolkien.js). Health check `tolkien-envs`
(registro vs worktrees huérfanos). :3011 'Tolkien pruebas' ELIMINADO
(redundante, colisionaba la cookie host-only tolkien.session con :3010).
GOTCHA cookie host-only: `tolkien.session` es por-HOST no por-puerto → N
dev-servers pelean por un login en el browser; local-enter?port=
re-inyecta al entrar → se trabaja UN entorno a la vez en el navegador
(aceptable, documentado). ESTADO (2026-07-24): código COMPLETO y
verificado (node --check en todos los archivos), pero DORMIDO — falta (a)
construir tolkien_template por 1ª vez
(node bin/cwc-tolkien-template-build.js, hace el import Zoho real) y (b)
reiniciar la consola para activar el hook; ambos pendientes de E2E
supervisado.
ACTUALIZAR = MAIN LOCAL SIEMPRE FRESCO (2026-07-10, pedido de Niko:
"el botón no hacía nada"). CAUSA RAÍZ: el viejo /update hacía `pull
--ff-only` sobre la RAMA ACTUAL — parado en una rama feature decía
"Already up to date" y tu main local quedaba viejo, pero el semáforo
comparaba HEAD vs origin/main (mezclando "lo de Chris" con "lo tuyo")
así que el contador nunca bajaba. AHORA POST /update: (1) fetch
--prune SIEMPRE; (2) si estás en `main` → stash→pull --ff-only→pop de
siempre (flujo cuidadoso, nunca descarta trabajo); (3) si estás en una
RAMA FEATURE → `git fetch origin main:main` adelanta tu main LOCAL a
origin/main SIN checkout ni tocar tu rama/working tree (git rechaza el
ff si main divergió → devuelve `warn`, no fuerza). status() suma
`mainBehind` (commits de origin/main que tu main local no tiene — la
pregunta REAL "¿mi base está fresca para pushear?", independiente de en
qué rama estés) + `onMain`; el semáforo del front pasó a leer mainBehind
(no HEAD..origin/main). GET /branches (nuevo, gh): mis PRs ABIERTOS
base main (`gh pr list --author @me --state open`) + por cada uno cuántos
commits de main le faltan a su rama (`origin/<rama>..origin/main`) — la
"verdad" de qué propuse y Chris aún no mergeó (detecta squash-merges);
best-effort (sin gh/auth → lista vacía, el panel no muestra el indicador).
POST /rebase-branch (admin, nuevo): rebasa la rama ACTUAL sobre
origin/main para seguir en paralelo sobre lo último de Chris —
conflicto ⇒ `git rebase --abort` ⇒ rama EXACTAMENTE como estaba (dirty
⇒ stash antes/pop después); tras rebase OK avisa `needsForcePush`.
Solo rebasa la rama en la que estás parado (no hace checkout de otra =
seguro). Front (tolkien.js): línea 🌿 "N PRs sin mergear" (ícono ramas,
🟡 si alguno quedó atrás de main, 🟢 si están al día/ninguno) clic →
ventana openBranchesDialog con la lista (#N + título + ↓N sobre main) y
el botón "Poner al día" SOLO en la rama actual atrasada; Actualizar
re-consulta /branches (si Chris mergeó un PR, sale de la lista solo).
La consulta gh NO va en el auto-refresh de 5 min (red): solo al montar,
tras Actualizar y al abrir la ventana.

## Sala con entorno: preview y publicación (PLAN-3236 E4/E5)

- `visado/lecturas/preview` expone a participantes solo id, puerto, estado,
  rama, liveness y la URL de entrada; nunca worktree ni unidad.
- `local-enter` conserva el flujo base y admite el puerto de una sala al
  host-admin o a sus participantes, con identidad propia y gates fail-closed.
- `tolkien.env.push` es host-only/visado: commitea en inglés, valida el origin
  corporativo, pushea sin force y abre o reutiliza un PR siempre borrador.
- La rama publicable es únicamente `cwc-env/<id>` del record del entorno.

## Gotchas de esta carpeta

- Infraestructura del host (`POST /refresh-data`, `GET /refresh-data/status`,
  `GET /postpull-status`,
  `GET /envs`, `GET /envs/:id`, `POST /envs/provision`, `POST
  /envs/:id/teardown`, `POST /envs/:id/push`) exige `isAdmin && scope.isHost`:
  `admin` no implica ser host. Desde una sala, el catálogo cerrado de visado
  permite pedir las operaciones nominales y las ejecuta con la autoridad del
  dueño que las aprueba.
- Stack N2 ≠ entornos efímeros: el primero es UN Postgres+Redis persistente por
  USUARIO y vive por referencia contada de sesiones; los segundos son
  worktree+DB+dev-server por CHAT. No reutilizar el reaper idle de entornos para
  el stack N2: aunque una sesión lleve una semana quieta, su claim se conserva
  hasta confirmar que murió.
- `scripts/onboard.sh` pertenece al repo EXTERNO de Tolkien: no se modifica
  desde Mi Consola. El aislamiento se aplica únicamente inyectando
  `COMPOSE_PROJECT_NAME`, `DB_HOST_PORT`, `REDIS_HOST_PORT`,
  `CONSOLE_HOST_PORT` y `API_HOST_PORT` desde el runner.
- `isEnvAlive` describe el DEV-SERVER, no el entorno. No filtrar por esa señal
  decisiones sobre recursos persistentes (puerto, DB, marco o limpieza): el
  criterio correcto casi siempre es si el worktree existe en disco. atCap() es
  la excepción deliberada porque su recurso sí son los dev-servers concurrentes;
  no "unificar" ambos criterios.
- Entornos Tolkien por sesión (PLAN-1815): el worktree de un entorno NO es
  config.projectDir → worldLabelFor lo reconoce por PREFIJO (ENVS_DIR), no por
  igualdad exacta. Flipear el cwd de un chat requiere MOVER su transcript (el
  --resume del SDK está indexado por projectKey=cwd) → la auto-provisión REUSA
  handoff({internal}) en vez de reinventar el move. El hook de auto-provisión se
  instala SOLO cuando cwd===config.projectDir base y en modo escribible (no
  'plan'); un runner YA VIVO no lo toma hasta reabrir/chat nuevo (mismo gotcha
  del bootstrap de Pad). La DB plantilla tolkien_template debe quedar DORMIDA
  (ALLOW_CONNECTIONS false) para poder clonarla: Postgres exige 0 conexiones a
  la fuente de un CREATE DATABASE ... TEMPLATE. `console:BUG-2092`: ese
  `handoff()` reusado corre a MITAD de turno, cuando el SDK todavía no escribió
  el transcript — por eso `moveTranscript()` tolera el origen inexistente y la
  provisión espera el cierre del turno antes de mudar. Y "tener entorno" no es
  "estar dentro del entorno": mientras el `cwd` siga siendo el base, el hook debe
  quedar instalado y la mudanza se REINTENTA, o la sesión termina escribiendo en
  el repo base sin aislamiento.
- Contexto de entornos (`console:PLAN-2072`): los symlinks son
  BIDIRECCIONALES — editar
  `CLAUDE.local.md` desde un worktree edita el archivo REAL de `~/tolkien`; es
  deliberado para que una lección promovida se propague al instante y nunca
  quede stale. `.pad.toml` DEBE estar ignorado en Tolkien: vive en el
  `.git/info/exclude` LOCAL compartido por todos los worktrees, junto a los
  otros artefactos operativos. Si se suma un link a `ENV_CONTEXT_LINKS` o un
  archivo generado, verificar ANTES que esté ignorado; un untracked deja
  `git status --porcelain` dirty, bloquea `teardownEnv()` y puede colarse en un
  PR.
- El corte por idle del reaper NO mide actividad de la sesión por sí solo
  (`console:BUG-2086`): `heartbeat(id)` se escribe en `provisionEnv()` y lo refresca
  `Chat._touchEnv()` desde `chat/index.js` (throttle de 5 min, disparado por
  `_onRunnerEvent`). Si algún día se spawnea un entorno por un camino que NO pase por
  un chat con `tolkienEnv` seteado, ese entorno nace con el latido congelado y el
  reaper lo desaloja a las 6h aunque esté en uso. La segunda red es `activeChatIds`,
  no el latido. `teardownEnv()` ya NO borra NUNCA la rama `cwc-env/<id>`
  (`console:BUG-2142`): antes sólo la conservaba cuando
  `git rev-list --count <base>..<branch>` daba > 0, pero la rama no es un residuo
  condicionado a tener commits propios sino la IDENTIDAD persistente de la sesión.
  `envIdForChat(chatId)` es determinístico, por lo que un chat vuelve siempre a la
  misma rama, y `createWorktree()` se reengancha sobre ella cuando existe. Borrarla
  por «no tener commits» hacía que la reconstrucción naciera desde `main` y
  devolviera un aislamiento hueco: entorno correcto, historia de trabajo vacía.
  Se prefiere una rama de más —barata, sin worktree y recuperable— a una identidad
  perdida. Esto ENDURECE el C5 de `console:BUG-2086`; no lo contradice.
- Reprovisión perezosa (`console:PLAN-2172`): `createWorktree(id,
  baseRef='main')` devuelve `{ worktree, branch, reused }`. `reused: true`
  informa que reconstruyó sobre una rama o un worktree preexistente;
  `reused: false`, que el entorno nació de cero. El dato no gobierna la
  reconstrucción: `chat/index.js` sólo lo consume para contarle al usuario si
  RECUPERÓ su entorno o recibió uno nuevo. Es un campo aditivo, por lo que ningún
  call-site anterior se rompe.
