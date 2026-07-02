# Módulo chat — notas de configuración

## Qué configuración hereda cada conversación (Fase 8)

Desde la Fase 8 el motor de cada conversación (`bin/cwc-chat-runner.js`) corre
con `settingSources: ['user', 'project']` (fuente única:
`src/core/sdk-settings.js`). Eso significa que cada chat hereda:

**Del usuario (`~/.claude/`):**
- `settings.json` completo: modelo por defecto, tema, y — OJO — las reglas
  `permissions.allow` (hoy `Bash`, `Read`, `WebFetch`): esos tools se
  auto-aprueban SIN pasar por el diálogo de permisos del chat (`canUseTool`
  solo ve lo que el CLI habría preguntado). Es el mismo comportamiento que la
  TUI del usuario.
- Los hooks del observador (Fase 3: `UserPromptSubmit`/`Stop`/`SessionEnd` →
  `bin/cwc-observe.js`) y la statusline. Para que las sesiones de chat NO
  contaminen `~/.cwc-state` (que es exclusivo de TUIs y alimenta la adopción
  TUI→Chat vía `sessionIdForCwd`), el runner exporta `CWC_CHAT_RUNNER=1` y el
  observador, al verla, sale sin escribir. El estado del chat viaja por el
  socket del runner, no por el observador.
- Skills y comandos custom de `~/.claude/skills/` y `~/.claude/commands/`,
  y el CLAUDE.md global del usuario si existe.

**Del proyecto (el `cwd` de la conversación, `.claude/` + raíz):**
- `CLAUDE.md` del proyecto (contexto automático).
- Skills (`.claude/skills/`) y comandos custom (`.claude/commands/`).
- `settings.json` del proyecto si existe.
- NO se carga `settings.local.json` (`'local'` no está en la lista del chat).

Además `allowedTools: ['Skill']` habilita que Claude invoque skills de forma
autónoma (aparte de la invocación manual con `/comando`).

## Comandos slash

- El `system/init` de cada sesión trae `slash_commands` (built-ins + skills +
  comandos custom del cwd). Es LA fuente de verdad: no hardcodear comandos
  (no todos los de la TUI son despachables por SDK).
- El runner lo guarda, lo emite como `{type:'meta', slashCommands}` y lo
  incluye en su `hello`; el server lo re-emite por WS y lo suma al payload
  del attach (`{type:'history', ..., slashCommands}`). La lista es POR
  conversación (depende del cwd), nunca global.
- Un comando se envía como texto normal que empieza con `/` — ningún punto de
  la cadena (input → WS → runner → SDK) filtra ni escapa la barra.

## Autocompletado (frontend, Fase 8 · parte 2)

- `chat-tab.js`: al escribir `/` como primer carácter se abre el popup
  (`.chat-slash-pop`, `dismissablePopup` de ui/popup.js) anclado sobre el
  composer — `#app` sigue a `visualViewport`, así que queda sobre el teclado
  virtual sin cálculo extra. Filtro en vivo (prefijo primero, subcadena
  después), `↑↓`+`Enter`/`Tab` insertan (`/comando ` con espacio; nunca envía
  solo), `Esc` cierra sin reabrir hasta que cambie el texto.
- El server enriquece los nombres del init con el `description:` del
  frontmatter de los `SKILL.md` (solo lectura) y cachea la lista POR CWD en
  memoria: un chat nuevo en un cwd ya visto tiene lista antes de su primer
  init; si no, el popup muestra "cargando comandos…".
- Mensajes que empiezan con `/comando` se pintan con chip destacado
  (`.chat-cmd-chip`) — solo presentación, el texto viaja intacto.
- Móvil: botón `/` en la auxbar (`insertSlash()` en el chat; `/` literal en
  una terminal); filas ≥44px en punteros gruesos.

## Contraste con las corridas headless (tickets/salud)

Las corridas headless usan `settingSourcesFor('headless')` =
`['project','local']`, NUNCA `'user'`, y llevan doble blindaje read-only
(hook `PreToolUse` + `canUseTool`). Regla dura 6 de CLAUDE.md — no igualar
esa configuración a la del chat.
