#!/usr/bin/env node
// bin/cwc-tolkien-refresh-runner.js — refresh de la DB LOCAL de Tolkien (TRUNCATE
// + reimport de importers Zoho), DESACOPLADO del server (regla de oro/regla 2:
// operación larga que DEBE sobrevivir a un reinicio de la web). El endpoint POST
// /api/tolkien/refresh-data reserva el job 'running' en disco y spawnea esto; el
// GET /refresh-data/status solo LEE el disco. NO usa el SDK (0 tokens): son
// comandos locales (psql/infisical/pnpm) — la regla 6 no aplica. Lógica en
// src/modules/tolkien/refresh-shared.js.
import { refreshLocalData, readRefreshJob, writeRefreshJob } from '../src/modules/tolkien/refresh-shared.js';
import { spawnSourcesRunner } from '../src/modules/tolkien/sources-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function main() {
  const job = readRefreshJob();
  if (!job || !job.running) { log('no hay job running reservado; salgo.'); process.exit(0); return; }
  try {
    const result = await refreshLocalData();
    writeRefreshJob({ ...job, running: false, result, error: null, finishedAt: Date.now() });
    log(`OK refresh: ok=${result.ok} en ${result.durationMs}ms`);
    if (result.ok) {
      const started = spawnSourcesRunner();
      log(started ? 'refresh completo de fuentes encadenado.' : 'refresh de fuentes ya estaba corriendo; no se duplicó.');
    }
  } catch (err) {
    writeRefreshJob({ ...job, running: false, result: null, error: String(err?.message || err).slice(0, 300), finishedAt: Date.now() });
    log('FAIL refresh:', err?.message || err);
  }
}

main().catch((err) => { log('FALLO inesperado:', err?.message || err); process.exit(1); });
