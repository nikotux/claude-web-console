// core/connections-zoho.js — proveedor Zoho Desk por grant code pegado.
//
// Zoho no ofrece device flow: el usuario genera un grant code en la consola de
// API de su data center y lo pega en la consola, igual que otros flujos de
// "pegar código". Este módulo solo hace HTTP; no persiste ni loguea secretos.

export const ZOHO_SCOPES = ['Desk.tickets.ALL', 'Desk.contacts.READ', 'Desk.contacts.CREATE', 'Desk.basic.READ', 'Desk.settings.READ', 'Desk.search.READ'];

const ZOHO_DCS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca'];

function dcOf(dc) {
  const clean = String(dc || '').trim().toLowerCase();
  return ZOHO_DCS.includes(clean) ? clean : 'com';
}

function accountsBase(dc) {
  return `https://accounts.zoho.${dcOf(dc)}`;
}

function deskBase(dc) {
  return `https://desk.zoho.${dcOf(dc)}`;
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
    throw new Error('No se pudo contactar a Zoho: ' + (err?.message || err));
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

function zohoError(r) {
  return r.data?.error_description || r.data?.error || r.raw || ('HTTP ' + r.status);
}

// Zoho devuelve el MISMO `invalid_code` para tres situaciones muy distintas y el
// usuario no tiene forma de saber cuál le tocó. Este texto es la diferencia entre
// "no funciona" y "ah, tengo que generar el código en MI Self Client".
export function explainZohoError(raw) {
  const text = String(raw || '');
  if (text.includes('invalid_code')) {
    return 'Zoho rechazó el grant code (invalid_code). Suele ser por una de tres cosas: (1) el código se generó en una app DISTINTA a la que usa la consola — un Self Client sólo puede generar códigos para sí mismo, así que si en tu API Console no ves la app de la consola, cargá acá tu propio Client ID y Secret; (2) el código ya se usó (son de un solo uso); (3) se venció (duran entre 3 y 10 minutos). Generá uno nuevo y pegalo apenas lo tengas.';
  }
  if (text.includes('invalid_client')) {
    return 'Zoho rechazó las credenciales de la app (invalid_client): el Client ID y el Client Secret no son del mismo Self Client, o están mal copiados.';
  }
  return text;
}

export function authUrl({ clientId, dc }) {
  return `https://api-console.zoho.${dcOf(dc)}`;
}

export async function exchangeCode({ clientId, clientSecret, code, dc }) {
  if (!clientId) throw new Error('Falta el Client ID de la app de Zoho.');
  if (!clientSecret) throw new Error('Falta el Client Secret de la app de Zoho.');
  if (!code) throw new Error('Falta el grant code de Zoho.');

  const r = await postForm(`${accountsBase(dc)}/oauth/v2/token`, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    access_type: 'offline',
  });
  if (!r.data?.access_token || !r.data?.refresh_token) throw new Error(zohoError(r));
  return r.data;
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken, dc }) {
  const r = await postForm(`${accountsBase(dc)}/oauth/v2/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  if (!r.data?.access_token) throw new Error(zohoError(r));
  return r.data;
}

// La API de Desk exige el header `orgId` en TODA llamada. Se descubre una vez
// al conectar y se persiste con la conexión para las operaciones futuras.
export async function getOrg(accessToken, dc) {
  try {
    const res = await fetch(`${deskBase(dc)}/api/v1/organizations`, {
      headers: { authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
    const org = list[0];
    if (!org?.id) return null;
    return { id: String(org.id), name: org.companyName || org.name || null };
  } catch {
    return null;
  }
}

// Zoho Desk NO tiene endpoint de "mi agente" (404 verificado). Se resuelve al
// agente listando agentes y matcheando por email - mismo criterio que
// seguimientos/desk-source.js. Devuelve también el agentId, que hace falta para
// operar a nombre del usuario (p.ej. asignarse un ticket).
// OJO multiusuario: el email lo provee el llamador; hoy sale de la identidad de
// instancia (un solo usuario). Cuando haya varios, debe ser el email del usuario
// que conectó ESTA cuenta, no el de la instancia.
export async function getMe(accessToken, dc, orgId, email) {
  try {
    const headers = { authorization: `Zoho-oauthtoken ${accessToken}` };
    if (orgId) headers.orgId = String(orgId);
    const res = await fetch(`${deskBase(dc)}/api/v1/agents?limit=100`, { headers });
    if (!res.ok) return null;
    const j = await res.json();
    const list = Array.isArray(j?.data) ? j.data : [];
    const want = String(email || '').trim().toLowerCase();
    const me = want
      ? list.find((a) => String(a.emailId || a.email || '').toLowerCase() === want)
      : null;
    if (!me) return null;
    const name = me.name || `${me.firstName || ''} ${me.lastName || ''}`.trim();
    return { email: me.emailId || me.email || null, id: me.id ? String(me.id) : null, name: name || null };
  } catch {
    // Perfil best-effort: si falla, la conexión NO se rompe (queda sin account).
    return null;
  }
}
