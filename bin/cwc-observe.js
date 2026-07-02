#!/usr/bin/env node
// bin/cwc-observe.js — observador de Claude Code para la consola web.
//
// Lo invocan la statusline y los hooks de Claude Code (config de usuario,
// instalada por bin/install-observer.js). Recibe el JSON por stdin y escribe
// ~/.cwc-state/<session_id>.json con { cwd, model, status, ts } — la fuente
// de "estado real" (trabajando/esperando) y modelo en tiempo real que lee el
// servidor de la consola.
//
// Modos (argv[2]):
//   statusline → actualiza cwd/modelo e imprime "Modelo · ~carpeta"
//   working    → hook UserPromptSubmit (Claude empezó a trabajar)
//   waiting    → hook Stop (terminó; espera input)
//   ended      → hook SessionEnd (la sesión terminó)
//
// Diseñado para NO romper nada: cualquier error termina en silencio (exit 0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2] || 'statusline';

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try { run(); } catch { /* nunca romper la sesión de Claude */ }
  process.exit(0);
});

function run() {
  let j = {};
  try { j = JSON.parse(raw); } catch { /* stdin no-JSON */ }

  // Sesiones del CHAT web (runner del SDK, Fase 8): NO tocar ~/.cwc-state.
  // Ese estado es exclusivo de TUIs — sessionIdForCwd() alimenta la adopción
  // TUI->Chat y se confundiría con la sesión del propio chat; el chat ya
  // reporta working/waiting por el socket de su runner.
  if (process.env.CWC_CHAT_RUNNER) return;

  const sid = j.session_id || null;
  const dir = path.join(os.homedir(), '.cwc-state');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* noop */ }

  const file = sid ? path.join(dir, `${sid}.json`) : null;
  let prev = {};
  if (file && fs.existsSync(file)) {
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* noop */ }
  }

  // La statusline trae workspace.current_dir y model; los hooks traen cwd.
  const cwd = j.cwd || j.workspace?.current_dir || prev.cwd || null;
  const model = j.model || prev.model || null;
  const status = mode === 'statusline' ? (prev.status || 'waiting') : mode;

  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify({ sessionId: sid, cwd, model, status, ts: Date.now() }));
    } catch { /* noop */ }
  }

  if (mode === 'statusline') {
    const home = os.homedir();
    const shortDir = cwd ? (cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd) : '';
    process.stdout.write([model?.display_name, shortDir].filter(Boolean).join(' · '));
  }
}
