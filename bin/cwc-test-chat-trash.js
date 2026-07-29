#!/usr/bin/env node
// Test funcional, determinista y aislado de modules/chat/trash.js.
// No toca la papelera real. Uso: node bin/cwc-test-chat-trash.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const DAY_MS = 86400000;
const owner = 'tester';
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-trash-test-'));
const ownerTrashDir = path.join(testRoot, '.cwc-users', owner, '.cwc-data', 'chat-trash');
const indexPath = path.join(ownerTrashDir, 'index.json');
const itemPath = (trashId) => path.join(ownerTrashDir, trashId);
const transcriptCopyPath = (trashId, originalPath) => (
  path.join(itemPath(trashId), 'transcript', path.basename(originalPath))
);

process.env.CWC_HOME = testRoot;
process.env.HOME = testRoot;
process.env.CWC_DATA_DIR = path.join(testRoot, '.cwc-data');
process.env.CWC_HOST_USER = 'cwc-trash-test-host';

const setDeletedAt = (trashId, deletedAt) => {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const item = index.items.find((entry) => entry.trashId === trashId);
  if (!item) throw new Error(`no existe ${trashId} en index.json`);
  item.deletedAt = deletedAt;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

  const metaPath = path.join(itemPath(trashId), 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.deletedAt = deletedAt;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
};

try {
  const {
    trashChat,
    listChatTrash,
    restoreChatTrash,
    purgeChatTrash,
    autoPurgeChatTrash,
    autoPurgeAllChatTrash,
  } = await import('../src/modules/chat/trash.js');

  console.log('\nT1 · COPIA DEL TRANSCRIPT');
  const t1Original = path.join(testRoot, 'sources', 'ctest-1.jsonl');
  const t1Content = '{"type":"user"}\n{"type":"assistant"}\n{"type":"result"}\n';
  fs.mkdirSync(path.dirname(t1Original), { recursive: true });
  fs.writeFileSync(t1Original, t1Content);
  const t1Id = trashChat({
    chatId: 'ctest-1',
    owner,
    title: 'T',
    cwd: '/tmp/x',
    sessionId: 'sid-1',
    transcriptPath: t1Original,
    attachDir: null,
  });
  const t1Copy = transcriptCopyPath(t1Id, t1Original);
  ok('T1.a devuelve un trashId', typeof t1Id === 'string' && t1Id.length > 0, t1Id);
  eq('T1.b la copia existe en transcript/<basename>', fs.existsSync(t1Copy), true);
  eq('T1.c la copia conserva el contenido exacto', fs.readFileSync(t1Copy, 'utf8'), t1Content);
  eq('T1.d el transcript original sigue existiendo', fs.existsSync(t1Original), true);
  eq(
    'T1.e listChatTrash reporta hasTranscript=true',
    listChatTrash(owner).find((entry) => entry.id === t1Id)?.hasTranscript,
    true,
  );

  console.log('\nT2 · REPARACIÓN PEREZOSA');
  const t2Original = path.join(testRoot, 'late-sdk', 'ctest-2.jsonl');
  const t2Content = '{"late":true}\n';
  const t2Id = trashChat({
    chatId: 'ctest-2',
    owner,
    title: 'Late',
    cwd: '/tmp/late',
    sessionId: 'sid-2',
    transcriptPath: t2Original,
    attachDir: null,
  });
  eq(
    'T2.a antes del flush queda hasTranscript=false',
    listChatTrash(owner).find((entry) => entry.id === t2Id)?.hasTranscript,
    false,
  );
  fs.mkdirSync(path.dirname(t2Original), { recursive: true });
  fs.writeFileSync(t2Original, t2Content);
  eq(
    'T2.b después del flush listChatTrash repara hasTranscript=true',
    listChatTrash(owner).find((entry) => entry.id === t2Id)?.hasTranscript,
    true,
  );
  const t2Copy = transcriptCopyPath(t2Id, t2Original);
  eq('T2.c la reparación crea la copia en disco', fs.existsSync(t2Copy), true);
  eq('T2.d la copia reparada conserva el contenido', fs.readFileSync(t2Copy, 'utf8'), t2Content);

  console.log('\nT3 · IDEMPOTENCIA');
  const t3Input = {
    chatId: 'ctest-3',
    owner,
    title: 'Idempotente',
    cwd: '/tmp/idempotente',
    sessionId: 'sid-3',
    transcriptPath: null,
    attachDir: null,
  };
  const t3First = trashChat(t3Input);
  const t3Second = trashChat(t3Input);
  eq('T3.a dos depósitos devuelven el mismo trashId', t3Second, t3First);
  eq(
    'T3.b queda una sola entrada para el chatId',
    listChatTrash(owner).filter((entry) => entry.chatId === 'ctest-3').length,
    1,
  );

  console.log('\nT4 · PURGA A LOS 30 DÍAS');
  const t4OldId = trashChat({
    chatId: 'ctest-4-old',
    owner,
    title: 'Vieja',
    cwd: '/tmp/old',
    sessionId: 'sid-4-old',
    transcriptPath: null,
    attachDir: null,
  });
  const t4YoungId = trashChat({
    chatId: 'ctest-4-young',
    owner,
    title: 'Vigente',
    cwd: '/tmp/young',
    sessionId: 'sid-4-young',
    transcriptPath: null,
    attachDir: null,
  });
  setDeletedAt(t4OldId, Date.now() - 31 * DAY_MS);
  setDeletedAt(t4YoungId, Date.now() - 29 * DAY_MS);
  const t4List = listChatTrash(owner);
  eq('T4.a la entrada de 31 días ya no aparece', t4List.some((entry) => entry.id === t4OldId), false);
  eq('T4.b la carpeta de 31 días fue borrada', fs.existsSync(itemPath(t4OldId)), false);
  eq('T4.c la entrada de 29 días sobrevive', t4List.some((entry) => entry.id === t4YoungId), true);
  eq('T4.d la entrada de 29 días tiene daysLeft=1', t4List.find((entry) => entry.id === t4YoungId)?.daysLeft, 1);

  const t4AutoId = trashChat({
    chatId: 'ctest-4-auto',
    owner,
    title: 'Auto purge',
    cwd: '/tmp/auto',
    sessionId: 'sid-4-auto',
    transcriptPath: null,
    attachDir: null,
  });
  setDeletedAt(t4AutoId, Date.now() - 31 * DAY_MS);
  eq('T4.e autoPurgeChatTrash devuelve el conteo correcto', autoPurgeChatTrash(owner), 1);
  eq('T4.f autoPurgeChatTrash borra la carpeta expirada', fs.existsSync(itemPath(t4AutoId)), false);

  console.log('\nT5 · RESTAURAR');
  const t5Original = path.join(testRoot, 'restore-target', 'ctest-5.jsonl');
  const t5AttachDir = path.join(testRoot, 'restore-target', 'attachments-5');
  const t5Content = '{"restore":"transcript"}\n';
  fs.mkdirSync(path.join(t5AttachDir, 'nested'), { recursive: true });
  fs.writeFileSync(t5Original, t5Content);
  fs.writeFileSync(path.join(t5AttachDir, 'a.txt'), 'adjunto A\n');
  fs.writeFileSync(path.join(t5AttachDir, 'nested', 'b.txt'), 'adjunto B\n');
  const t5Id = trashChat({
    chatId: 'ctest-5',
    owner,
    title: 'Restaurable',
    cwd: '/tmp/restore',
    sessionId: 'sid-5',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    ticket: 'TICKET-5',
    transcriptPath: t5Original,
    attachDir: t5AttachDir,
  });
  fs.rmSync(t5Original, { force: true });
  fs.rmSync(t5AttachDir, { recursive: true, force: true });
  const t5Restored = restoreChatTrash(t5Id, owner);
  eq('T5.a restore devuelve la metadata esperada', t5Restored, {
    sessionId: 'sid-5',
    cwd: '/tmp/restore',
    title: 'Restaurable',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    ticket: 'TICKET-5',
  });
  eq('T5.b el transcript vuelve a su ruta original', fs.existsSync(t5Original), true);
  eq('T5.c el transcript restaurado conserva el contenido', fs.readFileSync(t5Original, 'utf8'), t5Content);
  eq('T5.d vuelve el adjunto de primer nivel', fs.readFileSync(path.join(t5AttachDir, 'a.txt'), 'utf8'), 'adjunto A\n');
  eq(
    'T5.e vuelve el adjunto anidado',
    fs.readFileSync(path.join(t5AttachDir, 'nested', 'b.txt'), 'utf8'),
    'adjunto B\n',
  );
  eq('T5.f la entrada restaurada desaparece del listado', listChatTrash(owner).some((entry) => entry.id === t5Id), false);
  eq('T5.g la carpeta restaurada desaparece del disco', fs.existsSync(itemPath(t5Id)), false);

  const t5Existing = path.join(testRoot, 'restore-target', 'ctest-5-existing.jsonl');
  fs.writeFileSync(t5Existing, 'contenido al depositar\n');
  const t5ExistingId = trashChat({
    chatId: 'ctest-5-existing',
    owner,
    title: 'No pisar',
    cwd: '/tmp/no-overwrite',
    sessionId: 'sid-5-existing',
    transcriptPath: t5Existing,
    attachDir: null,
  });
  fs.writeFileSync(t5Existing, 'contenido original más nuevo\n');
  ok('T5.h restaurar con original existente devuelve metadata', restoreChatTrash(t5ExistingId, owner) !== null);
  eq(
    'T5.i restaurar no pisa un transcript original existente',
    fs.readFileSync(t5Existing, 'utf8'),
    'contenido original más nuevo\n',
  );

  console.log('\nT6 · PURGA MANUAL Y MULTIUSUARIO');
  const t6ManualId = trashChat({
    chatId: 'ctest-6-manual',
    owner,
    title: 'Manual',
    cwd: '/tmp/manual',
    sessionId: 'sid-6-manual',
    transcriptPath: null,
    attachDir: null,
  });
  eq('T6.a purgeChatTrash devuelve true para una entrada existente', purgeChatTrash(t6ManualId, owner), true);
  eq('T6.b purgeChatTrash borra la carpeta', fs.existsSync(itemPath(t6ManualId)), false);
  eq('T6.c purgeChatTrash devuelve false para un id inexistente', purgeChatTrash('no-existe', owner), false);

  const t6AutoId = trashChat({
    chatId: 'ctest-6-auto-all',
    owner,
    title: 'Multiusuario',
    cwd: '/tmp/multi',
    sessionId: 'sid-6-auto',
    transcriptPath: null,
    attachDir: null,
  });
  setDeletedAt(t6AutoId, Date.now() - 31 * DAY_MS);
  let t6AutoResult;
  let t6AutoThrew = false;
  try {
    t6AutoResult = autoPurgeAllChatTrash([owner, 'no-existe', owner]);
  } catch (err) {
    t6AutoThrew = true;
    t6AutoResult = err;
  }
  eq('T6.d autoPurgeAllChatTrash no explota con repetidos e inexistentes', t6AutoThrew, false);
  eq('T6.e autoPurgeAllChatTrash devuelve un número', typeof t6AutoResult, 'number');
  eq('T6.f autoPurgeAllChatTrash deduplica y devuelve el conteo correcto', t6AutoResult, 1);
  eq('T6.g autoPurgeAllChatTrash borra la carpeta expirada', fs.existsSync(itemPath(t6AutoId)), false);

  ok(
    'AISLAMIENTO · la papelera usada está dentro del temporal',
    ownerTrashDir.startsWith(testRoot + path.sep),
    { testRoot, ownerTrashDir },
  );
} catch (err) {
  fail++;
  console.log(`❌ ejecución completa sin excepciones\n   detalle: ${err?.stack || err}`);
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
  eq('LIMPIEZA · el directorio temporal fue borrado', fs.existsSync(testRoot), false);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} chat-trash: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
