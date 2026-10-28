# Archivado — Bugs & Features v1

**Fecha:** 2026-07-07 · **Por:** Nicolás (Niko) Mosquera

## Qué se archivó y por qué

**"Bugs & Features" v1** fue reemplazado por **"Tickets & Features"** (antes "Bugs v2"),
el dashboard determinístico que lee Zoho/GitHub directo vía MCP (sin sub-agente de IA
en el camino de lectura). El detonante fue el bug de Desk #527: v1 leía el estado de
Desk a través de un LLM que retranscribía datos ya estructurados a texto libre, y ese
paso fallaba sistemáticamente. v2 elimina el intérprete. Ver el plan completo en
`~/pool of documents/2026-07-06_plan-backend-deterministico-lectura-desk_v01.md`.

v1 quedó **archivado** (no borrado): reversible si hiciera falta.

## Contenido de esta carpeta

| Ruta | Qué era |
|---|---|
| `src-modules/bugs/` | Backend del triage de bugs (skill bug-triage, `/api/bugs`) |
| `src-modules/bugfixes/` | Backend de seguimiento de fixes/PRs + desk-runner LLM (`/api/bugfixes`) |
| `public-js-modules/bugs/` | Frontend: sección "Bugs & Features" + el tablero (`board/`) |
| `bin/cwc-triage-runner.js` | Runner de triage (LLM) |
| `bin/cwc-desk-runner.js` | Runner de estado de Desk (LLM, el del bug — parseo frágil) |
| `bin/cwc-ticket-investigate-runner.js` | Investigación de contexto de tickets sin PR |
| `bin/cwc-investigate-runner.js` | Investigación de PRs |
| `bin/cwc-bugfix-link.js` | CLI para vincular un PR al tablero v1 |
| `~/.cwc-data/_archived/` | Datos de v1: bugfixes.json, tickets.json, triage-cache.json, desk-live/, investigations/, etc. |

## Qué se migró a Tickets & Features (NO archivado)

- **Contextos de prompt editables** (`bugfix-context.md`, `bugfix-pr-context.md`):
  siguen en `~/.cwc-data/`, actualmente servidos por `/api/projects/work-context`
  (`src/modules/tickets/context-store.js`). Los usa `system/project-context-panel`.

## Notas

- El CSS de v1 (`.bb-*`, `.bfm-*`, parte de `.bf-*`) sigue en `public/css/style.css`
  porque v2 reutiliza varias clases (`.bb-chip`, `.bf-sub`, `.tk-card`…). El CSS muerto
  del tablero viejo quedó inerte; limpieza opcional a futuro (baja prioridad).
- Los imports relativos internos de los módulos archivados quedan "rotos" respecto a su
  nueva ubicación, pero no importa: nada los carga (fuera del registry). Reversión =
  mover de vuelta + re-registrar en `registry.js` / `main.js` / `index.html`.

## Archivado — Tickets & Features v2 (2026-10-28, console:PLAN-3480)

Nico dejó de usar el módulo. Se retiraron el registro backend/frontend, el slot,
la ayuda, el diccionario activo y el precalentamiento de metadata. Al no cargarse
index.js ni refresher.js, el nuevo proceso no inicia el refresh de 60 s que
consultaba Zoho/GitHub/Pad cloud y persistía el snapshot. No se reinició el servicio
ni se tocaron datos de runtime.

| Origen | Destino archivado |
|---|---|
| src/modules/tickets/{index,refresher,sources,views,pad-client,claims-store,context-analyze-shared}.js | _archived/src-modules/tickets/ (7 archivos, sin cambios de contenido) |
| bin/cwc-ticket-context-runner.js | _archived/bin/cwc-ticket-context-runner.js |
| bin/migrate-tickets-meta-to-pad.js | _archived/bin/migrate-tickets-meta-to-pad.js |
| public/js/modules/tickets/{tickets,dashboard,ticket-detail,pr-detail,meta-panel,help}.js | _archived/public-js-modules/tickets/ (6 archivos) |
| public/i18n/en/tickets.json | _archived/public-i18n/tickets.json |

