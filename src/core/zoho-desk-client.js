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

export async function sendReply(username, ticket, content, { to = null, cc = '', bcc = '', fromEmailAddress = null, contentType = 'plainText' } = {}) {
  const text = String(content ?? '').trim();
  if (!text) throw new Error('sendReply requiere el cuerpo del mensaje.');

  const id = await resolveTicketId(username, ticket);
  let ticketData = null;
  const loadTicket = async () => {
    if (!ticketData) ticketData = await zohoFetch(username, `/tickets/${encodeURIComponent(id)}`);
    return ticketData;
  };

  // El destinatario no siempre se puede inferir: los tickets creados por el
  // "Report a bug" de la consola nacen con channel Phone y email null, así que
  // hay que caer al correo del contacto y, si tampoco está, exigirlo explícito.
  let recipient = String(to ?? '').trim();
  if (!recipient) {
    const t = await loadTicket();
    recipient = String(t?.email ?? '').trim();
    if (!recipient && t?.contactId) {
      const contact = await zohoFetch(username, `/contacts/${encodeURIComponent(String(t.contactId))}`);
      recipient = String(contact?.email ?? '').trim();
    }
  }
  if (!recipient) {
    throw new Error(`El ticket #${ticket} no tiene correo asociado ni contacto con correo. Pasá --to=<direccion>.`);
  }

  // Zoho solo acepta como remitente una dirección de respuesta VERIFICADA y ACTIVA
  // del departamento del ticket. El endpoint que las lista es `mailReplyAddress`;
  // `/organizations/emailConfiguration/fromAddresses` y sus variantes dan 404.
  // La dirección viene en el campo `address` — NO en `email`.
  let sender = String(fromEmailAddress ?? '').trim();
  if (!sender) {
    const t = await loadTicket();
    const deptId = t?.departmentId ? String(t.departmentId) : null;
    if (!deptId) {
      throw new Error(`El ticket #${ticket} no declara departamento; no se puede deducir el remitente. Pasá --from=<direccion verificada>.`);
    }
    const r = await zohoFetch(username, `/mailReplyAddress?departmentId=${encodeURIComponent(deptId)}`);
    const usable = (Array.isArray(r?.data) ? r.data : [])
      .filter((a) => a?.isVerified && a?.isActive && String(a?.address ?? '').trim());

    if (!usable.length) {
      throw new Error(`El departamento ${deptId} no tiene ninguna dirección de respuesta verificada y activa. Pasá --from=<direccion>.`);
    }
    if (usable.length === 1) {
      // Con una sola candidata da igual que no esté marcada como default: es la única.
      sender = String(usable[0].address).trim();
    } else {
      const preferred = usable.find((a) => a?.isDepartmentDefault);
      if (!preferred) {
        // Elegir a ciegas acá es elegir con qué identidad de empresa sale el correo.
        const names = usable.map((a) => String(a.address).trim()).join(', ');
        throw new Error(`El departamento ${deptId} tiene varias direcciones verificadas y ninguna marcada como default (${names}). Pasá --from=<una de esas> para no elegir por vos.`);
      }
      sender = String(preferred.address).trim();
    }
  }

  return zohoFetch(username, `/tickets/${encodeURIComponent(id)}/sendReply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'EMAIL',
      to: recipient,
      cc: String(cc ?? ''),
      bcc: String(bcc ?? ''),
      contentType,
      content: text,
      fromEmailAddress: sender,
    }),
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
