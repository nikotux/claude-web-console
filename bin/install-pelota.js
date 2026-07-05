#!/usr/bin/env node
// bin/install-pelota.js — instala el recordatorio de "🎾 La pelota" en la
// config de usuario de Claude Code (~/.claude/settings.json).
//
// QUÉ ES: la preferencia global de Nico (~/.claude/CLAUDE.md, sección "La
// pelota") exige cerrar TODA respuesta con una línea "🎾 Pelota: ..." que dice
// quién tiene la pelota. Pero el CLAUDE.md se carga UNA vez al iniciar la
// sesión y en hilos largos queda lejos en el contexto: el modelo a veces la
// omitía (reportado por el usuario 2026-07-05). Este hook la vuelve
// DETERMINÍSTICA: un UserPromptSubmit con echo puro inyecta el recordatorio
// fresco en CADA turno (≈40 tokens de contexto, 0 procesos Node).
//
// ADITIVO y REVERSIBLE (mismo patrón que install-observer/install-interfono):
//   - Backup del settings.json original en settings.json.bak (solo la 1ª vez).
//   - Nuestras entradas previas se reemplazan (idempotente); las AJENAS
//     (observador, interfono) se preservan intactas. Marca: [cwc-pelota].
// Deshacer: node bin/uninstall-pelota.js
// Gotcha: las sesiones YA ABIERTAS toman el hook al reiniciar claude adentro.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = `${SETTINGS}.bak`;
const MARK = 'cwc-pelota';

const REMINDER = "🎾 [cwc-pelota] Recordatorio de formato: cerrá tu respuesta con UNA línea final '🎾 Pelota: ...' — nadie (🟢 nada pendiente, puede cerrar) / TUYA (🟡 + la acción exacta que le pedís al usuario) / MÍA (🔵 seguís trabajando vos) / OTRO (📨 quién y qué la libera). Es lo ÚLTIMO del mensaje.";

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

setHook('UserPromptSubmit', {
  hooks: [{ type: 'command', command: `echo "${REMINDER.replace(/"/g, '\\"')}"` }],
});

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`hook de La pelota instalado en ${SETTINGS}`);
console.log('Las sesiones NUEVAS lo toman ya; las abiertas, al reiniciar claude adentro.');
