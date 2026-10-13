#!/usr/bin/env node
// Runner desacoplado del refresh completo de fuentes del workboard Tolkien.
// El endpoint y el timer solo reservan el job; este proceso sobrevive al web.
import {
  readSourcesJob,
  refreshSources,
  writeSourcesJob,
} from '../src/modules/tolkien/sources-shared.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

async function main() {
  const job = readSourcesJob();
  if (!job?.running) {
    log('no hay job running reservado; salgo.');
    return;
  }
  try {
    const result = await refreshSources();
    writeSourcesJob({ ...job, running: false, result, error: null, finishedAt: Date.now() });
    log(`OK fuentes: ok=${result.ok} en ${result.durationMs}ms`);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    writeSourcesJob({ ...job, running: false, result: null, error: message, finishedAt: Date.now() });
    log('FAIL fuentes:', message);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  log('FALLO inesperado:', error?.message || error);
  process.exitCode = 1;
});
