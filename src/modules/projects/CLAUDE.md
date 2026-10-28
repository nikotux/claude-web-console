<!-- cwc:ficha-modulo -->
# src/modules/projects — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### projects/                 contexto (CLAUDE.md) y memorias EDITABLES de los proyectos
registrados en PROJECTS (index.js): `tolkien` (config.projectDir)
Y `console` (esta misma consola, su propia raíz de repo) — agregar
uno nuevo es sumar una entrada al objeto, todas las funciones de
memory.js toman `projectDir` como parámetro (nada hardcodeado).
GET /api/projects = lista {key,name,dir}; GET/POST /:key/context =
<projectDir>/CLAUDE.md real (POST entero: existe para uso
programático, la UI NO lo usa; exige `hash` y preserva sin cambios los bloques
gestionados por mejora-continua/pad-index); INTEGRIDAD — la UI edita el
contexto POR SECCIONES (riesgo señalado por el usuario: cargar el
.md entero en un textarea permitía borrarlo completo de un
descuido): GET /:key/context/sections = índice {i,title,level,
lines,size,hash} cortado por encabezados # a ### (splitContextSections;
INVARIANTE: sections.join('\n') === archivo byte a byte, verificado);
GET/POST /:key/context/section/:i = UN fragmento — el POST exige el
`hash` (sha256/16) del texto ABIERTO y si el archivo cambió en el
medio (otra sesión de Claude editándolo) responde 409 sin pisar
nada. GUARDIÁN con IA (POST /:key/context/section/:i/analyze,
admin o dueño de su proyecto, valida hash ANTES de gastar tokens):
corrida corta del SDK
(haiku, 1 turno, CERO herramientas — las dos capas de la regla 6
acá deniegan TODO) que compara sección vieja vs nueva y devuelve
{removed, added, modified, risk ok|atencion|critico, riskWhy,
summary}. DESACOPLADA a runner (regla de oro, 2026-07-05: antes
corría INLINE en el handler y un deploy a mitad la perdía con los
tokens gastados): el POST persiste el job en el `.cwc-data` del
usuario que lo pidió (`<userDataDir>/projects-analyze/<id>.json`;
para el host sigue siendo `~/.cwc-data/projects-analyze/<id>.json`)
(id DETERMINÍSTICO por
proyecto+sección+hash+contenido: un reintento reusa el MISMO job,
sin runner duplicado — lock implícito por identidad), spawnea
bin/cwc-projects-analyze-runner.js detached y responde YA
{id,status:'running'}; GET /:key/context/section/:i/analyze/:id
SOLO lee disco (0 tokens; staleness ⇒ error, nunca cuelga) y el
front encuesta cada 2 s tolerando fetch fallidos (deploy en el
medio). Lógica compartida en projects/analyze-shared.js (prompt +
parseo + jobs con poda >24 h). BLINDAJE ANTICONSUMO: el host conserva
su entorno completo; un inquilino corre con `userRunnerEnv` y su
`CLAUDE_CODE_OAUTH_TOKEN`, y sin credencial propia el POST falla cerrado
con un mensaje para conectar su cuenta (nunca usa la cuenta Claude del
server). La UI lo muestra en un modal de CONFIRMACIÓN FORZADA
(reviewChange en project-context-panel.js) — solo "Confirmar y
guardar" escribe, "Seguir editando" vuelve al editor sin tocar
nada, y si la IA falla cae a un diff local (renderDiff) con la
misma confirmación forzada: nunca se guarda a ciegas, nunca se
bloquea el trabajo. Guardar sin cambios NO dispara análisis.
GET /:key/memory = índice MEMORY.md + notas resueltas contra
disco (orden del índice, huérfanas al final); GET/POST
/:key/memory/index = MEMORY.md crudo; GET/POST
/:key/memory/note/:file = una nota (ambos POST exigen `hash`; whitelist estricta
`^[A-Za-z0-9_-]+\.md$`, sin path traversal; `:key` validado contra
PROJECTS, 404 si no existe). GET abierto a autenticados, POST
admin (mismo patrón que el contexto de bugfixes). La carpeta de
memorias se ubica con encodeCwd(projectDir) (core/claude-model.js)
— MISMA codificación que usa Claude Code para
~/.claude/projects/. NO son copias: son los archivos reales que
lee la próxima sesión de Claude Code en ESE proyecto — guardar acá
cambia comportamiento real (excepción deliberada a la regla 4, ver
ahí). Ojo recursivo: editar el proyecto `console` significa editar
el CLAUDE.md/memorias que gobiernan las sesiones de Claude Code en
ESTE MISMO repo.

Identidad per-user: GET/POST `/api/projects/me/identity` resuelven SIEMPRE
`systemScopeFor(req).dataDir`; para el host ese scope sigue apuntando a
`~/.cwc-data`, por retrocompatibilidad. El GET devuelve la identidad con
`source:'user'`, `editable:true` y `perUserIdentityAvailable:true`; el POST
persiste sólo `identity`. `pickIdentity(body)`, exportado desde
`personalization.js`, es la fuente única de saneo para esta superficie y la de
admin: allowlist estricta de `name`/`email`/`github`/`signature`, convertidos a
string, con trim y máximo de 200 caracteres. La sección `client` de
`instance.json` NO es escribible por esta vía. Además de Cabina, el consumidor
`public/js/modules/system/project-context-panel.js` lee el mismo GET.

GOTCHA: el TODO «SP2 aún no migró la identidad per-user» sobrevivió a su propio
bloqueante: `systemScopeFor`/`userDataDir` ya existían y `env-vars` ya resolvía
el scope correctamente. Al tocar un comentario que difiere trabajo a otra fase,
verificar primero si esa fase ya llegó.
