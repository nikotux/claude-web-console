#!/usr/bin/env node
// bin/cwc-move-sections.js — mueve secciones/gotchas de CLAUDE.md a fichas locales.
//
// Uso:
//   node bin/cwc-move-sections.js          → dry-run, no escribe nada
//   node bin/cwc-move-sections.js --apply  → aplica movimientos + backup en /tmp
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../src/core/atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_FILE = path.join(REPO_ROOT, 'CLAUDE.md');
const BACKUP_FILE = '/tmp/CLAUDE.md.pre-move';

// Secciones completas que se MUEVEN a una ficha (se cortan de CLAUDE.md y se
// apendean al destino; en la raíz queda lo que diga replacementFile).
const SECTION_MOVES = [
  { title: 'Verificación de salud', dest: 'src/modules/health/CLAUDE.md' },
  { title: 'Módulo VIVO `tickets/` — Contexto adicional + Histórico del trabajo (2026-07-07)', dest: 'src/modules/tickets/CLAUDE.md' },
  { title: 'Multi-tenant (multiusuario en una consola)', dest: 'src/core/CLAUDE.md' },
  { title: 'NO MODIFICAR (generado o estado de runtime)', dest: null },
];

// Gotchas (bullets de la sección "## Gotchas conocidos") que se mueven.
// El match es por PREFIJO del texto del bullet, tras el "- ".
const GOTCHA_MOVES = [
  ['`renderMarkdown()` (public/js/ui/markdown.js) DEVUELVE', 'public/js/ui/CLAUDE.md'],
  ['En `Session` (terminal/sessions.js) la propiedad', 'src/modules/terminal/CLAUDE.md'],
  ['**MCP de Pad (getpad.dev) disponible en Consola**', 'src/core/CLAUDE.md'],
  ['**SEGUNDA vía a Pad: cliente MCP del BACKEND**', 'src/modules/tickets/CLAUDE.md'],
  ['**Programa "Modularización Consola" trackeado en Pad**', 'src/core/CLAUDE.md'],
  ['Traspaso Chat↔TUI', 'src/modules/chat/CLAUDE.md'],
  ['`#sidebar` en móvil', 'public/CLAUDE.md'],
  ['Cabecera del sidebar', 'public/CLAUDE.md'],
  ['`#rail-tabs` (chips de pestañas ABIERTAS)', 'public/CLAUDE.md'],
  ['Pac-Man — MOTOR de estados', 'public/js/ui/CLAUDE.md'],
  ['Cambio de pestaña y scroll del chat', 'public/js/modules/CLAUDE.md'],
  ['Burbujas del chat en móvil', 'public/js/modules/CLAUDE.md'],
  ['`.dlg-overlay` (ui/dialog.js) NECESITA', 'public/js/ui/CLAUDE.md'],
  ['`.dlg-card` usa `max-height: 88dvh`', 'public/js/ui/CLAUDE.md'],
  ['Módulo tokens: los TOKENS son exactos', 'src/modules/tokens/CLAUDE.md'],
  ['Splash de arranque', 'public/CLAUDE.md'],
  ['LAZY-CONNECT de conversaciones en el arranque', 'public/js/modules/CLAUDE.md'],
  ['Entornos Tolkien por sesión (PLAN-1815)', 'src/modules/tolkien/CLAUDE.md'],
  ['Etiqueta de modelo: hay DOS funciones', 'public/js/ui/CLAUDE.md'],
];

