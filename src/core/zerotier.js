// core/zerotier.js — detecta la IP de la interfaz ZeroTier y ESPERA a que exista.
//
// Tras un reboot, zerotier-one tarda en levantar y la interfaz zt* puede no
// tener IP todavía. En vez de crashear, reintentamos hasta que aparezca.
import os from 'node:os';

// Devuelve la IPv4 de la interfaz zt indicada, o de la primera zt* si iface=null.
// null si aún no hay ninguna.
export function findZeroTierIp(iface = null) {
  const ifaces = os.networkInterfaces();
  const names = iface ? [iface] : Object.keys(ifaces).filter((n) => n.startsWith('zt'));
  for (const name of names) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return { ip: addr.address, iface: name };
      }
    }
  }
  return null;
}

// Espera (con backoff) hasta que la interfaz ZeroTier tenga IP.
export async function waitForZeroTier(iface = null, { intervalMs = 2000, maxWaitMs = 0 } = {}) {
  const start = Date.now();
  let logged = false;
  for (;;) {
    const found = findZeroTierIp(iface);
    if (found) return found;
    if (!logged) {
      console.log(
        `[zerotier] Esperando la interfaz ${iface || 'zt*'} de ZeroTier ` +
          `(¿zerotier-one levantando?). Reintentando cada ${intervalMs}ms...`,
      );
      logged = true;
    }
    if (maxWaitMs > 0 && Date.now() - start > maxWaitMs) {
      throw new Error(`No apareció la interfaz ZeroTier tras ${maxWaitMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
