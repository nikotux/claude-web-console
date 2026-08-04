// core/pad-url.js — fuente ÚNICA del default de URL del Pad LOCAL self-hosted.
//
// POR QUÉ EXISTE (2026-08-03): el default vivía duplicado como literal en 11
// archivos (core, modules y bin). Cuando la IP ZeroTier de esta máquina cambió
// de .62 a .192, la unidad systemd se actualizó pero los 11 literales no — y como
// .62 quedó asignada a la consola VIEJA, la consola nueva y los MCP siguieron
// hablando con una máquina ajena durante días, con la sesión de Pad rebotando
// entre las dos (miles de eventos `session_ip_changed`).
//
// POR QUÉ ES DINÁMICO (2026-08-03): arreglar el literal no evita la repetición.
// El Pad local bindea a la MISMA IP ZeroTier que la consola, así que la fuente de
// verdad no es un número escrito a mano sino la interfaz zt* del sistema — la
// misma que usa src/server.js para bindear. findZeroTierIp() es síncrona y solo
// usa node:os, por eso es seguro llamarla desde runners de bin/ con env limpio.
//
// ORDEN DE RESOLUCIÓN: CWC_PAD_URL (override explícito) → IP ZeroTier detectada
// → FALLBACK_URL. El fallback existe para el caso de arranque temprano en que
// zerotier-one todavía no levantó la interfaz (el mismo escenario que
// waitForZeroTier resuelve para el server).
import { findZeroTierIp } from './zerotier.js';

const PAD_PORT = Number(process.env.CWC_PAD_PORT) || 7777;
const FALLBACK_URL = `http://10.213.222.192:${PAD_PORT}`;

// Resuelve la URL FRESCA en cada llamada. Usala si te importa reflejar un cambio
// de IP sin reiniciar el proceso.
export function padDefaultUrl() {
  if (process.env.CWC_PAD_URL) return process.env.CWC_PAD_URL;
  const zt = findZeroTierIp();
  if (zt?.ip) return `http://${zt.ip}:${PAD_PORT}`;
  return FALLBACK_URL;
}

// Valor resuelto al IMPORTAR. Es lo que consumen los 11 call-sites históricos,
// que lo guardan en una constante de módulo. Un cambio de IP en caliente exige
// reiniciar el proceso — igual que el bind del server, así que no agrega una
// restricción nueva.
export const PAD_DEFAULT_URL = padDefaultUrl();
export default PAD_DEFAULT_URL;
