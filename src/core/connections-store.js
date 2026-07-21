// core/connections-store.js — store mínimo para conexiones OAuth externas.
//
// La CONFIG DE LA APP OAuth es de nivel INSTANCIA: una app sirve a todos los
// usuarios, que es el modelo normal de OAuth. Vive en
// ~/.cwc-data/connections/_app.json. Los TOKENS son PER-USUARIO y viven en
// userDataDir(username)/connections/<provider>.json. Todo se escribe 0600 y de
// forma ATÓMICA para no dejar credenciales corruptas a mitad de escritura.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { userDataDir } from './user-space.js';
import * as ms from './connections-microsoft.js';
import * as zoho from './connections-zoho.js';

export const PROVIDERS = [
  { id: 'microsoft', label: 'Microsoft (Calendario)', scopes: ms.MS_SCOPES },
  { id: 'zoho', label: 'Zoho (Desk)', scopes: zoho.ZOHO_SCOPES },
];

const APP_FILE = path.join(os.homedir(), '.cwc-data', 'connections', '_app.json');
const DEFAULT_APP_CONFIG = {
  microsoft: { clientId: '', tenantId: 'common' },
  zoho: { clientId: '', clientSecret: '', dc: 'com' },
};

export const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isProvider(id) {
  return PROVIDERS.some((p) => p.id === id);
}

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
  const c = readConnection(username, provider);
  if (!c) throw new Error(`Sin conexión de ${provider} para este usuario.`);
  if (c.accessToken && c.expiresAt > Date.now() + 60_000) return c.accessToken;

  const cfg = readAppConfig();
  let t;
  if (provider === 'microsoft') {
    const { clientId, tenantId } = cfg.microsoft;
    t = await ms.refreshAccessToken({ clientId, tenantId, refreshToken: c.refreshToken });
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
