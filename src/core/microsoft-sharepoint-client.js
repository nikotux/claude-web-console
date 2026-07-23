// core/microsoft-sharepoint-client.js — cliente directo a Graph SharePoint con identidad de USUARIO.
//
// Las sesiones de chat necesitan leer y escribir documentos de SharePoint sin
// pasar por el HTTP interno de la consola. Este módulo resuelve el token OAuth
// de Microsoft por username y traduce URLs pegadas desde el navegador a rutas
// de drive de Graph, donde la biblioteca por defecto ya es la raíz.
import fs from 'node:fs';
import path from 'node:path';
import { getAccessToken } from './connections-store.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SITE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_LIST_ITEMS = 2000;
const SMALL_UPLOAD_LIMIT = 4 * 1024 * 1024;
const CHUNK_SIZE = 5 * 1024 * 1024;
const siteCache = new Map();

async function parseResponse(res) {
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { text, json };
}

function graphErrorMessage({ text, json }) {
  return json?.error?.message || json?.message || json?.error_description || text.slice(0, 200);
}

function sharePointPermissionError(status, original) {
  return `Graph ${status}: sin permiso para este sitio. Si recién agregaste el scope Sites.ReadWrite.All, reconectá Microsoft en ⚙ Sistema → Conexiones (el token viejo no lo tiene). Microsoft Graph: ${original}`;
}

async function sharePointCtx(username) {
  let token;
  try {
    token = await getAccessToken(username, 'microsoft');
  } catch {
    throw new Error(`Microsoft no está conectado para ${username}. Conectalo en ⚙ Sistema → Conexiones.`);
  }
  if (!token) {
    throw new Error(`Microsoft no está conectado para ${username}. Conectalo en ⚙ Sistema → Conexiones.`);
  }

  return {
    token,
    headers: { authorization: 'Bearer ' + token },
  };
}

