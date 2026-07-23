#!/usr/bin/env node
import { addLink, createItem, findItemByTitle, listLinks, setParent } from '../src/core/pad-service-client.js';

const UMBRELLA = 'PLAN-1320';
const BLOCKS = [
  { key: 'A', title: 'Bloque A · Modelo de links (PLAN-1320)', tasks: ['TASK-1321', 'TASK-1322', 'TASK-1323'], blockedBy: [], content: 'Ejecutor: Tándem. Archivos: bin/cwc-pad-relink.js (nuevo) + data Pad. Parent-primario vs referencia. Independiente (arranca ya).' },
  { key: 'B', title: 'Bloque B · Árbol desde inventory (PLAN-1320)', tasks: ['TASK-1324', 'TASK-1325', 'TASK-1326'], blockedBy: [], content: 'Ejecutor: Tándem. Archivos: bin/cwc-pad-arch-gen.js (nuevo) + lee core/inventory.js. Árbol profundo auto-sync. Independiente (arranca ya).' },
  { key: 'C', title: 'Bloque C · Reconectar específico (PLAN-1320)', tasks: ['TASK-1327', 'TASK-1328'], blockedBy: ['B'], content: 'Ejecutor: Tándem. Archivos: bin/cwc-pad-reparent.js (nuevo) + data Pad. Reconectar al nodo más específico. Depende de B (necesita el árbol).' },
  { key: 'D', title: 'Bloque D · Sinergia Salud (PLAN-1320)', tasks: ['TASK-1329', 'TASK-1330', 'TASK-1331'], blockedBy: ['B'], content: 'Ejecutor: Tándem. Archivos: src/modules/health/* (+coherence). Hallazgos→nodo ARQUI. Depende de B (necesita los nodos).' },
];

const stats = {
  blocksCreated: 0,
  blocksExisted: 0,
  parented: 0,
  dag: 0,
  errors: 0,
};
const refByKey = {};

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

async function ensureBlock(block) {
  let ref = null;

  try {
    const found = await findItemByTitle('planes', block.title);
    if (found) {
      ref = found.ref;
      stats.blocksExisted += 1;
    }
  } catch (err) {
    stats.errors += 1;
    console.error(`[${block.key}] No se pudo buscar bloque "${block.title}": ${err?.message || err}`);
  }

  if (!ref) {
    try {
      const created = await withRateRetry(() => createItem('planes', {
        title: block.title,
        content: block.content,
        fields: { status: 'active', phase: block.key, owner: 'Niko' },
      }));
      if (created.ok) {
        ref = created.data?.ref;
        stats.blocksCreated += 1;
      } else {
        stats.errors += 1;
        console.error(`[${block.key}] No se pudo crear bloque "${block.title}": ${created.error || 'error desconocido'}`);
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[${block.key}] Excepción creando bloque "${block.title}": ${err?.message || err}`);
    }
  }

  if (ref) {
    refByKey[block.key] = ref;
    try {
      const parented = await withRateRetry(() => setParent(ref, UMBRELLA));
      if (!parented?.ok) {
        stats.errors += 1;
        console.error(`[${block.key}] No se pudo setParent(${ref}, ${UMBRELLA}): ${parented?.error || 'error desconocido'}`);
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[${block.key}] Excepción setParent(${ref}, ${UMBRELLA}): ${err?.message || err}`);
    }

    for (const taskRef of block.tasks) {
      try {
        const taskParented = await withRateRetry(() => setParent(taskRef, ref));
        if (taskParented?.ok) {
          stats.parented += 1;
        } else {
          stats.errors += 1;
          console.error(`[${block.key}] No se pudo setParent(${taskRef}, ${ref}): ${taskParented?.error || 'error desconocido'}`);
        }
      } catch (err) {
        stats.errors += 1;
        console.error(`[${block.key}] Excepción setParent(${taskRef}, ${ref}): ${err?.message || err}`);
      }
    }
  }

  return ref;
}

async function ensureDagLink(block) {
  const blockRef = refByKey[block.key];
  if (!blockRef) return;

  for (const blocker of block.blockedBy) {
    const blockerRef = refByKey[blocker];
    if (!blockerRef) {
      stats.errors += 1;
      console.error(`[${block.key}] No existe ref para blocker ${blocker}`);
      continue;
    }

    let exists = false;
    try {
      const links = await withRateRetry(() => listLinks(blockRef));
      if (links.ok && Array.isArray(links.data)) {
        exists = links.data.some((link) => link?.target_ref === blockerRef);
      } else {
        stats.errors += 1;
        console.error(`[${block.key}] No se pudieron listar links de ${blockRef}: ${links.error || 'error desconocido'}`);
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[${block.key}] Excepción listLinks(${blockRef}): ${err?.message || err}`);
    }

    if (exists) continue;

    try {
      const linked = await withRateRetry(() => addLink(blockRef, blockerRef, 'blocked-by'));
      if (linked.ok) {
        stats.dag += 1;
      } else {
        stats.errors += 1;
        console.error(`[${block.key}] No se pudo addLink(${blockRef}, ${blockerRef}, blocked-by): ${linked.error || 'error desconocido'}`);
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[${block.key}] Excepción addLink(${blockRef}, ${blockerRef}, blocked-by): ${err?.message || err}`);
    }
  }
}

try {
  for (const block of BLOCKS) {
    await ensureBlock(block);
  }

  for (const block of BLOCKS) {
    if (block.blockedBy.length > 0) await ensureDagLink(block);
  }

  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  for (const block of BLOCKS) {
    console.log(`${block.key} = ${refByKey[block.key] || ''} blockedBy:${block.blockedBy}`);
  }
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-blocks-1320 falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
