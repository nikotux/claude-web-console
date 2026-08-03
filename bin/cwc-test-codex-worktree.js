#!/usr/bin/env node
// Test funcional, determinista y aislado del worktree de delegaciones Codex.
// No toca ~/.cwc-data ni usa SDK/red/tokens. Uso: node bin/cwc-test-codex-worktree.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-codex-worktree-'));
const repo = path.join(testRoot, 'toy-repo');
const dataDir = path.join(testRoot, '.cwc-data');
let activeWorktree = null;
let removeDelegationWorktree = null;

process.env.CWC_DATA_DIR = dataDir;
process.env.HOME = testRoot;

const git = (cwd, args, { input = null } = {}) => {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} falló: ${result.error?.message || result.stderr.trim() || `código ${result.status}`}`,
    );
  }
  return result.stdout;
};

const worktreeCount = () => (
  git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .length
);

const readRepoState = () => ({
  gitignore: fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'),
  a: fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'),
  b: fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'),
  seeded: fs.readFileSync(path.join(repo, 'seeded-untracked.txt'), 'utf8'),
  created: fs.readFileSync(path.join(repo, 'created-by-codex.txt'), 'utf8'),
});

try {
  const worktree = await import('../src/modules/chat/codex-shared.js');
  const {
    createDelegationWorktree,
    seedWorktree,
    applyDeclaredBack,
  } = worktree;
  removeDelegationWorktree = worktree.removeDelegationWorktree;

  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'test@cwc.local']);
  git(repo, ['config', 'user.name', 'cwc-test']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a desde HEAD\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b desde HEAD\n');
  fs.writeFileSync(path.join(repo, 'three-way.txt'), 'cabecera desde HEAD original\nseparador estable\nobjetivo desde HEAD\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'fixture', 'index.js'), 'export default 1;\n');
  git(repo, ['add', '.gitignore', 'a.txt', 'b.txt', 'three-way.txt']);
  git(repo, ['commit', '--quiet', '-m', 'commit inicial']);

  console.log('\nT1 · CREACIÓN Y LIMPIEZA');
  const first = await createDelegationWorktree(repo, 'test-create-remove');
  activeWorktree = first.path;
  eq('T1.a createDelegationWorktree crea el directorio', fs.existsSync(first.path), true);
  eq('T1.b el worktree es un repositorio usable', git(first.path, ['rev-parse', '--is-inside-work-tree']).trim(), 'true');
  eq('T1.c el repo de juguete sí tiene node_modules ignorado', fs.existsSync(path.join(repo, 'node_modules')), true);
  eq('T1.d el worktree nace sin node_modules', fs.existsSync(path.join(first.path, 'node_modules')), false);
  eq('T1.e git worktree list tiene dos entradas', worktreeCount(), 2);
  await removeDelegationWorktree(repo, first.path);
  activeWorktree = null;
  eq('T1.f removeDelegationWorktree borra el directorio', fs.existsSync(first.path), false);
  eq('T1.g git worktree list vuelve a una entrada', worktreeCount(), 1);

  fs.writeFileSync(path.join(repo, 'a.txt'), 'a sucio del repo real\n');
  fs.writeFileSync(path.join(repo, 'seeded-untracked.txt'), 'untracked sembrado\n');
  const delegated = await createDelegationWorktree(repo, 'test-seed-apply');
  activeWorktree = delegated.path;

  console.log('\nT2 · SIEMBRA DE TRACKEADOS');
  const seeded = await seedWorktree(delegated.path, repo);
  eq('T2.a seedWorktree termina correctamente', seeded, { ok: true });
  eq(
    'T2.b el trackeado sembrado contiene la versión sucia, no HEAD',
    fs.readFileSync(path.join(delegated.path, 'a.txt'), 'utf8'),
    'a sucio del repo real\n',
  );

  console.log('\nT3 · SIEMBRA DE UNTRACKED');
  eq('T3.a el archivo untracked existe en el worktree', fs.existsSync(path.join(delegated.path, 'seeded-untracked.txt')), true);
  eq(
    'T3.b el archivo untracked conserva el contenido exacto',
    fs.readFileSync(path.join(delegated.path, 'seeded-untracked.txt'), 'utf8'),
    'untracked sembrado\n',
  );

  console.log('\nT4 · BASE FIJADA');
  eq('T4.a git diff HEAD queda vacío después de sembrar', git(delegated.path, ['diff', 'HEAD']), '');

  console.log('\nT5 · SOLO VUELVE LO DECLARADO');
  const bBefore = fs.readFileSync(path.join(repo, 'b.txt'), 'utf8');
  fs.writeFileSync(path.join(delegated.path, 'a.txt'), 'a cambiada por Codex\n');
  fs.writeFileSync(path.join(delegated.path, 'b.txt'), 'b cambiada por Codex pero no declarada\n');
  const selective = await applyDeclaredBack(delegated.path, repo, ['a.txt']);
  eq('T5.a applyDeclaredBack informa solo a.txt', selective, { ok: true, applied: ['a.txt'] });
  eq('T5.b a.txt declarado vuelve al repo real', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'a cambiada por Codex\n');
  eq('T5.c b.txt no declarado queda exactamente igual', fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), bBefore);

  console.log('\nT6 · ARCHIVO NUEVO DECLARADO');
  fs.writeFileSync(path.join(delegated.path, 'created-by-codex.txt'), 'archivo nuevo de Codex\n');
  const created = await applyDeclaredBack(delegated.path, repo, ['created-by-codex.txt']);
  eq('T6.a applyDeclaredBack informa el archivo nuevo', created, { ok: true, applied: ['created-by-codex.txt'] });
  eq('T6.b el archivo nuevo declarado llega al repo real', fs.readFileSync(path.join(repo, 'created-by-codex.txt'), 'utf8'), 'archivo nuevo de Codex\n');

  console.log('\nT7 · CONFLICTO DETECTADO, NO PISADO');
  fs.writeFileSync(path.join(delegated.path, 'a.txt'), 'cambio incompatible de Codex\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'cambio incompatible del repo real\n');
  const conflict = await applyDeclaredBack(delegated.path, repo, ['a.txt']);
  eq('T7.a applyDeclaredBack reporta conflict=true', conflict.conflict, true);
  const realAfterConflict = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8');
  eq('T7.b a.txt conserva el cambio del repo real', realAfterConflict, 'cambio incompatible del repo real\n');
  ok(
    'T7.c a.txt no contiene marcadores de conflicto',
    !realAfterConflict.includes('<<<<<<<')
      && !realAfterConflict.includes('=======')
      && !realAfterConflict.includes('>>>>>>>'),
    realAfterConflict,
  );

  console.log('\nT8 · PARCHE VACÍO');
  const beforeEmptyApply = readRepoState();
  const empty = await applyDeclaredBack(delegated.path, repo, ['.gitignore']);
  eq('T8.a applyDeclaredBack devuelve empty=true', empty.empty, true);
  eq('T8.b el parche vacío no escribe nada', readRepoState(), beforeEmptyApply);

  await removeDelegationWorktree(repo, delegated.path);
  activeWorktree = null;
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'fija el estado previo a la prueba de tres vías']);

  console.log('\nT9 · SIEMBRA CON MERGE DE TRES VÍAS');
  const threeWayWorktree = await createDelegationWorktree(repo, 'test-seed-three-way');
  activeWorktree = threeWayWorktree.path;
  fs.writeFileSync(path.join(repo, 'three-way.txt'), 'cabecera desde HEAD nuevo\nseparador estable\nobjetivo desde HEAD\n');
  git(repo, ['add', 'three-way.txt']);
  git(repo, ['commit', '--quiet', '-m', 'avanza la base para probar tres vías']);
  fs.writeFileSync(path.join(repo, 'three-way.txt'), 'cabecera desde HEAD nuevo\nseparador estable\nobjetivo sucio\n');
  const threeWayPatch = git(repo, ['diff', 'HEAD']);
  const threeWayPatchPath = path.join(testRoot, 'three-way.patch');
  fs.writeFileSync(threeWayPatchPath, threeWayPatch);
  const directCheck = spawnSync('git', ['-C', threeWayWorktree.path, 'apply', '--check', threeWayPatchPath], {
    encoding: 'utf8',
  });
  ok(
    'T9.a el parche directo no aplica sobre la base vieja',
    directCheck.status !== 0,
    { status: directCheck.status, stderr: directCheck.stderr },
  );
  const seededThreeWay = await seedWorktree(threeWayWorktree.path, repo);
  eq('T9.b seedWorktree reintenta con tres vías y termina correctamente', seededThreeWay, { ok: true });
  eq(
    'T9.c el merge conserva la base del worktree y suma el cambio sucio',
    fs.readFileSync(path.join(threeWayWorktree.path, 'three-way.txt'), 'utf8'),
    'cabecera desde HEAD original\nseparador estable\nobjetivo sucio\n',
  );

  ok(
    'AISLAMIENTO · repo, datos y worktree están dentro del temporal',
    repo.startsWith(`${testRoot}${path.sep}`)
      && dataDir.startsWith(`${testRoot}${path.sep}`)
      && delegated.path.startsWith(`${testRoot}${path.sep}`),
    { testRoot, repo, dataDir, worktree: delegated.path },
  );
} catch (error) {
  fail++;
  console.log(`❌ ejecución completa sin excepciones\n   detalle: ${error?.stack || error}`);
} finally {
  if (activeWorktree && removeDelegationWorktree && fs.existsSync(repo)) {
    try { await removeDelegationWorktree(repo, activeWorktree); } catch { /* best-effort */ }
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
  eq('LIMPIEZA · el directorio temporal fue borrado', fs.existsSync(testRoot), false);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} codex-worktree: ${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
