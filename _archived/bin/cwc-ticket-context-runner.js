#!/usr/bin/env node
// bin/cwc-ticket-context-runner.js — interpretación IA de UNA transcripción para
// generar el "Contexto adicional" de un ticket/PR, DESACOPLADO del server
// (regla de oro: detached+unref, un reinicio de la web a mitad NO lo mata).
//
// El endpoint POST /api/tickets/ticket/:id/context-analyze (modules/tickets/
// index.js) escribe el job PENDIENTE en
// <dataDir-del-dueño>/ticket-context/<id>.json (con la transcripción + el
// contexto del ítem + su `key`) y spawnea esto con `--data-dir`; acá corre el
// SDK (sonnet, 1 turno, CERO herramientas — dos capas de denegación, regla 6:
// el texto viaja entero en el prompt), persiste el resultado en el MISMO
// archivo y AUTO-GUARDA el contexto en meta-store (decisión de Niko:
// auto-guardar al interpretar). El front encuesta el GET hasta que status deja
// de ser 'running'. Mismo patrón que bin/cwc-audio-runner.js.
import {
  ROOT, CONTEXT_TIMEOUT_MS, contextPrompt, parseContext, renderContextText,
  readJob, writeJob,
} from '../src/modules/tickets/context-analyze-shared.js';
import { saveContexto } from '../src/modules/tickets/meta-store.js';
import { resolveDataDir } from '../src/core/data-dir.js';
import { textOnlyQuery } from '../src/core/text-only-query.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const args = process.argv.slice(2);
const id = args[0];
const dataDirIndex = args.indexOf('--data-dir');
// Precedencia: la ruta explícita del server; si no viene, resolveDataDir()
// honra CWC_DATA_DIR y recién después aplica el fallback compatible del host.
const dataDir = dataDirIndex < 0 ? resolveDataDir() : args[dataDirIndex + 1];

async function runAnalysis(job) {
  // Texto puro, read-only doble capa (regla 6) vía el helper único core/text-only-query.
  const text = await textOnlyQuery(
    contextPrompt({ transcript: job.transcript, itemTitle: job.itemTitle, itemDesc: job.itemDesc }),
    {
      model: 'sonnet',
      maxTurns: 1,
      timeoutMs: CONTEXT_TIMEOUT_MS,
      cwd: ROOT,
      denyReason: 'La interpretación de contexto no usa herramientas.',
      timeoutMessage: 'La interpretación tardó demasiado.',
    },
  );
  const result = parseContext(text);
  if (!result) throw new Error('No se pudo interpretar la respuesta.');
  return result;
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  if (!dataDir) { log('falta la ruta después de --data-dir.'); process.exit(1); return; }
  const job = readJob(dataDir, id);
  if (!job) { log(`job ${id} inexistente (¿se limpió antes de arrancar?).`); process.exit(0); return; }
  // El server pasa solo URL/workspace (no secretos). pad-service-client lee la
  // credencial desde HOME/.pad del dueño, fijado por userRunnerEnv(owner).
  const ctx = process.env.CWC_PAD_WORKSPACE
    ? { url: process.env.CWC_PAD_URL || undefined, workspace: process.env.CWC_PAD_WORKSPACE }
    : null;
  try {
    const result = await runAnalysis(job);
    const rendered = renderContextText(result);
    // AUTO-GUARDAR en meta-store: aparece en la sección "Contexto adicional" del
    // ítem sin un paso extra (editable/borrable después desde la UI).
    if (job.key) { try { await saveContexto(job.key, rendered, ctx); } catch (e) { log('no pude auto-guardar:', e?.message); } }
    writeJob(dataDir, id, { ...job, status: 'done', result, rendered, error: null, updatedAt: Date.now() });
    log(`OK job ${id} (key ${job.key}): ${result.puntosClave.length} punto(s), ${result.acuerdos.length} acuerdo(s)`);
  } catch (err) {
    writeJob(dataDir, id, { ...job, status: 'error', result: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => {
  log('FALLO inesperado:', err?.message || err);
  process.exit(1);
});
