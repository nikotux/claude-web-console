// core/model-router.js — NÚCLEO del router de modelo automático del chat.
//
// NO es un motor: es plomería IN-PROCESS (mismo patrón que core/tool-policy.js),
// consultada EN VIVO por Chat.sendUser() (modules/chat/index.js) en cada turno
// real del usuario. Decide si conviene subir/bajar el modelo de la conversación
// y aplica el cambio con el MISMO mecanismo que ya usa el selector manual
// (Chat.setModel() → q.setModel() del SDK si el motor está vivo, o solo
// actualiza el campo si está dormido) — cero plomería de cambio de modelo
// nueva, solo la DECISIÓN.
//
// Origen y fundamentos (charla del 2026-07-06 con el usuario, research +
// datos reales de ESTA consola — ver memoria del proyecto):
//  - RouteLLM/FrugalGPT: la cascada "arrancar y escalar si hace falta" rinde
//    mejor que predecir la complejidad de antemano. Los propios cambios
//    manuales de `/model` de este usuario (16 casos en su historial real)
//    confirman el MISMO patrón: escala reactivo, no anticipado.
//  - Análisis de costo real de transcripts propios: clasificar con Haiku en
//    CADA turno es ~0,005% del costo total — insignificante. El ahorro/valor
//    de verdad está en decidir bien Sonnet↔Opus↔Fable para el trabajo pesado,
//    no en cazar saludos con Haiku.
//  - Con solo 16 cambios manuales en el historial, NO hay señal confiable para
//    automatizar el salto a FABLE (un mensaje de "arreglá esto" y uno de
//    "rediseño mayor" pueden verse igual de simples/largos). Por eso esta
//    heurística de Fase 1 tiene TECHO en `opus`: subir a `fable` queda
//    deliberadamente MANUAL (selector) hasta juntar más datos.
//  - `opusplan` (precedente oficial de Claude Code) ya valida la idea de
//    "la fase de la tarea decide el modelo", pero es un switch binario atado a
//    Plan Mode, sin memoria — acá se diseña la histéresis que a ESE no le hace
//    falta reinventar de cero.
//
// Alcance (Fase 1): heurística 0-costo (nada de red, nada de tokens) sobre el
// TEXTO del turno + histéresis de dos umbrales (sube apenas se detecta algo
// más difícil; baja recién tras varios turnos simples SEGUIDOS, un escalón
// por vez — nunca de un salto).
//
// Fase 2 (2026-07-06, agregada acá): dos piezas nuevas, ambas con el MISMO
// techo en `opus` que la heurística de Fase 1 (nunca escalan solas a fable):
//  - `applyHysteresis()` separa la histéresis de la heurística (Fase 1 la
//    tenía mezclada adentro de `decideModelForTurn`) para que el clasificador
//    de Haiku (que vive en modules/chat/index.js, junto a extractTitle — este
//    núcleo se mantiene sin dependencias del SDK) pueda reusarla tal cual
//    cuando la heurística devuelve `ambiguous:true`.
//  - `reactiveEscalation()` es la "red de seguridad" estilo cascada
//    (FrugalGPT): si un turno recién terminado usó MUCHAS herramientas de
//    golpe, es señal barata y confiable de que el nivel se quedó corto — sube
//    un escalón para el PRÓXIMO turno. No hay forma de "rehacer" el turno que
//    ya pasó con el modelo que tenía, así que esto es prevención hacia
//    adelante (siguiente turno), no corrección retroactiva.
//
// Activación implícita (sin UI nueva): SOLO se gestiona un chat si su modelo
// ACTUAL es exactamente uno de los 4 alias de MODEL_LEVELS. Si el usuario
// eligió `opusplan`, `default`, o todavía no eligió nada, el router queda
// INERTE a propósito — elegir uno de los 4 alias directos desde el selector
// ES el "prender" el modo automático; elegir opusplan/default lo apaga.

// Fase 3 (2026-07-06): visibilidad + aprendizaje. `logDecision()` es un
// registro APPEND-ONLY (patrón "invariantes propuestos" de Salud: esto es
// SOLO observación para calibrar después con datos reales — nada de esta
// fase se auto-aplica ni se relee para decidir en caliente) de cada cambio
// de modelo que hizo el router (nunca de los manuales — esos ya quedan en el
// historial normal del chat). modules/chat/index.js llama a logDecision() en
// cada punto donde decide subir/bajar de nivel; el indicador visible del
// nivel (badge "🤖" en el header + nota inline al cambiar solo) vive en
// public/js/modules/chat/chat-tab.js, con el flag `auto` que viaja en el
// evento `{type:'model', model, auto}` (Chat.setModel(model, {auto:true})).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = path.join(os.homedir(), '.cwc-data', 'model-router-log.jsonl');
const LOG_MAX_BYTES = 2 * 1024 * 1024; // tope crudo — ver poda en logDecision

