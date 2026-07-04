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
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
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
export function optToolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name);
}

export const OPT_RISKS = new Set(['bajo', 'medio', 'alto']);
export const OPT_TIPOS = new Set(['modelo', 'turnos', 'timeout', 'flujo', 'fusion', 'paralelismo', 'prompt', 'otro']);

// id estable de una propuesta (para aceptar/descartar sin ambigüedad).
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
export const proposalId = (p) => sha(`${p.motor || ''}|${p.tipo || ''}|${p.propuesta || ''}`);

// Prompt del análisis: recibe el CENSO determinístico + el CONSUMO REAL ya
// masticados (JSON) y VERIFICA leyendo el código antes de proponer.
export function optimizePrompt(census, usage) {
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
    '',
    'Método (importante — tenés un presupuesto ACOTADO de turnos, administralo:',
    'leé primero CLAUDE.md, después SOLO los archivos que necesites verificar;',
    'el censo y el consumo de arriba ya están masticados, no los re-derives.',
    'Reservá SIEMPRE el último turno para el bloque ```json final: una respuesta',
    'sin ese bloque no sirve de nada):',
    '1. Leé CLAUDE.md de la raíz: las REGLAS DURAS (1-9) son INVIOLABLES.',
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

// Parseo defensivo del texto del modelo → resultado normalizado.
export function parseOptimization(text) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : (String(text || '').match(/\{[\s\S]*\}/) || [])[0];
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const propuestas = (Array.isArray(o.propuestas) ? o.propuestas : []).slice(0, 12).map((p) => {
    const clean = {
      motor: String(p.motor ?? '').slice(0, 80),
      archivo: String(p.archivo ?? '').slice(0, 200),
      tipo: OPT_TIPOS.has(p.tipo) ? p.tipo : 'otro',
      actual: String(p.actual ?? '').slice(0, 400),
      propuesta: String(p.propuesta ?? '').slice(0, 500),
      razon: String(p.razon ?? '').slice(0, 600),
      impacto: String(p.impacto ?? '').slice(0, 300),
      riesgo: OPT_RISKS.has(p.riesgo) ? p.riesgo : 'medio',
      archivos: (Array.isArray(p.archivos) ? p.archivos : []).slice(0, 6).map((a) => String(a).slice(0, 200)),
      pasos: (Array.isArray(p.pasos) ? p.pasos : []).slice(0, 8).map((s) => String(s).slice(0, 300)),
      status: 'pending',
    };
    return { ...clean, id: proposalId(clean) };
  });
  const fn = o.flujoNuevo && typeof o.flujoNuevo === 'object' ? o.flujoNuevo : null;
  return {
    resumen: String(o.resumen ?? '').slice(0, 1200),
    propuestas,
    flujoNuevo: fn ? {
      vale: fn.vale === true,
      titulo: String(fn.titulo ?? '').slice(0, 120),
      descripcion: String(fn.descripcion ?? '').slice(0, 800),
      diseno: (Array.isArray(fn.diseno) ? fn.diseno : []).slice(0, 10).map((s) => String(s).slice(0, 300)),
    } : null,
  };
}

// ===== Resultado persistido (sobrevive reinicios; el front lo encuesta) =====
export function readOpt() {
  try { return JSON.parse(fss.readFileSync(OPT_FILE, 'utf8')); }
  catch { return { updatedAt: null, resumen: null, propuestas: [], flujoNuevo: null, error: null }; }
}
export function writeOpt(data) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(OPT_FILE, JSON.stringify(data), { mode: 0o600 });
  } catch (err) { console.error('[optimize] no pude escribir optimization.json:', err?.message); }
}

// ===== Lock/heartbeat del runner (patrón desk/triage) =====
// Guarda { pid, ts, phase } — phase alimenta el progreso del front. El server
// RESERVA con pid:0 antes de spawnear (cierra la carrera TOCTOU, patrón
// spawnFix); el runner reclama esa reserva (otherOptAlive exige pid real).
export function writeOptLock(state) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(OPT_LOCK, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearOptLock() { try { fss.unlinkSync(OPT_LOCK); } catch { /* noop */ } }
export function readOptLock() {
  try {
    const l = JSON.parse(fss.readFileSync(OPT_LOCK, 'utf8'));
    if (Date.now() - l.ts >= OPT_LOCK_FRESH_MS) return null; // lock viejo = runner muerto
    return l;
  } catch { return null; }
}
export function isOptRunning() { return !!readOptLock(); }
// ¿Hay OTRO runner realmente corriendo? Exige pid REAL (≠ 0): la reserva del
// server (pid:0) NO cuenta — sin esto el runner vería su propia reserva y se
// auto-deadlockearía (mismo patrón que otherBatchAlive del orquestador).
export function otherOptAlive() {
  try {
    const { pid, ts } = JSON.parse(fss.readFileSync(OPT_LOCK, 'utf8'));
    return !!pid && pid !== process.pid && Date.now() - ts < OPT_LOCK_FRESH_MS;
  } catch { return false; }
}
