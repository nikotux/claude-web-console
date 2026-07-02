// core/sdk-settings.js — settingSources ÚNICOS para toda corrida del SDK.
//
// Una sola fuente de verdad (Fase 8 + hallazgo de la revisión de salud) en
// vez de arrays sueltos en cada módulo:
//
//  - 'chat' (interactivo, runner de conversaciones): 'user' + 'project'.
//    Hereda skills, comandos slash, CLAUDE.md y hooks tanto del usuario
//    (~/.claude/...) como del proyecto del cwd (.claude/...). Acá el usuario
//    aprueba cada tool en vivo, así que heredar allowlists es aceptable.
//
//  - 'headless' (tickets y toda corrida no interactiva): 'project' + 'local',
//    NUNCA 'user' (regla dura 6 de CLAUDE.md: esas corridas son read-only
//    blindadas y no deben heredar allowlists ni hooks del usuario; el
//    settings.local.json de un proyecto puede pre-aprobar tools mutantes,
//    por eso además llevan el hook PreToolUse que deniega antes de los
//    permisos). 'project' carga .mcp.json + skills; 'local' habilita el
//    server MCP (enabledMcpjsonServers).
export function settingSourcesFor(kind) {
  if (kind === 'chat') return ['user', 'project'];
  if (kind === 'headless') return ['project', 'local'];
  throw new Error(`settingSourcesFor: tipo desconocido "${kind}"`);
}
