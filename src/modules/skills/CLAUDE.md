<!-- cwc:ficha-modulo -->
# src/modules/skills — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### skills/                   CENSO READ-ONLY de skills de Claude Code (2026-07-19, pestaña
"Skills" de ⚙ Sistema, PEND-684; aislamiento por usuario PLAN-2117/B1).
GET /api/skills (0 tokens IA, todo determinístico) deriva el principal con
`systemScopeFor(req)` en cada request. El host conserva exactamente 🏠 Mi
Consola (`<repo>/.claude/skills`) · 🌳 Tolkien
(`config.projectDir/.claude/skills`) · 🌐 Global
(`<scope.claudeDir>/skills`). Un inquilino solo escanea 🌐 sus globales y 🌳
`<scope.workspace>/tolkien/.claude/skills`; las fuentes inexistentes se omiten
sin error. No hay caché de censo en este módulo, por lo que ningún resultado
puede cruzarse entre usuarios.

El cruce con `playbooks` usa `reqPadContext(req)` y, por tanto, el token y
workspace de Pad del principal (`console` para el host, `tenant-<id>` para un
inquilino). Vincula el pie "Fuente de verdad: `PLAYB-<n>`" y expone además
`padOnly` = playbooks `active`+`invocation_slug` sin SKILL.md espejado
(coherente con MC-683: los draft/sin-slug no cuentan como candidatos).
