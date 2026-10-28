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
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';

function routerLogFile(dataDir) { return path.join(dataDir || resolveDataDir(), 'model-router-log.jsonl'); }
function routerTurnsFile(dataDir) { return path.join(dataDir || resolveDataDir(), 'model-router-turns.jsonl'); }
function planLimitsFile(dataDir) { return path.join(dataDir || resolveDataDir(), 'plan-limits.json'); }
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
// El llamador debe pasar el dataDir del DUEÑO del chat; sin él cae al data-dir del proceso.
export function logDecision(entry, { dataDir } = {}) { appendCapped(routerLogFile(dataDir), entry); }

// Registro por TURNO (para calibrar: distribución de turnos por nivel + tasa de
// rebote — v1 solo logueaba CAMBIOS, así que Haiko 0% era invisible). Liviano.
// Enriquecido (PEND-391 #2/#4): { chatId, model, modelChoice, switchedFromPrev,
// prevModel, effort, ranLevel, base, override, toolCalls, toolErrors,
// cacheCreate, cacheRead, input, output }.
export function logTurn(entry, { dataDir } = {}) { appendCapped(routerTurnsFile(dataDir), entry); }

// Métricas de calibración (PEND-391 #4): lee model-router-turns.jsonl (0 tokens,
// solo disco) y computa lo que la investigación pidió medir — distribución de
// turnos por MODELO, tasa de REBOTE (turnos que cambiaron de modelo / total), y
// la AUDITORÍA DE CACHÉ (#2): en los turnos donde el modelo CAMBIÓ vs los que
// NO, ¿cuánto cae cache_read y cuánto sube cache_creation? Si el switch invalida
// el caché, los turnos con switch tendrán cacheRead≈0 y cacheCreate alto — eso
// CONFIRMA que rebotar de tier cuesta tokens de la ventana de rate-limit.
export function readTurnMetrics({ limit = 4000, dataDir } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(routerTurnsFile(dataDir), 'utf8').split('\n').filter(Boolean);
  } catch { return { turns: 0, byModel: {}, bounceRate: 0, cache: null, note: 'sin datos aún' }; }
  const rows = lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byModel = {};
  let switches = 0, withUsage = 0;
  const acc = (bucket) => ({ n: 0, cacheRead: 0, cacheCreate: 0, input: 0, output: 0, ...bucket });
  const sw = acc(), nosw = acc();
  for (const r of rows) {
    const m = r.model || 'desconocido';
    byModel[m] = (byModel[m] || 0) + 1;
    if (r.switchedFromPrev) switches++;
    // Solo turnos con usage real (cacheRead/cacheCreate no null) para la auditoría.
    if (r.cacheRead != null || r.cacheCreate != null) {
      withUsage++;
      const b = r.switchedFromPrev ? sw : nosw;
      b.n++; b.cacheRead += r.cacheRead || 0; b.cacheCreate += r.cacheCreate || 0;
      b.input += r.input || 0; b.output += r.output || 0;
    }
  }
  const avg = (b) => b.n ? {
    turns: b.n,
    avgCacheRead: Math.round(b.cacheRead / b.n),
    avgCacheCreate: Math.round(b.cacheCreate / b.n),
    avgInput: Math.round(b.input / b.n),
  } : { turns: 0 };
  return {
    turns: rows.length,
    byModel,
    bounceRate: rows.length ? +(switches / rows.length).toFixed(3) : 0,
    switches,
    cache: withUsage ? {
      // Auditoría de la hipótesis del caché (#2): comparar los dos buckets.
      switched: avg(sw),      // turnos donde el modelo cambió vs el turno previo
      notSwitched: avg(nosw), // turnos SIN cambio de modelo
      hypothesis: 'si switched.avgCacheRead << notSwitched.avgCacheRead, el switch de modelo invalida el caché (rebotar de tier cuesta tokens de la ventana)',
    } : { note: 'aún no hay turnos con usage de caché; se llena a medida que se usan los chats con la instrumentación nueva' },
  };
}

// REENCUADRE (PEND-391 #5): el objetivo real del router NO es ahorrar $ (es
// suscripción, no se factura por token) sino NO QUEMAR LA VENTANA DE
// RATE-LIMIT (5 h / semanal de claude.ai). Por eso la métrica de calibración
// se lee en TOKENS de la ventana (model-router-turns.jsonl), no en dólares, y
// el caché de prompt importa: un switch de modelo lo invalida (cache_read→0),
// así que rebotar de tier puede COSTAR tokens en vez de ahorrarlos.

