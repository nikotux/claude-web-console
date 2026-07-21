#!/usr/bin/env node
// bin/cwc-desk.js — CLI de Zoho Desk con identidad OAuth del USUARIO.
//
// Las sesiones de chat corren en otros cwd y no pueden llamar al HTTP interno de
// la consola. Este comando carga el .env de la consola por ruta explícita ANTES
// de importar módulos que arrastran core/config.js; así funciona invocado por
// ruta absoluta desde cualquier proyecto y mantiene el modelo multiusuario.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const {
  addComment,
  assignTicket,
  createTicket,
  getTicket,
  updateTicket,
  uploadAttachment,
} = await import('../src/core/zoho-desk-client.js');
const { hostUser } = await import('../src/core/user-space.js');

function usage() {
  console.log([
    'cwc-desk — Zoho Desk con la identidad OAuth del usuario',
    '',
    'Uso:',
    '  node bin/cwc-desk.js [--user=<id>] get <nroTicket>',
    '  node bin/cwc-desk.js [--user=<id>] assign <nroTicket> [agentId]',
    '  node bin/cwc-desk.js [--user=<id>] comment <nroTicket> "<texto>" [--public]',
    '  node bin/cwc-desk.js [--user=<id>] attach <nroTicket> <rutaArchivo> [--public]',
    '  node bin/cwc-desk.js [--user=<id>] update <nroTicket> --status="..." --priority="..." --dueDate="..."',
    '  node bin/cwc-desk.js [--user=<id>] create --subject="..." --department=<id> --contact=<id> [--description="..."]',
    '',
    'Ejemplos:',
    '  node bin/cwc-desk.js get 606',
    '  node bin/cwc-desk.js comment 606 "Actualizado en reunión"        # nota interna',
    '  node bin/cwc-desk.js comment 606 "Respuesta al cliente" --public',
    '  node bin/cwc-desk.js assign 606',
    '  node bin/cwc-desk.js attach 606 /tmp/evidencia.pdf',
    '  node bin/cwc-desk.js update 606 --status="On Hold"',
  ].join('\n'));
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--public') flags.public = true;
    else if (arg.startsWith('--user=')) flags.user = arg.slice(7);
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function fieldFlags(flags) {
  const skip = new Set(['help', 'public', 'user']);
  const fields = {};
  for (const [key, value] of Object.entries(flags)) {
    if (skip.has(key)) continue;
    fields[key] = value === true ? '' : value;
  }
  return fields;
}

function summarizeTicket(t) {
  return {
    ticketNumber: t?.ticketNumber ?? null,
    id: t?.id ?? null,
    subject: t?.subject ?? null,
    status: t?.status ?? null,
    assigneeId: t?.assigneeId ?? null,
    attachmentCount: t?.attachmentCount ?? t?.attachmentsCount ?? null,
    webUrl: t?.webUrl ?? null,
  };
}

function printablePath(filePath) {
  const home = os.homedir();
  const abs = path.resolve(filePath);
  return abs.startsWith(home + path.sep) ? '~/' + path.relative(home, abs) : abs;
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0] || 'help';
  const username = flags.user || hostUser();
  if (flags.help || cmd === 'help') { usage(); return; }

  if (cmd === 'get') {
    const ticket = rest[1];
    if (!ticket) throw new Error('Uso: cwc-desk.js get <nroTicket>');
    const t = await getTicket(username, ticket);
    console.log(JSON.stringify(summarizeTicket(t), null, 2));
    return;
  }

  if (cmd === 'assign') {
    const ticket = rest[1];
    const agentId = rest[2];
    if (!ticket) throw new Error('Uso: cwc-desk.js assign <nroTicket> [agentId]');
    const t = await assignTicket(username, ticket, agentId);
    console.log(`OK: ticket #${t?.ticketNumber || ticket} asignado a ${t?.assigneeId || agentId || 'el usuario conectado'}.`);
    return;
  }

  if (cmd === 'comment') {
    const ticket = rest[1];
    const text = rest.slice(2).join(' ').trim();
    if (!ticket || !text) throw new Error('Uso: cwc-desk.js comment <nroTicket> "<texto>" [--public]');
    await addComment(username, ticket, text, { isPublic: !!flags.public });
    console.log(`OK: comentario ${flags.public ? 'público' : 'interno'} agregado al ticket #${ticket}.`);
    return;
  }

  if (cmd === 'attach') {
    const ticket = rest[1];
    const filePath = rest[2];
    if (!ticket || !filePath) throw new Error('Uso: cwc-desk.js attach <nroTicket> <rutaArchivo> [--public]');
    await uploadAttachment(username, ticket, filePath, { isPublic: !!flags.public });
    console.log(`OK: adjunto ${printablePath(filePath)} subido al ticket #${ticket}${flags.public ? ' como público' : ' como interno'}.`);
    return;
  }

  if (cmd === 'update') {
    const ticket = rest[1];
    const fields = fieldFlags(flags);
    if (!ticket || !Object.keys(fields).length) throw new Error('Uso: cwc-desk.js update <nroTicket> --status="..."');
    const t = await updateTicket(username, ticket, fields);
    console.log(`OK: ticket #${t?.ticketNumber || ticket} actualizado.`);
    return;
  }

  if (cmd === 'create') {
    const fields = fieldFlags(flags);
    if (fields.department && !fields.departmentId) {
      fields.departmentId = fields.department;
      delete fields.department;
    }
    if (fields.contact && !fields.contactId) {
      fields.contactId = fields.contact;
      delete fields.contact;
    }
    const t = await createTicket(username, fields);
    console.log(`OK: ticket #${t?.ticketNumber || t?.id || '(sin número)'} creado.`);
    return;
  }

  throw new Error(`Subcomando desconocido: ${cmd}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
