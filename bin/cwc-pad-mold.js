#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MOLD, MOLD_VERSION, readMoldState, recordMoldVersion } from '../src/core/pad-mold.js';
import {
  createCollection,
  listCollections,
  listItems,
  updateCollection,
} from '../src/core/pad-service-client.js';
import { readUserPadToken } from '../src/core/user-space.js';

const PAD_URL = process.env.CWC_PAD_URL || 'http://10.213.222.62:7777';
const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const TENANT_WORKSPACE_RE = /^tenant-[a-zA-Z0-9_.-]{1,32}$/;
const EXCLUDED_WORKSPACES = new Set(['console', 'tolkien', 'comunidad']);
const SLEEP_MS = 400;
const MAX_RATE_RETRIES = 8;

function usage() {
  return [
    'Uso:',
    '  node bin/cwc-pad-mold.js [--audit]',
    '  node bin/cwc-pad-mold.js --apply <workspace-slug>',
    '  node bin/cwc-pad-mold.js --apply-all',
    '',
    'Audit no escribe. Apply opera solo sobre workspaces tenant-* activos.',
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function parseArgs(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--audit')) {
    return { mode: 'audit', workspace: null };
  }
  if (argv.length === 1 && argv[0] === '--apply-all') {
    return { mode: 'apply-all', workspace: null };
  }
  if (argv.length === 2 && argv[0] === '--apply') {
    return { mode: 'apply', workspace: argv[1] };
  }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { mode: 'help', workspace: null };
  }
  throw usageError('argumentos inválidos');
}

function isTenantWorkspace(slug) {
  return TENANT_WORKSPACE_RE.test(slug) && !EXCLUDED_WORKSPACES.has(slug);
}

function assertSafeTarget(slug) {
  if (EXCLUDED_WORKSPACES.has(slug)) {
    throw usageError(`workspace protegido: ${slug}`);
  }
  if (!isTenantWorkspace(slug)) {
    throw usageError(`workspace fuera del alcance tenant-*: ${slug || '[vacío]'}`);
  }
}

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readTenantWorkspaces() {
  const db = openDatabase();
  try {
    const rows = db.prepare(`
      SELECT w.slug AS workspace, c.slug AS collection, c.prefix, c.schema
      FROM workspaces w
      LEFT JOIN collections c
        ON c.workspace_id = w.id
        AND c.deleted_at IS NULL
      WHERE w.deleted_at IS NULL
      ORDER BY w.slug, c.slug
    `).all();
    const workspaces = new Map();
    for (const row of rows) {
      if (!isTenantWorkspace(row.workspace)) continue;
      if (!workspaces.has(row.workspace)) workspaces.set(row.workspace, []);
      if (row.collection) {
        workspaces.get(row.workspace).push({
          slug: row.collection,
          prefix: row.prefix,
          schema: row.schema,
        });
      }
    }
    return [...workspaces.entries()].map(([workspace, collections]) => ({
      workspace,
      collections,
    }));
  } finally {
    db.close();
  }
}

function missingCollections(present) {
  const slugs = new Set(present.map((collection) => (
    typeof collection === 'string' ? collection : collection.slug
  )));
  return MOLD.filter((collection) => !slugs.has(collection.slug));
}

function prefixDivergences(present) {
  return MOLD.flatMap((expected) => {
    const actual = present.find((collection) => collection.slug === expected.slug);
    if (!actual || actual.prefix === expected.prefix) return [];
    return [{ slug: expected.slug, actual: actual.prefix, expected: expected.prefix }];
  });
}

function schemaDivergences(present) {
  return MOLD.flatMap((expected) => {
    const actual = present.find((collection) => collection.slug === expected.slug);
    if (!actual || actual.schema === expected.schema) return [];
    return [{ slug: expected.slug, actual: actual.schema, expected: expected.schema }];
  });
}

function isAppendOnlySchema(divergence) {
  return typeof divergence.actual === 'string'
    && divergence.actual.endsWith(']}')
    && divergence.expected.length > divergence.actual.length
    && divergence.expected.startsWith(divergence.actual.slice(0, -2));
}

function versionLabel(state, workspace) {
  const entry = state[workspace];
  if (!Number.isInteger(entry?.version)) return `sin-registro (esperado=v${MOLD_VERSION})`;
  if (entry.version < MOLD_VERSION) {
    return `v${entry.version} (desactualizado; esperado=v${MOLD_VERSION})`;
  }
  return `v${entry.version}`;
}

function formatPrefixDivergence(divergence) {
  return `${divergence.slug} (${divergence.actual || 'sin-prefijo'} → ${divergence.expected})`;
}

