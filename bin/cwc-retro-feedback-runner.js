#!/usr/bin/env node
// bin/cwc-retro-feedback-runner.js — ingesta MANUAL de "Feedback de Chris"
// para Mejora Continua, DESACOPLADO (regla de oro). Interpreta TEXTO PURO
// pegado a mano (correo/Teams copiado, notas de una llamada) — CERO
// herramientas (regla 6, vía core/text-only-query.js) — y hace el UPSERT en
// el store de retro con categoría 'feedback-cliente' + destino sugerido
// 'contexto' (se inyecta sola en todo chat de bug futuro al adoptarla).
import {
  feedbackPrompt, parseFeedback, readFeedbackJob, writeFeedbackJob,
} from '../src/modules/retro/feedback-shared.js';
import { upsertLesson, computeFingerprint, listLessons } from '../src/modules/retro/store.js';
import { padContextForUser, sharedPadContextForUser } from '../src/core/pad-context.js';
import { textOnlyQuery } from '../src/core/text-only-query.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, '[retro-feedback]', ...a);
const id = String(process.argv[2] || '');

async function interpret(job, ctx) {
  // dedup "vs seen": lecciones YA registradas de feedback, para que el modelo
  // reuse el título exacto de un concepto repetido (patrón de retroPrompt).
  let existing = [];
  try {
    const r = await listLessons(ctx);
    existing = (r.lessons || []).filter((l) => l.category === 'feedback-cliente').map((l) => l.title);
  } catch (err) { log('no pude traer feedback existente para dedup:', err?.message || err); }
  const existingLine = existing.length
    ? `\n\nFEEDBACK YA REGISTRADO. Si repetís el mismo concepto, reusá el título EXACTO de esta lista para que se reconozca como el mismo (suma recurrencia en vez de duplicar):\n${existing.slice(0, 30).map((t) => `- ${t}`).join('\n')}`
    : '';
  const text = await textOnlyQuery(feedbackPrompt(job) + existingLine, {
    model: 'sonnet',
    maxTurns: 1,
    timeoutMs: 4 * 60 * 1000,
    denyReason: 'Registrar feedback: corrida de TEXTO PURO, sin herramientas.',
    timeoutMessage: 'La interpretación tardó demasiado.',
  });
  const parsed = parseFeedback(text);
  if (!parsed) throw new Error('No se pudo interpretar el feedback pegado (respuesta inválida).');
  return parsed.items;
}

async function persist(items, job, ctx, sharedCtx) {
  let created = 0;
  let merged = 0;
  let lastErr = null;
  for (const it of items) {
    try {
      const refs = (job.ticketRef ? [job.ticketRef] : []).concat(it.refs || []);
      const fingerprint = computeFingerprint('feedback-cliente', it.title);
      const r = await upsertLesson({
        title: it.title,
        category: 'feedback-cliente',
        observation: it.observation,
        lesson: it.lesson,
        destination: 'contexto',
        // BUG-1928: el feedback manual también trata PRs de Tolkien; dejarlo en
        // "otros" bloquearía memoria y claude-md cuando el frontend no manda project.
        project: job.project || 'tolkien',
        confidence: it.confidence,
        fingerprint,
        sourceRefs: refs,
      }, ctx, sharedCtx);
      if (r?.created) created += 1; else merged += 1;
    } catch (err) { lastErr = err; log('no pude guardar feedback:', err?.message || err); }
  }
  // Si la IA interpretó algo pero NADA se pudo guardar (p.ej. Pad rechazó el
  // campo), no marcar el job 'done' en silencio — el usuario vería "0 nuevas"
  // sin enterarse de que en realidad falló por completo.
  if (items.length && created + merged === 0) {
    throw new Error(`No se pudo guardar ninguna de las ${items.length} pieza(s) interpretadas: ${lastErr?.message || 'error desconocido'}`);
  }
  return { created, merged, total: items.length };
}

async function main() {
  if (!id) { log('falta el id del job.'); process.exit(1); return; }
  const job = readFeedbackJob(id);
  if (!job) { log(`job ${id} inexistente (¿se limpió antes de arrancar?).`); process.exit(0); return; }
  const ctx = padContextForUser(job.owner || null);
  const sharedCtx = sharedPadContextForUser(job.owner || null);
  try {
    const items = await interpret(job, ctx);
    const summary = await persist(items, job, ctx, sharedCtx);
    const cur = readFeedbackJob(id);
    if (!cur) { log(`job ${id} fue borrado durante la corrida; no lo recreo.`); return; }
    writeFeedbackJob(id, { ...cur, status: 'done', result: summary, error: null, updatedAt: Date.now() });
    log(`OK job ${id}: ${summary.created} nueva(s) · ${summary.merged} recurrente(s) de ${summary.total} pieza(s)`);
  } catch (err) {
    const cur = readFeedbackJob(id);
    if (cur) writeFeedbackJob(id, { ...cur, status: 'error', result: null, error: String(err?.message || err).slice(0, 300), updatedAt: Date.now() });
    log(`FAIL job ${id}:`, err?.message || err);
  }
}

main().catch((err) => { log('FALLO inesperado:', err?.message || err); process.exit(1); });