async function graphFetch(username, url, options = {}) {
  const ctx = await sharePointCtx(username);
  const headers = { ...ctx.headers, ...(options.headers || {}) };
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH_BASE}${url}`, {
    ...options,
    headers,
  });
  const parsed = await parseResponse(res);
  if (!res.ok) {
    const original = graphErrorMessage(parsed) || res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new Error(sharePointPermissionError(res.status, original));
    }
    throw new Error('Graph ' + res.status + ': ' + original);
  }
  return parsed.json;
}

async function graphFetchBuffer(username, url, options = {}) {
  const ctx = await sharePointCtx(username);
  const headers = { ...ctx.headers, ...(options.headers || {}) };
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH_BASE}${url}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const parsed = await parseResponse(res);
    const original = graphErrorMessage(parsed) || res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new Error(sharePointPermissionError(res.status, original));
    }
    throw new Error('Graph ' + res.status + ': ' + original);
  }
  return Buffer.from(await res.arrayBuffer());
}

function clearUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function decodePart(value) {
  const raw = String(value || '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function splitPath(value) {
  return String(value || '')
    .split('/')
    .filter(Boolean)
    .map(decodePart);
}

function cleanFolderPath(segments) {
  const usable = [];
  for (const segment of segments) {
    if (segment === 'Forms') break;
    if (/\.aspx$/i.test(segment)) break;
    usable.push(segment);
  }
  if (!usable.length) return '';
  return '/' + usable.join('/');
}

function stripLibrary(segments) {
  if (!segments.length) return segments;
  const first = decodePart(segments[0]).toLowerCase();
  if (first === 'shared documents' || first === 'documents') return segments.slice(1);
  return segments;
}

function parseSiteSegments(pathname) {
  const segments = splitPath(pathname);
  const marker = segments[0]?.toLowerCase();
  if ((marker !== 'sites' && marker !== 'teams') || !segments[1]) return null;
  return {
    sitePath: `/${segments[0]}/${segments[1]}`,
    rest: segments.slice(2),
  };
}

function parseError() {
  return new Error('No pude determinar el sitio de SharePoint. Usá una URL completa o algo como mordorstaffing.sharepoint.com/sites/HRANDHRASST.');
}

function folderFromAuthoritativeId(idPath, sitePath) {
  const idSegments = splitPath(idPath);
  const siteSegments = splitPath(sitePath);
  let rest = idSegments;
  const sameSite = siteSegments.every((segment, index) => idSegments[index]?.toLowerCase() === segment.toLowerCase());
  if (sameSite) rest = idSegments.slice(siteSegments.length);
  return cleanFolderPath(stripLibrary(rest));
}

export function parseSharePointUrl(input) {
  let url;
  try {
    url = new URL(clearUrl(input));
  } catch {
    throw parseError();
  }

  const hostname = url.hostname;
  const parsed = parseSiteSegments(url.pathname);
  if (!hostname || !parsed?.sitePath) throw parseError();

  const id = url.searchParams.get('id');
  const folderPath = id
    ? folderFromAuthoritativeId(id, parsed.sitePath)
    : cleanFolderPath(stripLibrary(parsed.rest));

  return {
    hostname,
    sitePath: parsed.sitePath,
    folderPath,
  };
}

function encodeSegment(segment) {
  return encodeURIComponent(decodePart(segment));
}

export function drivePath(folderPath) {
  const segments = splitPath(folderPath);
  if (!segments.length) return '';
  return '/' + segments.map(encodeSegment).join('/');
}

function folderChildrenUrl(siteId, folderPath = '') {
  const encodedSiteId = encodeURIComponent(siteId);
  const encodedPath = drivePath(folderPath);
  if (!encodedPath) return `/sites/${encodedSiteId}/drive/root/children`;
  return `/sites/${encodedSiteId}/drive/root:${encodedPath}:/children`;
}

function driveItemPath(folderPath, name) {
  const encodedFolder = drivePath(folderPath);
  const encodedName = encodeSegment(name);
  return encodedFolder ? `${encodedFolder}/${encodedName}` : `/${encodedName}`;
}

function requireSite(site) {
  if (!site?.id) throw new Error('Falta el sitio de SharePoint resuelto.');
  return site.id;
}

function siteCacheKey(username, hostname, sitePath) {
  return `${username || ''}\n${hostname.toLowerCase()}\n${sitePath}`;
}

export async function resolveSite(username, input) {
  const parsed = typeof input === 'string' ? parseSharePointUrl(input) : input;
  const hostname = String(parsed?.hostname || '').trim();
  const sitePath = String(parsed?.sitePath || '').trim();
  if (!hostname || !sitePath) throw parseError();

  const key = siteCacheKey(username, hostname, sitePath);
  const cached = siteCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.site;

  const graphSitePath = drivePath(sitePath);
  const qs = new URLSearchParams({ $select: 'id,name,displayName,webUrl' });
  const site = await graphFetch(username, `/sites/${hostname}:${graphSitePath}?${qs.toString()}`);
  const result = {
    id: site?.id,
    name: site?.name,
    displayName: site?.displayName,
    webUrl: site?.webUrl,
  };
  if (!result.id) throw new Error('Graph devolvió una respuesta de sitio inválida.');
  siteCache.set(key, { site: result, expiresAt: Date.now() + SITE_CACHE_TTL_MS });
  return result;
}

export async function listFolder(username, site, folderPath = '', { top = 200 } = {}) {
  const siteId = requireSite(site);
  const pageSize = Math.max(1, Math.min(Number(top) || 200, 999));
  const qs = new URLSearchParams({
    $select: 'id,name,size,lastModifiedDateTime,folder,file,webUrl',
    $top: String(pageSize),
  });
  let url = `${folderChildrenUrl(siteId, folderPath)}?${qs.toString()}`;
  const items = [];

  while (url && items.length < MAX_LIST_ITEMS) {
    const data = await graphFetch(username, url);
    if (!Array.isArray(data?.value)) throw new Error('Graph devolvió una respuesta de carpeta inválida.');
    for (const item of data.value) {
      if (items.length >= MAX_LIST_ITEMS) break;
      const itemPath = `${drivePath(folderPath)}/${item.name || ''}`.replace(/\/+/g, '/');
      items.push({
        id: item.id,
        name: item.name,
        type: item.folder ? 'folder' : 'file',
        size: item.size ?? 0,
        modified: item.lastModifiedDateTime || null,
        mimeType: item.file?.mimeType || null,
        webUrl: item.webUrl || null,
        path: itemPath || '/',
      });
    }
    url = data['@odata.nextLink'] || '';
  }

  return items;
}

export async function downloadFile(username, site, filePath, destAbs) {
  const siteId = requireSite(site);
  if (!filePath) throw new Error('Falta la ruta del archivo en SharePoint.');
  if (!path.isAbsolute(destAbs)) throw new Error('downloadFile exige destAbs absoluto.');

  const itemPath = drivePath(filePath);
  if (!itemPath) throw new Error('Falta la ruta del archivo en SharePoint.');
  const buffer = await graphFetchBuffer(username, `/sites/${encodeURIComponent(siteId)}/drive/root:${itemPath}:/content`);
  await fs.promises.mkdir(path.dirname(destAbs), { recursive: true });
  await fs.promises.writeFile(destAbs, buffer);
  return {
    name: decodePart(path.posix.basename(itemPath)),
    size: buffer.length,
    dest: destAbs,
  };
}

export async function uploadFile(username, site, folderPath, srcAbs, { as = null } = {}) {
  const siteId = requireSite(site);
  if (!path.isAbsolute(srcAbs)) throw new Error('uploadFile exige srcAbs absoluto.');

  const stat = await fs.promises.stat(srcAbs);
  if (!stat.isFile()) throw new Error('La ruta local no es un archivo: ' + srcAbs);
  const name = as || path.basename(srcAbs);
  const itemPath = driveItemPath(folderPath, name);

  if (stat.size <= SMALL_UPLOAD_LIMIT) {
    const buffer = await fs.promises.readFile(srcAbs);
    const item = await graphFetch(username, `/sites/${encodeURIComponent(siteId)}/drive/root:${itemPath}:/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: buffer,
    });
    return { id: item?.id, name: item?.name, size: item?.size, webUrl: item?.webUrl };
  }

  const session = await graphFetch(username, `/sites/${encodeURIComponent(siteId)}/drive/root:${itemPath}:/createUploadSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
  });
  if (!session?.uploadUrl) throw new Error('Graph no devolvió uploadUrl para la sesión de subida.');

  let result = null;
  const handle = await fs.promises.open(srcAbs, 'r');
  try {
    for (let start = 0; start < stat.size; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, stat.size) - 1;
      const buffer = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(chunk.length),
          'content-range': `bytes ${start}-${start + chunk.length - 1}/${stat.size}`,
        },
        body: chunk,
      });
      const parsed = await parseResponse(res);
      if (!res.ok) {
        throw new Error('Graph ' + res.status + ': ' + (graphErrorMessage(parsed) || res.statusText));
      }
      if (res.status === 200 || res.status === 201) result = parsed.json;
    }
  } finally {
    await handle.close();
  }

  if (!result) throw new Error('Graph no confirmó la subida del archivo.');
  return { id: result?.id, name: result?.name, size: result?.size, webUrl: result?.webUrl };
}

export async function createFolder(username, site, folderPath, name) {
  const siteId = requireSite(site);
  if (!name) throw new Error('Falta el nombre de la carpeta.');
  const folder = await graphFetch(username, folderChildrenUrl(siteId, folderPath), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });
  return { id: folder?.id, name: folder?.name, size: folder?.size, webUrl: folder?.webUrl };
}
