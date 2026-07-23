#!/usr/bin/env node
import { findItemByTitle, createItem, addLink, listLinks, listItems } from '../src/core/pad-service-client.js';

const EXPLICIT_MAP = {
  'BUG-936': 'ARQUI-1262',
  'BUG-928': 'ARQUI-1292',
  'BUG-920': 'ARQUI-1292',
  'BUG-787': 'ARQUI-1271',
  'BUG-785': 'ARQUI-1272',
  'BUG-620': 'ARQUI-1286',
  'BUG-472': 'ARQUI-1275',
  'BUG-41': 'ARQUI-1281',
  'BUG-18': 'ARQUI-1259',
  'BUG-46': 'ARQUI-1280',
  'BUG-12': 'ARQUI-1259',
  'BUG-15': 'ARQUI-1308',
  'BUG-37': 'ARQUI-1262',
  'BUG-23': 'ARQUI-1268',
  'BUG-20': 'ARQUI-1291',
  'BUG-28': 'ARQUI-1287',
  'BUG-29': 'ARQUI-1287',
  'BUG-32': 'ARQUI-1278',
  'BUG-33': 'ARQUI-1278',
  'BUG-42': 'ARQUI-1280',
  'BUG-44': 'ARQUI-1259',
  'PEND-917': 'ARQUI-1308',
  'PEND-884': 'ARQUI-1275',
  'PEND-803': 'ARQUI-1271',
  'PEND-788': 'ARQUI-1271',
  'PEND-751': 'ARQUI-1302',
  'PEND-750': 'ARQUI-1280',
  'PEND-747': 'ARQUI-1268',
  'PEND-684': 'ARQUI-1299',
  'PEND-516': 'ARQUI-1292',
  'PEND-499': 'ARQUI-1293',
  'PEND-487': 'ARQUI-1275',
  'PEND-229': 'ARQUI-1308',
  'PEND-200': 'ARQUI-1273',
  'PEND-176': 'ARQUI-1281',
  'PEND-178': 'ARQUI-1275',
  'PLAN-927': 'ARQUI-1293',
  'PLAN-892': 'ARQUI-1268',
  'PLAN-781': 'ARQUI-1297',
  'PLAN-779': 'ARQUI-1300',
  'PLAN-752': 'ARQUI-1280',
  'PLAN-560': 'ARQUI-1271',
  'PLAN-469': 'ARQUI-1262',
  'CONVE-19': 'ARQUI-1266',
  'CONVE-17': 'ARQUI-1307',
  'CONVE-14': 'ARQUI-1264',
  'CONVE-10': 'ARQUI-1308',
  'CONVE-8': 'ARQUI-1280',
  'CONVE-5': 'ARQUI-1259',
  'CONVE-2': 'ARQUI-1280',
  'CONVE-706': 'ARQUI-1303',
  'CONVE-271': 'ARQUI-1271',
  'PLAYB-395': 'ARQUI-1278',
  'PLAYB-36': 'ARQUI-1280',
  'PLAYB-26': 'ARQUI-1280',
  'CDT-887': 'ARQUI-1274',
  'CDT-253': 'ARQUI-1274',
  'CDT-251': 'ARQUI-1274',
  'CDT-252': 'ARQUI-1274',
  'CDT-250': 'ARQUI-1274',
  'TASK-313': 'ARQUI-1280',
  'IDR-1250': 'IDR-1151',
};

const EXTRA = [
  ['IDR-1151', 'ARQUI-1295'],
  ['DOC-355', 'DOC-332'],
  ['DOC-350', 'DOC-332'],
];

const MC_PARENT = 'ARQUI-1288';
const CAT_NODE = {
  procedimiento: 'MC · Procedimientos',
  metodologia: 'MC · Metodología',
  convencion: 'MC · Convenciones',
  'feedback-cliente': 'MC · Feedback de Chris',
  nota: 'MC · Notas',
  regla: 'MC · Reglas',
  herramienta: 'MC · Herramientas',
};

const stats = {
  created: 0,
  linked: 0,
  errors: 0,
};
const explicitApplied = [];

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

function itemsArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

async function ensureLink(childRef, parentRef) {
  if (!childRef || !parentRef) return;

  try {
    const lk = await withRateRetry(() => listLinks(childRef));
    if (lk.ok && Array.isArray(lk.data)) {
      for (const link of lk.data) {
        if (link?.target_ref === parentRef || link?.source_ref === parentRef) return;
      }
    } else if (!lk.ok) {
      stats.errors += 1;
      console.error(`[attach] ${childRef}: no se pudieron listar links: ${lk.error || 'error desconocido'}`);
    }

    const w = await withRateRetry(() => addLink(childRef, parentRef, 'implements'));
    if (w.ok) {
      stats.linked += 1;
    } else {
      stats.errors += 1;
      console.error(`[attach] ${childRef} -> ${parentRef}: ${w.error || 'error desconocido'}`);
    }
  } catch (err) {
    stats.errors += 1;
    console.error(`[attach] ${childRef} -> ${parentRef}: ${err?.message || err}`);
  }
}

async function ensureCatNode(title) {
  const found = await findItemByTitle('arquitectura', title);
  if (found?.ref) return found.ref;

  const w = await withRateRetry(() => createItem('arquitectura', {
    title,
    fields: { kind: 'grupo', status: 'vigente' },
  }));
  if (w.ok && w.data?.ref) {
    stats.created += 1;
    return w.data.ref;
  }

  stats.errors += 1;
  console.error(`[arquitectura] No se pudo crear item "${title}": ${w.error || 'error desconocido'}`);
  return null;
}

try {
  for (const [childRef, parentRef] of Object.entries(EXPLICIT_MAP)) {
    await ensureLink(childRef, parentRef);
    explicitApplied.push([childRef, parentRef]);
  }

  for (const [childRef, parentRef] of EXTRA) {
    await ensureLink(childRef, parentRef);
  }

  const catRef = new Map();
  for (const [category, title] of Object.entries(CAT_NODE)) {
    const ref = await ensureCatNode(title);
    catRef.set(category, ref);
    await ensureLink(ref, MC_PARENT);
  }

  const r = await withRateRetry(() => listItems('mejora-continua'));
  if (r.ok) {
    for (const item of itemsArray(r.data)) {
      const cat = parseFields(item).category || 'nota';
      const parent = catRef.get(cat) || catRef.get('nota');
      if (item?.ref && parent) await ensureLink(item.ref, parent);
    }
  } else {
    stats.errors += 1;
    console.error(`[mejora-continua] No se pudieron listar items: ${r.error || 'error desconocido'}`);
  }

  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  console.log('PARES EXPLICIT_MAP');
  for (const [childRef, parentRef] of explicitApplied) {
    console.log(`${childRef} -> ${parentRef}`);
  }
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-attach falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
