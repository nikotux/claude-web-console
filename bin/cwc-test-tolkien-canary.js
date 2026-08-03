#!/usr/bin/env node
// Test funcional, determinista y aislado del canario de Tolkien.
// No usa red, Chromium, ~/.cwc-data ni la base local.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import {
  evaluateContract,
  pickSample,
  runScan,
  verdictExitCode,
} from './cwc-tolkien-canary.js';

const OPEN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLOSED_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AVAILABLE_UUID = '99999999-9999-4999-8999-999999999999';

function option(value) {
  return { value, label: value, disabled: false, selected: false };
}

function input(name, type = 'hidden', required = false) {
  return {
    name,
    tag: 'input',
    type,
    required,
    disabled: false,
    readOnly: false,
  };
}

function textarea(name, required = false) {
  return {
    name,
    tag: 'textarea',
    type: 'textarea',
    required,
    disabled: false,
    readOnly: false,
  };
}

function select(name, values, required = false) {
  return {
    name,
    tag: 'select',
    type: 'select',
    required,
    disabled: false,
    readOnly: false,
    options: values.map(option),
  };
}

function baseSchema() {
  return {
    schemaVersion: 3,
    generatedAt: '2026-07-31T12:00:00.000Z',
    tickets: [
      {
        ticketWorkflowId: OPEN_UUID,
        workKey: 'WORK-1',
        closeGate: { state: 'missing_outcome' },
      },
      {
        ticketWorkflowId: AVAILABLE_UUID,
        workKey: 'WORK-3',
        closeGate: { state: 'available' },
      },
      {
        ticketWorkflowId: CLOSED_UUID,
        workKey: 'WORK-2',
        closeGate: { state: 'closed' },
      },
    ],
    forms: [
      {
        id: 'estado/work-context',
        signature: 'estado|Save context|desiredOutcome|desiredOutcome|mode|nextActorKind|ticketWorkflowId',
        tab: 'estado',
        submitLabel: 'Save context',
        observedOn: ['WORK-1'],
        fields: [
          input('ticketWorkflowId'),
          input('desiredOutcome'),
          select('mode', ['working', 'waiting']),
          select('nextActorKind', ['teammate', 'external_system', 'scheduled_time']),
          textarea('desiredOutcome', true),
        ],
      },
      {
        id: 'estado/close-ticket',
        signature: 'estado|Close ticket|evidenceSummary|ticketWorkflowId|verificationKind',
        tab: 'estado',
        submitLabel: 'Close ticket',
        observedOn: ['WORK-3'],
        fields: [
          input('ticketWorkflowId'),
          select(
            'verificationKind',
            ['requester_confirmation', 'objective_check', 'operator_attestation'],
            true,
          ),
          textarea('evidenceSummary', true),
        ],
      },
      {
        id: 'estado/reopen-in-tolkien',
        signature: 'estado|Reopen in Tolkien|ticketWorkflowId',
        tab: 'estado',
        submitLabel: 'Reopen in Tolkien',
        observedOn: ['WORK-2'],
        fields: [input('ticketWorkflowId')],
      },
    ],
  };
}

function makeSchema(overrides = null) {
  const schema = structuredClone(baseSchema());
  if (typeof overrides === 'function') overrides(schema);
  else if (overrides) Object.assign(schema, overrides);
  return schema;
}

function form(schema, id) {
  return schema.forms.find((entry) => entry.id === id);
}

function field(schema, formId, name, tag) {
  return form(schema, formId).fields.find((entry) => entry.name === name && entry.tag === tag);
}

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

function hasFinding(result, severity, kind, fieldName = null) {
  return result.findings.some((entry) => (
    entry.severity === severity
    && entry.kind === kind
    && (fieldName === null || entry.field === fieldName)
  ));
}

const baseline = makeSchema();

{
  const result = evaluateContract({ baseline, fresh: makeSchema() });
  ok(
    'T1 idéntico al baseline',
    result.verdict === 'ok' && result.findings.length === 0 && result.unverified.length === 0,
    result,
  );
}

