// Cliente de solo lectura al UDM Pro: usa la API Integration y la API interna
// de Network con API key desde .env y TLS self-signed limitado a estas requests.
import https from 'node:https';
import { config } from '../../core/config.js';

const agent = new https.Agent({ rejectUnauthorized: false });
const REQUEST_TIMEOUT_MS = 15000;

let cachedSiteId = null;

function ensureConfigured() {
  if (!config.unifi?.host || !config.unifi?.apiKey) {
    throw new Error('Puente UniFi no configurado: falta UNIFI_HOST/UNIFI_API_KEY en .env');
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function segment(value) {
  return encodeURIComponent(String(value ?? ''));
}

function apiGet(pathStr) {
  ensureConfigured();

  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, `https://${config.unifi.host}`);

    const req = https.request(
      url,
      {
        method: 'GET',
        agent,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'X-API-KEY': config.unifi.apiKey,
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            reject(new Error(`Error HTTP UniFi ${status} al consultar ${pathStr}`));
            return;
          }

          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (err) {
            reject(new Error(`Respuesta UniFi no es JSON valido en ${pathStr}: ${err.message}`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout UniFi tras ${REQUEST_TIMEOUT_MS / 1000}s al consultar ${pathStr}`));
    });

    req.on('error', (err) => {
      reject(new Error(`Error de red UniFi al consultar ${pathStr}: ${err.message}`));
    });

    req.end();
  });
}

export async function getSites() {
  const payload = await apiGet('/proxy/network/integration/v1/sites');
  return asArray(payload?.data);
}

export async function resolveSiteId() {
  if (cachedSiteId) {
    return cachedSiteId;
  }

  const sites = await getSites();
  const preferredSite = sites.find((site) => site?.internalReference === config.unifi?.site);
  const selectedSite = preferredSite ?? sites[0];

  if (!selectedSite?.id) {
    throw new Error('No se pudo resolver el site UniFi: la API no devolvio sites con id');
  }

  cachedSiteId = selectedSite.id;
  return cachedSiteId;
}

export async function getDevices() {
  const siteId = await resolveSiteId();
  const payload = await apiGet(`/proxy/network/integration/v1/sites/${segment(siteId)}/devices`);
  return asArray(payload?.data);
}

export async function getNetworks() {
  const site = config.unifi?.site || 'default';
  const payload = await apiGet(`/proxy/network/api/s/${segment(site)}/rest/networkconf`);
  return asArray(payload?.data);
}

export async function getWlans() {
  const site = config.unifi?.site || 'default';
  const payload = await apiGet(`/proxy/network/api/s/${segment(site)}/rest/wlanconf`);
  return asArray(payload?.data);
}

export async function getFixedClients() {
  const site = config.unifi?.site || 'default';
  const payload = await apiGet(`/proxy/network/api/s/${segment(site)}/rest/user`);
  return asArray(payload?.data).filter((client) => client?.use_fixedip === true);
}

export async function getFirewallPolicies() {
  const siteId = await resolveSiteId();
  const limit = 200;
  const policies = [];

  for (let offset = 0; ; offset += limit) {
    const payload = await apiGet(
      `/proxy/network/integration/v1/sites/${segment(siteId)}/firewall/policies?offset=${offset}&limit=${limit}`,
    );
    const page = asArray(payload?.data);
    policies.push(...page);

    const totalCount = Number(payload?.totalCount);
    if (Number.isFinite(totalCount) && policies.length >= totalCount) {
      break;
    }

    if (!page.length || page.length < limit) {
      break;
    }
  }

  return policies;
}

export async function getGatewayStats(deviceId) {
  const siteId = await resolveSiteId();
  return apiGet(
    `/proxy/network/integration/v1/sites/${segment(siteId)}/devices/${segment(deviceId)}/statistics/latest`,
  );
}

export async function getClients() {
  const site = config.unifi?.site || 'default';
  const payload = await apiGet(`/proxy/network/api/s/${segment(site)}/stat/sta`);
  return asArray(payload?.data);
}

export async function getHealth() {
  const site = config.unifi?.site || 'default';
  const payload = await apiGet(`/proxy/network/api/s/${segment(site)}/stat/health`);
  return asArray(payload?.data);
}

export async function findClient(query) {
  const needle = String(query ?? '').toLowerCase();

  if (!needle) {
    return [];
  }

  const clients = await getClients();
  return clients.filter((client) => {
    const fields = [client?.hostname, client?.name, client?.ip, client?.mac];
    return fields.some((value) => String(value ?? '').toLowerCase().includes(needle));
  });
}

export async function getDeviceStats() {
  const site = config.unifi?.site || 'default';
  const payload = await apiGet(`/proxy/network/api/s/${segment(site)}/stat/device`);
  return asArray(payload?.data);
}
