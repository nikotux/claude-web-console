#!/usr/bin/env node
// Guard ESTÁTICO sobre el código fuente del reaper; NO es una prueba de
// comportamiento en runtime. Uso: node bin/cwc-test-chat-reaper.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';

let pass = 0, fail = 0;
const fmt = (value) => inspect(value, { depth: null, sorted: true, breakLength: 120 });
const ok = (name, condition, detail = null) => {
  if (condition) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail === null ? '' : `\n   detalle: ${fmt(detail)}`}`);
  }
};
const eq = (name, got, expected) => {
  if (isDeepStrictEqual(got, expected)) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   esperado: ${fmt(expected)}\n   obtenido: ${fmt(got)}`);
  }
};

const binDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(binDir, '..');
const srcDir = path.join(projectRoot, 'src');
const indexPath = path.join(srcDir, 'modules', 'chat', 'index.js');
const indexSource = fs.readFileSync(indexPath, 'utf8');
const jsSources = [];

const collectJsSources = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsSources(entryPath);
    else if (entry.isFile() && entry.name.endsWith('.js')) jsSources.push(fs.readFileSync(entryPath, 'utf8'));
  }
};
collectJsSources(srcDir);
const allSrcJs = jsSources.join('\n');
const executableSrcJs = allSrcJs.replace(/^[ \t]*\/\/.*$/gm, '');

const reaperStart = indexSource.indexOf('    setInterval(() => {\n      const now = Date.now();');
const reaperEnd = indexSource.indexOf('    }, 60 * 1000).unref();', reaperStart);
const reaperSource = reaperStart >= 0 && reaperEnd > reaperStart
  ? indexSource.slice(reaperStart, reaperEnd)
  : '';

eq('1. no existe la constante ni ningún uso ejecutable de FORGET_MS en src/', executableSrcJs.includes('FORGET_MS'), false);
ok(
  '2. el bucle del reaper no llama a c.close()',
  reaperSource.length > 0 && !/\bc\.close\s*\(/.test(reaperSource),
  { reaperFound: reaperSource.length > 0 },
);
eq('3. pruneSalas() no se invoca en chat/index.js', indexSource.includes('pruneSalas('), false);
eq('4. salaKeepIdsForPrune no existe en ningún archivo JavaScript de src/', allSrcJs.includes('salaKeepIdsForPrune'), false);
ok(
  '5. siguen las ramas legítimas de sleep y descarte de cerradas',
  indexSource.includes("if (c.viewMode === 'chat' && c.alive && !(c._bgTasks?.length) && now - c.lastActivity > SLEEP_MS) c.sleep();")
    && indexSource.includes('if (c.closed && now - c.lastActivity > SLEEP_MS * 2) { this.chats.delete(id); dirty = true; }'),
);

console.log(`\n${fail === 0 ? '✅' : '❌'} chat-reaper: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
