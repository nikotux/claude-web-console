#!/usr/bin/env node
// bin/cwc-i18n-audit.js — CLI de la auditoría compartida de i18n y ayuda.
//   node bin/cwc-i18n-audit.js          → informe legible
//   node bin/cwc-i18n-audit.js --json   → informe estructurado
//   node bin/cwc-i18n-audit.js --soft   → informa hallazgos pero sale 0
import {
  auditI18n,
  HELP_BUTTON_EXCEPTIONS,
} from '../src/modules/health/i18n-shared.js';

const args = process.argv.slice(2);
const knownFlags = new Set(['--json', '--soft']);
const unknownFlags = args.filter((arg) => !knownFlags.has(arg));
if (unknownFlags.length) {
  console.error(`Flags desconocidos: ${unknownFlags.join(', ')}`);
  process.exit(2);
}

const jsonOutput = args.includes('--json');
const soft = args.includes('--soft');

function emojiForI18n(row) {
  if (row.status === 'SIN DICCIONARIO' || row.status === 'DICCIONARIO INVÁLIDO') return '🔴';
  if (row.missingCount) return '🔴';
  if (row.orphanedCount) return '⚠️';
  return '✅';
}

function list(values) {
  return values.length ? values.join(', ') : 'ninguno';
}

function printHuman(report) {
  console.log('## i18n');
  console.log('| estado | namespace | usadas | en | faltantes | huérfanas | diccionario |');
  console.log('|---|---:|---:|---:|---:|---:|---|');
  for (const row of report.i18n.namespaces) {
    const dictionary = row.dictionaryError
      ? `INVÁLIDO: ${row.dictionaryError}`
      : (row.dictionary || 'SIN DICCIONARIO');
    console.log(`| ${emojiForI18n(row)} | ${row.namespace} | ${row.usedCount} | ${row.translatedCount} | ${row.missingCount} | ${row.orphanedCount} | ${dictionary} |`);
  }
  const totals = report.i18n.totals;
  console.log(`Total: ${totals.used} usadas · ${totals.translated} en inglés · ${totals.missing} faltantes · ${totals.orphaned} huérfanas`);

  console.log('\n## carga');
  const outsideModules = report.carga.dictionariesOutsideModules;
  console.log(`${outsideModules.length ? '🔴' : '✅'} Diccionarios en disco fuera de MODULES: ${list(outsideModules)}`);
  const withoutFile = report.carga.modulesWithoutFile;
  console.log(`${withoutFile.length ? '⚠️' : '✅'} Entradas de MODULES sin archivo: ${list(withoutFile)}`);
  const pages = report.carga.pagesWithoutInit;
  console.log(`${pages.length ? '⚠️' : '✅'} Páginas sin initI18n: ${list(pages)}`);
  const ignored = report.carga.dictionariesIgnoredByGit;
  console.log(`${ignored.length ? '🔴' : '✅'} Diccionarios ignorados por git: ${list(ignored)}`);

  console.log('\n## ayuda');
  const withoutButton = report.ayuda.indexWithoutButton;
  console.log(`${withoutButton.length ? '⚠️' : '✅'} Entradas del índice sin helpBtn: ${list(withoutButton)}`);
  for (const exception of HELP_BUTTON_EXCEPTIONS) {
    if (!report.ayuda.knownExceptions.includes(exception.id)) continue;
    console.log(`✅ Excepción conocida ${exception.id}: ${exception.reason}`);
  }
  const withoutIndex = report.ayuda.buttonsWithoutIndex;
  console.log(`${withoutIndex.length ? '🔴' : '✅'} helpBtn sin entrada en el índice: ${list(withoutIndex)}`);
  const brokenLoads = report.ayuda.brokenLoads
    .map((entry) => `${entry.id} → ${entry.path || 'load ausente'}`);
  console.log(`${brokenLoads.length ? '🔴' : '✅'} Loads inexistentes: ${list(brokenLoads)}`);
}

const report = auditI18n();
if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else printHuman(report);
process.exitCode = soft || report.ok ? 0 : 1;