// Escala GESTIONADA por el router, barato→caro. FABLE PROHIBIDO (v2, C1): no
// está acá y el call-site lo bloquea (FORBIDDEN_AUTO). El índice ES el nivel.
export const MODEL_LEVELS = ['haiku', 'sonnet', 'opus'];

// Eje thinking effort (PEND-391 #3): effort por defecto según el NIVEL de
// AutoTux — una palanca de profundidad MÁS BARATA que saltar de tier. Un chat
// nace/reabre con este effort (es opción de SPAWN del SDK, no hay setEffort en
// vivo). El usuario puede pisar el effort a mano desde el submenú de Sesiones.
const EFFORT_BY_LEVEL = ['low', 'medium', 'high']; // haiku→low · sonnet→medium · opus→high
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// AUTO nunca sube el effort más allá de 'high' solo (xhigh/max son caros y
// quedan para elección MANUAL, mismo criterio que fable en el eje modelo).
export const AUTO_EFFORT_MAX_IDX = 2; // 'high'
export function effortForLevel(level) {
  if (typeof level !== 'number' || level < 0) return null;
  return EFFORT_BY_LEVEL[Math.min(level, EFFORT_BY_LEVEL.length - 1)];
}
export function effortForModel(model) {
  const lvl = clampLevel(model); // clampLevel es function declaration (hoisted)
  return lvl === -1 ? null : effortForLevel(lvl);
}
export function effortIdx(effort) {
  const i = EFFORT_LEVELS.indexOf(effort);
  return i === -1 ? -1 : i;
}

// ─── F1+F2 (PEND-405): eje EFFORT como decisión de ruteo, caché-aware ──────────
// El effort es una palanca de profundidad MÁS BARATA que saltar de tier de
// modelo, y —clave— NO invalida el caché de prompt (un cambio de modelo SÍ, lo
// medimos en la instrumentación #2). Por eso, ante una necesidad de "subir",
// el router elige ENTRE subir effort (mismo modelo, caché intacto) o saltar de
// tier (más capaz pero tira el caché). Regla:
//   - Señal DURA (corrección del usuario / insuficiencia por errores de tool):
//     necesita CAPACIDAD real ⇒ salta de TIER (el effort no arregla un modelo
//     que no da abasto).
//   - Señal BLANDA (clasificador 'up' / código / mensaje largo): probamos el
//     effort PRIMERO si hay margen (más barato); si no, tier.
//   - Caché PEGAJOSO (el último turno leyó mucho del caché): sesga hacia effort
//     incluso en señales duras borderline — saltar de tier desperdiciaría ese
//     caché (cuesta tokens de la ventana de rate-limit, el objetivo real #5).
export const CACHE_STICKY_TOKENS = 15000; // cacheRead ≥ esto ⇒ hay prefijo cacheado que vale conservar
// Devuelve 'effort' (subir effort, mismo modelo) | 'model' (saltar tier) |
// 'none' (sin margen en ninguno). `pinned` = la persona fijó el effort a mano
// (no lo tocamos: siempre 'model'). effortIdx/level son índices; -1 = fuera de
// escala (no gestionado). lastCacheRead en tokens (0 si no hay dato).
export function decideUpAxis({ hard = false, level = -1, effortIndex = -1, lastCacheRead = 0, pinned = false, conserve = false, ceiling = CEILING }) {
  const canModel = level >= 0 && level < ceiling;
  const canEffort = !pinned && effortIndex >= 0 && effortIndex < AUTO_EFFORT_MAX_IDX;
  if (!canEffort && !canModel) return 'none';
  // F4: ventana de rate-limit apretada ⇒ NUNCA saltar de tier (invalida caché +
  // opus quema más ventana). Solo subir effort si hay margen; si no, quedarse.
  if (conserve) return canEffort ? 'effort' : 'none';
  if (!canEffort) return 'model';
  if (!canModel) return 'effort';
  const sticky = lastCacheRead >= CACHE_STICKY_TOKENS;
  if (hard) return sticky ? 'effort' : 'model';   // dura: tier salvo caché pegajoso
  return 'effort';                                 // blanda: effort primero (barato)
}

