// core/connections-store.js — store mínimo para conexiones externas.
//
// La CONFIG DE LA APP OAuth puede ser de INSTANCIA o tener un override completo
// POR-USUARIO. Los TOKENS OAuth y credenciales API también son per-usuario.
// Todo se escribe 0600 y de forma ATÓMICA para no dejar credenciales corruptas
// a mitad de escritura.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { config } from './config.js';
import { userDataDir } from './user-space.js';
import * as ms from './connections-microsoft.js';
import * as zoho from './connections-zoho.js';

export const PROVIDERS = [
  { id: 'microsoft', label: 'Microsoft 365 (Correo, Calendario, Archivos, SharePoint, Teams, Contactos y Tareas)', kind: 'oauth', scopes: ms.MS_SCOPES },
  { id: 'zoho', label: 'Zoho (Desk, CRM y Projects)', kind: 'oauth', scopes: zoho.ZOHO_SCOPES },
  // Freshservice se retiró de la interfaz por pedido de Niko (2026-09-14) al no ser relevante:
  // nadie la tenía conectada ni había credenciales guardadas. El módulo
  // `connections-freshservice.js` y sus endpoints /freshservice/connect, /disconnect y /status
  // siguen en el código, inertes; para reponerla alcanza con volver a agregar la entrada a este array.
];

// El archivo de la app OAuth de INSTANCIA se ancla a `config.home`, NUNCA a
// `os.homedir`: en POSIX `os.homedir` sigue a $HOME, y el runner de chat de un
// inquilino corre con HOME=~/.cwc-users/<id>. Con `os.homedir` la app de instancia
// se volvía INVISIBLE dentro de ese runner y el refresh del token salía con clientId
// vacío — síntoma: el chat contestaba "Microsoft no está conectado" mientras el panel
// de Conexiones mostraba la cuenta sana. `config.home` sale de CWC_HOME y no lo afecta.
const APP_FILE = path.join(config.home, '.cwc-data', 'connections', '_app.json');
const DEFAULT_APP_CONFIG = {
  microsoft: { clientId: '', tenantId: 'common' },
  zoho: { clientId: '', clientSecret: '', dc: 'com' },
};

export const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function cleanString(value) {
  return String(value || '').trim();
}

export function readAppConfig() {
  const raw = readJson(APP_FILE) || {};
  const microsoft = raw.microsoft || {};
  const zohoCfg = raw.zoho || {};

  return {
    microsoft: {
      clientId: cleanString(microsoft.clientId),
      tenantId: cleanString(microsoft.tenantId) || DEFAULT_APP_CONFIG.microsoft.tenantId,
    },
    zoho: {
      clientId: cleanString(zohoCfg.clientId),
      clientSecret: cleanString(zohoCfg.clientSecret),
      dc: cleanString(zohoCfg.dc) || DEFAULT_APP_CONFIG.zoho.dc,
    },
  };
}

export function writeAppConfig(patch) {
  const cfg = readAppConfig();
  const allowed = {
    microsoft: ['clientId', 'tenantId'],
    zoho: ['clientId', 'clientSecret', 'dc'],
  };

  for (const [provider, keys] of Object.entries(allowed)) {
    if (!patch?.[provider] || typeof patch[provider] !== 'object') continue;
    for (const key of keys) {
      if (Object.hasOwn(patch[provider], key)) {
        cfg[provider][key] = cleanString(patch[provider][key]);
      }
    }
  }
  cfg.microsoft.tenantId = cfg.microsoft.tenantId || DEFAULT_APP_CONFIG.microsoft.tenantId;
  cfg.zoho.dc = cfg.zoho.dc || DEFAULT_APP_CONFIG.zoho.dc;

  writeJsonAtomic(APP_FILE, cfg, { mode: 0o600 });
  return cfg;
}

export function appConfigured(provider) {
  const cfg = readAppConfig()[provider];
  if (!cfg) return false;
  if (provider === 'zoho') return !!cfg.clientId && !!cfg.clientSecret;
  return !!cfg.clientId;
}

function userConnDir(username) {
  return path.join(userDataDir(username), 'connections');
}

function userAppFile(username) {
  return path.join(userConnDir(username), '_app.json');
}

function userAppStorageFile(username) {
  const file = userAppFile(username);
  // El host conserva userDataDir(host) === HOME por retrocompatibilidad, por lo
  // que su _app.json colisionaría con APP_FILE. Su override va al archivo
  // hermano para no leer ni sobrescribir la app de instancia como si fuera suyo.
  return path.resolve(file) === path.resolve(APP_FILE)
    ? path.join(userConnDir(username), '_app-user.json')
    : file;
}