| Librería que queda en src/modules/tickets/ | Uso vivo |
|---|---|
| meta-store.js | Chat: histórico y extracción de transcripts; chat/index.js inyecta ahora setTicketClaudeDirResolver. |
| context-store.js | Proyectos, Salud, Retro y los CLIs tenant-mirror-reset / retro-context-rehydrate. |
| desk-mcp-client.js y derive.js | Conservados temporalmente: seguimientos/desk-source.js importa ambos; desk-mcp-client también importa derive. |
| CLAUDE.md | Ficha de la librería y sus contratos por usuario. |

Las rutas GET/POST /api/tickets/context se trasladaron a
GET/POST /api/projects/work-context; GET/POST /api/tickets/context-sync pasan a
GET/POST /api/projects/work-context/sync. Conservan cuerpos, respuestas y
systemScopeFor(req). El panel de Proyectos consume las nuevas rutas.

Salud deja de registrar ticket-context y sus exenciones; se retiraron también
las entradas stale desk/investigate/ticket-investigate de RUNNER_STATE_FILES,
cuyos runners ya estaban en _archived/bin. Se conserva la exención de
desk-mcp-client mientras lo use Seguimientos. El regex de invariants.js sigue
incluyendo tickets porque los stores permanecen vivos.

Los traslados preservan el contenido byte a byte; el índice Git no se modifica
en esta fase porque .git es de solo lectura (git mv requiere full_access: true).
Como en v1, el código archivado no se ejecuta y sus imports relativos se conservan
para una eventual restitución a la ubicación original.

## Archivado — Banco de conocimiento, Laboratorio, Cerebro y Seguimientos (2026-10-28, console:PLAN-3480)

Fases F3–F5: los seis módulos se retiraron por completo del código activo,
conservando sus archivos byte a byte bajo `_archived/`. Se preservaron los
cambios previos de F1/F2. No se reinició el servicio ni se modificaron datos de
runtime: un proceso ya arrancado conserva su código hasta su próximo reinicio.

| Origen | Destino archivado |
|---|---|
| src/modules/tasks/ | _archived/src-modules/tasks/ (carpeta completa) |
| src/modules/audio/ | _archived/src-modules/audio/ (carpeta completa) |
| src/modules/learning/{index,analyze-shared,context-shared,explain-shared,session-log}.js | _archived/src-modules/learning/ |
| src/modules/lab/index.js | _archived/src-modules/lab/index.js |
| src/modules/cerebro/ | _archived/src-modules/cerebro/ (carpeta completa) |
| src/modules/seguimientos/ | _archived/src-modules/seguimientos/ (carpeta completa) |
| src/modules/tickets/{desk-mcp-client,derive}.js | _archived/src-modules/tickets/ |
| public/js/modules/{tasks,learning,audio,lab}/ | _archived/public-js-modules/{tasks,learning,audio,lab}/ (carpetas completas) |
| public/{cerebro,seguimientos}.html | _archived/public/{cerebro,seguimientos}.html |
| public/js/{cerebro,seguimientos}/ | _archived/public-js/{cerebro,seguimientos}/ (carpetas completas) |
| public/css/cerebro.css | _archived/public-css/cerebro.css |
| public/js/modules/{cerebro,seguimientos}-help.js | _archived/public-js-modules/{cerebro,seguimientos}-help.js |
| public/i18n/en/{tasks,learning,audio,cerebro,seguimientos}.json | _archived/public-i18n/{tasks,learning,audio,cerebro,seguimientos}.json |
| bin/cwc-{tasks-analyze,learning-analyze,learning-context,learning-explain,audio,seguimientos}-runner.js | _archived/bin/ (6 runners) |
| bin/migrate-learning-to-pad.js | _archived/bin/migrate-learning-to-pad.js |
| bin/cwc-calendar.js | _archived/bin/cwc-calendar.js |

