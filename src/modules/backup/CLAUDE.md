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
bin/cwc-commitmsg-runner.js DETACHED (regla de oro; sonnet, 1
turno, CERO herramientas — regla 6 con TODO denegado, patrón
projects/analyze-shared); GET /commit-message/:id solo lee disco
y el diálogo encuesta cada 1.5 s — si la IA falla, el mensaje se
escribe a mano (nunca bloquea). GET /git-info ahora expone
`dirty[]` (name-status contra HEAD, incluye stageados) además de
dirtyCount. Lógica compartida en backup/commitmsg-shared.js.
Untracked: NUNCA viajan solos — el diálogo de Push los lista con
checkbox por archivo (body {includeUntracked:[...]}) y el backend
valida la selección en 3 capas: solo lo que git lista como
untracked no-ignorado (un .env ignorado NI aparece), re-chequeo con
isSecretPath() (403 si un secreto se coló) y
selección humana explícita archivo por archivo. Cada push exitoso
ADEMÁS: (1) agrega
una entrada EN INGLÉS a la sección "## Changelog" de README.md
(marcadores <!-- cwc:changelog:start/end -->, función
updateReadmeChangelog — commits locales sin pushear + archivos
recién stageados; si no hay nada nuevo, no toca el README) y
(2) reafirma la descripción del repo en GitHub (inglés, resume
consola+módulos) vía `gh repo edit` (best-effort: si falta gh/auth
no rompe el push, ver campo `description` de la respuesta).
(3) encola la redacción de 🆕 Novedades (`bin/cwc-news-runner.js`)
fire-and-forget: un fallo ahí jamás convierte el push en error, y los commits
`cwc backup …` viajan en el detalle técnico pero se omiten del prompt.
PULL desde GitHub (POST /pull, admin): restauración del código —
mismas guardas, fetch + stash→merge --ff-only→pop (patrón
tolkien/update: NUNCA descarta trabajo ni fuerza nada; divergencia
= 409 con el stash repuesto). "Nada que traer" se detecta con
merge-base --is-ancestor (comparar HEAD==remote NO alcanza: local
adelante reiniciaría al pedo). Si package(-lock).json cambió corre
npm install ANTES del restart; reinicia SOLO con árbol sano (pop
conflictuado o npm roto → avisa y NO reinicia: un server sobre
archivos con marcas de conflicto entra en crash-loop).

REGLA 8 — RETENCIÓN DE BACKUPS (2026-07-26, BUG-2044): se conservan
10 archivos por conjunto, con cupos INDEPENDIENTES para
`cwc-backup-*.tar.gz` y `pad-backup-*.db` porque tienen tamaños y ritmos
distintos. La antigüedad se decide por `mtime` real, nunca por el nombre.
Cada conjunto se poda únicamente después de crear con éxito un backup de
ese mismo tipo; un fallo no habilita el borrado de respaldos anteriores.
Al podar un `.db` también se borran sus sidecars `.db-shm`/`.db-wal`.
Toda corrida de poda loguea cantidad, nombres y bytes liberados, incluso
si no había excedente. `KEEP_PER_SET` es la constante exportada y la UI
lista ambos conjuntos con tamaño y muestra la política vigente. La poda
no se ejecuta al listar ni al arrancar: solo después de `POST /create`.

CLASIFICACIÓN DE SECRETOS (2026-07-31, `console:BUG-2528`): la denylist
anti-secretos NO es una sola lista — son TRES, con reglas de match distintas
a propósito, y `isSecretPath()` las aplica en ese orden:
- `SECRET_BASENAMES` (`.env`) → secreto POR NOMBRE: matchea por basename en
  CUALQUIER nivel del árbol. Es el fix de BUG-15 y no se toca.
- `SECRET_ROOT_FILES` (`users.json`, `sessions.json`, `recents.json`,
  `titles.json`) → secreto POR LUGAR: es estado de runtime que el server
  escribe en `PROJECT_DIR` y solo existe ahí. Matchea SOLO como ruta exacta
  de raíz.
- `SECRET_DIRS` (`certs`) → secreto POR DIRECTORIO: matchea como segmento en
  cualquier nivel (`app/certs/key.pem`).
- `SECRET_ROOT_NAMES` = la unión de los tres, para los DOS usos que necesitan
  nombres de raíz: el loop de `check-ignore` de `repoSecretGuards()` y la
  lista `excluded` que `GET /git-info` muestra en la UI.
POR QUÉ importa: BUG-15 había ensanchado el match a basename para cazar
secretos anidados (`sub/.env`), pero eso arrastró a los cuatro `.json` de
estado, cuyos nombres son genéricos. El diccionario i18n legítimo
`public/i18n/en/sessions.json` quedaba clasificado como fuga y el `403` de
`selectUntracked()` sale ANTES del `git add -u`, así que un solo archivo mal
clasificado abortaba el commit ENTERO (67 cambios), no solo ese archivo.
NO ensanchar `SECRET_ROOT_FILES` a match por basename: es exactamente el bug.
Tampoco renombrar el archivo i18n para esquivar el detector — eso es esconder
el síntoma, prohibido por `console:CONVE-2336`.
