#!/usr/bin/env node
// bin/migrate-tickets-meta-to-pad.js — migración ÚNICA (ejecutar A MANO, NUNCA
// en el arranque del server) del registro file-based viejo de metadata de
// tickets/PRs (~/.cwc-data/ticket-meta.json) a la colección
// `contexto-de-tickets` (prefix CDT) del Pad LOCAL (workspace `console`).
// Parte del ROAD-110 Fase 3 / TASK-249.
//
// A diferencia de tasks/learning (id viejo → ref de Pad), acá la clave
// (ticketNumber '123' / 'pr:<n>') es la que YA usa el resto de la consola —
// se preserva TAL CUAL como `title` del item + custom field `ticketKey`
// redundante. IDEMPOTENTE: si el Pad YA tiene un item con ese título exacto
// en `contexto-de-tickets`, se saltea (no duplica) — se puede correr de
// nuevo sin miedo si se cortó a mitad. Saltea entradas completamente vacías
// (sin contextoAdicional y sin historico) para no ensuciar Pad con ruido.
//
// Uso: node bin/migrate-tickets-meta-to-pad.js [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listItems, createItem } from '../src/core/pad-service-client.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FILE = path.join(os.homedir(), '.cwc-data', 'ticket-meta.json');
const CONTEXT_MAX = 20000;
const clampStr = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);

function log(...a) { console.log(...a); }
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// El Pad local rate-limita ("Too many requests") si se le pega muy seguido
// (ya visto en las migraciones anteriores de tasks/learning). Reintenta con
// backoff ante ese error puntual; cualquier otro error se deja pasar tal cual.
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
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function hasRealData(entry) {
  const ctx = String(entry?.contextoAdicional || '').trim();
  const hist = Array.isArray(entry?.historico) ? entry.historico : [];
  return !!ctx || hist.length > 0;
}

async function existingTitles(collectionSlug) {
  const r = await listItems(collectionSlug);
  if (!r.ok) throw new Error(`No se pudo leer ${collectionSlug} de Pad: ${r.error}`);
  const set = new Set(r.data.map((it) => it.title));
  return set;
}

async function main() {
  const store = loadOld();
  const keys = Object.keys(store);
  log(`Origen: ${keys.length} clave(s) en ${FILE}`);
  if (DRY_RUN) log('*** DRY RUN: no se escribe nada en Pad ***');

  const existing = await existingTitles('contexto-de-tickets');

  let created = 0, skippedExisting = 0, skippedEmpty = 0, failed = 0;
  for (const key of keys) {
    const entry = store[key];
    if (!hasRealData(entry)) { skippedEmpty += 1; log(`  · salteada (sin datos reales): "${key}"`); continue; }
    if (existing.has(key)) { skippedExisting += 1; log(`  = ya existe, salteada: "${key}"`); continue; }

    const fields = {
      ticketKey: key,
      contexto: entry.contextoAdicional
        ? { text: clampStr(entry.contextoAdicional, CONTEXT_MAX), at: entry.contextoAt || Date.now() }
        : null,
      historico: Array.isArray(entry.historico) ? entry.historico : [],
    };
    if (DRY_RUN) {
      log(`  + [dry-run] crearía item "${key}" (historico=${fields.historico.length}, contexto=${fields.contexto ? 'sí' : 'no'})`);
      created += 1;
      continue;
    }
    const r = await withRetry(() => createItem('contexto-de-tickets', { title: key, fields }), `crear "${key}"`);
    if (!r.ok) { log(`  ! FALLÓ crear "${key}": ${r.error}`); failed += 1; continue; }
    created += 1;
    log(`  + item creado: "${key}" -> ${r.data.ref}`);
    await sleep(250);
  }

  log('');
  log('===== Resumen =====');
  log(`Creados:        ${created}`);
  log(`Ya existían:    ${skippedExisting}`);
  log(`Vacíos (sin dato real), salteados: ${skippedEmpty}`);
  log(`Fallidos:       ${failed}`);
  if (DRY_RUN) log('*** DRY RUN: nada de esto se escribió de verdad. Correr sin --dry-run para aplicar. ***');
}

main().catch((err) => {
  console.error('FALLO la migración:', err?.stack || err);
  process.exit(1);
});
