#!/usr/bin/env node
// Test determinista de las funciones puras de core/model-router.js (v2b).
// No toca red ni SDK. Uso: node bin/cwc-test-model-router.js
import {
  MODEL_LEVELS, CEILING, FORBIDDEN_AUTO, IDLE_DECAY_MS,
  clampLevel, classifySignal, signalToMove, turnOverride,
  decideBase, insufficiencyEscalation, idleDecayMove,
} from '../src/core/model-router.js';

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; }
  else { fail++; console.log(`❌ ${name}\n   esperado: ${e}\n   obtenido: ${g}`); }
};

// --- escala ---
eq('MODEL_LEVELS sin fable', MODEL_LEVELS, ['haiku', 'sonnet', 'opus']);
eq('CEILING = opus', CEILING, 2);
eq('fable prohibido', FORBIDDEN_AUTO.has('fable'), true);

// --- clampLevel ---
eq('clamp sonnet', clampLevel('sonnet'), 1);
eq('clamp opus', clampLevel('opus'), 2);
eq('clamp fable→opus', clampLevel('fable'), 2);   // bug de v1 evitado
eq('clamp opusplan→-1', clampLevel('opusplan'), -1);
eq('clamp default→-1', clampLevel('default'), -1);

// --- classifySignal ---
eq('closing: perfecto', classifySignal('perfecto').kind, 'closing');
eq('closing: gracias!', classifySignal('gracias!').kind, 'closing');
eq('goahead: dale', classifySignal('dale').kind, 'goahead');
eq('goahead: ok', classifySignal('ok').kind, 'goahead');
eq('goahead: dale, seguí', classifySignal('dale, seguí').kind, 'goahead');
eq('strong_up: no funciona', classifySignal('no funciona el login').kind, 'strong_up');
eq('strong_up: está mal', classifySignal('el status code está mal').kind, 'strong_up');
eq('up: code fence', classifySignal('mirá esto ```\ncode\n```').kind, 'up');
eq('up: mensaje largo', classifySignal('x'.repeat(1300)).kind, 'up');
eq('ambiguous: pregunta media', classifySignal('¿por qué el TTL se compara en segundos?').kind, 'ambiguous');
eq('none: vacío', classifySignal('   ').kind, 'none');
// go-ahead que dispara trabajo NO debe ser override (frágil en Haiku)
eq('goahead NO override', turnOverride(classifySignal('dale').kind), null);
eq('closing SÍ override→haiku', turnOverride(classifySignal('perfecto').kind), 0);

// --- signalToMove ---
eq('move closing→down', signalToMove('closing'), 'down');
eq('move goahead→down', signalToMove('goahead'), 'down');
eq('move up', signalToMove('up'), 'up');
eq('move strong_up', signalToMove('strong_up'), 'strong_up');
eq('move ambiguous→same', signalToMove('ambiguous'), 'same');

// --- decideBase: subir es ±1 e inmediato ---
eq('up desde sonnet→opus', decideBase({ baseLevel: 1, move: 'up' }),
  { level: 2, downStreak: 0, cooldown: 2, changed: true });
eq('up desde opus (techo) no sube', decideBase({ baseLevel: 2, move: 'up' }),
  { level: 2, downStreak: 0, cooldown: 0, changed: false });

// --- cooldown congela señales no-fuertes ---
eq('cooldown congela up', decideBase({ baseLevel: 1, move: 'up', cooldown: 2 }),
  { level: 1, downStreak: 0, cooldown: 1, changed: false });
eq('cooldown congela down (streak no avanza)', decideBase({ baseLevel: 2, move: 'down', cooldown: 1, downStreak: 1 }),
  { level: 2, downStreak: 1, cooldown: 0, changed: false });
eq('strong_up ROMPE cooldown', decideBase({ baseLevel: 1, move: 'strong_up', cooldown: 2 }),
  { level: 2, downStreak: 0, cooldown: 2, changed: true });

// --- bajar exige 2 'down' seguidos ---
const d1 = decideBase({ baseLevel: 2, move: 'down', downStreak: 0 });
eq('1er down: solo cuenta', d1, { level: 2, downStreak: 1, cooldown: 0, changed: false });
const d2 = decideBase({ baseLevel: 2, move: 'down', downStreak: 1 });
eq('2do down: baja 1 escalón', d2, { level: 1, downStreak: 0, cooldown: 2, changed: true });
eq('no baja por debajo de haiku', decideBase({ baseLevel: 0, move: 'down', downStreak: 1 }),
  { level: 0, downStreak: 2, cooldown: 0, changed: false });

// --- insuficiencia: evidencia, no volumen ---
eq('2 errores → sube', insufficiencyEscalation({ baseLevel: 1, toolCalls: 3, toolErrors: 2 }),
  { level: 2, downStreak: 0, cooldown: 2, changed: true });
eq('10 tools + 1 error → sube', insufficiencyEscalation({ baseLevel: 1, toolCalls: 10, toolErrors: 1 }),
  { level: 2, downStreak: 0, cooldown: 2, changed: true });
eq('muchos tools SIN error → no sube', insufficiencyEscalation({ baseLevel: 1, toolCalls: 15, toolErrors: 0 }), null);
eq('1 error solo → no sube', insufficiencyEscalation({ baseLevel: 1, toolCalls: 3, toolErrors: 1 }), null);
eq('ya en opus → no sube', insufficiencyEscalation({ baseLevel: 2, toolCalls: 20, toolErrors: 5 }), null);

// --- idle decay ---
eq('idle 61min desde opus → down', idleDecayMove({ baseLevel: 2, idleMs: IDLE_DECAY_MS + 1 }), 'down');
eq('idle desde sonnet → null', idleDecayMove({ baseLevel: 1, idleMs: IDLE_DECAY_MS + 1 }), null);
eq('poco idle → null', idleDecayMove({ baseLevel: 2, idleMs: 1000 }), null);

console.log(`\n${fail === 0 ? '✅' : '❌'} model-router v2b: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
