#!/usr/bin/env node
// bin/uninstall-interfono.js — quita el Interfono de ~/.claude/settings.json y
// borra el comando /btw. Reversa de bin/install-interfono.js.
//
// Quita SOLO las entradas de hooks nuestras (marcadas por cwc-bus.js); las
// ajenas (incluidas las del observador) se preservan. No restaura el .bak para
// no pisar cambios ajenos posteriores: solo remueve lo que agregamos.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CMD_FILE = path.join(os.homedir(), '.claude', 'commands', 'btw.md');
const MARK = 'cwc-bus.js';

let settings = {};
let existed = false;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  existed = true;
} catch (e) {
  if (e.code === 'ENOENT') {
    // No hay settings.json: no hay hooks nuestros que quitar. Solo removeremos
    // el comando /btw más abajo; NUNCA creamos un settings vacío.
  } else {
    // JSON corrupto/ilegible: ABORTAR. Sobrescribir con {} borraría TODO lo
    // ajeno (hooks del observador, permisos, MCP). Nunca pisar un original no
    // parseable sin intervención humana.
    console.error(`ERROR: ${SETTINGS} existe pero no es JSON válido (${e.message}).`);
    console.error('Abortado para no perder configuración ajena. Arreglalo a mano y reintentá.');
    process.exit(1);
  }
}

if (settings.hooks) {
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(
      (e) => !JSON.stringify(e).includes(MARK));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

if (existed) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`hooks del Interfono removidos de ${SETTINGS}`);
} else {
  console.log(`${SETTINGS} no existe; nada que quitar en hooks.`);
}

try { fs.unlinkSync(CMD_FILE); console.log(`comando removido: ${CMD_FILE}`); }
catch { /* no existía */ }
