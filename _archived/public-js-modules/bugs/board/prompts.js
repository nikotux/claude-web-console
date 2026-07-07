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

// Contexto del motor Comunicaciones (comms) para Chris: 0 tokens, lee el
// índice ya cacheado en disco (GET /api/comms/index). Si el PR de este fix
// tiene hilo indexado o hay un DM de Teams con Chris, lo trae para que el chat
// arranque sabiendo qué se habló últimamente — sin tener que abrir el tablero
// de Comunicaciones a mano. Best-effort: si falla o no hay nada, no rompe nada.
export async function fetchCommsContext(b) {
  try {
    const idx = await (await fetch('/api/comms/index')).json();
    const threads = idx.threads || [];
    const wanted = [];
    if (b.prNumber) {
      const t = threads.find((x) => x.id === `gh:${b.prNumber}:chris`);
      if (t) wanted.push(t);
    }
    const dm = threads.find((x) => x.id === 'teams:chris');
    if (dm) wanted.push(dm);
    if (!wanted.length) return '';
    const lines = ['COMUNICACIONES con Chris (motor Comunicaciones — datos ya indexados):'];
    for (const t of wanted) {
      const last = t.messages?.[t.messages.length - 1];
      if (!last) continue;
      lines.push(`- [${t.source}] ${t.title}${t.awaitingReply ? ' (esperando respuesta de Chris)' : ''}: "${String(last.text).slice(0, 200)}"`);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  } catch { return ''; }
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
export function workPrompt(b, { invText, workContext, prContext, commsText }) {
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
    commsText || '',
    b.prNumber ? `\nSi el PR tiene feedback más nuevo, revisalo: gh pr view ${b.prNumber} --comments` : '',
    workContext ? `\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${workContext}\n---` : '',
    prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
    '',
    '🚦 RECORDATORIO (gate del contexto de trabajo): antes de CUALQUIER push (git push / gh pr create|edit / actualizar PR) mostrá el PLAN DE PUSH y esperá mi OK explícito; recién ahí ejecutá de corrido.',
    `🔗 Si el push termina saliendo por FUERA del módulo "Enviar PR" (excepción autorizada), en el MISMO turno ejecutá: node /home/nmosquera/claude-web-console/bin/cwc-bugfix-link.js ${b.ticketNumber} <nroPR> — vincula el PR al tablero (determinístico, 0 tokens); sin eso el registro queda huérfano.`,
    '',
    'Empezá mostrándome el diff actual de esos archivos contra origin/main y tu evaluación de qué falta o qué mejorarías.',
  ].filter(Boolean).join('\n');
}

// Prompt de "Trabajar en esto" para un FEATURE del tablero (FEAT-n, sin
// ticket de Desk). El feature es de TOLKIEN por definición (regla de
// clasificación: el tablero no carga trabajo de otros proyectos).
export function featurePrompt(b, { invText, workContext, prContext, commsText }) {
  const est = prEstado(b);
  return [
    `Trabajemos el feature ${b.ticketNumber} de Tolkien: ${b.title || ''}`,
    '',
    'ENUNCIADO del feature (lo que se pidió):',
    b.spec || b.summary || '(sin enunciado — pedímelo antes de empezar)',
    '',
    `Estado actual: ${est.label}.`,
    b.prUrl ? `PR: ${b.prUrl}` : '',
    b.files?.length ? `Archivos tocados hasta ahora:\n${b.files.map((f) => `- ${f}`).join('\n')}` : 'Todavía sin archivos editados.',
    `\nHISTORIAL del ciclo:\n${historyText(b) || '(sin eventos)'}`,
    (b.feedback || []).length ? `\nFEEDBACK de Chris en el PR (guardado — tenelo MUY presente):\n${b.feedback.slice(-5).map((f) => `- ${f.author}: ${(f.body || '').slice(0, 300)}`).join('\n')}` : '',
    (b.similar || []).length ? `\nSOLUCIONES PASADAS PARECIDAS (aprendé de ellas):\n${b.similar.map((s) => `- ${s.ticketNumber}${s.files?.[0] ? ` (${s.files[0]})` : ''}: ${s.fix || s.rootCause || ''}${s.lesson ? ` — lección: ${s.lesson}` : ''}`).join('\n')}` : '',
    invText || '',
    commsText || '',
    'Proceso: es un FEATURE, no un bugfix — arrancá por el DISEÑO: qué se',
    'quiere lograr, dónde encaja en el código de Tolkien, qué opciones hay y',
    'cuál conviene. Presentame el plan y esperá mi OK antes de implementar.',
    'OJO: no hay ticket de Desk detrás (no toques Desk). El respaldo del',
    `trabajo es este feature del tablero (${b.ticketNumber}); citalo en tu cierre.`,
    '🚦 GATE DE PUSH (igual que en bugs): antes de CUALQUIER push (git push / gh pr create|edit / actualizar PR) mostrá el PLAN DE PUSH y esperá mi OK explícito; recién ahí ejecutá de corrido.',
    `🔗 Si el push termina saliendo por FUERA del módulo "Enviar PR" (excepción autorizada), en el MISMO turno ejecutá: node /home/nmosquera/claude-web-console/bin/cwc-bugfix-link.js ${b.ticketNumber} <nroPR> — vincula el PR al tablero (determinístico, 0 tokens); sin eso el registro queda huérfano (caso FEAT-2/PR #249).`,
    workContext ? `\n--- CONTEXTO DE TRABAJO (aplica lo general; lo específico de Desk NO corre acá) ---\n${workContext}\n---` : '',
    prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
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
    '   La nota SIEMPRE cierra con la firma exacta "— Nicolás (dev team)" en su propia línea: la API de Desk publica con otra identidad y el autor real tiene que quedar claro.',
    '4. Recién con mi OK, publicala en el ticket (visible al solicitante si se puede) y ajustá el estado si corresponde.',
    `5. Inmediatamente DESPUÉS de publicarla, registrala en el motor Comunicaciones (auditoría central) ejecutando: node /home/nmosquera/claude-web-console/bin/cwc-comms.js record desk ticket_reply --ticket ${b.ticketNumber} -- "<la nota exacta que publicaste>". Es determinístico y 0 tokens; NO re-envía nada, solo deja el registro.`,
    'NO toques código ni envíes PRs desde este chat.',
  ].filter(Boolean).join('\n');
}

// Prompt de "Trabajar en Chat (plan)" (ticket del triage sin trabajo).
export function triagePrompt(t, { invText, workContext, prContext, commsText }) {
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
    commsText || '',
    workContext ? `\n--- CONTEXTO DE TRABAJO (seguilo al pie de la letra) ---\n${workContext}\n---` : '',
    prContext ? `\n--- REDACCIÓN DEL PR (así se escribe tu cierre) ---\n${prContext}\n---` : '',
    '',
    'Estás en modo PLAN: investigá el código relevante y proponé un plan de arreglo antes de tocar nada.',
  ].filter(Boolean).join('\n');
}
