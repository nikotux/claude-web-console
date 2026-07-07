// modules/bugfixes/investigate-shared.js — lo COMPARTIDO entre el módulo server
// y el runner desacoplado de la "investigación a fondo" de un PR
// (bin/cwc-investigate-runner.js).
//
// QUÉ hace: responde "¿la pelota la tenés vos o Chris, y qué hacer?". Dos capas:
//   🚦 SEMÁFORO (determinístico, 0 tokens): de los datos de gh (reviews,
//      comentarios, commits, checks, mergeable, reviewDecision) sale si Chris
//      respondió tras tu último commit, si hay cambios pedidos, checks rojos o
//      conflictos. Lo calcula computeSemaforo().
//   🧠 LECTURA (IA, a demanda): el runner junta el diff + los comentarios de
//      Chris y el modelo los interpreta → veredicto {accion, bloqueante,
//      severidad, queQuiereChris, pasos[], archivos[], recomendacion, titular}.
//
// RESILIENCIA (regla 2): la corrida vive en un RUNNER DETACHED cuyo resultado se
// PERSISTE en ~/.cwc-data/investigations/<pr>.json → sobrevive al cambio de
// pestaña y al reinicio del server. El front dispara (POST) y encuesta (GET).
//
// SEGURIDAD (regla 6, la MÁS blindada): la corrida IA es PURA LECTURA DE TEXTO
// —los datos ya los juntó Node con gh— así que NO usa NINGUNA herramienta ni
// MCP. Las dos capas (hook PreToolUse + canUseTool) deniegan TODO.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const INV_DIR = path.join(DATA_DIR, 'investigations');   // resultado por PR
export const INV_LOCK = path.join(DATA_DIR, 'investigate.lock'); // heartbeat
export const INV_LOG = path.join(DATA_DIR, 'investigate.log');

export const INV_TIMEOUT_MS = 4 * 60000;
export const INV_TTL_MS = 60000;            // "fresco": no re-investigar si es más nuevo
export const INV_HEARTBEAT_MS = 3000;
export const INV_LOCK_FRESH_MS = 20000;     // lock más viejo = runner muerto
export const DIFF_CAP = 50000;              // 50 KB de diff (recorte defensivo)

// La corrida IA NO usa herramientas: deny total en las DOS capas (regla 6).
export const investigateToolAllowed = () => false;

// ===== Semáforo determinístico (0 tokens) desde el JSON de gh pr view =====
export function computeSemaforo(pr, { deskReplied = null } = {}) {
  const me = pr.author?.login || '';
  const commits = pr.commits || [];
  const lastCommitAt = commits.reduce((m, c) => Math.max(m, c.committedDate ? Date.parse(c.committedDate) : 0), 0);
  // Eventos de Chris (el revisor): reviews con estado + comentarios. Excluye tus
  // propios mensajes y los bots.
  const events = [
    ...(pr.reviews || []).map((r) => ({ who: r.author?.login || '?', at: r.submittedAt ? Date.parse(r.submittedAt) : 0, kind: String(r.state || 'review').toLowerCase(), body: r.body || '' })),
    ...(pr.comments || []).map((c) => ({ who: c.author?.login || '?', at: c.createdAt ? Date.parse(c.createdAt) : 0, kind: 'comment', body: c.body || '' })),
  ].filter((e) => e.who && e.who !== me && !/^(github-actions|dependabot|codecov)/i.test(e.who));
  events.sort((a, b) => a.at - b.at);
  const lastChris = events[events.length - 1] || null;
  const chrisRespondio = !!(lastChris && lastChris.at > lastCommitAt);

  const norm = (c) => String(c.conclusion || c.state || c.status || '').toLowerCase();
  const rollup = pr.statusCheckRollup || [];
  const checks = {
    ok: rollup.filter((c) => ['success', 'neutral', 'skipped'].includes(norm(c))).length,
    failing: rollup.filter((c) => ['failure', 'error', 'timed_out', 'cancelled'].includes(norm(c))).length,
    total: rollup.length,
  };
  const conflictos = pr.mergeable === 'CONFLICTING';
  const reviewDecision = pr.reviewDecision || null;

  // ¿De quién es la pelota?
  let ball = 'chris'; // por defecto: esperando que Chris revise/mergee
  if (conflictos || checks.failing > 0 || reviewDecision === 'CHANGES_REQUESTED') ball = 'yours';
  else if (reviewDecision === 'APPROVED') ball = 'clear'; // aprobado, falta merge
  else if (chrisRespondio) ball = 'yours';                // Chris dijo algo tras tu commit: leelo

  return {
    ball, chrisRespondio, reviewDecision, checks, conflictos,
    deskRespondio: deskReplied,
    ultimaActividad: lastChris ? { quien: lastChris.who, cuando: lastChris.at, tipo: lastChris.kind } : null,
    // Los comentarios de Chris (texto) para que el prompt/veredicto los use.
    comentariosChris: events.filter((e) => e.body).slice(-6).map((e) => ({ quien: e.who, tipo: e.kind, at: e.at, body: String(e.body).slice(0, 1200) })),
  };
}

