#!/usr/bin/env node
// Test funcional, determinista y aislado del reconcile de Tolkien.
// No usa red, Chromium, ~/.cwc-data ni el SDK. Consume 0 tokens.

import { inspect, isDeepStrictEqual } from 'node:util';
import {
  classifyReconciliationTicket,
  zohoSnapshot,
} from './cwc-tolkien.js';

const VIEWER_ID = '813994000001796001';
const OTHER_ID = '813994000004284004';
const GENERATED_AT = '2026-08-02T10:00:00.000Z';
const agents = new Map([
  [VIEWER_ID, { name: 'Nicolás Mosquera', email: 'nmosquera@mordorstaffing.com' }],
  [OTHER_ID, { name: 'Sebastián Arias', email: 'sebastian@example.test' }],
]);
const getAgents = async () => agents;

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

function ticket(overrides = {}) {
  return {
    ticketWorkflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workKey: 'WORK-620',
    workNumber: 'WORK-620',
    title: 'Ticket de prueba',
    url: 'https://tolkien.example.test/tickets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    executionState: 'active',
    deskTicketId: '620',
    deskTicketNumber: '620',
    hasDesiredOutcome: true,
    desiredOutcome: 'Resolver el pedido',
    isWaiting: false,
    ...overrides,
  };
}

function zoho(overrides = {}) {
  return {
    id: '620',
    ticketNumber: '620',
    subject: 'Ticket de prueba',
    status: 'Open',
    statusType: 'Open',
    closedTime: null,
    modifiedTime: '2026-08-02T09:00:00.000Z',
    modifiedBy: VIEWER_ID,
    resolution: null,
    webUrl: 'https://desk.example.test/ticket/620',
    assigneeId: VIEWER_ID,
    ...overrides,
  };
}

function clientReturning(ticketData) {
  return {
    async callTool(name) {
      if (name !== 'desk_get_ticket') throw new Error(`Tool inesperada: ${name}`);
      return ticketData;
    },
  };
}

async function classify(zohoTicket, viewerAgentId = VIEWER_ID) {
  return classifyReconciliationTicket(
    ticket(),
    clientReturning(zohoTicket),
    GENERATED_AT,
    getAgents,
    viewerAgentId,
  );
}

console.log('\nT1 · ABIERTO Y ASIGNADO AL VIEWER');
{
  const result = await classify(zoho());
  ok(
    'T1 conserva realOpen/open_in_both',
    result.bucket === 'realOpen' && result.entry.reason === 'open_in_both',
    result,
  );
}

console.log('\nT2 · ABIERTO Y REASIGNADO');
{
  const result = await classify(zoho({ assigneeId: OTHER_ID }));
  ok(
    'T2 crea reassigned y nombra al otro agente',
    result.bucket === 'reassigned'
      && result.entry.reason === 'assigned_to_other'
      && result.entry.assigneeName === 'Sebastián Arias'
      && result.entry.detail === `Asignado en Zoho a Sebastián Arias (${OTHER_ID}).`,
    result,
  );
}

console.log('\nT3 · ABIERTO SIN ASIGNADO');
{
  const result = await classify(zoho({ assigneeId: null }));
  ok(
    'T3 trata la ausencia de asignado como reassigned',
    result.bucket === 'reassigned'
      && result.entry.reason === 'assigned_to_other'
      && result.entry.assigneeName === null
      && result.entry.detail === 'Sin asignado en Zoho.',
    result,
  );
}

console.log('\nT4 · EL CIERRE GANA');
{
  const result = await classify(zoho({
    status: 'Closed',
    statusType: 'Closed',
    closedTime: '2026-08-02T09:00:00.000Z',
    resolution: 'Pedido resuelto.',
    assigneeId: OTHER_ID,
  }));
  ok(
    'T4 cerrado y reasignado sigue siendo closable',
    result.bucket === 'closable'
      && result.entry.assigneeName === 'Sebastián Arias'
      && result.entry.assigneeId === OTHER_ID
      && result.entry.evidenceSummary.includes('Asignado en Zoho a Sebastián Arias.'),
    result,
  );
}

console.log('\nT5 · CIERRE NO RESUELTO');
{
  const result = await classify(zoho({
    status: 'Closed - Duplicate',
    statusType: 'Closed',
    closedTime: '2026-08-02T09:00:00.000Z',
    assigneeId: OTHER_ID,
  }));
  ok(
    'T5 cancelado o duplicado sigue en unpaired',
    result.bucket === 'unpaired' && result.entry.reason === 'closed_but_not_resolved',
    result,
  );
}

console.log('\nT6 · CIERRE SIN FECHA');
{
  const result = await classify(zoho({
    status: 'Closed',
    statusType: 'Closed',
    closedTime: null,
    assigneeId: OTHER_ID,
  }));
  ok(
    'T6 cerrado sin closedTime sigue en unpaired',
    result.bucket === 'unpaired' && result.entry.reason === 'closed_without_close_time',
    result,
  );
}

console.log('\nT7 · SNAPSHOT ADITIVO');
{
  const source = zoho();
  const snapshot = zohoSnapshot(source);
  const expected = {
    id: source.id,
    ticketNumber: source.ticketNumber,
    subject: source.subject,
    status: source.status,
    statusType: source.statusType,
    closedTime: source.closedTime,
    modifiedTime: source.modifiedTime,
    resolution: source.resolution,
    webUrl: source.webUrl,
    assigneeId: source.assigneeId,
  };
  ok(
    'T7 conserva los nueve campos y agrega assigneeId',
    isDeepStrictEqual(snapshot, expected),
    { expected, snapshot },
  );
}

console.log('\nT8 · COMPARACIÓN POR STRING');
{
  const result = await classify(zoho({ assigneeId: 12345 }), '12345');
  ok(
    'T8 id numérico y viewerAgentId string coinciden',
    result.bucket === 'realOpen' && result.entry.reason === 'open_in_both',
    result,
  );
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail > 0 ? 1 : 0;
