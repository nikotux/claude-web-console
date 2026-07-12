#!/usr/bin/env node
// bin/migrate-tasks-to-pad.js — migración ÚNICA (ejecutar A MANO, NUNCA en el
// arranque del server) del registro file-based viejo de Pendientes
// (~/.cwc-data/tasks.json) a las colecciones `pendientes`/`planes` del Pad
// LOCAL (workspace `console`). Parte del ROAD-110/TASK-123.
//
// Orden: PRIMERO los planes (para poder mapear planId→ref al crear las
// tareas), DESPUÉS las tareas (con su `parent` ya seteado). Un SEGUNDO paso
// aplica las relaciones `blocks[]` (pueden apuntar a tareas O planes, así que
// hace falta que TODO exista antes de enlazar). IDEMPOTENTE: si el Pad YA
// tiene un item con el MISMO título en la colección correspondiente, se
// saltea (no duplica) — así se puede correr de nuevo sin miedo si se cortó a
// mitad.
//
// Uso: node bin/migrate-tasks-to-pad.js [--dry-run]
//
// Nota de alcance (decisión tomada durante la implementación, no 100%
// especificada en el plan original): los COMENTARIOS de cada tarea/plan viejo
// TAMBIÉN se migran (vía pad.addComment), en orden cronológico ascendente —
// pero Pad les asigna su PROPIO `created_at` (el momento de la migración), no
// preserva el timestamp original. Es una pérdida de fidelidad histórica
// aceptada a propósito (el contenido del comentario SÍ se preserva íntegro;
// solo la fecha de "cuándo se escribió" queda como la fecha de la migración) —
// alternativa habría sido no migrar comentarios, que se consideró peor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listItems, createItem, addComment, addLink, setParent,
} from '../src/core/pad-service-client.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FILE = path.join(os.homedir(), '.cwc-data', 'tasks.json');

const STATUSES = ['pendiente', 'en-progreso', 'hecha'];
const PRIORITIES = ['alta', 'media', 'baja'];
const TYPES = ['task', 'idea', 'nota', 'feature'];
const PLAN_STATUSES = ['active', 'done', 'cancelled', 'proposed'];
const clampStr = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const normStatus = (s) => (STATUSES.includes(s) ? s : 'pendiente');
const normPriority = (p) => (PRIORITIES.includes(p) ? p : 'media');
const normType = (t) => (TYPES.includes(t) ? t : 'task');
const normPlanStatus = (s) => (PLAN_STATUSES.includes(s) ? s : 'active');
const normDate = (d) => { const s = clampStr(d, 10).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };

function log(...a) { console.log(...a); }
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// El Pad local rate-limita ("Too many requests") si se le pega muy seguido —
// verificado en caliente durante esta misma migración (61 tareas seguidas sin
// pausa empezaron a fallar a partir de la ~#20). Reintenta con backoff simple
// ante ese error puntual; cualquier otro error se deja pasar tal cual (no es
// un problema de ritmo, no tiene sentido reintentar solo).
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
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    plans: Array.isArray(raw.plans) ? raw.plans : [],
  };
}

async function existingTitles(collection) {
  const r = await listItems(collection);
  if (!r.ok) throw new Error(`No se pudo leer ${collection} de Pad: ${r.error}`);
  const map = new Map(); // title (normalizado) -> ref
  for (const it of r.data) map.set((it.title || '').trim().toLowerCase(), it.ref);
  return map;
}

async function migrateComments(ref, comments) {
  if (!Array.isArray(comments) || !comments.length) return;
  const sorted = [...comments].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const c of sorted) {
    const text = clampStr(c.text, 4000).trim();
    if (!text) continue;
    if (DRY_RUN) { log(`    [dry-run] comentario en ${ref}: "${text.slice(0, 60)}"`); continue; }
    const r = await withRetry(() => addComment(ref, text), `comentario ${ref}`);
    if (!r.ok) log(`    ! no se pudo migrar un comentario de ${ref}: ${r.error}`);
    await sleep(250);
  }
}