export function readUserAppConfig(username) {
  const raw = readJson(userAppStorageFile(username)) || {};
  const microsoft = raw.microsoft || {};
  const zohoCfg = raw.zoho || {};

  return {
    microsoft: {
      clientId: cleanString(microsoft.clientId),
      tenantId: cleanString(microsoft.tenantId),
    },
    zoho: {
      clientId: cleanString(zohoCfg.clientId),
      clientSecret: cleanString(zohoCfg.clientSecret),
      dc: cleanString(zohoCfg.dc),
    },
  };
}

export function writeUserAppConfig(username, patch) {
  const cfg = readUserAppConfig(username);
  const allowed = {
    microsoft: ['clientId', 'tenantId'],
    zoho: ['clientId', 'clientSecret', 'dc'],
  };

  for (const [provider, keys] of Object.entries(allowed)) {
    if (!patch?.[provider] || typeof patch[provider] !== 'object') continue;
    for (const key of keys) {
      if (Object.hasOwn(patch[provider], key)) {
        cfg[provider][key] = cleanString(patch[provider][key]);
      }
    }
  }

  // writeJsonAtomic crea el directorio privado si falta.
  writeJsonAtomic(userAppStorageFile(username), cfg, { mode: 0o600 });
  return cfg;
}

export function clearUserAppConfig(username, provider) {
  const empty = provider === 'microsoft'
    ? { clientId: '', tenantId: '' }
    : provider === 'zoho'
      ? { clientId: '', clientSecret: '', dc: '' }
      : null;
  if (!empty) return readUserAppConfig(username);

  // Se deja el archivo vacío por proveedor: es más simple y mantiene intacto
  // el override del otro proveedor.
  return writeUserAppConfig(username, { [provider]: empty });
}

export function userAppComplete(username, provider) {
  const cfg = readUserAppConfig(username)[provider];
  if (!cfg) return false;
  if (provider === 'zoho') return !!cfg.clientId && !!cfg.clientSecret;
  return provider === 'microsoft' && !!cfg.clientId;
}

function withProviderDefaults(provider, cfg, source) {
  if (provider === 'microsoft') {
    return {
      clientId: cleanString(cfg?.clientId),
      tenantId: cleanString(cfg?.tenantId) || DEFAULT_APP_CONFIG.microsoft.tenantId,
      source,
    };
  }
  if (provider === 'zoho') {
    return {
      clientId: cleanString(cfg?.clientId),
      clientSecret: cleanString(cfg?.clientSecret),
      dc: cleanString(cfg?.dc) || DEFAULT_APP_CONFIG.zoho.dc,
      source,
    };
  }
  return null;
}

export function effectiveAppConfig(username, provider) {
  const userCfg = readUserAppConfig(username);
  const instanceCfg = readAppConfig();

  // La elección es TODO O NADA por proveedor. Si el override del usuario está
  // completo se usa ENTERO; si no, se usa ENTERA la config de instancia. NUNCA
  // se mezcla el clientId de un usuario con el clientSecret de la instancia:
  // esa mezcla es exactamente el error corregido y produciría invalid_client.
  if (userAppComplete(username, provider)) {
    return withProviderDefaults(provider, userCfg[provider], 'user');
  }
  return withProviderDefaults(provider, instanceCfg[provider], 'instance');
}

export function appConfiguredFor(username, provider) {
  return userAppComplete(username, provider) || appConfigured(provider);
}

function appConfigForConnection(username, provider, connection) {
  const appClientId = cleanString(connection?.appClientId);
  if (!appClientId) return { [provider]: effectiveAppConfig(username, provider) };

  const userCfg = readUserAppConfig(username);
  if (userAppComplete(username, provider) && userCfg[provider]?.clientId === appClientId) {
    return { [provider]: withProviderDefaults(provider, userCfg[provider], 'user') };
  }

  const instanceCfg = readAppConfig();
  if (instanceCfg[provider]?.clientId === appClientId) {
    return { [provider]: withProviderDefaults(provider, instanceCfg[provider], 'instance') };
  }

  return { [provider]: effectiveAppConfig(username, provider) };
}

function connFile(username, provider) {
  return path.join(userConnDir(username), `${provider}.json`);
}

function jobFile(username, jobId) {
  return path.join(userConnDir(username), 'jobs', `${jobId}.json`);
}

export function readConnection(username, provider) {
  return readJson(connFile(username, provider));
}

export function writeConnection(username, provider, data) {
  writeJsonAtomic(connFile(username, provider), data, { mode: 0o600 });
  return data;
}

export function deleteConnection(username, provider) {
  try {
    fs.rmSync(connFile(username, provider), { force: true });
  } catch {
    // Borrar una conexión debe ser idempotente aunque el archivo no exista.
  }
  return true;
}

