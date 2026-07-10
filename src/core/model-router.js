// core/model-router.js — NÚCLEO del router de modelo automático del chat (AutoTux).
//
// NO es un motor: es plomería IN-PROCESS (mismo patrón que core/tool-policy.js),
// consultada EN VIVO por Chat.sendUser() (modules/chat/index.js) en cada turno
// real del usuario. Decide si conviene subir/bajar el modelo de la conversación
// y aplica el cambio con el MISMO mecanismo que ya usa el selector manual
// (Chat.setModel() → q.setModel() del SDK) — cero plomería de cambio de modelo
// nueva, solo la DECISIÓN.
//
// ─────────────────────────────────────────────────────────────────────────────
// v2 (2026-07-10) — REDISEÑO tras revisión externa + simulacros con datos reales.
// Documentos: docs/autotux-analisis-externo.md (diagnóstico) +
// ~/pool of documents/2026-07-10_autotux-propuesta-rediseno_v01.md (propuesta).
//
// PROBLEMA de v1 (medido en model-router-log.jsonl, 62 decisiones): el router
// colapsaba en un flip-flop Sonnet↔Opus (49 subidas / 13 bajadas / 0 a haiku o
// fable). Tres causas que se reforzaban:
//   1. Saltos DIRECTOS al techo (code fence / ≥800 chars → Opus de un salto).
//   2. Histéresis con la asimetría en la dirección equivocada: subir sin inercia
//      + bajar lento ⇒ "trepar y quedarse".
//   3. Un solo estado (el modelo del chat) que toda decisión mutaba ⇒ Haiku
//      quedaba estructuralmente inalcanzable.
//
// v2 (shape "v2b segura", validado por simulacro: ~12-18% de ahorro SIN riesgo
// de calidad — ver /tmp/autotux-sim*.js del análisis):
//   C1. FABLE PROHIBIDO: fuera de MODEL_LEVELS + guard en el call-site. Ya no es
//       "techo", es prohibición (pedido del dueño).
//   C2. Todos los movimientos automáticos son ±1 escalón (nunca saltos).
//   C3. COOLDOWN anti-rebote: tras cada cambio, 2 turnos congelados para señales
//       no-fuertes (análogo a BGP route-flap dampening — penalizar la
//       oscilación, no el cambio).
//   C4. Separar NIVEL BASE (pegajoso, histéresis+cooldown) del OVERRIDE DE TURNO
//       (Haiku SOLO ese turno, sin tocar estado). El override se limita a acks
//       de CIERRE (perfecto/gracias/listo…) — NUNCA a go-aheads (dale/ok/sí) que
//       suelen DISPARAR trabajo: correr una implementación en Haiku es frágil
//       (hallazgo del simulacro).
//   C5. Escalada por EVIDENCIA DE INSUFICIENCIA (corrección del usuario · errores
//       de herramientas), no por conteo bruto de tools. La corrección del
//       usuario ("no funciona", "está mal") es una etiqueta de calidad GRATIS
//       con ground truth — sube en el acto. Esto cumple el requisito "detectar
//       que el modelo no alcanzó y subir" SIN re-correr el turno (el auto-redo
//       automático disparó 0 veces en los simulacros: o ya estás en Opus, o la
//       corrección escala un turno antes y gratis; se descartó por riesgo/nulo
//       beneficio).
//   +  Bajada por INACTIVIDAD (idle ≥60 min ⇒ decae 1 escalón al reanudar).
//
// Fundamentos citados (research; el razonamiento se sostiene solo): RouteLLM/
// FrugalGPT (cascada arrancar-barato-escalar), AutoMix (auto-verificación para
// escalar), BGP route-flap dampening (RFC 2439, cooldown). Bandit/RL descartado:
// con ~62 decisiones no hay volumen para aprender una política sin sobreajuste.
//
// Activación implícita: SOLO gestiona un chat si su modelo ACTUAL mapea a la
// escala (clampLevel != -1). opusplan/default ⇒ router inerte a propósito.
// El estado por chat persistido sigue siendo MÍNIMO: dos contadores chicos
// (downStreak, cooldown). El nivel se deriva de chat.model, no se duplica.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = path.join(os.homedir(), '.cwc-data', 'model-router-log.jsonl');
const TURN_LOG_FILE = path.join(os.homedir(), '.cwc-data', 'model-router-turns.jsonl');
const LOG_MAX_BYTES = 2 * 1024 * 1024; // tope crudo — ver poda

