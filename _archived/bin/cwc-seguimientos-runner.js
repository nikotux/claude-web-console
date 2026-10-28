#!/usr/bin/env node
// bin/cwc-seguimientos-runner.js — clasificador IA del dashboard "Seguimientos"
// (F1.2). DESACOPLADO (regla de oro/regla 2): consume tokens (Haiku) → corre
// como proceso propio y SOBREVIVE a reinicios de la web. Lee el snapshot de
// Limbo, clasifica los frentes (dueño de la pelota / bloqueador / próxima acción,
// con GATE anti-backend) y RE-ESCRIBE el snapshot. Best-effort: nunca rompe el
// dashboard. Lo dispara POST /api/seguimientos/classify (dedup por lock).
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../src/core/data-dir.js';
import { readSnapshot, writeSnapshot } from '../src/modules/seguimientos/store.js';
import { classifyFrentes } from '../src/modules/seguimientos/classify-shared.js';

const args = process.argv.slice(2);
const dataDirIndex = args.indexOf('--data-dir');
// La ruta explícita del server tiene prioridad; sin ella, resolveDataDir()
// conserva CWC_DATA_DIR y el fallback retrocompatible del host.
const dataDir = dataDirIndex < 0 ? resolveDataDir() : args[dataDirIndex + 1];
const DIR = dataDir ? path.join(dataDir, 'seguimientos') : '';
const LOCK = path.join(DIR, 'classify.lock');

function setFlag(v) {
  const s = readSnapshot(dataDir);
  s.classifying = v;
  writeSnapshot(dataDir, s);
}

async function main() {
  if (!dataDir) { console.error('[seguimientos] falta la ruta después de --data-dir.'); process.exit(1); return; }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // Dedup: lock fresco (<10 min) ⇒ ya hay una clasificación corriendo.
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 10 * 60 * 1000) { console.error('[seguimientos] clasificación ya en curso'); return; }
  } catch { /* sin lock */ }
  fs.writeFileSync(LOCK, String(process.pid));
  setFlag(true);
  try {
    const snap = readSnapshot(dataDir);
    const frentes = snap.frentes || [];
    if (!frentes.length) { console.error('[seguimientos] sin frentes que clasificar'); return; }

    const byKey = await classifyFrentes(frentes);
    let n = 0;
    const classified = frentes.map((f) => {
      const c = byKey.get(f.key);
      if (!c) return f;
      n++;
      return { ...f, ownerBall: c.ownerBall, ownerType: c.ownerType, blockedBy: c.blockedBy, involucrados: c.involucrados, nextAction: c.nextAction, isBackend: c.isBackend, isMine: c.isMine };
    });
    // GATE anti-backend: lo marcado backend NO pertenece al dashboard.
    const kept = classified.filter((f) => !f.isBackend);
    const excluded = classified.length - kept.length;
    const counts = { ...(snap.counts || {}), total: kept.length, classified: n, backendExcluded: excluded };
    writeSnapshot(dataDir, { ...snap, frentes: kept, counts, classifying: false, classifiedAt: new Date().toISOString() });
    console.error(`[seguimientos] clasificados ${n}/${frentes.length} · excluidos backend: ${excluded}`);
  } finally {
    setFlag(false);
    try { fs.unlinkSync(LOCK); } catch { /* noop */ }
  }
}

main().catch((e) => {
  console.error('[seguimientos] runner error:', e.message);
  try { fs.unlinkSync(LOCK); } catch { /* noop */ }
  process.exit(1);
});
