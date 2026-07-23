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

function fieldsObj(item) {
  if (item?.fields && typeof item.fields === 'object') return item.fields;
  if (typeof item?.fields === 'string') {
    try {
      const parsed = JSON.parse(item.fields);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function cell(value) {
  const text = String(value || '');
  return text ? text : '-';
}

function emptyStats() {
  return {
    total: 0,
    linked: 0,
    float: 0,
  };
}

try {
  const cr = await withRateRetry(() => listCollections());
  if (!cr.ok) {
    console.error(`No se pudieron listar colecciones: ${cr.error || 'error desconocido'}`);
    process.exit(1);
  }

  const slugs = itemsArray(cr.data).map((collection) => collection?.slug).filter(Boolean);
  const byCollection = new Map();
  const floating = [];
  let errores = 0;

  for (const slug of slugs) {
    const stats = emptyStats();
    byCollection.set(slug, stats);

    const r = await withRateRetry(() => listItems(slug));
    if (!r.ok) {
      errores += 1;
      console.error(`[${slug}] No se pudieron listar items: ${r.error || 'error desconocido'}`);
      continue;
    }

    for (const item of itemsArray(r.data)) {
      stats.total += 1;

      try {
        const lk = await withRateRetry(() => listLinks(item.ref));
        if (!lk.ok) {
          errores += 1;
          console.error(`[${slug}] ${item.ref || '-'}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
        }

        const linkCount = (lk.ok && Array.isArray(lk.data)) ? lk.data.length : 0;
        if (linkCount > 0) {
          stats.linked += 1;
          continue;
        }

        stats.float += 1;
        const fields = fieldsObj(item);
        const tags = Array.isArray(item?.tags) ? item.tags.join('/') : (typeof item?.tags === 'string' ? item.tags : '');
        floating.push({
          slug,
          ref: item?.ref || '',
          title: String(item?.title || '').slice(0, 80),
          cat: fields.category || '',
          proj: fields.project || '',
          tags,
        });
      } catch (err) {
        errores += 1;
        console.error(`[${slug}] ${item?.ref || '-'}: ${err?.message || err}`);
      }
    }
  }

  for (const slug of slugs) {
    const stats = byCollection.get(slug) || emptyStats();
    console.log(`CENSO ${slug} total=${stats.total} linked=${stats.linked} float=${stats.float}`);
  }

  floating.sort((a, b) => a.slug.localeCompare(b.slug));

  console.log(`=== FLOTANTES (${floating.length}) ===`);
  for (const item of floating) {
    console.log(`${cell(item.slug)} | ${cell(item.ref)} | ${cell(item.cat)} | ${cell(item.proj)} | ${cell(item.tags)} | ${cell(item.title)}`);
  }

  const totals = [...byCollection.values()].reduce((acc, stats) => {
    acc.items += stats.total;
    acc.linked += stats.linked;
    acc.float += stats.float;
    return acc;
  }, { items: 0, linked: 0, float: 0 });

  console.log(`TOTAL items=${totals.items} linked=${totals.linked} float=${totals.float} colecciones=${slugs.length}`);
  if (errores > 0) console.error(`Errores recuperables: ${errores}`);
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-graph-audit fallo con excepcion: ${err?.message || err}`);
  process.exit(1);
}
