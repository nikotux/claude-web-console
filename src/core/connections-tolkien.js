// Tolkien no forma parte de connections-store porque no usa OAuth: su
// credencial es una cookie de sesión de Auth.js. El email y el vencimiento se
// consultan en el endpoint de sesión porque el token es un JWE cifrado y no se
// puede decodificar localmente. El valor de la cookie vive SOLO dentro del
// storageState; connections/tolkien.json contiene únicamente metadata.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';

export const TOLKIEN_BASE_URL = 'https://app.tolkien.mordorstaffing.com';
export const TOLKIEN_COOKIE_NAME = '__Secure-tolkien.session';
export const TOLKIEN_COOKIE_DOMAIN = '.tolkien.mordorstaffing.com';
export const TOLKIEN_SESSION_DEFAULT_DAYS = 30;
export const TOLKIEN_EXPIRY_WARN_DAYS = 3;

export function tolkienConnectionFile(dataDir) {
  return path.join(dataDir, 'connections', 'tolkien.json');
}

export function tolkienSessionFile(dataDir) {
  return path.join(dataDir, 'tolkien', 'session.json');
}

export function isValidTolkienCookie(value) {
  return typeof value === 'string'
    && value.length >= 20
    && value.length <= 8192
    && /^[\x21-\x3A\x3C-\x7E]+$/.test(value);
}

export function readTolkienConnection(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(tolkienConnectionFile(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

export function writeTolkienConnection(dataDir, data) {
  const file = tolkienConnectionFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  writeJsonAtomic(file, data, { mode: 0o600, space: 2 });
}

export function readTolkienSessionState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(tolkienSessionFile(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

export function writeTolkienSessionState(dataDir, state) {
  const file = tolkienSessionFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  writeJsonAtomic(file, state, { mode: 0o600, space: 2 });
}

export function deleteTolkienConnection(dataDir) {
  let removedConnection = false;
  let removedSession = false;
  for (const [file, markRemoved] of [
    [tolkienConnectionFile(dataDir), () => { removedConnection = true; }],
    [tolkienSessionFile(dataDir), () => { removedSession = true; }],
  ]) {
    try {
      fs.unlinkSync(file);
      markRemoved();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { removedConnection, removedSession };
}

export function buildTolkienStorageState(cookieValue, expiresEpochSeconds) {
  return {
    cookies: [{
      name: TOLKIEN_COOKIE_NAME,
      value: cookieValue,
      domain: TOLKIEN_COOKIE_DOMAIN,
      path: '/',
      expires: expiresEpochSeconds,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }],
    origins: [],
  };
}

export async function verifyTolkienSession(
  cookieValue,
  { timeoutMs = 30000, now = Date.now() } = {},
) {
  let res;
  try {
    res = await fetch(`${TOLKIEN_BASE_URL}/api/auth/session`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        cookie: `${TOLKIEN_COOKIE_NAME}=${cookieValue}`,
        accept: 'application/json',
        'user-agent': 'cwc-tolkien-login/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      ok: false,
      reason: 'network',
      message: 'No pude contactar a Tolkien para verificar la sesión.',
    };
  }

  if (res.status !== 200) {
    return {
      ok: false,
      reason: 'http',
      status: res.status,
      message: `Tolkien respondió HTTP ${res.status} al verificar la sesión.`,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      reason: 'parse',
      message: 'Tolkien devolvió una respuesta inesperada al verificar la sesión.',
    };
  }

  if (typeof body?.user?.email !== 'string' || !body.user.email.trim()) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'La cookie no corresponde a una sesión válida (venció o fue revocada). Volvé a iniciar sesión en Tolkien y reconectá.',
    };
  }

  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  let freshCookieValue = cookieValue;
  let rotated = false;
  let setCookieExpiresAt = null;
  for (const entry of setCookies) {
    if (!entry.startsWith(`${TOLKIEN_COOKIE_NAME}=`)) continue;
    const [cookiePair, ...attributes] = entry.split(';');
    const candidate = cookiePair.slice(TOLKIEN_COOKIE_NAME.length + 1);
    if (
      candidate
      && candidate !== cookieValue
      && isValidTolkienCookie(candidate)
    ) {
      freshCookieValue = candidate;
      rotated = true;
    }
    const expiresAttribute = attributes.find((attribute) => /^\s*expires=/i.test(attribute));
    if (expiresAttribute) {
      const parsed = Date.parse(expiresAttribute.replace(/^\s*expires=/i, ''));
      if (Number.isFinite(parsed)) setCookieExpiresAt = parsed;
    }
    break;
  }

  const bodyExpiresAt = Date.parse(body.expires);
  let expiresAt;
  let expiresAtSource;
  if (Number.isFinite(bodyExpiresAt)) {
    expiresAt = bodyExpiresAt;
    expiresAtSource = 'server';
  } else if (setCookieExpiresAt !== null) {
    expiresAt = setCookieExpiresAt;
    expiresAtSource = 'server';
  } else {
    expiresAt = now + TOLKIEN_SESSION_DEFAULT_DAYS * 24 * 3600 * 1000;
    expiresAtSource = 'estimated';
  }

  return {
    ok: true,
    email: body.user.email.trim(),
    name: body.user?.name ?? null,
    expiresAt,
    expiresAtSource,
    cookieValue: freshCookieValue,
    rotated,
  };
}

export function tolkienStatus(dataDir, now = Date.now()) {
  const connection = readTolkienConnection(dataDir);
  if (!connection) {
    return {
      connected: false,
      account: null,
      name: null,
      connectedAt: null,
      verifiedAt: null,
      expiresAt: null,
      expiresAtSource: null,
      daysLeft: null,
      expiringSoon: false,
      expired: false,
    };
  }

  const expiresAt = Number.isFinite(connection.expiresAt) ? connection.expiresAt : null;
  const expired = expiresAt !== null && expiresAt <= now;
  const daysLeft = expiresAt === null
    ? null
    : Math.max(0, Math.ceil((expiresAt - now) / 86400000));
  const expiringSoon = !expired
    && daysLeft !== null
    && daysLeft <= TOLKIEN_EXPIRY_WARN_DAYS;
  return {
    connected: true,
    account: connection.account ?? null,
    name: connection.name ?? null,
    connectedAt: connection.connectedAt ?? null,
    verifiedAt: connection.verifiedAt ?? null,
    expiresAt,
    expiresAtSource: connection.expiresAtSource ?? null,
    daysLeft,
    expiringSoon,
    expired,
  };
}
