<!-- cwc:ficha-modulo -->
# src/modules/terminal — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### terminal/                 sesiones tmux (PREFIX cwc-) + bare/TUI (BARE_PREFIX cwct-) + rehidratación

## Gotchas de esta carpeta

- En `Session` (terminal/sessions.js) la propiedad de adjuntado es
  `attachSpec`, NO `attach` (colisiona con el método `attach(ws)`).
