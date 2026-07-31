<!-- cwc:ficha-modulo -->
# src/modules/skills — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### skills/                   CENSO + CATÁLOGO instalable de skills de Claude Code (2026-07-19, pestaña
"Skills" de ⚙ Sistema, PEND-684; catálogo PLAN-2181; aislamiento por usuario
PLAN-2117/B1).
GET /api/skills (0 tokens IA, todo determinístico) deriva el principal con
`systemScopeFor(req)` en cada request. El host conserva exactamente 🏠 Mi
Consola (`<repo>/.claude/skills`) · 🌳 Tolkien
(`config.projectDir/.claude/skills`) · 🌐 Global
(`<scope.claudeDir>/skills`). Un inquilino solo escanea 🌐 sus globales y 🌳
`<scope.workspace>/tolkien/.claude/skills`; las fuentes inexistentes se omiten
sin error. No hay caché de censo en este módulo, por lo que ningún resultado
puede cruzarse entre usuarios.

`catalog.js` expone como catálogo únicamente las skills de Mi Consola cuyo
SKILL.md declara `cwc-share: catalog`; `cwc-default: true` las marca para la
instalación inicial. Una clave ausente o un valor desconocido se trata
fail-closed como `cwc-share: host-only` + `cwc-default: false`: nunca se
comparte. El hash corto SHA-256 cubre todos los archivos de la skill, incluidos
`references/` y `scripts/`, para señalar copias desactualizadas.

GET `/api/skills` calcula el catálogo y sus hashes una sola vez por request y
lo comparte entre la reconciliación de defaults y el estado del catálogo. El
estado INSTALADO se lee siempre fresco después de reconciliar, porque ese paso
puede haber instalado skills nuevas.

Cada GET `/api/skills` reconcilia los defaults nuevos antes del censo. El ledger
per-usuario `<scope.dataDir>/skills-defaults-offered.json` recuerda cuáles ya se
ofrecieron: una skill desinstalada deliberadamente NO se reinstala. Una colisión
con una skill propia también queda ofrecida (nunca se pisa); un fallo de I/O no,
para reintentarlo en la próxima carga. El alta usa la misma reconciliación y el
mismo ledger mediante `installDefaults()`.

POST `/api/skills/install` `{dirName}` copia la skill al
`<scope.claudeDir>/skills/<dirName>/`; POST `/api/skills/uninstall` `{dirName}`
elimina esa copia. Ambos derivan el scope por request, validan `dirName` con
whitelist estricta y confinan la ruta a `scope.claudeDir/skills`. La instalación
deja `.cwc-catalog.json` (mode 600, escritura atómica) con origen
`console-catalog`, nombre, hash y fecha. Un directorio sin ese marcador, con
marcador inválido o con otro origen es una skill propia del usuario: el catálogo
NUNCA la pisa ni la borra. La copia tampoco sigue symlinks. La validación real
del pedido responde 400; un fallo inesperado de instalación o desinstalación
responde 500 porque indica infraestructura rota.

El cruce con `playbooks` usa `reqPadContext(req)` y, por tanto, el token y
workspace de Pad del principal (`console` para el host, `tenant-<id>` para un
inquilino). Vincula el pie "Fuente de verdad: `PLAYB-<n>`" y expone además
`padOnly` = playbooks `active`+`invocation_slug` sin SKILL.md espejado
(coherente con MC-683: los draft/sin-slug no cuentan como candidatos).
