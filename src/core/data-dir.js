// core/data-dir.js — resolutor ÚNICO del directorio de datos runtime (.cwc-data).
// CONFIG-FREE a propósito: lo importan el SERVER y el RUNNER de inquilino (que
// corre con env LIMPIO, sin CWC_TOKEN → no puede importar core/config.js).
//
// Multi-tenant (PLAN-592/TASK-614): el server inyecta CWC_DATA_DIR=userDataDir(owner)
// al runner del inquilino (userRunnerEnv). Con CWC_DATA_DIR seteado, la data
// user-scoped (adjuntos del chat, etc.) cae bajo el espacio del inquilino. Sin él
// (server host y runner del host) → ~/.cwc-data de siempre: retrocompat total.
import os from 'node:os';
import path from 'node:path';

export function resolveDataDir() {
  const explicit = process.env.CWC_DATA_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return path.join(os.homedir(), '.cwc-data');
}
