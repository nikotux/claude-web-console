#!/usr/bin/env node
// bin/uninstall-observer.js — quita el observador de ~/.claude/settings.json.
//
// Elimina EXACTAMENTE lo que instaló install-observer.js (statusLine y hooks
// que apunten a cwc-observe.js); todo lo demás queda intacto. El backup
// original sigue en settings.json.bak por si se quiere restaurar a mano.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = 'cwc-observe.js';

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {
  console.log('No hay settings.json; nada que hacer.');
  process.exit(0);
}

if (settings.statusLine && String(settings.statusLine.command || '').includes(MARK)) {
  delete settings.statusLine;
  console.log('statusLine del observador eliminada.');
}

if (settings.hooks) {
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(
      (e) => !JSON.stringify(e).includes(MARK),
    );
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  console.log('hooks del observador eliminados.');
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`listo: ${SETTINGS} limpio. (Los archivos de estado en ~/.cwc-state/ se pueden borrar a mano.)`);
