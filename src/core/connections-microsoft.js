// core/connections-microsoft.js — proveedor Microsoft por Device Code Flow.
//
// Esta plomería habla directo con Microsoft Entra ID y Graph sin tocar disco:
// el device flow no requiere redirect URI, así que funciona bien detrás de
// ZeroTier o redes privadas. Los tokens son secretos del caller; este módulo no
// los persiste ni los loguea.

// Mail.Read alcanza para el buzón propio (/me); Mail.Read.Shared es lo que
// habilita leer un buzón compartido como accounting@ desde la cuenta conectada.
export const MS_SCOPES = [
  'offline_access',
  'User.Read',
  'Calendars.ReadWrite',
  'Mail.Read',
  'Mail.Read.Shared',
  'Sites.ReadWrite.All',
];

function authority(tenantId) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId || 'common')}/oauth2/v2.0`;
}

async function postForm(url, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') body.set(key, value);
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new Error('No se pudo contactar a Microsoft: ' + (err?.message || err));
  }

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  return { ok: res.ok, status: res.status, data, raw: data ? null : text.slice(0, 300) };
}

function msError(r) {
  return r.data?.error_description || r.data?.error || r.raw || ('HTTP ' + r.status);
}

export async function startDeviceFlow({ clientId, tenantId }) {
  if (!clientId) throw new Error('Falta el Client ID de la app de Microsoft.');

  const r = await postForm(`${authority(tenantId)}/devicecode`, {
    client_id: clientId,
    scope: MS_SCOPES.join(' '),
  });
  if (!r.ok || !r.data?.device_code) throw new Error(msError(r));

  const data = r.data;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || data.verification_uri_complete || '',
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
}

export async function pollDeviceToken({ clientId, tenantId, deviceCode }) {
  const r = await postForm(`${authority(tenantId)}/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
  });

  if (r.ok && r.data?.access_token) return { status: 'ok', tokens: r.data };
  if (r.data?.error === 'authorization_pending') return { status: 'pending' };
  if (r.data?.error === 'slow_down') return { status: 'slow_down' };
  throw new Error(msError(r));
}

export async function refreshAccessToken({ clientId, tenantId, refreshToken }) {
  if (!refreshToken) throw new Error('No hay refresh token de Microsoft.');

  const r = await postForm(`${authority(tenantId)}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: MS_SCOPES.join(' '),
  });
  if (!r.ok || !r.data?.access_token) throw new Error(msError(r));

  // Azure puede rotar el refresh token; el caller debe re-persistirlo si viene.
  return r.data;
}

export async function getMe(accessToken) {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const me = await res.json();
    return me?.userPrincipalName || me?.mail || me?.displayName || null;
  } catch {
    return null;
  }
}