function cleanLine(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function lineStartOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function readReplacementFile(title) {
  const slug = replacementSlug(title);
  const file = `/tmp/reemplazo-${slug}.md`;
  return fs.readFileSync(file, 'utf8');
}

function replacementSlug(title) {
  if (title === 'Verificación de salud') return 'salud';
  if (title === 'Módulo VIVO `tickets/` — Contexto adicional + Histórico del trabajo (2026-07-07)') return 'tickets';
  if (title === 'Multi-tenant (multiusuario en una consola)') return 'multitenant';
  if (title === 'NO MODIFICAR (generado o estado de runtime)') return 'nomodificar';
  throw new Error(`No hay slug de reemplazo para la sección: ${title}`);
}

function trimTrailingBlankLines(lines, endLine, minLine) {
  let nextEnd = endLine;
  while (nextEnd > minLine && cleanLine(lines[nextEnd - 1]) === '') nextEnd--;
  return nextEnd;
}

function sectionContentEndLine(lines, nextSectionLine, minLine) {
  let nextEnd = trimTrailingBlankLines(lines, nextSectionLine, minLine);
  while (nextEnd > minLine && cleanLine(lines[nextEnd - 1]) === '<!-- cwc:mejora-continua:start -->') {
    nextEnd = trimTrailingBlankLines(lines, nextEnd - 1, minLine);
  }
  return nextEnd;
}

function findSectionMove(sourceText, lines, offsets, move) {
  const needle = `## ${move.title}`;
  const matches = [];
  for (let index = 0; index < lines.length; index++) {
    if (cleanLine(lines[index]) === needle) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`La sección "${move.title}" matcheó ${matches.length}; esperaba exactamente 1.`);
  }

  const startLine = matches[0];
  let nextSectionLine = lines.length;
  for (let index = startLine + 1; index < lines.length; index++) {
    if (/^## /.test(cleanLine(lines[index]))) {
      nextSectionLine = index;
      break;
    }
  }

  const contentEndLine = sectionContentEndLine(lines, nextSectionLine, startLine + 1);
  const start = offsets[startLine];
  const end = offsets[contentEndLine] ?? sourceText.length;
  return {
    kind: 'section',
    label: move.title,
    dest: move.dest,
    start,
    end,
    text: sourceText.slice(start, end),
    replacement: readReplacementFile(move.title),
  };
}

function findGotchaSection(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^## Gotchas conocidos/.test(cleanLine(lines[index]))) starts.push(index);
  }
  if (starts.length !== 1) {
    throw new Error(`La sección "## Gotchas conocidos" matcheó ${starts.length}; esperaba exactamente 1.`);
  }

  let endLine = lines.length;
  for (let index = starts[0] + 1; index < lines.length; index++) {
    if (/^## /.test(cleanLine(lines[index]))) {
      endLine = index;
      break;
    }
  }
  return { startLine: starts[0], endLine };
}

function findGotchaMove(sourceText, lines, offsets, gotchaSection, prefix, dest) {
  const bulletStarts = [];
  for (let index = gotchaSection.startLine + 1; index < gotchaSection.endLine; index++) {
    if (/^- /.test(cleanLine(lines[index]))) bulletStarts.push(index);
  }

  const matches = bulletStarts.filter((lineIndex) => cleanLine(lines[lineIndex]).slice(2).startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`El gotcha con prefijo "${prefix}" matcheó ${matches.length}; esperaba exactamente 1.`);
  }

  const startLine = matches[0];
  const bulletIndex = bulletStarts.indexOf(startLine);
  const rawEndLine = bulletStarts[bulletIndex + 1] ?? gotchaSection.endLine;
  const contentEndLine = trimTrailingBlankLines(lines, rawEndLine, startLine + 1);
  const start = offsets[startLine];
  const end = offsets[contentEndLine] ?? sourceText.length;
  return {
    kind: 'gotcha',
    label: prefix,
    dest,
    start,
    end,
    text: sourceText.slice(start, end),
    replacement: '',
  };
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

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function appendBlocks(baseText, blocks) {
  let nextText = ensureTrailingNewline(baseText);
  for (const block of blocks) {
    nextText = `${nextText.trimEnd()}\n\n${ensureTrailingNewline(block.text)}`;
  }
  return nextText;
}

function appendGotchas(baseText, blocks) {
  let nextText = ensureTrailingNewline(baseText);
  if (!/^## Gotchas de esta carpeta$/m.test(nextText)) {
    nextText = `${nextText.trimEnd()}\n\n## Gotchas de esta carpeta\n`;
  }
  for (const block of blocks) {
    nextText = `${nextText.trimEnd()}\n\n${ensureTrailingNewline(block.text)}`;
  }
  return nextText;
}

