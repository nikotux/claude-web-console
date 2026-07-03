// modules/health/invariants.js — INVARIANTES verificables del proyecto.
//
// FASE 4 del "sistema nervioso": aserciones que DEBEN cumplirse siempre. El
// auditor de salud inyecta en cada unidad SOLO los invariantes que le aplican
// (por `match` contra sus rutas de archivo) y los verifica sí o sí — así caza
// bugs SUTILES que el barrido genérico se pierde (p.ej. asimetrías en archivos
// grandes). Están seedeados de los gotchas conocidos de CLAUDE.md; son la
// parte "receta/rules" del cerebro (viven en el repo, humano-autoradas). La
// Fase 5 (loop que aprende) PROPONE nuevas acá cuando el auto-fix resuelve algo.
//
// Cada invariante: { match: RegExp (contra rel path de archivo), text: string }.
export const INVARIANTS = [
  {
    match: /src\/modules\/chat\/(index|shared)\.js$/,
    text: 'SIMETRÍA de estado en chat/index.js: todo `case` del switch de eventos que muta estado persistente de la conversación (mode, model, etc.) debe llamar a onUpdate()/persist() IGUAL que sus gemelos. Ej histórico: `case "mode"` debía llamar onUpdate() como `case "model"` — si un camino guarda y su gemelo no, es un bug.',
  },
  {
    match: /src\/core\/paths\.js$|src\/modules\/(files|projects|backup)\//,
    text: 'VALIDACIÓN DE RUTAS: toda ruta que venga del cliente pasa por resolveWithinHome/clampToHome (core/paths.js) ANTES de tocar disco. NUNCA validar con startsWith crudo ni concatenar rutas sin clamping (riesgo de path traversal).',
  },
  {
    match: /src\/core\/sdk-settings\.js$|bin\/cwc-(chat|health|triage|healthfix)-runner\.js$|src\/modules\/(health|bugfixes|bugs)\/(index|shared)\.js$/,
    text: 'settingSources: la fuente ÚNICA es settingSourcesFor (core/sdk-settings.js). Las corridas HEADLESS (salud, triage, tickets) NUNCA deben cargar settingSources con "user"; y sus tools van blindadas por DOS capas (hook PreToolUse + canUseTool) — read-only salvo las excepciones documentadas en la regla 6 (desk_* y el auto-fix con fixToolAllowed).',
  },
  {
    match: /src\/server\.js$|src\/core\/zerotier\.js$/,
    text: 'BIND EXCLUSIVO: el server escucha SOLO en la IP ZeroTier (core/zerotier.js). Jamás 0.0.0.0 ni 127.0.0.1 como address de listen.',
  },
  {
    match: /public\/css\/(ui|style)\.css$/,
    text: 'GUARD [hidden]: existe `[hidden]{display:none!important}` global en ui.css. Cualquier regla `display` de autor sobre un elemento ocultable debe respetarlo (no pisarlo sin contemplar [hidden]).',
  },
  {
    match: /src\/modules\/projects\//,
    text: 'INTEGRIDAD de secciones: splitContextSections debe cumplir sections.join("\\n") === el archivo original byte a byte; y el POST de una sección exige el hash del texto abierto (409 si el archivo cambió) para no pisar ediciones concurrentes.',
  },
  {
    match: /src\/modules\/chat\/index\.js$/,
    text: 'AUTO-TÍTULO y otras corridas auxiliares del SDK dentro del chat deben ser READ-ONLY doble capa (regla 6) y NUNCA bloquear el turno del usuario (corren en paralelo; si fallan, se degradan en silencio).',
  },
];

// Invariantes que aplican a una unidad (por sus archivos). Devuelve textos.
export function invariantsFor(unit) {
  const files = unit?.files || [];
  return INVARIANTS.filter((inv) => files.some((f) => inv.match.test(f))).map((inv) => inv.text);
}