### Librerías y excepción conservadas

| Archivo vivo | Consumidor / contrato |
|---|---|
| src/modules/learning/store.js | chat/index.js: appendChatContext como appendLearningChatContext para chats históricos con learningId. No depende de session-log.js ni de otros archivados. |
| src/modules/tickets/meta-store.js | Chat: histórico y extracción determinística de transcripts, con resolver por dueño. |
| src/modules/tickets/context-store.js | Proyectos, Salud, Retro y CLIs tenant-mirror-reset / retro-context-rehydrate. |
| bin/cwc-desk.js | La skill viva .claude/skills/eta/SKILL.md lo usa para actualizar dueDate. Se conserva según la excepción del plan. |

La referencia a `tickets/derive.js` en `comms/shared.js` es solo un comentario;
la de `health/coherence-shared.js` es un ejemplo textual de auditoría.
No quedan importadores vivos de desk-mcp-client.js/derive.js.

### Cableado retirado

- Backend: imports/entradas del registry, rutas /cerebro y /seguimientos,
  vendors /vendor/3d-force-graph y /vendor/three; ningún index.js de los seis
  módulos queda sin registrar.
- Frontend: slots tasks/lab, accesos del pie, montaje, loaders de ayuda,
  diccionarios y claves exclusivas de ayuda/accesos en core.json.
- Salud e inventario: estados y registro de runners, exenciones de archivos
  archivados. El alcance de invariants.js conserva learning por su store,
  retira tasks; audio no figuraba en ese regex. policy.js no tenía reglas
  de estos módulos; no se cambió en esta fase.
- Pad: precarga solo mejora-continua; el barrido de 20 s conserva el refresco
  de lecturas solicitadas por consumidores vivos. El generador de arquitectura
  deja solo retro en Banco de conocimiento y retira Seguimientos de su grupo.
  getGraph/getCompleteGraph/getActivity y padTelemetry se eliminaron tras
  confirmar que Cerebro era su único consumidor.
- Terminal: se retiraron OMP_BIN, el parámetro agent y el título omp de las
  sesiones. POST /api/terminal/sessions rechaza cualquier agent no nulo con
  HTTP 400 y «Agente inválido.», también al adjuntar una sesión.
- Dependencias: npm uninstall 3d-force-graph actualizó package.json y
  package-lock.json; quitó 20 paquetes. npm ls three solo mostraba la cadena
  de 3d-force-graph antes y devuelve (empty) después.

Se conservan learningId, la lectura best-effort de learning-session-ids.json
en Tokens y el código dormido limbo de Chat/Sesiones. El CLI legacy
bin/migrate-tasks-to-pad.js no importa módulos archivados y queda fuera de
los traslados explícitos de este plan. No se modificaron el CLAUDE.md raíz
ni las fichas no autorizadas de Terminal/Salud/ui.

### Cómo revertir

1. Mover con mv los archivos de esta tabla a sus rutas originales, sin
   sobrescribir los stores vivos ni los archivos archivados en F1/F2.
   Los imports relativos archivados se conservan para esa ubicación original.
2. Reponer imports y registros backend/frontend, slots, accesos, ayuda,
   diccionarios, rutas, vendors y las entradas correspondientes de Salud e
   inventario; restituir los helpers exclusivos de Cerebro y el soporte de
   omp si se quiere restaurar Laboratorio.
3. Restaurar la dependencia 3d-force-graph mediante npm (con autorización
   explícita), conservando package.json y package-lock.json sincronizados.
4. Restituir la precarga y los grupos del generador si vuelven esos consumidores.
   Actualizar las fichas y ejecutar node --check e import del registry antes
   de un reinicio autorizado. No requiere mover ni regenerar datos de runtime.

Los traslados se hicieron con mv: no se escribió en .git. Para preparar o
registrar estos cambios en Git hace falta full_access: true.

### Verificación F3–F5

- `node --check <archivo>`: 58 archivos JavaScript modificados o movidos,
  0 errores. Los 57 traslados preservan el contenido byte a byte.
