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
GET /refresh-data/status SOLO lee ese disco (staleness 12 min). NO usa el
SDK (0 tokens: comandos locales psql/infisical/pnpm — la regla 6 no
aplica). `runCmd` (exec local) se movió a refresh-shared y RECHAZA ante
terminación anormal (timeout/kill/spawn-fail sin código numérico), igual
que `git()` — el `gh` de /branches lo importa de ahí.
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
src/modules/tolkien/template-shared.js (DB plantilla DORMIDA
tolkien_template: buildTemplate = migrate deploy + 3 importers Zoho,
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
descarta dirty]) + bin/cwc-tolkien-env-runner.js. AUTO-PROVISIÓN (hook,
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
(default on). BOTONES fan-out: ⬇️ Actualizar rebasea cada worktree vivo
sobre origin/main (dirty→skip, conflicto→abort+report); 💽 Vista fresca
refresca tolkien_console (:3010) + dispara build de tolkien_template que
al terminar RE-CLONA las DBs de los entornos vivos (recloneLiveEnvs); 🔄
fetch NO cambia (.git compartido ya beneficia a todos los worktrees).
local-enter con allowlist DINÁMICA = 3010 + puertos de entornos vivos.
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

## Gotchas de esta carpeta

- Entornos Tolkien por sesión (PLAN-1815): el worktree de un entorno NO es
  config.projectDir → worldLabelFor lo reconoce por PREFIJO (ENVS_DIR), no por
  igualdad exacta. Flipear el cwd de un chat requiere MOVER su transcript (el
  --resume del SDK está indexado por projectKey=cwd) → la auto-provisión REUSA
  handoff({internal}) en vez de reinventar el move. El hook de auto-provisión se
  instala SOLO cuando cwd===config.projectDir base y en modo escribible (no
  'plan'); un runner YA VIVO no lo toma hasta reabrir/chat nuevo (mismo gotcha
  del bootstrap de Pad). La DB plantilla tolkien_template debe quedar DORMIDA
  (ALLOW_CONNECTIONS false) para poder clonarla: Postgres exige 0 conexiones a
  la fuente de un CREATE DATABASE ... TEMPLATE.
