#!/usr/bin/env node
// bin/install-interfono.js — instala el "Interfono" entre sesiones en la
// config de usuario de Claude Code (~/.claude/settings.json) + el comando /btw.
//
// ADITIVO y REVERSIBLE (mismo patrón que bin/install-observer.js):
//   - Backup del settings.json original en settings.json.bak (solo la 1ª vez).
//   - Agrega hooks apuntando a bin/cwc-bus.js. Las entradas nuestras previas se
//     reemplazan (idempotente); las AJENAS (incluidas las del observador, que
//     usa el mismo settings) se preservan intactas.
//   - Instala ~/.claude/commands/btw.md (comando /btw).
// Deshacer: node bin/uninstall-interfono.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUS = path.resolve(__dirname, 'cwc-bus.js');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = `${SETTINGS}.bak`;
const CMD_DIR = path.join(os.homedir(), '.claude', 'commands');
const CMD_FILE = path.join(CMD_DIR, 'btw.md');
const MARK = 'cwc-bus.js';

// BUS queda dentro de comillas dobles del shell: escapar todos los caracteres
// que conservan significado especial en ese contexto.
const shellDoubleQuote = (value) => `"${String(value).replace(/["\\$`]/g, '\\$&')}"`;
const cmd = (sub) => `node ${shellDoubleQuote(BUS)} ${sub}`;

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
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    // El archivo EXISTE pero no parsea (corrupto, escritura concurrente a
    // mitad, edición rota). Tratarlo como "nuevo" y escribir {} pisaría hooks
    // ajenos (observador, permisos, MCP) SIN backup fresco (el .bak solo se
    // toma la 1ª vez). Abortar es lo seguro. ENOENT sí es un settings nuevo.
    console.error(`ERROR: ${SETTINGS} existe pero no es JSON válido (${e.message}).`);
    console.error('Abortado para no sobrescribir configuración ajena. Arreglalo a mano y reintentá.');
    process.exit(1);
  }
  // ENOENT: settings nuevo, seguimos con {}.
}

if (!isPlainObject(settings)) {
  abortInvalidSettings('la raíz debe ser un objeto');
}
if (settings.hooks === undefined) {
  settings.hooks = {};
} else if (!isPlainObject(settings.hooks)) {
  abortInvalidSettings('"hooks" debe ser un objeto');
}
for (const [event, entries] of Object.entries(settings.hooks)) {
  if (!Array.isArray(entries)) abortInvalidSettings(`hooks.${event} debe ser un array`);
}

if (fs.existsSync(SETTINGS) && !fs.existsSync(BACKUP)) {
  fs.copyFileSync(SETTINGS, BACKUP);
  console.log(`backup: ${BACKUP}`);
}

// Reemplaza SOLO nuestras entradas (por MARK) en un evento, preservando ajenas.
function setHook(event, entry) {
  const kept = (settings.hooks[event] || []).filter((e) => !JSON.stringify(e).includes(MARK));
  kept.push(entry);
  settings.hooks[event] = kept;
}

// Entrega pasiva: imprime mensajes pendientes al arrancar y en cada prompt.
setHook('SessionStart', { hooks: [{ type: 'command', command: cmd('hook-inject') }] });
setHook('UserPromptSubmit', { hooks: [{ type: 'command', command: cmd('hook-inject') }] });
// Claims: frenar antes de editar (guard) y reservar después de editar (claim).
setHook('PreToolUse', { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: cmd('hook-guard') }] });
setHook('PostToolUse', { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: cmd('hook-claim') }] });
// Cierre: soltar todos los claims propios.
setHook('SessionEnd', { hooks: [{ type: 'command', command: cmd('hook-release') }] });

writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`hooks instalados en ${SETTINGS}`);

// Comando /btw. Si ya existe un btw.md AJENO (sin nuestra marca cwc-bus.js), lo
// respaldamos antes de pisarlo — misma protección que damos a settings.json.
fs.mkdirSync(CMD_DIR, { recursive: true });
if (fs.existsSync(CMD_FILE)) {
  let prev = '';
  try { prev = fs.readFileSync(CMD_FILE, 'utf8'); } catch { /* ilegible: lo tratamos como ajeno */ }
  if (!prev.includes('cwc-bus.js')) {
    const bak = `${CMD_FILE}.bak`;
    try {
      fs.writeFileSync(bak, prev);
      console.log(`había un /btw ajeno; respaldado en ${bak}`);
    } catch (e) {
      console.error(`no se pudo respaldar el /btw ajeno (${e?.message}); se aborta para no destruirlo.`);
      process.exit(1);
    }
  }
}
fs.writeFileSync(CMD_FILE, btwCommandText());
console.log(`comando instalado: ${CMD_FILE}`);
console.log('Las sesiones NUEVAS de Claude Code toman el Interfono; las ya abiertas, al reiniciar claude adentro.');

// ---- Contenido del comando /btw ----
// $ARGUMENTS se sustituye por el texto crudo que el usuario escribe tras /btw
// y termina en un comando ejecutado por shell (backtick de Claude Code). Va
// entre comillas dobles para neutralizar espacios/glob/`;`/`&&`/`||`; riesgo
// residual (backticks, $(...), comilla doble literal en el mensaje) queda
// documentado y aceptado: es autoinfligido, el propio usuario de esa sesión.
function btwCommandText() {
  return `---
description: Interfono — enviar un mensaje a otra sesión de Claude Code de esta máquina
allowed-tools: Bash(node:*)
---
Vas a mandar un mensaje por el "Interfono" a otra sesión de Claude Code que
corre en esta misma máquina (otra TUI o chat). El primer argumento es el nombre
de la sesión destino (o \`all\` para broadcast); el resto es el mensaje.

Resultado del envío:
!\`node ${shellDoubleQuote(BUS)} send "$ARGUMENTS"\`

Confirmale al usuario a quién se envió. Si el comando devolvió un error o la
lista de sesiones, mostrásela para que corrija el destino. Si el mensaje era una
PREGUNTA, aclarale que la respuesta llegará cuando la otra sesión conteste (la
verás inyectada en tu próximo turno). No reenvíes el mensaje más de una vez.
`;
}