function printAudit(workspaces) {
  const state = readMoldState();
  console.log(`MODO AUDIT · molde=v${MOLD_VERSION} · escrituras=0`);
  if (workspaces.length === 0) {
    console.log('Sin workspaces tenant-* activos.');
    return;
  }
  for (const entry of workspaces) {
    const missing = missingCollections(entry.collections).map((collection) => collection.slug);
    const divergent = prefixDivergences(entry.collections).map(formatPrefixDivergence);
    const schemaDivergent = schemaDivergences(entry.collections).map((divergence) => divergence.slug);
    console.log(entry.workspace);
    console.log(`  version=${versionLabel(state, entry.workspace)}`);
    console.log(`  presentes=${entry.collections.length ? entry.collections.map((collection) => collection.slug).join(', ') : '(ninguna)'}`);
    console.log(`  faltantes=${missing.length ? missing.join(', ') : '(ninguna)'}`);
    console.log(`  prefijo-divergente=${divergent.length ? divergent.join(', ') : '(ninguno)'}`);
    console.log(`  schema-divergente=${schemaDivergent.length ? schemaDivergent.join(', ') : '(ninguno)'}`);
  }
}

function collectionsArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.collections) ? data.collections : [];
}

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
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

async function withRateRetry(operation, label) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (!isRateLimitError(result) || attempt >= MAX_RATE_RETRIES) return result;
    const waitMs = Math.min(3000 * (2 ** attempt), 30000);
    console.log(`  [rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`);
    await sleep(waitMs);
  }
}

