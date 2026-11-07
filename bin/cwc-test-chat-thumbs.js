#!/usr/bin/env node
// Test funcional, determinista y aislado de miniaturas + replay de imágenes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspect, isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';

let pass = 0;
let fail = 0;
const fmt = (value) => inspect(value, { depth: null, sorted: true, breakLength: 120 });
const ok = (name, condition, detail = null) => {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail === null ? '' : `\n   detalle: ${fmt(detail)}`}`);
  }
};
const eq = (name, got, expected) => {
  if (isDeepStrictEqual(got, expected)) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}\n   esperado: ${fmt(expected)}\n   obtenido: ${fmt(got)}`);
  }
};

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-thumbs-test-'));
process.env.CWC_HOME = testRoot;
process.env.HOME = testRoot;
process.env.CWC_DATA_DIR = path.join(testRoot, '.cwc-data');
process.env.CWC_HOST_USER = 'thumb-host';
delete process.env.CWC_CHAT_THUMBS;

const attachmentsRoot = path.join(process.env.CWC_DATA_DIR, 'chat-attachments');
const chatDir = path.join(attachmentsRoot, 'ctest-thumbs');
const queueDir = path.join(attachmentsRoot, 'ctest-queue');
const cacheDir = path.join(attachmentsRoot, 'ctest-cache');
fs.mkdirSync(chatDir, { recursive: true });
fs.mkdirSync(queueDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

try {
  const replay = await import('../src/modules/chat/replay-images.js');
  const thumbs = await import('../src/modules/chat/thumbs.js');

  console.log('\nT1 · HUELLA BASE64');
  for (const size of [3, 2, 1]) {
    const buf = Buffer.alloc(size, size + 20);
    eq(`T1 tamaño con ${size === 3 ? 0 : 3 - size} padding`, replay.imageFingerprint(buf.toString('base64'))?.size, size);
  }
  eq('T1 base64 inválido devuelve null', replay.imageFingerprint('%%%='), null);
  const sampleSource = Buffer.from(Array.from({ length: 200 }, (_, i) => i));
  const fpSamples = replay.imageFingerprint(sampleSource.toString('base64'));
  ok('T1 genera tres ventanas distintas', fpSamples.samples.length === 3, fpSamples);
  for (const sample of fpSamples.samples) {
    eq(`T1 muestra exacta en offset ${sample.offset}`, sample.bytes, sampleSource.subarray(sample.offset, sample.offset + 48));
  }

  console.log('\nT2 · REPLAY DE ARCHIVOS');
  const noise = crypto.randomBytes(800 * 600 * 3);
  const bigPath = path.join(chatDir, 'usuario.png');
  await sharp(noise, { raw: { width: 800, height: 600, channels: 3 } }).png().toFile(bigPath);
  const bigBuf = fs.readFileSync(bigPath);
  ok('T2 imagen de prueba supera 60 KB', bigBuf.length > 60 * 1024, bigBuf.length);
  const userFp = replay.imageFingerprint(bigBuf.toString('base64'));
  let resolved = replay.resolveReplayFiles('ctest-thumbs', [{ fp: userFp, kind: 'image', base64Getter: () => bigBuf.toString('base64') }]);
  eq('T2 imagen de usuario recupera nombre y mime', resolved[0], { name: 'usuario.png', mime: 'image/png' });

  const toolName = 'asst-tool_1-1.png';
  fs.copyFileSync(bigPath, path.join(chatDir, toolName));
  replay._clearReplayCache();
  resolved = replay.resolveReplayFiles('ctest-thumbs', [{ fp: userFp, kind: 'image', prefix: replay.toolImagePrefix('tool_1') }]);
  eq('T2 imagen de herramienta prioriza prefijo asst', resolved[0], { name: toolName, mime: 'image/png' });

  const deleted = Buffer.alloc(111, 7);
  const deletedPath = path.join(chatDir, 'borrada.png');
  fs.writeFileSync(deletedPath, deleted);
  const deletedFp = replay.imageFingerprint(deleted.toString('base64'));
  fs.unlinkSync(deletedPath);
  replay._clearReplayCache();
  eq('T2 archivo borrado queda sin match', replay.resolveReplayFiles('ctest-thumbs', [{ fp: deletedFp, kind: 'image' }])[0], null);

  const sameA = Buffer.alloc(256, 11);
  const sameB = Buffer.alloc(256, 22);
  fs.writeFileSync(path.join(chatDir, 'mismo-a.png'), sameA);
  fs.writeFileSync(path.join(chatDir, 'mismo-b.png'), sameB);
  replay._clearReplayCache();
  resolved = replay.resolveReplayFiles('ctest-thumbs', [{
    fp: replay.imageFingerprint(sameB.toString('base64')),
    kind: 'image',
    base64Getter: () => sameB.toString('base64'),
  }]);
  eq('T2 distingue dos archivos del mismo tamaño', resolved[0]?.name, 'mismo-b.png');
  eq('T2 chatId null devuelve null alineado', replay.resolveReplayFiles(null, [{ fp: userFp, kind: 'image' }]), [null]);
  eq('T2 chatId inválido devuelve null alineado', replay.resolveReplayFiles('../mal', [{ fp: userFp, kind: 'image' }]), [null]);

  const late = Buffer.alloc(333, 44);
  const lateItem = { fp: replay.imageFingerprint(late.toString('base64')), kind: 'image' };
  eq('T2 cache inicial sin archivo', replay.resolveReplayFiles('ctest-cache', [lateItem]), [null]);
  fs.writeFileSync(path.join(cacheDir, 'tardia.png'), late);
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(cacheDir, future, future);
  eq('T2 cache invalida al cambiar mtime del directorio', replay.resolveReplayFiles('ctest-cache', [lateItem])[0]?.name, 'tardia.png');

  console.log('\nT3 · GENERACIÓN Y COLA');
  const tinyPath = path.join(chatDir, 'pequena.png');
  const gifPath = path.join(chatDir, 'animada.gif');
  const webpPath = path.join(chatDir, 'grande.webp');
  const jpgPath = path.join(chatDir, 'grande.jpg');
  await sharp({ create: { width: 10, height: 10, channels: 3, background: '#336699' } }).png().toFile(tinyPath);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#993366' } }).gif().toFile(gifPath);
  await sharp(noise, { raw: { width: 800, height: 600, channels: 3 } }).webp({ lossless: true }).toFile(webpPath);
  await sharp(noise, { raw: { width: 800, height: 600, channels: 3 } }).jpeg({ quality: 90 }).toFile(jpgPath);
  ok('T3 webp de prueba supera 60 KB', fs.statSync(webpPath).size > 60 * 1024, fs.statSync(webpPath).size);
  ok('T3 jpg de prueba supera 60 KB', fs.statSync(jpgPath).size > 60 * 1024, fs.statSync(jpgPath).size);
  eq('T3 imagen pequeña usa original', await thumbs.ensureThumb('ctest-thumbs', 'pequena.png'), null);
  eq('T3 gif usa original', await thumbs.ensureThumb('ctest-thumbs', 'animada.gif'), null);
  eq('T3 webp grande usa original', await thumbs.ensureThumb('ctest-thumbs', 'grande.webp'), null);

  const dedupeName = 'dedupe.png';
  fs.copyFileSync(bigPath, path.join(chatDir, dedupeName));
  const dedupePromises = Array.from({ length: 5 }, () => thumbs.ensureThumb('ctest-thumbs', dedupeName));
  ok('T3 cinco pedidos comparten la misma promesa', dedupePromises.every((p) => p === dedupePromises[0]));
  const dedupePaths = await Promise.all(dedupePromises);
  ok('T3 miniatura deduplicada existe', dedupePaths.every((p) => p && p === dedupePaths[0] && fs.existsSync(p)), dedupePaths);
  const dedupeMeta = await sharp(dedupePaths[0]).metadata();
  ok('T3 salida webp y lado máximo 360', dedupeMeta.format === 'webp' && Math.max(dedupeMeta.width, dedupeMeta.height) <= 360, dedupeMeta);
  const firstMtime = fs.statSync(dedupePaths[0]).mtimeMs;
  const cachedPath = await thumbs.ensureThumb('ctest-thumbs', dedupeName);
  eq('T3 segundo pedido usa el mismo path', cachedPath, dedupePaths[0]);
  eq('T3 segundo pedido no reescribe', fs.statSync(cachedPath).mtimeMs, firstMtime);
  const thumbFiles = fs.readdirSync(path.dirname(cachedPath)).filter((name) => name.endsWith('.webp'));
  eq('T3 dedupe produjo un solo archivo', thumbFiles.length, 1);
  const jpgThumb = await thumbs.ensureThumb('ctest-thumbs', 'grande.jpg');
  ok('T3 jpg grande genera miniatura', jpgThumb && fs.existsSync(jpgThumb), jpgThumb);

  const queueNames = [];
  for (let i = 0; i < 10; i += 1) {
    const name = `cola-${i}.png`;
    fs.copyFileSync(bigPath, path.join(queueDir, name));
    queueNames.push(name);
  }
  const queuePromises = queueNames.map((name) => thumbs.ensureThumb('ctest-queue', name));
  const ac = new AbortController();
  fs.copyFileSync(bigPath, path.join(queueDir, 'abortada.png'));
  const abortedPromise = thumbs.ensureThumb('ctest-queue', 'abortada.png', { signal: ac.signal });
  ac.abort();
  let maxRunning = thumbs._queueStats().running;
  const poll = setInterval(() => { maxRunning = Math.max(maxRunning, thumbs._queueStats().running); }, 1);
  const queueResults = await Promise.all(queuePromises);
  const abortedResult = await abortedPromise;
  clearInterval(poll);
  ok('T3 diez miniaturas distintas se generan', queueResults.every((result) => result && fs.existsSync(result)), queueResults);
  eq('T3 request abortada mientras esperaba no trabaja', abortedResult, null);
  ok('T3 nunca ejecuta más de dos trabajos', maxRunning <= 2 && maxRunning === 2, maxRunning);
  eq('T3 cola termina vacía', thumbs._queueStats(), { running: 0, pending: 0, inFlight: 0 });

  process.env.CWC_CHAT_THUMBS = '0';
  eq('T3 switch de emergencia deshabilita', await thumbs.ensureThumb('ctest-thumbs', dedupeName), null);
  delete process.env.CWC_CHAT_THUMBS;

  console.log('\nT4 · CLI DE BACKFILL');
  const backfillHome = path.join(testRoot, 'backfill-home');
  const backfillChat = path.join(backfillHome, '.cwc-data', 'chat-attachments', 'cbackfill');
  const backfillThumbs = path.join(backfillChat, '_thumbs');
  fs.mkdirSync(backfillThumbs, { recursive: true });
  fs.copyFileSync(bigPath, path.join(backfillChat, 'grande.png'));
  const legacyWebp = path.join(backfillChat, 'legado.webp');
  fs.copyFileSync(webpPath, legacyWebp);
  const legacyWebpStat = fs.statSync(legacyWebp);
  const legacyWebpThumb = path.join(backfillThumbs,
    thumbs.thumbNameFor('legado.webp', legacyWebpStat.size, legacyWebpStat.mtimeMs));
  fs.writeFileSync(legacyWebpThumb, 'legacy-webp-thumb');
  const orphan = path.join(backfillThumbs, '00000000000000000000.webp');
  fs.writeFileSync(orphan, 'orphan');
  const cli = path.join(process.cwd(), 'bin', 'cwc-chat-thumbs-backfill.js');
  const cliEnv = { ...process.env, CWC_HOME: backfillHome, CWC_HOST_USER: 'thumb-host' };
  const runCli = (...args) => JSON.parse(execFileSync(process.execPath, [cli, '--json', '--user', 'thumb-host', ...args], {
    cwd: process.cwd(), env: cliEnv, encoding: 'utf8',
  }));
  const dry = runCli();
  eq('T4 dry-run cuenta candidato', dry.total.candidates, 1);
  eq('T4 webp sigue contando como imagen', dry.total.images, 2);
  eq('T4 dry-run no genera', dry.total.generated, 0);
  eq('T4 dry-run reporta ambos huérfanos', dry.total.orphansPruned, 2);
  eq('T4 dry-run no borra huérfano', fs.existsSync(orphan), true);
  eq('T4 dry-run no borra miniatura heredada de webp', fs.existsSync(legacyWebpThumb), true);
  eq('T4 dry-run no crea miniatura', fs.readdirSync(backfillThumbs).length, 2);
  const applied = runCli('--apply');
  eq('T4 apply genera una miniatura', applied.total.generated, 1);
  eq('T4 apply poda el huérfano', fs.existsSync(orphan), false);
  eq('T4 apply poda miniatura heredada de webp', fs.existsSync(legacyWebpThumb), false);
  const second = runCli('--apply');
  eq('T4 segundo apply es idempotente', second.total.generated, 0);
  eq('T4 segundo apply detecta existente', second.total.existing, 1);
} catch (e) {
  fail += 1;
  console.error('❌ excepción no controlada:', e?.stack || e);
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log(`\n${pass} ok · ${fail} fallos`);
if (fail) process.exitCode = 1;
