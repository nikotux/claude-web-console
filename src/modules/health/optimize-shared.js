// modules/health/optimize-shared.js — lo COMPARTIDO entre el módulo server y
// el runner desacoplado de la OPTIMIZACIÓN IA (bin/cwc-optimize-runner.js).
//
// QUÉ ES: el botón "🧠 Optimización IA" de la pestaña Salud analiza el flujo de
// TODOS los motores IA de la consola (censo determinístico de
// core/inventory.js: qué modelo usa cada corrida del SDK, con qué turnos,
// timeouts y blindaje) cruzado con el CONSUMO REAL (módulo tokens) y devuelve
// PROPUESTAS de optimización: bajar/subir modelo, ajustar turnos, fusionar o
// paralelizar corridas, o proponer un flujo nuevo (orquestador/multi-agente).
//
// GARANTÍAS (mismas del resto del sistema):
//   - Regla de oro: corre en un RUNNER DETACHED con lock/heartbeat + resultado
//     persistido en ~/.cwc-data/optimization.json → sobrevive a reinicios.
//   - Regla 6: la corrida es READ-ONLY blindada por DOS capas (hook PreToolUse
//     + canUseTool) con la MISMA allowlist que el auditor de salud
//     (Read/Grep/Glob/TodoWrite). settingSources: [] (cero MCP ni permisos).
//   - Las propuestas NUNCA se auto-aplican: quedan PENDIENTES (patrón
//     invariant-proposals) y aplicar = chat supervisado (acceptEdits).
//
// PLOMERÍA COMPARTIDA (fusión 2026-07-06, propuesta de la propia Optimización
// IA): el lock/heartbeat, el store del resultado y el parseo de propuestas
// estaban duplicados línea por línea con coherence-shared.js — ahora ambos
// instancian las FÁBRICAS de proposal-runner-shared.js re-exportando los
// nombres históricos (bin/cwc-optimize-runner.js y el módulo server no cambian).
import path from 'node:path';
import { hardRulesText } from './shared.js';
import {
  DATA_DIR, readOnlyToolAllowed, makeLock, makeResultStore, makeProposalParser,
} from './proposal-runner-shared.js';
export const OPT_FILE = path.join(DATA_DIR, 'optimization.json');   // resultado persistido
export const OPT_LOCK = path.join(DATA_DIR, 'optimize.lock');       // heartbeat del runner
export const OPT_LOG = path.join(DATA_DIR, 'optimize.log');

// Cotas calibradas con la corrida real 2026-07-04: con 30 turnos sonnet se
// quedaba SIN turnos antes de emitir el JSON final (12 motores + CLAUDE.md son
// muchas lecturas) y el parseo fallaba. 60 turnos (como el triage) + timeout
// acorde; el prompt además le exige administrar el presupuesto.
export const OPT_TIMEOUT_MS = 15 * 60 * 1000; // corte duro del análisis
export const OPT_MAX_TURNS = 60;              // cota de coste (lee muchos archivos)
export const OPT_HEARTBEAT_MS = 3000;
export const OPT_LOCK_FRESH_MS = 20000;       // lock más viejo = runner muerto

// Allowlist de herramientas: SOLO lecturas locales (dos capas — regla 6).
// Idéntica a la del auditor de salud (toolAllowed de shared.js) a propósito:
// el optimizador LEE código y datos, jamás escribe.
export const optToolAllowed = readOnlyToolAllowed;

export const OPT_RISKS = new Set(['bajo', 'medio', 'alto']);
export const OPT_TIPOS = new Set(['modelo', 'turnos', 'timeout', 'flujo', 'fusion', 'paralelismo', 'prompt', 'otro']);

// Parseo defensivo + id estable (sha1 motor|tipo|propuesta) — fábrica compartida.
const parser = makeProposalParser({ keyField: 'motor', tipos: OPT_TIPOS, risks: OPT_RISKS });
export const proposalId = parser.proposalId;
export const parseOptimization = parser.parse;

