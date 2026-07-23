#!/usr/bin/env node
// bin/cwc-sharepoint.js — CLI de SharePoint con identidad OAuth del USUARIO.
//
// Las sesiones de chat corren en otros cwd y no pueden llamar al HTTP interno de
// la consola. Este comando carga el .env de la consola por ruta explícita ANTES
// de importar módulos que arrastran core/config.js; así funciona invocado por
// ruta absoluta desde cualquier proyecto y mantiene el modelo multiusuario.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const {
  createFolder,
  downloadFile,
  listFolder,
  parseSharePointUrl,
  resolveSite,
  uploadFile,
} = await import('../src/core/microsoft-sharepoint-client.js');
const { hostUser } = await import('../src/core/user-space.js');
const { materializeIntoChat } = await import('../src/modules/chat/attachments.js');

function usage() {
  console.log([
    'cwc-sharepoint — SharePoint con la identidad OAuth del usuario',
    '',
    'Uso:',
    '  node bin/cwc-sharepoint.js [--user=<id>] ls <urlOSitio> [rutaCarpeta]',
    '  node bin/cwc-sharepoint.js [--user=<id>] get <urlOSitio> <rutaArchivo> [--chat=<chatId>] [--out=<rutaAbs>]',
    '  node bin/cwc-sharepoint.js [--user=<id>] put <urlOSitio> <rutaCarpeta> <archivoLocal> [--as="<nombre>"] --yes',
    '  node bin/cwc-sharepoint.js [--user=<id>] mkdir <urlOSitio> <rutaCarpeta> <nombre> --yes',
    '',
    'Ejemplos:',
    '  node bin/cwc-sharepoint.js ls "https://mordorstaffing.sharepoint.com/sites/HRANDHRASST/..."',
    '  node bin/cwc-sharepoint.js ls mordorstaffing.sharepoint.com/sites/HRANDHRASST "/General/NUEVA OFICINA"',
  ].join('\n'));
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--json') flags.json = true;
    else if (arg.startsWith('--user=')) flags.user = arg.slice(7);
    else if (arg.startsWith('--chat=')) flags.chat = arg.slice(7);
    else if (arg.startsWith('--out=')) flags.out = arg.slice(6);
    else if (arg.startsWith('--as=')) flags.as = arg.slice(5);
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

function printablePath(filePath) {
  const home = os.homedir();
  const abs = path.resolve(filePath);
  return abs.startsWith(home + path.sep) ? '~/' + path.relative(home, abs) : abs;
}

function basenameFromSharePointPath(filePath) {
  const clean = String(filePath || '').split('/').filter(Boolean).pop() || 'sharepoint-download';
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

function formatSize(size) {
  if (size === null || size === undefined) return '-';
  const n = Number(size);
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function printTable(items) {
  if (!items.length) {
    console.log('(vacío)');
    return;
  }

  const rows = items.map((item) => ({
    tipo: item.type,
    nombre: item.name || '',
    tamano: item.type === 'folder' ? '-' : formatSize(item.size),
    modificado: item.modified || '-',
  }));
  const headers = ['tipo', 'nombre', 'tamano', 'modificado'];
  const widths = {};
  for (const header of headers) {
    widths[header] = Math.max(header.length, ...rows.map((row) => String(row[header]).length));
  }
  console.log(headers.map((header) => header.padEnd(widths[header])).join('  '));
  console.log(headers.map((header) => '-'.repeat(widths[header])).join('  '));
  for (const row of rows) {
    console.log(headers.map((header) => String(row[header]).padEnd(widths[header])).join('  '));
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function dryRunPut(siteArg, folderPath, srcAbs, asName) {
  console.error('Falta --yes. No se subió nada.');
  console.error(`Sitio: ${siteArg}`);
  console.error(`Ruta destino: ${folderPath || '/'}`);
  console.error(`Archivo: ${printablePath(srcAbs)}`);
  if (asName) console.error(`Nombre remoto: ${asName}`);
  process.exitCode = 2;
}

function dryRunMkdir(siteArg, folderPath, name) {
  console.error('Falta --yes. No se creó nada.');
  console.error(`Sitio: ${siteArg}`);
  console.error(`Ruta destino: ${folderPath || '/'}`);
  console.error(`Carpeta: ${name}`);
  process.exitCode = 2;
}

async function removeTmp(filePath) {
  try {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Limpieza best-effort del temporal.
  }
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0] || 'help';
  const username = flags.user || hostUser();
  if (flags.help || cmd === 'help') { usage(); return; }

  if (cmd === 'ls') {
    const siteArg = rest[1];
    if (!siteArg) throw new Error('Uso: cwc-sharepoint.js ls <urlOSitio> [rutaCarpeta]');
    const parsed = parseSharePointUrl(siteArg);
    const folderPath = rest[2] !== undefined ? rest[2] : parsed.folderPath;
    const site = await resolveSite(username, parsed);
    const items = await listFolder(username, site, folderPath);
    if (flags.json) printJson(items);
    else printTable(items);
    return;
  }

  if (cmd === 'get') {
    const siteArg = rest[1];
    const filePath = rest[2];
    if (!siteArg || !filePath) throw new Error('Uso: cwc-sharepoint.js get <urlOSitio> <rutaArchivo> [--chat=<chatId>] [--out=<rutaAbs>]');
    const site = await resolveSite(username, siteArg);
    const label = basenameFromSharePointPath(filePath);

    if (flags.chat) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-sharepoint-'));
      const tmpAbs = path.join(tmpDir, label);
      try {
        const downloaded = await downloadFile(username, site, filePath, tmpAbs);
        const materialized = await materializeIntoChat(flags.chat, tmpAbs, { label });
        if (!materialized?.ok) {
          throw new Error('No se pudo materializar el archivo en el chat: ' + (materialized?.reason || 'motivo desconocido'));
        }
        if (flags.json) printJson({ ...materialized, source: downloaded });
        else console.log(`OK: ${downloaded.name} materializado en el chat ${flags.chat}.`);
      } finally {
        await removeTmp(tmpAbs);
      }
      return;
    }

    const destAbs = flags.out ? path.resolve(flags.out) : path.resolve(process.cwd(), label);
    const downloaded = await downloadFile(username, site, filePath, destAbs);
    if (flags.json) printJson(downloaded);
    else console.log(`OK: ${downloaded.name} descargado en ${printablePath(downloaded.dest)} (${formatSize(downloaded.size)}).`);
    return;
  }

  if (cmd === 'put') {
    const siteArg = rest[1];
    const folderPath = rest[2];
    const src = rest[3];
    if (!siteArg || folderPath === undefined || !src) throw new Error('Uso: cwc-sharepoint.js put <urlOSitio> <rutaCarpeta> <archivoLocal> [--as="<nombre>"] --yes');
    const srcAbs = path.resolve(src);
    if (!flags.yes) {
      dryRunPut(siteArg, folderPath, srcAbs, flags.as);
      return;
    }
    const site = await resolveSite(username, siteArg);
    const uploaded = await uploadFile(username, site, folderPath, srcAbs, { as: flags.as || null });
    if (flags.json) printJson(uploaded);
    else console.log(`OK: ${uploaded.name || path.basename(srcAbs)} subido a ${folderPath || '/'}.`);
    return;
  }

  if (cmd === 'mkdir') {
    const siteArg = rest[1];
    const folderPath = rest[2];
    const name = rest[3];
    if (!siteArg || folderPath === undefined || !name) throw new Error('Uso: cwc-sharepoint.js mkdir <urlOSitio> <rutaCarpeta> <nombre> --yes');
    if (!flags.yes) {
      dryRunMkdir(siteArg, folderPath, name);
      return;
    }
    const site = await resolveSite(username, siteArg);
    const folder = await createFolder(username, site, folderPath, name);
    if (flags.json) printJson(folder);
    else console.log(`OK: carpeta ${folder.name || name} creada en ${folderPath || '/'}.`);
    return;
  }

  throw new Error(`Subcomando desconocido: ${cmd}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
