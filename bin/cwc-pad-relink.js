#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { addLink, deleteLink, listLinks, setParent } from '../src/core/pad-service-client.js';

const args = process.argv.slice(2);
const dryRun = args.some((arg) => arg === '--dry-run' || arg === '-n');

function usage() {
  console.error('Uso: cwc-pad-relink --map <ruta.json> [--dry-run]');
  console.error('   o: cwc-pad-relink REF=PARENT [REF=PARENT ...] [--dry-run]');
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
    if (arg === '--dry-run' || arg === '-n' || arg === '--map') continue;
    if (mapIndex >= 0 && arg === args[mapIndex + 1]) continue;
    const eq = arg.indexOf('=');
    if (eq <= 0) continue;
    entries[arg.slice(0, eq)] = arg.slice(eq + 1);
  }

  return entries;
}

function buildPlan(ref, primary, links) {
  const outgoing = links.filter((link) => link?.source_ref === ref);
  const parentLinks = outgoing.filter((link) => link?.link_type === 'parent');
  const implLinks = outgoing.filter((link) => link?.link_type === 'implements');
  const implTargets = new Set(implLinks.map((link) => link?.target_ref).filter(Boolean));
  const plan = [];

  for (const link of implLinks) {
    if (link?.target_ref === primary) {
      plan.push({ op: 'deleteLink', id: link.id, desc: `borrar implements duplicado ${ref}->${primary}` });
    }
  }

  let primaryParentSeen = false;
  for (const link of parentLinks) {
    const target = link?.target_ref;
    if (target === primary) {
      if (primaryParentSeen) {
        plan.push({ op: 'deleteLink', id: link.id, desc: 'quitar parent duplicado' });
      }
      primaryParentSeen = true;
      continue;
    }

    if (!implTargets.has(target)) {
      plan.push({ op: 'addLink', target, type: 'implements', desc: `preservar viejo parent ${target} como referencia` });
    }
    plan.push({ op: 'deleteLink', id: link.id, desc: `quitar parent no-primario ${target}` });
  }

  if (!primaryParentSeen) {
    plan.push({ op: 'setParent', target: primary, desc: `hogar estructural -> ${primary}` });
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

  for (const [ref, primary] of pairs) {
    stats.entries += 1;

    if (!primary || primary === ref) {
      stats.skipped += 1;
      console.log(`[skip] ${ref}: parent inválido`);
      continue;
    }

    const lk = await withRateRetry(() => listLinks(ref));
    if (!lk.ok) {
      stats.errors += 1;
      console.error(`[err] ${ref}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
      continue;
    }

    const plan = buildPlan(ref, primary, Array.isArray(lk.data) ? lk.data : []);
    if (!plan.length) {
      stats.conforme += 1;
      console.log(`[ok] ${ref} ya conforme (parent=${primary})`);
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
    console.log(`[fix] ${ref} -> parent ${primary} (${plan.length} ops)`);
  }

  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-relink falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
