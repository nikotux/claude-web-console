// Cliente de solo lectura al UDM Pro: usa la API Integration y la API interna
// de Network con API key desde .env y TLS self-signed limitado a estas requests.
import https from 'node:https';
import tls from 'node:tls';
import { config } from '../../core/config.js';

const REQUEST_TIMEOUT_MS = 15000;
const rawPinnedFingerprint = process.env.UNIFI_CERT_SHA256?.trim() || null;

function markedError(message, mark, extra = {}) {
  const err = new Error(message);
  err[mark] = true;
  Object.assign(err, extra);
  return err;
}

function normalizeFingerprint(value) {
  return String(value || '').replace(/:/g, '').toUpperCase();
}

const pinnedFingerprint = normalizeFingerprint(rawPinnedFingerprint);

function checkServerIdentity(_hostname, cert) {
  const actual = normalizeFingerprint(cert?.fingerprint256);
  if (!actual || actual !== pinnedFingerprint) {
    return markedError('La huella SHA-256 del certificado UniFi no coincide', 'upstream');
  }
  return undefined;
}

function createAgent() {
  const agent = new https.Agent({
    rejectUnauthorized: false,
    ...(pinnedFingerprint ? { checkServerIdentity } : {}),
  });
  if (!pinnedFingerprint) {
    return agent;
  }

  // El UDM usa certificado self-signed: la huella opcional reemplaza la CA
  // como ancla de confianza y se valida antes de entregar el socket al request.
  agent.createConnection = (options, callback) => {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      socket.removeListener('secureConnect', onSecureConnect);
      socket.removeListener('error', onError);
      if (err) {
        socket.destroy();
        callback(err);
        return;
      }
      callback(null, socket);
    }

    function onSecureConnect() {
      finish(checkServerIdentity(options.servername || options.host, socket.getPeerCertificate()));
    }

    function onError(err) {
      finish(markedError(`Error TLS UniFi: ${err.message}`, 'upstream'));
    }

    socket.once('secureConnect', onSecureConnect);
    socket.once('error', onError);
  };

  return agent;
}

const agent = createAgent();

let cachedSiteId = null;

function ensureConfigured() {
  if (!config.unifi?.host || !config.unifi?.apiKey) {
    throw markedError(
      'Puente UniFi no configurado: falta UNIFI_HOST/UNIFI_API_KEY en .env',
      'notConfigured',
    );
  }
  if (rawPinnedFingerprint && !/^[A-F0-9]{64}$/.test(pinnedFingerprint)) {
    throw markedError('UNIFI_CERT_SHA256 no contiene una huella SHA-256 valida', 'notConfigured');
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
  let url;
  try {
    url = new URL(pathStr, `https://${config.unifi.host}`);
  } catch {
    throw markedError('UNIFI_HOST no contiene un host valido', 'notConfigured');
  }

  return new Promise((resolve, reject) => {
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
            reject(markedError(
              `Error HTTP UniFi ${status} al consultar ${pathStr}`,
              'upstream',
              { status },
            ));
            return;
          }

          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (err) {
            reject(markedError(
              `Respuesta UniFi no es JSON valido en ${pathStr}: ${err.message}`,
              'upstream',
            ));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(markedError(
        `Timeout UniFi tras ${REQUEST_TIMEOUT_MS / 1000}s al consultar ${pathStr}`,
        'upstream',
      ));
    });

    req.on('error', (err) => {
      reject(markedError(`Error de red UniFi al consultar ${pathStr}: ${err.message}`, 'upstream'));
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
  const configuredSite = config.unifi?.site?.trim();
  let selectedSite;

  if (configuredSite) {
    selectedSite = sites.find((site) => site?.internalReference === configuredSite);
    if (!selectedSite) {
      throw markedError(
        `El site UniFi configurado '${configuredSite}' no existe en la API Integration`,
        'notConfigured',
      );
    }
  } else {
    selectedSite = sites[0];
    if (sites.length > 1) {
      console.warn('[unifi] Hay varios sites y UNIFI_SITE no está definido; se usará el primero');
    }
  }

  if (!selectedSite?.id) {
    throw markedError('No se pudo resolver el site UniFi: la API no devolvio sites con id', 'upstream');
  }

  cachedSiteId = selectedSite.id;
  return cachedSiteId;
}

async function integrationGet(pathForSite) {
  let siteId = await resolveSiteId();
  try {
    return await apiGet(pathForSite(siteId));
  } catch (err) {
    if (err?.status !== 404) {
      throw err;
    }
    cachedSiteId = null;
    siteId = await resolveSiteId();
    return apiGet(pathForSite(siteId));
  }
}

export async function getDevices() {
  const payload = await integrationGet(
    (siteId) => `/proxy/network/integration/v1/sites/${segment(siteId)}/devices`,
  );
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
  const limit = 200;
  const policies = [];

  for (let offset = 0; ; offset += limit) {
    const payload = await integrationGet(
      (siteId) => `/proxy/network/integration/v1/sites/${segment(siteId)}/firewall/policies?offset=${offset}&limit=${limit}`,
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
  return integrationGet(
    (siteId) => `/proxy/network/integration/v1/sites/${segment(siteId)}/devices/${segment(deviceId)}/statistics/latest`,
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
