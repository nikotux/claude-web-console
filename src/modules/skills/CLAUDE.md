<!-- cwc:ficha-modulo -->
# src/modules/skills — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### skills/                   CENSO READ-ONLY de skills de Claude Code (2026-07-19, pestaña
"Skills" de ⚙ Sistema, PEND-684). GET /api/skills (0 tokens IA, todo
determinístico): escanea `.claude/skills/*/SKILL.md` de 🏠 Mi Consola
(este repo) · 🌳 Tolkien (config.projectDir — cruce sumado a
CROSS_WORLD_ALLOW del check `cross-world` de salud) · 🌐 Global
(~/.claude/skills), y los cruza con la colección `playbooks` del Pad
LOCAL (pad-service-client, workspace `console`) por el pie "Fuente de
verdad: `PLAYB-<n>`" que ya usan module-scan/codex-verify/rutear.
Expone además `padOnly` = playbooks `active`+`invocation_slug` sin
SKILL.md espejado (coherente con la lección MC-683: los draft/sin-slug
no cuentan como candidatos). Ver detalle completo del diseño en el
bloque de `system.js` más abajo.
