#!/usr/bin/env node
// bin/cwc-transcript-reaper.js — poda de transcripts por-usuario (SP9-8/TASK-674).
// Politica SP9-6 (docs/decision-sp9-clones-retencion.md): edad max 90d + cap 2GiB
// por-usuario (oldest-first) + ventana de gracia 7d que por MTIME protege sola las
// sesiones vivas/recientes (no hace falta IPC con el server). CONFIG-FREE: corre
// standalone (cron/systemd-timer/manual), no importa core/config.js. Best-effort:
// nunca tira; loguea lo podado. v1 = solo INQUILINOS (~/.cwc-users/<u>/.claude);
// el HOST (~/.claude) es opt-in (CWC_REAP_HOST=1). NO toca ~/.cwc-data (runtime).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.CWC_HOME || os.homedir();
const USERS_ROOT = path.join(HOME, '.cwc-users');
const DATA_DIR = path.join(HOME, '.cwc-data');
const LOG = path.join(DATA_DIR, 'transcript-reaper.log');
const LOCK = path.join(DATA_DIR, 'transcript-reaper.lock');

const DAY_MS = 86400000;
const MAX_AGE_DAYS = Number(process.env.CWC_TRANSCRIPT_MAX_AGE_DAYS) || 90;
const GRACE_DAYS = Number(process.env.CWC_TRANSCRIPT_GRACE_DAYS) || 7;
const MAX_BYTES = Number(process.env.CWC_TRANSCRIPT_MAX_BYTES) || 2 * 1024 * 1024 * 1024;
const REAP_HOST = process.env.CWC_REAP_HOST === '1';
const DRY_RUN = process.env.CWC_REAP_DRY_RUN === '1' || process.argv.includes('--dry-run');
const LOCK_TTL_MS = 30 * 60 * 1000; // un reaper vivo <30min bloquea a otro

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG, msg); } catch { /* best-effort */ }
  process.stdout.write(msg);
}

// Lock anti-concurrencia (reanudable: un lock vencido/muerto se ignora).
function acquireLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (cur && cur.ts && (Date.now() - cur.ts) < LOCK_TTL_MS) return false; // otro reaper fresco
  } catch { /* sin lock o corrupto: seguimos */ }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }), { mode: 0o600 }); return true; }
  catch { return true; } // si no podemos escribir el lock, corremos igual (best-effort)
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch { /* noop */ } }

// Junta recursivamente los .jsonl bajo un dir (best-effort).
function collectJsonl(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* skip */ }
    }
  }
}

function tryDelete(p) {
  if (DRY_RUN) return true;
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

// Poda los transcripts de UN usuario (dir = <space>/.claude/projects).
function reapUser(userId, projectsDir) {
  const files = [];
  collectJsonl(projectsDir, files);
  if (!files.length) return { userId, files: 0, deleted: 0, freed: 0 };
  const now = Date.now();
  const graceMs = GRACE_DAYS * DAY_MS;
  const ageMs = MAX_AGE_DAYS * DAY_MS;
  const deleted = new Set();
  let freed = 0;
  // 1) PASE POR EDAD: borra lo mas viejo que MAX_AGE (respetando SIEMPRE la gracia).
  for (const f of files) {
    const age = now - f.mtimeMs;
    if (age <= graceMs) continue;         // ventana de gracia: protege sesiones vivas/recientes
    if (age > ageMs) {
      if (tryDelete(f.path)) { deleted.add(f.path); freed += f.size; }
    }
  }
  // 2) PASE POR TAMANO: si lo que queda supera el cap, borra oldest-first (sin tocar gracia).
  let remaining = files.filter((f) => !deleted.has(f.path));
  let total = remaining.reduce((s, f) => s + f.size, 0);
  if (total > MAX_BYTES) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs); // mas viejo primero
    for (const f of remaining) {
      if (total <= MAX_BYTES) break;
      if ((now - f.mtimeMs) <= graceMs) continue;    // nunca tocar la gracia
      if (tryDelete(f.path)) { deleted.add(f.path); freed += f.size; total -= f.size; }
    }
  }
  return { userId, files: files.length, deleted: deleted.size, freed };
}

function main() {
  if (!acquireLock()) { log('otro reaper esta corriendo; salgo.'); return; }
  try {
    log(`reaper start (dry=${DRY_RUN} maxAge=${MAX_AGE_DAYS}d grace=${GRACE_DAYS}d cap=${Math.round(MAX_BYTES / (1024 * 1024))}MiB host=${REAP_HOST})`);
    const targets = [];
    // inquilinos
    try {
      for (const d of fs.readdirSync(USERS_ROOT, { withFileTypes: true })) {
        if (d.isDirectory()) targets.push({ userId: d.name, projects: path.join(USERS_ROOT, d.name, '.claude', 'projects') });
      }
    } catch { /* aun sin inquilinos */ }
    // host opt-in
    if (REAP_HOST) targets.push({ userId: '(host)', projects: path.join(HOME, '.claude', 'projects') });
    let totalDeleted = 0, totalFreed = 0;
    for (const t of targets) {
      const r = reapUser(t.userId, t.projects);
      totalDeleted += r.deleted; totalFreed += r.freed;
      log(`  ${r.userId}: ${r.files} transcripts, borrados ${r.deleted}, liberados ${(r.freed / (1024 * 1024)).toFixed(1)} MiB`);
    }
    log(`reaper done: ${targets.length} usuarios, ${totalDeleted} transcripts podados, ${(totalFreed / (1024 * 1024)).toFixed(1)} MiB liberados${DRY_RUN ? ' (DRY-RUN, nada borrado)' : ''}`);
  } finally {
    releaseLock();
  }
}

main();
