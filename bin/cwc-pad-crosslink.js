#!/usr/bin/env node
import { addLink, listItems, listLinks, resolveId } from '../src/core/pad-service-client.js';

const REF_RE = /\b(DOC|BUG|TASK|PLAN|PEND|ROAD|CONVE|PLAYB|FB|FEAT|TDA|RDA|CDT|MC|IDR)-\d+\b/g;
const TARGET = [
  'docs',
  'bugs',
  'tasks',
  'roadmap-items',
  'features',
  'feedback',
  'conventions',
  'playbooks',
  'contexto-de-tickets',
  'mejora-continua',
];

const args = process.argv.slice(2);
const dryRun = args.some((arg) => arg === '--dry-run' || arg === '-n');
const slugs = args.filter((arg) => !arg.startsWith('-'));
const collections = slugs.length ? slugs : TARGET;

function fieldsText(item) {
  if (!item?.fields) return '';
  if (typeof item.fields === 'string') return item.fields;
  if (typeof item.fields === 'object') return JSON.stringify(item.fields);
  return '';
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

function uniqueRefsFrom(item) {
  const self = item.ref;
  const text = [item.title || '', item.content || '', fieldsText(item)].join(' \n ');
  REF_RE.lastIndex = 0;
  return [...new Set(text.match(REF_RE) || [])].filter((ref) => ref !== self).slice(0, 25);
}

function emptyStats() {
  return {
    items: 0,
    'mencionesÚnicas': 0,
    creados: 0,
    wouldLink: 0,
    yaEnlazados: 0,
    dangling: 0,
    errores: 0,
  };
}

function addStats(total, stats) {
  total.items += stats.items;
  total['mencionesÚnicas'] += stats['mencionesÚnicas'];
  total.creados += stats.creados;
  total.wouldLink += stats.wouldLink;
  total.yaEnlazados += stats.yaEnlazados;
  total.dangling += stats.dangling;
  total.errores += stats.errores;
}

async function processCollection(slug) {
  const stats = emptyStats();
  const r = await withRateRetry(() => listItems(slug));
  if (!r.ok) {
    stats.errores += 1;
    console.error(`[${slug}] No se pudieron listar items: ${r.error || 'error desconocido'}`);
    return stats;
  }

  for (const item of itemsArray(r.data)) {
    const self = item?.ref;
    if (!self) continue;

    stats.items += 1;
    try {
      const mentionedRefs = uniqueRefsFrom(item);
      stats['mencionesÚnicas'] += mentionedRefs.length;
      if (!mentionedRefs.length) continue;

      const linkedRefs = new Set();
      const lk = await withRateRetry(() => listLinks(self));
      if (lk.ok && Array.isArray(lk.data)) {
        for (const link of lk.data) {
          if (link?.target_ref) linkedRefs.add(link.target_ref);
          if (link?.source_ref) linkedRefs.add(link.source_ref);
        }
      } else if (!lk.ok) {
        stats.errores += 1;
        console.error(`[${slug}] ${self}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
      }

      for (const ref of mentionedRefs) {
        if (linkedRefs.has(ref)) {
          stats.yaEnlazados += 1;
          continue;
        }

        const exists = await resolveId(ref);
        if (exists == null) {
          stats.dangling += 1;
          continue;
        }

        if (dryRun) {
          stats.wouldLink += 1;
          console.log(`[dry] ${self} -> ${ref}`);
          continue;
        }

        const w = await withRateRetry(() => addLink(self, ref, 'implements'));
        if (w.ok) {
          stats.creados += 1;
        } else {
          stats.errores += 1;
          console.error(`[${slug}] ${self} -> ${ref}: ${w.error || 'error desconocido'}`);
        }
      }
    } catch (err) {
      stats.errores += 1;
      console.error(`[${slug}] ${self}: ${err?.message || err}`);
    }
  }

  return stats;
}

try {
  const total = emptyStats();

  for (const slug of collections) {
    const stats = await processCollection(slug);
    addStats(total, stats);
    console.log(`${slug} ${JSON.stringify(stats)}`);
  }

  console.log(`TOTAL ${JSON.stringify(total)}`);
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-crosslink falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
