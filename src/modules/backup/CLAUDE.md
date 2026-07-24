<!-- cwc:ficha-modulo -->
# src/modules/backup — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### backup/                   tar.gz completo (server-side, con secretos) + push del CÓDIGO al
remote `personal` (guardas: solo ese remote, URL sin Mordor-Staffing).
COMMIT SIN PUSH (2026-07-05, pedido del usuario): botón "Commit
(sin push)" del panel — commit LOCAL descriptivo de los cambios
pendientes sin tocar el remote (el push sigue commiteando con su
mensaje genérico "cwc backup <fecha>"; este botón deja historia
con mensajes en español). POST /api/backup/commit {message,
includeUntracked[]}: guardas repoSecretGuards (repo + secretos,
SIN exigir remote — extraídas de securityGuards) + selectUntracked
(las 3 capas anti-secretos del push, helper ahora COMPARTIDO por
push y commit) + sanitizeCommitMessage (sin chars de control,
tope 2000); add -u + untracked seleccionados; NO changelog, NO
restart, reversible con git reset --soft.
BOTÓN "🔁 Reiniciar el servidor" (2026-07-22, PEND-917, pedido de Niko:
"no veo el botón de reiniciar"): el panel de Backup suma, en el bloque
"Mantenimiento" junto a su hermano "🔄 Reiniciar sesiones", un botón que
reinicia el PROCESO del server (systemctl --user restart). NO son lo
mismo: "Reiniciar sesiones" (POST /api/admin/restart-runners) recicla los
MOTORES de chat; éste mata el Node de la consola — las tmux y los runners
SOBREVIVEN (KillMode=process), solo se corta la web unos segundos. Hace
falta para que el server tome CÓDIGO nuevo tras un deploy. OJO: el
endpoint NO vive acá sino en el módulo `updates` (POST
/api/updates/restart, admin, difiere el restart 300 ms para alcanzar a
responder) — existía desde antes pero estaba HUÉRFANO (ningún frontend lo
llamaba); esto es solo el cableado del botón, en `system/backup-panel.js`.
Como el server muere DESPUÉS de responder, el botón encuesta
/api/chat/list cada 1,5 s (hasta 40 intentos) hasta que vuelva a atender
— el fetch fallando mientras está caído es lo ESPERADO, no un error.
GOTCHA de testeo: `data-ref` NO es único entre paneles (el "Reciclar
runners" de Conexiones también usa data-ref="recycle") — al verificar con
Playwright, calificá por contenedor (`.bk-git [data-ref=...]`), si no da
falso positivo/negativo.
Mensaje IA: POST
/commit-message captura diff+archivos EN NODE, escribe el job en
~/.cwc-data/commitmsg/<id>.json (id determinístico por estado del
árbol ⇒ doble click = mismo job) y spawnea
bin/cwc-commitmsg-runner.js DETACHED (regla de oro; haiku, 1
turno, CERO herramientas — regla 6 con TODO denegado, patrón
projects/analyze-shared); GET /commit-message/:id solo lee disco
y el diálogo encuesta cada 1.5 s — si la IA falla, el mensaje se
escribe a mano (nunca bloquea). GET /git-info ahora expone
`dirty[]` (name-status contra HEAD, incluye stageados) además de
dirtyCount. Lógica compartida en backup/commitmsg-shared.js.
Untracked: NUNCA viajan solos — el diálogo de Push los lista con
checkbox por archivo (body {includeUntracked:[...]}) y el backend
valida la selección en 3 capas: solo lo que git lista como
untracked no-ignorado (un .env ignorado NI aparece), re-chequeo
contra SECRET_PATHS/SECRET_DIRS (403 si un secreto se coló) y
selección humana explícita archivo por archivo. Cada push exitoso
ADEMÁS: (1) agrega
una entrada EN INGLÉS a la sección "## Changelog" de README.md
(marcadores <!-- cwc:changelog:start/end -->, función
updateReadmeChangelog — commits locales sin pushear + archivos
recién stageados; si no hay nada nuevo, no toca el README) y
(2) reafirma la descripción del repo en GitHub (inglés, resume
consola+módulos) vía `gh repo edit` (best-effort: si falta gh/auth
no rompe el push, ver campo `description` de la respuesta).
PULL desde GitHub (POST /pull, admin): restauración del código —
mismas guardas, fetch + stash→merge --ff-only→pop (patrón
tolkien/update: NUNCA descarta trabajo ni fuerza nada; divergencia
= 409 con el stash repuesto). "Nada que traer" se detecta con
merge-base --is-ancestor (comparar HEAD==remote NO alcanza: local
adelante reiniciaría al pedo). Si package(-lock).json cambió corre
npm install ANTES del restart; reinicia SOLO con árbol sano (pop
conflictuado o npm roto → avisa y NO reinicia: un server sobre
archivos con marcas de conflicto entra en crash-loop).
