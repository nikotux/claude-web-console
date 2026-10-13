#!/usr/bin/env node
// Migración one-shot de console:BUG-3241. Limpia únicamente los espejos de
// inquilinos cuya parte ajena al bloque gestionado sigue siendo una copia byte
// a byte del host. Cualquier contenido propio queda intacto.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../src/core/atomic-write.js';
import { systemScopeFor } from '../src/core/system-scope.js';
import { hostUser } from '../src/core/user-space.js';
import { listUsers } from '../src/core/users.js';
import {
  contextPathsFor,
  renderManagedSection,
  syncToTolkien,
} from '../src/modules/tickets/context-store.js';

const MARK_START = Buffer.from('<!-- cwc:tickets-context:start -->');
const MARK_END = Buffer.from('<!-- cwc:tickets-context:end -->');

function usage() {
  return [
    'Uso: node bin/cwc-tenant-mirror-reset.js [--apply] [--user <id>]',
    'Sin --apply hace dry-run y no escribe nada.',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function parseArgs(argv) {
  const options = { apply: false, help: false, user: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--user' || arg.startsWith('--user=')) {
      if (options.user !== null) throw usageError('--user solo puede indicarse una vez');
      const value = arg === '--user' ? argv[++index] : arg.slice('--user='.length);
      if (!value || value.startsWith('-')) throw usageError('--user requiere un id');
      options.user = value;
    } else {
      throw usageError(`argumento desconocido: ${arg}`);
    }
  }
  return options;
}

// Si los marcadores no forman un bloque válido, todo el archivo es contenido
// ajeno. Así una estructura dudosa nunca habilita el borrado por accidente.
function foreignPart(content) {
  const start = content.indexOf(MARK_START);
  if (start === -1) return content;
  const end = content.indexOf(MARK_END, start + MARK_START.length);
  if (end === -1) return content;
  return Buffer.concat([
    content.subarray(0, start),
    content.subarray(end + MARK_END.length),
  ]);
}

function classificationFor(content, hostContent, hostForeignPart) {
  if (content.equals(hostContent) || foreignPart(content).equals(hostForeignPart)) {
    return 'copia-del-host';
  }
  return 'propio';
}

function timestampForBackup(date = new Date()) {
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}`
    + `-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function tenantHeader(username) {
  return `# Reglas personales de ${username} para sesiones en este repo (NO versionado)\n\n`;
}

function plannedBytes(scope, username) {
  const managed = renderManagedSection({}, scope);
  const text = `${tenantHeader(username)}${MARK_START.toString()}\n${managed}\n`
    + `${MARK_END.toString()}\n`;
  return Buffer.byteLength(text, 'utf8');
}

function createBackup(file, stamp, originalStat) {
  const backupFile = `${file}.bak-mirror-reset-${stamp}`;
  fs.copyFileSync(file, backupFile, fs.constants.COPYFILE_EXCL);
  const backupStat = fs.statSync(backupFile);
  if (backupStat.uid !== originalStat.uid || backupStat.gid !== originalStat.gid) {
    fs.chownSync(backupFile, originalStat.uid, originalStat.gid);
  }
  fs.chmodSync(backupFile, 0o644);
  return backupFile;
}

function restoreBackup(file, backupFile, originalStat) {
  const content = fs.readFileSync(backupFile);
  writeFileAtomic(file, content, { mode: 0o644 });
  const restoredStat = fs.statSync(file);
  if (restoredStat.uid !== originalStat.uid || restoredStat.gid !== originalStat.gid) {
    fs.chownSync(file, originalStat.uid, originalStat.gid);
  }
  fs.chmodSync(file, 0o644);
}

function currentBytes(file, fallback) {
  try {
    return fs.statSync(file).size;
  } catch {
    return fallback;
  }
}

function bytesTransition(before, after) {
  return `${before} → ${after}`;
}

function rowFor(username, classification, before, after, playbookExists, state) {
  return {
    usuario: username,
    clasificación: classification,
    'bytes antes→después': bytesTransition(before, after),
    '¿playbook existe?': playbookExists ? 'sí' : 'no',
    estado: state,
  };
}

function discoverTenants(selectedUser) {
  const host = hostUser();
  const tenants = listUsers().filter((user) => user?.username && user.username !== host);
  if (!selectedUser) return tenants;
  if (selectedUser === host) throw usageError(`el usuario host ${host} nunca se procesa`);
  const selected = tenants.find((user) => user.username === selectedUser);
  if (!selected) throw usageError(`usuario inexistente: ${selectedUser}`);
  return [selected];
}

function applyReset(user, scope, mirrorFile, playbookFile, beforeBytes, stamp) {
  const originalStat = fs.statSync(mirrorFile);
  let backupFile = null;
  let headerWritten = false;

  try {
    backupFile = createBackup(mirrorFile, stamp, originalStat);
    writeFileAtomic(mirrorFile, tenantHeader(user.username), { mode: 0o644 });
    headerWritten = true;

    const synced = syncToTolkien(scope);
    if (!synced.ok) throw new Error(`syncToTolkien: ${synced.reason || 'falló'}`);

    const afterBytes = fs.statSync(mirrorFile).size;
    return {
      afterBytes,
      playbookExists: fs.existsSync(playbookFile),
      state: `aplicado; backup ${path.basename(backupFile)}`,
      writeError: false,
    };
  } catch (error) {
    let restoreError = null;
    if (headerWritten && backupFile) {
      try {
        restoreBackup(mirrorFile, backupFile, originalStat);
      } catch (caught) {
        restoreError = caught;
      }
    }
    const reason = error?.message || String(error);
    const restoreState = restoreError
      ? `; ERROR al restaurar: ${restoreError?.message || String(restoreError)}`
      : (headerWritten ? '; restaurado desde backup' : '');
    return {
      afterBytes: currentBytes(mirrorFile, beforeBytes),
      playbookExists: fs.existsSync(playbookFile),
      state: `ERROR de escritura: ${reason}${restoreState}`,
      writeError: true,
    };
  }
}

function processTenant(user, hostContent, hostForeignPart, options, stamp) {
  const scope = systemScopeFor({
    type: 'session',
    username: user.username,
    admin: !!user.admin,
  });
  const { mirrorFile, playbookFile } = contextPathsFor(scope);
  const playbookExists = fs.existsSync(playbookFile);

  let content;
  try {
    content = fs.readFileSync(mirrorFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        row: rowFor(user.username, 'sin-archivo', '—', '—', playbookExists, 'sin archivo; no se toca'),
        writeError: false,
        readError: false,
      };
    }
    return {
      row: rowFor(
        user.username,
        'error-de-lectura',
        '?',
        '?',
        playbookExists,
        `ERROR de lectura: ${error?.message || String(error)}`,
      ),
      writeError: false,
      readError: true,
    };
  }

  const beforeBytes = content.length;
  const classification = classificationFor(content, hostContent, hostForeignPart);
  if (classification === 'propio') {
    return {
      row: rowFor(user.username, classification, beforeBytes, beforeBytes, playbookExists, 'preservado'),
      writeError: false,
      readError: false,
    };
  }

  if (!options.apply) {
    try {
      const afterBytes = plannedBytes(scope, user.username);
      return {
        row: rowFor(
          user.username,
          classification,
          beforeBytes,
          afterBytes,
          playbookExists,
          'dry-run: limpiaría',
        ),
        writeError: false,
        readError: false,
      };
    } catch (error) {
      return {
        row: rowFor(
          user.username,
          classification,
          beforeBytes,
          '?',
          playbookExists,
          `ERROR de lectura/proceso: ${error?.message || String(error)}`,
        ),
        writeError: false,
        readError: true,
      };
    }
  }

  const result = applyReset(user, scope, mirrorFile, playbookFile, beforeBytes, stamp);
  return {
    row: rowFor(
      user.username,
      classification,
      beforeBytes,
      result.afterBytes,
      result.playbookExists,
      result.state,
    ),
    writeError: result.writeError,
    readError: false,
  };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }

  let tenants;
  try {
    tenants = discoverTenants(options.user);
  } catch (error) {
    console.error(error.message);
    if (error.usage) console.error(usage());
    return 2;
  }

  const hostFile = contextPathsFor(systemScopeFor({ type: 'token', admin: true })).mirrorFile;
  let hostContent;
  try {
    hostContent = fs.readFileSync(hostFile);
  } catch (error) {
    console.error(`No se pudo leer el archivo del host ${hostFile}: ${error?.message || String(error)}`);
    return 2;
  }
  const hostForeignPart = foreignPart(hostContent);
  const stamp = timestampForBackup();
  const rows = [];
  let writeErrors = 0;
  let readErrors = 0;

  console.log(`MODO ${options.apply ? 'APPLY' : 'DRY-RUN'} · host solo lectura · Pad no se toca`);
  for (const user of tenants) {
    let result;
    try {
      result = processTenant(user, hostContent, hostForeignPart, options, stamp);
    } catch (error) {
      result = {
        row: rowFor(
          user.username,
          'error-de-proceso',
          '?',
          '?',
          false,
          `ERROR de lectura/proceso: ${error?.message || String(error)}`,
        ),
        writeError: false,
        readError: true,
      };
    }
    rows.push(result.row);
    if (result.writeError) writeErrors += 1;
    if (result.readError) readErrors += 1;
  }

  if (rows.length) console.table(rows);
  else console.log('No hay inquilinos para procesar.');
  if (writeErrors) console.error(`Fallaron ${writeErrors} escritura(s).`);
  if (readErrors) console.error(`Fallaron ${readErrors} lectura(s) o cálculo(s).`);
  if (writeErrors) return 1;
  return readErrors ? 2 : 0;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
