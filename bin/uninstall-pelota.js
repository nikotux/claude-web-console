#!/usr/bin/env node
// bin/uninstall-pelota.js — quita el recordatorio de "🎾 La pelota" de
// ~/.claude/settings.json. Reversa de bin/install-pelota.js.
//
// Quita SOLO las entradas nuestras (marca [cwc-pelota]); las ajenas
// (observador, interfono) se preservan. No restaura el .bak para no pisar
// cambios ajenos posteriores: solo remueve lo que agregamos.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = 'cwc-pelota';

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { settings = {}; }

if (settings.hooks) {
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(
      (e) => !JSON.stringify(e).includes(MARK));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`hook de La pelota removido de ${SETTINGS}`);
