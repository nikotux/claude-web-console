#!/usr/bin/env node
// bin/cwc-calendar.js — CLI de Microsoft Calendar con identidad OAuth del USUARIO.
//
// Las sesiones de chat corren fuera de la consola y no deben escribir calendario
// con identidad del agente. Este comando carga el .env por ruta explícita ANTES
// de importar core/config.js y usa America/Bogota como zona fija de Niko.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const {
  createEvent,
  deleteEvent,
  listEvents,
} = await import('../src/core/microsoft-calendar-client.js');
const { hostUser } = await import('../src/core/user-space.js');

const DEFAULT_TZ = 'America/Bogota';

function usage() {
  console.log([
    'cwc-calendar — Microsoft Calendar con la identidad OAuth del usuario',
    '',
    'Uso:',
    '  node bin/cwc-calendar.js [--user=<id>] list [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--tz="America/Bogota"]',
    '  node bin/cwc-calendar.js [--user=<id>] create --subject="..." --start="2026-07-23T09:00:00" --end="2026-07-23T09:30:00" [--body="..."] [--location="..."] [--allday] [--reminder=<minutos>] [--tz="America/Bogota"]',
    '  node bin/cwc-calendar.js [--user=<id>] delete <eventId>',
    '',
    'Notas:',
    '  En --allday, --start y --end son fechas YYYY-MM-DD; end es EXCLUSIVO en Graph.',
    '  La zona horaria por defecto siempre es America/Bogota.',
    '',
    'Ejemplos:',
    '  node bin/cwc-calendar.js list',
    '  node bin/cwc-calendar.js list --from=2026-07-21 --to=2026-07-28',
    '  node bin/cwc-calendar.js create --subject="Seguimiento ticket 606" --start="2026-07-23T09:00:00" --end="2026-07-23T09:30:00" --reminder=15',
    '  node bin/cwc-calendar.js create --subject="Fuera de oficina" --start=2026-07-23 --end=2026-07-24 --allday',
    '  node bin/cwc-calendar.js delete AAMkAG...',
  ].join('\n'));
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--allday') flags.allday = true;
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

function bogotaTodayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDaysKey(dayKey, delta) {
  const y = Number(dayKey.slice(0, 4));
  const m = Number(dayKey.slice(5, 7));
  const d = Number(dayKey.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function dateRange(flags) {
  const fromDay = flags.from || bogotaTodayKey();
  const toDay = flags.to || addDaysKey(fromDay, 7);
  return {
    from: `${fromDay}T00:00:00`,
    to: `${toDay}T23:59:59`,
  };
}

function allDayDateTime(value, flagName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`En --allday, ${flagName} debe ser una fecha YYYY-MM-DD.`);
  }
  return `${value}T00:00:00`;
}

function reminderValue(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error('--reminder debe ser un número entero de minutos.');
  return n;
}

function eventLine(e) {
  const start = String(e?.start?.dateTime || '');
  const end = String(e?.end?.dateTime || '');
  const date = start.slice(0, 10) || '(sin fecha)';
  const time = e?.isAllDay ? 'todo el día' : `${start.slice(11, 16) || '--:--'}-${end.slice(11, 16) || '--:--'}`;
  return `${date} ${time} ${e?.subject || '(sin asunto)'}`;
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0] || 'help';
  const username = flags.user || hostUser();
  const timeZone = flags.tz || DEFAULT_TZ;
  if (flags.help || cmd === 'help') { usage(); return; }

  if (cmd === 'list') {
    const range = dateRange(flags);
    const events = await listEvents(username, { ...range, timeZone });
    if (!events.length) {
      console.log('Sin eventos.');
      return;
    }
    for (const event of events) console.log(eventLine(event));
    return;
  }

  if (cmd === 'create') {
    const isAllDay = !!flags.allday;
    const start = isAllDay ? allDayDateTime(flags.start, '--start') : flags.start;
    const end = isAllDay ? allDayDateTime(flags.end, '--end') : flags.end;
    const event = await createEvent(username, {
      subject: flags.subject,
      start,
      end,
      timeZone,
      bodyHtml: flags.body || null,
      location: flags.location || null,
      isAllDay,
      reminderMinutesBeforeStart: reminderValue(flags.reminder),
    });
    console.log(`OK: evento "${event?.subject || flags.subject}" creado para ${event?.start?.dateTime || start} (id ${event?.id}).`);
    return;
  }

  if (cmd === 'delete') {
    const eventId = rest[1];
    if (!eventId) throw new Error('Uso: cwc-calendar.js delete <eventId>');
    await deleteEvent(username, eventId);
    console.log(`OK: evento ${eventId} eliminado.`);
    return;
  }

  throw new Error(`Subcomando desconocido: ${cmd}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
