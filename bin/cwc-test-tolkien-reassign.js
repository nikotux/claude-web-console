#!/usr/bin/env node
// Test funcional, determinista y aislado de la resolución de reasignación.
// No usa red, Chromium, ~/.cwc-data ni el SDK. Consume 0 tokens.

import { inspect } from 'node:util';
import {
  CliError,
  aliasSetFor,
  loadIdentityAliases,
} from './cwc-tolkien-nav.js';
import {
  classifyReconciliationTicket,
  extractReassignAssigneeName,
  reassignSubmissionDecision,
  resolveReassignTarget,
  resolveZohoViewerIdentity,
  shouldAbortForUnknownAgents,
  verifyReassignState,
} from './cwc-tolkien.js';

const TARGET_USER_ID = '981c1e7b-5f0e-41bf-bfcc-eb312bbeb09f';
const OTHER_USER_ID = 'a587f496-b8be-47ed-a190-ef69ca809997';
const TARGET_AGENT_ID = '813994000004295001';
const agents = new Map([
  [TARGET_AGENT_ID, {
    name: 'Juan Camilo Hincapié Gonzalez',
    email: 'accounting@mordorstaffing.com',
  }],
]);

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

function option(value, label, overrides = {}) {
  return { value, label, disabled: false, ...overrides };
}

function resolve(overrides = {}) {
  return resolveReassignTarget({
    zohoAssigneeId: TARGET_AGENT_ID,
    agents,
    selectOptions: [
      option('', '— reassign to —', { disabled: true }),
      option(TARGET_USER_ID, 'Juan Camilo Hincapié Gonzalez (accounting@mordorstaffing.com)'),
    ],
    ...overrides,
  });
}

console.log('\nT1 · EMAIL ÚNICO');
{
  const result = resolve();
  ok(
    'T1 resuelve el UUID correcto',
    result.ok === true
      && result.userId === TARGET_USER_ID
      && result.name === 'Juan Camilo Hincapié Gonzalez'
      && result.email === 'accounting@mordorstaffing.com',
    result,
  );
}

console.log('\nT2 · HINCAPIÉ SE RESUELVE SÓLO POR EMAIL');
{
  const result = resolve({
    selectOptions: [
      option(OTHER_USER_ID, 'Esther Hincapié Arias (sarias@mordorstaffing.com)'),
      option(TARGET_USER_ID, 'Juan Camilo Hincapié Gonzalez (accounting@mordorstaffing.com)'),
    ],
  });
  ok(
    'T2 no elige al otro nombre Hincapié',
    result.ok === true && result.userId === TARGET_USER_ID,
    result,
  );
}

console.log('\nT3 · EMAIL DUPLICADO');
{
  const result = resolve({
    selectOptions: [
      option(TARGET_USER_ID, 'Juan Hincapié (accounting@mordorstaffing.com)'),
      option(OTHER_USER_ID, 'Otro Hincapié (accounting@mordorstaffing.com)'),
    ],
  });
  ok(
    'T3 falla cerrado ante dos opciones',
    result.ok === false && result.reason === 'usuario_ambiguo_en_tolkien' && !result.userId,
    result,
  );
}

console.log('\nT4 · EMAIL AUSENTE EN TOLKIEN');
{
  const result = resolve({
    selectOptions: [option(OTHER_USER_ID, 'Esther Arias (sarias@mordorstaffing.com)')],
  });
  ok(
    'T4 informa sin_usuario_en_tolkien',
    result.ok === false && result.reason === 'sin_usuario_en_tolkien',
    result,
  );
}

console.log('\nT5 · ZOHO SIN ASIGNADO');
{
  const result = resolve({ zohoAssigneeId: null });
  ok(
    'T5 informa sin_asignado_en_zoho',
    result.ok === false && result.reason === 'sin_asignado_en_zoho',
    result,
  );
}

console.log('\nT6 · AGENTE DESCONOCIDO');
{
  const result = resolve({ zohoAssigneeId: 'no-existe' });
  ok(
    'T6 informa agente_zoho_desconocido',
    result.ok === false && result.reason === 'agente_zoho_desconocido',
    result,
  );
  const withoutEmail = resolve({
    agents: new Map([[TARGET_AGENT_ID, { name: 'Agente sin correo', email: '  ' }]]),
  });
  ok(
    'T6 también falla cerrado si el agente no tiene email',
    withoutEmail.ok === false && withoutEmail.reason === 'agente_sin_email',
    withoutEmail,
  );
}

