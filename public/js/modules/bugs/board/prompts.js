// board/prompts.js — textos de los chats que abre el tablero (antes ~40 líneas
// inline en el JS de UI) + los contextos editables que se les inyectan.
// Solo CONSTRUYE strings: el openChat vive en actions.js.

import { fmtDate } from './util.js';
import { timelineOf, EV_LABEL, prEstado } from './labels.js';

// Contextos editables 'work'/'pr' (⚙ Sistema → Proyectos → Bugfixes).
export async function fetchContexts() {
  try {
    return (await Promise.all([
      fetch('/api/bugfixes/context?kind=work').then((r) => r.json()),
      fetch('/api/bugfixes/context?kind=pr').then((r) => r.json()),
    ])).map((d) => d.context || '');
  } catch { return ['', '']; }
}

// Texto del historial para inyectar contexto COMPLETO en los chats del ciclo.
export const historyText = (b) => timelineOf(b)
  .map((e) => `- ${fmtDate(e.t)}: ${(EV_LABEL[e.type] || (() => e.type))(e)}`).join('\n');

// Bloque de texto del veredicto de una investigación de PR (si se corrió).
export function invTextOfPr(L) {
  if (!L?.ok || !(L.pasos?.length || L.queQuiereChris)) return '';
  return `\nINVESTIGACIÓN del PR (qué pide Chris${L.bloqueante ? ' — BLOQUEANTE' : ''}):\n${L.queQuiereChris || ''}${L.pasos?.length ? `\nPasos:\n${L.pasos.map((p) => `- ${p}`).join('\n')}` : ''}`;
}

// Bloque de texto del veredicto de una investigación de contexto (sin PR).
export function invTextOfTicket(L, { yaHecha = false } = {}) {
  if (!L?.ok || !(L.pasos?.length || L.causaRaiz || L.porQueNoResuelto)) return '';
  return `\nINVESTIGACIÓN DE CONTEXTO${yaHecha ? ' ya hecha' : ''} (por qué no se resolvió):\n${L.porQueNoResuelto || ''}${L.causaRaiz ? `\nCausa raíz: ${L.causaRaiz}` : ''}${L.pasos?.length ? `\nPasos sugeridos:\n${L.pasos.map((p) => `- ${p}`).join('\n')}` : ''}${L.archivos?.length ? `\nArchivos: ${L.archivos.join(', ')}` : ''}`;
}

// Prompt de "Trabajar en esto" (fila con registro del motor).
export function workPrompt(b, { invText, workContext, prContext }) {
  const est = prEstado(b);
  return [
    `Retomemos el fix del ticket Desk #${b.ticketNumber} para refinarlo a mano antes de ${b.status === 'subido' ? 'MODIFICAR el PR ya existente' : 'subir el PR'}.`,
    '',
    `Estado actual del registro: ${est.label}.`,
    b.prUrl ? `PR: ${b.prUrl}` : '',
    b.ticketUrl ? `Ticket: ${b.ticketUrl}` : '',
    b.files?.length ? `Archivos del fix hasta ahora:\n${b.files.map((f) => `- ${f}`).join('\n')}` : 'Todavía sin archivos editados (quedó en plan).',
    b.summary ? `\nResumen registrado del fix:\n${b.summary}` : '',
    `\nHISTORIAL del ciclo de este fix (tenelo presente):\n${historyText(b) || '(sin eventos)'}`,
    // Feedback de Chris YA guardado en este ticket (base de conocimiento).
    (b.feedback || []).length ? `\nFEEDBACK de Chris en el PR (guardado — tenelo MUY presente, marca qué espera):\n${b.feedback.slice(-5).map((f) => `- ${f.author}: ${(f.body || '').slice(0, 300)}`).join('\n')}` : '',
    // Lecciones de tickets pasados parecidos (biblioteca del motor).
    (b.similar || []).length ? `\nSOLUCIONES PASADAS PARECIDAS (aprendé de ellas antes de decidir):\n${b.similar.map((s) => `- TKT #${s.ticketNumber}${s.files?.[0] ? ` (${s.files[0]})` : ''}: ${s.fix || s.rootCause || ''}${s.lesson ? ` — lección: ${s.lesson}` : ''}`).join('\n')}` : '',
    invText || '',
    b.prNumber ? `\nSi el PR tiene feedback más nuevo, revisalo: gh pr view ${b.prNumber} --comments` : '',
    workContext ? `\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${workContext}\n---` : '',
    prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
    '',
    'Empezá mostrándome el diff actual de esos archivos contra origin/main y tu evaluación de qué falta o qué mejorarías.',
  ].filter(Boolean).join('\n');
}

// Prompt de "Responder/Actualizar ticket (chat)": redacta EN INGLÉS y escribe
// en Desk solo con aprobación del usuario. Se adapta a con/sin PR.
export function deskChatPrompt(b) {
  const hasPr = !!b.prNumber;
  return [
    hasPr
      ? `Actualicemos el ticket de Zoho Desk #${b.ticketNumber} con las novedades del PR #${b.prNumber}.`
      : `Respondamos el ticket de Zoho Desk #${b.ticketNumber} (todavía sin PR asociado).`,
    b.ticketUrl ? `Ticket: ${b.ticketUrl}` : '',
    hasPr && b.prUrl ? `PR: ${b.prUrl}` : '',
    '',
    `HISTORIAL del fix:\n${historyText(b) || '(sin eventos)'}`,
    b.summary ? `\nResumen del fix:\n${b.summary.slice(0, 1200)}` : '',
    '',
    'Proceso (en este orden):',
    hasPr
      ? `1. Mirá el estado real y el feedback del PR: gh pr view ${b.prNumber} --comments`
      : '1. Repasá el historial del fix y lo que ya sabemos del problema.',
    '2. Verificá el ticket y su hilo en Desk con las tools desk_* del MCP (mirá si ya hay una respuesta nuestra para no repetir).',
    hasPr
      ? '3. Redactá una actualización EN INGLÉS, corta y humana (2-4 frases) con lo que cambió desde la última nota (qué se corrigió/mejoró y que el despliegue sigue en curso). MOSTRÁMELA y esperá mi OK.'
      : '3. Redactá EN INGLÉS una respuesta corta y humana (2-4 frases) apropiada al estado real: un avance, un pedido de información, o el próximo paso. MOSTRÁMELA y esperá mi OK.',
    '4. Recién con mi OK, publicala en el ticket (visible al solicitante si se puede) y ajustá el estado si corresponde.',
    'NO toques código ni envíes PRs desde este chat.',
  ].filter(Boolean).join('\n');
}

// Prompt de "Trabajar en Chat (plan)" (ticket del triage sin trabajo).
export function triagePrompt(t, { invText, workContext, prContext }) {
  return [
    `Trabajemos el bug del ticket Desk #${t.ticketNumber}.`,
    '',
    `Qué se rompió: ${t.whatBroke}`,
    `Ruta: ${t.route || '(sin ruta)'}`,
    `Severidad: ${t.severity} · Recomendación del triage: ${t.recommendation}`,
    t.reporter ? `Reportó: ${t.reporter}` : '',
    t.webUrl ? `Ticket: ${t.webUrl}` : '',
    t.context ? `\nContexto del triage:\n${t.context}` : '',
    invText || '',
    workContext ? `\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${workContext}\n---` : '',
    prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
    '',
    'Estás en modo PLAN: investigá el código relevante y proponé un plan de arreglo antes de tocar nada.',
  ].filter(Boolean).join('\n');
}