{
  const olderBaseline = makeSchema((schema) => {
    const actor = field(schema, 'estado/work-context', 'nextActorKind', 'select');
    actor.options = actor.options.filter((entry) => entry.value !== 'scheduled_time');
  });
  const result = evaluateContract({ baseline: olderBaseline, fresh: makeSchema() });
  ok(
    'T2 scheduled_time nueva es informativa',
    result.verdict === 'info'
      && hasFinding(result, 'info', 'option-added', 'nextActorKind')
      && !result.findings.some((entry) => entry.severity === 'block'),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    const verification = field(schema, 'estado/close-ticket', 'verificationKind', 'select');
    verification.options = verification.options.filter((entry) => entry.value !== 'objective_check');
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T3 falta objective_check',
    result.verdict === 'block' && hasFinding(result, 'block', 'option-missing', 'verificationKind'),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    const close = form(schema, 'estado/close-ticket');
    close.fields = close.fields.filter((entry) => entry.name !== 'evidenceSummary');
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T4 falta evidenceSummary',
    result.verdict === 'block' && hasFinding(result, 'block', 'field-missing', 'evidenceSummary'),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    const work = form(schema, 'estado/work-context');
    const index = work.fields.findIndex((entry) => entry.name === 'mode' && entry.tag === 'select');
    work.fields[index] = input('mode', 'text');
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T5 mode cambia de select a input',
    result.verdict === 'block'
      && result.findings.some((entry) => (
        entry.severity === 'block'
        && ['field-missing', 'field-kind-changed', 'form-missing'].includes(entry.kind)
      )),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    form(schema, 'estado/close-ticket').fields.push(select('closureCategory', ['normal'], true));
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T6 campo requerido nuevo',
    result.verdict === 'block' && hasFinding(result, 'block', 'new-required-field', 'closureCategory'),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    schema.tickets = schema.tickets.filter((ticket) => ticket.closeGate.state !== 'available');
    schema.forms = schema.forms.filter((entry) => entry.id !== 'estado/close-ticket');
  });
  const optional = evaluateContract({ baseline, fresh });
  const required = evaluateContract({ baseline, fresh, required: ['close-form'] });
  ok(
    'T7 deriva de estado y --require',
    optional.verdict === 'info'
      && optional.unverified.some((entry) => entry.element === 'close-form')
      && !optional.findings.some((entry) => entry.severity === 'block')
      && required.verdict === 'block'
      && hasFinding(required, 'block', 'unverified-required'),
    { optional, required },
  );
}