console.log('\nT7 · DESTINATARIO ES EL VIEWER');
{
  const result = resolve({
    viewerEmail: 'accounting@mordorstaffing.com',
    viewerEmails: new Set(['accounting@mordorstaffing.com']),
  });
  ok(
    'T7 informa ya_es_del_usuario',
    result.ok === false
      && result.reason === 'ya_es_del_usuario'
      && result.userId === TARGET_USER_ID,
    result,
  );
}

console.log('\nT8 · NORMALIZACIÓN DE EMAIL');
{
  const normalizedAgents = new Map([
    [TARGET_AGENT_ID, { name: 'Juan Hincapié', email: '  ACCOUNTING@MORDORSTAFFING.COM  ' }],
  ]);
  const result = resolve({
    agents: normalizedAgents,
    selectOptions: [
      option(TARGET_USER_ID, 'Juan Hincapié (  accounting@mordorstaffing.com  )'),
    ],
  });
  ok(
    'T8 ignora mayúsculas y espacios alrededor',
    result.ok === true && result.userId === TARGET_USER_ID,
    result,
  );
}

console.log('\nT9 · PARSEO DE LABEL');
{
  const result = resolve({
    selectOptions: [
      option(OTHER_USER_ID, 'Label sin paréntesis'),
      option(TARGET_USER_ID, 'Nombre Completo (accounting@mordorstaffing.com)'),
    ],
  });
  ok(
    'T9 extrae nombre/email e ignora el label inválido',
    result.ok === true
      && result.userId === TARGET_USER_ID
      && result.name === 'Nombre Completo'
      && result.email === 'accounting@mordorstaffing.com',
    result,
  );
}

function resolutionResult(target) {
  return { ticket: {}, target };
}

console.log('\nT10 · TODOS LOS AGENTES SON DESCONOCIDOS');
{
  const results = Array.from({ length: 42 }, () => resolutionResult({
    ok: false,
    reason: 'agente_zoho_desconocido',
  }));
  ok('T10 aborta los 42 candidatos desconocidos', shouldAbortForUnknownAgents(results), results);
}

console.log('\nT11 · HAY UN CANDIDATO RESUELTO');
{
  const results = Array.from({ length: 41 }, () => resolutionResult({
    ok: false,
    reason: 'agente_zoho_desconocido',
  }));
  results.push(resolutionResult({ ok: true, userId: TARGET_USER_ID }));
  ok(
    'T11 no aborta con evidencia de directorio cargado',
    shouldAbortForUnknownAgents(results) === false,
    results,
  );
}

console.log('\nT12 · NO HAY CANDIDATOS');
{
  ok(
    'T12 no aborta una lista vacía',
    shouldAbortForUnknownAgents([]) === false,
  );
}

console.log('\nT13 · OTROS MOTIVOS DE SALTEO');
{
  const results = [
    resolutionResult({ ok: false, reason: 'sin_usuario_en_tolkien' }),
    resolutionResult({ ok: false, reason: 'agente_sin_email' }),
  ];
  ok(
    'T13 no aborta por motivos distintos',
    shouldAbortForUnknownAgents(results) === false,
    results,
  );
}

const OWNERSHIP_AFTER_WORK_308 = '🙋 OwnershipTaken by Esther Sofia Arias Ramirez · 2026-08-02 22:08 UTC (assigned by nmosquera)— reassign to —Abraham Joel...';
const OWNERSHIP_BEFORE_WORK_308 = '🙋 OwnershipTaken by Nicolas Sebastian Mosquera Madrigal · 2026-07-27 17:45 UTC (assigned by codex:desk-owner-reconciliation)— reassign to —Abraham Joel...';

console.log('\nT14 · EXTRACCIÓN DEL DUEÑO MOSTRADO');
{
  const result = extractReassignAssigneeName(OWNERSHIP_AFTER_WORK_308);
  ok(
    'T14 extrae el nombre entre Taken by y la fecha',
    result === 'Esther Sofia Arias Ramirez',
    result,
  );
}

