#!/usr/bin/env node
// bin/cwc-healthfix-orchestrator.js — resuelve un BATCH de hallazgos en PARALELO
// con AISLAMIENTO y seguros anti-colisión (Fase B del orquestador).
//
// DESACOPLADO del server (regla 2 + regla de oro): estado en
// ~/.cwc-data/healthfix-batch.json + lock/heartbeat → sobrevive a un reinicio
// de la web y es REANUDABLE. Excepción de escritura de la regla 6 (como el
// auto-fix de a uno): edita código de la consola, blindado por fixToolAllowed.
//
// FLUJO:
//  Fase 1 (PARALELO, aislado): cada fix corre en su propio SANDBOX (git
//    worktree que refleja el estado actual) → edita + node --check ahí → produce
//    un PATCH. Colisión imposible al editar. Concurrencia adaptativa (pool F2.5).
//  BARRERA.
//  Fase 2 (SERIAL, verdad de git): aplica cada patch al árbol REAL uno por uno,
//    con git apply --check (conflicto → se marca, NO se aplica) + node --check
//    por aplicación (falla → revierte). NUNCA reinicia el servicio.
import os from 'node:os';
import path from 'node:path';
import fss from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT, readBatch, writeBatch, writeBatchLock, clearBatchLock, otherBatchAlive,
  fixPrompt, fixToolAllowed, readReview, writeReview, recordSolved, recordDismissed, findingId, addProposal,
  FIX_TIMEOUT_MS, FIX_MAX_TURNS, HEARTBEAT_MS,
} from '../src/modules/health/shared.js';
import { createSandbox, extractPatch, removeSandbox, integratePatch, pruneSandboxes, WT_BASE } from '../src/modules/health/worktree.js';
import { runAdaptivePool } from '../src/modules/health/pool.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (err) => /429|rate.?limit|overloaded|too many requests|529|503/.test(String((err && err.message) || err).toLowerCase());
const patchPath = (id) => path.join(WT_BASE, `${id}.patch`);
const MOCK = process.env.CWC_HEALTHFIX_MOCK === '1'; // test: no llama al SDK

// Solo salgo si hay OTRO orquestador con pid REAL vivo. El lock-placeholder
// (pid:0) que puso el server es MI reserva → la reclamo escribiendo mi pid.
// (Antes usaba isBatchRunning y veía su propia reserva pid:0 → auto-deadlock:
// quedaba "arrancando…" para siempre.)
if (otherBatchAlive()) { log('ya hay un batch corriendo (pid real vivo): salgo.'); process.exit(0); }
writeBatchLock(process.pid);
const heartbeat = setInterval(() => writeBatchLock(process.pid), HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearBatchLock(); process.exit(code); }

// Corre UN fix autónomo en el sandbox `wt`. Devuelve el texto del asistente
// (para parsear FIXOK/FIXFAIL/PROPOSED-INVARIANT). Con MOCK, hace un edit
// trivial y verificable sin gastar tokens.
async function runFix(item, wt) {
  if (MOCK) {
    const rel = (item.file || '').split(':')[0] || 'src/modules/stats/index.js';
    try { fss.appendFileSync(path.join(wt, rel), `\n// healthfix-mock ${item.id}\n`); } catch { /* noop */ }
    return `FIXOK mock: comentario en ${rel}\nNO-INVARIANT`;
  }
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Auto-fix: solo lectura/edición + node --check.' } };
  let out = '';
  let attempt = 0;
  for (;;) {
    try {
      const q = query({
        prompt: fixPrompt(item),
        options: {
          cwd: wt, model: 'sonnet', maxTurns: FIX_MAX_TURNS, permissionMode: 'default', settingSources: [],
          hooks: { PreToolUse: [{ hooks: [async (input) => (fixToolAllowed(input.tool_name, input.tool_input) ? {} : deny)] }] },
          canUseTool: async (name, input) => (fixToolAllowed(name, input) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Auto-fix: solo lectura/edición + node --check.' }),
        },
      });
      let timer = null;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), FIX_TIMEOUT_MS); });
      const pump = (async () => { for await (const m of q) { if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += `${b.text}\n`; } else if (m.type === 'result') break; } })();
      try { await Promise.race([pump, timeout]); } finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
      return out;
    } catch (err) {
      if (isRateLimit(err) && attempt < 3) { attempt += 1; await sleep(15000); continue; }
      return `${out}\nFIXFAIL ${String((err && err.message) || err).slice(0, 140)}`;
    }
  }
}

// Marca el hallazgo resuelto en review.json (la tarjeta se actualiza sola) +
// registro durable.
function markResolved(item, summary) {
  const st = readReview();
  const f = (st.findings || []).find((x) => findingId(x) === item.id);
  if (f) { f.fixStatus = 'resolved'; f.fixSummary = summary; f.resolvedAt = Date.now(); st.updatedAt = Date.now(); writeReview(st); }
  recordSolved(item, summary);
}

