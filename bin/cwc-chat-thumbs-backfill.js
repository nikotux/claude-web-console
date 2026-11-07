#!/usr/bin/env node
// Backfill idempotente de miniaturas del chat. Dry-run por defecto.
// Aplicación amable con el host: nice -n 19 node bin/cwc-chat-thumbs-backfill.js --apply
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateThumbFile, isThumbCandidate, THUMB_DIR, thumbNameFor, thumbsEnabled,
} from '../src/modules/chat/thumbs.js';

const EMPTY = () => ({
  chats: 0,
  images: 0,
  candidates: 0,
  existing: 0,
  generated: 0,
  failed: 0,
  orphansPruned: 0,
  bytesOriginal: 0,
  bytesThumbs: 0,
});

function parseArgs(argv) {
  const options = { apply: false, json: false, user: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--user' && argv[i + 1]) options.user = argv[++i];
    else throw new Error(`Opción inválida: ${arg}`);
  }
  return options;
}

function userRoots(home) {
  const host = process.env.CWC_HOST_USER || os.userInfo().username;
  const roots = [{ user: host, root: path.join(home, '.cwc-data', 'chat-attachments') }];
  const tenantsDir = path.join(home, '.cwc-users');
  try {
    for (const entry of fs.readdirSync(tenantsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === host) continue;
      roots.push({
        user: entry.name,
        root: path.join(tenantsDir, entry.name, '.cwc-data', 'chat-attachments'),
      });
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  return roots;
}

async function scanUser(entry, apply) {
  const summary = { user: entry.user, ...EMPTY() };
  let chats;
  try { chats = fs.readdirSync(entry.root, { withFileTypes: true }); }
  catch (e) {
    if (e?.code === 'ENOENT') return summary;
    throw e;
  }
  for (const chat of chats) {
    if (!chat.isDirectory()) continue;
    summary.chats += 1;
    const chatDir = path.join(entry.root, chat.name);
    const thumbDir = path.join(chatDir, THUMB_DIR);
    const expected = new Set();
    let files = [];
    try { files = fs.readdirSync(chatDir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || file.name.startsWith('_') || file.name.startsWith('.')) continue;
      if (!/\.(?:png|jpe?g|webp|gif)$/i.test(file.name)) continue;
      summary.images += 1;
      const src = path.join(chatDir, file.name);
      let stat;
      try { stat = fs.statSync(src); } catch { continue; }
      summary.bytesOriginal += stat.size;
      if (!isThumbCandidate(file.name, stat.size)) continue;
      summary.candidates += 1;
      const thumbName = thumbNameFor(file.name, stat.size, stat.mtimeMs);
      expected.add(thumbName);
      const dst = path.join(thumbDir, thumbName);
      if (fs.existsSync(dst)) {
        summary.existing += 1;
        try { summary.bytesThumbs += fs.statSync(dst).size; } catch { /* noop */ }
        continue;
      }
      if (!apply) continue;
      if (await generateThumbFile(src, dst)) {
        summary.generated += 1;
        try { summary.bytesThumbs += fs.statSync(dst).size; } catch { /* noop */ }
      } else {
        summary.failed += 1;
      }
    }
    let thumbs = [];
    try { thumbs = fs.readdirSync(thumbDir, { withFileTypes: true }); } catch { /* no existe aún */ }
    for (const thumb of thumbs) {
      if (!thumb.isFile() || !/^[0-9a-f]{20}\.webp$/.test(thumb.name) || expected.has(thumb.name)) continue;
      if (apply) {
        try {
          fs.unlinkSync(path.join(thumbDir, thumb.name));
          summary.orphansPruned += 1;
        }
        catch { summary.failed += 1; }
      } else summary.orphansPruned += 1; // dry-run: cantidad que se podaría
    }
  }
  return summary;
}

function totals(users) {
  const total = EMPTY();
  for (const user of users) {
    for (const key of Object.keys(total)) total[key] += user[key];
  }
  return total;
}

function printHuman(result) {
  console.log(`${result.dryRun ? 'DRY RUN' : 'APPLY'} · miniaturas de chat${result.disabled ? ' · deshabilitadas por CWC_CHAT_THUMBS=0' : ''}`);
  for (const user of result.users) {
    console.log(`${user.user}: chats=${user.chats} images=${user.images} candidates=${user.candidates} existing=${user.existing} generated=${user.generated} failed=${user.failed} orphansPruned=${user.orphansPruned} bytesOriginal=${user.bytesOriginal} bytesThumbs=${user.bytesThumbs}`);
  }
  const t = result.total;
  console.log(`TOTAL: chats=${t.chats} images=${t.images} candidates=${t.candidates} existing=${t.existing} generated=${t.generated} failed=${t.failed} orphansPruned=${t.orphansPruned} bytesOriginal=${t.bytesOriginal} bytesThumbs=${t.bytesThumbs}`);
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (e) {
    console.error(`${e.message}\nUso: node bin/cwc-chat-thumbs-backfill.js [--apply] [--user <nombre>] [--json]`);
    process.exitCode = 1;
    return;
  }
  const home = path.resolve(process.env.CWC_HOME?.trim() || os.homedir());
  let roots = userRoots(home);
  if (options.user) roots = roots.filter((entry) => entry.user === options.user);
  if (options.user && !roots.length) {
    console.error(`Usuario desconocido: ${options.user}`);
    process.exitCode = 1;
    return;
  }
  const disabled = !thumbsEnabled();
  const users = [];
  for (const root of roots) users.push(disabled ? { user: root.user, ...EMPTY() } : await scanUser(root, options.apply));
  const result = { dryRun: !options.apply, disabled, users, total: totals(users) };
  if (options.json) console.log(JSON.stringify(result));
  else printHuman(result);
}

await main();
