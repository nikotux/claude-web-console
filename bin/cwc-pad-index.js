#!/usr/bin/env node
// Genera y muestra el preview del índice enrutador de Pad; --apply lo inserta.
import { apply, generate } from '../src/core/pad-index.js';
import { emitTasks, evaluateContracts } from '../src/core/pad-contracts.js';

const args = new Set(process.argv.slice(2));

function printRows(rows, emptyMessage) {
  if (!rows.length) {
    console.log(emptyMessage);
    return;
  }
  console.table(rows);
}

try {
  if (args.has('--contracts')) {
    const result = await evaluateContracts();
    console.log('\nIncumplimientos de contratos:');
    printRows(
      result.failures.map(({ module, kind, check, detail }) => ({ module, kind, check, detail })),
      'Ninguno.',
    );
    const skipped = result.checks.filter((check) => check.ok === null);
    if (skipped.length) {
      console.log('\nChecks omitidos:');
      console.table(skipped.map(({ module, kind, check, detail }) => ({ module, kind, check, detail })));
    }
  }

  if (args.has('--emit')) {
    const dryRun = !args.has('--write');
    const result = await emitTasks(undefined, { dryRun });
    console.log(`\nEmisor de tareas (${dryRun ? 'dry-run, sin escrituras' : 'ESCRITURA habilitada'}):`);
    printRows(result.created, 'Sin tareas para crear.');
    console.log('\nTareas para cerrar:');
    printRows(result.closed, 'Sin tareas para cerrar.');
    console.log('\nAcciones omitidas:');
    printRows(result.skipped, 'Ninguna.');
  }

  if (args.has('--apply')) {
    const result = await apply();
    console.log(`\nÍndice aplicado: ${result.dest}`);
    console.log(result.indexText);
    console.log('\nCálculo del techo:');
    console.log(JSON.stringify(result.ceiling, null, 2));
  } else if (!args.has('--contracts') && !args.has('--emit')) {
    const result = await generate();
    console.log(`\nPreview: ${result.previewFile}\n`);
    console.log(result.indexText);
    console.log('\nCálculo del techo:');
    console.log(JSON.stringify(result.ceiling, null, 2));
  }
} catch (error) {
  console.error(`[pad-index] ${error?.stack || error}`);
  process.exitCode = 1;
}
