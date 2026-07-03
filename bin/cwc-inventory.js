#!/usr/bin/env node
// bin/cwc-inventory.js — regenera el INVENTARIO del proyecto a mano.
//
// El generador (src/core/inventory.js) es determinístico y corre inline en el
// server on-demand; este CLI es para dispararlo/inspeccionarlo suelto.
//   node bin/cwc-inventory.js          → regenera si cambió algo (on-demand)
//   node bin/cwc-inventory.js --force  → regenera sí o sí
import { generateInventory, INVENTORY_JSON, INVENTORY_MD } from '../src/core/inventory.js';

const force = process.argv.includes('--force');
const { inventory: inv, regenerated } = generateInventory({ force });
console.log(regenerated ? 'Inventario regenerado.' : 'Sin cambios: inventario cacheado sigue fresco (usá --force para rehacer).');
console.log(`  módulos: ${inv.counts.modules} · runners: ${inv.counts.runners} · frontend: ${inv.counts.frontend}`);
console.log(`  fingerprint global: ${inv.fingerprint}`);
console.log(`  ${INVENTORY_JSON}`);
console.log(`  ${INVENTORY_MD}`);