// F4 (PEND-405): presión de la ventana de rate-limit (0 tokens — solo lee el
// snapshot plan-limits.json que el módulo tokens persiste). El llamador pasa el
// data-dir del DUEÑO del chat; sin él cae al data-dir del proceso. Este núcleo NO
// importa user-space a propósito: también lo consume bin/cwc-test-model-router.js.
// Devuelve el % MÁXIMO usado entre las ventanas (sesión 5h / semanal), 0..100, o
// null si no hay dato. El router se pone conservador al superar el umbral.
export const WINDOW_PRESSURE_CONSERVE = 75; // ≥75% usado ⇒ conservar (effort, no tier)
export function readWindowPressure(dataDir = null) {
  try {
    const file = planLimitsFile(dataDir);
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!obj || !Array.isArray(obj.limits)) return null;
    const pcts = obj.limits.map((l) => (typeof l.percent === 'number' ? l.percent : null)).filter((p) => p != null);
    return pcts.length ? Math.max(...pcts) : null;
  } catch { return null; }
}
// Simétrico para bajar: si el effort está POR ENCIMA del default del tier
// (fue subido por el router), bajarlo PRIMERO antes de bajar de modelo — así el
// modelo (y su caché) se conservan más tiempo. Devuelve 'effort' | 'model'.
export function decideDownAxis({ level = -1, effortIndex = -1, tierEffortIndex = -1, pinned = false }) {
  if (!pinned && effortIndex >= 0 && tierEffortIndex >= 0 && effortIndex > tierEffortIndex) return 'effort';
  return 'model';
}
export const CEILING = MODEL_LEVELS.length - 1; // 2 = opus
export const FORBIDDEN_AUTO = new Set(['fable']); // guard de defensa en profundidad

// PLAN-519 F1: AutoTux con techo FABLE OPCIONAL. Cuando el usuario opta-in
// (fableCeiling por chat), la escala de ESE chat se extiende UN nivel arriba,
// contigua: ['haiku','sonnet','opus','fable']. Sin opt-in, es la escala base de
// 3 (fable sigue prohibido en auto). Las funciones del router aceptan `levels`/
// `ceiling` por parámetro (default = base) para no cambiar el comportamiento
// existente. El effort de fable (nivel 3) cae a 'high' por el Math.min de
// effortForLevel — AUTO nunca pasa de 'high'.
export function levelsFor(fableCeiling) {
  return fableCeiling ? [...MODEL_LEVELS, 'fable'] : MODEL_LEVELS;
}

