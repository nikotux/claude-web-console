#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import {
  addLink,
  listLinks,
} from '../src/core/pad-service-client.js';

const WORKSPACE = 'console';
const PAD_OPTS = { workspace: WORKSPACE };
const BACKUP_PATH = '/home/nmosquera/.cwc-backups/pad-backup-2026-07-26_21-28-47.db';
const LIVE_PATH = '/home/nmosquera/.pad/pad.db';
const EXPECTED_MISSING = 531;
const EXPECTED_LINK_TYPE = 'implements';
const EXAMPLE_LIMIT = 10;
const MAX_RATE_RETRIES = 8;

const args = process.argv.slice(2);
const apply = args.includes('--apply');

function usage() {
  console.log('Uso: node bin/cwc-pad-links-restore.js [--apply]');
  console.log('Sin --apply hace dry-run. El alcance está fijado por código al workspace console.');
}

function openReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function workspaceId(db, label) {
  const row = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(WORKSPACE);
  if (!row?.id) throw new Error(`${label}: no existe el workspace ${WORKSPACE}`);
  return row.id;
}

function readLinks(db, workspaceIdValue) {
  return db.prepare(
    'SELECT id, source_id, target_id, link_type FROM item_links WHERE workspace_id = ?',
  ).all(workspaceIdValue);
}

function humanRef(item) {
  if (!item?.prefix || !Number.isInteger(item.item_number)) return null;
  return `${item.prefix}-${item.item_number}`;
}

function readLiveItems(db, workspaceIdValue) {
  const rows = db.prepare(`
    SELECT
      i.id,
      i.item_number,
      i.deleted_at,
      c.prefix,
      c.slug AS collection_slug,
      c.deleted_at AS collection_deleted_at
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    WHERE i.workspace_id = ?
  `).all(workspaceIdValue);

  return new Map(rows.map((item) => [
    item.id,
    {
      ...item,
      ref: humanRef(item),
      available: item.deleted_at === null && item.collection_deleted_at === null,
    },
  ]));
}

