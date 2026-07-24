#!/usr/bin/env node
// bin/cwc-split-claudemd.js — parte el mapa grande de CLAUDE.md en fichas locales.
//
// Uso:
//   node bin/cwc-split-claudemd.js          → dry-run, no escribe nada
//   node bin/cwc-split-claudemd.js --apply  → genera fichas + manifest
//   node bin/cwc-split-claudemd.js --verify → reconstruye y compara byte a byte
//   node bin/cwc-split-claudemd.js --rewrite-root <archivo> → reemplaza el mapa raíz por un índice
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../src/core/atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_FILE = path.join(REPO_ROOT, 'CLAUDE.md');
const MANIFEST_FILE = path.join(REPO_ROOT, '.cwc-split-manifest.json');

const ROUTES = [
  { test: (entry) => entry.level === 2 && /^([a-z-]+)\/$/.test(entry.key), dest: 'src/modules/$1/CLAUDE.md' },
  { test: (entry) => entry.key === 'src/core/', dest: 'src/core/CLAUDE.md' },
  { test: (entry) => entry.key.startsWith('bin/'), dest: 'bin/CLAUDE.md' },
  { test: (entry) => entry.key.startsWith('public/js/ui/'), dest: 'public/js/ui/CLAUDE.md' },
  { test: (entry) => entry.key.startsWith('public/js/modules/'), dest: 'public/js/modules/CLAUDE.md' },
  { test: (entry) => entry.key.startsWith('public/'), dest: 'public/CLAUDE.md' },
  { test: () => true, dest: '__ROOT__' },
];

