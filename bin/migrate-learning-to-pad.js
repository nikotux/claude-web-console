#!/usr/bin/env node
// bin/migrate-learning-to-pad.js — migración ÚNICA (ejecutar A MANO, NUNCA en
// el arranque del server) del registro file-based viejo del MÓDULO DE
// APRENDIZAJE (~/.cwc-data/learning.json) a las colecciones
// `temas-de-aprendizaje` (TDA) / `rutas-de-aprendizaje` (RDA) del Pad LOCAL
// (workspace `console`). Parte de ROAD-110 Fase 2 / TASK-232. Mismo patrón
// exacto que bin/migrate-tasks-to-pad.js (TASK-123).
//
// Orden: PRIMERO las rutas (para poder mapear routeId→ref al crear los
// temas), DESPUÉS los temas (con su `parent` ya seteado). IDEMPOTENTE: si el
// Pad YA tiene un item con el MISMO título en la colección correspondiente,
// se saltea (no duplica) — así se puede correr de nuevo sin miedo si se
// cortó a mitad.
//
// Uso: node bin/migrate-learning-to-pad.js [--dry-run]
//
// Nota de alcance (decisión tomada durante la implementación, no 100%
// especificada en el plan original):
//   - contextoEntradas[] (charlas IA + notas manuales + resúmenes de chat) se
//     migra TAL CUAL al campo custom `json` `contextoEntradas` — se preserva
//     cada entrada completa (id/at/source/text) sin pérdida de fidelidad
//     (a diferencia de los comentarios de tasks, acá no hay "recreación" vía
//     un endpoint propio: es un campo json directo, copia 1:1).
//   - explanation + explainModel + explainedAt + explainFingerprint +
//     explainFiles[] + explainVersions[] se empaquetan en el ÚNICO campo
//     custom `json` `explanation` = {text, model, at, fingerprint, files,
//     versions} — mismo mapeo que usa store.js en caliente.
//   - El string legado ÚNICO `contextoAdicional`/`contextoAt` (versión previa
//     al feature de lista, ya migrada al vuelo por normalizeTopic() del
//     store.js viejo) se convierte a una entrada más si todavía existiera en
//     algún tema no normalizado (defensivo; en los datos reales de este
//     proyecto ya no queda ninguno).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listItems, createItem, setParent,
} from '../src/core/pad-service-client.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FILE = path.join(os.homedir(), '.cwc-data', 'learning.json');

const STATUSES = ['por-aprender', 'reforzando', 'dominado'];
const PRIORITIES = ['alta', 'media', 'baja'];
const SCOPES = ['console', 'tolkien'];
const ROUTE_STATUSES = ['activa', 'propuesta', 'completada', 'archivada'];
const clampStr = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const normStatus = (s) => (STATUSES.includes(s) ? s : 'por-aprender');
const normPriority = (p) => (PRIORITIES.includes(p) ? p : 'media');
const normScope = (s) => (SCOPES.includes(s) ? s : 'console');
const normRouteStatus = (s) => (ROUTE_STATUSES.includes(s) ? s : 'activa');

function log(...a) { console.log(...a); }
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// El Pad local rate-limita ("Too many requests") bajo ráfaga — verificado en
// la migración de tasks. Reintenta con backoff simple ante ese error puntual.
async function withRetry(fn, label, tries = 5) {
  for (let i = 0; i < tries; i += 1) {
    const r = await fn();
    if (r.ok || !/too many requests/i.test(String(r.error || ''))) return r;
    const wait = 1500 * (i + 1);
    log(`    ~ rate limit de Pad en ${label}, reintento en ${wait}ms (${i + 1}/${tries})`);
    await sleep(wait);
  }
  return fn();
}

function loadOld() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return {
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    routes: Array.isArray(raw.routes) ? raw.routes : [],
  };
}

async function existingTitles(collection) {
  const r = await listItems(collection);
  if (!r.ok) throw new Error(`No se pudo leer ${collection} de Pad: ${r.error}`);
  const map = new Map(); // title (normalizado) -> ref
  for (const it of r.data) map.set((it.title || '').trim().toLowerCase(), it.ref);
  return map;
}

// Normaliza contextoEntradas de un tema viejo (incluye el legado de string
// único contextoAdicional, defensivo — ver nota de alcance arriba).
function normalizedContextoEntradas(t) {
  if (Array.isArray(t.contextoEntradas)) return t.contextoEntradas;
  if (t.contextoAdicional && String(t.contextoAdicional).trim()) {
    return [{ id: 'CX0', at: t.contextoAt || t.updatedAt || Date.now(), source: 'manual', text: t.contextoAdicional }];
  }
  return [];
}

function packagedExplanation(t) {
  if (!t.explanation) return {};
  return {
    text: clampStr(t.explanation, 40000),
    model: clampStr(t.explainModel, 40),
    at: t.explainedAt || null,
    fingerprint: clampStr(t.explainFingerprint, 64),
    files: Array.isArray(t.explainFiles) ? t.explainFiles.slice(0, 40) : [],
    versions: Array.isArray(t.explainVersions) ? t.explainVersions.slice(0, 5) : [],
  };
}

