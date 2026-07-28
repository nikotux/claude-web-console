#!/usr/bin/env node
// bin/cwc-retro-sweep-runner.js — BUG-2068: barre transcripts TUI quietos y
// encola su destilación de Mejora Continua. Consume 0 TOKENS porque no usa el
// SDK (la regla 6 no aplica) y vive desacoplado del server por la regla dura 2.
// Lo dispara el tick de init() del módulo retro; también admite una inspección
// manual estrictamente read-only con --dry-run.
import {
  clearSweepLock,
  isSweepRunning,
  readSweepLock,
  SWEEP_HEARTBEAT_MS,
  SWEEP_MAX_AGE_MS,
  SWEEP_MAX_PER_RUN,
  SWEEP_QUIET_MS,
  sweepTuiTranscripts,
  writeSweepLock,
  writeSweepState,
} from '../src/modules/retro/sweep-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const asJson = argv.includes('--json');

function numericFlag(name, fallback) {
  const raw = argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 1));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const quietMs = numericFlag('--quiet-ms', SWEEP_QUIET_MS);
const maxAgeDays = numericFlag('--max-age-days', SWEEP_MAX_AGE_MS / (24 * 60 * 60 * 1000));
const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
const max = Math.floor(numericFlag('--max', SWEEP_MAX_PER_RUN));

function readableSummary(summary) {
  console.log(`Barrido TUI${summary.dryRun ? ' (simulación)' : ''}: ${summary.candidates.length} candidato(s) de ${summary.cli} sesión(es) CLI en ${summary.scanned} transcript(s).`);
  console.log(`Omitidos: ${summary.skipped.esChat} chat(s) · ${summary.skipped.yaBarrido} ya barrido(s) · ${summary.skipped.activo} activo(s) · ${summary.skipped.viejo} viejo(s) · ${summary.skipped.grande} grande(s).`);
  console.log(`Pendientes para próximas corridas: ${summary.pendientes}.`);
  if (!summary.candidates.length) {
    console.log('Candidatos: ninguno.');
    return;
  }
  console.log('Candidatos:');
  for (const item of summary.candidates) {
    const date = new Date(item.mtimeMs).toISOString();
    console.log(`- ${item.sessionId} · ${date} · ${item.cwd} · ${item.title || 'Sin título'}`);
  }
}

async function runDry() {
  const summary = await sweepTuiTranscripts({
    quietMs,
    maxAgeMs,
    max,
    dryRun: true,
  });
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else readableSummary(summary);
}

async function runReal() {
  // spawnRetroSweepRunner reserva el lock con NUESTRO pid antes de que este
  // proceso arranque. Esa reserva propia es válida; solo bloquea un pid ajeno.
  const reservation = readSweepLock();
  if (isSweepRunning() && reservation?.pid !== process.pid) {
    log('ya hay un barrido en curso');
    return;
  }

  const startedAt = Date.now();
  writeSweepLock({ pid: process.pid });
  const heartbeat = setInterval(
    () => writeSweepLock({ pid: process.pid }),
    SWEEP_HEARTBEAT_MS,
  );
  heartbeat.unref();
  writeSweepState({
    status: 'running',
    startedAt,
    finishedAt: 0,
    result: null,
    error: null,
  });

  try {
    const result = await sweepTuiTranscripts({
      quietMs,
      maxAgeMs,
      max,
      dryRun: false,
    });
    writeSweepState({
      status: 'done',
      startedAt,
      finishedAt: Date.now(),
      result,
      error: null,
    });
    log(`OK: ${result.scanned} transcript(s) · ${result.cli} CLI · ${result.queued} encolado(s) · ${result.trivial} trivial(es) · ${result.pendientes} pendiente(s).`);
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    writeSweepState({
      status: 'error',
      startedAt,
      finishedAt: Date.now(),
      result: null,
      error: message,
    });
    log('FALLÓ:', message);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    clearSweepLock();
  }
}

if (dryRun) await runDry();
else await runReal();
