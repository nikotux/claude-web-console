#!/usr/bin/env node
import { createItem, findItemByTitle, setParent } from '../src/core/pad-service-client.js';

// 2026-07-29 (console:PEND-2286): la colección `tasks` se fusionó en `pendientes`.
// Este one-off apunta ahora a `pendientes`; conserva su idempotencia porque
// `findItemByTitle` busca por TÍTULO y los títulos sobrevivieron intactos al move.

const PARENT = 'PLAN-1320';
const TASKS = [
  { title:'A1 · Criterio de parent-primario vs referencia', phase:'A', executor:'claude', model:'opus', effort:'high', content:'Diseñar la regla determinística de cuál de los N padres de un ítem es su HOGAR estructural (link parent) y cuáles quedan como REFERENCIA (implements), por tipo de ítem. Salida: criterio documentado para A3.' },
  { title:'A2 · Tool cwc-pad-relink.js (parent vs referencia)', phase:'A', executor:'tandem', model:'opus', effort:'high', content:'Escribir tool idempotente: dado un mapa {ref: parentPrimario}, convierte ESE link a parent (setParent) y deja el resto de los links como implements (referencia). Soporta --dry-run. Patrón de los otros bin/cwc-pad-*.js.' },
  { title:'A3 · Clasificar y re-etiquetar los ~130 multi-padre', phase:'A', executor:'claude', model:'opus', effort:'high', content:'IA elige el parent primario de cada ítem multi-padre por concern (criterio de A1) y corre la tool de A2. Verificar con structure-audit que multi-padre baje.' },
  { title:'B1 · Diseño del mapeo inventory.json → nodos ARQUI', phase:'B', executor:'claude', model:'opus', effort:'high', content:'Definir niveles (subsistema/módulo/archivo/endpoint), títulos y un uid ESTABLE por nodo (clave de upsert) para idempotencia. Contrato para B2.' },
  { title:'B2 · Generador cwc-pad-arch-gen.js (derivado de inventory)', phase:'B', executor:'tandem', model:'opus', effort:'high', content:'Lee inventory.json (core/inventory.js) y emite/refresca los nodos ARQUI con uid estable, idempotente, --dry-run. Reemplaza el esqueleto hand-buildeado por uno data-driven y auto-sync.' },
  { title:'B3 · Correr generador + verificar árbol profundo', phase:'B', executor:'claude', model:'sonnet', effort:'high', content:'Ejecutar el generador y auditar el árbol resultante (cwc-pad-structure-audit). Verificar profundidad y 0 huérfanos.' },
  { title:'C1 · Tool de re-parent al nodo más específico', phase:'C', executor:'tandem', model:'opus', effort:'high', content:'Extender la tool de relink/attach para colgar un ítem del nodo módulo/archivo MÁS específico (no el subsistema) dado un mapa; idempotente.' },
  { title:'C2 · Clasificar y reconectar ítems por concern al nodo específico', phase:'C', executor:'claude', model:'opus', effort:'high', content:'IA mapea cada ítem al nodo ARQUI más específico y ejecuta la tool de C1. Verificar cobertura.' },
  { title:'D1 · Contrato: motores de Salud → nodo ARQUI', phase:'D', executor:'claude', model:'opus', effort:'high', content:'Diseñar cómo health/coherence linkean sus hallazgos al nodo de arquitectura correspondiente (escanear por nodo). Contrato para D2.' },
  { title:'D2 · Implementar hook Salud→ARQUI en los motores', phase:'D', executor:'tandem', model:'opus', effort:'high', content:'Código en src/modules/health (+coherence) para linkear hallazgos al nodo ARQUI del módulo afectado.' },
  { title:'D3 · Verificación E2E de la sinergia Salud↔Arquitectura', phase:'D', executor:'claude', model:'sonnet', effort:'high', content:'Correr un escaneo y verificar que los hallazgos quedan colgados de su nodo de arquitectura.' },
];

const stats = {
  created: 0,
  existed: 0,
  parented: 0,
  errors: 0,
};
const visited = [];

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

async function ensureTask(task) {
  const found = await withRateRetry(() => findItemByTitle('pendientes', task.title));
  if (found?.ref) {
    stats.existed += 1;
    return found.ref;
  }

  const w = await withRateRetry(() => createItem('pendientes', {
    title: task.title,
    content: task.content,
    fields: {
      priority: 'media',
      phase: task.phase,
      model: task.model,
      effort: task.effort,
      executor: task.executor,
    },
  }));
  if (w.ok && w.data?.ref) {
    stats.created += 1;
    return w.data.ref;
  }

  stats.errors += 1;
  console.error(`[tasks] No se pudo crear item "${task.title}": ${w.error || 'error desconocido'}`);
  return null;
}

try {
  for (const task of TASKS) {
    try {
      const ref = await ensureTask(task);
      visited.push({ ref, task });
      if (!ref) continue;

      const w = await withRateRetry(() => setParent(ref, PARENT));
      if (w.ok) {
        stats.parented += 1;
      } else {
        stats.errors += 1;
        console.error(`[parent] ${ref} -> ${PARENT}: ${w.error || 'error desconocido'}`);
      }
    } catch (err) {
      stats.errors += 1;
      visited.push({ ref: null, task });
      console.error(`[tasks] ${task.title}: ${err?.message || err}`);
    }
  }

  console.log(`RESUMEN ${JSON.stringify(stats)}`);
  for (const item of visited) {
    console.log(`${item.ref || 'null'} [${item.task.executor}/${item.task.model}/${item.task.effort}] ${item.task.title}`);
  }
  process.exit(0);
} catch (err) {
  console.error(`cwc-pad-atomize-1320 falló con excepción: ${err?.message || err}`);
  process.exit(1);
}
