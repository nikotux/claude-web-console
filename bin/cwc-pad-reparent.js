#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { addLink, deleteLink, listLinks, setParent, listItems } from '../src/core/pad-service-client.js';

const args = process.argv.slice(2);
const dryRun = args.some((arg) => arg === '--dry-run' || arg === '-n');
const linkIndex = args.findIndex((arg) => arg === '--link');
const linkValue = linkIndex >= 0 ? args[linkIndex + 1] : undefined;
const linkMode = linkValue === 'implements' || linkValue === 'parent' ? linkValue : 'parent';
const supersede = args.includes('--supersede-arqui-refs');

function usage() {
  console.error('Uso: cwc-pad-reparent --map <ruta.json> [--dry-run]');
  console.error('   o: cwc-pad-reparent REF=uidNodoARQUI [REF=uidNodoARQUI ...] [--dry-run]');
  console.error("      --link <parent|implements> (default parent; 'implements' re-apunta una referencia sin tocar el parent — para ítems data-viva)");
  console.error('      --supersede-arqui-refs (al reparentar/re-apuntar, elimina otros links implements de ese ítem hacia nodos de arquitectura distintos del target — limpia la referencia v1 superada)');
}

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
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

function parseFields(item) {
  const raw = item?.fields;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadMap() {
  const mapIndex = args.findIndex((arg) => arg === '--map');
  const entries = {};

  if (mapIndex >= 0) {
    const path = args[mapIndex + 1];
    if (!path || path.startsWith('-')) {
      throw new Error('--map requiere una ruta JSON');
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`no se pudo leer/parsear --map ${path}: ${err?.message || err}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--map debe ser un objeto JSON {ref: parentRef}');
    }

    Object.assign(entries, parsed);
  }

  for (const arg of args) {
    if (arg === '--dry-run' || arg === '-n' || arg === '--map' || arg === '--link' || arg === '--supersede-arqui-refs') continue;
    if (mapIndex >= 0 && arg === args[mapIndex + 1]) continue;
    if (linkIndex >= 0 && arg === args[linkIndex + 1]) continue;
    const eq = arg.indexOf('=');
    if (eq <= 0) continue;
    entries[arg.slice(0, eq)] = arg.slice(eq + 1);
  }

  return entries;
}

function buildPlan(ref, targetRef, links, arquiRefSet, opts) {
  const outgoing = links.filter((link) => link?.source_ref === ref);
  const parentLinks = outgoing.filter((link) => link?.link_type === 'parent');
  const implLinks = outgoing.filter((link) => link?.link_type === 'implements');
  const implTargets = new Set(implLinks.map((link) => link?.target_ref).filter(Boolean));
  const plan = [];

  if (opts.supersede) {
    for (const link of implLinks) {
      if (link?.target_ref && link.target_ref !== targetRef && arquiRefSet.has(link.target_ref)) {
        plan.push({ op: 'deleteLink', id: link.id, desc: `superseder referencia ARQUI vieja ${ref}->${link.target_ref}` });
      }
    }
  }

  if (opts.linkMode === 'implements') {
    if (!implTargets.has(targetRef)) {
      plan.push({ op: 'addLink', target: targetRef, type: 'implements', desc: `referencia por concern -> ${targetRef}` });
    }
    return plan;
  }

  for (const link of implLinks) {
    if (link?.target_ref === targetRef) {
      plan.push({ op: 'deleteLink', id: link.id, desc: `borrar implements duplicado ${ref}->${targetRef}` });
    }
  }

  let primaryParentSeen = false;
  for (const link of parentLinks) {
    const target = link?.target_ref;
    if (target === targetRef) {
      if (primaryParentSeen) {
        plan.push({ op: 'deleteLink', id: link.id, desc: 'quitar parent duplicado' });
      }
      primaryParentSeen = true;
      continue;
    }

    if (!arquiRefSet.has(target) && !implTargets.has(target)) {
      plan.push({ op: 'addLink', target, type: 'implements', desc: `preservar sol no-ARQUI ${target} como referencia` });
    }
    plan.push({ op: 'deleteLink', id: link.id, desc: `quitar parent no-primario ${target}` });
  }

  if (!primaryParentSeen) {
    plan.push({ op: 'setParent', target: targetRef, desc: `hogar estructural -> ${targetRef}` });
  }

  return plan;
}

try {
  const mapping = loadMap();
  const pairs = Object.entries(mapping);
  if (!pairs.length) {
    usage();
    process.exit(1);
  }

  const arqui = await withRateRetry(() => listItems('arquitectura'));
  if (!arqui.ok) {
    console.error(`[err] arquitectura: no se pudieron listar items: ${arqui.error || 'error desconocido'}`);
    process.exit(1);
  }

  const uidToNode = new Map();
  const arquiRefSet = new Set();
  for (const item of itemsArray(arqui.data)) {
    if (item?.ref) arquiRefSet.add(item.ref);
    const fields = parseFields(item);
    if (fields.uid && !uidToNode.has(fields.uid)) {
      uidToNode.set(fields.uid, { ref: item.ref, status: fields.status });
    }
  }

  const stats = {
    entries: 0,
    conforme: 0,
    relinked: 0,
    deletes: 0,
    implAdded: 0,
    parented: 0,
    skipped: 0,
    errors: 0,
    wouldChange: 0,
  };

  for (const [ref, uid] of pairs) {
    stats.entries += 1;

    if (!uid || typeof uid !== 'string') {
      stats.skipped += 1;
      console.log(`[skip] ${ref}: uid inválido`);
      continue;
    }

    const node = uidToNode.get(uid);
    if (!node) {
      stats.errors += 1;
      console.error(`[err] ${ref}: uid ARQUI no encontrado: ${uid}`);
      continue;
    }

    if (node.status === 'retirado') {
      stats.skipped += 1;
      console.log(`[skip] ${ref}: nodo ARQUI ${uid} está retirado`);
      continue;
    }

    const targetRef = node.ref;
    if (targetRef === ref) {
      stats.skipped += 1;
      console.log(`[skip] ${ref}: no puede ser su propio padre`);
      continue;
    }

    const lk = await withRateRetry(() => listLinks(ref));
    if (!lk.ok) {
      stats.errors += 1;
      console.error(`[err] ${ref}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
      continue;
    }

    const plan = buildPlan(ref, targetRef, Array.isArray(lk.data) ? lk.data : [], arquiRefSet, { linkMode, supersede });
    if (!plan.length) {
      stats.conforme += 1;
      console.log(`[ok] ${ref} ya conforme (parent=${targetRef} · uid=${uid})`);
      continue;
    }

    if (dryRun) {
      for (const op of plan) {
        console.log(`[dry] ${ref}: ${op.desc}`);
      }
      stats.wouldChange += plan.length;
      continue;
    }

    for (const op of plan) {
      try {
        let result;
        if (op.op === 'deleteLink') {
          result = await withRateRetry(() => deleteLink(op.id));
          if (result.ok) stats.deletes += 1;
        } else if (op.op === 'addLink') {
          result = await withRateRetry(() => addLink(ref, op.target, 'implements'));
          if (result.ok) stats.implAdded += 1;
        } else if (op.op === 'setParent') {
          result = await withRateRetry(() => setParent(ref, op.target));
          if (result.ok) stats.parented += 1;
        } else {
          result = { ok: false, error: `op desconocida ${op.op}` };
        }

        if (!result.ok) {
          stats.errors += 1;
          console.error(`[err] ${ref}: ${op.desc}: ${result.error || 'error desconocido'}`);
        }
      } catch (err) {
        stats.errors += 1;
        console.error(`[err] ${ref}: ${op.desc}: ${err?.message || err}`);
      }
    }

    stats.relinked += 1;
    console.log(`[fix] ${ref} -> parent ${targetRef} (uid=${uid}, ${plan.length} ops)`);
  }

  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-reparent falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
