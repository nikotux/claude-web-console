// core/claude-oauth.js — ÚNICO lugar del repo que ESCRIBE
// .claude/.credentials.json. Refresca el access token OAuth de Anthropic con
// el refreshToken, que ROTA: la respuesta trae uno nuevo y el anterior queda
// quemado, por eso la escritura es atómica y ocurre en el mismo paso que la
// llamada. Ninguna credencial se loguea nunca.
import fs from 'node:fs/promises';
import path from 'node:path';
import { userClaudeDir, hostUser } from './user-space.js';

const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
// client_id público del CLI de Claude Code (el mismo que usa `claude` para su
// propio refresh; sale del binario instalado, no es un secreto).
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Margen de seguridad: si al token le quedan menos de 5 min, lo renovamos ya.
const SKEW_MS = 5 * 60 * 1000;

const inFlight = new Map();
const credsFile = (owner) => path.join(userClaudeDir(owner), '.credentials.json');

async function readCreds(owner) {
  try {
    return JSON.parse(await fs.readFile(credsFile(owner), 'utf8'));
  } catch {
    return null;
  }
}

function isUsable(oauth) {
  return !!oauth?.accessToken
    && (!oauth.expiresAt || oauth.expiresAt - SKEW_MS > Date.now());
}

async function writeCreds(owner, full) {
  const file = credsFile(owner);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(full), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function doRefresh(owner) {
  try {
    const full = await readCreds(owner);
    const oauth = full?.claudeAiOauth;
    if (isUsable(oauth)) return oauth;
    if (!oauth?.refreshToken) return null;
    if (oauth.refreshTokenExpiresAt && oauth.refreshTokenExpiresAt <= Date.now()) {
      return null;
    }

    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 15000);
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: oauth.refreshToken,
          client_id: CLIENT_ID,
        }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;

    // Otro proceso puede haber renovado entre nuestra lectura y la respuesta.
    // Preferimos quemar esta respuesta antes que pisar el refresh del CLI.
    const fresh = await readCreds(owner);
    if (
      isUsable(fresh?.claudeAiOauth)
      && fresh.claudeAiOauth.expiresAt > oauth.expiresAt
    ) {
      return fresh.claudeAiOauth;
    }

    const next = {
      ...oauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    if (Array.isArray(data.scopes)) {
      next.scopes = data.scopes;
    } else if (typeof data.scope === 'string') {
      next.scopes = data.scope.split(' ').filter(Boolean);
    }
    if (data.subscription_type) next.subscriptionType = data.subscription_type;
    const refreshExpiresIn = Number(data.refresh_token_expires_in);
    if (data.refresh_token && refreshExpiresIn) {
      next.refreshTokenExpiresAt = Date.now() + refreshExpiresIn * 1000;
    }

    try {
      await writeCreds(owner, { ...(fresh || full), claudeAiOauth: next });
    } catch {
      // El token todavía sirve para esta llamada, pero se pierde para la próxima.
    }
    return next;
  } catch {
    return null;
  }
}

export function refreshClaudeOauth(owner = hostUser()) {
  const current = inFlight.get(owner);
  if (current) return current;

  const refresh = doRefresh(owner).finally(() => {
    if (inFlight.get(owner) === refresh) inFlight.delete(owner);
  });
  inFlight.set(owner, refresh);
  return refresh;
}

export async function getValidClaudeAccessToken(owner = hostUser()) {
  const oauth = (await readCreds(owner))?.claudeAiOauth;
  if (isUsable(oauth)) {
    return { token: oauth.accessToken, oauth, refreshed: false };
  }

  const next = await refreshClaudeOauth(owner);
  if (next?.accessToken) {
    return { token: next.accessToken, oauth: next, refreshed: true };
  }
  return null;
}
