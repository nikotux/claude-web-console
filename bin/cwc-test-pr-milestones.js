#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  acknowledgeMilestones, applyPrObservation, applyPrTransitions, buildPrGraphqlQuery,
  extractTolkienPrLink, isDeployedCompareStatus, isTolkienPrCommand,
  normalizePrLinks, parseKamalProductionTitle, validMilestoneKeys,
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
});
test('glifos coinciden con el Ojo, el anillo con gema y la torre aprobados', () => {
  assert.match(milestoneGlyph('approved'), /M1 6s1\.8-3 5-3/);
  assert.match(milestoneGlyph('merged'), /M4\.8 2\.25 6 1l1\.2 1\.25/);
  assert.doesNotMatch(milestoneGlyph('merged'), /M2\.8 8h10\.4/);
  assert.match(milestoneGlyph('deployed'), /M2\.2 10h7\.6/);
});

console.log(`${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