// v2: subir sigue siendo rápido (1 señal) pero con COOLDOWN posterior; bajar
// exige 2 turnos "down" seguidos (era 3 — C5 cubre el riesgo de bajar de más).
const DOWN_STREAK_TO_DEMOTE = 2;
const COOLDOWN_TURNS = 2;            // turnos congelados tras un cambio (anti-rebote)
const LONG_MESSAGE_CHARS = 1200;     // era 800; longitud ≠ dificultad, ahora señal débil
const REACTIVE_TOOL_THRESHOLD = 10;  // era 6; ahora exige ADEMÁS ≥1 error de tool
// Decisión abierta #3 de la investigación (PEND-391), resuelta a AGRESIVO: 30
// min (antes 60). Un chat que estuvo media hora quieto en Opus casi seguro
// terminó su sesión intensa; si no, el 1er turno con código lo re-sube. Bajar
// esta constante ahorra ventana de rate-limit sin riesgo (la subida es barata).
export const IDLE_DECAY_MS = 30 * 60 * 1000; // ≥30 min dormido ⇒ decae 1 escalón

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
export function clampLevel(model, levels = MODEL_LEVELS) {
  const i = levels.indexOf(model);
  if (i !== -1) return i;
  // fable fuera de la escala (sin opt-in): se clampa al techo de la escala dada
  // (mismo criterio histórico: una elección manual de fable que vuelve a auto).
  if (model === 'fable') return levels.length - 1;
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
export function decideBase({ baseLevel, move, downStreak = 0, cooldown = 0, ceiling = CEILING }) {
  const dec = Math.max(0, cooldown - 1); // decae al procesar el turno
  if (move === 'strong_up') { // corrección del usuario: rompe cooldown
    if (baseLevel >= ceiling) return { level: baseLevel, downStreak: 0, cooldown: dec, changed: false };
    return { level: baseLevel + 1, downStreak: 0, cooldown: COOLDOWN_TURNS, changed: true };
  }
  if (cooldown > 0) { // congelado para señales no-fuertes; el streak NO avanza
    return { level: baseLevel, downStreak, cooldown: dec, changed: false };
  }
  if (move === 'up') {
    if (baseLevel >= ceiling) return { level: baseLevel, downStreak: 0, cooldown: 0, changed: false };
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
export function insufficiencyEscalation({ baseLevel, toolCalls = 0, toolErrors = 0, ceiling = CEILING }) {
  if (baseLevel < 0 || baseLevel >= ceiling) return null;
  const hardFail = toolErrors >= 2;
  const bigAndFailing = toolCalls >= REACTIVE_TOOL_THRESHOLD && toolErrors >= 1;
  if (!hardFail && !bigAndFailing) return null;
  return { level: baseLevel + 1, downStreak: 0, cooldown: COOLDOWN_TURNS, changed: true };
}

// ─── F5(b) (PEND-405): loop de calibración DETERMINÍSTICO — alternativa al #6 ──
// En vez de entrenar un clasificador ML (riesgoso, bloqueado por datos), MINAMOS
// determinísticamente (0 tokens, sin ML, patrón core/inventory.js) los logs
// reales del router para: (1) PROPONER ajustes de umbrales aprobables (patrón
// invariantes de Salud — nada se auto-aplica), y (2) derivar SEÑALES APRENDIDAS
// (keyword→dirección) que la heurística puede consultar antes de gastar el
// clasificador Haiku. TODO gateado por SUFICIENCIA DE DATOS: con pocos ejemplos
// (~108 hoy) devuelve casi vacío a propósito — el punto del #6 era que hace
// falta volumen; acá lo hacemos explícito en vez de sobreajustar.
const CALIB_MIN_DECISIONS = 400;   // menos que esto ⇒ señales aprendidas OFF (ruido)
const CALIB_MIN_SUPPORT = 6;       // ocurrencias mínimas de un keyword para confiar
const STOPWORDS = new Set(['para','pero','como','esto','esta','este','que','con','los','las','del','una','uno','por','the','and','for','you','are','con','más','muy','sin','sus','han','hay','fue','ver','así','solo','todo','cada']);
export function analyzeCalibration({ decisionsLimit = 8000, turnsLimit = 8000, dataDir } = {}) {
  const readJsonl = (file, lim) => {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lim).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return []; }
  };
  const decisions = readJsonl(routerLogFile(dataDir), decisionsLimit);
  const turns = readJsonl(routerTurnsFile(dataDir), turnsLimit);
  const proposals = [];

  // (1) Fuentes de decisión (para ver qué domina).
  const bySource = {};
  for (const d of decisions) bySource[d.source || '?'] = (bySource[d.source || '?'] || 0) + 1;

  // (2) Tasa de rebote (turnos que cambiaron de modelo / total con dato).
  const switched = turns.filter((t) => t.switchedFromPrev).length;
  const bounceRate = turns.length ? +(switched / turns.length).toFixed(3) : 0;
  if (turns.length >= 50 && bounceRate > 0.3) {
    proposals.push({ id: 'bounce-high', kind: 'umbral', current: 'COOLDOWN_TURNS=2', suggested: 'COOLDOWN_TURNS=3', rationale: `Tasa de rebote ${(bounceRate * 100).toFixed(0)}% (>30%): el router cambia de modelo demasiado seguido. Subir el cooldown anti-rebote lo estabiliza.`, evidence: { bounceRate, switched, turns: turns.length } });
  }

  // (3) Auditoría de caché del closing-ack→Haiku (¿ahorro NEGATIVO?): un override
  // corre en Haiku, pero el turno SIGUIENTE re-crea el caché (switchedFromPrev).
  const overrideTurns = turns.filter((t) => t.override);
  const withUsage = turns.filter((t) => t.cacheRead != null);
  if (overrideTurns.length >= 10) {
    const swAfter = turns.filter((t) => t.switchedFromPrev && (t.cacheCreate || 0) > (t.cacheRead || 0)).length;
    const ratio = withUsage.length ? swAfter / withUsage.length : 0;
    if (ratio > 0.2) {
      proposals.push({ id: 'closing-ack-cache', kind: 'flujo', current: 'closing-ack→Haiku activo', suggested: 'evaluar desactivar el override a Haiku', rationale: `Muchos turnos con switch re-crean más caché del que leen (${(ratio * 100).toFixed(0)}%): el override de cierre a Haiku podría dar AHORRO NEGATIVO (invalida el caché y el turno siguiente lo re-crea). Medir con más datos antes de tocar.`, evidence: { overrideTurns: overrideTurns.length, ratio } });
    }
  }

  // (4) Distribución por modelo (¿algún nivel nunca se usa?).
  const byModel = {};
  for (const t of turns) byModel[t.model || '?'] = (byModel[t.model || '?'] || 0) + 1;

  // (5) SEÑALES APRENDIDAS (keyword→dirección) — gateadas por suficiencia.
  let learnedSignals = [];
  const dataSufficient = decisions.length >= CALIB_MIN_DECISIONS;
  if (dataSufficient) {
    const upWords = {}, downWords = {};
    for (const d of decisions) {
      const up = d.source === 'correction' || d.source === 'insufficiency' || (d.to && d.from && MODEL_LEVELS.indexOf(d.to) > MODEL_LEVELS.indexOf(d.from));
      const bag = up ? upWords : downWords;
      for (const w of String(d.text || '').toLowerCase().replace(/[^a-záéíóúñ0-9\s]/g, ' ').split(/\s+/)) {
        if (w.length < 4 || STOPWORDS.has(w)) continue;
        bag[w] = (bag[w] || 0) + 1;
      }
    }
    for (const [w, n] of Object.entries(upWords)) {
      if (n >= CALIB_MIN_SUPPORT && (upWords[w] || 0) > 2 * (downWords[w] || 0)) {
        learnedSignals.push({ keyword: w, dir: 'up', support: n });
      }
    }
    learnedSignals = learnedSignals.sort((a, b) => b.support - a.support).slice(0, 40);
  }

  return {
    decisions: decisions.length,
    turns: turns.length,
    bySource,
    byModel,
    bounceRate,
    proposals,
    learnedSignals,
    dataSufficiency: { decisions: decisions.length, needed: CALIB_MIN_DECISIONS, sufficientForLearnedSignals: dataSufficient, note: dataSufficient ? 'hay datos para señales aprendidas' : `faltan datos: ${decisions.length}/${CALIB_MIN_DECISIONS} decisiones para activar señales aprendidas (evita sobreajuste con poco volumen — el motivo por el que el clasificador ML #6 se descartó)` },
  };
}

// Caché TTL de las señales aprendidas (F5b): la heurística las consulta ANTES de
// gastar el clasificador Haiku. Se refresca cada 30 min (analyzeCalibration lee
// archivos). Con pocos datos la lista viene vacía ⇒ null ⇒ sin efecto (seguro).
const _sigCache = new Map();
const SIG_TTL_MS = 30 * 60 * 1000;
function getLearnedSignals(nowMs, dataDir) {
  // nowMs se pasa desde el llamador (Date.now() está prohibido en el core-workflow
  // pero NO en runtime del server; igual lo recibimos para testeabilidad).
  const now = nowMs || 0;
  const resolvedDataDir = dataDir || resolveDataDir();
  let cached = _sigCache.get(resolvedDataDir);
  if (!cached?.sig || (now && now - cached.at > SIG_TTL_MS)) {
    try { cached = { at: now, sig: analyzeCalibration({ dataDir: resolvedDataDir }).learnedSignals || [] }; }
    catch { cached = { at: now, sig: [] }; }
    _sigCache.set(resolvedDataDir, cached);
  }
  return cached.sig;
}
// Devuelve 'up' si el texto matchea una señal aprendida 'up' con soporte, o null.
// Solo actúa cuando HAY señales (datos suficientes); si no, null (heurística sigue
// su curso hacia el clasificador Haiku). Alternativa determinística al #6.
export function learnedSignalBias(text, nowMs = 0, { dataDir } = {}) {
  const sig = getLearnedSignals(nowMs, dataDir);
  if (!sig || !sig.length) return null;
  const t = String(text || '').toLowerCase();
  for (const s of sig) { if (s.dir === 'up' && t.includes(s.keyword)) return 'up'; }
  return null;
}

// ¿Corresponde una bajada por inactividad? (idle ≥ IDLE_DECAY_MS y base por
// encima de sonnet). Devuelve 'down' o null. La sesión intensa que justificó
// Opus probablemente terminó; si no, el 1er turno con código la sube de nuevo.
export function idleDecayMove({ baseLevel, idleMs }) {
  return (baseLevel > 1 && idleMs >= IDLE_DECAY_MS) ? 'down' : null;
}
