<!-- cwc:ficha-modulo -->
# src/modules/updates — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### updates/                  CENSO CENTRALIZADO de versiones de TERCEROS + APLICADO reversible con
verificación (2026-07-21, PLAN-779, pedido de Niko: "no hay mecanismo que
avise cuándo salen updates de lo que la consola depende de afuera").
Pestaña "🔄 Actualizaciones" del grupo 🩺 Diagnóstico del menú Sistema.
Responde la pregunta que hoy nadie miraba: qué de las dependencias EXTERNAS
(no el código propio, que ya cubre Salud/Coherencia) quedó viejo o con CVE.
GET /api/updates (autenticados, 0 tokens IA — todo determinístico, mismo
espíritu que core/inventory.js y `mcps`): corre EN PARALELO `npm outdated
--json` + `npm audit --json --omit=dev` + `npm view @anthropic-ai/claude-code
version` + `claude --version` + `apt list --upgradable` + `pad/node/tmux/
zerotier --version` (todo LECTURA, ningún comando muta). Clasifica cada lib
npm por riesgo: 🧬 core (Agent SDK — motor de TODO chat/runner) · 🔴 watch
(baileys, fijado a propósito, ver comms/) · 📦 lib (normal). Es subprocess
CLI (como tolkien/refresh corre psql/git; NO es corrida del SDK → la regla 6
NO aplica). Caché 6 h en `~/.cwc-data/updates-census.json` (atómica; fallback
a disco tras reinicio antes de re-correr los npm lentos) + ?fresh=1.
APLICADO (admin, decisión de Niko 2026-07-21): botón SOLO en lo REVERSIBLE.
POST /updates/npm {pkg,version} — whitelist ESTRICTA: nombre válido
(PKG_NAME_RE) + versión semver (VERSION_RE) + declarado en package.json +
NO en NEVER_UPDATE (baileys); corre `npm install pkg@ver` + node --check
(syntaxCheck de shared.js) y devuelve {syntax, needsRestart, revertHint}
(revertible con `git checkout -- package.json package-lock.json && npm
install`). POST /updates/claude-cli — `claude update` (updater propio del
CLI, no toca el repo). apt/SO: SOLO informativo (comando `sudo apt-get
install --only-upgrade <pkg>` para copiar; NO se aplica desde la web — se
mezcla con docker/systemd, mayor radio de impacto). REINICIO SEPARADO: POST
/updates/restart (systemctl --user restart, diferido tras responder) es un
botón APARTE "🔁 Reiniciar y verificar" — NUNCA dentro de "Actualizar", para
que Niko elija el momento (el Agent SDK exige reinicio para tomar efecto pero
corta las sesiones activas). GET /updates/verify = node --check a demanda; el
semáforo completo lo trae el front de GET /api/health/checks (existente). VIGILADAS
sin botón (WATCHED): baileys (rompió una vez), endpoints no oficiales (medidor
de Codex, OAuth usage de Anthropic — best-effort a propósito). Lógica en
updates/shared.js (buildUpdatesCensus/syntaxCheck), frontend
system/updates-panel.js (mountUpdatesPanel; look .hr-* de health-review-modal,
secciones colapsables 🧬 Motor · 🔐 Seguridad · 📚 Librerías · 🐧 SO · ⚙️
Servicios · ⚠️ Vigiladas; layout de 2 COLUMNAS por ítem — texto grande /
estado-versión chica). Verificado E2E: censo real (Agent SDK, vulns, apt,
libs) + panel Playwright sin errores JS.
ÍTEMS DESPLEGABLES CON "¿QUÉ ES ESTO?" (2026-07-21, pedido de Niko: "que
cada ítem se pueda desplegar y me muestre una breve descripción para
entender y si es necesario indagar más adelante en una sesión"). Cada ítem
del panel pasó de tarjeta plana a COLAPSABLE (helper `collapsible()` en
updates-panel.js, markup compatible con el `wireToggles()` existente:
.hr-finding/.hr-f-head/.hr-f-body + hr-collapsed): colapsado muestra solo
nombre + versión/estado; al desplegarlo aparece la descripción. Los datos
son DETERMINÍSTICOS (0 tokens): catálogos hand-authored en shared.js —
`PKG_INFO` (los ~21 paquetes npm reales, con `what` = qué es y `role` =
para qué lo usa ESTA consola), `SERVICE_INFO` (Pad local/Node/tmux/
ZeroTier) y `APT_INFO` (paquetes de sistema notables; el resto cae a un
texto genérico). Lo no catalogado usa como fallback el `description`
oficial leído de node_modules/<pkg>/package.json (instantáneo, SIN red).
Además `buildUsageMap()` hace UN solo `grep -rlE` sobre src/bin/public/js
y atribuye por archivo → campo `usedIn` (hasta 6 archivos por paquete) que
se muestra como "Dónde se usa" — el gancho para indagar después en una
sesión. El wiring del `info` va DESPUÉS del bloque que agrega los
CORE_PKGS faltantes y ANTES del `libs.sort()` (así los core también lo
reciben). `wireToggles()` ignora clicks en `button, input, label` para que
tildar el checkbox de un major no colapse la tarjeta. OJO: el panel lista
solo los paquetes DESACTUALIZADOS (+ los core), porque `npm outdated`
omite los que están al día — un paquete sano no aparece ni con su
descripción. Verificado E2E (Playwright): 25 ítems colapsados con chevron,
"Qué es:"/"Para qué lo usa la consola:"/"Dónde se usa:" presentes, y al
desplegar Pad local aparece su descripción; 0 errores JS.
BOTÓN ÚNICO ORQUESTADO (2026-07-21, rediseño pedido de Niko: "una sola
actualización que planee el orden, drene lo que corre por interfono,
actualice todo a lo más reciente-estable, reinicie y mande continuar").
"🚀 Actualizar todo (orquestado)" → POST /updates/run (admin) reserva el job
y spawnea el RUNNER DESACOPLADO bin/cwc-updates-runner.js (lógica en
updates/orchestrate-shared.js). Es el ÚNICO runner que REINICIA el servicio
y SOBREVIVE a ese reinicio (detached + KillMode=process, igual que los
chat-runners que se re-enganchan tras un restart — regla de oro/regla 2).
FASES (estado en ~/.cwc-data/updates-job.json, heartbeat, REANUDABLE):
planning (censo fresco + buildPlan ordenado: reversibles primero, apt al
final) → draining (notifyInterfono broadcast 'all' vía core/bus.js +
detectActiveWork con collectActiveRunners de health/shared; espera ACOTADA
90s a que el fondo repose — no bloquea, los runners igual sobreviven) →
applying (npm SOLO a `wanted`/estable in-range · claude update · apt-get
upgrade con `sudo -n`) → verifying (node --check de server.js + todos los
bin/*.js; si falla ⇒ ABORTA sin reiniciar + hint de revert) → restarting
(systemctl --user restart, el runner espera con waitServiceActive) →
resuming (interfono de continuación + job done). DECISIONES DE NIKO
(AskUserQuestion 2026-07-21): "estable conservador" = npm SOLO a `wanted`;
los SALTOS MAYORES (latest fuera del rango) se LISTAN aparte ("requieren tu
OK") con CHECKBOX de opt-in por paquete (destildado; los tildados viajan en
`includeMajors` del POST /updates/run, validados declarados+no-watch →
buildPlan `majorsToApply` → el runner los instala a `latest` tras los
in-range, mismo node --check+abort; aviso: un major puede romper en RUNTIME,
node --check solo caza sintaxis). Sin tilde NO se aplican solos.
ACTUALIZADOR CON CRITERIO (2026-07-21, pedido de Niko: "que el orquestador
verifique con la documentación oficial si un update es riesgoso"). CUATRO
capas nuevas: (A · VULNERABILIDADES) `applyAuditFix` = `npm audit fix` SIN
--force (solo arreglos in-range, reversibles) — paso PRIMERO del orquestador
+ botón standalone "🔐 Arreglar vulnerabilidades" (POST /updates/audit-fix,
0 reinicio) + `plan.vulnFix`. (B · ANÁLISIS DE RIESGO IA) módulo
`updates/analyze-shared.js` + runner DESACOPLADO `bin/cwc-updates-analyze-runner.js`:
por cada salto MAYOR baja el changelog oficial con Node/`gh` (repo
PerpetualSoftware/pad… no, el repo del paquete vía `npm view repository.url` →
`gh api repos/O/R/releases`, determinístico 0 tokens) y una corrida IA
READ-ONLY doble capa (regla 6: Read/Grep/Glob, settingSources [], sonnet,
pool max 3) lee CÓMO el proyecto usa el paquete + cruza los breaking changes →
veredicto {level seguro|riesgoso|rompe, confidence alta|media|baja, why,
breakingChanges, usedApis}. Persistido en ~/.cwc-data/updates-risk.json
(heartbeat). POST /updates/analyze (spawn) · GET /updates/risk (0 tokens).
(C · ORQUESTADOR CON VEREDICTO) buildPlan(census, scope, includeMajors,
verdicts): un major NUNCA se auto-incluye por veredicto IA; `auto` queda
siempre `false` y el salto mayor entra SOLO si Niko lo tilda en
`includeMajors` (`forced`). Las BETAS/RC nunca (`isPrerelease`: OJO — sin \b,
"rc13" no tenía boundary). El veredicto NO es garantía (un changelog puede
omitir algo) → informa el riesgo y la UI, pero no decide la instalación. El
front pinta el veredicto por major (🟢🟡🔴 + por qué) y el checkbox aparece en
todo major no bloqueado para admin. (D · PAD LOCAL) `padLatest()` en shared.js:
`gh api repos/PerpetualSoftware/pad/releases/latest` (ignora RC) vs
`pad --version` → el ítem de servicios muestra "0.9.2 → 0.10.0" si hay update;
NO se aplica desde el botón (el binario self-hosted + su servicio systemd se
cambian a mano por SSH). CACHÉ: el runner llama `invalidateCensusCache()`
(borra updates-census.json) tras aplicar — si no, el server tras el reinicio
(mem=null) servía el snapshot PRE-update y la UI seguía mostrando "por
actualizar" lo ya aplicado (bug reportado por Niko, 2 veces). REGLA DURA:
NUNCA sugerir/ejecutar `sudo reboot` de la MÁQUINA (pedido enfático de Niko
2026-07-21, ver memoria feedback-nunca-reboot-maquina) — el reinicio del
SERVICIO (systemctl --user restart) sí; el reboot-required del SO se muestra
como dato NEUTRO sin nag (interfono/job/panel ya no lo empujan). Verificado E2E: Pad 0.9.2→0.10.0 detectado, npm audit
fix arregla las 2 vulns, análisis IA produce veredictos reales
(@xterm/addon-web-links → riesgoso/baja sin changelog = conservador correcto),
buildPlan exige tilde para cualquier major y excluye rompe/beta, Playwright 0
errores.
🔴 INCIDENTE REAL + ENDURECIMIENTO (2026-07-21). Qué pasó: el botón aplicó
`cookie` 1→2 (tildado por Niko pese al veredicto IA 🟡 riesgoso/confianza
baja). cookie v2 RENOMBRÓ su export `parse` → `parseCookie`; `src/core/auth.js`
importaba `{ parse }` → `SyntaxError: The requested module 'cookie' does not
provide an export named 'parse'` → el server entró en CRASH-LOOP (systemd
reintentó 5+ veces) y se PERDIÓ EL ACCESO WEB. Se arregló adaptando el import
a la API nueva (commit `10e5b7d`), no revirtiendo. Los tres eslabones que
fallaron: (1) `node --check` es CIEGO a esto — solo parsea sintaxis, un import
inexistente falla en runtime; (2) `waitServiceActive` solo consultaba
`systemctl is-active`, que durante un crash-loop reporta "active/activating"
transitoriamente → el runner mandó "✅ podés continuar" con la consola caída;
(3) el checkbox de opt-in permitía forzar un major que la IA no pudo verificar.
CINCO ENDURECIMIENTOS (pedido de Niko tras el incidente): (1) VERIFICACIÓN
HTTP REAL + AUTO-REVERT — `httpAlive()` (orchestrate-shared.js) pega a
`https://<IP ZeroTier>:<puerto>/api/health/checks` con node:https
(rejectUnauthorized:false, cert self-signed) usando `findZeroTierIp` +
`config.port`; `serviceRestartCount()` lee `NRestarts` de systemd. El runner
guarda NRestarts ANTES de reiniciar y tras el restart declara FALLA
CONFIRMADA si `alive===false` O `restartsAfter > restartsBefore+1` (crash-loop)
→ fase `reverting` → `revertNpmChanges()` (git checkout de package.json/lock +
npm install) → reinicia → re-verifica → job en `error` + interfono de aviso.
PRINCIPIO DURO: se auto-revierte SOLO ante evidencia POSITIVA de falla; si
`alive===null` (no se pudo verificar: sin IP/token) NO se revierte, se marca
`verifySkipped:true` y sigue. (2) BLOQUEO POR VEREDICTO — buildPlan clasifica
cada major en TILDABLE (no bloqueante, pero siempre requiere `includeMajors`) y
BLOQUEADO: sin veredicto IA · `rompe` · `riesgoso`+`baja` · pre-release. Un
BLOQUEADO NO entra aunque esté en `includeMajors` (el checkbox ya no alcanza) y
sale en `plan.majorsBlocked[{name,from,to,reason}]`; el front lo muestra con 🔒
y sin checkbox. Verificado: cookie riesgoso/baja + tildado ⇒ queda en
majorsBlocked.
(3) CONFIRMAR VERSIÓN INSTALADA — `applyNpm` lee la versión REAL de
node_modules tras el install y si no coincide con el target devuelve ok:false
("npm reportó éxito pero quedó instalada la X"). Mata el ✅ falso (caso real:
archiver dijo OK y siguió en 7.0.1). (4) CLI NO GESTIONABLE — `censusClaudeCli`
resuelve el symlink de `claude`: si cae fuera de $HOME (acá
`/usr/lib/node_modules/...`, instalación root) marca `manageable:false` + nota;
buildPlan OMITE el paso del CLI y el front no ofrece botón — así deja de
figurar como pendiente eterno que `claude update` no puede resolver sin sudo.
(5) DASHBOARD SIEMPRE FRESCO — el panel compara `job.finishedAt` vs
`census.generatedAt` y si el censo es más viejo que el último update lo re-pide
con `fresh=1`, sin que el usuario recargue. GOTCHA descubierto al verificar: la
caché del censo (updates-census.json) SOBREVIVE a cambios de código, así que si
el censo gana campos nuevos el snapshot viejo no los tiene y la UI los muestra
vacíos — se cura con `POST /updates/refresh` (o borrando el archivo).
Alcance COMPLETO = apt incluido (si deja
/var/run/reboot-required avisa pero NO reinicia la máquina). baileys
excluido (RC ≠ estable, risk 'watch'). GET /updates/run-status (0 tokens,
status EFECTIVO: job 'running' con heartbeat vencido ⇒ error, no cuelga el
botón). Los updates per-ítem (POST /updates/npm) quedan de RESPALDO en el
censo. Front: vista de PROGRESO en vivo (fases + checklist de pasos + log +
activeWork + aviso reboot), poll cada 2s RESILIENTE al reinicio (el fetch
falla durante el restart → reintenta). Verificado: buildPlan (marked
in-range se aplica, express/baileys van a majors sin aplicar), notifyInterfono
escribe al bus, systemctl --user is-active OK, Playwright (botón único + 51
ítems en grid 2-col + 0 errores JS). El flujo destructivo completo (apt+
reinicio real) se dispara con el botón bajo confirm, no en tests.
🔴 SEGUNDO INCIDENTE + BLINDAJE (2026-07-24, archiver@8). Qué pasó: el botón
"🚀 Actualizar todo (orquestado)" instaló `archiver@8.0.0` y el server entró
en CRASH-LOOP (5 arranques fallidos, NRestarts 0→4) con
`SyntaxError: The requested module 'archiver' does not provide an export named
'default'` en `src/modules/files/index.js:17`. Causa raíz: archiver v8 pasó a
ESM puro (`"type":"module"`, `exports:"./index.js"`) y dejó de exponer default
export; ahora exporta clases nombradas (`Archiver`, `ZipArchive`, `TarArchive`,
`JsonArchive`). Es el MISMO accidente conceptual que `cookie` 1→2 del
2026-07-21: segunda vez que `node --check` deja pasar un import roto, porque
parsea pero no evalúa el grafo ESM. DOS FALLAS DE DISEÑO expuestas: (1)
`archiver` NUNCA fue tildado por Niko (`includeMajors: []` en el job), pero
entró por la vía `auto:true` de `buildPlan()` porque el veredicto IA fue 🟢
seguro/confianza alta; la IA leyó el changelog y el uso `archiver('zip',...)`
pero no vio el cambio de formato de módulo, así que el checkbox de opt-in
quedó bypasseado. (2) el auto-revert era TODO-O-NADA: `revertNpmChanges()` =
`git checkout -- package.json package-lock.json && npm install`; al revertir
el major roto también se llevó puesto el update BUENO de
`@anthropic-ai/claude-agent-sdk` 0.3.216→0.3.219, que ya había quedado `ok` en
el job. Por eso el panel volvía siempre a mostrar 0.3.216 y PARECÍA roto sin
estarlo: mostraba fielmente un bucle donde el update sano se aplicaba, el major
rompía runtime, y el revert total deshacía ambos.
BLINDAJE aplicado y verificado: (A) `src/modules/files/index.js` migrado a
archiver v8 con `import { ZipArchive } from 'archiver'` y
`new ZipArchive({ zlib: { level: 6 } })` en los dos usos; `package.json` quedó
en `archiver: ^8.0.0`; E2E `GET /api/files/download-zip` devolvió HTTP 200 y
un zip válido de 5 archivos. (B) `verifyRuntime()` nuevo en
`orchestrate-shared.js`: corre en proceso aparte
`import('./src/core/registry.js')`, que encadena TODOS los
`src/modules/*/index.js`, y así un import roto en cualquier módulo falla ANTES
de tocar el servicio; cazó el modo exacto `does not provide an export named
'X'`. (C) `revertPackages(pkgs)` nuevo en `orchestrate-shared.js`: revert
quirúrgico, reinstala solo los paquetes indicados a su versión previa
(`npm install name@from`) y conserva los updates que sí funcionaron;
`revertNpmChanges()` queda como ÚLTIMO recurso. (D)
`bin/cwc-updates-runner.js` cableado en TRES puntos: verificación TEMPRANA tras
npm (si se rompe runtime, revierte solo majors, re-verifica y si se recupera
CONTINÚA conservando in-range; si no, revert total y ABORTA SIN REINICIAR),
verificación FINAL antes del restart con el mismo tratamiento, y
POST-REINICIO escalonado (primero revert quirúrgico de majors + restart +
`httpAlive`, solo después revert total). (E) `buildPlan()` cambió la política:
MUERTA la auto-inclusión por veredicto IA; un salto mayor entra SOLO si Niko lo
tildó (`forced`), `auto` es siempre `false`, y el veredicto IA informa pero no
decide; test verificado: veredicto seguro/alta sin tilde ⇒ `majorsToApply: []`,
con tilde ⇒ entra. (F) `public/js/modules/system/updates-panel.js` eliminó la
UX de "majors auto": checkbox para todo major no bloqueado si sos admin, texto
de veredicto favorable aclarando que igual necesita tu tilde, y conteos de la
sección ajustados. LECCIÓN DURA: un veredicto IA favorable informa pero no
decide, y `node --check` nunca alcanza — el gate previo al reinicio es
`verifyRuntime()`.
🧑‍✈️ SESIÓN DE ACTUALIZACIÓN (2026-07-25, PLAN-1895). Pedido de Niko: el
botón orquestado le resultaba confuso, poco práctico y a veces riesgoso, y
además «se escapan cosas»; ejemplo real: se actualizaron Codex y Claude para
que aparecieran modelos nuevos que la consola no ofrecía. Huecos verificados
ese día: el Codex CLI (`codex-cli 0.145.0`, `~/.npm-global`) NO estaba en el
censo; `~/.codex/models_cache.json` listaba 8 modelos mientras
`src/modules/chat/codex-models.js` conocía 5 — faltaban `gpt-5.4`,
`gpt-5.4-mini` y `codex-auto-review`—; MCPs y Pad también estaban fuera del
censo. Decisiones explícitas de Niko vía AskUserQuestion: sesión EJECUTORA
TOTAL (Bash directo, no copiloto), se abre SIEMPRE al apretar el botón y tiene
cobertura completa (Codex + modelos + MCPs/Pad).
Implementación: `POST /api/updates/session-briefing` (admin) corre un censo
fresco y `buildPlan(census,{apt:true},[],verdicts)`, con `includeMajors` VACÍO
a propósito: la sesión decide con Niko EN EL CHAT, no mediante el checkbox.
Después `buildUpdateBriefing()` de `updates/session-shared.js`, función PURA,
determinística y de 0 tokens, produce `{ok, prompt, title, cwd, actions}`. El
front (`system/updates-panel.js`) llama
`openChat({cwd:'claude-web-console', model:'opus',
mode:'bypassPermissions', prompt, title})`. DOS GOTCHAS DE DISEÑO no obvios:
(1) la sesión NO puede ser TÁNDEM porque su hook bloquea `Bash` de escritura;
una sesión de update en Tándem ni siquiera podría correr `npm install`, por lo
que va en modo normal. (2) `mode:'bypassPermissions'` es DELIBERADO: frenar en
cada permiso de npm/apt/systemctl volvería inusable el flujo; Bash total hace
que se PIERDAN las whitelists del runner, de modo que el blindaje pasa a ser
el BRIEFING y no el código, riesgo aceptado explícitamente por Niko.
El briefing entrega censo completo en tablas, plan ordenado, veredictos IA por
major, los DOS incidentes reales (`cookie` v2 y `archiver` v8) con su modo de
falla y reglas innegociables: JAMÁS ejecutar `sudo reboot` de la máquina;
antes de reiniciar correr la verificación de runtime real
`import('./src/core/registry.js')`, porque `node --check` es ciego a imports
rotos; drenar por interfono; entender que el corte de unos 10 s de la web es
esperado porque la sesión sobrevive gracias a `KillMode=process`; intentar
primero un revert QUIRÚRGICO, preferir ARREGLAR antes que revertir y borrar
`~/.cwc-data/updates-census.json` tras aplicar. El runner determinístico
`bin/cwc-updates-runner.js` se CONSERVA INTACTO como botón secundario
«🤖 Modo automático», sin IA y con 0 tokens.
CENSO AMPLIADO en `shared.js`: `censusCodexCli()` compara la versión contra
`npm view @openai/codex version`, resuelve el symlink y, si cae dentro de
`$HOME`, devuelve `manageable:true` más `updateCmd`; `censusModels()` compara
Codex desde `models_cache.json` contra `CODEX_MODEL_EFFORTS`, pero solo toma
como disponibles las entradas `visibility:'list'` (o sin ese campo, fail-open):
las demás se informan aparte en `hidden` y no generan un `missing` imposible
de cerrar (BUG-2817). Claude se compara contra `VALID_MODELS`. El CLI de Claude
NO expone un catálogo en disco, por lo que
devuelve honestamente `source:'hardcoded'` más una nota en vez de fabricar una
detección falsa. `censusMcps()` reutiliza `runMcpList`/`parseList` de
`mcps/login-shared.js` y es informativo. Los modelos faltantes NO se arreglan
actualizando: se arreglan EDITANDO `src/modules/chat/codex-models.js` o
`src/core/claude-model.js`, y el panel lo explica con `hint`.
`CENSUS_VERSION = 2`: como la caché `updates-census.json` sobrevive a cambios
de código, un censo anterior dejaba vacíos los campos nuevos hasta forzar
`?fresh=1`; ahora un snapshot cuya `version` difiere se trata como
inexistente. DOS DEFECTOS CAZADOS EN LA VERIFICACIÓN: el panel renderizaba
`[object Object]` para los MCP porque `status` es
`{code,light,label}` y no un string; además, el ítem de modelos de Claude
mostraba un FALSO VERDE («conoce todos los modelos disponibles») aunque no se
había comparado contra ninguna fuente. Ahora existe un tercer estado NEUTRO
«sin verificación automática» y el ✅ verde queda reservado para una
comparación real. E2E verificado: `POST /api/updates/session-briefing` respondió
HTTP 200 con 4 acciones y un briefing de 5559 caracteres que contenía las 17
secciones y todas las reglas; Playwright confirmó los botones
«🧑‍✈️ Actualizar con sesión · 4» y «🤖 Modo automático · 4», la sección
«🤖 Codex y modelos» con los 3 modelos faltantes, cero `[object Object]`,
Claude en estado neutro y el click entregando a `openChat` exactamente
`{cwd:'claude-web-console', model:'opus', mode:'bypassPermissions'}`.
`GET /api/health/checks` quedó 16/17 ok; el único warn eran cambios sin
commitear.