function appendCapped(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...obj })}\n`, { mode: 0o600 });
    const size = fs.statSync(file).size;
    if (size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(-Math.floor(lines.length / 2));
      fs.writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
    }
  } catch { /* best-effort: nunca romper el turno */ }
}

// Registro append-only de UN cambio de modelo decidido por el router. `entry`:
// { chatId, sessionId, source: 'heuristic'|'classifier'|'reactive'|'override'|
//   'insufficiency'|'idle'|'guard', from, to, text }.
export function logDecision(entry) { appendCapped(LOG_FILE, entry); }

// Registro por TURNO (para calibrar: distribución de turnos por nivel + tasa de
// rebote — v1 solo logueaba CAMBIOS, así que Haiko 0% era invisible). Liviano.
// { chatId, ranLevel, base, override(bool), toolCalls, toolErrors }.
export function logTurn(entry) { appendCapped(TURN_LOG_FILE, entry); }

// Escala GESTIONADA por el router, barato→caro. FABLE PROHIBIDO (v2, C1): no
// está acá y el call-site lo bloquea (FORBIDDEN_AUTO). El índice ES el nivel.
export const MODEL_LEVELS = ['haiku', 'sonnet', 'opus'];
export const CEILING = MODEL_LEVELS.length - 1; // 2 = opus
export const FORBIDDEN_AUTO = new Set(['fable']); // guard de defensa en profundidad

// v2: subir sigue siendo rápido (1 señal) pero con COOLDOWN posterior; bajar
// exige 2 turnos "down" seguidos (era 3 — C5 cubre el riesgo de bajar de más).
const DOWN_STREAK_TO_DEMOTE = 2;
const COOLDOWN_TURNS = 2;            // turnos congelados tras un cambio (anti-rebote)
const LONG_MESSAGE_CHARS = 1200;     // era 800; longitud ≠ dificultad, ahora señal débil
const REACTIVE_TOOL_THRESHOLD = 10;  // era 6; ahora exige ADEMÁS ≥1 error de tool
export const IDLE_DECAY_MS = 60 * 60 * 1000; // ≥60 min dormido ⇒ decae 1 escalón

// Acks de CIERRE (cierran un hilo, NO disparan trabajo) ⇒ override efímero a
// Haiku seguro. Deliberadamente NO incluye dale/ok/sí (go-aheads).
const CLOSING_ACK_RE = /^(perfecto|genial|gracias|buen[ií]simo|excelente|listo|entendido|de acuerdo|correcto|continuemos?|sigamos?|joya|impecable|barbaro|bárbaro)[.!¡¿?\s]*$/i;
// Go-ahead / confirmaciones que PUEDEN disparar trabajo ⇒ cuentan para bajar el
// base (señal 'down') pero NUNCA override (correr trabajo en Haiku es frágil).
const GOAHEAD_RE = /^(ok(ay)?|dale|s[ií]|vale|bueno|ya|ah+ ok|de una|hac[eé]lo|seguí|segu[ií]|continu[áa]|dale,?\s*(seguí|segu[ií]|continu[áa])?)[.!¡¿?\s]*$/i;
const CODE_FENCE_RE = /```/;
// Etiqueta humana GRATIS: el usuario corrige ⇒ el modelo no alcanzó (C5).
const USER_CORRECTION_RE = /\b(no funciona|no sirve|est[áa] mal|no era eso|eso no|no es lo que|sigue fallando|sigue sin|otra vez el error|otra vez fall|incorrecto|te equivocaste|no compil[óa]|no compila|rompiste|revert[íi]|volv[ée] atr[áa]s)\b/i;

// Deriva el nivel del modelo. -1 ⇒ no gestionado (opusplan/default). fable
// (elección manual previa que vuelve a 'auto') ⇒ se clampa a opus, NO a -1
// (bug de v1: indexOf('fable') daba 3 con la escala vieja; con la nueva daría
// -1 y el router quedaría inerte por accidente — se maneja explícito).
export function clampLevel(model) {
  const i = MODEL_LEVELS.indexOf(model);
  if (i !== -1) return i;
  if (model === 'fable') return CEILING;
  return -1;
}

