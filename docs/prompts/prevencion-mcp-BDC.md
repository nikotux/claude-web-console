# Encargo — Prevención del bug "MCP de scope local no carga en la consola" (B · D · C)

> Sesión hermana. En la sesión de `tolkien` seguimos con PLAN-567; esta sesión
> se ocupa SOLO de las acciones de prevención B, D y C. Escribí todo en español.

## Contexto (qué pasó, ya resuelto la causa)

En los chats de `claude-web-console`, los MCP `pad` y `honcho` **no cargaban**
(sus tools `mcp__pad__*` / `mcp__honcho__*` no aparecían), aunque `claude mcp
list` interactivo sí los mostraba conectados.

**Causa raíz:** el runner del SDK (`bin/cwc-chat-runner.js`) usa
`settingSourcesFor('chat')`, que devolvía `['user','project']`. Los MCP que se
agregan con `claude mcp add` quedan en scope **`local`** (`~/.claude.json` →
`projects[cwd].mcpServers`), que requiere `'local'` en esa lista.
`tolkien-mordor` y `context7` sí cargaban porque viven en `.mcp.json` (scope
`project`).

**Fix ya aplicado y commiteado:** `src/core/sdk-settings.js` ahora devuelve
`['user','project','local']` para el kind `'chat'`. Commit `653c771` en la
branch `redesign/board-mobile`. (No hace falta re-hacerlo.)

Pistas falsas que costaron 3 intentos (para no repetir): (1) una credencial
OAuth vieja de Chris — inocua; (2) `systemctl restart` del servicio NO recicla
los runners porque son detached (`child.unref()`).

## Acción B — Memoria local (rápida, alto valor)

Escribí un archivo de memoria en
`~/.claude/projects/-home-nmosquera-tolkien/memory/` (p.ej.
`mcp-scope-local-diagnostico.md`) con la **regla de diagnóstico**, y sumalo al
índice `MEMORY.md`.

Regla a guardar (self-contained): *"Si un MCP aparece conectado en `/mcp`
interactivo (o `claude mcp list`) pero sus tools NO están en un chat de la
consola web → es un problema de **scope**, no de credencial. Los MCP de
`claude mcp add` quedan en scope `local` (`~/.claude.json`); el runner del SDK
solo los carga si `settingSources` incluye `'local'`. Primer paso de
diagnóstico: comparar los MCP que muestra `claude mcp list` vs los que tiene el
chat; si el interactivo tiene de más, es el cajón `local`. Ver
`claude-web-console/src/core/sdk-settings.js` (`settingSourcesFor`)."*

## Acción D — Honcho (con matiz)

⚠️ El Honcho de este entorno es `tolkien-dev` = memoria del **proyecto
Tolkien**. Este bug es de la **consola personal** (`claude-web-console`), que NO
es Tolkien. Por eso guardar la lección en `tolkien-project` está fuera de lugar.

Hacé **D1**: guardá la conclusion observada sobre `nico` (entorno de dev de
Nico), NO sobre `tolkien-project`. Contenido = la misma regla de B, marcando que
es sobre la consola web personal. Si el peer/target no encaja limpio, dejá la
lección solo en la memoria local (B) y anotá acá que D se salteó por scope.

## Acción C — Health-check en la consola (feature, requiere plan)

Objetivo: un chequeo que, para un cwd, compare **MCP configurados** (`.mcp.json`
scope project + `~/.claude.json` projects[cwd].mcpServers scope local) contra
los que la sesión **realmente cargaría** según `settingSourcesFor('chat')`, y
marque en rojo el **gap** (p.ej. "hay MCP en scope local pero el chat no lee ese
cajón"). Es el detector del bug de hoy para cualquier MCP futuro.

Pasos sugeridos:
1. **Plan primero** (regla de Nico): tabla de archivos a tocar + efecto, y OK
   antes de codear.
2. Backend: helper que lea ambos orígenes de MCP + `settingSourcesFor` y compute
   el gap. Endpoint bajo el módulo `health` o `admin` (patrón del registry).
3. Frontend: sección en el menú ⚙ Sistema (mismo patrón que `backup-panel.js`).
4. Commit a tu fork `personal` (NO PR a Chris — es tu repo). Mostrar plan de
   commit antes de commitear.

Nota: como el fix (A) ya está, C es defensa a futuro / diagnóstico más rápido,
no urgente.

## Cierre
Cerrá con un resumen visual (qué quedó hecho de B/D/C) y la línea 🎾 Pelota.
