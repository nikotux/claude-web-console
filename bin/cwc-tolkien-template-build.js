#!/usr/bin/env node
// bin/cwc-tolkien-template-build.js — build desacoplado de la DB plantilla
// dormida de Tolkien. El endpoint que lo use reserva el job 'running' en disco;
// este runner solo lee esa reserva, ejecuta buildTemplate() y persiste el final.
import { recloneLiveEnvs } from '../src/modules/tolkien/env-shared.js';
import { buildTemplate, readTemplateJob, writeTemplateJob } from '../src/modules/tolkien/template-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function main() {
  const job = readTemplateJob();
  if (!job || !job.running) { log('no hay job running reservado; salgo.'); process.exit(0); return; }
  try {
    const result = await buildTemplate();
    writeTemplateJob({ ...job, running: false, result, error: null, finishedAt: Date.now() });
    log(`OK template build: ok=${result.ok} en ${result.durationMs}ms`);
    if (result.ok === true) {
      try {
        const envs = await recloneLiveEnvs();
        log('reclone live envs:', JSON.stringify(envs));
      } catch (err) {
        log('FAIL reclone live envs:', err?.message || err);
      }
    }
  } catch (err) {
    writeTemplateJob({ ...job, running: false, result: null, error: String(err?.message || err).slice(0, 300), finishedAt: Date.now() });
    log('FAIL template build:', err?.message || err);
  }
}

main().catch((err) => { log('FALLO inesperado:', err?.message || err); process.exit(1); });