// ===== Prompt de la lectura profunda (IA) =====
export function investigatePrompt({ prNumber, prTitle, ticketTitle, semaforo, diff }) {
  const S = semaforo;
  const comentarios = (S.comentariosChris || []).map((c) => `- [${c.quien}] (${c.tipo}): ${c.body}`).join('\n') || '(sin comentarios de Chris)';
  return [
    'Sos un asistente técnico que revisa el estado de un Pull Request y le dice al desarrollador (en español rioplatense, claro y directo) si tiene que hacer algo y qué.',
    '',
    `PR #${prNumber}: ${prTitle || '(sin título)'}`,
    ticketTitle ? `Ticket asociado: ${ticketTitle}` : '',
    `Estado técnico: review=${S.reviewDecision || 'sin decisión'} · checks ${S.checks.ok}/${S.checks.total}${S.checks.failing ? ` (${S.checks.failing} fallando)` : ''} · conflictos con main=${S.conflictos ? 'SÍ' : 'no'} · Chris respondió tras tu último commit=${S.chrisRespondio ? 'SÍ' : 'no'}.`,
    '',
    'Comentarios/reviews de Chris (el revisor), del más viejo al más nuevo:',
    comentarios,
    '',
    'Diff del PR (puede estar recortado):',
    '```diff',
    (diff || '(sin diff disponible)').slice(0, DIFF_CAP),
    '```',
    '',
    'Interpretá los comentarios de Chris A LA LUZ del diff y respondé ÚNICAMENTE con un bloque JSON (nada de texto fuera de él):',
    '```json',
    '{"accion":"si|no|quizas","bloqueante":true|false,"severidad":"blocker|cambio|nit|nota|aprobacion","queQuiereChris":"1-2 frases claras","pasos":["acción concreta citando el archivo"],"archivos":["archivo.js"],"recomendacion":"corregir-y-actualizar-pr|mergear|responder-github|esperar|responder-desk","confianza":"alta|media|baja","titular":"<=60 chars para un badge"}',
    '```',
    'Reglas:',
    '- Si el ÚLTIMO comentario de Chris es una aprobación y no pide cambios: accion=no, severidad=aprobacion, recomendacion=esperar (o mergear si ya aprobó del todo).',
    '- bloqueante=true SOLO si Chris pide un cambio que impide el merge (un bug, algo roto, checks/conflictos). Una sugerencia opcional (nit) NO es bloqueante.',
    '- pasos: acciones concretas en imperativo, citando el archivo cuando puedas. Vacío si no hay que hacer nada.',
    '- titular: corto, para mostrar en el tablero. Ej: "Chris pidió cambios · bloqueante", "Aprobado · listo para mergear", "Nota opcional de Chris".',
    '- Si no hay comentarios de Chris y no hay cambios pedidos: accion=no, severidad=nota, recomendacion=esperar, titular="En revisión · esperando a Chris".',
  ].filter((l) => l !== '').join('\n');
}

// Parseo defensivo: último bloque JSON válido de la respuesta del modelo.
export function parseVerdict(out) {
  const candidates = [];
  const fences = out.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fences) for (const f of fences) candidates.push(f.replace(/```(?:json)?/gi, '').trim());
  const brace = out.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  let p = null;
  for (const c of candidates.reverse()) { try { p = JSON.parse(c); break; } catch { /* siguiente */ } }
  if (!p || typeof p !== 'object') return { ok: false, error: 'No se pudo interpretar el veredicto.' };
  const sev = ['blocker', 'cambio', 'nit', 'nota', 'aprobacion'].includes(p.severidad) ? p.severidad : 'nota';
  const rec = ['corregir-y-actualizar-pr', 'mergear', 'responder-github', 'esperar', 'responder-desk'].includes(p.recomendacion) ? p.recomendacion : 'esperar';
  return {
    ok: true,
    accion: ['si', 'no', 'quizas'].includes(p.accion) ? p.accion : 'no',
    bloqueante: p.bloqueante === true,
    severidad: sev,
    queQuiereChris: String(p.queQuiereChris || '').slice(0, 600),
    pasos: Array.isArray(p.pasos) ? p.pasos.slice(0, 8).map((s) => String(s).slice(0, 300)) : [],
    archivos: Array.isArray(p.archivos) ? p.archivos.slice(0, 12).map((s) => String(s).slice(0, 200)) : [],
    recomendacion: rec,
    confianza: ['alta', 'media', 'baja'].includes(p.confianza) ? p.confianza : 'media',
    titular: String(p.titular || '').slice(0, 60),
  };
}

// ===== Resultado persistido por PR =====
const safeKey = (pr) => String(pr).replace(/[^\w.-]/g, '').slice(0, 20);
export function invResultPath(pr) { return path.join(INV_DIR, `${safeKey(pr)}.json`); }
export function readInvestigation(pr) {
  try { return JSON.parse(fss.readFileSync(invResultPath(pr), 'utf8')); } catch { return null; }
}
export function writeInvestigation(pr, data) {
  try {
    fss.mkdirSync(INV_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(invResultPath(pr), JSON.stringify(data), { mode: 0o600 });
  } catch (err) { console.error('[investigate] no pude persistir:', err?.message); }
}

// ===== Lock de "investigación corriendo" (heartbeat del runner) =====
export function writeInvLock(state) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(INV_LOCK, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearInvLock() { try { fss.unlinkSync(INV_LOCK); } catch { /* noop */ } }
export function readInvLock() {
  try {
    const l = JSON.parse(fss.readFileSync(INV_LOCK, 'utf8'));
    if (Date.now() - l.ts >= INV_LOCK_FRESH_MS) return null;
    return l;
  } catch { return null; }
}
export function isInvestigating() { return !!readInvLock(); }
