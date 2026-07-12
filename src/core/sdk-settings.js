// core/sdk-settings.js — settingSources ÚNICOS para toda corrida del SDK.
//
// Una sola fuente de verdad (Fase 8 + hallazgo de la revisión de salud) en
// vez de arrays sueltos en cada módulo:
//
//  - 'chat' (interactivo, runner de conversaciones): 'user' + 'project' +
//    'local'. Hereda skills, comandos slash, CLAUDE.md y hooks tanto del
//    usuario (~/.claude/...) como del proyecto del cwd (.claude/...). Acá el
//    usuario aprueba cada tool en vivo (y en bypassPermissions ya se
//    auto-aprueba todo), así que heredar allowlists es aceptable. 'local' es
//    IMPRESCINDIBLE para los MCP de scope local (los que `claude mcp add`
//    guarda en ~/.claude.json → projects[cwd].mcpServers, p.ej. `pad` y
//    `honcho`): sin 'local' esos servers NO se cargan en la consola aunque el
//    `claude` interactivo sí los vea. 'project' cubre .mcp.json
//    (tolkien-mordor, context7).
//
//  - 'headless' (tickets y toda corrida no interactiva): 'project' + 'local',
//    NUNCA 'user' (regla dura 6 de CLAUDE.md: esas corridas son read-only
//    blindadas y no deben heredar allowlists ni hooks del usuario; el
//    settings.local.json de un proyecto puede pre-aprobar tools mutantes,
//    por eso además llevan el hook PreToolUse que deniega antes de los
//    permisos). 'project' carga .mcp.json + skills; 'local' habilita el
//    server MCP (enabledMcpjsonServers).
//  - 'none' (interpretación PURA de texto: retro, ticket-context, audio,
//    commitmsg, learning-*, projects-analyze…): [] — NADA de settings, skills,
//    hooks ni MCP. Estas corridas NO usan herramientas (además llevan las dos
//    capas de deny de la regla 6, ver core/text-only-query.js). Antes cada
//    runner escribía el literal `settingSources: []` a mano; este kind es la
//    fuente única para no repetirlo (y para que un grep encuentre a todos).
export function settingSourcesFor(kind) {
  if (kind === 'chat') return ['user', 'project', 'local'];
  if (kind === 'headless') return ['project', 'local'];
  if (kind === 'none') return [];
  throw new Error(`settingSourcesFor: tipo desconocido "${kind}"`);
}
