#!/usr/bin/env node
// bin/cwc-block-progress.js — escritor DETERMINÍSTICO del control-plane del
// Orquestador Interno (CONVE-654 / PLAN-642). 0 tokens, sin SDK: un BLOQUE marca
// su tarea (PEND) hecha y/o su PLAN-bloque en Pad-CONSOLE, desde CUALQUIER
// cwd — incluido un bloque que corre en cwd=Tolkien, que NO puede tocar el
// Pad-console con su MCP (Regla 12/Limbo). Escribe SIEMPRE contra el Pad LOCAL
// self-hosted (workspace 'console' = el plano de control), vía el binario `pad`
// (autenticado como el dueño/Niko), forzando --workspace y --url para no depender
// del .pad.toml del cwd. El acto de marcar una tarea `hecha` ADEMÁS refresca el
// updated_at del ítem → es el HEARTBEAT que el orquestador lee para desempatar el
// caso "vivo pero ocioso". La SEÑAL de fin de bloque va por OTRO canal (interfono,
// bin/cwc-bus.js send / `/btw`); esto es solo el estado persistente en Pad.
//
// Uso:
//   cwc-block-progress task  <PEND-ref>          <status> [--note "texto"]
//   cwc-block-progress block <PLAN-ref>          <status> [--note "texto"]
//   cwc-block-progress done  <ref> [--note "texto"]        # atajo: status del tipo terminal
// Ejemplos:
//   cwc-block-progress task PEND-612 hecha --note "N2b self-check + invariante"
//   cwc-block-progress block PLAN-592 active --note "arrancó B-A"
// Estados válidos para `pendientes` y `planes` (el binario pad valida el enum):
//   pendientes: pendiente | en-progreso | hecha
//   planes:     active | proposed | done | cancelled
// Exit: 0 ok · 2 error de uso · 1 fallo al escribir Pad.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAD_DEFAULT_URL } from '../src/core/pad-url.js';

const PAD_URL = PAD_DEFAULT_URL;
const WORKSPACE = process.env.CWC_PAD_WORKSPACE || 'console'; // control-plane = SIEMPRE console

function fail(msg, code = 2) { console.error('[block-progress] ' + msg); process.exit(code); }

// Ubica el binario `pad` sin depender del PATH del entorno del runner.
function padBin() {
  const candidates = [
    process.env.CWC_PAD_BIN,
    path.join(os.homedir(), '.local', 'bin', 'pad'),
    '/usr/local/bin/pad',
    'pad', // último recurso: PATH
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (c === 'pad' || fs.existsSync(c)) return c; } catch { /* noop */ }
  }
  return 'pad';
}

// Parseo mínimo de args: <verb> <ref> [status] [--note "..."]
const argv = process.argv.slice(2);
if (argv.length < 2) fail('uso: cwc-block-progress <task|block|done> <ref> [status] [--note "texto"]');

const verb = argv[0];
const ref = argv[1];
if (!/^[A-Z]+-\d+$/.test(ref)) fail(`ref inválido: ${ref} (esperado tipo TASK-5, PLAN-3, PEND-9)`);

let note = null;
let status = null;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--note') { note = argv[++i] || ''; continue; }
  if (!argv[i].startsWith('--') && status === null) { status = argv[i]; continue; }
}

if (verb === 'done') {
  // atajo: infiere el status terminal por el prefijo del ref
  const pref = ref.split('-')[0];
  status = pref === 'PEND' ? 'hecha' : 'done'; // PLAN/TASK → done
} else if (verb !== 'task' && verb !== 'block') {
  fail(`verbo desconocido: ${verb} (usar task | block | done)`);
}
if (!status) fail('falta el status (o usá el verbo `done`)');

const args = ['item', 'update', ref, '--status', status, '--workspace', WORKSPACE, '--url', PAD_URL];
if (note) { args.push('--comment', `[OB] ${note}`); }

try {
  const out = execFileSync(padBin(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(out || `[block-progress] ${ref} → ${status}\n`);
  process.exit(0);
} catch (e) {
  const detail = (e.stderr || e.stdout || e.message || '').toString().slice(0, 400);
  fail(`no pude actualizar ${ref} en Pad ${WORKSPACE}: ${detail}`, 1);
}
