#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// El cliente compartido lee esta variable al importarse. Su import es dinámico
// y ocurre únicamente en modo apply, después de validar y respaldar.
process.env.CWC_PAD_CACHE = '0';

const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const BACKUP_DIR = path.join(os.homedir(), '.cwc-backups');
const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_RATE_RETRIES = 8;

function usage() {
  return [
    'Uso: node bin/cwc-pad-schema-expand.js --workspace <slug> --collection <slug> --field \'<json>\' [opciones]',
    '',
    'Opciones:',
    '  --workspace <slug>     Workspace destino. OBLIGATORIO (no hay default: escribir en el workspace equivocado es el riesgo principal).',
    '  --collection <slug>    Colección destino. OBLIGATORIO.',
    '  --field \'<json>\'       Repetible. Un objeto JSON de UN campo, p.ej.',
    '                         \'{"key":"phase","label":"Phase","type":"text"}\'',
    '  --backup-db            Copia pad.db antes de la primera escritura (backup() de node:sqlite, WAL-aware).',
    '  --apply                Ejecuta. Sin este flag es dry-run total (0 escrituras).',
    '  --json                 Emite el resultado como JSON.',
    '  --help, -h',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  error.showUsage = true;
  return error;
}

function validationError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw usageError(`${flag} requiere un valor`);
  return value;
}

function inlineValue(arg, prefix, flag) {
  const value = arg.slice(prefix.length);
  if (!value) throw usageError(`${flag} requiere un valor`);
  return value;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    backupDb: false,
    collection: null,
    fields: [],
    help: false,
    json: false,
    workspace: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--backup-db') options.backupDb = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--workspace' || arg.startsWith('--workspace=')) {
      if (options.workspace !== null) {
        throw usageError('--workspace solo puede indicarse una vez');
      }
      options.workspace = arg === '--workspace'
        ? valueAfter(argv, index++, '--workspace')
        : inlineValue(arg, '--workspace=', '--workspace');
    } else if (arg === '--collection' || arg.startsWith('--collection=')) {
      if (options.collection !== null) {
        throw usageError('--collection solo puede indicarse una vez');
      }
      options.collection = arg === '--collection'
        ? valueAfter(argv, index++, '--collection')
        : inlineValue(arg, '--collection=', '--collection');
    } else if (arg === '--field' || arg.startsWith('--field=')) {
      const field = arg === '--field'
        ? valueAfter(argv, index++, '--field')
        : inlineValue(arg, '--field=', '--field');
      options.fields.push(field);
    } else {
      throw usageError(`argumento desconocido: ${arg}`);
    }
  }

  if (!options.help) {
    if (!options.workspace) throw usageError('--workspace es obligatorio');
    if (!options.collection) throw usageError('--collection es obligatorio');
    if (options.fields.length === 0) throw usageError('--field es obligatorio');
  }
  return options;
}

function parseRequestedFields(rawFields) {
  const fields = rawFields.map((raw, index) => {
    let field;
    try {
      field = JSON.parse(raw);
    } catch (error) {
      throw validationError(`--field #${index + 1} no es JSON válido: ${error.message}`);
    }
    if (field === null
      || Array.isArray(field)
      || typeof field !== 'object'
      || Object.getPrototypeOf(field) !== Object.prototype) {
      throw validationError(`--field #${index + 1} debe ser un objeto JSON plano`);
    }
    if (typeof field.key !== 'string' || !field.key || !FIELD_KEY_RE.test(field.key)) {
      throw validationError(
        `--field #${index + 1} tiene key inválida: ${JSON.stringify(field.key)}`,
      );
    }
    return field;
  });

  const seen = new Set();
  for (const field of fields) {
    if (seen.has(field.key)) {
      throw validationError(`key repetida entre --field: ${field.key}`);
    }
    seen.add(field.key);
  }
  return fields;
}

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readCollection(db, workspace, collection) {
  return db.prepare(`
    SELECT c.schema, c.slug
    FROM collections c
    JOIN workspaces w
      ON w.id = c.workspace_id
    WHERE w.slug = ?
      AND c.slug = ?
      AND w.deleted_at IS NULL
      AND c.deleted_at IS NULL
  `).get(workspace, collection);
}