// Descarta los intentos de conexión de ese usuario para ese proveedor (borra
// los jobs). Se usa para "Cancelar intento": la tarjeta vuelve a "sin conectar".
export function cancelAttempts(username, provider) {
  let removed = 0;
  try {
    const dir = path.join(userConnDir(username), 'jobs');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      const j = readJson(full);
      if (!j || j.provider !== provider) continue;
      try { fs.unlinkSync(full); removed++; } catch { /* best-effort */ }
    }
  } catch { /* sin jobs */ }
  return removed;
}

export function connectionStatus(username, provider) {
  const c = readConnection(username, provider);
  const meta = PROVIDERS.find((p) => p.id === provider);
  if (meta?.kind === 'apikey') {
    const credential = apiCredentialFromConnection(provider, c);
    return {
      connected: !!credential,
      account: credential ? c?.email ?? null : null,
      connectedAt: credential ? c?.connectedAt ?? null : null,
      error: null,
      domain: credential?.domain ?? null,
      email: credential ? c?.email ?? null : null,
      name: credential ? c?.name ?? null : null,
    };
  }
  return {
    connected: !!c,
    account: c?.account ?? null,
    connectedAt: c?.connectedAt ?? null,
    error: c?.error ?? null,
  };
}

// Último intento de conexión de ese usuario para ese proveedor (para que la UI
// distinga "nunca intentó" de "intentó y quedó a medias" — p.ej. esperando la
// aprobación del admin del tenant). Best-effort: si no hay jobs, null.
export function lastAttempt(username, provider) {
  try {
    const dir = path.join(userConnDir(username), 'jobs');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    let best = null;
    for (const f of files) {
      const j = readJson(path.join(dir, f));
      if (!j || j.provider !== provider) continue;
      if (!best || (j.createdAt || 0) > (best.createdAt || 0)) best = j;
    }
    if (!best) return null;
    return { status: best.status || 'unknown', error: best.error || null, at: best.createdAt || null };
  } catch {
    return null;
  }
}

export function newJobId() {
  return crypto.randomUUID().replace(/-/g, '');
}

export function readJob(username, jobId) {
  if (!JOB_ID_RE.test(jobId || '')) return null;
  return readJson(jobFile(username, jobId));
}

export function writeJob(username, jobId, data) {
  if (!JOB_ID_RE.test(jobId || '')) {
    throw Object.assign(new Error('jobId inválido'), { badRequest: true });
  }
  writeJsonAtomic(jobFile(username, jobId), data, { mode: 0o600 });
  return data;
}

export async function getAccessToken(username, provider) {
  const meta = PROVIDERS.find((p) => p.id === provider);
  if (meta?.kind === 'apikey') {
    throw new Error(`${provider} no usa OAuth: usá getApiCredential()`);
  }
  const c = readConnection(username, provider);
  if (!c) throw new Error(`Sin conexión de ${provider} para este usuario.`);
  if (c.accessToken && c.expiresAt > Date.now() + 60_000) return c.accessToken;

  // El refresh token de un Self Client sólo vale para el client_id que lo emitió.
  // Por eso la conexión guarda `appClientId` y acá se elige la config que COINCIDE
  // (la del usuario o la de instancia), y sólo si no hay match se cae a la
  // efectiva. Refrescar con el client_id equivocado invalida la conexión entera.
  const cfg = appConfigForConnection(username, provider, c);
  let t;
  if (provider === 'microsoft') {
    const { clientId, tenantId } = cfg.microsoft;
    const scopes = Array.isArray(c.scopes) && c.scopes.length > 0 ? c.scopes : undefined;
    t = await ms.refreshAccessToken({ clientId, tenantId, refreshToken: c.refreshToken, scopes });
  } else if (provider === 'zoho') {
    const { clientId, clientSecret, dc } = cfg.zoho;
    t = await zoho.refreshAccessToken({ clientId, clientSecret, refreshToken: c.refreshToken, dc });
  } else {
    throw new Error(`Proveedor inválido: ${provider}`);
  }

  const next = {
    ...c,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || c.refreshToken,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    error: null,
  };
  writeConnection(username, provider, next);
  return next.accessToken;
}

function apiCredentialFromConnection(provider, connection) {
  if (provider !== 'freshservice') return null;
  const domain = cleanString(connection?.domain);
  const apiKey = cleanString(connection?.apiKey);
  return domain && apiKey ? { domain, apiKey } : null;
}

// Puerta ÚNICA a credenciales estáticas. Los endpoints de estado usan
// connectionStatus(), que construye una vista segura sin incluir apiKey.
export function getApiCredential(username, provider) {
  const meta = PROVIDERS.find((p) => p.id === provider);
  if (meta?.kind !== 'apikey') return null;
  return apiCredentialFromConnection(provider, readConnection(username, provider));
}
