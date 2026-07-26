#!/usr/bin/env node
// bin/cwc-retro-runner.js — MEJORA CONTINUA (ROAD-256): destila LECCIONES DE
// PROCESO de UNA sesión de chat, DESACOPLADO del server (regla de oro). Corrida
// IA de TEXTO PURO, read-only doble capa (regla 6): PreToolUse deny + canUseTool
// deny + settingSources [] ⇒ CERO herramientas. La transcripción condensada
// viaja en el prompt (nunca lee disco vía tools). Tras destilar, hace el UPSERT
// determinístico en Pad local (dedup por fingerprint = recurrencia) — eso NO es
// una tool del modelo, es HTTP desde Node (como audio escribe el job a disco).
import {
  ROOT, RETRO_TIMEOUT_MS, RETRO_DEDUP_LIMIT, retroPrompt, parseRetro,
  readRetroJob, writeRetroJob,
} from '../src/modules/retro/shared.js';
import { upsertLesson, computeFingerprint, listLessons } from '../src/modules/retro/store.js';
import { padContextForUser } from '../src/core/pad-context.js';
import { textOnlyQuery } from '../src/core/text-only-query.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const id = process.argv[2];

async function distill(job, ctx) {
  // dedup "vs seen": pasamos las lecciones ya registradas para que el modelo
  // reuse el título exacto de un concepto repetido (best-effort — si Pad falla
  // igual destila, solo pierde la guía de recurrencia).
  let existing = [];
  try {
    const r = await listLessons(ctx);
    const lessons = r.lessons || [];
    // BUG-1930: el medidor observa primero aprobadas/promovidas; descartadas
    // quedan últimas, aunque su recurrencia todavía aporta una señal secundaria.
    const priority = (l) => (l.status === 'promovida' || l.status === 'aprobada' ? 0 : (l.status === 'descartada' ? 2 : 1));
    const ordered = [...lessons].sort((a, b) => (
      priority(a) - priority(b)
      || Number(b.recurrence || 0) - Number(a.recurrence || 0)
      || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
    ));
    existing = ordered.slice(0, RETRO_DEDUP_LIMIT).map((l) => ({ category: l.category, title: l.title }));
    if (lessons.length > RETRO_DEDUP_LIMIT) {
      log(`dedup: ${lessons.length - RETRO_DEDUP_LIMIT} lección(es) quedaron fuera del tope de ${RETRO_DEDUP_LIMIT}.`);
    }
  }
  catch (err) { log('no pude traer lecciones existentes para dedup:', err?.message || err); }
  // Texto puro, read-only doble capa (regla 6) vía el helper único core/text-only-query.
  const text = await textOnlyQuery(retroPrompt(job, existing), {
    model: 'sonnet',      // la lectura de proceso necesita calidad
    maxTurns: 1,
    timeoutMs: RETRO_TIMEOUT_MS,
    cwd: ROOT,
    denyReason: 'La destilación de mejora continua no usa herramientas.',
    timeoutMessage: 'La destilación tardó demasiado.',
  });
  const parsed = parseRetro(text);
  if (!parsed) throw new Error('No se pudo interpretar la respuesta de la destilación.');
  return parsed.lessons;
}

async function persist(lessons, job, ctx) {
  const src = { sessionId: job.meta?.sessionId || null, title: job.meta?.title || '', at: Date.now() };
  let created = 0;
  let merged = 0;
  for (const l of lessons) {
    try {
      const project = l.project || job.meta?.project || 'otros';
      const fingerprint = computeFingerprint(l.category, l.title);
      const r = await upsertLesson({ ...l, project, fingerprint, sourceChat: src }, ctx);
      if (r?.created) created += 1; else merged += 1;
    } catch (err) { log('no pude guardar lección:', err?.message || err); }
  }
  return { created, merged, total: lessons.length };
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  const job = readRetroJob(id);
  if (!job) { log(`job ${id} inexistente (¿se limpió antes de arrancar?).`); process.exit(0); return; }
  const ctx = padContextForUser(job.owner || null);
  try {
    const lessons = await distill(job, ctx);
    const summary = await persist(lessons, job, ctx);
    const cur = readRetroJob(id);
    if (!cur) { log(`job ${id} fue borrado durante la corrida; no lo recreo.`); return; }
    writeRetroJob(id, { ...cur, status: 'done', result: summary, error: null, updatedAt: Date.now() });
    log(`OK job ${id}: ${summary.created} nueva(s) · ${summary.merged} recurrente(s) de ${summary.total} destilada(s)`);
  } catch (err) {
    const cur = readRetroJob(id);
    if (cur) writeRetroJob(id, { ...cur, status: 'error', result: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => { log('FALLO inesperado:', err?.message || err); process.exit(1); });
