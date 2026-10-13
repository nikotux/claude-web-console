#!/usr/bin/env node
// bin/cwc-tolkien-postpull-runner.js — recompila packages/* tras un pull del
// clon principal y reinicia el Tolkien local. Corre desacoplado del server,
// persiste estado/log y no usa el SDK (0 tokens).
import { execFile } from 'node:child_process';
import {
  ensurePackagesBuilt,
  readPostpullJob,
  writePostpullJob,
} from '../src/modules/tolkien/build-shared.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function restartLocalTolkien() {
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', 'restart', 'tolkien-console'], {
      timeout: 60_000,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const output = `${stderr || ''}\n${stdout || ''}`.trim();
      resolve({
        ok: !err,
        step: 'reiniciar Tolkien local',
        detail: err ? (output.split('\n').find(Boolean) || String(err.message || err)).slice(0, 200) : '',
      });
    });
  });
}

async function main() {
  const job = readPostpullJob();
  if (!job?.running) {
    log('no hay job running reservado; salgo.');
    return;
  }

  try {
    const steps = [];
    const build = await ensurePackagesBuilt();
    steps.push(build);
    if (build.ok) steps.push(await restartLocalTolkien());
    const result = { ok: steps.every((step) => step.ok), steps };
    writePostpullJob({ ...job, running: false, result, error: null, finishedAt: Date.now() });
    log(`post-pull terminado: ok=${result.ok}`);
  } catch (err) {
    writePostpullJob({
      ...job,
      running: false,
      result: null,
      error: String(err?.message || err).slice(0, 300),
      finishedAt: Date.now(),
    });
    log('FAIL post-pull:', err?.message || err);
  }
}

main().catch((err) => { log('FALLO inesperado:', err?.message || err); process.exitCode = 1; });
