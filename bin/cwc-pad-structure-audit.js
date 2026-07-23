#!/usr/bin/env node
import { listCollections, listItems, listLinks } from '../src/core/pad-service-client.js';

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

function getMapArray(map, key) {
  if (!map.has(key)) map.set(key, []);
  return map.get(key);
}

function countFor(map, key) {
  return map.get(key) || 0;
}

function titleFor(title, ref) {
  return title.get(ref) || '-';
}

function collFor(coll, ref) {
  return coll.get(ref) || '-';
}

try {
  const cr = await withRateRetry(() => listCollections());
  if (!cr.ok) {
    console.error(`No se pudieron listar colecciones: ${cr.error || 'error desconocido'}`);
    process.exit(1);
  }

  const slugs = itemsArray(cr.data).map((collection) => collection?.slug).filter(Boolean);
  const title = new Map();
  const coll = new Map();
  const allRefs = [];
  const degree = new Map();
  const parents = new Map();
  const childCount = new Map();
  let errores = 0;

  for (const slug of slugs) {
    const r = await withRateRetry(() => listItems(slug));
    if (!r.ok) {
      errores += 1;
      console.error(`[${slug}] No se pudieron listar items: ${r.error || 'error desconocido'}`);
      continue;
    }

    for (const item of itemsArray(r.data)) {
      const ref = item?.ref;
      if (!ref) continue;

      allRefs.push(ref);
      title.set(ref, String(item?.title || '').slice(0, 70));
      coll.set(ref, slug);
      degree.set(ref, 0);
      parents.set(ref, []);
      childCount.set(ref, 0);
    }
  }

  for (const ref of allRefs) {
    try {
      const lk = await withRateRetry(() => listLinks(ref));
      if (!lk.ok) {
        errores += 1;
        console.error(`[${collFor(coll, ref)}] ${ref}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
        continue;
      }

      const seenPairs = new Set();
      for (const link of Array.isArray(lk.data) ? lk.data : []) {
        const source = link?.source_ref;
        const target = link?.target_ref;
        if (!source || !target) continue;

        const pairKey = `${source}|${target}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        degree.set(ref, countFor(degree, ref) + 1);

        if (source === ref && target) {
          getMapArray(parents, ref).push(target);
        }

        if (target === ref && source) {
          childCount.set(ref, countFor(childCount, ref) + 1);
        }
      }
    } catch (err) {
      errores += 1;
      console.error(`[${collFor(coll, ref)}] ${ref}: ${err?.message || err}`);
    }
  }

  console.log('=== TOP FAN-OUT (padres con más hijos) ===');
  const topFanOut = allRefs
    .map((ref) => ({ ref, count: countFor(childCount, ref) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.ref.localeCompare(b.ref))
    .slice(0, 30);
  for (const item of topFanOut) {
    console.log(`${item.count}  ${item.ref}  [${collFor(coll, item.ref)}]  ${titleFor(title, item.ref)}`);
  }

  console.log('=== MULTI-PADRE (jerarquía ambigua) ===');
  const multiParent = allRefs
    .map((ref) => ({ ref, refs: getMapArray(parents, ref) }))
    .filter((item) => item.refs.length > 1)
    .sort((a, b) => b.refs.length - a.refs.length || a.ref.localeCompare(b.ref));
  for (const item of multiParent) {
    console.log(`${item.ref}  [${collFor(coll, item.ref)}]  ${titleFor(title, item.ref)}  padres: ${item.refs.join(', ')}`);
  }

  console.log('=== NODOS-MARAÑA (grado > 12) ===');
  const tangles = allRefs
    .map((ref) => ({ ref, count: countFor(degree, ref) }))
    .filter((item) => item.count > 12)
    .sort((a, b) => b.count - a.count || a.ref.localeCompare(b.ref));
  for (const item of tangles) {
    console.log(`${item.count}  ${item.ref}  [${collFor(coll, item.ref)}]  ${titleFor(title, item.ref)}`);
  }

  console.log('=== HOJAS SUELTAS-ISH (grado 1, solo cuelgan de 1 padre) === (conteo por colección)');
  const leavesByCollection = new Map();
  for (const ref of allRefs) {
    if (countFor(degree, ref) === 1 && countFor(childCount, ref) === 0) {
      const slug = collFor(coll, ref);
      leavesByCollection.set(slug, countFor(leavesByCollection, slug) + 1);
    }
  }
  for (const slug of [...leavesByCollection.keys()].sort((a, b) => a.localeCompare(b))) {
    console.log(`${slug}  ${countFor(leavesByCollection, slug)}`);
  }

  const totalItems = allRefs.length;
  const conLinks = allRefs.filter((ref) => countFor(degree, ref) > 0).length;
  const totalDegree = allRefs.reduce((sum, ref) => sum + countFor(degree, ref), 0);
  const promedioGrado = totalItems > 0 ? (totalDegree / totalItems).toFixed(1) : '0.0';

  console.log(`TOTAL items=${totalItems} conLinks=${conLinks} promedioGrado=${promedioGrado}`);
  if (errores > 0) console.error(`Errores recuperables: ${errores}`);
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-structure-audit fallo con excepcion: ${err?.message || err}`);
  process.exit(1);
}
