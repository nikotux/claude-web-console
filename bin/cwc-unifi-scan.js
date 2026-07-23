#!/usr/bin/env node
import { scanToPad } from '../src/modules/unifi/inventory-shared.js';

const dryRun = process.argv.slice(2).some((arg) => arg === '--dry-run' || arg === '-n');

try {
  const res = await scanToPad({ dryRun });
  if (!res.ok) {
    console.error(`Escaneo UniFi falló: ${res.error || 'error desconocido'}`);
    process.exit(1);
  }

  console.log('Escaneo UniFi estructural completado');
  console.log(`Modo: ${res.dryRun ? 'dry-run (sin escrituras)' : 'escritura'}`);
  console.log(`Total escaneado: ${res.total}`);
  console.log(`Creados: ${res.created}`);
  console.log(`Actualizados: ${res.updated}`);
  console.log(`Retirados: ${res.retired}`);
  console.log(`Errores: ${res.errors || 0}`);
  process.exit(0);
} catch (err) {
  console.error(`Escaneo UniFi falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