function cleanFenceLine(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function splitLines(text) {
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

function lineStartOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function findProjectMapBlock(text) {
  const lines = text.split('\n');
  const offsets = lineStartOffsets(text);
  const headerIndex = lines.findIndex((line) => /^##\s+Mapa del proyecto/.test(cleanFenceLine(line)));
  if (headerIndex === -1) throw new Error('No encontré el encabezado "## Mapa del proyecto".');

  const openIndex = lines.findIndex((line, index) => index > headerIndex && /^```/.test(cleanFenceLine(line)));
  if (openIndex === -1) throw new Error('No encontré la apertura del bloque de código del mapa.');

  const closeIndex = lines.findIndex((line, index) => index > openIndex && /^```/.test(cleanFenceLine(line)));
  if (closeIndex === -1) throw new Error('No encontré el cierre del bloque de código del mapa.');

  const startOffset = offsets[openIndex + 1];
  const endOffset = offsets[closeIndex];
  const rawBlock = text.slice(startOffset, endOffset);

  return {
    rawBlock,
    lines: splitLines(rawBlock),
    startLine: openIndex + 2,
    endLine: closeIndex,
    fenceStartOffset: offsets[openIndex],
    fenceEndOffset: offsets[closeIndex + 1] ?? text.length,
  };
}

function parseFirstLine(line, level) {
  const prefixLength = level === 2 ? 2 : 0;
  const body = line.slice(prefixLength);
  const match = body.match(/^(.+?)( {2,})(.*)$/);
  return {
    key: match ? match[1] : body,
    firstLineRest: match ? match[3] : '',
    firstLineBody: body,
  };
}

function commonContinuationIndent(lines) {
  let min = Infinity;
  for (const line of lines) {
    if (/^\s*$/.test(line)) continue;
    const match = line.match(/^ */);
    min = Math.min(min, match ? match[0].length : 0);
  }
  return Number.isFinite(min) ? ' '.repeat(min) : '';
}

function finalizeEntry(entry, index) {
  const continuation = entry.lines.slice(1);
  const text = `${entry.lines.join('\n')}\n`;
  return {
    ...entry,
    index,
    indent: commonContinuationIndent(continuation),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function parseEntries(blockLines) {
  const entries = [];
  let current = null;

  for (let index = 0; index < blockLines.length; index++) {
    const line = blockLines[index];
    let level = 0;
    if (/^[^\s]/.test(line)) level = 1;
    else if (/^ {2}\S/.test(line)) level = 2;

    if (level > 0) {
      if (current) entries.push(finalizeEntry(current, entries.length));
      const parsed = parseFirstLine(line, level);
      current = {
        level,
        key: parsed.key,
        firstLineRest: parsed.firstLineRest,
        firstLineBody: parsed.firstLineBody,
        lines: [line],
      };
      continue;
    }

    if (/^\s*$/.test(line) || /^ {3,}/.test(line)) {
      if (!current) throw new Error(`Línea de continuación sin entrada previa en el bloque: ${index + 1}`);
      current.lines.push(line);
      continue;
    }

    throw new Error(`Línea no reconocida en el bloque: ${index + 1}: ${line}`);
  }

  if (current) entries.push(finalizeEntry(current, entries.length));
  return entries.map((entry) => ({ ...entry, dest: routeEntry(entry) }));
}

function routeEntry(entry) {
  for (const route of ROUTES) {
    if (!route.test(entry)) continue;
    if (route.dest.includes('$1')) {
      const match = entry.key.match(/^([a-z-]+)\/$/);
      return route.dest.replace('$1', match ? match[1] : '');
    }
    return route.dest;
  }
  return '__ROOT__';
}

function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.dest)) {
      groups.set(entry.dest, { dest: entry.dest, entries: [], bytes: 0, lines: 0 });
    }
    const group = groups.get(entry.dest);
    group.entries.push(entry);
    group.bytes += entry.bytes;
    group.lines += entry.lines.length;
  }
  return [...groups.values()];
}

function renderEntry(entry) {
  const rendered = [`### ${entry.firstLineBody}`];
  for (const line of entry.lines.slice(1)) {
    if (/^\s*$/.test(line)) {
      rendered.push('');
    } else {
      rendered.push(line.slice(entry.indent.length));
    }
  }
  return rendered.join('\n');
}

function fichaHeader(dest) {
  const folder = path.dirname(dest).replaceAll(path.sep, '/');
  return [
    '<!-- cwc:ficha-modulo -->',
    `# ${folder} — ficha del proyecto`,
    '',
    '> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.',
    '',
  ].join('\n');
}

function manifestFor(sourceText, block, entries) {
  return {
    generatedAt: new Date().toISOString(),
    sourceBytes: Buffer.byteLength(sourceText, 'utf8'),
    block: {
      startLine: block.startLine,
      endLine: block.endLine,
    },
    entries: entries.map((entry) => ({
      key: entry.key,
      level: entry.level,
      dest: entry.dest,
      lines: entry.lines.length,
      bytes: entry.bytes,
      indent: entry.indent,
    })),
  };
}

function printDryRun(groups, entries) {
  let totalBytes = 0;
  let totalLines = 0;
  console.log('destino | entradas | bytes | líneas');
  console.log('--- | ---: | ---: | ---:');
  for (const group of groups) {
    totalBytes += group.bytes;
    totalLines += group.lines;
    console.log(`${group.dest} | ${group.entries.length} | ${group.bytes} | ${group.lines}`);
  }
  console.log(`TOTAL | ${entries.length} | ${totalBytes} | ${totalLines}`);

  const rootEntries = entries.filter((entry) => entry.dest === '__ROOT__');
  console.log('');
  console.log('Entradas catch-all (__ROOT__):');
  if (rootEntries.length === 0) {
    console.log('- ninguna');
  } else {
    for (const entry of rootEntries) console.log(`- ${entry.key}`);
  }
}

function applySplit(sourceText, block, entries) {
  const groups = groupEntries(entries).filter((group) => group.dest !== '__ROOT__');
  for (const group of groups) {
    const target = path.join(REPO_ROOT, group.dest);
    const content = `${fichaHeader(group.dest)}${group.entries.map(renderEntry).join('\n')}\n`;
    writeFileAtomic(target, content, { mode: 0o644 });
  }
  writeFileAtomic(MANIFEST_FILE, `${JSON.stringify(manifestFor(sourceText, block, entries), null, 2)}\n`, { mode: 0o644 });
  console.log(`Generadas ${groups.length} fichas y .cwc-split-manifest.json.`);
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) throw new Error('No existe .cwc-split-manifest.json; corré --apply primero.');
  return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
}

function fileLinesWithoutFinalNewline(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

function buildFichaReaders(manifest) {
  const readers = new Map();
  for (const entry of manifest.entries) {
    if (entry.dest === '__ROOT__' || readers.has(entry.dest)) continue;
    const file = path.join(REPO_ROOT, entry.dest);
    const lines = fileLinesWithoutFinalNewline(file);
    const firstHeading = lines.findIndex((line) => line.startsWith('### '));
    if (firstHeading === -1) throw new Error(`La ficha no tiene entradas: ${entry.dest}`);
    readers.set(entry.dest, { lines, cursor: firstHeading });
  }
  return readers;
}

function reconstructEntryFromFicha(manifestEntry, readers) {
  const reader = readers.get(manifestEntry.dest);
  if (!reader) throw new Error(`No hay ficha cargada para ${manifestEntry.dest}`);

  const heading = reader.lines[reader.cursor];
  if (!heading || !heading.startsWith('### ')) {
    throw new Error(`Esperaba encabezado de entrada en ${manifestEntry.dest}, línea ${reader.cursor + 1}`);
  }
  reader.cursor += 1;

  const original = [`${manifestEntry.level === 2 ? '  ' : ''}${heading.slice(4)}`];
  for (let i = 1; i < manifestEntry.lines; i++) {
    const line = reader.lines[reader.cursor];
    if (line === undefined) throw new Error(`La ficha ${manifestEntry.dest} terminó antes de reconstruir ${manifestEntry.key}`);
    original.push(line === '' ? '' : `${manifestEntry.indent}${line}`);
    reader.cursor += 1;
  }
  return original;
}

function firstDiffIndex(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : limit;
}

function contextAround(text, index) {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + 120);
  return text.slice(start, end);
}