function applyEdits(sourceText, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let lastStart = sourceText.length + 1;
  let nextText = sourceText;
  for (const edit of sorted) {
    if (edit.end > lastStart) {
      throw new Error(`Rangos superpuestos al aplicar: ${edit.label}`);
    }
    nextText = `${nextText.slice(0, edit.start)}${edit.replacement}${nextText.slice(edit.end)}`;
    lastStart = edit.start;
  }
  return nextText;
}

function planMoves(sourceText) {
  const lines = sourceText.split('\n');
  const offsets = lineStartOffsets(sourceText);
  const sectionBlocks = SECTION_MOVES.map((move) => findSectionMove(sourceText, lines, offsets, move));
  const gotchaSection = findGotchaSection(lines);
  const gotchaBlocks = GOTCHA_MOVES.map(([prefix, dest]) => findGotchaMove(sourceText, lines, offsets, gotchaSection, prefix, dest));
  return { sectionBlocks, gotchaBlocks, allBlocks: [...sectionBlocks, ...gotchaBlocks] };
}

function groupByDest(blocks) {
  const groups = new Map();
  for (const block of blocks) {
    if (!block.dest) continue;
    if (!groups.has(block.dest)) groups.set(block.dest, []);
    groups.get(block.dest).push(block);
  }
  return groups;
}

function nextFichaText(dest, blocks) {
  const target = path.join(REPO_ROOT, dest);
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : fichaHeader(dest);
  const sections = blocks.filter((block) => block.kind === 'section');
  const gotchas = blocks.filter((block) => block.kind === 'gotcha');
  let nextText = appendBlocks(original, sections);
  if (gotchas.length > 0) nextText = appendGotchas(nextText, gotchas);
  return nextText;
}

function printDryRun(sourceText, nextRootText, blocks) {
  let removedBytes = 0;
  let appendedBytes = 0;
  console.log('tipo | origen | destino | bytes');
  console.log('--- | --- | --- | ---:');
  for (const block of blocks) {
    const bytes = Buffer.byteLength(block.text, 'utf8');
    removedBytes += bytes;
    if (block.dest) appendedBytes += bytes;
    console.log(`${block.kind} | ${block.label} | ${block.dest ?? '(solo reemplazo en raíz)'} | ${bytes}`);
  }
  console.log(`TOTAL | ${blocks.length} movimientos | removidos de raíz: ${removedBytes} | apendeados a fichas: ${appendedBytes}`);
  const beforeBytes = Buffer.byteLength(sourceText, 'utf8');
  const afterBytes = Buffer.byteLength(nextRootText, 'utf8');
  console.log(`CLAUDE.md | bytes | ${beforeBytes} → ${afterBytes} | ${afterBytes - beforeBytes}`);
}

function applyMoves(sourceText, nextRootText, blocks) {
  writeFileAtomic(BACKUP_FILE, sourceText, { mode: 0o644 });
  for (const [dest, destBlocks] of groupByDest(blocks).entries()) {
    writeFileAtomic(path.join(REPO_ROOT, dest), nextFichaText(dest, destBlocks), { mode: 0o644 });
  }
  writeFileAtomic(SOURCE_FILE, nextRootText, { mode: 0o644 });
  const beforeBytes = Buffer.byteLength(sourceText, 'utf8');
  const afterBytes = Buffer.byteLength(nextRootText, 'utf8');
  console.log(`CLAUDE.md: ${beforeBytes} → ${afterBytes}`);
}

function main() {
  const apply = process.argv.includes('--apply');
  const unknownFlags = process.argv.slice(2).filter((arg) => arg !== '--apply');
  if (unknownFlags.length > 0) throw new Error(`Flags no soportados: ${unknownFlags.join(' ')}`);

  const sourceText = fs.readFileSync(SOURCE_FILE, 'utf8');
  const { allBlocks } = planMoves(sourceText);
  const nextRootText = applyEdits(sourceText, allBlocks);
  if (apply) {
    applyMoves(sourceText, nextRootText, allBlocks);
    return;
  }
  printDryRun(sourceText, nextRootText, allBlocks);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