// Clasifica el TEXTO del turno en una SEÑAL (nunca un nivel absoluto):
//  closing   → override a Haiku este turno + cuenta como 'down' para el base
//  goahead   → 'down' para el base, SIN override
//  strong_up → +1 inmediato, rompe cooldown (corrección del usuario)
//  up        → +1, respeta cooldown (trae código o mensaje muy largo)
//  ambiguous → el llamador consulta al clasificador relativo (Haiku, background)
//  none      → texto vacío
export function classifySignal(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'none' };
  if (USER_CORRECTION_RE.test(t)) return { kind: 'strong_up' };   // prioridad: corrección aunque sea corta
  if (t.length <= 80 && CLOSING_ACK_RE.test(t)) return { kind: 'closing' };
  if (t.length <= 80 && GOAHEAD_RE.test(t)) return { kind: 'goahead' };
  if (CODE_FENCE_RE.test(t)) return { kind: 'up' };
  if (t.length >= LONG_MESSAGE_CHARS) return { kind: 'up' };
  return { kind: 'ambiguous' };
}

// Mapea una señal a un MOVIMIENTO del base: 'up'|'down'|'strong_up'|'same'.
export function signalToMove(kind) {
  if (kind === 'strong_up') return 'strong_up';
  if (kind === 'up') return 'up';
  if (kind === 'closing' || kind === 'goahead') return 'down';
  return 'same'; // none/ambiguous: el llamador decide
}

// Override efímero de turno: un ack de CIERRE corre este turno en Haiku (0) sin
// tocar el estado. Cualquier otra cosa: null (sin override).
export function turnOverride(kind) {
  return kind === 'closing' ? 0 : null;
}

// Aplica un MOVIMIENTO ±1 al nivel base con cooldown anti-rebote. Devuelve el
// estado nuevo { level, downStreak, cooldown, changed }. Es la ÚNICA función que
// hace la aritmética del cooldown (el llamador no lo decrementa aparte).
export function decideBase({ baseLevel, move, downStreak = 0, cooldown = 0 }) {
  const dec = Math.max(0, cooldown - 1); // decae al procesar el turno
  if (move === 'strong_up') { // corrección del usuario: rompe cooldown
    if (baseLevel >= CEILING) return { level: baseLevel, downStreak: 0, cooldown: dec, changed: false };
    return { level: baseLevel + 1, downStreak: 0, cooldown: COOLDOWN_TURNS, changed: true };
  }
  if (cooldown > 0) { // congelado para señales no-fuertes; el streak NO avanza
    return { level: baseLevel, downStreak, cooldown: dec, changed: false };
  }
  if (move === 'up') {
    if (baseLevel >= CEILING) return { level: baseLevel, downStreak: 0, cooldown: 0, changed: false };
    return { level: baseLevel + 1, downStreak: 0, cooldown: COOLDOWN_TURNS, changed: true };
  }
  if (move === 'down') {
    const streak = downStreak + 1;
    if (baseLevel > 0 && streak >= DOWN_STREAK_TO_DEMOTE) {
      return { level: baseLevel - 1, downStreak: 0, cooldown: COOLDOWN_TURNS, changed: true };
    }
    return { level: baseLevel, downStreak: streak, cooldown: 0, changed: false };
  }
  return { level: baseLevel, downStreak: 0, cooldown: 0, changed: false }; // 'same'
}

// Escalada por INSUFICIENCIA para el PRÓXIMO turno (C5): evidencia, no volumen.
// hardFail = ≥2 errores de tool; bigAndFailing = ≥10 tools Y ≥1 error. Devuelve
// null si no aplica (ya en el techo, o sin evidencia).
export function insufficiencyEscalation({ baseLevel, toolCalls = 0, toolErrors = 0 }) {
  if (baseLevel < 0 || baseLevel >= CEILING) return null;
  const hardFail = toolErrors >= 2;
  const bigAndFailing = toolCalls >= REACTIVE_TOOL_THRESHOLD && toolErrors >= 1;
  if (!hardFail && !bigAndFailing) return null;
  return { level: baseLevel + 1, downStreak: 0, cooldown: COOLDOWN_TURNS, changed: true };
}

// ¿Corresponde una bajada por inactividad? (idle ≥ IDLE_DECAY_MS y base por
// encima de sonnet). Devuelve 'down' o null. La sesión intensa que justificó
// Opus probablemente terminó; si no, el 1er turno con código la sube de nuevo.
export function idleDecayMove({ baseLevel, idleMs }) {
  return (baseLevel > 1 && idleMs >= IDLE_DECAY_MS) ? 'down' : null;
}
