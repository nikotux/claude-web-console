#!/usr/bin/env node
// bin/cwc-adduser.js — crea un usuario de la consola desde la CLI.
//
// Reusa core/users.js (mismo users.json que lee el server, permisos 600,
// hash scrypt). NO importa core/config.js a propósito: así funciona en una
// instalación fresca ANTES de tener un .env con CWC_TOKEN.
//
// Uso:
//   node bin/cwc-adduser.js <usuario> [--admin]         (pide contraseña oculta)
//   echo 'la-clave' | node bin/cwc-adduser.js <usuario> [--admin] --password-stdin
//
// El PRIMER usuario se crea SIEMPRE admin (necesitás al menos un admin para
// administrar el resto), avisando aunque no pases --admin.
//
// OJO: si el server YA está corriendo, no relee users.json en caliente —
// reiniciá el servicio para que tome el usuario nuevo. En una instalación
// nueva se crea ANTES de arrancar el servicio (ver bin/cwc-setup.js), sin
// necesidad de reinicio.
import readline from 'node:readline';
import { createUser, userCount, isValidUsername } from '../src/core/users.js';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const wantAdmin = args.includes('--admin');
const fromStdin = args.includes('--password-stdin');

function fail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

if (!username) fail('Falta el usuario. Uso: node bin/cwc-adduser.js <usuario> [--admin]');
if (!isValidUsername(username)) fail('Usuario inválido (letras, números, . _ - ; máx 32).');

// Contraseña oculta por readline (no eco de lo tecleado).
function askHidden(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(promptText, (a) => { rl.close(); rl.output.write('\n'); resolve(a); });
    muted = true;
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

(async () => {
  // El primer usuario debe ser admin sí o sí.
  const isFirst = userCount() === 0;
  const admin = wantAdmin || isFirst;
  if (isFirst && !wantAdmin) console.log('(es el primer usuario → se crea como administrador)');

  let password;
  if (fromStdin) {
    password = await readStdin();
  } else {
    password = await askHidden(`Contraseña para "${username}" (mín 10 caracteres): `);
    const again = await askHidden('Repetí la contraseña: ');
    if (password !== again) fail('Las contraseñas no coinciden.');
  }

  try {
    createUser(username, password, admin);
  } catch (e) {
    fail(e.message || String(e));
  }
  console.log(`✅ Usuario "${username}" creado${admin ? ' (administrador)' : ''}.`);
  process.exit(0);
})();