// Prompt del análisis: recibe el CENSO determinístico + el CONSUMO REAL ya
// masticados (JSON) y VERIFICA leyendo el código antes de proponer.
export function optimizePrompt(census, usage) {
  // REGLAS DURAS ya masticadas (0 tool calls, mismo patrón que unitPrompt de
  // shared.js): si hardRulesText() trae texto se inyecta directo y el modelo
  // NO gasta un Read del CLAUDE.md entero (~1900 líneas) solo para esto; si
  // vino vacío (sección movida/renombrada), fallback a la instrucción vieja.
  const rules = hardRulesText();
  return [
    'Sos el CONSULTOR DE OPTIMIZACIÓN IA de Claude Web Console. Corrida NO',
    'interactiva, SOLO LECTURA (no modifiques nada, no corras comandos).',
    '',
    'La consola usa el Agent SDK en varios "motores" (chats, runners headless,',
    'corridas cortas). Tu tarea: evaluar si cada motor usa el MODELO y la',
    'CONFIGURACIÓN adecuados para su tarea, y proponer optimizaciones que',
    'mejoren costo/latencia SIN sacrificar calidad — o mejoren calidad donde',
    'hoy falta.',
    '',
    'CENSO determinístico de motores (generado por core/inventory.js —',
    'modelo, turnos, timeouts, blindaje y settings REALES de cada corrida):',
    '```json',
    JSON.stringify(census),
    '```',
    usage ? 'CONSUMO REAL por motor y modelo (módulo tokens; costo = equivalente API):' : 'CONSUMO REAL: no disponible en esta corrida.',
    ...(usage ? ['```json', JSON.stringify(usage), '```'] : []),
    ...(rules ? [
      '',
      'REGLAS DURAS del proyecto (sección «## Reglas duras» de CLAUDE.md, YA',
      'extraída acá — NO abras CLAUDE.md para esto, usá este texto directo):',
      '',
      rules,
    ] : []),
    '',
    'Método (importante — tenés un presupuesto ACOTADO de turnos, administralo:',
    ...(rules
      ? ['las reglas duras van inyectadas arriba (no gastes un turno en abrir',
        'CLAUDE.md para eso); leé SOLO los archivos que necesites verificar;']
      : ['leé primero CLAUDE.md, después SOLO los archivos que necesites verificar;']),
    'el censo y el consumo de arriba ya están masticados, no los re-derives.',
    'Reservá SIEMPRE el último turno para el bloque ```json final: una respuesta',
    'sin ese bloque no sirve de nada):',
    ...(rules
      ? ['1. Las REGLAS DURAS (1-9) van INYECTADAS arriba y son INVIOLABLES.']
      : ['1. Leé CLAUDE.md de la raíz: las REGLAS DURAS (1-9) son INVIOLABLES.']),
    '   Ninguna propuesta puede debilitar el blindaje read-only de dos capas,',
    '   los runners desacoplados, el bind ZeroTier ni el resto de las reglas.',
    '2. Por cada motor del censo, ABRÍ el archivo citado y verificá qué hace de',
    '   verdad (complejidad de la tarea, cuántas corridas dispara, prompts).',
    '3. Tené en cuenta la experiencia REAL del proyecto documentada en',
    '   CLAUDE.md: el auditor de salud pasó de haiku a sonnet porque haiku',
    '   alucinaba falsos positivos — NO propongas bajar de modelo tareas de',
    '   análisis profundo de código. Haiku sirve para tareas mecánicas de 1',
    '   turno con criterio dado en el prompt (auto-título, guardián).',
    '4. Buscá: modelo sobredimensionado en tareas mecánicas · modelo corto en',
    '   tareas profundas · maxTurns/timeout desalineados con la tarea · motores',
    '   sin modelo pineado (usan el default caro) · corridas fusionables ·',
    '   corridas serializadas que podrían paralelizarse (regla del proyecto:',
    '   paralelo lo que LEE, serial lo que ESCRIBE) · prompts que re-mandan',
    '   contexto que ya está masticado en disco (inventario, caché).',
    '5. NO inventes para llenar: si un motor está bien, no lo toques. Cada',
    '   propuesta debe citar el archivo y ser verificable leyendo el código.',
    '',
    'Al final, evaluá si vale la pena un FLUJO NUEVO (p.ej. un orquestador',
    'multi-agente para alguna fase, siguiendo los patrones ya existentes:',
    'pool adaptativo de salud, orquestador de batch). Solo si el beneficio es',
    'claro; "vale": false si la arquitectura actual ya está bien.',
    '',
    'Respondé ÚNICAMENTE con un bloque ```json con EXACTAMENTE estas claves:',
    '{',
    '  "resumen": "3-5 líneas en criollo: estado general de la flota de motores, lo más valioso primero",',
    '  "propuestas": [{',
    '    "motor": "nombre corto del motor (p.ej. triage, auto-título)",',
    '    "archivo": "ruta relativa del archivo principal",',
    '    "tipo": "modelo" | "turnos" | "timeout" | "flujo" | "fusion" | "paralelismo" | "prompt" | "otro",',
    '    "actual": "configuración/comportamiento actual, concreto",',
    '    "propuesta": "qué cambiar, concreto y accionable",',
    '    "razon": "por qué mejora (con evidencia del código/consumo)",',
    '    "impacto": "qué se gana (menos tokens, más calidad, menos latencia…)",',
    '    "riesgo": "bajo" | "medio" | "alto",',
    '    "archivos": ["rutas a tocar"],',
    '    "pasos": ["pasos concretos para aplicarla"]',
    '  }],',
    '  "flujoNuevo": { "vale": true|false, "titulo": "…", "descripcion": "…", "diseno": ["fase/pieza por línea"] }',
    '}',
    'Máximo 12 propuestas, ordenadas por valor (impacto/riesgo). Sin texto',
    'fuera del bloque.',
  ].join('\n');
}

// ===== Resultado persistido (sobrevive reinicios; el front lo encuesta) =====
const store = makeResultStore({
  file: OPT_FILE, tag: 'optimize',
  empty: () => ({ updatedAt: null, resumen: null, propuestas: [], flujoNuevo: null, error: null }),
});
export const readOpt = store.read;
export const writeOpt = store.write;

// ===== Lock/heartbeat del runner (patrón desk/triage) =====
// Fábrica compartida: reserva pid:0 del server + reclamo del runner (ver
// makeLock en proposal-runner-shared.js — otherOptAlive exige pid real).
const lock = makeLock({ file: OPT_LOCK, freshMs: OPT_LOCK_FRESH_MS });
export const writeOptLock = lock.write;
export const clearOptLock = lock.clear;
export const readOptLock = lock.read;
export const isOptRunning = lock.isRunning;
export const otherOptAlive = lock.otherAlive;
