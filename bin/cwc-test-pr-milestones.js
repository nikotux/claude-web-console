#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  acknowledgeMilestones, applyPrObservation, applyPrTransitions, buildPrGraphqlQuery,
  ciWakeOutcome,
  extractTolkienPrLink, isDeployedCompareStatus, isTolkienPrCommand,
  normalizeCodexPrLinks, normalizePrLinks, parseKamalProductionTitle,
  prCiBadge, prLinkFromCodexEvent, prLinkFromCommand, sameCi, summarizePrCi,
  validMilestoneKeys,
} from '../src/modules/chat/pr-milestones.js';
import { milestoneGlyph } from '../public/js/ui/pr-milestone.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok ${pass} - ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`not ok ${pass + fail} - ${name}`);
    console.error(error.stack || error);
  }
}

const base = () => ({
  number: 1934,
  linkedAt: '2026-10-30T10:00:00.000Z',
  title: null,
  url: 'https://github.com/Mordor-Staffing/tolkien/pull/1934',
  approvedAt: null,
  mergedAt: null,
  mergeSha: null,
  deployedAt: null,
  deploySha: null,
  closed: false,
  pending: [],
});
const sha = '0123456789abcdef0123456789abcdef01234567';
const ciObserved = (nodes, extra = {}) => ({
  number: 1934,
  title: 'CI en vivo',
  url: 'https://github.com/Mordor-Staffing/tolkien/pull/1934',
  state: 'OPEN',
  headRefOid: sha.toUpperCase(),
  commits: { nodes: [{ commit: { oid: sha.toUpperCase(), statusCheckRollup: { contexts: { totalCount: nodes.length, nodes } } } }] },
  ...extra,
});
const checkRun = (name, conclusion, extra = {}) => ({
  __typename: 'CheckRun',
  name,
  status: 'COMPLETED',
  conclusion,
  startedAt: '2026-11-06T10:00:00.000Z',
  completedAt: '2026-11-06T10:01:00.000Z',
  ...extra,
});
const statusContext = (context, state, createdAt = '2026-11-06T10:00:00.000Z') => ({
  __typename: 'StatusContext', context, state, createdAt,
});

test('reconoce Bash gh pr create', () => {
  assert.equal(isTolkienPrCommand('Bash', { command: 'gh pr create --fill' }), true);
});
test('reconoce Bash gh pr edit', () => {
  assert.equal(isTolkienPrCommand('Bash', { command: 'cd repo && gh pr edit 1934 --title x' }), true);
});
test('ignora gh pr view', () => {
  assert.equal(isTolkienPrCommand('Bash', { command: 'gh pr view 1934' }), false);
});
test('extrae la primera URL de Tolkien', () => {
  assert.deepEqual(extractTolkienPrLink('listo\nhttps://github.com/Mordor-Staffing/tolkien/pull/1934'), {
    number: 1934,
    url: 'https://github.com/Mordor-Staffing/tolkien/pull/1934',
  });
});
test('ignora URLs de otros repos', () => {
  assert.equal(extractTolkienPrLink('https://github.com/Mordor-Staffing/otro/pull/1934'), null);
});
test('extrae PR de gh pr create exitoso solo desde su output', () => {
  assert.deepEqual(prLinkFromCommand({
    command: 'gh pr create --fill',
    output: 'https://github.com/Mordor-Staffing/tolkien/pull/1991',
    exitCode: 0,
  }), {
    number: 1991,
    url: 'https://github.com/Mordor-Staffing/tolkien/pull/1991',
  });
});
test('ignora gh pr create fallido', () => {
  assert.equal(prLinkFromCommand({
    command: 'gh pr create --fill',
    output: 'https://github.com/Mordor-Staffing/tolkien/pull/1991',
    exitCode: 1,
  }), null);
});
test('ignora gh pr view aunque devuelva una URL', () => {
  assert.equal(prLinkFromCommand({
    command: 'gh pr view 1991',
    output: 'https://github.com/Mordor-Staffing/tolkien/pull/1991',
    exitCode: 0,
  }), null);
});
test('ignora una URL presente solo en el comando', () => {
  assert.equal(prLinkFromCommand({
    command: 'gh pr edit 1991 --body https://github.com/Mordor-Staffing/tolkien/pull/1991',
    output: 'edición terminada',
    exitCode: 0,
  }), null);
});
test('ignora URL de otro repo en el output del comando', () => {
  assert.equal(prLinkFromCommand({
    command: 'gh pr create --fill',
    output: 'https://github.com/Mordor-Staffing/otro/pull/1991',
    exitCode: 0,
  }), null);
});
test('extrae PR de item.completed command_execution de Codex', () => {
  assert.deepEqual(prLinkFromCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: "/bin/bash -lc 'gh pr create --fill'",
      aggregated_output: 'https://github.com/Mordor-Staffing/tolkien/pull/1991\n',
      exit_code: 0,
      status: 'completed',
    },
  }, '2026-10-30T12:00:00.000Z'), {
    number: 1991,
    url: 'https://github.com/Mordor-Staffing/tolkien/pull/1991',
    at: '2026-10-30T12:00:00.000Z',
  });
});
test('ignora item.started de Codex', () => {
  assert.equal(prLinkFromCodexEvent({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'gh pr create --fill',
      aggregated_output: 'https://github.com/Mordor-Staffing/tolkien/pull/1991',
      exit_code: 0,
    },
  }), null);
});
test('ignora agent_message de Codex aunque contenga una URL', () => {
  assert.equal(prLinkFromCodexEvent({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'Creé https://github.com/Mordor-Staffing/tolkien/pull/1991',
    },
  }), null);
});
test('normaliza links de Codex, deduplica, descarta inválidos y limita el total', () => {
  const at = '2026-10-30T12:00:00.000Z';
  const links = normalizeCodexPrLinks([
    { number: 1, url: 'https://example.com/engaño', at },
    { number: 1, url: 'https://github.com/Mordor-Staffing/tolkien/pull/999', at },
    { number: 0, at },
    { number: Number.MAX_SAFE_INTEGER + 1, at },
    { number: 99, at: 'fecha inválida' },
    ...Array.from({ length: 10 }, (_, i) => ({ number: i + 2, at })),
  ]);
  assert.equal(links.length, 10);
  assert.deepEqual(links.map((link) => link.number), Array.from({ length: 10 }, (_, i) => i + 1));
  assert.equal(links[0].url, 'https://github.com/Mordor-Staffing/tolkien/pull/1');
});