- Terminal: 20 casos de validación del handler pasaron, incluidos valores
  falsy no nulos y adjuntado; no se crearon sesiones.
- `git diff --check`: sin salida, exit 0.
- `data-module="tasks|lab|tickets"`: sin coincidencias.
- Sin `omp` ni `agent` huérfanos en Terminal; solo queda
  `src/modules/terminal/index.js:113: if (req.body?.agent != null)`.
- Import de pad-service-client OK con `CWC_PAD_URL=http://127.0.0.1:7777`;
  los cuatro exports exclusivos de Cerebro ya no existen.
- La búsqueda de imports vivos solo encuentra
  `src/modules/chat/index.js:83` → `../learning/store.js`.
- `git status --short | wc -l`: 136 (incluye F1/F2).
- Alcance contrastado con los hashes anteriores a F3: ningún archivo fuera
  de la lista autorizada fue modificado; los stores vivos y Tokens se preservan.

El import obligatorio del registry (exit 0) devolvió:

```text
terminal,files,stats,tokens,tmux,admin,sponsorship,tolkien,backup,chat,health,projects,interfono,retro,env-vars,onboard,skills,mcps,updates,connections,unifi,news,visado,folders,forja
```

**Pendiente fuera del alcance autorizado:** el grep obligatorio no queda
vacío salvo librerías/comentarios: encuentra 21 referencias en
`src/modules/health/facets-snapshot.json` (20 a archivos archivados y una al
store vivo). No es cableado ejecutable, pero ese snapshot debe depurarse o
regenerarse para que la comprobación textual quede limpia. No se modificó
porque el plan no lo autoriza. La búsqueda literal no detecta el import
de Chat porque está escrito como `../learning/store.js`; se verificó aparte.

Salida literal del grep obligatorio:

```text
src/modules/health/facets-snapshot.json:122:    "file:public/js/modules/audio/audio.js": {
src/modules/health/facets-snapshot.json:146:    "file:public/js/modules/learning/learning.js": {
src/modules/health/facets-snapshot.json:330:    "file:public/js/modules/tasks/tasks.js": {
src/modules/health/facets-snapshot.json:410:    "file:src/modules/audio/index.js": {
src/modules/health/facets-snapshot.json:418:    "file:src/modules/audio/shared.js": {
src/modules/health/facets-snapshot.json:666:    "file:src/modules/learning/analyze-shared.js": {
src/modules/health/facets-snapshot.json:674:    "file:src/modules/learning/context-shared.js": {
src/modules/health/facets-snapshot.json:682:    "file:src/modules/learning/explain-shared.js": {
src/modules/health/facets-snapshot.json:690:    "file:src/modules/learning/index.js": {
src/modules/health/facets-snapshot.json:698:    "file:src/modules/learning/session-log.js": {
src/modules/health/facets-snapshot.json:706:    "file:src/modules/learning/store.js": {
src/modules/health/facets-snapshot.json:850:    "file:src/modules/seguimientos/calendar-source.js": {
src/modules/health/facets-snapshot.json:858:    "file:src/modules/seguimientos/classify-shared.js": {
src/modules/health/facets-snapshot.json:866:    "file:src/modules/seguimientos/desk-source.js": {
src/modules/health/facets-snapshot.json:874:    "file:src/modules/seguimientos/history-store.js": {
src/modules/health/facets-snapshot.json:882:    "file:src/modules/seguimientos/index.js": {
src/modules/health/facets-snapshot.json:890:    "file:src/modules/seguimientos/refresher.js": {
src/modules/health/facets-snapshot.json:898:    "file:src/modules/seguimientos/store.js": {
src/modules/health/facets-snapshot.json:922:    "file:src/modules/tasks/analyze-shared.js": {
src/modules/health/facets-snapshot.json:930:    "file:src/modules/tasks/index.js": {
src/modules/health/facets-snapshot.json:938:    "file:src/modules/tasks/store.js": {
src/modules/learning/store.js:1:// modules/learning/store.js — MÓDULO DE APRENDIZAJE: registro PRIVADO de los
```

