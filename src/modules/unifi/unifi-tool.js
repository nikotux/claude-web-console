// Puente de SOLO LECTURA a UniFi para el chat (PLAN-774), hermano de codex-tool.js.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getDevices,
  getHealth,
  findClient,
} from './client.js';
import { scanToPad } from './inventory-shared.js';

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  return textResult({ error: String(err?.message || err) });
}

function healthSummary(health) {
  return (Array.isArray(health) ? health : []).map((h) => ({
    subsystem: h?.subsystem,
    status: h?.status,
  }));
}

function deviceNameByMac(devices) {
  const out = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    const mac = String(d?.macAddress || d?.mac || '').toLowerCase();
    if (mac) out.set(mac, d?.name || mac);
  }
  return out;
}

export function createUnifiToolServer() {
  const dispositivos = tool(
    'unifi_dispositivos',
    'Lista dispositivos UniFi de solo lectura con modelo, estado, firmware e IP.',
    {},
    async () => {
      try {
        const devices = await getDevices();
        return textResult((Array.isArray(devices) ? devices : []).map((d) => ({
          name: d?.name,
          model: d?.model,
          state: d?.state,
          firmwareVersion: d?.firmwareVersion,
          firmwareUpdatable: d?.firmwareUpdatable,
          ipAddress: d?.ipAddress,
        })));
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const cliente = tool(
    'unifi_cliente',
    'Busca clientes UniFi por hostname, nombre, IP o MAC y devuelve telemetria cruda relevante.',
    {
      query: z.string(),
    },
    async ({ query }) => {
      try {
        const clients = await findClient(query);
        return textResult((Array.isArray(clients) ? clients : []).map((c) => ({
          hostname: c?.hostname,
          name: c?.name,
          ip: c?.ip,
          mac: c?.mac,
          is_wired: c?.is_wired,
          signal: c?.signal,
          satisfaction: c?.satisfaction,
          ap_mac: c?.ap_mac,
          essid: c?.essid,
          channel: c?.channel,
          tx_retries: c?.tx_retries,
        })));
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const diagnosticar = tool(
    'unifi_diagnosticar',
    'Datos crudos para diagnosticar llamadas cortadas o internet lento de una persona, sin interpretar.',
    {
      persona: z.string(),
    },
    async ({ persona }) => {
      try {
        const [clients, health, devices] = await Promise.all([
          findClient(persona),
          getHealth(),
          getDevices(),
        ]);
        const apNames = deviceNameByMac(devices);
        return textResult({
          clientes: (Array.isArray(clients) ? clients : []).map((c) => {
            const apMac = String(c?.ap_mac || '').toLowerCase();
            return {
              identidad: c?.hostname || c?.name || c?.ip || c?.mac || '',
              señal: c?.signal,
              satisfaction: c?.satisfaction,
              ap: apNames.get(apMac) || c?.ap_mac || null,
              tx_retries: c?.tx_retries,
              is_wired: c?.is_wired,
            };
          }),
          saludSitio: healthSummary(health).filter((h) => ['wan', 'www', 'lan', 'wlan'].includes(String(h.subsystem || '').toLowerCase())),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const salud = tool(
    'unifi_salud',
    'Devuelve el estado crudo de salud de los subsistemas UniFi.',
    {},
    async () => {
      try {
        return textResult(healthSummary(await getHealth()));
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  const inventario = tool(
    'unifi_inventario',
    'Escanea inventario UniFi hacia Pad local y devuelve resumen. Solo lee UniFi; puede escribir Pad si dryRun no esta activo.',
    {
      dryRun: z.boolean().optional(),
    },
    async ({ dryRun }) => {
      try {
        const res = await scanToPad({ dryRun: dryRun === true });
        return textResult({
          created: res?.created,
          updated: res?.updated,
          retired: res?.retired,
          total: res?.total,
          errors: res?.errors,
          ...(res?.error ? { error: res.error } : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
    { alwaysLoad: true },
  );

  return createSdkMcpServer({
    name: 'unifi',
    version: '1.0.0',
    tools: [dispositivos, cliente, diagnosticar, salud, inventario],
  });
}