test('transición a aprobado', () => {
  const out = applyPrTransitions(base(), { state: 'OPEN', reviewDecision: 'APPROVED' }, { now: '2026-10-30T11:00:00.000Z' });
  assert.deepEqual(out.milestones, ['approved']);
  assert.deepEqual(out.link.pending, ['approved']);
});
test('transición a mergeado', () => {
  const out = applyPrTransitions(base(), { state: 'MERGED', mergedAt: '2026-10-30T11:00:00.000Z', mergeCommit: { oid: sha } });
  assert.deepEqual(out.milestones, ['merged']);
  assert.equal(out.link.mergeSha, sha);
});
test('aprobado y mergeado juntos emiten solo mergeado', () => {
  const out = applyPrTransitions(base(), {
    state: 'MERGED', reviewDecision: 'APPROVED', mergedAt: '2026-10-30T11:00:00.000Z', mergeCommit: { oid: sha },
  });
  assert.deepEqual(out.milestones, ['merged']);
  assert.ok(out.link.approvedAt);
});
test('PR cerrada sin merge queda terminada sin hito', () => {
  const out = applyPrTransitions(base(), { state: 'CLOSED', reviewDecision: null, mergedAt: null, mergeCommit: null });
  assert.equal(out.link.closed, true);
  assert.deepEqual(out.milestones, []);
});
test('primera observación del backfill registra estado sin pendiente', () => {
  const out = applyPrTransitions(base(), {
    state: 'MERGED', reviewDecision: 'APPROVED', mergedAt: '2026-10-30T11:00:00.000Z', mergeCommit: { oid: sha },
  }, { now: '2026-10-30T11:05:00.000Z', firstObservation: true });
  assert.equal(out.link.mergedAt, '2026-10-30T11:00:00.000Z');
  assert.deepEqual(out.link.pending, []);
});
test('normalize conserva el baseline durable', () => {
  assert.equal(normalizePrLinks([{ ...base(), baseline: true }])[0].baseline, true);
});
test('primera observación consume baseline sin generar pendientes', () => {
  const out = applyPrObservation({ ...base(), baseline: true }, {
    state: 'MERGED', reviewDecision: 'APPROVED', mergedAt: '2026-10-30T11:00:00.000Z', mergeCommit: { oid: sha },
  }, { deployed: true, deploySha: sha, deployedAt: '2026-10-30T11:10:00.000Z' }, { now: '2026-10-30T11:05:00.000Z' });
  assert.equal(out.link.baseline, false);
  assert.deepEqual(out.link.pending, []);
  assert.deepEqual(out.milestones, []);
});
test('observación se aplica al índice vigente sin resucitar un ACK', () => {
  const snapshot = {
    ...base(), approvedAt: '2026-10-30T10:30:00.000Z', pending: ['approved'],
  };
  const prepended = { ...base(), number: 2000, url: 'https://github.com/Mordor-Staffing/tolkien/pull/2000' };
  const current = [prepended, acknowledgeMilestones([snapshot], ['approved:1934'])[0]];
  const index = current.findIndex((link) => link.number === snapshot.number);
  const out = applyPrObservation(current[index], {
    state: 'MERGED', reviewDecision: 'APPROVED', mergedAt: '2026-10-30T11:00:00.000Z', mergeCommit: { oid: sha },
  }, null, { now: '2026-10-30T11:05:00.000Z' });
  current[index] = out.link;
  assert.equal(current[0].number, 2000);
  assert.deepEqual(current[1].pending, ['merged']);
  assert.equal(current[1].number, 1934);
});
test('un merge anterior al enlace se registra sin pendiente', () => {
  const out = applyPrTransitions(base(), {
    state: 'MERGED', mergedAt: '2026-10-30T09:00:00.000Z', mergeCommit: { oid: sha },
  }, { now: '2026-10-30T11:05:00.000Z' });
  assert.deepEqual(out.milestones, []);
  assert.deepEqual(out.link.pending, []);
});
test('los campos extra de CI no alteran la observación de hitos', () => {
  const observed = {
    state: 'OPEN', reviewDecision: null, title: 'Sin cambios',
    url: 'https://github.com/Mordor-Staffing/tolkien/pull/1934',
  };
  const options = { now: '2026-10-30T11:05:00.000Z' };
  const plain = applyPrObservation(base(), observed, null, options);
  const withCi = applyPrObservation(base(), {
    ...observed,
    headRefOid: sha,
    commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: { contexts: { nodes: [] } } } }] },
  }, null, options);
  assert.deepEqual(withCi, plain);
});