async function main() {
  const { tasks, plans } = loadOld();
  log(`Origen: ${plans.length} planes · ${tasks.length} tareas (${FILE})`);
  if (DRY_RUN) log('*** DRY RUN: no se escribe nada en Pad ***');

  const planExisting = await existingTitles('planes');
  const taskExisting = await existingTitles('pendientes');

  // ===== 1) Planes =====
  const planIdMap = new Map(); // old PLAN-<n> -> ref real de Pad
  let plansCreated = 0, plansSkipped = 0;
  for (const p of plans) {
    const title = clampStr(p.title, 200).trim() || 'Plan sin título';
    const key = title.toLowerCase();
    if (planExisting.has(key)) {
      planIdMap.set(p.id, planExisting.get(key));
      plansSkipped += 1;
      log(`  = plan ya existe, salteado: "${title}" -> ${planExisting.get(key)}`);
      continue;
    }
    const fields = {
      status: normPlanStatus(p.status),
      owner: clampStr(p.owner, 120),
      phase: clampStr(p.phase, 20),
      targetDate: normDate(p.targetDate),
    };
    if (DRY_RUN) {
      log(`  + [dry-run] crearía plan: "${title}" fields=${JSON.stringify(fields)}`);
      planIdMap.set(p.id, `DRYRUN-${p.id}`);
      plansCreated += 1;
      continue;
    }
    const r = await withRetry(() => createItem('planes', { title, content: clampStr(p.description, 4000), fields }), `crear plan "${title}"`);
    if (!r.ok) { log(`  ! FALLÓ crear plan "${title}": ${r.error}`); continue; }
    planIdMap.set(p.id, r.data.ref);
    plansCreated += 1;
    log(`  + plan creado: "${title}" -> ${r.data.ref}`);
    await migrateComments(r.data.ref, p.comments);
    await sleep(250);
  }

  // ===== 2) Tareas =====
  const taskIdMap = new Map(); // old T<n> -> ref real de Pad
  let tasksCreated = 0, tasksSkipped = 0;
  for (const t of tasks) {
    const title = clampStr(t.title, 200).trim() || 'Sin título';
    const key = title.toLowerCase();
    if (taskExisting.has(key)) {
      taskIdMap.set(t.id, taskExisting.get(key));
      tasksSkipped += 1;
      log(`  = tarea ya existe, salteada: "${title}" -> ${taskExisting.get(key)}`);
      continue;
    }
    const status = normStatus(t.status);
    const fields = {
      status,
      priority: normPriority(t.priority),
      type: normType(t.type),
      owner: clampStr(t.owner, 120),
      estimate: clampStr(t.estimate, 40),
      dueDate: normDate(t.dueDate),
      source: t.source === 'audio' ? 'audio' : 'manual',
      sourceRef: t.sourceRef ? clampStr(t.sourceRef, 64) : '',
      doneAt: t.doneAt ? String(t.doneAt) : (status === 'hecha' ? String(t.updatedAt || Date.now()) : ''),
    };
    const tags = Array.isArray(t.tags) ? t.tags.map((x) => clampStr(x, 40).trim()).filter(Boolean).slice(0, 10) : [];
    if (DRY_RUN) {
      log(`  + [dry-run] crearía tarea: "${title}" fields=${JSON.stringify(fields)} planId=${t.planId || '-'}`);
      taskIdMap.set(t.id, `DRYRUN-${t.id}`);
      tasksCreated += 1;
      continue;
    }
    const r = await withRetry(() => createItem('pendientes', { title, content: clampStr(t.description, 4000), tags, fields }), `crear tarea "${title}"`);
    if (!r.ok) { log(`  ! FALLÓ crear tarea "${title}": ${r.error}`); continue; }
    taskIdMap.set(t.id, r.data.ref);
    tasksCreated += 1;
    log(`  + tarea creada: "${title}" -> ${r.data.ref}`);

    // parent (plan) — ya tenemos el ref real del plan por el mapa del paso 1.
    if (t.planId && planIdMap.has(t.planId)) {
      const newPlanRef = planIdMap.get(t.planId);
      const sp = await withRetry(() => setParent(r.data.ref, newPlanRef), `parent ${r.data.ref}->${newPlanRef}`);
      if (!sp.ok) log(`    ! no se pudo asignar el plan ${newPlanRef} a ${r.data.ref}: ${sp.error}`);
    } else if (t.planId) {
      log(`    ! planId viejo "${t.planId}" de la tarea "${title}" no se encontró en el mapa (huérfano, se omite).`);
    }

    await migrateComments(r.data.ref, t.comments);
    await sleep(250);
  }

  // ===== 3) Relaciones "blocks" (segundo paso: todo debe existir ya) =====
  let blocksLinked = 0, blocksSkipped = 0;
  const allOld = [...plans.map((p) => ({ ...p, __map: planIdMap })), ...tasks.map((t) => ({ ...t, __map: taskIdMap }))];
  for (const item of allOld) {
    const selfMap = item.__map === planIdMap ? planIdMap : taskIdMap;
    const selfRef = selfMap.get(item.id);
    if (!selfRef || !Array.isArray(item.blocks) || !item.blocks.length) continue;
    for (const oldTarget of item.blocks) {
      const targetRef = planIdMap.get(oldTarget) || taskIdMap.get(oldTarget);
      if (!targetRef) { blocksSkipped += 1; continue; }
      if (DRY_RUN) { log(`  + [dry-run] link blocks: ${selfRef} -> ${targetRef}`); blocksLinked += 1; continue; }
      const lr = await withRetry(() => addLink(selfRef, targetRef, 'blocks'), `blocks ${selfRef}->${targetRef}`);
      if (lr.ok) blocksLinked += 1; else blocksSkipped += 1;
      await sleep(250);
    }
  }

  log('');
  log('===== Resumen =====');
  log(`Planes:  ${plansCreated} creados · ${plansSkipped} ya existían`);
  log(`Tareas:  ${tasksCreated} creados · ${tasksSkipped} ya existían`);
  log(`Blocks:  ${blocksLinked} enlazados · ${blocksSkipped} omitidos (target no encontrado)`);
  if (DRY_RUN) log('*** DRY RUN: nada de esto se escribió de verdad. Correr sin --dry-run para aplicar. ***');
}

main().catch((err) => {
  console.error('FALLO la migración:', err?.stack || err);
  process.exit(1);
});
