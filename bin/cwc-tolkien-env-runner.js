#!/usr/bin/env node
import { provisionEnv } from '../src/modules/tolkien/env-shared.js';

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error(`[${new Date().toISOString()}] falta id de entorno`);
    process.exit(1);
  }
  console.log(`[${new Date().toISOString()}] provision start ${id}`);
  await provisionEnv(id);
  console.log(`[${new Date().toISOString()}] provision end ${id}`);
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] provision fatal: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
