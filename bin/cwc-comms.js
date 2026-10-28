#!/usr/bin/env node
// bin/cwc-comms.js — CLI TRANSVERSAL del motor de Comunicaciones (lógica en
// src/modules/comms/shared.js). Puerta ÚNICA para que CUALQUIER sesión de
// Claude Code (o vos) registre/consulte una comunicación con un contacto, sin
// depender del proceso del server (patrón bin/cwc-bus.js del Interfono).
//
// Subcomandos:
//   log <contacto> [--in|--out] [--project P] [--url U] [--channel C] -- <texto>
//   query | status                 estado agregado (nuevos / sin responder)
//   list | index [contactId]       hilos indexados (todos o de un contacto)
//   contacts                       listar contactos
//   contact-add <nombre> [--github login]
//   scan                           lanzar un escaneo de GitHub (detached)
import * as C from '../src/modules/comms/shared.js';

const cmd = process.argv[2] || 'help';
const out = (o) => console.log(JSON.stringify(o, null, 2));
const outJson = out;

function parseFlags(args) {
  const flags = {}; const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    else if (a === '--in') flags.direction = 'in';
    else if (a === '--out') flags.direction = 'out';
    else if (a.startsWith('--project=')) flags.project = a.slice(10);
    else if (a === '--project') { flags.project = args[i + 1]; i += 1; }
    else if (a.startsWith('--url=')) flags.url = a.slice(6);
    else if (a === '--url') { flags.url = args[i + 1]; i += 1; }
    else if (a.startsWith('--channel=')) flags.channel = a.slice(10);
    else if (a === '--channel') { flags.channel = args[i + 1]; i += 1; }
    else if (a.startsWith('--github=')) flags.github = a.slice(9);
    else if (a === '--github') { flags.github = args[i + 1]; i += 1; }
    else if (a === '--pr') { flags.pr = args[i + 1]; i += 1; }
    else if (a === '--ticket') { flags.ticket = args[i + 1]; i += 1; }
    else if (a === '--reviewer') { flags.reviewer = args[i + 1]; i += 1; }
    else if (a === '--dry') flags.dry = true;
    else rest.push(a);
  }
  return { flags, rest };
}

function resolveContact(token) {
  const t = String(token || '').toLowerCase().replace(/^@/, '');
  return C.readContacts().find((c) => c.id.toLowerCase() === t
    || c.name.toLowerCase() === t
    || (c.github || '').toLowerCase() === t) || null;
}

function usage() {
  console.log([
    'cwc-comms — motor de comunicaciones (transversal, file-based, 0 tokens)',
    '',
    'Subcomandos:',
    '  log <contacto> [--in|--out] [--project P] [--url U] [--channel C] -- <texto>',
    '                                 registrar una comunicación (--in = lo dijo el contacto)',
    '  query | status                 estado agregado (nuevos / sin responder)',
    '  list | index [contactId]       hilos indexados',
    '  contacts                       listar contactos',
    '  contact-add <nombre> [--github login]',
    '  scan                           lanzar un escaneo de GitHub (detached)',
  ].join('\n'));
}

switch (cmd) {
  case 'log': {
    C.ensureSeed();
    const { flags, rest } = parseFlags(process.argv.slice(3));
    const who = resolveContact(rest[0]);
    const text = rest.slice(1).join(' ').trim();
    if (!who || !text) { console.error('Uso: cwc-comms log <contacto> [--in|--out] [--project P] [--url U] -- <texto>'); process.exit(1); }
    out({ ok: true, entry: C.appendManual({ contactId: who.id, text, direction: flags.direction || 'out', project: flags.project || null, url: flags.url || null, channel: flags.channel || 'cli' }) });
    break;
  }
  case 'query': case 'status': {
    C.ensureSeed();
    out(C.buildStatus());
    break;
  }
  case 'list': case 'index': {
    C.ensureSeed();
    const idx = C.buildIndex();
    const who = process.argv[3] ? resolveContact(process.argv[3]) : null;
    const threads = who ? idx.threads.filter((t) => t.contactId === who.id) : idx.threads;
    out({ ...idx, threads });
    break;
  }
  case 'contacts': {
    C.ensureSeed();
    out({ contacts: C.readContacts() });
    break;
  }
  case 'contact-add': {
    C.ensureSeed();
    const { flags, rest } = parseFlags(process.argv.slice(3));
    const name = rest.join(' ').trim() || flags.github;
    if (!name && !flags.github) { console.error('Uso: cwc-comms contact-add <nombre> [--github login]'); process.exit(1); }
    out({ ok: true, contact: C.addContact({ name, github: flags.github }) });
    break;
  }
  case 'scan': {
    C.ensureSeed();
    if (C.isRunning()) { out({ ok: true, running: true, started: false }); break; }
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const runner = path.join(here, 'cwc-comms-runner.js');
    const child = spawn(process.execPath, [runner], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', (err) => {
      try { console.error('[comms] no se pudo lanzar el runner:', String(err?.message || err)); } catch { /* noop */ }
    });
    if (child.pid) {
      C.writeLock(child.pid);
      child.unref();
      out({ ok: true, running: true, started: true });
    } else {
      out({ ok: false, running: false, started: false, error: 'No se pudo lanzar el runner.' });
    }
    break;
  }
  case 'send': {
    // Uso: cwc-comms send <channel> <action> <contacto> [--pr N] [--ticket N] [--dry] -- <texto>
    C.ensureSeed();
    const { flags, rest } = parseFlags(process.argv.slice(3));
    const channel = rest[0]; const action = rest[1];
    const who = rest[2] ? resolveContact(rest[2]) : null;
    const text = rest.slice(who ? 3 : 2).join(' ').trim();
    if (!channel || !action) { console.error('Uso: cwc-comms send <github|desk|teams> <action> [contacto] [--pr N] [--ticket N] [--dry] -- <texto>'); process.exit(1); }
    const GW = await import('../src/modules/comms/gateway-shared.js');
    const payload = { text };
    if (flags.pr) payload.prNumber = flags.pr;
    if (flags.ticket) payload.ticketNumber = flags.ticket;
    if (flags.reviewer) payload.reviewer = flags.reviewer;
    const out = await GW.sendComm({ channel, action, payload, contactId: who ? who.id : null, actor: 'cli', dryRun: !!flags.dry });
    outJson(out);
    break;
  }
  case 'record': {
    // Registra en el OUTBOX una comunicación EJECUTADA en otro lado (ej. un chat
    // aprobado por el usuario), sin re-enviarla. Uso: cwc-comms record <channel>
    // <action> [contacto] [--pr N] [--ticket N] -- <texto>
    C.ensureSeed();
    const { flags, rest } = parseFlags(process.argv.slice(3));
    const channel = rest[0]; const action = rest[1];
    const who = rest[2] ? resolveContact(rest[2]) : null;
    const text = rest.slice(who ? 3 : 2).join(' ').trim();
    if (!channel || !action) { console.error('Uso: cwc-comms record <github|desk|teams> <action> [contacto] [--pr N] [--ticket N] -- <texto>'); process.exit(1); }
    const ref = flags.ticket ? `ticket #${flags.ticket}` : (flags.pr ? `PR #${flags.pr}` : null);
    const e = C.appendOutbox({ channel, action, to: who ? (who.github || who.name) : (ref || 'externo'), ref, contactId: who ? who.id : null, text, actor: 'cli:record', ok: true });
    if (who) { try { C.appendManual({ contactId: who.id, text: `→ ${text}`, direction: 'out', channel }); } catch { /* noop */ } }
    outJson({ ok: true, entry: e });
    break;
  }
  default:
    usage();
    process.exit(0);
}
