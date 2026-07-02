#!/usr/bin/env node
// bin/install-observer.js — instala el observador en ~/.claude/settings.json.
//
// ADITIVO y REVERSIBLE:
//   - Backup del settings.json original en settings.json.bak (solo la primera
//     vez, para preservar el estado pre-observador).
//   - Agrega statusLine + hooks (UserPromptSubmit/Stop/SessionEnd) apuntando a
//     bin/cwc-observe.js. Si ya había entradas nuestras, las reemplaza; las
//     ajenas se preservan.
// Deshacer: node bin/uninstall-observer.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBSERVE = path.resolve(__dirname, 'cwc-observe.js');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = `${SETTINGS}.bak`;
const MARK = 'cwc-observe.js';

const cmd = (mode) => `node ${OBSERVE} ${mode}`;

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { /* nuevo */ }

// Backup del original (una sola vez).
if (fs.existsSync(SETTINGS) && !fs.existsSync(BACKUP)) {
  fs.copyFileSync(SETTINGS, BACKUP);
  console.log(`backup: ${BACKUP}`);
}

// Statusline: solo se pisa si es nuestra o no existe (no rompemos una ajena).
if (!settings.statusLine || String(settings.statusLine.command || '').includes(MARK)) {
  settings.statusLine = { type: 'command', command: cmd('statusline') };
} else {
  console.warn('⚠ Ya existe una statusLine ajena; NO se tocó (el estado usará solo hooks).');
}

// Hooks: se filtran entradas nuestras previas y se agrega la fresca.
settings.hooks = settings.hooks || {};
const EVENTS = { UserPromptSubmit: 'working', Stop: 'waiting', SessionEnd: 'ended' };
for (const [event, mode] of Object.entries(EVENTS)) {
  const entries = (settings.hooks[event] || []).filter(
    (e) => !JSON.stringify(e).includes(MARK),
  );
  entries.push({ hooks: [{ type: 'command', command: cmd(mode) }] });
  settings.hooks[event] = entries;
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`instalado en ${SETTINGS}`);
console.log('Las sesiones NUEVAS de Claude Code reportan estado; las ya abiertas, al reiniciarse.');