test('acepta solo el título exacto de deploy a producción', () => {
  assert.equal(parseKamalProductionTitle(`Deploy Kamal deploy production sha-${sha}`), sha);
});
for (const [name, title] of [
  ['next', `Deploy Kamal deploy next sha-${sha}`],
  ['dead-letter-bot-reboot', `Deploy Kamal deploy dead-letter-bot-reboot sha-${sha}`],
  ['rollback', `Rollback production sha-${sha}`],
  ['sha malformado', 'Deploy Kamal deploy production sha-abc123'],
]) {
  test(`rechaza título ${name}`, () => assert.equal(parseKamalProductionTitle(title), null));
}

test('ahead e identical significan desplegado', () => {
  assert.equal(isDeployedCompareStatus('ahead'), true);
  assert.equal(isDeployedCompareStatus('identical'), true);
  assert.equal(isDeployedCompareStatus('behind'), false);
  assert.equal(isDeployedCompareStatus('diverged'), false);
});
test('valida claves de ack y límite', () => {
  assert.equal(validMilestoneKeys(['approved:1', 'merged:1934', 'deployed:99']), true);
  assert.equal(validMilestoneKeys(Array.from({ length: 21 }, (_, i) => `merged:${i + 1}`)), false);
  assert.equal(validMilestoneKeys(['closed:1']), false);
  assert.equal(validMilestoneKeys('merged:1'), false);
});
test('ack elimina solo las claves indicadas', () => {
  const link = { ...base(), pending: ['approved', 'merged'] };
  assert.deepEqual(acknowledgeMilestones([link], ['approved:1934'])[0].pending, ['merged']);
});
test('GraphQL deduplica y usa aliases seguros', () => {
  const query = buildPrGraphqlQuery([1934, 1934, 8]);
  assert.match(query, /p1934: pullRequest\(number:1934\)/);
  assert.match(query, /p8: pullRequest\(number:8\)/);
  assert.equal((query.match(/p1934:/g) || []).length, 1);
  assert.match(query, /number title url state reviewDecision mergedAt mergeCommit\{oid\}/);
  assert.match(query, /headRefOid commits\(last:1\)/);
  assert.match(query, /statusCheckRollup/);
  assert.match(query, /contexts\(first:60\)\{totalCount nodes/);
});
test('GraphQL conserva el límite de 50 PR', () => {
  const query = buildPrGraphqlQuery(Array.from({ length: 60 }, (_, i) => i + 1));
  assert.equal((query.match(/: pullRequest/g) || []).length, 50);
  assert.doesNotMatch(query, /p51:/);
});

test('resume CI con todas las revisiones aprobadas', () => {
  const ci = summarizePrCi(ciObserved([
    checkRun('lint', 'SUCCESS'),
    checkRun('docs', 'NEUTRAL', { startedAt: '2026-11-06T09:58:00.000Z' }),
  ]));
  assert.deepEqual(ci, {
    number: 1934,
    title: 'CI en vivo',
    url: 'https://github.com/Mordor-Staffing/tolkien/pull/1934',
    sha,
    state: 'passed',
    total: 2,
    done: 2,
    failed: 0,
    running: [],
    failedNames: [],
    startedAt: Date.parse('2026-11-06T09:58:00.000Z'),
    finishedAt: Date.parse('2026-11-06T10:01:00.000Z'),
  });
});
test('una falla define failed aunque otra revisión siga corriendo', () => {
  const ci = summarizePrCi(ciObserved([
    checkRun('tests', 'FAILURE'),
    checkRun('deploy', null, { status: 'IN_PROGRESS', completedAt: null }),
  ]));
  assert.equal(ci.state, 'failed');
  assert.equal(ci.done, 1);
  assert.equal(ci.failed, 1);
  assert.deepEqual(ci.running, ['deploy']);
  assert.deepEqual(ci.failedNames, ['tests']);
  assert.equal(ci.finishedAt, Date.parse('2026-11-06T10:01:00.000Z'));
});
test('todas terminadas con falla producen estado failed y nombres acotados', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => checkRun(` falla ${i} `.padEnd(100, 'x'), 'FAILURE'));
  const ci = summarizePrCi(ciObserved(nodes));
  assert.equal(ci.state, 'failed');
  assert.equal(ci.failed, 10);
  assert.equal(ci.failedNames.length, 8);
  assert.ok(ci.failedNames.every((name) => name.length <= 80 && name === name.trim()));
});
test('skipped, neutral y stale cuentan como revisiones listas sin falla', () => {
  const ci = summarizePrCi(ciObserved([
    checkRun('skip', 'SKIPPED'), checkRun('neutral', 'NEUTRAL'), checkRun('old', 'STALE'),
  ]));
  assert.equal(ci.state, 'passed');
  assert.equal(ci.done, 3);
  assert.equal(ci.failed, 0);
});
test('mezcla estados clásicos de StatusContext', () => {
  const ci = summarizePrCi(ciObserved([
    statusContext('legacy-ok', 'SUCCESS', '2026-11-06T09:55:00.000Z'),
    statusContext('legacy-bad', 'ERROR'),
    statusContext('legacy-wait', 'EXPECTED'),
  ]));
  assert.equal(ci.state, 'failed');
  assert.equal(ci.done, 2);
  assert.equal(ci.failed, 1);
  assert.deepEqual(ci.running, ['legacy-wait']);
  assert.deepEqual(ci.failedNames, ['legacy-bad']);
  assert.equal(ci.startedAt, Date.parse('2026-11-06T09:55:00.000Z'));
});
test('un re-run con el mismo nombre conserva solo la ejecución más nueva', () => {
  const ci = summarizePrCi(ciObserved([
    checkRun('tests', 'FAILURE', { startedAt: '2026-11-06T09:00:00.000Z' }),
    checkRun('tests', 'SUCCESS', { startedAt: '2026-11-06T10:00:00.000Z' }),
  ]));
  assert.equal(ci.total, 1);
  assert.equal(ci.state, 'passed');
  assert.equal(ci.failed, 0);
});
test('PR merged o cerrada no tiene resumen de CI', () => {
  const observed = ciObserved([checkRun('tests', 'SUCCESS')]);
  assert.equal(summarizePrCi({ ...observed, state: 'MERGED' }), null);
  assert.equal(summarizePrCi({ ...observed, state: 'CLOSED' }), null);
});
test('PR sin revisiones no tiene resumen de CI', () => {
  assert.equal(summarizePrCi(ciObserved([])), null);
  assert.equal(summarizePrCi(ciObserved([], { commits: { nodes: [] } })), null);
});
test('entrada basura nunca produce un resumen ni lanza', () => {
  assert.equal(summarizePrCi(null), null);
  assert.equal(summarizePrCi({ state: 'OPEN', commits: { nodes: 'no' } }), null);
  assert.equal(summarizePrCi({ get state() { throw new Error('basura'); } }), null);
  assert.equal(summarizePrCi(ciObserved([]), null), null);
});
test('ciWakeOutcome avisa la primera falla aunque sigan revisiones corriendo', () => {
  const previousCi = summarizePrCi(ciObserved([
    checkRun('tests', null, { status: 'IN_PROGRESS', completedAt: null }),
    checkRun('deploy', null, { status: 'IN_PROGRESS', completedAt: null }),
  ]));
  const ci = summarizePrCi(ciObserved([
    checkRun('tests', 'FAILURE'),
    checkRun('deploy', null, { status: 'IN_PROGRESS', completedAt: null }),
  ]));
  assert.equal(ciWakeOutcome(previousCi, ci), 'falló: tests');
});
test('ciWakeOutcome no repite una falla cuando termina otra revisión', () => {
  const previousCi = summarizePrCi(ciObserved([
    checkRun('tests', 'FAILURE'),
    checkRun('deploy', null, { status: 'IN_PROGRESS', completedAt: null }),
  ]));
  const ci = summarizePrCi(ciObserved([
    checkRun('tests', 'FAILURE'),
    checkRun('deploy', 'FAILURE', { completedAt: '2026-11-06T10:02:00.000Z' }),
  ]));
  assert.equal(ciWakeOutcome(previousCi, ci), null);
});
test('ciWakeOutcome cubre passed, running y observaciones ausentes', () => {
  const running = summarizePrCi(ciObserved([
    checkRun('tests', null, { status: 'IN_PROGRESS', completedAt: null }),
  ]));
  const passed = summarizePrCi(ciObserved([checkRun('tests', 'SUCCESS')]));
  assert.equal(ciWakeOutcome(running, passed), 'pasó');
  assert.equal(ciWakeOutcome(running, running), null);
  assert.equal(ciWakeOutcome(null, passed), null);
  assert.equal(ciWakeOutcome(running, null), null);
});
test('ciWakeOutcome permite que un re-run vuelva a despertar al terminar', () => {
  const failed = summarizePrCi(ciObserved([checkRun('tests', 'FAILURE')]));
  const running = summarizePrCi(ciObserved([
    checkRun('tests', null, { status: 'IN_PROGRESS', completedAt: null }),
  ]));
  const passed = summarizePrCi(ciObserved([checkRun('tests', 'SUCCESS')]));
  assert.equal(ciWakeOutcome(failed, running), null);
  assert.equal(ciWakeOutcome(running, passed), 'pasó');
});
test('prCiBadge prioriza running, luego failed y el passed más reciente', () => {
  const passedOld = summarizePrCi(ciObserved([checkRun('old', 'SUCCESS')], { number: 1 }));
  const passedNew = { ...passedOld, number: 2, finishedAt: passedOld.finishedAt + 1_000 };
  const failed = { ...passedOld, number: 3, state: 'failed', failed: 1, failedNames: ['tests'] };
  const running = { ...passedOld, number: 4, state: 'running', done: 0, running: ['tests'], finishedAt: null };
  assert.deepEqual(prCiBadge([passedNew, failed, running]), { number: 4, state: 'running', done: 0, total: 1, failed: 0 });
  assert.deepEqual(prCiBadge([passedNew, failed]), { number: 3, state: 'failed', done: 1, total: 1, failed: 1 });
  assert.deepEqual(prCiBadge([passedOld, passedNew]), { number: 2, state: 'passed', done: 1, total: 1, failed: 0 });
  assert.equal(prCiBadge('basura'), null);
});
test('sameCi detecta solo cambios visibles de CI', () => {
  const ci = summarizePrCi(ciObserved([checkRun('tests', 'SUCCESS')]));
  assert.equal(sameCi(ci, { ...ci, title: 'otro', url: 'https://example.com' }), true);
  assert.equal(sameCi(ci, { ...ci, state: 'failed', failed: 1, failedNames: ['tests'] }), false);
  assert.equal(sameCi(ci, { ...ci, sha: 'f'.repeat(40) }), false);
  assert.equal(sameCi({ ...ci, running: ['b', 'a'] }, { ...ci, running: ['a', 'b'] }), true);
  assert.equal(sameCi(null, null), true);
  assert.equal(sameCi(ci, null), false);
});
test('glifos coinciden con el Ojo, el anillo con gema y la torre aprobados', () => {
  assert.match(milestoneGlyph('approved'), /M1 6s1\.8-3 5-3/);
  assert.match(milestoneGlyph('merged'), /M4\.8 2\.25 6 1l1\.2 1\.25/);
  assert.doesNotMatch(milestoneGlyph('merged'), /M2\.8 8h10\.4/);
  assert.match(milestoneGlyph('deployed'), /M2\.2 10h7\.6/);
});

console.log(`${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