async function applyWorkspace(workspace) {
  assertSafeTarget(workspace);
  const counts = {
    created: 0,
    prefixesFixed: 0,
    prefixesWithData: 0,
    schemasFixed: 0,
    schemasUnsafe: 0,
  };
  const userId = workspace.slice('tenant-'.length);
  const token = readUserPadToken(userId, PAD_URL);
  if (!token) {
    console.log(`${workspace}: sin-token`);
    return { workspace, status: 'sin-token', ...counts };
  }

  const opts = { ctx: { url: PAD_URL, token, workspace } };
  const listed = await withRateRetry(
    () => listCollections(opts),
    `listar colecciones de ${workspace}`,
  );
  if (!listed.ok) {
    console.log(`${workspace}: error al listar colecciones: ${listed.error}`);
    return { workspace, status: 'error', ...counts };
  }

  const present = collectionsArray(listed.data);
  const missing = missingCollections(present);
  console.log(`${workspace}: faltan ${missing.length}; prefijos divergentes ${prefixDivergences(present).length}; schemas divergentes ${schemaDivergences(present).length}`);
  for (const collection of missing) {
    const created = await withRateRetry(
      () => createCollection(collection, opts),
      `crear ${workspace}/${collection.slug}`,
    );
    if (!created.ok) {
      console.log(`  [error] ${collection.slug}: ${created.error}`);
      return { workspace, status: 'error', ...counts };
    }
    counts.created += 1;
    console.log(`  [creada] ${collection.slug}`);
    await sleep(SLEEP_MS);
  }

  const afterCreate = await withRateRetry(
    () => listCollections(opts),
    `verificar creación de colecciones de ${workspace}`,
  );
  if (!afterCreate.ok) {
    console.log(`  [error] no se pudieron verificar las colecciones: ${afterCreate.error}`);
    return { workspace, status: 'error', ...counts };
  }

  const divergent = prefixDivergences(collectionsArray(afterCreate.data));
  const schemaDivergent = schemaDivergences(collectionsArray(afterCreate.data));
  let operationErrors = 0;
  for (const divergence of divergent) {
    const listedItems = await withRateRetry(
      () => listItems(divergence.slug, opts),
      `contar ítems de ${workspace}/${divergence.slug}`,
    );
    if (!listedItems.ok) {
      operationErrors += 1;
      console.log(`  [error] no se contaron ítems de ${divergence.slug}: ${listedItems.error}`);
      continue;
    }

    const itemCount = itemsArray(listedItems.data).length;
    // Cambiar el prefijo reescribe el ref visible de todos los ítems: solo es
    // seguro hacerlo cuando la colección no tiene ningún ítem no archivado.
    if (itemCount > 0) {
      counts.prefixesWithData += 1;
      console.log(`  [omitida] prefijo-divergente-con-datos=${formatPrefixDivergence(divergence)}; items=${itemCount}`);
      await sleep(SLEEP_MS);
      continue;
    }

    const updated = await withRateRetry(
      () => updateCollection(divergence.slug, { prefix: divergence.expected }, opts),
      `corregir prefijo de ${workspace}/${divergence.slug}`,
    );
    if (!updated.ok) {
      operationErrors += 1;
      console.log(`  [error] prefijo ${divergence.slug}: ${updated.error}`);
      continue;
    }
    counts.prefixesFixed += 1;
    console.log(`  [prefijo-corregido] ${formatPrefixDivergence(divergence)}`);
    await sleep(SLEEP_MS);
  }

  for (const divergence of schemaDivergent) {
    if (!isAppendOnlySchema(divergence)) {
      counts.schemasUnsafe += 1;
      console.log(`  [omitida] schema-divergente=${divergence.slug}; el molde no agrega fields solo al final`);
      continue;
    }

    const updated = await withRateRetry(
      () => updateCollection(divergence.slug, { schema: divergence.expected }, opts),
      `corregir schema de ${workspace}/${divergence.slug}`,
    );
    if (!updated.ok) {
      operationErrors += 1;
      console.log(`  [error] schema ${divergence.slug}: ${updated.error}`);
      continue;
    }

    const reread = await withRateRetry(
      () => listCollections(opts),
      `releer schema de ${workspace}/${divergence.slug}`,
    );
    const actual = reread.ok
      ? collectionsArray(reread.data).find((collection) => collection.slug === divergence.slug)
      : null;
    if (!reread.ok || actual?.schema !== divergence.expected) {
      operationErrors += 1;
      const detail = reread.ok ? 'la relectura no coincide byte a byte' : reread.error;
      console.log(`  [error] schema ${divergence.slug}: ${detail}`);
      continue;
    }

    counts.schemasFixed += 1;
    console.log(`  [schema-corregido] ${divergence.slug}`);
    await sleep(SLEEP_MS);
  }

  const verified = await withRateRetry(
    () => listCollections(opts),
    `verificar molde de ${workspace}`,
  );
  const verifiedCollections = verified.ok ? collectionsArray(verified.data) : [];
  const stillMissing = verified.ok ? missingCollections(verifiedCollections) : MOLD;
  const stillDivergent = verified.ok ? prefixDivergences(verifiedCollections) : divergent;
  const stillSchemaDivergent = verified.ok ? schemaDivergences(verifiedCollections) : schemaDivergent;
  if (!verified.ok
    || operationErrors > 0
    || stillMissing.length > 0
    || stillDivergent.length > 0
    || stillSchemaDivergent.length > 0) {
    const requiresDecision = operationErrors === 0
      && stillMissing.length === 0
      && stillDivergent.length === counts.prefixesWithData
      && stillSchemaDivergent.length === counts.schemasUnsafe;
    const detail = !verified.ok
      ? verified.error
      : [
          stillMissing.length ? `faltantes=${stillMissing.map((collection) => collection.slug).join(', ')}` : null,
          stillDivergent.length ? `prefijo-divergente=${stillDivergent.map(formatPrefixDivergence).join(', ')}` : null,
          stillSchemaDivergent.length ? `schema-divergente=${stillSchemaDivergent.map((divergence) => divergence.slug).join(', ')}` : null,
          operationErrors ? `errores=${operationErrors}` : null,
        ].filter(Boolean).join('; ');
    console.log(`  [${requiresDecision ? 'requiere-decision' : 'error'}] no se registró la versión: ${detail}`);
    const status = requiresDecision ? 'requiere-decision' : 'error';
    return { workspace, status, ...counts };
  }

  recordMoldVersion(workspace);
  console.log(`  [ok] versión v${MOLD_VERSION} registrada`);
  return { workspace, status: 'ok', ...counts };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help') {
    console.log(usage());
    return;
  }

  const workspaces = readTenantWorkspaces();
  if (options.mode === 'audit') {
    printAudit(workspaces);
    return;
  }

  let targets;
  if (options.mode === 'apply') {
    assertSafeTarget(options.workspace);
    if (!workspaces.some((entry) => entry.workspace === options.workspace)) {
      throw usageError(`workspace tenant activo inexistente: ${options.workspace}`);
    }
    targets = [options.workspace];
  } else {
    targets = workspaces.map((entry) => entry.workspace);
  }

  console.log(`MODO APPLY · molde=v${MOLD_VERSION} · targets=${targets.length}`);
  const results = [];
  for (const workspace of targets) {
    results.push(await applyWorkspace(workspace));
  }
  const ok = results.filter((result) => result.status === 'ok').length;
  const withoutToken = results.filter((result) => result.status === 'sin-token').length;
  const requiresDecision = results.filter((result) => result.status === 'requiere-decision').length;
  const errors = results.filter((result) => result.status === 'error').length;
  const created = results.reduce((sum, result) => sum + result.created, 0);
  const prefixesFixed = results.reduce((sum, result) => sum + result.prefixesFixed, 0);
  const prefixesWithData = results.reduce((sum, result) => sum + result.prefixesWithData, 0);
  const schemasFixed = results.reduce((sum, result) => sum + result.schemasFixed, 0);
  const schemasUnsafe = results.reduce((sum, result) => sum + result.schemasUnsafe, 0);
  console.log(`RESUMEN ok=${ok} sin-token=${withoutToken} requieren-decision=${requiresDecision} errores=${errors} creadas=${created} prefijos-corregidos=${prefixesFixed} prefijos-divergentes-con-datos=${prefixesWithData} schemas-corregidos=${schemasFixed} schemas-requieren-decision=${schemasUnsafe}`);
  if (withoutToken > 0 || requiresDecision > 0 || errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  if (error.exitCode) console.error(usage());
  process.exitCode = error.exitCode || 1;
});
