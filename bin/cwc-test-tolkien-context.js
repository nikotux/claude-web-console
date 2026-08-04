#!/usr/bin/env node
// Test puro, determinista y sin navegador del subcomando context.

import { inspect } from 'node:util';
import {
  bogotaFollowupBounds,
  validateWorkContextValues,
  workContextDiff,
} from './cwc-tolkien.js';

const NOW = new Date('2026-08-04T12:00:00.000Z');
let pass = 0;
let fail = 0;

function ok(name, condition, detail = null) {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name} · pass`);
  } else {
    fail += 1;
    const suffix = detail === null
      ? ''
      : `\n   detalle: ${inspect(detail, { depth: null, sorted: true, breakLength: 120 })}`;
    console.log(`❌ ${name} · fail${suffix}`);
  }
}

function validationError(values) {
  try {
    validateWorkContextValues(values, { now: NOW });
    return null;
  } catch (error) {
    return error;
  }
}

function completeWaiting(overrides = {}) {
  return {
    mode: 'waiting',
    nextActorKind: 'vendor',
    waitingReasonKind: 'delivery',
    followupOn: '2026-08-05',
    waitingReason: 'Esperando la entrega confirmada.',
    reactivationTrigger: 'Guía de entrega recibida.',
    ...overrides,
  };
}

console.log('\nT1 · SCHEDULED_TIME PROHIBIDO');
{
  const error = validationError({ nextActorKind: 'scheduled_time' });
  ok(
    'T1 rechaza scheduled_time con un mensaje explícito',
    error?.message.includes('scheduled_time') && error?.message.includes('prohibido'),
    error,
  );
}

console.log('\nT2 · CAMPOS OBLIGATORIOS DE WAITING');
{
  const required = [
    ['waitingReasonKind', '--waiting-reason-kind'],
    ['followupOn', '--followup'],
    ['waitingReason', '--why'],
    ['reactivationTrigger', '--evidence'],
  ];
  for (const [field, option] of required) {
    const values = completeWaiting();
    delete values[field];
    const error = validationError(values);
    ok(`T2 nombra el faltante ${option}`, error?.message.includes(option), error);
  }
}

console.log('\nT3 · FOLLOWUP FUERA DE RANGO');
{
  const yesterday = validationError(completeWaiting({ followupOn: '2026-08-03' }));
  const plus400 = validationError(completeWaiting({ followupOn: '2027-09-08' }));
  ok('T3 rechaza ayer', yesterday?.message.includes('anterior'), yesterday);
  ok('T3 rechaza hoy + 400 días', plus400?.message.includes('posterior'), plus400);
}

console.log('\nT4 · WAITING COMPLETO Y FECHA VÁLIDA');
{
  const bounds = bogotaFollowupBounds(NOW);
  const error = validationError(completeWaiting({ followupOn: bounds.maximum }));
  ok(
    'T4 acepta el límite hoy + 366 días',
    error === null && bounds.minimum === '2026-08-04' && bounds.maximum === '2027-08-05',
    { bounds, error },
  );
}

console.log('\nT5 · LONGITUD DE ACTOR-LABEL');
{
  const tooShort = validationError({ nextActorLabel: 'x' });
  const tooLong = validationError({ nextActorLabel: 'x'.repeat(121) });
  ok('T5 rechaza 1 carácter', tooShort?.message.includes('2 y 120'), tooShort);
  ok('T5 rechaza 121 caracteres', tooLong?.message.includes('2 y 120'), tooLong);
}

console.log('\nT6 · ENUMS INVÁLIDOS');
{
  const actor = validationError({ nextActorKind: 'hobbit' });
  const reason = validationError({ waitingReasonKind: 'palantir' });
  ok('T6 rechaza nextActorKind inválido', actor?.message.includes('--next-actor'), actor);
  ok(
    'T6 rechaza waitingReasonKind inválido',
    reason?.message.includes('--waiting-reason-kind'),
    reason,
  );
}

console.log('\nT7 · DIFF SIN CAMBIO');
{
  const rows = workContextDiff(
    { mode: 'working', nextActorKind: 'vendor' },
    { mode: 'working' },
  );
  const mode = rows.find((row) => row.field === 'mode');
  ok(
    'T7 marca sin cambio cuando actual y propuesto son iguales',
    mode?.changed === false && mode?.status === 'sin cambio',
    mode,
  );
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail > 0 ? 1 : 0;