{
  const fresh = makeSchema((schema) => {
    form(schema, 'estado/close-ticket').observedOn.push('WORK-2');
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T8 formulario de cierre en ticket cerrado',
    result.verdict === 'block' && hasFinding(result, 'block', 'close-form-on-closed-ticket'),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    schema.forms.push({
      id: 'estado/new-form',
      signature: 'estado|New action|novelField',
      tab: 'estado',
      submitLabel: 'New action',
      observedOn: ['WORK-1'],
      fields: [input('novelField', 'text')],
    });
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T9 formulario nuevo fuera del contrato',
    result.verdict === 'info'
      && hasFinding(result, 'info', 'form-new')
      && !result.findings.some((entry) => entry.severity === 'block'),
    result,
  );
}

{
  const result = evaluateContract({ baseline, fresh: makeSchema(), nextActorKind: 'inventado' });
  ok(
    'T10 nextActorKind inexistente',
    result.verdict === 'block' && hasFinding(result, 'block', 'option-missing', 'nextActorKind'),
    result,
  );
}

{
  const got = ['ok', 'info', 'block', 'error'].map(verdictExitCode);
  ok('T11 códigos de salida', JSON.stringify(got) === JSON.stringify([0, 10, 20, 1]), got);
}

{
  const closableUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const explicitUuids = [
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  ];
  const reconcile = {
    closable: [{ ticketWorkflowId: closableUuid, workKey: 'WORK-3' }],
    realOpen: [{ ticketWorkflowId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', workKey: 'WORK-4' }],
  };
  const automatic = pickSample({ baseline, reconcile });
  const explicit = pickSample({ baseline, reconcile, explicitTickets: explicitUuids });
  ok(
    'T12 selección de muestra',
    automatic.length === 3
      && automatic[0].role === 'closable'
      && automatic[0].ticketWorkflowId === closableUuid
      && automatic[1].role === 'realOpen'
      && automatic[2].role === 'closed'
      && explicit.map((entry) => entry.ticketWorkflowId).join(',') === explicitUuids.join(',')
      && explicit.every((entry) => entry.role === 'explicit'),
    { automatic, explicit },
  );
}

{
  const fresh = makeSchema((schema) => {
    for (const entry of schema.forms) {
      entry.observedOn = entry.observedOn.filter((key) => key !== 'WORK-2');
    }
  });
  const result = evaluateContract({ baseline, fresh });
  const closed = result.elements.find((entry) => entry.element === 'closed-recognition');
  ok(
    'T13 observación fallida',
    result.verdict === 'info'
      && closed?.status === 'unverified'
      && closed.reason.includes('la observación de WORK-2 falló')
      && !result.findings.some((entry) => entry.severity === 'block'),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    for (const entry of schema.forms) {
      entry.observedOn = entry.observedOn.filter((key) => key !== 'WORK-2');
    }
    const unattributedClose = structuredClone(form(schema, 'estado/close-ticket'));
    unattributedClose.id = 'estado/unattributed-close-ticket';
    unattributedClose.observedOn = [];
    schema.forms.push(unattributedClose);
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T14 observación fallida no enmascara un ok',
    result.verdict === 'info'
      && result.elements.some((entry) => (
        entry.element === 'closed-recognition' && entry.status === 'unverified'
      ))
      && !hasFinding(result, 'block', 'close-form-on-closed-ticket'),
    result,
  );
}

{
  const fresh = makeSchema((schema) => {
    schema.tickets = schema.tickets.filter((ticket) => ticket.ticketWorkflowId === AVAILABLE_UUID);
    const work = form(schema, 'estado/work-context');
    work.observedOn = ['WORK-3'];
    work.fields = work.fields.filter((entry) => entry.tag !== 'textarea');
    schema.forms = schema.forms.filter((entry) => entry.id !== 'estado/reopen-in-tolkien');
  });
  const result = evaluateContract({ baseline, fresh });
  ok(
    'T15 work-context solo en missing_outcome',
    !result.findings.some((entry) => entry.severity === 'block')
      && result.elements.some((entry) => (
        entry.element === 'work-context' && entry.status === 'unverified'
      )),
    result,
  );
}

{
  const closable = [
    { ticketWorkflowId: '11111111-1111-4111-8111-111111111111', workKey: 'WORK-11' },
    { ticketWorkflowId: '22222222-2222-4222-8222-222222222222', workKey: 'WORK-12' },
    { ticketWorkflowId: '33333333-3333-4333-8333-333333333333', workKey: 'WORK-13' },
  ];
  const realOpen = [
    { ticketWorkflowId: '44444444-4444-4444-8444-444444444444', workKey: 'WORK-14' },
  ];
  const full = pickSample({ baseline, reconcile: { closable, realOpen } });
  const fallback = pickSample({ baseline, reconcile: { closable: closable.slice(0, 1), realOpen } });
  ok(
    'T16 pickSample con 3',
    full.length === 3
      && full[0].role === 'closable'
      && full[0].ticketWorkflowId === closable[0].ticketWorkflowId
      && full[1].role === 'closable'
      && full[1].ticketWorkflowId === closable[1].ticketWorkflowId
      && full[2].role === 'closed'
      && fallback.length === 3
      && fallback[0].role === 'closable'
      && fallback[1].role === 'realOpen'
      && fallback[1].ticketWorkflowId === realOpen[0].ticketWorkflowId
      && fallback[2].role === 'closed',
    { full, fallback },
  );
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-tolkien-canary-test-'));
  try {
    const canaryDir = path.join(tempDir, 'canary');
    fs.mkdirSync(canaryDir);
    let deadPid = null;
    for (let candidate = 4_000_000; candidate > 3_900_000; candidate -= 1) {
      try {
        process.kill(candidate, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          deadPid = candidate;
          break;
        }
      }
    }
    if (deadPid === null) throw new Error('No se encontró un PID muerto para T17.');

    const deadScratch = path.join(canaryDir, `scratch-${deadPid}`);
    const liveScratch = path.join(canaryDir, `scratch-${process.pid}`);
    const unmatchedScratch = path.join(canaryDir, 'scratch-abc');
    fs.mkdirSync(deadScratch);
    fs.mkdirSync(liveScratch);
    fs.mkdirSync(unmatchedScratch);

    const result = runScan({
      paths: {
        canaryDir,
        censusFile: path.join(tempDir, 'missing-census.json'),
        reconcileFile: path.join(tempDir, 'missing-reconcile.json'),
        schemaCli: path.join(tempDir, 'missing-schema-cli.js'),
      },
      tickets: [],
      tabs: [],
      sessionFile: path.join(tempDir, 'missing-session.json'),
      keepScratch: true,
    });
    ok(
      'T17 barrido de scratch huérfanos',
      !fs.existsSync(deadScratch)
        && fs.existsSync(liveScratch)
        && fs.existsSync(unmatchedScratch)
        && result.error?.reason === 'session-missing',
      { deadPid, result },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail > 0 ? 1 : 0;