// Registro append-only de UN cambio de modelo decidido por el router. Nunca
// rompe el turno del chat (best-effort): un fallo de disco se ignora.
// `entry` esperado: { chatId, sessionId, source: 'heuristic'|'classifier'|
// 'reactive', from, to, text (extracto corto) }.
export function logDecision(entry) {
  try {
    const dir = path.dirname(LOG_FILE);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({ ts: Date.now(), ...entry })}\n`;
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
    // Poda cruda: pasado el tope, nos quedamos con la mitad más reciente —
    // alcanza para un log de calibración, no hace falta rotación sofisticada.
    const size = fs.statSync(LOG_FILE).size;
    if (size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(-Math.floor(lines.length / 2));
      fs.writeFileSync(LOG_FILE, `${kept.join('\n')}\n`, { mode: 0o600 });
    }
  } catch { /* best-effort */ }
}

// Orden barato -> caro. El índice ES el "nivel" (se deriva de chat.model, NO
// se duplica en un estado propio — solo se persiste el contador de histéresis).
export const MODEL_LEVELS = ['haiku', 'sonnet', 'opus', 'fable'];

// Techo de la heurística de Fase 1 (ver nota de fundamentos arriba): nunca
// sugiere subir sola hasta 'fable' — a fable se llega a mano desde el selector.
const HEURISTIC_CEILING = MODEL_LEVELS.indexOf('opus'); // 2

// Turnos "simples" SEGUIDOS necesarios para bajar UN escalón. Subir es
// inmediato (mismo turno); bajar tiene inercia — asimetría deliberada.
const DOWN_STREAK_TO_DEMOTE = 3;

// Confirmaciones/saludos triviales en español (con alguna variante corta en
// inglés). Vocabulario tomado de los propios turnos "perfecto"/"reincialo"/
// "continuemos" que aparecieron en el análisis del historial real de esta
// consola — turnos donde el mensaje en sí no ameritaba el modelo caro que
// estaba activo por inercia del hilo.
const TRIVIAL_RE = /^(ok(ay)?|dale|listo|gracias|perfecto|genial|buen[ií]simo|excelente|s[ií]|no|de acuerdo|correcto|entendido|continuemos?|sigamos?|dale,?\s*gracias)[.!¡¿?]*$/i;

const CODE_FENCE_RE = /```/;
const LONG_MESSAGE_CHARS = 800; // mensaje largo con mucho contexto: probable trabajo pesado

function levelIndexOf(model) {
  return MODEL_LEVELS.indexOf(model);
}

// Heurística 0-costo: mira SOLO el texto del turno. Devuelve un índice
// sugerido de MODEL_LEVELS, o `null` si el mensaje es ambiguo — en ese caso
// no se opina, el nivel actual queda intacto (ni sube ni cuenta para bajar).
export function classifyHeuristic(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.length <= 60 && TRIVIAL_RE.test(t)) return 0; // haiku
  if (CODE_FENCE_RE.test(t)) return HEURISTIC_CEILING; // trae código
  if (t.length >= LONG_MESSAGE_CHARS) return HEURISTIC_CEILING; // pedido largo/con mucho contexto
  return null; // ambiguo: no tocar nada
}

// Aplica la histéresis dado un nivel SUGERIDO ya concreto (nunca null) — la
// misma función sirve tanto a la heurística de Fase 1 como al clasificador de
// Haiku de Fase 2, así las dos vías de decisión suben/bajan exactamente igual.
export function applyHysteresis({ currentLevel, suggestion, downStreak = 0 }) {
  if (suggestion > currentLevel) {
    // Subir es fácil: YA, en este mismo turno.
    return { level: suggestion, downStreak: 0, changed: true };
  }
  if (suggestion < currentLevel) {
    const streak = downStreak + 1;
    if (streak >= DOWN_STREAK_TO_DEMOTE) {
      // Baja UN escalón por vez (nunca de un salto) tras varios turnos simples seguidos.
      return { level: currentLevel - 1, downStreak: 0, changed: true };
    }
    return { level: currentLevel, downStreak: streak, changed: false };
  }
  // suggestion === currentLevel: turno "normal" para el nivel en curso.
  return { level: currentLevel, downStreak: 0, changed: false };
}

// Decide el nivel del PRÓXIMO turno usando SOLO la heurística 0-costo. Devuelve
// `null` si el modelo actual no es uno de los 4 alias gestionados (opusplan/
// default/sin elegir) — el router queda inerte adrede. Si la heurística no
// sabe qué opinar, devuelve `ambiguous:true` (nivel/contador sin tocar) para
// que el llamador (chat/index.js) decida si vale la pena consultar a Haiku
// (Fase 2) antes de resolver con `applyHysteresis`.
export function decideModelForTurn({ currentModel, text, downStreak = 0 }) {
  const currentLevel = levelIndexOf(currentModel);
  if (currentLevel === -1) return null;

  const suggestion = classifyHeuristic(text);
  if (suggestion === null) {
    return { level: currentLevel, downStreak, changed: false, ambiguous: true };
  }
  return { ...applyHysteresis({ currentLevel, suggestion, downStreak }), ambiguous: false };
}

// Cuántas tool_use hacen falta en UN turno para considerarlo "pesado de
// verdad" — umbral deliberadamente alto (evita falsos positivos en turnos con
// 2-3 herramientas normales) y calibrable con más datos reales más adelante.
const REACTIVE_TOOL_THRESHOLD = 6;

// Escalado reactivo (Fase 2): al terminar un turno, ¿usó tantas herramientas
// que el nivel actual se quedó corto? Devuelve `null` si no aplica (ya está en
// el techo automático, o no llegó al umbral) — mismo shape que applyHysteresis
// para que el llamador lo aplique igual.
export function reactiveEscalation({ currentLevel, toolCallsInTurn }) {
  if (currentLevel === -1 || currentLevel >= HEURISTIC_CEILING) return null;
  if ((toolCallsInTurn || 0) < REACTIVE_TOOL_THRESHOLD) return null;
  return { level: currentLevel + 1, downStreak: 0, changed: true };
}