async function main() {
  const { topics, routes } = loadOld();
  log(`Origen: ${routes.length} rutas · ${topics.length} temas (${FILE})`);
  if (DRY_RUN) log('*** DRY RUN: no se escribe nada en Pad ***');

  const routeExisting = await existingTitles('rutas-de-aprendizaje');
  const topicExisting = await existingTitles('temas-de-aprendizaje');

  // ===== 1) Rutas =====
  const routeIdMap = new Map(); // old LR<n> -> ref real de Pad
  let routesCreated = 0, routesSkipped = 0;
  for (const r of routes) {
    const title = clampStr(r.title, 200).trim() || 'Ruta sin título';
    const key = title.toLowerCase();
    if (routeExisting.has(key)) {
      routeIdMap.set(r.id, routeExisting.get(key));
      routesSkipped += 1;
      log(`  = ruta ya existe, salteada: "${title}" -> ${routeExisting.get(key)}`);
      continue;
    }
    const fields = { status: normRouteStatus(r.status) };
    if (DRY_RUN) {
      log(`  + [dry-run] crearía ruta: "${title}" fields=${JSON.stringify(fields)}`);
      routeIdMap.set(r.id, `DRYRUN-${r.id}`);
      routesCreated += 1;
      continue;
    }
    const cr = await withRetry(() => createItem('rutas-de-aprendizaje', { title, content: clampStr(r.description, 4000), fields }), `crear ruta "${title}"`);
    if (!cr.ok) { log(`  ! FALLÓ crear ruta "${title}": ${cr.error}`); continue; }
    routeIdMap.set(r.id, cr.data.ref);
    routesCreated += 1;
    log(`  + ruta creada: "${title}" -> ${cr.data.ref}`);
    await sleep(250);
  }

  // ===== 2) Temas =====
  let topicsCreated = 0, topicsSkipped = 0;
  for (const t of topics) {
    const title = clampStr(t.title, 200).trim() || 'Tema sin título';
    const key = title.toLowerCase();
    if (topicExisting.has(key)) {
      topicsSkipped += 1;
      log(`  = tema ya existe, salteado: "${title}" -> ${topicExisting.get(key)}`);
      continue;
    }
    const fields = {
      area: clampStr(t.area, 80),
      scope: normScope(t.scope),
      status: normStatus(t.status),
      priority: normPriority(t.priority),
      question: clampStr(t.question, 1000),
      source: t.source === 'chris' ? 'chris' : 'manual',
      contextoEntradas: normalizedContextoEntradas(t),
      explanation: packagedExplanation(t),
    };
    const tags = Array.isArray(t.tags) ? t.tags.map((x) => clampStr(x, 40).trim()).filter(Boolean).slice(0, 10) : [];
    if (DRY_RUN) {
      log(`  + [dry-run] crearía tema: "${title}" area=${fields.area || '-'} scope=${fields.scope} routeId=${t.routeId || '-'} ctxEntries=${fields.contextoEntradas.length} explicación=${fields.explanation.text ? 'sí' : 'no'}`);
      topicsCreated += 1;
      continue;
    }
    const cr = await withRetry(() => createItem('temas-de-aprendizaje', {
      title, content: clampStr(t.notes, 8000), tags, fields,
    }), `crear tema "${title}"`);
    if (!cr.ok) { log(`  ! FALLÓ crear tema "${title}": ${cr.error}`); continue; }
    topicsCreated += 1;
    log(`  + tema creado: "${title}" -> ${cr.data.ref}`);

    // parent (ruta) — ya tenemos el ref real de la ruta por el mapa del paso 1.
    if (t.routeId && routeIdMap.has(t.routeId)) {
      const newRouteRef = routeIdMap.get(t.routeId);
      const sp = await withRetry(() => setParent(cr.data.ref, newRouteRef), `parent ${cr.data.ref}->${newRouteRef}`);
      if (!sp.ok) log(`    ! no se pudo asignar la ruta ${newRouteRef} a ${cr.data.ref}: ${sp.error}`);
    } else if (t.routeId) {
      log(`    ! routeId viejo "${t.routeId}" del tema "${title}" no se encontró en el mapa (huérfano, se omite).`);
    }
    await sleep(250);
  }

  log('');
  log('===== Resumen =====');
  log(`Rutas: ${routesCreated} creadas · ${routesSkipped} ya existían`);
  log(`Temas: ${topicsCreated} creados · ${topicsSkipped} ya existían`);
  if (DRY_RUN) log('*** DRY RUN: nada de esto se escribió de verdad. Correr sin --dry-run para aplicar. ***');
}

main().catch((err) => {
  console.error('FALLO la migración:', err?.stack || err);
  process.exit(1);
});