function countBy(values, keyFn) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFn(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

function graphStats(db, workspaceIdValue) {
  const links = db.prepare(
    'SELECT COUNT(*) AS count FROM item_links WHERE workspace_id = ?',
  ).get(workspaceIdValue).count;
  const activeItemFilter = `
    i.workspace_id = ?
    AND i.deleted_at IS NULL
    AND c.deleted_at IS NULL
  `;
  const items = db.prepare(`
    SELECT COUNT(*) AS count
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    WHERE ${activeItemFilter}
  `).get(workspaceIdValue).count;
  const withoutOutgoing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    WHERE ${activeItemFilter}
      AND NOT EXISTS (
        SELECT 1
        FROM item_links l
        WHERE l.workspace_id = i.workspace_id
          AND l.source_id = i.id
      )
  `).get(workspaceIdValue).count;
  const withoutAnyEdge = db.prepare(`
    SELECT COUNT(*) AS count
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    WHERE ${activeItemFilter}
      AND NOT EXISTS (
        SELECT 1
        FROM item_links l
        WHERE l.workspace_id = i.workspace_id
          AND (l.source_id = i.id OR l.target_id = i.id)
      )
  `).get(workspaceIdValue).count;

  return { links, items, withoutOutgoing, withoutAnyEdge };
}

function buildPlan() {
  const backup = openReadOnly(BACKUP_PATH);
  const live = openReadOnly(LIVE_PATH);
  try {
    const backupWorkspaceId = workspaceId(backup, 'backup');
    const liveWorkspaceId = workspaceId(live, 'DB viva');
    const backupLinks = readLinks(backup, backupWorkspaceId);
    const liveLinks = readLinks(live, liveWorkspaceId);
    const liveLinkIds = new Set(liveLinks.map((link) => link.id));
    const liveItems = readLiveItems(live, liveWorkspaceId);
    const missing = backupLinks
      .filter((link) => !liveLinkIds.has(link.id))
      .map((link) => {
        const source = liveItems.get(link.source_id);
        const target = liveItems.get(link.target_id);
        let skipReason = null;
        if (!source?.available) skipReason = 'source ausente o borrado en la DB viva';
        else if (!target?.available) skipReason = 'target ausente o borrado en la DB viva';
        else if (!source.ref) skipReason = 'no se pudo construir el ref humano del source';
        else if (!target.ref) skipReason = 'no se pudo construir el ref humano del target';
        return {
          ...link,
          sourceRef: source?.ref || null,
          targetRef: target?.ref || null,
          sourceCollection: source?.collection_slug || '[source ausente]',
          skipReason,
        };
      })
      .sort((a, b) => (
        String(a.sourceRef).localeCompare(String(b.sourceRef))
        || String(a.targetRef).localeCompare(String(b.targetRef))
        || String(a.id).localeCompare(String(b.id))
      ));

    return {
      backupStats: graphStats(backup, backupWorkspaceId),
      liveStats: graphStats(live, liveWorkspaceId),
      missing,
    };
  } finally {
    backup.close();
    live.close();
  }
}

function printStats(label, stats) {
  console.log(
    `${label} links=${stats.links} items_activos=${stats.items} `
    + `sin_arista_saliente=${stats.withoutOutgoing} sin_ninguna_arista=${stats.withoutAnyEdge}`,
  );
}

function printPlan(plan) {
  console.log(`MODO ${apply ? 'APPLY' : 'DRY-RUN'} · workspace=${WORKSPACE}`);
  printStats('BACKUP', plan.backupStats);
  printStats('ANTES_DB_VIVA', plan.liveStats);
  console.log(`TOTAL FALTANTE POR ID=${plan.missing.length}`);
  console.log('DESGLOSE POR LINK_TYPE');
  for (const [linkType, count] of countBy(plan.missing, (link) => link.link_type)) {
    console.log(`  ${linkType}: ${count}`);
  }
  console.log('DESGLOSE POR COLECCIÓN DEL SOURCE');
  for (const [collection, count] of countBy(plan.missing, (link) => link.sourceCollection)) {
    console.log(`  ${collection}: ${count}`);
  }
  console.log(`EJEMPLOS (${Math.min(EXAMPLE_LIMIT, plan.missing.length)})`);
  for (const link of plan.missing.slice(0, EXAMPLE_LIMIT)) {
    console.log(`  ${link.sourceRef || link.source_id} --${link.link_type}--> ${link.targetRef || link.target_id}`);
  }
  const skipped = plan.missing.filter((link) => link.skipReason);
  console.log(`NO RESTAURABLES=${skipped.length}`);
  for (const link of skipped) {
    console.log(
      `  [skip] ${link.sourceRef || link.source_id} --${link.link_type}--> `
      + `${link.targetRef || link.target_id}: ${link.skipReason}`,
    );
  }
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
    console.log(`[rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`);
    await sleep(waitMs);
  }
}

function linksArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.links) ? data.links : [];
}

function sameLink(link, candidate) {
  const sameSource = link?.source_id === candidate.source_id
    || link?.source_ref === candidate.sourceRef;
  const sameTarget = link?.target_id === candidate.target_id
    || link?.target_ref === candidate.targetRef;
  return sameSource && sameTarget && link?.link_type === candidate.link_type;
}

function assertKnownState(plan) {
  const typeCounts = countBy(plan.missing, (link) => link.link_type);
  const exactlyImplements = typeCounts.length === 1
    && typeCounts[0][0] === EXPECTED_LINK_TYPE
    && typeCounts[0][1] === EXPECTED_MISSING;
  if (plan.missing.length !== EXPECTED_MISSING || !exactlyImplements) {
    throw new Error(
      `precondición incumplida: se esperaban exactamente ${EXPECTED_MISSING} links `
      + `${EXPECTED_LINK_TYPE}; no se aplicó ninguna escritura`,
    );
  }
}

async function restore(plan) {
  assertKnownState(plan);
  const stats = { created: 0, alreadyPresent: 0, skippedMissingItem: 0 };

  for (let index = 0; index < plan.missing.length; index += 1) {
    const candidate = plan.missing[index];
    const position = `${index + 1}/${plan.missing.length}`;
    const edge = `${candidate.sourceRef || candidate.source_id} --${candidate.link_type}--> ${candidate.targetRef || candidate.target_id}`;

    if (candidate.skipReason) {
      stats.skippedMissingItem += 1;
      console.log(`[${position}] [skip] ${edge}: ${candidate.skipReason}`);
      continue;
    }

    const listed = await withRateRetry(
      () => listLinks(candidate.sourceRef, PAD_OPTS),
      `listLinks ${candidate.sourceRef}`,
    );
    if (!listed?.ok) {
      throw new Error(`[${position}] ${edge}: listLinks falló: ${listed?.error || 'error desconocido'}`);
    }
    if (linksArray(listed.data).some((link) => sameLink(link, candidate))) {
      stats.alreadyPresent += 1;
      console.log(`[${position}] [skip existente] ${edge}`);
      continue;
    }

    const created = await withRateRetry(
      () => addLink(candidate.sourceRef, candidate.targetRef, candidate.link_type, PAD_OPTS),
      `addLink ${edge}`,
    );
    if (!created?.ok) {
      throw new Error(`[${position}] ${edge}: addLink falló: ${created?.error || 'error desconocido'}`);
    }
    stats.created += 1;
    console.log(`[${position}] [restaurado] ${edge}`);
  }

  return stats;
}

function verifyAgainstBackup() {
  const backup = openReadOnly(BACKUP_PATH);
  const live = openReadOnly(LIVE_PATH);
  try {
    const backupStats = graphStats(backup, workspaceId(backup, 'backup'));
    const liveStats = graphStats(live, workspaceId(live, 'DB viva'));
    return {
      backupStats,
      liveStats,
      matches: backupStats.links === liveStats.links
        && backupStats.withoutOutgoing === liveStats.withoutOutgoing
        && backupStats.withoutAnyEdge === liveStats.withoutAnyEdge,
    };
  } finally {
    backup.close();
    live.close();
  }
}

try {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }
  const unknownArgs = args.filter((arg) => arg !== '--apply');
  if (unknownArgs.length > 0) {
    usage();
    throw new Error(`argumentos desconocidos: ${unknownArgs.join(' ')}`);
  }

  const plan = buildPlan();
  printPlan(plan);
  assertKnownState(plan);

  if (!apply) {
    console.log('DRY-RUN COMPLETO · escrituras=0 · precondición 531 implements confirmada');
    process.exit(0);
  }

  const restored = await restore(plan);
  console.log(`RESUMEN APPLY ${JSON.stringify(restored)}`);
  const verification = verifyAgainstBackup();
  printStats('OBJETIVO_BACKUP', verification.backupStats);
  printStats('DESPUÉS_DB_VIVA', verification.liveStats);
  if (!verification.matches) {
    throw new Error('la verificación final no coincide con el backup');
  }
  console.log('VERIFICACIÓN OK · el conteo de links y los ítems sin aristas coinciden con el backup');
} catch (error) {
  console.error(`cwc-pad-links-restore falló: ${error?.message || error}`);
  process.exit(1);
}
