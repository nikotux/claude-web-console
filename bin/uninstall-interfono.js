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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function abortInvalidSettings(detail) {
  console.error(`ERROR: ${SETTINGS} tiene una configuración inválida (${detail}).`);
  console.error('Abortado antes de escribir. Corregila a mano y reintentá.');
  process.exit(1);
}

function writeFileAtomic(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  try {
    fs.writeFileSync(tmp, contents, { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no llegó a crearse o ya se renombró */ }
    throw e;
  }
}

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

if (!isPlainObject(settings)) {
  abortInvalidSettings('la raíz debe ser un objeto');
}
if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
  abortInvalidSettings('"hooks" debe ser un objeto');
}
for (const [event, entries] of Object.entries(settings.hooks || {})) {
  if (!Array.isArray(entries)) abortInvalidSettings(`hooks.${event} debe ser un array`);
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
  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`hooks del Interfono removidos de ${SETTINGS}`);
} else {
  console.log(`${SETTINGS} no existe; nada que quitar en hooks.`);
}

// Solo borramos el btw.md si es NUESTRO (contiene la marca cwc-bus.js); un
// /btw ajeno del usuario no se toca — misma cautela que con settings.json.
try {
  const cur = fs.readFileSync(CMD_FILE, 'utf8');
  if (cur.includes('cwc-bus.js')) {
    fs.unlinkSync(CMD_FILE);
    console.log(`comando removido: ${CMD_FILE}`);
  } else {
    console.log(`${CMD_FILE} no es del Interfono (sin marca cwc-bus.js); se deja intacto.`);
  }
} catch { /* no existía o ilegible: nada que quitar */ }
