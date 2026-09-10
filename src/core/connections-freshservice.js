// core/connections-freshservice.js — proveedor Freshservice por API key.
//
// Freshservice autentica cada request con HTTP Basic (API key como usuario y
// "X" como contraseña). Este módulo sólo verifica credenciales: no persiste ni
// loguea la API key y nunca construye una URL con texto sin validar.

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function freshserviceBaseUrl(domain) {
  const raw = String(domain || '').trim();
  if (!raw) throw new Error('Falta el dominio de Freshservice.');

  let hostname = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('Dominio de Freshservice inválido.');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.port
      || (parsed.pathname && parsed.pathname !== '/')
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('Dominio de Freshservice inválido.');
    }
    hostname = parsed.hostname;
  } else if (/[/?#:@\\]/.test(raw)) {
    throw new Error('Dominio de Freshservice inválido.');
  }

  const cleanHost = hostname.toLowerCase();
  const suffix = '.freshservice.com';
  const subdomain = cleanHost.endsWith(suffix)
    ? cleanHost.slice(0, -suffix.length)
    : cleanHost;
  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw new Error('Dominio de Freshservice inválido.');
  }

  return `https://${subdomain}.freshservice.com`;
}

export function authHeader(apiKey) {
  return `Basic ${Buffer.from(`${String(apiKey || '')}:X`, 'utf8').toString('base64')}`;
}

export async function verifyFreshservice({ domain, apiKey }) {
  let baseUrl;
  try {
    baseUrl = freshserviceBaseUrl(domain);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const cleanApiKey = String(apiKey || '').trim();
  if (!cleanApiKey) return { ok: false, error: 'Falta la API key de Freshservice.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v2/agents/me`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: authHeader(cleanApiKey),
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, error: 'Freshservice no respondió dentro de 15 segundos.' };
    }
    return { ok: false, error: 'No se pudo contactar a Freshservice.' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: 'Credenciales inválidas' };
  }
  if (response.status === 404) {
    return { ok: false, error: 'Dominio de Freshservice inexistente' };
  }
  if (!response.ok) {
    return { ok: false, error: `Freshservice respondió HTTP ${response.status}.` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'Freshservice devolvió una respuesta inválida.' };
  }
  const agent = payload?.agent || payload;
  const name = agent?.name
    || `${agent?.first_name || ''} ${agent?.last_name || ''}`.trim()
    || null;
  return {
    ok: true,
    email: agent?.email || null,
    name,
    id: agent?.id == null ? null : String(agent.id),
  };
}