console.log('\nT15 · VERIFICACIÓN POR NOMBRE CON SELECT RESETEADO');
{
  const result = verifyReassignState(
    { assignedToUserId: null, assignee: OWNERSHIP_AFTER_WORK_308 },
    { assignedToUserId: TARGET_USER_ID, targetName: 'Esther Sofia Arias Ramirez' },
  );
  ok(
    'T15 verifica aunque assignedToUserId sea null',
    result.ok === true && result.nameMatches === true && result.uuidMatches === false,
    result,
  );
}

console.log('\nT16 · VERIFICACIÓN ALTERNATIVA POR UUID');
{
  const result = verifyReassignState(
    { assignedToUserId: TARGET_USER_ID, assignee: 'bloque sin dueño extraíble' },
    { assignedToUserId: TARGET_USER_ID, targetName: 'Esther Sofia Arias Ramirez' },
  );
  ok(
    'T16 verifica por UUID aunque no pueda extraer el nombre',
    result.ok === true && result.nameMatches === false && result.uuidMatches === true,
    result,
  );
}

console.log('\nT17 · DUEÑO SIN CAMBIO');
{
  const before = { assignedToUserId: null, assignee: OWNERSHIP_BEFORE_WORK_308 };
  const result = verifyReassignState(
    { assignedToUserId: null, assignee: OWNERSHIP_BEFORE_WORK_308 },
    { assignedToUserId: TARGET_USER_ID, targetName: 'Esther Sofia Arias Ramirez' },
    { before },
  );
  ok(
    'T17 falla si el dueño sigue siendo el usuario de la sesión',
    result.ok === false
      && result.unchangedOwner === true
      && result.detail?.includes('no cambió'),
    result,
  );
}

console.log('\nT18 · NOMBRES SIN ACENTOS NI MAYÚSCULAS');
{
  const result = verifyReassignState(
    { assignedToUserId: null, assignee: 'OwnershipTaken by Juan Camilo Hincapié Gonzalez · hoy' },
    { assignedToUserId: TARGET_USER_ID, targetName: 'juan camilo hincapie gonzalez' },
  );
  ok(
    'T18 ignora acentos y mayúsculas al comparar nombres',
    result.ok === true && result.nameMatches === true,
    result,
  );
}

console.log('\nT19 · IDEMPOTENCIA');
{
  const result = reassignSubmissionDecision(
    { assignedToUserId: null, assignee: OWNERSHIP_AFTER_WORK_308 },
    { assignedToUserId: TARGET_USER_ID, targetName: 'Esther Sofia Arias Ramirez' },
  );
  ok(
    'T19 saltea sin submit cuando el dueño ya es el destinatario',
    result.shouldSubmit === false && result.reason === 'ya_reasignado',
    result,
  );
}

console.log('\nT20 · RACE DE ALIAS DEL VIEWER');
{
  const viewerAliasAgentId = '813994000000139001';
  const result = resolveReassignTarget({
    zohoAssigneeId: viewerAliasAgentId,
    agents: new Map([[
      viewerAliasAgentId,
      { name: 'Julián García', email: 'dev@mordorstaffing.com' },
    ]]),
    selectOptions: [
      option(OTHER_USER_ID, 'Dev Zoho (dev@mordorstaffing.com)'),
    ],
    viewerEmail: 'jgarcia@mordorstaffing.com',
    viewerEmails: new Set([
      'jgarcia@mordorstaffing.com',
      'dev@mordorstaffing.com',
    ]),
  });
  ok(
    'T20 nunca reasigna el ticket del viewer a otro usuario con su email alias',
    result.ok === false && result.reason === 'ya_es_del_usuario',
    result,
  );
}

console.log('\nT21 · SIN IDENTITY.JSON');
{
  const aliasMap = loadIdentityAliases({
    identityPath: '/identity-ausente/identity.json',
    existsSync: () => false,
    readFileSync: () => { throw new Error('no debería leer'); },
  });
  const viewerEmails = aliasSetFor(' JGARCIA@MORDORSTAFFING.COM ', aliasMap);
  ok(
    'T21 conserva el comportamiento exacto sin configuración',
    aliasMap.size === 0
      && viewerEmails.size === 1
      && viewerEmails.has('jgarcia@mordorstaffing.com'),
    { aliasMap, viewerEmails },
  );
}