function parseCurrentSchema(actual, workspace, collection) {
  if (typeof actual !== 'string') {
    throw validationError(`schema de ${workspace}/${collection} no es un string`);
  }
  if (!actual.endsWith(']}')) {
    throw validationError(
      `schema de ${workspace}/${collection} no termina exactamente en ]}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(actual);
  } catch (error) {
    throw validationError(
      `schema inválido en ${workspace}/${collection}: ${error.message}`,
    );
  }
  if (!parsed || !Array.isArray(parsed.fields)) {
    throw validationError(`schema inválido en ${workspace}/${collection}: fields no es un array`);
  }
  return parsed;
}

function buildAndVerifySchema(actual, actualParsed, pending) {
  const sufijo = pending.map((field) => JSON.stringify(field)).join(',');
  const nuevo = actual.slice(0, -2) + ',' + sufijo + ']}';
  const oldPrefix = actual.slice(0, -2);

  if (nuevo.startsWith(oldPrefix) !== true) {
    throw validationError('autoverificación fallida: el prefijo viejo no quedó intacto');
  }
  if (nuevo.length <= actual.length) {
    throw validationError('autoverificación fallida: el schema nuevo no creció');
  }

  let newParsed;
  try {
    newParsed = JSON.parse(nuevo);
  } catch (error) {
    throw validationError(`autoverificación fallida: schema nuevo inválido: ${error.message}`);
  }
  const expectedLength = actualParsed.fields.length + pending.length;
  if (!Array.isArray(newParsed.fields) || newParsed.fields.length !== expectedLength) {
    throw validationError(
      `autoverificación fallida: fields esperados=${expectedLength}, reales=${newParsed.fields?.length}`,
    );
  }

  for (let index = 0; index < actualParsed.fields.length; index += 1) {
    const oldField = actualParsed.fields[index];
    const newField = newParsed.fields[index];
    if (oldField?.key !== newField?.key) {
      throw validationError(
        `autoverificación fallida: cambió el orden de fields en el índice ${index}`,
      );
    }
    if (JSON.stringify(oldField) !== JSON.stringify(newField)) {
      throw validationError(
        `autoverificación fallida: cambió el field viejo del índice ${index}`,
      );
    }
  }
  return { nuevo, newParsed };
}

function isRateLimitError(result) {
  const message = String(result?.error || '').toLowerCase();
  return result?.status === 429
    || message.includes('429')
    || message.includes('too many')
    || message.includes('rate limit');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateRetry(operation, label, log) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (!isRateLimitError(result) || attempt >= MAX_RATE_RETRIES) return result;
    const waitMs = Math.min(3000 * (2 ** attempt), 30000);
    log(`[rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`);
    await sleep(waitMs);
  }
}

async function makeBackup(db, log) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '');
  const backupPath = path.join(BACKUP_DIR, `pad-preschema-expand-${stamp}.db`);
  await backup(db, backupPath);
  log(`Backup DB: ${backupPath}`);
  return backupPath;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function resultObject(
  options,
  pending,
  alreadyDeclared,
  actual,
  nuevo,
  fieldsBefore,
  fieldsAfter,
) {
  return {
    ok: true,
    modo: options.apply ? 'apply' : 'dry-run',
    workspace: options.workspace,
    collection: options.collection,
    agregados: pending.map((field) => field.key),
    yaDeclarados: alreadyDeclared.map((field) => field.key),
    bytesAntes: byteLength(actual),
    bytesDespues: byteLength(nuevo),
    fieldsAntes: fieldsBefore,
    fieldsDespues: fieldsAfter,
    backupPath: null,
    verificacionPost: null,
  };
}

function printHuman(result) {
  const mode = result.modo === 'apply' ? 'APPLY' : 'DRY-RUN';
  const writes = result.modo === 'apply' && result.agregados.length > 0 ? 1 : 0;
  console.log(
    `MODO ${mode} · workspace=${result.workspace} · collection=${result.collection}`
    + ` · escrituras=${writes}`,
  );
  console.log(
    `campos-a-agregar=${result.agregados.length}`
    + `${result.agregados.length ? `: ${result.agregados.join(', ')}` : ''}`,
  );
  console.log(
    `ya-declarados=${result.yaDeclarados.length}`
    + `${result.yaDeclarados.length ? `: ${result.yaDeclarados.join(', ')}` : ''}`,
  );
  for (const key of result.yaDeclarados) console.log(`ya-declarado: ${key}`);
  console.log(
    `schema: ${result.bytesAntes} B → ${result.bytesDespues} B`
    + ` (+${result.bytesDespues - result.bytesAntes})`,
  );
  if (result.agregados.length === 0) {
    console.log('nada que hacer');
    return;
  }
  console.log(
    `append-only=OK · prefijo-intacto=OK`
    + ` · fields ${result.fieldsAntes} → ${result.fieldsDespues}`,
  );
  if (result.backupPath) console.log(`backup-db=${result.backupPath}`);
  if (result.verificacionPost === true) console.log('verificacion-post=OK · byte-a-byte=OK');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonRequested = rawArgs.includes('--json');
  let options;

  try {
    options = parseArgs(rawArgs);
    if (options.help) {
      if (options.json) console.log(JSON.stringify({ ok: true, usage: usage() }, null, 2));
      else console.log(usage());
      return 0;
    }

    const fields = parseRequestedFields(options.fields);
    let db = null;
    let actual;
    let actualParsed;
    let pending;
    let alreadyDeclared;
    let nuevo;
    let newParsed;
    let backupPath = null;
    const log = options.json ? () => {} : (message) => console.log(message);

    try {
      db = openDatabase();
      const collection = readCollection(db, options.workspace, options.collection);
      if (!collection) {
        throw validationError(
          `no existe la colección ${options.collection} en ${options.workspace}`,
        );
      }
      actual = collection.schema;
      actualParsed = parseCurrentSchema(actual, options.workspace, options.collection);
      const existingKeys = new Set(
        actualParsed.fields
          .filter((field) => field && typeof field.key === 'string')
          .map((field) => field.key),
      );
      alreadyDeclared = fields.filter((field) => existingKeys.has(field.key));
      pending = fields.filter((field) => !existingKeys.has(field.key));

      if (pending.length === 0) {
        nuevo = actual;
        newParsed = actualParsed;
      } else {
        ({ nuevo, newParsed } = buildAndVerifySchema(actual, actualParsed, pending));
      }

      const ensureBackup = async () => {
        if (!options.backupDb || backupPath) return backupPath;
        try {
          backupPath = await makeBackup(db, log);
        } catch (error) {
          throw validationError(
            `falló el backup de seguridad; no se escribirá el schema: `
            + `${error?.message || String(error)}`,
          );
        }
        return backupPath;
      };
      if (options.apply && pending.length > 0) await ensureBackup();
    } finally {
      if (db) db.close();
    }

    const result = resultObject(
      options,
      pending,
      alreadyDeclared,
      actual,
      nuevo,
      actualParsed.fields.length,
      newParsed.fields.length,
    );
    result.backupPath = backupPath;

    if (options.apply && pending.length > 0) {
      const { updateCollection } = await import('../src/core/pad-service-client.js');
      const updated = await withRateRetry(
        () => updateCollection(
          options.collection,
          { schema: nuevo },
          { workspace: options.workspace },
        ),
        `updateCollection ${options.workspace}/${options.collection}`,
        log,
      );
      if (!updated?.ok) {
        throw validationError(
          `falló updateCollection de ${options.workspace}/${options.collection}: `
          + `${updated?.error || 'respuesta sin ok'}`,
        );
      }

      const verificationDb = openDatabase();
      let reread;
      try {
        reread = readCollection(verificationDb, options.workspace, options.collection);
      } finally {
        verificationDb.close();
      }
      if (!reread || reread.schema !== nuevo) {
        const actualAfter = reread?.schema;
        throw validationError(
          'ERROR de verificación post-escritura: el schema releído no coincide byte a byte'
          + ` (largo esperado=${byteLength(nuevo)} B,`
          + ` largo real=${typeof actualAfter === 'string' ? byteLength(actualAfter) : 'sin-schema'} B)`,
        );
      }
      result.verificacionPost = true;
    }

    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    return 0;
  } catch (error) {
    const message = error?.message || String(error);
    if (jsonRequested) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`ERROR: ${message}`);
      if (error?.showUsage) console.error(usage());
    }
    return 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
