// core/zoho-desk-client.js — cliente directo a Zoho Desk con identidad de USUARIO.
//
// Este módulo es la vía directa gobernada para sesiones Limbo: resuelve el
// token OAuth por username en cada operación (modelo multiusuario) y manda orgId
// siempre, porque Desk lo exige incluso en endpoints que parecen globales.
import fs from 'node:fs';
import path from 'node:path';
import { getAccessToken, readAppConfig, readConnection } from './connections-store.js';

function deskBase(dc) {
  return `https://desk.zoho.${String(dc || 'com').trim() || 'com'}/api/v1`;
}

async function parseResponse(res) {
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { text, json };
}

async function zohoFetch(username, url, options = {}) {
  const ctx = await deskCtx(username);
  const headers = { ...ctx.headers, ...(options.headers || {}) };
  const res = await fetch(url.startsWith('http') ? url : `${deskBase(ctx.dc)}${url}`, {
    ...options,
    headers,
  });
  const { text, json } = await parseResponse(res);
  if (!res.ok) {
    throw new Error('Zoho ' + res.status + ': ' + (json?.message || json?.errorCode || text.slice(0, 200)));
  }
  return json;
}

export async function deskCtx(username) {
  const conn = readConnection(username, 'zoho');
  if (!conn) {
    throw new Error(`Zoho no está conectado para ${username}. Conectalo en ⚙ Sistema → Conexiones.`);
  }
  if (!conn.orgId) {
    throw new Error(`Zoho no está conectado para ${username}: falta orgId. Reconectalo en ⚙ Sistema → Conexiones.`);
  }

  let token;
  try {
    token = await getAccessToken(username, 'zoho');
  } catch (err) {
    throw new Error(`Zoho no está conectado para ${username}. Conectalo en ⚙ Sistema → Conexiones. (${err?.message || err})`);
  }
  if (!token) {
    throw new Error(`Zoho no está conectado para ${username}. Conectalo en ⚙ Sistema → Conexiones.`);
  }

  const dc = readAppConfig().zoho.dc || 'com';
  const orgId = String(conn.orgId);
  return {
    token,
    orgId,
    agentId: conn.agentId ? String(conn.agentId) : null,
    dc,
    headers: { authorization: 'Zoho-oauthtoken ' + token, orgId },
  };
}

export async function resolveTicketId(username, ticketNumberOrId) {
  const s = String(ticketNumberOrId || '').trim().replace(/^#/, '');
  if (/^\d{15,}$/.test(s)) return s;
  if (!s) throw new Error('Falta el número o ID del ticket de Zoho.');

  for (const from of [1, 101, 201]) {
    const qs = new URLSearchParams({ limit: '100', from: String(from) });
    const data = await zohoFetch(username, `/tickets?${qs.toString()}`);
    const tickets = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    const found = tickets.find((t) => String(t.ticketNumber || '').trim() === s);
    if (found?.id) return String(found.id);
  }

  throw new Error(`Ticket #${s} no encontrado en Zoho Desk.`);
}

export async function getTicket(username, ticket) {
  const id = await resolveTicketId(username, ticket);
  return zohoFetch(username, `/tickets/${encodeURIComponent(id)}`);
}

export async function listDepartments(username) {
  const r = await zohoFetch(username, '/departments');
  return Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []);
}

export async function assignTicket(username, ticket, agentId) {
  const ctx = await deskCtx(username);
  const assigneeId = agentId ? String(agentId) : ctx.agentId;
  if (!assigneeId) {
    throw new Error(`Zoho no está conectado para ${username}: falta agentId para asignar el ticket.`);
  }
  const id = await resolveTicketId(username, ticket);
  return zohoFetch(username, `/tickets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assigneeId }),
  });
}

export async function updateTicket(username, ticket, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('updateTicket requiere un objeto de campos.');
  }
  const id = await resolveTicketId(username, ticket);
  return zohoFetch(username, `/tickets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

export async function addComment(username, ticket, content, { isPublic = false } = {}) {
  const id = await resolveTicketId(username, ticket);
  return zohoFetch(username, `/tickets/${encodeURIComponent(id)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, contentType: 'plainText', isPublic: !!isPublic }),
  });
}

export async function uploadAttachment(username, ticket, filePath, { isPublic = false, fileName = null } = {}) {
  const id = await resolveTicketId(username, ticket);
  const fd = new FormData();
  const blob = new Blob([fs.readFileSync(filePath)]);
  // Los archivos de WhatsApp llegan con hash; en Desk conviene ver el nombre real.
  const attachmentName = String(fileName ?? '').trim()
    ? path.basename(String(fileName).trim())
    : path.basename(filePath);
  fd.append('file', blob, attachmentName);
  const qs = new URLSearchParams({ isPublic: String(!!isPublic) });
  return zohoFetch(username, `/tickets/${encodeURIComponent(id)}/attachments?${qs.toString()}`, {
    method: 'POST',
    body: fd,
  });
}

export async function createTicket(username, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('createTicket requiere un objeto de campos.');
  }
  return zohoFetch(username, '/tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });
}