Archivos nuevos en `_archived/` según
`git ls-files --others --exclude-standard _archived` (73; 57 de esta fase y
16 ya presentes de F1/F2):

```text
_archived/bin/cwc-audio-runner.js
_archived/bin/cwc-calendar.js
_archived/bin/cwc-learning-analyze-runner.js
_archived/bin/cwc-learning-context-runner.js
_archived/bin/cwc-learning-explain-runner.js
_archived/bin/cwc-seguimientos-runner.js
_archived/bin/cwc-tasks-analyze-runner.js
_archived/bin/cwc-ticket-context-runner.js
_archived/bin/migrate-learning-to-pad.js
_archived/bin/migrate-tickets-meta-to-pad.js
_archived/public-css/cerebro.css
_archived/public-i18n/audio.json
_archived/public-i18n/cerebro.json
_archived/public-i18n/learning.json
_archived/public-i18n/seguimientos.json
_archived/public-i18n/tasks.json
_archived/public-i18n/tickets.json
_archived/public-js-modules/audio/audio.js
_archived/public-js-modules/audio/help.js
_archived/public-js-modules/cerebro-help.js
_archived/public-js-modules/lab/CLAUDE.md
_archived/public-js-modules/lab/help.js
_archived/public-js-modules/lab/lab.js
_archived/public-js-modules/learning/help.js
_archived/public-js-modules/learning/learning.js
_archived/public-js-modules/seguimientos-help.js
_archived/public-js-modules/tasks/help.js
_archived/public-js-modules/tasks/tasks.js
_archived/public-js-modules/tickets/dashboard.js
_archived/public-js-modules/tickets/help.js
_archived/public-js-modules/tickets/meta-panel.js
_archived/public-js-modules/tickets/pr-detail.js
_archived/public-js-modules/tickets/ticket-detail.js
_archived/public-js-modules/tickets/tickets.js
_archived/public-js/cerebro/cerebro.js
_archived/public-js/cerebro/orbits.js
_archived/public-js/cerebro/palette.js
_archived/public-js/cerebro/pulses.js
_archived/public-js/seguimientos/seguimientos.js
_archived/public/cerebro.html
_archived/public/seguimientos.html
_archived/src-modules/audio/CLAUDE.md
_archived/src-modules/audio/index.js
_archived/src-modules/audio/shared.js
_archived/src-modules/cerebro/CLAUDE.md
_archived/src-modules/cerebro/index.js
_archived/src-modules/lab/index.js
_archived/src-modules/learning/analyze-shared.js
_archived/src-modules/learning/context-shared.js
_archived/src-modules/learning/explain-shared.js
_archived/src-modules/learning/index.js
_archived/src-modules/learning/session-log.js
_archived/src-modules/seguimientos/CLAUDE.md
_archived/src-modules/seguimientos/calendar-source.js
_archived/src-modules/seguimientos/classify-shared.js
_archived/src-modules/seguimientos/desk-source.js
_archived/src-modules/seguimientos/history-store.js
_archived/src-modules/seguimientos/index.js
_archived/src-modules/seguimientos/refresher.js
_archived/src-modules/seguimientos/store.js
_archived/src-modules/tasks/CLAUDE.md
_archived/src-modules/tasks/analyze-shared.js
_archived/src-modules/tasks/index.js
_archived/src-modules/tasks/store.js
_archived/src-modules/tickets/claims-store.js
_archived/src-modules/tickets/context-analyze-shared.js
_archived/src-modules/tickets/derive.js
_archived/src-modules/tickets/desk-mcp-client.js
_archived/src-modules/tickets/index.js
_archived/src-modules/tickets/pad-client.js
_archived/src-modules/tickets/refresher.js
_archived/src-modules/tickets/sources.js
_archived/src-modules/tickets/views.js
```
