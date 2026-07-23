#!/usr/bin/env node
import { findItemByTitle, createItem, addLink, setParent, listLinks } from '../src/core/pad-service-client.js';

const ROUTES = [
  { title: 'Infraestructura, secretos y autenticación', temas: ['TDA-245', 'TDA-238', 'TDA-241'] },
  { title: 'IA, agentes y memoria', temas: ['TDA-239', 'TDA-244', 'TDA-243'] },
  { title: 'Fundamentos de desarrollo y producción', temas: ['TDA-242', 'TDA-240'] },
];
const EXISTING_ROUTES = ['RDA-347', 'RDA-236'];
const LEARNING_NODE = 'ARQUI-1287';

const stats = {
  created: 0,
  assigned: 0,
  linked: 0,
  errors: 0,
};
const assignments = [];

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

async function ensureRoute(title) {
  const found = await findItemByTitle('rutas-de-aprendizaje', title);
  if (found?.ref) return found.ref;

  const w = await withRateRetry(() => createItem('rutas-de-aprendizaje', {
    title,
    fields: { status: 'activa' },
  }));
  if (w.ok && w.data?.ref) {
    stats.created += 1;
    return w.data.ref;
  }

  stats.errors += 1;
  console.error(`[rutas-de-aprendizaje] No se pudo crear ruta "${title}": ${w.error || 'error desconocido'}`);
  return null;
}

try {
  for (const route of ROUTES) {
    const routeRef = await ensureRoute(route.title);
    if (!routeRef) continue;

    for (const temaRef of route.temas) {
      const w = await withRateRetry(() => setParent(temaRef, routeRef));
      if (w.ok) {
        stats.assigned += 1;
        assignments.push([temaRef, routeRef, route.title]);
      } else {
        stats.errors += 1;
        console.error(`[parent] ${temaRef} -> ${routeRef}: ${w.error || 'error desconocido'}`);
      }
    }

    await ensureLink(routeRef, LEARNING_NODE);
  }

  for (const ref of EXISTING_ROUTES) {
    await ensureLink(ref, LEARNING_NODE);
  }

  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  for (const [temaRef, routeRef, routeTitle] of assignments) {
    console.log(`${temaRef} -> ${routeRef} (${routeTitle})`);
  }
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-routes falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
