#!/usr/bin/env node
import {
  deleteLink,
  getItem,
  listCollections,
  listItems,
  listLinks,
  setParent,
} from '../src/core/pad-service-client.js';

const WORKSPACE = 'console';
const PAD_OPTS = { workspace: WORKSPACE };
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyReparents = args.includes('--only-reparents');

const REPARENTS = [
  { ref: 'PLAN-507', oldParent: 'ARQUI-1271', newParent: 'ARQUI-1425' },
  { ref: 'PLAN-272', oldParent: 'ARQUI-1282', newParent: 'ARQUI-1452' },
];

function usage() {
  console.log('Uso: cwc-pad-graph-fix.js [--apply] [--only-reparents]');
  console.log('Sin --apply hace dry-run y no escribe nada. El alcance siempre es el workspace console.');
  console.log('--only-reparents ejecuta únicamente el Trabajo A y omite por completo el Trabajo B.');
}

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

function linksArray(data) {
  return Array.isArray(data) ? data : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(result) {
  const msg = String(result?.error || '').toLowerCase();
  return result?.status === 429 || msg.includes('429') || msg.includes('too many') || msg.includes('rate');
}

async function withRateRetry(operation) {
  const first = await operation();
  if (first?.ok === false && isRateLimitError(first)) {
    await sleep(500);
    return operation();
  }
  return first;
}

function outgoingLinks(ref, links) {
  return links.filter((link) => link?.source_ref === ref);
}

function parentLinks(ref, links) {
  return outgoingLinks(ref, links).filter((link) => link?.link_type === 'parent');
}

async function readLinks(ref) {
  const result = await withRateRetry(() => listLinks(ref, PAD_OPTS));
  if (!result.ok) {
    throw new Error(`${ref}: no se pudieron listar links: ${result.error || 'error desconocido'}`);
  }
  return linksArray(result.data);
}

async function inventory() {
  const collections = await withRateRetry(() => listCollections(PAD_OPTS));
  if (!collections.ok) {
    throw new Error(`no se pudieron listar colecciones de ${WORKSPACE}: ${collections.error || 'error desconocido'}`);
  }

  const items = [];
  const slugs = itemsArray(collections.data)
    .map((collection) => collection?.slug)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  for (const slug of slugs) {
    const result = await withRateRetry(() => listItems(slug, PAD_OPTS));
    if (!result.ok) {
      throw new Error(`[${slug}] no se pudieron listar items: ${result.error || 'error desconocido'}`);
    }
    for (const item of itemsArray(result.data)) {
      if (item?.ref) items.push({ ...item, collection: slug });
    }
  }

  return { items, slugs };
}

async function buildPlan(items, includeRedundantImplements = true) {
  const itemByRef = new Map(items.map((item) => [item.ref, item]));
  const linksByRef = new Map();
  const redundantImplements = [];
  const refsToRead = includeRedundantImplements
    ? items
    : REPARENTS.map(({ ref }) => itemByRef.get(ref)).filter(Boolean);

  for (const item of refsToRead) {
    const links = await readLinks(item.ref);
    linksByRef.set(item.ref, links);

    if (!includeRedundantImplements) continue;
    for (const link of outgoingLinks(item.ref, links)) {
      if (
        link?.id
        && link?.link_type === 'implements'
        && link?.target_ref
        && link.target_ref === item.parent_ref
      ) {
        redundantImplements.push({
          id: link.id,
          sourceRef: item.ref,
          targetRef: link.target_ref,
          collection: item.collection,
        });
      }
    }
  }

  redundantImplements.sort((a, b) => (
    a.sourceRef.localeCompare(b.sourceRef)
    || a.targetRef.localeCompare(b.targetRef)
    || String(a.id).localeCompare(String(b.id))
  ));

  const reparents = [];
  for (const wanted of REPARENTS) {
    const item = itemByRef.get(wanted.ref);
    const links = linksByRef.get(wanted.ref) || [];
    let detail = item;
    if (item) {
      const detailResult = await withRateRetry(() => getItem(wanted.ref, PAD_OPTS));
      if (!detailResult.ok || !detailResult.data) {
        throw new Error(`${wanted.ref}: no se pudo leer el detalle: ${detailResult.error || 'respuesta vacía'}`);
      }
      detail = detailResult.data;
    }
    const outgoing = outgoingLinks(wanted.ref, links);
    const oldCandidates = outgoing.filter((link) => (
      (link?.link_type === 'parent' || link?.link_type === 'implements')
      && link?.target_ref === wanted.oldParent
    ));
    const oldTargetId = detail?.parent_ref === wanted.oldParent ? detail?.parent_link_id : null;
    const oldLink = oldCandidates.find((link) => oldTargetId && link?.target_id === oldTargetId)
      || oldCandidates[0]
      || null;
    const newParentPresent = parentLinks(wanted.ref, links)
      .some((link) => link?.target_ref === wanted.newParent);
    const otherParents = parentLinks(wanted.ref, links)
      .map((link) => link?.target_ref)
      .filter((target) => target && target !== wanted.oldParent && target !== wanted.newParent);
    reparents.push({
      ...wanted,
      itemFound: Boolean(item),
      oldLinkId: oldLink?.id || null,
      oldLinkType: oldLink?.link_type || null,
      newParentPresent,
      otherParents,
    });
  }

  const reparentLinkIds = new Set(reparents.map((entry) => entry.oldLinkId).filter(Boolean));
  return {
    redundantImplements: redundantImplements.filter((link) => !reparentLinkIds.has(link.id)),
    reparents,
  };
}

function printPlan(plan, inventoryStats) {
  console.log(`MODO DRY-RUN · workspace=${WORKSPACE} · escrituras=0`);
  console.log(`INVENTARIO colecciones=${inventoryStats.slugs.length} items=${inventoryStats.items.length}`);
  console.log('=== TRABAJO A · REPARENTS ===');
  for (const entry of plan.reparents) {
    if (!entry.itemFound) {
      console.log(`[skip] ${entry.ref}: item no encontrado`);
    } else if (!entry.oldLinkId && entry.newParentPresent) {
      console.log(`[ok] ${entry.ref}: parent ya es ${entry.newParent}`);
    } else if (!entry.oldLinkId && entry.otherParents.length > 0) {
      console.log(`[skip] ${entry.ref}: parent inesperado ${entry.otherParents.join(', ')}`);
    } else if (!entry.oldLinkId) {
      console.log(`[dry] ${entry.ref}: parent viejo ya ausente; crear parent ${entry.newParent} (recuperación idempotente)`);
    } else {
      const createStep = entry.newParentPresent ? 'parent nuevo ya presente' : `crear parent ${entry.newParent}`;
      console.log(`[dry] ${entry.ref}: borrar ${entry.oldLinkType} ${entry.oldParent} link=${entry.oldLinkId}; ${createStep}`);
    }
  }

  console.log('=== TRABAJO B · IMPLEMENTS REDUNDANTES ===');
  for (const link of plan.redundantImplements) {
    console.log(`[dry] ${link.sourceRef} -> ${link.targetRef} tipo=implements link=${link.id} colección=${link.collection}`);
  }

  const reparentChanges = plan.reparents.filter((entry) => (
    entry.itemFound
    && (
      Boolean(entry.oldLinkId)
      || (!entry.newParentPresent && entry.otherParents.length === 0)
    )
  )).length;
  const oldLinksToDelete = plan.reparents.filter((entry) => entry.oldLinkId).length;
  console.log(
    `TOTAL dry-run reparents=${reparentChanges} implements_a_borrar=${plan.redundantImplements.length} `
    + `links_a_borrar=${plan.redundantImplements.length + oldLinksToDelete} escrituras=0`,
  );
}

async function applyReparent(entry, stats) {
  if (!entry.itemFound) {
    stats.reparentsSkipped += 1;
    console.log(`[skip] ${entry.ref}: item no encontrado`);
    return;
  }

  const itemResult = await withRateRetry(() => getItem(entry.ref, PAD_OPTS));
  if (!itemResult.ok || !itemResult.data) {
    stats.errors += 1;
    throw new Error(`${entry.ref}: no se pudo leer el estado actual: ${itemResult.error || 'respuesta vacía'}`);
  }
  const item = itemResult.data;
  let links = await readLinks(entry.ref);
  let parents = parentLinks(entry.ref, links);
  const oldCandidates = outgoingLinks(entry.ref, links).filter((link) => (
    (link?.link_type === 'parent' || link?.link_type === 'implements')
    && link?.target_ref === entry.oldParent
  ));
  const oldTargetId = item.parent_ref === entry.oldParent ? item.parent_link_id : null;
  const oldLink = oldCandidates.find((link) => oldTargetId && link?.target_id === oldTargetId)
    || oldCandidates[0]
    || null;

  if (!oldLink && parents.some((link) => link?.target_ref === entry.newParent)) {
    stats.reparentsSkipped += 1;
    console.log(`[skip] ${entry.ref}: parent ${entry.newParent} ya presente`);
    return;
  }
  const unexpected = parents.filter((link) => (
    link?.target_ref !== entry.oldParent && link?.target_ref !== entry.newParent
  ));
  if (!oldLink && unexpected.length > 0) {
    stats.reparentsSkipped += 1;
    console.log(`[skip] ${entry.ref}: parent actual inesperado ${unexpected.map((link) => link.target_ref).join(', ')}`);
    return;
  }

  if (oldLink) {
    const deleted = await withRateRetry(() => deleteLink(oldLink.id, PAD_OPTS));
    if (!deleted.ok) {
      stats.errors += 1;
      throw new Error(`${entry.ref}: no se pudo borrar ${oldLink.link_type} ${entry.oldParent} link=${oldLink.id}: ${deleted.error || 'error desconocido'}`);
    }
    stats.parentLinksDeleted += 1;
    console.log(`[fix] ${entry.ref}: borrado ${oldLink.link_type} ${entry.oldParent} link=${oldLink.id}`);
  }

  links = await readLinks(entry.ref);
  parents = parentLinks(entry.ref, links);
  if (parents.some((link) => link?.target_ref === entry.newParent)) {
    stats.reparentsDone += 1;
    console.log(`[fix] ${entry.ref}: parent ${entry.newParent} ya quedó presente`);
    return;
  }
  if (parents.length > 0) {
    stats.reparentsSkipped += 1;
    console.log(`[skip] ${entry.ref}: apareció otro parent antes de crear ${entry.newParent}`);
    return;
  }

  const created = await withRateRetry(() => setParent(entry.ref, entry.newParent, PAD_OPTS));
  if (!created.ok) {
    stats.errors += 1;
    throw new Error(`${entry.ref}: no se pudo crear parent ${entry.newParent}: ${created.error || 'error desconocido'}`);
  }
  stats.reparentsDone += 1;
  stats.parentLinksCreated += 1;
  console.log(`[fix] ${entry.ref}: creado parent ${entry.newParent}`);
}

async function applyRedundantImplements(candidate, stats) {
  const itemResult = await withRateRetry(() => getItem(candidate.sourceRef, PAD_OPTS));
  if (!itemResult.ok || !itemResult.data) {
    stats.errors += 1;
    throw new Error(`${candidate.sourceRef}: no se pudo leer el estado actual: ${itemResult.error || 'respuesta vacía'}`);
  }
  const links = await readLinks(candidate.sourceRef);
  const outgoing = outgoingLinks(candidate.sourceRef, links);
  const current = outgoing.find((link) => link?.id === candidate.id);
  if (!current) {
    stats.implementsSkipped += 1;
    console.log(`[skip] ${candidate.sourceRef}: link ${candidate.id} ya no existe`);
    return;
  }
  if (current.link_type !== 'implements' || current.target_ref !== candidate.targetRef) {
    stats.implementsSkipped += 1;
    console.log(`[skip] ${candidate.sourceRef}: link ${candidate.id} cambió de tipo o target`);
    return;
  }
  if (itemResult.data.parent_ref !== candidate.targetRef) {
    stats.implementsSkipped += 1;
    console.log(`[skip] ${candidate.sourceRef}: ${candidate.targetRef} ya no es su parent`);
    return;
  }

  const deleted = await withRateRetry(() => deleteLink(candidate.id, PAD_OPTS));
  if (!deleted.ok) {
    stats.errors += 1;
    throw new Error(`${candidate.sourceRef}: no se pudo borrar implements ${candidate.targetRef} link=${candidate.id}: ${deleted.error || 'error desconocido'}`);
  }
  stats.implementsDeleted += 1;
  console.log(`[fix] ${candidate.sourceRef} -> ${candidate.targetRef} tipo=implements link=${candidate.id}`);
}

try {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }
  const unknownArgs = args.filter((arg) => arg !== '--apply' && arg !== '--only-reparents');
  if (unknownArgs.length > 0) {
    usage();
    console.error(`Argumentos desconocidos: ${unknownArgs.join(' ')}`);
    process.exit(1);
  }

  const inventoryStats = await inventory();
  const plan = await buildPlan(inventoryStats.items, !onlyReparents);

  if (!apply) {
    printPlan(plan, inventoryStats);
    process.exit(0);
  }

  console.log(`MODO APPLY · workspace=${WORKSPACE}${onlyReparents ? ' · solo_reparents=true' : ''}`);
  const stats = {
    reparentsDone: 0,
    reparentsSkipped: 0,
    parentLinksDeleted: 0,
    parentLinksCreated: 0,
    implementsDeleted: 0,
    implementsSkipped: 0,
    errors: 0,
  };

  for (const entry of plan.reparents) {
    await applyReparent(entry, stats);
  }
  if (!onlyReparents) {
    for (const candidate of plan.redundantImplements) {
      await applyRedundantImplements(candidate, stats);
    }
  }

  console.log(`RESUMEN apply ${JSON.stringify(stats)}`);
  process.exit(stats.errors > 0 ? 1 : 0);
} catch (err) {
  console.error(`cwc-pad-graph-fix falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