console.log('\nT22 · ALIAS SIMÉTRICO Y AGENTE ZOHO');
{
  const aliasMap = loadIdentityAliases({
    identityPath: '/identity-valida/identity.json',
    existsSync: () => true,
    readFileSync: () => JSON.stringify({
      aliases: { ' JGARCIA@MORDORSTAFFING.COM ': [' DEV@MORDORSTAFFING.COM '] },
    }),
  });
  const fromCanonical = aliasSetFor('jgarcia@mordorstaffing.com', aliasMap);
  const fromAlias = aliasSetFor('dev@mordorstaffing.com', aliasMap);
  const identity = resolveZohoViewerIdentity(
    'jgarcia@mordorstaffing.com',
    new Map([[
      '813994000000139001',
      { name: 'Julián García', email: 'dev@mordorstaffing.com' },
    ]]),
    aliasMap,
  );
  ok(
    'T22 normaliza, hace simétrica la relación y resuelve vía dev@',
    fromCanonical.has('dev@mordorstaffing.com')
      && fromAlias.has('jgarcia@mordorstaffing.com')
      && identity.ok === true
      && identity.viewerAgentIds.has('813994000000139001'),
    { fromCanonical, fromAlias, identity },
  );
}

console.log('\nT23 · CLASIFICACIÓN CON AGENTE ALIAS');
{
  const viewerAliasAgentId = '813994000000139001';
  const zoho = {
    id: 'zoho-ticket-alias',
    ticketNumber: '1234',
    status: 'Open',
    statusType: 'Open',
    assigneeId: viewerAliasAgentId,
  };
  const result = await classifyReconciliationTicket(
    {
      ticketWorkflowId: 'tolkien-ticket-alias',
      executionState: 'active',
      deskTicketId: zoho.id,
      deskTicketNumber: zoho.ticketNumber,
    },
    { callTool: async () => zoho },
    '2026-08-04T00:00:00.000Z',
    async () => new Map(),
    new Set([viewerAliasAgentId]),
  );
  ok(
    'T23 el assigneeId del alias queda en realOpen',
    result.bucket === 'realOpen' && result.entry.reason === 'open_in_both',
    result,
  );
}

console.log('\nT24 · ALIAS AMBIGUO');
{
  const viewerEmails = new Set([
    'jgarcia@mordorstaffing.com',
    'dev@mordorstaffing.com',
  ]);
  const ambiguousAgents = new Map([
    ['zoho-jgarcia', { name: 'Julián Tolkien', email: 'jgarcia@mordorstaffing.com' }],
    ['zoho-dev', { name: 'Julián Zoho', email: 'dev@mordorstaffing.com' }],
  ]);
  const result = resolveReassignTarget({
    zohoAssigneeId: 'zoho-dev',
    agents: ambiguousAgents,
    selectOptions: [option(OTHER_USER_ID, 'Dev Zoho (dev@mordorstaffing.com)')],
    viewerEmail: 'jgarcia@mordorstaffing.com',
    viewerEmails,
  });
  ok(
    'T24 falla cerrado con alias_ambiguo',
    result.ok === false && result.reason === 'alias_ambiguo',
    result,
  );
}

console.log('\nT25 · IDENTITY.JSON CORRUPTO');
{
  let thrown = null;
  try {
    loadIdentityAliases({
      identityPath: '/identity-corrupta/identity.json',
      existsSync: () => true,
      readFileSync: () => '{ aliases: roto',
    });
  } catch (error) {
    thrown = error;
  }
  ok(
    'T25 lanza CliError y cita la ruta',
    thrown instanceof CliError
      && thrown.message.includes('/identity-corrupta/identity.json')
      && thrown.message.includes('JSON válido'),
    thrown,
  );
}

console.log('\nT26 · TICKET ABIERTO SIN ASSIGNEEID');
{
  const zoho = {
    id: 'zoho-ticket-sin-asignado',
    ticketNumber: '1235',
    status: 'Open',
    statusType: 'Open',
    assigneeId: '',
  };
  const result = await classifyReconciliationTicket(
    {
      ticketWorkflowId: 'tolkien-ticket-sin-asignado',
      executionState: 'active',
      deskTicketId: zoho.id,
      deskTicketNumber: zoho.ticketNumber,
    },
    { callTool: async () => zoho },
    '2026-08-04T00:00:00.000Z',
    async () => new Map(),
    new Set(['']),
  );
  ok(
    'T26 un assigneeId vacío nunca cae en realOpen',
    result.bucket === 'reassigned' && result.entry.reason === 'assigned_to_other',
    result,
  );
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exitCode = fail > 0 ? 1 : 0;