function verifySplit(sourceText, block) {
  const manifest = readManifest();
  const currentEntries = parseEntries(block.lines);
  if (manifest.entries.length !== currentEntries.length) {
    throw new Error(`El manifest tiene ${manifest.entries.length} entradas, pero CLAUDE.md tiene ${currentEntries.length}.`);
  }

  const readers = buildFichaReaders(manifest);
  const reconstructedLines = [];
  for (let index = 0; index < manifest.entries.length; index++) {
    const manifestEntry = manifest.entries[index];
    const currentEntry = currentEntries[index];
    if (manifestEntry.key !== currentEntry.key || manifestEntry.level !== currentEntry.level || manifestEntry.dest !== currentEntry.dest) {
      throw new Error(`El manifest no coincide con CLAUDE.md en la entrada ${index + 1}: ${manifestEntry.key} / ${currentEntry.key}`);
    }
    const lines = manifestEntry.dest === '__ROOT__'
      ? currentEntry.lines
      : reconstructEntryFromFicha(manifestEntry, readers);
    reconstructedLines.push(...lines);
  }

  for (const [dest, reader] of readers.entries()) {
    if (reader.cursor !== reader.lines.length) {
      throw new Error(`La ficha ${dest} tiene contenido extra desde la línea ${reader.cursor + 1}.`);
    }
  }

  const reconstructed = `${reconstructedLines.join('\n')}${block.rawBlock.endsWith('\n') ? '\n' : ''}`;
  if (reconstructed === block.rawBlock) {
    console.log('OK');
    return;
  }

  const charOffset = firstDiffIndex(block.rawBlock, reconstructed);
  const byteOffset = Buffer.byteLength(block.rawBlock.slice(0, charOffset), 'utf8');
  console.log(`FAIL primer offset distinto: ${byteOffset}`);
  console.log('CLAUDE.md:');
  console.log(contextAround(block.rawBlock, charOffset));
  console.log('reconstruido:');
  console.log(contextAround(reconstructed, charOffset));
  process.exitCode = 1;
}

function rewriteRootMap(replacementFile) {
  if (!replacementFile) throw new Error('Uso: --rewrite-root <archivo>');

  const sourceText = fs.readFileSync(SOURCE_FILE, 'utf8');
  const replacementText = fs.readFileSync(path.resolve(replacementFile), 'utf8');
  const block = findProjectMapBlock(sourceText);
  const nextText = `${sourceText.slice(0, block.fenceStartOffset)}${replacementText}${sourceText.slice(block.fenceEndOffset)}`;
  const beforeBytes = Buffer.byteLength(sourceText, 'utf8');
  const afterBytes = Buffer.byteLength(nextText, 'utf8');
  const diff = afterBytes - beforeBytes;

  writeFileAtomic('/tmp/CLAUDE.md.pre-rewrite', sourceText, { mode: 0o644 });
  writeFileAtomic(SOURCE_FILE, nextText, { mode: 0o644 });
  console.log(`${beforeBytes} → ${afterBytes} (${diff >= 0 ? '+' : ''}${diff})`);
}

function main() {
  const apply = process.argv.includes('--apply');
  const verify = process.argv.includes('--verify');
  const rewriteRootIndex = process.argv.indexOf('--rewrite-root');
  const rewriteRoot = rewriteRootIndex !== -1;
  if ([apply, verify, rewriteRoot].filter(Boolean).length > 1) throw new Error('Usá solo uno de --apply, --verify o --rewrite-root.');

  if (rewriteRoot) {
    rewriteRootMap(process.argv[rewriteRootIndex + 1]);
    return;
  }

  const sourceText = fs.readFileSync(SOURCE_FILE, 'utf8');
  const block = findProjectMapBlock(sourceText);
  const entries = parseEntries(block.lines);

  if (verify) {
    verifySplit(sourceText, block);
    return;
  }
  if (apply) {
    applySplit(sourceText, block, entries);
    return;
  }
  printDryRun(groupEntries(entries), entries);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
