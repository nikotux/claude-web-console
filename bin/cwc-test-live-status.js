#!/usr/bin/env node
import assert from 'node:assert/strict';
import { codexBadge, codexLiveForChat, codexTypical, liveKey } from '../src/modules/chat/live-status.js';
import { buildWakeText, WAKE_PREFIX } from '../src/modules/chat/shared.js';
import { formatLiveDuration, renderCiCard, renderCodexCard } from '../public/js/modules/chat/live-cards.js';
import { isWakeText, wakeSummary } from '../public/js/modules/chat/wake-notice.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass += 1; console.log(`ok ${pass} - ${name}`); }
  catch (error) { fail += 1; console.error(`not ok ${pass + fail} - ${name}`); console.error(error.stack || error); }
}

const now = Date.parse('2026-11-06T12:00:00.000Z');
const job = (id, extra = {}) => ({
  id, chatId: 'chat-a', label: `Encargo ${id}`, status: 'running',
  startedAt: new Date(now - 60_000).toISOString(), heartbeatAt: new Date(now).toISOString(),
  ...extra,
});

test('filtra por chat y conserva activos', () => {
  assert.deepEqual(codexLiveForChat([job('a'), job('b', { chatId: 'chat-b' })], 'chat-a', now).map((x) => x.id), ['a']);
});
test('conserva terminados por 90 s y descarta anteriores', () => {
  const recent = job('recent', { status: 'done', finishedAt: new Date(now - 90_000).toISOString() });
  const old = job('old', { status: 'done', finishedAt: new Date(now - 90_001).toISOString() });
  assert.deepEqual(codexLiveForChat([old, recent], 'chat-a', now).map((x) => x.id), ['recent']);
});
test('recorta etiqueta y ordena por inicio', () => {
  const live = codexLiveForChat([
    job('late', { label: 'x'.repeat(140) }),
    job('early', { startedAt: new Date(now - 120_000).toISOString() }),
  ], 'chat-a', now);
  assert.deepEqual(live.map((x) => x.id), ['early', 'late']);
  assert.equal(live[1].label.length, 120);
});
test('no calcula tiempos típicos con menos de diez muestras', () => {
  assert.equal(codexTypical(Array.from({ length: 9 }, (_, i) => job(String(i), { status: 'done', finishedAt: now }))), null);
});
test('calcula mediana y p90 de trabajos correctos', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => job(String(i), {
    status: 'done', startedAt: now, finishedAt: now + (i + 1) * 1_000,
  }));
  assert.deepEqual(codexTypical(jobs), { medianMs: 5_500, p90Ms: 9_000, n: 10 });
});
test('ignora errores en los tiempos típicos', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => job(String(i), {
    status: 'done', isError: i === 0, startedAt: now, finishedAt: now + 1_000,
  }));
  assert.equal(codexTypical(jobs), null);
});
test('badge cuenta pasos del primer trabajo activo', () => {
  assert.deepEqual(codexBadge([job('a', { progress: { steps: [{ done: true }, { done: false }] } })]), { running: true, done: 1, total: 2 });
  assert.deepEqual(codexBadge([job('a')]), { running: true, done: 0, total: 0 });
});
test('badge desaparece sin trabajos activos', () => {
  assert.equal(codexBadge([job('a', { status: 'done', finishedAt: now })]), null);
});
test('liveKey es estable para el mismo valor', () => {
  assert.equal(liveKey({ jobs: [job('a')] }), liveKey({ jobs: [job('a')] }));
});
test('tarjeta Codex usa singular para un archivo y una acción', () => {
  const running = renderCodexCard(job('singular', { progress: { counts: { files: 1, actions: 1 } } }), { now });
  assert.match(running, /Cambió 1 archivo/);
  assert.match(running, /Hizo 1 acción/);
  assert.doesNotMatch(running, /1 archivos|1 acciones/);
  const finished = renderCodexCard(job('finished', {
    status: 'done', finishedAt: now, progress: { counts: { files: 1 } },
  }), { now });
  assert.match(finished, /cambió 1 archivo/);
  assert.doesNotMatch(finished, /1 archivos/);
});
test('tarjeta Codex completa ofrece minimizar', () => {
  const html = renderCodexCard(job('full', {
    progress: { steps: [{ text: 'Implementar', done: false }] },
  }), { now });
  assert.match(html, /data-live-minimize="codex:full"/);
  assert.match(html, /aria-label="Minimizar"/);
});
test('tarjeta Codex minimizada muestra avance, actividad y restaurar', () => {
  const html = renderCodexCard(job('mini', {
    progress: {
      steps: [
        { text: 'Uno', done: true }, { text: 'Dos', done: true }, { text: 'Tres', done: true },
        { text: 'Escribir estilos', done: false }, { text: 'Probar', done: false }, { text: 'Entregar', done: false },
      ],
      now: { label: 'Ajustando la tarjeta' },
      counts: { files: 2, actions: 5 },
    },
  }), { now, minimized: true });
  assert.match(html, />4\/6</);
  assert.match(html, /Escribir estilos/);
  assert.match(html, /▶ Ajustando la tarjeta/);
  assert.match(html, /data-live-restore="codex:mini"/);
  assert.match(html, /class="live-mini-bar"><span style="width:50%"><\/span>/);
  assert.doesNotMatch(html, /Ver los pasos/);
});
test('tarjeta Codex minimizada conserva la alerta sin señales', () => {
  const html = renderCodexCard(job('stale', {
    heartbeatAt: new Date(now - 91_000).toISOString(),
    progress: { steps: [{ text: 'Esperar respuesta', done: false }] },
  }), { now, minimized: true });
  assert.match(html, /No da señales/);
  assert.match(html, /live-card--warn/);
});
test('tarjeta Codex terminada ignora el estado minimizado', () => {
  const finished = job('same-finished', {
    status: 'done', finishedAt: new Date(now).toISOString(),
    progress: { steps: [{ text: 'Listo', done: true }], counts: { files: 2 } },
  });
  assert.equal(
    renderCodexCard(finished, { now, minimized: true }),
    renderCodexCard(finished, { now, minimized: false }),
  );
});
test('tarjeta Codex limpia markdown en pasos, mensaje y acciones', () => {
  const html = renderCodexCard(job('markdown', {
    progress: {
      steps: [{ text: 'Leer `codex-progress.js`', done: false }, { text: '**Contar** líneas', done: false }],
      lastMessage: '**Guardé** `app.js`',
      now: { label: 'Revisando __índice__' },
      recent: [{ label: '**Abrió** `app.js`', ok: true }],
    },
  }), { now, expanded: true });
  assert.match(html, /Leer codex-progress\.js/);
  assert.match(html, /Lo último que contó: «Guardé app\.js»/);
  assert.match(html, /Revisando índice/);
  assert.match(html, /Abrió app\.js/);
  assert.doesNotMatch(html, /`|\*\*|__/);
});
test('tarjeta CI usa singular y plural según los conteos', () => {
  const failedOne = renderCiCard({
    number: 7, state: 'failed', total: 1, done: 1, failed: 1,
    failedNames: ['lint'], url: 'https://github.com/acme/repo/pull/7',
  }, { now });
  assert.match(failedOne, /Falló 1 revisión del PR #7: lint/);
  const runningOne = renderCiCard({
    number: 7, state: 'running', total: 1, done: 1, failed: 1, failedNames: ['lint'],
  }, { now });
  assert.match(runningOne, /1 de 1 lista · 1 falló: lint/);
  const runningMany = renderCiCard({
    number: 8, state: 'running', total: 5, done: 3, failed: 2, failedNames: ['lint', 'test'],
  }, { now });
  assert.match(runningMany, /3 de 5 listas · 2 fallaron: lint, test/);
});
test('tarjeta CI en curso ofrece minimizar con su clave completa', () => {
  const html = renderCiCard({
    number: 12, sha: 'abc', state: 'running', total: 5, done: 2,
  }, { now });
  assert.match(html, /data-live-minimize="ci:12:abc"/);
});
test('tarjeta CI minimizada muestra avance, revisiones activas y restaurar', () => {
  const html = renderCiCard({
    number: 12, sha: 'abc', state: 'running', total: 5, done: 2,
    running: ['lint', 'test'], url: 'https://github.com/acme/repo/pull/12',
    startedAt: new Date(now - 60_000).toISOString(),
  }, { now, minimized: true });
  assert.match(html, />2\/5</);
  assert.match(html, /▶ lint, test/);
  assert.match(html, /data-live-restore="ci:12:abc"/);
  assert.match(html, /class="live-mini-bar"><span style="width:40%"><\/span>/);
});
test('tarjeta CI minimizada resalta revisiones fallidas', () => {
  const html = renderCiCard({
    number: 12, sha: 'abc', state: 'running', total: 5, done: 2, failed: 1,
    failedNames: ['lint'], url: 'https://github.com/acme/repo/pull/12',
  }, { now, minimized: true });
  assert.match(html, /live-card--fail/);
  assert.match(html, /❌ 1 falló: lint/);
});
test('tarjetas CI finalizadas ignoran el estado minimizado', () => {
  for (const ci of [
    { number: 12, sha: 'abc', state: 'passed', total: 5, done: 5 },
    { number: 12, sha: 'abc', state: 'failed', total: 5, done: 5, failed: 1, failedNames: ['lint'] },
  ]) {
    assert.equal(renderCiCard(ci, { now, minimized: true }), renderCiCard(ci, { now, minimized: false }));
  }
});
test('un minuto conserva el formato compacto', () => {
  assert.equal(formatLiveDuration(60_000), '1 min');
});

const wake = (items) => buildWakeText('bg-done', { items });
test('resume un encargo Codex correcto', () => {
  assert.deepEqual(wakeSummary(wake([{ kind: 'Codex', label: 'uno', outcome: 'done' }])), {
    kind: 'codex', text: 'Codex terminó, puedes continuar',
  });
});
test('resume varios encargos Codex correctos', () => {
  assert.deepEqual(wakeSummary(wake([
    { kind: 'Codex', label: 'uno', outcome: 'done' },
    { kind: 'Codex', label: 'dos', outcome: 'done' },
  ])), { kind: 'codex', text: 'Codex terminó 2 encargos, puedes continuar' });
});
test('marca cualquier resultado Codex problemático', () => {
  for (const outcome of ['error', 'killed']) {
    assert.deepEqual(wakeSummary(wake([{ kind: 'Codex', label: 'uno', outcome }])), {
      kind: 'codex-problem', text: 'Codex terminó con un problema, hay que revisarlo',
    });
  }
});
test('resume uno o varios subagentes', () => {
  assert.deepEqual(wakeSummary(wake([{ kind: 'Subagente', label: 'uno' }])), {
    kind: 'sub', text: 'El subagente terminó, puedes continuar',
  });
  assert.deepEqual(wakeSummary(wake([
    { kind: 'Subagente', label: 'uno' }, { kind: 'Subagente', label: 'dos' },
  ])), { kind: 'sub', text: 'Terminaron 2 subagentes, puedes continuar' });
});
test('resume una mezcla de Codex y subagente', () => {
  assert.deepEqual(wakeSummary(wake([
    { kind: 'Codex', label: 'uno', outcome: 'done' }, { kind: 'Subagente', label: 'dos' },
  ])), { kind: 'mixed', text: 'Codex y el subagente terminaron, puedes continuar' });
});
test('resume el CI terminado o fallado', () => {
  const passed = wake([{ kind: 'CI', number: 2067, outcome: 'pasó' }]);
  assert.match(passed, /• CI del PR #2067 → pasó/);
  assert.deepEqual(wakeSummary(passed), { kind: 'ci', text: 'El CI terminó, mira qué sigue' });
  assert.deepEqual(wakeSummary(wake([{ kind: 'CI', number: 2067, outcome: 'falló: e2e, lint' }])), {
    kind: 'ci-failed', text: 'El CI falló, hay que revisarlo',
  });
  assert.deepEqual(wakeSummary(wake([
    { kind: 'CI', number: 2067, outcome: 'pasó' }, { kind: 'Codex', label: 'uno', outcome: 'done' },
  ])), { kind: 'mixed', text: 'Terminaron varios trabajos, puedes continuar' });
  assert.deepEqual(wakeSummary(wake([
    { kind: 'CI', number: 2067, outcome: 'falló: e2e' }, { kind: 'Codex', label: 'uno', outcome: 'error' },
  ])).kind, 'codex-problem');
});
test('resume mergeado y en producción de un PR', () => {
  const deployed = wake([{ kind: 'PR', number: 2067, outcome: 'en producción' }]);
  assert.match(deployed, /• PR #2067 → en producción/);
  assert.deepEqual(wakeSummary(deployed), {
    kind: 'deployed', text: 'Los cambios del PR #2067 ya están en producción',
  });
  assert.deepEqual(wakeSummary(wake([{ kind: 'PR', number: 2067, outcome: 'mergeado' }])), {
    kind: 'merged', text: 'El PR #2067 se mergeó, mira qué sigue',
  });
  assert.deepEqual(wakeSummary(wake([
    { kind: 'PR', number: 1, outcome: 'mergeado' }, { kind: 'PR', number: 2, outcome: 'en producción' },
  ])), { kind: 'pr', text: 'Hay novedades en 2 PR, mira qué sigue' });
  assert.deepEqual(wakeSummary(wake([
    { kind: 'PR', number: 1, outcome: 'en producción' }, { kind: 'CI', number: 2, outcome: 'pasó' },
  ])).kind, 'mixed');
  assert.deepEqual(wakeSummary(wake([
    { kind: 'PR', number: 1, outcome: 'en producción' }, { kind: 'CI', number: 2, outcome: 'falló: e2e' },
  ])).kind, 'ci-failed');
});
test('resume el check-in de pelota otro', () => {
  const text = buildWakeText('otro-checkin', { otroElapsedMs: 27 * 60_000 });
  assert.deepEqual(wakeSummary(text), {
    kind: 'checkin', text: 'Pasaron 27 min, reviso si ya llegó lo que esperábamos',
  });
});
test('usa un resumen seguro para avisos antiguos desconocidos', () => {
  assert.deepEqual(wakeSummary(`${WAKE_PREFIX} formato anterior`), {
    kind: 'other', text: 'Aviso del despertador',
  });
});
test('no confunde texto normal con un aviso', () => {
  assert.equal(isWakeText('Un mensaje normal'), false);
  assert.equal(isWakeText(wake([{ kind: 'Codex', label: 'uno', outcome: 'done' }])), true);
});

console.log(`${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
