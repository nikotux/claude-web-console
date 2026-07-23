// core/config.js — carga y valida el .env del proyecto.
import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { loadInstance } from './instance-config.js';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[config] Falta la variable obligatoria ${name} en el .env`);
    process.exit(1);
  }
  return v.trim();
}

const home = process.env.CWC_HOME?.trim() || os.homedir();

export const config = {
  token: required('CWC_TOKEN'),
  port: parseInt(process.env.CWC_PORT || '8092', 10),
  // Interfaz ZeroTier objetivo. Vacío => autodetección de zt*.
  ztIface: process.env.CWC_ZT_IFACE?.trim() || null,
  home: path.resolve(home),
  tmuxSocket: process.env.CWC_TMUX_SOCKET?.trim() || 'cwc',
  scrollback: parseInt(process.env.CWC_SCROLLBACK || '5000', 10),
  // Días de validez de una sesión de usuario (persisten a reinicios del server).
  sessionDays: parseInt(process.env.CWC_SESSION_DAYS || '30', 10),
  // Proyecto principal con panel/actualización propia (git). Default: ~/tolkien.
  projectDir: path.resolve(process.env.CWC_PROJECT_DIR?.trim() || path.join(home, 'tolkien')),
  projectName: process.env.CWC_PROJECT_NAME?.trim() || 'tolkien',
  unifi: {
    host: process.env.UNIFI_HOST?.trim() || null,
    apiKey: process.env.UNIFI_API_KEY?.trim() || null,
    site: process.env.UNIFI_SITE?.trim() || 'default',
  },
  // Capa de config de instancia (identidad + cliente) — ver core/instance-config.js.
  // Separa del código la identidad de quien corre esta consola (email, GitHub,
  // departamento Zoho, nombre del MCP) para que otra persona pueda instalar su
  // propia instancia sin heredar la de Nico (PLAN-476/PEND-377).
  instance: loadInstance(),
};
