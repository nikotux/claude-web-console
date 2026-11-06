#!/usr/bin/env node
// Pruebas puras + guards estáticos del despertador del chat.
// Uso: node bin/cwc-test-chat-despertador.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
// El sandbox de tests puede negar uv_interface_addresses; shared re-exporta la
// política de tools, que carga la detección ZeroTier aunque estas pruebas no la usen.
os.networkInterfaces = () => ({});
const {
  OTRO_CHECKIN_MS, OTRO_HOLD_MS, WAKE_PREFIX,
  holdsForOtro, wakeDecision, buildWakeText, sleepThresholdMs,
} = await import('../src/modules/chat/shared.js');

let pass = 0, fail = 0;
const fmt = (value) => inspect(value, { depth: null, sorted: true, breakLength: 120 });
const ok = (name, condition, detail = null) => {
  if (condition) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail === null ? '' : `\n   detalle: ${fmt(detail)}`}`);
  }
};
const eq = (name, got, expected) => {
  if (isDeepStrictEqual(got, expected)) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   esperado: ${fmt(expected)}\n   obtenido: ${fmt(got)}`);
  }
};

const now = 10 * 60 * 60 * 1000;
const decision = (overrides = {}) => wakeDecision({
  status: 'waiting', pelota: 'otro', idleMs: OTRO_CHECKIN_MS + 60 * 1000,
  otroSince: now - 30 * 60 * 1000, now, pendingCount: 0, liveBgCount: 0,
  ...overrides,
});

eq('1. working no despierta', decision({ status: 'working', pendingCount: 1 }), null);
eq('2. un resultado pendiente despierta aun con pelota TUYA', decision({ pelota: 'tuya', pendingCount: 1 }), 'bg-done');
eq('3. OTRO sin fondo y 16 min idle pide check-in', decision(), 'otro-checkin');
eq('4. OTRO sin fondo y 10 min idle espera', decision({ idleMs: 10 * 60 * 1000 }), null);
eq('5. OTRO con fondo vivo espera el resultado', decision({ liveBgCount: 1 }), null);
eq('6. OTRO pasado el tope de 4 h no despierta', decision({ otroSince: now - OTRO_HOLD_MS }), null);
eq('7. NADIE sin resultado pendiente no despierta', decision({ pelota: 'nadie' }), null);
eq('8. TUYA sin resultado pendiente no despierta', decision({ pelota: 'tuya' }), null);

eq('9. holdsForOtro acepta justo antes del tope', holdsForOtro('otro', now - OTRO_HOLD_MS + 1, now), true);
eq('10. holdsForOtro corta exactamente en 4 h', holdsForOtro('otro', now - OTRO_HOLD_MS, now), false);
eq('11. holdsForOtro exige inicio positivo', holdsForOtro('otro', 0, now), false);
eq('12. holdsForOtro exige pelota OTRO', holdsForOtro('tuya', now - 1, now), false);

const bgText = buildWakeText('bg-done', { items: [
  { kind: 'Codex', label: 'ajustar runner', outcome: 'completed' },
  { kind: 'Agent', label: 'mirar CI', outcome: 'terminado' },
] });
ok('13. el aviso de fondo trae prefijo, labels y collect_codex',
  bgText.startsWith(WAKE_PREFIX)
    && bgText.includes('«ajustar runner»')
    && bgText.includes('«mirar CI»')
    && bgText.includes('collect_codex'));
const checkinText = buildWakeText('otro-checkin', { otroElapsedMs: 16 * 60 * 1000 });
ok('14. el check-in trae prefijo y minutos transcurridos',
  checkinText.startsWith(WAKE_PREFIX) && checkinText.includes('Pasaron 16 min'));

eq('15. sleepThresholdMs conserva NADIE en 5 min', sleepThresholdMs('nadie'), 5 * 60 * 1000);
eq('16. sleepThresholdMs conserva OTRO en 45 min', sleepThresholdMs('otro'), 45 * 60 * 1000);
eq('17. sleepThresholdMs conserva TUYA en 45 min', sleepThresholdMs('tuya'), 45 * 60 * 1000);
eq('18. sleepThresholdMs conserva null en 45 min', sleepThresholdMs(null), 45 * 60 * 1000);

const binDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(binDir, '..');
const runnerSource = fs.readFileSync(path.join(binDir, 'cwc-chat-runner.js'), 'utf8');
const policySource = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'tool-policy.js'), 'utf8');
const wakeIntervalEnd = runnerSource.indexOf('}, 20 * 1000).unref();');
const wakeIntervalStart = runnerSource.lastIndexOf('setInterval(() => {', wakeIntervalEnd);
const wakeInterval = wakeIntervalStart >= 0 && wakeIntervalEnd > wakeIntervalStart
  ? runnerSource.slice(wakeIntervalStart, wakeIntervalEnd)
  : '';
const sleepIntervalEnd = runnerSource.indexOf('}, 60 * 1000).unref();');
const sleepIntervalStart = runnerSource.lastIndexOf('setInterval(() => {', sleepIntervalEnd);
const sleepInterval = sleepIntervalStart >= 0 && sleepIntervalEnd > sleepIntervalStart
  ? runnerSource.slice(sleepIntervalStart, sleepIntervalEnd)
  : '';

ok('19. el runner define maybeWake y pendingWake',
  runnerSource.includes('function maybeWake()') && runnerSource.includes('const pendingWake = new Map()'));
ok('20. el interval de 20 s llama maybeWake', wakeInterval.includes('maybeWake()'), { wakeIntervalFound: !!wakeInterval });
ok('21. el interval de sueño retiene OTRO', sleepInterval.includes('holdsForOtro('), { sleepIntervalFound: !!sleepInterval });
ok('22. AUTONOMY_INSTRUCTION documenta cwc-despertador', policySource.includes('[cwc-despertador]'));

console.log(`\n${fail === 0 ? '✅' : '❌'} chat-despertador: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
