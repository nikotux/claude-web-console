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

const cmd = (sub) => `node ${BUS} ${sub}`;

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { /* nuevo */ }

if (fs.existsSync(SETTINGS) && !fs.existsSync(BACKUP)) {
  fs.copyFileSync(SETTINGS, BACKUP);
  console.log(`backup: ${BACKUP}`);
}

settings.hooks = settings.hooks || {};

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

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`hooks instalados en ${SETTINGS}`);

// Comando /btw
fs.mkdirSync(CMD_DIR, { recursive: true });
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
!\`node ${BUS} send "$ARGUMENTS"\`

Confirmale al usuario a quién se envió. Si el comando devolvió un error o la
lista de sesiones, mostrásela para que corrija el destino. Si el mensaje era una
PREGUNTA, aclarale que la respuesta llegará cuando la otra sesión conteste (la
verás inyectada en tu próximo turno). No reenvíes el mensaje más de una vez.
`;
}
