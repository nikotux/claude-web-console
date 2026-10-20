#!/usr/bin/env node
// Test funcional, determinista y aislado del parser de la cola de Tolkien.
// No usa red, Chromium ni ~/.cwc-data.

import { inspect, isDeepStrictEqual } from 'node:util';
import {
  executionStateFromNamedStatus,
  parseQueueSnapshot,
} from './cwc-tolkien.js';

const BASE_URL = 'https://app.tolkien.mordorstaffing.com';
const HEADERS = [
  '',
  'ID',
  'Subject',
  'Requester',
  'Status',
  'Priority',
  'Tier',
  'Due ↑',
  'Assignee',
  'Lane',
  'Actions',
];
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let pass = 0;
let fail = 0;

function ok(name, condition, detail = null) {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    const suffix = detail === null ? '' : `\n   detalle: ${inspect(detail, { depth: null })}`;
    console.log(`❌ ${name}${suffix}`);
  }
}

function tableRow(id, owner, text = `WORK-1 Ticket ${owner}`) {
  return {
    href: `/tickets/${id}`,
    cells: ['', 'WORK-1 Desk #907', 'Ticket', 'Requester', 'Active', 'High', '1', '', owner, 'Doing', ''],
    text,
  };
}

console.log('\nT1 — tabla nueva');
{
  const result = parseQueueSnapshot({
    headers: HEADERS,
    rows: [
      tableRow(ID_A, 'Julian Andres Garcia Rendon', '  WORK-33720   Primer ticket  '),
      tableRow(ID_B, 'Nicolás Mosquera', 'WORK-33842 Segundo ticket'),
    ],
    legacy: [
      { href: '/tickets/productivity', text: 'Productivity 12', owner: null },
      { href: '/tickets/projects', text: 'Projects 4', owner: null },
    ],
  }, BASE_URL);
  ok(
    'T1 prioriza las dos filas y conserva owners y URLs absolutas',
    result.length === 2
      && result[0].owner === 'Julian Andres Garcia Rendon'
      && result[1].owner === 'Nicolás Mosquera'
      && result[0].url === `${BASE_URL}/tickets/${ID_A}`
      && result[1].url === `${BASE_URL}/tickets/${ID_B}`
      && result[0].listingText === 'WORK-33720 Primer ticket',
    result,
  );
}

console.log('\nT2 — vista vacía');
{
  const result = parseQueueSnapshot({
    headers: HEADERS,
    rows: [{ href: null, cells: ['🎉 Nothing here'], text: '🎉 Nothing here' }],
    legacy: [],
  }, BASE_URL);
  ok('T2 la fila informativa no produce tickets', isDeepStrictEqual(result, []), result);
}

console.log('\nT3 — layout anterior');
{
  const result = parseQueueSnapshot({
    headers: [],
    rows: [],
    legacy: [{ href: `/tickets/${ID_A}`, text: 'WORK-12 Ticket legado Owner: Ana', owner: 'Ana' }],
  }, BASE_URL);
  ok(
    'T3 usa legacy cuando la tabla no aporta tickets',
    result.length === 1 && result[0].ticketWorkflowId === ID_A && result[0].owner === 'Ana',
    result,
  );
}

console.log('\nT4 — rutas reservadas');
{
  const result = parseQueueSnapshot({
    headers: HEADERS,
    rows: [
      { href: '/tickets/new', cells: [], text: 'New' },
      { href: '/tickets/productivity', cells: [], text: 'Productivity' },
      { href: '/tickets/projects', cells: [], text: 'Projects' },
      { href: '/tickets/delivery', cells: [], text: 'Delivery' },
    ],
    legacy: [
      { href: '/tickets/new', text: 'New', owner: null },
      { href: '/tickets/productivity', text: 'Productivity', owner: null },
      { href: '/tickets/projects', text: 'Projects', owner: null },
      { href: '/tickets/delivery', text: 'Delivery', owner: null },
    ],
  }, BASE_URL);
  ok('T4 ignora todas las rutas reservadas', isDeepStrictEqual(result, []), result);
}

console.log('\nT5 — deduplicación');
{
  const result = parseQueueSnapshot({
    headers: HEADERS,
    rows: [tableRow(ID_A, 'Ana', 'Primera'), tableRow(ID_A, 'Ana', 'Segunda')],
    legacy: [],
  }, BASE_URL);
  ok(
    'T5 devuelve una sola entrada por UUID',
    result.length === 1 && result[0].ticketWorkflowId === ID_A,
    result,
  );
}

console.log('\nT6 — ticket sin assignee');
{
  const result = parseQueueSnapshot({
    headers: HEADERS,
    rows: [tableRow(ID_A, '—')],
    legacy: [],
  }, BASE_URL);
  ok('T6 convierte el guion largo en owner null', result.length === 1 && result[0].owner === null, result);
}

console.log('\nT7 — estados nombrados');
{
  const cases = [
    ['new', 'open', 'active'],
    ['open', 'open', 'active'],
    ['in_progress', 'open', 'active'],
    ['on_hold', 'on_hold', 'active'],
    ['closed', 'closed', 'completed'],
    ['cancelled', 'closed', 'cancelled'],
    ['future_status', 'closed', null],
  ];
  for (const [dataStatus, dataStatusType, expected] of cases) {
    const actual = executionStateFromNamedStatus(dataStatus, dataStatusType);
    ok(
      `T7 ${dataStatus} → ${expected ?? 'null'}`,
      actual === expected,
      { dataStatus, dataStatusType, expected, actual },
    );
  }
  ok(
    'T7 usa data-status-type open como fallback seguro',
    executionStateFromNamedStatus('future_status', 'open') === 'active',
  );
  ok(
    'T7 usa data-status-type on_hold como fallback seguro',
    executionStateFromNamedStatus(null, 'on_hold') === 'active',
  );
}

console.log('\nT8 — assignee con avatar');
{
  const avatarRow = tableRow(ID_A, 'JC');
  avatarRow.cellLabels = Array(HEADERS.length).fill(null);
  avatarRow.cellLabels[8] = 'Juan Camilo Hincapié Gonzalez';
  const result = parseQueueSnapshot({ headers: HEADERS, rows: [avatarRow], legacy: [] }, BASE_URL);
  ok(
    'T8 usa el nombre completo de la etiqueta en vez de las iniciales',
    result.length === 1 && result[0].owner === 'Juan Camilo Hincapié Gonzalez',
    result,
  );
}

console.log('\nT9 — assignee sin etiqueta');
{
  const result = parseQueueSnapshot({
    headers: HEADERS,
    rows: [tableRow(ID_A, 'JC')],
    legacy: [],
  }, BASE_URL);
  ok(
    'T9 conserva el texto como fallback cuando cellLabels no existe',
    result.length === 1 && result[0].owner === 'JC',
    result,
  );
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail > 0 ? 1 : 0;