// Marca un FALSO POSITIVO en review.json (sale de la cola "por resolver") +
// lo guarda en el registro DURABLE para que el motor no lo re-encole nunca más.
function markDismissed(item, reason) {
  const st = readReview();
  const f = (st.findings || []).find((x) => findingId(x) === item.id);
  if (f) { f.fixStatus = 'dismissed'; f.dismissReason = reason; f.dismissedAt = Date.now(); st.updatedAt = Date.now(); writeReview(st); }
  recordDismissed(item, reason);
}

async function main() {
  const batch = readBatch();
  if (!batch || !Array.isArray(batch.items)) { log('sin batch: salgo.'); finish(0); return; }
  batch.running = true;
  const flush = () => { batch.updatedAt = Date.now(); writeBatch(batch); };
  // Reanudación: purgar sandboxes huérfanos.
  pruneSandboxes();
  log(`batch: ${batch.items.length} hallazgo(s).`);

  // FASE 1 — resolver en paralelo (sandboxes aislados). Reanuda los que no
  // llegaron a 'ready'/'integrated'/'conflict'/'check-failed'/'failed'.
  const pending = batch.items.filter((it) => it.status === 'pending' || it.status === 'fixing');
  batch.phase = pending.length ? `resolviendo ${pending.length} en paralelo (aislado)…` : 'integrando…';
  flush();
  await runAdaptivePool(pending, async (it) => {
    it.status = 'fixing'; flush();
    const wt = createSandbox(it.id);
    try {
      const out = await runFix(it, wt);
      if (/FIXOK/.test(out)) {
        const patch = extractPatch(wt);
        fss.writeFileSync(patchPath(it.id), patch, { mode: 0o600 });
        it.status = 'ready';
        it.fixSummary = (out.match(/FIXOK\s*(.*)/)?.[1] || '').trim().slice(0, 300);
        const inv = out.match(/PROPOSED-INVARIANT\s+([^\n]+?)\s*\|\s*([^\n]+)/i);
        if (inv) addProposal({ text: inv[1].trim(), match: inv[2].trim() || (it.file || '').split(':')[0], fromFinding: it });
        log(`  ready ${it.area}`);
      } else if (/FIXNONE/.test(out) || /falso positivo/i.test(out)) {
        // No era un bug: el modelo lo descartó (falso positivo). NO es un fallo.
        it.status = 'dismissed';
        it.error = (out.match(/FIXNONE\s*(.*)/)?.[1] || out.match(/falso positivo[^\n]*/i)?.[0] || 'no era un bug').trim().slice(0, 200);
        log(`  DISMISS ${it.area}: ${it.error}`);
      } else {
        it.status = 'failed';
        it.error = (out.match(/FIXFAIL\s*(.*)/)?.[1] || 'sin confirmación del modelo').trim().slice(0, 200);
        log(`  FAIL ${it.area}: ${it.error}`);
      }
    } catch (err) {
      it.status = 'failed'; it.error = String((err && err.message) || err).slice(0, 160);
    } finally {
      removeSandbox(it.id);
      batch.done = (batch.done || 0) + 1;
      flush();
    }
  }, { min: 2, start: 4, backoffMs: 15000 });

  // FALSOS POSITIVOS — pase SERIAL (sin race sobre review.json): los que el
  // modelo descartó salen de la cola "por resolver" y quedan en el registro
  // durable → el motor no los re-encola en la próxima corrida.
  for (const it of batch.items.filter((x) => x.status === 'dismissed')) {
    markDismissed(it, it.error || 'no era un bug (falso positivo)');
    log(`  descartado ${it.area}: ${it.error || ''}`);
  }

  // FASE 2 — integración SERIAL al árbol real (verdad de git). Orden: primero
  // los 'safe' (dominios disjuntos), después el resto — reduce conflictos.
  batch.phase = 'integrando (serial)…'; flush();
  const ready = batch.items.filter((it) => it.status === 'ready')
    .sort((a, b) => (a.policy?.risk === 'safe' ? 0 : 1) - (b.policy?.risk === 'safe' ? 0 : 1));
  for (const it of ready) {
    let patch = '';
    try { patch = fss.readFileSync(patchPath(it.id), 'utf8'); } catch { /* noop */ }
    const res = integratePatch(patch);
    if (res.ok) {
      it.status = 'integrated'; it.files = res.files;
      markResolved(it, it.fixSummary || 'resuelto por el orquestador');
      log(`  integrado ${it.area} (${(res.files || []).join(', ')})`);
    } else {
      it.status = res.reason === 'conflict' ? 'conflict' : 'check-failed';
      it.error = res.detail || res.reason;
      log(`  ${it.status} ${it.area}: ${it.error}`);
    }
    try { fss.unlinkSync(patchPath(it.id)); } catch { /* noop */ }
    flush();
  }

  pruneSandboxes();
  batch.phase = null; batch.running = false; batch.finishedAt = Date.now();
  flush();
  const c = batch.items.reduce((a, it) => { a[it.status] = (a[it.status] || 0) + 1; return a; }, {});
  log(`batch OK: ${JSON.stringify(c)}`);
  finish(0);
}

main().catch((err) => {
  const b = readBatch();
  if (b) { b.running = false; b.error = String((err && err.message) || err).slice(0, 200); writeBatch(b); }
  log('batch FALLÓ:', (err && err.message) || err);
  finish(1);
});
